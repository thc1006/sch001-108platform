#!/usr/bin/env node
/**
 * 競賽資料看門狗
 * --------------------------------------------------------------
 * 檢查 advanced-resources/competitions.json：
 *   1. JSON 格式與必填欄位是否正確
 *   2. category / level 欄位值是否在允許清單內
 *   3. deadline 是否為合法日期
 *   4. 是否有競賽報名截止日「已過期」（資料過時，需要更新）
 *   5. 哪些競賽「即將截止」（僅列入報告參考，不觸發提醒）
 *
 * 由 .github/workflows/competitions-check.yml 每週執行；發現「過期」或
 * 「欄位錯誤」時，workflow 會自動開 / 更新一個 issue 提醒維護者。
 *
 * 本機執行：  node scripts/check-competitions.mjs
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';

const DATA_PATH = new URL('../advanced-resources/competitions.json', import.meta.url);
const REPORT_PATH = 'competition-report.md';
const SOON_DAYS = 30;

const REQUIRED_FIELDS = ['title', 'organizer', 'category', 'level', 'form', 'description', 'deadline', 'url'];
const ALLOWED_CATEGORIES = ['科學', '數理', '資訊', '語文人文', '商業管理', '藝術設計'];
const ALLOWED_LEVELS = ['校際/地區', '全國', '國際'];

function fail(message) {
    console.error(`❌ ${message}`);
    process.exit(1);
}

const raw = await readFile(DATA_PATH, 'utf8').catch((err) => fail(`讀不到 competitions.json：${err.message}`));

let data;
try {
    data = JSON.parse(raw);
} catch (err) {
    fail(`competitions.json 不是合法的 JSON：${err.message}`);
}

if (!Array.isArray(data.competitions)) {
    fail('competitions.json 缺少 competitions 陣列');
}

const list = data.competitions;
const today = new Date();
today.setHours(0, 0, 0, 0);

const schemaErrors = [];
const expired = [];
const expiringSoon = [];

list.forEach((comp, index) => {
    const label = comp.title || `第 ${index + 1} 筆`;

    for (const field of REQUIRED_FIELDS) {
        if (!(field in comp)) schemaErrors.push(`「${label}」缺少欄位：${field}`);
    }
    if (comp.category && !ALLOWED_CATEGORIES.includes(comp.category)) {
        schemaErrors.push(`「${label}」的 category「${comp.category}」不在允許清單內`);
    }
    if (comp.level && !ALLOWED_LEVELS.includes(comp.level)) {
        schemaErrors.push(`「${label}」的 level「${comp.level}」不在允許清單內`);
    }

    if (!comp.deadline) return; // 空字串代表「依官網公告」，屬正常狀況

    const deadline = new Date(comp.deadline);
    if (Number.isNaN(deadline.getTime())) {
        schemaErrors.push(`「${label}」的 deadline「${comp.deadline}」不是合法日期（請用 YYYY-MM-DD）`);
        return;
    }

    const diffDays = Math.ceil((deadline - today) / 86_400_000);
    if (diffDays < 0) {
        expired.push({ label, deadline: comp.deadline });
    } else if (diffDays <= SOON_DAYS) {
        expiringSoon.push({ label, deadline: comp.deadline, diffDays });
    }
});

const needsAttention = schemaErrors.length > 0 || expired.length > 0;

// ---- 主控台摘要 ----
console.log(`競賽資料檢查（資料版本 ${data.lastUpdated || '未標記'}）`);
console.log(`  競賽總數：${list.length}`);
console.log(`  欄位錯誤：${schemaErrors.length}`);
console.log(`  已過期　：${expired.length}`);
console.log(`  即將截止：${expiringSoon.length}`);

// ---- Markdown 報告（供 workflow 開 issue 用）----
const lines = ['## 競賽資料檢查報告', ''];
lines.push(`- 檢查日期：${today.toISOString().slice(0, 10)}`);
lines.push(`- 資料最後更新：${data.lastUpdated || '未標記'}`);
lines.push(`- 競賽總數：${list.length}`);
lines.push('');

if (schemaErrors.length) {
    lines.push('### ⚠️ 欄位錯誤（請修正 competitions.json）', '');
    for (const e of schemaErrors) lines.push(`- ${e}`);
    lines.push('');
}
if (expired.length) {
    lines.push('### 🔴 報名截止日已過期（資料過時，請更新或移除）', '');
    for (const e of expired) lines.push(`- **${e.label}**　截止日 ${e.deadline} 已過`);
    lines.push('');
}
if (expiringSoon.length) {
    lines.push(`### 🟡 ${SOON_DAYS} 天內即將截止（僅供參考，頁面會自動標示）`, '');
    for (const e of expiringSoon) lines.push(`- ${e.label}　截止日 ${e.deadline}（剩 ${e.diffDays} 天）`);
    lines.push('');
}
if (!needsAttention && !expiringSoon.length) {
    lines.push('✅ 一切正常，沒有過期或欄位錯誤。', '');
}

await writeFile(REPORT_PATH, lines.join('\n'), 'utf8');

// ---- 回傳結果給 GitHub Actions ----
if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `needs_attention=${needsAttention}\n`);
}

console.log(needsAttention ? '→ 有項目需要處理，已寫入報告。' : '→ 無待辦項目。');
