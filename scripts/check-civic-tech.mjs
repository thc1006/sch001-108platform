#!/usr/bin/env node
/**
 * 公民科技專案地圖資料看門狗
 * --------------------------------------------------------------
 * 檢查 public/civic-tech-map/projects.json：
 *   1. JSON 格式與必填欄位是否正確
 *   2. id 格式（小寫英數與連字號）與唯一性
 *   3. status 欄位值是否在允許清單內
 *   4. subjects / competencies / sdgs 陣列的型別與內容
 *      - competencies 須符合 108 課綱核心素養代碼（A1-A3、B1-B3、C1-C3）
 *      - sdgs 須為 1-17 的整數
 *   5. url 是否為合法的 http(s) 連結
 *   6. 哪些專案 status 為 dormant（近期活動較少，需提醒讀者查證最新狀態）
 *
 * 由 .github/workflows/civic-tech-check.yml 每週執行；發現「欄位錯誤」或
 * 「有 dormant 專案」時，workflow 會自動開 / 更新一個 issue 提醒維護者。
 *
 * 本機執行：  node scripts/check-civic-tech.mjs
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';

// 公民科技專案資料的單一家為 public/(會被 astro build 複製進 dist/);
// 看門狗讀此處,並與 src/pages/civic-tech-map/index.astro 頁面內容對應。
const DATA_PATH = new URL('../public/civic-tech-map/projects.json', import.meta.url);
const REPORT_PATH = 'civic-tech-report.md';

// 必填文字欄位:必須存在且為非空字串
const TEXT_FIELDS = ['id', 'name', 'org', 'url', 'description'];
// 必填陣列欄位:必須存在且為陣列(sdgs 允許空陣列＝無對應 SDG)
const ARRAY_FIELDS = ['subjects', 'competencies', 'sdgs'];
const ALLOWED_STATUS = ['active', 'maintenance', 'dormant'];
// 108 課綱核心素養代碼:三面九項(A1-A3 自主行動、B1-B3 溝通互動、C1-C3 社會參與)
const COMPETENCY_RE = /^[ABC][1-3]$/;
const ID_RE = /^[a-z0-9-]+$/;

// 致命錯誤:寫出錯誤報告、通知 workflow 開 issue,再以非零碼結束。
// 即使在「檔案讀不到 / JSON 無法解析」這種狀況,civic-tech-check.yml 仍能
// 憑此報告與 needs_attention 輸出開 issue 提醒維護者(workflow 仍會顯示紅燈)。
async function fail(message) {
    console.error(`❌ ${message}`);
    const report = [
        '## 公民科技專案地圖資料檢查報告',
        '',
        '### ❌ 致命錯誤：projects.json 無法檢查',
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

const raw = await readFile(DATA_PATH, 'utf8').catch((err) => fail(`讀不到 projects.json：${err.message}`));

let data;
try {
    data = JSON.parse(raw);
} catch (err) {
    await fail(`projects.json 不是合法的 JSON：${err.message}`);
}

if (data === null || typeof data !== 'object' || !Array.isArray(data.projects)) {
    await fail('projects.json 的最外層必須是物件，且需包含 projects 陣列');
}

const list = data.projects;

// 以台灣時間 (UTC+8) 的當天日期為基準,僅供報告標示用。
const taipeiToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
}).format(new Date());

const schemaErrors = [];
const linkWarnings = [];
const dormant = [];
const seenIds = new Set();

list.forEach((proj, index) => {
    if (proj === null || typeof proj !== 'object' || Array.isArray(proj)) {
        schemaErrors.push(`第 ${index + 1} 筆專案不是有效的物件`);
        return;
    }
    const label = typeof proj.name === 'string' && proj.name.trim() ? proj.name : `第 ${index + 1} 筆`;

    // 必填文字欄位:必須存在且為非空字串
    for (const field of TEXT_FIELDS) {
        if (!(field in proj)) {
            schemaErrors.push(`「${label}」缺少欄位：${field}`);
        } else if (typeof proj[field] !== 'string' || proj[field].trim() === '') {
            schemaErrors.push(`「${label}」的欄位 ${field} 必須是非空字串`);
        }
    }

    // id:格式須為小寫英數與連字號,且全檔不可重複(對應頁面 anchor)
    if (typeof proj.id === 'string' && proj.id.trim() !== '') {
        if (!ID_RE.test(proj.id)) {
            schemaErrors.push(`「${label}」的 id「${proj.id}」格式不符（僅允許小寫英數與連字號）`);
        }
        if (seenIds.has(proj.id)) {
            schemaErrors.push(`id「${proj.id}」重複出現,每筆專案的 id 必須唯一`);
        }
        seenIds.add(proj.id);
    }

    // 必填陣列欄位:必須存在且為陣列
    for (const field of ARRAY_FIELDS) {
        if (!(field in proj)) {
            schemaErrors.push(`「${label}」缺少欄位：${field}`);
        } else if (!Array.isArray(proj[field])) {
            schemaErrors.push(`「${label}」的欄位 ${field} 必須是陣列`);
        }
    }

    // subjects:陣列內每一項須為非空字串,且至少有一項
    if (Array.isArray(proj.subjects)) {
        if (proj.subjects.length === 0) {
            schemaErrors.push(`「${label}」的 subjects 至少需要一個學科領域`);
        }
        proj.subjects.forEach((s, i) => {
            if (typeof s !== 'string' || s.trim() === '') {
                schemaErrors.push(`「${label}」的 subjects 第 ${i + 1} 項必須是非空字串`);
            }
        });
    }

    // competencies:陣列內每一項須符合 108 課綱核心素養代碼,且至少有一項
    if (Array.isArray(proj.competencies)) {
        if (proj.competencies.length === 0) {
            schemaErrors.push(`「${label}」的 competencies 至少需要一個核心素養代碼`);
        }
        proj.competencies.forEach((c) => {
            if (typeof c !== 'string' || !COMPETENCY_RE.test(c)) {
                schemaErrors.push(`「${label}」的 competencies「${c}」不是合法的核心素養代碼（須為 A1-A3、B1-B3、C1-C3）`);
            }
        });
    }

    // sdgs:陣列內每一項須為 1-17 的整數(允許空陣列)
    if (Array.isArray(proj.sdgs)) {
        proj.sdgs.forEach((n) => {
            if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 17) {
                schemaErrors.push(`「${label}」的 sdgs「${n}」不是合法的 SDG 編號（須為 1-17 的整數）`);
            }
        });
    }

    // status:必填,且須在允許清單內
    if (!('status' in proj)) {
        schemaErrors.push(`「${label}」缺少欄位：status`);
    } else if (typeof proj.status !== 'string' || !ALLOWED_STATUS.includes(proj.status)) {
        schemaErrors.push(`「${label}」的 status「${proj.status}」不在允許清單內（${ALLOWED_STATUS.join(' / ')}）`);
    } else if (proj.status === 'dormant') {
        dormant.push({ label, url: typeof proj.url === 'string' ? proj.url : '' });
    }

    // url:須為合法的 http(s) 連結
    if (typeof proj.url === 'string' && proj.url.trim() !== '') {
        let parsed;
        try {
            parsed = new URL(proj.url);
        } catch {
            parsed = null;
        }
        if (!parsed) {
            schemaErrors.push(`「${label}」的 url「${proj.url}」不是合法的 URL`);
        } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            schemaErrors.push(`「${label}」的 url「${proj.url}」必須使用 http 或 https 通訊協定`);
        } else if (parsed.protocol === 'http:') {
            // http 連結可運作但不安全,列入提醒供維護者升級為 https
            linkWarnings.push(`「${label}」的 url 使用未加密的 http,建議改用 https：${proj.url}`);
        }
    }
});

const needsAttention = schemaErrors.length > 0 || dormant.length > 0 || linkWarnings.length > 0;

// ---- 主控台摘要 ----
console.log(`公民科技專案資料檢查（資料版本 ${data.lastUpdated || '未標記'}）`);
console.log(`  專案總數：${list.length}`);
console.log(`  欄位錯誤：${schemaErrors.length}`);
console.log(`  連結提醒：${linkWarnings.length}`);
console.log(`  待查證　：${dormant.length}（status 為 dormant）`);

// ---- Markdown 報告(供 workflow 開 issue 用)----
const lines = ['## 公民科技專案地圖資料檢查報告', ''];
lines.push(`- 檢查日期：${taipeiToday}（台灣時間）`);
lines.push(`- 資料最後更新：${data.lastUpdated || '未標記'}`);
lines.push(`- 專案總數：${list.length}`);
lines.push('');

if (schemaErrors.length) {
    lines.push('### ⚠️ 欄位錯誤（請修正 projects.json）', '');
    for (const e of schemaErrors) lines.push(`- ${e}`);
    lines.push('');
}
if (linkWarnings.length) {
    lines.push('### 🟠 連結提醒（建議改善）', '');
    for (const w of linkWarnings) lines.push(`- ${w}`);
    lines.push('');
}
if (dormant.length) {
    lines.push('### 🟡 近期活動較少的專案（請查證最新狀態，必要時更新或移除）', '');
    for (const d of dormant) lines.push(`- **${d.label}**${d.url ? `　${d.url}` : ''}`);
    lines.push('');
}
if (!needsAttention) {
    lines.push('✅ 一切正常，沒有欄位錯誤、連結問題或待查證項目。', '');
}

await writeFile(REPORT_PATH, lines.join('\n'), 'utf8');

// ---- 回傳結果給 GitHub Actions ----
if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `needs_attention=${needsAttention}\n`);
}

// 欄位錯誤屬於資料結構問題,需以非零碼結束讓 CI 顯示紅燈;
// dormant 與連結提醒只是維護提醒,不算建置失敗,以零碼結束。
if (schemaErrors.length) {
    console.error('→ 有欄位錯誤,請修正 projects.json。');
    process.exit(1);
}
console.log(needsAttention ? '→ 有項目需要處理，已寫入報告。' : '→ 無待辦項目。');
