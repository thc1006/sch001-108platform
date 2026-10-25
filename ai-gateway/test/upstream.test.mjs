/**
 * WinLab 串流用戶端：送出的欄位、SSE 解析（依 WHATWG 規格）的邊界情況、錯誤分類、
 * 逾時與取消、遮罩、連線重用。全部打本機的假 WinLab（fake-upstream.mjs）。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { spawnSync } from 'node:child_process';

import { streamChat, sseData, redact, parseRetryAfter, classifyStatus, UpstreamError } from '../src/upstream.mjs';
import { startFakeUpstream, testConfig } from './fake-upstream.mjs';

const basicPayload = (extra = {}) => ({
    messages: [{ role: 'user', content: '你好' }],
    maxTokens: 8192,
    reasoningEffort: 'xhigh',
    ...extra,
});

async function withUpstream(script, fn) {
    const up = await startFakeUpstream(script);
    try {
        return await fn(up);
    } finally {
        await up.close();
    }
}

async function collect(chunks) {
    const out = [];
    for await (const d of sseData(chunks)) out.push(d);
    return out;
}

// 直接控制回應的 HTTP 伺服器（假 WinLab 的劇本表達不了的情境用）
async function withServer(handler, fn) {
    const srv = createHttpServer(handler);
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
        return await fn(`http://127.0.0.1:${srv.address().port}`);
    } finally {
        srv.closeAllConnections();
        await new Promise((resolve) => srv.close(resolve));
    }
}
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const finishChunk = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n';

test('正常串流：分開收集思考與正文，回傳結束原因與用量', async () => {
    await withUpstream([{ thinking: ['先想', '一下'], content: ['你', '好！'], finish: 'stop' }], async (up) => {
        const thoughts = [];
        const texts = [];
        const r = await streamChat(testConfig(up.origin), basicPayload(), {
            onReasoning: (t) => thoughts.push(t),
            onContent: (t) => texts.push(t),
        });
        assert.equal(r.reasoning, '先想一下');
        assert.equal(r.content, '你好！');
        assert.equal(r.finishReason, 'stop');
        assert.equal(r.reasoningChunks, 2);
        assert.equal(r.contentChunks, 2);
        assert.deepEqual(thoughts, ['先想', '一下']);
        assert.deepEqual(texts, ['你', '好！']);
        // 最後一塊只帶 usage、finish_reason 是 null，不能把 stop 蓋掉
        assert.equal(r.usage.completion_tokens, 4);
    });
});

test('送出的請求：固定路徑不帶 query、只有白名單欄位、帶 key 與標頭', async () => {
    await withUpstream([{ content: ['ok'] }], async (up) => {
        await streamChat(testConfig(up.origin), basicPayload());
        const [req] = up.requests;
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(req.headers.authorization, 'Bearer sk-test-key-123');
        assert.equal(req.headers.accept, 'text/event-stream');
        assert.equal(req.headers['content-type'], 'application/json');
        assert.deepEqual(Object.keys(req.body).sort(), [
            'max_tokens', 'messages', 'model', 'reasoning_effort', 'stream', 'stream_options',
        ]);
        assert.equal(req.body.model, 'qwen3.8-27b-fp8');
        assert.equal(req.body.max_tokens, 8192);
        assert.equal(req.body.reasoning_effort, 'xhigh');
        assert.equal(req.body.stream, true);
        assert.deepEqual(req.body.stream_options, { include_usage: true });
        assert.deepEqual(req.body.messages, [{ role: 'user', content: '你好' }]);
    });
});

test('temperature 只送有限的數字（0 也要送）；response_format 只送物件', async () => {
    const format = { type: 'json_object' };
    await withUpstream([{ content: ['{}'] }, { content: ['x'] }, { content: ['y'] }], async (up) => {
        await streamChat(testConfig(up.origin), basicPayload({ temperature: 0, responseFormat: format }));
        await streamChat(testConfig(up.origin), basicPayload({ temperature: Number.NaN, responseFormat: null }));
        await streamChat(testConfig(up.origin), basicPayload({ temperature: '0.5' }));
        assert.equal(up.requests[0].body.temperature, 0);
        assert.deepEqual(up.requests[0].body.response_format, format);
        assert.equal('temperature' in up.requests[1].body, false);
        assert.equal('response_format' in up.requests[1].body, false);
        assert.equal('temperature' in up.requests[2].body, false);
    });
});

test('訊息裡的孤立代理項整理成 U+FFFD 再送（上游 Python 端轉 UTF-8 才不會失敗）', async () => {
    await withUpstream([{ content: ['ok'] }], async (up) => {
        await streamChat(testConfig(up.origin), basicPayload({ messages: [{ role: 'user', content: 'a\ud83db' }] }));
        assert.equal(up.requests[0].body.messages[0].content, 'a�b');
        assert.doesNotMatch(up.requests[0].raw, /\\ud83d/i);
    });
});

test('key 含 NUL 或非 ASCII（例如存成 UTF-16）：misconfigured、不發請求、錯誤不帶出 key', async () => {
    await withUpstream([{ content: ['不該被呼叫'] }], async (up) => {
        for (const apiKey of ['sk-real\u0000', 's\u0000k\u0000-\u0000x', 'sk-中文']) {
            await assert.rejects(streamChat(testConfig(up.origin, { apiKey }), basicPayload()), (err) => {
                assert.equal(err.code, 'misconfigured');
                assert.equal(err.cause, undefined);
                assert.doesNotMatch(`${err.message} ${err.stack}`, /real|中文/);
                return true;
            });
        }
        assert.equal(up.requests.length, 0);
    });
});

test('沒有 key：auth；LLM_UPSTREAM 不是網址：misconfigured；都不發請求', async () => {
    await withUpstream([{ content: ['不該被呼叫'] }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin, { apiKey: '' }), basicPayload()), { code: 'auth' });
        await assert.rejects(streamChat(testConfig('not a url'), basicPayload()), { code: 'misconfigured' });
        assert.equal(up.requests.length, 0);
    });
});

test('429：忙線、可重試、帶 Retry-After；上游原文遮罩後只放在不可列舉的 detail', async () => {
    await withUpstream([{
        status: 429,
        headers: { 'retry-after': '7' },
        body: { error: { message: 'max_parallel_requests exceeded for key sk-LEAKED.secret-1 at 10.1.2.3:4000 key_hash=' + 'a'.repeat(64) } },
    }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.ok(err instanceof UpstreamError);
            assert.equal(err.code, 'busy');
            assert.equal(err.retryable, true);
            assert.equal(err.retryAfter, 7);
            assert.equal(err.status, 429);
            assert.match(err.detail, /max_parallel_requests/);
            assert.doesNotMatch(err.detail, /LEAKED|10\.1\.2\.3|aaaa/);
            // message 給 log 用，不含上游原文；JSON.stringify 不會帶出 detail
            assert.doesNotMatch(err.message, /max_parallel/);
            assert.doesNotMatch(JSON.stringify(err), /max_parallel/);
            return true;
        });
    });
});

test('HTTP 狀態分類', () => {
    const cases = [
        [401, 'auth', false], [403, 'auth', false],
        [400, 'misconfigured', false], [404, 'misconfigured', false], [308, 'misconfigured', false],
        [408, 'timeout', true], [504, 'timeout', true],
        [500, 'unavailable', true], [502, 'unavailable', true], [503, 'unavailable', true],
        [501, 'misconfigured', false], [505, 'misconfigured', false],
        [429, 'busy', true],
    ];
    for (const [status, code, retryable] of cases) {
        assert.deepEqual(classifyStatus(status), { code, retryable }, `HTTP ${status}`);
    }
});

test('HTTP 錯誤經過真的連線也分類正確', async () => {
    await withUpstream([{ status: 503, body: { error: { message: 'x' } } }, { status: 401, body: 'denied' }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), { code: 'unavailable', retryable: true });
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), { code: 'auth', retryable: false });
    });
});

test('不跟轉址：308 會被當成設定錯誤，不會帶著 key 轉到別的地方', async () => {
    await withUpstream([{ status: 308, headers: { location: '/v1/chat/completions?model=other' }, body: '' }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.code, 'misconfigured');
            assert.equal(err.status, 308);
            return true;
        });
        assert.equal(up.requests.length, 1);
    });
});

test('錯誤內容很大時只讀一小段（不會把記憶體吃光），detail 截在 500 字', async () => {
    await withUpstream([{ status: 502, body: Buffer.alloc(5 * 1024 * 1024, 'x') }], async (up) => {
        const started = Date.now();
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.code, 'unavailable');
            assert.ok(err.detail.length <= 500);
            return true;
        });
        assert.ok(Date.now() - started < 3_000);
    });
});

test('Retry-After：只收十進位秒數或 HTTP-date，照上游要求的秒數，上限一天只為了數值安全', () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    assert.equal(parseRetryAfter('7', now), 7);
    assert.equal(parseRetryAfter('0', now), 0);
    assert.equal(parseRetryAfter('0x10', now), undefined);
    assert.equal(parseRetryAfter('1.5', now), undefined);
    assert.equal(parseRetryAfter('1e9', now), undefined);
    assert.equal(parseRetryAfter('3600', now), 3600);
    assert.equal(parseRetryAfter('86400', now), 86_400);
    assert.equal(parseRetryAfter('999999', now), 86_400);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 00:00:30 GMT', now), 30);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 01:00:00 GMT', now), 3600);
    assert.equal(parseRetryAfter('Fri, 01 Jan 2027 00:00:00 GMT', now), 86_400);
    // fetch 把重複的標頭用「, 」接起來：取第一個值
    assert.equal(parseRetryAfter('120, 120', now), 120);
    assert.equal(parseRetryAfter('30, 999', now), 30);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 00:00:30 GMT, Wed, 21 Oct 2026 00:01:00 GMT', now), 30);
    assert.equal(parseRetryAfter('soon, 30', now), undefined);
    assert.equal(parseRetryAfter('Tue, 20 Oct 2026 00:00:00 GMT', now), 0);
    assert.equal(parseRetryAfter('soon', now), undefined);
    assert.equal(parseRetryAfter(null, now), undefined);
});

test('讀錯誤內容時呼叫端取消：仍回報 aborted', async () => {
    await withUpstream([{ status: 500, body: 'x' }], async (up) => {
        const ctrl = new AbortController();
        const fetchImpl = async (url, init) => {
            const res = await fetch(url, init);
            ctrl.abort();
            return res;
        };
        await assert.rejects(
            streamChat(testConfig(up.origin), basicPayload(), { signal: ctrl.signal, fetchImpl }),
            { code: 'aborted' },
        );
    });
});

test('200 但不是 SSE：protocol；content-type 是上游的文字，遮罩並截短後放 detail，不進訊息；內容只記長度與開頭', async () => {
    const body = '{"choices":[{"message":{"content":"王小明的讀書計畫"}}]}';
    await withUpstream([{ rawChunks: [body], contentType: `application/json; x=sk-${'z'.repeat(200)}` }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.code, 'protocol');
            assert.equal(err.message, 'LLM 服務沒有回串流');
            assert.equal(err.detail, `content-type: application/json; x=sk-***；${body.length} 字元，開頭是 "{"`);
            return true;
        });
    });
});

test('content-type 裡的 key 用原文比對（先轉小寫的話，大小寫有別的 key 就遮不到）', async () => {
    const key = 'WlKeyZ9yX8wV7uT6sR5qP4oN';
    await withUpstream([{ rawChunks: ['{}'], contentType: `application/json; token=${key}` }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin, { apiKey: key }), basicPayload()), (err) => {
            assert.doesNotMatch(`${err.message} ${err.detail}`, /wlkey|WlKey/i);
            assert.match(err.detail, /token=\*\*\*/);
            return true;
        });
    });
});

test('content-type 大小寫不同也認得', async () => {
    await withUpstream([{ content: ['ok'], contentType: 'Text/Event-Stream; charset=UTF-8' }], async (up) => {
        const r = await streamChat(testConfig(up.origin), basicPayload());
        assert.equal(r.content, 'ok');
    });
});

test('204 沒有 body：protocol', async () => {
    await withUpstream([{ status: 204, headers: { 'content-type': 'text/event-stream' } }], async (up) => {
        // 204 不是 ok 以外的狀態，res.ok 為 true；沒有 body 就不是串流
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), { code: 'protocol' });
    });
});

// 正文常照抄學生的輸入：串流壞掉時 detail 只記形狀，log 裡不會出現內容
test('串流中出現非 JSON、或 JSON 但不是物件：protocol，detail 只記長度與開頭（不含正文）', async () => {
    const doubled = 'data: {"choices":[{"delta":{"content":"我最近心情很差"}}]}';
    const cases = [
        ['not json sk-SECRET123', '串流內容不是 JSON', '21 字元，開頭是 "n"'],
        [doubled, '串流內容不是 JSON', `${doubled.length} 字元，開頭是 "data:"`],
        ['null', '串流內容不是物件', 'JSON 的 null'],
        ['42', '串流內容不是物件', 'JSON 的 number'],
    ];
    for (const [bad, message, detail] of cases) {
        await withUpstream([{ rawChunks: [`data: ${bad}\n\n`] }], async (up) => {
            await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
                assert.equal(err.code, 'protocol', bad);
                assert.equal(err.message, message, bad);
                assert.equal(err.retryable, false, bad);
                assert.equal(err.detail, detail, bad);
                return true;
            });
        });
    }
});

test('空的 data 事件直接略過，不算錯誤', async () => {
    const rawChunks = [
        'data:\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"有"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ];
    await withUpstream([{ rawChunks }], async (up) => {
        const r = await streamChat(testConfig(up.origin), basicPayload());
        assert.equal(r.content, '有');
    });
});

test('只有 reasoning 欄位（部分 vLLM 版本）也收得到思考', async () => {
    const rawChunks = [
        'data: {"choices":[{"index":0,"delta":{"reasoning":"想"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":"答"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ];
    await withUpstream([{ rawChunks }], async (up) => {
        const r = await streamChat(testConfig(up.origin), basicPayload());
        assert.equal(r.reasoning, '想');
        assert.equal(r.content, '答');
    });
});

test('串流途中的 error 物件：依 code 分類；LiteLLM 接著送的 [DONE] 不能讓它被當成正常結束', async () => {
    const cases = [
        [{ message: 'upstream exploded sk-SECRET9', code: 500 }, 'unavailable', true],
        [{ message: 'bad request', code: '400' }, 'misconfigured', false],
        [{ message: 'busy', code: '429' }, 'busy', true],
        [{ message: 'odd', code: 'internal_error' }, 'unavailable', true],
    ];
    for (const [errorChunk, code, retryable] of cases) {
        await withUpstream([{ content: ['半'], errorChunk }], async (up) => {
            await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
                assert.equal(err.code, code, errorChunk.message);
                assert.equal(err.retryable, retryable, errorChunk.message);
                assert.match(err.detail, new RegExp(errorChunk.message.split(' ')[0]));
                assert.doesNotMatch(err.detail, /SECRET9/);
                return true;
            });
        });
    }
});

test('上游錯誤的 request id、type、code 與 param：只收 [A-Za-z0-9_.:-] 組成、64 字以內、遮罩前後相同的值', async () => {
    const uuid = '0f8e2c1a-7b9d-4e5f-a1b2-c3d4e5f60718';
    const cases = [
        ['LiteLLM 的格式', { status: 400, headers: { 'x-request-id': 'req-abc_1.2:3' }, body: { error: { type: 'BadRequestError', code: 400, param: 'messages', message: '學生的輸入' } } },
            ['req-abc_1.2:3', 'BadRequestError', '400', 'messages']],
        ['vLLM 的格式（在最外層）', { status: 400, headers: { 'x-litellm-call-id': uuid }, body: { object: 'error', type: 'BadRequestError', code: 400, message: 'x' } },
            [uuid, 'BadRequestError', '400', undefined]],
        ['有空白、漢字、超過 64 字', { status: 400, headers: { 'x-request-id': 'has space' }, body: { error: { type: '學生的輸入', code: 'x'.repeat(65), param: '學生 的輸入' } } },
            [undefined, undefined, undefined, undefined]],
        ['遮罩會改掉的：key、內部位址、長十六進位', { status: 400, headers: { 'x-request-id': 'a'.repeat(40) }, body: { error: { type: 'litellm-proxy:4000', code: 'sk-test-key-123', param: '10.1.2.3' } } },
            [undefined, undefined, undefined, undefined]],
        ['內容不是 JSON', { status: 502, headers: { 'x-request-id': 'req-502' }, body: 'Bad Gateway' }, ['req-502', undefined, undefined, undefined]],
    ];
    for (const [label, step, expected] of cases) {
        await withUpstream([step], async (up) => {
            await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
                assert.ok(err instanceof UpstreamError, label);
                assert.deepEqual([err.upstreamId, err.upstreamType, err.upstreamCode, err.upstreamParam], expected, label);
                return true;
            });
        });
    }
});

test('串流中的 error 事件：type 與 code 照同樣的規則收；request id 用串流裡最近一塊的 id，沒有才用標頭', async () => {
    const id = 'chatcmpl-0123456789abcdef0123456789abcdef';
    const rawChunks = [
        `data: {"id":"${id}","choices":[{"index":0,"delta":{"content":"半"}}]}\n\n`,
        'data: {"error":{"type":"InternalServerError","code":"500","message":"學生的輸入"}}\n\n',
        'data: [DONE]\n\n',
    ];
    const headers = { 'x-request-id': 'req-header' };
    await withUpstream([{ rawChunks, headers }, { errorChunk: { type: 'X Y', code: 503 }, headers }], async (up) => {
        for (const expected of [[id, 'InternalServerError', '500'], ['req-header', undefined, '503']]) {
            await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
                assert.deepEqual([err.upstreamId, err.upstreamType, err.upstreamCode], expected);
                return true;
            });
        }
    });
});

test('收到標頭之後的其他錯誤（不是串流、閒置逾時）也帶著標頭的 request id', async () => {
    const headers = { 'x-request-id': 'req-after-headers' };
    await withUpstream([{ contentType: 'text/html', headers }, { thinking: ['想'], hangAfterChunks: 2, headers }], async (up) => {
        for (const code of ['protocol', 'timeout']) {
            await assert.rejects(streamChat(testConfig(up.origin, { idleTimeoutMs: 300 }), basicPayload()), (err) => {
                assert.equal(err.code, code);
                assert.equal(err.upstreamId, 'req-after-headers', code);
                return true;
            });
        }
    });
});

test('finish_reason 只收固定形狀的代號，其他換成 unknown（它會寫進錯誤訊息與 log）', async () => {
    for (const [raw, expected] of [['content_filter', 'content_filter'], ['stop 學生的輸入', 'unknown'], ['x'.repeat(65), 'unknown']]) {
        await withUpstream([{ content: ['半'], finish: raw }], async (up) => {
            assert.equal((await streamChat(testConfig(up.origin), basicPayload())).finishReason, expected, raw);
        });
    }
});

test('已經收到 finish_reason 之後才出錯：答案已完整，照樣回傳', async () => {
    const rawChunks = [
        'data: {"choices":[{"index":0,"delta":{"content":"完整答案"}}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"error":{"message":"late failure","code":500}}\n\n',
        'data: [DONE]\n\n',
    ];
    await withUpstream([{ rawChunks }], async (up) => {
        const r = await streamChat(testConfig(up.origin), basicPayload());
        assert.equal(r.content, '完整答案');
        assert.equal(r.finishReason, 'stop');
    });
});

test('收到 finish_reason 後上游卡住不送 usage：短暫等待後照樣回傳（usage 為 null）', async () => {
    await withUpstream([{ content: ['答'], finish: 'stop', hangAfterChunks: 3 }], async (up) => {
        const started = Date.now();
        const r = await streamChat(testConfig(up.origin, { idleTimeoutMs: 5_000, afterFinishIdleMs: 100 }), basicPayload());
        assert.equal(r.content, '答');
        assert.equal(r.usage, null);
        assert.ok(Date.now() - started < 2_000, '不該等滿閒置逾時');
    });
});

test('串流結束卻沒有 finish_reason（上游中途關閉）：錯誤，不能交出半截答案', async () => {
    await withUpstream([{ content: ['半截'], finish: null }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), { code: 'unavailable', retryable: true });
    });
});

test('連線在途中被切斷（已經收到部分正文）：可重試的 unavailable', async () => {
    await withUpstream([{ content: ['一', '二', '三', '四'], cutAfterChunks: 3 }], async (up) => {
        const received = [];
        await assert.rejects(
            streamChat(testConfig(up.origin), basicPayload(), { onContent: (t) => received.push(t) }),
            { code: 'unavailable', retryable: true },
        );
        assert.ok(received.length >= 1, '切斷前應該已經收到正文，否則測的不是「途中」');
    });
});

test('SSE：CRLF、CR、LF 混用，註解、BOM，事件被切在任意位置，中文字被切成兩半', async () => {
    const event = JSON.stringify({ choices: [{ index: 0, delta: { content: '中文' } }] });
    const whole = `\uFEFF: keep-alive\r\ndata: ${event}\r\n\r\ndata: x\rdata: y\r\rdata: [DONE]\n\n`;
    const bytes = Buffer.from(whole, 'utf8');
    for (const size of [1, 2, 3, 5, 7]) {
        const chunks = [];
        for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
        assert.deepEqual(await collect(chunks), [event, 'x\ny', '[DONE]'], `每 ${size} 位元組一塊`);
    }
});

test('SSE：CR 剛好在一塊的結尾、LF 在下一塊開頭，同一事件的多行 data 不能被拆開', async () => {
    assert.deepEqual(await collect([Buffer.from('data: {"a":\r'), Buffer.from('\ndata: 1}\r\n\r\n')]), ['{"a":\n1}']);
});

test('SSE：結尾沒有空行的事件依規格丟棄，不派送', async () => {
    assert.deepEqual(await collect([Buffer.from('data: complete\n\ndata: dangling')]), ['complete']);
    assert.deepEqual(await collect([Buffer.from('data: dangling\n')]), []);
});

test('SSE：只去掉冒號後的一個空白；沒有冒號的 data 行值為空字串；其他欄位忽略', async () => {
    assert.deepEqual(await collect([Buffer.from('data:  two\n\n')]), [' two']);
    assert.deepEqual(await collect([Buffer.from('data:nospace\n\n')]), ['nospace']);
    assert.deepEqual(await collect([Buffer.from('data\ndata: b\n\n')]), ['\nb']);
    assert.deepEqual(await collect([Buffer.from('event: x\nid: 1\nretry: 5\n\n')]), []);
});

test('SSE：EOF 時不完整的 UTF-8 不會變成例外', async () => {
    const half = Buffer.from('中', 'utf8').subarray(0, 2);
    assert.deepEqual(await collect([Buffer.from('data: ok\n\n'), half]), ['ok']);
});

test('SSE：一行超過上限（上游壞掉）時丟 protocol，不無限累積', async () => {
    async function* huge() {
        const block = Buffer.alloc(256 * 1024, 'a');
        yield Buffer.from('data: ');
        for (let i = 0; i < 6; i++) yield block;
    }
    await assert.rejects(collect(huge()), { code: 'protocol' });
});

test('真實串流經過 HTTP 被切成很多塊時也能正確組回（並確認真的收到了多塊）', async () => {
    const event = JSON.stringify({ choices: [{ index: 0, delta: { content: '高中生自主學習' } }] });
    const finish = JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    const whole = Buffer.from(`data: ${event}\n\ndata: ${finish}\n\ndata: [DONE]\n\n`, 'utf8');
    const rawChunks = [];
    for (let i = 0; i < whole.length; i += 5) rawChunks.push(whole.subarray(i, i + 5));
    await withUpstream([{ rawChunks }, { rawChunks }], async (up) => {
        // 先數一下用戶端實際收到幾塊，確定測的是「跨塊」而不是一次收完
        const res = await fetch(`${up.origin}/v1/chat/completions`, { method: 'POST', body: '{}' });
        let pieces = 0;
        for await (const piece of res.body) if (piece.byteLength) pieces++;
        assert.ok(pieces >= 5, `只收到 ${pieces} 塊`);

        const r = await streamChat(testConfig(up.origin), basicPayload());
        assert.equal(r.content, '高中生自主學習');
        assert.equal(r.finishReason, 'stop');
    });
});

test('連標頭都沒送：閒置逾時', async () => {
    await withUpstream([{ hangBeforeHeaders: true }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin, { idleTimeoutMs: 200 }), basicPayload()), { code: 'timeout', retryable: true });
    });
});

test('上游送了幾塊之後就沒聲音：閒置逾時', async () => {
    await withUpstream([{ thinking: ['a', 'b', 'c'], hangAfterChunks: 2 }], async (up) => {
        const started = Date.now();
        await assert.rejects(
            streamChat(testConfig(up.origin, { idleTimeoutMs: 300 }), basicPayload()),
            { code: 'timeout', retryable: true },
        );
        assert.ok(Date.now() - started < 5_000);
    });
});

test('一直有東西進來就不算閒置：總時間超過閒置門檻也不會被誤殺', async () => {
    const thinking = Array.from({ length: 8 }, (_, i) => `t${i}`);
    await withUpstream([{ thinking, content: ['完成'], chunkDelayMs: 100 }], async (up) => {
        const r = await streamChat(testConfig(up.origin, { idleTimeoutMs: 600 }), basicPayload());
        assert.equal(r.content, '完成');
    });
});

test('undici 自己的 headers／body 逾時歸類為 timeout（不是 unavailable）', async () => {
    for (const code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']) {
        const fetchImpl = async () => {
            throw new TypeError('fetch failed', { cause: Object.assign(new Error('timeout'), { code }) });
        };
        await assert.rejects(streamChat(testConfig('http://127.0.0.1:9'), basicPayload(), { fetchImpl }), { code: 'timeout', retryable: true });
    }
});

test('呼叫端取消：aborted，而且不是 timeout', async () => {
    await withUpstream([{ thinking: ['a', 'b'], hangAfterChunks: 1 }], async (up) => {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 100);
        await assert.rejects(
            streamChat(testConfig(up.origin, { idleTimeoutMs: 5_000 }), basicPayload(), { signal: ctrl.signal }),
            { code: 'aborted' },
        );
    });
});

test('回呼丟出的例外原樣丟回，不翻譯成「連不上 LLM 服務」', async () => {
    await withUpstream([{ content: ['a', 'b'] }], async (up) => {
        const boom = new TypeError('回呼壞了');
        await assert.rejects(
            streamChat(testConfig(up.origin), basicPayload(), { onContent: () => { throw boom; } }),
            (err) => err === boom,
        );
    });
});

test('回呼是 async 而且 reject：原樣丟回，不會讓程序崩潰', async () => {
    await withUpstream([{ content: ['a', 'b', 'c'], chunkDelayMs: 20 }], async (up) => {
        const boom = new Error('async 回呼壞了');
        await assert.rejects(
            streamChat(testConfig(up.origin), basicPayload(), { onContent: async () => { throw boom; } }),
            (err) => err === boom,
        );
    });
});

test('連不上：unavailable 且可重試，錯誤不掛原始 cause', async () => {
    const srv = createServer();
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const { port } = srv.address();
    await new Promise((r) => srv.close(r));
    await assert.rejects(streamChat(testConfig(`http://127.0.0.1:${port}`), basicPayload()), (err) => {
        assert.equal(err.code, 'unavailable');
        assert.equal(err.retryable, true);
        assert.match(err.message, /ECONNREFUSED/);
        assert.equal(err.cause, undefined);
        return true;
    });
});

test('每條路徑都不殘留計時器：子程序跑完各種收尾路徑後立刻退出（閒置設 60 秒）', () => {
    // 在同一個程序裡數全域計時器會被前一個測試留下的計時器干擾，所以開子程序：
    // 只要有計時器沒清掉，子程序就會撐到 60 秒才退出
    const upstreamUrl = new URL('../src/upstream.mjs', import.meta.url).href;
    const fakeUrl = new URL('./fake-upstream.mjs', import.meta.url).href;
    const script = `
        const { streamChat } = await import(${JSON.stringify(upstreamUrl)});
        const { startFakeUpstream, testConfig } = await import(${JSON.stringify(fakeUrl)});
        const up = await startFakeUpstream([{ content: ['ok'] }, { status: 500, body: 'x' }, { content: ['ok'], hangAfterChunks: 3 }]);
        const cfg = testConfig(up.origin, { idleTimeoutMs: 60000, afterFinishIdleMs: 200 });
        const payload = { messages: [{ role: 'user', content: 'x' }], maxTokens: 16, reasoningEffort: 'none' };
        await streamChat(cfg, payload);
        await streamChat(cfg, payload).catch(() => {});
        await streamChat(cfg, payload);
        await up.close();`;
    const started = Date.now();
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 30_000 });
    assert.equal(result.status, 0, String(result.stderr));
    assert.ok(Date.now() - started < 15_000, `子程序 ${Date.now() - started}ms 才退出：有計時器沒清掉`);
});

test('[DONE] 之後把串流讀到結束：連線放回連線池，之後的輪次不必重新連線', async () => {
    // 回應在 [DONE] 之後 50ms 才結束。收到 [DONE] 就中斷的話，每一輪都要重新連線（與 TLS 握手）。
    // 第一條連線不被重用是 undici 本身的行為（純 fetch 打最簡單的 Node 伺服器也一樣），
    // 所以斷言的是「之後不再增加」。收尾期限放寬：CPU 被搶時，200ms 的期限可能比那 50ms 先到，
    // 連線被中止，每一輪都得重新連線（2026-10-22 在負載高時重複跑整套測試，24 次裡遇過 1 次）
    const step = { content: ['ok'], endDelayMs: 50 };
    await withUpstream([step, step, step, step, step], async (up) => {
        const cfg = testConfig(up.origin, { idleTimeoutMs: 10_000, afterFinishIdleMs: 5_000 });
        for (let i = 0; i < 5; i++) await streamChat(cfg, basicPayload());
        assert.ok(up.connections <= 2, `5 輪用了 ${up.connections} 條連線`);
    });
});

test('redact：key 本身、JSON 跳脫、被控制字元切開的 key、Bearer、雜湊、內網位址、格式字元', () => {
    const key = 'sk-REALKEY-abc';
    assert.equal(redact(`token ${key} end`, { secrets: [key] }), 'token *** end');
    assert.equal(redact('{"m":"sk\\u002dESCAPED"}'), '{"m":"sk-***"}');
    assert.equal(redact('sk-ABC\u0007DEF tail'), 'sk-*** tail');
    assert.equal(redact('Authorization: Bearer eyJhbGciOi.payload.sig'), 'Authorization: Bearer ***');
    assert.equal(redact(`key_hash=${'f'.repeat(64)}`), 'key_hash=<hash>');
    assert.equal(redact('api_base http://10.1.2.3:8100/v1 and 192.168.0.5 and 172.20.1.1:80'), 'api_base http://<internal>/v1 and <internal> and <internal>');
    assert.equal(redact('a\u202Eb\u200Bc\nd'), 'abc d');
    assert.equal(redact('x'.repeat(600)).length, 500);
    assert.equal(redact(undefined), '');
});

test('錯誤內容是無止盡的串流：只讀一小段就放手', async () => {
    let sent = 0;
    await withServer(async (req, res) => {
        for await (const _ of req);
        res.writeHead(502, { 'content-type': 'text/plain' });
        const block = Buffer.alloc(64 * 1024, 'x');
        // 等 drain 或 close 其中一個；兩個 listener 都要拿掉，否則每一圈多留一個（MaxListenersExceededWarning）
        const writable = () => new Promise((resolve) => {
            const done = () => {
                res.off('drain', done);
                res.off('close', done);
                resolve();
            };
            res.on('drain', done);
            res.on('close', done);
        });
        while (!res.destroyed && sent < 256 * 1024 * 1024) {
            sent += block.length;
            if (!res.write(block)) await writable();
        }
    }, async (origin) => {
        await assert.rejects(streamChat(testConfig(origin, { idleTimeoutMs: 3_000 }), basicPayload()), { code: 'unavailable' });
        assert.ok(sent < 16 * 1024 * 1024, `伺服器送了 ${sent} bytes 才被放手`);
    });
});

test('錯誤內容讀到上限後就取消，連線不會一直掛著', async () => {
    let closed = false;
    await withServer(async (req, res) => {
        for await (const _ of req);
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.write(Buffer.alloc(32 * 1024, 'y'));
        res.socket.on('close', () => { closed = true; });
    }, async (origin) => {
        await assert.rejects(streamChat(testConfig(origin), basicPayload()), { code: 'unavailable' });
        for (let i = 0; i < 40 && !closed; i++) await sleepMs(25);
        assert.ok(closed, '錯誤內容沒有被取消');
    });
});

test('收到標頭後重新計時閒置：標頭在 600ms、內容在 1200ms、閒置 1000ms 不該逾時', async () => {
    await withServer(async (req, res) => {
        for await (const _ of req);
        await sleepMs(600);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        await sleepMs(600);
        res.end(`${finishChunk}data: [DONE]\n\n`);
    }, async (origin) => {
        const r = await streamChat(testConfig(origin, { idleTimeoutMs: 1_000 }), basicPayload());
        assert.equal(r.content, 'ok');
    });
});

test('收尾期限是固定的：收到 finish_reason 後上游持續送心跳也不會延後，答案照樣交出', async () => {
    await withServer(async (req, res) => {
        for await (const _ of req);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(finishChunk);
        const timer = setInterval(() => { if (!res.destroyed) res.write(': ping\n\n'); }, 50);
        res.on('close', () => clearInterval(timer));
    }, async (origin) => {
        const started = Date.now();
        const r = await streamChat(testConfig(origin, { idleTimeoutMs: 5_000, afterFinishIdleMs: 300 }), basicPayload());
        assert.equal(r.content, 'ok');
        assert.ok(Date.now() - started < 2_000, `等了 ${Date.now() - started}ms`);
    });
});

test('收到 [DONE] 卻沒有結束原因、上游也不關連線：很快以「沒有給結束原因」失敗，不等滿閒置逾時', async () => {
    await withServer(async (req, res) => {
        for await (const _ of req);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"半"}}]}\n\ndata: [DONE]\n\n');
    }, async (origin) => {
        const started = Date.now();
        await assert.rejects(
            streamChat(testConfig(origin, { idleTimeoutMs: 5_000, afterFinishIdleMs: 300 }), basicPayload()),
            (err) => {
                assert.equal(err.code, 'unavailable');
                assert.match(err.message, /沒有給結束原因/);
                return true;
            },
        );
        assert.ok(Date.now() - started < 2_000);
    });
});

test('[DONE] 之後的事件一律不理', async () => {
    const rawChunks = [finishChunk, 'data: [DONE]\n\n', 'data: {"choices":[{"index":0,"delta":{"content":"EXTRA"}}]}\n\n'];
    await withUpstream([{ rawChunks }], async (up) => {
        assert.equal((await streamChat(testConfig(up.origin), basicPayload())).content, 'ok');
    });
});

test('串流途中的 error 物件 code 是 null（OpenAI 格式常見）：unavailable、可重試、不帶 status', async () => {
    await withUpstream([{ content: ['半'], errorChunk: { message: 'x', code: null } }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.code, 'unavailable');
            assert.equal(err.retryable, true);
            assert.equal(err.status, undefined);
            return true;
        });
    });
});

test('回呼丟出 undefined 這種假值：一樣原樣丟回（不是「連不上」），在結束那塊丟出也不會被吞掉', async () => {
    for (const rawChunks of [
        ['data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n', finishChunk, 'data: [DONE]\n\n'],
        [finishChunk, 'data: [DONE]\n\n'],
    ]) {
        await withUpstream([{ rawChunks }], async (up) => {
            let caught = 'not thrown';
            try {
                await streamChat(testConfig(up.origin), basicPayload(), { onContent: () => { throw undefined; } });
            } catch (err) {
                caught = err;
            }
            assert.equal(caught, undefined);
        });
    }
});

test('async 回呼以 undefined reject：原樣丟回並中止串流', async () => {
    await withUpstream([{ content: ['a', 'b', 'c'], chunkDelayMs: 20 }], async (up) => {
        let caught = 'not thrown';
        try {
            await streamChat(testConfig(up.origin), basicPayload(), { onContent: async () => { throw undefined; } });
        } catch (err) {
            caught = err;
        }
        assert.equal(caught, undefined);
    });
});

test('本地序列化失敗（例如循環參照）：直接丟出原本的錯誤，不是可重試的網路錯誤，也不發請求', async () => {
    const circular = { type: 'json_object' };
    circular.self = circular;
    await withUpstream([{ content: ['不該被呼叫'] }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload({ responseFormat: circular })), TypeError);
        assert.equal(up.requests.length, 0);
    });
});

test('200 但不是 SSE、讀內容時呼叫端取消：回報 aborted', async () => {
    await withUpstream([{ rawChunks: ['{"choices":[]}'], contentType: 'application/json' }], async (up) => {
        const ctrl = new AbortController();
        const fetchImpl = async (url, init) => {
            const res = await fetch(url, init);
            ctrl.abort();
            return res;
        };
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload(), { signal: ctrl.signal, fetchImpl }), { code: 'aborted' });
    });
});

test('reasoning_content 是空字串時退回讀 reasoning', async () => {
    const rawChunks = [
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"","reasoning":"想"}}]}\n\n',
        finishChunk,
        'data: [DONE]\n\n',
    ];
    await withUpstream([{ rawChunks }], async (up) => {
        assert.equal((await streamChat(testConfig(up.origin), basicPayload())).reasoning, '想');
    });
});

test('SSE：一直送 data 行卻不給空行（事件不結束）：超過上限丟 protocol，不無限累積', async () => {
    async function* endless() {
        const lines = Buffer.from('data: abcdefghijklmnopqrstuvwxyz\n'.repeat(4096));
        for (let i = 0; i < 64; i++) yield lines;
    }
    await assert.rejects(collect(endless()), { code: 'protocol' });
});

test('SSE：接近上限的長行切成很多小塊送來也很快（殘行不會一再重掃）', async () => {
    async function* chunks() {
        yield Buffer.from('data: ');
        const block = Buffer.alloc(64, 'a');
        for (let i = 0; i < (900 * 1024) / 64; i++) yield block;
        yield Buffer.from('\n\n');
    }
    const started = Date.now();
    const events = await collect(chunks());
    assert.equal(events.length, 1);
    assert.equal(events[0].length, 900 * 1024);
    assert.ok(Date.now() - started < 1_500, `花了 ${Date.now() - started}ms`);
});

test('redact：含數字與大寫的雜湊、小寫 bearer、黏在底線後的雜湊都要遮掉', () => {
    assert.equal(redact(`key_hash=${'0123456789abcdef'.repeat(4)}`), 'key_hash=<hash>');
    assert.equal(redact(`hash ${'0123456789ABCDEF'.repeat(2)}`), 'hash <hash>');
    assert.equal(redact(`key_hash_${'ab12'.repeat(10)}`), 'key_hash_<hash>');
    assert.equal(redact('authorization: bearer abc.def-ghi'), 'authorization: Bearer ***');
});

test('redact：JSON 字串裡被控制字元切開的 key、URL 編碼與 base64 的 key 也要遮掉', () => {
    assert.equal(redact('{"m":"sk-ABC\\u0007DEF tail"}'), '{"m":"sk-*** tail"}');
    const key = 'sk-REAL/KEY+1';
    assert.doesNotMatch(redact(`a ${encodeURIComponent(key)} b`, { secrets: [key] }), /REAL/);
    assert.doesNotMatch(redact(`a ${Buffer.from(key).toString('base64')} b`, { secrets: [key] }), /c2st/);
});

test('redact：IPv6 迴路／ULA／link-local、169.254、叢集與內部網域名稱都換成 <internal>', () => {
    assert.equal(redact('at [fd12:3456::1]:8100 and fe80::1 and ::1'), 'at <internal> and <internal> and <internal>');
    assert.equal(redact('meta 169.254.169.254:80'), 'meta <internal>');
    assert.equal(redact('llm.ns.svc.cluster.local:4000 and api.corp.internal'), '<internal> and <internal>');
});

test('Retry-After：格式對但日期不存在時當成沒給', () => {
    assert.equal(parseRetryAfter('Wed, 99 Oct 2026 00:00:30 GMT'), undefined);
});

test('redact：會讓正規表示式回溯的長輸入也在線性時間內完成（不會卡住事件迴圈）', () => {
    const inputs = [
        'a.'.repeat(512 * 1024), 'a-'.repeat(512 * 1024), '1.'.repeat(512 * 1024), 'fc00:'.repeat(200_000),
        'a@'.repeat(512 * 1024), 'x'.repeat(1024 * 1024), `bearer${' '.repeat(1024 * 1024)}!`, 'f'.repeat(1024 * 1024),
    ];
    for (const input of inputs) {
        const started = performance.now();
        redact(input, { secrets: ['sk-AbCdEfGhIjKlMnOpQrStUv'] });
        const ms = performance.now() - started;
        assert.ok(ms < 1_000, `${JSON.stringify(input.slice(0, 12))}… 花了 ${ms.toFixed(0)}ms`);
    }
});

test('redact：被 JSON 短跳脫（\\b \\f）、Python 的 \\x07、兩層 JSON 或被截斷的 JSON 裡的跳脫切開的 key，都接回來再遮', () => {
    const key = 'sk-AbCdEfGhIjKlMnOpQrStUv';
    const split = (sep) => `${key.slice(0, 10)}${sep}${key.slice(10)}`;
    assert.equal(redact(`{"m":"${split('\\b')}"}`), '{"m":"sk-***"}');
    assert.equal(redact(`{"m":"${split('\\f')}"}`), '{"m":"sk-***"}');
    assert.equal(redact(`'${split('\\x07')}'`), "'sk-***'");
    // LiteLLM 把內層錯誤整段序列化成字串再包一層（甚至兩層）：每多一層，跳脫就多一道
    const inner = JSON.stringify({ error: { message: split('\u0007') } });
    const twice = JSON.stringify({ error: { message: inner } });
    assert.doesNotMatch(redact(twice), /hIjKl/);
    assert.doesNotMatch(redact(JSON.stringify({ detail: twice })), /hIjKl/);
    // 超過 8 KiB 被截斷、已經不是合法 JSON
    assert.doesNotMatch(redact(`{"m":"${'x'.repeat(50)} ${split('\\u0008')} ...`), /hIjKl/);
});

test('redact：key 的各種寫法——base64 三種對齊、base64url、十六進位、JSON 跳脫、被空白或換行切開——都遮掉', () => {
    const key = 'WlKeyZ9yX8wV7uT6sR5qP4oN';
    const b64 = (text) => Buffer.from(text).toString('base64');
    const hex = Buffer.from(key).toString('hex');
    const cases = [
        [`blob ${b64(key)} end`, b64(key).slice(4, 24)],
        [`Authorization: Basic ${b64(`:${key}`)}`, b64(`:${key}`).slice(4, 24)],
        [`x ${b64(`u:${key}`)}`, b64(`u:${key}`).slice(4, 24)],
        [`x ${b64(key).replaceAll('+', '-').replaceAll('/', '_')}`, b64(key).slice(4, 24)],
        [`hex=${hex}`, hex.slice(4, 30)],
        [`HEX=${hex.toUpperCase()}`, hex.toUpperCase().slice(4, 30)],
        [`key=${key.slice(0, 12)} ${key.slice(12)}`, 'sR5qP'],
        [`key=${key.slice(0, 12)}\n${key.slice(12)}`, 'sR5qP'],
    ];
    for (const [input, fragment] of cases) {
        assert.ok(!redact(input, { secrets: [key] }).includes(fragment), input);
    }
    const quoted = 'ab"cdEFGH1234';
    assert.equal(redact(JSON.stringify({ m: quoted }), { secrets: [quoted] }), '{"m":"***"}');
});

test('redact：URL 編碼（含小寫 %xx）的 key 也遮掉——key 不是 sk- 開頭時只能靠這一步', () => {
    const key = 'Ab+Cd/Ef=Gh~Ij*KlMn';
    const encoded = encodeURIComponent(key);
    assert.notEqual(encoded, key);
    for (const form of [encoded, encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())]) {
        assert.doesNotMatch(redact(`?k=${form}&x=1`, { secrets: [key] }), /Ij|KlMn/, form);
    }
});

test('redact：JSON 值裡的控制字元拿掉、換行與 tab 變成空白（不會留下 \\u0007 或 \\n 這類跳脫）', () => {
    assert.equal(redact('{"m":"a\\u0007b\\u001fc\\nd\\te"}'), '{"m":"abc d e"}');
});

test('redact：內部位址（k8s 短名、Tailscale、家用網域、localhost、IPv6 zone id、CGNAT、私有網段邊界）換成 <internal>', () => {
    const cases = [
        ['api_base=http://vllm-qwen.vllm.svc:8000/v1', 'api_base=http://<internal>/v1'],
        ['api_base=http://vllm-qwen.vllm:8000/v1', 'api_base=http://<internal>/v1'],
        ['connect to litellm-proxy:4000 failed', 'connect to <internal> failed'],
        ['host gpu01.tail1a2b3c.ts.net:8000', 'host <internal>'],
        ['nas.home.arpa:5000 and box.localdomain', '<internal> and <internal>'],
        ['http://localhost:4000/v1', 'http://<internal>/v1'],
        ['[fe80::1%25eth0]:8000', '<internal>'],
        ['fd7a:115c:a1e0::1234', '<internal>'],
        ['fd00::1 and fc00::1', '<internal> and <internal>'],
        ['127.0.0.1 and 127.255.255.254', '<internal> and <internal>'],
        ['100.64.0.1 100.127.255.255', '<internal> <internal>'],
        ['172.16.0.1 172.31.255.255', '<internal> <internal>'],
        // 句尾的句點不是名稱的一部分：名稱照樣遮掉，句點留著。
        ['failed to reach api.corp.internal.', 'failed to reach <internal>.'],
        ['refused by localhost. retrying', 'refused by <internal>. retrying'],
        ['x.svc.cluster.local:4000.', '<internal>.'],
        // CGNAT 的每一段（100.64–127）、兩位數與五位數的 port、名稱裡有數字、IPv6 每組都有內容
        ['100.69.1.1 100.70.0.1 100.99.0.1 100.100.0.1 100.110.0.1 100.119.0.1 100.120.0.1', Array(7).fill('<internal>').join(' ')],
        ['svc-a:80 and vllm.ns:80 and node2-gpu:65535', '<internal> and <internal> and <internal>'],
        ['fe80::a1b2:c3d4 and fd12::ab:cd', '<internal> and <internal>'],
        // 網址裡只有一段的主機名稱、StatefulSet 的三段式短名、IP 範圍的第一個位址
        ['api_base=http://vllm:8000/v1 and see http://gpu01 now', 'api_base=http://<internal>/v1 and see http://<internal> now'],
        // 網址裡的帳密先遮掉，後面的主機名稱照樣認得出來
        ['api_base=http://user:pass@vllm:8000/v1', 'api_base=http://***@<internal>/v1'],
        ['https://admin@llm.example.edu/v1', 'https://***@llm.example.edu/v1'],
        ['vllm-0.vllm-headless.vllm:8000', '<internal>'],
        ['range 10.0.0.1-10.0.0.255', 'range <internal>-<internal>'],
    ];
    for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
});

test('redact：不是內部位址或 key 的不要誤遮（時間、版本號、程式碼、公開網域、請求 id、一般單字）', () => {
    for (const text of [
        'deadline Feb1:30 exceeded',
        'cafe80:1 checksum',
        'vLLM version 10.1.2.3-dev',
        'std::1 overload',
        'version 1.10.1.2.3',
        '100.63.255.255 100.128.0.1 172.15.255.255 172.32.0.1',
        'see https://example.com:443/x and llm.winlab.tw',
        'error code:400',
        'request chatcmpl-0123456789abcdef0123456789abcdef',
        'disk-full task-queue Flask-RESTful',
        'docs.internal.com and lan.example.org',
        // 不完整或多一位數的 IPv4、只有一個冒號或一組超過四位的 IPv6
        '10.1..3 and 10.1.2.3456',
        'fdab:1234 and fe80:12345::1',
        // LiteLLM 的例外名稱與標頭名稱後面接冒號但不是 port；六位數不是 port
        'litellm.BadRequestError: OpenAIException - x-request-id: abc',
        'name-x:123456 and a.b:123456',
        // 請求 id 比 32 位長也一樣不遮；sk- 前面黏著英數字的不是 key
        'request chatcmpl-0123456789abcdef0123456789abcdef0123',
        'id 2sk-3',
        // 多一段數字的是版本號；公開網域帶 port；traceback 的檔名與行號；套件版本；模型名稱
        'build 10.1.2.3.4',
        'winlab.tw:443 and llm.winlab.tw:443',
        'File "proxy_server.py:3421" at server.js:120:15',
        'react@18.3.1 and model gpt-4:32k',
    ]) {
        assert.equal(redact(text), text, text);
    }
});

test('redact：LiteLLM 額度錯誤裡的 email 遮掉', () => {
    assert.equal(redact('Max budget: 10.0 user=student.name+tag@example.edu.tw'), 'Max budget: 10.0 user=<email>');
});

test('SSE：CR 在一塊的結尾、接著一個空塊、LF 在下一塊開頭：仍是同一個 CRLF', async () => {
    async function* chunks() {
        yield Buffer.from('data: a\r');
        yield Buffer.alloc(0);
        yield Buffer.from('\ndata: b\n\n');
    }
    assert.deepEqual(await collect(chunks()), ['a\nb']);
});

test('SSE：很多事件各被切成兩塊送來：殘行的長度每一行都重新計算，不會累積到誤判超長', async () => {
    async function* chunks() {
        const first = Buffer.from(`data: ${'x'.repeat(94)}`);
        const second = Buffer.from(`${'y'.repeat(50)}\n\n`);
        for (let i = 0; i < 12_000; i++) {
            yield first;
            yield second;
        }
    }
    assert.equal((await collect(chunks())).length, 12_000);
});

test('vLLM 只帶 usage 的那塊是 choices: []：照收 usage，不會出錯', async () => {
    const rawChunks = [finishChunk, 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n', 'data: [DONE]\n\n'];
    await withUpstream([{ rawChunks }], async (up) => {
        assert.deepEqual((await streamChat(testConfig(up.origin), basicPayload())).usage, { prompt_tokens: 5, completion_tokens: 1 });
    });
});

test('choices: [] 的一塊出現在正文之前：略過它，後面的正文照收', async () => {
    const rawChunks = ['data: {"choices":[]}\n\n', finishChunk, 'data: [DONE]\n\n'];
    await withUpstream([{ rawChunks }], async (up) => {
        const r = await streamChat(testConfig(up.origin), basicPayload());
        assert.equal(r.content, 'ok');
        assert.equal(r.finishReason, 'stop');
    });
});

test('收到 finish_reason 之後的 error 物件不影響結果，之後的 usage 照收', async () => {
    const rawChunks = [
        finishChunk,
        'data: {"error":{"message":"late","code":500}}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
        'data: [DONE]\n\n',
    ];
    await withUpstream([{ rawChunks }], async (up) => {
        const r = await streamChat(testConfig(up.origin), basicPayload());
        assert.equal(r.content, 'ok');
        assert.deepEqual(r.usage, { prompt_tokens: 5, completion_tokens: 1 });
    });
});

test('串流途中的 error 物件巢狀很深（JSON.stringify 會丟 RangeError）：照樣依 code 分類，不變成「連不上」', async () => {
    const depth = 100_000;
    const error = `{"code":429,"inner":${'{"inner":'.repeat(depth)}{}${'}'.repeat(depth)}}`;
    await withUpstream([{ rawChunks: [`data: {"error":${error}}\n\n`, 'data: [DONE]\n\n'] }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.code, 'busy');
            assert.ok(err.detail.length > 0);
            return true;
        });
    });
});

test('收到 [DONE] 卻沒有結束原因、收尾期間呼叫端取消：回報 aborted（不是可重試的 unavailable）', async () => {
    await withServer(async (req, res) => {
        for await (const _ of req);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"index":0,"delta":{"content":"半"}}]}\n\ndata: [DONE]\n\n');
    }, async (origin) => {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 100);
        await assert.rejects(
            streamChat(testConfig(origin, { idleTimeoutMs: 5_000, afterFinishIdleMs: 2_000 }), basicPayload(), { signal: ctrl.signal }),
            { code: 'aborted' },
        );
    });
});

test('收到 [DONE] 卻沒有結束原因：可重試的 unavailable', async () => {
    await withUpstream([{ rawChunks: ['data: {"choices":[{"index":0,"delta":{"content":"半"}}]}\n\n', 'data: [DONE]\n\n'] }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.code, 'unavailable');
            assert.equal(err.retryable, true);
            return true;
        });
    });
});

test('回呼回傳的 thenable 在讀 then 時就丟例外：原樣丟回，不翻譯成「連不上」', async () => {
    const boom = new Error('then getter 壞了');
    const evil = { get then() { throw boom; } };
    await withUpstream([{ content: ['a', 'b'] }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload(), { onContent: () => evil }), (err) => err === boom);
    });
});

test('async 回呼 reject 時立刻中止上游（不讓 GPU 替已經離開的使用者繼續生成）', async () => {
    let sent = 0;
    let closed = false;
    await withServer(async (req, res) => {
        for await (const _ of req);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.on('close', () => { closed = true; });
        for (let i = 0; i < 60 && !res.destroyed; i++) {
            res.write(`data: {"choices":[{"index":0,"delta":{"content":"${i}"}}]}\n\n`);
            sent++;
            await sleepMs(20);
        }
        res.end();
    }, async (origin) => {
        await assert.rejects(
            streamChat(testConfig(origin), basicPayload(), { onContent: async () => { throw new Error('使用者離開了'); } }),
            /使用者離開了/,
        );
        for (let i = 0; i < 40 && !closed; i++) await sleepMs(25);
        assert.ok(closed, '上游連線沒有被中止');
        assert.ok(sent < 15, `上游送了 ${sent} 塊才被中止`);
    });
});

test('收尾期限的正式預設是 5 秒：收到 finish_reason 後上游不送 usage 也不關，5 秒後照樣交出答案', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cfg = testConfig('http://upstream.invalid', { idleTimeoutMs: 60_000 });
    delete cfg.afterFinishIdleMs;
    const fetchImpl = async (url, init) => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(finishChunk));
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
        },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    let settled = false;
    const done = streamChat(cfg, basicPayload(), { fetchImpl }).finally(() => { settled = true; });
    const turn = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
    await turn();
    t.mock.timers.tick(4_999);
    await turn();
    assert.equal(settled, false, '4999ms 時還在等');
    t.mock.timers.tick(1);
    const r = await done;
    assert.equal(r.content, 'ok');
    assert.equal(r.usage, null);
});

test('Retry-After：HTTP-date 的三種格式都收（RFC 9110：IMF-fixdate、RFC 850、asctime），一律當 UTC', () => {
    const now = Date.UTC(2026, 9, 21, 0, 0, 0);
    assert.equal(parseRetryAfter('Wed, 21 Oct 2026 00:00:30 GMT', now), 30);
    assert.equal(parseRetryAfter('Wednesday, 21-Oct-26 00:01:00 GMT', now), 60);
    assert.equal(parseRetryAfter('Wed Oct 21 00:00:45 2026', now), 45);
    assert.equal(parseRetryAfter('Wed Oct  1 00:00:45 2026', now), 0);
    // 兩位數的年：看起來在 50 年以後的當成上一個世紀
    assert.equal(parseRetryAfter('Sunday, 06-Nov-94 08:49:37 GMT', now), 0);
    for (const bad of ['Wed, 31 Feb 2026 00:00:30 GMT', 'Wed, 21 Oct 2026 24:00:00 GMT', 'Wed Oct 21 00:00:45 26', '2026-10-21T00:00:30Z', '1.5', '0x10', 'Wed, 21 Oct 2026 00:00:30 UTC']) {
        assert.equal(parseRetryAfter(bad, now), undefined, bad);
    }
});

test('上游設定被拒絕（null）：misconfigured，訊息指向啟動時的警告，不發請求', async () => {
    await assert.rejects(streamChat(testConfig(null), basicPayload()), (err) => {
        assert.equal(err.code, 'misconfigured');
        assert.match(err.message, /啟動時的警告/);
        return true;
    });
});

test('UpstreamError 的 name 是 UpstreamError；沒說能不能重試就是不能', () => {
    assert.equal(new UpstreamError('busy', 'x').name, 'UpstreamError');
    assert.equal(new UpstreamError('protocol', 'x').retryable, false);
});

test('redact：base64 裡的 key 只留下混著前後位元組的字元（三種對齊、key 後面還有資料、base64url）', () => {
    const key = 'Ab>>>Cd???Ef>>>Gh???Ij'; // 編出來的中段有 + 與 /，base64url 的寫法才不一樣
    // [前綴, 混著前綴的字元數, key 的中段結束的位置]：22 個位元組的 key
    for (const [prefix, head, end] of [['', 0, 28], [':', 2, 28], ['u:', 3, 32]]) {
        const standard = Buffer.from(`${prefix}${key}@tail`).toString('base64');
        assert.match(standard.slice(head, end), /\+.*\/|\/.*\+/);
        for (const encoded of [standard, standard.replaceAll('+', '-').replaceAll('/', '_')]) {
            const expected = `x ${encoded.slice(0, head)}***${encoded.slice(end)} y`;
            assert.equal(redact(`x ${encoded} y`, { secrets: [key] }), expected, `${prefix}|${encoded}`);
        }
    }
});

test('redact：base64 的中段不到 8 個字元就不拿來比（短片段到處都是）；剛好 8 個就遮', () => {
    assert.equal(redact('id YWJjZGU= x', { secrets: ['abcde'] }), 'id YWJjZGU= x');
    assert.equal(redact('id YWJjZGVm x', { secrets: ['abcdef'] }), 'id *** x');
});

test('redact：被空白切開的 key 至少 8 個字元才比對；空的 secret 跳過，不影響後面的', () => {
    assert.equal(redact('k=abcd efgh', { secrets: ['abcdefgh'] }), 'k=***');
    assert.equal(redact('k=abcd efg', { secrets: ['abcdefg'] }), 'k=abcd efg');
    assert.equal(redact('a KEY123456 b', { secrets: [undefined, '', 'KEY123456'] }), 'a *** b');
});

test('redact：不是 JSON 的文字裡的 \\uXXXX、\\xXX、\\n 也還原，最多三層', () => {
    assert.equal(redact('token \\u0073k-AbCdEfGhIjKlMnOp end'), 'token sk-*** end');
    assert.equal(redact('repr \\x73k-AbCdEfGhIjKlMnOp'), 'repr sk-***');
    assert.equal(redact('line1\\nline2\\tx'), 'line1 line2 x');
    // 三層：\\\\u0073 → \\u0073 → \u0073 → s
    assert.equal(redact('k=\\\\\\\\u0073k-AbCdEfGhIjKlMnOp'), 'k=sk-***');
});

test('redact：JSON 裡的陣列、數字、布林、null 原樣保留', () => {
    assert.equal(redact('{"n":5,"b":true,"z":null,"a":["x\\u0007y",1]}'), '{"n":5,"b":true,"z":null,"a":["xy",1]}');
});

test('redact：連續空白（含全形空白與 U+2028）縮成一個、頭尾去掉；不是字串的輸入照樣轉成字串', () => {
    assert.equal(redact('  a \u3000\u2028  b  '), 'a b');
    assert.equal(redact(0), '0');
    assert.equal(redact(null), '');
    assert.equal(redact(undefined), '');
});

test('redact：輸入先截到 64 KiB，被截斷時尾端再丟 256 字；剛好 64 KiB 不算截斷（limit 放寬時看得出來）', () => {
    assert.equal(redact('x'.repeat(70_000), { limit: Infinity }).length, 64 * 1024 - 256);
    assert.equal(redact('x'.repeat(64 * 1024), { limit: Infinity }).length, 64 * 1024);
    assert.equal(redact(`abc${'x'.repeat(300)}`, { truncated: true, limit: Infinity }).length, 303 - 256);
    assert.equal(redact('abc', { truncated: true }), '');
});

test('UpstreamError：有給 cause 才帶 cause', () => {
    const cause = new Error('inner');
    assert.equal(new UpstreamError('network', 'x', { cause }).cause, cause);
    assert.equal('cause' in new UpstreamError('network', 'x'), false);
});

test('Retry-After：時分秒超出範圍不收；閏秒 23:59:60 當成 :59；RFC 850 的兩位數年以 50 年為界', () => {
    const now = Date.UTC(2026, 9, 20, 23, 59, 0);
    assert.equal(parseRetryAfter('Tue, 20 Oct 2026 23:59:60 GMT', now), 59);
    for (const bad of ['Tue, 20 Oct 2026 10:60:00 GMT', 'Tue, 20 Oct 2026 10:00:61 GMT', 'Mon, 30 Feb 2026 00:00:00 GMT']) {
        assert.equal(parseRetryAfter(bad, now), undefined, bad);
    }
    // 2076 年不算「50 年以後」，照字面（遠在一天之後，夾到上限）；2077 年算，改成 1977 年
    assert.equal(parseRetryAfter('Thursday, 01-Jan-76 00:00:00 GMT', now), 86_400);
    assert.equal(parseRetryAfter('Friday, 01-Jan-77 00:00:00 GMT', now), 0);
    assert.equal(parseRetryAfter(' 30 ', now), 30);
});

test('SSE：一行與一個事件的上限都剛好是 1 MiB 字元（等於上限可以，多一個字元就是 protocol）', async () => {
    const MAX = 1024 * 1024;
    // 殘行：還沒遇到行尾的部分
    async function* partialLine(n) {
        yield Buffer.from(`data: ${'x'.repeat(n - 6)}`);
        yield Buffer.from('\n\n');
    }
    assert.equal((await collect(partialLine(MAX)))[0].length, MAX - 6);
    await assert.rejects(collect(partialLine(MAX + 1)), (err) => err.code === 'protocol' && /一行/.test(err.message));
    // 一個事件的 data：整行在同一塊裡，不經過殘行
    async function* event(n) {
        yield Buffer.from(`data: ${'y'.repeat(n)}\n\n`);
    }
    assert.equal((await collect(event(MAX)))[0].length, MAX);
    await assert.rejects(collect(event(MAX + 1)), (err) => err.code === 'protocol' && /事件/.test(err.message));
});

test('錯誤內容只讀前 8 KiB 時，切在 key 中間的殘段不會進 log（截斷時丟掉尾端）', async () => {
    const key = 'WlKeyZ9yX8wV7uT6sR5qP4oN'; // 不是 sk- 開頭，沒有通用規則兜底
    const body = `${' '.repeat(8192 - 10)}${key} tail`;
    await withUpstream([{ status: 500, body }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin, { apiKey: key }), basicPayload()), (err) => {
            assert.equal(err.code, 'unavailable');
            assert.doesNotMatch(err.detail, /WlKey/);
            return true;
        });
    });
    // 分成很多小塊送來：讀到的總量（而不是最後一塊）到了上限就停，並且算成截斷
    await withServer(async (req, res) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        for (let i = 0; i < body.length; i += 512) {
            res.write(body.slice(i, i + 512));
            await new Promise((resolve) => setImmediate(resolve));
        }
        res.end();
    }, async (origin) => {
        await assert.rejects(streamChat(testConfig(origin, { apiKey: key }), basicPayload()), (err) => {
            assert.doesNotMatch(err.detail, /WlKey/);
            return true;
        });
    });
});

test('錯誤內容的截斷界線：8191 位元組讀完不算截斷，剛好 8192 位元組就算（後面可能還有）', async () => {
    const tail = 'MARKER';
    const steps = [
        { status: 500, body: `${' '.repeat(8191 - tail.length)}${tail}` },
        { status: 500, body: `${' '.repeat(8192 - tail.length)}${tail}` },
    ];
    await withUpstream(steps, async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.detail, tail);
            return true;
        });
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.detail, '');
            return true;
        });
    });
});

test('錯誤內容：剛好 8 KiB 之後的內容不讀；讀到的部分原樣（遮罩後）放進 detail', async () => {
    await withUpstream([{ status: 500, body: `${' '.repeat(8192)}MARKER` }, { status: 500, body: '{"error":"boom"}' }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.doesNotMatch(err.detail, /MARKER/);
            return true;
        });
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.detail, '{"error":"boom"}');
            return true;
        });
    });
});

test('錯誤內容慢慢滴：用收尾期限，不必等滿閒置逾時才回報', async () => {
    await withServer((req, res) => {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.write('{"error":');
        const timer = setInterval(() => res.write(' '), 50);
        res.on('close', () => clearInterval(timer));
    }, async (origin) => {
        const started = performance.now();
        await assert.rejects(streamChat(testConfig(origin, { idleTimeoutMs: 2_000, afterFinishIdleMs: 200 }), basicPayload()), { code: 'unavailable', status: 503 });
        const ms = performance.now() - started;
        assert.ok(ms < 1_500, `花了 ${ms.toFixed(0)}ms`);
    });
});

test('redact：被 \\b、\\f 切開的 key 在兩層 JSON 裡也接回來（還原成控制字元再拿掉，而不是變成空白）', () => {
    const key = 'sk-AbCdEfGhIjKlMnOpQrStUv';
    for (const sep of ['\b', '\f']) {
        const inner = JSON.stringify({ error: { message: `${key.slice(0, 13)}${sep}${key.slice(13)}` } });
        const twice = JSON.stringify({ error: { message: inner } });
        assert.doesNotMatch(redact(twice), /KlMn|OpQr/, JSON.stringify(sep));
    }
});

test('redact：只屬於格式字元或只屬於預設可忽略字元的看不見字元，都會被拿掉', () => {
    // U+034F、U+FE0F、U+3164 只是預設可忽略；U+0600、U+FFF9 只是格式字元
    for (const ch of ['\u034F', '\uFE0F', '\u3164', '\u0600', '\uFFF9']) {
        assert.equal(redact(`sk-AbCdEf${ch}GhIjKl tail`), 'sk-*** tail', `U+${ch.codePointAt(0).toString(16)}`);
    }
});

test('redact：JSON 物件的鍵也還原跳脫、清掉看不見的字元', () => {
    assert.equal(redact('{"sk-AbC\\\\u0007DefGhIjKl":1}'), '{"sk-***":1}');
});

test('redact：短 key 的十六進位寫法（大小寫）也遮——不到 32 位，通用的雜湊規則兜不住', () => {
    const key = 'WlKey9';
    const hex = Buffer.from(key).toString('hex');
    assert.equal(redact(`h=${hex} H=${hex.toUpperCase()}`, { secrets: [key] }), 'h=*** H=***');
});

test('串流：先到的 finish_reason 為準，後面的不能蓋掉', async () => {
    const rawChunks = [
        'data: {"choices":[{"index":0,"delta":{"content":"a"},"finish_reason":"length"}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
    ];
    await withUpstream([{ rawChunks }], async (up) => {
        assert.equal((await streamChat(testConfig(up.origin), basicPayload())).finishReason, 'length');
    });
});

test('串流中的 error：code 不是 4xx／5xx 時不當成 HTTP 狀態（一律 unavailable、可重試），599 仍是', async () => {
    for (const [code, status] of [[200, undefined], [302, undefined], [600, undefined], [599, 599]]) {
        const rawChunks = [`data: {"error":{"message":"x","code":${code}}}\n\n`, 'data: [DONE]\n\n'];
        await withUpstream([{ rawChunks }], async (up) => {
            await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
                assert.equal(err.code, 'unavailable', String(code));
                assert.equal(err.retryable, true, String(code));
                assert.equal(err.status, status, String(code));
                return true;
            });
        });
    }
});

test('連線錯誤的代號：undici 放在 cause 裡的、錯誤本身的 code、都沒有時用錯誤名稱', async () => {
    const cases = [
        [Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }), 'timeout', /UND_ERR_HEADERS_TIMEOUT/],
        [Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }), 'unavailable', /ECONNREFUSED/],
        [new TypeError('fetch failed'), 'unavailable', /TypeError/],
    ];
    for (const [thrown, code, message] of cases) {
        const fetchImpl = async () => { throw thrown; };
        await assert.rejects(streamChat(testConfig('http://upstream.invalid'), basicPayload(), { fetchImpl }), (err) => {
            assert.equal(err.code, code);
            assert.equal(err.retryable, true);
            assert.match(err.message, message);
            return true;
        });
    }
});

test('回呼接連失敗時丟回第一個錯誤', async () => {
    let open;
    const gate = new Promise((resolve) => { open = resolve; });
    let calls = 0;
    // 送出角色、a、b 三塊之後掛住：兩個回呼都還沒失敗時，兩塊都已經交出去了
    await withUpstream([{ content: ['a', 'b'], hangAfterChunks: 3 }], async (up) => {
        const p = streamChat(testConfig(up.origin), basicPayload(), {
            onContent: (text) => {
                calls++;
                if (calls === 2) setImmediate(open);
                return gate.then(() => { throw new Error(`失敗-${text}`); });
            },
        });
        await assert.rejects(p, /失敗-a/);
    });
});

test('回呼在串流已經收完、函式還沒回傳之前才失敗：仍丟回回呼的錯誤', async () => {
    const all = 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n'
        + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n';
    const fetchImpl = async () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(all));
            controller.close();
        },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(streamChat(testConfig('http://upstream.invalid'), basicPayload(), {
        fetchImpl,
        onContent: () => Promise.reject(new Error('寫給前端失敗')),
    }), /寫給前端失敗/);
});

test('收到 [DONE] 卻沒有結束原因、之後連線被切斷：unavailable，可重試', async () => {
    const rawChunks = ['data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n', 'data: [DONE]\n\n', 'data: x\n\n'];
    await withUpstream([{ rawChunks, cutAfterChunks: 2 }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            assert.equal(err.code, 'unavailable');
            assert.equal(err.retryable, true);
            return true;
        });
    });
});

test('收尾期限設成 0：收到結束原因就交出答案，不等 usage', async () => {
    const rawChunks = [finishChunk, 'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n', 'data: [DONE]\n\n'];
    await withUpstream([{ rawChunks, chunkDelayMs: 100 }], async (up) => {
        const r = await streamChat(testConfig(up.origin, { afterFinishIdleMs: 0 }), basicPayload());
        assert.equal(r.content, 'ok');
        assert.equal(r.usage, null);
    });
});

test('收尾期限從第一次收到結束訊號起算：之後的 [DONE] 不會讓它延後', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cfg = testConfig('http://upstream.invalid', { idleTimeoutMs: 60_000, afterFinishIdleMs: 5_000 });
    let stream;
    const fetchImpl = async (url, init) => new Response(new ReadableStream({
        start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode(finishChunk));
            init.signal.addEventListener('abort', () => controller.error(init.signal.reason));
        },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    let settled = false;
    const done = streamChat(cfg, basicPayload(), { fetchImpl }).finally(() => { settled = true; });
    const turn = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };
    await turn();
    t.mock.timers.tick(4_000);
    stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    await turn();
    t.mock.timers.tick(999);
    await turn();
    assert.equal(settled, false, '從 finish 起算 4999ms 時還在等');
    t.mock.timers.tick(1);
    await turn();
    assert.equal(settled, true, '從 finish 起算 5000ms 時應該已經收尾');
    assert.equal((await done).content, 'ok');
});

test('SSE：CR 在一塊的結尾、下一塊只有一個 LF：仍是同一個 CRLF', async () => {
    async function* chunks() {
        yield Buffer.from('data: a\r');
        yield Buffer.from('\n');
        yield Buffer.from('data: b\n\n');
    }
    assert.deepEqual(await collect(chunks()), ['a\nb']);
});

test('SSE：一行結束後計數歸零，下一個殘行剛好 1 MiB 仍可以', async () => {
    const MAX = 1024 * 1024;
    async function* chunks() {
        yield Buffer.from('data: a\n\n');
        yield Buffer.from(`data: ${'x'.repeat(MAX - 6)}`);
        yield Buffer.from('\n\n');
    }
    const events = await collect(chunks());
    assert.deepEqual(events.map((e) => e.length), [1, MAX - 6]);
});

test('redact：URL 編碼的各種變體（大小寫混用、Python 的 quote()、表單編碼）都先解回原樣再比對', () => {
    const key = 'Ab+Cd/Ef=Gh~Ij*Kl!Mn';
    const forms = [
        'Ab%2bCd%2FEf%3dGh~Ij*Kl!Mn',           // 大小寫混用
        'Ab%2BCd/Ef%3DGh~Ij%2AKl%21Mn',         // Python quote()：/ 不編碼
        'Ab%2BCd%2FEf%3DGh%7EIj%2AKl%21Mn',     // 表單編碼：~、*、! 也編碼
    ];
    for (const form of forms) {
        assert.doesNotMatch(redact(`?k=${form}&x=1`, { secrets: [key] }), /Ij|KlMn/, form);
    }
    // 空白與控制字元不解：%20 照原樣留著
    assert.equal(redact('a%20b%0Ac'), 'a%20b%0Ac');
});

test('redact：key 本身含反斜線或 %XX 時也遮得掉（key 跟文字經過同樣的整理）', () => {
    for (const key of ['Ab\\nCdEfGhIjKlMn', 'Ab\\\\CdEfGhIjKlMn', 'Ab%41CdEfGhIjKlMn']) {
        assert.doesNotMatch(redact(`token ${key} end`, { secrets: [key] }), /GhIj/, key);
    }
});

test('不是串流的內容慢慢滴：同樣用收尾期限，不必等滿閒置逾時', async () => {
    await withServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        const timer = setInterval(() => res.write(' '), 50);
        res.on('close', () => clearInterval(timer));
    }, async (origin) => {
        const started = performance.now();
        await assert.rejects(streamChat(testConfig(origin, { idleTimeoutMs: 2_000, afterFinishIdleMs: 200 }), basicPayload()), { code: 'protocol' });
        const ms = performance.now() - started;
        assert.ok(ms < 1_500, `花了 ${ms.toFixed(0)}ms`);
    });
});

test('redact：JSON 一律在解析後重新序列化（多餘的空白不會留下）', () => {
    assert.equal(redact('{ "a" : 1, "b" : "x" }'), '{"a":1,"b":"x"}');
});

test('redact：以 :: 結尾的 IPv6 與網段寫法也遮', () => {
    assert.equal(redact('route fd00::/8 via fe80::'), 'route <internal>/8 via <internal>');
});

test('streamChat 結束後不留下計時器（成功、HTTP 錯誤、串流中斷都一樣）', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pending = new Set();
    // 只算 upstream.mjs 自己建立的：undici 的連線池有自己的計時器（保持連線用），不歸這裡管
    globalThis.setTimeout = (fn, ms, ...args) => {
        const handle = realSetTimeout(() => { pending.delete(handle); fn(...args); }, ms);
        if (/ai-gateway\/src\/upstream\.mjs/.test(new Error().stack)) pending.add(handle);
        return handle;
    };
    globalThis.clearTimeout = (handle) => {
        pending.delete(handle);
        realClearTimeout(handle);
    };
    try {
        const steps = [{ content: ['ok'] }, { status: 500, body: '{}' }, { content: ['a', 'b'], cutAfterChunks: 2 }];
        await withUpstream(steps, async (up) => {
            for (let i = 0; i < steps.length; i++) {
                await streamChat(testConfig(up.origin, { idleTimeoutMs: 60_000, afterFinishIdleMs: 30_000 }), basicPayload()).catch(() => {});
                assert.equal(pending.size, 0, `第 ${i + 1} 種結束方式留下了 ${pending.size} 個計時器`);
            }
        });
    } finally {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
    }
});

test('content-type 放進 detail 前截到 100 字（不會被其他規則縮短的長值也一樣）', async () => {
    await withUpstream([{ rawChunks: ['{}'], contentType: `application/json; x=${'y'.repeat(300)}` }], async (up) => {
        await assert.rejects(streamChat(testConfig(up.origin), basicPayload()), (err) => {
            const shownType = err.detail.split('；')[0].replace(/^content-type: /, '');
            assert.equal(shownType.length, 100);
            assert.ok(shownType.startsWith('application/json; x=yyy'));
            return true;
        });
    });
});

test('redact：%40、%60 這類可見 ASCII 的 URL 編碼也解回原字', () => {
    assert.equal(redact('a%40b%60c'), 'a@b`c');
});
