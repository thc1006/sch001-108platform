#!/usr/bin/env node
// 內容學年度漂移檢查（#116），比對 src/content 底下每個 .md 的學年度和 scripts/admission-cycle.json，
// 判斷在 admission-cycle.lib.mjs。不連網。
//
//   node scripts/check-admission-cycle.mjs
//     設定或內容有錯就以 1 結束。過了 remindAfter、keep 過了 recheckAfter 只印警告，結束碼不看日期，
//     CI 才不會哪天突然變紅。
//
// 測試用 ADMISSION_CYCLE_TODAY（YYYY-MM-DD）指定今天，沒給就用台灣的日期。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkContent, dueKeeps, isPast, isRealDate, taipeiToday, validateConfig } from './admission-cycle.lib.mjs';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const CONFIG = path.join(ROOT, 'scripts/admission-cycle.json');
const CONTENT = path.join(ROOT, 'src/content');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** fail 印出錯誤後以 1 結束。 */
function fail(errors, hint) {
    console.error(`\n錯誤 ${errors.length} 項：`);
    for (const e of errors) console.error(`  ${e}`);
    if (hint) console.error(`\n${hint}`);
    process.exit(1);
}

/** warn 印出警告。在 Actions 上另發 annotation，run 的摘要頁看得到；跳脫照 @actions/core 的 escapeData。 */
function warn(title, message) {
    console.log(`\n警告：${message}`);
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.log(`::warning title=${title}::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
    }
}

const today = process.env.ADMISSION_CYCLE_TODAY || taipeiToday();
if (!isRealDate(today)) fail([`ADMISSION_CYCLE_TODAY 必須是 YYYY-MM-DD 日期，目前是 ${today}`]);

let config;
try {
    config = JSON.parse(readFileSync(CONFIG, 'utf8'));
} catch (err) {
    fail([`讀不到或無法解析 ${rel(CONFIG)}：${err.message}`]);
}
const configErrors = validateConfig(config);
if (configErrors.length) fail(configErrors.map((m) => `${rel(CONFIG)}：${m}`));
const { cycle, next, remindAfter } = config;

// Windows 上 checkout 出來可能是 CRLF，先換成 LF，錯誤訊息的摘錄才不會帶著 \r。
let files;
try {
    files = readdirSync(CONTENT, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => path.join(e.parentPath, e.name))
        .sort()
        .map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8').replace(/\r\n/g, '\n') }));
} catch (err) {
    fail([`讀不到內容目錄 ${rel(CONTENT)}：${err.message}`]);
}

const { errors, found, kept } = checkContent(files, config);
console.log(`學年度檢查：cycle ${cycle}、next ${next}，今天 ${today}（台灣時間），remindAfter ${remindAfter}`);
console.log(`  ${rel(CONTENT)} 底下 ${files.length} 個 .md 檔，找到 ${found} 處學年度和甄選會網址，keep ${config.keep.length} 筆放行 ${kept} 處`);

if (isPast(remindAfter, today)) {
    warn('學年度還沒換屆', `今天 ${today} 已經過了 remindAfter（${remindAfter}），cycle 還是 ${cycle}。內容改成 ${next} 學年度之後，把 cycle 改成 ${next}。`);
}
for (const { index, keep } of dueKeeps(config, today)) {
    warn('keep 該重新確認', `keep[${index}]（${keep.url ?? keep.file}）的 recheckAfter 是 ${keep.recheckAfter}，已經過了，請重新確認還需不需要。`);
}

if (errors.length) {
    fail(
        errors,
        `內容以 ${cycle} 學年度申請入學為準：學年度要寫 ${cycle} 或 ${next}，區間要包含其中一個。確定要保留的舊年度，` +
            `在 ${rel(CONFIG)} 的 keep 加一筆，文字寫 file、text、cycle、reason，網址寫 url、cycle、reason。`,
    );
}
console.log('\n沒有問題。');
