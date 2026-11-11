/**
 * 簡轉繁的轉換程序，對照表由呼叫端傳入（s2t.mjs 用產生好的表，scripts/build-s2t-phrases.mjs
 * 產生表時用它驗證）。規則見 s2t.mjs。
 */

// 句子的結尾。詞組的鍵只有漢字，不會跨過這些字
const TERMINATORS = new Set([...'。！？!?\n']);
// 一句最多算幾個字，超過就當作下一句。CURATED 要看整句有沒有簡體字，串流最多為此留這麼多字
const MAX_SENTENCE = 100;

/**
 * pairs、defaults：[簡, 繁] 的陣列，逐字對照與一對多字的預設轉法
 * phrases、curated、always：[鍵, 轉法] 的陣列；guards：鍵的陣列
 * simplified：簡體專用字（正確的繁體文字不會有的字）的 Set
 */
export function createConverter({ pairs, defaults, phrases, curated, always = [], guards, simplified }) {
    const table = new Map(pairs);
    const fallback = new Map(defaults);
    const norm = (ch) => table.get(ch) ?? fallback.get(ch) ?? ch;

    // 鍵以 norm 後的字存，逐字對照與預設轉法的字簡繁都對得上（繁體的「獲准」也對得上擋詞「获准」）。不同的鍵 norm 後可能相同（六须鲇、六须鲶），
    // 都留著，後加的優先。prefixes 是所有鍵的前綴（不含整個鍵），用來判斷還能不能接得更長
    const words = new Map();
    const prefixes = new Set();
    const GUARD = { kind: 'guard' };
    const add = (key, entry) => {
        let n = '';
        for (const ch of key) {
            if (n) prefixes.add(n);
            n += norm(ch);
        }
        if (!words.has(n)) words.set(n, []);
        words.get(n).unshift(entry);
    };
    for (const key of guards) add(key, GUARD);
    for (const [key, value] of phrases) add(key, { kind: 'phrase', key, value });
    for (const [key, value] of curated) add(key, { kind: 'curated', key, value });
    for (const [key, value] of always) add(key, { kind: 'always', key, value });

    // 這些字後面的「么」是簡體的「麼」（什么、怎么、這么、那么、多么、要么、甚么）
    const moPrefixes = new Set([...'什怎這这那多要甚']);
    const convertChar = (ch, previous) => {
        if (ch === '据' && previous === '拮') return ch;
        if (ch === '么') return moPrefixes.has(previous) ? '麼' : ch;
        return table.get(ch) ?? fallback.get(ch) ?? ch;
    };

    /**
     * chars[start] 開始最長、可以套用的詞：擋詞與 ALWAYS 一律可以；PHRASES 要比對到的那段原文有簡體專用字；
     * CURATED 要整句有簡體專用字（tainted 是 undefined 表示這句還沒收完，不知道；final 時不再等，
     * 當作沒有）。
     * open：走到 chars 結尾時還可能接成更長的詞；waiting：有 CURATED 的詞要等整句收完才知道能不能用。
     */
    const longest = (chars, start, tainted) => {
        let found = { length: 0, entry: null };
        let simplifiedSeen = false;
        let waiting = false;
        let n = '';
        for (let i = start; i < chars.length; i++) {
            n += norm(chars[i]);
            if (simplified.has(chars[i])) simplifiedSeen = true;
            for (const entry of words.get(n) ?? []) {
                const usable = entry.kind === 'guard' || entry.kind === 'always' || (entry.kind === 'phrase' && simplifiedSeen) || (entry.kind === 'curated' && tainted === true);
                if (usable) {
                    found = { length: i - start + 1, entry };
                    break;
                }
                if (entry.kind === 'curated' && tainted === undefined) waiting = true;
            }
            if (!prefixes.has(n)) return { ...found, open: false, waiting };
        }
        return { ...found, open: true, waiting };
    };

    // 逐段轉換。final 為 true 時把留著的全部轉完。收到的字先分句：句尾或滿 MAX_SENTENCE 個字就換下一句，
    // 記下每句有沒有簡體專用字（還沒收完、也還沒看到簡體字的句子是 undefined）。整段和串流分句的結果相同
    const createRun = () => {
        let pending = []; // 還沒轉出去的字，和每個字屬於第幾句
        let sentenceOf = [];
        let previous = '';
        const taint = new Map();
        let sentence = 0;
        let length = 0;
        const close = () => {
            if (taint.get(sentence) === undefined) taint.set(sentence, false);
            sentence++;
            length = 0;
        };
        return (input, final) => {
            const chars = [...pending, ...input];
            const sentences = sentenceOf;
            for (const ch of input) {
                sentences.push(sentence);
                if (simplified.has(ch)) taint.set(sentence, true);
                length++;
                if (TERMINATORS.has(ch) || length === MAX_SENTENCE) close();
            }
            let out = '';
            let i = 0;
            while (i < chars.length) {
                const { length: matched, entry, open, waiting } = longest(chars, i, taint.get(sentences[i]));
                if (!final && (open || waiting)) break;
                const step = Math.max(matched, 1);
                const key = entry?.value && [...entry.key];
                const value = entry?.value && [...entry.value];
                for (let k = i; k < i + step; k++) {
                    const ch = chars[k];
                    // 原文和鍵同一個字的位置照詞組轉；原文寫成繁體（或另一個簡體寫法）的字照逐字對照
                    out += key && ch === key[k - i] ? value[k - i] : convertChar(ch, previous);
                    previous = ch;
                }
                i += step;
            }
            pending = chars.slice(i);
            sentenceOf = sentences.slice(i);
            for (const id of taint.keys()) if (id < (sentenceOf[0] ?? sentence)) taint.delete(id);
            return out;
        };
    };

    /** 整段轉換 */
    const toTraditional = (text) => createRun()([...String(text)], true);

    /**
     * 串流用：回傳一個逐段轉換的函式。結尾可能還接得成更長的詞、或 CURATED 的詞要等這句收完時先留著，
     * 下一段來了再一起轉；結尾若是半個代理對（emoji 或罕用字被切開）也先留著。串流結束時呼叫 flush()
     * 轉換並取回留下的部分。所有片段（含 flush）接起來，等於整段 toTraditional 的結果。
     */
    const createTraditionalStream = () => {
        const run = createRun();
        let half = '';
        const convert = (text) => {
            let input = half + String(text);
            half = '';
            const last = input.charCodeAt(input.length - 1);
            if (last >= 0xd800 && last <= 0xdbff) {
                half = input.slice(-1);
                input = input.slice(0, -1);
            }
            return run([...input], false);
        };
        convert.flush = () => {
            const out = run([...half], true);
            half = '';
            return out;
        };
        return convert;
    };

    return { toTraditional, createTraditionalStream };
}
