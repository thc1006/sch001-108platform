// Markdown 參考式連結的定義 [id]: 網址 "標題"，writing.lib.mjs 和 admission-cycle.lib.mjs 共用。只認寫在同一行的
// 定義：標籤、網址和可有可無的標題都在這一行，標題後面沒有字，沒有用 <> 包起來的網址括號要成對。這一行要在
// 區塊開頭：文件開頭，或空行、ATX 標題、另一個定義、圍欄結束的下一行。網址或標題寫到下一行的定義不認，那幾行
// 照內文查。frontmatter、圍起來的程式碼和 HTML_BLOCKS 列的 HTML 區塊裡的不算。行首是 > 或清單符號的定義不認；
// 清單項目裡空一行、內縮最多三格的會被當成定義。

/** refLabel 正規化標籤：去掉頭尾空白、合併中間的空白、不分大小寫。 */
export const refLabel = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase();

const DEFINITION = /^ {0,3}\[(?!\^)((?:[^[\]\\\n]|\\.)+)\]:[ \t]*(<[^<>\n]*>|[^\s<\0-\x1f\x7f][^\s\0-\x1f\x7f]*)(?:[ \t]+(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\((?:[^()\\\n]|\\.)*\)))?[ \t]*$/;
// 沒有用 <> 包起來的網址，括號要成對。
const balanced = (dest) => dest.startsWith('<') || dest.replace(/\\./g, '').split('').reduce((n, c) => (n < 0 ? n : n + (c === '(') - (c === ')')), 0) === 0;
const FOOTNOTE = /^ {0,3}\[\^([^\]\n]+)\]:/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
// [開頭, 結尾]。結尾是 null 的到空行為止。開頭在段落中間也算，結尾那一行的下一行不當成區塊開頭。
const HTML_BLOCKS = [
    [/^ {0,3}<(?:pre|script|style|textarea)(?:[\s>]|$)/i, /<\/(?:pre|script|style|textarea)>/i],
    [/^ {0,3}<!--/, /-->/],
    [/^ {0,3}<\?/, /\?>/],
    [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
    [/^ {0,3}<![A-Za-z]/, />/],
    [/^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$)/, null],
];

/**
 * refDefinitions 回傳 src 裡的定義 {label, start, end}，start 到 end 是定義那一行。註腳 [^1]: 的 label 以 ^ 開頭，
 * 範圍只到冒號，後面的字是內文。
 * @param {string} src @returns {Array<{label: string, start: number, end: number}>}
 */
export function refDefinitions(src) {
    const defs = [];
    let pos = src.match(/^---\n[^]*?\n---(?=\n|$)/)?.[0].length ?? 0;
    if (pos) pos++;
    let canStart = true, fence = null, html = null;
    for (; pos <= src.length; ) {
        const eol = src.indexOf('\n', pos) < 0 ? src.length : src.indexOf('\n', pos);
        const line = src.slice(pos, eol);
        const start = pos;
        pos = eol + 1;
        let m;
        if (fence) {
            m = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
            if (m && m[1][0] === fence[0] && m[1].length >= fence.length) { fence = null; canStart = true; }
        } else if (html) {
            if (html === 'blank' ? !line.trim() : html.test(line)) { canStart = html === 'blank'; html = null; }
        } else if (!line.trim()) {
            canStart = true;
        } else if ((m = line.match(FENCE)) && !(m[1][0] === '`' && m[2].includes('`'))) {
            fence = m[1];
        } else if ((m = HTML_BLOCKS.find(([open]) => open.test(line)))) {
            html = m[1] && m[1].test(line.replace(m[0], '')) ? null : m[1] ?? 'blank';
            canStart = false;
        } else if (canStart && (m = line.match(DEFINITION)) && m[1].trim() && balanced(m[2])) {
            defs.push({ label: m[1], start, end: eol });
        } else if (canStart && (m = line.match(FOOTNOTE))) {
            defs.push({ label: `^${m[1]}`, start, end: start + m[0].length });
            canStart = false;
        } else {
            canStart = ATX.test(line);
        }
    }
    return defs;
}

/** refLabels 回傳 src 裡定義過的標籤，已經用 refLabel 正規化。 */
export const refLabels = (src) => new Set(refDefinitions(src).map((d) => refLabel(d.label)));
