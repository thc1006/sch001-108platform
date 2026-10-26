#!/usr/bin/env node
/**
 * AI 閘道的 HTTP 服務：網站的瀏覽器跨網域呼叫 POST /v1/tasks/<id>，這裡驗證、排隊、
 * 呼叫 WinLab（必要時自動續寫），再用 SSE 把進度與結果串回去。
 *
 * 端點：
 *   POST    /v1/tasks/<id>   body: {"input": {...}}；回應 text/event-stream（見下）
 *   OPTIONS /v1/tasks/<id>   CORS 預檢
 *   GET     /healthz         程序活著就 200（liveness）
 *   GET     /readyz          有 key、上游設定合法、沒在關機就 200，否則 503（readiness）
 *
 * SSE 事件（每個 data 都是一行 JSON）：
 *   accepted  { requestId, task }
 *   progress  { phase: queued|started|thinking|writing|continuing|retrying, position?, round?, attempt?, delayMs?, ... }
 *             started 只在排過隊的任務輪到時送一次：之後到第一個 token 之前可能還要等上游一兩分鐘
 *   delta     { text }                    只有文字任務：正文片段（只供即時顯示，以 done.result 為準）
 *   done      { result, rounds, continuations, usage, elapsedMs }
 *   error     { code, message, retryable, retryAfter? }
 * 串流正常會以一個 done 或 error 結束。收不到的情況：用戶端自己離開、用戶端不把資料收走
 * 而被斷線（MAX_PENDING_BYTES、DRAIN_TIMEOUT_MS）、程序被強制結束（第二次 SIGTERM、SIGKILL）、
 * 閘道本身的程式錯誤。前端要把「沒收到 done 或 error 就結束的串流」當成可以重試的中斷。
 *
 * 開始串流之前的拒絕一律回 JSON：{"error": {code, message, requestId, ...}}。
 *
 * 為什麼全程用 SSE：xhigh 一個任務可能要好幾十秒，有進度可看使用者才不會以為當掉；
 * 中途的代理（通道）多半有閒置逾時，持續有位元組流過（含心跳）連線才不會被砍。
 * SSE 一律不壓縮：ahp-match 實測 gzip 過的 SSE 經過 ngrok 會被吃成 0 byte。
 */
import { createServer } from 'node:http';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadLlmConfig, loadServerConfig, configProblems } from './config.mjs';
import { generate, GenerationError, parseContextOverflow } from './generate.mjs';
import { UpstreamError } from './upstream.mjs';
import { SlotGate, ClientLimiter, LimitError, clientKey, createProxyMatcher } from './limits.mjs';
import { createCatalog, validateInput, buildMessages, finalizeOutput, inputByteLimit, TaskError } from './tasks.mjs';
import { createTraditionalStream } from './s2t.mjs';

// 進度事件最多每 500ms 一次；階段改變時立刻送
const PROGRESS_INTERVAL_MS = 500;
// 關機時把進行中的任務中止之後，等它們把 error 事件送出去的時間
const SHUTDOWN_FLUSH_MS = 1_000;
// 關機時已經收到、還沒回應的請求（多半還在上傳 body），最多等這麼久讓它們拿到 503
const REQUEST_WAIT_MS = 5_000;
// 回應寫完之後，用戶端遲遲不把資料收走（不讀的連線），最多再等這麼久就斷開
const DRAIN_TIMEOUT_MS = 30_000;
// 生成期間用戶端不把資料收走：待送的資料超過這麼多，或 write() 回 false 之後這麼久都沒有 drain，
// 就中止上游並關掉連線。模型一秒只寫幾十個 token，正常的用戶端收得比它快，待送量接近 0；
// 不設限的話，不讀的連線會讓整份回答（累計上限見 generate.mjs）都排在記憶體裡
const MAX_PENDING_BYTES = 1024 * 1024;
const STALL_TIMEOUT_MS = 30_000;
// 用戶端 IP 標頭只看最後這麼多個字元：最右邊的值就在最後面，前面再長都與我們無關
const MAX_IP_HEADER_CHARS = 256;
// 信任的代理沒送用戶端 IP 時的警告，最多每分鐘一次
const CLIENT_IP_WARN_INTERVAL_MS = 60_000;
// 不論成敗、所有到達的任務請求的計數窗口（上限是 cfg.requestLimitPerMinute）
const ARRIVAL_WINDOW_MS = 60_000;
// 合法的 body 是 {"input": {"欄位": "字串"}}，只有兩層。JSON.parse 處理深層巢狀很貴
// （29 萬 bytes 的巢狀陣列約 20ms），先線性掃一次，超過這個深度就不解析
const MAX_BODY_DEPTH = 3;
// Node 檢查 headersTimeout／requestTimeout 的間隔。預設 30 秒，設定的逾時實際上要多等最多
// 30 秒才生效（2026-10-22 實測：20 秒的標頭期限 30 秒才切、30 秒的 body 期限 60 秒才切）
const CONNECTIONS_CHECK_MS = 5_000;
// 同時在收 body 的任務請求上限，超過就立刻 503 並關掉連線。Funnel 收完標頭就轉送，body 邊收邊送，
// 慢慢上傳的連線每條約 50 KiB。依記憶體選：2026-10-22 在 256 MiB 的 cgroup 裡持續灌慢速上傳，
// RSS 最高 162 MiB（上限 2000 時 204 MiB）。滿了新任務一律 503，取捨見 README 的「資源上限」
const MAX_BODY_READS = 1000;
// 連線數的最後防線（net.Server 的 maxConnections：到了上限，新連線直接關掉）。比 MAX_BODY_READS
// 大，留給進行中的 SSE、閒置的 keep-alive 與還在送標頭的連線
const MAX_CONNECTIONS = 2048;
// 標頭上限。任務請求的標頭只有幾個欄位，Node 預設的 16 KiB 只會讓每條慢連線多佔記憶體
const MAX_HEADER_BYTES = 8 * 1024;

// 給學生看的錯誤訊息。code 是穩定的代號，前端可以依代號另外處理；
// 建議等待的秒數由前端依 retryAfter 自己補上，這裡不寫死時間
const MESSAGES = {
    busy: '目前使用的人比較多，請稍後再試。',
    // 次數是依對外 IP 計的，整間學校常共用一個：只按了一次的學生也可能看到這個訊息
    rate_limited: '同一個網路（例如學校）的使用次數已達上限，請稍後再試。',
    too_many_inflight: '你所在的網路（例如學校）目前已有多個任務在進行或排隊，請等前面的完成後再試。',
    request_timeout: '傳送內容花了太久，請檢查網路後再試一次。',
    timeout: 'AI 思考的時間超過上限了，請稍後再試，或把內容寫得更具體一些。',
    incomplete: 'AI 的回答太長，沒能在時限內寫完。請把問題縮小一點再試。',
    // 同樣是 incomplete，原因是接續的幾輪都沒有進展（generate 的 stalled），不是回答太長
    stalled: 'AI 這次沒能把回答寫完，可以再試一次。',
    format: 'AI 回覆的格式不正確，請再試一次。',
    empty: 'AI 沒有產生內容，請換個說法再試一次。',
    unavailable: 'AI 服務暫時無法使用，請稍後再試。',
    restarting: 'AI 服務正在更新，請稍後再試一次。',
    not_ready: 'AI 服務正在啟動或維護中，請稍後再試。',
    internal: 'AI 服務發生錯誤，請稍後再試。',
};

const LEVELS = ['error', 'warn', 'info', 'debug'];
// JSON.stringify 不會跳脫的「看不見、會改變顯示或斷行」的字元：C1 控制字元（含 NEL）、
// 軟連字號、零寬與雙向控制字元、行段分隔符、BOM。不跳脫的話，log 檢視工具可能把一行
// 拆成好幾行，或把後面的欄位顛倒顯示
const LOG_UNSAFE = /[\u007f-\u009f\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/g;

/**
 * 一行一筆：「時間 級別 標籤 key=value …」，跟 ahp-match 的 log 一樣好 grep。
 * 值含空白、引號、等號或控制字元時以 JSON 字串輸出，log 不會被使用者輸入改版面。
 * 不記使用者輸入的內容，只記長度、代號與用量。
 */
export function createLogger(level = 'info', write = (line) => process.stdout.write(`${line}\n`)) {
    const max = LEVELS.indexOf(level);
    const format = (value) => {
        const text = String(value);
        if (/^[\w.:/@,+-]+$/.test(text)) return text;
        return JSON.stringify(text).replace(LOG_UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    };
    return (lvl, tag, fields = {}) => {
        if (LEVELS.indexOf(lvl) > max) return;
        const parts = [new Date().toISOString(), lvl, tag];
        for (const [key, value] of Object.entries(fields)) {
            if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${format(value)}`);
        }
        write(parts.join(' '));
    };
}

function isJsonContentType(value) {
    return /^application\/json\s*(;|$)/i.test(String(value || ''));
}

// Node 的錯誤代碼（ERR_STREAM_WRITE_AFTER_END、ECONNRESET）
const NODE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * describeInternal 給程式錯誤寫 log：只有種類、Node 的錯誤代碼與呼叫堆疊，不含訊息。V8 的訊息
 * 可能夾帶字串的值（Cannot create property 'x' on string '…'），那可能是學生的輸入或模型的輸出。
 * 任何值都能描述，Object.create(null) 這類 String() 會丟例外的也行。
 * @param {unknown} value @returns {string}
 */
function describeInternal(value) {
    try {
        if (!(value instanceof Error)) return Object.prototype.toString.call(value);
        const code = NODE_ERROR_CODE.test(value.code) ? `(${value.code})` : '';
        // 先跳過訊息佔的行數：訊息裡的字串值也可能有一行以「    at 」開頭
        const lines = String(value.stack).split('\n').slice(String(value.message).split('\n').length);
        const frames = lines.filter((line) => /^\s+at /.test(line)).map((line) => line.trim());
        return [`${value.name}${code}`, ...frames].join(' ');
    } catch {
        return Object.prototype.toString.call(value);
    }
}

/**
 * upstreamLogFields 回傳 UPSTREAM-ERR 要記的欄位。上游的錯誤內容可能照抄學生的輸入，原文只留在
 * 錯誤的 detail 給 generate 判斷 context 長度；這裡只記閘道自己的代號與說明、HTTP 狀態、
 * 只收固定形狀的上游代號（見 upstream.mjs 的 upstreamToken），以及解析出來的數字。
 * @param {object} err @returns {object}
 */
function upstreamLogFields(err) {
    const overflow = parseContextOverflow(err);
    return {
        code: err.code,
        status: err.status,
        reason: err.message,
        upstreamId: err.upstreamId,
        upstreamType: err.upstreamType,
        upstreamCode: err.upstreamCode,
        upstreamParam: err.upstreamParam,
        mediaType: err.mediaType,
        bodyLength: err.bodyLength,
        bodyStart: err.bodyStart,
        retryAfter: err.retryAfter,
        contextLimit: overflow?.limit,
        inputTokens: overflow?.exact,
        inputAtLeast: overflow?.atLeast,
    };
}

class HttpError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

// 上傳 body 的途中連線就斷了：沒有人可以回應了。serverTimeout 代表其實是 Node 自己的
// requestTimeout 到了（它已經回了 408 並關掉連線）：log 要記成 408，而不是用戶端離開的 499
class ClientGone extends Error {
    constructor(serverTimeout) {
        super(serverTimeout ? '收 body 逾時（Node 的 requestTimeout）' : '上傳途中斷線');
        this.serverTimeout = serverTimeout;
    }
}

// 請求帶著 body、而且還沒收完。不能只看 req.complete：沒有 body 的 GET 在處理當下
// complete 也還是 false，那樣連健康檢查都會把 keep-alive 連線關掉
function hasUnreadBody(req) {
    if (req.complete) return false;
    const length = req.headers['content-length'];
    return req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
}

// timeoutMs：收完 body 的期限，自己計時。Node 的 requestTimeout 在 server.close() 之後就不再
// 檢查，而關機的寬限期（SHUTDOWN_GRACE_MS）預設長達 15 分鐘
function readBody(req, limit, timeoutMs) {
    return new Promise((resolve, reject) => {
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
            reject(new HttpError(413, 'payload_too_large', '請求內容太大'));
            return;
        }
        let size = 0;
        const chunks = [];
        let settled = false;
        let timer;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            chunks.length = 0;
            reject(err);
        };
        timer = setTimeout(() => fail(new HttpError(408, 'request_timeout', MESSAGES.request_timeout)), timeoutMs);
        req.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                fail(new HttpError(413, 'payload_too_large', '請求內容太大'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', () => fail(new ClientGone(req.socket?.errored?.code === 'ERR_HTTP_REQUEST_TIMEOUT')));
    });
}

// 巢狀深度是否超過 limit：線性掃一次，略過字串內容（字串裡的括號不算）
function exceedsDepth(text, limit) {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (inString) {
            if (c === 0x5c) i++; // 反斜線：下一個字元是跳脫的一部分
            else if (c === 0x22) inString = false;
        } else if (c === 0x22) {
            inString = true;
        } else if (c === 0x7b || c === 0x5b) {
            if (++depth > limit) return true;
        } else if (c === 0x7d || c === 0x5d) {
            depth--;
        }
    }
    return false;
}

// body 只能是 {"input": …}：多出來的頂層鍵（前端寫錯也好、塞垃圾也好）一律拒絕
function isInputEnvelope(body) {
    return body !== null && typeof body === 'object' && !Array.isArray(body)
        && Object.keys(body).length === 1 && Object.hasOwn(body, 'input');
}

// 關機時中止任務用的 reason：catch 裡據此分辨「我們要關機」與「用戶端自己離開」
const SHUTDOWN = new Error('閘道正在關機');
// 用戶端不把資料收走時中止任務用的 reason（見 MAX_PENDING_BYTES）
const CLIENT_STALLED = new Error('用戶端不收資料');

// 任務的總時限到了（GenerationError），或上游逾時（UpstreamError：太久沒送任何資料，或回了 408、504）。
function isTimeout(err) {
    return (err instanceof GenerationError || err instanceof UpstreamError) && err.code === 'timeout';
}

/**
 * 把各層的錯誤翻成給前端的 { code, retryable, retryAfter } 與給 log 的細節。
 * auth、misconfigured 這類是我們這邊的設定問題：對學生一律說「暫時無法使用」，
 * 狀態碼與上游的錯誤代號只進 log（見 upstreamLogFields）。
 * 取消（用戶端離開、關機）不經過這裡：呼叫端先看自己的 signal 判斷。
 * tokensSeen 表示上游已經送來過思考或正文。
 */
function describeError(err, { tokensSeen = true } = {}) {
    if (err instanceof LimitError) {
        return { code: 'busy', retryable: true, retryAfter: err.retryAfter };
    }
    // 上游要求等待的時間太長（超過在請求裡等的上限或任務剩下的時限），generate 沒有重試：照忙線回報，
    // 轉告上游要求的秒數
    if (err instanceof GenerationError && err.retryAfter !== undefined) {
        const upstream = err.cause instanceof UpstreamError ? err.cause : undefined;
        return { code: 'busy', retryable: true, retryAfter: Math.max(1, err.retryAfter), upstream };
    }
    // 第一個 token 之前就逾時，是 WinLab 忙到還沒開始處理，跟學生寫了什麼無關：說忙線，不叫他改寫內容。
    // 上游自己回了 408、504 的，log 照樣記狀態碼與上游的錯誤代號；其他是閘道的時限先到，註明一個 token 都沒收到。
    if (!tokensSeen && isTimeout(err)) {
        const upstream = err.status ? err : { code: 'timeout', message: `${err.message}，還沒收到任何 token` };
        return { code: 'busy', retryable: true, retryAfter: 30, upstream };
    }
    if (err instanceof UpstreamError) {
        // Retry-After: 0 原樣傳下去的話，前端會立刻重打
        if (err.code === 'busy') return { code: 'busy', retryable: true, retryAfter: Math.max(1, err.retryAfter ?? 30), upstream: err };
        if (err.code === 'timeout') return { code: 'timeout', retryable: true, upstream: err };
        return { code: 'unavailable', retryable: err.retryable, upstream: err };
    }
    if (err instanceof GenerationError) {
        if (err.code === 'timeout') return { code: 'timeout', retryable: true };
        if (err.code === 'incomplete') {
            return err.stalled
                ? { code: 'incomplete', message: MESSAGES.stalled, retryable: true, detail: err.message }
                : { code: 'incomplete', retryable: false, detail: err.message };
        }
        if (err.code === 'empty') return { code: 'empty', retryable: true };
        if (err.code === 'format') return { code: 'format', retryable: true, detail: err.message };
        return { code: 'unavailable', retryable: true, detail: err.message };
    }
    if (err instanceof TaskError) {
        return { code: err.code === 'empty' ? 'empty' : 'format', retryable: true, detail: err.detail };
    }
    return { code: 'internal', retryable: true, detail: describeInternal(err) };
}

// generate 收下 JSON 的標準跟交出前的 finalizeOutput 一樣（見 generate 的 acceptJson）。
// 不收時回傳不合格的來源、路徑與規則代號，generate 交回 onReject 記 log
function acceptsJson(task, content) {
    try {
        finalizeOutput(task, content);
        return true;
    } catch (err) {
        if (err instanceof TaskError) return { source: err.source, path: err.path, rule: err.rule };
        throw err;
    }
}

// JSON-REJECT 的欄位再以形狀把關一次。路徑本來就只有規格裡的名稱與索引（schema.mjs 的 SchemaMismatch）
const REJECT_SOURCES = new Set(['schema', 'check', 'parse']);
const REJECT_RULE = /^[A-Za-z_]{1,32}$/;
const REJECT_PATH = /^\$\S{0,255}$/;
function rejectLogFields(reason) {
    const { source, path, rule } = reason && typeof reason === 'object' ? reason : {};
    const shaped = (value, re) => (typeof value === 'string' && re.test(value) ? value : undefined);
    return { source: REJECT_SOURCES.has(source) ? source : undefined, path: shaped(path, REJECT_PATH), rule: shaped(rule, REJECT_RULE) };
}

/**
 * 建立閘道（不開始 listen）。測試可以注入 tasks 與 generateImpl。
 *
 * @param {object} options
 * @param {object} options.llm        loadLlmConfig() 的結果
 * @param {object} options.server     loadServerConfig() 的結果
 * @param {Map}    options.tasks      createCatalog() 的結果
 * @param {Function} [options.generateImpl]
 * @param {Function} [options.log]    createLogger() 的結果
 * @param {Function} [options.now]    單調時鐘（毫秒），限流與警告的頻率用；測試可以注入
 * @param {number} [options.maxBodyReads]  同時在收 body 的請求上限；測試可以調小
 * @param {number} [options.maxPendingBytes]  生成期間待送資料的上限；測試可以調小
 * @param {number} [options.stallTimeoutMs]   write() 回 false 之後等 drain 的時限；測試可以調短
 */
export function createGateway({
    llm, server: cfg, tasks, generateImpl = generate, log = createLogger(cfg.logLevel), now = () => performance.now(),
    maxBodyReads = MAX_BODY_READS, maxPendingBytes = MAX_PENDING_BYTES, stallTimeoutMs = STALL_TIMEOUT_MS,
}) {
    const gate = new SlotGate({
        concurrency: cfg.concurrency,
        maxQueue: cfg.maxQueue,
        queueTimeoutMs: cfg.queueTimeoutMs,
    });
    const limiter = new ClientLimiter({
        windowMs: cfg.rateLimitWindowMs,
        max: cfg.rateLimitMax,
        maxInflight: cfg.clientMaxInflight,
        now,
    });
    // 不論成敗、所有到達的任務請求的寬鬆計數，在讀 body 之前檢查。上面的 limiter 只計真正
    // 開始的任務，驗證失敗的請求不計次；少了這一道，連續送超大的錯誤請求就能把 CPU 吃滿
    const arrivals = new ClientLimiter({
        windowMs: ARRIVAL_WINDOW_MS,
        max: cfg.requestLimitPerMinute,
        maxInflight: Infinity,
        now,
    });
    const trustedProxy = createProxyMatcher(cfg.trustedProxies || []);
    // 內部位址（代理、節點）可以原樣進 log；其他位址可能是用戶端，只記雜湊
    const internalAddress = createProxyMatcher(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '127.0.0.0/8']);
    const sweepTimer = setInterval(() => {
        limiter.sweep();
        arrivals.sweep();
    }, Math.min(cfg.rateLimitWindowMs, ARRIVAL_WINDOW_MS));
    sweepTimer.unref();
    // 用戶端在 log 裡只出現雜湊：同一個程序內可以關聯同一個來源，又反推不回 IP
    const salt = randomBytes(16);
    const clientTag = (key) => createHash('sha256').update(salt).update(key).digest('hex').slice(0, 10);
    // 從拿到用戶端名額起、到回應的連線關閉為止的每個請求
    const active = new Set();
    // 每個已經收到、還沒回應完的請求（不只任務）：關機時限時等它們拿到回應，見 close()
    const unanswered = new Set();
    let draining = false;
    let closing = null;
    // 信任的代理沒送用戶端 IP、不信任的來源卻帶了這個標頭：各自的次數（從上一次警告之後）與上一次警告的時間
    const clientIpWarnings = {
        missing: { tag: 'CLIENT-IP-MISSING', count: 0, warnedAt: -Infinity },
        untrusted: { tag: 'CLIENT-IP-UNTRUSTED', count: 0, warnedAt: -Infinity },
    };
    // 正在收 body 的任務請求數（見 MAX_BODY_READS）
    let bodyReads = 0;

    function onRequest(req, res) {
        const answered = new Promise((resolve) => res.once('close', resolve));
        unanswered.add(answered);
        answered.then(() => unanswered.delete(answered));
        route(req, res).catch((err) => {
            log('error', 'UNHANDLED', { method: req.method, path: req.url?.split('?')[0], error: describeInternal(err) });
            if (!res.headersSent) {
                sendJson(req, res, 500, { error: { code: 'internal', message: MESSAGES.internal } }, corsHeaders(req));
            } else {
                res.destroy();
            }
        });
    }
    const server = createServer({ connectionsCheckingInterval: CONNECTIONS_CHECK_MS, maxHeaderSize: MAX_HEADER_BYTES }, onRequest);
    server.maxConnections = MAX_CONNECTIONS;
    // Expect: 100-continue：不讓 Node 自動回 100 Continue（那等於請對方先把整個 body 送過來），
    // 等提早的檢查（origin、任務、格式、限流）都過了、真的要讀 body 時才回
    server.on('checkContinue', onRequest);
    // body 只有幾 KB：慢慢上傳的連線不必等到預設的 5 分鐘。回應（SSE）不受這兩個限制。
    // 任務請求的 body 另有閘道自己計時的期限（cfg.bodyTimeoutMs，回 JSON 的 408 並帶 CORS），
    // requestTimeout 只是其他路徑的最後防線：設得比「標頭期限 + body 期限」長，正常輪不到它
    server.headersTimeout = 20_000;
    server.requestTimeout = server.headersTimeout + cfg.bodyTimeoutMs + 10_000;

    function allowedOrigin(req) {
        const origin = req.headers.origin;
        return origin && cfg.allowedOrigins.includes(origin) ? origin : null;
    }

    function corsHeaders(req) {
        const origin = allowedOrigin(req);
        return origin
            ? { 'access-control-allow-origin': origin, 'access-control-expose-headers': 'X-Request-Id, Retry-After', vary: 'Origin' }
            : { vary: 'Origin' };
    }

    /**
     * 用戶端的限流鍵（見 limits.mjs 的 clientKey）。只有連線來自信任的代理（TRUSTED_PROXIES，
     * 例如把 Funnel 流量轉進來的那一跳）時才看 CLIENT_IP_HEADER，而且只取最右邊、必須是合法
     * 的位址（ip:port、[v6]:port 的寫法也收）：那是代理自己看到的來源，左邊的都可能是用戶端
     * 自己填的。直接連進來的人填這個標頭沒有用，否則每次換一個值就能繞過限流，或塞超長的值
     * 把限流表撐爆。要注意 TRUSTED_PROXIES 涵蓋的是一個位址，不是一支程式：k3s 上主機本身與
     * hostNetwork 的 pod 連進來時，來源也是那個位址（見 deploy/k3s/app.yaml）
     */
    function clientKeyOf(req) {
        const peer = req.socket.remoteAddress || '';
        if (cfg.clientIpHeader && trustedProxy(peer)) {
            const raw = req.headers[cfg.clientIpHeader];
            const value = Array.isArray(raw) ? raw.at(-1) : raw;
            const last = typeof value === 'string' ? value.slice(-MAX_IP_HEADER_CHARS).split(',').at(-1).trim() : '';
            const key = clientKey(last);
            if (key !== 'invalid') return key;
            noteClientIpProblem('missing');
        } else if (cfg.clientIpHeader && req.headers[cfg.clientIpHeader] !== undefined) {
            noteClientIpProblem('untrusted', internalAddress(peer) ? clientKey(peer) : `hash:${clientTag(clientKey(peer))}`);
        }
        return clientKey(peer);
    }

    // 兩種情況都只能退回連線的位址，等於所有經過代理的人共用一個桶（全站加起來每個窗口只剩
    // RATE_LIMIT_MAX 次）：信任的代理沒送用戶端 IP 或送了解析不了的值（標頭名稱錯了、代理換了行為），
    // 或帶著這個標頭的連線不是來自 TRUSTED_PROXIES（節點的 pod 網段變了、轉送路徑改了）。要讓維運
    // 看得到，但不能每個請求記一筆：最多每分鐘一次，附上這段時間的次數與連線的位址
    function noteClientIpProblem(kind, peer) {
        const warning = clientIpWarnings[kind];
        warning.count++;
        const t = now();
        if (t - warning.warnedAt < CLIENT_IP_WARN_INTERVAL_MS) return;
        log('warn', warning.tag, { header: cfg.clientIpHeader, count: warning.count, ...(peer ? { peer } : {}) });
        warning.count = 0;
        warning.warnedAt = t;
    }

    // 還沒讀完的 body 不必替它讀完：直接關掉連線，免得對方一路灌到 requestTimeout。
    // 關機中也一律關：留著的話，代理會拿這條連線送下一個請求，落到這個要關的 pod
    function connectionHeader(req) {
        return draining || hasUnreadBody(req) ? { connection: 'close' } : {};
    }

    function sendJson(req, res, status, body, headers = {}) {
        headers = { ...headers, ...connectionHeader(req) };
        res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...headers,
        });
        res.end(JSON.stringify(body));
    }

    async function route(req, res) {
        const path = (req.url || '/').split('?')[0];

        if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
            sendJson(req, res, 200, { status: 'ok' });
            return;
        }
        if (path === '/readyz' && (req.method === 'GET' || req.method === 'HEAD')) {
            // 這個端點經過通道是公開的：只說狀態，不說哪裡沒設定好、目前有多少人在用
            // （原因在啟動的 START log 裡）
            const status = draining ? 'draining' : configProblems(llm).length ? 'not_ready' : 'ready';
            sendJson(req, res, status === 'ready' ? 200 : 503, { status });
            return;
        }

        const match = path.match(/^\/v1\/tasks\/([a-z][a-z0-9-]{0,63})$/);
        if (!match) {
            sendJson(req, res, 404, { error: { code: 'not_found', message: '找不到這個路徑' } });
            return;
        }
        if (req.method === 'OPTIONS') {
            preflight(req, res);
            return;
        }
        if (req.method !== 'POST') {
            sendJson(req, res, 405, { error: { code: 'method_not_allowed', message: '只接受 POST' } }, { allow: 'POST, OPTIONS' });
            return;
        }
        await runTask(req, res, match[1]);
    }

    // 只有允許的網站能過預檢；瀏覽器沒過預檢就不會送出 POST，其他網站也就無法
    // 借訪客的瀏覽器替他們消耗 GPU（application/json 的 POST 一定會先預檢）
    function preflight(req, res) {
        const origin = allowedOrigin(req);
        if (!origin) {
            sendJson(req, res, 403, { error: { code: 'origin_not_allowed', message: '這個網站不能使用 AI 服務' } }, { vary: 'Origin' });
            return;
        }
        res.writeHead(204, {
            'access-control-allow-origin': origin,
            'access-control-allow-methods': 'POST',
            'access-control-allow-headers': 'Content-Type',
            'access-control-max-age': '600',
            vary: 'Origin',
            'cache-control': 'no-store',
            ...connectionHeader(req),
        });
        res.end();
    }

    async function runTask(req, res, taskId) {
        const requestId = randomUUID();
        const started = Date.now();
        const origin = allowedOrigin(req);
        const headers = { 'x-request-id': requestId, ...corsHeaders(req) };
        const reject = (status, code, message, extra = {}, extraHeaders = {}) => {
            log(status >= 500 ? 'warn' : 'info', 'REJECT', { id: requestId, task: taskId, status, code });
            if (extra.retryAfter) extraHeaders = { ...extraHeaders, 'retry-after': String(extra.retryAfter) };
            sendJson(req, res, status, { error: { code, message, requestId, ...extra } }, { ...headers, ...extraHeaders });
        };
        // 關機中還收得到請求，只可能是沿用舊的 keep-alive 連線（新連線已經不收了），或是開始
        // 關機時還在上傳 body 的請求。回應帶 connection: close（見 connectionHeader）：
        // 代理下一次開新連線，就會落到已經就緒的新 pod
        const rejectDraining = () => reject(503, 'not_ready', MESSAGES.restarting, { retryAfter: 5 });

        // 瀏覽器跨網域的 POST 一定帶 Origin；沒有或不在名單內就拒絕（curl 可以偽造，
        // 這不是身分驗證，只是讓別的網站無法借用；真正的防線是下面的限流與排隊）
        if (!origin) return reject(403, 'origin_not_allowed', '這個網站不能使用 AI 服務');
        const task = tasks.get(taskId);
        if (!task) return reject(404, 'unknown_task', '沒有這個 AI 功能');
        if (!isJsonContentType(req.headers['content-type'])) {
            return reject(415, 'unsupported_media_type', '請求格式必須是 JSON');
        }
        if (draining) return rejectDraining();
        if (configProblems(llm).length) return reject(503, 'not_ready', MESSAGES.not_ready, { retryAfter: 30 });

        // 收 body、解析、驗證都要花主執行緒的時間，而驗證失敗的請求不計入次數上限：讀 body 之前
        // 先擋掉超量的來源（2026-10-22 實測：單一來源每秒送 33 個 28 萬字元的錯誤請求，一次都
        // 沒被計次，/healthz 從 2ms 變成 266ms～2s）
        const key = clientKeyOf(req);
        try {
            arrivals.admit(key, { wouldQueue: false }).done();
            limiter.check(key);
        } catch (err) {
            if (err instanceof LimitError) {
                return reject(429, err.code, MESSAGES[err.code] || MESSAGES.rate_limited, { retryAfter: err.retryAfter });
            }
            throw err;
        }

        if (bodyReads >= maxBodyReads) return reject(503, 'busy', MESSAGES.busy, { retryAfter: 5 });
        // 提早的檢查都過了，才請送出 Expect: 100-continue 的用戶端開始送 body
        if (/^100-continue$/i.test(req.headers.expect || '')) res.writeContinue();
        let raw;
        bodyReads++;
        try {
            raw = await readBody(req, inputByteLimit(task), cfg.bodyTimeoutMs);
        } catch (err) {
            if (err instanceof HttpError) return reject(err.status, err.code, err.message);
            if (err instanceof ClientGone) {
                log('info', 'REJECT', err.serverTimeout
                    ? { id: requestId, task: taskId, status: 408, code: 'request_timeout' }
                    : { id: requestId, task: taskId, status: 499, code: 'client_closed' });
                return undefined;
            }
            throw err;
        } finally {
            bodyReads--;
        }
        // 合法的 body 只有兩層；深層巢狀先擋下來，不交給 JSON.parse
        if (exceedsDepth(raw, MAX_BODY_DEPTH)) return reject(400, 'invalid_input', '請求格式不正確');
        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            return reject(400, 'invalid_json', '請求內容不是合法的 JSON');
        }
        if (!isInputEnvelope(body)) return reject(400, 'invalid_input', '請求格式不正確');
        let input;
        try {
            input = validateInput(task, body.input);
        } catch (err) {
            if (err instanceof TaskError) return reject(400, 'invalid_input', err.message, { field: err.field });
            throw err;
        }
        // 上傳 body 的期間開始關機
        if (draining) return rejectDraining();

        let ticket;
        try {
            ticket = limiter.admit(key, { wouldQueue: gate.saturated });
        } catch (err) {
            if (err instanceof LimitError) {
                return reject(429, err.code, MESSAGES[err.code] || MESSAGES.rate_limited, { retryAfter: err.retryAfter });
            }
            throw err;
        }

        // 從這裡開始握有用戶端名額，所有出口都要經過 finally 釋放；
        // 回應的連線關閉時才離開 active，關機流程才等得到最後一個事件真的送出去
        const abort = new AbortController();
        const handle = { abort, queued: false, done: null };
        handle.done = new Promise((resolve) => {
            res.once('close', () => {
                active.delete(handle);
                resolve();
            });
        });
        active.add(handle);
        let release = () => {};
        let heartbeat;
        let progressTimer;
        let stallTimer;
        // 判定用戶端不收資料的那一道門檻（pending 或 drain_timeout）與當時待送的位元組，記進 TASK
        let stalledBy;
        let queueMs = 0;
        let queuedAt;
        // 上游第一次回應、第一個思考 token、第一個 delta 事件的時刻，跟 total 一樣從請求進來算
        const firsts = { byte: undefined, thinking: undefined, delta: undefined };
        const since = (at) => (at === undefined ? undefined : `${at - started}ms`);
        let outcome = 'ok';
        let result;
        let failedWith;
        // 有沒有真的開始生成：沒開始的（排隊已滿、排到逾時、排隊中離開或關機）最後要退回次數
        let generationStarted = false;
        // 上游送來過思考或正文沒有：第一個 token 之前就忙線、連不上或逾時的，也要退回次數
        let tokensSeen = false;
        // 回應結束前連線就斷了：使用者關分頁或按停止。立刻中止上游，不讓 GPU 白做工
        res.on('close', () => {
            if (!res.writableFinished) abort.abort();
        });

        try {
            const entry = gate.tryEnter({
                signal: abort.signal,
                onPosition: (position) => send('progress', { phase: 'queued', position }),
                key,
            });
            if (!entry) {
                outcome = 'busy';
                return reject(503, 'busy', MESSAGES.busy, { retryAfter: 30 });
            }

            res.writeHead(200, {
                ...headers,
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-store',
                'x-content-type-options': 'nosniff',
                // 請中途的 nginx 類代理不要緩衝，事件才會即時送到
                'x-accel-buffering': 'no',
            });
            req.socket.setNoDelay(true);
            send('accepted', { requestId, task: task.id });
            if (entry.queued) send('progress', { phase: 'queued', position: entry.position });
            heartbeat = setInterval(() => write(': ping\n\n'), cfg.heartbeatMs);

            handle.queued = entry.queued;
            queuedAt = Date.now();
            release = await entry.ready;
            handle.queued = false;
            queueMs = Date.now() - queuedAt;
            // 輪到的那一刻剛好開始關機（或用戶端剛好離開）：不必開始了
            abort.signal.throwIfAborted();
            if (entry.queued) send('progress', { phase: 'started' });

            let lastPhase = null;
            let lastSentAt = 0;
            let pendingProgress = null;
            const flushProgress = () => {
                progressTimer = undefined;
                if (!pendingProgress) return;
                send('progress', pendingProgress);
                lastSentAt = Date.now();
                pendingProgress = null;
            };
            const onProgress = (p) => {
                if (p.phase === 'thinking' || p.phase === 'writing') tokensSeen = true;
                if (p.phase === 'thinking') firsts.thinking ??= Date.now();
                pendingProgress = p;
                if (p.phase !== lastPhase || Date.now() - lastSentAt >= PROGRESS_INTERVAL_MS) {
                    lastPhase = p.phase;
                    clearTimeout(progressTimer);
                    flushProgress();
                } else if (!progressTimer) {
                    progressTimer = setTimeout(flushProgress, PROGRESS_INTERVAL_MS - (Date.now() - lastSentAt));
                }
            };

            // 文字任務的片段同樣先轉成台灣繁體（跟 finalizeOutput 用同一張表），送出去的片段接起來
            // 才會等於 done 的結果。轉換器記得上一段的最後一個字，切在兩段之間的字也轉得對
            const traditional = createTraditionalStream();
            const sendDelta = (text) => {
                if (!text) return;
                firsts.delta ??= Date.now();
                send('delta', { text });
            };
            generationStarted = true;
            // 任務自己的時限比較短時用它（tasks.mjs 的 timeoutMs）
            const taskLlm = task.timeoutMs < llm.taskTimeoutMs ? { ...llm, taskTimeoutMs: task.timeoutMs } : llm;
            const generated = await generateImpl(taskLlm, {
                messages: buildMessages(task, input),
                temperature: task.temperature,
                responseFormat: task.responseFormat,
                acceptJson: task.output.type === 'json' ? (content) => acceptsJson(task, content) : undefined,
            }, {
                signal: abort.signal,
                onProgress,
                onContent: task.output.type === 'markdown' ? (text) => sendDelta(traditional(text)) : undefined,
                onResponse: () => { firsts.byte ??= Date.now(); },
                onReject: ({ round, reason }) => log('info', 'JSON-REJECT', { id: requestId, task: task.id, round, ...rejectLogFields(reason) }),
            });
            clearTimeout(progressTimer);
            result = generated;
            if (task.output.type === 'markdown') {
                sendDelta(traditional.flush());
            }
            const output = finalizeOutput(task, generated.content);
            send('done', {
                result: output,
                rounds: generated.rounds,
                continuations: generated.continuations,
                usage: generated.usage,
                elapsedMs: Date.now() - started,
            });
        } catch (err) {
            failedWith = err;
            let failure;
            if (abort.signal.aborted && abort.signal.reason === SHUTDOWN) {
                // 換版時新的 pod 已經就緒，叫前端幾秒後重試即可
                failure = { code: 'unavailable', message: MESSAGES.restarting, retryable: true, retryAfter: 5 };
                outcome = 'shutdown';
            } else if (abort.signal.aborted) {
                failure = { code: 'aborted' };
                outcome = 'aborted';
            } else {
                failure = describeError(err, { tokensSeen });
                outcome = failure.code;
            }
            if (failure.upstream) {
                log('warn', 'UPSTREAM-ERR', { id: requestId, ...upstreamLogFields(failure.upstream) });
            } else if (failure.detail) {
                log(failure.code === 'internal' ? 'error' : 'warn', 'TASK-ERR', { id: requestId, code: failure.code, detail: failure.detail });
            }
            if (failure.code !== 'aborted') {
                const payload = {
                    code: failure.code,
                    message: failure.message || MESSAGES[failure.code] || MESSAGES.internal,
                    retryable: Boolean(failure.retryable),
                    retryAfter: failure.retryAfter,
                };
                if (res.headersSent) {
                    send('error', payload);
                } else if (!res.writableEnded) {
                    // 還沒開始串流就出錯（不該發生，但發生時不能讓請求永遠等不到回應）
                    sendJson(req, res, 500, { error: { ...payload, requestId } }, headers);
                }
            }
        } finally {
            clearInterval(heartbeat);
            clearTimeout(progressTimer);
            // 之後用戶端不收資料的情況交給下面的 DRAIN_TIMEOUT_MS
            clearTimeout(stallTimer);
            // 寫 done 時才發現用戶端不收的，生成雖然做完了，用戶端也沒拿到結果
            if (abort.signal.reason === CLIENT_STALLED) outcome = 'client_stalled';
            release();
            // 沒用到 GPU 的請求不算次數：尖峰時依 Retry-After 重試的整班學生，不該在負載退了之後
            // 反而被自己的重試鎖住。包括上游在第一個 token 之前就回忙線（429）、連不上或逾時的
            const upstreamRefused = failedWith instanceof UpstreamError && (failedWith.code === 'busy' || failedWith.code === 'unavailable');
            if (!generationStarted || (!tokensSeen && (upstreamRefused || isTimeout(failedWith)))) ticket.refund();
            ticket.done();
            if (res.headersSent && !res.writableEnded) res.end();
            // 用戶端不把資料收走（零視窗）時，名額已經歸還，連線與緩衝也不能無限期佔著
            if (!res.writableFinished && !res.destroyed) {
                const drainTimer = setTimeout(() => res.destroy(), DRAIN_TIMEOUT_MS);
                drainTimer.unref();
                res.once('close', () => clearTimeout(drainTimer));
            }
            // 排到逾時、排隊中離開或關機：記到這一刻為止排了多久
            if (handle.queued) queueMs = Date.now() - queuedAt;
            const usage = result?.usage ?? failedWith?.usage;
            const stats = result?.stats ?? failedWith?.stats;
            log(outcome === 'ok' ? 'info' : 'warn', 'TASK', {
                id: requestId,
                task: task.id,
                client: clientTag(key),
                outcome,
                status: outcome === 'aborted' || outcome === 'client_stalled' ? 499 : res.statusCode,
                rounds: result?.rounds ?? failedWith?.rounds,
                cont: (result?.continuations ?? failedWith?.continuations)?.join(','),
                reasoning: usage?.reasoningTokens,
                completion: usage?.completionTokens,
                prompt: usage?.promptTokens,
                queue: `${queueMs}ms`,
                total: `${Date.now() - started}ms`,
                firstByte: since(firsts.byte),
                firstThinking: since(firsts.thinking),
                firstDelta: since(firsts.delta),
                retries: stats?.retries,
                probes: stats?.probes,
                rewrites: stats?.rewrites,
                stall: stalledBy?.reason,
                pending: stalledBy?.pending,
            });
        }
        return undefined;

        function send(event, data) {
            write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }

        // 寫進回應，用戶端不把資料收走時中止任務（見 MAX_PENDING_BYTES）。超過上限是在寫之前檢查：
        // 一次寫入大的 done 不算，要上一筆還沒收走才算
        function write(chunk) {
            if (!res.headersSent || res.writableEnded || res.destroyed) return;
            if (res.writableLength > maxPendingBytes) {
                stall('pending');
                return;
            }
            if (res.write(chunk) || stallTimer) return;
            stallTimer = setTimeout(stall, stallTimeoutMs, 'drain_timeout');
            res.once('drain', () => {
                clearTimeout(stallTimer);
                stallTimer = undefined;
            });
        }

        function stall(reason) {
            clearTimeout(stallTimer);
            stallTimer = undefined;
            stalledBy = { reason, pending: res.writableLength };
            abort.abort(CLIENT_STALLED);
            // 用 RST 關掉：用戶端不收資料時，FIN 排在核心緩衝裡還沒送出的資料後面，連線與緩衝都會留著
            if (res.socket) res.socket.resetAndDestroy();
            else res.destroy();
        }
    }

    async function settle(promises, ms) {
        let timer;
        await Promise.race([
            Promise.all(promises),
            new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
        ]);
        clearTimeout(timer);
    }

    /**
     * 停止收新請求並等進行中的任務結束（最多 graceMs），之後中止剩下的、讓它們送出
     * 可重試的 error 事件，最後強制關閉連線。
     *
     * k3s 換版時：Pod 一進入 Terminating 就被移出 Service 的端點，preStop 的 sleep 讓這件事
     * 先傳播完，SIGTERM 到這裡時已經不會有新流量。排隊中的任務不會再輪到，立刻叫前端重試
     * （新的 pod 已經就緒）；正在跑的讓它跑完。/readyz 的 draining 與新任務的 not_ready
     * 只有還連著的舊連線看得到。
     */
    function close({ graceMs = 0, requestWaitMs = REQUEST_WAIT_MS } = {}) {
        closing ??= (async () => {
            draining = true;
            clearInterval(sweepTimer);
            for (const h of active) {
                if (h.queued) h.abort.abort(SHUTDOWN);
                // 這個回應一結束就關掉它的 keep-alive 連線。留著的話，代理的連線池會拿它送下一個
                // 學生的請求，落到這個要關的 pod 而拿到 503（2026-10-22 實測：SSE 結束後連線還會
                // 留約 6 秒）。draining 之後不會再有新的 handle：新的任務請求一律 503 並關連線
                h.done.then(() => server.closeIdleConnections());
            }
            // server.close() 本身會先關掉閒置的 keep-alive 連線（Node 19 起），也會停掉 Node 自己的
            // headersTimeout／requestTimeout 檢查，所以 body 的期限由 readBody 自己計時。
            const closed = new Promise((resolve) => server.close(resolve));
            if (active.size) await settle([...active].map((h) => h.done), graceMs);
            if (active.size) {
                for (const h of active) h.abort.abort(SHUTDOWN);
                await settle([...active].map((h) => h.done), SHUTDOWN_FLUSH_MS);
            }
            // 已經收到、還沒回應的請求（多半還在上傳 body）：限時讓它們走到 draining 的 503，
            // 不要直接切斷。經過代理時，被切斷的請求只會變成看不懂的 502。
            if (unanswered.size) await settle([...unanswered], requestWaitMs);
            server.closeAllConnections();
            await closed;
        })();
        return closing;
    }

    // gate、limiter 一併交出去：給測試注入故障，也方便除錯時查看
    return { server, close, gate, limiter, stats: () => ({ ...gate.stats, active: active.size, draining }) };
}

async function main() {
    const llm = loadLlmConfig(process.env);
    const serverConfig = loadServerConfig(process.env);
    const log = createLogger(serverConfig.logLevel);
    // 寬限期比任務時限短的話，換版時最長的那種任務會做到一半被中止（GPU 白做、學生要重來）
    if (serverConfig.shutdownGraceMs < llm.taskTimeoutMs) {
        log('warn', 'CONFIG', { problem: 'shutdown-grace-below-task-timeout', grace: serverConfig.shutdownGraceMs, taskTimeout: llm.taskTimeoutMs });
    }
    const { TASK_DEFINITIONS } = await import('./task-catalog.mjs');
    const tasks = createCatalog(TASK_DEFINITIONS);
    const gateway = createGateway({ llm, server: serverConfig, tasks, log });
    gateway.server.listen(serverConfig.port, serverConfig.host, () => {
        log('info', 'START', {
            host: serverConfig.host,
            // PORT=0 時由系統挑埠：印出實際的埠
            port: gateway.server.address().port,
            model: llm.model,
            effort: llm.reasoningEffort,
            tasks: [...tasks.keys()].join(',') || '(none)',
            origins: serverConfig.allowedOrigins.join(','),
            // 限流靠的是用戶端 IP：從哪裡取、信任哪些代理，部署時一眼就能確認
            clientIp: serverConfig.clientIpHeader
                ? `${serverConfig.clientIpHeader} via ${serverConfig.trustedProxies.join(',') || '(no trusted proxy: header ignored)'}`
                : 'socket',
            key: llm.apiKey ? 'loaded' : 'MISSING',
            problems: configProblems(llm).join(',') || undefined,
        });
    });
    let stopping = false;
    const stop = async (signal) => {
        if (stopping) {
            // 第二次 Ctrl-C／SIGTERM：不等寬限期了
            log('warn', 'FORCED-EXIT', { signal });
            process.exit(1);
        }
        stopping = true;
        log('info', 'SHUTDOWN', { signal, ...gateway.stats() });
        await gateway.close({ graceMs: serverConfig.shutdownGraceMs });
        process.exit(0);
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
}

// 直接執行時才啟動（被測試 import 時不啟動）；透過 symlink 執行時 argv[1] 是連結本身
function isMain() {
    try {
        return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isMain()) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
