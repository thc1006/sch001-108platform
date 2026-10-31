/**
 * 排隊閘門、每個來源的限流與上游卡住時的斷路器。
 *
 * 執行：npm run test:ai-gateway
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { SlotGate, ClientLimiter, Breaker, LimitError, clientKey, createProxyMatcher, createSourceMatcher, parseCidr, formatCidr, coversAllIPv4, blockRangeProblem } from '../src/limits.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

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

function breakerAt(t0 = 0) {
    const clock = { t: t0 };
    const changes = [];
    const breaker = new Breaker({ now: () => clock.t, onChange: (fields) => changes.push(fields) });
    return { breaker, clock, changes };
}

test('Breaker：連續 2 個任務卡住就斷開 30 秒，期間 wait() 給剩下的秒數（無條件進位），enter() 丟 busy', () => {
    const { breaker, clock, changes } = breakerAt();
    assert.equal(breaker.enter(), null);
    breaker.finish(null, true);
    assert.equal(breaker.wait(), 0);
    breaker.finish(null, true);
    assert.deepEqual(changes, [{ state: 'open', failures: 2 }]);
    assert.equal(breaker.wait(), 30);
    clock.t = 29_001;
    assert.equal(breaker.wait(), 1);
    assert.throws(() => breaker.enter(), (err) => err instanceof LimitError && err.code === 'busy' && err.retryAfter === 1);
});

test('Breaker：沒卡住的任務不改變計數；中間有一個收到回應就重新計算', () => {
    const { breaker, changes } = breakerAt();
    breaker.finish(null, true);
    breaker.finish(null, false);
    breaker.success();
    breaker.finish(null, true);
    assert.equal(breaker.wait(), 0);
    assert.deepEqual(changes, []);
});

test('Breaker：30 秒後只放一個任務去試；試的那個收到回應就恢復，記一次 closed', () => {
    const { breaker, clock, changes } = breakerAt();
    breaker.finish(null, true);
    breaker.finish(null, true);
    clock.t = 30_000;
    assert.equal(breaker.wait(), 0);
    const trial = breaker.enter();
    assert.ok(trial);
    // 試的那個還沒結束：其他任務照樣擋
    assert.equal(breaker.wait(), 30);
    assert.throws(() => breaker.enter(), { code: 'busy' });
    breaker.success();
    breaker.finish(trial, false);
    assert.deepEqual(changes, [{ state: 'open', failures: 2 }, { state: 'closed' }]);
    assert.equal(breaker.enter(), null);
    // 計數歸零：要再連續卡住 2 個才斷開
    breaker.finish(null, true);
    assert.equal(breaker.wait(), 0);
});

test('Breaker：試的那個又卡住就再斷開 30 秒；試的那個沒有結論（例如連不上、被取消）就讓下一個去試', () => {
    const { breaker, clock, changes } = breakerAt();
    breaker.finish(null, true);
    breaker.finish(null, true);
    clock.t = 30_000;
    breaker.finish(breaker.enter(), false);
    assert.equal(breaker.wait(), 0);
    const second = breaker.enter();
    assert.ok(second);
    clock.t = 40_000;
    breaker.finish(second, true);
    assert.deepEqual(changes, [{ state: 'open', failures: 2 }, { state: 'open', failures: 3 }]);
    assert.equal(breaker.wait(), 30);
    // 斷開期間才結束的其他卡住的任務不延長時間、不重複記 log
    clock.t = 50_000;
    breaker.finish(null, true);
    assert.equal(breaker.wait(), 20);
    assert.equal(changes.length, 2);
});

test('Breaker：恢復之後又斷開、換別的任務去試時，上一個去試的任務結束不會放掉新的那一個', () => {
    const { breaker, clock } = breakerAt();
    breaker.finish(null, true);
    breaker.finish(null, true);
    clock.t = 30_000;
    const first = breaker.enter();
    // 斷開之前就在跑的任務收到回應：恢復
    breaker.success();
    breaker.finish(null, true);
    breaker.finish(null, true);
    clock.t = 60_000;
    const second = breaker.enter();
    assert.ok(second && second !== first);
    breaker.finish(first, false);
    assert.equal(breaker.wait(), 30);
    assert.throws(() => breaker.enter(), { code: 'busy' });
    breaker.finish(second, false);
    assert.ok(breaker.enter());
});

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

// 2002:cb00:7105::/48 是 203.0.113.5 的 6to4 前綴（文件用的位址段）
test('clientKey：IPv6 的前綴長度可以指定，不是 16 的倍數時那一組只留前面的位元；IPv4 與內嵌 IPv4 不受影響', () => {
    assert.equal(clientKey('2001:db8:1:2:3:4:5:6', 48), '2001:db8:1::/48');
    assert.equal(clientKey('2001:db8:1:2:3:4:5:6', 32), '2001:db8::/32');
    assert.equal(clientKey('2001:db8:1:2ff:3:4:5:6', 56), '2001:db8:1:200::/56');
    assert.equal(clientKey('2001:db8:1:2ff:3:4:5:6', 60), '2001:db8:1:2f0::/60');
    assert.equal(clientKey('2001:DB8:1:2:3:4:5:6', 128), '2001:db8:1:2:3:4:5:6/128');
    assert.equal(clientKey('2001:db8:1:2:3:4:5:6', 112), '2001:db8:1:2:3:4:5::/112');
    assert.equal(clientKey('2001:db8:1:2:3:4:5:6', 64), clientKey('2001:db8:1:2:3:4:5:6'));
    assert.equal(clientKey('2001:db8:1:2::1', 48), clientKey('2001:db8:1:ffff::1', 48));
    for (const address of ['203.0.113.5', '::ffff:203.0.113.5', '2002:cb00:7105::1', '2001:0:c000:201:0:0:34ff:8efa']) {
        assert.equal(clientKey(address, 32), '203.0.113.5', address);
    }
});

test('clientKey：6to4（2002::/16）取內嵌的 IPv4，同一個 IPv4 的各個 /64 與 IPv4 本身都是同一個桶', () => {
    for (const address of ['2002:cb00:7105::1', '2002:cb00:7105:1::1', '2002:CB00:7105:ffff:1:2:3:4', '[2002:cb00:7105:2::9]:443']) {
        assert.equal(clientKey(address), '203.0.113.5', address);
    }
    assert.equal(clientKey('2002:cb00:7106:1::1'), '203.0.113.6');
    // 2002 開頭的才是 6to4
    assert.equal(clientKey('2001:db8:7105:1::1'), '2001:db8:7105:1::/64');
});

// Teredo：2001:0:<伺服器的 IPv4>:<旗標>:<反相的埠>:<反相的用戶端 IPv4>。伺服器用 192.0.2.1、192.0.2.2，
// 用戶端 203.0.113.5 反相是 34ff:8efa（都是文件用的位址段）
test('clientKey：Teredo（2001:0::/32）取反相後的用戶端 IPv4，伺服器、旗標與埠換了也是同一個桶', () => {
    for (const address of ['2001:0:c000:201:0:0:34ff:8efa', '2001:0:c000:202:8000:1234:34ff:8efa', '2001::c000:201:0:ffff:34ff:8efa']) {
        assert.equal(clientKey(address), '203.0.113.5', address);
    }
    assert.equal(clientKey('2001:0:c000:201:0:0:34ff:8ef9'), '203.0.113.6');
    assert.equal(clientKey('2001:db8:c000:201::1'), '2001:db8:c000:201::/64');
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

test('parseCidr：IPv4、IPv6 的位址或 CIDR，前綴以外的位元清掉並標出 hostBits；zone id、方括號、埠、超過長度的前綴都不收', () => {
    assert.deepEqual(parseCidr('192.0.2.0/24'), { v6: false, bits: 24, base: 0xc0000200, hostBits: false });
    assert.deepEqual(parseCidr('192.0.2.5/24'), { v6: false, bits: 24, base: 0xc0000200, hostBits: true });
    assert.deepEqual(parseCidr('192.0.2.5'), { v6: false, bits: 32, base: 0xc0000205, hostBits: false });
    assert.deepEqual(parseCidr('2001:DB8:1:2::/48'), { ...parseCidr('2001:db8:1::/48'), hostBits: true });
    assert.equal(parseCidr('::1').bits, 128);
    for (const bad of ['', 'abc', '192.0.2.0/33', '2001:db8::/129', '192.0.2.01', 'fe80::1%eth0', 'fe80::1%eth0/64', '[2001:db8::1]', '192.0.2.1:80', '192.0.2.0/24/8', '192.0.2.0/']) {
        assert.equal(parseCidr(bad), null, bad);
    }
});

test('parseCidr：::ffff:a.b.c.d/(96+n) 換成 IPv4 的 a.b.c.d/n；formatCidr 寫回', () => {
    assert.deepEqual(parseCidr('::ffff:203.0.113.0/120'), parseCidr('203.0.113.0/24'));
    assert.deepEqual(parseCidr('::FFFF:CB00:7105'), parseCidr('203.0.113.5'));
    assert.deepEqual(parseCidr('::ffff:0:0/96'), parseCidr('0.0.0.0/0'));
    assert.equal(parseCidr('::ffff:0:0/95').v6, true);
    for (const [text, written] of [['::ffff:203.0.113.9/120', '203.0.113.0/24'], ['192.0.2.5', '192.0.2.5/32'], ['2001:DB8:1:2::/48', '2001:db8:1::/48'], ['2001:db8::1', '2001:db8:0:0:0:0:0:1/128']]) {
        assert.equal(formatCidr(parseCidr(text)), written, text);
        assert.deepEqual(parseCidr(written), { ...parseCidr(text), hostBits: false }, text);
    }
});

test('coversAllIPv4：IPv4 的 /0，以及包含 ::ffff:0:0/96 的 IPv6 範圍', () => {
    for (const text of ['0.0.0.0/0', '192.0.2.1/0', '::/0', '::/64', '::/80', '0:0:0::/48', '::ffff:0:0/96', '::ffff:0:0/95', '::ffff:192.0.2.4/96']) {
        assert.equal(coversAllIPv4(parseCidr(text)), true, text);
    }
    for (const text of ['0.0.0.0/1', '::/96', '::1', '0:0:0:0:0:fffe::/96', '2001:db8::/32', '2002::/16', '::ffff:192.0.2.0/120']) {
        assert.equal(coversAllIPv4(parseCidr(text)), false, text);
    }
});

test('blockRangeProblem：涵蓋所有 IPv4、比 IPv4 /8 或 IPv6 /16 大、前綴之後還有 1 的範圍不收', () => {
    const cases = {
        '0.0.0.0/0': 'all-ipv4', '::/0': 'all-ipv4', '::/80': 'all-ipv4', '::ffff:192.0.2.4/96': 'all-ipv4',
        '192.0.0.0/7': 'too-broad', '2000::/15': 'too-broad', '::ffff:192.0.2.4/97': 'too-broad',
        '203.0.113.0/2': 'too-broad', '198.51.100.7/24': 'host-bits', '2001:db8::1/32': 'host-bits',
        '10.0.0.0/8': null, '2001::/16': null, '192.0.2.7': null, '::ffff:192.0.2.0/120': null, '2001:db8:1::/48': null,
    };
    for (const [text, problem] of Object.entries(cases)) assert.equal(blockRangeProblem(parseCidr(text)), problem, text);
});

test('createSourceMatcher：IPv4 範圍比對 IPv4 位址與內嵌的用戶端 IPv4（對應位址、6to4、Teredo），::ffff: 寫法的範圍也是', () => {
    // 6to4 的 2002:c000:0207::/48 與 Teredo 反相後都是 192.0.2.7，跟 clientKey 取的一樣
    const addresses = ['192.0.2.7', '192.0.2.7:443', '::ffff:192.0.2.7', '::FFFF:C000:207', '[::ffff:192.0.2.7]:80', '::ffff:192.0.2.7%eth0', '2002:c000:207::1', '2002:C000:0207:ffff::9', '2001:0:c000:201:8000:63bf:3fff:fdf8'];
    for (const blocked of [createSourceMatcher(['192.0.2.0/24']), createSourceMatcher(['::ffff:192.0.2.0/120'])]) {
        for (const address of addresses) {
            assert.equal(blocked(address), true, address);
            assert.equal(clientKey(address), '192.0.2.7', address);
        }
        for (const address of ['203.0.113.9', '2002:cb00:7109::1', '2001:db8:c000:207::1', '::192.0.2.7', '', 'junk', undefined]) {
            assert.equal(blocked(address), false, String(address));
        }
    }
});

test('createSourceMatcher：IPv6 範圍比對原本的 IPv6 位址；寫錯或涵蓋所有 IPv4 的項目丟例外', () => {
    const blocked = createSourceMatcher(['2001:db8:1::/48', '2002::/16']);
    for (const address of ['2001:db8:1::1', '2001:DB8:1:FFFF:1:2:3:4', '[2001:db8:1::5]:443', '2001:db8:1::1%eth0', '2002:c000:207::1']) {
        assert.equal(blocked(address), true, address);
    }
    for (const address of ['2001:db8:2::1', '192.0.2.7', '::ffff:192.0.2.7', '::1']) {
        assert.equal(blocked(address), false, address);
    }
    assert.equal(createSourceMatcher([])('192.0.2.7'), false);
    for (const bad of ['192.0.2.0/33', '0.0.0.0/0', '::/0', '::/80', '203.0.113.0/2', '198.51.100.7/24']) {
        assert.throws(() => createSourceMatcher([bad]), /不合法的 CIDR/, bad);
    }
});

test('createSourceMatcher：前綴長度的邊界（IPv4 /8、/31、/32，IPv6 /16、/127、/128）', () => {
    const cases = [
        ['10.0.0.0/8', '10.255.255.255', '11.0.0.0'],
        ['192.0.2.6/31', '192.0.2.7', '192.0.2.8'],
        ['192.0.2.7/32', '192.0.2.7', '192.0.2.6'],
        ['2001::/16', '2001:ffff::1', '2002:1::1'],
        ['2001:db8::/127', '2001:db8::1', '2001:db8::2'],
        ['2001:db8::1/128', '2001:db8::1', '2001:db8::'],
    ];
    for (const [cidr, inside, outside] of cases) {
        const blocked = createSourceMatcher([cidr]);
        assert.equal(blocked(inside), true, `${cidr} ${inside}`);
        assert.equal(blocked(outside), false, `${cidr} ${outside}`);
    }
});

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
