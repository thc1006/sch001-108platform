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

    if (global.PuterAI && global.PuterAI.__version === 2) {
        return; // 已載入，避免重複定義
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
    // callGeminiWithFallback（加入 logger）
    // ------------------------------------------------------------
    async function callGeminiWithFallback(prompt, options) {
        options = options || {};
        if (typeof puter === 'undefined' || !puter || !puter.ai || typeof puter.ai.chat !== 'function') {
            var e = new Error('Puter.js 尚未載入完成，請重新整理頁面。');
            log('error', 'Puter.js 未就緒', { hasPuter: typeof puter !== 'undefined' });
            throw e;
        }

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
    // 匯出
    // ------------------------------------------------------------
    global.PuterAI = {
        __version: 2,
        MODELS: MODELS,
        formatPuterError: formatPuterError,
        callGeminiWithFallback: callGeminiWithFallback,
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
