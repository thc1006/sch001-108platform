// 內容學年度漂移檢查的判斷（#116），由 check-admission-cycle.mjs 呼叫，admission-cycle.test.mjs 測試。
// 升學內容以 admission-cycle.json 的 cycle 那一屆大學申請入學為準。內文的「NNN 學年度」和甄選會
// 網址 applyNNN／starNNN 的年度只能是 cycle 或 next，「113 至 115 學年度」這種區間要包含其中一個，
// 其他的要列在 keep 才放行。next 也放行，換屆時才能一頁一個 PR 改成下一屆，最後再改 cycle。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON_CHARS = 10;
const TOP_KEYS = new Set(['_readme', 'cycle', 'next', 'remindAfter', 'remindReason', 'keep']);
const TEXT_KEEP_KEYS = new Set(['file', 'text', 'cycle', 'reason', 'recheckAfter']);
const URL_KEEP_KEYS = new Set(['url', 'cycle', 'reason', 'recheckAfter']);

// 只有分隔符號後面可以換行。換行前也算的話，一行以「114 學年度」結尾、下一行是「- 115 學年度」的清單，
// 114 會被當成區間的開頭。
const SP = '[^\\S\\r\\n]*';
const BREAK = `${SP}(?:\\r?\\n${SP})?`;
const LIST = '[、／/及和與或]';
const RANGE = '[至到~～〜\\-–—－]';
const NUM = '\\d{3}(?!\\d)';
// 已知看不出來的寫法：逗號隔開的「114，115 學年度」只算 115，因為「名額為 112，115 學年度增加為 120」的 112
// 不是年度；表格裡只寫數字、欄名才寫「學年度」的；國字的「一一四學年度」；數字和「學年度」被換行拆開的。
const PHRASE = new RegExp(`(?<!\\d)${NUM}(?:${SP}(?:${LIST}|${RANGE})${BREAK}${NUM})*${SP}學年度`, 'g');
const RANGE_SEP = new RegExp(RANGE);
// 比對成功時 lastIndex 停在下一組的年度數字，下一組一定從那裡開始。
const RANGE_TO_NEXT = new RegExp(`${SP}${RANGE}${BREAK}(?=${NUM}${SP}學年度)`, 'y');
// 不管有沒有 scheme 都抓，前面接英數字的不算，notcac.edu.tw 不是甄選會。甄選會的網址只用 ASCII，網址到
// 空白、Markdown 的記號或非 ASCII 字元為止，keep 才比得到整個網址。
const CAC_URL = /(?<![\w.-])(?:https?:\/\/)?(?:[a-z0-9-]+\.)*cac\.edu\.tw\/(?:apply|star)(\d{3})(?!\d)[^\s()<>[\]"'`*|\u0080-\uffff]*/gi;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReason = (v) => typeof v === 'string' && [...v.trim()].length >= MIN_REASON_CHARS;
// 「115 至 119 學年度入學適用第三期」這種有效期間，在 115 到 119 都還是對的，所以區間看有沒有包含，不只看結尾。
const allows = (years, t) => (t.from === undefined ? years.has(t.year) : [...years].some((y) => t.from <= y && y <= t.year));

/** isRealDate 判斷 text 是不是存在的 YYYY-MM-DD 日期，2027-02-29 這種會被 Date 捲到下個月的不算。 */
export function isRealDate(text) {
    if (typeof text !== 'string' || !DATE_RE.test(text)) return false;
    const [y, m, d] = text.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === text;
}

/** isPast 判斷 todayISO 是否已經過了 dateISO，當天還不算。兩者都是 YYYY-MM-DD。 */
export const isPast = (dateISO, todayISO) => todayISO > dateISO;

/**
 * taipeiToday 回傳 now 在台灣的日期。remindAfter 寫的是台灣的日曆日，CI 跑在 UTC，照 UTC 算的話，
 * 每天 UTC 16:00 之後，也就是台灣 0 點到 8 點，日期會少一天。
 * @param {Date} [now] @returns {string}
 */
export function taipeiToday(now = new Date()) {
    const format = { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' };
    return new Intl.DateTimeFormat('en-CA', format).format(now);
}

/**
 * remindWindow 回傳 next 那一屆可以填的 remindAfter 範圍，兩端都算：從那一屆考生升高三的 8 月 1 日，
 * 到隔年 3 月底第一階段放榜。招聯會行事曆上，116 學年度的簡章在 2026-11-03 公告，第一階段在 2027-03-30 放榜。
 * @param {number} next @returns {{from: string, to: string}}
 */
export function remindWindow(next) {
    return { from: `${next + 1910}-08-01`, to: `${next + 1911}-03-31` };
}

/**
 * maskForText 把 src 裡不算內文的字元換成空白，換行和長度不變，位置才對得回原文：Markdown 連結的網址、
 * HTML 註解與標籤（含 <https://…> 這種自動連結）、參考式連結的定義、裸網址，以及粗體斜體的 * 和 _、
 * 刪除線的 ~~。裸網址到非 ASCII 字元為止，後面緊接的中文才不會被吃掉。全形數字換成半形。
 * @param {string} src @returns {string}
 */
function maskForText(src) {
    const blank = (m) => m.replace(/[^\n]/g, ' ');
    return src
        .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
        .replace(/\]\([^)\n]*\)/g, (m) => `](${' '.repeat(m.length - 3)})`)
        .replace(/<!--[^]*?-->/g, blank)
        .replace(/<\/?[A-Za-z][^<>\n]*>/g, blank)
        .replace(/^ {0,3}\[[^\]\n]+\]:.*/gm, blank)
        .replace(/https?:\/\/[^\s<>()[\]"'`\u0080-\uffff]*/g, blank)
        .replace(/[*_]|~~/g, blank);
}

/**
 * findYears 找出 src 裡的學年度。內文的部分，「115、116 學年度」這種列舉每個算一個；「113 至 115 學年度」
 * 和「113 學年度至 115 學年度」這種區間算一個，year 是結尾，from 是開頭。網址的部分，每個 applyNNN／starNNN
 * 算一個。start 到 end 是整個字樣在 src 裡的位置，內文的 phrase 去掉了 Markdown 標記。
 * @param {string} src
 * @returns {Array<{year: number, from?: number, kind: 'text'|'url', start: number, end: number, line: number, phrase: string}>}
 */
export function findYears(src) {
    const lineOf = (pos) => src.slice(0, pos).split('\n').length;
    const out = [];
    for (const m of src.matchAll(CAC_URL)) {
        const url = m[0].replace(/[.,;:!?]+$/, '');
        out.push({ year: Number(m[1]), kind: 'url', start: m.index, end: m.index + url.length, line: lineOf(m.index), phrase: url });
    }
    const text = maskForText(src);
    let carry = null;
    for (const m of text.matchAll(PHRASE)) {
        const end = m.index + m[0].length;
        const nums = [...m[0].matchAll(/\d{3}/g)];
        // 上一組是「113 學年度至」的話，這一組的第一個年度是那個區間的結尾。
        let from = carry;
        carry = null;
        nums.forEach((n, i) => {
            const year = Number(n[0]);
            const pos = m.index + n.index;
            let rangeStart;
            if (i + 1 < nums.length) {
                rangeStart = RANGE_SEP.test(m[0].slice(n.index + 3, nums[i + 1].index));
            } else {
                RANGE_TO_NEXT.lastIndex = end;
                rangeStart = RANGE_TO_NEXT.test(text);
                if (rangeStart) carry = { year, start: pos };
            }
            if (rangeStart) {
                from = { year, start: pos };
                return;
            }
            const start = from ? from.start : pos;
            const phrase = text.slice(start, end).replace(/\s+/g, ' ');
            out.push({ year, ...(from && { from: from.year }), kind: 'text', start, end, line: lineOf(start), phrase });
            from = null;
        });
    }
    return out.sort((a, b) => a.start - b.start);
}

/**
 * validateConfig 檢查 admission-cycle.json 本身，回傳錯誤訊息，空陣列表示沒問題。
 * 不讀內容，也不看今天日期，同一份設定在哪一天跑結果都一樣。
 * @param {unknown} config @returns {string[]}
 */
export function validateConfig(config) {
    if (!isPlainObject(config)) return ['設定檔的最外層必須是物件'];
    const errors = [];
    for (const k of Object.keys(config)) if (!TOP_KEYS.has(k)) errors.push(`最外層有不認得的欄位「${k}」`);
    const { cycle, next, remindAfter } = config;
    const cycleOk = Number.isInteger(cycle) && cycle >= 100 && cycle <= 999;
    if (!cycleOk) errors.push(`cycle 必須是三位數的整數，目前是 ${JSON.stringify(cycle)}`);
    else if (next !== cycle + 1) errors.push(`next 必須是 cycle + 1，也就是 ${cycle + 1}，目前是 ${JSON.stringify(next)}`);
    if (!isRealDate(remindAfter)) {
        errors.push(`remindAfter 必須是存在的 YYYY-MM-DD 日期，目前是 ${JSON.stringify(remindAfter)}`);
    } else if (cycleOk && next === cycle + 1) {
        const w = remindWindow(next);
        if (remindAfter < w.from || remindAfter > w.to) {
            errors.push(`remindAfter（${remindAfter}）必須在 ${w.from} 到 ${w.to} 之間，也就是 ${next} 學年度考生升高三到第一階段放榜`);
        }
    }
    if (!isReason(config.remindReason)) errors.push(`remindReason 要寫 remindAfter 這個日期的依據，至少 ${MIN_REASON_CHARS} 個字`);
    if (!Array.isArray(config.keep)) {
        errors.push('keep 必須是陣列，沒有例外時寫 []');
        return errors;
    }
    const seen = new Set();
    config.keep.forEach((k, i) => {
        const at = `keep[${i}]`;
        if (!isPlainObject(k)) return errors.push(`${at} 必須是物件`);
        const isUrl = 'url' in k;
        const keys = isUrl ? URL_KEEP_KEYS : TEXT_KEEP_KEYS;
        for (const key of Object.keys(k)) {
            if (!keys.has(key)) errors.push(`${at} 有不認得的欄位「${key}」，${isUrl ? '網址' : '文字'} keep 只能有 ${[...keys].join('、')}`);
        }
        if (cycleOk && k.cycle !== cycle) {
            errors.push(`${at} 的 cycle 是 ${JSON.stringify(k.cycle)}，和設定檔的 cycle ${cycle} 不同。換屆時每一筆 keep 都要重新確認，還需要的把 cycle 改成 ${cycle}，不需要的刪掉`);
        }
        if (!isReason(k.reason)) errors.push(`${at} 的 reason 要寫為什麼保留這個年度，至少 ${MIN_REASON_CHARS} 個字`);
        if ('recheckAfter' in k && !isRealDate(k.recheckAfter)) errors.push(`${at} 的 recheckAfter 必須是存在的 YYYY-MM-DD 日期`);
        let key;
        if (isUrl) {
            const found = typeof k.url === 'string' ? findYears(k.url) : [];
            if (found.length !== 1 || found[0].kind !== 'url' || found[0].phrase !== k.url) {
                errors.push(`${at} 的 url 必須是一個完整的甄選會 applyNNN／starNNN 網址`);
            } else if (cycleOk && (found[0].year === cycle || found[0].year === next)) {
                errors.push(`${at} 的網址年度是 ${found[0].year}，本來就放行，不需要 keep`);
            } else key = `url\n${k.url}`;
        } else {
            if (typeof k.file !== 'string' || !k.file.endsWith('.md')) errors.push(`${at} 的 file 必須是 .md 檔從 repo 根目錄起算的路徑`);
            if (typeof k.text !== 'string' || !k.text.trim() || /[\r\n]/.test(k.text)) errors.push(`${at} 的 text 必須是同一行裡的一段原文`);
            else key = `text\n${k.file}\n${k.text}`;
        }
        if (key && seen.has(key)) errors.push(`${at} 和前面的 keep 重複`);
        if (key) seen.add(key);
    });
    return errors;
}

/**
 * excerpt 回傳 src 裡 start 那一行的前後幾十個字，錯誤訊息用來指出位置。
 * @param {string} src @param {number} start @param {number} end @returns {string}
 */
function excerpt(src, start, end) {
    const lineStart = src.lastIndexOf('\n', start - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl < 0 ? src.length : nl;
    const from = Math.max(lineStart, start - 30);
    const to = Math.min(lineEnd, end + 30);
    // 跨行的區間會把換行帶進來，印出來時換成空白。
    return `${from > lineStart ? '…' : ''}${src.slice(from, to).replace(/\s*\n\s*/g, ' ')}${to < lineEnd ? '…' : ''}`;
}

/**
 * classify 列出 files 裡年度不在 allowed 的學年度，以及各自被哪幾筆 keep 放行。
 * 文字 keep 只放行完整落在 text 那一段裡的學年度，同一行其他地方的不算。
 * spans 是每筆文字 keep 在檔案裡的位置，找不到或不只一處的不在裡面，原因放在 keepErrors。
 */
function classify(files, keep, allowed) {
    const byPath = new Map(files.map((f) => [f.path, f]));
    const spans = new Map();
    const keepErrors = [];
    keep.forEach((k, i) => {
        if (!isPlainObject(k) || 'url' in k || typeof k.text !== 'string') return;
        const f = byPath.get(k.file);
        if (!f) return keepErrors.push(`keep[${i}] 的 file「${k.file}」不在比對的檔案裡，檔案改名或刪掉了就更新或刪掉這一筆`);
        const at = f.text.indexOf(k.text);
        if (at < 0) return keepErrors.push(`keep[${i}] 的 text 在 ${k.file} 裡找不到，內容改過了就更新或刪掉這一筆`);
        if (f.text.indexOf(k.text, at + 1) >= 0) return keepErrors.push(`keep[${i}] 的 text 在 ${k.file} 裡不只一處，加長到只出現一次`);
        spans.set(i, { file: k.file, start: at, end: at + k.text.length });
    });
    const hits = [];
    let found = 0;
    for (const f of files) {
        for (const t of findYears(f.text)) {
            found++;
            if (allows(allowed, t)) continue;
            const by = [];
            keep.forEach((k, i) => {
                const s = spans.get(i);
                const covers =
                    t.kind === 'url'
                        ? isPlainObject(k) && k.url === t.phrase
                        : s && s.file === f.path && s.start <= t.start && t.end <= s.end;
                if (covers) by.push(i);
            });
            hits.push({ ...t, path: f.path, by, context: excerpt(f.text, t.start, t.end) });
        }
    }
    return { found, hits, spans, keepErrors };
}

/**
 * checkContent 比對 files 的學年度與 config 的 cycle、next、keep，回傳錯誤訊息。
 * config 要先通過 validateConfig。沒有任何檔案，或一個學年度都找不到，都算錯：
 * 內容目錄搬走或比對規則壞掉時，什麼都沒比到不能當成通過。
 * @param {Array<{path: string, text: string}>} files path 從 repo 根目錄起算，和 keep 的 file 相同
 * @param {{cycle: number, next: number, keep: object[]}} config
 * @returns {{errors: string[], found: number, kept: number}}
 */
export function checkContent(files, config) {
    const { cycle, next, keep } = config;
    if (files.length === 0) return { errors: ['src/content 底下沒有任何 .md 檔，沒有東西可以比對'], found: 0, kept: 0 };
    const allowed = new Set([cycle, next]);
    const { found, hits, spans, keepErrors } = classify(files, keep, allowed);
    const errors = [...keepErrors];
    if (found === 0) errors.push(`${files.length} 個檔案裡找不到任何學年度或甄選會網址，比對規則可能壞了`);
    const used = new Set();
    for (const h of hits) {
        if (h.by.length === 1) {
            used.add(h.by[0]);
            continue;
        }
        const where = `${h.path}:${h.line}`;
        if (h.by.length > 1) {
            errors.push(`${where} 「${h.phrase}」同時被 ${h.by.map((i) => `keep[${i}]`).join('、')} 放行，留一筆就好`);
            continue;
        }
        let what = `「${h.phrase}」裡的 ${h.year} 不是`;
        if (h.kind === 'url') what = `網址 ${h.phrase} 的 ${h.year} 不是`;
        else if (h.from !== undefined) what = `「${h.phrase}」不包含`;
        errors.push(`${where} ${what} ${cycle} 或 ${next}\n    ${h.context}`);
    }
    keep.forEach((k, i) => {
        if (used.has(i) || !isPlainObject(k)) return;
        if ('url' in k) {
            if (!hits.some((h) => h.by.includes(i))) errors.push(`keep[${i}] 的網址 ${k.url} 已經不在內容裡，刪掉這一筆`);
            return;
        }
        const s = spans.get(i);
        if (!s) return;
        const text = files.find((f) => f.path === s.file).text;
        const all = findYears(text).filter((t) => s.start <= t.start && t.end <= s.end);
        const inside = all.filter((t) => t.kind === 'text');
        if (inside.length === 0 && all.length > 0) errors.push(`keep[${i}] 的 text 只包含網址，網址要寫成網址 keep（url）`);
        else if (inside.length === 0) errors.push(`keep[${i}] 的 text 沒有完整包含任何一處學年度，區間和列舉要從第一個年度包到「學年度」`);
        else if (inside.every((t) => allows(allowed, t))) errors.push(`keep[${i}] 的 text 裡的學年度本來就放行，不需要 keep`);
        // 其他情況是和別的 keep 重疊，上面已經報過。
    });
    return { errors, found, kept: hits.filter((h) => h.by.length === 1).length };
}

/**
 * dueKeeps 列出 recheckAfter 已經過了的 keep，當天還不算，和 remindAfter 一樣。
 * @param {{keep: object[]}} config @param {string} todayISO
 * @returns {Array<{index: number, keep: object}>}
 */
export function dueKeeps(config, todayISO) {
    return config.keep
        .map((keep, index) => ({ index, keep }))
        .filter(({ keep }) => isRealDate(keep.recheckAfter) && isPast(keep.recheckAfter, todayISO));
}
