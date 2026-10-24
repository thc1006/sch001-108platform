#!/usr/bin/env node
/**
 * 全站外部連結的健康檢查，排程執行。
 *
 * ci.yml 的 lychee 只驗站內的 file:// 連結，競賽看門狗只涵蓋 competitions.json 的
 * url 欄位，其餘的外部網址只有這支在看（#72）。
 *
 * 網址一律讀 .reports/url-inventory.json，由 check-built-site.mjs 在 npm run check:site
 * 時產生，記有每一處引用的出處檔案。
 * 刻意「不」自己再掃一次 dist/ 與 public/：同一件事有兩份擷取邏輯就會漂移，
 * 而 #78 出事的原因正是「對應表被手抄成第二份」。要多一個欄位就去改
 * check-built-site.mjs，不要在這裡長出第二套擷取。
 *
 * 與 PR gate 的分工：
 *   ci.yml 的 Site and Browser Integrity → 站內連結與靜態位址政策，確定性，擋 PR
 *   本檢查                               → 外部站台可用性，非確定性，只開 issue／寫 summary
 *
 * 內文裸網域也要檢查，只看 href／url 欄位會漏掉它們。競賽資料的 description
 * 是大段中文說明，裡面有很多只用文字寫出來的網域，例如「原 tpmso.org 已轉址至
 * tpmso.k12ea.gov.tw」。實測全站有 45 個這種裸主機名，其中 30 個不出現在任何
 * url 欄位。
 *
 * 擷取（純字串）在 check-built-site.mjs，結果放在盤點的 bareDomainCandidates；
 * 這裡負責需要網路的那一半：用 DNS 根區篩掉「長得像網域但其實是檔名」的候選，
 * 再走與一般網址完全相同的探測路徑（同一套 SSRF 防護、同一套手動轉址）。
 *
 * 三態：
 *   dead       網域解析不到、404/410      → 觸發 issue
 *   unverified 403/429/5xx/逾時/TLS       → 只記錄，報告依原因分組
 *   healthy    2xx/3xx                    → 不處理
 * 三態有一個結構性盲點：網域被接管之後照樣回 200，狀態碼健康、內容卻已經換人。
 * ieso-info.org 現在是澳洲線上博弈站，www.sasmo.sg 轉去聯盟廣告頁，兩者都回 200。
 * 狀態碼永遠看不出這件事，所以另外用 link-policy.json 的 hijacked 名單把它們
 * 標出來。名單不讓主機算進健康，也不放過連到它的網址；說明文字裡的警告在期限內
 * 只列出、不通知，到期前 30 天起每週通知。
 * 另有第四種訊號（不是第四態）：被位址政策擋下。它在分類上算 unverified（我們
 * 確實沒驗到），但必須單獨大聲列出：資料檔裡出現指向 loopback／私網／雲端
 * metadata 的網址，意義是資料被動了手腳或寫錯，不是站台防爬。
 *
 * 這支負責讀檔、探測與寫檔；每一筆歸到報告的哪一段、要不要通知、報告與主控台寫什麼，在
 * check-external-links.lib.mjs，那裡都是純函式，測試直接餵探測結果。
 *
 * 本機執行：  node scripts/check-external-links.mjs
 *             node scripts/check-external-links.mjs --limit 20   （只驗前 N 筆）
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

import { runProbes } from './link-health.lib.mjs';
import { validatePolicy } from './link-policy.lib.mjs';
import { screenBareDomains, probeUrlFor } from './bare-domains.lib.mjs';
import { EXTERNAL_LINKS_MARKER } from './watchdog-issue.lib.mjs';
import { buildReport } from './check-external-links.lib.mjs';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const INVENTORY_PATH = path.resolve(ROOT, '.reports/url-inventory.json');
const POLICY_PATH = path.resolve(ROOT, 'scripts/link-policy.json');
const REPORT_PATH = path.resolve(ROOT, 'external-links-report.md');

const argOf = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};

const die = async (message) => {
    console.error(`❌ ${message}`);
    await writeFile(
        REPORT_PATH,
        [EXTERNAL_LINKS_MARKER, '', '## 全站外部連結檢查報告', '', '### ❌ 致命錯誤：無法執行檢查', '', `- ${message}`, ''].join('\n'),
        'utf8',
    ).catch(() => {});
    if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, 'needs_attention=true\ncoverage_complete=false\n').catch(() => {});
    }
    process.exit(1);
};

let inventory;
try {
    inventory = JSON.parse(await readFile(INVENTORY_PATH, 'utf8'));
} catch (err) {
    await die(`讀不到外部網址盤點 ${INVENTORY_PATH}（${err.message}）。請先執行 npm run build:deployable && npm run check:site。`);
}
if (!Array.isArray(inventory?.urls) || inventory.urls.length === 0) {
    // 「盤點是空的」和「全部都健康」在報告上長得一模一樣。必須當成錯誤。
    await die('外部網址盤點是空的。這代表 check-built-site.mjs 的擷取壞了，不是「沒有外部連結」。');
}

// 例外政策壞掉（含過期）時不要「當作沒有例外」繼續跑：那會讓每週報告突然多出一堆
// 早就審過的雜訊，維護者只會學會忽略。確定性 CI 本來就該先擋下來，這裡是第二道。
const todayISO = new Date().toISOString().slice(0, 10);
let policyEntries = [];
let hijackedEntries = [];
try {
    const { errors, entries, hijacked } = validatePolicy(JSON.parse(await readFile(POLICY_PATH, 'utf8')), todayISO);
    if (errors.length) {
        await die(`link-policy.json 無效（${errors.length} 項）：${errors.join('；')}。請先修好政策檔再跑健檢。`);
    }
    policyEntries = entries;
    hijackedEntries = hijacked ?? [];
} catch (err) {
    await die(`讀不到或無法解析 ${POLICY_PATH}（${err.message}）。`);
}

const limit = Number(argOf('--limit') || 0);
const targets = limit > 0 ? inventory.urls.slice(0, limit) : inventory.urls;

// 以「今年第幾週」輪替起點，讓預算不足時的覆蓋率長期均勻
const now = new Date();
const weekIndex = Math.floor((Date.now() - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * 86_400_000));

const CONCURRENCY = 6;
const BUDGET_MS = 12 * 60_000;
// 最終回應多讀這麼多位元組，供 hijack-signals 取 <title> 與 meta description。
// 16KB 足以涵蓋幾乎所有頁面的 <head>；讀滿就 destroy，不等 end，因為被接管的頁面
// 常常是很大的廣告頁，讀完整份會把一次上百站的批次工作卡住。
const HEAD_BYTES = 16 * 1024;

const { results, skipped } = await runProbes(
    targets.map((t) => t.url),
    { concurrency: CONCURRENCY, budgetMs: BUDGET_MS, rotateSeed: weekIndex * CONCURRENCY, readBodyBytes: HEAD_BYTES },
);

// 內文裸網域在盤點裡存的是「候選」：擷取是純字串規則，跑在不能連網的確定性檢查裡，
// 因此 Node.js／fuse.min.js／competitions.html 這類形態相符但不是網域的東西也在裡面。
// 這裡用 DNS 根區把它們篩掉：查 TLD 的 NS 記錄，自我維護、不必養一份 TLD 清單。
//
// 刻意不用「這個網域解析得到嗎」當作「它算不算網域」的判準，兩頭都錯：內文點名的網域
// 停用之後就解析不到，那正是要抓的東西，列在 hijacked 的主機解析不到時也會連同接管警示
// 一起被丟掉；反過來 readme.md、logo.ai、test.sh 都被蹲域名的人註冊、解析得到。詳見
// bare-domains.lib.mjs 的檔頭。
const BARE_BUDGET_MS = 3 * 60_000;
// 與上面 inventory.urls 同一個道理：「盤點裡沒有這個欄位」和「一個裸網域都沒有」
// 在報告上長得一模一樣。欄位不存在只可能是盤點檔的格式比這支程式舊，或
// check-built-site.mjs 的擷取被拿掉了，兩種都必須當成錯誤。當成沒有裸網域的話，
// 報告會印出「實際探測：0」、needs_attention=false、coverage_complete=true，CI 全綠。
if (!inventory.bareDomainCandidates || !Array.isArray(inventory.bareDomainCandidates.hosts)) {
    await die('盤點裡沒有 bareDomainCandidates。這代表盤點檔是舊版的，或 check-built-site.mjs 的裸網域擷取壞了，不是「沒有裸網域」。請先執行 npm run build:deployable && npm run check:site。');
}
const bareInfo = inventory.bareDomainCandidates;
const bareCandidates = limit > 0 ? bareInfo.hosts.slice(0, limit) : bareInfo.hosts;

const screen = await screenBareDomains(
    bareCandidates.map((h) => h.host),
    { resolveNs: (name) => dns.promises.resolveNs(name) },
);
let bareResults = [];
let bareSkipped = 0;
if (screen.accepted.length) {
    ({ results: bareResults, skipped: bareSkipped } = await runProbes(screen.accepted.map(probeUrlFor), {
        concurrency: CONCURRENCY,
        budgetMs: BARE_BUDGET_MS,
        rotateSeed: weekIndex * CONCURRENCY,
        readBodyBytes: HEAD_BYTES,
    }));
}

// 每一筆歸到報告的哪一段、要不要通知、報告與主控台寫什麼，都由 buildReport 決定，見 check-external-links.lib.mjs。
const out = buildReport({
    todayISO,
    limit,
    inventoryPath: INVENTORY_PATH,
    inventoryTotal: inventory.urls.length,
    targets,
    results,
    skipped,
    bareInfo,
    bareCandidates,
    screen,
    bareResults,
    bareSkipped,
    policy: { entries: policyEntries, hijacked: hijackedEntries },
    budgetMs: BUDGET_MS,
    bareBudgetMs: BARE_BUDGET_MS,
});
for (const line of out.consoleSummary) console.log(line);
await writeFile(REPORT_PATH, out.report, 'utf8');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, out.githubOutput);
for (const line of out.consoleTail) console.log(line);
