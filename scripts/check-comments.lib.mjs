// 找出原始碼裡的註解，供 check-comments.mjs 計算註解行數、比對「只改了註解」。
//
// 掃描器把檔案切成一串不重疊的 item，每個 item 不是程式就是註解，item 之間只剩空白。
// 程式 item 就是比對用的 token：JS 用真正的 JS token，多數語言用空白分開的詞，
// Dockerfile 和只有整行註解的設定檔用整行。引號裡不拆。

/** CODE 是程式 item 的 kind。 */
export const CODE = 'code';
/** COMMENT 是註解 item 的 kind。 */
export const COMMENT = 'comment';

/** ScanError 表示檔案無法可靠地切開，例如字串或註解沒有結束。pos 是出錯的位置。 */
export class ScanError extends Error {
    constructor(message, pos) {
        super(message);
        this.pos = pos;
    }
}

const NEWLINE = /[\n\r\u2028\u2029]/;
/** JS_SPACE 是 JS 的空白和換行，包含 NBSP 和全形空白。 */
const JS_SPACE = /\s/;
/** TEXT_SPACE 是 HTML 和 CSS 的空白。NBSP、全形空白在這兩種語言裡是內容。 */
const TEXT_SPACE = /[ \t\n\r\f]/;

/**
 * Sink 依位置收集 item。以空白分詞的語言逐字呼叫 extend：字元屬於目前的詞，還沒有詞就從那裡開一個；
 * cut 結束目前的詞。mode 的用途見 codeTokens。
 */
class Sink {
    items = [];
    #open = -1;
    #mode = 'text';

    code(s, e, mode = 'js') {
        this.cut(s);
        this.items.push({ kind: CODE, s, e, mode });
    }

    comment(s, e) {
        this.cut(s);
        this.items.push({ kind: COMMENT, s, e });
    }

    extend(i, mode) {
        if (this.#open < 0) {
            this.#open = i;
            this.#mode = mode;
        }
    }

    cut(i) {
        if (this.#open >= 0 && i > this.#open) this.items.push({ kind: CODE, s: this.#open, e: i, mode: this.#mode });
        this.#open = -1;
    }
}

function matchAt(re, src, i) {
    re.lastIndex = i;
    return re.exec(src)?.[0] ?? '';
}

const IDENT = /[$_\p{ID_Start}\\][$\u200c\u200d\p{ID_Continue}\\]*/uy;
const FLAGS = /[$\u200c\u200d\p{ID_Continue}]*/uy;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?[\d_]+)?)n?/y;
const PUNCT = />>>=|\.\.\.|===|!==|\*\*=|<<=|>>=|>>>|&&=|\|\|=|\?\?=|=>|==|!=|<=|>=|&&|\|\||\?\?|\?\.(?!\d)|\+\+|--|\+=|-=|\*=|%=|&=|\|=|\^=|<<|>>|\*\*|[{}()[\];,<>+\-*%&|^!~?:=.@#]/y;
const TAG_NAME = /[A-Za-z_$][\w$.:-]*/y;
/** GENERIC 是 TSX 泛型箭頭函式的型別參數，例如 <T,>、<T extends U>、<const T,>，這時的 < 不是標籤。 */
const GENERIC = /(?:const\s+)?[A-Za-z_$][\w$]*\s*(?:,|extends\s+[^\s=>/])/y;
/** BEFORE_EXPR 列出後面接運算式的關鍵字：接著出現的 / 是正規表示式，在 TSX 裡 < 是標籤。 */
const BEFORE_EXPR = new Set(['return', 'typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await', 'default']);
/** STATEMENT_PARENS 列出括號關起來之後是陳述句開頭的關鍵字，例如 if (…) /re/.test(s)。 */
const STATEMENT_PARENS = new Set(['if', 'while', 'for', 'with']);

/**
 * scanJs 掃 JS 和 TS，回傳停下來的位置。
 *
 * / 是除號還是正規表示式，看前一個 token：前面是值（識別字、數字、字串、) 或 ]）就是除號，
 * 例外是上面兩組關鍵字。前一個 token 是值、中間沒有換行時，++、-- 是後置運算子，! 是 TS 的
 * 非空斷言，後面的 / 仍是除號。下面這些 token 後面接 / 時分不出是哪一種，丟 ScanError：} 可能
 * 結束區塊，也可能結束物件字面值或函式運算式；>、>>、>>> 可能結束 TS 的型別參數，例如
 * x as Array<T> / 2；sloppy script 可以拿 yield、await 當變數名稱；for (…) 裡的 of 也可能是變數名稱。
 * classic script 把 <!-- 和行首的 --> 當成單行註解，module 不會（ECMAScript 附錄 B 的 HTML-like Comments），
 * 所以程式裡出現 <!-- 或 --> 一律丟 ScanError。
 *
 * opt.closeBrace 時遇到沒有配對的 } 就停下並回傳它的位置；opt.fence 時遇到 --- 就停（Astro）；
 * opt.markup 時，可以放運算式的位置出現 < 加名稱就是標籤（TSX、Astro），opt.ctx 轉給 scanMarkup。
 * 型別位置的泛型函式型別和標籤分不開，例如 type F = <T>(x: T) => T 和 interface 裡的 <T>(x: T): T，
 * 所以 opt.markup 是 'frontmatter' 時遇到標籤一律丟 ScanError；compiler-rs 也把 frontmatter 裡的 JSX
 * 原樣留下，不當成模板。模板運算式裡被當成標籤的，結尾標籤的名稱對不上時由 scanMarkup 丟 ScanError。
 */
function scanJs(src, out, start, end, opt) {
    const parens = [];
    let i = start;
    let depth = 0;
    let exprNext = true;
    let word = null;
    let afterDot = false;
    let newline = false;
    let unsure = false;
    while (i < end) {
        const c = src[i];
        if (JS_SPACE.test(c)) {
            newline ||= NEWLINE.test(c);
            i++;
            continue;
        }
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
            const j = jsComment(src, out, i, end);
            newline ||= NEWLINE.test(src.slice(i, j));
            i = j;
            continue;
        }
        if (opt.fence && src.startsWith('---', i)) return i;
        if (c === '}' && depth === 0 && opt.closeBrace) return i;
        if (src.startsWith('<!--', i) || src.startsWith('-->', i)) throw new ScanError('分不出 <!-- 或 --> 是不是註解', i);
        if (c === '/' && unsure) throw new ScanError('分不出 / 是除號還是正規表示式', i);

        const s = i;
        const prevWord = word;
        const dot = afterDot;
        const nlBefore = newline;
        word = null;
        afterDot = false;
        newline = false;
        unsure = false;
        let m;
        if (c === '"' || c === "'") {
            i = jsString(src, i, end);
            exprNext = false;
        } else if (c === '`') {
            i = jsTemplate(src, out, i, end, opt);
            exprNext = false;
            continue;
        } else if (c === '/' && exprNext) {
            i = jsRegex(src, i, end);
            exprNext = false;
        } else if (c === '/') {
            i += src[i + 1] === '=' ? 2 : 1;
            exprNext = true;
        } else if (c === '<' && opt.markup && exprNext && isTagStart(src, i)) {
            if (opt.markup === 'frontmatter') throw new ScanError('分不出 frontmatter 裡的 < 是標籤還是 TS 的泛型', i);
            i = scanMarkup(src, out, i, end, true, opt.ctx ?? NO_CTX);
            exprNext = false;
            continue;
        } else if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1]))) {
            i += matchAt(NUMBER, src, i).length;
            exprNext = false;
        } else if ((m = matchAt(IDENT, src, i))) {
            i += m.length;
            const inFor = parens.at(-1) === 'for';
            if (dot) exprNext = false;
            // of 只有在 for (…) 裡、接在值後面時是關鍵字。
            else if (m === 'of') exprNext = inFor && !exprNext;
            else exprNext = BEFORE_EXPR.has(m);
            unsure = !dot && (m === 'yield' || m === 'await' || (m === 'of' && inFor));
            // for await (…) 的括號和 for (…) 一樣。
            if (!dot) word = m === 'await' && prevWord === 'for' ? 'for' : m;
        } else if (c === '#' && src[i + 1] === '!' && i === 0 && opt.hashbang) {
            while (i < end && !NEWLINE.test(src[i])) i++;
        } else if (c === '#' && (m = matchAt(IDENT, src, i + 1))) {
            i += 1 + m.length;
            exprNext = false;
        } else {
            const p = matchAt(PUNCT, src, i) || c;
            i += p.length;
            if (p === '(') parens.push(STATEMENT_PARENS.has(prevWord) ? prevWord : null);
            else if (p === '{') depth++;
            else if (p === '}') depth = Math.max(0, depth - 1);
            if (p === ')') exprNext = Boolean(parens.pop());
            else if (p === '++' || p === '--' || p === '!') exprNext ||= nlBefore;
            else exprNext = p !== ']';
            afterDot = p === '.' || p === '?.';
            unsure = p === '}' || p === '>' || p === '>>' || p === '>>>';
        }
        out.code(s, i);
    }
    if (opt.closeBrace) throw new ScanError('{ 沒有對應的 }', start - 1);
    return end;
}

function jsComment(src, out, i, end) {
    let j;
    if (src[i + 1] === '/') {
        j = i + 2;
        while (j < end && !NEWLINE.test(src[j])) j++;
    } else {
        j = src.indexOf('*/', i + 2);
        if (j < 0 || j + 2 > end) throw new ScanError('/* 註解沒有結束', i);
        j += 2;
    }
    out.comment(i, j);
    return j;
}

function jsString(src, i, end) {
    const q = src[i];
    for (let j = i + 1; j < end; j++) {
        const c = src[j];
        if (c === q) return j + 1;
        if (c === '\\') j += src.startsWith('\r\n', j + 1) ? 2 : 1;
        else if (c === '\n' || c === '\r') break;
    }
    throw new ScanError('字串沒有結束', i);
}

function jsRegex(src, i, end) {
    let inClass = false;
    for (let j = i + 1; j < end; j++) {
        const c = src[j];
        if (NEWLINE.test(c)) break;
        if (c === '\\') {
            j++;
            if (j >= end || NEWLINE.test(src[j])) break;
        } else if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) return j + 1 + matchAt(FLAGS, src, j + 1).length;
    }
    throw new ScanError('正規表示式沒有結束', i);
}

/** jsTemplate 掃樣板字串：從 ` 或 } 到下一個 ${ 或 ` 是一個 token，${} 裡面照一般程式掃。 */
function jsTemplate(src, out, i, end, opt) {
    let s = i;
    for (let j = i + 1; j < end; j++) {
        const c = src[j];
        if (c === '\\') j++;
        else if (c === '`') {
            out.code(s, j + 1);
            return j + 1;
        } else if (c === '$' && src[j + 1] === '{') {
            out.code(s, j + 2);
            j = scanJs(src, out, j + 2, end, { markup: opt.markup, closeBrace: true, ctx: opt.ctx });
            s = j;
        }
    }
    throw new ScanError('樣板字串沒有結束', i);
}

function isTagStart(src, i) {
    if (src[i + 1] === '>') return true;
    GENERIC.lastIndex = i + 1;
    return !GENERIC.test(src) && matchAt(TAG_NAME, src, i + 1) !== '';
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const JS_TYPES = /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/i;
/** KEEP_SPACE 是瀏覽器照原樣顯示空白的元素。 */
const KEEP_SPACE = new Set(['pre', 'textarea']);
/** RCDATA 是瀏覽器把內容當成文字的元素，裡面的 <!-- --> 會顯示出來。compiler-rs 照樣處理裡面的 {}。 */
const RCDATA = new Set(['title', 'textarea']);
const NO_CTX = { keep: false, rc: false };

/**
 * scanAstro 掃 .astro 檔。規則對照 @astrojs/compiler-rs 0.5.1 的 parse() 和 transform()（2026-10 實測）：
 * frontmatter 是 TSX，第一個不在字串、註解、樣板、正規表示式裡的 --- 就是結尾，即使它在一行中間；
 * 小寫的 <script>、<style> 內容到第一個 </script>、</style> 為止；標籤的屬性之間可以寫 JS 註解。
 */
function scanAstro(src, out) {
    let i = 0;
    const fence = /^\s*---/.exec(src);
    if (fence) {
        const open = fence[0].length - 3;
        out.code(open, open + 3, 'text');
        const close = scanJs(src, out, open + 3, src.length, { fence: true, markup: 'frontmatter' });
        if (close >= src.length) throw new ScanError('frontmatter 沒有結尾的 ---', open);
        out.code(close, close + 3, 'text');
        i = close + 3;
    }
    scanMarkup(src, out, i, src.length, false, NO_CTX);
}

/**
 * scanMarkup 掃模板，回傳停下來的位置。nested 表示從 JS 運算式裡的 < 進來，掃完這一個元素就回傳；
 * 這時照 JSX 的規則，結尾標籤的名稱要和開頭的相同，對不上就丟 ScanError。
 * ctx 是外層元素的狀態：keep 表示在 <pre> 或 <textarea> 裡，空白不拆詞；rc 表示在 <title> 或
 * <textarea> 裡，<!-- --> 是文字。大寫開頭的標籤是元件，不是這幾種元素。
 */
function scanMarkup(src, out, i, end, nested, ctx) {
    const open = [];
    let keep = ctx.keep ? 1 : 0;
    let rc = ctx.rc ? 1 : 0;
    while (i < end) {
        const c = src[i];
        if (src.startsWith('<!--', i) && !rc) {
            const j = src.indexOf('-->', i + 4);
            if (j < 0 || j + 3 > end) throw new ScanError('<!-- 註解沒有結束', i);
            out.comment(i, j + 3);
            i = j + 3;
        } else if (c === '<' && /[A-Za-z/>!?]/.test(src[i + 1] ?? '')) {
            const tag = scanTag(src, out, i, end);
            if (nested && tag.close && tag.name !== open.at(-1)) throw new ScanError(`</${tag.name}> 和開頭的 <${open.at(-1)}> 對不上`, i);
            i = tag.end;
            if (tag.close) {
                open.pop();
                if (KEEP_SPACE.has(tag.name) && keep > 0) keep--;
                if (RCDATA.has(tag.name) && rc > 0) rc--;
            } else if (!tag.self && !VOID_TAGS.has(tag.name)) {
                open.push(tag.name);
                if (KEEP_SPACE.has(tag.name)) keep++;
                if (RCDATA.has(tag.name)) rc++;
                if (tag.raw) i = rawContent(src, out, i, end, tag, keep > 0);
            }
            if (nested && open.length === 0) {
                out.cut(i);
                return i;
            }
        } else if (c === '{') {
            i = astroExpression(src, out, i, end, { keep: keep > 0, rc: rc > 0 });
        } else {
            if (TEXT_SPACE.test(c) && !keep) out.cut(i);
            else out.extend(i, 'html');
            i++;
        }
    }
    if (nested) throw new ScanError('運算式裡的標籤沒有結束', end);
    out.cut(end);
    return end;
}

/** scanTag 掃一個標籤，回傳名稱、屬性和結束位置。屬性值的引號、樣板字串和 {} 裡不拆。 */
function scanTag(src, out, i, end) {
    const close = src[i + 1] === '/';
    let j = i + (close ? 2 : 1);
    const name = matchAt(/[^\s/>{]*/y, src, j);
    j += name.length;
    out.extend(i, 'html');
    const tag = { name, close, self: /^[!?]/.test(name), attrs: {} };
    while (tag.end === undefined) {
        if (j >= end) throw new ScanError(`<${name} 標籤沒有結束`, i);
        const c = src[j];
        if (TEXT_SPACE.test(c)) {
            out.cut(j);
            j++;
        } else if (c === '>' || (c === '/' && src[j + 1] === '>')) {
            out.extend(j, 'html');
            tag.self ||= c === '/';
            tag.end = j + (c === '/' ? 2 : 1);
        } else if (c === '/' && (src[j + 1] === '/' || src[j + 1] === '*')) {
            j = jsComment(src, out, j, end);
        } else if (c === '{') {
            j = astroExpression(src, out, j, end, NO_CTX);
        } else {
            out.extend(j, 'html');
            const attr = matchAt(/[^\s=>/{]+/y, src, j) || c;
            j += attr.length;
            tag.attrs[attr] = '';
            // 等號兩側可以有空白，compiler-rs 照樣當成同一個屬性；這些空白留在屬性的 token 裡。
            const eq = matchAt(/[ \t\n\r\f]*=[ \t\n\r\f]*/y, src, j);
            if (!eq) continue;
            j += eq.length;
            const q = src[j];
            if (q === '"' || q === "'") {
                const k = src.indexOf(q, j + 1);
                if (k < 0 || k >= end) throw new ScanError('屬性值的引號沒有結束', j);
                tag.attrs[attr] = src.slice(j + 1, k);
                j = k + 1;
            } else if (q === '`') {
                j = jsTemplate(src, out, j, end, { markup: true });
            } else if (q === '{') {
                j = astroExpression(src, out, j, end, NO_CTX);
            } else {
                tag.attrs[attr] = matchAt(/[^\s>]*/y, src, j);
                j += tag.attrs[attr].length;
            }
        }
    }
    tag.raw = !close && !tag.self && (name === 'script' || name === 'style' || 'is:raw' in tag.attrs);
    return tag;
}

/**
 * rawContent 掃 <script>、<style> 和 is:raw 元素的內容，回傳結尾標籤的位置。
 * type 不是 JS 的 <script>（例如 application/ld+json）和 is:raw 的內容當成文字，不找註解。
 */
function rawContent(src, out, i, end, tag, keep) {
    const re = new RegExp(`</${tag.name.replace(/[^\w-]/g, '\\$&')}(?=[\\s/>])`, 'g');
    re.lastIndex = i;
    const close = re.exec(src)?.index ?? -1;
    if (close < 0 || close >= end) throw new ScanError(`<${tag.name}> 沒有結束`, i);
    out.cut(i);
    const raw = 'is:raw' in tag.attrs;
    if (tag.name === 'style' && !raw) scanCss(src, out, i, close);
    else if (tag.name === 'script' && !raw && (!tag.attrs.type || JS_TYPES.test(tag.attrs.type))) scanJs(src, out, i, close, {});
    else scanWords(src, out, i, close, raw ? 'html' : 'text', keep);
    return close;
}

/**
 * astroExpression 掃 {} 運算式，回傳 } 之後的位置。大括號裡只有註解時連同大括號整個算註解，
 * 所以把 HTML 註解換成 JSX 註解不算改了程式。
 */
function astroExpression(src, out, i, end, ctx) {
    out.cut(i);
    const first = out.items.length;
    out.code(i, i + 1);
    const close = scanJs(src, out, i + 1, end, { markup: true, closeBrace: true, ctx });
    const inner = out.items.slice(first + 1);
    if (inner.length > 0 && inner.every((it) => it.kind === COMMENT)) {
        out.items[first].kind = COMMENT;
        out.comment(close, close + 1);
    } else {
        out.code(close, close + 1);
    }
    return close + 1;
}

/** scanWords 以空白分詞，引號裡不拆；keep 時空白也不拆。 */
function scanWords(src, out, i, end, mode, keep) {
    let quote = '';
    for (; i < end; i++) {
        const c = src[i];
        if (!quote && !keep && TEXT_SPACE.test(c)) {
            out.cut(i);
            continue;
        }
        out.extend(i, mode);
        if (quote) {
            if (c === quote) quote = '';
            else if (c === '\\' && quote === '"') i++;
        } else if (c === '"' || c === "'") quote = c;
    }
    out.cut(end);
}

function scanCss(src, out, i, end) {
    while (i < end) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '*') {
            const j = src.indexOf('*/', i + 2);
            if (j < 0 || j + 2 > end) throw new ScanError('/* 註解沒有結束', i);
            out.comment(i, j + 2);
            i = j + 2;
            continue;
        }
        if (TEXT_SPACE.test(c)) {
            out.cut(i);
            i++;
            continue;
        }
        out.extend(i, 'text');
        if (c === '"' || c === "'") i = cssString(src, i, end);
        else if (c === '\\') i += 2;
        else if (src.slice(i, i + 4).toLowerCase() === 'url(' && !/[\w-]/.test(src[i - 1] ?? '')) i = cssUrl(src, i + 4, end);
        else i++;
    }
    out.cut(end);
}

/** cssString 回傳字串結束的位置。沒有跳脫的換行就結束字串，換行本身不屬於字串（CSS Syntax Level 3 §4.3.5）。 */
function cssString(src, i, end) {
    const q = src[i];
    for (let j = i + 1; j < end; j++) {
        if (src[j] === q) return j + 1;
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') return j;
    }
    return end;
}

/** cssUrl 回傳 url( 結束的位置。沒有引號的 url(…) 整段是一個 token，裡面的 /* 不是註解（§4.3.6）。 */
function cssUrl(src, i, end) {
    let j = i;
    while (j < end && TEXT_SPACE.test(src[j])) j++;
    if (src[j] === '"' || src[j] === "'") return i;
    const close = src.indexOf(')', j);
    return close < 0 || close >= end ? end : close + 1;
}

/** SHELL_LEAD 列出後面接著一個指令的保留字。 */
const SHELL_LEAD = new Set(['!', '{', 'do', 'elif', 'else', 'if', 'then', 'time', 'until', 'while']);

/**
 * scanShell 掃 shell 指令。# 只在一個詞的開頭才是註解：行首、空白之後，或 ; & | 和括號之後。
 * 引號、${ }、$(( )) 裡的 # 不是註解；$( ) 裡是另一段指令，照同樣的規則判斷。反引號裡的 # 一律當程式，
 * bash 會把那裡詞首的 # 當註解，這裡寧可多報。
 *
 * [[ ]] 裡 =~ 右邊的正規表示式和 @( ) 這類 extglob pattern，bash 讀成一個詞（parse.y 的 read_token_word），
 * 括號裡可以有空白，( 和 | 之後的 # 不是註解。沒開 extglob 時 !( 是 ! 加上子 shell，這裡一樣當成一個詞，
 * 只會多報。$( ) 裡出現 case 時丟 ScanError，因為分支的 pat) 會被當成 $( 的結尾。
 * here-document 的內容整段算程式，clean 把一行整理成和結尾字串比對的樣子。
 */
function scanShell(src, out, start, end, mode, clean) {
    const stack = [{ kind: 'cmd' }];
    const heredocs = [];
    let i = start;
    let wordStart = true;
    while (i < end) {
        const c = src[i];
        const ctx = stack.at(-1);
        const top = ctx.kind;
        const inCmd = top === 'cmd' || top === 'sub';
        if (inCmd && (c === ' ' || c === '\t' || c === '\n')) {
            // 剛結束的詞是 =~ 時，下一個詞是正規表示式。
            if (!wordStart) ctx.regexNext = src.startsWith('=~', i - 2) && (i - 3 < start || /[ \t\n]/.test(src[i - 3]));
            ctx.regex = false;
            out.cut(i);
            i++;
            wordStart = true;
            if (c === '\n' && heredocs.length) i = heredocBodies(src, out, i, end, heredocs, mode, clean);
            continue;
        }
        if (inCmd && c === '#' && wordStart) {
            let j = src.indexOf('\n', i);
            if (j < 0 || j > end) j = end;
            out.comment(i, j);
            i = j;
            continue;
        }
        if (inCmd && wordStart) {
            if (top === 'sub' && /^case[ \t\n]/.test(src.slice(i, i + 5)) && atCommand(src, start, i)) {
                throw new ScanError('$( ) 裡有 case，分支的 ) 會被當成 $( 的結尾', i);
            }
            ctx.regex = ctx.regexNext;
            ctx.regexNext = false;
        }
        out.extend(i, mode);
        wordStart = false;
        if (c === "'" && (inCmd || top === 'param' || top === 'group')) {
            const j = src.indexOf("'", i + 1);
            if (j < 0 || j >= end) throw new ScanError("' 沒有結束", i);
            i = j + 1;
        } else if (c === '\\') {
            i += 2;
        } else if (top === 'arith') {
            if (c === '(') ctx.depth++;
            else if (c === ')' && --ctx.depth === 0) stack.pop();
            i++;
        } else if (c === '"' || c === '`') {
            const kind = c === '"' ? 'dq' : 'bq';
            if (top === kind) stack.pop();
            else stack.push({ kind });
            i++;
        } else if (c === '$' && src[i + 1] === "'" && (inCmd || top === 'group')) {
            i = ansiQuote(src, i + 1, end);
        } else if (c === '$' && src.startsWith('((', i + 1)) {
            stack.push({ kind: 'arith', depth: 2 });
            i += 3;
        } else if (c === '$' && src[i + 1] === '(') {
            stack.push({ kind: 'sub', depth: 0 });
            i += 2;
            wordStart = true;
        } else if (c === '$' && src[i + 1] === '{') {
            stack.push({ kind: 'param' });
            i += 2;
        } else if (top === 'param' && c === '}') {
            stack.pop();
            i++;
        } else if (inCmd && !ctx.regex && src.startsWith('((', i) && /[\s;&|(]/.test(src[i - 1] ?? ' ')) {
            stack.push({ kind: 'arith', depth: 2 });
            i += 2;
        } else if (inCmd && src.startsWith('<<<', i)) {
            // here-string，不是 here-document。
            i += 3;
        } else if (inCmd && src.startsWith('<<', i)) {
            const doc = heredocStart(src, i + 2);
            if (doc) heredocs.push(doc);
            i += 2;
        } else if (c === '(' && (top === 'group' || (inCmd && (ctx.regex || /[?*+@!]/.test(src[i - 1] ?? ''))))) {
            if (top === 'group') ctx.depth++;
            else stack.push({ kind: 'group', depth: 1 });
            i++;
        } else if (top === 'group' && c === ')') {
            if (--ctx.depth === 0) stack.pop();
            i++;
        } else if (top === 'sub' && c === ')' && ctx.depth === 0) {
            stack.pop();
            i++;
        } else {
            if (top === 'sub' && c === '(') ctx.depth++;
            else if (top === 'sub' && c === ')') ctx.depth--;
            // 正規表示式裡的 | 不分開詞。
            if (inCmd && ';&|()'.includes(c) && !(ctx.regex && c === '|')) {
                wordStart = true;
                ctx.regex = false;
            }
            i++;
        }
    }
    if (stack.length > 1) throw new ScanError('引號、括號、$( 或 ${ 沒有結束', end);
    if (heredocs.length) throw new ScanError(`here-document 沒有找到結尾的 ${heredocs[0].delim}`, end);
    out.cut(end);
}

/** atCommand 判斷 i 是不是一個指令的開頭：前面是 ( ; & | 或換行，或是 SHELL_LEAD 的保留字。 */
function atCommand(src, start, i) {
    let j = i;
    while (j > start && (src[j - 1] === ' ' || src[j - 1] === '\t')) j--;
    if (j === start || '(;&|\n'.includes(src[j - 1])) return true;
    return SHELL_LEAD.has(/[^\s;&|()]+$/.exec(src.slice(start, j))?.[0]);
}

function ansiQuote(src, i, end) {
    for (let j = i + 1; j < end; j++) {
        if (src[j] === '\\') j++;
        else if (src[j] === "'") return j + 1;
    }
    throw new ScanError("$' 沒有結束", i);
}

function heredocStart(src, j) {
    const strip = src[j] === '-';
    if (strip) j++;
    while (src[j] === ' ' || src[j] === '\t') j++;
    const word = matchAt(/(?:[^\s;&|()<>'"\\]|\\.|'[^'\n]*'|"(?:[^"\\\n]|\\.)*")+/y, src, j);
    return word ? { delim: unquote(word), strip } : null;
}

const unquote = (word) => word.replace(/\\(.)|["']/g, '$1');

/**
 * heredocBodies 讀完 docs 裡每個 here-document，回傳之後的位置。內容連同結尾那一行算一個 token，
 * 逐字比對。clean 把一行整理成和結尾字串比對的樣子，<<- 再去掉行首的 tab。
 */
function heredocBodies(src, out, i, end, docs, mode, clean) {
    for (const doc of docs.splice(0)) {
        const s = i;
        for (;;) {
            if (i >= end) throw new ScanError(`here-document 沒有找到結尾的 ${doc.delim}`, s);
            let e = src.indexOf('\n', i);
            if (e < 0 || e > end) e = end;
            let line = clean(src.slice(i, e));
            if (doc.strip) line = line.replace(/^\t+/, '');
            i = e + 1;
            if (line === doc.delim) {
                out.code(s, e, mode);
                break;
            }
        }
    }
    return Math.min(i, end);
}

/** scanShellFile 掃 .sh 檔。第一行的 #! 決定用哪個直譯器執行，算程式。 */
function scanShellFile(src, out) {
    let start = 0;
    if (src.startsWith('#!')) {
        start = src.includes('\n') ? src.indexOf('\n') : src.length;
        out.code(0, start, 'text');
    }
    scanShell(src, out, start, src.length, 'text', (line) => line);
}

const BLOCK_HEADER = /^[|>](?:([1-9])([-+])?|([-+])([1-9])?)?$/;
const MARKER = /^(?:---|\.\.\.)(?:[ \t\r]|$)/;
const ACTIONS_KEY = /(?:^|[\s{,[])["']?(?:shell|runs-on)["']?\s*:/;
/** ACTIONS_BASH 列出交給 bash 或 sh 執行的寫法。Windows runner 的預設 shell 是 pwsh，註解規則和 bash 不同。 */
const ACTIONS_BASH = /^(?:- )?(["']?)(?:shell\1: (["']?)(?:bash|sh)\2|runs-on\1: (["']?)(?:ubuntu|macos)-[\w.-]+\3)$/;
const isProperty = (word) => /^[&!]/.test(word);

/**
 * scanYaml 掃 YAML。交給 bash 的 run: | 照 shell 掃，要不要這樣掃得先讀過整個檔案，所以掃兩次。
 * 下面兩種會算錯，只影響行數，因為 --code-unchanged 不比 YAML：run: | 裡一行以前面沒有空白的反斜線結尾時，
 * bash 把下一行接進同一個詞，這裡卻把它開頭的 # 當註解；env、with 底下的 run: | 也照 shell 掃。
 */
function scanYaml(src, out) {
    const lines = [];
    yamlPass(src, new Sink(), false, lines);
    yamlPass(src, out, runsInBash(lines));
}

/**
 * runsInBash 判斷 run: | 是不是交給 bash 或 sh：要有 runs-on 或 shell，而且都對上 ACTIONS_BASH。
 * @param {string[]} lines 每一行去掉註解後以空白連接的 token @returns {boolean}
 */
function runsInBash(lines) {
    const keyed = lines.filter((line) => ACTIONS_KEY.test(line));
    return keyed.length > 0 && keyed.every((line) => ACTIONS_BASH.test(line));
}

/** yamlPass 逐行掃一遍。bash 為真時 run: | 照 shell 掃；有給 lines 時收集每一行的 token。 */
function yamlPass(src, out, bash, lines) {
    const st = { quote: null, flow: 0, json: false, pending: null, plain: null, blank: 0, afterRun: false, bash, lines };
    let i = 0;
    while (i < src.length) {
        let e = src.indexOf('\n', i);
        if (e < 0) e = src.length;
        const block = yamlLine(src, out, i, e, st);
        i = e + 1;
        if (block) i = yamlBlock(src, out, i, block);
        st.afterRun = block?.run ?? st.afterRun;
    }
    if (st.quote) throw new ScanError(`${st.quote} 沒有結束`, src.length);
    if (st.flow) throw new ScanError('flow 集合的 [ 或 { 沒有結束', src.length);
    out.cut(src.length);
}

/**
 * yamlLine 掃一行，這一行以 block scalar 的標頭結尾時回傳標頭的資訊。# 前面是空白或行首、又不在引號裡
 * 才是註解（YAML 1.2.2 §6.6）。引號只有出現在 node 開頭才算引號，所以 if: a == 'b' 和多行 plain scalar
 * 續行開頭的 ' 都是普通字元。st 記錄跨行的狀態：沒有結束的引號、flow 集合的層數、剛結束的引號或 flow
 * 集合、上一行結尾還沒有 value 的 node，以及上一行是不是以 plain scalar 結尾。plain scalar 可以跨行，
 * 縮排比父層深的下一行是續行，flow 裡不看縮排。續行前的空行會變成值裡的換行，中間夾著註解就不是合法的
 * YAML，這兩件事記在續行第一個 token 的 extra。
 */
function yamlLine(src, out, s, e, st) {
    const first = out.items.length;
    const lead = /^[ \t\r]*/.exec(src.slice(s, e))[0].length;
    const c0 = src[s + lead];
    if (!st.quote && (s + lead === e || c0 === '#')) {
        if (s + lead === e) st.blank++;
        else {
            out.comment(s + lead, e);
            if (st.plain) st.plain.comment = true;
        }
        return null;
    }
    const cont = !st.quote && st.plain !== null && !(lead === 0 && MARKER.test(src.slice(s, e)))
        && (st.flow > 0 ? !',]}:'.includes(c0) : lead > st.plain.col);
    const plainLine = cont && st.flow === 0;
    const startedInside = st.quote !== null || st.flow > 0;
    let i = s;
    let quoteOk = !cont;
    let wordAt = -1;
    let wordOk = true;
    let tail = 'plain';
    let comment = false;
    const endWord = (to) => {
        if (plainLine) return;
        const w = src.slice(wordAt, to);
        if (w === '-' || w === '?' || w.endsWith(':') || (wordAt === s && MARKER.test(w))) tail = 'indicator';
        else if (wordOk && isProperty(w)) tail = 'property';
        quoteOk = tail === 'indicator' || tail === 'property' || (st.flow > 0 && /[,[{]$/.test(w));
    };
    if (st.quote) {
        out.extend(i, 'yaml');
        i = yamlQuoted(src, i, e, st);
        quoteOk = false;
        if (!st.quote) {
            st.json = true;
            tail = 'quoted';
        }
    }
    while (i < e) {
        const c = src[i];
        if (c === ' ' || c === '\t' || c === '\r') {
            if (wordAt >= 0 && i > wordAt) endWord(i);
            wordAt = -1;
            out.cut(i);
            i++;
            continue;
        }
        if (c === '#' && (i === s || /[ \t]/.test(src[i - 1]))) {
            out.comment(i, e);
            comment = true;
            break;
        }
        if (wordAt < 0) {
            wordAt = i;
            wordOk = quoteOk;
        }
        out.extend(i, 'yaml');
        if ((c === '"' || c === "'") && quoteOk) {
            st.quote = c;
            i = yamlQuoted(src, i + 1, e, st);
            quoteOk = false;
            if (!st.quote) {
                st.json = true;
                tail = 'quoted';
            }
            continue;
        }
        // !<…> 是 verbatim tag，裡面的逗號和括號不是 flow 的符號。
        if (c === '!' && src[i + 1] === '<' && quoteOk) {
            const k = src.indexOf('>', i);
            i = k < 0 || k >= e ? e : k + 1;
            continue;
        }
        const json = st.json;
        st.json = false;
        tail = 'plain';
        if ((c === '[' || c === '{') && (quoteOk || st.flow > 0)) {
            st.flow++;
            tail = 'flow';
        } else if ((c === ']' || c === '}') && st.flow > 0) {
            st.flow--;
            st.json = true;
            tail = 'flow';
        } else if (c === ',' && st.flow > 0) {
            tail = 'flow';
        } else if (c === ':' && json && st.flow > 0) {
            // JSON 風格的 key（引號或 flow 集合）後面可以緊接 : 和 value（YAML 1.2.2 §7.4.2）。
            tail = 'indicator';
        }
        quoteOk = st.flow > 0 && (/[,[{]/.test(c) || tail === 'indicator');
        // flow 裡新的 node 從下一個字元重新算一個詞，才認得出緊接著的 &anchor。
        if (quoteOk) {
            wordAt = i + 1;
            wordOk = true;
        }
        i++;
    }
    if (wordAt >= 0 && i > wordAt) endWord(Math.min(i, e));
    if (!st.quote) out.cut(e);
    const words = out.items.slice(first).filter((it) => it.kind === CODE).map((it) => ({ it, text: src.slice(it.s, it.e) }));
    st.lines?.push(words.map((w) => w.text).join(' '));
    // run: | 的 token 和後面的 YAML token 看起來一樣，標出 run: | 在哪裡結束。
    if (st.afterRun && words.length) {
        words[0].it.extra = '（接在 run: | 後面）';
        st.afterRun = false;
    }
    if (cont) {
        const notes = [st.blank && `前面 ${st.blank} 個空行`, st.plain.comment && '前面隔著註解'].filter(Boolean);
        if (notes.length) words[0].it.extra = `（${notes.join('，')}）`;
    }
    st.blank = 0;
    if (startedInside || st.quote || st.flow > 0) {
        st.pending = null;
        st.plain = !st.quote && st.flow > 0 && tail === 'plain' ? { col: -1, comment } : null;
        return null;
    }
    if (cont) {
        st.plain.comment = comment;
        return null;
    }
    const node = yamlNode(src, s, words, st.pending);
    const value = words.slice(node.value);
    const header = value.length === 1 && BLOCK_HEADER.exec(value[0].text);
    st.pending = value.length === 0 ? node : null;
    st.plain = value.length > 0 && !header && tail === 'plain' ? { col: node.col, comment } : null;
    if (!header) return null;
    return {
        header: value[0].it,
        keyCol: node.col,
        digit: Number(header[1] ?? header[4] ?? 0),
        chomp: header[2] ?? header[3] ?? '',
        // 有 &anchor 的 run: 可能在別處用 *alias 當成一般字串，內容就整段逐字比對。
        run: st.bash && value[0].text[0] === '|' && !node.anchored && node.name === 'run',
    };
}

/**
 * yamlNode 分析一行 block 的 token，回傳 value 從第幾個 token 開始，以及 value 的父層從哪一欄開始。
 * 行首的 -、? 和 --- 是指示符號，之後可以有一個 key：key 可以有好幾個詞、帶 &anchor 或 !tag，冒號前
 * 也可以有空白，父層從 key 的第一個詞算起。name 是 key 去掉前面的 &anchor、!tag 和結尾的冒號、外層引號。
 * anchored 表示 value 帶 &anchor，&anchor 可以寫在上一行的冒號後面；key 前面的 &anchor 屬於 key，不算。
 * 沒有 key 時父層是最後一個指示符號，連指示符號都沒有時沿用 pending，也就是上一行結尾還沒有 value 的 node。
 */
function yamlNode(src, s, words, pending) {
    let node = pending ?? { col: -1, name: '', anchored: false };
    let j = 0;
    for (; j < words.length; j++) {
        const w = words[j].text;
        if (j === 0 && words[0].it.s === s && MARKER.test(w)) node = { col: -1, name: '', anchored: false };
        else if (w === '-' || w === '?') node = { col: words[j].it.s - s, name: '', anchored: false };
        else break;
    }
    let k = j;
    while (k < words.length && !words[k].text.endsWith(':')) k++;
    let v = j;
    if (k < words.length) {
        let n = j;
        while (n < k && isProperty(words[n].text)) n++;
        const name = src.slice(words[n].it.s, words[k].it.e).replace(/\s*:$/, '').replace(/^(["'])(.*)\1$/, '$2');
        node = { col: words[j].it.s - s, name, anchored: false };
        v = k + 1;
    }
    let { anchored } = node;
    for (; v < words.length && isProperty(words[v].text); v++) anchored ||= words[v].text[0] === '&';
    return { ...node, anchored, value: v };
}

function yamlQuoted(src, i, e, st) {
    while (i < e) {
        const c = src[i];
        if (st.quote === '"' && c === '\\') i += 2;
        else if (c === st.quote && st.quote === "'" && src[i + 1] === "'") i += 2;
        else if (c === st.quote) {
            st.quote = null;
            return i + 1;
        } else i++;
    }
    return e;
}

/**
 * exprComments 把和 ${{ }} 重疊的 shell 註解改成程式。GitHub Actions 在交給 shell 之前先代換運算式，
 * 註解裡的也一樣；代換結果有換行時，後面的文字就離開了註解。找結尾的方法照 actions/runner 的
 * TemplateReader.ParseScalar：' 括起來的 }} 不算，沒有結尾就延伸到最後。
 */
function exprComments(src, items, s, e) {
    const spans = [];
    for (let i = src.indexOf('${{', s); i >= 0 && i < e; i = src.indexOf('${{', i)) {
        let j = i + 3;
        let quoted = false;
        for (; j < e; j++) {
            if (src[j] === "'") quoted = !quoted;
            else if (!quoted && src[j] === '}' && src[j - 1] === '}') break;
        }
        spans.push([i, j + 1]);
        i = j + 1;
    }
    for (const it of items) {
        if (it.kind === COMMENT && spans.some(([a, b]) => it.s < b && a < it.e)) Object.assign(it, { kind: CODE, mode: 'yaml' });
    }
}

/**
 * yamlBlock 掃 block scalar 的內容，回傳下一行的位置。內容是比標頭的 key 縮排更深的行，
 * 只有空白、而且不超過縮排的行是空行。縮排、開頭的空行數、+ 保留的結尾空行數、最後一行有沒有換行
 * 都會改變值，又不在內容的 token 裡，所以記在標頭的 extra 一起比。run: | 的值是 shell 腳本，
 * 這幾項裡只有縮排會影響它：續行和多行字串會把縮排以外的空白帶進指令。
 */
function yamlBlock(src, out, i, block) {
    let indent = block.digit ? block.keyCol + block.digit : -1;
    let first = -1;
    let last = -1;
    let leading = 0;
    let trailing = 0;
    while (i < src.length) {
        let e = src.indexOf('\n', i);
        if (e < 0) e = src.length;
        const line = src.slice(i, e).replace(/\r$/, '');
        const n = /^ */.exec(line)[0].length;
        if (n === line.length && (indent < 0 || n <= indent)) {
            if (e < src.length) {
                if (first < 0) leading++;
                else trailing++;
            }
            i = e + 1;
            continue;
        }
        if (indent < 0) {
            if (n <= block.keyCol) break;
            indent = n;
        } else if (n < indent) break;
        if (first < 0) first = i;
        last = e;
        trailing = 0;
        i = e + 1;
    }
    const notes = [];
    if (first < 0) {
        if (block.chomp === '+' && leading) notes.push(`結尾 ${leading} 個空行`);
    } else if (block.run) {
        notes.push(`縮排 ${indent}`);
        const strip = new RegExp(`^ {0,${indent}}`);
        const from = out.items.length;
        scanShell(src, out, first, last, 'yaml', (line) => line.replace(/\r$/, '').replace(strip, ''));
        exprComments(src, out.items.slice(from), first, last);
    } else {
        notes.push(`縮排 ${indent}`);
        out.code(first + indent, last, 'yaml');
        if (leading) notes.push(`開頭 ${leading} 個空行`);
        if (block.chomp === '+' && trailing) notes.push(`結尾 ${trailing} 個空行`);
        if (block.chomp !== '-' && last === src.length) notes.push('最後一行沒有換行');
    }
    if (notes.length) block.header.extra = `（${notes.join('，')}）`;
    return Math.min(i, src.length);
}

const DIRECTIVE = /^#\s*(syntax|escape|check)\s*=\s*(\S?)/i;
const CONTINUATION = { '\\': /(^|[^\\])\\[ \t]*$/, '`': /(^|[^`])`[ \t]*$/ };

/**
 * scanDockerfile 掃 Dockerfile。只有整行的 # 是註解，續行中間的也算；檔頭的 # syntax= 這類
 * parser directive 不是註解。其他行整行算一個 token：BuildKit 保留續行的前導空白，舊式的
 * ENV key value 和 WORKDIR 這類指令也把參數原樣當成值，以空白分詞會漏掉這些地方的改動。
 * RUN、COPY、ADD 的 here-document 從續行接好的整行找，內容從下一行開始。
 * 規則對照 BuildKit frontend/dockerfile/parser 的 parser.go、directives.go（2026-10 的 master）。
 */
function scanDockerfile(src, out) {
    let escape = '\\';
    let directives = true;
    let cmd = null;
    let i = 0;
    while (i < src.length) {
        let e = src.indexOf('\n', i);
        if (e < 0) e = src.length;
        const line = src.slice(i, e).replace(/\r+$/, '');
        const t = line.trimStart();
        const directive = directives && cmd === null ? DIRECTIVE.exec(t) : null;
        directives = directive !== null;
        if (directive?.[1].toLowerCase() === 'escape' && directive[2] === '`') escape = '`';
        if (directive) {
            out.code(i, e, 'text');
        } else if (t.startsWith('#')) {
            out.comment(i + line.length - t.length, e);
        } else if (t) {
            out.code(i, e, 'text');
            const part = cmd === null ? t : line;
            const cont = CONTINUATION[escape].exec(part);
            cmd = (cmd ?? '') + (cont ? part.slice(0, cont.index + cont[1].length) : part);
            if (!cont) {
                const docs = dockerHeredocs(cmd);
                cmd = null;
                if (docs.length) {
                    i = heredocBodies(src, out, e + 1, src.length, docs, 'text', (l) => l.replace(/\r+$/, ''));
                    continue;
                }
            }
        }
        i = e + 1;
    }
    out.cut(src.length);
}

/**
 * dockerHeredocs 照 BuildKit 的 heredocsFromLine 找出一條指令裡的 here-document：用 shell 的規則
 * 切詞，<< 後面的空白併進同一個詞，開頭是 <<（前面可以有數字）的詞才算。引號沒有結束時一個也不算。
 */
function dockerHeredocs(line) {
    if (!/^(?:onbuild\s+)?(?:run|copy|add)(?:\s|$)/i.test(line)) return [];
    const words = [];
    let w = '';
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" || c === '"') {
            let j = i + 1;
            while (j < line.length && line[j] !== c) j += c === '"' && line[j] === '\\' ? 2 : 1;
            if (j >= line.length) return [];
            w += line.slice(i, j + 1);
            i = j;
        } else if (c === '\\') {
            w += line.slice(i, i + 2);
            i++;
        } else if (line.startsWith('<<', i)) {
            const op = matchAt(/<<[ \t\r]*/y, line, i);
            w += op;
            i += op.length - 1;
        } else if (/\s/.test(c)) {
            if (w) words.push(w);
            w = '';
        } else w += c;
    }
    if (w) words.push(w);
    return words.flatMap((word) => {
        const m = /^\d*<<(-?)\s*([^<]+)$/.exec(word);
        return m ? [{ strip: m[1] === '-', delim: unquote(m[2]) }] : [];
    });
}

/** scanLines 掃只有整行註解的設定檔：isComment 為真的行是註解，其他非空白的行整行算一個 token。 */
function scanLines(src, out, isComment) {
    let i = 0;
    while (i < src.length) {
        let e = src.indexOf('\n', i);
        if (e < 0) e = src.length;
        const line = src.slice(i, e);
        if (isComment(line)) out.comment(i + line.length - line.trimStart().length, e);
        else if (line.trim()) out.code(i, e, 'text');
        i = e + 1;
    }
}

const SCANNERS = {
    js: (src, out) => scanJs(src, out, 0, src.length, { hashbang: true }),
    astro: scanAstro,
    css: (src, out) => scanCss(src, out, 0, src.length),
    shell: scanShellFile,
    yaml: scanYaml,
    dockerfile: scanDockerfile,
    // npm 的 ini 解析器跳過 ^\s*[;#] 的行（npm 11.19.0 內附的 ini 6.0.0），值後面的 ; 和 # 也是註解，這裡當程式。
    ini: (src, out) => scanLines(src, out, (line) => /^\s*[;#]/.test(line)),
    // gitignore 只有第一個字元是 # 的行才是註解，前面有空白就是 pattern。
    ignore: (src, out) => scanLines(src, out, (line) => line.startsWith('#')),
    // RFC 9309：# 之前可以有空白；指令後面的 # 註解這裡當程式。
    robots: (src, out) => scanLines(src, out, (line) => /^[ \t]*#/.test(line)),
};

/**
 * languageOf 依檔名決定用哪一種掃描器，不檢查的檔案回傳 null。
 * @param {string} file 以 / 分隔的路徑
 * @returns {'js'|'astro'|'css'|'shell'|'yaml'|'dockerfile'|'ini'|'ignore'|'robots'|null}
 */
export function languageOf(file) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    if (/\.(?:js|mjs|cjs|ts)$/.test(base)) return 'js';
    if (base.endsWith('.astro')) return 'astro';
    if (base.endsWith('.css')) return 'css';
    if (base.endsWith('.sh')) return 'shell';
    if (/\.ya?ml$/.test(base)) return 'yaml';
    if (/^(?:Containerfile|Dockerfile)(?:\.|$)|\.(?:containerfile|dockerfile)$/i.test(base)) return 'dockerfile';
    if (base === '.npmrc') return 'ini';
    if (base === '.gitignore' || base === '.dockerignore') return 'ignore';
    if (base === 'robots.txt') return 'robots';
    return null;
}

/**
 * scan 把原始碼切成程式與註解的 item，依位置排序、互不重疊。
 * 有任何非空白字元沒有落在 item 裡就丟 ScanError：那個位置的改動會比對不到。
 * @param {string} src
 * @param {string} lang languageOf 的回傳值
 * @returns {{kind: string, s: number, e: number, mode?: string, extra?: string}[]}
 */
export function scan(src, lang) {
    if (!SCANNERS[lang]) throw new Error(`不支援的語言：${lang}`);
    const out = new Sink();
    SCANNERS[lang](src, out);
    out.cut(src.length);
    let pos = 0;
    for (const it of [...out.items, { s: src.length, e: src.length }]) {
        if (it.s < pos || !/^\s*$/.test(src.slice(pos, it.s))) throw new ScanError('掃描器漏掉了字元', pos);
        pos = it.e;
    }
    return out.items;
}

/**
 * countLines 計算註解行與程式行。有程式的行算程式行，即使後面接著註解；
 * 只有註解的行算註解行，block 註解跨過的每一行都算；空白行兩邊都不算。
 * @param {string} src
 * @param {{kind: string, s: number, e: number}[]} items scan 的回傳值
 * @returns {{comment: number, code: number}}
 */
export function countLines(src, items) {
    const marks = [];
    let line = 0;
    let pos = 0;
    for (const it of items) {
        for (; pos < it.s; pos++) if (src[pos] === '\n') line++;
        const mark = it.kind === CODE ? 2 : 1;
        for (; pos < it.e; pos++) {
            if (src[pos] === '\n') line++;
            else if ((marks[line] ?? 0) < mark && !JS_SPACE.test(src[pos])) marks[line] = mark;
        }
    }
    let comment = 0;
    let code = 0;
    for (const m of marks) {
        if (m === 1) comment++;
        else if (m === 2) code++;
    }
    return { comment, code };
}

const VERBATIM = new Set(['yaml', 'html']);

/**
 * codeTokens 把程式 item 轉成比對用的 token，gap 記錄 token 前面隔著什麼：'\n' 換行，' ' 空白，
 * '' 直接相連或只隔著註解。註解不等於空白，CSS 的 .a 和 .b 中間只夾一個註解時是 .a.b，不是 .a .b。
 * 兩個 JS token 之間只分有沒有換行，因為換行會影響自動補分號，其他空白和註解不影響意思。
 * YAML 和 Astro 模板的 gap 是去掉註解後剩下的空白：同一行照原樣比，換行之後比最後一行的縮排，
 * 所以刪掉獨佔一行的註解不算改了程式。沒有引號的 YAML scalar 裡的空白屬於值；模板文字的空白會留在
 * HTML 裡，CSS 的 white-space 能讓它顯示出來。空行數不在 gap 裡：會改變 YAML 值的空行由掃描器記在
 * item 的 extra，extra 接在 token 後面一起比；模板文字之間的空行數不比。
 * @param {string} src
 * @param {{kind: string, s: number, e: number, mode?: string, extra?: string}[]} items scan 的回傳值
 * @returns {{text: string, gap: string, pos: number}[]}
 */
export function codeTokens(src, items) {
    const tokens = [];
    let prev = null;
    let cursor = 0;
    let space = '';
    let nl = true;
    for (const it of items) {
        space += src.slice(cursor, it.s);
        cursor = it.e;
        if (it.kind === COMMENT) {
            nl ||= NEWLINE.test(src.slice(it.s, it.e));
            continue;
        }
        nl ||= NEWLINE.test(space);
        let gap;
        if (nl) gap = VERBATIM.has(it.mode) ? `\n${space.slice(space.lastIndexOf('\n') + 1)}` : '\n';
        else if (prev.mode === 'js' && it.mode === 'js') gap = '';
        else if (VERBATIM.has(prev.mode) && VERBATIM.has(it.mode)) gap = space;
        else gap = space ? ' ' : '';
        tokens.push({ text: src.slice(it.s, it.e) + (it.extra ?? ''), gap, pos: it.s });
        prev = it;
        space = '';
        nl = false;
    }
    return tokens;
}

/**
 * firstDifference 去掉兩個版本的註解後比對 token 序列，回傳第一個不同的地方，完全相同時回傳 null。
 * 某一邊的 token 先用完時，那一邊是 null。
 * @param {string} before
 * @param {string} after
 * @param {string} lang languageOf 的回傳值
 * @returns {null | {before: object|null, after: object|null}}
 */
export function firstDifference(before, after, lang) {
    const a = tokensOf(before, lang, '舊版');
    const b = tokensOf(after, lang, '新版');
    let k = 0;
    while (k < a.length && k < b.length && a[k].text === b[k].text && a[k].gap === b[k].gap) k++;
    if (k === a.length && k === b.length) return null;
    return { before: a[k] ?? null, after: b[k] ?? null };
}

function tokensOf(src, lang, label) {
    try {
        return codeTokens(src, scan(src, lang));
    } catch (err) {
        if (err instanceof ScanError) err.message = `${label}：${err.message}`;
        throw err;
    }
}
