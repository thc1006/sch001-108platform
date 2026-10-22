/**
 * WinLab（OpenAI 相容 Chat Completions）的串流用戶端：送出一輪請求、邊收邊回報，
 * 收完回傳這一輪的思考、正文、結束原因與用量。
 *
 * 一律用串流（stream: true）：
 *   - xhigh 一輪最多 8192 tokens，以實測約 46 tokens/s 計要三分鐘；串流才能
 *     邊收邊回報進度，也才分得出「還在想」和「卡死了」（閒置逾時）。
 *   - 被截斷時要知道是斷在思考還是斷在正文（generate.mjs 的接續策略不同），
 *     而思考內容只出現在串流的 delta.reasoning_content。
 *
 * 錯誤一律轉成 UpstreamError，code 是給上層判斷用的穩定代號。上游回來的錯誤內容
 * 會夾帶 key 的雜湊與內網位址，遮罩後才放進 detail（不可列舉，JSON.stringify 帶不出去）
 * 給 log，絕不往外送；額度之類的數字留著，除錯時用得到。呼叫端的回呼丟出的例外原樣丟回，
 * 不翻譯成網路錯誤，否則上層會依 retryable 替已經離開的使用者再燒一次 GPU。
 */

export class UpstreamError extends Error {
    /**
     * @param {string} code      busy | auth | misconfigured | unavailable | timeout | aborted | protocol
     * @param {string} message   給 log 看的說明（不含上游原文）
     * @param {object} [extra]   status：上游 HTTP 狀態；retryable：稍後重試有沒有機會成功；
     *                           retryAfter：上游 Retry-After 秒數；detail：遮罩過的上游原文
     */
    constructor(code, message, { status, retryable = false, retryAfter, detail, cause } = {}) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = 'UpstreamError';
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.retryAfter = retryAfter;
        Object.defineProperty(this, 'detail', { value: detail, enumerable: false, writable: true, configurable: true });
    }
}

// 內部位址（可帶 port）：WinLab 的錯誤會帶出 LiteLLM 後面的位址。
// 每一段都以 lookbehind 開頭，只能從一串位址字元的開頭比起：用 \b 的話，一長串 a.b.c.…
// 在每個位置都要先吃到底再逐字回溯（二次方，1 MiB 要幾十分鐘，整個事件迴圈跟著卡住），
// 也會把 cafe80:1、std::1、1.10.1.2.3 這類字串的一部分誤認成位址
// 後面接 -dev 或更多段數字的是版本號，不是位址；接 -數字 的是範圍（10.0.0.1-10.0.0.255），照遮
const IPV4_END = String.raw`(?!\w|-[a-z]|\.\d)`;
const OCTET = String.raw`\d{1,3}`;
// 名稱後面還有一段（.internal.com）就不是內部網域；句尾的句點不算一段
const NAME_END = String.raw`(?![\w-]|\.[\w-])`;
// 最後一段是這些的名稱不當成叢集內部的 name.ns:port：公開網域（example.com:443），以及
// 原始碼與設定檔的副檔名（LiteLLM 的 traceback 會寫 proxy_server.py:3421、server.js:120:15）
const NOT_NAMESPACE = [
    'com|net|org|edu|gov|mil|int|io|ai|dev|app|cloud|co|me|info|biz|tw|jp|cn|uk|de',
    'py|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|sh|sql',
    'json|ya?ml|toml|ini|cfg|conf|log|txt|md|html?|css|lock',
].join('|');
// port 後面不能再接英數字：gpt-4:32k 的 32k 不是 port
const PORT_AHEAD = String.raw`(?=:\d{2,5}(?!\w))`;
const INTERNAL_ADDRESS = new RegExp([
    // IPv4：私有、迴路、CGNAT（Tailscale 的位址在這段）、link-local
    String.raw`(?<![\w.])(?:10|127)(?:\.${OCTET}){3}${IPV4_END}`,
    String.raw`(?<![\w.])192\.168(?:\.${OCTET}){2}${IPV4_END}`,
    String.raw`(?<![\w.])172\.(?:1[6-9]|2\d|3[01])(?:\.${OCTET}){2}${IPV4_END}`,
    String.raw`(?<![\w.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.${OCTET}){2}${IPV4_END}`,
    String.raw`(?<![\w.])169\.254(?:\.${OCTET}){2}${IPV4_END}`,
    // IPv6：迴路、ULA（fc00::/7）、link-local（fe80::/10），可帶方括號與 zone id；
    // 至少要有兩個冒號，Feb1:30 這種時間不算
    String.raw`\[?(?<![\w:])(?:::1|f[cd][0-9a-f]{2}:(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4}|fe[89ab][0-9a-f]:(?:[0-9a-f]{0,4}:){1,6}[0-9a-f]{0,4})(?:%(?:25)?[\w.-]+)?\]?`,
    // 叢集與內部網域：k8s 的 name.ns.svc[.cluster.local]、雲端的 .internal、mDNS 的 .local
    // （threading.local 這類名稱也會被遮，寧可多遮）、家用的 .lan／.home.arpa、Tailscale 的 .ts.net
    String.raw`(?<![\w.-])[\w-]+(?:\.[\w-]+)*\.(?:svc(?:\.cluster\.local)?|cluster\.local|internal|local|localdomain|lan|home\.arpa|ts\.net)${NAME_END}`,
    String.raw`(?<![\w.-])localhost${NAME_END}`,
    // 網址裡只有一段的主機名稱（http://vllm:8000/v1、http://gpu01）：公開的主機一定有點。
    // 帳密已經先換成 ***@（見 redact），主機名稱接在它後面也算
    String.raw`(?<=:\/\/|:\/\/\*\*\*@)[a-z][\w-]*${NAME_END}`,
    // 帶 port 的叢集短名：name.ns:8000、pod.svc.ns:8000、litellm-proxy:4000
    // （單段的要有連字號，免得 code:400 也被遮）
    String.raw`(?<![\w.-])[a-z][\w-]*(?:\.[a-z][\w-]*)?\.(?!(?:${NOT_NAMESPACE})(?![\w-]))[a-z][\w-]*${PORT_AHEAD}`,
    String.raw`(?<![\w.-])[a-z][a-z0-9]*-[\w-]*${PORT_AHEAD}`,
].map((p) => `${p}(?::\\d+)?`).join('|'), 'gi');

// 一進來先截到這麼長。最後只留 limit（預設 500）字給 log，這之後的內容再長也輪不到；
// 也讓下面每一步的成本都有上限（SSE 的一個事件最多 1 MiB）
const REDACT_INPUT_CHARS = 64 * 1024;
// 被截斷的內容丟掉尾端這麼多字：截斷點可能切在 key 中間，殘段比對不到任何寫法；前面的內容
// 遮罩後又縮短（空白收斂、看不見的字元被拿掉）時，殘段就會落進留給 log 的那 500 字。
// key 的十六進位寫法是兩倍長、還可能被看不見的字元隔開，留四倍以上的餘裕
const TRUNCATED_TAIL_CHARS = 256;
// 看不見、會把 key 切開或擾亂終端機的字元：控制字元（\t \n \r 換成空白）、格式字元（零寬、
// 雙向控制）、預設可忽略的字元（異體字選擇符、韓文填充字、軟連字號、tag 字元）
const INVISIBLE = /(?![\t\n\r])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

function cleanString(text) {
    return text.replace(INVISIBLE, '').replace(/[\t\n\r]/g, ' ');
}

// 文字裡寫成跳脫序列的字元先還原再清：被 -、\u0007（JSON）或 \x07（Python 的 repr）
// 切開的 key 才接得回來。不是合法 JSON 的內容（例如超過 8 KiB 被截斷）、以及 LiteLLM
// 把內層錯誤整段序列化成字串再包一層的情況，都靠這一步
// 一次還原一層，由左往右掃：\\u0007 是「跳脫過的反斜線」加上 u0007，不是 \\ 加上 \u0007。
// 短跳脫還原成真正的控制字元，交給 cleanString：\b \f 會被拿掉（被它們切開的 key 才接得回來），
// \n \r \t 變成空白
const SHORT_ESCAPES = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
function unescapeOnce(text) {
    return text.replace(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|([bfnrt])|(["\\/]))/g, (_, u, x, control, literal) => {
        if (u) return String.fromCharCode(Number.parseInt(u, 16));
        if (x) return String.fromCharCode(Number.parseInt(x, 16));
        if (control) return SHORT_ESCAPES[control];
        return literal;
    });
}

// 包了好幾層（JSON 字串裡又是一段 JSON）時，每一層都多一道跳脫：最多還原三層
function unescapeLike(text) {
    let out = text;
    for (let i = 0; i < 3 && out.includes('\\'); i++) {
        const next = unescapeOnce(out);
        if (next === out) break;
        out = next;
    }
    return out;
}

// JSON 在解析後的值上清字元（物件的鍵也是），再序列化：對序列化的結果做文字替換的話，
// \b \f 這類短跳脫會漏掉
function cleanJson(value) {
    if (typeof value === 'string') return cleanString(unescapeLike(value));
    if (Array.isArray(value)) return value.map(cleanJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanJson(k), cleanJson(v)]));
    }
    return value;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// URL 編碼的可見 ASCII 解回原字：encodeURIComponent、Python 的 quote()、表單編碼各自編碼
// 不同的字元，%XX 也可能大小寫混用，一律解回來之後只要比對原樣。空白與控制字元不解
function decodePercentAscii(text) {
    return text.replace(/%([2-7][0-9A-Fa-f])/g, (m, hex) => {
        const code = Number.parseInt(hex, 16);
        return code >= 0x21 && code <= 0x7e ? String.fromCharCode(code) : m;
    });
}

// 文字在比對 key 之前經過的整理（清字元、還原跳脫、解 URL 編碼），key 也照做一次：
// key 本身含有反斜線或 %XX 時，文字裡的它已經被改寫過了
const normalizeLikeText = (text) => decodePercentAscii(cleanString(unescapeLike(text)));

// key 可能出現的各種寫法：原樣與整理過的樣子、JSON 跳脫過（" 與 \ 前面多一個反斜線）、
// 十六進位、base64（三種對齊與 base64url）。URL 編碼的寫法不用列：文字裡的已經解回原樣
function secretForms(secret) {
    const normalized = normalizeLikeText(secret);
    const hex = Buffer.from(secret).toString('hex');
    return new Set([
        secret,
        normalized,
        JSON.stringify(secret).slice(1, -1),
        JSON.stringify(normalized).slice(1, -1),
        hex,
        hex.toUpperCase(),
        ...base64Forms(secret),
    ].filter(Boolean));
}

/**
 * key 在一大段 base64 裡的樣子：key 前面的位元組數除以 3 的餘數不同，編出來的字元就不同，
 * 三種對齊都要算（例如 Basic 認證的 base64(":" + key)）。只取完全由 key 決定的中段：
 * 開頭幾個字元混著前面的位元組、結尾不滿一組的會被後面的位元組影響。base64url 也一併算進來
 */
function base64Forms(secret) {
    const bytes = Buffer.from(secret);
    const forms = new Set();
    for (let offset = 0; offset < 3; offset++) {
        const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
        const middle = encoded.slice(Math.ceil((offset * 4) / 3), Math.floor((offset + bytes.length) / 3) * 4);
        if (middle.length >= 8) {
            forms.add(middle);
            forms.add(middle.replaceAll('+', '-').replaceAll('/', '_'));
        }
    }
    return [...forms];
}

/**
 * 遮罩後截短，給 log 用。truncated：text 是被截斷的（例如錯誤內容只讀了前 8 KiB），尾端
 * 一併丟掉。依序：截到 REDACT_INPUT_CHARS（截斷時丟掉尾端）；拿掉看不見的字元（被切開的 key 會
 * 重新接起來，終端機跳脫碼與 RLO 也一併清掉）；JSON 解析後在值上清字元再序列化，不是 JSON
 * 就先還原跳脫序列再清一次；URL 編碼的可見 ASCII 解回原字；接著遮掉 key 本身（各種編碼的
 * 寫法，見 secretForms）、sk- 開頭的 key、Bearer token、長十六進位（key 的雜湊）、email、內部位址。
 */
export function redact(text, { secrets = [], limit = 500, truncated = false } = {}) {
    let raw = String(text ?? '');
    if (truncated || raw.length > REDACT_INPUT_CHARS) {
        raw = raw.slice(0, REDACT_INPUT_CHARS);
        raw = raw.slice(0, Math.max(0, raw.length - TRUNCATED_TAIL_CHARS));
    }
    let out = cleanString(raw);
    try {
        out = JSON.stringify(cleanJson(JSON.parse(out)));
    } catch {
        // 不是 JSON（或巢狀深到解析不了）：照文字處理
        out = cleanString(unescapeLike(out));
    }
    out = decodePercentAscii(out);
    for (const secret of secrets) {
        if (!secret) continue;
        for (const form of secretForms(secret)) out = out.split(form).join('***');
        // 被空白或換行切開的 key（上游把它斷行、或排版時插了空白）。key 本身不含空白，
        // 每個字之間只有 \s*，不會回溯
        if (secret.length >= 8) {
            out = out.replace(new RegExp([...secret].map(escapeRegExp).join('\\s*'), 'g'), '***');
        }
    }
    return out
        .replace(/(?<![A-Za-z0-9])sk-[\w.-]+/g, 'sk-***')
        .replace(/bearer\s+[\w.~+/=-]+/gi, 'Bearer ***')
        // vLLM 的請求 id（chatcmpl-<32 位十六進位>）不是祕密，回報問題時用得到
        .replace(/(?<![0-9a-f])(?<!chatcmpl-)[0-9a-f]{32,}(?![0-9a-f])/gi, '<hash>')
        // LiteLLM 的額度錯誤會帶出 key 擁有者的 email
        // 網址裡的帳密（http://user:pass@host）：先遮掉，免得帳號被下面的規則當成主機名稱
        .replace(/(?<=:\/\/)[^\s/?#@]+@/g, '***@')
        // 網域的最後一段要以英文字母開頭：react@18.3.1 是套件版本，不是 email
        .replace(/(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z][\w-]*/g, '<email>')
        .replace(INTERNAL_ADDRESS, '<internal>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
}

// Retry-After 只收十進位秒數或 HTTP-date，上限 5 分鐘。不能直接丟給 Number（'0x10' 會變 16）
// 或 Date.parse（V8 連 '1.5' 都當成日期，沒有時區的 asctime 還會當成本地時間）。
// HTTP-date 依 RFC 9110 §5.6.7：IMF-fixdate 是標準，接收端也要接受過時的 RFC 850 與 asctime
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = MONTHS.join('|');
const IMF_FIXDATE = new RegExp(String.raw`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (${MONTH}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$`);
const RFC850_DATE = new RegExp(String.raw`^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (\d{2})-(${MONTH})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$`);
const ASCTIME_DATE = new RegExp(String.raw`^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (${MONTH}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$`);

function parseHttpDate(text, now) {
    let m;
    let year;
    let month;
    let day;
    let hh;
    let mm;
    let ss;
    if ((m = IMF_FIXDATE.exec(text))) {
        [, day, month, year, hh, mm, ss] = m;
    } else if ((m = RFC850_DATE.exec(text))) {
        [, day, month, year, hh, mm, ss] = m;
        // 兩位數的年：看起來在 50 年以後的，當成過去最近一個同尾數的年份（RFC 9110）
        const thisYear = new Date(now).getUTCFullYear();
        year = Math.floor(thisYear / 100) * 100 + Number(year);
        if (year > thisYear + 50) year -= 100;
    } else if ((m = ASCTIME_DATE.exec(text))) {
        [, month, day, hh, mm, ss, year] = m;
    } else {
        return Number.NaN;
    }
    const fields = [Number(year), MONTHS.indexOf(month), Number(day), Number(hh), Number(mm), Number(ss)];
    if (fields[3] > 23 || fields[4] > 59 || fields[5] > 60) return Number.NaN;
    // 閏秒（23:59:60）當成 :59，不然 Date.UTC 會進位到隔天，被下面的檢查擋掉
    const at = Date.UTC(...fields.slice(0, 5), Math.min(fields[5], 59));
    // 不存在的日期（99 日、2 月 30 日）Date.UTC 會往後進位：轉回來對不上就不收
    const check = new Date(at);
    if (check.getUTCFullYear() !== fields[0] || check.getUTCMonth() !== fields[1] || check.getUTCDate() !== fields[2]) return Number.NaN;
    return at;
}

export function parseRetryAfter(value, now = Date.now()) {
    if (!value) return undefined;
    const text = String(value).trim();
    let seconds;
    if (/^\d+$/.test(text)) {
        seconds = Number(text);
    } else {
        const at = parseHttpDate(text, now);
        if (Number.isNaN(at)) return undefined;
        seconds = Math.ceil((at - now) / 1000);
    }
    return Math.min(300, Math.max(0, seconds));
}

// 依 WinLab 的 HTTP 狀態分類。429 可能是速率、並行、key 或使用者額度（WinLab 文件），
// 對前端一律是「忙線，稍後再試」；401/403 是 key 失效或來源 IP 不在白名單，
// 使用者再按幾次也不會好，所以不是 retryable。
export function classifyStatus(status) {
    if (status === 429) return { code: 'busy', retryable: true };
    if (status === 401 || status === 403) return { code: 'auth', retryable: false };
    if (status === 408 || status === 504) return { code: 'timeout', retryable: true };
    // 501（不支援）、505（HTTP 版本）是永久性的
    if (status >= 500 && status !== 501 && status !== 505) return { code: 'unavailable', retryable: true };
    // 3xx（不跟轉址）、400（欄位不被接受、超過上限）、404（路徑或模型錯）：都是我們送錯了
    return { code: 'misconfigured', retryable: false };
}

// 一行與一個事件最長多少字元：SSE 正常的一個事件只有一塊 delta（幾百字元），超過就是上游
// 壞了，不要無限累積（也免得之後 JSON.parse／redact 在事件迴圈上同步處理一大串）
const MAX_LINE_CHARS = 1024 * 1024;
const MAX_EVENT_CHARS = 1024 * 1024;

/**
 * 把 SSE 位元組串流拆成一個個事件的 data 字串，依 WHATWG HTML 的 event stream 規格：
 *   - 行尾可以是 CRLF、CR 或 LF；CR 落在一塊的結尾時先當成行尾，下一塊若以 LF 開頭就跳過
 *   - 冒號開頭是註解；沒有冒號的行整行是欄位名稱、值為空字串；冒號後只去掉一個空白
 *   - 空行才派送事件；有過 data 行才派送（data 可以是空字串）；同一事件多行 data 以 \n 串接
 *   - 串流結束時還沒等到空行的事件與殘行直接丟掉（規格寫明 must be discarded）
 * 每塊只掃描新進來的部分，殘行以陣列累積，長行切成很多小塊送來時不會一再重掃。
 * 用 TextDecoder 的 stream 模式，中文字的 UTF-8 位元組被切在兩塊之間也不會變亂碼。
 */
export async function* sseData(body, onBytes) {
    const decoder = new TextDecoder();
    const terminator = /\r\n|\r|\n/g;
    let partial = [];       // 還沒遇到行尾的片段
    let partialLength = 0;
    let skipLeadingLf = false;
    let dataBuffer = null;

    function* line(text) {
        if (text === '') {
            if (dataBuffer !== null) yield dataBuffer;
            dataBuffer = null;
            return;
        }
        if (text.startsWith(':')) return;
        const colon = text.indexOf(':');
        const field = colon === -1 ? text : text.slice(0, colon);
        if (field !== 'data') return; // event:、id:、retry: WinLab 沒有用到
        let value = colon === -1 ? '' : text.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        dataBuffer = dataBuffer === null ? value : `${dataBuffer}\n${value}`;
        if (dataBuffer.length > MAX_EVENT_CHARS) {
            throw new UpstreamError('protocol', `串流的一個事件超過 ${MAX_EVENT_CHARS} 字元`);
        }
    }

    function* feed(text) {
        let start = 0;
        // 空的一塊不算數：CR | 空塊 | LF 仍是同一個 CRLF
        if (skipLeadingLf && text.length > 0) {
            skipLeadingLf = false;
            if (text[0] === '\n') start = 1;
        }
        for (;;) {
            terminator.lastIndex = start;
            const match = terminator.exec(text);
            if (!match) break;
            if (match[0] === '\r' && match.index === text.length - 1) skipLeadingLf = true;
            const piece = text.slice(start, match.index);
            const full = partial.length ? partial.join('') + piece : piece;
            partial = [];
            partialLength = 0;
            start = match.index + match[0].length;
            yield* line(full);
        }
        if (start < text.length) {
            partial.push(text.slice(start));
            partialLength += text.length - start;
            if (partialLength > MAX_LINE_CHARS) {
                throw new UpstreamError('protocol', `串流的一行超過 ${MAX_LINE_CHARS} 字元`);
            }
        }
    }

    for await (const chunk of body) {
        if (onBytes) onBytes();
        yield* feed(decoder.decode(chunk, { stream: true }));
    }
    yield* feed(decoder.decode());
    // 沒有以空行結束的事件與殘行：依規格丟棄
}

// 錯誤內容最多讀這麼多：只是要留 500 字給 log，上游回幾百 MB 時不能把記憶體吃光
const MAX_ERROR_BODY_BYTES = 8 * 1024;
// 收到 finish_reason 或 [DONE] 之後，剩下的只有 usage 與連線結尾：最多再等這麼久就收尾。
// 這段期限是固定的，之後再進來的位元組（例如心跳）不會讓它延後
const AFTER_FINISH_IDLE_MS = 5_000;

// 回應不是正常的串流時，detail 只記形狀：正文常照抄學生的輸入，不能進 log
function shapeOf(text) {
    const head = text.trimStart();
    return `${text.length} 字元，開頭是 ${JSON.stringify(head.startsWith('data:') ? 'data:' : head.slice(0, 1))}`;
}

// 回傳 { text, truncated }：truncated 表示後面還有沒讀的，交給 redact 丟掉尾端
async function readLimited(res, limit) {
    if (!res.body) return { text: '', truncated: false };
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (size < limit) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.byteLength;
        }
    } finally {
        reader.cancel().catch(() => {});
    }
    // 剛好讀滿上限時也當成截斷：後面有沒有東西不知道，寧可多丟一段
    return { text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit)), truncated: size >= limit };
}

// 只收可見的 ASCII：key 檔若存成 UTF-16 或夾了 NUL，undici 組標頭失敗時的錯誤訊息
// 會帶著整個標頭值（也就是 key），不能讓它有機會發生
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * 送出一輪串流請求。
 *
 * @param {object} config   loadLlmConfig() 的結果
 * @param {object} payload  { messages, maxTokens, reasoningEffort, temperature?, responseFormat? }
 * @param {object} [hooks]  signal：呼叫端取消；onReasoning(text)／onContent(text)：逐段回報，
 *                          丟出的例外（或 async 回呼的 reject）會中止這一輪並原樣丟回；
 *                          串流已經收完之後才 reject 的不影響結果。fetchImpl：測試用
 * @returns {Promise<{reasoning: string, content: string, finishReason: string,
 *                    usage: object|null, reasoningChunks: number, contentChunks: number}>}
 */
export async function streamChat(config, payload, { signal, onReasoning, onContent, fetchImpl = fetch } = {}) {
    if (!config.apiKey) {
        throw new UpstreamError('auth', '沒有設定 LLM API key（LLM_API_KEY_FILE／LLM_API_KEY）');
    }
    if (!PRINTABLE_ASCII.test(config.apiKey)) {
        throw new UpstreamError('misconfigured', 'LLM API key 含有不可見或非 ASCII 的字元（檔案編碼可能不是 UTF-8）');
    }
    if (!config.upstream) {
        throw new UpstreamError('misconfigured', 'LLM_UPSTREAM 被設定成不允許的網址（原因見啟動時的警告）');
    }
    let url;
    try {
        // 只送路徑、不帶 query：LiteLLM 會吃 ?model=，等於繞過上面固定的模型
        url = new URL('/v1/chat/completions', config.upstream);
    } catch {
        throw new UpstreamError('misconfigured', 'LLM_UPSTREAM 不是合法的網址');
    }
    const secrets = [config.apiKey];

    // 欄位逐一指定，不展開呼叫端的物件：WinLab 對不認得的欄位一律 400，
    // 而且 n、logprobs 這類欄位會放大成本，不該有機會被帶上去。
    // 字串一律整理成合法的 UTF-16：孤立代理項送到上游 Python 端轉 UTF-8 時會失敗
    const body = {
        model: config.model,
        messages: payload.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content.toWellFormed() : m.content,
        })),
        max_tokens: payload.maxTokens,
        reasoning_effort: payload.reasoningEffort,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (typeof payload.temperature === 'number' && Number.isFinite(payload.temperature)) {
        body.temperature = payload.temperature;
    }
    if (payload.responseFormat && typeof payload.responseFormat === 'object') {
        body.response_format = payload.responseFormat;
    }
    // 在送出前序列化：本地的錯誤（例如循環參照）不能被當成可重試的網路錯誤
    const requestBody = JSON.stringify(body);

    // 閒置逾時：上游多久沒送任何位元組就當成卡死。每收到一塊就重新計時，所以 xhigh 想很久
    // 但一直在吐 token 的請求不會被誤殺。答案收完之後改成固定的收尾期限（見 enterClosing）
    const idle = new AbortController();
    let idleTimer;
    let closing = false;
    const armIdle = (ms = config.idleTimeoutMs) => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => idle.abort(), ms);
    };
    // 收尾期限：答案收完之後等 usage，以及讀錯誤內容（狀態碼已經決定分類，內容只是給 log 看的）
    const closingMs = Math.min(config.idleTimeoutMs, config.afterFinishIdleMs ?? AFTER_FINISH_IDLE_MS);
    const enterClosing = () => {
        if (closing) return;
        closing = true;
        armIdle(closingMs);
    };
    // 回呼出錯時中止串流用；錯誤本身原樣丟回。用旗標判斷而不是看錯誤的真假值：
    // 回呼丟出 undefined、null、0 也要算數
    const callbackAbort = new AbortController();
    let callbackFailed = false;
    let callbackError;
    const recordCallbackFailure = (err) => {
        if (callbackFailed) return;
        callbackFailed = true;
        callbackError = err;
        callbackAbort.abort();
    };
    const call = (fn, text) => {
        if (!fn || callbackFailed) return;
        try {
            const result = fn(text);
            // 讀 then 本身也可能丟例外（getter），一樣算回呼出錯
            if (result && typeof result.then === 'function') result.then(undefined, recordCallbackFailure);
        } catch (err) {
            recordCallbackFailure(err);
            throw err;
        }
    };
    const combined = AbortSignal.any([signal, idle.signal, callbackAbort.signal].filter(Boolean));

    // 呼叫端取消、閒置逾時與網路錯誤都可能在任何一個 await 冒出來，統一在這裡翻譯。
    // 走到最後一個分支的只會是 fetch／undici 自己丟的錯誤（我們自己丟的都是 UpstreamError）
    const translate = (err) => {
        if (err instanceof UpstreamError) return err;
        if (idle.signal.aborted) {
            return new UpstreamError('timeout', `上游超過 ${config.idleTimeoutMs}ms 沒有回應任何資料`, { retryable: true });
        }
        if (signal?.aborted) {
            return new UpstreamError('aborted', '請求被取消', { cause: signal.reason });
        }
        const code = err?.cause?.code || err?.code || err?.name || 'unknown';
        // undici 自己的 headersTimeout／bodyTimeout（預設 300 秒）
        if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
            return new UpstreamError('timeout', `上游逾時（${code}）`, { retryable: true });
        }
        // 不掛原始的 cause：undici 的部分錯誤訊息會帶出請求標頭
        return new UpstreamError('unavailable', `連不上 LLM 服務（${code}）`, { retryable: true });
    };
    const throwIfAborted = () => {
        if (signal?.aborted) throw new UpstreamError('aborted', '請求被取消', { cause: signal.reason });
    };

    armIdle();
    try {
        let res;
        try {
            res = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${config.apiKey}`,
                    'content-type': 'application/json',
                    accept: 'text/event-stream',
                },
                body: requestBody,
                signal: combined,
                // 不跟轉址：308 可以把請求連同 key 轉到 ?model=… 或別的來源
                redirect: 'manual',
            });
        } catch (err) {
            throw translate(err);
        }
        armIdle();

        if (!res.ok) {
            // 錯誤內容慢慢滴的話，不必等滿閒置逾時（正式設定 3 分鐘）才回報
            armIdle(closingMs);
            let detail = '';
            try {
                const { text, truncated } = await readLimited(res, MAX_ERROR_BODY_BYTES);
                detail = redact(text, { secrets, truncated });
            } catch {
                // 讀錯誤內容失敗（含收尾期限到了）不影響分類
            }
            throwIfAborted();
            const { code, retryable } = classifyStatus(res.status);
            throw new UpstreamError(code, `LLM 服務回應 HTTP ${res.status}`, {
                status: res.status,
                retryable,
                retryAfter: parseRetryAfter(res.headers.get('retry-after')),
                detail,
            });
        }

        // content-type 是上游給的文字，跟錯誤內容一樣遮罩後放進 detail，不進 message。
        // 遮罩用原文：先轉小寫的話，大小寫有別的 key 就比對不到了
        const rawType = res.headers.get('content-type') || '';
        if (!rawType.toLowerCase().includes('text/event-stream') || !res.body) {
            armIdle(closingMs);
            const { text } = await readLimited(res, MAX_ERROR_BODY_BYTES).catch(() => ({ text: '' }));
            throwIfAborted();
            throw new UpstreamError('protocol', 'LLM 服務沒有回串流', {
                detail: `content-type: ${redact(rawType, { secrets, limit: 100 }) || '（無）'}；${shapeOf(text)}`,
            });
        }

        let reasoning = '';
        let content = '';
        let finishReason = null;
        let usage = null;
        let reasoningChunks = 0;
        let contentChunks = 0;
        let sawDone = false;

        try {
            for await (const data of sseData(res.body, () => { if (!closing) armIdle(); })) {
                // [DONE] 之後還是把串流讀到結束（chunked 的結尾），連線才能放回連線池重用；
                // 之後的事件一律不理
                if (sawDone) continue;
                if (data === '[DONE]') {
                    sawDone = true;
                    enterClosing();
                    continue;
                }
                if (data === '') continue;
                let chunk;
                try {
                    chunk = JSON.parse(data);
                } catch {
                    throw new UpstreamError('protocol', '串流內容不是 JSON', { detail: shapeOf(data) });
                }
                if (!chunk || typeof chunk !== 'object') {
                    throw new UpstreamError('protocol', '串流內容不是物件', { detail: `JSON 的 ${chunk === null ? 'null' : typeof chunk}` });
                }
                // LiteLLM 串到一半出錯時會送 {"error": {...}}，不能當成正常結束；
                // 答案已經收完（有 finish_reason）之後才出的錯不影響結果，後面若還有 usage 照收
                if (chunk.error) {
                    if (finishReason) continue;
                    const status = Number(chunk.error.code);
                    const isHttp = Number.isInteger(status) && status >= 400 && status <= 599;
                    const { code, retryable } = isHttp ? classifyStatus(status) : { code: 'unavailable', retryable: true };
                    throw new UpstreamError(code, 'LLM 服務在串流途中回報錯誤', {
                        status: isHttp ? status : undefined,
                        retryable,
                        // 遮罩原本的那一行：再把 chunk.error 序列化一次的話，巢狀很深時會丟 RangeError
                        detail: redact(data, { secrets }),
                    });
                }
                if (chunk.usage) usage = chunk.usage;
                const choice = chunk.choices?.[0];
                if (!choice) continue;
                // 最後一塊（只帶 usage）的 finish_reason 是 null，不能蓋掉前一塊的 stop／length
                if (choice.finish_reason && !finishReason) {
                    finishReason = choice.finish_reason;
                    enterClosing();
                }
                const delta = choice.delta || {};
                // vLLM 的欄位是 reasoning_content；部分版本叫 reasoning，兩個都收
                const thought = delta.reasoning_content || delta.reasoning;
                if (thought) {
                    reasoning += thought;
                    reasoningChunks++;
                    call(onReasoning, thought);
                }
                if (delta.content) {
                    content += delta.content;
                    contentChunks++;
                    call(onContent, delta.content);
                }
            }
        } catch (err) {
            if (callbackFailed) throw callbackError;
            // 答案已經收完（有 finish_reason），之後只是等 usage／[DONE] 時斷線或到了收尾期限：照樣交出結果
            if (!(finishReason && !signal?.aborted)) {
                // 收尾期間被呼叫端取消的，照常回報 aborted
                if (sawDone && !finishReason && !signal?.aborted) {
                    throw new UpstreamError('unavailable', 'LLM 服務的串流結束了，但沒有給結束原因', { retryable: true });
                }
                throw translate(err);
            }
        }
        if (callbackFailed) throw callbackError;

        // 沒有結束原因就收尾，代表上游在途中把連線關了：當成錯誤，絕不能把半截的
        // 內容當成完整答案交出去（ahp-match 實際遇過瀏覽器把半截答案當完整的）
        if (!finishReason) {
            throw new UpstreamError('unavailable', sawDone
                ? 'LLM 服務的串流結束了，但沒有給結束原因'
                : 'LLM 服務的串流在途中中斷', { retryable: true });
        }
        return { reasoning, content, finishReason, usage, reasoningChunks, contentChunks };
    } finally {
        clearTimeout(idleTimer);
    }
}
