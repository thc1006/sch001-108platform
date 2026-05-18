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

// 除 deadline 外都必須是「非空字串」；deadline 必須是字串（允許空字串＝依官網公告）
const TEXT_FIELDS = ['title', 'organizer', 'category', 'level', 'form', 'region', 'eligibility', 'mode', 'description', 'url'];
const ALLOWED_CATEGORIES = ['科學', '數理', '資訊', '語文人文', '商業管理', '藝術設計', '社會永續', '跨領域'];
const ALLOWED_LEVELS = ['校際/地區', '全國', '國際'];
const ALLOWED_REGIONS = ['台灣', '美國', '英國', '歐盟', '東亞', '全球線上', '其他'];
const ALLOWED_ELIGIBILITY = ['公開報名', '國家隊選拔', '邀請制'];
const ALLOWED_MODES = ['線上', '實體', '混合'];

// 致命錯誤：寫出錯誤報告、通知 workflow 開 issue，再以非零碼結束。
// 即使在「檔案讀不到 / JSON 無法解析」這種狀況，competitions-check.yml 仍能
// 憑此報告與 needs_attention 輸出開 issue 提醒維護者（workflow 仍會顯示紅燈）。
async function fail(message) {
    console.error(`❌ ${message}`);
    const report = [
        '## 競賽資料檢查報告',
        '',
        '### ❌ 致命錯誤：competitions.json 無法檢查',
        '',
        `- ${message}`,
        '',
    ].join('\n');
    await writeFile(REPORT_PATH, report, 'utf8').catch(() => {});
    if (process.env.GITHUB_OUTPUT) {
        await appendFile(process.env.GITHUB_OUTPUT, 'needs_attention=true\n').catch(() => {});
    }
    process.exit(1);
}

const raw = await readFile(DATA_PATH, 'utf8').catch((err) => fail(`讀不到 competitions.json：${err.message}`));

let data;
try {
    data = JSON.parse(raw);
} catch (err) {
    await fail(`competitions.json 不是合法的 JSON：${err.message}`);
}

if (data === null || typeof data !== 'object' || !Array.isArray(data.competitions)) {
    await fail('competitions.json 的最外層必須是物件，且需包含 competitions 陣列');
}

const list = data.competitions;

// 以台灣時間 (UTC+8) 的當天日期為基準。today 與 deadline 都化為「日曆日」
// 的 UTC 零點數值再相減，得到精確天數差，不受執行環境（CI 為 UTC）時區影響。
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const taipeiToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
}).format(new Date());
const [todayYear, todayMonth, todayDay] = taipeiToday.split('-').map(Number);
const todayUTC = Date.UTC(todayYear, todayMonth - 1, todayDay);

const schemaErrors = [];
const expired = [];
const expiringSoon = [];

list.forEach((comp, index) => {
    if (comp === null || typeof comp !== 'object' || Array.isArray(comp)) {
        schemaErrors.push(`第 ${index + 1} 筆競賽不是有效的物件`);
        return;
    }
    const label = typeof comp.title === 'string' && comp.title.trim() ? comp.title : `第 ${index + 1} 筆`;

    // 必填文字欄位：必須存在且為非空字串（頁面會直接當字串用，例如 comp.form.includes()）
    for (const field of TEXT_FIELDS) {
        if (!(field in comp)) {
            schemaErrors.push(`「${label}」缺少欄位：${field}`);
        } else if (typeof comp[field] !== 'string' || comp[field].trim() === '') {
            schemaErrors.push(`「${label}」的欄位 ${field} 必須是非空字串`);
        }
    }
    if (typeof comp.category === 'string' && !ALLOWED_CATEGORIES.includes(comp.category)) {
        schemaErrors.push(`「${label}」的 category「${comp.category}」不在允許清單內`);
    }
    if (typeof comp.level === 'string' && !ALLOWED_LEVELS.includes(comp.level)) {
        schemaErrors.push(`「${label}」的 level「${comp.level}」不在允許清單內`);
    }
    if (typeof comp.region === 'string' && !ALLOWED_REGIONS.includes(comp.region)) {
        schemaErrors.push(`「${label}」的 region「${comp.region}」不在允許清單內`);
    }
    if (typeof comp.eligibility === 'string' && !ALLOWED_ELIGIBILITY.includes(comp.eligibility)) {
        schemaErrors.push(`「${label}」的 eligibility「${comp.eligibility}」不在允許清單內`);
    }
    if (typeof comp.mode === 'string' && !ALLOWED_MODES.includes(comp.mode)) {
        schemaErrors.push(`「${label}」的 mode「${comp.mode}」不在允許清單內`);
    }

    // deadline：必須存在且為字串；空字串代表「依官網公告」
    if (!('deadline' in comp)) {
        schemaErrors.push(`「${label}」缺少欄位：deadline`);
        return;
    }
    if (typeof comp.deadline !== 'string') {
        schemaErrors.push(`「${label}」的 deadline 必須是字串（YYYY-MM-DD 格式或空字串）`);
        return;
    }
    if (comp.deadline === '') return; // 空字串代表「依官網公告」，屬正常狀況

    // 嚴格驗證：先比對 YYYY-MM-DD 格式，再做日期往返檢查
    const matched = DATE_RE.exec(comp.deadline);
    if (!matched) {
        schemaErrors.push(`「${label}」的 deadline「${comp.deadline}」格式不符 YYYY-MM-DD`);
        return;
    }
    const year = Number(matched[1]);
    const month = Number(matched[2]);
    const day = Number(matched[3]);
    const deadlineUTC = Date.UTC(year, month - 1, day);
    const parsed = new Date(deadlineUTC);
    // 例如 2026-02-30 會被 Date 正規化成 3 月，往返比對可抓出這種不存在的日期
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
        schemaErrors.push(`「${label}」的 deadline「${comp.deadline}」不是實際存在的日期`);
        return;
    }

    const diffDays = Math.ceil((deadlineUTC - todayUTC) / 86_400_000);
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
lines.push(`- 檢查日期：${taipeiToday}（台灣時間）`);
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
