#!/usr/bin/env node
// check-admission-cycle.mjs 的故障注入，一次改一處，確認該紅的會紅、該放行的放行：
//   A. 內容、keep、設定：寫進舊年度、西元年當申請年度、殭屍 keep、cycle 過期的 keep、next 和 remindAfter
//      不合規則、內容目錄清空都要以 1 結束；cycle、next、「115 年度」和包含 cycle 的區間要放行；
//      時程日期和別人文章的標題只列出來；
//      過了 remindAfter 或 recheckAfter 只印警告，結束碼仍是 0；--remind 要寫出報告和 needs_attention
//   B. 判斷：改壞 admission-cycle.lib.mjs 或 markdown-refs.lib.mjs，admission-cycle.test.mjs 必須失敗
//   C. 串接：改壞 check-admission-cycle.mjs，A 段至少要有一項失敗
//   D. 排程：改壞 admission-cycle-check.yml，admission-cycle.test.mjs 必須失敗
// 用固定的測資和日期，不用真實內容：真實內容哪天沒有 keep 或甄選會網址，這裡照樣測得到。
// scripts/ 和 .github/ 複製到 .admission-cycle-faultcheck/ 再放測資，版控裡的檔案不會被改到。
//
// 執行：  npm run test:admission-cycle-faults
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const WORK = path.join(ROOT, '.admission-cycle-faultcheck');
const SCRIPTS = path.join(WORK, 'scripts');
const CONFIG = path.join(SCRIPTS, 'admission-cycle.json');
const CONTENT = path.join(WORK, 'src/content');
const REPORT = path.join(WORK, 'admission-cycle-report.md');
const OUTPUT = path.join(WORK, 'github-output');
const PAGE_A = 'src/content/clusters/a/overview.md';
const PAGE_B = 'src/content/clusters/b/application.md';
const KEEP_TEXT = '多來自 111 學年度的舊統計';
const KEEP_URL = 'https://www.cac.edu.tw/apply114/guide.php';

const pages = {
    [PAGE_A]: [
        '---',
        'title: 測試頁 — 115 學年度',
        'description: 115 學年度申請入學的測試資料。',
        '---',
        '',
        '本頁以 **115 學年度**申請入學為準，簡章見[甄選會](https://www.cac.edu.tw/apply115/index.php)。',
        '',
        '核心能力自 113 至 115 學年度沒有改變，請以 115／116 學年度的簡章為準。',
        '',
        `坊間的數字${KEEP_TEXT}，本頁不引用。`,
        '',
        `簡章公告後還沒更新的頁面：[校系分則](${KEEP_URL})`,
        '',
    ].join('\n'),
    [PAGE_B]: ['---', 'title: 申請時程', '---', '', '116 學年度的簡章在 2026 年 11 月公告。', ''].join('\n'),
};
const reason = '故障注入的測資，保留理由至少十個字。';
const baselineConfig = () => ({
    cycle: 115,
    next: 116,
    remindAfter: '2026-12-15',
    remindReason: '故障注入的測資，日期落在 116 學年度的範圍裡。',
    keep: [
        { file: PAGE_A, text: KEEP_TEXT, cycle: 115, reason },
        { url: KEEP_URL, cycle: 115, reason },
    ],
});

rmSync(WORK, { recursive: true, force: true });
cpSync(path.join(ROOT, 'scripts'), SCRIPTS, { recursive: true });
// 單元測試會讀 workflow。
cpSync(path.join(ROOT, '.github'), path.join(WORK, '.github'), { recursive: true });

/** reset 把測資和設定寫回基準狀態。 */
function reset() {
    rmSync(CONTENT, { recursive: true, force: true });
    for (const [file, text] of Object.entries(pages)) {
        mkdirSync(path.dirname(path.join(WORK, file)), { recursive: true });
        writeFileSync(path.join(WORK, file), text);
    }
    writeFileSync(CONFIG, JSON.stringify(baselineConfig(), null, 2));
}

/** snapshot 把設定和內容目錄串成一個字串，用來確認注入真的改到了東西。 */
function snapshot() {
    if (!existsSync(CONTENT)) return `${readFileSync(CONFIG, 'utf8')}\n（沒有內容目錄）`;
    const entries = readdirSync(CONTENT, { recursive: true, withFileTypes: true }).map((e) => {
        const p = path.join(e.parentPath, e.name);
        return e.isFile() ? `${p}\n${readFileSync(p, 'utf8')}` : p;
    });
    return [readFileSync(CONFIG, 'utf8'), ...entries.sort()].join('\n');
}

/**
 * check 跑沙盒裡的檢查，回傳結束碼、stdout 和 stderr 合併的輸出、報告，以及寫進 GITHUB_OUTPUT 的
 * needs_attention（沒寫是 null）。
 */
function check(env = {}, args = []) {
    rmSync(REPORT, { force: true });
    rmSync(OUTPUT, { force: true });
    // GITHUB_OUTPUT 指到沙盒，CI 上不會把故障注入的結果寫進真正的 step output。不測 annotation 的
    // 案例不設 GITHUB_ACTIONS，子行程才不會多發 ::warning。
    const base = { ...process.env, ADMISSION_CYCLE_TODAY: '2026-10-25', GITHUB_OUTPUT: OUTPUT };
    delete base.GITHUB_ACTIONS;
    const cli = path.join(SCRIPTS, 'check-admission-cycle.mjs');
    let code = 0;
    let out;
    try {
        out = String(execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe', env: { ...base, ...env } }));
    } catch (e) {
        code = e.status ?? 1;
        out = String(e.stdout || '') + String(e.stderr || '');
    }
    const report = existsSync(REPORT) ? readFileSync(REPORT, 'utf8') : null;
    const flag = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8').match(/^needs_attention=(true|false)$/m) : null;
    return { code, out, report, attention: flag ? flag[1] === 'true' : null };
}

const append = (file, line) => () => writeFileSync(path.join(WORK, file), `${readFileSync(path.join(WORK, file), 'utf8')}\n${line}\n`);
const replace = (file, from, to) => () => {
    const p = path.join(WORK, file);
    writeFileSync(p, readFileSync(p, 'utf8').replace(from, to));
};
const editConfig = (fn) => () => {
    const c = JSON.parse(readFileSync(CONFIG, 'utf8'));
    fn(c);
    writeFileSync(CONFIG, JSON.stringify(c, null, 2));
};

const cases = [
    { name: '內文多了「114 學年度」', inject: append(PAGE_B, '另見 114 學年度的統計。'), code: 1, expect: /application\.md:7 「114 學年度」裡的 114 不是 115 或 116/ },
    { name: '粗體的「**114** 學年度」', inject: append(PAGE_B, '**114** 學年度的規定'), code: 1, expect: /「114 學年度」裡的 114/ },
    { name: 'HTML 標籤包住的 114', inject: append(PAGE_B, '<strong>114</strong> 學年度的規定'), code: 1, expect: /「114 學年度」裡的 114/ },
    {
        name: 'CRLF 的內容照樣檢查，錯誤訊息裡沒有 \\r',
        inject: () => writeFileSync(path.join(WORK, PAGE_B), `${pages[PAGE_B]}另見 114 學年度的統計。\n`.replace(/\n/g, '\r\n')),
        code: 1,
        expect: /application\.md:6 「114 學年度」裡的 114/,
        absent: /\r/,
    },
    { name: '列舉「114、115 學年度」', inject: append(PAGE_B, '114、115 學年度都一樣'), code: 1, expect: /「114、115 學年度」裡的 114/ },
    { name: '區間不包含 cycle 或 next：「112 至 114 學年度」', inject: append(PAGE_B, '112 至 114 學年度'), code: 1, expect: /「112 至 114 學年度」不包含 115 或 116/ },
    { name: '出現 apply114 網址', inject: append(PAGE_B, '[時程](https://www.cac.edu.tw/apply114/schedule.php)'), code: 1, expect: /網址 https:\/\/www\.cac\.edu\.tw\/apply114\/schedule\.php 的 114/ },
    { name: '出現沒有 scheme 的 star113 網址', inject: append(PAGE_B, '見 www.cac.edu.tw/star113/。'), code: 1, expect: /網址 www\.cac\.edu\.tw\/star113\/ 的 113/ },
    { name: 'keep 放行的那一行另外寫了 114 學年度', inject: replace(PAGE_A, '，本頁不引用。', '，114 學年度也一樣。'), code: 1, expect: /overview\.md:10 「114 學年度」裡的 114/ },
    { name: '殭屍 keep：keep 指的那句刪掉了', inject: replace(PAGE_A, `坊間的數字${KEEP_TEXT}，本頁不引用。`, ''), code: 1, expect: /keep\[0\] 的 text 在 \S+ 裡找不到/ },
    { name: '殭屍 keep：keep 指的網址刪掉了', inject: replace(PAGE_A, `[校系分則](${KEEP_URL})`, ''), code: 1, expect: /keep\[1\] 的網址 \S+ 已經不在內容裡/ },
    { name: 'keep 的 cycle 過期', inject: editConfig((c) => { c.keep[0].cycle = 114; }), code: 1, expect: /keep\[0\] 的 cycle 是 114，和設定檔的 cycle 115 不同/ },
    { name: 'keep 的 text 在檔案裡不只一處', inject: append(PAGE_A, `另一處也${KEEP_TEXT}。`), code: 1, expect: /keep\[0\] 的 text 在 \S+ 裡不只一處/ },
    { name: 'keep 的 text 沒有完整的學年度字樣', inject: editConfig((c) => { c.keep[0].text = '多來自 111 學年'; }), code: 1, expect: /keep\[0\] 的 text 沒有完整包含任何一處學年度/ },
    { name: 'keep 的年度本來就放行', inject: editConfig((c) => { c.keep.push({ file: PAGE_A, text: '115／116 學年度', cycle: 115, reason }); }), code: 1, expect: /keep\[2\] 的 text 裡的學年度本來就放行/ },
    { name: '重複的 keep', inject: editConfig((c) => { c.keep.push({ ...c.keep[0] }); }), code: 1, expect: /keep\[2\] 和前面的 keep 重複/ },
    { name: 'keep 的 reason 太短', inject: editConfig((c) => { c.keep[1].reason = '還沒上線'; }), code: 1, expect: /keep\[1\] 的 reason/ },
    { name: 'next 不是 cycle + 1', inject: editConfig((c) => { c.next = 117; }), code: 1, expect: /next 必須是 cycle \+ 1，也就是 116/ },
    { name: 'remindAfter 晚了一天（2027-04-01）', inject: editConfig((c) => { c.remindAfter = '2027-04-01'; }), code: 1, expect: /remindAfter（2027-04-01）必須在 2026-08-01 到 2027-03-31 之間/ },
    { name: 'remindAfter 早了一天（2026-07-31）', inject: editConfig((c) => { c.remindAfter = '2026-07-31'; }), code: 1, expect: /必須在 2026-08-01 到 2027-03-31 之間/ },
    { name: 'remindAfter 不是存在的日期', inject: editConfig((c) => { c.remindAfter = '2026-12-32'; }), code: 1, expect: /remindAfter 必須是存在的 YYYY-MM-DD 日期/ },
    { name: '設定檔不是合法的 JSON', inject: () => writeFileSync(CONFIG, '{ "cycle": 115,'), code: 1, expect: /讀不到或無法解析 scripts\/admission-cycle\.json/ },
    {
        name: '內容目錄清空',
        inject: () => { rmSync(CONTENT, { recursive: true, force: true }); mkdirSync(CONTENT); },
        code: 1,
        expect: /src\/content 底下沒有任何 \.md 檔/,
    },
    { name: '內容目錄不見了', inject: () => rmSync(CONTENT, { recursive: true, force: true }), code: 1, expect: /讀不到內容目錄 src\/content/ },
    {
        name: '內容裡一個學年度都沒有',
        inject: () => {
            editConfig((c) => { c.keep = []; })();
            for (const file of Object.keys(pages)) writeFileSync(path.join(WORK, file), '---\ntitle: 空白頁\n---\n\n沒有年度的內容。\n');
        },
        code: 1,
        expect: /2 個檔案裡找不到任何學年度或甄選會網址/,
    },
    { name: '西元年當申請年度：「2026 升學趨勢」', inject: append(PAGE_B, '## 2026 升學趨勢'), code: 1, expect: /application\.md:7 「2026 升學」用西元年當申請年度/ },
    { name: '西元年當申請年度：粗體的「**2026 年**的選才」', inject: append(PAGE_B, '**2026 年**的選才標準'), code: 1, expect: /application\.md:7 「2026 年 的選才」用西元年當申請年度/ },
    { name: '「2026 產業趨勢」不是申請年度，放行', inject: append(PAGE_B, '## 2026 產業趨勢'), code: 0, expect: /沒有問題/ },
    {
        name: '別人文章的標題寫「2026 大學申請」：放行，列成提醒',
        inject: append(PAGE_B, '- [Cheers「2026 大學申請全攻略」](https://example.com/)'),
        code: 0,
        expect: /有 1 處，換屆時要對照簡章看，不算錯誤：\n {2}src\/content\/clusters\/b\/application\.md：標題 7 行\n/,
    },
    {
        name: '時程日期：放行，列成提醒',
        inject: append(PAGE_B, '| 一階篩選放榜 | 2026 年 3 月 31 日 |'),
        code: 0,
        expect: /寫著 115 這一屆的時程日期和別人文章的標題有 1 處[^]*application\.md：時程 7 行/,
    },
    { name: '沒有時程日期和標題：不印提醒', code: 0, absent: /換屆時要對照簡章看/ },
    { name: '「115 年度」不算學年度，放行', inject: append(PAGE_B, '114 年度預算和 115 年度預算'), code: 0, expect: /沒有問題/ },
    { name: '「113 至 115 學年度」的結尾是 cycle，放行', inject: append(PAGE_B, '113 至 115 學年度的統計'), code: 0, expect: /沒有問題/ },
    { name: '「113 學年度至 115 學年度」也是區間，放行', inject: append(PAGE_B, '113 學年度至 115 學年度'), code: 0, expect: /沒有問題/ },
    { name: '「115 至 119 學年度」包含 cycle，放行', inject: append(PAGE_B, '115 至 119 學年度入學適用第三期'), code: 0, expect: /沒有問題/ },
    { name: '區間在「至」後面換行，照樣是區間，放行', inject: append(PAGE_B, '112 學年度至\n115 學年度'), code: 0, expect: /沒有問題/ },
    { name: 'HTML 註解裡的年度不算，放行', inject: append(PAGE_B, '<!-- 114 學年度的舊資料 -->'), code: 0, expect: /沒有問題/ },
    { name: '名稱是 .md 的目錄不讀，放行', inject: () => mkdirSync(path.join(CONTENT, 'clusters/c/notes.md'), { recursive: true }), code: 0, expect: /沒有問題/ },
    { name: '「116 學年度」是 next，放行', inject: append(PAGE_A, '116 學年度的簡章'), code: 0, expect: /沒有問題/ },
    { name: 'apply116 網址是 next，放行', inject: append(PAGE_A, '[簡章](https://www.cac.edu.tw/apply116/regulation.php)'), code: 0, expect: /沒有問題/ },
    { name: 'Markdown 連結的網址部分不算內文，放行', inject: append(PAGE_B, '[簡章](https://example.com/114學年度.pdf)'), code: 0, expect: /沒有問題/ },
    { name: '過了 remindAfter：只印警告', env: { ADMISSION_CYCLE_TODAY: '2026-12-16' }, code: 0, expect: /警告：今天 2026-12-16 已經過了 remindAfter（2026-12-15），cycle 還是 115/ },
    { name: '過了 remindAfter：Actions 上發 warning annotation', env: { ADMISSION_CYCLE_TODAY: '2026-12-16', GITHUB_ACTIONS: 'true' }, code: 0, expect: /^::warning title=學年度還沒換屆::/m },
    { name: 'remindAfter 當天：不警告', env: { ADMISSION_CYCLE_TODAY: '2026-12-15' }, code: 0, absent: /警告/ },
    { name: 'ADMISSION_CYCLE_TODAY 不是日期', env: { ADMISSION_CYCLE_TODAY: '2026-13-01' }, code: 1, expect: /ADMISSION_CYCLE_TODAY 必須是 YYYY-MM-DD 日期/ },
    {
        name: '過了 keep 的 recheckAfter：只印警告',
        inject: editConfig((c) => { c.keep[1].recheckAfter = '2026-10-24'; }),
        code: 0,
        expect: /警告：keep\[1\]（https:\/\/www\.cac\.edu\.tw\/apply114\/guide\.php）的 recheckAfter 是 2026-10-24，已經過了/,
    },
    {
        name: 'keep 的 recheckAfter 在今天之後、remindAfter 之前：不警告',
        inject: editConfig((c) => { c.keep[1].recheckAfter = '2026-11-01'; }),
        code: 0,
        absent: /警告/,
    },
    { name: '不加 --remind：不寫報告，也不寫 needs_attention', env: { ADMISSION_CYCLE_TODAY: '2026-12-16' }, code: 0, attention: null, report: null },
    {
        name: '--remind 過了 remindAfter：通知，報告有機器標記和換屆後要改的地方',
        args: ['--remind'],
        env: { ADMISSION_CYCLE_TODAY: '2026-12-16' },
        code: 0,
        attention: true,
        report: /^<!-- admission-cycle-watchdog:v1 -->\n[^]*### 該換屆了\n\n.*remindAfter 的依據：故障注入的測資，日期落在 116 學年度的範圍裡。\n[^]*cycle 改成 116 之後不放行的有 8 處，在 1 個檔案，其中 2 處現在由 keep 放行：\n\n- `src\/content\/clusters\/a\/overview\.md`：第 2、3、6、8、10、12 行\n/,
    },
    {
        name: '--remind 過了 remindAfter：時程日期和標題也列在報告裡',
        args: ['--remind'],
        env: { ADMISSION_CYCLE_TODAY: '2026-12-16' },
        inject: append(PAGE_B, '| 一階篩選放榜 | 2026 年 3 月 31 日 |'),
        code: 0,
        attention: true,
        report: /### 該換屆了[^]*寫著 115 這一屆的時程日期和別人文章的標題有 1 處，換屆時要對照簡章看，不算錯誤：\n\n- `src\/content\/clusters\/b\/application\.md`：時程 7 行\n/,
    },
    { name: '--remind remindAfter 當天：不通知', args: ['--remind'], env: { ADMISSION_CYCLE_TODAY: '2026-12-15' }, code: 0, attention: false, report: /沒有需要處理的事/ },
    {
        name: '--remind 過了 keep 的 recheckAfter：通知',
        args: ['--remind'],
        inject: editConfig((c) => { c.keep[1].recheckAfter = '2026-10-24'; }),
        code: 0,
        attention: true,
        report: /### 該重新確認的 keep\n\n- keep\[1\]（https:\/\/www\.cac\.edu\.tw\/apply114\/guide\.php）的 recheckAfter 是 2026-10-24。/,
    },
    {
        name: '--remind 內容有錯：以 1 結束，照樣通知，錯誤寫進報告',
        args: ['--remind'],
        inject: append(PAGE_B, '另見 114 學年度的統計。'),
        code: 1,
        attention: true,
        report: /### 檢查的錯誤\n\n- src\/content\/clusters\/b\/application\.md:7 「114 學年度」裡的 114 不是 115 或 116\n  另見/,
    },
    {
        name: '--remind 設定檔壞掉：以 1 結束，照樣通知',
        args: ['--remind'],
        inject: () => writeFileSync(CONFIG, '{'),
        code: 1,
        attention: true,
        report: /^<!-- admission-cycle-watchdog:v1 -->\n[^]*- 讀不到或無法解析 scripts\/admission-cycle\.json/,
    },
];

/** problem 跑一個 A 段的案例，結果符合預期時回傳 null，否則回傳哪裡不對。 */
function problem(c) {
    reset();
    if (c.inject) {
        const before = snapshot();
        c.inject();
        if (snapshot() === before) return '注入沒有改到任何東西，請更新這一條';
    }
    const r = check(c.env, c.args);
    // 印出來之前壓成一行，輸出裡的 ::warning 才不會被 runner 當成這個 job 的 annotation。
    const out = r.out.replace(/\s+/g, ' ').slice(0, 240);
    if (r.code !== c.code) return `結束碼是 ${r.code}，應該是 ${c.code}。輸出：${out}`;
    if (c.expect && !c.expect.test(r.out)) return `輸出裡沒有 ${c.expect}。輸出：${out}`;
    if (c.absent?.test(r.out)) return `輸出裡不該有 ${c.absent}`;
    if ('attention' in c && r.attention !== c.attention) return `needs_attention 是 ${r.attention}，應該是 ${c.attention}`;
    if (c.report === null && r.report !== null) return '不該寫出報告';
    if (c.report && !c.report.test(r.report ?? '')) return `報告裡沒有 ${c.report}。報告：${(r.report ?? '（沒有報告）').replace(/\s+/g, ' ').slice(0, 240)}`;
    return null;
}

/** passes 在沙盒裡跑單元測試，回傳是否通過。 */
function passes() {
    try {
        execFileSync(process.execPath, ['--test', path.join(SCRIPTS, 'admission-cycle.test.mjs')], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

const libMutations = [
    ['區間的開頭也檢查', 'rangeStart = RANGE_SEP.test(', 'rangeStart = false && RANGE_SEP.test('],
    ['「學年度至」後面的區間開頭也檢查', 'rangeStart = RANGE_TO_NEXT.test(text);', 'rangeStart = false;'],
    ['區間只看結尾', '[...years].some((y) => t.from <= y && y <= t.year)', 'years.has(t.year)'],
    ['列舉少了和、與、或', "const LIST = '[、／/及和與或]';", "const LIST = '[、／/及]';"],
    ['區間只認至和 en dash', "const RANGE = '[至到~～〜\\\\-–—－]';", "const RANGE = '[至–]';"],
    ['分隔符號後面不能換行', 'const BREAK = `${SP}(?:\\\\r?\\\\n${SP})?`;', 'const BREAK = SP;'],
    ['HTML 註解當成內文', '.replace(/<!--[^]*?--!?>/g, blank)', ''],
    ['遮蔽的註解不認 --!> 結尾', '.replace(/<!--[^]*?--!?>/g, blank)', '.replace(/<!--[^]*?-->/g, blank)'],
    ['HTML 標籤擋住年度', '.replace(/<\\/?[A-Za-z][^<>\\n]*>/g, blank)', ''],
    ['參考式連結的定義當成內文', '.replace(/^ {0,3}\\[[^\\]\\n]+\\]:.*/gm, blank)', ''],
    ['裸網址當成內文', '.replace(/https?:\\/\\/[^\\s<>()[\\]"\'`\\u0080-\\uffff]*/g, blank)', ''],
    ['甄選會網址的結尾吃進中文標點', "[^\\s()<>[\\]\"'`*|\\u0080-\\uffff]*/gi", "[^\\s()<>[\\]\"'`*|]*/gi"],
    ['甄選會網址只認 www', '(?:[a-z0-9-]+\\.)*cac', '(?:www\\.)?cac'],
    ['reason 九個字也接受', 'const MIN_REASON_CHARS = 10;', 'const MIN_REASON_CHARS = 9;'],
    ['reason 不去掉前後空白', '[...v.trim()].length', '[...v].length'],
    ['網址 keep 不看是不是網址', " || found[0].kind !== 'url'", ''],
    ['本來就放行的判斷用 some', 'inside.every((t) => allows(allowed, t))', 'inside.some((t) => allows(allowed, t))'],
    ['摘錄前後只留 5 個字', 'const from = Math.max(lineStart, start - 30);', 'const from = Math.max(lineStart, start - 5);'],
    ['不去掉粗體', '.replace(/[*_]|~~/g, blank);', ';'],
    ['Markdown 連結的網址當成內文', '.replace(/\\]\\([^)\\n]*\\)/g,', '.replace(/$^/g,'],
    ['全形數字不轉半形', '.replace(/[０-９]/g,', '.replace(/$^/g,'],
    ['空白可以跨行', "const SP = '[^\\\\S\\\\r\\\\n]*';", "const SP = '\\\\s*';"],
    ['keep 放行整個檔案', 's.file === f.path && s.start <= t.start && t.end <= s.end', 's.file === f.path'],
    ['keep 的 text 不只一處也接受', 'if (f.text.indexOf(k.text, at + 1) >= 0)', 'if (false)'],
    ['網址 keep 用開頭比對', 'k.url === t.phrase', 't.phrase.startsWith(k.url)'],
    ['不檢查 keep 的 cycle', 'if (cycleOk && k.cycle !== cycle)', 'if (false)'],
    ['不檢查 next', 'else if (next !== cycle + 1)', 'else if (false)'],
    ['remindAfter 的上限少一天', 'remindAfter > w.to', 'remindAfter >= w.to'],
    ['remindAfter 當天就算過了', 'todayISO > dateISO', 'todayISO >= dateISO'],
    ['今天用 UTC 的日期', "timeZone: 'Asia/Taipei'", "timeZone: 'UTC'"],
    ['沒有檔案也算通過', 'if (files.length === 0) return', 'if (false) return'],
    ['一個學年度都沒找到也算通過', 'if (found === 0) errors.push', 'if (false) errors.push'],
    ['西元年寫法不報錯', 'for (const h of findFraming(f.text)) {', 'for (const h of []) {'],
    ['連結文字也算西元年寫法', 'const text = blankLinks(maskForText(src), src).replace(', 'const text = maskForText(src).replace('],
    ['《》〈〉裡也算西元年寫法', ".replace(/[《〈][^》〉\\n]*[》〉]/g, blank)", ''],
    ['西元年寫法的間隔可以有標點和符號', "[^\\\\s\\\\d\\\\p{P}\\\\p{S}]){0,6}?", "[^\\\\s\\\\d]){0,6}?"],
    ['西元年寫法的間隔可以有符號', "\\\\p{P}\\\\p{S}]", "\\\\p{P}]"],
    ['西元年寫法的間隔可以換行', "(?:[^\\\\S\\\\n]*[^\\\\s", "(?:\\\\s*[^\\\\s"],
    ['連結文字不必接網址或定義', "if (masked[m.index + m[0].length] === '(') return true;", 'return true;'],
    ['行內連結的文字也算', "if (masked[m.index + m[0].length] === '(') return true;", 'if (false) return true;'],
    ['參考式連結的文字也算', 'return refs.has(refLabel(src.slice(a, b)));', 'return false;'],
    ['參考式連結的標籤從替換過的文字取', 'refLabel(src.slice(a, b))', 'refLabel(masked.slice(a, b))'],
    ['[文字][] 的標籤用空字串', 'm[2] ? m.indices[2] : m.indices[1]', 'm[2] !== undefined ? m.indices[2] : m.indices[1]'],
    ['[X][Y](網址) 的 [X] 也當連結文字', '\\](?!\\())?/dg', '\\])?/dg'],
    ['\\[x] 也當連結', 'masked[m.index - 1] === \'\\\\\' || ', ''],
    ['程式碼裡的 [x] 也當連結', ' || code.some(([a, b]) => m.index < b && m.index + m[0].length > a)', ''],
    ['程式碼的反引號不必一樣長', '/(?<!`)(`+)(?!`)[^]*?(?<!`)\\1(?!`)/g', '/(`+)[^]*?`/g'],
    ['程式碼可以跨空行', ".filter((c) => !/\\n[ \\t]*\\n/.test(c[0]))", ''],
    ['程式碼不能跨行', '(?!`)[^]*?(?<!`)', '(?!`)[^\\n]*?(?<!`)'],
    ['只看 [x] 的開頭在不在程式碼裡', 'm.index < b && m.index + m[0].length > a', 'm.index > a && m.index < b'],
    ['參考式連結的文字裡可以有 [', " || m[1].includes('[')", ''],
    ['西元年寫法的間隔放寬到 9 個字', '{0,6}?[^', '{0,9}?[^'],
    ['西元年寫法的間隔收緊到 5 個字', '{0,6}?[^', '{0,5}?[^'],
    ['西元年寫法少了審查', "|備審|審查|選才|", "|備審|選才|"],
    ['時程日期放寬到 9 月', 'const SCHEDULE_LAST_MONTH = 8;', 'const SCHEDULE_LAST_MONTH = 9;'],
    ['時程日期收緊到 7 月', 'const SCHEDULE_LAST_MONTH = 8;', 'const SCHEDULE_LAST_MONTH = 7;'],
    ['時程日期不看同一行的字', ' && SCHEDULE_WORD.test(lines[line - 1])', ''],
    ['時程日期也看連結文字', 'const body = blankLinks(masked, src);', 'const body = masked;'],
    ['標題寫「115 學年度」也列', '(?:年|學年度|[至到', '(?:年|[至到'],
    ['標題只看民國年', ' || western.test(m[1])', ''],
    ['換屆清單用現在的 cycle 判斷', 'new Set([config.next, config.next + 1])', 'new Set([config.cycle, config.next])'],
];
// markdown-refs.lib.mjs 的突變，也用 admission-cycle.test.mjs 抓。
const refsMutations = [
    ['標籤分大小寫', 'replace(/\\s+/g, \' \').toLowerCase()', 'replace(/\\s+/g, \' \')'],
    ['標籤不合併空白', 's.trim().replace(/\\s+/g, \' \').toLowerCase()', 's.trim().toLowerCase()'],
    ['標籤不去頭尾空白', 's.trim().replace(/\\s+/g, \' \').toLowerCase()', 's.replace(/\\s+/g, \' \').toLowerCase()'],
    ['定義前面的縮排不認', 'const DEFINITION = /^ {0,3}\\[', 'const DEFINITION = /^\\['],
    ['註腳也當成一般的定義', '\\[(?!\\^)((?:', '\\[((?:'],
    ['標題後面可以有字', '))?[ \\t]*$/;', '))?.*$/;'],
    ['沒有網址也算定義', '[^\\s\\0-\\x1f\\x7f]*)(?:[ \\t]+', '[^\\s\\0-\\x1f\\x7f]*)?(?:[ \\t]+'],
    ['網址不認角括號', ']:[ \\t]*(<[^<>\\n]*>|', ']:[ \\t]*(\\uFFFF|'],
    ['網址可以有控制字元', '[^\\s<\\0-\\x1f\\x7f][^\\s\\0-\\x1f\\x7f]*', '[^\\s<]\\S*'],
    ['網址的括號不必成對', ' && balanced(m[2])', ''],
    ['段落中間也算定義', 'canStart && (m = line.match(DEFINITION))', '(m = line.match(DEFINITION))'],
    ['標題下面不能接定義', 'canStart = ATX.test(line);', 'canStart = false;'],
    ['setext 標題下面也能接定義', 'canStart = ATX.test(line);', 'canStart = ATX.test(line) || /^ {0,3}=+[ \\t]*$/.test(line);'],
    ['圍欄結束的下一行不能接定義', 'fence = null; canStart = true;', 'fence = null; canStart = false;'],
    ['HTML 區塊結束的下一行也能接定義', 'canStart = html === \'blank\';', 'canStart = true;'],
    ['frontmatter 裡的也算定義', 'let pos = src.match(/^---\\n[^]*?\\n---(?=\\n|$)/)?.[0].length ?? 0;', 'let pos = 0;'],
    ['程式碼裡的也算定義', '            fence = m[1];', '            fence = null;'],
    ['結束的圍欄可以比較短', 'm[1].length >= fence.length', 'true'],
    ['結束的圍欄可以換字元', 'm[1][0] === fence[0] && ', ''],
    ['pre、script 這類區塊到空行為止', '[/^ {0,3}<(?:pre|script|style|textarea)(?:[\\s>]|$)/i, /<\\/(?:pre|script|style|textarea)>/i],', '[/^ {0,3}<(?:pre|script|style|textarea)(?:[\\s>]|$)/i, null],'],
    ['<? 區塊不認', '[/^ {0,3}<\\?/, /\\?>/],', ''],
    ['CDATA 區塊不認', '[/^ {0,3}<!\\[CDATA\\[/, /\\]\\]>/],', ''],
    ['HTML 註解只到空行', '[/^ {0,3}<!--/, /--!?>/],', '[/^ {0,3}<!--/, null],'],
    ['HTML 註解區塊不認 --!> 結尾', '[/^ {0,3}<!--/, /--!?>/],', '[/^ {0,3}<!--/, /-->/],'],
    ['HTML 區塊裡的也算定義', '            html = m[1] && m[1].test(line.replace(m[0], \'\')) ? null : m[1] ?? \'blank\';', '            html = null;'],
];
// 每一條都是曾經讓單元測試照樣通過的改法。
const workflowMutations = [
    ['開 issue 的條件拿掉 always()', "if: always() && steps.check.outputs.needs_attention == 'true'", "if: steps.check.outputs.needs_attention == 'true'"],
    ['檢查那一步的 id 改名', '        id: check\n', '        id: chk\n'],
    ['列出 issue 的標籤打錯', '--label admission-cycle-watchdog --state open', '--label admission-cycle --state open'],
    ['新開 issue 的標籤打錯', '                --label admission-cycle-watchdog \\\n', '                --label admission-cycles \\\n'],
    ['排程改成每天', "cron: '40 2 * * 1'", "cron: '40 2 * * *'"],
    ['拿掉機器標記的檢查', 'if ! grep -qF -- "$MARKER" admission-cycle-report.md; then', 'if false; then'],
    ['多了 push 觸發', '  workflow_dispatch:\n', '  workflow_dispatch:\n  push:\n'],
    ['報告檔名打錯', '--body-file admission-cycle-report.md)', '--body-file admission-cycle-reports.md)'],
];
const cliMutations = [
    ['有錯誤也以 0 結束', 'if (errors.length) {', 'if (false) {'],
    ['只讀內容目錄的第一層', 'recursive: true, withFileTypes: true', 'recursive: false, withFileTypes: true'],
    ['過了 remindAfter 就失敗', "warn('學年度還沒換屆',", "fail(['學年度還沒換屆'],"],
    ['不看 keep', 'checkContent(files, config)', 'checkContent(files, { ...config, keep: [] })'],
    ['不檢查設定檔', 'if (configErrors.length) fail(', 'if (false) fail('],
    ['不檢查 ADMISSION_CYCLE_TODAY', 'if (!isRealDate(today)) fail(', 'if (false) fail('],
    ['recheckAfter 拿 remindAfter 比', 'dueKeeps(config, today)', 'dueKeeps(config, remindAfter)'],
    ['目錄也當成檔案讀', "e.isFile() && e.name.endsWith('.md')", "e.name.endsWith('.md')"],
    ['CRLF 不換成 LF', ".replace(/\\r\\n/g, '\\n')", ''],
    ['報告沒有機器標記', "[ADMISSION_CYCLE_MARKER, '',", "['',"],
    ['needs_attention 一律寫 false', 'needs_attention=${attention}', 'needs_attention=false'],
    ['有錯時不寫報告', 'if (remind) {', 'if (false) {'],
    ['不印提醒', 'if (hints.size) {', 'if (false) {'],
    ['換屆報告不列提醒', '...(hints.size ? [hintHead', '...(false ? [hintHead'],
    ['換屆清單不算 keep 放行的', 'pending.filter((h) => h.by.length).length', '0'],
];

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  符合  ${name}`); };
const bad = (name, why) => { fail++; console.log(`  不符  ${name}：${why}`); };

/**
 * mutate 把沙盒裡的 file（從沙盒根目錄起算）換成改壞的版本跑 survived，跑完換回原檔。survived 回傳 true
 * 表示改壞了沒被抓到。換行先統一成 LF：Windows 上的 checkout 是 CRLF，用 LF 寫的比對字串會對不上。
 */
function mutate(file, [name, from, to], survived, why) {
    const target = path.join(WORK, file);
    const original = readFileSync(target, 'utf8').split(/\r?\n/).join('\n');
    if (original.split(from).length !== 2) return bad(name, '原文找不到或不只一處，請更新這一條');
    writeFileSync(target, original.replace(from, to));
    try {
        if (survived()) bad(name, why);
        else ok(name);
    } finally {
        writeFileSync(target, original);
    }
}

const baseline = () => {
    reset();
    const r = check();
    return r.code === 0 && !/警告/.test(r.out) && passes();
};
if (!baseline()) {
    console.error('基準就不是綠燈（檢查沒過、有警告或單元測試失敗），後面的結果沒有意義。');
    console.error(check().out);
    rmSync(WORK, { recursive: true, force: true });
    process.exit(1);
}
console.log('基準是綠燈：測資通過檢查、沒有警告，單元測試通過。\n');

console.log('A. 內容、keep、設定與日期：');
for (const c of cases) {
    const why = problem(c);
    if (why) bad(c.name, why);
    else ok(c.name);
}

console.log('\nB. 改壞判斷（admission-cycle.test.mjs 必須失敗）：');
reset();
for (const m of libMutations) mutate('scripts/admission-cycle.lib.mjs', m, passes, '改壞之後單元測試還是通過');
for (const m of refsMutations) mutate('scripts/markdown-refs.lib.mjs', m, passes, '改壞之後單元測試還是通過');

console.log('\nC. 改壞串接（A 段至少一項必須失敗）：');
for (const m of cliMutations) mutate('scripts/check-admission-cycle.mjs', m, () => cases.every((c) => problem(c) === null), 'A 段全部照樣符合');

console.log('\nD. 改壞排程（admission-cycle.test.mjs 必須失敗）：');
for (const m of workflowMutations) mutate('.github/workflows/admission-cycle-check.yml', m, passes, '改壞之後單元測試還是通過');

const after = baseline();
console.log(after ? '\n還原後仍是綠燈。' : '\n還原後不是綠燈，沙盒沒有復原乾淨。');
rmSync(WORK, { recursive: true, force: true });
const total = cases.length + libMutations.length + refsMutations.length + cliMutations.length + workflowMutations.length;
console.log(`故障注入：${pass} 項符合，${fail} 項不符（共 ${total} 項）`);
process.exit(fail === 0 && after ? 0 : 1);
