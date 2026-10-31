/**
 * PlatformAI helper 單元測試（以 Playwright 執行）
 *
 * 前置：
 *   npm ci
 *   npx playwright install chromium
 *
 * 執行：
 *   npx playwright test tests/e2e/platform-ai.spec.js
 *
 * 伺服器由 playwright.config.js 的 webServer 自動啟動，不需要另開 terminal。
 */

const { test, expect } = require('@playwright/test');

// clock.install() 之後時間仍照真實時間流動，負載高時 runFor 之間會多出幾百毫秒，
// 斷言「計時器還沒到」就可能提早失敗。pauseAt 之後只有 runFor、fastForward 會推進時間。
async function pauseClock(page) {
    await page.clock.install({ time: 0 });
    await page.clock.pauseAt(10_000);
}

// 允許透過 BASE_URL 環境變數覆寫測試伺服器位置，方便 port 8000 被占用時切換
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const FIXTURE_URL = BASE_URL + '/tests/fixtures/platform-ai.html';

async function gotoFixture(page, queryString = '') {
    await page.goto(FIXTURE_URL + queryString);
    // 等待 shared/platform-ai.js 載入完成
    await page.waitForFunction(() => window.__READY__ === true && typeof window.PlatformAI === 'object');
}

/**
 * 以 addInitScript 注入頁面：一個假的閘道（取代 window.fetch）與幾個小工具。
 * 不用 page.route，是因為 route.fulfill 一次給完整個 body，測不到事件被切在任意
 * 位置、串流掛住、中途中止這些情況；這裡的 ReadableStream 每次只吐一個片段。
 *
 * __installFakeGateway(spec)：
 *   chunks             依序送出的片段（字串，或位元組陣列）；送完就結束串流
 *   chunkDelayMs       每個片段之前先等這麼久（配合 page.clock 測心跳）
 *   heartbeatMs        片段送完之後不結束，每隔這麼久送一次心跳（: ping），直到被 abort
 *   hangAfterChunks    送完之後不結束也不再送（測逾時、取消、done 之後關連線）
 *   failAfterChunks    送完之後串流以 TypeError 中斷（連線中途斷掉時瀏覽器給的就是它）
 *   hangBeforeHeaders  連回應標頭都不給
 *   headersDelayMs     等這麼久才給回應標頭
 *   networkError       fetch 直接失敗（離線、CORS 被擋時瀏覽器給的就是 TypeError）
 *   status / headers / textBody   開始串流之前就拒絕的回應；headers 的值給 null 表示拿掉
 * 呼叫紀錄在 window.__gateway.calls；fetch 的 signal 被 abort 時 aborted 變 true；
 * 串流被用戶端 cancel 時 cancelled 變 true；pulls 是 body 被讀取（pull）的次數。
 */
function fakeGatewayScript() {
    window.__installFakeGateway = function (spec) {
        spec = spec || {};
        const state = { calls: [], aborted: false, cancelled: false, pulls: 0 };
        window.__gateway = state;
        window.fetch = function (url, init) {
            init = init || {};
            state.calls.push({
                url: String(url),
                method: init.method,
                headers: init.headers,
                body: init.body,
                credentials: init.credentials,
                cache: init.cache,
                redirect: init.redirect,
            });
            const signal = init.signal;
            const abortError = () => new DOMException('The operation was aborted.', 'AbortError');
            if (signal) signal.addEventListener('abort', () => { state.aborted = true; });
            const respond = () => {
                const headers = new Headers({
                    'content-type': 'text/event-stream; charset=utf-8',
                    'x-request-id': 'req-header',
                });
                for (const [name, value] of Object.entries(spec.headers || {})) {
                    if (value === null) headers.delete(name);
                    else headers.set(name, value);
                }
                if (spec.textBody !== undefined) {
                    return new Response(spec.textBody, { status: spec.status || 200, headers });
                }
                const encoder = new TextEncoder();
                const queue = (spec.chunks || []).map((c) => (typeof c === 'string' ? encoder.encode(c) : new Uint8Array(c)));
                const body = new ReadableStream({
                    start(controller) {
                        if (signal) {
                            signal.addEventListener('abort', () => {
                                try { controller.error(abortError()); } catch (_) {}
                            });
                        }
                    },
                    async pull(controller) {
                        state.pulls++;
                        if (queue.length) {
                            if (spec.chunkDelayMs) await new Promise((r) => setTimeout(r, spec.chunkDelayMs));
                            controller.enqueue(queue.shift());
                            return;
                        }
                        if (spec.heartbeatMs) {
                            await new Promise((r) => setTimeout(r, spec.heartbeatMs));
                            if (!(signal && signal.aborted)) controller.enqueue(encoder.encode(': ping\n\n'));
                            return;
                        }
                        if (spec.hangAfterChunks) await new Promise(() => {});
                        if (spec.failAfterChunks) {
                            controller.error(new TypeError('network error'));
                            return;
                        }
                        controller.close();
                    },
                    cancel() { state.cancelled = true; },
                });
                return new Response(body, { status: spec.status || 200, headers });
            };
            return new Promise((resolve, reject) => {
                if (signal && signal.aborted) return reject(abortError());
                if (spec.networkError) return reject(new TypeError('Failed to fetch'));
                if (spec.hangBeforeHeaders) {
                    signal.addEventListener('abort', () => reject(abortError()));
                    return;
                }
                if (spec.headersDelayMs) {
                    const timer = setTimeout(() => resolve(respond()), spec.headersDelayMs);
                    signal.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); });
                    return;
                }
                resolve(respond());
            });
        };
    };
    window.__setGatewayMeta = function (content) {
        document.querySelectorAll('meta[name="ai-gateway-url"]').forEach((m) => m.remove());
        if (content === null) return;
        const meta = document.createElement('meta');
        meta.name = 'ai-gateway-url';
        meta.content = content;
        document.head.appendChild(meta);
    };
    window.__sse = (event, data) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
    // 把 runTask 的結果或錯誤攤平成可以傳回 Node 端的物件
    window.__settle = (promise) => promise.then(
        (value) => ({ ok: true, value }),
        (e) => ({
            ok: false,
            name: e.name,
            code: e.code,
            message: e.message,
            retryable: e.retryable,
            retryAfter: e.retryAfter,
            requestId: e.requestId,
            status: e.status,
            field: e.field,
            partial: e.partial,
            describe: window.PlatformAI.describeError(e),
        }),
    );
}

test.describe('PlatformAI 共用 module', () => {

    test.describe('全域物件', () => {
        // 這一頁有九個 .astro 頁面各自寫一行 <script src=".../platform-ai.js">，而使用者
        // 在站內移動時瀏覽器快取、bfcache、以及日後可能出現的第三方嵌入都會讓同一份
        // 腳本被載入不只一次。守衛若寫成 __version === 3 這種相等比較，一份比較舊的
        // 副本在新版之後跑起來時，會發現版號不等於自己的，於是不返回、把新版整個
        // 覆蓋掉，悄悄降級，而且沒有任何地方會出聲。
        test('已載入的新版不得被後來跑起來的舊版覆蓋', async ({ page }) => {
            await page.addInitScript(() => {
                window.PlatformAI = { __version: 99, __sentinel: 'newer' };
            });
            await page.goto(FIXTURE_URL);
            await page.waitForFunction(() => window.__READY__ === true);
            const after = await page.evaluate(() => ({
                version: window.PlatformAI.__version,
                sentinel: window.PlatformAI.__sentinel,
            }));
            expect(after.version).toBe(99);
            expect(after.sentinel).toBe('newer');
        });

        // 反向：舊版或沒版號的殘留不得擋住這一份真的載入。
        test('版號較舊的殘留不得擋住新版載入', async ({ page }) => {
            await page.addInitScript(() => {
                window.PlatformAI = { __version: 1, __sentinel: 'older' };
            });
            await gotoFixture(page);
            const after = await page.evaluate(() => ({
                version: window.PlatformAI.__version,
                sentinel: window.PlatformAI.__sentinel,
                hasRunTask: typeof window.PlatformAI.runTask === 'function',
            }));
            expect(after.version).toBeGreaterThan(1);
            expect(after.sentinel).toBeUndefined();
            expect(after.hasRunTask).toBe(true);
        });

        // 頁面上已經有沒有 perFrame 的 v6 時，版號沒升的話這一份會提早返回，頁面拿不到 perFrame。
        test('沒有 perFrame 的 v6 已經在頁面上時，這一份照樣載入，perFrame 可用', async ({ page }) => {
            await page.addInitScript(() => {
                window.PlatformAI = { __version: 6 };
            });
            await gotoFixture(page);
            expect(await page.evaluate(() => typeof window.PlatformAI.perFrame)).toBe('function');
        });

        // 頁面上已經有 v7 時，版號沒升的話這一份會提早返回，排隊時不會出現分批送出的提醒。
        test('v7 已經在頁面上時，這一份照樣載入，排隊時有分批送出的提醒', async ({ page }) => {
            await page.addInitScript(() => {
                window.PlatformAI = { __version: 7 };
            });
            await gotoFixture(page);
            const text = await page.evaluate(() => {
                const box = document.createElement('div');
                document.body.appendChild(box);
                PlatformAI.mountProgress(box).update({ phase: 'queued', position: 2 });
                return box.textContent;
            });
            expect(text).toContain('請分批送出');
        });

        // 頁面上已經有 v8 時，版號沒升的話這一份會提早返回，斷線時已經收到的答案不會放在 partial。
        test('v8 已經在頁面上時，這一份照樣載入，斷線時帶著 partial', async ({ page }) => {
            await page.addInitScript(fakeGatewayScript);
            await page.addInitScript(() => {
                window.PlatformAI = { __version: 8 };
            });
            await gotoFixture(page);
            const r = await page.evaluate(() => {
                window.__setGatewayMeta('http://localhost:8787');
                window.__installFakeGateway({ chunks: [__sse('delta', { text: '寫到一半' })] });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({ code: 'disconnected', partial: '寫到一半' });
        });

        // 頁面上已經有 v9 時，版號沒升的話這一份會提早返回，忙線之後每按一次都會送出。
        test('v9 已經在頁面上時，這一份照樣載入，忙線之後的等待期間不送出', async ({ page }) => {
            await page.addInitScript(fakeGatewayScript);
            await page.addInitScript(() => {
                window.PlatformAI = { __version: 9 };
            });
            await gotoFixture(page);
            const calls = await page.evaluate(async () => {
                window.__setGatewayMeta('http://localhost:8787');
                window.__installFakeGateway({
                    status: 503,
                    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' },
                    textBody: JSON.stringify({ error: { code: 'busy', message: '目前使用的人比較多，請稍後再試。' } }),
                });
                await __settle(PlatformAI.runTask('t', { a: 'b' }));
                await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return window.__gateway.calls.length;
            });
            expect(calls).toBe(1);
        });

        test('PlatformAI 已定義，且完整暴露出 API 介面與版號', async ({ page }) => {
            await gotoFixture(page);
            const info = await page.evaluate(() => ({
                defined: typeof window.PlatformAI === 'object',
                version: window.PlatformAI.__version,
                hasFormat: typeof window.PlatformAI.formatError === 'function',
                hasLog: typeof window.PlatformAI.log === 'function',
                hasMount: typeof window.PlatformAI.mountDebugPanel === 'function',
                hasRunTask: typeof window.PlatformAI.runTask === 'function',
                hasDescribe: typeof window.PlatformAI.describeError === 'function',
                hasProgress: typeof window.PlatformAI.mountProgress === 'function',
                hasGatewayUrl: typeof window.PlatformAI.getGatewayUrl === 'function',
                puterApi: ['callGeminiWithFallback', 'ensureSignedIn', 'MODELS'].filter((key) => key in window.PlatformAI),
            }));
            expect(info.defined).toBe(true);
            // 這一支驗的是「共用 module 載進來了、介面完整」，版號是附帶資訊。
            // 釘成字面值的話，改版時這裡會紅，而它紅的原因跟它想守的東西無關，
            // 測試名稱也會跟著過時。所以只驗它是個正整數：
            // 缺欄位、被寫成字串、被寫成 0 都會紅，單純改版不會。
            expect(Number.isInteger(info.version)).toBe(true);
            expect(info.version).toBeGreaterThan(0);
            expect(info.hasFormat).toBe(true);
            expect(info.hasLog).toBe(true);
            expect(info.hasMount).toBe(true);
            expect(info.hasRunTask).toBe(true);
            expect(info.hasDescribe).toBe(true);
            expect(info.hasProgress).toBe(true);
            expect(info.hasGatewayUrl).toBe(true);
            expect(info.puterApi).toEqual([]);
        });
    });

    test.describe('formatError', () => {
        test.beforeEach(async ({ page }) => { await gotoFixture(page); });

        test('null / undefined → "unknown"', async ({ page }) => {
            expect(await page.evaluate(() => PlatformAI.formatError(null))).toBe('unknown');
            expect(await page.evaluate(() => PlatformAI.formatError(undefined))).toBe('unknown');
        });

        test('Error instance', async ({ page }) => {
            const r = await page.evaluate(() => PlatformAI.formatError(new TypeError('bad input')));
            expect(r).toBe('TypeError: bad input');
        });

        test('DOMException (AbortError) — 關鍵：舊版不 instanceof Error', async ({ page }) => {
            const r = await page.evaluate(() =>
                PlatformAI.formatError(new DOMException('aborted by user', 'AbortError'))
            );
            expect(r).toContain('AbortError');
            expect(r).toContain('aborted by user');
        });

        test('DOMException (TimeoutError)', async ({ page }) => {
            const r = await page.evaluate(() =>
                PlatformAI.formatError(new DOMException('timed out', 'TimeoutError'))
            );
            expect(r).toContain('TimeoutError');
            expect(r).toContain('timed out');
        });

        test('循環引用不會拋錯（safeStringify）', async ({ page }) => {
            const r = await page.evaluate(() => {
                const a = { x: 1 };
                a.self = a;
                return PlatformAI.formatError(a);
            });
            // a 沒有 name 與 message，會落到 safeStringify
            expect(r).toContain('[Circular]');
        });

        test('BigInt 不會讓 stringify 炸掉', async ({ page }) => {
            const r = await page.evaluate(() => PlatformAI.formatError({ value: 12345678901234567890n }));
            expect(r).toContain('12345678901234567890');
        });

        test('string 型 error 不加多餘引號（回歸：Copilot review 指出）', async ({ page }) => {
            // formatError("oops") 應回傳 "oops" 而非 '"oops"'
            const r = await page.evaluate(() => PlatformAI.formatError('oops'));
            expect(r).toBe('oops');
        });

        test('function / symbol 型 error 不會讓回傳變 undefined（回歸：Copilot review 指出）', async ({ page }) => {
            const results = await page.evaluate(() => ({
                fn: PlatformAI.formatError(function badInput() {}),
                sym: PlatformAI.formatError(Symbol('x')),
                num: PlatformAI.formatError(42),
                bool: PlatformAI.formatError(true),
            }));
            // 全部應為非空字串，契約「回傳 string」不破損
            expect(typeof results.fn).toBe('string');
            expect(results.fn.length).toBeGreaterThan(0);
            expect(results.fn).not.toBe('undefined');
            expect(typeof results.sym).toBe('string');
            expect(results.sym).toContain('Symbol');
            expect(results.num).toBe('42');
            expect(results.bool).toBe('true');
        });
    });

    test.describe('Logger', () => {
        test.beforeEach(async ({ page }) => { await gotoFixture(page); });

        test('log 事件會被收集', async ({ page }) => {
            const logs = await page.evaluate(() => {
                PlatformAI.clearLogs();
                PlatformAI.log('info', 'hello');
                PlatformAI.log('warn', 'yikes', { detail: 42 });
                return PlatformAI.getLogs();
            });
            expect(logs.length).toBe(2);
            expect(logs[0].level).toBe('info');
            expect(logs[0].message).toBe('hello');
            expect(logs[1].level).toBe('warn');
            expect(logs[1].meta.detail).toBe(42);
        });

        test('clearLogs 清空', async ({ page }) => {
            const count = await page.evaluate(() => {
                PlatformAI.log('info', 'a');
                PlatformAI.clearLogs();
                return PlatformAI.getLogs().length;
            });
            expect(count).toBe(0);
        });

        test('log(msg, null) 不會在 panel 渲染多餘的 "null"（回歸：Copilot review 指出）', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            // 只保留我們要驗的兩筆，方便斷言
            const { noMetaLine, withMetaLine } = await page.evaluate(() => {
                PlatformAI.clearLogs();
                PlatformAI.log('info', 'NO_META_MARKER', null);
                PlatformAI.log('info', 'WITH_META_MARKER', { foo: 'bar' });
                // 取出 panel 內每一行的 textContent（panel > body > 每行是一個 div）
                const body = document.querySelector('#ai-debug-panel > div:nth-of-type(2)');
                const lines = Array.from(body.querySelectorAll(':scope > div'))
                    .map(div => div.textContent);
                return {
                    noMetaLine: lines.find(t => t.includes('NO_META_MARKER')) || '',
                    withMetaLine: lines.find(t => t.includes('WITH_META_MARKER')) || '',
                };
            });
            // 沒 meta 的那一行不能出現獨立的 "null" 字串。
            expect(noMetaLine).toContain('NO_META_MARKER');
            expect(noMetaLine).not.toMatch(/\bnull\b/);
            // 有 meta 的那一行應有 JSON 附加
            expect(withMetaLine).toContain('WITH_META_MARKER');
            expect(withMetaLine).toContain('"foo"');
        });
    });

    test.describe('Debug panel', () => {
        test('手動 mountDebugPanel 會插入 DOM 元素', async ({ page }) => {
            await gotoFixture(page);
            await page.evaluate(() => PlatformAI.mountDebugPanel());
            await expect(page.locator('#ai-debug-panel')).toBeVisible();
        });

        test('?debug=1 會自動掛載 panel', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            await expect(page.locator('#ai-debug-panel')).toBeVisible();
        });

        test('localStorage.AI_DEBUG 會自動掛載 panel', async ({ page, context }) => {
            // 先拜訪 fixture 以便設定 localStorage（同源）
            await page.goto(FIXTURE_URL);
            await page.evaluate(() => localStorage.setItem('AI_DEBUG', '1'));
            // 重新載入，此時 shared/platform-ai.js 執行時會讀到 flag
            await page.reload();
            await page.waitForFunction(() => window.__READY__ === true);
            await expect(page.locator('#ai-debug-panel')).toBeVisible();
            // 清掉避免影響下一個測試
            await page.evaluate(() => localStorage.removeItem('AI_DEBUG'));
        });

        test('未啟用時不掛載 panel', async ({ page }) => {
            await gotoFixture(page);
            const count = await page.locator('#ai-debug-panel').count();
            expect(count).toBe(0);
        });

        test('header mousedown 落在按鈕上不觸發拖曳（回歸：Copilot review 指出）', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            const panel = page.locator('#ai-debug-panel');
            await expect(panel).toBeVisible();
            const initialPos = await panel.evaluate(el => {
                const r = el.getBoundingClientRect();
                return { right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom };
            });
            // 模擬在 Copy button 上按下→拖曳→鬆開
            const copyBtn = panel.getByRole('button', { name: 'Copy' });
            const box = await copyBtn.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + 100, box.y + 100);  // 拖 100px
            await page.mouse.up();
            // panel 位置應不變（button 上拖曳被忽略）
            const afterPos = await panel.evaluate(el => {
                const r = el.getBoundingClientRect();
                return { right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom };
            });
            expect(Math.abs(afterPos.right - initialPos.right)).toBeLessThan(5);
            expect(Math.abs(afterPos.bottom - initialPos.bottom)).toBeLessThan(5);
        });

        test('close + remount 後拖曳仍正常且無 listener 洩漏（回歸：Copilot review 指出）', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            const panel = page.locator('#ai-debug-panel');
            await expect(panel).toBeVisible();

            // 關閉 panel，應觸發 dragCtrl.abort() 移除 document-level listeners
            // 按鈕用 aria-label 作為可訪問名稱。
            await panel.getByRole('button', { name: /close/i }).click();
            await expect(panel).toHaveCount(0);

            // 模擬使用者在頁面上移動滑鼠（舊 listener 若沒被 abort，會觸發並可能拋錯）
            const errors = [];
            page.on('pageerror', e => errors.push(e.message));
            await page.mouse.move(100, 100);
            await page.mouse.down();
            await page.mouse.move(200, 200);
            await page.mouse.up();
            expect(errors).toHaveLength(0);

            // 重新 mount 新 panel，拖曳應在新 panel 上生效（不是被舊 listener 干擾）
            await page.evaluate(() => PlatformAI.mountDebugPanel());
            await expect(panel).toBeVisible();

            const before = await panel.evaluate(el => {
                const r = el.getBoundingClientRect();
                return { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) };
            });

            // 抓 title 文字（位於 header 非按鈕區）作為拖曳起點
            const titleBox = await panel.locator('strong').first().boundingBox();
            await page.mouse.move(titleBox.x + titleBox.width / 2, titleBox.y + titleBox.height / 2);
            await page.mouse.down();
            await page.mouse.move(titleBox.x - 80, titleBox.y + 40);
            await page.mouse.up();

            const after = await panel.evaluate(el => {
                const r = el.getBoundingClientRect();
                return { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) };
            });

            // 新 panel 位置應該因拖曳而改變（right 增加 ~80、bottom 減少 ~40）
            expect(Math.abs(after.right - before.right)).toBeGreaterThan(20);
        });

        test('log 超過 MAX_LOGS 時 panel DOM 同步限長（回歸：Copilot review 指出）', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            const { logCount, domCount } = await page.evaluate(() => {
                PlatformAI.clearLogs();
                // 推 210 筆超過預設 MAX_LOGS=200
                for (let i = 0; i < 210; i++) PlatformAI.log('info', 'msg-' + i);
                const body = document.querySelector('#ai-debug-panel > div:nth-of-type(2)');
                return {
                    logCount: PlatformAI.getLogs().length,
                    domCount: body.children.length,
                };
            });
            // 陣列有 200 上限
            expect(logCount).toBeLessThanOrEqual(200);
            // 更重要：DOM 也被同步截斷，否則 panel 會一直累積行數。
            expect(domCount).toBeLessThanOrEqual(200);
            // 1:1 對應（panel 內行數 = logs 陣列長度）
            expect(domCount).toBe(logCount);
        });

        test('toggle / close 按鈕具有可訪問的 aria-label（回歸：Copilot A11Y）', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            const panel = page.locator('#ai-debug-panel');
            await expect(panel).toBeVisible();

            const closeBtn = panel.locator('button', { hasText: /^×$/ });
            const toggleBtn = panel.locator('button', { hasText: /^–$/ });

            await expect(closeBtn).toHaveAttribute('aria-label', /close/i);
            await expect(toggleBtn).toHaveAttribute('aria-label', /collapse/i);
            await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

            // 點 toggle 收合後 aria-label 應切換為 Expand
            await toggleBtn.click();
            const expandBtn = panel.locator('button', { hasText: /^\+$/ });
            await expect(expandBtn).toHaveAttribute('aria-label', /expand/i);
            await expect(expandBtn).toHaveAttribute('aria-expanded', 'false');
        });

        test('panel 內 Clear 按鈕會清空 log 顯示', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            await page.evaluate(() => {
                PlatformAI.log('info', 'first');
                PlatformAI.log('warn', 'second');
            });
            // 預期 panel body 內有 2 行
            const panel = page.locator('#ai-debug-panel');
            await expect(panel).toBeVisible();
            // 點 Clear
            await panel.getByRole('button', { name: 'Clear' }).click();
            const logsLeft = await page.evaluate(() => PlatformAI.getLogs().length);
            expect(logsLeft).toBe(0);
        });
    });

    test.describe('getGatewayUrl', () => {
        test.beforeEach(async ({ page }) => {
            await page.addInitScript(fakeGatewayScript);
            await gotoFixture(page);
        });

        test('只接受 https（本機可用 http），去掉結尾斜線，保留路徑前綴', async ({ page }) => {
            const r = await page.evaluate(() => {
                const read = (value) => {
                    window.__setGatewayMeta(value);
                    return PlatformAI.getGatewayUrl();
                };
                return {
                    missing: read(null),
                    empty: read('   '),
                    https: read(' https://gw.example '),
                    prefix: read('https://gw.example/ai/'),
                    localhost: read('http://localhost:8787'),
                    loopback: read('http://127.0.0.1:8787/'),
                    ipv6: read('http://[::1]:8787'),
                    plainHttp: read('http://gw.example'),
                    credentials: read('https://user:pw@gw.example'),
                    query: read('https://gw.example/?model=x'),
                    hash: read('https://gw.example/#x'),
                    js: read('javascript:alert(1)'),
                    ftp: read('ftp://gw.example'),
                    garbage: read('not a url'),
                };
            });
            expect(r.missing).toBeNull();
            expect(r.empty).toBeNull();
            expect(r.https).toBe('https://gw.example');
            expect(r.prefix).toBe('https://gw.example/ai');
            expect(r.localhost).toBe('http://localhost:8787');
            expect(r.loopback).toBe('http://127.0.0.1:8787');
            expect(r.ipv6).toBe('http://[::1]:8787');
            for (const key of ['plainHttp', 'credentials', 'query', 'hash', 'js', 'ftp', 'garbage']) {
                expect(r[key], key).toBeNull();
            }
        });
    });

    test.describe('runTask（本地 LLM 閘道）', () => {
        test.beforeEach(async ({ page }) => {
            await page.addInitScript(fakeGatewayScript);
            await gotoFixture(page);
            await page.evaluate(() => window.__setGatewayMeta('http://localhost:8787'));
        });

        test('JSON 任務：依序處理事件並回傳結果；請求的內容與選項正確', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const result = { suggested_topic: '貓咪的行為', research_questions: ['一', '二', '三'], resource_types: ['甲', '乙', '丙'] };
                window.__installFakeGateway({
                    chunks: [
                        __sse('accepted', { requestId: 'req-1', task: 'starter-pack' }),
                        __sse('progress', { phase: 'thinking', round: 1, thinkingTokens: 10 }),
                        __sse('progress', { phase: 'writing', round: 1, writingTokens: 5 }),
                        __sse('done', { result, rounds: 1, continuations: [], usage: { completionTokens: 15 }, elapsedMs: 1234 }),
                    ],
                });
                const phases = [];
                const settled = await __settle(PlatformAI.runTask('starter-pack', { topic: '貓咪' }, {
                    onProgress: (p) => phases.push(p.phase),
                }));
                return { settled, phases, call: window.__gateway.calls[0], calls: window.__gateway.calls.length };
            });
            expect(r.settled.ok).toBe(true);
            expect(r.settled.value).toEqual({
                result: { suggested_topic: '貓咪的行為', research_questions: ['一', '二', '三'], resource_types: ['甲', '乙', '丙'] },
                rounds: 1,
                continuations: [],
                usage: { completionTokens: 15 },
                elapsedMs: 1234,
                requestId: 'req-1',
            });
            expect(r.phases).toEqual(['accepted', 'thinking', 'writing']);
            expect(r.calls).toBe(1);
            expect(r.call.url).toBe('http://localhost:8787/v1/tasks/starter-pack');
            expect(r.call.method).toBe('POST');
            expect(r.call.headers['Content-Type']).toBe('application/json');
            expect(JSON.parse(r.call.body)).toEqual({ input: { topic: '貓咪' } });
            // 不帶 cookie、不吃快取、不跟著轉址把輸入送去別的地方
            expect(r.call.credentials).toBe('omit');
            expect(r.call.cache).toBe('no-store');
            expect(r.call.redirect).toBe('error');
        });

        test('閘道網址有路徑前綴時接在前綴後面', async ({ page }) => {
            const url = await page.evaluate(async () => {
                window.__setGatewayMeta('https://gw.example/ai/');
                window.__installFakeGateway({ chunks: [__sse('done', { result: 'ok', rounds: 1 })] });
                await PlatformAI.runTask('t', { a: 'b' });
                return window.__gateway.calls[0].url;
            });
            expect(url).toBe('https://gw.example/ai/v1/tasks/t');
        });

        // 網路上的分塊位置是任意的：一個位元組一塊，等於把每一種切法都試過一次
        test('事件被切在任意位置（多位元組字元中間、\\r\\n 中間）仍正確解析', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const text =
                    'event: accepted\r\ndata: {"requestId":"req-2","task":"t"}\r\n\r\n' +
                    ': ping\r\n\r\n' +
                    // 只有 event 沒有 data 的區塊不算事件（HTML 標準如此）
                    'event: progress\r\n\r\n' +
                    'event: delta\r\ndata: {"text":"貓咪\\n很可愛😀"}\r\n\r\n' +
                    'event: progress\rdata: {"phase":"writing",\rdata: "round":1}\r\r' +
                    'event: done\ndata:{"result":"貓咪\\n很可愛😀","rounds":1}\n\n';
                const bytes = Array.from(new TextEncoder().encode(text), (b) => [b]);
                window.__installFakeGateway({ chunks: bytes });
                const deltas = [];
                const progress = [];
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, {
                    onDelta: (piece, all) => deltas.push([piece, all]),
                    onProgress: (p) => progress.push(p),
                }));
                return { settled, deltas, progress };
            });
            expect(r.settled.ok).toBe(true);
            expect(r.settled.value.result).toBe('貓咪\n很可愛😀');
            expect(r.settled.value.requestId).toBe('req-2');
            expect(r.deltas).toEqual([['貓咪\n很可愛😀', '貓咪\n很可愛😀']]);
            expect(r.progress).toEqual([{ phase: 'accepted' }, { phase: 'writing', round: 1 }]);
        });

        // 結尾的 \r 若要等下一塊才確定是不是 \r\n，串流就此結束時最後一個事件永遠收不到
        test('只用 \\r 當行尾、最後以 \\r\\r 結尾就關閉的串流，也收得到 done', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({
                    chunks: [
                        'event: accepted\rdata: {"requestId":"req-cr","task":"t"}\r\r',
                        'event: done\rdata: {"result":"好了","rounds":1}\r\r',
                    ],
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r.ok).toBe(true);
            expect(r.value).toMatchObject({ result: '好了', requestId: 'req-cr' });
        });

        test('以 \\r\\r 結尾的事件在同一塊就派送，不等下一塊', async ({ page }) => {
            const r = await page.evaluate(async () => {
                // 下一塊永遠不會來：accepted 要是等下一塊才派送，就會一路等到 timeoutMs
                window.__installFakeGateway({
                    chunks: ['event: accepted\rdata: {"requestId":"req-cr2","task":"t"}\r\r'],
                    hangAfterChunks: true,
                });
                const ctrl = new AbortController();
                const phases = [];
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, {
                    signal: ctrl.signal,
                    timeoutMs: 1000,
                    onProgress: (p) => { phases.push(p.phase); ctrl.abort(); },
                }));
                return { name: settled.name, phases };
            });
            expect(r).toEqual({ name: 'AbortError', phases: ['accepted'] });
        });

        // 閘道日後新增的事件，舊的頁面看不懂也不能因此失敗
        test('看不懂的事件略過：新的事件型別、沒有 event 欄位的、event 名稱前多一個空白的', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({
                    chunks: [
                        'event: notice\ndata: hello\n\n',
                        'data: 沒有 event 欄位，型別是 message\n\n',
                        // HTML 標準只去掉冒號後面的一個空白：這個事件的型別是「 done」，不是 done
                        'event:  done\ndata: {"result":"不該被當成結果","rounds":1}\n\n',
                        __sse('done', { result: '真正的結果', rounds: 1 }),
                    ],
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r.ok).toBe(true);
            expect(r.value.result).toBe('真正的結果');
        });

        test('派送之後事件型別要歸零：progress 後面沒有 event 欄位的事件不是 progress', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({
                    chunks: [
                        'event: progress\ndata: {"phase":"thinking","round":1}\n\n' +
                        'data: {"phase":"writing","round":1}\n\n',
                        __sse('done', { result: 'ok', rounds: 1 }),
                    ],
                });
                const phases = [];
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, { onProgress: (p) => phases.push(p.phase) }));
                return { ok: settled.ok, phases };
            });
            expect(r).toEqual({ ok: true, phases: ['thinking'] });
        });

        test('文字任務：onDelta 收到片段與累積的全文，結果以 done 為準', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({
                    chunks: [
                        __sse('accepted', { requestId: 'req-3', task: 't' }),
                        __sse('delta', { text: '第一段' }),
                        __sse('delta', { text: '' }),
                        __sse('delta', { text: '，第二段' }),
                        __sse('done', { result: '第一段，第二段（定稿）', rounds: 2, continuations: ['length'] }),
                    ],
                });
                const deltas = [];
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, {
                    onDelta: (piece, all) => deltas.push([piece, all]),
                }));
                return { settled, deltas };
            });
            expect(r.deltas).toEqual([['第一段', '第一段'], ['，第二段', '第一段，第二段']]);
            expect(r.settled.value.result).toBe('第一段，第二段（定稿）');
            expect(r.settled.value.continuations).toEqual(['length']);
        });

        test('串流中的 error 事件 → AIError，保留代號、可否重試與建議等待時間', async ({ page }) => {
            const r = await page.evaluate(() => {
                // 不多等隨機的秒數，等待時間就是閘道給的
                Math.random = () => 0;
                window.__installFakeGateway({
                    chunks: [
                        __sse('accepted', { requestId: 'req-4', task: 't' }),
                        __sse('progress', { phase: 'queued', position: 2 }),
                        __sse('error', { code: 'busy', message: '目前使用的人比較多，請稍後再試。', retryable: true, retryAfter: 30 }),
                    ],
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({
                ok: false,
                name: 'AIError',
                code: 'busy',
                retryable: true,
                retryAfter: 30,
                requestId: 'req-4',
                message: '目前使用的人比較多，請稍後再試。',
                describe: '目前使用的人比較多，請稍後再試（大約 30 秒後可以再試）。',
            });
        });

        // 例如答案太長沒寫完：同樣的輸入重試也沒用，頁面不該出現「再試一次」
        test('串流中的 error 事件說不能重試，就是不能重試', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({
                    chunks: [
                        __sse('accepted', { requestId: 'req-final', task: 't' }),
                        __sse('error', { code: 'incomplete', message: 'AI 的回答太長，沒能在時限內寫完。', retryable: false }),
                    ],
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({ ok: false, name: 'AIError', code: 'incomplete', retryable: false, requestId: 'req-final' });
        });

        // 頁面靠 partial 把沒寫完的答案留在畫面上
        test('串流中的 error 事件：之前收到的片段接起來放在 partial；沒收到片段或只有看不見的字元就是 undefined', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const incomplete = __sse('error', { code: 'incomplete', message: 'AI 的回答太長，沒能在時限內寫完。', retryable: false });
                window.__installFakeGateway({
                    chunks: [
                        __sse('accepted', { requestId: 'req-partial', task: 't' }),
                        __sse('delta', { text: '請先完成以下三項：\n' }),
                        __sse('delta', { text: '1. 蒐集' }),
                        incomplete,
                    ],
                });
                const withText = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'req-none', task: 't' }), incomplete] });
                const withoutText = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                // 只有零寬空白與韓文填充字：沒有看得見的字，跟沒收到一樣
                const invisible = String.fromCodePoint(0x200B) + String.fromCodePoint(0x3164);
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'req-invisible', task: 't' }), __sse('delta', { text: invisible }), incomplete] });
                const invisibleOnly = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return { withText, withoutText, invisibleOnly };
            });
            expect(r.withText).toMatchObject({ ok: false, name: 'AIError', code: 'incomplete', partial: '請先完成以下三項：\n1. 蒐集' });
            expect(r.withoutText).toMatchObject({ ok: false, code: 'incomplete' });
            expect(r.withoutText.partial).toBeUndefined();
            expect(r.invisibleOnly).toMatchObject({ ok: false, code: 'incomplete' });
            expect(r.invisibleOnly.partial).toBeUndefined();
        });

        test('開始串流之前就被拒絕（429）→ 採用閘道的訊息與 Retry-After', async ({ page }) => {
            const r = await page.evaluate(() => {
                Math.random = () => 0;
                // body 刻意不帶 retryAfter：要確定標頭真的有被讀
                window.__installFakeGateway({
                    status: 429,
                    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '120' },
                    textBody: JSON.stringify({ error: { code: 'rate_limited', message: '你的請求有點頻繁，請稍後再試。', requestId: 'req-header' } }),
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({
                ok: false,
                name: 'AIError',
                code: 'rate_limited',
                status: 429,
                retryable: true,
                retryAfter: 120,
                requestId: 'req-header',
                describe: '你的請求有點頻繁，請稍後再試（大約 2 分鐘後可以再試）。',
            });
        });

        test('Retry-After 最多採信一小時', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({
                    status: 429,
                    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '99999' },
                    textBody: JSON.stringify({ error: { code: 'rate_limited', message: '你的請求有點頻繁，請稍後再試。' } }),
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({
                retryAfter: 3600,
                describe: '你的請求有點頻繁，請稍後再試（大約 60 分鐘後可以再試）。',
            });
        });

        test('閘道回 busy 與 retryAfter → 等待期間再呼叫任何任務都直接丟出 busy，不送出請求；時間到了才再送出', async ({ page }) => {
            await pauseClock(page);
            const first = await page.evaluate(() => {
                // 隨機值固定為 0.9：等待時間是 30 + 30 × 0.3 × 0.9 = 38.1 秒
                Math.random = () => 0.9;
                window.__installFakeGateway({
                    status: 503,
                    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' },
                    textBody: JSON.stringify({ error: { code: 'busy', message: '目前使用的人比較多，請稍後再試。', retryable: true, retryAfter: 30 } }),
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            // 顯示的是實際要等的時間，不是閘道給的 30 秒
            expect(first).toMatchObject({ code: 'busy', retryAfter: 39, describe: '目前使用的人比較多，請稍後再試（大約 39 秒後可以再試）。' });
            const again = () => page.evaluate(async () => ({
                settled: await __settle(PlatformAI.runTask('u', { a: 'b' })),
                calls: window.__gateway.calls.length,
            }));
            expect(await again()).toMatchObject({
                calls: 1,
                settled: {
                    ok: false,
                    name: 'AIError',
                    code: 'busy',
                    retryable: true,
                    retryAfter: 39,
                    describe: '目前使用的人比較多，請稍後再試（大約 39 秒後可以再試）。',
                },
            });
            await page.clock.fastForward(38_000);
            expect(await again()).toMatchObject({ calls: 1, settled: { code: 'busy', retryAfter: 1 } });
            await page.clock.fastForward(1_000);
            expect((await again()).calls).toBe(2);
        });

        test('等待期間系統時間往後跳一小時 → 照樣擋著，不送出請求', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                Math.random = () => 0;
                window.__installFakeGateway({
                    status: 503,
                    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '30' },
                    textBody: JSON.stringify({ error: { code: 'busy', message: '目前使用的人比較多，請稍後再試。' } }),
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            await page.clock.setSystemTime(10_000 + 3_600_000);
            const r = await page.evaluate(async () => ({
                settled: await __settle(PlatformAI.runTask('t', { a: 'b' })),
                calls: window.__gateway.calls.length,
            }));
            expect(r).toMatchObject({ calls: 1, settled: { code: 'busy', retryAfter: 30 } });
        });

        test('rate_limited、too_many_inflight、not_ready 也要等；其他代號、或沒有 retryAfter 的不用等', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => { Math.random = () => 0.999; });
            const r = {};
            for (const code of ['rate_limited', 'too_many_inflight', 'not_ready', 'timeout', 'busy']) {
                r[code] = await page.evaluate(async (code) => {
                    // busy 這次沒有 retryAfter
                    window.__installFakeGateway({
                        status: code === 'timeout' ? 504 : 503,
                        headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': code === 'busy' ? null : '5' },
                        textBody: JSON.stringify({ error: { code, message: '請稍後再試。' } }),
                    });
                    await __settle(PlatformAI.runTask('t', { a: 'b' }));
                    const second = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                    return { calls: window.__gateway.calls.length, code: second.code };
                }, code);
                // 最長的等待是 5 + 5 × 0.3 × 0.999 秒，下一個代號之前先讓它過去
                await page.clock.fastForward(7_000);
            }
            expect(r).toEqual({
                rate_limited: { calls: 1, code: 'rate_limited' },
                too_many_inflight: { calls: 1, code: 'too_many_inflight' },
                not_ready: { calls: 1, code: 'not_ready' },
                timeout: { calls: 2, code: 'timeout' },
                busy: { calls: 2, code: 'busy' },
            });
        });

        test('隨機多等的時間最多 30 秒；總共最多等一小時，busy 最多等 10 分鐘', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => { Math.random = () => 0.999; });
            const wait = (code, retryAfter) => page.evaluate(async ([code, retryAfter]) => {
                window.__installFakeGateway({
                    status: 503,
                    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfter) },
                    textBody: JSON.stringify({ error: { code, message: '請稍後再試。' } }),
                });
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return { code: settled.code, retryAfter: settled.retryAfter, sent: window.__gateway.calls.length };
            }, [code, retryAfter]);
            // 每段等待一過就要送得出去：上限沒有生效的話，下一次呼叫還在等待期間內
            expect(await wait('busy', 3600)).toEqual({ code: 'busy', retryAfter: 600, sent: 1 });
            await page.clock.fastForward(600_001);
            expect(await wait('rate_limited', 300)).toEqual({ code: 'rate_limited', retryAfter: 330, sent: 1 });
            await page.clock.fastForward(330_001);
            expect(await wait('rate_limited', 3600)).toEqual({ code: 'rate_limited', retryAfter: 3600, sent: 1 });
            await page.clock.fastForward(3_600_001);
            expect(await wait('rate_limited', 5)).toEqual({ code: 'rate_limited', retryAfter: 7, sent: 1 });
        });

        // 兩個請求同時在進行，一個要等 120 秒、一個要等 10 秒，不論誰先被拒都以 120 秒為準
        for (const [order, first, second] of [['長的先、短的後', 'long', 'short'], ['短的先、長的後', 'short', 'long']]) {
            test(`同時進行的兩個任務先後被拒（${order}）：留下比較晚結束的等待時間，兩個錯誤都顯示它`, async ({ page }) => {
                await pauseClock(page);
                await page.evaluate(({ first, second }) => {
                    Math.random = () => 0;
                    const specs = { long: ['rate_limited', 120], short: ['busy', 10] };
                    const reject = (name, headersDelayMs) => {
                        const [code, retryAfter] = specs[name];
                        window.__installFakeGateway({
                            status: 429,
                            headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfter) },
                            textBody: JSON.stringify({ error: { code, message: '請稍後再試。' } }),
                            headersDelayMs,
                        });
                        window['__' + name] = __settle(PlatformAI.runTask('t', { a: 'b' }));
                    };
                    reject(first, 500);
                    reject(second, 1_000);
                }, { first, second });
                await page.clock.fastForward(1_000);
                const r = await page.evaluate(async () => ({
                    long: await window.__long,
                    short: await window.__short,
                    after: await __settle(PlatformAI.runTask('t', { a: 'b' })),
                }));
                expect(r.long).toMatchObject({ code: 'rate_limited', retryAfter: 120 });
                // 短的先被拒時，當下要等的就是它自己的 10 秒
                expect(r.short).toMatchObject({ code: 'busy', retryAfter: first === 'short' ? 10 : 120 });
                expect(r.after).toMatchObject({ code: 'rate_limited', retryAfter: 120 });
            });
        }

        test('開始串流之前的錯誤：閘道明說的 retryable 優先，沒說才依狀態碼判斷（408、429、5xx 可以重試）', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const retryable = async (status, error) => {
                    window.__installFakeGateway({
                        status,
                        headers: { 'content-type': 'application/json; charset=utf-8' },
                        textBody: JSON.stringify({ error }),
                    });
                    return (await __settle(PlatformAI.runTask('t', { a: 'b' }))).retryable;
                };
                return {
                    saysNo500: await retryable(500, { code: 'internal', message: '設定有誤', retryable: false }),
                    saysYes400: await retryable(400, { code: 'x', message: 'y', retryable: true }),
                    notBoolean503: await retryable(503, { code: 'busy', message: '忙', retryable: 'no' }),
                    silent408: await retryable(408, { code: 'request_timeout', message: '送出的時間太久了' }),
                    silent404: await retryable(404, { code: 'unknown_task', message: '沒有這個 AI 功能' }),
                };
            });
            expect(r).toEqual({ saysNo500: false, saysYes400: true, notBoolean503: true, silent408: true, silent404: false });
        });

        // 錯誤 JSON 很短；對方一直送下去的話，讀到上限就該停，不是照單全收
        test('錯誤回應的 body 太長：讀到上限就停下來，內容不採信', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const body = JSON.stringify({ error: { code: 'busy', message: '這段太長了，不該被採信', pad: 'x'.repeat(200 * 1024) } });
                const chunks = [];
                for (let i = 0; i < body.length; i += 1024) chunks.push(body.slice(i, i + 1024));
                window.__installFakeGateway({ status: 503, headers: { 'content-type': 'application/json' }, chunks });
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return { settled, pulls: window.__gateway.pulls, total: chunks.length };
            });
            expect(r.settled).toMatchObject({
                ok: false,
                code: 'unavailable',
                status: 503,
                requestId: 'req-header',
                message: 'AI 服務暫時無法使用，請稍後再試。',
            });
            expect(r.total).toBeGreaterThan(200);
            // 上限 16K 字，1 KiB 一塊，讀十幾塊就該停
            expect(r.pulls).toBeLessThan(30);
        });

        test('輸入不合格（400）→ 不可重試，指出是哪個欄位', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({
                    status: 400,
                    headers: { 'content-type': 'application/json; charset=utf-8' },
                    textBody: JSON.stringify({ error: { code: 'invalid_input', message: '初步想法最多 200 字（目前 250 字）', field: 'topic' } }),
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({
                ok: false,
                code: 'invalid_input',
                retryable: false,
                field: 'topic',
                describe: '初步想法最多 200 字（目前 250 字）',
            });
        });

        // 補了 CORS 標頭的代理（或同網域部署）回的錯誤頁，內容可能是英文、HTML 或內部資訊。
        // 跨網域、沒有 CORS 標頭的回應根本到不了這裡，見下面「真的跨網域」那個測試
        test('不是閘道給的錯誤回應（沒有 X-Request-Id）→ 不採信內容，一律說暫時無法使用', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({
                    status: 502,
                    headers: { 'content-type': 'text/html', 'x-request-id': null },
                    textBody: '<html><body>502 Bad Gateway nginx</body></html>',
                });
                const html = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                window.__installFakeGateway({
                    status: 500,
                    headers: { 'content-type': 'application/json', 'x-request-id': null },
                    textBody: JSON.stringify({ error: { code: 'weird', message: 'stack trace at /srv/app' } }),
                });
                const json = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return { html, json };
            });
            for (const res of [r.html, r.json]) {
                expect(res).toMatchObject({ ok: false, name: 'AIError', code: 'unavailable', retryable: true });
                expect(res.message).toBe('AI 服務暫時無法使用，請稍後再試。');
            }
            expect(r.html.status).toBe(502);
        });

        // 這兩種回應的 body 根本不會去讀。不中止請求的話連線一直占著：同一個主機的 HTTP/1.1
        // 連線只有 6 條，連續 6 次之後，之後的請求全部卡住
        test('沒讀 body 就結束的回應也要中止請求（200 但不是 SSE、不是閘道給的 502），連線才會釋放', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({ headers: { 'content-type': 'application/json' }, chunks: ['{"result":'], hangAfterChunks: true });
                const json = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                const jsonAborted = window.__gateway.aborted;
                window.__installFakeGateway({
                    status: 502,
                    headers: { 'content-type': 'text/html', 'x-request-id': null },
                    chunks: ['<html><body>502 Bad Gateway'],
                    hangAfterChunks: true,
                });
                const proxy = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return {
                    json: { code: json.code, aborted: jsonAborted },
                    proxy: { code: proxy.code, aborted: window.__gateway.aborted },
                };
            });
            expect(r).toEqual({
                json: { code: 'bad_response', aborted: true },
                proxy: { code: 'unavailable', aborted: true },
            });
        });

        test('fetch 本身失敗（離線、CORS 被擋）→ network，可重試', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({ networkError: true });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({
                ok: false,
                name: 'AIError',
                code: 'network',
                retryable: true,
                describe: '暫時連不上 AI 服務（可能是網路不穩，或服務正在維護），請稍後再試。',
            });
        });

        test('fetch 失敗時裝置是離線的 → 直說沒有網路連線', async ({ page }) => {
            await page.context().setOffline(true);
            const r = await page.evaluate(() => {
                window.__installFakeGateway({ networkError: true });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            await page.context().setOffline(false);
            expect(r).toMatchObject({ ok: false, code: 'network', retryable: true, describe: '你的裝置目前沒有網路連線，請連上網路後再試。' });
        });

        // 不換掉 fetch、也不用 page.route（Playwright 會替 fulfill 的跨網域回應補上 CORS 標頭）：
        // 頁面在 :8000，閘道網址指到 :8001 上不存在的路徑，靜態伺服器的 404 沒有 CORS 標頭。
        // 閘道停擺時通道回的 502、網站不在允許名單時閘道的 403，在瀏覽器裡都是這個樣子
        test('真的跨網域、回應沒有 CORS 標頭 → network，訊息不叫學生檢查自己的網路', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__setGatewayMeta('http://localhost:8001/no-such-gateway');
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({ ok: false, name: 'AIError', code: 'network', retryable: true });
            expect(r.describe).toBe('暫時連不上 AI 服務（可能是網路不穩，或服務正在維護），請稍後再試。');
            expect(r.describe).not.toContain('檢查網路');
        });

        test('串流進行到一半連線斷掉（TypeError）→ disconnected，不是 network', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'req-drop', task: 't' })], failAfterChunks: true });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({
                ok: false,
                name: 'AIError',
                code: 'disconnected',
                retryable: true,
                requestId: 'req-drop',
                describe: '和 AI 服務的連線中斷了，請再試一次。',
            });
        });

        test('串流沒有 done 就結束 → disconnected', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({
                    chunks: [__sse('accepted', { requestId: 'req-5', task: 't' }), __sse('progress', { phase: 'thinking', round: 1 })],
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({ ok: false, name: 'AIError', code: 'disconnected', retryable: true, requestId: 'req-5' });
        });

        // 頁面靠 partial 把已經顯示的答案留在畫面上，斷線時也一樣
        test('已經收到片段之後串流沒有 done 就結束、或連線斷掉 → disconnected 帶著 partial', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const chunks = [__sse('accepted', { requestId: 'req-eof', task: 't' }), __sse('delta', { text: '第一段' }), __sse('delta', { text: '寫到一半' })];
                window.__installFakeGateway({ chunks });
                const ended = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                window.__installFakeGateway({ chunks, failAfterChunks: true });
                const dropped = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return { ended, dropped };
            });
            for (const res of [r.ended, r.dropped]) {
                expect(res).toMatchObject({ ok: false, name: 'AIError', code: 'disconnected', partial: '第一段寫到一半', describe: '和 AI 服務的連線中斷了，請再試一次。' });
            }
        });

        test('已經收到片段之後一分鐘沒有任何位元組 → disconnected 帶著 partial', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'req-idle-partial', task: 't' }), __sse('delta', { text: '寫到一半' })], hangAfterChunks: true });
                window.__outcome = __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            await page.clock.fastForward(61_000);
            const r = await page.evaluate(() => window.__outcome);
            expect(r).toMatchObject({ ok: false, name: 'AIError', code: 'disconnected', partial: '寫到一半' });
        });

        test('已經收到片段之後超過 timeoutMs → TimeoutError 帶著 partial', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'r', task: 't' }), __sse('delta', { text: '寫到一半' })], hangAfterChunks: true });
                return __settle(PlatformAI.runTask('t', { a: 'b' }, { timeoutMs: 50 }));
            });
            expect(r).toMatchObject({ ok: false, name: 'TimeoutError', partial: '寫到一半' });
        });

        test('已經收到片段之後使用者取消 → AbortError 不帶 partial', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'r', task: 't' }), __sse('delta', { text: '寫到一半' })], hangAfterChunks: true });
                const ctrl = new AbortController();
                return __settle(PlatformAI.runTask('t', { a: 'b' }, {
                    signal: ctrl.signal,
                    onDelta: () => setTimeout(() => ctrl.abort(), 0),
                }));
            });
            expect(r).toMatchObject({ ok: false, name: 'AbortError' });
            expect(r.partial).toBeUndefined();
        });

        test('回應不是 SSE、data 不是 JSON、done 沒有 result → bad_response', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({ headers: { 'content-type': 'application/json' }, textBody: '{"result":1}' });
                const notSse = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                window.__installFakeGateway({ chunks: ['event: progress\ndata: not-json\n\n'] });
                const notJson = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                window.__installFakeGateway({ chunks: [__sse('done', { rounds: 1 })] });
                const noResult = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return [notSse, notJson, noResult].map((x) => x.code);
            });
            expect(r).toEqual(['bad_response', 'bad_response', 'bad_response']);
        });

        test('Content-Type 必須以 text/event-stream 開頭（不分大小寫），只是含有 event-stream 不算', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const out = {};
                for (const type of ['application/event-stream', 'text/plain; x=event-stream', 'Text/Event-Stream;charset=UTF-8']) {
                    window.__installFakeGateway({ headers: { 'content-type': type }, chunks: [__sse('done', { result: 'ok', rounds: 1 })] });
                    const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                    out[type] = settled.ok ? 'ok' : settled.code;
                }
                return out;
            });
            expect(r).toEqual({
                'application/event-stream': 'bad_response',
                'text/plain; x=event-stream': 'bad_response',
                'Text/Event-Stream;charset=UTF-8': 'ok',
            });
        });

        test('單一事件大得不合理 → bad_response，並關掉連線', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const big = 'x'.repeat(1536 * 1024);
                const cases = [
                    // 一行沒有換行、一直長下去
                    ['data: ' + 'x'.repeat(2 * 1024 * 1024 + 16)],
                    // 每一行都不大，但同一個事件的 data 加起來太大
                    ['data: ' + big + '\n', 'data: ' + big + '\n'],
                ];
                const out = [];
                for (const chunks of cases) {
                    window.__installFakeGateway({ chunks, hangAfterChunks: true });
                    const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                    out.push({ code: settled.code, aborted: window.__gateway.aborted });
                }
                return out;
            });
            expect(r).toEqual([{ code: 'bad_response', aborted: true }, { code: 'bad_response', aborted: true }]);
        });

        // 回報問題時要靠 requestId 對照閘道的 log；解析器丟錯的當下還不知道它，要在外層補上
        test('事件大得不合理的 bad_response 也帶著 accepted 給的 requestId', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({
                    chunks: [__sse('accepted', { requestId: 'req-big', task: 't' }), 'data: ' + 'x'.repeat(2 * 1024 * 1024 + 16)],
                    hangAfterChunks: true,
                });
                return __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            expect(r).toMatchObject({ ok: false, name: 'AIError', code: 'bad_response', requestId: 'req-big' });
        });

        test('收到 done 之後不再處理後面的事件，並主動關掉連線', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({
                    chunks: [
                        __sse('accepted', { requestId: 'req-6', task: 't' }) +
                        __sse('done', { result: '完成', rounds: 1 }) +
                        __sse('error', { code: 'internal', message: '不該出現' }),
                    ],
                    hangAfterChunks: true,
                });
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return { settled, aborted: window.__gateway.aborted };
            });
            expect(r.settled.ok).toBe(true);
            expect(r.settled.value.result).toBe('完成');
            expect(r.aborted).toBe(true);
        });

        test('done 後面同一塊跟著一行超過 2 MiB 的垃圾 → 仍然以 done 為準', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({
                    chunks: [__sse('done', { result: '完成', rounds: 1 }) + 'data: ' + 'x'.repeat(2 * 1024 * 1024 + 16) + '\n'],
                    hangAfterChunks: true,
                });
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return { settled, aborted: window.__gateway.aborted };
            });
            expect(r.settled.ok).toBe(true);
            expect(r.settled.value.result).toBe('完成');
            expect(r.aborted).toBe(true);
        });

        test('使用者取消 → 丟出 AbortError，並中止對閘道的請求', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'req-7', task: 't' })], hangAfterChunks: true });
                const ctrl = new AbortController();
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, {
                    signal: ctrl.signal,
                    onProgress: (p) => { if (p.phase === 'accepted') setTimeout(() => ctrl.abort(), 0); },
                }));
                return { settled, aborted: window.__gateway.aborted };
            });
            expect(r.settled).toMatchObject({ ok: false, name: 'AbortError', describe: '已取消。' });
            expect(r.aborted).toBe(true);
        });

        // 取消發生在處理同一塊的途中，後面的事件（連同 done）都已經在手上了，仍然要以取消為準
        test('在 onDelta 裡同步取消、done 就在同一塊 → 仍然丟出 AbortError，取消之後不再呼叫 onDelta', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({
                    chunks: [
                        __sse('accepted', { requestId: 'req-sync', task: 't' }) +
                        __sse('delta', { text: '一' }) +
                        __sse('delta', { text: '二' }) +
                        __sse('done', { result: '一二', rounds: 1 }),
                    ],
                    hangAfterChunks: true,
                });
                const ctrl = new AbortController();
                const deltas = [];
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, {
                    signal: ctrl.signal,
                    onDelta: (piece) => { deltas.push(piece); ctrl.abort(); },
                }));
                return { settled, deltas, aborted: window.__gateway.aborted };
            });
            expect(r.settled).toMatchObject({ ok: false, name: 'AbortError' });
            expect(r.deltas).toEqual(['一']);
            expect(r.aborted).toBe(true);
        });

        test('signal 一開始就已經 abort → 不送出請求', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({ chunks: [] });
                const ctrl = new AbortController();
                ctrl.abort();
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, { signal: ctrl.signal }));
                return { name: settled.name, calls: window.__gateway.calls.length };
            });
            expect(r).toEqual({ name: 'AbortError', calls: 0 });
        });

        // 時限應該用 timeoutMs，signal 只用來讓使用者取消（見 runTask 的說明）。這裡守的是另一件事：
        // signal 被 abort 時，丟回的就是它的 reason，不會被換成別的錯誤
        test('AbortSignal.timeout() 的 TimeoutError 原樣丟回', async ({ page }) => {
            const r = await page.evaluate(() => {
                window.__installFakeGateway({ hangBeforeHeaders: true });
                return __settle(PlatformAI.runTask('t', { a: 'b' }, { signal: AbortSignal.timeout(30) }));
            });
            expect(r).toMatchObject({ ok: false, name: 'TimeoutError', describe: '等待 AI 回應的時間太長了，請稍後再試。' });
        });

        test('超過 timeoutMs → TimeoutError，並中止請求', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'r', task: 't' })], hangAfterChunks: true });
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, { timeoutMs: 50 }));
                return { name: settled.name, aborted: window.__gateway.aborted };
            });
            expect(r).toEqual({ name: 'TimeoutError', aborted: true });
        });

        // setTimeout 的延遲超過 2^31-1（包括 Infinity）會被當成 0，立刻觸發
        test('timeoutMs 給 Infinity 或超過 setTimeout 上限的值，不會立刻逾時', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const out = {};
                for (const [name, timeoutMs] of [['infinity', Infinity], ['overflow', 2 ** 31]]) {
                    // 每塊之前等一下：計時器若立刻觸發，一定搶在 done 之前
                    window.__installFakeGateway({
                        chunkDelayMs: 20,
                        chunks: [__sse('accepted', { requestId: 'r', task: 't' }), __sse('done', { result: 'ok', rounds: 1 })],
                    });
                    const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, { timeoutMs }));
                    out[name] = settled.ok ? 'ok' : settled.name;
                }
                return out;
            });
            expect(r).toEqual({ infinity: 'ok', overflow: 'ok' });
        });

        // 心跳不斷時，能讓任務停下來的只剩總時限：要比閘道的排隊加生成（4 + 15 分鐘）更長
        test('預設總時限是 20 分鐘：心跳不斷時 19 分 50 秒仍在進行，20 分 01 秒才 TimeoutError', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'req-20m', task: 't' })], heartbeatMs: 15_000 });
                window.__outcome = null;
                __settle(PlatformAI.runTask('t', { a: 'b' })).then((r) => { window.__outcome = r; });
            });
            await page.clock.runFor(19 * 60_000 + 50_000);
            expect(await page.evaluate(() => ({ outcome: window.__outcome, aborted: window.__gateway.aborted })))
                .toEqual({ outcome: null, aborted: false });
            await page.clock.runFor(11_000);
            expect(await page.evaluate(() => window.__outcome)).toMatchObject({ ok: false, name: 'TimeoutError' });
            expect(await page.evaluate(() => window.__gateway.aborted)).toBe(true);
        });

        test('連續一分鐘沒有收到任何位元組（連心跳都沒有）→ disconnected', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                window.__installFakeGateway({ chunks: [__sse('accepted', { requestId: 'req-idle', task: 't' })], hangAfterChunks: true });
                window.__outcome = __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            await page.clock.fastForward(59_000);
            expect(await page.evaluate(() => window.__gateway.aborted)).toBe(false);
            await page.clock.fastForward(2_000);
            const r = await page.evaluate(() => window.__outcome);
            expect(r).toMatchObject({ ok: false, name: 'AIError', code: 'disconnected', requestId: 'req-idle' });
            expect(await page.evaluate(() => window.__gateway.aborted)).toBe(true);
        });

        // 封包被丟掉、中間的代理掛住：閘道一收到請求就會回標頭，等不到就是連不上，不必等 20 分鐘
        test('連回應標頭都等不到 → 一分鐘後 network（連不上），並中止請求', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                window.__installFakeGateway({ hangBeforeHeaders: true });
                window.__outcome = __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            await page.clock.fastForward(59_000);
            expect(await page.evaluate(() => window.__gateway.aborted)).toBe(false);
            await page.clock.fastForward(2_000);
            const r = await page.evaluate(() => window.__outcome);
            expect(r).toMatchObject({
                ok: false,
                name: 'AIError',
                code: 'network',
                retryable: true,
                describe: '暫時連不上 AI 服務（可能是網路不穩，或服務正在維護），請稍後再試。',
            });
            expect(await page.evaluate(() => window.__gateway.aborted)).toBe(true);
        });

        test('收到標頭就重設閒置計時：之後再一分鐘沒有任何位元組才算 disconnected', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                window.__installFakeGateway({ headersDelayMs: 30_000, chunks: [], hangAfterChunks: true });
                window.__outcome = __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            await page.clock.fastForward(31_000);
            await page.clock.fastForward(59_000);
            expect(await page.evaluate(() => window.__gateway.aborted)).toBe(false);
            await page.clock.fastForward(2_000);
            const r = await page.evaluate(() => window.__outcome);
            expect(r).toMatchObject({ ok: false, name: 'AIError', code: 'disconnected', requestId: 'req-header' });
        });

        // 錯誤回應的 body 讀到一半掛住：閒置逾時優先，回報斷線，而不是假裝讀到了錯誤內容
        test('錯誤回應的 body 一直不結束 → 一分鐘後 disconnected', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                window.__installFakeGateway({
                    status: 503,
                    headers: { 'content-type': 'application/json' },
                    chunks: ['{"error":{"code":"busy",'],
                    hangAfterChunks: true,
                });
                window.__outcome = __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            await page.clock.fastForward(61_000);
            const r = await page.evaluate(() => window.__outcome);
            expect(r).toMatchObject({ ok: false, name: 'AIError', code: 'disconnected' });
        });

        // 反過來：任務本身可以跑好幾分鐘，只要心跳持續進來就不能被當成斷線
        test('心跳（SSE 註解）會重設閒置計時：總時間遠超過一分鐘也不會斷', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                window.__installFakeGateway({
                    chunkDelayMs: 40_000,
                    chunks: [
                        __sse('accepted', { requestId: 'req-long', task: 't' }),
                        ': ping\n\n',
                        ': ping\n\n',
                        __sse('done', { result: '終於好了', rounds: 3 }),
                    ],
                });
                window.__outcome = __settle(PlatformAI.runTask('t', { a: 'b' }));
            });
            for (let i = 0; i < 4; i++) await page.clock.fastForward(40_000);
            const r = await page.evaluate(() => window.__outcome);
            expect(r.ok).toBe(true);
            expect(r.value.result).toBe('終於好了');
        });

        test('閘道網址沒有設定 → not_configured，不送出請求', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__setGatewayMeta(null);
                window.__installFakeGateway({ chunks: [] });
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }));
                return { settled, calls: window.__gateway.calls.length };
            });
            expect(r.settled).toMatchObject({
                ok: false,
                name: 'AIError',
                code: 'not_configured',
                describe: 'AI 服務尚未設定完成，暫時無法使用。',
            });
            expect(r.calls).toBe(0);
        });

        test('任務代號不合法 → TypeError，不送出請求', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({ chunks: [] });
                const names = [];
                for (const id of ['', 'Starter', '../x', 'a/b', '-a', 'a'.repeat(65), 123, undefined]) {
                    names.push((await __settle(PlatformAI.runTask(id, { a: 'b' }))).name);
                }
                return { names, calls: window.__gateway.calls.length };
            });
            expect(r.names).toEqual(Array(8).fill('TypeError'));
            expect(r.calls).toBe(0);
        });

        // 這是頁面程式的錯，不能被說成「連不上 AI 服務」
        test('input 無法序列化（BigInt、循環參照）→ 原樣丟出 TypeError，不送出請求', async ({ page }) => {
            const r = await page.evaluate(async () => {
                window.__installFakeGateway({ chunks: [__sse('done', { result: 'ok', rounds: 1 })] });
                const circular = { topic: '貓咪' };
                circular.self = circular;
                const big = await __settle(PlatformAI.runTask('t', { count: 1n }));
                const cyclic = await __settle(PlatformAI.runTask('t', circular));
                return { big: [big.name, big.code], cyclic: [cyclic.name, cyclic.code], calls: window.__gateway.calls.length };
            });
            expect(r).toEqual({ big: ['TypeError', undefined], cyclic: ['TypeError', undefined], calls: 0 });
        });

        // 一個頁面會呼叫很多次 runTask：每次留下一個計時器或 listener，就是一份越積越多的洩漏
        test('結束之後不留下計時器，也不留下掛在呼叫端 signal 上的 listener', async ({ page }) => {
            const r = await page.evaluate(async () => {
                // 建立了、但既沒有被清掉也還沒觸發的計時器
                const pending = new Set();
                const realSetTimeout = window.setTimeout;
                const realClearTimeout = window.clearTimeout;
                window.setTimeout = function (fn, ms) {
                    const args = Array.prototype.slice.call(arguments, 2);
                    const id = realSetTimeout.call(window, function () {
                        pending.delete(id);
                        return fn.apply(this, args);
                    }, ms);
                    pending.add(id);
                    return id;
                };
                window.clearTimeout = function (id) {
                    pending.delete(id);
                    return realClearTimeout.call(window, id);
                };
                const trackListeners = (signal) => {
                    const live = new Set();
                    const add = signal.addEventListener.bind(signal);
                    const remove = signal.removeEventListener.bind(signal);
                    signal.addEventListener = (type, fn, opts) => { live.add(fn); return add(type, fn, opts); };
                    signal.removeEventListener = (type, fn, opts) => { live.delete(fn); return remove(type, fn, opts); };
                    return live;
                };
                const cases = [
                    ['success', { chunks: [__sse('accepted', { requestId: 'r', task: 't' }), __sse('done', { result: 'ok', rounds: 1 })] }],
                    ['aiError', { chunks: [__sse('error', { code: 'busy', message: '忙' })] }],
                    ['network', { networkError: true }],
                    ['http503', { status: 503, headers: { 'content-type': 'application/json' }, textBody: '{"error":{"code":"busy","message":"忙"}}' }],
                    ['cancel', { chunks: [__sse('accepted', { requestId: 'r', task: 't' })], hangAfterChunks: true }],
                    ['timeout', { chunks: [__sse('accepted', { requestId: 'r', task: 't' })], hangAfterChunks: true }, { timeoutMs: 30 }],
                ];
                const out = {};
                try {
                    for (const [name, spec, extra] of cases) {
                        window.__installFakeGateway(spec);
                        pending.clear();
                        const ctrl = new AbortController();
                        const listeners = trackListeners(ctrl.signal);
                        const running = __settle(PlatformAI.runTask('t', { a: 'b' }, Object.assign({ signal: ctrl.signal }, extra)));
                        if (name === 'cancel') realSetTimeout.call(window, () => ctrl.abort(), 20);
                        const settled = await running;
                        // DOMException 也有 code（數字），所以只有 AIError 才看 code
                        const result = settled.ok ? 'ok' : settled.name === 'AIError' ? settled.code : settled.name;
                        out[name] = { result, timers: pending.size, listeners: listeners.size };
                    }
                } finally {
                    window.setTimeout = realSetTimeout;
                    window.clearTimeout = realClearTimeout;
                }
                return out;
            });
            expect(r).toEqual({
                success: { result: 'ok', timers: 0, listeners: 0 },
                aiError: { result: 'busy', timers: 0, listeners: 0 },
                network: { result: 'network', timers: 0, listeners: 0 },
                http503: { result: 'busy', timers: 0, listeners: 0 },
                cancel: { result: 'AbortError', timers: 0, listeners: 0 },
                timeout: { result: 'TimeoutError', timers: 0, listeners: 0 },
            });
        });

        test('回呼函式丟錯不影響任務本身，錯誤寫進 log', async ({ page }) => {
            const r = await page.evaluate(async () => {
                PlatformAI.clearLogs();
                window.__installFakeGateway({
                    chunks: [
                        __sse('accepted', { requestId: 'r', task: 't' }),
                        __sse('delta', { text: '嗨' }),
                        __sse('done', { result: '嗨', rounds: 1 }),
                    ],
                });
                const settled = await __settle(PlatformAI.runTask('t', { a: 'b' }, {
                    onProgress: () => { throw new Error('progress boom'); },
                    onDelta: () => { throw new Error('delta boom'); },
                }));
                return { settled, warnings: PlatformAI.getLogs().filter((l) => l.level === 'warn').map((l) => l.message) };
            });
            expect(r.settled.ok).toBe(true);
            expect(r.settled.value.result).toBe('嗨');
            expect(r.warnings.some((m) => m.includes('progress boom'))).toBe(true);
            expect(r.warnings.some((m) => m.includes('delta boom'))).toBe(true);
        });

        test('log 只記任務代號與結果，不記使用者輸入的內容', async ({ page }) => {
            const logs = await page.evaluate(async () => {
                PlatformAI.clearLogs();
                window.__installFakeGateway({ chunks: [__sse('done', { result: 'ok', rounds: 1 })] });
                await PlatformAI.runTask('t', { topic: '我的祕密想法' });
                window.__installFakeGateway({ networkError: true });
                await __settle(PlatformAI.runTask('t', { topic: '我的祕密想法' }));
                return JSON.stringify(PlatformAI.getLogs());
            });
            expect(logs).toContain('AI 任務完成');
            expect(logs).toContain('AI 任務失敗');
            expect(logs).not.toContain('我的祕密想法');
        });
    });

    test.describe('describeError', () => {
        test.beforeEach(async ({ page }) => { await gotoFixture(page); });

        test('每一種錯誤都有一句可以直接給學生看的話', async ({ page }) => {
            const r = await page.evaluate(() => {
                const ai = (code, message, extra) => Object.assign(new Error(message), { name: 'AIError', code }, extra);
                return {
                    abort: PlatformAI.describeError(new DOMException('x', 'AbortError')),
                    timeout: PlatformAI.describeError(new DOMException('x', 'TimeoutError')),
                    plain: PlatformAI.describeError(ai('incomplete', 'AI 的回答太長，沒能在時限內寫完。請把問題縮小一點再試。')),
                    seconds: PlatformAI.describeError(ai('busy', '目前使用的人比較多，請稍後再試。', { retryAfter: 45 })),
                    minute: PlatformAI.describeError(ai('rate_limited', '你的請求有點頻繁，請稍後再試。', { retryAfter: 60 })),
                    mixed: PlatformAI.describeError(ai('rate_limited', '你的請求有點頻繁，請稍後再試。', { retryAfter: 90 })),
                    other: PlatformAI.describeError(new TypeError('x is undefined')),
                    nothing: PlatformAI.describeError(undefined),
                };
            });
            expect(r.abort).toBe('已取消。');
            expect(r.timeout).toBe('等待 AI 回應的時間太長了，請稍後再試。');
            expect(r.plain).toBe('AI 的回答太長，沒能在時限內寫完。請把問題縮小一點再試。');
            expect(r.seconds).toBe('目前使用的人比較多，請稍後再試（大約 45 秒後可以再試）。');
            expect(r.minute).toBe('你的請求有點頻繁，請稍後再試（大約 1 分鐘後可以再試）。');
            expect(r.mixed).toBe('你的請求有點頻繁，請稍後再試（大約 1 分 30 秒後可以再試）。');
            // 程式錯誤的細節（英文、變數名）不給學生看
            expect(r.other).toBe('抱歉，AI 服務發生錯誤，請稍後再試。');
            expect(r.nothing).toBe('發生未知的錯誤，請稍後再試。');
        });
    });

    test.describe('perFrame', () => {
        test.beforeEach(async ({ page }) => { await gotoFixture(page); });

        test('同一個畫面裡呼叫 100 次，fn 只在下一個畫面執行一次，拿到最後一次的參數', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
                const calls = [];
                const draw = PlatformAI.perFrame((...args) => calls.push(args));
                for (let i = 1; i <= 100; i++) draw('片段', i);
                const before = calls.length;
                await nextFrame();
                await nextFrame();
                draw('片段', 101);
                await nextFrame();
                return { before, calls };
            });
            expect(r.before).toBe(0);
            expect(r.calls).toEqual([['片段', 100], ['片段', 101]]);
        });

        // 每次呼叫各在不同的 task 裡：setTimeout 或 microtask 合併的話，fn 會跟著呼叫次數執行。
        test('每次呼叫各在不同的 task：fn 執行的次數不超過畫面數，最後拿到最後一次的參數', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
                let frames = 0;
                let counting = true;
                const tick = () => { frames++; if (counting) requestAnimationFrame(tick); };
                requestAnimationFrame(tick);
                const calls = [];
                const draw = PlatformAI.perFrame((i) => calls.push(i));
                for (let i = 1; i <= 100; i++) {
                    draw(i);
                    await new Promise((resolve) => setTimeout(resolve, 1));
                }
                await nextFrame();
                await nextFrame();
                counting = false;
                return { calls, frames };
            });
            expect(r.calls.length).toBeLessThanOrEqual(r.frames);
            expect(r.calls.at(-1)).toBe(100);
        });

        test('cancel() 之後還沒執行的那次不執行，之後照常排程；fn 丟錯只記 log', async ({ page }) => {
            const r = await page.evaluate(async () => {
                const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
                const calls = [];
                const draw = PlatformAI.perFrame((text) => {
                    calls.push(text);
                    if (text === '壞掉') throw new Error('畫不出來');
                });
                draw('取消的');
                draw.cancel();
                draw.cancel();
                await nextFrame();
                draw('壞掉');
                await nextFrame();
                draw('之後');
                await nextFrame();
                return { calls, warnings: PlatformAI.getLogs().filter((l) => l.level === 'warn').map((l) => l.message) };
            });
            expect(r.calls).toEqual(['壞掉', '之後']);
            expect(r.warnings).toEqual(['AI 任務的回呼函式出錯：Error: 畫不出來']);
        });
    });

    test.describe('mountProgress', () => {
        test.beforeEach(async ({ page }) => { await gotoFixture(page); });

        // 多數螢幕閱讀器不唸 live region 插入當下就有的內容，只唸之後的變化
        test('role=status 插入時是空的，約 100 毫秒後才填入；在那之前的更新只留最新的一句', async ({ page }) => {
            await pauseClock(page);
            // 插入、更新、檢查都在同一段同步程式裡，不受真實時間流逝影響
            const initial = await page.evaluate(() => {
                const make = (id) => {
                    const box = document.createElement('div');
                    box.id = id;
                    box.textContent = '舊的結果';
                    document.body.appendChild(box);
                    return box;
                };
                const quiet = make('quiet');
                PlatformAI.mountProgress(quiet);
                const busy = make('busy');
                const progress = PlatformAI.mountProgress(busy);
                progress.update({ phase: 'accepted' });
                progress.update({ phase: 'queued', position: 3 });
                return {
                    quiet: quiet.querySelector('[role="status"]').textContent,
                    busy: busy.querySelector('[role="status"]').textContent,
                    oldResultsCleared: !quiet.textContent.includes('舊的結果') && !busy.textContent.includes('舊的結果'),
                };
            });
            expect(initial).toEqual({ quiet: '', busy: '', oldResultsCleared: true });
            await page.clock.runFor(100);
            await expect(page.locator('#quiet [role="status"]')).toHaveText('正在連線 AI 服務…');
            await expect(page.locator('#busy [role="status"]')).toHaveText('排隊中，前面還有 2 位…');
        });

        test('依進度事件更新階段文字；看不懂的階段維持上一句；finish 後移除', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                const box = document.createElement('div');
                box.id = 'box';
                document.body.appendChild(box);
                window.__progress = PlatformAI.mountProgress(box);
            });
            await page.clock.runFor(100);
            const status = page.locator('#box [role="status"]');
            await expect(status).toHaveText('正在連線 AI 服務…');
            const cases = [
                [{ phase: 'accepted' }, '已送出，等待 AI 開始…'],
                [{ phase: 'queued', position: 3 }, '排隊中，前面還有 2 位…'],
                [{ phase: 'queued', position: 1 }, '排隊中，下一個就輪到你…'],
                [{ phase: 'started' }, '輪到你了，等待 AI 開始回應…'],
                [{ phase: 'thinking', round: 1, thinkingTokens: 100 }, 'AI 正在思考…'],
                [{ phase: 'writing', round: 1 }, 'AI 正在撰寫回答…'],
                [{ phase: 'continuing', round: 2, reason: 'length' }, '回答比較長，AI 正在接著寫（第 2 輪）…'],
                [{ phase: 'thinking', round: 2 }, 'AI 正在思考（第 2 輪）…'],
                [{ phase: 'retrying', round: 2, attempt: 1, delayMs: 2500 }, 'AI 服務有點忙，3 秒後自動重試…'],
                // 閘道日後新增的階段：維持上一句，不要倒退回「正在連線」
                [{ phase: 'some-future-phase' }, 'AI 服務有點忙，3 秒後自動重試…'],
                [undefined, 'AI 服務有點忙，3 秒後自動重試…'],
                [{ phase: 'retrying', delayMs: 300000 }, 'AI 服務有點忙，5 分鐘後自動重試…'],
                [{ phase: 'retrying', delayMs: 90000 }, 'AI 服務有點忙，1 分 30 秒後自動重試…'],
            ];
            for (const [progress, text] of cases) {
                await page.evaluate((p) => window.__progress.update(p), progress);
                await expect(status).toHaveText(text);
            }
            await page.evaluate(() => window.__progress.finish());
            await expect(page.locator('#box .platform-ai-progress')).toHaveCount(0);
        });

        // 重試送出之後要等上游的第一個 token 才有下一個進度，WinLab 忙的時候可能超過一分鐘
        test('重試的倒數到了就改說正在重新嘗試，不會一直停在「3 秒後」；倒數期間來了新的進度就照新的', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                const box = document.createElement('div');
                box.id = 'box';
                document.body.appendChild(box);
                window.__progress = PlatformAI.mountProgress(box);
            });
            await page.clock.runFor(100);
            const status = page.locator('#box [role="status"]');
            await page.evaluate(() => window.__progress.update({ phase: 'retrying', round: 2, attempt: 1, delayMs: 2500 }));
            await expect(status).toHaveText('AI 服務有點忙，3 秒後自動重試…');
            await page.clock.runFor(2_900);
            await expect(status).toHaveText('AI 服務有點忙，3 秒後自動重試…');
            await page.clock.runFor(200);
            await expect(status).toHaveText('AI 服務有點忙，正在重新嘗試…');
            await page.evaluate(() => window.__progress.update({ phase: 'retrying', round: 2, attempt: 2, delayMs: 4000 }));
            await expect(status).toHaveText('AI 服務有點忙，4 秒後自動重試…');
            await page.evaluate(() => window.__progress.update({ phase: 'thinking', round: 2 }));
            await page.clock.runFor(5_000);
            await expect(status).toHaveText('AI 正在思考（第 2 輪）…');
        });

        // role=status 的內容一變就會被唸出來，秒數放在裡面就會每秒插話。
        test('已等待的秒數用 role=timer、aria-live=off，不在 role=status 裡；文字與按鈕邊框的對比足夠', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                const box = document.createElement('div');
                box.id = 'box';
                document.body.appendChild(box);
                window.__progress = PlatformAI.mountProgress(box, { onCancel: () => {} });
            });
            await page.clock.fastForward(65_000);
            const timer = page.locator('#box [role="timer"]');
            await expect(timer).toHaveText('已等待 1 分 5 秒');
            await expect(page.locator('#box [role="status"]')).not.toContainText('已等待');
            const r = await page.evaluate(() => {
                const el = document.querySelector('#box [role="timer"]');
                return {
                    ariaLive: el.getAttribute('aria-live'),
                    hidden: el.hasAttribute('aria-hidden'),
                    color: getComputedStyle(el).color,
                    cancelBorder: getComputedStyle(document.querySelector('#box button')).borderTopColor,
                };
            });
            // #4b5563 與 #6b7280 對白底分別約 7.6:1 與 4.8:1（按鈕外框至少要 3:1）
            expect(r).toEqual({ ariaLive: 'off', hidden: false, color: 'rgb(75, 85, 99)', cancelBorder: 'rgb(107, 114, 128)' });
        });

        // thinking 事件每隔幾秒就來一次；同一句再寫一次，螢幕閱讀器就會再唸一次
        test('同一個階段重複送來，文字只寫一次', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                const box = document.createElement('div');
                box.id = 'box';
                document.body.appendChild(box);
                window.__progress = PlatformAI.mountProgress(box);
            });
            await page.clock.runFor(100);
            const r = await page.evaluate(() => {
                const status = document.querySelector('#box [role="status"]');
                const observer = new MutationObserver(() => {});
                observer.observe(status, { childList: true, characterData: true, subtree: true });
                window.__progress.update({ phase: 'thinking', round: 1, thinkingTokens: 10 });
                window.__progress.update({ phase: 'thinking', round: 1, thinkingTokens: 50 });
                window.__progress.update({ phase: 'thinking', round: 1, thinkingTokens: 90 });
                const records = observer.takeRecords();
                observer.disconnect();
                return { writes: records.length, text: status.textContent };
            });
            expect(r).toEqual({ writes: 1, text: 'AI 正在思考…' });
        });

        // 排隊的名次一變，status 就重唸一次；提醒放在裡面的話每次都會跟著唸
        test('第一次排隊時在 role=status 外加一行分批送出的提醒，只加一次，finish 後移除', async ({ page }) => {
            await pauseClock(page);
            await page.evaluate(() => {
                const box = document.createElement('div');
                box.id = 'box';
                document.body.appendChild(box);
                window.__progress = PlatformAI.mountProgress(box);
            });
            await page.clock.runFor(100);
            const hint = page.locator('#box').getByText('同一個網路同時使用的人多時，請分批送出。');
            await page.evaluate(() => window.__progress.update({ phase: 'accepted' }));
            await expect(hint).toHaveCount(0);
            for (const position of [3, 2, 1]) {
                await page.evaluate((p) => window.__progress.update({ phase: 'queued', position: p }), position);
            }
            await page.evaluate(() => window.__progress.update({ phase: 'started' }));
            await expect(hint).toHaveCount(1);
            await expect(hint).toBeVisible();
            await expect(page.locator('#box [role="status"]')).toHaveText('輪到你了，等待 AI 開始回應…');
            await expect(page.locator('#box :is([aria-live], [role=status], [role=alert], [role=log], [role=timer])', { hasText: '分批' })).toHaveCount(0);
            await page.evaluate(() => window.__progress.finish());
            await expect(hint).toHaveCount(0);
        });

        test('每秒更新的計時器：finish() 立刻停；頁面自己清掉 container 時，下一秒就停', async ({ page }) => {
            await pauseClock(page);
            const counts = await page.evaluate(() => {
                // 還在跑的 setInterval
                const live = new Set();
                const realSetInterval = window.setInterval;
                const realClearInterval = window.clearInterval;
                window.setInterval = function () {
                    const id = realSetInterval.apply(window, arguments);
                    live.add(id);
                    return id;
                };
                window.clearInterval = function (id) {
                    live.delete(id);
                    return realClearInterval.call(window, id);
                };
                window.__liveIntervals = live;
                const make = (id) => {
                    const box = document.createElement('div');
                    box.id = id;
                    document.body.appendChild(box);
                    return box;
                };
                const finished = PlatformAI.mountProgress(make('finished'));
                PlatformAI.mountProgress(make('cleared'));
                const mounted = live.size;
                finished.finish();
                const afterFinish = live.size;
                document.getElementById('cleared').textContent = '';
                return { mounted, afterFinish, afterClear: live.size };
            });
            expect(counts).toEqual({ mounted: 2, afterFinish: 1, afterClear: 1 });
            await page.clock.runFor(1_000);
            expect(await page.evaluate(() => window.__liveIntervals.size)).toBe(0);
        });

        // 用鍵盤按：disabled 的按鈕會失去焦點，鍵盤使用者的焦點就掉回 <body>，得從頁首重新找起
        test('有 onCancel 才顯示取消按鈕；按下後只呼叫一次並停用，焦點留在按鈕上；沒給 focusTarget 時 finish() 把焦點交給 container', async ({ page }) => {
            await page.evaluate(() => {
                const plain = document.createElement('div');
                plain.id = 'plain';
                document.body.appendChild(plain);
                PlatformAI.mountProgress(plain);
                const box = document.createElement('div');
                box.id = 'box';
                document.body.appendChild(box);
                window.__cancelCount = 0;
                window.__progress = PlatformAI.mountProgress(box, { onCancel: () => { window.__cancelCount++; } });
            });
            await expect(page.locator('#plain button')).toHaveCount(0);
            const cancel = page.locator('#box').getByRole('button', { name: '取消' });
            await cancel.focus();
            await page.keyboard.press('Enter');
            await page.keyboard.press('Enter');
            // aria-disabled 的按鈕 Playwright 不肯 click，直接送 click 事件
            await cancel.dispatchEvent('click');
            expect(await page.evaluate(() => window.__cancelCount)).toBe(1);
            await expect(cancel).toHaveAttribute('aria-disabled', 'true');
            await expect(cancel).toBeDisabled();
            await expect(cancel).toBeFocused();
            const after = await page.evaluate(() => {
                window.__progress.finish();
                const box = document.getElementById('box');
                return { focused: document.activeElement === box, tabindex: box.getAttribute('tabindex') };
            });
            expect(after).toEqual({ focused: true, tabindex: '-1' });
        });

        // 按鈕本來就能取得焦點，補上 tabindex="-1" 反而會被移出 Tab 的順序。
        test('finish() 把焦點交給 focusTarget 指定的按鈕：按鈕和 container 都不加 tabindex，Tab 仍走得到按鈕', async ({ page }) => {
            await page.evaluate(() => {
                const before = document.createElement('input');
                before.id = 'before';
                const trigger = document.createElement('button');
                trigger.id = 'trigger';
                trigger.textContent = '開始';
                const box = document.createElement('div');
                box.id = 'box';
                document.body.append(before, trigger, box);
                const progress = PlatformAI.mountProgress(box, { onCancel: () => {}, focusTarget: trigger });
                box.querySelector('button').focus();
                progress.finish();
            });
            const trigger = page.locator('#trigger');
            await expect(trigger).toBeFocused();
            await expect(trigger).not.toHaveAttribute('tabindex');
            await expect(page.locator('#box')).not.toHaveAttribute('tabindex');
            await page.locator('#before').focus();
            await page.keyboard.press('Tab');
            await expect(trigger).toBeFocused();
        });

        test('focusTarget 本來不能取得焦點時，補上 tabindex="-1" 再交給它', async ({ page }) => {
            const r = await page.evaluate(() => {
                const box = document.createElement('div');
                const heading = document.createElement('h2');
                document.body.append(box, heading);
                const progress = PlatformAI.mountProgress(box, { onCancel: () => {}, focusTarget: heading });
                box.querySelector('button').focus();
                progress.finish();
                return { focused: document.activeElement === heading, tabindex: heading.getAttribute('tabindex') };
            });
            expect(r).toEqual({ focused: true, tabindex: '-1' });
        });

        test('finish() 時焦點不在進度區塊裡就不搶焦點', async ({ page }) => {
            const r = await page.evaluate(() => {
                const box = document.createElement('div');
                box.id = 'box';
                document.body.appendChild(box);
                const elsewhere = document.createElement('button');
                elsewhere.textContent = '別的按鈕';
                document.body.appendChild(elsewhere);
                const progress = PlatformAI.mountProgress(box, { onCancel: () => {} });
                elsewhere.focus();
                progress.finish();
                return { focused: document.activeElement === elsewhere, tabindex: box.getAttribute('tabindex') };
            });
            expect(r).toEqual({ focused: true, tabindex: null });
        });
    });

});
