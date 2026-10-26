/**
 * HTTP 層：CORS、拒絕路徑、SSE 事件、斷線中止、排隊、限流、心跳、關機與 log。
 * generateImpl 換成照劇本跑的假實作，精準控制每個任務何時結束；
 * 真正的 WinLab 呼叫與續寫邏輯由 upstream／generate 的測試負責。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGateway, createLogger } from '../src/server.mjs';
import { createCatalog } from '../src/tasks.mjs';
import { TASK_DEFINITIONS } from '../src/task-catalog.mjs';
import { UpstreamError } from '../src/upstream.mjs';
import { GenerationError, DEGENERATE_NUDGE } from '../src/generate.mjs';
import { testConfig, startFakeUpstream } from './fake-upstream.mjs';

const ORIGIN = 'https://thc1006.github.io';
const SERVER_FILE = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

const TASKS = createCatalog([
    {
        id: 'demo-json',
        input: { topic: { label: '主題', maxLength: 20 } },
        output: {
            type: 'json',
            schema: {
                type: 'object',
                properties: { answer: { type: 'string', minLength: 1 } },
                required: ['answer'],
                additionalProperties: false,
            },
        },
        instructions: '依主題回答。',
    },
    {
        id: 'demo-md',
        input: { question: { label: '問題', maxLength: 100 } },
        output: { type: 'markdown' },
        temperature: 0.5,
        instructions: '回答問題。',
    },
    {
        id: 'demo-long',
        input: { essay: { label: '文章', maxLength: 6000 } },
        output: { type: 'markdown' },
        instructions: '給回饋。',
    },
    {
        id: 'demo-quick',
        input: { topic: { label: '主題', maxLength: 20 } },
        output: { type: 'markdown' },
        instructions: '簡短回答。',
        timeoutMs: 300,
    },
]);

const OK_RESULT = { content: '{"answer":"好"}', rounds: 1, continuations: [], usage: { promptTokens: 1, completionTokens: 2, reasoningTokens: 0 } };

function serverConfig(overrides = {}) {
    return {
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: [ORIGIN],
        clientIpHeader: '',
        trustedProxies: [],
        concurrency: 4,
        maxQueue: 8,
        queueTimeoutMs: 5_000,
        rateLimitWindowMs: 60_000,
        rateLimitMax: 100,
        requestLimitPerMinute: 10_000,
        clientMaxInflight: 10,
        bodyTimeoutMs: 30_000,
        heartbeatMs: 60_000,
        shutdownGraceMs: 1_000,
        logLevel: 'debug',
        ...overrides,
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/**
 * 啟動一個閘道。generate 預設立刻回傳 {"answer":"好"}；可以傳入自訂的實作。
 * calls 記錄每次 generate 收到的設定、request 與 hooks。now 可以換成測試控制的時鐘。
 */
async function startGateway({ server = {}, llm = {}, generate, now, maxBodyReads, maxPendingBytes, stallTimeoutMs, host = '127.0.0.1' } = {}) {
    const logs = [];
    const calls = [];
    const generateImpl = async (llmConfig, request, hooks) => {
        calls.push({ llm: llmConfig, request, hooks });
        if (generate) return generate(request, hooks, calls.length);
        return OK_RESULT;
    };
    const gateway = createGateway({
        llm: testConfig('http://unused.invalid', llm),
        server: serverConfig(server),
        tasks: TASKS,
        generateImpl,
        log: (level, tag, fields) => logs.push({ level, tag, fields }),
        ...(now ? { now } : {}),
        ...(maxBodyReads ? { maxBodyReads } : {}),
        ...(maxPendingBytes ? { maxPendingBytes } : {}),
        ...(stallTimeoutMs ? { stallTimeoutMs } : {}),
    });
    await new Promise((resolve) => gateway.server.listen(0, host, resolve));
    const port = gateway.server.address().port;
    return {
        base: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
        port,
        logs,
        calls,
        gateway,
        async stop() {
            await gateway.close({ graceMs: 0, requestWaitMs: 0 });
        },
    };
}

/**
 * 用真的 generate、streamChat 與假 WinLab 啟動閘道：請求走過 HTTP 入口、生成引擎、上游串流解析
 * 與 SSE 回應。lines 收下 createLogger 寫出的每一行 log。
 */
async function startRealGateway(script, llm = {}) {
    const upstream = await startFakeUpstream(script);
    const lines = [];
    const gateway = createGateway({
        llm: testConfig(upstream.origin, { taskTimeoutMs: 4_000, ...llm }),
        server: serverConfig(),
        tasks: TASKS,
        log: createLogger('debug', (line) => lines.push(line)),
    });
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    return {
        base: `http://127.0.0.1:${gateway.server.address().port}`,
        upstream,
        lines,
        async stop() {
            await gateway.close({ graceMs: 0, requestWaitMs: 0 });
            await upstream.close();
        },
    };
}

/** 一個永遠不結束、直到被中止的 generate；回傳 { generate, started } */
function hangingGenerate() {
    const started = deferred();
    return {
        started: started.promise,
        generate: (request, hooks) => new Promise((resolve, reject) => {
            started.resolve(hooks);
            hooks.signal.addEventListener('abort', () => reject(new UpstreamError('aborted', '取消')), { once: true });
        }),
    };
}

function post(base, task, input, { origin = ORIGIN, headers = {}, body, signal } = {}) {
    return fetch(`${base}/v1/tasks/${task}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...headers },
        body: body ?? JSON.stringify({ input }),
        signal,
    });
}

/** 用 node:http 送請求，拿得到 fetch 會藏起來的 connection 標頭；可以指定 agent 重用連線 */
function rawRequest(port, { method = 'POST', path: urlPath = '/v1/tasks/demo-json', headers = {}, body, agent } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: agent ?? false }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text, reused: req.reusedSocket }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function jsonHeaders(extra = {}) {
    return { 'content-type': 'application/json', origin: ORIGIN, ...extra };
}

/** 原始 TCP 連線：text 記下收到的全部內容，whenClosed 在連線關閉時兌現 */
async function rawSocket(port) {
    const socket = net.connect(port, '127.0.0.1');
    socket.setEncoding('utf8');
    socket.text = '';
    socket.on('data', (c) => { socket.text += c; });
    socket.whenClosed = new Promise((resolve) => socket.on('close', resolve));
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
    });
    socket.on('error', () => {});
    return socket;
}

/** 一個完整的任務請求（原始 HTTP 文字） */
function rawPost(task, input, { origin = ORIGIN, extraHeaders = '' } = {}) {
    const body = JSON.stringify({ input });
    return `POST /v1/tasks/${task} HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n${extraHeaders}\r\n${body}`;
}

/** 送出標頭與源源不絕的 chunked body，回傳連線被關掉之前收到的回應（2 秒內沒關就失敗） */
async function floodChunked(port, urlPath, headers) {
    const socket = await rawSocket(port);
    socket.write(`POST ${urlPath} HTTP/1.1\r\nHost: x\r\n${headers}Transfer-Encoding: chunked\r\n\r\n`);
    const chunk = `1000\r\n${'x'.repeat(0x1000)}\r\n`;
    const pump = setInterval(() => { if (!socket.destroyed) socket.write(chunk); }, 1);
    try {
        assert.equal(await within(socket.whenClosed, 2_000), true, `${urlPath}：2 秒內連線沒有被關掉`);
        return socket.text;
    } finally {
        clearInterval(pump);
        socket.destroy();
    }
}

/** promise 在 ms 內兌現就回 true，否則回 false（不留下計時器） */
async function within(promise, ms) {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, ms, false); });
    try {
        return await Promise.race([promise.then(() => true), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 追蹤由 src/ 底下的程式建立的計時器，包括 process.getActiveResourcesInfo() 看不到的 unref
 * 計時器。到期或被清掉就移除；restore() 換回原本的函式。
 */
function trackTimers() {
    const original = { setTimeout, clearTimeout, setInterval, clearInterval };
    const live = new Map();
    const caller = () => new Error().stack.split('\n')[3] || '';
    const fromSrc = (line) => /[/\\]src[/\\][\w-]+\.mjs/.test(line);
    globalThis.setTimeout = (fn, ms, ...args) => {
        const where = caller();
        const timer = original.setTimeout((...a) => {
            live.delete(timer);
            fn(...a);
        }, ms, ...args);
        if (fromSrc(where)) live.set(timer, where.trim());
        return timer;
    };
    globalThis.clearTimeout = (timer) => {
        live.delete(timer);
        original.clearTimeout(timer);
    };
    globalThis.setInterval = (fn, ms, ...args) => {
        const where = caller();
        const timer = original.setInterval(fn, ms, ...args);
        if (fromSrc(where)) live.set(timer, where.trim());
        return timer;
    };
    globalThis.clearInterval = (timer) => {
        live.delete(timer);
        original.clearInterval(timer);
    };
    return { live, restore: () => Object.assign(globalThis, original) };
}

/** 把 SSE 文字解析成 [{event, data}]（data 已 JSON.parse）；comments 記下 : 開頭的行 */
function parseSse(text) {
    const events = [];
    let comments = 0;
    for (const block of text.split('\n\n')) {
        if (!block.trim()) continue;
        let event = 'message';
        const data = [];
        for (const line of block.split('\n')) {
            if (line.startsWith(':')) comments++;
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data.push(line.slice(6));
        }
        if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
    }
    return { events, comments };
}

async function readEvents(res) {
    return parseSse(await res.text()).events;
}

/**
 * 逐步讀 SSE。until(predicate) 讀到 predicate(目前為止的事件) 為真就停（已經收到的會先檢查，
 * 可以連續呼叫）；rest() 讀到串流結束。兩者都回傳目前為止的全部事件。
 */
function sseReader(res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const complete = () => parseSse(text.slice(0, text.lastIndexOf('\n\n') + 2)).events;
    return {
        async until(predicate) {
            for (;;) {
                const events = complete();
                if (predicate(events)) return events;
                const { value, done } = await reader.read();
                if (done) return parseSse(text).events;
                text += decoder.decode(value, { stream: true });
            }
        },
        async rest() {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) return parseSse(text).events;
                text += decoder.decode(value, { stream: true });
            }
        },
    };
}

const accepted = (events) => events.some((e) => e.event === 'accepted');
const queued = (events) => events.some((e) => e.data.phase === 'queued');

async function waitFor(fn, timeoutMs = 2000) {
    const started = Date.now();
    while (!fn()) {
        if (Date.now() - started > timeoutMs) throw new Error('waitFor 逾時');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('healthz／readyz：有 key 才 ready；公開的 readyz 只說狀態；HEAD 也可以', async () => {
    const gw = await startGateway();
    const noKey = await startGateway({ llm: { apiKey: '' } });
    try {
        assert.deepEqual(await (await fetch(`${gw.base}/healthz`)).json(), { status: 'ok' });
        const ready = await fetch(`${gw.base}/readyz`);
        assert.equal(ready.status, 200);
        assert.deepEqual(await ready.json(), { status: 'ready' });
        const notReady = await fetch(`${noKey.base}/readyz`);
        assert.equal(notReady.status, 503);
        assert.deepEqual(await notReady.json(), { status: 'not_ready' }, '不說是哪裡沒設定好');
        for (const p of ['/healthz', '/readyz']) {
            const head = await rawRequest(gw.port, { method: 'HEAD', path: p });
            assert.equal(head.status, 200, p);
            assert.equal(head.body, '', p);
        }
        // 沒有 body 的請求不必關連線（健康檢查、代理的連線池都靠 keep-alive）
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        try {
            const first = await rawRequest(gw.port, { method: 'GET', path: '/healthz', agent });
            assert.equal(first.headers.connection, 'keep-alive');
            const second = await rawRequest(gw.port, { method: 'GET', path: '/readyz', agent });
            assert.equal(second.reused, true);
            const notFound = await rawRequest(gw.port, { method: 'GET', path: '/nope', agent });
            assert.equal(notFound.headers.connection, 'keep-alive');
        } finally {
            agent.destroy();
        }
    } finally {
        await gw.stop();
        await noKey.stop();
    }
});

test('未知路徑 404；任務路徑用 GET 回 405 並列出允許的方法', async () => {
    const gw = await startGateway();
    try {
        assert.equal((await fetch(`${gw.base}/v1/chat/completions`, { method: 'POST' })).status, 404);
        assert.equal((await fetch(`${gw.base}/`)).status, 404);
        assert.equal((await fetch(`${gw.base}/v1/tasks/Demo`)).status, 404);
        const res = await fetch(`${gw.base}/v1/tasks/demo-json`);
        assert.equal(res.status, 405);
        assert.equal(res.headers.get('allow'), 'POST, OPTIONS');
    } finally {
        await gw.stop();
    }
});

test('預檢：允許的網站拿到 204 與完整的 CORS 標頭；其他網站 403 且沒有 CORS 標頭', async () => {
    const gw = await startGateway();
    try {
        const ok = await fetch(`${gw.base}/v1/tasks/demo-json`, {
            method: 'OPTIONS',
            headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
        });
        assert.equal(ok.status, 204);
        assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
        assert.equal(ok.headers.get('access-control-allow-methods'), 'POST');
        assert.equal(ok.headers.get('access-control-allow-headers'), 'Content-Type');
        assert.equal(ok.headers.get('access-control-max-age'), '600');
        assert.equal(ok.headers.get('cache-control'), 'no-store');
        assert.equal(ok.headers.get('vary'), 'Origin');

        const evil = await fetch(`${gw.base}/v1/tasks/demo-json`, {
            method: 'OPTIONS',
            headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
        });
        assert.equal(evil.status, 403);
        assert.equal(evil.headers.get('access-control-allow-origin'), null);
        assert.equal(evil.headers.get('vary'), 'Origin', '不同 Origin 的回應不同，快取要分開存');
        // 網域後綴攻擊：thc1006.github.io 的後面再接別的網域
        const suffix = await fetch(`${gw.base}/v1/tasks/demo-json`, {
            method: 'OPTIONS',
            headers: { origin: 'https://thc1006.github.io.evil.example' },
        });
        assert.equal(suffix.status, 403);
    } finally {
        await gw.stop();
    }
});

test('POST 沒有 Origin 或不在名單內：403，而且不會呼叫模型', async () => {
    const gw = await startGateway();
    try {
        assert.equal((await post(gw.base, 'demo-json', { topic: 'x' }, { origin: null })).status, 403);
        const evil = await post(gw.base, 'demo-json', { topic: 'x' }, { origin: 'https://evil.example' });
        assert.equal(evil.status, 403);
        assert.equal((await evil.json()).error.code, 'origin_not_allowed');
        assert.equal(evil.headers.get('access-control-allow-origin'), null);
        assert.equal(gw.calls.length, 0);
    } finally {
        await gw.stop();
    }
});

test('拒絕路徑都回 JSON，帶 request id、CORS 與防快取標頭（前端才讀得到錯誤）', async () => {
    const gw = await startGateway();
    try {
        const cases = [
            [() => post(gw.base, 'no-such-task', { topic: 'x' }), 404, 'unknown_task'],
            [() => post(gw.base, 'demo-json', null, { headers: { 'content-type': 'text/plain' }, body: '{}' }), 415, 'unsupported_media_type'],
            [() => post(gw.base, 'demo-json', null, { body: '{"input":' }), 400, 'invalid_json'],
            [() => post(gw.base, 'demo-json', { topic: '' }), 400, 'invalid_input'],
            [() => post(gw.base, 'demo-json', { topic: 'x', extra: 'y' }), 400, 'invalid_input'],
            [() => post(gw.base, 'demo-json', { topic: '超'.repeat(21) }), 400, 'invalid_input'],
            [() => post(gw.base, 'demo-json', null, { body: JSON.stringify({ input: { topic: 'x'.repeat(20_000) } }) }), 413, 'payload_too_large'],
        ];
        for (const [send, status, code] of cases) {
            const res = await send();
            assert.equal(res.status, status, code);
            assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN, code);
            assert.equal(res.headers.get('access-control-expose-headers'), 'X-Request-Id, Retry-After', code);
            assert.equal(res.headers.get('vary'), 'Origin', code);
            assert.equal(res.headers.get('x-content-type-options'), 'nosniff', code);
            assert.equal(res.headers.get('cache-control'), 'no-store', code);
            assert.ok(res.headers.get('x-request-id'), code);
            const body = await res.json();
            assert.equal(body.error.code, code);
            assert.equal(body.error.requestId, res.headers.get('x-request-id'));
            assert.ok(body.error.message, code);
        }
        const tooLong = await (await post(gw.base, 'demo-json', { topic: '超'.repeat(21) })).json();
        assert.equal(tooLong.error.field, 'topic');
        assert.match(tooLong.error.message, /主題最多 20 字/);
        assert.equal(gw.calls.length, 0);
    } finally {
        await gw.stop();
    }
});

test('Content-Type 的參數與大小寫不影響：application/json; charset=utf-8、Application/JSON 都收', async () => {
    const gw = await startGateway();
    try {
        for (const type of ['application/json; charset=utf-8', 'Application/JSON', 'application/json;charset=UTF-8']) {
            const res = await post(gw.base, 'demo-json', { topic: 'x' }, { headers: { 'content-type': type } });
            assert.equal(res.status, 200, type);
            await res.text();
        }
    } finally {
        await gw.stop();
    }
});

test('body 上限依任務的字數上限計算：6000 字的欄位填 5500 個中文字不會被 413 擋掉', async () => {
    const gw = await startGateway({ generate: async () => ({ ...OK_RESULT, content: '很好' }) });
    try {
        const res = await post(gw.base, 'demo-long', { essay: '學'.repeat(5500) });
        assert.equal(res.status, 200);
        assert.equal((await readEvents(res)).at(-1).event, 'done');
        // 而 20 字上限的任務，同樣的 body 就太大了
        const small = await post(gw.base, 'demo-json', null, { body: JSON.stringify({ input: { topic: '學'.repeat(5500) } }) });
        assert.equal(small.status, 413);
    } finally {
        await gw.stop();
    }
});

test('413 會關掉連線；宣告的 Content-Length 太大時不等 body 就回應', async () => {
    const gw = await startGateway();
    try {
        // 只送標頭、宣稱 10 MB，body 一個位元組都不送：要立刻收到 413，不是等到逾時
        const socket = net.connect(gw.port, '127.0.0.1');
        socket.write(
            'POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: https://thc1006.github.io\r\n' +
            'Content-Type: application/json\r\nContent-Length: 10000000\r\n\r\n',
        );
        const reply = await new Promise((resolve, reject) => {
            let text = '';
            const timer = setTimeout(() => reject(new Error('2 秒內沒有回應')), 2000);
            socket.on('data', (c) => { text += c; });
            socket.on('close', () => { clearTimeout(timer); resolve(text); });
            socket.on('error', () => {});
        });
        assert.match(reply, /^HTTP\/1\.1 413/);
        assert.match(reply, /\r\nconnection: close\r\n/i);
    } finally {
        await gw.stop();
    }
});

test('body 超過上限且沒有 Content-Length（chunked）也會被擋', async () => {
    const gw = await startGateway();
    try {
        const big = JSON.stringify({ input: { topic: 'x'.repeat(20_000) } });
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(big));
                controller.close();
            },
        });
        const res = await fetch(`${gw.base}/v1/tasks/demo-json`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: ORIGIN },
            body: stream,
            duplex: 'half',
        });
        assert.equal(res.status, 413);
    } finally {
        await gw.stop();
    }
});

// 不關連線的話，伺服器會替對方把無限長的 body 讀到 requestTimeout
test('403／404／415 這類提早拒絕會關掉連線，不替對方讀完源源不絕的 body', async () => {
    const gw = await startGateway();
    try {
        for (const [urlPath, headers] of [
            ['/v1/tasks/demo-json', 'Origin: https://evil.example\r\nContent-Type: application/json\r\n'],
            ['/v1/tasks/nope', 'Origin: https://thc1006.github.io\r\nContent-Type: application/json\r\n'],
            ['/v1/tasks/demo-json', 'Origin: https://thc1006.github.io\r\nContent-Type: text/plain\r\n'],
        ]) {
            const socket = net.connect(gw.port, '127.0.0.1');
            socket.on('error', () => {});
            socket.write(`POST ${urlPath} HTTP/1.1\r\nHost: x\r\n${headers}Transfer-Encoding: chunked\r\n\r\n`);
            const chunk = `1000\r\n${'x'.repeat(0x1000)}\r\n`;
            const pump = setInterval(() => { if (!socket.destroyed) socket.write(chunk); }, 1);
            const reply = await new Promise((resolve, reject) => {
                let text = '';
                const timer = setTimeout(() => reject(new Error(`${urlPath}：2 秒內連線沒有被關掉`)), 2000);
                socket.on('data', (c) => { text += c; });
                socket.on('close', () => { clearTimeout(timer); resolve(text); });
            });
            clearInterval(pump);
            assert.match(reply, /^HTTP\/1\.1 4\d\d/, urlPath);
            assert.match(reply, /\r\nconnection: close\r\n/i, urlPath);
        }
    } finally {
        await gw.stop();
    }
});

test('上傳 body 到一半斷線：記成 499，不是 UNHANDLED 的錯誤', async () => {
    const gw = await startGateway();
    try {
        const socket = net.connect(gw.port, '127.0.0.1');
        socket.on('error', () => {});
        socket.write(
            'POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: https://thc1006.github.io\r\n' +
            'Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"input":',
        );
        await sleep(50);
        socket.destroy();
        await waitFor(() => gw.logs.some((l) => l.tag === 'REJECT' && l.fields.status === 499));
        assert.equal(gw.logs.find((l) => l.tag === 'REJECT').fields.code, 'client_closed');
        assert.ok(!gw.logs.some((l) => l.tag === 'UNHANDLED'));
        assert.equal(gw.calls.length, 0);
    } finally {
        await gw.stop();
    }
});

test('沒有 key：503 not_ready，不會呼叫模型', async () => {
    const gw = await startGateway({ llm: { apiKey: '' } });
    try {
        const res = await post(gw.base, 'demo-json', { topic: 'x' });
        assert.equal(res.status, 503);
        assert.equal((await res.json()).error.code, 'not_ready');
        assert.equal(res.headers.get('retry-after'), '30');
        assert.equal(gw.calls.length, 0);
    } finally {
        await gw.stop();
    }
});

test('JSON 任務：accepted → progress → done；SSE 標頭正確；任務指令在 system、學生資料在 user', async () => {
    const gw = await startGateway({
        generate: async (request, hooks) => {
            hooks.onProgress({ phase: 'thinking', round: 1, thinkingTokens: 1, writingTokens: 0 });
            hooks.onProgress({ phase: 'writing', round: 1, thinkingTokens: 1, writingTokens: 1 });
            return { content: '{"answer":"好"}', rounds: 1, continuations: [], usage: { promptTokens: 5, completionTokens: 6, reasoningTokens: 3 } };
        },
    });
    try {
        const res = await post(gw.base, 'demo-json', { topic: '  能源 ' });
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /^text\/event-stream/);
        assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(res.headers.get('x-accel-buffering'), 'no');
        assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(res.headers.get('content-encoding'), null, 'SSE 不能壓縮');
        const requestId = res.headers.get('x-request-id');
        const events = await readEvents(res);
        assert.deepEqual(events.map((e) => e.event), ['accepted', 'progress', 'progress', 'done']);
        assert.deepEqual(events[0].data, { requestId, task: 'demo-json' });
        assert.equal(events[1].data.phase, 'thinking');
        assert.equal(events[2].data.phase, 'writing');
        assert.deepEqual(events[3].data.result, { answer: '好' });
        assert.equal(events[3].data.rounds, 1);
        assert.deepEqual(events[3].data.usage, { promptTokens: 5, completionTokens: 6, reasoningTokens: 3 });

        const { request, hooks } = gw.calls[0];
        assert.equal(request.messages[0].role, 'system');
        assert.match(request.messages[0].content, /【任務】\n依主題回答。/);
        assert.match(request.messages[1].content, /^<資料-[0-9a-f]{12} 欄位="主題">\n能源\n<\/資料-[0-9a-f]{12}>$/);
        assert.equal(request.responseFormat.json_schema.name, 'demo_json');
        assert.equal(hooks.onContent, undefined, 'JSON 任務不逐段送正文');
    } finally {
        await gw.stop();
    }
});

test('文字任務：delta 只供即時顯示，done.result 是去掉頭尾空白的定稿；帶上任務的 temperature', async () => {
    const gw = await startGateway({
        generate: async (request, hooks) => {
            for (const piece of ['## 建議', '\n\n', '多問問題。', '\n']) hooks.onContent(piece);
            return { content: '## 建議\n\n多問問題。\n', rounds: 1, continuations: [], usage: { promptTokens: 1, completionTokens: 3, reasoningTokens: 0 } };
        },
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼開始？' }));
        const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
        const done = events.find((e) => e.event === 'done');
        assert.equal(text, '## 建議\n\n多問問題。\n');
        assert.equal(done.data.result, '## 建議\n\n多問問題。');
        assert.equal(gw.calls[0].request.temperature, 0.5);
        assert.equal(gw.calls[0].request.responseFormat, undefined);
    } finally {
        await gw.stop();
    }
});

test('文字任務：簡體字在片段與結果裡都轉成台灣繁體；切在兩段之間的字（拮据、emoji）也一致', async () => {
    // 第三段切在 emoji 的兩個 UTF-16 單位中間
    const pieces = ['先做数', '据收集，经济拮', '据也没问题 \u{1F600}'.slice(0, 7), '据也没问题 \u{1F600}'.slice(7), '。'];
    const raw = pieces.join('');
    const gw = await startGateway({
        generate: async (request, hooks) => {
            for (const piece of pieces) hooks.onContent(piece);
            return { content: raw, rounds: 1, continuations: [], usage: { promptTokens: 1, completionTokens: 3, reasoningTokens: 0 } };
        },
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼開始？' }));
        const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
        const done = events.find((e) => e.event === 'done');
        assert.equal(text, '先做數據收集，經濟拮据也沒問題 \u{1F600}。');
        assert.equal(done.data.result, text);
    } finally {
        await gw.stop();
    }
});

test('進度事件會節流：同一階段的大量更新最多每 500ms 一次，但階段改變立刻送', async () => {
    const gw = await startGateway({
        generate: async (request, hooks) => {
            for (let i = 1; i <= 200; i++) hooks.onProgress({ phase: 'thinking', round: 1, thinkingTokens: i, writingTokens: 0 });
            hooks.onProgress({ phase: 'writing', round: 1, thinkingTokens: 200, writingTokens: 1 });
            return OK_RESULT;
        },
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }));
        const progress = events.filter((e) => e.event === 'progress');
        assert.ok(progress.length <= 3, `進度事件太多：${progress.length}`);
        assert.equal(progress[0].data.thinkingTokens, 1);
        assert.equal(progress.at(-1).data.phase, 'writing');
    } finally {
        await gw.stop();
    }
});

test('進度節流：被壓住的最後一筆更新，會在 500ms 後由計時器補送（不會一直停在舊數字）', async () => {
    const gw = await startGateway({
        generate: async (request, hooks) => {
            hooks.onProgress({ phase: 'thinking', round: 1, thinkingTokens: 1, writingTokens: 0 });
            await sleep(50);
            hooks.onProgress({ phase: 'thinking', round: 1, thinkingTokens: 2, writingTokens: 0 });
            await sleep(800);
            return OK_RESULT;
        },
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }));
        const tokens = events.filter((e) => e.event === 'progress').map((e) => e.data.thinkingTokens);
        assert.deepEqual(tokens, [1, 2]);
    } finally {
        await gw.stop();
    }
});

test('模型輸出不符格式：error 事件 format；log 的細節不含模型寫的內容', async () => {
    const gw = await startGateway({
        generate: async () => ({ ...OK_RESULT, content: '{"answer": 我的秘密病史}' }),
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }));
        const last = events.at(-1);
        assert.equal(last.event, 'error');
        assert.equal(last.data.code, 'format');
        assert.equal(last.data.retryable, true);
        assert.ok(!events.some((e) => e.event === 'done'));
        const taskErr = gw.logs.find((l) => l.tag === 'TASK-ERR');
        assert.equal(taskErr.fields.code, 'format');
        assert.ok(taskErr.fields.detail);
        assert.doesNotMatch(JSON.stringify(gw.logs), /秘密病史/);
    } finally {
        await gw.stop();
    }
});

test('上游錯誤：訊息只說「暫時無法使用」；UPSTREAM-ERR 只記允許的欄位，上游的原文（detail）不進 log', async () => {
    const gw = await startGateway({
        generate: async () => {
            throw new UpstreamError('auth', 'LLM 服務回應 HTTP 401', {
                status: 401, detail: 'key sk-*** not allowed from 1.2.3.4', upstreamType: 'auth_error', upstreamId: 'req-up-1',
            });
        },
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }));
        const error = events.at(-1);
        assert.equal(error.event, 'error');
        assert.equal(error.data.code, 'unavailable');
        assert.equal(error.data.retryable, false);
        assert.doesNotMatch(JSON.stringify(error.data), /401|1\.2\.3\.4|sk-|auth_error|req-up-1/);
        const { id, ...fields } = gw.logs.find((l) => l.tag === 'UPSTREAM-ERR').fields;
        assert.match(id, /^[0-9a-f-]{36}$/);
        assert.deepEqual(Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)), {
            code: 'auth', status: 401, reason: 'LLM 服務回應 HTTP 401', upstreamType: 'auth_error', upstreamId: 'req-up-1',
        });
        assert.doesNotMatch(JSON.stringify(gw.logs), /not allowed|1\.2\.3\.4|sk-/);
    } finally {
        await gw.stop();
    }
});

// 上游的錯誤內容可能照抄收到的使用者訊息，例如回報哪一則訊息驗證失敗
const LEAK = '祕密標記K7Q2';
const lastUser = (req) => req.body.messages.filter((m) => m.role === 'user').at(-1).content;
const UPSTREAM_LOG_KEYS = [
    'id', 'code', 'status', 'reason', 'upstreamId', 'upstreamType', 'upstreamCode', 'upstreamParam',
    'mediaType', 'bodyLength', 'bodyStart', 'retryAfter', 'contextLimit', 'inputTokens', 'inputAtLeast',
];

/** createLogger 寫出的一行「時間 級別 標籤 key=value …」裡的欄位，值是解開引號之後的字串 */
function logFields(line) {
    return Object.fromEntries([...line.matchAll(/ (\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)].map(([, k, v]) => [k, v.startsWith('"') ? JSON.parse(v) : v]));
}

test('上游的錯誤照抄了學生的輸入（HTTP 400 的 JSON、200 串流中的 error 事件）：log 與回給瀏覽器的錯誤都不含輸入，UPSTREAM-ERR 只記允許的欄位', async () => {
    const echo = (req) => ({ code: 400, type: 'BadRequestError', message: `Validation failed for supplied user message: ${lastUser(req)}`, input: lastUser(req) });
    const cases = [
        ['HTTP 400', (req) => ({ status: 400, headers: { 'x-request-id': 'req-up-400' }, body: { error: echo(req) } }), 'req-up-400'],
        ['串流中的 error', (req) => ({ headers: { 'x-request-id': 'req-up-sse' }, errorChunk: echo(req) }), 'req-up-sse'],
    ];
    for (const [label, step, upstreamId] of cases) {
        const gw = await startRealGateway(step);
        try {
            const events = await readEvents(await post(gw.base, 'demo-md', { question: `我的${LEAK}與病史` }));
            assert.ok(gw.upstream.requests[0].raw.includes(LEAK), `${label}：上游收到的訊息裡有標記`);
            const last = events.at(-1);
            assert.equal(last.event, 'error', label);
            assert.equal(last.data.code, 'unavailable', label);
            assert.doesNotMatch(JSON.stringify(events), new RegExp(LEAK), label);
            assert.doesNotMatch(gw.lines.join('\n'), new RegExp(`${LEAK}|病史|Validation failed`), label);
            const fields = logFields(gw.lines.find((l) => / UPSTREAM-ERR /.test(l)));
            assert.deepEqual(Object.keys(fields).filter((k) => !UPSTREAM_LOG_KEYS.includes(k)), [], label);
            assert.deepEqual([fields.status, fields.upstreamId, fields.upstreamType, fields.upstreamCode], ['400', upstreamId, 'BadRequestError', '400'], label);
        } finally {
            await gw.stop();
        }
    }
});

test('上游回 200 卻不是串流、內容照抄學生的輸入：UPSTREAM-ERR 只記 media type、長度與開頭字元的類別', async () => {
    const gw = await startRealGateway((req) => ({ contentType: 'text/html; charset=utf-8', rawChunks: [`<p>${lastUser(req)}</p>`] }));
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: `我的${LEAK}` }));
        assert.equal(events.at(-1).data.code, 'unavailable');
        assert.doesNotMatch(gw.lines.join('\n'), new RegExp(LEAK));
        const fields = logFields(gw.lines.find((l) => / UPSTREAM-ERR /.test(l)));
        assert.deepEqual(Object.keys(fields).filter((k) => !UPSTREAM_LOG_KEYS.includes(k)), []);
        assert.deepEqual([fields.code, fields.mediaType, fields.bodyStart], ['protocol', 'text/html', 'symbol']);
        assert.ok(Number(fields.bodyLength) > LEAK.length);
    } finally {
        await gw.stop();
    }
});

test('上游的 finish_reason 不是固定形狀的代號：當成 unknown，TASK-ERR 與回給瀏覽器的錯誤都不含原文', async () => {
    const gw = await startRealGateway((req) => ({ content: ['部分'], finish: `stop ${lastUser(req)}` }));
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: `我的${LEAK}` }));
        assert.equal(events.at(-1).data.code, 'unavailable');
        assert.doesNotMatch(JSON.stringify(events), new RegExp(LEAK));
        assert.doesNotMatch(gw.lines.join('\n'), new RegExp(LEAK));
        assert.equal(logFields(gw.lines.find((l) => / TASK-ERR /.test(l))).detail, '模型以 unknown 結束');
    } finally {
        await gw.stop();
    }
});

test('程式錯誤：TASK-ERR 只記錯誤的種類、Node 的錯誤代碼與呼叫位置，不記訊息（V8 的訊息可能夾帶字串的值）', async () => {
    const withCode = Object.assign(new Error(`write after end: ${LEAK}`), { code: 'ERR_STREAM_WRITE_AFTER_END' });
    // 訊息裡照抄的字串值有一行看起來像堆疊
    const fakeFrame = new TypeError(`Cannot create property 'x' on string '第一行\n    at ${LEAK} (x.js:1:1)'`);
    const errors = [new TypeError(`Cannot create property 'x' on string '${LEAK}'`), withCode, fakeFrame];
    const gw = await startGateway({ generate: async (request, hooks, n) => { throw errors[n - 1]; } });
    try {
        for (const expected of [/^TypeError at /, /^Error\(ERR_STREAM_WRITE_AFTER_END\) at /, /^TypeError at /]) {
            const last = (await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }))).at(-1);
            assert.equal(last.data.code, 'internal');
            const detail = gw.logs.filter((l) => l.tag === 'TASK-ERR').at(-1).fields.detail;
            assert.match(detail, expected);
            assert.match(detail, /server\.test\.mjs:\d+:\d+/);
        }
        assert.doesNotMatch(JSON.stringify(gw.logs), new RegExp(`${LEAK}|Cannot create|write after end`));
    } finally {
        await gw.stop();
    }
});

test('各種錯誤對應到的代號、可否重試與建議等待時間', async () => {
    const weird = Object.create(null);
    // 最後一欄是丟出錯誤之前上游有沒有送來過思考：逾時要在第一個 token 之後才是 timeout
    const cases = [
        ['demo-json', new UpstreamError('busy', '429', { status: 429, retryable: true, retryAfter: 7 }), 'busy', true, 7],
        ['demo-json', new UpstreamError('busy', '429', { status: 429, retryable: true }), 'busy', true, 30],
        // 上游說 Retry-After: 0 也不能叫前端立刻重打
        ['demo-json', new UpstreamError('busy', '429', { status: 429, retryable: true, retryAfter: 0 }), 'busy', true, 1],
        ['demo-json', new GenerationError('incomplete', '用完輪數'), 'incomplete', false, undefined],
        ['demo-json', new GenerationError('timeout', '超時'), 'timeout', true, undefined, true],
        ['demo-json', new GenerationError('timeout', '超時'), 'busy', true, 30, false],
        // 上游要求等待的時間比剩下的時限長、沒有重試：不論收到過 token 沒有，都照忙線轉告上游要求的秒數
        ['demo-json', new GenerationError('timeout', '重試要等', { retryAfter: 3600 }), 'busy', true, 3600, true],
        ['demo-json', new GenerationError('timeout', '重試要等', { retryAfter: 0 }), 'busy', true, 1, false],
        ['demo-json', new GenerationError('busy', '上游要求等 121 秒', { retryAfter: 121 }), 'busy', true, 121, true],
        ['demo-json', new GenerationError('empty', '沒有正文'), 'empty', true, undefined],
        ['demo-json', new GenerationError('stopped', 'content_filter'), 'unavailable', true, undefined],
        ['demo-json', new UpstreamError('timeout', '閒置', { retryable: true }), 'timeout', true, undefined, true],
        ['demo-json', new UpstreamError('timeout', '閒置', { retryable: true }), 'busy', true, 30, false],
        ['demo-json', new Error('程式錯誤'), 'internal', true, undefined],
        // String() 會丟例外的怪值也要能回報，不能讓請求卡住
        ['demo-json', weird, 'internal', true, undefined],
    ];
    for (const [task, err, code, retryable, retryAfter, thought = false] of cases) {
        const gw = await startGateway({
            generate: async (request, hooks) => {
                if (thought) hooks.onProgress({ phase: 'thinking', round: 1, thinkingTokens: 1, writingTokens: 0 });
                throw err;
            },
        });
        try {
            const events = await readEvents(await post(gw.base, task, { topic: 'x' }));
            const last = events.at(-1);
            assert.equal(last.event, 'error', code);
            assert.equal(last.data.code, code);
            assert.equal(last.data.retryable, retryable, code);
            assert.equal(last.data.retryAfter, retryAfter, code);
            assert.ok(last.data.message, code);
        } finally {
            await gw.stop();
        }
    }
});

test('文字任務的正文只有空白：error 事件 empty（不是 format）', async () => {
    const gw = await startGateway({ generate: async () => ({ ...OK_RESULT, content: ' \n ' }) });
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: 'q' }));
        assert.equal(events.at(-1).data.code, 'empty');
    } finally {
        await gw.stop();
    }
});

// 串流的片段不檢查內容，照樣送出；交出前的檢查才判定沒有看得見的字。
test('文字任務的正文只有看不見的字元：片段照樣送出，最後是 error 事件 empty', async () => {
    const gw = await startGateway({
        generate: async (request, hooks) => {
            hooks.onContent('\u200B');
            return { ...OK_RESULT, content: '\u200B' };
        },
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: 'q' }));
        assert.deepEqual(events.filter((e) => e.event === 'delta').map((e) => e.data.text), ['\u200B']);
        assert.equal(events.at(-1).event, 'error');
        assert.equal(events.at(-1).data.code, 'empty');
    } finally {
        await gw.stop();
    }
});

test('失敗的任務：TASK log 仍記下輪數與已經用掉的 token', async () => {
    const err = new GenerationError('incomplete', '用完輪數', { rounds: 3, continuations: ['length', 'length'] });
    err.usage = { promptTokens: 900, completionTokens: 24_576, reasoningTokens: 8000 };
    const gw = await startGateway({ generate: async () => { throw err; } });
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }));
        const line = gw.logs.find((l) => l.tag === 'TASK');
        assert.equal(line.fields.outcome, 'incomplete');
        assert.equal(line.fields.rounds, 3);
        assert.equal(line.fields.cont, 'length,length');
        assert.equal(line.fields.completion, 24_576);
        assert.equal(line.fields.reasoning, 8000);
    } finally {
        await gw.stop();
    }
});

test('開始串流之前就出錯（不該發生）：回 JSON 500 並帶 CORS，不讓請求永遠等不到回應', async () => {
    const gw = await startGateway();
    try {
        gw.gateway.gate.tryEnter = () => { throw new Error('閘門壞了'); };
        const res = await post(gw.base, 'demo-json', { topic: 'x' });
        assert.equal(res.status, 500);
        assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
        const body = await res.json();
        assert.equal(body.error.code, 'internal');
        assert.equal(body.error.requestId, res.headers.get('x-request-id'));
        await waitFor(() => gw.logs.some((l) => l.tag === 'TASK'));
        assert.equal(gw.logs.find((l) => l.tag === 'TASK').fields.outcome, 'internal');
        assert.equal(gw.gateway.limiter.clients.get('127.0.0.1').inflight, 0, '用戶端名額已歸還');
    } finally {
        await gw.stop();
    }
});

test('使用者中途離開：上游被取消、兩種名額都歸還、log 記 499', async () => {
    const hang = hangingGenerate();
    const gw = await startGateway({
        server: { concurrency: 1 },
        generate: (request, hooks, n) => (n > 1 ? { ...OK_RESULT, content: '{"answer":"第二個"}' } : hang.generate(request, hooks)),
    });
    try {
        const ctrl = new AbortController();
        const res = await post(gw.base, 'demo-json', { topic: 'x' }, { signal: ctrl.signal });
        await sseReader(res).until(accepted);
        await hang.started;
        ctrl.abort();
        await waitFor(() => gw.logs.some((l) => l.tag === 'TASK'));
        const taskLog = gw.logs.find((l) => l.tag === 'TASK');
        assert.equal(taskLog.fields.outcome, 'aborted');
        assert.equal(taskLog.fields.status, 499);
        assert.equal(gw.calls[0].hooks.signal.aborted, true);
        assert.equal(gw.gateway.limiter.clients.get('127.0.0.1').inflight, 0, '用戶端名額已歸還');
        // 全站名額已歸還：concurrency 1 的情況下第二個請求能馬上做完
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: 'y' }));
        assert.deepEqual(events.at(-1).data.result, { answer: '第二個' });
    } finally {
        await gw.stop();
    }
});

test('排隊中離開：讓出位置（後面的人名次往前）、不會呼叫模型', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1, maxQueue: 2 },
        generate: async (request, hooks, n) => {
            if (n === 1) await gate.promise;
            return OK_RESULT;
        },
    });
    try {
        const first = await post(gw.base, 'demo-json', { topic: 'a' });
        await sseReader(first).until(accepted);
        const ctrl = new AbortController();
        const second = await post(gw.base, 'demo-json', { topic: 'b' }, { signal: ctrl.signal });
        await sseReader(second).until(queued);
        const third = sseReader(await post(gw.base, 'demo-json', { topic: 'c' }));
        const before = await third.until(queued);
        assert.equal(before.find((e) => e.data.phase === 'queued').data.position, 2);
        ctrl.abort();
        const positions = (events) => events.filter((e) => e.data.phase === 'queued').map((e) => e.data.position);
        const after = await third.until((events) => positions(events).length >= 2);
        assert.deepEqual(positions(after), [2, 1]);
        gate.resolve();
        await waitFor(() => gw.logs.filter((l) => l.tag === 'TASK').length === 3);
        assert.equal(gw.calls.length, 2, '離開的那個沒有呼叫模型');
        assert.equal(gw.logs.filter((l) => l.tag === 'TASK' && l.fields.outcome === 'aborted').length, 1);
    } finally {
        gate.resolve();
        await gw.stop();
    }
});

test('排隊：名額滿時排隊並收到名次與後續的名次變動；排隊也滿就 503', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1, maxQueue: 2 },
        generate: async (request, hooks, n) => {
            if (n === 1) await gate.promise;
            return { ...OK_RESULT, content: `{"answer":"第${n}個"}` };
        },
    });
    try {
        const first = await post(gw.base, 'demo-json', { topic: 'a' });
        await sseReader(first).until(accepted);
        const second = await post(gw.base, 'demo-json', { topic: 'b' });
        const secondEvents = await sseReader(second).until(queued);
        assert.equal(secondEvents.find((e) => e.data.phase === 'queued').data.position, 1);
        const thirdRead = sseReader(await post(gw.base, 'demo-json', { topic: 'c' }));
        const thirdSoFar = await thirdRead.until(queued);
        assert.equal(thirdSoFar.find((e) => e.data.phase === 'queued').data.position, 2);

        const fourth = await post(gw.base, 'demo-json', { topic: 'd' });
        assert.equal(fourth.status, 503);
        assert.equal((await fourth.json()).error.code, 'busy');
        assert.equal(fourth.headers.get('retry-after'), '30');

        gate.resolve();
        const thirdEvents = await thirdRead.rest();
        const positions = thirdEvents.filter((e) => e.data.phase === 'queued').map((e) => e.data.position);
        assert.deepEqual(positions, [2, 1], '前一個做完後，名次從 2 變 1');
        assert.deepEqual(thirdEvents.at(-1).data.result, { answer: '第3個' });
    } finally {
        gate.resolve();
        await gw.stop();
    }
});

test('排隊太久：error 事件 busy', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1, maxQueue: 1, queueTimeoutMs: 100 },
        generate: async () => {
            await gate.promise;
            return OK_RESULT;
        },
    });
    try {
        const first = await post(gw.base, 'demo-json', { topic: 'a' });
        await sseReader(first).until(accepted);
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: 'b' }));
        assert.equal(events.at(-1).event, 'error');
        assert.equal(events.at(-1).data.code, 'busy');
        assert.equal(events.at(-1).data.retryAfter, 30);
    } finally {
        gate.resolve();
        await gw.stop();
    }
});

// 尖峰時整班學生依 Retry-After 重試：不能在負載退了之後，反而被自己的重試鎖住
test('排隊已滿回 503 的請求不計入限流次數', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1, maxQueue: 0, rateLimitMax: 2 },
        generate: async (request, hooks, n) => {
            if (n === 1) await gate.promise;
            return OK_RESULT;
        },
    });
    try {
        const first = await post(gw.base, 'demo-json', { topic: 'a' });
        await sseReader(first).until(accepted);
        for (let i = 0; i < 3; i++) {
            const busy = await post(gw.base, 'demo-json', { topic: 'b' });
            assert.equal(busy.status, 503);
            await busy.text();
        }
        gate.resolve();
        await waitFor(() => gw.logs.some((l) => l.tag === 'TASK' && l.fields.outcome === 'ok'));
        const after = await post(gw.base, 'demo-json', { topic: 'c' });
        assert.equal(after.status, 200, '只用了 1 次，不是 4 次');
        await after.text();
    } finally {
        gate.resolve();
        await gw.stop();
    }
});

test('同一來源超過次數：429 rate_limited 並附 Retry-After，被擋的不計次也不呼叫模型', async () => {
    const gw = await startGateway({ server: { rateLimitMax: 2 } });
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'a' }));
        await readEvents(await post(gw.base, 'demo-json', { topic: 'b' }));
        const res = await post(gw.base, 'demo-json', { topic: 'c' });
        assert.equal(res.status, 429);
        const body = await res.json();
        assert.equal(body.error.code, 'rate_limited');
        // 次數是依對外 IP 計的：只按了一次的學生也可能看到，訊息要說是整個網路
        assert.match(body.error.message, /同一個網路（例如學校）/);
        assert.ok(Number(res.headers.get('retry-after')) > 0);
        assert.equal(gw.calls.length, 2);
    } finally {
        await gw.stop();
    }
});

test('同一來源的佔用上限只在名額全滿時生效：GPU 有空就讓同一間教室的學生一起用', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 2, clientMaxInflight: 1 },
        generate: async () => {
            await gate.promise;
            return OK_RESULT;
        },
    });
    try {
        const first = await post(gw.base, 'demo-json', { topic: 'a' });
        await sseReader(first).until(accepted);
        // 名額還有一個：同一個 IP 的第二個請求照樣開始
        const second = await post(gw.base, 'demo-json', { topic: 'b' });
        assert.equal(second.status, 200);
        await sseReader(second).until(accepted);
        // 名額全滿：要排隊的第三個才被同一來源的上限擋下
        const third = await post(gw.base, 'demo-json', { topic: 'c' });
        assert.equal(third.status, 429);
        const body = await third.json();
        assert.equal(body.error.code, 'too_many_inflight');
        assert.match(body.error.message, /網路（例如學校）/);
    } finally {
        gate.resolve();
        await gw.stop();
    }
});

test('CLIENT_IP_HEADER：連線來自信任的代理時才採用，只看最右邊的值', async () => {
    const gw = await startGateway({ server: { rateLimitMax: 1, clientIpHeader: 'x-forwarded-for', trustedProxies: ['127.0.0.1/32'] } });
    try {
        const h = (xff) => ({ headers: { 'x-forwarded-for': xff } });
        await readEvents(await post(gw.base, 'demo-json', { topic: 'a' }, h('203.0.113.1')));
        // 同一個真實來源，左邊亂塞：仍被認成同一人
        assert.equal((await post(gw.base, 'demo-json', { topic: 'b' }, h('198.51.100.9, 203.0.113.1'))).status, 429);
        // 不同真實來源：各自計算
        const other = await post(gw.base, 'demo-json', { topic: 'c' }, h('203.0.113.2'));
        assert.equal(other.status, 200);
        await other.text();
        assert.ok(gw.gateway.limiter.clients.has('203.0.113.1'));
        assert.ok(!gw.gateway.limiter.clients.has('127.0.0.1'));
    } finally {
        await gw.stop();
    }
});

test('CLIENT_IP_HEADER：連線不是來自信任的代理時，自己填的標頭沒有用', async () => {
    const gw = await startGateway({ server: { rateLimitMax: 1, clientIpHeader: 'x-forwarded-for', trustedProxies: ['10.42.0.1/32'] } });
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'a' }, { headers: { 'x-forwarded-for': '203.0.113.1' } }));
        const spoofed = await post(gw.base, 'demo-json', { topic: 'b' }, { headers: { 'x-forwarded-for': '203.0.113.99' } });
        assert.equal(spoofed.status, 429, '換一個值也繞不過限流');
        assert.deepEqual([...gw.gateway.limiter.clients.keys()], ['127.0.0.1']);
    } finally {
        await gw.stop();
    }
});

test('CLIENT_IP_HEADER：值不是合法的 IP（或超長）時改看連線來源，不會各自成為一個桶', async () => {
    const gw = await startGateway({ server: { rateLimitMax: 1, clientIpHeader: 'x-forwarded-for', trustedProxies: ['127.0.0.1/32'] } });
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'a' }, { headers: { 'x-forwarded-for': 'garbage' } }));
        const long = await post(gw.base, 'demo-json', { topic: 'b' }, { headers: { 'x-forwarded-for': `1.2.3.4, ${'x'.repeat(5_000)}` } });
        assert.equal(long.status, 429);
        assert.deepEqual([...gw.gateway.limiter.clients.keys()], ['127.0.0.1']);
    } finally {
        await gw.stop();
    }
});

test('心跳：等待期間定期送 SSE 註解，代理才不會因閒置切斷', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { heartbeatMs: 30 },
        generate: async () => {
            await gate.promise;
            return OK_RESULT;
        },
    });
    try {
        const res = await post(gw.base, 'demo-json', { topic: 'a' });
        setTimeout(() => gate.resolve(), 200);
        const { comments } = parseSse(await res.text());
        assert.ok(comments >= 2, `心跳次數太少：${comments}`);
    } finally {
        gate.resolve();
        await gw.stop();
    }
});

test('關機：進行中的任務做完並收到 done；做完之後 close() 馬上結束，不必等滿寬限期', async () => {
    const gate = deferred();
    const gw = await startGateway({
        generate: async () => {
            await gate.promise;
            return { ...OK_RESULT, content: '{"answer":"做完了"}' };
        },
    });
    const reading = sseReader(await post(gw.base, 'demo-json', { topic: 'a' }));
    await reading.until(accepted);
    const started = Date.now();
    const closing = gw.gateway.close({ graceMs: 5_000 });
    assert.equal(gw.gateway.stats().draining, true);
    setTimeout(() => gate.resolve(), 50);
    const events = await reading.rest();
    assert.deepEqual(events.at(-1).data.result, { answer: '做完了' });
    await closing;
    assert.ok(Date.now() - started < 1_500, `close() 花了 ${Date.now() - started}ms`);
});

test('關機：排隊中的任務立刻收到可重試的錯誤（不會開始燒 GPU），進行中的照常做完', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1 },
        generate: async (request, hooks, n) => {
            if (n === 1) await gate.promise;
            return OK_RESULT;
        },
    });
    const firstRead = sseReader(await post(gw.base, 'demo-json', { topic: 'a' }));
    await firstRead.until(accepted);
    const secondRead = sseReader(await post(gw.base, 'demo-json', { topic: 'b' }));
    await secondRead.until(queued);
    const closing = gw.gateway.close({ graceMs: 5_000 });
    const secondEvents = await secondRead.rest();
    assert.deepEqual(secondEvents.at(-1), {
        event: 'error',
        data: { code: 'unavailable', message: 'AI 服務正在更新，請稍後再試一次。', retryable: true, retryAfter: 5 },
    });
    gate.resolve();
    assert.equal((await firstRead.rest()).at(-1).event, 'done');
    await closing;
    assert.equal(gw.calls.length, 1, '排隊的那個沒有呼叫模型');
    assert.ok(gw.logs.some((l) => l.tag === 'TASK' && l.fields.outcome === 'shutdown'));
});

test('關機：寬限期到了還沒做完的任務，送出可重試的 error 事件再斷線（不是截斷的串流）', async () => {
    const hang = hangingGenerate();
    const gw = await startGateway({ generate: hang.generate });
    const reading = sseReader(await post(gw.base, 'demo-json', { topic: 'a' }));
    await reading.until(accepted);
    await hang.started;
    const started = Date.now();
    await gw.gateway.close({ graceMs: 100 });
    assert.ok(Date.now() - started < 2_000);
    const events = await reading.rest();
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.code, 'unavailable');
    assert.equal(events.at(-1).data.retryAfter, 5);
    const line = gw.logs.find((l) => l.tag === 'TASK');
    assert.equal(line.fields.outcome, 'shutdown');
});

test('關機：閒置的 keep-alive 連線馬上關掉，close() 不用等它逾時', async () => {
    const gw = await startGateway();
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
        const res = await rawRequest(gw.port, { method: 'GET', path: '/healthz', agent });
        assert.equal(res.status, 200);
        const started = Date.now();
        await gw.gateway.close({ graceMs: 5_000 });
        assert.ok(Date.now() - started < 1_000, `close() 花了 ${Date.now() - started}ms`);
    } finally {
        agent.destroy();
    }
});

// 換版時代理的連線池會優先重用剛還回來的連線；SSE 結束後連線若還留著，下一個學生的請求就會
// 落到這個要關的 pod 而拿到 503（2026-10-22 實測：keep-alive 會再留約 6 秒）
test('關機：進行中的 SSE 一結束就關掉那條連線，代理不會再拿它送新的請求', async () => {
    const gateA = deferred();
    const gateB = deferred();
    const gw = await startGateway({
        generate: async (request) => {
            await (request.messages[1].content.includes('第一個') ? gateA.promise : gateB.promise);
            return OK_RESULT;
        },
    });
    // 另一個任務撐住寬限期：close() 還不會走到最後的 closeAllConnections，關掉連線的只能是這裡要測的行為
    const a = await rawSocket(gw.port);
    const b = await rawSocket(gw.port);
    a.write(rawPost('demo-json', { topic: '第一個' }));
    b.write(rawPost('demo-json', { topic: '第二個' }));
    await waitFor(() => gw.calls.length === 2);
    const closing = gw.gateway.close({ graceMs: 5_000 });
    gateA.resolve();
    // keep-alive 的閒置逾時是 5 秒：2 秒內沒關，就是沒有主動關
    assert.equal(await within(a.whenClosed, 2_000), true, 'SSE 結束後連線沒有被關掉');
    assert.match(a.text, /event: done/);
    assert.equal(await within(b.whenClosed, 50), false, '還在串流的另一條連線不受影響');
    gateB.resolve();
    await closing;
    // 用戶端要等連線關閉，才保證收到的資料都處理完了
    await b.whenClosed;
    assert.match(b.text, /event: done/);
});

// 關機中唯一收得到請求的情況：送出時那條連線還在串流（閒置的連線在開始關機時就關掉了）
test('關機中收到的請求一律回 connection: close：readyz 回 draining，健康檢查與預檢照常，新任務回 503（Retry-After 5）', async () => {
    const gate = deferred();
    const gw = await startGateway({ generate: async () => { await gate.promise; return OK_RESULT; } });
    const followUps = {
        readyz: 'GET /readyz HTTP/1.1\r\nHost: x\r\n\r\n',
        healthz: 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n',
        preflight: `OPTIONS /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nAccess-Control-Request-Method: POST\r\n\r\n`,
        task: rawPost('demo-json', { topic: 'late' }),
    };
    const sockets = {};
    for (const name of Object.keys(followUps)) {
        sockets[name] = await rawSocket(gw.port);
        sockets[name].write(rawPost('demo-json', { topic: name }));
    }
    await waitFor(() => gw.calls.length === 4);
    const closing = gw.gateway.close({ graceMs: 5_000 });
    let handled = 0;
    gw.gateway.server.on('request', () => { handled++; });
    for (const [name, text] of Object.entries(followUps)) sockets[name].write(text);
    await waitFor(() => handled === 4);
    gate.resolve();
    await Promise.all(Object.values(sockets).map((socket) => socket.whenClosed));
    // 第一個回應是 chunked 的 SSE，以 0\r\n\r\n 結尾；後面接的是關機中那個請求的回應
    const second = (name) => sockets[name].text.split('\r\n0\r\n\r\n')[1] || '';
    for (const name of Object.keys(followUps)) assert.match(second(name), /\r\nconnection: close\r\n/i, name);
    assert.match(second('readyz'), /^HTTP\/1\.1 503/);
    assert.match(second('readyz'), /\{"status":"draining"\}$/);
    assert.match(second('healthz'), /^HTTP\/1\.1 200/);
    assert.match(second('preflight'), /^HTTP\/1\.1 204/);
    assert.match(second('task'), /^HTTP\/1\.1 503/);
    assert.match(second('task'), /\r\nretry-after: 5\r\n/i);
    // 回應是 chunked：跳過標頭與 chunk 的長度那一行
    const body = JSON.parse(second('task').slice(second('task').indexOf('{')));
    assert.equal(body.error.code, 'not_ready');
    assert.equal(body.error.message, 'AI 服務正在更新，請稍後再試一次。');
    assert.equal(gw.calls.length, 4, '關機中的新任務沒有呼叫模型');
    await closing;
});

// 關機中的請求不必替它收 body：源源不絕的 body 也立刻拿到 503，而不是等到 body 的期限
test('關機中的任務請求在讀 body 之前就回 503，不收它的 body', async () => {
    const gate = deferred();
    const gw = await startGateway({ server: { bodyTimeoutMs: 1_000 }, generate: async () => { await gate.promise; return OK_RESULT; } });
    const socket = await rawSocket(gw.port);
    socket.write(rawPost('demo-json', { topic: 'a' }));
    await waitFor(() => gw.calls.length === 1);
    const closing = gw.gateway.close({ graceMs: 5_000 });
    const requested = new Promise((resolve) => gw.gateway.server.once('request', resolve));
    socket.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`);
    await requested;
    const pump = setInterval(() => { if (!socket.destroyed) socket.write(`10\r\n${'x'.repeat(16)}\r\n`); }, 5);
    try {
        gate.resolve();
        assert.equal(await within(socket.whenClosed, 2_000), true);
        assert.match(socket.text.split('\r\n0\r\n\r\n')[1] || '', /^HTTP\/1\.1 503/);
    } finally {
        clearInterval(pump);
    }
    await closing;
});

test('關機時沒有進行中的任務：還在上傳 body 的請求限時等它送完，拿到 503（而不是被直接切斷）', async () => {
    const gw = await startGateway();
    const socket = await rawSocket(gw.port);
    const body = JSON.stringify({ input: { topic: 'x' } });
    const requested = new Promise((resolve) => gw.gateway.server.once('request', resolve));
    socket.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\n\r\n${body.slice(0, 5)}`);
    await requested;
    const closing = gw.gateway.close({ graceMs: 0, requestWaitMs: 5_000 });
    socket.write(body.slice(5));
    await socket.whenClosed;
    assert.match(socket.text, /^HTTP\/1\.1 503/);
    assert.match(socket.text, /\r\nconnection: close\r\n/i);
    assert.match(socket.text, /"code":"not_ready"/);
    assert.equal(gw.calls.length, 0);
    await closing;
});

test('關機時一直沒送完 body 的請求最多等 requestWaitMs，之後照樣關掉連線', async () => {
    const gw = await startGateway();
    const socket = await rawSocket(gw.port);
    const requested = new Promise((resolve) => gw.gateway.server.once('request', resolve));
    socket.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\n` +
        'Content-Length: 100\r\n\r\n{"input":');
    await requested;
    const started = Date.now();
    await gw.gateway.close({ graceMs: 0, requestWaitMs: 100 });
    assert.ok(Date.now() - started < 1_000, `close() 花了 ${Date.now() - started}ms`);
    assert.equal(await within(socket.whenClosed, 1_000), true);
});

test('任務結束後不留下計時器（心跳）、也不留在 active 裡', async () => {
    const gw = await startGateway({ server: { heartbeatMs: 1_000 } });
    try {
        const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
        await readEvents(await post(gw.base, 'demo-json', { topic: 'warmup' }));
        await sleep(20);
        const baseline = timers();
        for (let i = 0; i < 5; i++) await readEvents(await post(gw.base, 'demo-json', { topic: `t${i}` }));
        await sleep(20);
        assert.ok(timers() - baseline < 3, `多了 ${timers() - baseline} 個計時器`);
        await waitFor(() => gw.gateway.stats().active === 0);
    } finally {
        await gw.stop();
    }
});

// 排隊者剛被放行、但它的後續還沒跑到時就開始關機：不能再去呼叫模型
test('關機：排隊中的任務剛好在輪到的那一刻遇上關機，不呼叫模型，收到可重試的錯誤', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1 },
        generate: async (request, hooks, n) => {
            if (n === 1) await gate.promise;
            return OK_RESULT;
        },
    });
    const originalTryEnter = gw.gateway.gate.tryEnter.bind(gw.gateway.gate);
    let closing;
    gw.gateway.gate.tryEnter = (options) => {
        const entry = originalTryEnter(options);
        if (!entry?.queued) return entry;
        // 放行的同一個 microtask 裡開始關機：close() 同步中止仍標記為排隊中的請求
        return { ...entry, ready: entry.ready.then((release) => { closing = gw.gateway.close({ graceMs: 5_000 }); return release; }) };
    };
    const first = sseReader(await post(gw.base, 'demo-json', { topic: 'a' }));
    await first.until(accepted);
    const second = sseReader(await post(gw.base, 'demo-json', { topic: 'b' }));
    await second.until(queued);
    gate.resolve();
    const events = await second.rest();
    assert.equal(events.at(-1).event, 'error');
    assert.equal(events.at(-1).data.code, 'unavailable');
    assert.equal(gw.calls.length, 1, '第二個沒有呼叫模型');
    await first.rest();
    await closing;
});

test('log：TASK 一行記下結果與用量，不含使用者輸入的內容與 IP', async () => {
    const gw = await startGateway();
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: '我的秘密主題' }));
        const line = gw.logs.find((l) => l.tag === 'TASK');
        assert.equal(line.fields.outcome, 'ok');
        assert.equal(line.fields.task, 'demo-json');
        assert.equal(line.fields.rounds, 1);
        assert.match(line.fields.client, /^[0-9a-f]{10}$/);
        assert.doesNotMatch(JSON.stringify(gw.logs), /我的秘密主題|127\.0\.0\.1/);
    } finally {
        await gw.stop();
    }
});

test('createLogger：一行一筆；值裡的換行、行段分隔符、NEL、雙向覆寫一律跳脫', () => {
    const lines = [];
    const log = createLogger('info', (line) => lines.push(line));
    log('warn', 'TEST', { plain: 'abc-1.2', detail: 'a\nb\u2028c\u2029d\u0085e\u202Ef\u200Bg', skip: undefined, empty: '' });
    log('debug', 'HIDDEN', {});
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.match(line, / warn TEST plain=abc-1\.2 detail="a\\nb\\u2028c\\u2029d\\u0085e\\u202ef\\u200bg"$/);
    assert.doesNotMatch(line, /[\n\u0085\u2028\u2029\u202E\u200B]/);
    assert.doesNotMatch(line, /skip=|empty=/);
});

// 透過 symlink 啟動（例如 /usr/local/bin/ai-gateway → …/server.mjs）時 argv[1] 是連結本身
test('直接執行：透過 symlink 也會啟動；SIGTERM 時記 SHUTDOWN 並以 0 結束', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-gateway-'));
    const link = path.join(dir, 'gateway.mjs');
    symlinkSync(SERVER_FILE, link);
    // PORT=0：由系統挑一個空的埠（隨機挑的埠可能剛好被占用），START log 會印出實際的埠。
    // 上游指到本機沒有服務的埠：沒設的話預設是正式的 WinLab，這個測試不該有機會連出去
    const child = spawn(process.execPath, [link], {
        env: {
            PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', LLM_API_KEY: 'sk-test-only', LLM_UPSTREAM: 'http://127.0.0.1:9',
            LOG_LEVEL: 'info', SHUTDOWN_GRACE_MS: '1000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
        let out = '';
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        await waitFor(() => / START /.test(out), 5_000);
        assert.match(out, /clientIp=socket/);
        assert.match(out, /key=loaded/);
        assert.doesNotMatch(out, /problems=/, '上游設定合法');
        assert.match(out, / warn CONFIG problem=shutdown-grace-below-task-timeout grace=1000 taskTimeout=\d+/, '寬限期比任務時限短要警告');
        const port = Number(/ port=(\d+)/.exec(out)?.[1]);
        assert.ok(port > 0, 'START log 印出系統挑的埠');
        assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
        const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
        child.kill('SIGTERM');
        assert.equal(await exited, 0);
        assert.match(out, / SHUTDOWN /);
    } finally {
        child.kill('SIGKILL');
        rmSync(dir, { recursive: true, force: true });
    }
});

// 真的跑一個程序：任務清單在複製出來的 src 裡另外寫，上游是本機的假上游（一直不回應）
test('直接執行：第一次 SIGTERM 讓進行中的任務送出可重試的錯誤後以 0 結束；第二次 SIGTERM 不等寬限期，以 1 結束', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-gateway-'));
    const fake = await startFakeUpstream(() => ({ hangBeforeHeaders: true }));
    const children = [];
    try {
        cpSync(path.dirname(SERVER_FILE), path.join(dir, 'src'), { recursive: true });
        const task = { id: 'demo-md', input: { question: { label: '問題', maxLength: 100 } }, output: { type: 'markdown' }, instructions: '回答問題。' };
        writeFileSync(path.join(dir, 'src', 'task-catalog.mjs'), `export const TASK_DEFINITIONS = [${JSON.stringify(task)}];\n`);
        const launch = async (graceMs) => {
            const child = spawn(process.execPath, [path.join(dir, 'src', 'server.mjs')], {
                env: {
                    PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', LLM_API_KEY: 'sk-test-only',
                    LLM_UPSTREAM: fake.origin, SHUTDOWN_GRACE_MS: String(graceMs), LOG_LEVEL: 'info',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            children.push(child);
            const run = { child, out: '', exited: new Promise((resolve) => child.on('exit', resolve)) };
            child.stdout.on('data', (c) => { run.out += c; });
            child.stderr.on('data', (c) => { run.out += c; });
            await waitFor(() => / START /.test(run.out), 5_000);
            const port = Number(/ port=(\d+)/.exec(run.out)[1]);
            const upstreamCalls = fake.requests.length;
            const res = await fetch(`http://127.0.0.1:${port}/v1/tasks/demo-md`, {
                method: 'POST',
                headers: { origin: ORIGIN, 'content-type': 'application/json' },
                body: JSON.stringify({ input: { question: '問' } }),
            });
            run.reading = sseReader(res);
            await run.reading.until(accepted);
            await waitFor(() => fake.requests.length > upstreamCalls, 5_000);
            return run;
        };

        const graceful = await launch(200);
        graceful.child.kill('SIGTERM');
        assert.deepEqual((await graceful.reading.rest()).at(-1), {
            event: 'error',
            data: { code: 'unavailable', message: 'AI 服務正在更新，請稍後再試一次。', retryable: true, retryAfter: 5 },
        });
        assert.equal(await graceful.exited, 0);
        assert.match(graceful.out, / SHUTDOWN /);

        const forced = await launch(60_000);
        forced.child.kill('SIGTERM');
        await waitFor(() => / SHUTDOWN /.test(forced.out), 5_000);
        forced.child.kill('SIGTERM');
        assert.equal(await forced.exited, 1);
        assert.match(forced.out, / FORCED-EXIT /);
        await forced.reading.rest().catch(() => {});
    } finally {
        for (const child of children) child.kill('SIGKILL');
        await fake.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

// 驗證失敗的請求不計入任務次數；收 body、解析、驗證都要花主執行緒的時間
test('已經被限流的來源：讀 body 之前就回 429 並關掉連線，不替它收 body', async () => {
    const gw = await startGateway({ server: { rateLimitMax: 1 } });
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'a' }));
        const reply = await floodChunked(gw.port, '/v1/tasks/demo-json', `Origin: ${ORIGIN}\r\nContent-Type: application/json\r\n`);
        assert.match(reply, /^HTTP\/1\.1 429/);
        assert.match(reply, /\r\nconnection: close\r\n/i);
        assert.match(reply, /"code":"rate_limited"/);
        assert.equal(gw.calls.length, 1);
    } finally {
        await gw.stop();
    }
});

test('所有到達的任務請求都計入每分鐘上限（驗證失敗的也算），超過就在讀 body 之前回 429；窗口過了恢復', async () => {
    let clock = 0;
    const gw = await startGateway({ server: { requestLimitPerMinute: 3 }, now: () => clock });
    try {
        for (let i = 0; i < 3; i++) {
            const res = await post(gw.base, 'demo-json', { topic: '' });
            assert.equal(res.status, 400);
            await res.text();
        }
        const res = await post(gw.base, 'demo-json', { topic: 'ok' });
        assert.equal(res.status, 429);
        const body = await res.json();
        assert.equal(body.error.code, 'rate_limited');
        assert.ok(Number(res.headers.get('retry-after')) >= 1 && Number(res.headers.get('retry-after')) <= 60);
        assert.equal(gw.gateway.limiter.clients.size, 0, '驗證失敗與被擋下的請求都不計入任務次數');
        // 超量時連 body 都不收
        const reply = await floodChunked(gw.port, '/v1/tasks/demo-json', `Origin: ${ORIGIN}\r\nContent-Type: application/json\r\n`);
        assert.match(reply, /^HTTP\/1\.1 429/);
        clock += 60_000;
        const later = await post(gw.base, 'demo-json', { topic: 'ok' });
        assert.equal(later.status, 200);
        await later.text();
        assert.equal(gw.calls.length, 1);
    } finally {
        await gw.stop();
    }
});

test('body 的頂層只能有 input：多出來的鍵、陣列、其他型別都是 400', async () => {
    const gw = await startGateway();
    try {
        for (const body of ['{"input":{"topic":"x"},"extra":1}', '[{"input":{"topic":"x"}}]', '{"inputs":{"topic":"x"}}', '"x"', 'null']) {
            const res = await post(gw.base, 'demo-json', null, { body });
            assert.equal(res.status, 400, body);
            const json = await res.json();
            assert.equal(json.error.code, 'invalid_input', body);
            assert.equal(json.error.message, '請求格式不正確', body);
        }
        assert.equal(gw.calls.length, 0);
    } finally {
        await gw.stop();
    }
});

// JSON.parse 處理深層巢狀很貴（29 萬 bytes 約 20ms），合法的 body 只有兩層
test('巢狀超過 3 層的 body 直接 400，不交給 JSON.parse；字串裡的括號不算層數', async () => {
    const gw = await startGateway();
    const original = JSON.parse;
    let parsedLong = 0;
    JSON.parse = function parse(text, ...rest) {
        if (typeof text === 'string' && text.length > 50_000) parsedLong++;
        return original.call(this, text, ...rest);
    };
    try {
        const deep = `{"input":{"essay":"x"},"junk":${'['.repeat(60_000)}${']'.repeat(60_000)}}`;
        const res = await post(gw.base, 'demo-long', null, { body: deep });
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error.code, 'invalid_input');
        assert.equal(parsedLong, 0, '沒有交給 JSON.parse');
        const brackets = await post(gw.base, 'demo-json', { topic: '[[[[{{{{"' });
        assert.equal(brackets.status, 200);
        await brackets.text();
    } finally {
        JSON.parse = original;
        await gw.stop();
    }
});

test('排隊等到逾時的請求不計入次數（同樣完全沒拿到服務）', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1, maxQueue: 1, queueTimeoutMs: 100, rateLimitMax: 2 },
        generate: async (request, hooks, n) => {
            if (n === 1) await gate.promise;
            return OK_RESULT;
        },
    });
    try {
        const first = sseReader(await post(gw.base, 'demo-json', { topic: 'a' }));
        await first.until(accepted);
        const timedOut = await readEvents(await post(gw.base, 'demo-json', { topic: 'b' }));
        assert.equal(timedOut.at(-1).data.code, 'busy');
        assert.equal(gw.gateway.limiter.clients.get('127.0.0.1').hits.length, 1, '只算正在跑的那一個');
        gate.resolve();
        await first.rest();
        const after = await post(gw.base, 'demo-json', { topic: 'c' });
        assert.equal(after.status, 200, '用了 2 次，不是 3 次');
        await after.text();
    } finally {
        gate.resolve();
        await gw.stop();
    }
});

test('排隊中用戶端離開、或排隊中遇上關機：都不計入次數', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1 },
        generate: async (request, hooks, n) => {
            if (n === 1) await gate.promise;
            return OK_RESULT;
        },
    });
    const hits = () => gw.gateway.limiter.clients.get('127.0.0.1').hits.length;
    const first = sseReader(await post(gw.base, 'demo-json', { topic: 'a' }));
    await first.until(accepted);
    const ctrl = new AbortController();
    const leaving = await post(gw.base, 'demo-json', { topic: 'b' }, { signal: ctrl.signal });
    await sseReader(leaving).until(queued);
    assert.equal(hits(), 2);
    ctrl.abort();
    await waitFor(() => gw.logs.some((l) => l.tag === 'TASK' && l.fields.outcome === 'aborted'));
    assert.equal(hits(), 1, '排隊中離開的退回去了');
    const waiting = sseReader(await post(gw.base, 'demo-json', { topic: 'c' }));
    await waiting.until(queued);
    const closing = gw.gateway.close({ graceMs: 5_000 });
    assert.equal((await waiting.rest()).at(-1).data.code, 'unavailable');
    assert.equal(hits(), 1, '關機時還在排隊的退回去了');
    gate.resolve();
    await first.rest();
    await closing;
});

test('信任的代理沒送用戶端 IP（或送了解析不了的值）：退回代理的位址，並記一筆有頻率限制的警告（附次數）', async () => {
    let clock = 0;
    const gw = await startGateway({ server: { clientIpHeader: 'x-forwarded-for', trustedProxies: ['127.0.0.1/32'] }, now: () => clock });
    try {
        for (let i = 0; i < 3; i++) await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }));
        const warnings = () => gw.logs.filter((l) => l.tag === 'CLIENT-IP-MISSING');
        assert.equal(warnings().length, 1, '一分鐘內只記一筆');
        assert.equal(warnings()[0].level, 'warn');
        assert.deepEqual(warnings()[0].fields, { header: 'x-forwarded-for', count: 1 });
        clock += 60_000;
        await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }, { headers: { 'x-forwarded-for': '198.51.100.1, ' } }));
        assert.equal(warnings().length, 2);
        assert.equal(warnings()[1].fields.count, 3, '上一筆之後又少了 3 次（含這一次）');
        assert.deepEqual([...gw.gateway.limiter.clients.keys()], ['127.0.0.1']);
    } finally {
        await gw.stop();
    }
});

test('CLIENT_IP_HEADER：ip:port、[v6]:port、IPv6（取 /64）、多行標頭都取最右邊的位址', async () => {
    const gw = await startGateway({ server: { clientIpHeader: 'x-forwarded-for', trustedProxies: ['127.0.0.1/32'] } });
    try {
        const cases = [
            ['203.0.113.7:4321', '203.0.113.7'],
            ['198.51.100.1, [2001:db8::1]:443', '2001:db8:0:0::/64'],
            ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
            [['198.51.100.9', '203.0.113.9'], '203.0.113.9'],
        ];
        for (const [value, key] of cases) {
            const res = await rawRequest(gw.port, { headers: jsonHeaders({ 'x-forwarded-for': value }), body: JSON.stringify({ input: { topic: 'x' } }) });
            assert.equal(res.status, 200, String(value));
            assert.ok(gw.gateway.limiter.clients.has(key), `${value} → ${key}`);
        }
        assert.ok(!gw.gateway.limiter.clients.has('127.0.0.1'));
        assert.ok(!gw.logs.some((l) => l.tag === 'CLIENT-IP-MISSING'));
    } finally {
        await gw.stop();
    }
});

test('逾時設定：標頭 20 秒、Node 每 5 秒檢查一次；requestTimeout 長於「標頭 + body」期限，只是最後防線', async () => {
    const gw = await startGateway({ server: { bodyTimeoutMs: 30_000 } });
    try {
        const { server } = gw.gateway;
        assert.equal(server.headersTimeout, 20_000);
        assert.equal(server.connectionsCheckingInterval, 5_000);
        assert.ok(server.requestTimeout > server.headersTimeout + 30_000, `requestTimeout=${server.requestTimeout}`);
    } finally {
        await gw.stop();
    }
});

test('上傳 body 太慢：閘道自己的期限到了回 408（JSON、帶 CORS），log 記 408 request_timeout', async () => {
    const gw = await startGateway({ server: { bodyTimeoutMs: 100 } });
    try {
        const socket = await rawSocket(gw.port);
        socket.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\n` +
            'Content-Length: 100\r\n\r\n{"input":');
        await socket.whenClosed;
        assert.match(socket.text, /^HTTP\/1\.1 408/);
        assert.match(socket.text, /\r\naccess-control-allow-origin: https:\/\/thc1006\.github\.io\r\n/i);
        assert.match(socket.text, /\r\nconnection: close\r\n/i);
        assert.match(socket.text, /"code":"request_timeout"/);
        await waitFor(() => gw.logs.some((l) => l.tag === 'REJECT'));
        assert.deepEqual(gw.logs.filter((l) => l.tag === 'REJECT').map((l) => [l.fields.status, l.fields.code]), [[408, 'request_timeout']]);
    } finally {
        await gw.stop();
    }
});

// Node 的逾時到了會自己回 408、關掉連線，我們這邊看到的是 body 讀到一半出錯
test('Node 自己的 requestTimeout 切斷連線時，log 記 408 request_timeout，不是用戶端離開的 499', async () => {
    const gw = await startGateway();
    try {
        let serverSocket;
        gw.gateway.server.on('connection', (s) => { serverSocket = s; });
        const requested = new Promise((resolve) => gw.gateway.server.once('request', resolve));
        const socket = await rawSocket(gw.port);
        socket.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\n` +
            'Content-Length: 100\r\n\r\n{"input":');
        await requested;
        serverSocket.destroy(Object.assign(new Error('模擬 Node 的 requestTimeout'), { code: 'ERR_HTTP_REQUEST_TIMEOUT' }));
        await waitFor(() => gw.logs.some((l) => l.tag === 'REJECT'));
        assert.deepEqual(gw.logs.filter((l) => l.tag === 'REJECT').map((l) => [l.fields.status, l.fields.code]), [[408, 'request_timeout']]);
    } finally {
        await gw.stop();
    }
});

// server.close() 會停掉 Node 自己的逾時檢查，而關機的寬限期預設長達 15 分鐘
test('body 的期限在開始關機之後仍然有效', async () => {
    const hang = hangingGenerate();
    const gw = await startGateway({ server: { bodyTimeoutMs: 300 }, generate: hang.generate });
    const reading = sseReader(await post(gw.base, 'demo-json', { topic: 'a' }));
    await reading.until(accepted);
    const requested = new Promise((resolve) => gw.gateway.server.once('request', resolve));
    const slow = await rawSocket(gw.port);
    slow.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\n` +
        'Content-Length: 100\r\n\r\n{"input":');
    await requested;
    // 進行中的任務撐住寬限期（600ms）：慢的 body 在寬限期內就要被切掉
    const closing = gw.gateway.close({ graceMs: 600 });
    assert.equal(await within(slow.whenClosed, 1_500), true, '關機中 body 的期限沒有生效');
    assert.match(slow.text, /^HTTP\/1\.1 408/);
    await closing;
    assert.equal((await reading.rest()).at(-1).data.code, 'unavailable');
});

test('Expect: 100-continue：提早的檢查沒過就直接回最終結果，不先請對方送 body', async () => {
    const gw = await startGateway({ server: { rateLimitMax: 1 } });
    try {
        for (const [headers, status] of [
            ['Origin: https://evil.example\r\nContent-Type: application/json\r\n', 403],
            [`Origin: ${ORIGIN}\r\nContent-Type: text/plain\r\n`, 415],
        ]) {
            const socket = await rawSocket(gw.port);
            socket.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\n${headers}Content-Length: 20\r\nExpect: 100-continue\r\n\r\n`);
            await socket.whenClosed;
            assert.ok(socket.text.startsWith(`HTTP/1.1 ${status} `), socket.text.split('\r\n')[0]);
            assert.doesNotMatch(socket.text, /100 Continue/);
        }
        await readEvents(await post(gw.base, 'demo-json', { topic: 'a' }));
        const limited = await rawSocket(gw.port);
        limited.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: 20\r\nExpect: 100-continue\r\n\r\n`);
        await limited.whenClosed;
        assert.match(limited.text, /^HTTP\/1\.1 429/, '已經被限流的也不必送 body');
    } finally {
        await gw.stop();
    }
});

test('Expect: 100-continue：檢查都過了才回 100 Continue，送完 body 照常串流', async () => {
    const gw = await startGateway();
    try {
        const socket = await rawSocket(gw.port);
        const body = JSON.stringify({ input: { topic: 'x' } });
        socket.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${body.length}\r\nExpect: 100-continue\r\n\r\n`);
        await waitFor(() => socket.text.includes('100 Continue'));
        socket.write(body);
        await waitFor(() => socket.text.includes('event: done'));
        assert.match(socket.text, /^HTTP\/1\.1 100 Continue\r\n\r\nHTTP\/1\.1 200/);
        socket.destroy();
    } finally {
        await gw.stop();
    }
});

test('同一條連線 pipeline 多個任務、之後斷線：全部中止，名額與 active 都歸零', async () => {
    const gw = await startGateway({
        generate: (request, hooks) => new Promise((resolve, reject) => {
            hooks.signal.addEventListener('abort', () => reject(new UpstreamError('aborted', '取消')), { once: true });
        }),
    });
    try {
        const socket = await rawSocket(gw.port);
        socket.write(rawPost('demo-json', { topic: 'a' }) + rawPost('demo-json', { topic: 'b' }) + rawPost('demo-json', { topic: 'c' }));
        await waitFor(() => gw.calls.length === 3);
        socket.destroy();
        await waitFor(() => gw.gateway.stats().active === 0);
        assert.deepEqual(gw.gateway.stats(), { inflight: 0, queued: 0, active: 0, draining: false });
        assert.ok(gw.calls.every((c) => c.hooks.signal.aborted));
        assert.equal(gw.logs.filter((l) => l.tag === 'TASK' && l.fields.outcome === 'aborted').length, 3);
        assert.equal(gw.gateway.limiter.clients.get('127.0.0.1').inflight, 0);
    } finally {
        await gw.stop();
    }
});

test('不論任務怎麼結束，src 建立的計時器（含 unref 的）都會清掉，也不留在 active 裡', async () => {
    const gate = deferred();
    const gw = await startGateway({
        server: { concurrency: 1, maxQueue: 1, queueTimeoutMs: 300, heartbeatMs: 1_000 },
        generate: async (request, hooks) => {
            const text = request.messages[1].content;
            // 同一階段連續兩筆：第二筆會被節流、由計時器補送
            hooks.onProgress({ phase: 'thinking', round: 1, thinkingTokens: 1, writingTokens: 0 });
            hooks.onProgress({ phase: 'thinking', round: 1, thinkingTokens: 2, writingTokens: 0 });
            if (text.includes('hold')) await gate.promise;
            if (text.includes('boom')) throw new Error('程式錯誤');
            if (text.includes('hang')) {
                await new Promise((resolve, reject) => hooks.signal.addEventListener('abort', () => reject(new Error('取消')), { once: true }));
            }
            return OK_RESULT;
        },
    });
    const timers = trackTimers();
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'ok' }));
        await readEvents(await post(gw.base, 'demo-json', { topic: 'boom' }));
        const ctrl = new AbortController();
        const hanging = await post(gw.base, 'demo-json', { topic: 'hang' }, { signal: ctrl.signal });
        await sseReader(hanging).until(accepted);
        ctrl.abort();
        await waitFor(() => gw.gateway.stats().active === 0);
        const holder = sseReader(await post(gw.base, 'demo-json', { topic: 'hold' }));
        await holder.until(accepted);
        const queuedOne = sseReader(await post(gw.base, 'demo-json', { topic: 'q' }));
        await queuedOne.until(queued);
        const full = await post(gw.base, 'demo-json', { topic: 'full' });
        assert.equal(full.status, 503);
        await full.text();
        assert.equal((await queuedOne.rest()).at(-1).data.code, 'busy');
        gate.resolve();
        await holder.rest();
        const invalid = await post(gw.base, 'demo-json', { topic: '' });
        assert.equal(invalid.status, 400);
        await invalid.text();
        await waitFor(() => gw.gateway.stats().active === 0 && gw.gateway.stats().inflight === 0);
        await sleep(20);
        assert.deepEqual([...timers.live.values()], []);
    } finally {
        timers.restore();
        gate.resolve();
        await gw.stop();
    }
});

test('名額空出來先給進行中任務最少的來源：佔著名額的來源後來排的請求，不會比別人先輪到', async () => {
    const holds = [];
    const gw = await startGateway({
        server: { concurrency: 2, maxQueue: 5, clientIpHeader: 'x-forwarded-for', trustedProxies: ['127.0.0.1/32'] },
        generate: async () => {
            const hold = deferred();
            holds.push(hold);
            await hold.promise;
            return OK_RESULT;
        },
    });
    const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });
    try {
        const running = [];
        for (const topic of ['a1', 'a2']) {
            running.push(sseReader(await post(gw.base, 'demo-json', { topic }, from('203.0.113.1'))));
            await running.at(-1).until(accepted);
        }
        await waitFor(() => holds.length === 2);
        const a3 = sseReader(await post(gw.base, 'demo-json', { topic: 'a3' }, from('203.0.113.1')));
        await a3.until(queued);
        const b1 = sseReader(await post(gw.base, 'demo-json', { topic: 'b1' }, from('203.0.113.2')));
        const position = (events) => events.filter((e) => e.data.phase === 'queued').at(-1).data.position;
        assert.equal(position(await b1.until(queued)), 1);
        assert.equal(position(await a3.until((events) => position(events) === 2)), 2);

        holds[0].resolve();
        await waitFor(() => holds.length === 3);
        assert.match(gw.calls[2].request.messages[1].content, /b1/, '下一個開始的是 B 的請求');
        holds[1].resolve();
        await waitFor(() => holds.length === 4);
        holds[2].resolve();
        holds[3].resolve();
        for (const reader of [...running, a3, b1]) assert.equal((await reader.rest()).at(-1).event, 'done');
    } finally {
        for (const hold of holds) hold.resolve();
        await gw.stop();
    }
});

test('任務自己的時限（timeoutMs）比 LLM_TASK_TIMEOUT_MS 短時，generate 拿到的是任務的時限', async () => {
    for (const [taskTimeoutMs, expected] of [[10_000, 300], [200, 200]]) {
        const gw = await startGateway({ llm: { taskTimeoutMs } });
        try {
            await readEvents(await post(gw.base, 'demo-quick', { topic: 'a' }));
            await readEvents(await post(gw.base, 'demo-json', { topic: 'a' }));
            assert.equal(gw.calls[0].llm.taskTimeoutMs, expected, `LLM_TASK_TIMEOUT_MS=${taskTimeoutMs}`);
            assert.equal(gw.calls[1].llm.taskTimeoutMs, taskTimeoutMs, '沒設 timeoutMs 的任務照全站的設定');
        } finally {
            await gw.stop();
        }
    }
});

// 名額空出來的排序只管排隊的人。閘道閒著時一個來源能拿走全部名額，佔多久由任務的時限決定
test('一個來源趁閒置拿走全部名額：任務的時限一到就空出來，排隊的別的來源輪得到', async () => {
    const upstream = await startFakeUpstream((req) => (JSON.stringify(req.body).includes('想很久')
        ? { thinking: ['想'], hangAfterChunks: 2 }
        : { content: ['好。'] }));
    const gateway = createGateway({
        llm: testConfig(upstream.origin, { taskTimeoutMs: 10_000, idleTimeoutMs: 5_000 }),
        server: serverConfig({ concurrency: 2, queueTimeoutMs: 1_500, clientIpHeader: 'x-forwarded-for', trustedProxies: ['127.0.0.1/32'] }),
        tasks: TASKS,
        log: () => {},
    });
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    const from = (ip) => ({ headers: { 'x-forwarded-for': ip } });
    try {
        const hogs = [];
        for (let i = 0; i < 2; i++) {
            hogs.push(sseReader(await post(base, 'demo-quick', { topic: '想很久' }, from('203.0.113.1'))));
            await hogs.at(-1).until(accepted);
        }
        const other = sseReader(await post(base, 'demo-quick', { topic: '短' }, from('203.0.113.2')));
        await other.until(queued);
        const done = (await other.rest()).at(-1);
        assert.equal(done.event, 'done', JSON.stringify(done));
        assert.equal(done.data.result, '好。');
        for (const hog of hogs) assert.equal((await hog.rest()).at(-1).data.code, 'timeout');
    } finally {
        await gateway.close({ graceMs: 0, requestWaitMs: 0 });
        await upstream.close();
    }
});

test('排過隊的任務輪到時送 progress started（之後到第一個 token 前可能還要等上游）；沒排隊的不送', async () => {
    const hold = deferred();
    const gw = await startGateway({
        server: { concurrency: 1 },
        generate: async (request, hooks, n) => {
            if (n === 1) await hold.promise;
            return OK_RESULT;
        },
    });
    try {
        const first = sseReader(await post(gw.base, 'demo-json', { topic: 'a' }));
        await first.until(accepted);
        const second = sseReader(await post(gw.base, 'demo-json', { topic: 'b' }));
        await second.until(queued);
        hold.resolve();
        const phases = (events) => events.filter((e) => e.event === 'progress').map((e) => e.data.phase);
        assert.deepEqual(phases(await second.rest()), ['queued', 'started']);
        assert.deepEqual(phases(await first.rest()), []);
    } finally {
        hold.resolve();
        await gw.stop();
    }
});

test('上游在第一個 token 之前就回忙線（429）或連不上：不計入次數；已經開始思考的才算', async () => {
    let mode = 'busy';
    const gw = await startGateway({
        server: { rateLimitMax: 2 },
        generate: async (request, hooks) => {
            if (mode === 'busy') throw new UpstreamError('busy', 'LLM 服務回應 HTTP 429', { status: 429, retryable: true, retryAfter: 30 });
            if (mode === 'down') throw new UpstreamError('unavailable', '連不上 LLM 服務（ECONNREFUSED）', { retryable: true });
            hooks.onProgress({ phase: 'thinking', round: 1, thinkingTokens: 1, writingTokens: 0 });
            throw new UpstreamError('busy', 'LLM 服務回應 HTTP 429', { status: 429, retryable: true });
        },
    });
    try {
        const codes = async (n) => {
            const out = [];
            for (let i = 0; i < n; i++) {
                const res = await post(gw.base, 'demo-json', { topic: 'x' });
                out.push(res.status === 200 ? (await readEvents(res)).at(-1).data.code : (await res.json()).error.code);
            }
            return out;
        };
        assert.deepEqual(await codes(3), ['busy', 'busy', 'busy']);
        mode = 'down';
        assert.deepEqual(await codes(3), ['unavailable', 'unavailable', 'unavailable']);
        mode = 'thinking';
        assert.deepEqual(await codes(3), ['busy', 'busy', 'rate_limited'], '上游有回應之後才計次，前面 6 次都沒算');
    } finally {
        await gw.stop();
    }
});

// WinLab 忙的時候光等第一個位元組就要一兩分鐘：時限在第一個 token 之前就到了，跟學生寫了什麼無關
test('第一個 token 之前就逾時（任務的時限、上游的閒置逾時）：回忙線、不計次、log 記 UPSTREAM-ERR；開始思考之後才逾時照舊', async () => {
    const upstream = await startFakeUpstream((req) => (JSON.stringify(req.body).includes('想很久')
        ? { thinking: ['想'], hangAfterChunks: 2 }
        : { hangBeforeHeaders: true }));
    const logs = [];
    const gateway = createGateway({
        llm: testConfig(upstream.origin, { taskTimeoutMs: 10_000, idleTimeoutMs: 600 }),
        server: serverConfig({ rateLimitMax: 1 }),
        tasks: TASKS,
        log: (level, tag, fields) => logs.push({ level, tag, fields }),
    });
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    const busy = { code: 'busy', message: '目前使用的人比較多，請稍後再試。', retryable: true, retryAfter: 30 };
    try {
        // demo-quick 的時限 300ms 比閒置逾時短，先到的是任務的時限；demo-md 沒有自己的時限，先到的是閒置逾時
        for (const [task, input] of [['demo-quick', { topic: '等' }], ['demo-md', { question: '等' }], ['demo-quick', { topic: '等' }]]) {
            assert.deepEqual((await readEvents(await post(base, task, input))).at(-1).data, busy, task);
        }
        const waited = logs.filter((l) => l.tag === 'UPSTREAM-ERR').map((l) => [l.fields.code, l.fields.reason]);
        assert.deepEqual(waited, [
            ['timeout', '超過總時限 300ms，還沒收到任何 token'],
            ['timeout', '上游超過 600ms 沒有回應任何資料，還沒收到任何 token'],
            ['timeout', '超過總時限 300ms，還沒收到任何 token'],
        ]);
        // rateLimitMax 是 1：上面三次都沒計次，開始思考之後才逾時的這次才算
        const thought = (await readEvents(await post(base, 'demo-quick', { topic: '想很久' }))).at(-1);
        assert.equal(thought.data.code, 'timeout');
        assert.match(thought.data.message, /寫得更具體/);
        const res = await post(base, 'demo-quick', { topic: '等' });
        assert.equal(res.status, 429);
        assert.equal((await res.json()).error.code, 'rate_limited');
    } finally {
        await gateway.close({ graceMs: 0, requestWaitMs: 0 });
        await upstream.close();
    }
});

// 408、504 是 WinLab（LiteLLM 或它前面的代理）自己回的逾時，維運要看得到它附的訊息。
test('第一個 token 之前上游回 408、504（HTTP 狀態或串流中的 error）：回忙線、不計次，UPSTREAM-ERR 記著狀態碼與上游錯誤的 code，不記錯誤的原文', async () => {
    const litellm = { message: 'litellm.Timeout: upstream vllm timed out after 600s', code: '504' };
    const steps = [{ status: 504, body: { error: litellm } }, { status: 408, body: 'proxy request timeout' }, { errorChunk: litellm }];
    const upstream = await startFakeUpstream(steps);
    const logs = [];
    const gateway = createGateway({
        llm: testConfig(upstream.origin),
        server: serverConfig({ rateLimitMax: 1 }),
        tasks: TASKS,
        log: (level, tag, fields) => logs.push({ level, tag, fields }),
    });
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${gateway.server.address().port}`;
    try {
        for (let i = 0; i < steps.length; i++) {
            const res = await post(base, 'demo-md', { question: '等' });
            assert.equal(res.status, 200, `#${i} 不該被計次`);
            assert.equal((await readEvents(res)).at(-1).data.code, 'busy', `#${i}`);
        }
        const logged = logs.filter((l) => l.tag === 'UPSTREAM-ERR').map((l) => l.fields);
        assert.deepEqual(logged.map((f) => [f.code, f.status, f.upstreamCode]), [['timeout', 504, '504'], ['timeout', 408, undefined], ['timeout', 504, '504']]);
        assert.deepEqual(logged.map((f) => f.reason), ['LLM 服務回應 HTTP 504', 'LLM 服務回應 HTTP 408', 'LLM 服務在串流途中回報錯誤']);
        assert.doesNotMatch(JSON.stringify(logs), /litellm|proxy request timeout|還沒收到任何 token/);
        assert.equal(upstream.requests.length, 3);
    } finally {
        await gateway.close({ graceMs: 0, requestWaitMs: 0 });
        await upstream.close();
    }
});

test('JSON 任務把交出前的驗證交給 generate（acceptJson）：包在說明裡的合格 JSON 收下，不合規格的不收；文字任務不給', async () => {
    const gw = await startGateway();
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'a' }));
        await readEvents(await post(gw.base, 'demo-md', { question: 'q' }));
        const accept = gw.calls[0].request.acceptJson;
        assert.equal(accept('以下是結果：\n{"answer":"好"}'), true);
        assert.equal(accept('```json\n{"answer":"好"}\n```'), true);
        // 不收時回傳不合格的來源、路徑與規則代號（generate 只把 true 當成收下）
        assert.deepEqual(accept('{"answer":"好","extra":1}'), { source: 'schema', path: '$', rule: 'additional' });
        assert.deepEqual(accept('{"answer":""}'), { source: 'schema', path: '$.answer', rule: 'min_length' });
        assert.deepEqual(accept('不是 JSON'), { source: 'parse', path: undefined, rule: 'SyntaxError' });
        assert.equal(gw.calls[1].request.acceptJson, undefined);
    } finally {
        await gw.stop();
    }
});

// 任務的 check 也在 acceptJson 裡：schema 抓不到的週次重複，在生成階段就走整份重寫，不會等到交出前才失敗。
test('study-plan 的週次重複：generate 不收下，照寫完卻不合格的流程整份重寫，交出重寫後的計畫', async () => {
    const plan = (labels) => ({
        learning_objectives: ['能說明手搖飲店的行銷策略。', '能設計問卷蒐集顧客意見。', '能提出改善建議並上台報告。'],
        execution_methods: ['每週觀察兩家店的促銷活動。', '設計問卷並訪談三位同學。'],
        weekly_plan: labels.map((week, i) => ({ week, tasks: `任務${i + 1}` })),
        expected_outcome: ['一份行銷策略分析報告。', '一份五分鐘的簡報。'],
    });
    const good = plan(['Week 1-2', 'Week 3-4', 'Week 5-6', 'Week 7-8']);
    const logs = [];
    const upstream = await startFakeUpstream([
        { content: [JSON.stringify(plan(['Week 1-2', 'Week 1-2', 'Week 1-2', 'Week 1-2']))], finish: 'stop' },
        { content: [JSON.stringify(good)], finish: 'stop' },
    ]);
    const gateway = createGateway({
        llm: testConfig(upstream.origin),
        server: serverConfig(),
        tasks: createCatalog(TASK_DEFINITIONS.filter((def) => def.id === 'study-plan')),
        log: (level, tag, fields) => logs.push({ tag, fields }),
    });
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    try {
        const events = await readEvents(await post(`http://127.0.0.1:${gateway.server.address().port}`, 'study-plan', { topic: '手搖飲的行銷' }));
        const done = events.find((e) => e.event === 'done');
        assert.deepEqual(done?.data.result, good);
        assert.deepEqual(done.data.continuations, ['rewrite']);
        assert.equal(upstream.requests.length, 2);
        // 重寫用的是 REFORMAT_JSON_PROMPT（寫完卻不合格），不是說被截斷的 REWRITE_JSON_PROMPT
        assert.match(upstream.requests[1].body.messages.at(-1).content, /^你上一則的回覆不是一份符合要求的 JSON/);
        const reject = logs.find((l) => l.tag === 'JSON-REJECT')?.fields;
        assert.deepEqual([reject?.round, reject?.source, reject?.path, reject?.rule], [1, 'check', '$.weekly_plan[1].week', 'check']);
    } finally {
        await gateway.close({ graceMs: 0, requestWaitMs: 0 });
        await upstream.close();
    }
});

test('JSON-REJECT 只收固定形狀的來源、路徑與規則代號，其他值（含 generate 交回的任意物件）都不記', async () => {
    const reasons = [
        { source: 'check', path: '$.answer', rule: 'check' },
        { source: `check ${LEAK}`, path: `${LEAK} $.answer`, rule: `rule ${LEAK}` },
        { source: 'schema', path: `$.answer ${LEAK}`, rule: 'undefined'.repeat(5) },
        false,
        undefined,
        `$.answer ${LEAK}`,
    ];
    const gw = await startGateway({
        generate: async (request, hooks) => {
            reasons.forEach((reason, i) => hooks.onReject({ round: i + 1, reason }));
            return OK_RESULT;
        },
    });
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }));
        const rejects = gw.logs.filter((l) => l.tag === 'JSON-REJECT').map(({ fields }) => {
            const { id, ...rest } = fields;
            assert.match(id, /^[0-9a-f-]{36}$/);
            return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
        });
        assert.deepEqual(rejects, [
            { task: 'demo-json', round: 1, source: 'check', path: '$.answer', rule: 'check' },
            ...[2, 3, 4, 5, 6].map((round) => ({ task: 'demo-json', round, ...(round === 3 ? { source: 'schema' } : {}) })),
        ]);
        assert.doesNotMatch(JSON.stringify(gw.logs), new RegExp(LEAK));
    } finally {
        await gw.stop();
    }
});

test('任務的 check 丟出例外：第一輪就以 internal 結束，不重寫，log 記下例外的種類', async () => {
    const upstream = await startFakeUpstream([{ content: ['{"answer":"好"}'], finish: 'stop' }]);
    const logs = [];
    const gateway = createGateway({
        llm: testConfig(upstream.origin),
        server: serverConfig(),
        tasks: createCatalog([{
            id: 'demo-broken-check',
            input: { topic: { label: '主題', maxLength: 20 } },
            output: { ...TASKS.get('demo-json').output, check: (value) => value.missing.length },
            instructions: '依主題回答。',
        }]),
        log: (level, tag, fields) => logs.push({ level, tag, fields }),
    });
    await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
    try {
        const events = await readEvents(await post(`http://127.0.0.1:${gateway.server.address().port}`, 'demo-broken-check', { topic: 'x' }));
        assert.equal(events.at(-1).event, 'error');
        assert.equal(events.at(-1).data.code, 'internal');
        assert.equal(upstream.requests.length, 1);
        const taskErr = logs.find((l) => l.tag === 'TASK-ERR');
        assert.equal(taskErr?.level, 'error');
        assert.match(taskErr.fields.detail, /^TypeError/);
    } finally {
        await gateway.close({ graceMs: 0, requestWaitMs: 0 });
        await upstream.close();
    }
});

test('generate 以 format 結束（用完輪數仍不合格）：error 事件 format、可以重試，不叫學生縮小問題', async () => {
    const gw = await startGateway({ generate: async () => { throw new GenerationError('format', '用完 3 輪，JSON 仍不符合格式'); } });
    try {
        const last = (await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }))).at(-1);
        assert.equal(last.data.code, 'format');
        assert.equal(last.data.retryable, true);
        assert.equal(last.data.message, 'AI 回覆的格式不正確，請再試一次。');
    } finally {
        await gw.stop();
    }
});

test('同時在收 body 的請求有上限：滿了就立刻 503 並關掉連線；收完的騰出位置', async () => {
    const gw = await startGateway({ maxBodyReads: 2 });
    const slow = [];
    try {
        for (let i = 0; i < 2; i++) {
            const socket = await rawSocket(gw.port);
            socket.write(`POST /v1/tasks/demo-json HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\nContent-Type: application/json\r\nContent-Length: 30\r\n\r\n{"input":`);
            slow.push(socket);
        }
        await waitFor(() => gw.logs.length === 0 && slow.every((s) => !s.destroyed));
        await sleep(50);
        const third = await rawRequest(gw.port, { headers: jsonHeaders(), body: JSON.stringify({ input: { topic: 'x' } }) });
        assert.equal(third.status, 503);
        assert.equal(JSON.parse(third.body).error.code, 'busy');
        assert.equal(third.headers['retry-after'], '5');
        assert.equal(third.headers.connection, 'close');
        slow[0].end('{"topic":"y"}}' + ' '.repeat(30 - '{"input":{"topic":"y"}}'.length));
        await slow[0].whenClosed;
        const fourth = await rawRequest(gw.port, { headers: jsonHeaders(), body: JSON.stringify({ input: { topic: 'z' } }) });
        assert.equal(fourth.status, 200);
    } finally {
        for (const socket of slow) socket.destroy();
        await gw.stop();
    }
});

test('標頭最多 8 KiB（超過回 431）；連線數上限是 2048', async () => {
    const gw = await startGateway();
    try {
        const ok = await rawRequest(gw.port, { headers: jsonHeaders({ 'x-pad': 'a'.repeat(7_000) }), body: JSON.stringify({ input: { topic: 'x' } }) });
        assert.equal(ok.status, 200);
        const big = await rawRequest(gw.port, { headers: jsonHeaders({ 'x-pad': 'a'.repeat(9_000) }), body: JSON.stringify({ input: { topic: 'x' } }) });
        assert.equal(big.status, 431);
        assert.equal(gw.gateway.server.maxConnections, 2048);
    } finally {
        await gw.stop();
    }
});

test('帶著 CLIENT_IP_HEADER、連線卻不是來自信任的代理：退回連線的位址，並記一筆有頻率限制的警告（附次數與位址）', async () => {
    let clock = 0;
    const gw = await startGateway({ server: { clientIpHeader: 'x-forwarded-for', trustedProxies: ['10.42.0.1/32'] }, now: () => clock });
    try {
        const send = (headers) => post(gw.base, 'demo-json', { topic: 'x' }, { headers }).then(readEvents);
        await send({});
        assert.ok(!gw.logs.some((l) => l.tag === 'CLIENT-IP-UNTRUSTED'), '沒帶標頭的不算');
        for (let i = 0; i < 3; i++) await send({ 'x-forwarded-for': `203.0.113.${i}` });
        const warnings = () => gw.logs.filter((l) => l.tag === 'CLIENT-IP-UNTRUSTED');
        assert.equal(warnings().length, 1, '一分鐘內只記一筆');
        assert.equal(warnings()[0].level, 'warn');
        assert.deepEqual(warnings()[0].fields, { header: 'x-forwarded-for', count: 1, peer: '127.0.0.1' });
        clock += 60_000;
        await send({ 'x-forwarded-for': '203.0.113.9' });
        assert.equal(warnings()[1].fields.count, 3);
        assert.deepEqual([...gw.gateway.limiter.clients.keys()], ['127.0.0.1']);
    } finally {
        await gw.stop();
    }
});

// internalAddress 只認 IPv4：從 ::1 連進來就是「不是內部位址」的情況，log 只能有雜湊
test('CLIENT-IP-UNTRUSTED：連線的位址不是內部位址時只記雜湊，原始位址不進 log', async () => {
    const gw = await startGateway({ host: '::1', server: { clientIpHeader: 'x-forwarded-for', trustedProxies: ['10.42.0.1/32'] } });
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: 'x' }, { headers: { 'x-forwarded-for': '203.0.113.9' } }));
        const warning = gw.logs.find((l) => l.tag === 'CLIENT-IP-UNTRUSTED');
        assert.match(warning.fields.peer, /^hash:[0-9a-f]{10}$/);
        assert.doesNotMatch(JSON.stringify(gw.logs), /::1|0:0:0:0::/);
    } finally {
        await gw.stop();
    }
});

// 第一輪被截斷在「1. 蒐集」，接續的一輪卻什麼都沒加就以 stop 結束：學生拿到的是半句話
const CUT_HEAD = '請先完成以下三項：\n1. 蒐集';
const deltaText = (events) => events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');

test('接續正文的一輪去重疊後沒有新增看得見的字就以 stop 結束：不送 done，第二次加提醒，連兩輪就以 incomplete 結束，已送出的部分不收回', async () => {
    // 看不見的字元用 code point 產生：照樣送出，只是不算新增（原始碼裡不能有看不見的字元）
    const [hangulFiller, brailleBlank] = [0x3164, 0x2800].map((cp) => String.fromCodePoint(cp));
    const cases = [
        // [說明, 第二、三輪的正文, 這兩輪送出去的字]
        ['只有空白', ['\n\n'], ''],
        ['空字串', [], ''],
        ['只重複結尾', ['蒐集'], ''],
        ['只有韓文填充字', [hangulFiller], hangulFiller.repeat(2)],
        ['只有點字空白', [brailleBlank], brailleBlank.repeat(2)],
    ];
    for (const [label, again, sent] of cases) {
        const gw = await startRealGateway([
            { content: [CUT_HEAD], finish: 'length' },
            { content: again, finish: 'stop' },
            { content: again, finish: 'stop' },
        ]);
        try {
            const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
            assert.equal(deltaText(events), CUT_HEAD + sent, label);
            assert.ok(!events.some((e) => e.event === 'done'), label);
            const last = events.at(-1);
            assert.equal(last.event, 'error', label);
            // 沒寫完是因為沒有進展，不是回答太長：訊息照實說，可以再試一次；log 分得出是哪一種
            assert.deepEqual(last.data, { code: 'incomplete', message: 'AI 這次沒能把回答寫完，可以再試一次。', retryable: true }, label);
            assert.match(gw.lines.find((l) => / TASK-ERR /.test(l)), /code=incomplete detail="模型連續兩輪沒有任何進展，提前結束"/, label);
            assert.equal(gw.upstream.requests.length, 3, label);
            const lastUser = (i) => gw.upstream.requests[i].body.messages.at(-1).content;
            assert.ok(!lastUser(1).includes(DEGENERATE_NUDGE), `${label}：第一次接續不加提醒`);
            assert.ok(lastUser(2).endsWith(DEGENERATE_NUDGE), `${label}：第二次接續的請求原本會一模一樣，加提醒`);
            assert.match(gw.lines.find((l) => / TASK /.test(l)), /outcome=incomplete/, label);
        } finally {
            await gw.stop();
        }
    }
});

test('接續正文有新增的字就照常完成；第一輪就只有空白、JSON 重寫只有空白，照舊是 empty', async () => {
    const cases = [
        ['接著寫完', 'demo-md', [{ content: [CUT_HEAD], finish: 'length' }, { content: ['蒐集資料\n2. 分析\n3. 報告'], finish: 'stop' }],
            { event: 'done', result: `${CUT_HEAD}資料\n2. 分析\n3. 報告` }],
        ['只補一個標點', 'demo-md', [{ content: [CUT_HEAD], finish: 'length' }, { content: ['。'], finish: 'stop' }],
            { event: 'done', result: `${CUT_HEAD}。` }],
        ['第一輪只有空白', 'demo-md', [{ content: ['\n\n'], finish: 'stop' }], { event: 'error', code: 'empty' }],
        ['JSON 重寫只有空白', 'demo-json', [{ content: ['{"answer":"生'], finish: 'length' }, { content: ['\n\n'], finish: 'stop' }],
            { event: 'error', code: 'empty' }],
    ];
    for (const [label, task, script, expected] of cases) {
        const gw = await startRealGateway(script);
        try {
            const input = task === 'demo-md' ? { question: '怎麼做專題？' } : { topic: '生物' };
            const events = await readEvents(await post(gw.base, task, input));
            const last = events.at(-1);
            assert.equal(last.event, expected.event, `${label}：${JSON.stringify(last)}`);
            if (expected.event === 'done') {
                assert.equal(last.data.result, expected.result, label);
                assert.equal(deltaText(events), expected.result, label);
            } else {
                assert.equal(last.data.code, expected.code, label);
            }
            assert.equal(gw.upstream.requests.length, script.length, label);
        } finally {
            await gw.stop();
        }
    }
});

test('接續輪遇到 429、Retry-After 比剩下的總時限長（3600 秒、一小時後的 HTTP-date）：不重試，照忙線回報並轉告要等的秒數', async () => {
    const cases = [['秒數', () => '3600'], ['HTTP-date', () => new Date(Date.now() + 3_600_000).toUTCString()]];
    for (const [label, header] of cases) {
        const gw = await startRealGateway((req, i) => (i === 0
            ? { content: [CUT_HEAD], finish: 'length' }
            : { status: 429, headers: { 'retry-after': header() }, body: { error: { message: 'rate limited', code: '429' } } }));
        try {
            const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
            const last = events.at(-1);
            assert.equal(last.event, 'error', label);
            assert.deepEqual([last.data.code, last.data.retryable], ['busy', true], label);
            // HTTP-date 只到秒，算出來可能少一秒
            assert.ok(last.data.retryAfter >= 3599 && last.data.retryAfter <= 3600, `${label}：${last.data.retryAfter}`);
            assert.equal(deltaText(events), CUT_HEAD, label);
            assert.equal(gw.upstream.requests.length, 2, `${label}：不重試`);
            const fields = logFields(gw.lines.find((l) => / UPSTREAM-ERR /.test(l)));
            assert.deepEqual([fields.status, fields.retryAfter], ['429', String(last.data.retryAfter)], label);
        } finally {
            await gw.stop();
        }
    }
});

test('上游沒照 max_tokens 停、一直送正文：超過一個回應的上限就中止，瀏覽器收到 unavailable，UPSTREAM-ERR 記 protocol', async () => {
    const gw = await startRealGateway([{ content: Array.from({ length: 270 }, () => 'x'.repeat(4096)), finish: 'stop' }]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        const last = events.at(-1);
        assert.equal(last.event, 'error', JSON.stringify(last).slice(0, 200));
        assert.equal(last.data.code, 'unavailable');
        assert.ok(!events.some((e) => e.event === 'done'));
        const fields = logFields(gw.lines.find((l) => / UPSTREAM-ERR /.test(l)));
        assert.equal(fields.code, 'protocol');
        assert.match(fields.reason, new RegExp(`${8192 * 128 + 4096} 字元`));
    } finally {
        await gw.stop();
    }
});

/** 送出任務請求之後完全不讀回應的用戶端：沒有 data 的監聽，緩衝滿了 TCP 視窗就是零 */
async function silentClient(port, task, input) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', (err) => { socket.errorCode = err.code; });
    socket.whenClosed = new Promise((resolve) => socket.on('close', resolve));
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(rawPost(task, input));
    return socket;
}

// 一直送 16 KiB 的片段，直到被中止或送滿 limit；回傳 { generate, state }
function floodingGenerate(limit, { waitAfter = false } = {}) {
    const state = { emitted: 0, aborted: false };
    const piece = 'x'.repeat(16 * 1024);
    const generate = async (request, hooks) => {
        while (!hooks.signal.aborted && state.emitted < limit) {
            hooks.onContent(piece);
            state.emitted += piece.length;
            await new Promise((resolve) => setImmediate(resolve));
        }
        if (waitAfter && !hooks.signal.aborted) {
            await new Promise((resolve) => hooks.signal.addEventListener('abort', resolve, { once: true }));
        }
        state.aborted = hooks.signal.aborted;
        throw new UpstreamError('aborted', '取消');
    };
    return { generate, state };
}

/**
 * 閘道在時限內認定用戶端不收資料：上游被中止、TASK 記 client_stalled、499 與判定的門檻、伺服器那端
 * 的連線已經放掉。不讀的用戶端要讀了才會發現連線被 RST 關掉，讀的時候拿到 ECONNRESET（FIN 的話
 * 會先讀到排著的資料再正常結束）
 */
async function expectStalled(gw, flood, socket, stall) {
    await waitFor(() => gw.logs.some((l) => l.tag === 'TASK'), 5_000);
    const task = gw.logs.find((l) => l.tag === 'TASK').fields;
    assert.deepEqual([task.outcome, task.status, task.stall], ['client_stalled', 499, stall]);
    assert.ok(task.pending > 0);
    assert.equal(flood.state.aborted, true, '上游沒有被中止');
    const connections = () => new Promise((resolve) => gw.gateway.server.getConnections((err, n) => resolve(n)));
    let open = await connections();
    for (let i = 0; i < 100 && open > 0; i++) {
        await sleep(10);
        open = await connections();
    }
    assert.equal(open, 0, '伺服器那端的連線還在');
    socket.resume();
    assert.equal(await within(socket.whenClosed, 2_000), true, '用戶端讀了之後連線沒有結束');
    assert.equal(socket.errorCode, 'ECONNRESET');
}

test('用戶端不讀資料：生成期間待送的資料超過上限，就中止上游並關掉連線，不繼續排進記憶體', async () => {
    const flood = floodingGenerate(32 * 1024 * 1024);
    const gw = await startGateway({ maxPendingBytes: 64 * 1024, stallTimeoutMs: 60_000, generate: flood.generate });
    const socket = await silentClient(gw.port, 'demo-md', { question: '長' });
    try {
        await expectStalled(gw, flood, socket, 'pending');
        assert.ok(flood.state.emitted < 32 * 1024 * 1024, `送了 ${flood.state.emitted} 字元才停`);
    } finally {
        socket.destroy();
        await gw.stop();
    }
});

test('用戶端不讀資料、待送的資料還沒到上限：write() 回 false 之後等 drain 有時限，時間到就中止上游並關掉連線', async () => {
    const flood = floodingGenerate(16 * 1024 * 1024, { waitAfter: true });
    const gw = await startGateway({ maxPendingBytes: 1024 * 1024 * 1024, stallTimeoutMs: 300, generate: flood.generate });
    const socket = await silentClient(gw.port, 'demo-md', { question: '長' });
    try {
        await expectStalled(gw, flood, socket, 'drain_timeout');
    } finally {
        socket.destroy();
        await gw.stop();
    }
});

test('正常讀取的用戶端不受影響：4 MiB 的片段與同樣大的 done 都收到', async () => {
    const piece = 'y'.repeat(16 * 1024);
    const gw = await startGateway({
        maxPendingBytes: 256 * 1024,
        stallTimeoutMs: 300,
        generate: async (request, hooks) => {
            for (let i = 0; i < 256; i++) {
                hooks.onContent(piece);
                await new Promise((resolve) => setImmediate(resolve));
            }
            return { ...OK_RESULT, content: piece.repeat(256) };
        },
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '長' }));
        assert.equal(events.at(-1).event, 'done');
        assert.equal(events.at(-1).data.result.length, 4 * 1024 * 1024);
        assert.equal(deltaText(events).length, 4 * 1024 * 1024);
        assert.equal(gw.logs.find((l) => l.tag === 'TASK').fields.outcome, 'ok');
    } finally {
        await gw.stop();
    }
});

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 時鐘用 mock，不必真的等（只換掉 setTimeout，網路照常運作）。stallTimeoutMs 用別處不會用到的 ms，
 * 記下這個長度的計時器有沒有排著。backedUp() 在計時器排著、連續 10 輪事件迴圈都沒被 drain 清掉時
 * 才是 true：一次寫入超過 16 KiB 時 write() 就會回 false，核心緩衝收得下的話 drain 馬上就來。
 * restore() 換回真的計時器：測試失敗時 gw.stop() 等的計時器才會到
 */
function watchStall(t, ms) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const set = globalThis.setTimeout;
    const clear = globalThis.clearTimeout;
    const live = new Set();
    globalThis.setTimeout = (fn, delay, ...args) => {
        const id = set((...a) => {
            live.delete(id);
            fn(...a);
        }, delay, ...args);
        if (delay === ms) live.add(id);
        return id;
    };
    globalThis.clearTimeout = (id) => {
        live.delete(id);
        clear(id);
    };
    const restore = () => {
        Object.assign(globalThis, { setTimeout: set, clearTimeout: clear });
        t.mock.timers.reset();
    };
    const backedUp = async () => {
        for (let i = 0; i < 10; i++) await nextTurn();
        return live.size > 0;
    };
    return { backedUp, restore };
}

// 一直送 256 KiB 的片段，直到閘道在等 drain；之後等 release() 才交出結果
function floodUntilBackedUp(backedUp) {
    const state = { sent: 0, backedUp: false };
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    const piece = 'x'.repeat(256 * 1024);
    const generate = async (request, hooks) => {
        while (state.sent < 64 * 1024 * 1024 && !state.backedUp) {
            hooks.onContent(piece);
            state.sent += piece.length;
            state.backedUp = await backedUp();
        }
        await released;
        return { ...OK_RESULT, content: 'ok' };
    };
    return { generate, state, release };
}

/** 讓暫停的用戶端開始讀，讀到 done 或連線結束為止；回傳讀到的結尾 */
async function readToEnd(socket) {
    let tail = '';
    socket.setEncoding('latin1');
    socket.on('data', (d) => { tail = (tail + d).slice(-200); });
    socket.resume();
    while (!tail.includes('event: done') && !socket.destroyed) await nextTurn();
    return tail;
}

test('用戶端暫停讀取到閘道開始等 drain、在時限內恢復讀取：drain 清掉計時器，之後過了時限也照常收到 done', async (t) => {
    const STALL_MS = 1_234;
    const watch = watchStall(t, STALL_MS);
    const flood = floodUntilBackedUp(watch.backedUp);
    const gw = await startGateway({ maxPendingBytes: 1024 * 1024 * 1024, stallTimeoutMs: STALL_MS, generate: flood.generate });
    const socket = await silentClient(gw.port, 'demo-md', { question: '長' });
    try {
        while (!flood.state.backedUp) {
            assert.ok(flood.state.sent < 64 * 1024 * 1024, '送了 64 MiB，閘道都沒有開始等 drain');
            await nextTurn();
        }
        t.mock.timers.tick(STALL_MS - 1);
        let received = 0;
        socket.on('data', (d) => { received += d.length; });
        const reading = readToEnd(socket);
        while (received < flood.state.sent) await nextTurn();
        // drain 之後計時器已經清掉；時鐘再走過時限也不能判定用戶端不收資料
        t.mock.timers.tick(10 * STALL_MS);
        flood.release();
        assert.match(await reading, /event: done/);
        while (!gw.logs.some((l) => l.tag === 'TASK')) await nextTurn();
        assert.equal(gw.logs.find((l) => l.tag === 'TASK').fields.outcome, 'ok');
    } finally {
        watch.restore();
        flood.release();
        socket.destroy();
        await gw.stop();
    }
});

test('生成結束時用戶端還沒收完：生成期間的計時器在 finally 清掉，過了 stallTimeoutMs 才讀也照常收到 done', async (t) => {
    const STALL_MS = 1_235;
    const watch = watchStall(t, STALL_MS);
    const flood = floodUntilBackedUp(watch.backedUp);
    flood.release();
    const gw = await startGateway({ maxPendingBytes: 1024 * 1024 * 1024, stallTimeoutMs: STALL_MS, generate: flood.generate });
    const socket = await silentClient(gw.port, 'demo-md', { question: '長' });
    try {
        while (!gw.logs.some((l) => l.tag === 'TASK')) await nextTurn();
        assert.equal(flood.state.backedUp, true, '送了 64 MiB，閘道都沒有開始等 drain');
        // 回應寫完之後歸 DRAIN_TIMEOUT_MS（30 秒）管，生成期間的計時器不能再把連線關掉
        t.mock.timers.tick(10 * STALL_MS);
        assert.match(await readToEnd(socket), /event: done/);
        assert.equal(gw.logs.find((l) => l.tag === 'TASK').fields.outcome, 'ok');
    } finally {
        watch.restore();
        flood.release();
        socket.destroy();
        await gw.stop();
    }
});
