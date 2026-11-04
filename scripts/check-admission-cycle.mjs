#!/usr/bin/env node
// 內容學年度漂移檢查（#116），比對 src/content 底下每個 .md 的學年度和 scripts/admission-cycle.json，
// 判斷在 admission-cycle.lib.mjs。不連網。
//
//   node scripts/check-admission-cycle.mjs [--remind]
//     設定或內容有錯就以 1 結束。過了 remindAfter、keep 或 watch 過了 recheckAfter 只印警告，結束碼不看日期，
//     CI 才不會哪天突然變紅。
//     寫著 cycle 這一屆的時程日期和別人文章的標題只列出來，不算錯誤。
//     --remind 給每週排程用：另外寫出 admission-cycle-report.md，有錯誤或該提醒的事時在 GITHUB_OUTPUT
//     寫 needs_attention=true，admission-cycle-check.yml 拿報告開 issue。
//
// 測試用 ADMISSION_CYCLE_TODAY（YYYY-MM-DD）指定今天，沒給就用台灣的日期；ADMISSION_CYCLE_REPORT_LIMIT
// 指定報告的字數上限，沒給是 60000。
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    checkContent,
    cycleHints,
    dueKeeps,
    dueWatches,
    entryLine,
    fitReport,
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
// GitHub issue 內文上限 65,536 字，超過時開不了 issue，留一點餘裕。
const REPORT_LIMIT = Number(process.env.ADMISSION_CYCLE_REPORT_LIMIT) || 60000;
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

/** writeReport 寫出報告，第一行是機器標記，下一輪才認得出自己開的 issue。太長時截斷，完整的印在 log。 */
function writeReport(sections, attention) {
    const body = [ADMISSION_CYCLE_MARKER, '', '## 內容的學年度', '', ...sections.flat()];
    if (!attention) body.push('沒有需要處理的事。', '');
    const full = body.join('\n');
    const text = fitReport(full, REPORT_LIMIT, `\n報告超過 ${REPORT_LIMIT} 字，後面截掉了，其餘見 Actions log。\n`);
    if (text !== full) console.log(`\n報告超過 ${REPORT_LIMIT} 字，寫進 issue 的版本截掉了後面。完整的報告：\n\n${full}`);
    writeFileSync(REPORT, text);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needs_attention=${attention}\n`);
    console.log(`\n報告寫在 ${rel(REPORT)}。`);
}

/** fail 印出錯誤後以 1 結束。--remind 時錯誤也寫進報告，issue 才看得到；放在最前面，報告截斷時錯誤最後才截到。 */
function fail(errors, hint, sections = []) {
    console.error(`\n錯誤 ${errors.length} 項：`);
    for (const e of errors) console.error(`  ${e}`);
    if (hint) console.error(`\n${hint}`);
    if (remind) {
        const list = errors.map((e) => `- ${e.replace(/\n\s*/g, '\n  ')}`);
        writeReport([['### 檢查的錯誤', '', ...list, ''], ...sections], true);
    }
    process.exit(1);
}

/**
 * warn 印出警告和 details 的每一行。在 Actions 上另發一則 annotation，只有 message，run 的摘要頁看得到；
 * 跳脫照 @actions/core 的 escapeData。
 */
function warn(title, message, details = []) {
    console.log(`\n警告：${message}`);
    for (const d of details) console.log(`  ${d}`);
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

const { errors, watchErrors, found, kept } = checkContent(files, config);
console.log(`學年度檢查：cycle ${cycle}、next ${next}，今天 ${today}（台灣時間），remindAfter ${remindAfter}`);
console.log(`  ${rel(CONTENT)} 底下 ${files.length} 個 .md 檔，找到 ${found} 處學年度和甄選會網址，keep ${config.keep.length} 筆放行 ${kept} 處，watch ${config.watch.length} 筆`);

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
        `3. keep 和 watch 逐筆確認，還需要的把 cycle 改成 ${next}，不需要的刪掉。`,
        '',
        `cycle 改成 ${next} 之後不放行的有 ${pending.length} 處，在 ${lines.size} 個檔案，其中 ${pending.filter((h) => h.by.length).length} 處現在由 keep 放行：`,
        '',
        ...[...lines].map(([file, set]) => `- \`${file}\`：第 ${[...set].join('、')} 行`),
        '',
        ...(hints.size ? [hintHead, '', ...[...hints].map(([file, h]) => `- \`${file}\`：${h.text}`), ''] : []),
    ]);
}
const dueLists = [
    ['keep', dueKeeps(config, today), '請重新確認還需不需要'],
    ['watch', dueWatches(config, today), '新資料公告了就改這一行並更新或刪掉這筆；還沒公告就把 recheckAfter 往後延'],
];
// 網址 keep 寫網址，其他寫檔名和行號。
const where = (entry) => entry.url ?? `${entry.file}:${entryLine(files, entry) ?? '?'}`;
for (const [name, due, todo] of dueLists) {
    if (!due.length) continue;
    // annotation 一個 step 最多顯示 10 則，每一類只發一則，逐筆的列在 log。
    warn(
        `${name} 該重新確認`,
        `${name} 有 ${due.length} 筆過了 recheckAfter，${todo}。`,
        due.map(({ index, entry }) => `${name}[${index}]（${where(entry)}）recheckAfter ${entry.recheckAfter}`),
    );
    // 同一個理由常有幾十筆，報告裡一個理由只印一次，issue 內文才不會超過上限。
    const groups = new Map();
    for (const { index, entry } of due) {
        const key = `${entry.recheckAfter}：${entry.reason}`;
        groups.set(key, [...(groups.get(key) ?? []), `  - ${name}[${index}] \`${where(entry)}\``]);
    }
    // key 的前 10 個字是日期。只比日期，sort 是穩定排序，同一天的照設定檔的順序。
    const date = ([key]) => key.slice(0, 10);
    const sorted = [...groups].sort((a, b) => (date(a) < date(b) ? -1 : date(a) > date(b) ? 1 : 0));
    sections.push([`### 該重新確認的 ${name}`, '', `${due.length} 筆的 recheckAfter 已經過了，${todo}。`, '', ...sorted.flatMap(([key, items]) => [`- recheckAfter ${key}`, ...items]), '']);
}

if (errors.length) {
    const hints = [];
    if (errors.length > watchErrors.length) {
        hints.push(
            `內容以 ${cycle} 學年度申請入學為準：學年度要寫 ${cycle} 或 ${next}，區間要包含其中一個。確定要保留的舊年度，` +
                `在 ${rel(CONFIG)} 的 keep 加一筆，文字寫 file、text、cycle、reason，網址寫 url、cycle、reason。` +
                '「2026 升學趨勢」這類西元年寫法沒有 keep，拿掉年份或寫成學年度。',
        );
    }
    if (watchErrors.length) hints.push('watch 指的行改過了：內容不會再過時就刪掉這一筆，還要追蹤就把 text 換成新的原文。');
    fail(errors, hints.join('\n'), sections);
}
if (remind) writeReport(sections, sections.length > 0);
console.log('\n沒有問題。');
