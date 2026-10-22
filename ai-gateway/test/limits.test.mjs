/**
 * 排隊閘門與每個來源的限流。
 *
 * 執行：npm run test:ai-gateway
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { SlotGate, ClientLimiter, LimitError, clientKey, createProxyMatcher } from '../src/limits.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------- SlotGate

test('SlotGate：名額內立刻放行，用完歸還', async () => {
    const gate = new SlotGate({ concurrency: 2, maxQueue: 0, queueTimeoutMs: 1000 });
    const a = gate.tryEnter();
    const b = gate.tryEnter();
    assert.equal(a.queued, false);
    assert.equal(b.queued, false);
    assert.deepEqual(gate.stats, { inflight: 2, queued: 0 });
    (await a.ready)();
    (await b.ready)();
    assert.deepEqual(gate.stats, { inflight: 0, queued: 0 });
});

test('SlotGate：排隊滿了同步回傳 null（才能在開始串流前回 503）', () => {
    const gate = new SlotGate({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1000 });
    assert.ok(gate.tryEnter());
    const queued = gate.tryEnter();
    assert.equal(queued.queued, true);
    assert.equal(gate.tryEnter(), null);
    queued.ready.catch(() => {});
});

test('SlotGate：先排先得，名額直接轉給下一位，名次變動會通知', async () => {
    const gate = new SlotGate({ concurrency: 1, maxQueue: 5, queueTimeoutMs: 5000 });
    const first = gate.tryEnter();
    const positions = { b: [], c: [] };
    const b = gate.tryEnter({ onPosition: (p) => positions.b.push(p) });
    const c = gate.tryEnter({ onPosition: (p) => positions.c.push(p) });
    // 初始名次在回傳值；onPosition 只通知之後的變動（呼叫端這時還沒開始串流）
    assert.equal(b.position, 1);
    assert.equal(c.position, 2);
    assert.deepEqual(positions, { b: [], c: [] });

    (await first.ready)();
    const releaseB = await b.ready;
    // 名額轉手，inflight 維持 1，c 往前一格
    assert.deepEqual(gate.stats, { inflight: 1, queued: 1 });
    assert.deepEqual(positions.c, [1]);

    releaseB();
    const releaseC = await c.ready;
    releaseC();
    assert.deepEqual(gate.stats, { inflight: 0, queued: 0 });
});

// 只照到達順序的話，佔滿名額的來源隨時排著請求，空出來的名額就一直回到它手上
test('SlotGate：名額空出來先給進行中任務最少的來源，不是先排進隊伍的同一個來源；名次跟著調整', async () => {
    const gate = new SlotGate({ concurrency: 2, maxQueue: 5, queueTimeoutMs: 5000 });
    const a1 = await gate.tryEnter({ key: 'A' }).ready;
    const a2 = await gate.tryEnter({ key: 'A' }).ready;
    const positions = { a3: [], b1: [] };
    const a3 = gate.tryEnter({ key: 'A', onPosition: (p) => positions.a3.push(p) });
    assert.equal(a3.position, 1);
    const b1 = gate.tryEnter({ key: 'B', onPosition: (p) => positions.b1.push(p) });
    assert.equal(b1.position, 1, 'B 沒有進行中的任務，排在 A 前面');
    assert.deepEqual(positions, { a3: [2], b1: [] });

    a1();
    const releaseB1 = await b1.ready;
    assert.deepEqual(gate.stats, { inflight: 2, queued: 1 });
    assert.deepEqual(positions.a3, [2, 1]);
    // 一樣多（各 1 個）時照到達順序：A 的請求先來
    const b2 = gate.tryEnter({ key: 'B' });
    assert.equal(b2.position, 2);
    a2();
    const releaseA3 = await a3.ready;
    releaseB1();
    releaseA3();
    (await b2.ready)();
    assert.deepEqual(gate.stats, { inflight: 0, queued: 0 });
    assert.equal(gate.running.size, 0);
});

test('SlotGate：release 呼叫兩次不會多放一個名額', async () => {
    const gate = new SlotGate({ concurrency: 1, maxQueue: 5, queueTimeoutMs: 5000 });
    const release = await gate.tryEnter().ready;
    const b = gate.tryEnter();
    const c = gate.tryEnter();
    release();
    release();
    await b.ready;
    await tick();
    assert.deepEqual(gate.stats, { inflight: 1, queued: 1 }, 'c 仍要排隊');
    c.ready.catch(() => {});
});

test('SlotGate：排隊中取消就讓出位置，後面的人往前', async () => {
    const gate = new SlotGate({ concurrency: 1, maxQueue: 5, queueTimeoutMs: 5000 });
    const first = gate.tryEnter();
    const ctrl = new AbortController();
    const cPositions = [];
    const b = gate.tryEnter({ signal: ctrl.signal });
    const c = gate.tryEnter({ onPosition: (p) => cPositions.push(p) });
    assert.equal(c.position, 2);
    ctrl.abort();
    await assert.rejects(b.ready, (err) => err instanceof LimitError && err.code === 'aborted');
    assert.deepEqual(gate.stats, { inflight: 1, queued: 1 });
    assert.deepEqual(cPositions, [1]);
    (await first.ready)();
    (await c.ready)();
    assert.deepEqual(gate.stats, { inflight: 0, queued: 0 });
});

test('SlotGate：已取消的 signal 進來直接拒絕、不佔名額', async () => {
    const gate = new SlotGate({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1000 });
    const entry = gate.tryEnter({ signal: AbortSignal.abort() });
    await assert.rejects(entry.ready, { code: 'aborted' });
    assert.deepEqual(gate.stats, { inflight: 0, queued: 0 });
});

test('SlotGate：排太久會以 busy 拒絕並離開隊伍', async () => {
    const gate = new SlotGate({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 50 });
    gate.tryEnter();
    const waiting = gate.tryEnter();
    await assert.rejects(waiting.ready, (err) => {
        assert.equal(err.code, 'busy');
        assert.equal(err.retryAfter, 30);
        return true;
    });
    assert.deepEqual(gate.stats, { inflight: 1, queued: 0 });
});

test('SlotGate：排隊的逾時恰好是 queueTimeoutMs', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = new SlotGate({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1000 });
    gate.tryEnter();
    const waiting = gate.tryEnter();
    let rejected = null;
    waiting.ready.catch((err) => { rejected = err; });
    t.mock.timers.tick(999);
    return Promise.resolve().then(() => {
        assert.equal(rejected, null, '999ms 時還在排隊');
        assert.equal(gate.stats.queued, 1);
        t.mock.timers.tick(1);
        return Promise.resolve();
    }).then(() => {
        assert.equal(rejected?.code, 'busy');
        assert.equal(gate.stats.queued, 0);
    });
});

test('SlotGate：saturated 表示名額全滿', async () => {
    const gate = new SlotGate({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1000 });
    assert.equal(gate.saturated, false);
    const release = await gate.tryEnter().ready;
    assert.equal(gate.saturated, true);
    release();
    assert.equal(gate.saturated, false);
});

test('SlotGate：onPosition 丟例外不影響 release，也不影響後面的人收到名次', async () => {
    const gate = new SlotGate({ concurrency: 1, maxQueue: 5, queueTimeoutMs: 5000 });
    const release = await gate.tryEnter().ready;
    const positions = { c: [], d: [] };
    const b = gate.tryEnter();
    const c = gate.tryEnter({ onPosition: (p) => { positions.c.push(p); throw new Error('通知失敗'); } });
    const d = gate.tryEnter({ onPosition: (p) => positions.d.push(p) });
    // b 輪到時要通知 c（丟例外）與 d
    assert.doesNotThrow(() => release());
    assert.deepEqual(positions, { c: [1], d: [2] });
    (await b.ready)();
    (await c.ready)();
    (await d.ready)();
    assert.deepEqual(gate.stats, { inflight: 0, queued: 0 });
});

test('SlotGate：呼叫端晚一點才接 ready 的拒絕，也不會變成 unhandledRejection', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
        const gate = new SlotGate({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 10 });
        gate.tryEnter();
        const waiting = gate.tryEnter();
        const aborted = gate.tryEnter({ signal: AbortSignal.abort() });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(unhandled, []);
        await assert.rejects(waiting.ready, { code: 'busy' });
        await assert.rejects(aborted.ready, { code: 'aborted' });
    } finally {
        process.off('unhandledRejection', onUnhandled);
    }
});

// ---------------------------------------------------------------- ClientLimiter

test('ClientLimiter：窗口內超過次數就擋，並給出幾秒後可再試（無條件進位）', () => {
    let now = 1_000_000;
    const limiter = new ClientLimiter({ windowMs: 60_000, max: 2, maxInflight: 10, now: () => now });
    limiter.admit('a').done();
    now += 10_500;
    limiter.admit('a').done();
    assert.throws(() => limiter.admit('a'), (err) => {
        assert.equal(err.code, 'rate_limited');
        assert.equal(err.retryAfter, 50); // 第一次在 49.5 秒後過期，進位成 50
        return true;
    });
    // 被擋的那次不算數：第一次過期後馬上又可以
    now += 49_500;
    assert.doesNotThrow(() => limiter.admit('a'));
});

test('ClientLimiter：紀錄恰好在 windowMs 時過期（邊界）', () => {
    let now = 0;
    const limiter = new ClientLimiter({ windowMs: 1000, max: 1, maxInflight: 10, now: () => now });
    limiter.admit('a').done();
    now = 999;
    assert.throws(() => limiter.admit('a'), { code: 'rate_limited' });
    now = 1000;
    assert.doesNotThrow(() => limiter.admit('a'));
});

test('ClientLimiter：不同來源各自計算', () => {
    const limiter = new ClientLimiter({ windowMs: 60_000, max: 1, maxInflight: 10 });
    limiter.admit('a').done();
    assert.doesNotThrow(() => limiter.admit('b'));
    assert.throws(() => limiter.admit('a'), { code: 'rate_limited' });
});

test('ClientLimiter：佔用量只在要排隊時檢查；done() 重複呼叫無害', () => {
    const limiter = new ClientLimiter({ windowMs: 60_000, max: 100, maxInflight: 2 });
    const t1 = limiter.admit('a');
    limiter.admit('a');
    assert.throws(() => limiter.admit('a'), { code: 'too_many_inflight' });
    assert.throws(() => limiter.admit('a', { wouldQueue: true }), { code: 'too_many_inflight' });
    // 名額還有空：直接就能開始，不必擋（整班共用一個 IP 時，GPU 有空就讓大家用）
    assert.doesNotThrow(() => limiter.admit('a', { wouldQueue: false }));
    t1.done();
    t1.done();
    assert.throws(() => limiter.admit('a'), { code: 'too_many_inflight' }, '佔用量仍是 2（第三個沒有排隊）');
});

test('ClientLimiter：同一個時間點的兩次請求，其中一次 refund 兩遍也只退掉自己那一筆', () => {
    const limiter = new ClientLimiter({ windowMs: 60_000, max: 5, maxInflight: 10, now: () => 10 });
    limiter.admit('a').done();
    const second = limiter.admit('a');
    second.refund();
    second.refund();
    assert.deepEqual(limiter.clients.get('a').hits, [10]);
});

test('ClientLimiter：refund 把這次的次數退回去；重複呼叫只退一次', () => {
    let now = 0;
    const limiter = new ClientLimiter({ windowMs: 60_000, max: 2, maxInflight: 10, now: () => now });
    limiter.admit('a').done();
    now = 10;
    const second = limiter.admit('a');
    assert.throws(() => limiter.admit('a'), { code: 'rate_limited' });
    second.refund();
    second.refund();
    second.done();
    const third = limiter.admit('a');
    assert.throws(() => limiter.admit('a'), { code: 'rate_limited' }, '只退了一次，不是全部清空');
    third.done();
    assert.equal(limiter.clients.get('a').hits.length, 2);
});

// 讀 body 之前用：已經被限流的來源不必再替它收 body、解析、驗證
test('ClientLimiter.check：只查不記——次數用完才丟 rate_limited，不建立紀錄、不改變清除順序', () => {
    let now = 0;
    const limiter = new ClientLimiter({ windowMs: 1000, max: 2, maxInflight: 10, maxClients: 2, now: () => now });
    assert.doesNotThrow(() => limiter.check('nobody'));
    assert.equal(limiter.clients.has('nobody'), false, '沒來過的來源不建立紀錄');
    limiter.admit('a').done();
    limiter.admit('b').done();
    assert.doesNotThrow(() => limiter.check('a'));
    assert.equal(limiter.clients.get('a').hits.length, 1, 'check 不計次');
    assert.deepEqual([...limiter.clients.keys()], ['a', 'b'], 'check 不把 a 排到最近');
    now = 100;
    limiter.admit('a').done();
    assert.throws(() => limiter.check('a'), (err) => {
        assert.equal(err.code, 'rate_limited');
        assert.equal(err.retryAfter, 1);
        return true;
    });
    // 窗口過了就不再擋（過期的紀錄在 check 時移掉）
    now = 1100;
    assert.doesNotThrow(() => limiter.check('a'));
    assert.equal(limiter.clients.get('a').hits.length, 0);
});

test('ClientLimiter：預設用單調時鐘（系統校時不影響窗口）', () => {
    const limiter = new ClientLimiter({ windowMs: 1000, max: 1, maxInflight: 1 });
    assert.ok(Math.abs(limiter.now() - performance.now()) < 100);
});

test('ClientLimiter：sweep 清掉沒有紀錄也沒有進行中任務的來源；邊界時刻也算過期', () => {
    let now = 0;
    const limiter = new ClientLimiter({ windowMs: 1000, max: 5, maxInflight: 5, now: () => now });
    limiter.admit('idle').done();
    const busy = limiter.admit('busy');
    now = 1000;
    limiter.sweep();
    assert.equal(limiter.clients.has('idle'), false);
    assert.equal(limiter.clients.has('busy'), true, '進行中的不能清');
    busy.done();
});

test('ClientLimiter：來源數超過上限時，從最久沒出現的開始清（不清進行中的）', () => {
    const limiter = new ClientLimiter({ windowMs: 60_000, max: 5, maxInflight: 5, maxClients: 3 });
    const keep = limiter.admit('k0'); // 進行中
    limiter.admit('k1').done();
    limiter.admit('k2').done();
    limiter.admit('k3').done();
    assert.equal(limiter.clients.size, 3);
    assert.equal(limiter.clients.has('k0'), true);
    assert.equal(limiter.clients.has('k1'), false);
    keep.done();
});

test('ClientLimiter：最近又出現的來源排到最後，不會先被清', () => {
    const limiter = new ClientLimiter({ windowMs: 60_000, max: 5, maxInflight: 5, maxClients: 2 });
    limiter.admit('a').done();
    limiter.admit('b').done();
    limiter.admit('a').done(); // a 變成最近使用
    limiter.admit('c').done();
    assert.deepEqual([...limiter.clients.keys()], ['a', 'c']);
});

// ---------------------------------------------------------------- clientKey

test('clientKey：IPv4 原樣；各種寫法的 IPv4 對應位址都還原成 IPv4', () => {
    assert.equal(clientKey('203.0.113.5'), '203.0.113.5');
    assert.equal(clientKey('  203.0.113.5 '), '203.0.113.5');
    for (const mapped of ['::ffff:203.0.113.5', '::FFFF:203.0.113.5', '::ffff:cb00:7105', '0:0:0:0:0:ffff:cb00:7105', '0000:0000:0000:0000:0000:FFFF:CB00:7105']) {
        assert.equal(clientKey(mapped), '203.0.113.5', mapped);
    }
});

test('clientKey：IPv6 取 /64（同一段視為同一來源，大小寫與省略寫法不影響）', () => {
    assert.equal(clientKey('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(clientKey('2001:0DB8:0001:0002:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(clientKey('2001:db8:1:2::ffff'), clientKey('2001:db8:1:2:9:9:9:9'));
    assert.equal(clientKey('::1'), '0:0:0:0::/64');
    assert.notEqual(clientKey('::1'), clientKey('203.0.113.5'), 'IPv4 不能全部擠進同一個 IPv6 桶');
});

test('clientKey：帶埠、方括號、zone id 的寫法先剝掉；不是 IP 的一律 invalid（鍵長有上限）', () => {
    assert.equal(clientKey('203.0.113.5:51234'), '203.0.113.5');
    assert.equal(clientKey('[2001:db8::1]:443'), '2001:db8:0:0::/64');
    assert.equal(clientKey('[2001:db8::1]'), '2001:db8:0:0::/64');
    assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    // zone id 不剝掉的話，結尾的 IPv4 認不出來，IPv4 對應位址就還原不了
    assert.equal(clientKey('::ffff:203.0.113.5%eth0'), '203.0.113.5');
    for (const junk of ['', undefined, 'unknown', 'not-an-ip', '1.2.3.256', 'x'.repeat(10_000), '203.0.113.5, 198.51.100.1']) {
        assert.equal(clientKey(junk), 'invalid', String(junk).slice(0, 30));
    }
});

// ---------------------------------------------------------------- createProxyMatcher

test('createProxyMatcher：CIDR 比對，IPv4 對應的 IPv6 也算；IPv6 一律不信任', () => {
    const trusted = createProxyMatcher(['10.42.0.0/16', '127.0.0.1/32']);
    assert.equal(trusted('10.42.3.4'), true);
    assert.equal(trusted('::ffff:10.42.3.4'), true);
    assert.equal(trusted('127.0.0.1'), true);
    assert.equal(trusted('10.43.0.1'), false);
    assert.equal(trusted('127.0.0.2'), false);
    assert.equal(trusted('::1'), false);
    assert.equal(trusted(''), false);
    assert.equal(createProxyMatcher([])('10.42.3.4'), false, '沒有設定就誰都不信任');
    assert.equal(createProxyMatcher(['0.0.0.0/0'])('203.0.113.5'), true);
});

test('createProxyMatcher：CIDR 寫錯在啟動時就丟例外', () => {
    for (const bad of ['10.0.0.0/33', '300.1.1.1', '10.0.0.0/8/1', 'abc', '10.0.0.0/x', '::1/128']) {
        assert.throws(() => createProxyMatcher([bad]), /不合法的 IPv4 CIDR/, bad);
    }
});
