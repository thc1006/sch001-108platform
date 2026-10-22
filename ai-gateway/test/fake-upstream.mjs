/**
 * 假的 WinLab：照劇本一輪一輪回應 Chat Completions，並記下收到的每個請求。
 * 測試全部打本機，不依賴外網：真的 WinLab 回應時間與內容都會飄，而且要 key。
 *
 * 劇本是陣列（第 n 個請求用第 n 步）或函式 (request, index) => step。每一步：
 *   { status, body, headers }      非 200 的回應（body 是字串或物件）
 *   { thinking: [..], content: [..], finish, usage }
 *                                  正常的 SSE 串流；thinking／content 每個元素是一塊 delta；
 *                                  finish: null 表示不送結束原因
 *   rawChunks: [..]                直接寫出這些字串或 Buffer（測 SSE 解析的邊界情況）
 *   errorChunk: {...}              在正文之後送出 {"error": ...}，接著像 LiteLLM 一樣送 [DONE]
 *   hangAfterChunks: n             送完 n 塊後就不再送、也不關（測閒置逾時）
 *   hangBeforeHeaders: true        連標頭都不送
 *   cutAfterChunks: n              送完 n 塊（確定送出去了）後直接切斷連線
 *   endDelayMs                     [DONE] 之後隔多久才結束回應（測連線重用）
 *   contentType                    覆寫回應的 content-type
 *   chunkDelayMs                   每塊之間額外的間隔
 *
 * 每次寫入之後都讓出一次 event loop：Node 的 HTTP 回應會把同一個 tick 內的寫入合併，
 * 不讓出的話「被切成很多塊」與「途中切斷」都只是名義上的（用戶端其實一塊都沒收到）。
 */
import { createServer } from 'node:http';

const sse = (obj) => `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

export function sseChunksFor(step) {
    const chunks = [];
    chunks.push(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
    for (const t of step.thinking || []) {
        chunks.push(sse({ choices: [{ index: 0, delta: { reasoning_content: t } }] }));
    }
    for (const c of step.content || []) {
        chunks.push(sse({ choices: [{ index: 0, delta: { content: c } }] }));
    }
    if (step.errorChunk) {
        chunks.push(sse({ error: step.errorChunk }));
        chunks.push(sse('[DONE]'));
        return chunks;
    }
    if (step.finish !== null) {
        chunks.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: step.finish || 'stop' }] }));
    }
    // 跟 LiteLLM 一樣：最後一塊只帶 usage，finish_reason 是 null
    const usage = step.usage === undefined ? {
        prompt_tokens: 10,
        completion_tokens: (step.thinking || []).length + (step.content || []).length,
        completion_tokens_details: { reasoning_tokens: (step.thinking || []).length },
    } : step.usage;
    if (usage !== null) chunks.push(sse({ choices: [{ index: 0, delta: {} }], usage }));
    chunks.push(sse('[DONE]'));
    return chunks;
}

export async function startFakeUpstream(script) {
    const requests = [];
    const sockets = new Set();
    let connections = 0;
    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const part of req) raw += part;
        let body = null;
        try {
            body = raw ? JSON.parse(raw) : null;
        } catch {
            body = raw;
        }
        const entry = { method: req.method, url: req.url, headers: req.headers, body, raw };
        const index = requests.length;
        requests.push(entry);
        const step = typeof script === 'function' ? script(entry, index) : script[index];
        if (!step) {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end(`fake upstream: no script step for request #${index}`);
            return;
        }
        if (step.hangBeforeHeaders) return;
        if (step.status && step.status !== 200) {
            res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers || {}) });
            if (step.status === 204 || step.status === 304) {
                res.end();
                return;
            }
            res.end(typeof step.body === 'string' || Buffer.isBuffer(step.body) ? step.body : JSON.stringify(step.body || {}));
            return;
        }
        res.writeHead(200, {
            'content-type': step.contentType || 'text/event-stream',
            'cache-control': 'no-cache',
            ...(step.headers || {}),
        });
        const chunks = step.rawChunks || sseChunksFor(step);
        for (let i = 0; i < chunks.length; i++) {
            if (step.hangAfterChunks === i) return; // 不送、不關，等用戶端逾時
            if (step.cutAfterChunks === i) {
                await yieldLoop();
                res.socket.destroy();
                return;
            }
            if (res.destroyed) return;
            res.write(chunks[i]);
            await yieldLoop();
            if (step.chunkDelayMs) await delay(step.chunkDelayMs);
        }
        if (step.endDelayMs) await delay(step.endDelayMs);
        res.end();
    });
    server.on('connection', (socket) => {
        connections++;
        socket.setNoDelay(true);
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        origin: `http://127.0.0.1:${port}`,
        requests,
        get connections() {
            return connections;
        },
        async close() {
            for (const s of sockets) s.destroy();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

// 測試共用的設定：小一點的逾時與重試間隔，跑起來才快
export function testConfig(origin, overrides = {}) {
    return {
        upstream: origin,
        apiKey: 'sk-test-key-123',
        model: 'qwen3.8-27b-fp8',
        reasoningEffort: 'xhigh',
        continuationEffort: 'none',
        maxTokens: 8192,
        contextTokens: 32768,
        maxRounds: 4,
        taskTimeoutMs: 10_000,
        idleTimeoutMs: 2_000,
        afterFinishIdleMs: 200,
        continuationRetries: 2,
        retryBaseMs: 10,
        retryMaxMs: 50,
        ...overrides,
    };
}
