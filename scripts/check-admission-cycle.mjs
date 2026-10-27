#!/usr/bin/env node
// 內容學年度漂移檢查（#116），比對 src/content 底下每個 .md 的學年度和 scripts/admission-cycle.json，
// 判斷在 admission-cycle.lib.mjs。不連網。
//
//   node scripts/check-admission-cycle.mjs [--remind]
//     設定或內容有錯就以 1 結束。過了 remindAfter、keep 過了 recheckAfter 只印警告，結束碼不看日期，
//     CI 才不會哪天突然變紅。
//     寫著 cycle 這一屆的時程日期和別人文章的標題只列出來，不算錯誤。
//     --remind 給每週排程用：另外寫出 admission-cycle-report.md，有錯誤或該提醒的事時在 GITHUB_OUTPUT
//     寫 needs_attention=true，admission-cycle-check.yml 拿報告開 issue。
//
// 測試用 ADMISSION_CYCLE_TODAY（YYYY-MM-DD）指定今天，沒給就用台灣的日期。
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    checkContent,
    cycleHints,
    dueKeeps,
    isPast,
    isRealDate,
    pendingForNext,
    remindWindow,
    taipeiToday,
    validateConfig,
} from './admission-cycle.lib.mjs';
import { ADMISSION_CYCLE_MARKER } from './watchdog-issue.lib.mjs';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const CONFIG = path.join(ROOT, 'scripts/admission-cycle.json');
const CONTENT = path.join(ROOT, 'src/content');
const REPORT = path.join(ROOT, 'admission-cycle-report.md');
const remind = process.argv.includes('--remind');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** writeReport 寫出報告，第一行是機器標記，下一輪才認得出自己開的 issue。 */
function writeReport(sections, attention) {
    const body = [ADMISSION_CYCLE_MARKER, '', '## 內容的學年度', '', ...sections.flat()];
    if (!attention) body.push('沒有需要處理的事。', '');
    writeFileSync(REPORT, body.join('\n'));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needs_attention=${attention}\n`);
    console.log(`\n報告寫在 ${rel(REPORT)}。`);
}

/** fail 印出錯誤後以 1 結束。--remind 時錯誤也寫進報告，issue 才看得到。 */
function fail(errors, hint, sections = []) {
    console.error(`\n錯誤 ${errors.length} 項：`);
    for (const e of errors) console.error(`  ${e}`);
    if (hint) console.error(`\n${hint}`);
    if (remind) {
        const list = errors.map((e) => `- ${e.replace(/\n\s*/g, '\n  ')}`);
        writeReport([...sections, ['### 檢查的錯誤', '', ...list, '']], true);
    }
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

// 一個檔案一行：「時程 19、20 行；標題 179 行」。
const hints = new Map();
for (const f of files) {
    const found = cycleHints(f.text, cycle);
    if (!found.length) continue;
    const by = (kind) => [...new Set(found.filter((h) => h.kind === kind).map((h) => h.line))].join('、');
    const parts = [['date', '時程'], ['title', '標題']].filter(([k]) => by(k)).map(([k, name]) => `${name} ${by(k)} 行`);
    hints.set(f.path, { count: found.length, text: parts.join('；') });
}
const hintTotal = [...hints.values()].reduce((n, h) => n + h.count, 0);
const hintHead = `寫著 ${cycle} 這一屆的時程日期和別人文章的標題有 ${hintTotal} 處，換屆時要對照簡章看，不算錯誤：`;
if (hints.size) {
    console.log(`\n${hintHead}`);
    for (const [file, h] of hints) console.log(`  ${file}：${h.text}`);
}

const sections = [];
if (isPast(remindAfter, today)) {
    warn('學年度還沒換屆', `今天 ${today} 已經過了 remindAfter（${remindAfter}），cycle 還是 ${cycle}。內容改成 ${next} 學年度之後，把 cycle 改成 ${next}。`);
    const pending = pendingForNext(files, config);
    const lines = new Map();
    for (const h of pending) lines.set(h.path, new Set([...(lines.get(h.path) ?? []), h.line]));
    const w = remindWindow(next + 1);
    sections.push([
        '### 該換屆了',
        '',
        `今天（台灣時間）${today}，已經過了 remindAfter（${remindAfter}），cycle 還是 ${cycle}。remindAfter 的依據：${config.remindReason}`,
        '',
        `1. 一頁一頁把內容改成 ${next} 學年度。${next} 是 next，改好的頁面現在就能合併。`,
        `2. 都改完之後，在 \`${rel(CONFIG)}\` 把 cycle 改成 ${next}、next 改成 ${next + 1}，remindAfter 改到 ${w.from} 到 ${w.to} 之間，remindReason 寫新日期的依據。`,
        `3. keep 逐筆確認，還需要的把 cycle 改成 ${next}，不需要的刪掉。`,
        '',
        `cycle 改成 ${next} 之後不放行的有 ${pending.length} 處，在 ${lines.size} 個檔案，其中 ${pending.filter((h) => h.by.length).length} 處現在由 keep 放行：`,
        '',
        ...[...lines].map(([file, set]) => `- \`${file}\`：第 ${[...set].join('、')} 行`),
        '',
        ...(hints.size ? [hintHead, '', ...[...hints].map(([file, h]) => `- \`${file}\`：${h.text}`), ''] : []),
    ]);
}
const due = dueKeeps(config, today);
for (const { index, keep } of due) {
    warn('keep 該重新確認', `keep[${index}]（${keep.url ?? keep.file}）的 recheckAfter 是 ${keep.recheckAfter}，已經過了，請重新確認還需不需要。`);
}
if (due.length) {
    sections.push([
        '### 該重新確認的 keep',
        '',
        ...due.map(({ index, keep }) => `- keep[${index}]（${keep.url ?? `${keep.file}：${keep.text}`}）的 recheckAfter 是 ${keep.recheckAfter}。理由：${keep.reason}`),
        '',
    ]);
}

if (errors.length) {
    fail(
        errors,
        `內容以 ${cycle} 學年度申請入學為準：學年度要寫 ${cycle} 或 ${next}，區間要包含其中一個。確定要保留的舊年度，` +
            `在 ${rel(CONFIG)} 的 keep 加一筆，文字寫 file、text、cycle、reason，網址寫 url、cycle、reason。` +
            '「2026 升學趨勢」這類西元年寫法沒有 keep，拿掉年份或寫成學年度。',
        sections,
    );
}
if (remind) writeReport(sections, sections.length > 0);
console.log('\n沒有問題。');
