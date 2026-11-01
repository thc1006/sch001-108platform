/**
 * 任務結束時的 TASK log：各階段的時間點與次數。請求走真的 generate、streamChat 與假 WinLab，
 * 時間點才是實際收到上游回應、送出事件的時刻。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGateway, createLogger } from '../src/server.mjs';
import { createCatalog } from '../src/tasks.mjs';
import { startFakeUpstream, testConfig } from './fake-upstream.mjs';

const ORIGIN = 'https://thc1006.github.io';

const TASKS = createCatalog([
    {
        id: 'demo-json',
        input: { topic: { label: '主題', maxLength: 100 } },
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
        // check 故意把模型寫的值放進描述，也可能指向規格外的路徑：log 只能收規格裡的路徑
        id: 'demo-checked',
        input: { topic: { label: '主題', maxLength: 100 } },
        output: {
            type: 'json',
            schema: {
                type: 'object',
                properties: { answer: { type: 'string', minLength: 1 } },
                required: ['answer'],
                additionalProperties: false,
            },
            check: ({ answer }) => {
                if (answer === '好') return null;
                return answer.startsWith('P') ? `$.${answer} 應為 好` : `$.answer 應為 好，實際是 ${answer}`;
            },
        },
        instructions: '依主題回答。',
    },
    {
        id: 'demo-md',
        input: { question: { label: '問題', maxLength: 100 } },
        output: { type: 'markdown' },
        instructions: '回答問題。',
    },
]);

// TASK 一行可以有的欄位。多出來的欄位要先確認它不會帶出學生的輸入或模型的輸出，再加進來
const TASK_LOG_KEYS = [
    'id', 'task', 'client', 'outcome', 'status', 'rounds', 'cont', 'reasoning', 'completion', 'prompt',
    'queue', 'total', 'stall', 'pending', 'firstByte', 'firstThinking', 'firstDelta', 'retries', 'probes', 'rewrites',
];

async function startGateway(script, { llm = {}, server = {}, logLevel = 'debug' } = {}) {
    const upstream = await startFakeUpstream(script);
    const lines = [];
    const gateway = createGateway({
        llm: testConfig(upstream.origin, { taskTimeoutMs: 4_000, ...llm }),
        server: {
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
            ...server,
        },
        tasks: TASKS,
        log: createLogger(logLevel, (line) => lines.push(line)),
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

function post(base, task, input, { signal } = {}) {
    return fetch(`${base}/v1/tasks/${task}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ input }),
        signal,
    });
}

async function readEvents(res) {
    const events = [];
    for (const block of (await res.text()).split('\n\n')) {
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
    }
    return events;
}

/** createLogger 寫出的一行「時間 級別 標籤 key=value …」裡的欄位，值是解開引號之後的字串 */
function logFields(line) {
    return Object.fromEntries([...line.matchAll(/ (\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)].map(([, k, v]) => [k, v.startsWith('"') ? JSON.parse(v) : v]));
}

async function waitFor(fn, timeoutMs = 2_000) {
    const started = Date.now();
    while (!fn()) {
        if (Date.now() - started > timeoutMs) throw new Error('waitFor 逾時');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function taskLog(gw) {
    await waitFor(() => gw.lines.some((l) => / TASK /.test(l)));
    const fields = logFields(gw.lines.find((l) => / TASK /.test(l)));
    assert.deepEqual(Object.keys(fields).filter((k) => !TASK_LOG_KEYS.includes(k)), []);
    return fields;
}

/** "123ms" 轉成 123；欄位不在就是 undefined */
function ms(value) {
    if (value === undefined) return undefined;
    assert.match(value, /^\d+ms$/);
    return Number.parseInt(value, 10);
}

const timesOf = (fields) => ({
    queue: ms(fields.queue),
    firstByte: ms(fields.firstByte),
    firstThinking: ms(fields.firstThinking),
    firstDelta: ms(fields.firstDelta),
    total: ms(fields.total),
});

test('文字任務寫完：上游第一個位元組、第一個思考 token、第一段答案依序發生，都不晚於總時間', async () => {
    const gw = await startGateway([{ thinking: ['先想'], content: ['答', '案'], finish: 'stop' }]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.equal(events.at(-1).event, 'done');
        const t = timesOf(await taskLog(gw));
        assert.ok(t.queue <= t.firstByte, JSON.stringify(t));
        assert.ok(t.firstByte <= t.firstThinking && t.firstThinking <= t.firstDelta && t.firstDelta <= t.total, JSON.stringify(t));
    } finally {
        await gw.stop();
    }
});

test('JSON 任務不送 delta、模型沒有思考：不記 firstDelta 與 firstThinking', async () => {
    const gw = await startGateway([{ content: ['{"answer":"好"}'], finish: 'stop' }]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: '生物' }));
        assert.equal(events.at(-1).event, 'done');
        const t = timesOf(await taskLog(gw));
        assert.ok(t.firstByte <= t.total, JSON.stringify(t));
        assert.equal(t.firstThinking, undefined);
        assert.equal(t.firstDelta, undefined);
    } finally {
        await gw.stop();
    }
});

test('接續：時間點取整個任務的第一次，不是最後一輪的', async () => {
    // 第二輪也有思考與正文，而且每塊隔 50ms：時間點若被第二輪蓋掉，就會晚於第二輪的請求到達
    let secondArrival;
    const gw = await startGateway((req, i) => {
        if (i === 0) return { thinking: ['想'], content: ['第一段'], finish: 'length' };
        secondArrival = Date.now();
        return { thinking: ['再想'], content: ['，接著寫完。'], finish: 'stop', chunkDelayMs: 50 };
    });
    try {
        const sentAt = Date.now();
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.equal(events.at(-1).event, 'done');
        const fields = await taskLog(gw);
        assert.equal(fields.cont, 'writing');
        const t = timesOf(fields);
        assert.ok(t.firstByte <= t.firstThinking && t.firstThinking <= t.firstDelta, JSON.stringify(t));
        // 時間從閘道收到請求算，比 sentAt 晚：sentAt 加上去只會更早
        for (const key of ['firstByte', 'firstThinking', 'firstDelta']) {
            assert.ok(sentAt + t[key] <= secondArrival, `${key}：${JSON.stringify(t)}，第二輪在 ${secondArrival - sentAt}ms`);
        }
    } finally {
        await gw.stop();
    }
});

test('排過隊的任務：時間從請求進來算，第一個位元組不早於排隊時間', async () => {
    const gw = await startGateway([
        { content: ['第一個'], finish: 'stop', chunkDelayMs: 100 },
        { content: ['第二個'], finish: 'stop' },
    ], { server: { concurrency: 1 } });
    try {
        const first = post(gw.base, 'demo-md', { question: '一' });
        await waitFor(() => gw.upstream.requests.length === 1);
        const second = await readEvents(await post(gw.base, 'demo-md', { question: '二' }));
        await readEvents(await first);
        assert.ok(second.some((e) => e.data.phase === 'queued'));
        await waitFor(() => gw.lines.filter((l) => / TASK /.test(l)).length === 2);
        const t = timesOf(logFields(gw.lines.filter((l) => / TASK /.test(l))[1]));
        assert.ok(t.queue >= 100, JSON.stringify(t));
        assert.ok(t.queue <= t.firstByte && t.firstByte <= t.firstDelta && t.firstDelta <= t.total, JSON.stringify(t));
    } finally {
        await gw.stop();
    }
});

test('沒拿到名額就結束（排隊逾時、排隊中離開）：queue 記到結束為止排了多久', async () => {
    const gw = await startGateway([{ hangBeforeHeaders: true }], { server: { concurrency: 1, queueTimeoutMs: 300 } });
    try {
        const running = new AbortController();
        const first = await post(gw.base, 'demo-md', { question: '一' }, { signal: running.signal });
        await waitFor(() => gw.upstream.requests.length === 1);
        const timedOut = await readEvents(await post(gw.base, 'demo-md', { question: '二' }));
        assert.equal(timedOut.at(-1).data.code, 'busy');
        const leaving = new AbortController();
        const left = await post(gw.base, 'demo-md', { question: '三' }, { signal: leaving.signal });
        await new Promise((resolve) => setTimeout(resolve, 200));
        leaving.abort();
        await left.text().catch(() => {});
        await waitFor(() => gw.lines.filter((l) => / TASK /.test(l)).length === 2);
        const [busy, aborted] = gw.lines.filter((l) => / TASK /.test(l)).map(logFields);
        assert.deepEqual([busy.outcome, aborted.outcome], ['busy', 'aborted']);
        // 計時從送出 SSE 標頭開始，比閘門的計時器晚一點點
        assert.ok(ms(busy.queue) >= 250, busy.queue);
        assert.ok(ms(aborted.queue) >= 150, aborted.queue);
        assert.equal(busy.firstByte, undefined);
        running.abort();
        await first.text().catch(() => {});
    } finally {
        await gw.stop();
    }
});

test('第一輪上游就回錯誤：記第一個位元組（錯誤的回應也算），沒有思考與答案的時間', async () => {
    const gw = await startGateway([{ status: 500, body: { error: { message: '壞了' } } }]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.equal(events.at(-1).data.code, 'unavailable');
        const fields = await taskLog(gw);
        const t = timesOf(fields);
        assert.ok(t.firstByte <= t.total, JSON.stringify(t));
        assert.equal(t.firstThinking, undefined);
        assert.equal(t.firstDelta, undefined);
    } finally {
        await gw.stop();
    }
});

test('上游還沒回應就取消：三個時間點都不記', async () => {
    const gw = await startGateway([{ hangBeforeHeaders: true }]);
    try {
        const ctrl = new AbortController();
        const res = await post(gw.base, 'demo-md', { question: '怎麼做專題？' }, { signal: ctrl.signal });
        await waitFor(() => gw.upstream.requests.length === 1);
        ctrl.abort();
        await res.text().catch(() => {});
        const fields = await taskLog(gw);
        assert.equal(fields.outcome, 'aborted');
        const t = timesOf(fields);
        assert.deepEqual([t.firstByte, t.firstThinking, t.firstDelta], [undefined, undefined, undefined]);
    } finally {
        await gw.stop();
    }
});

const countsOf = (fields) => [fields.retries, fields.probes, fields.rewrites];
const CUT_HEAD = '請先完成以下三項：\n1. 蒐集';

test('次數：一般完成都是 0，有開始生成才記', async () => {
    const gw = await startGateway([{ content: ['好'], finish: 'stop' }]);
    try {
        await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.deepEqual(countsOf(await taskLog(gw)), ['0', '0', '0']);
    } finally {
        await gw.stop();
    }
});

test('次數：接續輪遇到 429 與 503 各重試一次，retries 是 2', async () => {
    const gw = await startGateway([
        { content: [CUT_HEAD], finish: 'length' },
        { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'busy' } } },
        { status: 503, body: { error: { message: 'down' } } },
        { content: ['資料'], finish: 'stop' },
    ]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.equal(events.at(-1).event, 'done');
        const fields = await taskLog(gw);
        assert.deepEqual(countsOf(fields), ['2', '0', '0']);
        assert.equal(fields.rounds, '2');
    } finally {
        await gw.stop();
    }
});

const overflow = (detail) => ({ status: 400, body: { error: { message: `This model's maximum context length is 32768 tokens. However, ${detail}`, code: 400 } } });

test('次數：接續輪被 context 長度拒絕、錯誤寫出精確大小，校正後重送不算 retries', async () => {
    const gw = await startGateway([
        { content: [CUT_HEAD], finish: 'length' },
        overflow('your request has 25000 input tokens.'),
        { content: ['資料'], finish: 'stop' },
    ]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.equal(events.at(-1).event, 'done');
        assert.equal(gw.upstream.requests.length, 3);
        assert.deepEqual(countsOf(await taskLog(gw)), ['0', '0', '0']);
    } finally {
        await gw.stop();
    }
});

test('次數：接續輪被 context 長度拒絕、只給下界：探測後的重送不算 retries，探測回 429 後的重送算；probes 等於探測的請求數', async () => {
    const isProbe = (req) => req.body.max_tokens === 1;
    let probesSeen = 0;
    const gw = await startGateway((req, i) => {
        if (i === 0) return { content: [CUT_HEAD], finish: 'length' };
        if (i === 1) return overflow('your prompt contains at least 24577 input tokens.');
        if (isProbe(req)) {
            probesSeen++;
            if (probesSeen === 1) return { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'busy' } } };
            return { content: [], finish: 'length', usage: { prompt_tokens: 3000, completion_tokens: 1 } };
        }
        return { content: ['資料'], finish: 'stop' };
    });
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.equal(events.at(-1).event, 'done');
        const probes = gw.upstream.requests.filter(isProbe).length;
        assert.ok(probes >= 2);
        // 回 429 的探測退避後重送，那一次算 retries
        assert.deepEqual(countsOf(await taskLog(gw)), ['1', String(probes), '0']);
    } finally {
        await gw.stop();
    }
});

test('次數：退避等待中取消，沒有重送就不算 retries', async () => {
    const gw = await startGateway([
        { content: [CUT_HEAD], finish: 'length' },
        { status: 429, headers: { 'retry-after': '3' }, body: { error: { message: 'busy' } } },
        { content: ['資料'], finish: 'stop' },
    ]);
    try {
        const ctrl = new AbortController();
        const res = await post(gw.base, 'demo-md', { question: '怎麼做專題？' }, { signal: ctrl.signal });
        await waitFor(() => gw.upstream.requests.length === 2);
        await new Promise((resolve) => setTimeout(resolve, 100));
        ctrl.abort();
        await res.text().catch(() => {});
        const fields = await taskLog(gw);
        assert.equal(fields.outcome, 'aborted');
        assert.equal(gw.upstream.requests.length, 2);
        assert.deepEqual(countsOf(fields), ['0', '0', '0']);
    } finally {
        await gw.stop();
    }
});

test('次數：題目估計放不下完整的輸出額度時先探測，probes 是 1', async () => {
    const gw = await startGateway([
        { content: [], finish: 'length', usage: { prompt_tokens: 60, completion_tokens: 1 } },
        { content: ['好'], finish: 'stop' },
    ], { llm: { contextTokens: 7_000 } });
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.equal(events.at(-1).event, 'done');
        assert.equal(gw.upstream.requests[0].body.max_tokens, 1, '第一個請求是探測');
        const fields = await taskLog(gw);
        assert.deepEqual(countsOf(fields), ['0', '1', '0']);
        // 探測的回應也是上游的第一個位元組
        assert.ok(ms(fields.firstByte) <= ms(fields.firstDelta));
    } finally {
        await gw.stop();
    }
});

test('次數：JSON 被截斷後整份重寫，rewrites 是 1', async () => {
    const gw = await startGateway([
        { content: ['{"answer":"好'], finish: 'length' },
        { content: ['{"answer":"好"}'], finish: 'stop' },
    ]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: '生物' }));
        assert.equal(events.at(-1).event, 'done');
        const fields = await taskLog(gw);
        assert.equal(fields.cont, 'rewrite');
        assert.deepEqual(countsOf(fields), ['0', '0', '1']);
    } finally {
        await gw.stop();
    }
});

test('次數：第一輪就失敗、生成途中取消都記 0；排隊中取消沒開始生成，不記', async () => {
    const failed = await startGateway([{ status: 500, body: { error: { message: '壞了' } } }]);
    try {
        await readEvents(await post(failed.base, 'demo-md', { question: '怎麼做專題？' }));
        assert.deepEqual(countsOf(await taskLog(failed)), ['0', '0', '0']);
    } finally {
        await failed.stop();
    }
    const gw = await startGateway([{ hangBeforeHeaders: true }], { server: { concurrency: 1 } });
    try {
        const running = new AbortController();
        const first = await post(gw.base, 'demo-md', { question: '一' }, { signal: running.signal });
        await waitFor(() => gw.upstream.requests.length === 1);
        const waiting = new AbortController();
        const second = await post(gw.base, 'demo-md', { question: '二' }, { signal: waiting.signal });
        waiting.abort();
        await second.text().catch(() => {});
        running.abort();
        await first.text().catch(() => {});
        await waitFor(() => gw.lines.filter((l) => / TASK /.test(l)).length === 2);
        const [queuedLog, runningLog] = gw.lines.filter((l) => / TASK /.test(l)).map(logFields);
        assert.deepEqual([queuedLog.outcome, queuedLog.rounds, ...countsOf(queuedLog)], ['aborted', undefined, undefined, undefined, undefined]);
        assert.deepEqual([runningLog.outcome, ...countsOf(runningLog)], ['aborted', '0', '0', '0']);
        // 沒有排隊；CPU 被搶時 queue 可能記成 1ms 以上
        assert.ok(Number.parseInt(runningLog.queue, 10) < 1_000, runningLog.queue);
    } finally {
        await gw.stop();
    }
});

const REJECT_LOG_KEYS = ['id', 'task', 'round', 'source', 'path', 'rule'];
const rejectLogs = (gw) => gw.lines.filter((l) => / JSON-REJECT /.test(l)).map((line) => {
    const fields = logFields(line);
    assert.deepEqual(Object.keys(fields).filter((k) => !REJECT_LOG_KEYS.includes(k)), []);
    return fields;
});

test('JSON 寫完卻不通過 check：JSON-REJECT 記下任務、輪數、來源、路徑與規則，重寫之後交出', async () => {
    const gw = await startGateway([
        { content: ['{"answer":"壞"}'], finish: 'stop' },
        { content: ['{"answer":"好"}'], finish: 'stop' },
    ]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-checked', { topic: '生物' }));
        assert.deepEqual(events.at(-1).data.result, { answer: '好' });
        const [reject] = rejectLogs(gw);
        const task = await taskLog(gw);
        assert.deepEqual({ ...reject, id: undefined }, { id: undefined, task: 'demo-checked', round: '1', source: 'check', path: '$.answer', rule: 'check' });
        assert.equal(reject.id, task.id);
        assert.equal(task.rewrites, '1');
    } finally {
        await gw.stop();
    }
});

test('JSON-REJECT：schema 不通過、解析不了各記一筆；被截斷的不記；每一輪都不合格就以 format 結束', async () => {
    const gw = await startGateway([
        { content: ['{"answer":"'], finish: 'length' },
        { content: ['{"answer":""}'], finish: 'stop' },
        { content: ['這不是 JSON'], finish: 'stop' },
    ], { llm: { maxRounds: 3 } });
    try {
        const events = await readEvents(await post(gw.base, 'demo-json', { topic: '生物' }));
        assert.equal(events.at(-1).data.code, 'format');
        assert.deepEqual(rejectLogs(gw).map((f) => [f.task, f.round, f.source, f.path, f.rule]), [
            ['demo-json', '2', 'schema', '$.answer', 'min_length'],
            ['demo-json', '3', 'parse', undefined, 'SyntaxError'],
        ]);
        assert.equal((await taskLog(gw)).outcome, 'format');
    } finally {
        await gw.stop();
    }
});

test('JSON-REJECT 是 info：正式環境的 LOG_LEVEL 看得到', async () => {
    const gw = await startGateway([
        { content: ['{"answer":""}'], finish: 'stop' },
        { content: ['{"answer":"好"}'], finish: 'stop' },
    ], { logLevel: 'info' });
    try {
        await readEvents(await post(gw.base, 'demo-json', { topic: '生物' }));
        await taskLog(gw);
        assert.equal(gw.lines.filter((l) => / info JSON-REJECT /.test(l)).length, 1);
    } finally {
        await gw.stop();
    }
});

const CANARY = '祕密標記Q9Z4';

test('新的 log 欄位不帶出學生的輸入與模型的輸出：TASK 只有允許的欄位，任何一行都沒有標記', async () => {
    const gw = await startGateway([
        { thinking: [`想想${CANARY}`], content: [`開頭${CANARY}`], finish: 'length' },
        { content: [`結尾${CANARY}`], finish: 'stop' },
    ]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-md', { question: `我的${CANARY}` }));
        assert.equal(events.at(-1).event, 'done');
        assert.ok(gw.upstream.requests[0].raw.includes(CANARY), '上游收到的訊息裡有標記');
        const fields = await taskLog(gw);
        for (const key of ['firstByte', 'firstThinking', 'firstDelta']) assert.match(fields[key], /^\d+ms$/, key);
        for (const key of ['retries', 'probes', 'rewrites']) assert.match(fields[key], /^\d+$/, key);
        assert.doesNotMatch(gw.lines.join('\n'), new RegExp(CANARY));
    } finally {
        await gw.stop();
    }
});

test('JSON-REJECT 不帶出模型的輸出：check 的描述照抄模型寫的值、或指向規格外的路徑時，只記規格裡的路徑', async () => {
    const gw = await startGateway([
        { thinking: [`想想${CANARY}`], content: [JSON.stringify({ answer: `壞${CANARY}` })], finish: 'stop' },
        { content: [JSON.stringify({ answer: `P${CANARY}` })], finish: 'stop' },
        { content: [JSON.stringify({ answer: 'Pzzz' })], finish: 'stop' },
        { content: ['{"answer":"好"}'], finish: 'stop' },
    ]);
    try {
        const events = await readEvents(await post(gw.base, 'demo-checked', { topic: `我的${CANARY}` }));
        assert.deepEqual(events.at(-1).data.result, { answer: '好' });
        assert.deepEqual(rejectLogs(gw).map((f) => [f.round, f.source, f.path, f.rule]), [
            ['1', 'check', '$.answer', 'check'],
            ['2', 'check', undefined, 'check'],
            ['3', 'check', undefined, 'check'],
        ]);
        assert.doesNotMatch(gw.lines.join('\n'), new RegExp(`${CANARY}|Pzzz|實際是`));
    } finally {
        await gw.stop();
    }
});
