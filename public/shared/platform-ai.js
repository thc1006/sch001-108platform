/**
 * 網站 AI 功能的共用 helper：呼叫自架的 AI 閘道、顯示進度、把 AI 的答案轉成安全的 HTML。
 *
 * 暴露為 window.PlatformAI = {
 *   runTask, describeError, mountProgress, getGatewayUrl,
 *   formatError, renderMarkdown, perFrame,
 *   log, getLogs, clearLogs, mountDebugPanel
 * }
 *
 * 使用：
 *   <script src="/path/to/shared/platform-ai.js"></script>
 *   const { result } = await PlatformAI.runTask('starter-pack', { topic }, { onProgress });
 *
 * 前端 debug panel（使用者不用開 DevTools 也能看錯誤）：
 *   - URL 加 `?debug=1` 自動啟用
 *   - 或 localStorage.setItem('AI_DEBUG', '1') 持久啟用
 *   - panel 固定右下、可收合、可複製全部事件、可清空
 */
(function (global) {
    'use strict';

    // 版號只寫這一個地方。守衛與匯出各寫一次的話，守衛的數字一旦比匯出的大，
    // 這支腳本就再也不會提早返回，每載入一次覆寫一次全域物件，而那正是它想避免的事。
    var VERSION = 10;

    // 比較是 >=，不是 ===。用 === 的話，同一頁若先載到新版、後又載到一份舊的
    // （快取、第三方嵌入、頁面自己多寫了一行 script），舊的那份會看到版號不等於
    // 自己的，於是不返回、把新版整個覆蓋掉，悄悄降級成舊的那份。
    if (global.PlatformAI && global.PlatformAI.__version >= VERSION) {
        return; // 同版或更新的版本已經載入了
    }

    var MAX_LOGS = 200;
    var logs = [];
    var panelEl = null;
    var bodyEl = null;

    // safeStringify 把任何值轉成字串，循環引用、BigInt 和無法序列化的值都不會讓它丟錯。
    function safeStringify(value) {
        // Primitive 分支：避免 JSON.stringify 產生帶引號的 string（"oops"），
        // 或對 function / symbol / undefined 回傳 undefined 導致契約破損
        if (value === null) return 'null';
        var t = typeof value;
        if (t === 'string') return value;                       // 不加引號
        if (t === 'number' || t === 'boolean') return String(value);
        if (t === 'bigint') return String(value);
        if (t === 'undefined' || t === 'function' || t === 'symbol') {
            try { return String(value); } catch (_) { return '[Unserializable]'; }
        }

        // Object：用 replacer 處理循環引用與 BigInt
        try {
            var seen = new WeakSet();
            var result = JSON.stringify(value, function (key, val) {
                if (typeof val === 'bigint') return String(val);
                if (val && typeof val === 'object') {
                    if (seen.has(val)) return '[Circular]';
                    seen.add(val);
                }
                return val;
            });
            // 防禦：若 object 被 toJSON 或其他機制替換成 undefined，
            // 仍提供字串化回傳
            return result === undefined ? String(value) : result;
        } catch (e) {
            try { return String(value); } catch (_) { return '[Unserializable]'; }
        }
    }

    /**
     * formatError 把錯誤轉成一行文字給 log 用，null 與 undefined 回傳 'unknown'。
     * DOMException 在舊瀏覽器 instanceof Error 為 false，所以看 name 與 message 屬性。
     * @param {unknown} err @returns {string}
     */
    function formatError(err) {
        if (err === null || err === undefined) return 'unknown';
        if (typeof err === 'object' &&
            (typeof err.name === 'string' || typeof err.message === 'string')) {
            var name = err.name || 'Error';
            var message = err.message || '';
            return name + (message ? ': ' + message : '');
        }
        return safeStringify(err);
    }

    function nowString() {
        var d = new Date();
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        var ms = String(d.getMilliseconds()).padStart(3, '0');
        return hh + ':' + mm + ':' + ss + '.' + ms;
    }

    function log(level, message, meta) {
        var entry = {
            time: nowString(),
            level: level || 'info',
            message: String(message),
            meta: meta
        };
        logs.push(entry);
        if (logs.length > MAX_LOGS) {
            logs.shift();
            // 同步移除 panel 對應最舊的 DOM 行，避免長時間使用時 bodyEl
            // 累積上千個 <div> 造成記憶體 / 效能衰退
            if (bodyEl && bodyEl.firstChild) {
                bodyEl.removeChild(bodyEl.firstChild);
            }
        }

        // 同步寫 console
        // 用 != null 同時排除 undefined 與 null，避免 log('info', 'ok', null)
        // 時 console 多印一個 "null" 載荷
        var consoleFn = console[level] || console.log;
        try {
            if (meta != null) consoleFn.call(console, '[PlatformAI]', message, meta);
            else consoleFn.call(console, '[PlatformAI]', message);
        } catch (_) {}

        // 若 panel 已掛載，追加顯示
        if (panelEl && bodyEl) renderLogEntry(entry);
        return entry;
    }

    function getLogs() { return logs.slice(); }
    function clearLogs() {
        logs = [];
        if (bodyEl) bodyEl.textContent = '';
    }

    function shouldAutoMountPanel() {
        try {
            if (typeof window === 'undefined' || !window.location) return false;
            var qs = window.location.search || '';
            if (/[?&]debug=1(?:&|$)/.test(qs)) return true;
            if (window.localStorage && window.localStorage.getItem('AI_DEBUG') === '1') return true;
        } catch (_) {}
        return false;
    }

    function levelColor(level) {
        switch (level) {
            case 'error': return '#fca5a5';   // red-300
            case 'warn':  return '#fde68a';   // amber-200
            case 'info':  return '#bfdbfe';   // blue-200
            case 'debug': return '#d1d5db';   // gray-300
            default:      return '#e5e7eb';
        }
    }

    function renderLogEntry(entry) {
        if (!bodyEl) return;
        var line = document.createElement('div');
        line.style.padding = '4px 8px';
        line.style.borderBottom = '1px solid rgba(255,255,255,0.08)';
        line.style.color = levelColor(entry.level);
        line.style.whiteSpace = 'pre-wrap';
        line.style.wordBreak = 'break-word';
        var prefix = '[' + entry.time + '] ' + entry.level.toUpperCase() + ' ';
        var metaStr = '';
        if (entry.meta != null) {  // 同時排除 undefined 與 null
            metaStr = '\n  ' + safeStringify(entry.meta);
        }
        line.textContent = prefix + entry.message + metaStr;
        bodyEl.appendChild(line);
        bodyEl.scrollTop = bodyEl.scrollHeight;
    }

    function mountDebugPanel() {
        if (panelEl) return panelEl;
        if (typeof document === 'undefined' || !document.body) {
            // DOM 尚未就緒，等 DOMContentLoaded
            if (typeof document !== 'undefined') {
                document.addEventListener('DOMContentLoaded', mountDebugPanel, { once: true });
            }
            return null;
        }

        panelEl = document.createElement('div');
        panelEl.id = 'ai-debug-panel';
        panelEl.setAttribute('role', 'region');
        panelEl.setAttribute('aria-label', 'AI Debug Log');
        panelEl.style.cssText = [
            'position:fixed',
            'right:12px',
            'bottom:12px',
            'width:min(480px, 92vw)',
            'max-height:50vh',
            'background:#111827',
            'color:#e5e7eb',
            'border:1px solid #374151',
            'border-radius:8px',
            'box-shadow:0 10px 30px rgba(0,0,0,0.4)',
            'font-family:ui-monospace, SFMono-Regular, Menlo, monospace',
            'font-size:12px',
            'z-index:2147483647',
            'display:flex',
            'flex-direction:column',
            'overflow:hidden'
        ].join(';');

        var header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;background:#1f2937;border-bottom:1px solid #374151;cursor:move;user-select:none';

        var title = document.createElement('strong');
        title.textContent = '🔧 AI Log';
        title.style.flex = '1';
        title.style.fontSize = '12px';
        header.appendChild(title);

        function makeBtn(label, onClick) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.style.cssText = 'background:#374151;color:#e5e7eb;border:none;border-radius:4px;padding:3px 8px;cursor:pointer;font-size:11px';
            b.addEventListener('click', onClick);
            return b;
        }

        var copyBtn = makeBtn('Copy', function () {
            var text = logs.map(function (l) {
                return '[' + l.time + '] ' + l.level.toUpperCase() + ' ' + l.message +
                    (l.meta != null ? '\n  ' + safeStringify(l.meta) : '');
            }).join('\n');

            function showResult(ok) {
                copyBtn.textContent = ok ? '✓' : '×';
                setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1200);
            }

            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    // writeText 回傳 Promise；用 .then/.catch 確保 UI 真實反映結果
                    // 且避免 unhandled rejection（insecure context / 權限不足時會 reject）
                    navigator.clipboard.writeText(text).then(
                        function () { showResult(true); },
                        function () { showResult(false); }
                    );
                } else {
                    // Fallback：execCommand 為同步回傳 boolean
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    var ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                    showResult(ok);
                }
            } catch (e) {
                showResult(false);
            }
        });

        var clearBtn = makeBtn('Clear', function () { clearLogs(); });
        // toggle / close 純符號（–、+、×）對螢幕閱讀器不可理解，需補 aria-label。
        // 用 aria-expanded 傳達展開狀態給輔助技術。
        var toggleBtn = makeBtn('–', function () {
            if (bodyEl.style.display === 'none') {
                bodyEl.style.display = 'block';
                toggleBtn.textContent = '–';
                toggleBtn.setAttribute('aria-label', 'Collapse AI log');
                toggleBtn.setAttribute('aria-expanded', 'true');
            } else {
                bodyEl.style.display = 'none';
                toggleBtn.textContent = '+';
                toggleBtn.setAttribute('aria-label', 'Expand AI log');
                toggleBtn.setAttribute('aria-expanded', 'false');
            }
        });
        toggleBtn.setAttribute('aria-label', 'Collapse AI log');
        toggleBtn.setAttribute('aria-expanded', 'true');

        // dragCtrl 會在下方 addDrag 建立；closeBtn 關閉時透過 abort() 移除所有
        // document-level drag listeners，避免 close 後 listener 洩漏 / 重新 mount 疊加。
        var dragCtrl;
        var closeBtn = makeBtn('×', function () {
            if (dragCtrl) dragCtrl.abort();
            if (panelEl && panelEl.parentNode) {
                panelEl.parentNode.removeChild(panelEl);
            }
            panelEl = null;
            bodyEl = null;
        });
        closeBtn.setAttribute('aria-label', 'Close AI log panel');

        header.appendChild(copyBtn);
        header.appendChild(clearBtn);
        header.appendChild(toggleBtn);
        header.appendChild(closeBtn);

        bodyEl = document.createElement('div');
        bodyEl.style.cssText = 'flex:1;overflow:auto;padding:4px 0;max-height:40vh';

        panelEl.appendChild(header);
        panelEl.appendChild(bodyEl);
        document.body.appendChild(panelEl);

        // 簡單可拖曳
        // 用 AbortController 管理 3 個 listener 的生命週期：
        //   - close panel 時 dragCtrl.abort() 一次性移除，避免：
        //     (a) document 上 listener 洩漏（閒置仍被觸發）
        //     (b) close + 重新 mount 後 listener 疊加多組
        //     (c) 未來 refactor 若 dragging=true 時 panelEl 被清空會 crash
        (function addDrag() {
            var startX, startY, origRight, origBottom, dragging = false;
            dragCtrl = new AbortController();
            var opts = { signal: dragCtrl.signal };
            header.addEventListener('mousedown', function (e) {
                // 忽略 button 元素上的 mousedown：
                // - 避免 e.preventDefault() 抑制按鈕 click
                // - 避免使用者試圖點 Copy/Clear/× 時意外觸發拖曳
                if (e.target && (e.target.tagName === 'BUTTON' || (e.target.closest && e.target.closest('button')))) {
                    return;
                }
                dragging = true;
                startX = e.clientX; startY = e.clientY;
                var rect = panelEl.getBoundingClientRect();
                origRight = window.innerWidth - rect.right;
                origBottom = window.innerHeight - rect.bottom;
                e.preventDefault();
            }, opts);
            document.addEventListener('mousemove', function (e) {
                // 雙重保險：dragging 旗標 + panelEl 存在性檢查
                // 即使 AbortController 尚未完成移除（abort 為同步、但事件 dispatch
                // 時序保守起見），仍避免觸碰已釋放的 panelEl。
                if (!dragging || !panelEl) return;
                var dx = e.clientX - startX;
                var dy = e.clientY - startY;
                panelEl.style.right = Math.max(0, origRight - dx) + 'px';
                panelEl.style.bottom = Math.max(0, origBottom - dy) + 'px';
            }, opts);
            document.addEventListener('mouseup', function () { dragging = false; }, opts);
        })();

        // 補上已經累積的 log
        for (var i = 0; i < logs.length; i++) {
            renderLogEntry(logs[i]);
        }
        return panelEl;
    }

    // runTask 呼叫本地 LLM 閘道。
    //
    // 網站是 GitHub Pages 上的靜態頁面，AI 由我們架在 k3s 上的閘道提供。瀏覽器只說
    // 「要做哪個任務、輸入是什麼」（POST <閘道>/v1/tasks/<任務>，body {"input": {...}}），
    // prompt、模型與輸出格式都由閘道決定，WinLab 的 API key 也只存在閘道那一端。
    //
    // 閘道網址在建置時由 PUBLIC_AI_GATEWAY_URL 寫進 <meta name="ai-gateway-url">。
    // 沒設定時 runTask() 直接回報「尚未設定」，不去猜一個網址。
    //
    // 回應是 SSE（text/event-stream），事件依序是：
    //   accepted  { requestId, task }
    //   progress  { phase: queued|started|thinking|writing|continuing|retrying, position?, round?, delayMs? }
    //   delta     { text }      只有文字任務：答案的片段，可以邊收邊顯示
    //   done      { result, rounds, continuations, usage, elapsedMs }
    //   error     { code, message, retryable, retryAfter? }
    // 一個任務可能要好幾分鐘（xhigh 推理、答案太長時自動續寫），所以一定要讓使用者
    // 看得到進度：mountProgress() 依 progress 事件顯示 AI 在做什麼、已經等了多久。
    //
    var TASK_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
    // 閘道那一端排隊最多 4 分鐘（QUEUE_TIMEOUT_MS）、生成最多 15 分鐘（LLM_TASK_TIMEOUT_MS）。這裡要比
    // 兩者加起來再長一點，否則閘道還在正常工作，瀏覽器就先放棄了
    var DEFAULT_TASK_TIMEOUT_MS = 20 * 60 * 1000;
    // setTimeout 能接受的最長延遲（32 位元有號整數）。超過的值，包括 Infinity，瀏覽器會
    // 當成 0 立刻觸發，所以 timeoutMs 要夾在這個值以內；不夾的話，想表示「不另設時限」的
    // timeoutMs: Infinity 會馬上逾時。
    var MAX_TIMER_MS = 2147483647;
    // 閘道每 15 秒送一次心跳；連續一分鐘什麼都沒收到，就當作連線斷了。閘道的心跳間隔
    // （HEARTBEAT_MS）上限是 30 秒，這裡留了一倍的餘裕；兩邊要一起改，否則閘道的心跳
    // 一放慢，正常進行中的任務就會被當成斷線
    var IDLE_TIMEOUT_MS = 60 * 1000;
    // 單一事件的上限。正常的結果遠小於此，超過代表回應根本不是閘道送的
    var MAX_EVENT_CHARS = 2 * 1024 * 1024;
    // 開始串流之前的錯誤回應只讀這麼多；閘道的錯誤 JSON 很短
    var MAX_ERROR_BODY_CHARS = 16 * 1024;
    // 看得懂的事件。其他型別（包括沒有 event 欄位的 message）是閘道日後可能新增的，
    // 直接略過：不能因為舊的頁面看不懂新事件，就讓整個任務失敗
    var KNOWN_EVENTS = ['accepted', 'progress', 'delta', 'done', 'error'];
    // 閘道回這些代號並給了 retryAfter 時，等待期間不送出。整間學校常共用一個對外 IP，多按的每一次
    // 仍會送到閘道、計入這個 IP 每分鐘的請求數；等待時間多加隨機的幾秒，同時被拒的人才不會同時回來
    var COOLDOWN_CODES = ['busy', 'rate_limited', 'too_many_inflight', 'not_ready'];
    var COOLDOWN_JITTER_MAX_MS = 30 * 1000;
    var COOLDOWN_MAX_MS = 3600 * 1000;
    // busy 的 Retry-After 可能是上游給的，最長一天；閘道修好之後不該還擋著學生
    var BUSY_COOLDOWN_MAX_MS = 600 * 1000;
    // { until, code, message }，until 是 performance.now() 的時間：系統時間往回調不會拉長等待
    var cooldown = null;

    // network 不能只怪學生的網路：跨網域時，閘道停擺（通道回 502）、網站不在允許名單、網址路徑
    // 錯了，瀏覽器給的都是同一個 TypeError，分不出來
    var CLIENT_MESSAGES = {
        not_configured: 'AI 服務尚未設定完成，暫時無法使用。',
        network: '暫時連不上 AI 服務（可能是網路不穩，或服務正在維護），請稍後再試。',
        offline: '你的裝置目前沒有網路連線，請連上網路後再試。',
        disconnected: '和 AI 服務的連線中斷了，請再試一次。',
        bad_response: 'AI 服務的回應格式不正確，請稍後再試。',
        unavailable: 'AI 服務暫時無法使用，請稍後再試。'
    };

    function isLoopbackHost(hostname) {
        return hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
    }

    // 回傳閘道的基底網址（不含結尾斜線）；沒設定或不合法時回傳 null。
    // 只接受 https，http 只限本機（開發時把閘道跑在 localhost）。
    function getGatewayUrl() {
        if (typeof document === 'undefined') return null;
        var meta = document.querySelector('meta[name="ai-gateway-url"]');
        var raw = meta ? (meta.getAttribute('content') || '').trim() : '';
        if (!raw) return null;
        var url;
        try {
            url = new URL(raw);
        } catch (_) {
            log('error', 'ai-gateway-url 不是合法的網址', { value: raw.slice(0, 100) });
            return null;
        }
        var secure = url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
        if (!secure || url.username || url.password || url.search || url.hash) {
            log('error', 'ai-gateway-url 必須是 https（本機開發可用 http://localhost），且不能帶帳密、查詢字串或 #', { value: raw.slice(0, 100) });
            return null;
        }
        return url.origin + url.pathname.replace(/\/+$/, '');
    }

    // runTask 的錯誤：name 固定是 'AIError'；code 是穩定的代號（閘道給的 busy、
    // rate_limited、timeout、invalid_input…，或這裡自己的 network、disconnected…），
    // message 是可以直接給學生看的繁體中文。
    function makeAIError(code, message, extra) {
        extra = extra || {};
        var err = new Error(message);
        err.name = 'AIError';
        err.code = code;
        err.retryable = Boolean(extra.retryable);
        err.retryAfter = extra.retryAfter;   // 建議幾秒後再試；沒有就是 undefined
        err.requestId = extra.requestId;     // 回報問題時用來對照閘道的 log
        err.status = extra.status;
        err.field = extra.field;             // invalid_input：哪個欄位有問題
        err.partial = extra.partial;         // 出錯之前收到的片段接起來的全文，有看得見的字才有
        return err;
    }

    // 有沒有看得見的字，與閘道的 visible-text.mjs 同一個定義：零寬空白、韓文填充字、點字空白不算
    var VISIBLE_TEXT = /(?![\u2800\uFFFC\p{Default_Ignorable_Code_Point}])[\p{L}\p{N}\p{P}\p{S}]/u;

    function toRetryAfter(value) {
        var seconds = Number(value);
        return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : undefined;
    }

    // 連不上的時候，裝置明確離線就直說；其他情況（含 CORS 被擋）用 network 的說法
    function networkError(extra) {
        var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        return makeAIError('network', offline ? CLIENT_MESSAGES.offline : CLIENT_MESSAGES.network, extra);
    }

    // signal 的 reason 通常是 DOMException（AbortError，或 AbortSignal.timeout() 的
    // TimeoutError），原樣丟回去，呼叫端既有的 err.name 判斷就不用改。舊瀏覽器沒有
    // reason，或有人 abort('字串')，就補一個 AbortError。
    function abortReason(signal) {
        var reason = signal && signal.reason;
        if (reason && typeof reason === 'object' && typeof reason.name === 'string') return reason;
        return new DOMException('已取消', 'AbortError');
    }

    // 回呼函式（頁面的進度顯示等）出錯不該讓整個任務失敗
    function notify(fn) {
        if (typeof fn !== 'function') return;
        try {
            fn.apply(null, Array.prototype.slice.call(arguments, 1));
        } catch (err) {
            log('warn', 'AI 任務的回呼函式出錯：' + formatError(err));
        }
    }

    // 把 SSE 的文字流切成事件，依 HTML 標準的 event stream 規則：行尾可能是 \n、\r\n
    // 或 \r；冒號開頭的是註解（閘道的心跳）；data 可以有多行，以 \n 接起來；串流結束
    // 時沒收完的事件丟掉。回傳 push(text)，每切出一個事件就呼叫 onEvent({type, data})。
    //
    // onEvent 回傳 false 表示不用再看了（收到 done、使用者在回呼裡取消）：之後的內容一律
    // 不處理，同一塊裡剩下的部分也一樣。否則 done 後面跟著的垃圾（例如一行超過上限的
    // data）會把已經拿到的結果變成失敗。
    function createSseParser(onEvent) {
        var buffer = '';        // 還沒遇到行尾的部分
        var type = '';
        var data = [];
        var size = 0;
        var afterCR = false;    // 上一塊以 \r 結尾
        var stopped = false;

        function tooLarge() {
            return makeAIError('bad_response', CLIENT_MESSAGES.bad_response);
        }

        function handleLine(line) {
            if (line === '') {
                if (data.length && onEvent({ type: type || 'message', data: data.join('\n') }) === false) {
                    stopped = true;
                }
                type = '';
                data = [];
                size = 0;
                return;
            }
            if (line.charAt(0) === ':') return;
            var colon = line.indexOf(':');
            var field = colon === -1 ? line : line.slice(0, colon);
            var value = colon === -1 ? '' : line.slice(colon + 1);
            if (value.charAt(0) === ' ') value = value.slice(1);
            if (field === 'event') {
                type = value;
            } else if (field === 'data') {
                size += value.length + 1;
                if (size > MAX_EVENT_CHARS) throw tooLarge();
                data.push(value);
            }
        }

        return function push(text) {
            // 空的一塊（例如 TextDecoder 只收到半個多位元組字元）什麼都不改，afterCR 也留著
            if (stopped || !text) return;
            var lineEnd = /\r\n|\r|\n/g;
            var start = 0;
            // \r\n 被切在兩塊之間：那個 \r 已經當作行尾處理過了，這個 \n 屬於同一個行尾
            if (afterCR && text.charAt(0) === '\n') start = 1;
            lineEnd.lastIndex = start;
            var match;
            while ((match = lineEnd.exec(text))) {
                var line = buffer + text.slice(start, match.index);
                buffer = '';
                start = lineEnd.lastIndex;
                handleLine(line);
                if (stopped) return;
            }
            // 結尾的 \r 當下就結束了那一行，不必等下一塊才派送事件（串流可能就此結束，
            // 只用 \r 當行尾時，最後一個事件會因此永遠收不到）；只記下來，好跳過下一塊開頭的 \n
            afterCR = text.charAt(text.length - 1) === '\r';
            buffer += text.slice(start);
            if (buffer.length > MAX_EVENT_CHARS) throw tooLarge();
        };
    }

    // 讀錯誤回應的 body，最多 MAX_ERROR_BODY_CHARS 個字；超過就停下來並取消，回傳 null
    // （那麼長的不會是閘道的錯誤 JSON，沒有可以採信的內容）。不用 response.text()：
    // 它一定讀到結束，對方送多少就收多少
    async function readErrorBody(response) {
        if (!response.body) return '';
        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var raw = '';
        for (;;) {
            var chunk = await reader.read();
            if (chunk.done) return raw + decoder.decode();
            raw += decoder.decode(chunk.value, { stream: true });
            if (raw.length > MAX_ERROR_BODY_CHARS) {
                reader.cancel().catch(function () {});
                return null;
            }
        }
    }

    // 開始串流之前的拒絕：閘道回 JSON {"error": {code, message, retryable?, retryAfter?, field?}}。
    // 只有帶著閘道的 X-Request-Id 時才採信裡面的訊息。跨網域時，沒有 CORS 標頭的回應（閘道沒開時
    // 通道回的 502、閘道自己的 403 與 404）瀏覽器根本不交給頁面，走的是 fetch 失敗的 network；
    // 會走到這裡的，是補了 CORS 標頭的代理或同網域部署時的錯誤頁，內容可能是任何東西，一律
    // 當作暫時無法使用，不把陌生的文字秀給學生。
    async function responseError(response, requestId) {
        var info = {};
        if (requestId) {
            try {
                var raw = await readErrorBody(response);
                var body = raw === null ? null : JSON.parse(raw);
                if (body && body.error && typeof body.error === 'object') info = body.error;
            } catch (_) {}
        }
        var status = response.status;
        return makeAIError(
            typeof info.code === 'string' && info.code ? info.code : 'unavailable',
            typeof info.message === 'string' && info.message ? info.message : CLIENT_MESSAGES.unavailable,
            {
                status: status,
                // 閘道明說了能不能重試就照它的（同樣是 500，有的重試也沒用）；沒說才依狀態碼判斷
                retryable: typeof info.retryable === 'boolean'
                    ? info.retryable
                    : status === 408 || status === 429 || status >= 500,
                retryAfter: toRetryAfter(response.headers.get('Retry-After')) || toRetryAfter(info.retryAfter),
                requestId: requestId,
                field: typeof info.field === 'string' ? info.field : undefined
            }
        );
    }

    /**
     * 執行閘道上的一個 AI 任務。
     *
     * @param {string} taskId          任務代號，例如 'starter-pack'
     * @param {object} input           任務的輸入欄位，例如 { topic: '貓咪' }
     * @param {object} [options]
     * @param {AbortSignal} [options.signal]   只用來讓使用者取消；時限請用 timeoutMs（見下方）
     * @param {Function} [options.onProgress]  收到進度時呼叫，參數是 progress 事件的內容
     *                                         （送出後先收到一次 { phase: 'accepted' }）
     * @param {Function} [options.onDelta]     文字任務：收到答案片段時呼叫 (片段, 目前累積的全文)
     * @param {number} [options.timeoutMs]     整體時限，預設 20 分鐘
     * @returns {Promise<{result, rounds, continuations, usage, elapsedMs, requestId}>}
     *          result：JSON 任務是驗證過的物件，文字任務是完整的答案字串（以這個為準，
     *          onDelta 累積的只是邊收邊顯示用）
     *
     * 失敗時丟出：
     *   參數不合法（任務代號、無法序列化成 JSON 的 input）→ TypeError，請求不會送出
     *   使用者取消 → signal 的 reason（通常是 AbortError）
     *   超過時限 → TimeoutError
     *   其餘一律是 AIError（見 makeAIError）
     * 除了使用者取消，出錯之前已經收到看得見的字時，錯誤帶著 partial。
     * 閘道回 COOLDOWN_CODES 的錯誤並給了 retryAfter 時，等待期間再呼叫會直接丟出同一個代號的 AIError，不送出請求。
     * 要顯示的文字交給 describeError()。
     *
     * signal 不要拿來設時限，例如 signal: AbortSignal.timeout(30000)：閘道排隊和生成都可能
     * 超過 30 秒，各自的時限見 DEFAULT_TASK_TIMEOUT_MS 的說明。這樣設的話，長一點的任務
     * 一律失敗，排隊中的學生也永遠輪不到。要比預設更短的時限，用 timeoutMs。
     */
    async function runTask(taskId, input, options) {
        options = options || {};
        if (typeof taskId !== 'string' || !TASK_ID_PATTERN.test(taskId)) {
            throw new TypeError('任務代號不合法：' + String(taskId));
        }
        // 先序列化：input 裡有 BigInt、循環參照這類程式錯誤時，JSON.stringify 的 TypeError
        // 原樣往外丟。放在 fetch 那一行的話，它會被底下的 catch 當成連線失敗
        var requestBody = JSON.stringify({ input: input });
        var signal = options.signal;
        if (signal && signal.aborted) throw abortReason(signal);
        var base = getGatewayUrl();
        if (!base) {
            log('error', 'AI 閘道網址沒有設定（<meta name="ai-gateway-url">）');
            throw makeAIError('not_configured', CLIENT_MESSAGES.not_configured);
        }
        var waitMs = cooldown ? cooldown.until - performance.now() : 0;
        if (waitMs > 0) {
            log('info', 'AI 任務沒有送出：還在閘道建議的等待時間內', { task: taskId, code: cooldown.code });
            throw makeAIError(cooldown.code, cooldown.message, { retryable: true, retryAfter: toRetryAfter(waitMs / 1000) });
        }

        var controller = new AbortController();
        var stopReason = null;   // cancel | timeout | idle：之後把 abort 翻譯回對的錯誤
        function stop(reason) {
            if (!stopReason) stopReason = reason;
            controller.abort();
        }
        function onAbort() { stop('cancel'); }
        if (signal) signal.addEventListener('abort', onAbort);
        var timeoutMs = options.timeoutMs > 0 ? Math.min(options.timeoutMs, MAX_TIMER_MS) : DEFAULT_TASK_TIMEOUT_MS;
        var timer = setTimeout(function () { stop('timeout'); }, timeoutMs);
        var idleTimer = null;
        function touch() {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(function () { stop('idle'); }, IDLE_TIMEOUT_MS);
        }

        var requestId;
        var responded = false;   // 收到回應標頭了沒：閒置逾時發生在這之前是連不上，之後是斷線
        var streaming = false;
        var text = '';           // 收到的片段接起來的全文
        var startedAt = Date.now();
        log('info', 'AI 任務開始', { task: taskId });
        try {
            // 閒置計時從送出就開始算：連回應標頭都等不到（封包被丟掉、中間的代理掛住）時，
            // 一分鐘就放棄，不必乾等 20 分鐘的總時限
            touch();
            var response = await global.fetch(base + '/v1/tasks/' + taskId, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
                body: requestBody,
                signal: controller.signal,
                credentials: 'omit',
                cache: 'no-store',
                // 閘道從不轉址；被轉到別處時寧可失敗，也不把輸入再送一次給陌生的網址
                redirect: 'error'
            });
            responded = true;
            touch();
            requestId = response.headers.get('X-Request-Id') || undefined;
            if (!response.ok) throw await responseError(response, requestId);
            if (!/^text\/event-stream\b/i.test(response.headers.get('Content-Type') || '') || !response.body) {
                throw makeAIError('bad_response', CLIENT_MESSAGES.bad_response, { status: response.status, requestId: requestId });
            }

            streaming = true;
            var outcome = null;
            var parse = createSseParser(function (event) {
                // 已經有結果，或使用者剛在回呼裡同步取消了：後面的一律不看
                if (outcome || stopReason) return false;
                if (KNOWN_EVENTS.indexOf(event.type) === -1) return;
                var payload;
                try {
                    payload = JSON.parse(event.data);
                } catch (_) {
                    payload = null;
                }
                if (!payload || typeof payload !== 'object') {
                    throw makeAIError('bad_response', CLIENT_MESSAGES.bad_response, { requestId: requestId });
                }
                switch (event.type) {
                    case 'accepted':
                        if (typeof payload.requestId === 'string') requestId = payload.requestId;
                        notify(options.onProgress, { phase: 'accepted' });
                        break;
                    case 'progress':
                        notify(options.onProgress, payload);
                        break;
                    case 'delta':
                        if (typeof payload.text === 'string' && payload.text) {
                            text += payload.text;
                            notify(options.onDelta, payload.text, text);
                        }
                        break;
                    case 'done':
                        if (!('result' in payload)) {
                            throw makeAIError('bad_response', CLIENT_MESSAGES.bad_response, { requestId: requestId });
                        }
                        outcome = payload;
                        return false;
                    case 'error':
                        throw makeAIError(
                            typeof payload.code === 'string' && payload.code ? payload.code : 'unavailable',
                            typeof payload.message === 'string' && payload.message ? payload.message : CLIENT_MESSAGES.unavailable,
                            { retryable: payload.retryable, retryAfter: toRetryAfter(payload.retryAfter), requestId: requestId, partial: VISIBLE_TEXT.test(text) ? text : undefined }
                        );
                }
            });

            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            while (!outcome && !stopReason) {
                var chunk = await reader.read();
                if (chunk.done) break;
                touch();
                parse(decoder.decode(chunk.value, { stream: true }));
            }
            // 使用者在回呼裡同步取消時，迴圈是自己停下來的，沒有被 abort 打斷：丟一個
            // AbortError，讓底下的 catch 依 stopReason 翻譯成該丟的錯誤
            if (stopReason) throw new DOMException('已取消', 'AbortError');
            // 沒收到 done 或 error 串流就結束了：閘道重啟、通道斷線
            if (!outcome) throw makeAIError('disconnected', CLIENT_MESSAGES.disconnected, { retryable: true, requestId: requestId });

            log('info', 'AI 任務完成', {
                task: taskId,
                requestId: requestId,
                rounds: outcome.rounds,
                elapsedMs: Date.now() - startedAt
            });
            return {
                result: outcome.result,
                rounds: outcome.rounds,
                continuations: outcome.continuations,
                usage: outcome.usage,
                elapsedMs: outcome.elapsedMs,
                requestId: requestId
            };
        } catch (err) {
            var failure;
            if (stopReason === 'cancel') {
                failure = abortReason(signal);
            } else if (stopReason === 'timeout') {
                failure = new DOMException('等待 AI 回應逾時', 'TimeoutError');
            } else if (stopReason === 'idle') {
                // 連回應標頭都沒等到是連不上；收到回應之後才沒了聲音是斷線
                failure = responded
                    ? makeAIError('disconnected', CLIENT_MESSAGES.disconnected, { retryable: true, requestId: requestId })
                    : networkError({ retryable: true });
            } else if (err && err.name === 'AIError') {
                failure = err;
            } else {
                // fetch 的失敗（離線、DNS、TLS、CORS 被擋）瀏覽器一律只給 TypeError，不給細節；
                // 原始錯誤寫進 log，debug panel 裡看得到
                failure = streaming
                    ? makeAIError('disconnected', CLIENT_MESSAGES.disconnected, { retryable: true, requestId: requestId })
                    : networkError({ retryable: true, requestId: requestId });
            }
            // 有些錯誤建立時還不知道 requestId（例如解析器發現事件過大）；補上目前已知的，
            // 回報問題時才對得上閘道的 log
            if (failure.name === 'AIError' && !failure.requestId) failure.requestId = requestId;
            // error 事件以外的失敗（斷線、逾時、回應格式錯誤）也帶著收到的字；使用者取消的不帶
            if (stopReason !== 'cancel' && failure.partial === undefined && VISIBLE_TEXT.test(text)) failure.partial = text;
            if (failure.name === 'AIError' && failure.retryAfter && COOLDOWN_CODES.indexOf(failure.code) !== -1) {
                var nowMs = performance.now();
                var blockMs = failure.retryAfter * 1000;
                blockMs += Math.min(blockMs * 0.3 * Math.random(), COOLDOWN_JITTER_MAX_MS);
                blockMs = Math.min(blockMs, failure.code === 'busy' ? BUSY_COOLDOWN_MAX_MS : COOLDOWN_MAX_MS);
                if (!cooldown || nowMs + blockMs > cooldown.until) {
                    cooldown = { until: nowMs + blockMs, code: failure.code, message: failure.message };
                }
                // 顯示的秒數照實際要等的時間
                failure.retryAfter = toRetryAfter((cooldown.until - nowMs) / 1000);
            }
            log(failure.name === 'AbortError' ? 'info' : 'warn', 'AI 任務失敗', {
                task: taskId,
                requestId: requestId,
                code: failure.code || failure.name,
                cause: failure === err ? undefined : formatError(err),
                elapsedMs: Date.now() - startedAt
            });
            throw failure;
        } finally {
            clearTimeout(timer);
            clearTimeout(idleTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            // 一律中止這個請求，連線才會釋放；串流已經正常結束的話，abort 沒有任何作用。
            // 提早離開（收到 done、出錯、取消）時連線一關，閘道那端就會停止上游。
            // 不能只靠 reader.cancel()：Content-Type 不對、或不是閘道給的錯誤回應時，body 根本
            // 不讀，也就沒有 reader 可以 cancel。同一個主機的 HTTP/1.1 連線只有 6 條，連續 6 次
            // 之後所有請求都會卡住；而且 Firefox 的 reader.cancel() 不會關掉 HTTP/1.1 連線，
            // abort() 兩個瀏覽器都會關。
            controller.abort();
        }
    }

    function formatSeconds(seconds) {
        if (seconds < 60) return seconds + ' 秒';
        var minutes = Math.floor(seconds / 60);
        var rest = seconds % 60;
        return minutes + ' 分' + (rest ? ' ' + rest + ' 秒' : '鐘');
    }

    // 給畫面顯示用的一句話。runTask 丟出的任何錯誤都可以丟進來
    function describeError(err) {
        if (!err) return '發生未知的錯誤，請稍後再試。';
        if (err.name === 'AbortError') return '已取消。';
        if (err.name === 'TimeoutError') return '等待 AI 回應的時間太長了，請稍後再試。';
        if (err.name === 'AIError') {
            if (err.retryAfter > 0 && err.retryAfter <= 3600) {
                return err.message.replace(/。$/, '') + '（大約 ' + formatSeconds(err.retryAfter) + '後可以再試）。';
            }
            return err.message;
        }
        return '抱歉，AI 服務發生錯誤，請稍後再試。';
    }

    // mountProgress 在任務進行中顯示進度，用法：
    //
    //   var ctrl = new AbortController();
    //   var progress = PlatformAI.mountProgress(progressEl, {
    //       onCancel: function () { ctrl.abort(); },
    //       focusTarget: submitBtn
    //   });
    //   try {
    //       var r = await PlatformAI.runTask(id, input, { signal: ctrl.signal, onProgress: progress.update });
    //   } finally {
    //       progress.finish();
    //   }
    //
    // 會先清空 container。container 和它的上層都不能是 live region，否則取消按鈕與每秒更新的
    // 秒數都可能被唸出來：Safari 用的 WebKit 會把計時器 aria-live="off" 裡的變化照樣算給外層
    // （見 WebKit 的 AXObjectCache::handleTextChanged）。結果另外放進 live region。
    // finish() 移除進度區塊時，焦點若還在區塊裡，例如剛按了取消，就交給 focusTarget，沒給才交給
    // container。focusTarget 給發起任務的控制項。空的 container 通常高度是 0，看不到焦點框，WebKit
    // 也不把它放進無障礙樹（見 AccessibilityRenderObject::computeIsIgnored）。放結果的 live region
    // 也不適合，螢幕閱讀器會在焦點移入時唸一次內容，live region 又唸一次。
    // 階段文字放在 role="status" 裡，螢幕閱讀器在階段改變時會唸出來。
    // 這個 status 插入時是空的，約 100 毫秒後才填入第一句：多數螢幕閱讀器不唸插入當下就
    // 已經在裡面的內容，只唸之後的變化。
    // 每秒跳動的「已等待幾秒」用 role="timer" 加 aria-live="off"，看得到也讀得到，但不會每秒插話。
    // 第一次排隊時在 status 外加一行分批送出的提醒，名次變動時 status 重唸也不會唸到它。
    // 用到的樣式自己注入，不依賴頁面的 CSS（Tailwind 不會掃描 public/ 底下的 JS）。
    //
    var INITIAL_PROGRESS_TEXT = '正在連線 AI 服務…';
    var RETRYING_NOW_TEXT = 'AI 服務有點忙，正在重新嘗試…';
    var QUEUED_HINT_TEXT = '同一個網路同時使用的人多時，請分批送出。';
    var STATUS_FILL_DELAY_MS = 100;

    function retrySeconds(p) {
        return Math.max(1, Math.ceil((Number(p.delayMs) || 0) / 1000));
    }

    // 看不懂的 phase（閘道日後新增的）回傳 null：畫面維持上一句，不要倒退回「正在連線」
    function phaseText(progress) {
        var p = progress || {};
        var round = Number.isFinite(p.round) && p.round > 1 ? '（第 ' + p.round + ' 輪）' : '';
        switch (p.phase) {
            case 'accepted': return '已送出，等待 AI 開始…';
            case 'queued':
                return p.position > 1 ? '排隊中，前面還有 ' + (p.position - 1) + ' 位…' : '排隊中，下一個就輪到你…';
            // 排過隊的任務輪到了；到第一個 token 之前，WinLab 忙的時候可能還要等一兩分鐘
            case 'started': return '輪到你了，等待 AI 開始回應…';
            case 'thinking': return 'AI 正在思考' + round + '…';
            case 'writing': return 'AI 正在撰寫回答' + round + '…';
            case 'continuing': return '回答比較長，AI 正在接著寫' + round + '…';
            case 'retrying': return 'AI 服務有點忙，' + formatSeconds(retrySeconds(p)) + '後自動重試…';
            default: return null;
        }
    }

    function injectProgressStyle() {
        if (document.getElementById('platform-ai-progress-style')) return;
        var style = document.createElement('style');
        style.id = 'platform-ai-progress-style';
        style.textContent =
            '@keyframes platform-ai-spin{to{transform:rotate(360deg)}}' +
            '.platform-ai-spinner{width:20px;height:20px;flex-shrink:0;border:3px solid #e5e7eb;' +
            'border-top-color:#14b8a6;border-radius:50%;animation:platform-ai-spin 1s linear infinite}' +
            '@media (prefers-reduced-motion:reduce){.platform-ai-spinner{animation:none}}';
        document.head.appendChild(style);
    }

    function mountProgress(container, options) {
        options = options || {};
        injectProgressStyle();

        var root = document.createElement('div');
        root.className = 'platform-ai-progress';
        root.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:8px 12px;padding:16px 0;color:#374151';
        var spinner = document.createElement('div');
        spinner.className = 'platform-ai-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        var status = document.createElement('span');
        status.setAttribute('role', 'status');
        var elapsed = document.createElement('span');
        elapsed.setAttribute('role', 'timer');
        elapsed.setAttribute('aria-live', 'off');
        elapsed.style.cssText = 'font-size:0.875em;color:#4b5563;font-variant-numeric:tabular-nums';
        root.appendChild(spinner);
        root.appendChild(status);
        root.appendChild(elapsed);

        if (typeof options.onCancel === 'function') {
            var cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.textContent = '取消';
            // 邊框要和白底有 3:1 的對比，才看得出這裡有個按鈕（WCAG 1.4.11）
            cancelBtn.style.cssText = 'padding:2px 12px;border:1px solid #6b7280;border-radius:6px;background:#fff;color:#374151;cursor:pointer;font-size:0.875em';
            cancelBtn.addEventListener('click', function () {
                if (cancelBtn.getAttribute('aria-disabled') === 'true') return;
                // 用 aria-disabled 而不是 disabled：disabled 的按鈕會失去焦點，鍵盤使用者的
                // 焦點就掉回 <body>，得從頁首重新找起
                cancelBtn.setAttribute('aria-disabled', 'true');
                cancelBtn.style.opacity = '0.6';
                cancelBtn.style.cursor = 'default';
                notify(options.onCancel);
            });
            root.appendChild(cancelBtn);
        }

        container.textContent = '';
        container.appendChild(root);

        // 填入之前收到的進度只記下最新的一句，時間到再一次填進去
        var filled = false;
        var pendingText = INITIAL_PROGRESS_TEXT;
        var fillTimer = setTimeout(function () {
            filled = true;
            status.textContent = pendingText;
        }, STATUS_FILL_DELAY_MS);
        var retryTimer = null;
        var hint = null;
        function show(text) {
            if (!filled) {
                pendingText = text;
            } else if (status.textContent !== text) {
                // 文字沒變就不要重寫，否則螢幕閱讀器會把同一句再唸一次
                status.textContent = text;
            }
        }

        var startedAt = Date.now();
        var ticker = setInterval(function () {
            // 頁面自己把 container 清掉了也要停，不留一個永遠在跑的計時器
            if (!root.isConnected) {
                clearInterval(ticker);
                return;
            }
            elapsed.textContent = '已等待 ' + formatSeconds(Math.floor((Date.now() - startedAt) / 1000));
        }, 1000);

        return {
            element: root,
            update: function (progress) {
                var text = phaseText(progress);
                if (text === null) return;
                clearTimeout(retryTimer);
                show(text);
                if (progress.phase === 'queued' && !hint) {
                    hint = document.createElement('p');
                    hint.textContent = QUEUED_HINT_TEXT;
                    hint.style.cssText = 'flex-basis:100%;margin:0;text-align:center;font-size:0.875em;color:#4b5563';
                    root.appendChild(hint);
                }
                // 倒數到了就改口：重試送出之後，要等上游的第一個 token 才有下一個進度
                if (progress.phase === 'retrying') {
                    retryTimer = setTimeout(function () { show(RETRYING_NOW_TEXT); }, retrySeconds(progress) * 1000);
                }
            },
            finish: function () {
                clearTimeout(fillTimer);
                clearTimeout(retryTimer);
                clearInterval(ticker);
                // 焦點在進度區塊裡就先移走：區塊一移除，焦點會掉回 <body>。目標取不到焦點才補上
                // tabindex="-1"；按鈕、連結本來就能取得焦點，補了反而會被移出 Tab 的順序。
                if (root.contains(document.activeElement)) {
                    var target = options.focusTarget || container;
                    target.focus({ preventScroll: true });
                    if (document.activeElement !== target) {
                        target.setAttribute('tabindex', '-1');
                        target.focus({ preventScroll: true });
                    }
                }
                if (root.parentNode) root.parentNode.removeChild(root);
            }
        };
    }

    /**
     * perFrame 包住 fn：回傳的函式呼叫幾次都可以，fn 每個畫面最多執行一次，拿到最後一次的參數。
     * 邊收邊顯示的草稿每次都重畫全文，片段一次到好幾段或頁面忙的時候，多畫的那些看不到。
     * 結束時要呼叫 cancel()，否則排著的那次會在最後的答案換上之後又畫出草稿。
     * @param {Function} fn @returns {Function & { cancel: () => void }}
     */
    function perFrame(fn) {
        var frame = 0;
        var args = null;
        function run() {
            var latest = args;
            frame = 0;
            args = null;
            notify.apply(null, [fn].concat(latest));
        }
        function schedule() {
            args = Array.prototype.slice.call(arguments);
            if (!frame) frame = global.requestAnimationFrame(run);
        }
        schedule.cancel = function () {
            if (frame) global.cancelAnimationFrame(frame);
            frame = 0;
            args = null;
        };
        return schedule;
    }

    // renderMarkdown 把 AI 回應的 markdown 子集安全地轉成 HTML。
    //
    // 安全模型（順序不可顛倒）：
    //
    //   AI 的輸出是「不可信來源」，模型可能（被誘導）回傳含
    //   `<script>`、`<img onerror=...>`、`onclick=...` 等可執行 HTML
    //   的字串。若直接 innerHTML 注入會造成 XSS。
    //
    //   因此本函式採「先跳脫、後渲染」：
    //     1. 先對整段文字做 HTML escape（& < > " '），
    //        此時任何 AI 想注入的 `<script>` 都已變成無害的字面文字
    //        `&lt;script&gt;`，瀏覽器不會把它當標籤執行。
    //     2. 之後才用「我們自己產生」的、白名單內的標籤
    //        (<strong>/<em>/<code>/<br>/<li>...) 取代 markdown 標記。
    //
    //   這個順序是關鍵：如果先渲染 markdown、後 escape，會把我們
    //   自己插入的 <strong> 也一起 escape 掉（功能壞掉）；如果只渲染
    //   不 escape，AI 注入的 HTML 就會原樣執行（安全壞掉）。
    //
    //   另外刻意「不」支援連結 [](...)、圖片 ![]()、原始 HTML，
    //   它們都是注入面（javascript: URL、onerror 事件等），
    //   排除後本函式產生的 HTML 標籤集合是固定且封閉的。
    //
    function escapeHtml(text) {
        // 先把字串化，再依序替換 5 個危險字元。
        // 必須最先處理 & ，否則後續替換產生的 &lt; 會被二次替換。
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderMarkdown(text) {
        // 步驟 1：在套用任何 markdown 之前先做 HTML escape。
        // 經過這一步後，字串裡不可能再有可被瀏覽器解析的標籤 / 屬性。
        var safe = escapeHtml(text);

        // 步驟 2：在「已跳脫」的安全文字上套 markdown 子集。
        // 以下所有 <...> 都是本函式自己寫死的白名單標籤，
        // 內容部分早已 escape，故不會引入注入面。

        // 逐行處理：標題與清單是行層級語法
        var lines = safe.split('\n');
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];

            // 行首標題 `#`～`######`：去除井號，轉為 <strong>
            // （escape 後 `#` 仍是 `#`，不受影響）
            var heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
            if (heading) {
                out.push('<strong>' + heading[2] + '</strong>');
                continue;
            }

            // 行首清單 `- ` 或 `* `：轉為 • 項目
            var listItem = line.match(/^\s*[-*]\s+(.*)$/);
            if (listItem) {
                out.push('<li style="list-style:none">• ' + listItem[1] + '</li>');
                continue;
            }

            out.push(line);
        }
        var result = out.join('\n');

        // 行內語法（在整段文字上套用）：
        // 粗體 **text** → <strong>，斜體 *text* → <em>，行內碼 `code` → <code>
        // 先處理 ** 再處理 *，否則 ** 會被 * 規則先吃掉。

        // 行內碼：`...`（escape 後反引號仍是反引號）
        result = result.replace(/`([^`\n]+)`/g, '<code>$1</code>');

        // 粗體：**...**（非貪婪，不跨行）
        result = result.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

        // 斜體：*...*（非貪婪，不跨行；此時剩下的 * 都是單顆）
        result = result.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');

        // 換行：\n → <br>
        result = result.replace(/\n/g, '<br>');

        return result;
    }

    global.PlatformAI = {
        __version: VERSION,
        formatError: formatError,
        getGatewayUrl: getGatewayUrl,
        runTask: runTask,
        describeError: describeError,
        mountProgress: mountProgress,
        renderMarkdown: renderMarkdown,
        perFrame: perFrame,
        log: log,
        getLogs: getLogs,
        clearLogs: clearLogs,
        mountDebugPanel: mountDebugPanel,
        _safeStringify: safeStringify
    };

    // 依條件自動掛載 panel
    if (shouldAutoMountPanel()) {
        if (typeof document !== 'undefined' && document.readyState !== 'loading') {
            mountDebugPanel();
        } else if (typeof document !== 'undefined') {
            document.addEventListener('DOMContentLoaded', mountDebugPanel, { once: true });
        }
    }
})(typeof window !== 'undefined' ? window : this);
