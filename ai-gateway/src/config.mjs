/**
 * AI 閘道的設定：全部來自環境變數，啟動時讀一次。
 *
 * 變數名稱沿用 ahp-match 的 scripts/serve-local.js（同一台 k3s、打同一個 WinLab），
 * 數值打錯（0、8k、6e5）時退回預設並警告，而不是讓服務起不來或每個請求都失敗。
 * 唯一刻意不同名的是總時限：ahp-match 的 LLM_MAX_GENERATION_MS 是「單一請求」的上限，
 * 這裡的時限涵蓋一個任務的所有接續輪，所以叫 LLM_TASK_TIMEOUT_MS，避免同名不同義。
 *
 * 與 key 和上游網址有關的設定錯了不退回預設：退回正式站等於把 key 送到使用者沒打算送
 * 的地方。這兩種情況一律警告並當成「沒有設定」，由 configProblems() 列出；HTTP 服務的
 * readiness 檢查要依它回報未就緒，k3s 才不會把流量導進來。
 *
 *   LLM_UPSTREAM            WinLab 的 origin（預設 https://llm.winlab.tw）；路徑會被忽略，
 *                           http 只接受本機（key 不能走明文）
 *   LLM_API_KEY_FILE        從檔案讀 key，有設就優先（k3s 把 Secret 掛成檔案）
 *   LLM_API_KEY             直接給 key（只建議本機開發用）
 *   LLM_MODEL               模型（預設 qwen3.8-27b-fp8）
 *   LLM_REASONING_EFFORT    思考強度，WinLab 只收 none／low／medium／xhigh（預設 xhigh；不分大小寫）
 *   LLM_CONTINUATION_EFFORT 接續輪的思考強度（預設 none，理由見 generate.mjs）
 *   LLM_MAX_TOKENS          每一輪的 max_tokens 上限，含思考（預設 8192 = WinLab 單次上限）
 *   LLM_CONTEXT_TOKENS      模型的 context 長度（預設 32768，2026-10-21 實測）
 *   LLM_MAX_ROUNDS          被截斷時連同第一輪最多跑幾輪（預設 3）
 *   LLM_TASK_TIMEOUT_MS     一個任務所有輪合計的時限（預設 900000 = 15 分鐘）
 *   LLM_IDLE_TIMEOUT_MS     上游多久沒有進展就當成卡死（預設 180000，上限 300000）。收到標頭之前看有沒有
 *                           回應，之後看有沒有送來思考、正文或 usage
 *
 * 預設的輪數與時限是一起選的：被截斷的那一輪一定用滿 8192 tokens，以實測約 46 tokens/s
 * 計一輪約 3 分鐘；WinLab 忙碌時每一輪的第一個位元組還要再等一兩分鐘（2026-10-22 實測
 * 82.6 秒），3 輪都寫滿、沒有額外請求（探測、重試）時約 13 分鐘，所以預設 15 分鐘。
 * 輪數調高時時限要跟著調。
 */
import { readFileSync } from 'node:fs';

// WinLab 只收這四種思考強度。high、max 會被 400 拒絕（2026-10-21 實測），
// 所以不能照 OpenAI 的文件猜。由弱到強排列。
export const EFFORTS = ['none', 'low', 'medium', 'xhigh'];

// WinLab 單次輸出上限，含思考：max_tokens=8193 回 400「單次輸出上限為 8192 tokens(含思考)」。
// 設定超過這個值等於每個請求都必定失敗，所以直接當成合法範圍的上界。
export const WINLAB_MAX_TOKENS = 8192;

// undici（Node 的 fetch）自己的 headersTimeout／bodyTimeout 預設 300 秒，換不掉
// （閘道沒有相依套件、不自建 Agent）。閒置逾時設得比它長也沒有意義，只會被它先截斷。
export const MAX_IDLE_TIMEOUT_MS = 300_000;

// 貼上 key 時常夾帶的零寬字元（ZWSP、ZWNJ、ZWJ、WORD JOINER、BOM）：key 本身不會有這些字，
// 在哪裡都清掉。一律寫成跳脫序列：直接寫字元本體的話畫面上看不見，被編輯器正規化掉也沒人發現
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/g;
// 清掉雜訊後只能剩可見的 ASCII。key 檔存成 UTF-16 時會夾 NUL，帶進 HTTP 標頭時
// undici 的錯誤訊息會印出整個標頭值，也就是 key。
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

// 警告裡顯示設定值：只有短、而且明顯不是 key 的值（英數與 . + - _，最多 12 字）才原樣顯示，
// 其他只說有幾個字元。key 被貼錯變數時（例如貼進 LLM_MAX_TOKENS），警告不能把它印出來。
// LiteLLM 的 key 只有 25 字元，截短也擋不住；只顯示這種字元也順便擋掉換行造成的 log 偽造。
function shown(raw) {
    const text = String(raw).trim();
    if (text.length <= 12 && /^[\w.+-]*$/.test(text) && !/^sk-/i.test(text)) return JSON.stringify(text);
    return `（${[...text].length} 個字元，內容不顯示）`;
}

// 只有空白跟沒設一樣（都不警告）
const isUnset = (raw) => raw === undefined || String(raw).trim() === '';

// 環境變數只收範圍內的十進位整數；不合法就用預設值並警告
function toInt(env, name, fallback, min, max, warn) {
    const raw = env[name];
    if (isUnset(raw)) return fallback;
    const text = String(raw).trim();
    const n = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    if (Number.isNaN(n) || n < min || n > max) {
        warn(`設定 ${name}=${shown(raw)} 不合法（要介於 ${min}～${max} 的整數），改用預設值 ${fallback}`);
        return fallback;
    }
    return n;
}

function toEffort(env, name, fallback, warn) {
    const raw = env[name];
    if (isUnset(raw)) return fallback;
    const effort = String(raw).trim().toLowerCase();
    if (!EFFORTS.includes(effort)) {
        warn(`設定 ${name}=${shown(raw)} WinLab 不接受（只有 ${EFFORTS.join('／')}），改用 ${fallback}`);
        return fallback;
    }
    return effort;
}

// k3s 把 Secret 掛成檔案（LLM_API_KEY_FILE）：比放環境變數不容易從當機傾印或 log 外流。
// 讀不到、是空的、或含不合法字元時程序照樣啟動，由 configProblems() 回報，流量就不會導過來。
// 警告訊息一律不印 key 的內容。
function readApiKey(env, warn) {
    let key = env.LLM_API_KEY || '';
    let source = 'LLM_API_KEY';
    if (env.LLM_API_KEY_FILE) {
        source = 'LLM_API_KEY_FILE';
        try {
            key = readFileSync(env.LLM_API_KEY_FILE, 'utf8');
        } catch (err) {
            warn(`讀不到 LLM_API_KEY_FILE（${err.code || err.message}），AI 任務會失敗`);
            return '';
        }
        if (!key.trim()) {
            warn('LLM_API_KEY_FILE 是空的，AI 任務會失敗');
            return '';
        }
    }
    // 空白與換行只去頭尾。中間還有的話，代表檔案裡不只一行（多把 key、或 .env 格式）：
    // 猜不出哪一段才是 key，黏在一起的話每個請求都會 401，所以視為沒有設定
    const cleaned = key.replace(ZERO_WIDTH, '').trim();
    if (key && !cleaned) {
        warn(`${source} 只有空白或看不見的字元，AI 任務會失敗`);
        return '';
    }
    if (/\s/.test(cleaned)) {
        warn(`${source} 的內容中間有空白或換行（可能是多行或 .env 格式），只能放 key 本身，視為沒有設定 key`);
        return '';
    }
    // 「名稱=值」或「名稱: 值」（.env、YAML 的寫法）。base64 的 key 結尾的 = 是補位，不算：
    // 等號後面要有等號以外的東西才是「名稱=值」
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:=(?!=*$)|:)/.test(cleaned)) {
        warn(`${source} 看起來是「名稱=值」的格式，只能放 key 本身，視為沒有設定 key`);
        return '';
    }
    // 整個包在引號裡（從 .env 或 shell 複製過來）：引號會被當成 key 的一部分，每個請求都會 401
    if (/^(["'`]).*\1$/.test(cleaned)) {
        warn(`${source} 的內容包在引號裡，只能放 key 本身，視為沒有設定 key`);
        return '';
    }
    if (cleaned && !PRINTABLE_ASCII.test(cleaned)) {
        warn(`${source} 含有不可見或非 ASCII 的字元（檔案可能存成 UTF-16），視為沒有設定 key`);
        return '';
    }
    return cleaned;
}

function isLoopback(hostname) {
    return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

// 只取 origin。帳密不收（會被印進 log）；http 只接受本機（key 不能走明文）。
// 不合法時回傳 null（而不是退回正式站）：streamChat 會回報設定錯誤，configProblems() 也會列出。
// 警告訊息只印解析得出的 origin，不印原始字串（可能夾帶帳密）
function toUpstream(env, warn) {
    const raw = env.LLM_UPSTREAM;
    if (isUnset(raw)) return 'https://llm.winlab.tw';
    let url;
    try {
        // URL 的解析規則只去掉半形空白與控制字元；全形空白、NBSP、BOM 這類（從文件複製過來
        // 常夾帶）也要去掉，跟 isUnset 用同一套
        url = new URL(String(raw).trim());
    } catch {
        warn('設定 LLM_UPSTREAM 不是合法網址，AI 任務會失敗');
        return null;
    }
    if (url.username || url.password) {
        warn(`設定 LLM_UPSTREAM（${url.origin}）不能含帳密，AI 任務會失敗`);
        return null;
    }
    if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
        warn(`設定 LLM_UPSTREAM（${url.origin}）用 http 只允許本機，key 不能走明文，AI 任務會失敗`);
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        warn(`設定 LLM_UPSTREAM 的協定 ${url.protocol} 不支援，AI 任務會失敗`);
        return null;
    }
    // 請求一律送到 origin 的 /v1/chat/completions，網址上的其他部分不會被用到
    if (url.pathname !== '/' || url.search || url.hash) {
        warn(`設定 LLM_UPSTREAM 只取 origin（${url.origin}），路徑與參數會被忽略`);
    }
    return url.origin;
}

/**
 * 這份設定還缺什麼才能接任務。空陣列代表可以；HTTP 服務的 readiness 檢查用它決定回不回報
 * 就緒。key 或上游網址設錯時不退回預設值，就是靠這裡讓 k3s 不把流量導進來。
 */
export function configProblems(config) {
    const problems = [];
    if (!config.apiKey) problems.push('missing-api-key');
    if (!config.upstream) problems.push('invalid-upstream');
    return problems;
}

export function loadLlmConfig(env = process.env, { warn = (msg) => console.warn(msg) } = {}) {
    return {
        upstream: toUpstream(env, warn),
        apiKey: readApiKey(env, warn),
        model: (env.LLM_MODEL || '').trim() || 'qwen3.8-27b-fp8',
        reasoningEffort: toEffort(env, 'LLM_REASONING_EFFORT', 'xhigh', warn),
        continuationEffort: toEffort(env, 'LLM_CONTINUATION_EFFORT', 'none', warn),
        // 一定要送 max_tokens：不送的話 WinLab 閘道預設只給 2048，思考完答案就被截斷
        // （ahp-match 實際踩過）
        maxTokens: toInt(env, 'LLM_MAX_TOKENS', WINLAB_MAX_TOKENS, 1, WINLAB_MAX_TOKENS, warn),
        contextTokens: toInt(env, 'LLM_CONTEXT_TOKENS', 32_768, 4_096, 1_048_576, warn),
        maxRounds: toInt(env, 'LLM_MAX_ROUNDS', 3, 1, 8, warn),
        // setTimeout 最多 2^31-1 毫秒，超過會變成馬上觸發
        taskTimeoutMs: toInt(env, 'LLM_TASK_TIMEOUT_MS', 900_000, 10_000, 2_147_483_647, warn),
        idleTimeoutMs: toInt(env, 'LLM_IDLE_TIMEOUT_MS', 180_000, 1_000, MAX_IDLE_TIMEOUT_MS, warn),
    };
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

// 被略過的 origin 與代理位址不是祕密，警告裡要看得出是哪一項：原樣顯示設定值（只限可見的
// ASCII、最多 80 字；含帳密時帳密換成 ***），其他照 shown()
function shownOrigin(raw, url) {
    if (url && (url.username || url.password)) {
        return JSON.stringify(`${url.protocol}//***@${url.host}${url.pathname === '/' ? '' : url.pathname}`.slice(0, 80));
    }
    return /^[\x21-\x7E]{1,80}$/.test(raw) ? JSON.stringify(raw) : shown(raw);
}
const shownAddress = (raw) => (/^[0-9a-fA-F.:/]{1,43}$/.test(raw) ? JSON.stringify(raw) : shown(raw));

// origin 必須是 scheme://host[:port]，不能有路徑：瀏覽器送的 Origin 標頭就是這個格式，
// 多寫了 /sch001-108platform 的話永遠比對不到（GitHub Pages 專案路徑不屬於 origin）。
// 比對前一律正規化成 new URL(v).origin：大寫的主機名稱、寫明的預設埠（:443）、中文網域
// 都會變成瀏覽器實際送出的樣子。只收 https（本機開發可用 http://localhost）；萬用字元與
// 結尾帶點的主機名稱永遠不會等於瀏覽器送來的 Origin，寫了等於沒寫，一律略過並警告
function toOrigins(env, name, fallback, warn) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const origins = [];
    for (const item of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
        let url;
        try {
            url = new URL(item);
        } catch {
            url = null;
        }
        const bare = url && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
        const secure = url && (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)));
        if (!bare || !secure || url.hostname.includes('*') || url.hostname.endsWith('.')) {
            warn(`設定 ${name} 的 ${shownOrigin(item, url)} 不是可用的 origin（要像 https://thc1006.github.io，不含路徑），已略過`);
            continue;
        }
        if (!origins.includes(url.origin)) origins.push(url.origin);
    }
    if (origins.length === 0) {
        warn(`設定 ${name} 沒有任何合法的 origin，改用預設值 ${fallback.join(',')}`);
        return fallback;
    }
    return origins;
}

// 信任的代理：逗號分隔的 IPv4 位址或 CIDR。寫錯的那一項略過並警告（createProxyMatcher 會再驗一次）
function toCidrs(env, name, warn) {
    const cidrs = [];
    for (const item of String(env[name] || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(item);
        if (m && m.slice(1, 5).every((p) => Number(p) <= 255) && (m[5] === undefined || Number(m[5]) <= 32)) {
            cidrs.push(m[5] === undefined ? `${item}/32` : item);
            // /0 等於信任所有來源：任何人都能自己填 CLIENT_IP_HEADER，換一個值就繞過限流
            if (Number(m[5]) === 0) warn(`設定 ${name} 的 ${shownAddress(item)} 等於信任所有來源，任何人都能偽造用戶端 IP`);
        } else {
            warn(`設定 ${name} 的 ${shownAddress(item)} 不是 IPv4 位址或 CIDR，已略過`);
        }
    }
    return cidrs;
}

/**
 * HTTP 服務的設定（server.mjs 用）：
 *
 *   PORT                  監聽埠（預設 8787；0 代表由系統挑一個空的埠，START log 會印出實際的埠）
 *   HOST                  綁定位址（預設 127.0.0.1；k3s 的 manifest 設 0.0.0.0）
 *   ALLOWED_ORIGINS       允許呼叫的網站，逗號分隔（預設 https://thc1006.github.io）
 *   CLIENT_IP_HEADER      由哪個標頭取得用戶端 IP（預設不用，看連線來源）。Tailscale Funnel
 *                         用 x-forwarded-for：它會把這個標頭覆寫成真實來源
 *   TRUSTED_PROXIES       只有連線來自這些 IPv4 位址／CIDR 時才採用上面的標頭（逗號分隔）；
 *                         沒設的話標頭一律不採用，因為直接連進來的人自己填的值不能信。
 *                         信任的是位址：同一個位址連進來的其他程式（k3s 上的主機與 hostNetwork
 *                         pod）送的標頭也會被採信
 *   LLM_CONCURRENCY       同時進行的任務數（預設 4，上限 8 = key 的並行上限）
 *   LLM_MAX_QUEUE         最多排幾個（預設 8）
 *   QUEUE_TIMEOUT_MS      最多排多久（預設 240000 = 4 分鐘）。WinLab 忙的時候，進行中的任務光等
 *                         第一個位元組就要一兩分鐘，排隊的人要等得比這久才輪得到
 *   RATE_LIMIT_WINDOW_MS  每個來源的計數窗口（預設 600000 = 10 分鐘）
 *   RATE_LIMIT_MAX        每個來源在窗口內最多開始幾個任務（預設 100）。學校的整間教室、甚至
 *                         整個學校共用一個對外 IP，這個數字是整個網路一起用的；沒用到 GPU 的
 *                         請求（排隊已滿、排到逾時、排隊中離開，或上游在第一個 token 之前就回
 *                         忙線、連不上、逾時，或回了錯誤頁、看不懂的串流）不計
 *   REQUEST_LIMIT_PER_MINUTE 每個來源每分鐘最多送幾個任務請求，不論成敗（預設 120）。在讀 body
 *                         之前就檢查：驗證失敗的請求不計入上面的次數，沒有這一道的話，連續送
 *                         超大的錯誤請求就能把 CPU 吃滿
 *   CLIENT_MAX_INFLIGHT   名額已滿時，每個來源最多佔用幾個（含排隊；預設 6）
 *   BODY_TIMEOUT_MS       收完請求 body 的期限（預設 10000）。body 最多十幾 KB，慢慢上傳的連線
 *                         佔著記憶體，不必等太久。Node 自己的 requestTimeout 在開始關機之後就
 *                         不再檢查，這個期限由閘道自己計時
 *   HEARTBEAT_MS          SSE 心跳間隔（預設 15000，上限 30000）。前端（public/shared/platform-ai.js
 *                         的 IDLE_TIMEOUT_MS）連續 60 秒沒收到任何位元組就當成斷線，心跳一放慢，
 *                         正常進行中的任務就會被當成斷線；兩邊要一起改
 *   SHUTDOWN_GRACE_MS     關機時等進行中任務的上限（預設 900000 = 15 分鐘）。要不小於 LLM_TASK_TIMEOUT_MS：
 *                         換版時進行中的任務才做得完，不會做到一半被中止（WinLab 忙的時候第一個位元組
 *                         要等 80 秒以上，3 輪最壞約 13 分鐘）。k3s 的 terminationGracePeriodSeconds 要比它
 *                         再多出 preStop 與收尾的時間（中止後送出錯誤 1 秒、等上傳中的請求最多 5 秒）
 *   LOG_LEVEL             error／warn／info／debug（預設 info）
 */
export function loadServerConfig(env = process.env, { warn = (msg) => console.warn(msg) } = {}) {
    let logLevel = String(env.LOG_LEVEL || 'info').trim().toLowerCase();
    if (!LOG_LEVELS.includes(logLevel)) {
        warn(`設定 LOG_LEVEL=${shown(env.LOG_LEVEL)} 不合法（只有 ${LOG_LEVELS.join('／')}），改用 info`);
        logLevel = 'info';
    }
    const header = String(env.CLIENT_IP_HEADER || '').trim().toLowerCase();
    const clientIpHeader = /^[a-z0-9-]+$/.test(header) ? header : '';
    if (header && !clientIpHeader) warn(`設定 CLIENT_IP_HEADER=${shown(header)} 不是合法的標頭名稱，改看連線來源`);
    const trustedProxies = toCidrs(env, 'TRUSTED_PROXIES', warn);
    if (clientIpHeader && trustedProxies.length === 0) {
        warn('設定了 CLIENT_IP_HEADER 卻沒有 TRUSTED_PROXIES：標頭一律不採用，限流改看連線來源');
    }
    if (!clientIpHeader && trustedProxies.length > 0) {
        warn('設定了 TRUSTED_PROXIES 卻沒有 CLIENT_IP_HEADER：不會從標頭取用戶端 IP，所有經過代理的人共用代理的 IP 計數');
    }
    return {
        port: toInt(env, 'PORT', 8787, 0, 65535, warn),
        host: String(env.HOST || '').trim() || '127.0.0.1',
        allowedOrigins: toOrigins(env, 'ALLOWED_ORIGINS', ['https://thc1006.github.io'], warn),
        clientIpHeader,
        trustedProxies,
        concurrency: toInt(env, 'LLM_CONCURRENCY', 4, 1, 8, warn),
        maxQueue: toInt(env, 'LLM_MAX_QUEUE', 8, 0, 1000, warn),
        queueTimeoutMs: toInt(env, 'QUEUE_TIMEOUT_MS', 240_000, 1_000, 2_147_483_647, warn),
        rateLimitWindowMs: toInt(env, 'RATE_LIMIT_WINDOW_MS', 600_000, 1_000, 2_147_483_647, warn),
        // 每筆紀錄是一個時間戳；上限太大等於讓單一來源佔掉可觀的記憶體
        rateLimitMax: toInt(env, 'RATE_LIMIT_MAX', 100, 1, 1_000, warn),
        requestLimitPerMinute: toInt(env, 'REQUEST_LIMIT_PER_MINUTE', 120, 10, 10_000, warn),
        clientMaxInflight: toInt(env, 'CLIENT_MAX_INFLIGHT', 6, 1, 64, warn),
        bodyTimeoutMs: toInt(env, 'BODY_TIMEOUT_MS', 10_000, 1_000, 120_000, warn),
        heartbeatMs: toInt(env, 'HEARTBEAT_MS', 15_000, 1_000, 30_000, warn),
        shutdownGraceMs: toInt(env, 'SHUTDOWN_GRACE_MS', 900_000, 0, 2_147_483_647, warn),
        logLevel,
    };
}
