/**
 * PuterAI helper 單元測試（以 Playwright 執行）
 *
 * 前置：
 *   npm install
 *   npx playwright install
 *   npm run serve      # 另一個 terminal 啟 http://localhost:8000
 *
 * 執行：
 *   npx playwright test tests/e2e/puter-ai.spec.js
 */

const { test, expect } = require('@playwright/test');

// 允許透過 BASE_URL 環境變數覆寫測試伺服器位置，方便 port 8000 被占用時切換
const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const FIXTURE_URL = BASE_URL + '/tests/fixtures/puter-ai.html';

async function gotoFixture(page, queryString = '') {
    await page.goto(FIXTURE_URL + queryString);
    // 等待 shared/puter-ai.js 載入完成
    await page.waitForFunction(() => window.__READY__ === true && typeof window.PuterAI === 'object');
}

test.describe('PuterAI 共用 module', () => {

    test.describe('全域物件', () => {
        test('PuterAI 已定義且版本為 2', async ({ page }) => {
            await gotoFixture(page);
            const info = await page.evaluate(() => ({
                defined: typeof window.PuterAI === 'object',
                version: window.PuterAI.__version,
                hasFormat: typeof window.PuterAI.formatPuterError === 'function',
                hasCall: typeof window.PuterAI.callGeminiWithFallback === 'function',
                hasLog: typeof window.PuterAI.log === 'function',
                hasMount: typeof window.PuterAI.mountDebugPanel === 'function',
                models: window.PuterAI.MODELS,
            }));
            expect(info.defined).toBe(true);
            expect(info.version).toBe(2);
            expect(info.hasFormat).toBe(true);
            expect(info.hasCall).toBe(true);
            expect(info.hasLog).toBe(true);
            expect(info.hasMount).toBe(true);
            expect(info.models).toEqual([
                'gemini-3.1-pro-preview',
                'gemini-2.5-pro',
                'gemini-3-flash-preview',
            ]);
        });
    });

    test.describe('formatPuterError', () => {
        test.beforeEach(async ({ page }) => { await gotoFixture(page); });

        test('null / undefined → "unknown"', async ({ page }) => {
            expect(await page.evaluate(() => PuterAI.formatPuterError(null))).toBe('unknown');
            expect(await page.evaluate(() => PuterAI.formatPuterError(undefined))).toBe('unknown');
        });

        test('Error instance', async ({ page }) => {
            const r = await page.evaluate(() => PuterAI.formatPuterError(new TypeError('bad input')));
            expect(r).toBe('TypeError: bad input');
        });

        test('DOMException (AbortError) — 關鍵：舊版不 instanceof Error', async ({ page }) => {
            const r = await page.evaluate(() =>
                PuterAI.formatPuterError(new DOMException('aborted by user', 'AbortError'))
            );
            expect(r).toContain('AbortError');
            expect(r).toContain('aborted by user');
        });

        test('DOMException (TimeoutError)', async ({ page }) => {
            const r = await page.evaluate(() =>
                PuterAI.formatPuterError(new DOMException('timed out', 'TimeoutError'))
            );
            expect(r).toContain('TimeoutError');
            expect(r).toContain('timed out');
        });

        test('Puter 巢狀物件 {error:{code,message}}', async ({ page }) => {
            const r = await page.evaluate(() => PuterAI.formatPuterError({
                success: false,
                error: { code: 'rate_limit_exceeded', message: 'quota hit' }
            }));
            expect(r).toBe('[rate_limit_exceeded] quota hit');
        });

        test('Puter 字串型 {error:"..."}', async ({ page }) => {
            const r = await page.evaluate(() => PuterAI.formatPuterError({ error: 'simple string' }));
            expect(r).toBe('simple string');
        });

        test('循環引用不會拋錯（safeStringify）', async ({ page }) => {
            const r = await page.evaluate(() => {
                const a = { x: 1 };
                a.self = a;
                return PuterAI.formatPuterError(a);
            });
            // a 沒 name/message/error，會落到 safeStringify
            expect(r).toContain('[Circular]');
        });

        test('BigInt 不會讓 stringify 炸掉', async ({ page }) => {
            const r = await page.evaluate(() => PuterAI.formatPuterError({ value: 12345678901234567890n }));
            expect(r).toContain('12345678901234567890');
        });

        test('具 name+message 的物件但附帶 error.code → 顯示 code + name + message', async ({ page }) => {
            const r = await page.evaluate(() => PuterAI.formatPuterError({
                name: 'APIError',
                message: 'server refused',
                error: { code: 'forbidden' }
            }));
            expect(r).toBe('[forbidden] APIError: server refused');
        });

        test('string 型 error 不加多餘引號（回歸：Copilot review 指出）', async ({ page }) => {
            // formatPuterError("oops") 應回傳 "oops" 而非 '"oops"'
            const r = await page.evaluate(() => PuterAI.formatPuterError('oops'));
            expect(r).toBe('oops');
        });

        test('function / symbol 型 error 不會讓回傳變 undefined（回歸：Copilot review 指出）', async ({ page }) => {
            const results = await page.evaluate(() => ({
                fn: PuterAI.formatPuterError(function badInput() {}),
                sym: PuterAI.formatPuterError(Symbol('x')),
                num: PuterAI.formatPuterError(42),
                bool: PuterAI.formatPuterError(true),
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

    test.describe('callGeminiWithFallback', () => {
        test.beforeEach(async ({ page }) => { await gotoFixture(page); });

        test('第一個模型失敗 → 自動試第二個', async ({ page }) => {
            const result = await page.evaluate(async () => {
                const calls = [];
                window.puter = {
                    ai: {
                        chat: async (prompt, opts) => {
                            calls.push(opts.model);
                            if (opts.model === 'gemini-3.1-pro-preview') {
                                throw { success: false, error: { code: 'quota_exceeded', message: 'no quota' } };
                            }
                            return { message: { content: 'hello from ' + opts.model } };
                        }
                    }
                };
                const r = await PuterAI.callGeminiWithFallback('hi');
                return { calls, content: r.message.content };
            });
            expect(result.calls).toEqual(['gemini-3.1-pro-preview', 'gemini-2.5-pro']);
            expect(result.content).toBe('hello from gemini-2.5-pro');
        });

        test('全部模型失敗 → throw 最後一個 error', async ({ page }) => {
            const result = await page.evaluate(async () => {
                window.puter = {
                    ai: {
                        chat: async (prompt, opts) => {
                            throw { success: false, error: { code: 'fail_' + opts.model, message: 'x' } };
                        }
                    }
                };
                try {
                    await PuterAI.callGeminiWithFallback('hi');
                    return { thrown: false };
                } catch (e) {
                    return { thrown: true, code: e && e.error && e.error.code };
                }
            });
            expect(result.thrown).toBe(true);
            expect(result.code).toBe('fail_gemini-3-flash-preview');
        });

        test('AbortError 只試 1 個模型後立即 throw', async ({ page }) => {
            const result = await page.evaluate(async () => {
                const calls = [];
                window.puter = {
                    ai: {
                        chat: async (prompt, opts) => {
                            calls.push(opts.model);
                            throw new DOMException('aborted', 'AbortError');
                        }
                    }
                };
                try {
                    await PuterAI.callGeminiWithFallback('hi');
                    return { thrown: false };
                } catch (e) {
                    return { thrown: true, name: e.name, calls };
                }
            });
            expect(result.thrown).toBe(true);
            expect(result.name).toBe('AbortError');
            expect(result.calls).toEqual(['gemini-3.1-pro-preview']);
        });

        test('TimeoutError 只試 1 個模型後立即 throw', async ({ page }) => {
            const result = await page.evaluate(async () => {
                const calls = [];
                window.puter = {
                    ai: {
                        chat: async (prompt, opts) => {
                            calls.push(opts.model);
                            throw new DOMException('timeout', 'TimeoutError');
                        }
                    }
                };
                try {
                    await PuterAI.callGeminiWithFallback('hi');
                    return { thrown: false };
                } catch (e) {
                    return { thrown: true, name: e.name, calls };
                }
            });
            expect(result.thrown).toBe(true);
            expect(result.name).toBe('TimeoutError');
            expect(result.calls).toEqual(['gemini-3.1-pro-preview']);
        });

        test('Puter.js 未載入 → 友善錯誤訊息', async ({ page }) => {
            const result = await page.evaluate(async () => {
                delete window.puter;
                try {
                    await PuterAI.callGeminiWithFallback('hi');
                    return { thrown: false };
                } catch (e) {
                    return { thrown: true, message: e.message };
                }
            });
            expect(result.thrown).toBe(true);
            expect(result.message).toContain('尚未載入');
        });

        test('options 中的 signal / stream / temperature 會透傳', async ({ page }) => {
            const result = await page.evaluate(async () => {
                let received = null;
                window.puter = {
                    ai: {
                        chat: async (prompt, opts) => {
                            received = opts;
                            return 'ok';
                        }
                    }
                };
                const ctrl = new AbortController();
                await PuterAI.callGeminiWithFallback('hi', {
                    signal: ctrl.signal,
                    stream: true,
                    temperature: 0.7,
                });
                return {
                    hasSignal: received.signal instanceof AbortSignal,
                    stream: received.stream,
                    temperature: received.temperature,
                    model: received.model,
                };
            });
            expect(result.hasSignal).toBe(true);
            expect(result.stream).toBe(true);
            expect(result.temperature).toBe(0.7);
            expect(result.model).toBe('gemini-3.1-pro-preview');
        });
    });

    test.describe('Logger', () => {
        test.beforeEach(async ({ page }) => { await gotoFixture(page); });

        test('log 事件會被收集', async ({ page }) => {
            const logs = await page.evaluate(() => {
                PuterAI.clearLogs();
                PuterAI.log('info', 'hello');
                PuterAI.log('warn', 'yikes', { detail: 42 });
                return PuterAI.getLogs();
            });
            expect(logs.length).toBe(2);
            expect(logs[0].level).toBe('info');
            expect(logs[0].message).toBe('hello');
            expect(logs[1].level).toBe('warn');
            expect(logs[1].meta.detail).toBe(42);
        });

        test('clearLogs 清空', async ({ page }) => {
            const count = await page.evaluate(() => {
                PuterAI.log('info', 'a');
                PuterAI.clearLogs();
                return PuterAI.getLogs().length;
            });
            expect(count).toBe(0);
        });

        test('log(msg, null) 不會在 panel 渲染多餘的 "null"（回歸：Copilot review 指出）', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            // 只保留我們要驗的兩筆，方便斷言
            const { noMetaLine, withMetaLine } = await page.evaluate(() => {
                PuterAI.clearLogs();
                PuterAI.log('info', 'NO_META_MARKER', null);
                PuterAI.log('info', 'WITH_META_MARKER', { foo: 'bar' });
                // 取出 panel 內每一行的 textContent（panel > body > 每行是一個 div）
                const body = document.querySelector('#puter-ai-debug-panel > div:nth-of-type(2)');
                const lines = Array.from(body.querySelectorAll(':scope > div'))
                    .map(div => div.textContent);
                return {
                    noMetaLine: lines.find(t => t.includes('NO_META_MARKER')) || '',
                    withMetaLine: lines.find(t => t.includes('WITH_META_MARKER')) || '',
                };
            });
            // 沒 meta 的那一行不能出現獨立的 "null" 字串（Copilot 指出的 bug）
            expect(noMetaLine).toContain('NO_META_MARKER');
            expect(noMetaLine).not.toMatch(/\bnull\b/);
            // 有 meta 的那一行應有 JSON 附加
            expect(withMetaLine).toContain('WITH_META_MARKER');
            expect(withMetaLine).toContain('"foo"');
        });

        test('callGeminiWithFallback 會寫入 log', async ({ page }) => {
            const logs = await page.evaluate(async () => {
                PuterAI.clearLogs();
                window.puter = {
                    ai: {
                        chat: async (prompt, opts) => {
                            if (opts.model === 'gemini-3.1-pro-preview') {
                                throw { success: false, error: { code: 'bad', message: 'err' } };
                            }
                            return 'ok';
                        }
                    }
                };
                await PuterAI.callGeminiWithFallback('hi');
                return PuterAI.getLogs();
            });
            // 至少應有：開始、模型 1 失敗、模型 2 成功
            expect(logs.length).toBeGreaterThanOrEqual(3);
            expect(logs.some(l => l.message.includes('開始'))).toBe(true);
            expect(logs.some(l => l.level === 'warn' && l.message.includes('gemini-3.1-pro-preview'))).toBe(true);
            expect(logs.some(l => l.message.includes('gemini-2.5-pro') && l.message.includes('成功'))).toBe(true);
        });
    });

    test.describe('Debug panel', () => {
        test('手動 mountDebugPanel 會插入 DOM 元素', async ({ page }) => {
            await gotoFixture(page);
            await page.evaluate(() => PuterAI.mountDebugPanel());
            await expect(page.locator('#puter-ai-debug-panel')).toBeVisible();
        });

        test('?debug=1 會自動掛載 panel', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            await expect(page.locator('#puter-ai-debug-panel')).toBeVisible();
        });

        test('localStorage.PUTER_DEBUG 會自動掛載 panel', async ({ page, context }) => {
            // 先拜訪 fixture 以便設定 localStorage（同源）
            await page.goto(FIXTURE_URL);
            await page.evaluate(() => localStorage.setItem('PUTER_DEBUG', '1'));
            // 重新載入，此時 shared/puter-ai.js 執行時會讀到 flag
            await page.reload();
            await page.waitForFunction(() => window.__READY__ === true);
            await expect(page.locator('#puter-ai-debug-panel')).toBeVisible();
            // 清掉避免影響下一個測試
            await page.evaluate(() => localStorage.removeItem('PUTER_DEBUG'));
        });

        test('未啟用時不掛載 panel', async ({ page }) => {
            await gotoFixture(page);
            const count = await page.locator('#puter-ai-debug-panel').count();
            expect(count).toBe(0);
        });

        test('header mousedown 落在按鈕上不觸發拖曳（回歸：Copilot review 指出）', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            const panel = page.locator('#puter-ai-debug-panel');
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
            const panel = page.locator('#puter-ai-debug-panel');
            await expect(panel).toBeVisible();

            // 關閉 panel，應觸發 dragCtrl.abort() 移除 document-level listeners
            // 按鈕現在用 aria-label 作為可訪問名稱（Copilot A11Y 修正後）
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
            await page.evaluate(() => PuterAI.mountDebugPanel());
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
                PuterAI.clearLogs();
                // 推 210 筆超過預設 MAX_LOGS=200
                for (let i = 0; i < 210; i++) PuterAI.log('info', 'msg-' + i);
                const body = document.querySelector('#puter-ai-debug-panel > div:nth-of-type(2)');
                return {
                    logCount: PuterAI.getLogs().length,
                    domCount: body.children.length,
                };
            });
            // 陣列有 200 上限
            expect(logCount).toBeLessThanOrEqual(200);
            // 更重要：DOM 也被同步截斷（Copilot 原本指出的洩漏）
            expect(domCount).toBeLessThanOrEqual(200);
            // 1:1 對應（panel 內行數 = logs 陣列長度）
            expect(domCount).toBe(logCount);
        });

        test('toggle / close 按鈕具有可訪問的 aria-label（回歸：Copilot A11Y）', async ({ page }) => {
            await gotoFixture(page, '?debug=1');
            const panel = page.locator('#puter-ai-debug-panel');
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
                PuterAI.log('info', 'first');
                PuterAI.log('warn', 'second');
            });
            // 預期 panel body 內有 2 行
            const panel = page.locator('#puter-ai-debug-panel');
            await expect(panel).toBeVisible();
            // 點 Clear
            await panel.getByRole('button', { name: 'Clear' }).click();
            const logsLeft = await page.evaluate(() => PuterAI.getLogs().length);
            expect(logsLeft).toBe(0);
        });
    });
});
