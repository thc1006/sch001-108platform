// 頁面測試共用的假 AI 閘道：CI 不連真的閘道與 WinLab。
// 檔名不是 *.spec.js，Playwright 不會把它當成測試執行。

/** sse 把一個事件寫成 SSE 格式的字串。 @param {string} event @param {unknown} data @returns {string} */
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** XSS_IMG 是頁面該當成純文字顯示的 img 標籤，被執行的話 window.__xss 會變成 1。 */
const XSS_IMG = '<img src=x onerror="window.__xss=1">';
/** XSS_SCRIPT 是頁面該當成純文字顯示的 script 標籤，被執行的話 window.__xss 會變成 2。 */
const XSS_SCRIPT = '<script>window.__xss=2</script>';

/**
 * stubBuiltInGateway 把頁面的閘道網址換成 built-in.example，fetch 也換成一律失敗的版本。CI 的建置
 * 帶著正式閘道的網址（PUBLIC_AI_GATEWAY_URL 從 repository variable 帶入）；忘了呼叫
 * installFakeGateway 的測試會馬上失敗，不會從 CI 對正式的閘道送出請求。
 * @param {import('@playwright/test').Page} page
 */
async function stubBuiltInGateway(page) {
    await page.evaluate(() => {
        document.querySelectorAll('meta[name="ai-gateway-url"]').forEach((m) => m.remove());
        const meta = document.createElement('meta');
        meta.name = 'ai-gateway-url';
        meta.content = 'https://built-in.example';
        document.head.appendChild(meta);
        window.fetch = () => Promise.reject(new Error('測試沒有呼叫 installFakeGateway'));
    });
}

/**
 * installFakeGateway 把 fetch 換成照劇本回 SSE 的假閘道，收到的請求記在 window.__calls。
 * 既有的閘道 meta 先全部移除，因為 getGatewayUrl() 只看第一個。
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} [options]
 * @param {string[]} [options.chunks]   依序送出的 SSE 片段
 * @param {boolean} [options.hang]      送完 chunks 不結束，之後用 window.__stream.push(chunk)、
 *                                      window.__stream.end() 接著送。送過 done 就別再 end()：runTask
 *                                      收到 done 會中止請求，串流進入錯誤狀態，close() 會丟 TypeError。
 * @param {boolean} [options.withMeta]  false 時不補假的 meta，等於沒有設定閘道。
 */
async function installFakeGateway(page, { chunks = [], hang = false, withMeta = true } = {}) {
    await page.evaluate(({ chunks, hang, withMeta }) => {
        document.querySelectorAll('meta[name="ai-gateway-url"]').forEach((m) => m.remove());
        if (withMeta) {
            const meta = document.createElement('meta');
            meta.name = 'ai-gateway-url';
            meta.content = 'https://gateway.example';
            document.head.appendChild(meta);
        }
        window.__calls = [];
        window.fetch = (url, init) => {
            window.__calls.push({ url: String(url), body: init && init.body });
            const encoder = new TextEncoder();
            const signal = init && init.signal;
            const body = new ReadableStream({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
                    if (hang) {
                        window.__stream = {
                            push: (chunk) => controller.enqueue(encoder.encode(chunk)),
                            end: () => controller.close(),
                        };
                    } else {
                        controller.close();
                    }
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            try { controller.error(new DOMException('aborted', 'AbortError')); } catch (_) {}
                        });
                    }
                },
            });
            return Promise.resolve(new Response(body, {
                status: 200,
                headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req-1' },
            }));
        };
    }, { chunks, hang, withMeta });
}

module.exports = { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway };
