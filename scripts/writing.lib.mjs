// check-writing.mjs 的判斷，規範見 CONTRIBUTING.md 的「網站內容」。check-writing.mjs 負責讀檔和輸出，
// writing.test.mjs 測試這裡的每個函式。規則的 id 與嚴重度以 RULES 為準，writing-policy.json 只存 block
// 規則的基準筆數。
//
// 區塊是一段讀者看得到的文字：{ page, kind, tag, text, skip, bold, pointer? }。skip 和 text 等長，每個字元
// 一個代號：' ' 一般文字，'a' 站外連結文字，'q' 引用的原文與書名，'u' 網址。

/** PH 是模板字串 ${…} 的佔位符。執行時那裡多半是中文：P10 把它當成中文，英文 em dash 的判斷不把它當英文，回推原始檔時從這裡切開。 */
export const PH = '\uE000';

const HAN = '\\p{Script=Han}';
const BLOCK = new Set(['p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'dt', 'dd', 'blockquote', 'figcaption', 'caption', 'summary', 'label', 'button', 'div', 'section', 'article', 'header', 'footer', 'nav', 'aside', 'ul', 'ol', 'table', 'tr', 'details', 'br', 'option', 'select', 'form', 'main', 'figure', 'hr']);
const DROP = new Set(['script', 'style', 'code', 'pre', 'noscript', 'svg', 'template', 'kbd', 'samp']);
/** NAME_FIELDS 是資料 JSON 裡的專有名稱欄位：競賽名、書名、機構名照官方寫法，不檢查。tips 底下的 title 是站方寫的，照查。 */
const NAME_FIELDS = new Set(['title', 'name', 'org', 'organizer', 'author', 'original_title', 'provider', 'platform', 'university', 'major', 'category', 'tags', 'subjects', 'level', 'form', 'region', 'mode', 'lang', 'language', 'difficulty', 'pricing', 'type', 'theme']);
const SKIP_KEYS = new Set(['id', 'url', 'link', 'photo_url', 'image', 'lastUpdated', 'date', 'deadline', 'slug', 'icon', 'thumbnail_url', 'logo', 'thumbnail', 'recheckNote']);
// 只有明說照抄的「逐字」「原文」後面的「」算引文。冒號、說、寫後面多半是站方自己寫的示範句，照查。
const ATTRIB = /(逐字|原文)\s*[：:]?\s*$/u;
const DISPLAY_ATTRS = ['alt', 'title', 'aria-label', 'placeholder'];

/**
 * maskQuotes 回傳標出引文與網址的 skip。引文是「逐字」「原文」後面的「」、緊接在它後面的連續引號，以及《》〈〉。
 * @param {string} text @param {string} skip 和 text 等長 @returns {string}
 */
export function maskQuotes(text, skip) {
    const s = skip.split('');
    const mark = (a, b, c) => { for (let i = a; i < b; i++) if (s[i] === ' ') s[i] = c; };
    for (const m of text.matchAll(/《[^《》]*》|〈[^〈〉]*〉/gu)) mark(m.index, m.index + m[0].length, 'q');
    let depth = 0, open = -1, lastQuoted = -1;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '「') {
            if (depth === 0) open = i;
            depth++;
        } else if (text[i] === '」' && depth > 0 && --depth === 0) {
            const chained = lastQuoted >= 0 && /^[、，\s]*$/.test(text.slice(lastQuoted, open));
            if (ATTRIB.test(text.slice(Math.max(0, open - 6), open)) || chained) {
                mark(open, i + 1, 'q');
                lastQuoted = i + 1;
            }
        }
    }
    for (const m of text.matchAll(/https?:\/\/[^\s<>()（）「」，。]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|edu|gov|tw|io|dev|app|cc|me)(?:\/[^\s，。）」]*)?/giu)) {
        for (let i = m.index; i < m.index + m[0].length; i++) s[i] = 'u';
    }
    return s.join('');
}

/**
 * isMention 判斷命中是不是在談這個詞本身，例如「把「很多」改成數字」：命中單獨在一對「」裡，而且這串相連的引號
 * 前面接著把、像是、例如、比如、寫成、改成這類詞，或後面接著這類、這種、這兩個字、的句型這類詞。沒有這些詞的「真心話」
 * 是強調，照算。已知限制：「例如「真心話」系列講座」這種標題也會被當成在談詞語。
 * @param {string} text @param {number} index @param {number} len @returns {boolean}
 */
export function isMention(text, index, len) {
    const open = text.lastIndexOf('「', index);
    const close = text.indexOf('」', open + 1);
    if (open < 0 || close < index + len || text.slice(open + 1, index).includes('」')) return false;
    if (/\p{Script=Han}/u.test(text.slice(open + 1, index) + text.slice(index + len, close))) return false;
    let a = open, b = close + 1;
    for (let m; (m = text.slice(0, a).match(/「[^「」]{1,12}」[、\s]?$/)); ) a -= m[0].length;
    for (let m; (m = text.slice(b).match(/^[、\s]?「[^「」]{1,12}」/)); ) b += m[0].length;
    return /(把|像是|例如|比如|諸如|寫成|改成|換成|叫做|稱為|這個詞|用詞|字眼|說法)\s*$/u.test(text.slice(Math.max(0, a - 6), a))
        || /^\s*(這類|這種|這些|等詞|等字|一詞|這個詞|這兩個字|這幾個字|之類|的句型|句型|的寫法|這個寫法)/u.test(text.slice(b, b + 6));
}

/**
 * blocksFrom 把 root 底下的文字依區塊切段。$ 是 cheerio 物件。站外連結的文字標 'a'；<q>、<cite>、帶 cite 的
 * blockquote 與 data-writing-quote 標 'q'；data-writing-ignore 和元素裡只有一個「—」「-」「…」的佔位符整個略過。
 */
export function blocksFrom($, root, base) {
    const out = [];
    let buf = '', skip = '', bold = [];
    const flush = (tag) => {
        let t = '', k = '';
        for (let i = 0; i < buf.length; i++) {
            const ws = /\s/.test(buf[i]);
            if (ws && (t === '' || t.endsWith(' '))) continue;
            t += ws ? ' ' : buf[i];
            k += skip[i];
        }
        if (t.endsWith(' ')) { t = t.slice(0, -1); k = k.slice(0, -1); }
        if (t) out.push({ ...base, tag, text: t, skip: maskQuotes(t, k), bold });
        buf = ''; skip = ''; bold = [];
    };
    const walk = (node, tag, flag) => {
        for (const ch of node.children || []) {
            if (ch.type === 'text') { buf += ch.data; skip += flag.repeat(ch.data.length); continue; }
            if (ch.type !== 'tag') continue;
            const name = ch.name.toLowerCase();
            const el = $(ch);
            if (DROP.has(name) || el.attr('data-writing-ignore') !== undefined) continue;
            if (/^\s*[—–\-…]\s*$/.test(el.text()) && el.children().length === 0 && name !== 'p' && name !== 'li') continue;
            const href = name === 'a' ? el.attr('href') || '' : '';
            const ext = /^https?:\/\//i.test(href) && !/^https?:\/\/thc1006\.github\.io\//i.test(href);
            const quote = name === 'q' || name === 'cite' || el.attr('data-writing-quote') !== undefined || (name === 'blockquote' && (el.attr('cite') !== undefined || el.find('cite').length > 0));
            const f = flag !== ' ' ? flag : ext ? 'a' : quote ? 'q' : ' ';
            if (BLOCK.has(name)) {
                flush(tag);
                const t = name === 'br' || name === 'hr' ? tag : name;
                walk(ch, t, f);
                flush(t);
            } else if (name === 'strong' || name === 'b') {
                const start = buf.length;
                walk(ch, tag, f);
                const own = buf.slice(start).trim();
                let next = ch.next;
                while (next && next.type === 'text' && next.data.trim() === '') next = next.next;
                bold.push({ own, label: /[：:]$/.test(own) || (next?.type === 'text' && /^\s*[：:]/.test(next.data)) });
            } else walk(ch, tag, f);
        }
    };
    walk(root, 'div', ' ');
    flush('div');
    return out;
}

const plain = (page, kind, tag, text, extra = {}) => ({ page, kind, tag, text, skip: maskQuotes(text, ' '.repeat(text.length)), bold: [], ...extra });

/**
 * pageBlocks 回傳一頁的區塊：<main> 的文字；和內文不重複的頁面標題、meta description、og:title、og:description
 * 與 alt、title、aria-label、placeholder 屬性；inline <script> 裡會顯示的字串。withChrome 為真時另外收 header、
 * footer。seenScripts 跨頁共用，版面共用的腳本只算一次。
 */
export function pageBlocks($, page, { withChrome = false, seenScripts = new Set() } = {}) {
    const blocks = [];
    const main = $('main')[0];
    if (main) blocks.push(...blocksFrom($, main, { page, kind: 'html' }));
    if (withChrome) for (const sel of ['body > header', 'body > footer']) $(sel).each((_, el) => blocks.push(...blocksFrom($, el, { page: '(layout)', kind: 'html' })));
    const mainText = main ? $(main).text().replace(/\s+/g, '') : '';
    const seen = new Set();
    const attr = (tag, value) => {
        const x = String(value || '').replace(/\s+/g, ' ').trim();
        const key = x.replace(/( - [^-]*){0,2}$/, '').replace(/\s+/g, '');
        if (!/\p{Script=Han}/u.test(x) || seen.has(key) || mainText.includes(key)) return;
        seen.add(key);
        blocks.push(plain(page, 'html', tag, x));
    };
    attr('attr:title', $('head > title').text());
    attr('attr:description', $('meta[name="description"]').attr('content'));
    for (const p of ['og:title', 'og:description']) attr(`attr:${p}`, $(`meta[property="${p}"]`).attr('content'));
    $(DISPLAY_ATTRS.map((a) => `body [${a}]`).join(', ')).each((_, el) => { for (const a of DISPLAY_ATTRS) attr(`attr:${a}`, $(el).attr(a)); });
    $('script:not([src])').each((_, el) => {
        for (const t of scriptStrings($(el).html() || '')) {
            if (seenScripts.has(t)) continue;
            seenScripts.add(t);
            blocks.push(plain(page, 'html', 'script', t));
        }
    });
    return blocks;
}

/**
 * jsonBlocks 回傳資料 JSON 裡的字串欄位，鍵名以 _html 結尾的用 load 解析成 HTML。_ 開頭的鍵和網址、日期這類
 * 欄位不看；專有名稱欄位標成 'name'。
 */
export function jsonBlocks(data, page, load) {
    const blocks = [];
    (function walk(o, key, ptr) {
        if (Array.isArray(o)) o.forEach((x, i) => walk(x, key, `${ptr}/${i}`));
        else if (o && typeof o === 'object') {
            for (const k of Object.keys(o)) if (!SKIP_KEYS.has(k) && !k.startsWith('_') && !(k === 'note' && key !== 'cycle')) walk(o[k], k, `${ptr}/${k}`);
        } else if (typeof o === 'string' && /\p{Script=Han}/u.test(o) && !/^https?:/.test(o)) {
            if (key.endsWith('_html')) {
                const $ = load(`<div id="__r">${o}</div>`);
                blocks.push(...blocksFrom($, $('#__r')[0], { page, kind: 'json', pointer: ptr }));
            } else {
                const name = NAME_FIELDS.has(key) && !(key === 'title' && ptr.includes('/tips/'));
                blocks.push(plain(page, 'json', name ? 'name' : 'p', o.replace(/\s+/g, ' ').trim(), { pointer: ptr }));
            }
        }
    })(data, '', '');
    return blocks;
}

/**
 * scriptStrings 取出程式碼裡會顯示的中文字串常值。逐字掃描：註解和正規式字面值跳過；模板字串的 ${…} 換成 PH，
 * 裡面的巢狀字串另外取出；console.*(…) 的引數與傳給 RegExp、match、replace 等的字串不算。模板裡的
 * alt、title、aria-label、placeholder 屬性另算一段，其餘標籤去掉。不加 parser 依賴，所以正規式只用前一個
 * 字元判斷。
 */
export function scriptStrings(code) {
    const out = [];
    const skipRanges = [];
    for (const m of code.matchAll(/console\.\w+\(/g)) {
        let depth = 0, i = m.index + m[0].length - 1;
        for (; i < code.length; i++) {
            if (code[i] === '(') depth++;
            else if (code[i] === ')' && --depth === 0) break;
            else if ('"\'`'.includes(code[i])) i = skipString(code, i);
        }
        skipRanges.push([m.index, i]);
    }
    const push = (raw, start) => {
        if (skipRanges.some(([a, b]) => start >= a && start <= b)) return;
        const line = code.slice(code.lastIndexOf('\n', start) + 1, start);
        if (/(new RegExp|\.match|\.test|\.replace|\.split|\.includes|\.startsWith|\.endsWith|\.indexOf)\(\s*$/.test(line)) return;
        const curly = /[“”‘’]\uE000|\uE000[“”‘’]/.test(raw);
        if (!/\p{Script=Han}/u.test(raw) && !curly) return;
        for (const am of raw.matchAll(/(?<![\w-])(?:alt|title|aria-label|placeholder)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+))/g)) {
            const v = (am[1] ?? am[2] ?? am[3]).replace(/\s+/g, ' ').trim();
            if (/\p{Script=Han}/u.test(v)) out.push(v);
        }
        const t = raw.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (/\p{Script=Han}/u.test(t) || curly) out.push(t);
    };
    for (let i = 0; i < code.length; i++) {
        const c = code[i];
        if (c === '/' && code[i + 1] === '/') { i = code.indexOf('\n', i); if (i < 0) break; continue; }
        if (c === '/' && code[i + 1] === '*') { i = code.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
        if (c === '/' && /(^|[=(:[!&|?{};,+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(code.slice(Math.max(0, i - 12), i))) { i = skipRegex(code, i); continue; }
        if (c === '"' || c === "'") { const e = skipString(code, i); push(code.slice(i + 1, e), i); i = e; continue; }
        if (c === '`') { const { end, text } = readTemplate(code, i, push); push(text, i); i = end; }
    }
    return out;
}

function skipRegex(code, i) {
    let cls = false;
    for (let k = i + 1; k < code.length; k++) {
        const c = code[k];
        if (c === '\\') k++;
        else if (c === '[') cls = true;
        else if (c === ']') cls = false;
        else if ((c === '/' && !cls) || c === '\n') return k;
    }
    return code.length;
}

function skipString(code, i) {
    if (code[i] === '`') return readTemplate(code, i).end;
    for (let k = i + 1; k < code.length; k++) {
        if (code[k] === '\\') k++;
        else if (code[k] === code[i] || code[k] === '\n') return k;
    }
    return code.length;
}

function readTemplate(code, i, onNested) {
    let text = '';
    for (let k = i + 1; k < code.length; k++) {
        const c = code[k];
        if (c === '\\') { text += c + (code[k + 1] ?? ''); k++; continue; }
        if (c === '`') return { end: k, text };
        if (c !== '$' || code[k + 1] !== '{') { text += c; continue; }
        for (let depth = 0, j = k + 1; j < code.length; j++) {
            const d = code[j];
            if (d === '{') depth++;
            else if (d === '}' && --depth === 0) { k = j; break; }
            else if (d === '`') { const r = readTemplate(code, j, onNested); onNested?.(r.text, j); j = r.end; }
            else if (d === '"' || d === "'") { const e = skipString(code, j); onNested?.(code.slice(j + 1, e), j); j = e; }
        }
        text += PH;
    }
    return { end: code.length, text };
}

// ---- 規則 ----
const after = (m, n = 4) => m.input.slice(m.index + m[0].length, m.index + m[0].length + n);
const before = (m, n = 4) => m.input.slice(Math.max(0, m.index - n), m.index);
const isHan = (c) => /\p{Script=Han}/u.test(c || '');
const PLACE = /(臺北|台北|新北|基隆|桃園|新竹|苗栗|臺中|台中|彰化|南投|雲林|嘉義|臺南|台南|高雄|屏東|宜蘭|花蓮|臺東|台東|澎湖|金門|馬祖|左營|南港)$/;
const SENTENCE = /[^。！？!?；;]+[。！？!?；;」』）)]*/gu;

function superlativeNormal(m) {
    const a = after(m, 6);
    if (/^(後|終|新|近|早|晚|遲|初)/.test(a)) return '時間或順序';
    if (/^好(能|是|先|在|要|不要|別)/.test(a)) return '最好（建議）';
    if (/^(常見|多|少)的?是?[^。]{0,24}\d/.test(a)) return '後面有數字';
    if (/^(低|高|多|少|長|短|快|慢)\s*(\d|[一二三四五六七八九十兩]|可|只|不|為|上限|下限|門檻|錄取|級分|分數|標準|約|僅)/.test(a)) return '規定的上下限';
    return null;
}

function dashNormal(m) {
    const b = before(m, 6), a = after(m, 6);
    if (/[0-9０-９]\s*$/.test(b) && /^\s*[0-9０-９]/.test(a)) return '數字範圍';
    if (/(週|周|星期)[一二三四五六日天]$/.test(b) && /^(週|周|星期)/.test(a)) return '星期範圍';
    if (PLACE.test(b) && isHan(a[0])) return '地名起訖';
    if (/[A-Za-z]/.test(b.slice(-1)) && /[A-Za-z]/.test(a[0] ?? '')) return '英文裡的 em dash';
    if (/[A-Za-z]\s*$/.test(b) && /^\s*[A-Za-z]/.test(a) && !b.includes(PH) && !a.includes(PH)) return '英文裡的 em dash';
    // 同一對「」裡三段以上、沒有標點的步驟鏈，例如「動機—探究—收穫—反思」。
    const qa = m.input.lastIndexOf('「', m.index), qb = m.input.indexOf('」', m.index);
    const chain = qa >= 0 && qb > m.index && !m.input.slice(qa, m.index).includes('」') ? m.input.slice(qa + 1, qb) : '';
    const parts = chain.split('—');
    if (/^[\p{Script=Han}—]+$/u.test(chain) && parts.length >= 3 && parts.every((x) => x.length >= 1 && x.length <= 8 && !/[是了在]/.test(x))) return '步驟鏈';
    return null;
}

function quoteNesting(b) {
    const out = [];
    const stack = [];
    for (let i = 0; i < b.text.length; i++) {
        const c = b.text[i];
        if (c === '「' || c === '『') {
            const want = stack.length % 2 === 0 ? '「' : '『';
            if (c !== want && !(c === '『' && b.text[i + 1] === '』')) out.push({ index: i, len: 1, note: `第 ${stack.length + 1} 層應該用${want}` });
            stack.push(c);
        } else if ((c === '」' || c === '』') && stack.length) {
            const open = stack.pop();
            if ((open === '「') !== (c === '」')) out.push({ index: i, len: 1, note: `${open}和${c}不成對` });
        }
    }
    return out;
}

function longSentences(b) {
    if (!['p', 'li', 'dd', 'td', 'div', 'blockquote'].includes(b.tag)) return [];
    const out = [];
    // 引號、書名和網址裡的字不算長度：照抄的簡章條文不是作者能拆的句子。
    const quoted = new Set();
    for (const q of b.text.matchAll(/「[^「」]*」|『[^『』]*』/gu)) for (let k = q.index; k < q.index + q[0].length; k++) quoted.add(k);
    for (const m of b.text.matchAll(SENTENCE)) {
        const own = [...m[0]].map((c, k) => (quoted.has(m.index + k) || /[qu]/.test(b.skip[m.index + k]) ? ' ' : c)).join('');
        const n = (own.match(/\p{Script=Han}/gu) || []).length + (own.match(/[A-Za-z0-9]+/g) || []).length;
        if (n > 80) out.push({ index: m.index, len: m[0].length, note: `${n} 字` });
    }
    return out;
}

/**
 * RULES 是全部的自動規則。skip 是要略過的 skip 代號；names 為真時連專有名稱欄位也查；normal 回傳字串表示
 * 本站的正常用法；custom 用在不靠正規式的規則。規則的說明與例句在 CONTRIBUTING.md。
 */
export const RULES = [
    { id: 'W01-hen-duo', severity: 'block', skip: 'aqu', re: /很多(?![元樣])/gu },
    { id: 'W02-vague-quantity', severity: 'warn', skip: 'aqu', re: /許多|大量|眾多|諸多|無數|海量|各式各樣|各種各樣|各種|不少(?!於)/gu },
    { id: 'W03-intensifier', severity: 'warn', skip: 'aqu', re: /非常|極其|極為|十分(?!鐘|之)|相當(?!於)|超級|無比|格外|高度(?=\p{Script=Han})/gu, normal: (m) => (m[0] === '高度' && /^(差|約|為|是|計|公尺|限制)/.test(after(m)) ? '物理高度' : null) },
    { id: 'W04-filler-signpost', severity: 'block', skip: 'aqu', re: /值得(?:注意|一提)的是|值得一提|綜上所述|總而言之|總之|毫無疑問|不言而喻|眾所周知|換句話說|簡而言之|說到底|歸根究[柢底]|歸根結[柢底]/gu },
    { id: 'W05-filler-addition', severity: 'warn', skip: 'aqu', re: /此外|除此之外|與此同時|事實上|本質上|顯然/gu, normal: (m) => (m[0] === '事實上' && before(m, 1) === '在' ? '建立在事實上' : null) },
    {
        id: 'W06-puffery', severity: 'block', skip: 'aqu',
        re: /賦能|一站式|無縫|全方位|助力|解碼|精髓|潛規則|真心話|不可或缺|至關重要|不容忽視|舉足輕重|扮演(?:著)?(?:至關重要|很重要|重要|關鍵)的?角色|的藝術|秘訣|祕訣|神器|乾貨/gu,
        normal: (m) => (m[0] === '助力' && before(m, 8).includes('阻力') ? '阻力還是助力' : m[0] === '解碼' && (/^(後|前|器|成|出)/.test(after(m)) || /[A-Za-z0-9-]\s*$/.test(before(m, 3))) ? '技術用語' : null),
    },
    { id: 'W07-endorsement', severity: 'warn', skip: 'aqu', re: /旨在|致力於|深入探討|打造|強大|優雅|精彩|豐富|獨特|頂尖|卓越|關鍵在於|攻略/gu },
    { id: 'W08-superlative', severity: 'warn', skip: 'aqu', re: /最(?=\p{Script=Han})/gu, normal: superlativeNormal },
    { id: 'W09-pushy-directive', severity: 'warn', skip: 'aqu', re: /務必|一定要|千萬(?:要|別|不要)|絕對(?!值)/gu, normal: (m) => (m[0] === '一定要' && /(不|未必)$/.test(before(m, 2)) ? '否定' : null) },
    { id: 'W10-core', severity: 'warn', skip: 'aqu', re: /核心/gu, normal: (m) => (/^(素養|能力|課程|科目|期刊|知識|學科|必修|課|通識)/.test(after(m)) ? '課綱與系所用語' : null) },
    { id: 'W11-genuinely', severity: 'warn', skip: 'aqu', re: /真正(?:的)?/gu },
    { id: 'W12-mainland-register', severity: 'warn', skip: 'aqu', re: /信息(?!素)|視頻|軟件|硬件|數據庫|賦能|閉環|抓手|顆粒度|復盤|(?<!供應)鏈路/gu },
    { id: 'P01-double-dash', severity: 'block', skip: 'aqu', re: /—{2,}|─{2,}|―+/gu },
    { id: 'P02-single-dash', severity: 'block', skip: 'aqu', re: /(?<![—─])—(?![—─])/gu, normal: dashNormal },
    {
        id: 'P04-halfwidth-punct', severity: 'block', skip: 'aqu',
        re: new RegExp(`(?<=${HAN})[,;:!?]|[,;:!?](?=${HAN})|(?<=${HAN})\\.(?=\\s|$|${HAN})`, 'gu'),
        normal: (m) => (/[A-Za-z]$/.test(before(m, 1)) && /[!?]/.test(m[0]) ? '英文名稱' : m[0] === '.' && /^\s+[A-Z]/.test(after(m, 3)) ? '英文句子' : null),
    },
    { id: 'P05-halfwidth-paren', severity: 'block', skip: 'aqu', re: new RegExp(`\\([^()（）]*${HAN}[^()（）]*\\)|(?<=${HAN}\\s?)\\([^()（）]*\\)`, 'gu') },
    { id: 'P06-exclamation', severity: 'warn', skip: 'aqu', re: /！|(?<=\p{Script=Han})!/gu },
    { id: 'P07-emoji', severity: 'block', skip: 'u', names: true, re: /(?![©®™])(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)/gu },
    { id: 'P09-quote-nesting', severity: 'block', skip: '', custom: quoteNesting },
    { id: 'P10-curly-quote', severity: 'block', skip: 'u', re: new RegExp(`[“”‘’](?=${HAN}|${PH})|(?<=${HAN}|${PH})[“”‘’]`, 'gu') },
    {
        id: 'P11-ellipsis', severity: 'warn', skip: 'qu', re: /\.{3}|(?<!…)…(?!…)/gu,
        normal: (m, b) => ((/^(script|attr:placeholder)$/.test(b.tag) && b.text.length <= 30 && /(…|\.\.\.)$/.test(b.text)) || /(載入|讀取|搜尋|處理|產生|傳送)中…$/.test(b.text) ? '介面狀態' : /[A-Za-z)]\s*$/.test(before(m, 2)) && /^\s*[A-Za-z]/.test(after(m, 2)) ? '英文引文' : null),
    },
    { id: 'S01-not-x-but-y', severity: 'warn', skip: 'q', re: /(?:不是|並非|並不是|不只是)[^，。！？；—─]{1,20}[，,]?\s*(?:而是|才是)[^。！？；」]{1,24}|(?:關鍵|重點|問題)[^，。！？]{0,8}不在(?:於)?[^，。！？]{1,16}[，,]\s*(?:而在於?|而是)|與其(?:說)?[^。！？；]{1,30}?不如/gu },
    { id: 'S02-not-only', severity: 'warn', skip: 'q', re: /(?:不僅|不只|不光)(?:是)?[^。！？；]{1,30}?(?:更|還|而且)(?:是)?/gu },
    { id: 'S05-weak-verb', severity: 'warn', skip: 'q', re: /進行(?![的中了多各一兩])(?=\p{Script=Han}{2})|作出|加以|予以/gu },
    { id: 'S08-long-sentence', severity: 'warn', skip: '', custom: longSentences },
    { id: 'C01-vague-attribution', severity: 'warn', skip: 'q', re: /(?:教授|老師|委員|學者|專家)們?(?:普遍|大多|多半|一致)(?:認為|指出|表示|建議)|(?:專家|學者|業界|許多人|很多人|大家|一般人|多數人)(?:普遍|大多|多半|一致)?(?:認為|指出|表示|建議)|(?:有|許多|很多|多項)研究(?:指出|顯示|發現|證實)|據統計|(?<!數)據說|據了解|普遍認為/gu },
    {
        id: 'C02-unsourced-rank', severity: 'warn', skip: 'aq', re: /(?:全球|全世界|世界|全台|台灣|臺灣|全國|國內|亞洲)(?:最[大多早高]|第一|首[創座個])|(?<!歷)史上最/gu,
        normal: (m) => (/(號稱|自稱|官網|官方|據|稱)[^。]{0,8}$/.test(before(m, 12)) ? '已標明是誰說的' : null),
    },
    { id: 'F01-bold-label', severity: 'warn', skip: '', names: true, custom: (b) => b.bold.filter((x) => x.label).map((x) => ({ index: Math.max(0, b.text.indexOf(x.own)), len: x.own.length, note: x.own })) },
    { id: 'F02-bold-dense', severity: 'warn', skip: '', custom: (b) => (['p', 'li', 'dd', 'td', 'div'].includes(b.tag) && b.bold.length >= 2 ? [{ index: 0, len: 0, note: `${b.bold.length} 處粗體` }] : []) },
    { id: 'K01-chat-residue', severity: 'block', skip: 'q', re: /希望(?:這|以上|本文|這些|這篇)?[^。！？]{0,6}(?:對你|對您)?有(?:所)?幫助|讓我們(?=陪|為|一起|來|帶|的)|我們(?:來|一起)(?:看看|探討)|如果你(?:還)?有(?:任何)?(?:問題|疑問)|歡迎(?:隨時)?(?:提問|詢問)|作為(?:一個)?\s?AI|截至我的(?:知識|訓練)|^(?:好的|當然)[，！,!]/gu },
];

/**
 * findHits 回傳 blocks 裡每一筆命中 {rule, block, index, len, match, note}。略過的範圍、談詞語本身的引號與正常用法
 * 不算，數量記在回傳的 skipped（rule id → 理由 → 筆數）。
 */
export function findHits(blocks, rules = RULES) {
    const hits = [];
    const skipped = {};
    const note = (id, why) => { skipped[id] ??= {}; skipped[id][why] = (skipped[id][why] ?? 0) + 1; };
    for (const r of rules) {
        for (const b of blocks) {
            if (b.tag === 'name' && !r.names) continue;
            const found = r.custom ? r.custom(b) : [...b.text.matchAll(r.re)].map((m) => ({ index: m.index, len: m[0].length, m }));
            for (const f of found) {
                if (f.len > 0 && r.skip && [...b.skip.slice(f.index, f.index + f.len)].some((c) => r.skip.includes(c))) { note(r.id, '略過的範圍'); continue; }
                if (f.len > 0 && isMention(b.text, f.index, f.len)) { note(r.id, '談詞語本身'); continue; }
                const normal = r.normal && f.m ? r.normal(f.m, b) : null;
                if (normal) { note(r.id, normal); continue; }
                hits.push({ rule: r.id, block: b, index: f.index, len: f.len, match: f.m ? f.m[0] : f.note, note: f.note });
            }
        }
    }
    return { hits, skipped };
}

// ---- 回推原始檔 ----
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
// 一次掃過，&amp;lt; 只解成 &lt;，不會再被解成 <。
const decode = (s) => s.replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, e) => ENTITIES[e]);
const stripTags = (s) => { let prev; do { prev = s; s = s.replace(/<[^>]*>/g, ''); } while (s !== prev); return s; };
const normText = (s) => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, '');
const normLine = (s, md) => normText(decode(stripTags(s.replace(/\\"/g, '"').replace(/\\n/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')).replace(/\*\*|__|`/g, '').replace(md ? /^\s*(#+|[-*+]|\d+\.|>)\s+/ : /^\s*(#+|[-*+]|>)\s+/, '')));

/**
 * sourceIndex 為每個原始檔建兩份正規化文字：text 去掉標籤（比對內文），raw 保留屬性值（比對屬性與腳本字串）。
 * 各行接成一串，記下每行的起點，跨行的字也找得到。
 * @param {Array<{path: string, content: string}>} files
 */
export function sourceIndex(files) {
    const build = (lines) => { const starts = []; let joined = ''; for (const l of lines) { starts.push(joined.length); joined += l; } return { joined, starts }; };
    return new Map(files.map(({ path, content }) => {
        const lines = content.split('\n');
        return [path, { text: build(lines.map((l) => normLine(l, path.endsWith('.md')))), raw: build(lines.map((l) => normText(decode(l.replace(/\\"/g, '"'))))) }];
    }));
}

const lineAt = (starts, pos) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo + 1; };

/**
 * locate 回推命中所在的原始檔與行號，找不到回傳 null，由呼叫的人記成 page:頁面路徑。取命中前後各 12、8、4 字，
 * 去掉 PH 後取最長的一段；這段不到 4 字就不找，免得在別的檔案找到同樣的短字。先找 preferred，再找全部。
 * @returns {{file: string, line: number, dup: number}|null}
 */
export function locate(index, block, at, len, preferred = []) {
    const kinds = block.tag.startsWith('attr') || block.tag === 'script' ? ['raw', 'text'] : ['text', 'raw'];
    for (const scope of [preferred.filter((f) => index.has(f)), [...index.keys()]]) {
        for (const pad of [12, 8, 4]) {
            const snip = block.text.slice(Math.max(0, at - pad), at + len + pad).split(PH).map(normText).sort((x, y) => y.length - x.length)[0];
            if (snip.length < 4) continue;
            for (const kind of kinds) {
                for (const file of scope) {
                    const { joined, starts } = index.get(file)[kind];
                    const pos = joined.indexOf(snip);
                    if (pos < 0) continue;
                    let dup = 0;
                    for (let k = pos; k >= 0; k = joined.indexOf(snip, k + 1)) dup++;
                    return { file, line: lineAt(starts, pos), dup };
                }
            }
        }
    }
    return null;
}

// ---- writing-allow.json ----
const KINDS = new Set(['quote', 'name', 'counterexample']);
/** charCount 數 reason 的字數，空白、標點和零寬字元不算。 */
const charCount = (s) => [...s.replace(/[\s\p{P}\p{S}\u200B-\u200D\u2060\uFEFF]/gu, '')].length;

/**
 * allowProblems 檢查放行條目的欄位，回傳每條的錯誤與警告。kind 只能是 quote、name、counterexample；quote 和
 * name 要有含網域的 http(s) source；reason 去掉空白與標點至少 10 個字；rule 要是存在的 id；file 和 page 恰好
 * 一個；同樣的 file／page、text、rule 不能重複；recheckAfter 要是存在的日期，過了 today 只警告。
 * @param {object[]} entries @param {Set<string>} ruleIds @param {string} today YYYY-MM-DD
 * @returns {Array<{errors: string[], warnings: string[]}>}
 */
export function allowProblems(entries, ruleIds, today) {
    const seen = new Set();
    return entries.map((e) => {
        const errors = [];
        const warnings = [];
        if (!KINDS.has(e.kind)) errors.push(`kind 要是 quote、name 或 counterexample，現在是 ${JSON.stringify(e.kind)}`);
        if ((e.kind === 'quote' || e.kind === 'name') && !(typeof e.source === 'string' && /^https?:\/\/[^\s/.]+(\.[^\s/.]+)+(\/\S*)?$/.test(e.source))) errors.push(`kind 是 ${e.kind} 時，source 要是含網域的網址`);
        if (typeof e.reason !== 'string' || charCount(e.reason) < 10) errors.push('reason 去掉空白與標點後至少 10 個字');
        if (typeof e.text !== 'string' || !e.text.trim()) errors.push('缺 text');
        if (!ruleIds.has(e.rule)) errors.push(`rule ${JSON.stringify(e.rule)} 不是規則 id`);
        const target = [e.file, e.page].filter((x) => x !== undefined && x !== '');
        if (target.length !== 1 || typeof target[0] !== 'string') errors.push('file 和 page 要恰好填一個字串');
        const key = JSON.stringify([e.file ?? e.page, e.text, e.rule]);
        if (seen.has(key)) errors.push('和前面的條目重複');
        seen.add(key);
        if (e.recheckAfter !== undefined) {
            const m = typeof e.recheckAfter === 'string' && e.recheckAfter.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
            if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) errors.push(`recheckAfter ${JSON.stringify(e.recheckAfter)} 不是存在的日期`);
            else if (today > e.recheckAfter) warnings.push(`已過 recheckAfter ${e.recheckAfter}`);
        }
        return { errors, warnings };
    });
}

/**
 * allowOccurrences 回傳 entry.text 在 blocks 裡出現幾次。blocks 要先篩成這條指定的檔案或頁面，不是 1 次的條目不放行。
 */
export const allowOccurrences = (entry, blocks) => blocks.reduce((n, b) => n + b.text.split(entry.text).length - 1, 0);

/** allowCovers 判斷命中是否落在 entry.text 在這個區塊裡的某一次出現之內。 */
export function allowCovers(entry, block, at, len) {
    for (let p = block.text.indexOf(entry.text); p >= 0; p = block.text.indexOf(entry.text, p + 1)) if (at >= p && at + len <= p + entry.text.length) return true;
    return false;
}

// ---- writing-policy.json 的基準 ----
const isCount = (n) => Number.isInteger(n) && n >= 0;

/**
 * compareBaseline 比較 block 規則目前的筆數 counts（rule id → 鍵 → 筆數）和 policy 的基準，回傳超過的 over 與少於的 under。
 * 鍵是原始檔路徑，回推不到的是 page:頁面路徑。基準以檔案為單位，同一檔修一筆加一筆不會被發現。
 */
export function compareBaseline(policy, counts, rules = RULES) {
    const over = [];
    const under = [];
    // 沒有列在 policy 的 block 規則當成基準是空的，漏寫不會變成不檢查。
    for (const rule of rules.filter((r) => r.severity === 'block').map((r) => r.id)) {
        const baseline = policy.rules[rule]?.baseline ?? {};
        const now = counts[rule] ?? {};
        for (const [key, n] of Object.entries(now)) if (n > (baseline[key] ?? 0)) over.push({ rule, key, count: n, baseline: baseline[key] ?? 0 });
        for (const [key, n] of Object.entries(baseline)) if ((now[key] ?? 0) < n) under.push({ rule, key, count: now[key] ?? 0, baseline: n });
    }
    return { over, under };
}

/** lowerBaseline 回傳新的 policy：每個鍵改成 min(現值, 基準)，降到 0 的鍵刪掉，不新增鍵也不調高。 */
export function lowerBaseline(policy, counts) {
    const rules = {};
    for (const [rule, { baseline = {} }] of Object.entries(policy.rules)) {
        const next = {};
        for (const [key, n] of Object.entries(baseline)) {
            const v = Math.min(counts[rule]?.[key] ?? 0, n);
            if (v > 0) next[key] = v;
        }
        rules[rule] = { baseline: next };
    }
    return { ...policy, rules };
}

/**
 * verifyPolicy 比較目標分支與這次的 policy，回傳問題清單。policy 的規則要和 RULES 的 block 規則一致；目標分支
 * 有的規則不能刪；基準要是非負整數，不能變大，也不能多出新鍵。新加的 block 規則要以空的基準加入。
 */
export function verifyPolicy(before, after, rules = RULES) {
    const problems = [];
    const block = new Set(rules.filter((r) => r.severity === 'block').map((r) => r.id));
    for (const id of block) if (!(id in after.rules)) problems.push(`${id}：RULES 是 block，policy 沒有這條`);
    for (const id of Object.keys(after.rules)) if (!block.has(id)) problems.push(`${id}：policy 有這條，RULES 不是 block`);
    for (const id of Object.keys(before.rules)) if (!(id in after.rules)) problems.push(`${id}：目標分支有這條規則的基準，這次刪了`);
    for (const [id, { baseline = {} }] of Object.entries(after.rules)) {
        const old = before.rules[id]?.baseline ?? {};
        for (const [key, n] of Object.entries(baseline)) {
            if (!isCount(n)) problems.push(`${id}：${key} 的基準 ${JSON.stringify(n)} 不是非負整數`);
            else if (!(key in old)) problems.push(`${id}：多出基準鍵 ${key}`);
            else if (n > old[key]) problems.push(`${id}：${key} 的基準從 ${old[key]} 變成 ${n}`);
        }
    }
    return problems;
}

// ---- annotation ----

/** changedLines 從 git diff -U0 的輸出取出新版本被改到的行，回傳「檔案:行號」的集合。 */
export function changedLines(diff) {
    const changed = new Set();
    let file = null;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
        const m = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
        if (m && file) for (let k = 0; k < Number(m[2] ?? 1); k++) changed.add(`${file}:${Number(m[1]) + k}`);
    }
    return changed;
}

/**
 * pickAnnotations 挑出落在改到的行上的命中，超過基準的檔案是 error，其餘是 warning。GitHub 每個 step 的 error 和
 * warning 各只顯示 limit 個，回傳要發的 annotation 和沒發的筆數。
 * @returns {{annotations: Array<{level: string, hit: object}>, rest: number}}
 */
export function pickAnnotations(hits, changed, overKeys, limit = 10) {
    const annotations = [];
    const sent = { error: 0, warning: 0 };
    let rest = 0;
    for (const h of hits.filter((x) => x.line && changed.has(`${x.key}:${x.line}`))) {
        const level = overKeys.has(`${h.rule}|${h.key}`) ? 'error' : 'warning';
        if (sent[level]++ >= limit) rest++;
        else annotations.push({ level, hit: h });
    }
    return { annotations, rest };
}
