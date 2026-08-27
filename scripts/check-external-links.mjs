#!/usr/bin/env node
/**
 * 全站外部連結健康檢查（排程執行）
 * --------------------------------------------------------------
 * #72 的最後一塊：在此之前，全站外部連結沒有任何東西在把關。lychee 那個 job
 * 看起來在檢查，實際上一個連結都沒驗到；競賽看門狗只涵蓋 competitions.json 的
 * 133 個網址，其餘 400 多個是完全沒人看的。
 *
 * ── 網址從哪來 ──
 * 一律讀 .reports/url-inventory.json，由 check-built-site.mjs 在 npm run check:site
 * 時產生（實測 501 個去重網址／1459 處引用，含每一處的出處檔案）。
 * 刻意「不」自己再掃一次 dist/ 與 public/：同一件事有兩份擷取邏輯就會漂移，
 * 而 #78 出事的原因正是「對應表被手抄成第二份」。要多一個欄位就去改
 * check-built-site.mjs，不要在這裡長出第二套擷取。
 *
 * ── 與 PR gate 的分工 ──
 *   ci.yml 的 Site Integrity → 站內連結與靜態位址政策，確定性，擋 PR
 *   本檢查                   → 外部站台可用性，非確定性，只開 issue／寫 summary
 *
 * ── 內文裸網域（#nnn 新增）──
 * 在此之前，只有「寫成 href／url 欄位」的網址會被檢查。但競賽資料的 description
 * 是大段中文說明，裡面充滿只用文字寫出來的網域：「原 tpmso.org 已轉址至
 * tpmso.k12ea.gov.tw」。實測全站有 45 個這種裸主機名，其中 30 個在任何 url 欄位
 * 都不出現——完全沒有東西在看它們。
 *
 * 擷取（純字串）在 check-built-site.mjs，結果放在盤點的 bareDomainCandidates；
 * 這裡負責需要網路的那一半：用 DNS 根區篩掉「長得像網域但其實是檔名」的候選，
 * 再走與一般網址完全相同的探測路徑（同一套 SSRF 防護、同一套手動轉址）。
 *
 * ── 三態 ──
 *   dead       網域解析不到、404/410      → 觸發 issue
 *   unverified 403/429/5xx/逾時/TLS       → 只記錄（多為防爬，瀏覽器仍可開）
 *   healthy    2xx/3xx                    → 不處理
 * 三態有一個結構性盲點：網域被接管之後照樣回 200，狀態碼健康、內容卻已經換人。
 * ieso-info.org 現在是澳洲線上博弈站，www.sasmo.sg 轉去聯盟廣告頁，兩者都回 200。
 * 狀態碼永遠看不出這件事，所以另外用 link-policy.json 的 hijacked 名單把它們
 * 標出來：命中者不論狀態碼一律單獨大聲列出，且永不計入健康。
 * 另有第四種訊號（不是第四態）：被位址政策擋下。它在分類上算 unverified（我們
 * 確實沒驗到），但必須單獨大聲列出——資料檔裡出現指向 loopback／私網／雲端
 * metadata 的網址，意義是資料被動了手腳或寫錯，不是站台防爬。
 *
 * 本機執行：  node scripts/check-external-links.mjs
 *             node scripts/check-external-links.mjs --limit 20   （只驗前 N 筆）
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import dns from 'node:dns';
import { fileURLToPath } from 'node:url';

import { classifyLink, describeResult, isBlockedResult, runProbes } from './link-health.lib.mjs';
import { validatePolicy, matchPolicy, matchHijacked } from './link-policy.lib.mjs';
import { screenBareDomains, probeUrlFor } from './bare-domains.lib.mjs';
import { EXTERNAL_LINKS_MARKER } from './watchdog-issue.lib.mjs';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const INVENTORY_PATH = path.resolve(ROOT, '.reports/url-inventory.json');
const POLICY_PATH = path.resolve(ROOT, 'scripts/link-policy.json');
const REPORT_PATH = path.resolve(ROOT, 'external-links-report.md');

/** 這個資料檔另有專屬看門狗；重疊是刻意的縱深防禦，但報告要講清楚免得重複處理。 */
const ALSO_COVERED_BY = [
    { file: 'advanced-resources/competitions.json', by: 'competitions-check.yml（另含截止日與欄位的語意檢查）' },
];

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

// ── 網址盤點 ──
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

// ── 例外政策 ──
// 政策壞掉（含過期）時不要「當作沒有例外」繼續跑——那會讓每週報告突然多出一堆
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

const { results, skipped } = await runProbes(
    targets.map((t) => t.url),
    { concurrency: CONCURRENCY, budgetMs: BUDGET_MS, rotateSeed: weekIndex * CONCURRENCY },
);

const dead = [];
const blocked = [];
const unverified = [];
const suppressed = [];
/** 已知被接管的主機。不論狀態碼都要單獨列出，且永不計入健康。 */
const hijackedHits = [];
let healthy = 0;

for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (!r) continue; // 預算用盡，未檢查
    const item = { url: targets[i].url, occurrences: targets[i].occurrences ?? [], reason: describeResult(r) };

    if (isBlockedResult(r)) {
        blocked.push({ ...item, reason: r.reason });
        continue;
    }
    // 接管的判定必須在三態分類**之前**：被接管的網域回的就是 200，
    // 走到 classifyLink 就會被算進 healthy，等於用檢查器替博弈站背書。
    const hijack = matchHijacked(hijackedEntries, targets[i].url);
    if (hijack) {
        hijackedHits.push({ ...item, policy: hijack, source: 'url' });
        continue;
    }
    const verdict = classifyLink(r);
    if (verdict === 'dead') {
        // 例外政策**不會**在這裡出現。404/410 與網域解析不到一律照實回報——
        // allowlist 只降低 unverified 的噪音，把確定壞掉的連結壓下去等於廢掉整個檢查。
        dead.push(item);
    } else if (verdict === 'unverified') {
        const policy = matchPolicy(policyEntries, targets[i].url);
        if (policy) suppressed.push({ ...item, policy });
        else unverified.push(item);
    } else {
        healthy++;
    }
}

// ── 內文裸網域 ──
// 盤點裡存的是「候選」：擷取是純字串規則，跑在不能連網的確定性檢查裡，因此
// Node.js／fuse.min.js／competitions.html 這類形態相符但不是網域的東西也在裡面。
// 這裡用 DNS 根區把它們篩掉——查 TLD 的 NS 記錄，自我維護、不必養一份 TLD 清單。
//
// 刻意**不**用「這個網域解析得到嗎」當作「它算不算網域」的判準。實測兩頭都錯：
// concordreview.org 正是已停用、查不到 A 記錄的網域，而那恰好是要抓的東西；
// 反過來 readme.md、logo.ai、test.sh 都被蹲域名的人註冊、解析得到。詳見
// bare-domains.lib.mjs 的檔頭。
const BARE_BUDGET_MS = 3 * 60_000;
const bareInfo = inventory.bareDomainCandidates ?? { total: 0, alreadyCoveredByUrls: 0, hosts: [] };
const bareCandidates = limit > 0 ? bareInfo.hosts.slice(0, limit) : bareInfo.hosts;
const occurrencesOfHost = new Map(bareCandidates.map((h) => [h.host, h.occurrences ?? []]));

const { accepted: bareHosts, rejected: bareRejected } = await screenBareDomains(
    bareCandidates.map((h) => h.host),
    { resolveNs: (name) => dns.promises.resolveNs(name) },
);

const bareDead = [];
const bareBlocked = [];
const bareOther = [];
let bareHealthy = 0;
let bareSkipped = 0;
if (bareHosts.length) {
    const { results: bareResults, skipped: bs } = await runProbes(bareHosts.map(probeUrlFor), {
        concurrency: CONCURRENCY,
        budgetMs: BARE_BUDGET_MS,
        rotateSeed: weekIndex * CONCURRENCY,
    });
    bareSkipped = bs;
    for (let i = 0; i < bareHosts.length; i++) {
        const r = bareResults[i];
        if (!r) continue;
        const host = bareHosts[i];
        const item = { url: probeUrlFor(host), host, occurrences: occurrencesOfHost.get(host) ?? [], reason: describeResult(r) };
        if (isBlockedResult(r)) {
            bareBlocked.push({ ...item, reason: r.reason });
            continue;
        }
        const hijack = matchHijacked(hijackedEntries, item.url);
        if (hijack) {
            hijackedHits.push({ ...item, policy: hijack, source: 'bare' });
            continue;
        }
        const verdict = classifyLink(r);
        if (verdict === 'dead') bareDead.push(item);
        else if (verdict === 'unverified') bareOther.push(item);
        else bareHealthy++;
    }
}

const coverageComplete = skipped === 0 && bareSkipped === 0;
// 被接管的網域一定要讓人看到——它回 200，不會出現在任何一個「壞掉」的桶子裡。
const needsAttention =
    dead.length > 0 || blocked.length > 0 || bareDead.length > 0 || bareBlocked.length > 0 || hijackedHits.length > 0 || !coverageComplete;

const sourcesOf = (item) => [...new Set(item.occurrences.map((o) => o.file))].sort();
// 出處全列會炸掉報告：同一個網址可能出現在 90 幾個頁面（例如共用的頁尾連結），
// 一筆失效就吃掉整個 issue 的可讀性。列前幾個、其餘只給數字。
const MAX_SOURCES_SHOWN = 5;
const sourceLines = (item) => {
    const all = sourcesOf(item);
    const out = all.slice(0, MAX_SOURCES_SHOWN).map((s) => `  - 出處：\`${s}\``);
    if (all.length > MAX_SOURCES_SHOWN) out.push(`  - …另有 ${all.length - MAX_SOURCES_SHOWN} 處引用（共 ${all.length} 個檔案）`);
    return out;
};
const coveredElsewhere = (item) => ALSO_COVERED_BY.filter((c) => sourcesOf(item).includes(c.file));

// ── 主控台摘要 ──
console.log('全站外部連結檢查');
console.log(`  盤點來源：${INVENTORY_PATH}（${inventory.urls.length} 個去重網址）`);
console.log(`  本次檢查：${targets.length}`);
console.log(`  健康　　：${healthy}`);
console.log(`  失效　　：${dead.length}`);
console.log(`  位址封鎖：${blocked.length}`);
console.log(`  無法判定：${unverified.length}`);
console.log(`  已列例外：${suppressed.length}`);
if (skipped) console.log(`  未檢查　：${skipped}（逾時間預算）`);
console.log('內文裸網域（只寫在說明文字裡的網域）');
console.log(`  盤點候選：${bareInfo.total}（其中 ${bareInfo.alreadyCoveredByUrls} 個已由 url 欄位涵蓋，不重複檢查）`);
console.log(`  DNS 篩掉：${bareRejected.length}（TLD 不存在＝檔名或縮寫，不是網域）`);
console.log(`  實際探測：${bareHosts.length}`);
console.log(`  健康　　：${bareHealthy}`);
console.log(`  失效　　：${bareDead.length}`);
console.log(`  位址封鎖：${bareBlocked.length}`);
console.log(`  無法判定：${bareOther.length}`);
if (bareSkipped) console.log(`  未檢查　：${bareSkipped}（逾時間預算）`);
if (hijackedHits.length) console.log(`🚨 已知被接管的網域：${hijackedHits.length}`);

// ── Markdown 報告 ──
const lines = [EXTERNAL_LINKS_MARKER, '', '## 全站外部連結檢查報告', ''];
lines.push(`- 檢查日期：${todayISO}（UTC）`);
lines.push(`- 盤點：${inventory.urls.length} 個去重外部網址，來自 check-built-site.mjs 的建置產物掃描`);
lines.push(`- 本次檢查 ${targets.length} 筆：健康 ${healthy}、失效 ${dead.length}、位址封鎖 ${blocked.length}、無法判定 ${unverified.length}、已列例外 ${suppressed.length}`);
lines.push(
    `- 內文裸網域：盤點候選 ${bareInfo.total}（${bareInfo.alreadyCoveredByUrls} 個已由 url 欄位涵蓋）、DNS 篩掉 ${bareRejected.length}、實際探測 ${bareHosts.length}（健康 ${bareHealthy}、失效 ${bareDead.length}、無法判定 ${bareOther.length}）`,
);
lines.push('');

if (hijackedHits.length) {
    lines.push('### 🚨 已知被接管的網域（狀態碼健康，內容已經換人）', '');
    lines.push(
        '這些主機列在 `scripts/link-policy.json` 的 `hijacked`。它們多半回 HTTP 200——三態分類看不出任何異常，',
        '所以必須靠這份名單標出來。名單只會**放大**訊號，不會壓低任何東西；每一筆都有到期日，到期會讓確定性 CI 紅，',
        '強迫重新查證「它是否仍被接管」。',
        '',
    );
    for (const h of hijackedHits) {
        lines.push(`- **${h.policy.match.host}**（本次探測：${h.reason}）`);
        lines.push(`  - 來源：${h.source === 'bare' ? '說明文字裡的裸網域' : 'url 欄位'}　\`${h.url}\``);
        lines.push(`  - 情況：${h.policy.reason}`);
        lines.push(`  - 證據：${h.policy.evidence}`);
        lines.push(`  - 負責人：${h.policy.owner}　重新查證期限：${h.policy.expires}`);
        lines.push(...sourceLines(h));
    }
    lines.push('');
}

if (blocked.length) {
    lines.push('### 🛑 網址被位址政策擋下（請立刻檢查資料是否被竄改）', '');
    lines.push('這些網址指向 loopback／私有網段／link-local／雲端 metadata，健檢拒絕連線。', '');
    lines.push('正常的教育資源不會長這樣；出現在這裡代表資料檔被寫錯或被動過手腳。', '');
    for (const b of blocked) {
        lines.push(`- **${b.reason}**`);
        lines.push(`  - 網址：\`${b.url}\``);
        lines.push(...sourceLines(b));
    }
    lines.push('');
}

if (dead.length) {
    lines.push('### 🔗 連結失效（網域解析不到或頁面不存在，請更新）', '');
    for (const d of dead) {
        lines.push(`- **${d.reason}**：${d.url}`);
        lines.push(...sourceLines(d));
        for (const c of coveredElsewhere(d)) lines.push(`  - 註：此檔另由 ${c.by} 檢查，可能會在兩處看到同一筆`);
    }
    lines.push('');
}

if (bareDead.length || bareBlocked.length) {
    lines.push('### 🔤 說明文字裡的網域失效（請改寫內文或補上現行網址）', '');
    lines.push(
        '這些網域只出現在說明文字裡、沒有做成連結，所以讀者不會點到——但它們仍然值得每週看一次。',
        '',
        '有兩種情況，處理方式不同：',
        '',
        '1. **內文把它當成現行網址在介紹** → 資料錯了，請改寫敘述或補上正確的現行網址。',
        '2. **內文本來就說它已經停用**（例如「原 X 已轉址至 Y」）→ 資料是對的，不必改。',
        '   這一筆會一直出現在這裡，那是刻意的：我們的內文點名了一個沒有主人的網域，',
        '   而沒有主人的網域隨時可能被別人註冊走。ieso-info.org 與 www.sasmo.sg 就是這樣',
        '   變成博弈站與廣告漏斗的。持續盯著它，改天它從「解析不到」變成「HTTP 200」，',
        '   就是該把它加進 link-policy.json 的 hijacked 名單的時候。',
        '',
    );
    for (const d of [...bareBlocked, ...bareDead]) {
        lines.push(`- **${d.reason}**：${d.host}`);
        lines.push(...sourceLines(d));
    }
    lines.push('');
}

if (bareOther.length) {
    lines.push(
        `<details><summary>🔤 說明文字裡的網域無法判定 ${bareOther.length} 筆</summary>`,
        '',
    );
    for (const u of bareOther) lines.push(`- ${u.reason}：${u.host}`);
    lines.push('', '</details>', '');
}

if (bareRejected.length) {
    lines.push(
        `<details><summary>🧪 被 DNS 篩掉的裸網域候選 ${bareRejected.length} 筆（不是網域，未探測）</summary>`,
        '',
        '擷取規則是純字串比對，會擷到檔名與縮寫。這裡用「該 TLD 在 DNS 根區存不存在」把它們篩掉，',
        '列出來是為了讓擷取規則退化時看得出來——這一區應該只有檔名，出現真的網域就是規則出問題了。',
        '',
    );
    for (const r of bareRejected) lines.push(`- ${r.host} — ${r.reason}`);
    lines.push('', '</details>', '');
}

if (skipped || bareSkipped) {
    lines.push('### ⏱️ 檢查未完成（覆蓋不完整）', '');
    lines.push(
        `本次有 ${skipped + bareSkipped} 筆未檢查（逾 ${BUDGET_MS / 60_000} + ${BARE_BUDGET_MS / 60_000} 分鐘預算）。**未檢查不等於正常**，這批網址本次沒有被驗證過。`,
        '',
        '起點每週輪替，長期覆蓋率會均勻；但若連續數週出現，代表預算或併發數需要調整。',
        '',
    );
}

if (unverified.length) {
    // 「無法判定」底下其實有兩種完全不同的東西，先前被同一句「多為防爬機制，通常
    // 瀏覽器仍可開啟，不需處理」蓋過去：
    //
    //   403／429／5xx  → 站台有回應，只是拒絕這個 client。瀏覽器多半打得開。
    //   逾時／連線被拒 → TCP 層完全不通。這種很可能是真的死站，只是我們刻意不把它
    //                    判成 dead——runner 的網路環境（境外資料中心 IP）常被台灣的
    //                    政府與學校站台整段封鎖，貿然判死會產生大量誤報。
    //
    // 實際發生過：sdl.ntl.edu.tw（6 個頁面引用）與 12basic.edu.tw 在台灣本地也是
    // 連線逾時，等於已經死掉，卻被那句「不需處理」放行。分類規則刻意不改（只有
    // ENOTFOUND 與 404/410 才開 issue），但報告必須讓人看得出差別。
    // 依「結構化的 status / code」分類，不要比對 describeResult 產出的中文字串。
    // 第一版就是用字串比對，結果「轉址次數超過上限」（ETOOMANYREDIRECTS）被歸進
    // 「防爬，瀏覽器通常仍可開啟」——但轉址迴圈在瀏覽器裡一樣是壞的。顯示字串是
    // 給人看的，會被改寫、會有 fallback 直接吐出原始 code，不該拿來當判斷依據。
    const bucketOf = (u) => {
        if (u.status) return 'rejected'; // 有 HTTP 狀態碼＝站台有回應（403／429／5xx…）
        const c = String(u.code || '');
        if (/TIMEOUT|ETIMEDOUT|ABORT_ERR|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE/i.test(c)) {
            return 'unreachable';
        }
        return 'other'; // TLS、轉址迴圈、以及任何我們還沒歸類過的 code
    };
    const unreachable = unverified.filter((u) => bucketOf(u) === 'unreachable');
    const rejected = unverified.filter((u) => bucketOf(u) === 'rejected');
    const other = unverified.filter((u) => bucketOf(u) === 'other');

    if (unreachable.length) {
        lines.push(
            `<details open><summary>⚠️ 連得上但沒有回應的連結 ${unreachable.length} 筆（TCP 層不通，<strong>值得人工確認是否已停站</strong>）</summary>`,
            '',
            'runner 位於境外資料中心，台灣的政府／學校站台常整段封鎖這類 IP，所以不自動判定為失效。',
            '但若你在本地瀏覽器也開不起來，那就是真的停站了，請更新或移除連結。',
            '',
        );
        for (const u of unreachable) lines.push(`- ${u.reason}：${u.url}`);
        lines.push('', '</details>', '');
    }
    if (rejected.length) {
        lines.push(
            `<details><summary>ℹ️ 被站台拒絕的連結 ${rejected.length} 筆（有 HTTP 狀態碼，多為防爬機制，瀏覽器通常仍可開啟）</summary>`,
            '',
        );
        for (const u of rejected) lines.push(`- ${u.reason}：${u.url}`);
        lines.push('', '</details>', '');
    }
    if (other.length) {
        // 轉址迴圈、TLS 問題這類「瀏覽器裡也一樣壞」的情況不能混進上面那組，
        // 否則會被「瀏覽器通常仍可開啟」這句話帶過去。
        lines.push(
            `<details open><summary>⚠️ 其他無法判定的連結 ${other.length} 筆（轉址迴圈／TLS 等，<strong>瀏覽器裡多半也是壞的</strong>）</summary>`,
            '',
        );
        for (const u of other) lines.push(`- ${u.reason}：${u.url}`);
        lines.push('', '</details>', '');
    }
}

if (suppressed.length) {
    lines.push(
        `<details><summary>📋 已列入例外政策的連結 ${suppressed.length} 筆（scripts/link-policy.json）</summary>`,
        '',
        '例外只降低 `unverified` 的噪音；若其中任何一筆變成 404/410 或網域解析不到，仍然會出現在上面的「連結失效」。',
        '',
    );
    for (const s of suppressed) {
        lines.push(`- ${s.reason}：${s.url}`);
        lines.push(`  - 理由：${s.policy.reason}`);
        lines.push(`  - 負責人：${s.policy.owner}　到期日：${s.policy.expires}`);
    }
    lines.push('', '</details>', '');
}

if (ALSO_COVERED_BY.length) {
    lines.push('<details><summary>📁 另有專屬看門狗的資料檔</summary>', '');
    for (const c of ALSO_COVERED_BY) lines.push(`- \`${c.file}\` → ${c.by}`);
    lines.push('', '這裡仍然會一起檢查（縱深防禦），只是同一筆失效可能在兩份報告都看得到。', '', '</details>', '');
}

if (!needsAttention && !unverified.length && !bareOther.length) lines.push('✅ 全部外部連結正常。', '');

await writeFile(REPORT_PATH, lines.join('\n'), 'utf8');

if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `needs_attention=${needsAttention}\ncoverage_complete=${coverageComplete}\n`);
}

if (!coverageComplete) console.log(`→ 覆蓋不完整：${skipped} 筆未檢查，不可視為健康。`);
console.log(needsAttention ? '→ 有項目需要處理，已寫入報告。' : '→ 無待辦項目。');
