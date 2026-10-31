/**
 * USAGE log 的計數（Usage）：各任務的請求數、拒絕的代號與原因、來源的個數，以及開始的任務數超過門檻的網段。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Usage } from '../src/usage.mjs';

// top 的「網段:次數」拆成 Map
const topOf = (fields) => new Map(fields.top ? fields.top.split(',').map((item) => {
    const at = item.lastIndexOf(':');
    return [item.slice(0, at), Number(item.slice(at + 1))];
}) : []);

test('take：交出這段時間的計數並歸零；名稱依字母排序', () => {
    let clock = Date.parse('2026-11-01T04:00:00Z');
    const usage = new Usage({ now: () => clock, threshold: 2 });
    for (const [task, tag] of [['starter-pack', 'a'], ['career-chat', 'a'], ['career-chat', 'b'], ['unknown', 'c']]) usage.request(task, tag);
    for (const prefix of ['203.0.113.0/24', '203.0.113.0/24', '203.0.113.0/24', '2001:db8:1::/48']) usage.start(prefix);
    usage.accept();
    usage.reject('busy', 'breaker');
    usage.reject('unknown_task');
    usage.reject('headers_too_large');
    clock += 3_600_000;
    assert.equal(usage.records, 12);
    assert.deepEqual(usage.take(), {
        from: '2026-11-01T04:00:00.000Z',
        requests: 4,
        accepted: 1,
        rejected: 'busy/breaker:1,headers_too_large:1,unknown_task:1',
        tasks: 'career-chat:2,starter-pack:1,unknown:1',
        sources: 3,
        top: '203.0.113.0/24:3',
    });
    assert.equal(usage.records, 0);
    assert.deepEqual(usage.take(), {
        from: '2026-11-01T05:00:00.000Z', requests: 0, accepted: 0, rejected: '', tasks: '', sources: 0, top: '',
    });
});

// 2026-11-01 第二輪審查的 probes/join.mjs：三個學生在三個 /24 各開了 4、2、1 個任務，原本 top 照列，
// 次數跟 TASK 裡三個雜湊的行數一對就知道是誰的網段
test('top 只列超過門檻的網段：一個來源開得到的任務數不會被列出來', () => {
    const usage = new Usage({ threshold: 700 });
    for (const [prefix, n] of [['203.0.113.0/24', 4], ['198.51.100.0/24', 2], ['192.0.2.0/24', 1]]) {
        for (let i = 0; i < n; i++) usage.start(prefix);
    }
    assert.equal(usage.take().top, '');
    for (let i = 0; i < 701; i++) usage.start('203.0.113.0/24');
    for (let i = 0; i < 700; i++) usage.start('198.51.100.0/24');
    assert.equal(usage.take().top, '203.0.113.0/24:701');
});

test('top 最多 5 個，依次數排；退回的次數扣掉；只有拒絕也算有東西可記', () => {
    const usage = new Usage({ threshold: 0 });
    for (let i = 1; i <= 7; i++) {
        for (let n = 0; n < i; n++) usage.start(`192.0.2.${i}/32`);
    }
    usage.unstart('192.0.2.7/32');
    usage.unstart('192.0.2.7/32');
    usage.unstart('198.51.100.0/24');
    assert.equal(usage.take().top, '192.0.2.6/32:6,192.0.2.5/32:5,192.0.2.7/32:5,192.0.2.4/32:4,192.0.2.3/32:3');
    usage.reject('headers_too_large');
    assert.equal(usage.records, 1);
});

test('來源的個數最多記 maxSources 個，再多寫成「maxSources+」', () => {
    const usage = new Usage({ maxSources: 3 });
    for (const tag of ['a', 'b', 'a', 'c']) usage.request('demo', tag);
    assert.equal(usage.take().sources, 3);
    for (const tag of ['a', 'b', 'c', 'd', 'a']) usage.request('demo', tag);
    assert.equal(usage.take().sources, '3+');
});

// 2026-11-01 第二輪審查的 probes/hide.mjs：依來源計再依網段加總時，表滿了之後一個 /24 裡 30 個學生被列成
// 330，攻擊者也能換網段把自己藏起來。改成依網段計、只列確定的下限
test('網段的表滿了之後：列出的次數不會比實際多，用得多的網段照樣列出', () => {
    const usage = new Usage({ capacity: 100, threshold: 0 });
    const truth = new Map();
    const start = (prefix) => {
        usage.start(prefix);
        truth.set(prefix, (truth.get(prefix) ?? 0) + 1);
    };
    for (let i = 0; i < 20_000; i++) start(`2001:db8:${(i % 5_000).toString(16)}::/48`);
    for (let i = 0; i < 30; i++) start('203.0.113.0/24');
    for (let i = 0; i < 3_000; i++) start('198.51.100.0/24');
    for (let i = 0; i < 2_000; i++) start(`2001:db8:${(i + 5_000).toString(16)}::/48`);
    assert.equal(usage.heap.length, 100);
    const top = topOf(usage.take());
    for (const [prefix, count] of top) assert.ok(count <= truth.get(prefix), `${prefix} 列成 ${count}，實際 ${truth.get(prefix)}`);
    assert.ok(top.get('198.51.100.0/24') > 2_000, [...top].join(' '));
    assert.ok((top.get('203.0.113.0/24') ?? 0) <= 30);
});

// 跟直接照 Space-Saving 寫的參考實作逐步比對：換掉的一定是次數最少的，堆、索引與 Map 一致
test('最小堆與參考實作一致（含退回次數）', () => {
    let seed = 1;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x80000000;
    };
    for (let trial = 0; trial < 200; trial++) {
        const capacity = 1 + Math.floor(random() * 12);
        const usage = new Usage({ capacity });
        const reference = new Map();
        for (let n = Math.floor(random() * 400); n > 0; n--) {
            const prefix = `p${Math.floor(30 * random() ** 2)}`;
            if (random() < 0.2) {
                usage.unstart(prefix);
                const entry = reference.get(prefix);
                if (entry && entry.count > entry.error) entry.count--;
            } else if (reference.has(prefix)) {
                usage.start(prefix);
                reference.get(prefix).count++;
            } else if (reference.size < capacity) {
                usage.start(prefix);
                reference.set(prefix, { count: 1, error: 0 });
            } else {
                const min = Math.min(...[...reference.values()].map((e) => e.count));
                const victim = usage.heap[0].prefix;
                assert.equal(reference.get(victim).count, min);
                usage.start(prefix);
                reference.delete(victim);
                reference.set(prefix, { count: min + 1, error: min });
            }
            assert.equal(usage.prefixes.size, reference.size);
            for (const [i, entry] of usage.heap.entries()) {
                assert.equal(entry.i, i);
                assert.equal(usage.prefixes.get(entry.prefix), entry);
                assert.deepEqual({ count: entry.count, error: entry.error }, reference.get(entry.prefix));
                for (const child of [2 * i + 1, 2 * i + 2]) {
                    if (child < usage.heap.length) assert.ok(entry.count <= usage.heap[child].count);
                }
            }
        }
    }
});
