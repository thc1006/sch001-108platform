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
 * ── 三態 ──
 *   dead       網域解析不到、404/410      → 觸發 issue
 *   unverified 403/429/5xx/逾時/TLS       → 只記錄（多為防爬，瀏覽器仍可開）
 *   healthy    2xx/3xx                    → 不處理
 * 另有第四種訊號（不是第四態）：被位址政策擋下。它在分類上算 unverified（我們
 * 確實沒驗到），但必須單獨大聲列出——資料檔裡出現指向 loopback／私網／雲端
 * metadata 的網址，意義是資料被動了手腳或寫錯，不是站台防爬。
 *
 * 本機執行：  node scripts/check-external-links.mjs
 *             node scripts/check-external-links.mjs --limit 20   （只驗前 N 筆）
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyLink, describeResult, isBlockedResult, runProbes } from './link-health.lib.mjs';
import { validatePolicy, matchPolicy } from './link-policy.lib.mjs';
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
try {
    const { errors, entries } = validatePolicy(JSON.parse(await readFile(POLICY_PATH, 'utf8')), todayISO);
    if (errors.length) {
        await die(`link-policy.json 無效（${errors.length} 項）：${errors.join('；')}。請先修好政策檔再跑健檢。`);
    }
    policyEntries = entries;
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
let healthy = 0;

for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (!r) continue; // 預算用盡，未檢查
    const item = { url: targets[i].url, occurrences: targets[i].occurrences ?? [], reason: describeResult(r) };

    if (isBlockedResult(r)) {
        blocked.push({ ...item, reason: r.reason });
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

const coverageComplete = skipped === 0;
const needsAttention = dead.length > 0 || blocked.length > 0 || !coverageComplete;

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

// ── Markdown 報告 ──
const lines = [EXTERNAL_LINKS_MARKER, '', '## 全站外部連結檢查報告', ''];
lines.push(`- 檢查日期：${todayISO}（UTC）`);
lines.push(`- 盤點：${inventory.urls.length} 個去重外部網址，來自 check-built-site.mjs 的建置產物掃描`);
lines.push(`- 本次檢查 ${targets.length} 筆：健康 ${healthy}、失效 ${dead.length}、位址封鎖 ${blocked.length}、無法判定 ${unverified.length}、已列例外 ${suppressed.length}`);
lines.push('');

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

if (skipped) {
    lines.push('### ⏱️ 檢查未完成（覆蓋不完整）', '');
    lines.push(
        `本次有 ${skipped} 筆未檢查（逾 ${BUDGET_MS / 60_000} 分鐘預算）。**未檢查不等於正常**，這批網址本次沒有被驗證過。`,
        '',
        '起點每週輪替，長期覆蓋率會均勻；但若連續數週出現，代表預算或併發數需要調整。',
        '',
    );
}

if (unverified.length) {
    lines.push(
        `<details><summary>ℹ️ 無法判定的連結 ${unverified.length} 筆（多為防爬機制，通常瀏覽器仍可開啟，不需處理）</summary>`,
        '',
    );
    for (const u of unverified) lines.push(`- ${u.reason}：${u.url}`);
    lines.push('', '</details>', '');
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

if (!needsAttention && !unverified.length) lines.push('✅ 全部外部連結正常。', '');

await writeFile(REPORT_PATH, lines.join('\n'), 'utf8');

if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `needs_attention=${needsAttention}\ncoverage_complete=${coverageComplete}\n`);
}

if (!coverageComplete) console.log(`→ 覆蓋不完整：${skipped} 筆未檢查，不可視為健康。`);
console.log(needsAttention ? '→ 有項目需要處理，已寫入報告。' : '→ 無待辦項目。');
