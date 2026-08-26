#!/usr/bin/env node
/**
 * 全站外部連結健康檢查
 * --------------------------------------------------------------
 * 涵蓋 build 產物的 HTML 與資料驅動的 JSON。後者是關鍵：多個頁面在瀏覽器端
 * fetch JSON 才渲染，那些網址不會出現在 HTML 裡，掃 HTML 的 lychee 一個都
 * 看不到（實測 235 個資料檔網址中只有 18 個進到 HTML）。
 *
 * 與 PR gate 的分工：
 *   ci.yml 的 Internal Links → 站內連結，確定性，擋 PR
 *   本檢查               → 外部站台可用性，非確定性，只開 issue／寫 summary
 *
 * 判定沿用 link-health.lib.mjs 的三態，與競賽看門狗完全一致：
 *   dead       網域解析不到、404/410      → 觸發 issue
 *   unverified 403/429/5xx/逾時/TLS       → 只記錄（多為防爬，瀏覽器仍可開）
 *   healthy    2xx/3xx                    → 不處理
 *
 * 本機執行：  node scripts/check-external-links.mjs
 *             node scripts/check-external-links.mjs --limit 20   （只驗前 N 筆）
 */

import { writeFile, appendFile } from 'node:fs/promises';
import { classifyLink, describeResult, runProbes } from './link-health.lib.mjs';
import { collectExternalUrls } from './link-inventory.lib.mjs';

const REPORT_PATH = 'external-links-report.md';

// 已由其他檢查器負責外部可用性的資料檔。每個資料檔都必須有明確 owner——
// 不能存在「沒有任何工具會看到它」的檔案，那正是本次要修掉的失效模式。
const OWNED_ELSEWHERE = [
    { match: 'advanced-resources/competitions.json', owner: 'competitions-check.yml（含語意時效性檢查）' },
];

const argOf = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};

const { entries, stats } = await collectExternalUrls({
    htmlDir: 'dist',
    jsonDir: 'public',
    excludeJson: OWNED_ELSEWHERE.map((o) => o.match),
});

const limit = Number(argOf('--limit') || 0);
const targets = limit > 0 ? entries.slice(0, limit) : entries;

// 以「今年第幾週」輪替起點，讓預算不足時的覆蓋率長期均勻
const weekIndex = Math.floor((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / (7 * 86_400_000));

const { results, skipped } = await runProbes(
    targets.map((t) => t.url),
    { concurrency: 6, budgetMs: 12 * 60_000, rotateSeed: weekIndex * 6 },
);

const dead = [];
const unverified = [];
for (let i = 0; i < targets.length; i++) {
    const r = results[i];
    if (!r) continue; // 預算用盡，未檢查
    const verdict = classifyLink(r);
    if (verdict === 'dead') dead.push({ ...targets[i], reason: describeResult(r) });
    else if (verdict === 'unverified') unverified.push({ ...targets[i], reason: describeResult(r) });
}

const coverageComplete = skipped === 0;
const needsAttention = dead.length > 0 || !coverageComplete;

// ---- 主控台摘要 ----
console.log('全站外部連結檢查');
console.log(`  來源：HTML ${stats.htmlFiles} 檔、JSON ${stats.jsonFiles} 檔`);
console.log(`  去重後網址：${entries.length}（本次檢查 ${targets.length}）`);
console.log(`  失效　：${dead.length}`);
console.log(`  無法判定：${unverified.length}`);
if (skipped) console.log(`  未檢查：${skipped}（逾時間預算）`);

// ---- Markdown 報告 ----
const lines = ['<!-- external-links-watchdog:v1 -->', '', '## 全站外部連結檢查報告', ''];
lines.push(`- 檢查日期：${new Date().toISOString().slice(0, 10)}（UTC）`);
lines.push(`- 來源：build 產物 HTML ${stats.htmlFiles} 檔、資料檔 JSON ${stats.jsonFiles} 檔`);
lines.push(`- 去重後外部網址：${entries.length}`);
lines.push('');

if (OWNED_ELSEWHERE.length) {
    lines.push('<details><summary>📁 由其他檢查器負責的資料檔（本報告不重複檢查）</summary>', '');
    for (const o of OWNED_ELSEWHERE) lines.push(`- \`${o.match}\` → ${o.owner}`);
    lines.push('', '</details>', '');
}

if (dead.length) {
    lines.push('### 🔗 連結失效（網域解析不到或頁面不存在，請更新）', '');
    for (const d of dead) {
        lines.push(`- **${d.reason}**：${d.url}`);
        for (const s of d.sources) lines.push(`  - 出處：\`${s}\``);
    }
    lines.push('');
}

if (skipped) {
    lines.push('### ⏱️ 檢查未完成（覆蓋不完整）', '');
    lines.push(`本次有 ${skipped} 筆未檢查（逾時間預算）。**未檢查不等於正常**，這批網址本次沒有被驗證過。`, '');
}

if (unverified.length) {
    lines.push(
        `<details><summary>ℹ️ 無法判定的連結 ${unverified.length} 筆（多為防爬機制，通常瀏覽器仍可開啟，不需處理）</summary>`,
        '',
    );
    for (const u of unverified) lines.push(`- ${u.reason}：${u.url}`);
    lines.push('', '</details>', '');
}

if (!needsAttention && !unverified.length) {
    lines.push('✅ 全部外部連結正常。', '');
}

await writeFile(REPORT_PATH, lines.join('\n'), 'utf8');

if (process.env.GITHUB_OUTPUT) {
    await appendFile(
        process.env.GITHUB_OUTPUT,
        `needs_attention=${needsAttention}\ncoverage_complete=${coverageComplete}\n`,
    );
}

if (!coverageComplete) console.log(`→ 覆蓋不完整：${skipped} 筆未檢查，不可視為健康。`);
console.log(needsAttention ? '→ 有項目需要處理，已寫入報告。' : '→ 無待辦項目。');
