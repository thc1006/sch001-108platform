/**
 * Puter.js AI 共用 helper
 *
 * 暴露為 window.PuterAI = {
 *   MODELS, formatPuterError, callGeminiWithFallback,
 *   log, getLogs, clearLogs, mountDebugPanel
 * }
 *
 * 使用：
 *   <script src="https://js.puter.com/v2/"></script>
 *   <script src="/path/to/shared/puter-ai.js"></script>
 *   const resp = await PuterAI.callGeminiWithFallback(prompt, { signal: ... });
 *
 * 前端 debug panel（使用者不用開 DevTools 也能看錯誤）：
 *   - URL 加 `?debug=1` 自動啟用
 *   - 或 localStorage.setItem('PUTER_DEBUG', '1') 持久啟用
 *   - panel 固定右下、可收合、可複製全部事件、可清空
 */
(function (global) {
    'use strict';

    // 版號只寫這一個地方。守衛與匯出各寫一次的話，有人把匯出改成 4 卻沒動守衛，
    // 這支腳本就再也不會提早返回，每載入一次覆寫一次全域物件——而那正是它想避免的事。
    var VERSION = 3;

    // 比較是 >=，不是 ===。用 === 的話，同一頁若先載到新版、後又載到一份舊的
    // （快取、第三方嵌入、頁面自己多寫了一行 script），舊的那份會看到版號不等於
    // 自己的，於是不返回、把新版整個覆蓋掉——安靜降級成舊版行為。
    if (global.PuterAI && global.PuterAI.__version >= VERSION) {
        return; // 同版或更新的版本已經載入了
    }

    var MODELS = ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-3-flash-preview'];
    var MAX_LOGS = 200;
    var logs = [];
    var panelEl = null;
    var bodyEl = null;

    // ------------------------------------------------------------
    // Safe stringify（處理循環引用、BigInt、不可序列化值、primitive）
    // ------------------------------------------------------------
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

    // ------------------------------------------------------------
    // 錯誤格式化：處理 Error / DOMException / Puter 純物件
    // ------------------------------------------------------------
    function formatPuterError(err) {
        if (err === null || err === undefined) return 'unknown';

        // Error、DOMException、或其他具 name/message 的物件
        // 注意：DOMException 在舊瀏覽器 `instanceof Error` 為 false，
        // 所以不能只用 instanceof，改查 name/message 屬性
        if (typeof err === 'object' &&
            (typeof err.name === 'string' || typeof err.message === 'string')) {
            var name = err.name || 'Error';
            var message = err.message || '';
            if (err.error && typeof err.error === 'object' && err.error.code) {
                return '[' + err.error.code + '] ' + name + (message ? ': ' + message : '');
            }
            return name + (message ? ': ' + message : '');
        }

        // Puter 純物件 shape：{success:false, error:{code, message}} 或 {error:"string"}
        if (typeof err === 'object' && err.error !== undefined) {
            var inner = err.error;
            if (typeof inner === 'string') return inner;
            if (typeof inner === 'object' && inner !== null) {
                var code = inner.code || inner.status || '?';
                var msg = inner.message || inner.name || safeStringify(inner);
                return '[' + code + '] ' + msg;
            }
        }

        return safeStringify(err);
    }

    // ------------------------------------------------------------
    // Logger
    // ------------------------------------------------------------
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
            if (meta != null) consoleFn.call(console, '[PuterAI]', message, meta);
            else consoleFn.call(console, '[PuterAI]', message);
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

    // ------------------------------------------------------------
    // Debug panel（浮動 UI，使用者端可見）
    // ------------------------------------------------------------
    function shouldAutoMountPanel() {
        try {
            if (typeof window === 'undefined' || !window.location) return false;
            var qs = window.location.search || '';
            if (/[?&]debug=1(?:&|$)/.test(qs)) return true;
            if (window.localStorage && window.localStorage.getItem('PUTER_DEBUG') === '1') return true;
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
        panelEl.id = 'puter-ai-debug-panel';
        panelEl.setAttribute('role', 'region');
        panelEl.setAttribute('aria-label', 'Puter AI Debug Log');
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
        title.textContent = '🔧 Puter AI Log';
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
                toggleBtn.setAttribute('aria-label', 'Collapse Puter AI log');
                toggleBtn.setAttribute('aria-expanded', 'true');
            } else {
                bodyEl.style.display = 'none';
                toggleBtn.textContent = '+';
                toggleBtn.setAttribute('aria-label', 'Expand Puter AI log');
                toggleBtn.setAttribute('aria-expanded', 'false');
            }
        });
        toggleBtn.setAttribute('aria-label', 'Collapse Puter AI log');
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
        closeBtn.setAttribute('aria-label', 'Close Puter AI log panel');

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

    // ------------------------------------------------------------
    // 驗證：明確要求建立 temporary user
    // ------------------------------------------------------------
    //
    // 為什麼要顯式做這件事：先前完全不碰 puter.auth，直接呼叫 puter.ai.chat()，
    // 由 Puter.js 自行決定何時、以什麼方式要求使用者驗證。改為明確呼叫
    // signIn({ attempt_temp_user_creation: true })，讓首次造訪的學生能以臨時帳號
    // 直接試用，不必先註冊。
    //
    // 兩個限制務必理解，否則會寫出看似正常、實際被瀏覽器擋掉的程式碼：
    //
    //   1. signIn() 必須在 user gesture（click／tap）的 transient activation
    //      期間內呼叫，否則 popup 會被瀏覽器封鎖。因此 ensureSignedIn() 必須是
    //      callGeminiWithFallback() 的「第一個 await」——呼叫端都是在 click
    //      handler 內同步呼叫本函式，中間不得插入其他 await。
    //      （已稽核 9 個呼叫點，全部符合。）
    //
    //   2. attempt_temp_user_creation 主要服務首次造訪者。若瀏覽器已有 Puter
    //      使用紀錄、舊 session、登出狀態，或被判定不適合建立臨時帳號，Puter
    //      仍可能轉向一般登入／註冊流程。因此登入後一律以 getUser() 回報實際
    //      的 is_temp，不可假設一定是臨時帳號。
    //
    var signInPromise = null; // 同頁併發呼叫共用，避免同時彈出多個 popup

    async function describeCurrentUser() {
        try {
            var user = await puter.auth.getUser();
            var info = {
                username: user && user.username,
                temporary: Boolean(user && user.is_temp)
            };
            log('info', 'Puter 已登入', info);
            return info;
        } catch (err) {
            // 已登入但拿不到使用者資訊：不阻斷後續 AI 呼叫
            log('warn', '取得 Puter 使用者資訊失敗：' + formatPuterError(err));
            return null;
        }
    }

    async function ensureSignedIn() {
        // puter.auth 不存在（舊版 Puter.js、或測試只 mock 了 ai）→ 不阻斷，
        // 交由 puter.ai.chat() 沿用既有行為。
        if (typeof puter === 'undefined' || !puter || !puter.auth ||
            typeof puter.auth.signIn !== 'function') {
            log('debug', 'puter.auth 不可用，略過顯式登入');
            return null;
        }

        var signedIn = false;
        try {
            signedIn = puter.auth.isSignedIn();
        } catch (err) {
            log('warn', 'isSignedIn() 失敗，視為未登入：' + formatPuterError(err));
        }
        if (signedIn) return describeCurrentUser();

        // 併發時共用同一個登入流程，否則多個 AI 呼叫會各彈一個 popup
        if (signInPromise) return signInPromise;

        signInPromise = (async function () {
            try {
                log('info', '要求 Puter 登入（嘗試建立臨時帳號）');
                await puter.auth.signIn({ attempt_temp_user_creation: true });
                return await describeCurrentUser();
            } catch (err) {
                // 使用者關閉 popup、popup 被擋、或轉向一般登入後放棄，都會走到這裡。
                // 不 throw：讓後續 puter.ai.chat() 產生真正的錯誤，行為不比改動前差。
                log('error', 'Puter 登入未完成：' + formatPuterError(err));
                return null;
            } finally {
                signInPromise = null;
            }
        })();
        return signInPromise;
    }


    // ------------------------------------------------------------
    // callGeminiWithFallback（加入 logger）
    // ------------------------------------------------------------
    async function callGeminiWithFallback(prompt, options) {
        options = options || {};
        if (typeof puter === 'undefined' || !puter || !puter.ai || typeof puter.ai.chat !== 'function') {
            var e = new Error('Puter.js 尚未載入完成，請重新整理頁面。');
            log('error', 'Puter.js 未就緒', { hasPuter: typeof puter !== 'undefined' });
            throw e;
        }

        // 必須是本函式的第一個 await：呼叫端在 click handler 內同步呼叫本函式，
        // 這樣 signIn() 仍在 transient user activation 期間內，popup 不會被擋。
        await ensureSignedIn();

        log('info', 'AI 呼叫開始', { promptLength: prompt ? prompt.length : 0, options: { stream: !!options.stream, hasSignal: !!options.signal } });

        var lastErr;
        for (var i = 0; i < MODELS.length; i++) {
            var model = MODELS[i];
            try {
                var callOpts = Object.assign({}, options, { model: model });
                var result = await puter.ai.chat(prompt, callOpts);
                log('info', '模型 ' + model + ' 成功');
                return result;
            } catch (err) {
                lastErr = err;
                var detail = formatPuterError(err);
                log('warn', '模型 ' + model + ' 失敗：' + detail, { name: err && err.name });
                if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
                    log('error', '使用者取消或逾時，不再 fallback');
                    throw err;
                }
            }
        }
        log('error', '所有模型皆失敗', { lastError: formatPuterError(lastErr) });
        throw lastErr;
    }

    // ------------------------------------------------------------
    // renderMarkdown：把 AI 回應的 markdown 子集安全地轉成 HTML
    // ------------------------------------------------------------
    //
    // 安全模型（務必理解，順序不可顛倒）：
    //
    //   AI 的輸出是「不可信來源」——模型可能（被誘導）回傳含
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
    //   另外刻意「不」支援連結 [](...)、圖片 ![]()、原始 HTML
    //   ——它們都是注入面（javascript: URL、onerror 事件等），
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
        // 步驟 1：HTML escape——在套用任何 markdown 之前先做。
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
        // 注意先處理 ** 再處理 *，否則 ** 會被 * 規則先吃掉。

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

    // ------------------------------------------------------------
    // 匯出
    // ------------------------------------------------------------
    global.PuterAI = {
        __version: VERSION,
        MODELS: MODELS,
        formatPuterError: formatPuterError,
        ensureSignedIn: ensureSignedIn,
        callGeminiWithFallback: callGeminiWithFallback,
        renderMarkdown: renderMarkdown,
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
