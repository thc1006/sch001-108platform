#!/usr/bin/env node
/**
 * 看門狗連結健檢的狀態機測試
 * --------------------------------------------------------------
 * 全部打本機 http server，不依賴外網——外網測試會因防爬與站台狀態而飄。
 *
 * 執行：  node --test scripts/
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

import { probe, isDeadResult, classifyLink, validateUrl, validateCycle, nextOccurrenceUTC, ALLOWED_FORMS } from './check-competitions.lib.mjs';
import { ALLOWED_COMPETITION_FIELDS, TEXT_FIELDS, validateInstant, validateDateOnly, validateSchedule } from './check-competitions.lib.mjs';
import { selectNeedsRecheck, sourceCheckedProblem } from './check-competitions.lib.mjs';
import { selectCanonicalIssue, WATCHDOG_MARKER, ACTIONS_APP_LOGIN } from './watchdog-issue.lib.mjs';

let base;
let server;
let goneHits = 0;
let flakyHits = 0;

before(async () => {
    server = createServer((req, res) => {
        const url = req.url;
        // HEAD 回 200、GET 回 404：只靠 HEAD 判斷會誤判為健康
        if (url === '/head-ok-get-gone') {
            if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
            goneHits++;
            res.writeHead(404); return res.end('gone');
        }
        // HEAD 回 404、GET 回 200：只靠 HEAD 判斷會誤判為失效（Kaggle / tpmso.org 的真實情況）
        if (url === '/head-gone-get-ok') {
            if (req.method === 'HEAD') { res.writeHead(404); return res.end(); }
            res.writeHead(200); return res.end('<html>ok</html>');
        }
        if (url === '/ok') { res.writeHead(200); return res.end('<html>ok</html>'); }
        if (url === '/404') { res.writeHead(404); return res.end('nope'); }
        if (url === '/410') { res.writeHead(410); return res.end('gone'); }
        if (url === '/403') { res.writeHead(403); return res.end('forbidden'); }
        if (url === '/429') { res.writeHead(429); return res.end('slow down'); }
        if (url === '/500') { res.writeHead(500); return res.end('boom'); }
        // 第一次 404、之後 200：重試機制應把它救回來
        if (url === '/flaky') {
            flakyHits++;
            if (flakyHits === 1) { res.writeHead(404); return res.end(); }
            res.writeHead(200); return res.end('<html>ok</html>');
        }
        if (url === '/slow') { return; } // 不回應，用來測逾時
        if (url === '/redirect') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
        res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// ── probe 的方法選擇 ──

test('HEAD 200 但 GET 404 → 必須判定為失效（不可只信 HEAD）', async () => {
    const r = await probe(`${base}/head-ok-get-gone`);
    assert.equal(r.status, 404);
    assert.equal(isDeadResult(r), true);
    assert.ok(goneHits > 0, '必須真的送出 GET');
});

test('HEAD 404 但 GET 200 → 必須判定為健康（不可只信 HEAD）', async () => {
    const r = await probe(`${base}/head-gone-get-ok`);
    assert.equal(r.status, 200);
    assert.equal(isDeadResult(r), false);
});

// ── 狀態碼分類 ──

test('404 / 410 → dead', async () => {
    for (const p of ['/404', '/410']) {
        const r = await probe(`${base}${p}`);
        assert.equal(classifyLink(r), 'dead', `${p} 應為 dead`);
    }
});

test('403 / 429 / 500 → unverified（防爬與暫時性故障不可開 issue）', async () => {
    for (const p of ['/403', '/429', '/500']) {
        const r = await probe(`${base}${p}`);
        assert.equal(classifyLink(r), 'unverified', `${p} 應為 unverified`);
    }
});

test('200 與轉址後 200 → healthy', async () => {
    assert.equal(classifyLink(await probe(`${base}/ok`)), 'healthy');
    assert.equal(classifyLink(await probe(`${base}/redirect`)), 'healthy');
});

test('網域無法解析 (ENOTFOUND) → dead', async () => {
    const r = await probe('https://this-domain-must-not-exist-4b81f2a9.invalid/');
    assert.equal(r.status, 0);
    assert.equal(r.code, 'ENOTFOUND');
    assert.equal(classifyLink(r), 'dead');
});

test('逾時 → unverified，不可當成失效', async () => {
    const r = await probe(`${base}/slow`, AbortSignal.timeout(300));
    assert.equal(r.status, 0);
    assert.equal(classifyLink(r), 'unverified');
});

test('第一次 404、重試 200 → 最終視為健康', async () => {
    let r = await probe(`${base}/flaky`);
    assert.equal(classifyLink(r), 'dead', '第一次應為 dead 才會觸發重試');
    if (isDeadResult(r)) r = await probe(`${base}/flaky`);
    assert.equal(classifyLink(r), 'healthy');
});

test('GET 的 response body 一定要被釋放（不可依賴 GC）', async () => {
    // probe 內部在 finally cancel；若漏掉，重複呼叫會逐漸卡住連線池。
    // 這裡以「連續多次仍能在合理時間內完成」作為回歸偵測。
    const started = Date.now();
    for (let i = 0; i < 30; i++) {
        const r = await probe(`${base}/ok`);
        assert.equal(r.status, 200);
    }
    assert.ok(Date.now() - started < 10_000, '連續 30 次 GET 不應變慢或卡住');
});

// ── schema 驗證 ──

test('拼錯協定 / 非 https / 內嵌帳密的 url 必須被 schema 攔下', () => {
    for (const bad of ['htps://example.com', ' https://example.com', 'https://', 'javascript:alert(1)', 'http://example.com', 'https://u:p@example.com']) {
        const errs = [];
        validateUrl(bad, '測試', errs);
        assert.ok(errs.length > 0, `「${bad}」應產生 schema 錯誤`);
    }
});

test('合法 https url 不應產生錯誤', () => {
    const errs = [];
    validateUrl('https://example.com/path?q=1', '測試', errs);
    assert.equal(errs.length, 0);
});

test('form 只接受三種值', () => {
    assert.deepEqual(ALLOWED_FORMS, ['個人', '團體', '個人/團體']);
    assert.ok(!ALLOWED_FORMS.includes('個人與團隊'));
});

// ── 年度週期（cycle）──

test('cycle：只知月份時取該月最後一天（保守，不會誤判成已截止）', () => {
    const today = Date.UTC(2026, 7, 2); // 2026-08-02
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    assert.equal(iso(nextOccurrenceUTC('03', today)), '2027-03-31');
    assert.equal(iso(nextOccurrenceUTC('12', today)), '2026-12-31');
});

test('cycle：今年已過就推到明年，未到則用今年', () => {
    const today = Date.UTC(2026, 7, 2);
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    assert.equal(iso(nextOccurrenceUTC('07-31', today)), '2027-07-31');
    assert.equal(iso(nextOccurrenceUTC('09-15', today)), '2026-09-15');
});

test('cycle：當天算「還沒過」', () => {
    const today = Date.UTC(2026, 7, 2);
    assert.equal(new Date(nextOccurrenceUTC('08-02', today)).toISOString().slice(0, 10), '2026-08-02');
});

test('cycle：格式錯誤回 null，不可靜默當成有效', () => {
    const today = Date.UTC(2026, 7, 2);
    for (const bad of ['13', '00', '07-32', '7-1', '2026-07-31', '', null, undefined]) {
        assert.equal(nextOccurrenceUTC(bad, today), null, `${bad} 應為 null`);
    }
});

test('cycle：schema 驗證攔下非法值', () => {
    const cases = [
        [{ closes: '13-01' }, '月份超界'],
        [{ opens: '7' }, '未補零'],
        [{ foo: 1 }, '未知欄位'],
        [{}, '全空'],
        ['not-object', '非物件'],
        [{ note: '  ' }, 'note 空白'],
    ];
    for (const [val, why] of cases) {
        const errs = [];
        validateCycle(val, '測試', errs);
        assert.ok(errs.length > 0, `${why} 應被攔下`);
    }
});

test('cycle：合法值與未提供都不報錯', () => {
    for (const ok of [undefined, { closes: '07-31' }, { opens: '01', closes: '07-31' }, { note: '不定期' }]) {
        const errs = [];
        validateCycle(ok, '測試', errs);
        assert.equal(errs.length, 0, `${JSON.stringify(ok)} 不應報錯`);
    }
});

test('cycle：不存在的日期必須被攔下（02-30、04-31…）', () => {
    for (const bad of ['02-30', '02-31', '04-31', '06-31', '09-31', '11-31']) {
        const errs = [];
        validateCycle({ closes: bad }, '測試', errs);
        assert.ok(errs.length > 0, `${bad} 不是實際存在的日期，應被攔下`);
    }
    // 02-29 僅閏年存在，仍屬合法設定
    const errs = [];
    validateCycle({ closes: '02-29' }, '測試', errs);
    assert.equal(errs.length, 0, '02-29 應視為合法');
});

test('cycle：02-29 在平年退回 2/28，不可靜默跨月到 3/1', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    assert.equal(iso(nextOccurrenceUTC('02-29', Date.UTC(2027, 0, 1))), '2027-02-28');
    assert.equal(iso(nextOccurrenceUTC('02-29', Date.UTC(2028, 0, 1))), '2028-02-29');
});




// ── 報名時程欄位 ──
const errsOf = (fn) => {
    const e = [];
    fn(e);
    return e;
};

test('schedule：時刻必須帶明確時區位移', () => {
    // 省略時區的時刻會被瀏覽器當成使用者的本地時間解析，同一筆資料在不同時區的人
    // 眼中是不同的時刻——正是這組欄位要修掉的問題本身，不能容忍再猜一個時區。
    for (const good of ['2026-09-15T23:59:00-07:00', '2026-11-04T14:00:00-05:00', '2026-05-18T23:59:00+08:00', '2026-01-01T00:00Z']) {
        assert.deepEqual(errsOf((e) => validateInstant(good, 'deadlineAt', 'X', e)), [], `${good} 應被接受`);
    }
    for (const bad of ['2026-09-15T23:59:00', '2026-09-15', '2026-09-15T25:00:00Z', '2026-02-30T00:00:00Z', 42, null]) {
        assert.ok(errsOf((e) => validateInstant(bad, 'deadlineAt', 'X', e)).length > 0, `${bad} 應被拒絕`);
    }
    // undefined＝未提供，選填欄位不得報錯
    assert.deepEqual(errsOf((e) => validateInstant(undefined, 'deadlineAt', 'X', e)), []);
});

test('schedule：純日期欄位攔得住不存在的日期', () => {
    assert.deepEqual(errsOf((e) => validateDateOnly('2026-11-14', 'eventStartsAt', 'X', e)), []);
    for (const bad of ['2026-02-30', '2026-13-01', '2026-11-31', '26-11-14', '2026/11/14']) {
        assert.ok(errsOf((e) => validateDateOnly(bad, 'eventStartsAt', 'X', e)).length > 0, `${bad} 應被拒絕`);
    }
});

test('schedule：欄位之間的先後關係', () => {
    const bad = (comp) => errsOf((e) => validateSchedule(comp, 'X', e));

    // 賽事結束早於開始
    assert.ok(bad({ eventStartsAt: '2026-11-15', eventEndsAt: '2026-11-14' }).some((m) => m.includes('早於')));
    // 只有結束沒有開始＝資料寫了一半
    assert.ok(bad({ eventEndsAt: '2026-11-15' }).some((m) => m.includes('沒有 eventStartsAt')));
    // 報名開放不早於截止
    assert.ok(
        bad({ opensAt: '2026-09-16T00:00:00Z', deadlineAt: '2026-09-15T00:00:00Z' }).some((m) => m.includes('不早於')),
    );
    // deadline 與 deadlineAt 的日期部分不一致——頁面只採用 deadlineAt，另一個會靜默變錯
    assert.ok(
        bad({ deadline: '2026-09-14', deadlineAt: '2026-09-15T23:59:00-07:00' }).some((m) => m.includes('不一致')),
    );
    // 合法組合不得報錯
    assert.deepEqual(
        bad({
            deadline: '2026-11-04',
            deadlineAt: '2026-11-04T14:00:00-05:00',
            eventStartsAt: '2026-11-04',
            eventEndsAt: '2026-11-17',
            sourceCheckedAt: '2026-08-27',
        }),
        [],
    );
});

test('schedule：registrationNote 有長度上限', () => {
    const bad = (comp) => errsOf((e) => validateSchedule(comp, 'X', e));
    assert.deepEqual(bad({ registrationNote: '報名開放中 · 依所在地活動時間' }), []);
    assert.ok(bad({ registrationNote: '' }).length > 0);
    // 它會直接當狀態列文字，過長會撐破卡片版面
    assert.ok(bad({ registrationNote: '報'.repeat(31) }).some((m) => m.includes('過長')));
});

// ── 前端狀態：時區行為 ──
// 這是本次要修的實際錯誤。Breakthrough 官方截止 2026-09-15 23:59 PDT ＝ 台灣
// 9/16 14:59。只存日期的話，台灣 9/15 凌晨就顯示「今日截止」（實際還有 39 小時），
// 9/16 00:00 起顯示「已截止」（實際還有近 15 小時）。
test('status：帶時區的截止時刻在跨日邊界上不得算錯', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url), 'utf8');
    const grab = (name) => {
        const m = src.match(new RegExp(`function ${name}\\((?:[^)]*)\\) \\{[\\s\\S]*?\\n      \\}`));
        assert.ok(m, `在 competitions.astro 抽不到 ${name}——若已改名請同步更新本測試`);
        return m[0];
    };
    const bundle = ['todayTaipeiUTC', 'taipeiDayUTC', 'nextOccurrenceUTC', 'fmtUTC', 'getStatus', 'statusText']
        .map(grab)
        .join('\n');

    const comp = {
        deadline: '2026-09-15',
        deadlineAt: '2026-09-15T23:59:00-07:00',
        cycle: { closes: '09-15' },
    };
    const at = (iso) => {
        const fixed = new Date(iso).getTime();
        // 只在被抽出的程式碼範圍內遮蔽 Date，不污染全域
        class FixedDate extends Date {
            constructor(...a) {
                super(...(a.length ? a : [fixed]));
            }
            static now() {
                return fixed;
            }
        }
        const f = new Function('Date', `${bundle}; return { getStatus, statusText };`)(FixedDate);
        return f.statusText(f.getStatus(comp));
    };

    assert.equal(at('2026-09-15T00:00:00Z'), '即將截止 · 剩 1 天', '台灣 9/15 08:00：還有 1 天多，不是今日截止');
    assert.equal(at('2026-09-15T16:00:00Z'), '今日截止', '台灣 9/16 00:00：還有近 15 小時，不是已截止');
    assert.equal(at('2026-09-16T06:00:00Z'), '今日截止', '台灣 9/16 14:00：截止前一小時仍可報名');
    assert.match(at('2026-09-16T07:30:00Z'), /^本屆已截止/, '台灣 9/16 15:30：確實已過');
});

test('status：報名尚未開放時不得顯示「報名中」', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url), 'utf8');
    const grab = (name) => src.match(new RegExp(`function ${name}\\((?:[^)]*)\\) \\{[\\s\\S]*?\\n      \\}`))[0];
    const bundle = ['todayTaipeiUTC', 'taipeiDayUTC', 'nextOccurrenceUTC', 'fmtUTC', 'getStatus', 'statusText']
        .map(grab)
        .join('\n');

    const fixed = new Date('2026-01-10T00:00:00Z').getTime();
    class FixedDate extends Date {
        constructor(...a) {
            super(...(a.length ? a : [fixed]));
        }
        static now() {
            return fixed;
        }
    }
    const f = new Function('Date', `${bundle}; return { getStatus, statusText };`)(FixedDate);

    // 報名 2/23 才開放、5/18 截止。先前只要 deadline 在未來就一律「報名中」，
    // 即使報名根本還沒開始——學生點進去只會看到「敬請期待」。
    const s = f.getStatus({
        deadline: '2026-05-18',
        deadlineAt: '2026-05-18T23:59:00+08:00',
        opensAt: '2026-02-23T00:00:00+08:00',
    });
    assert.equal(s.key, 'upcoming');
    assert.match(f.statusText(s), /尚未開放/);
});


// 篩選 chip 是寫死在 HTML 裡的，而狀態 key 是 JS 算出來的。新增一個狀態卻忘了加
// chip，那些競賽在使用者點任一篩選時就會整批消失——實作這次改動時我就先犯了一次。
// 這個測試把兩邊綁在一起。
test('status：每個狀態 key 都要有對應的篩選 chip 與樣式', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url), 'utf8');

    const orderLine = src.match(/const STATUS_ORDER = \{([^}]*)\}/);
    assert.ok(orderLine, '抽不到 STATUS_ORDER——若已改名請同步更新本測試');
    const keys = [...orderLine[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    assert.ok(keys.length >= 5, `STATUS_ORDER 只抽到 ${keys.length} 個 key，抽取邏輯可能壞了`);

    // getStatus 實際可能回傳的 key，必須是 STATUS_ORDER 的子集（排序表不可漏）
    const produced = [...src.matchAll(/return \{ key: '(\w+)'/g)].map((m) => m[1]);
    for (const k of new Set(produced)) {
        assert.ok(keys.includes(k), `getStatus 會回傳 '${k}'，但 STATUS_ORDER 沒有它——排序會是 undefined`);
    }

    for (const k of keys) {
        assert.ok(src.includes(`.is-${k} .comp-status`), `狀態 '${k}' 沒有對應的 .is-${k} .comp-status 樣式`);
        // 'closed' 刻意不提供篩選：已經結束又沒有週期的競賽對學生沒有可行動性，
        // 只在「全部」裡出現。其餘每個 key 都必須可篩選。
        if (k === 'closed') continue;
        assert.ok(
            src.includes(`data-status="${k}"`),
            `狀態 '${k}' 沒有對應的篩選 chip——使用者點任一篩選時這些競賽會整批消失`,
        );
        assert.ok(src.includes(`dot-${k}`), `狀態 '${k}' 的 chip 缺少 dot-${k} 顏色`);
    }
});

// ── 已查證的五筆資料 ──
// 這五筆是逐一開官網查證過的。寫成測試是為了讓「改回錯的值」變成紅燈，而不是
// 靠人記得。若官方日期真的變了，改測試與改資料要一起做。
test('data：五筆已查證競賽的報名時程不得被改回錯的值', async () => {
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(
        readFileSync(new URL('../public/advanced-resources/competitions.json', import.meta.url), 'utf8'),
    );
    const find = (needle) => {
        const hits = data.competitions.filter((c) => c.title.includes(needle));
        assert.equal(hits.length, 1, `「${needle}」應恰好比對到 1 筆`);
        return hits[0];
    };

    // OPhO：官網只公布 8/21–23 的比賽日期，沒有報名截止日。
    const opho = find('OPhO');
    assert.equal(opho.deadline, '', 'OPhO 的比賽日期不可再被填進 deadline 顯示成「報名截止」');
    assert.equal(opho.eventStartsAt, '2026-08-21');
    assert.equal(opho.eventEndsAt, '2026-08-23');

    // Samsung：初賽報名 2/23 – 5/18 23:59（台灣時間）
    const samsung = find('Solve for Tomorrow');
    assert.equal(samsung.deadlineAt, '2026-05-18T23:59:00+08:00');
    assert.equal(samsung.opensAt, '2026-02-23T00:00:00+08:00');

    // HiMCM：報名截止 11/4 14:00 EST，賽程 11/4–11/17
    const himcm = find('HiMCM');
    assert.equal(himcm.deadlineAt, '2026-11-04T14:00:00-05:00');
    assert.equal(himcm.eventEndsAt, '2026-11-17');

    // NASA：無全球統一截止日，11/14 是活動開始而非報名截止
    const nasa = find('Space Apps');
    assert.equal(nasa.deadline, '');
    assert.equal(nasa.eventStartsAt, '2026-11-14');
    assert.ok(!nasa.cycle?.closes, 'NASA 不得再把活動開始日當成 cycle.closes');
    assert.ok(nasa.registrationNote, '應說明報名規則而不是捏造一個截止日');

    // Breakthrough：9/15 23:59 PDT
    assert.equal(find('Breakthrough').deadlineAt, '2026-09-15T23:59:00-07:00');

    // 用共用的驗證器，不要再寫死日期。這裡原本是 assert.equal(..., '2026-08-27')——
    // 訊息說「應記錄逐筆查證日期」，實作卻要求等於某一天，於是任何人重新查證都
    // 無法更新它。HiMCM 在 2026-08-28 確實重查過（comap.com → 301 → comap.org）。
    for (const t of ['OPhO', 'Solve for Tomorrow', 'HiMCM', 'Space Apps', 'Breakthrough']) {
        const why = sourceCheckedProblem(find(t).sourceCheckedAt);
        assert.equal(why, null, `${t} 應記錄逐筆查證日期，但它 ${why}`);
    }
});

// ── 競賽物件的欄位白名單 ──
// cycle 內部本來就有同類的白名單，但物件本身先前沒有。"cyle"（少一個 c）這種錯字
// 只要必填欄位都在就會通過驗證，前端則靜默忽略它——該筆競賽的週期資訊等於憑空
// 消失且沒有任何訊號。
test('schema：實際資料不得出現白名單以外的欄位', async () => {
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(
        readFileSync(new URL('../public/advanced-resources/competitions.json', import.meta.url), 'utf8'),
    );
    const seen = new Set();
    for (const c of data.competitions) for (const k of Object.keys(c)) seen.add(k);
    const unknown = [...seen].filter((k) => !ALLOWED_COMPETITION_FIELDS.has(k));
    assert.deepEqual(
        unknown,
        [],
        `competitions.json 出現白名單以外的欄位：${unknown.join('、')}。` +
            '若是刻意新增的欄位，請同步更新 ALLOWED_COMPETITION_FIELDS；若是錯字，請修正資料。',
    );
    // 反向：白名單裡的必填欄位每一筆都要有，否則白名單形同虛設
    for (const f of TEXT_FIELDS) {
        assert.ok(seen.has(f), `白名單列了 ${f}，但實際資料一筆都沒有——白名單與資料已漂移`);
    }
});

test('schema：常見錯字不在白名單內', () => {
    // 這幾個都是實際容易打錯的形狀，全部必須被視為未知欄位而攔下
    for (const typo of ['cyle', 'cycles', 'Cycle', 'deadLine', 'dead_line', 'URL']) {
        assert.ok(!ALLOWED_COMPETITION_FIELDS.has(typo), `${typo} 不該在白名單內`);
    }
});

// ── 看門狗的 issue 認領 ──
// 這五個情境先前只用人工假造的 gh 驗過一次，沒有留下回歸測試——而認領邏輯正是
// 出過事的那一段：#70（人工開立）用了同一個標籤，連續四週的週報全貼到那裡。
// 判斷邏輯移到 watchdog-issue.lib.mjs 之後，這裡把五個情境固定下來。
const bot = (number, body) => ({ number, author: { login: ACTIONS_APP_LOGIN }, body });
const human = (number, body) => ({ number, author: { login: 'thc1006' }, body });

test('watchdog：人工開立的 issue 即使貼了同一個標籤也不接管', () => {
    // 實際發生過的情況：#70 是人工開的，標籤相同。標籤是共用屬性，不能單獨決定歸屬。
    const r = selectCanonicalIssue([human(70, `追蹤：資料稽核\n${WATCHDOG_MARKER}`)]);
    assert.deepEqual(r, { action: 'create' }, '人工 issue 就算 body 有標記也不得接管');
});

test('watchdog：Actions 開的但沒有機器標記時不接管', () => {
    // repo 內其他自動化同樣以 Actions App 身分開 issue，只看作者會誤認。
    assert.deepEqual(selectCanonicalIssue([bot(80, '別的 workflow 開的 issue')]), { action: 'create' });
});

test('watchdog：作者與標記都符合時接管既有 issue', () => {
    assert.deepEqual(selectCanonicalIssue([bot(81, `${WATCHDOG_MARKER}\n\n上週報告`)]), {
        action: 'comment',
        number: 81,
    });
});

test('watchdog：完全沒有候選時新開 issue', () => {
    assert.deepEqual(selectCanonicalIssue([]), { action: 'create' });
});

test('watchdog：出現多個 canonical issue 時必須大聲失敗，不可安靜取第一個', () => {
    // 取第一個會讓另一個永遠收不到報告，而且沒有任何訊號——正是本 issue 在修的失效模式。
    const r = selectCanonicalIssue([bot(91, WATCHDOG_MARKER), bot(90, WATCHDOG_MARKER)]);
    assert.equal(r.action, 'fail');
    assert.deepEqual(r.numbers, [90, 91], '應列出全部重複的 issue 供人工處理');
});

test('watchdog：畸形輸入不得被當成可接管', () => {
    const bad = [null, undefined, 'x', 42, {}, { number: 1 }, { author: { login: ACTIONS_APP_LOGIN } }];
    assert.deepEqual(selectCanonicalIssue(bad), { action: 'create' });
    assert.deepEqual(selectCanonicalIssue(null), { action: 'create' });
    // number 不是整數時不可接管——後續會被當成 issue 編號傳給 gh
    assert.deepEqual(
        selectCanonicalIssue([{ number: '81', author: { login: ACTIONS_APP_LOGIN }, body: WATCHDOG_MARKER }]),
        { action: 'create' },
    );
});

// workflow 實際呼叫的是 CLI，不是函式本身。只測函式會漏掉 stdin 解析、輸出格式與
// 退出碼這層接線——而 workflow 正是靠退出碼決定要不要中止。
test('watchdog：CLI 的輸出格式與退出碼', async () => {
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    // 用 fileURLToPath 而非手刻 pathname 轉換：pathname 是 percent-encoded，
    // 路徑含空白或非 ASCII（本 repo 就在 .claude/worktrees 下）時會解析錯誤。
    const cli = fileURLToPath(new URL('./find-watchdog-issue.mjs', import.meta.url));
    const run = (payload) =>
        execFileSync(process.execPath, [cli], { input: JSON.stringify(payload), encoding: 'utf8' }).trim();

    assert.equal(run([]), 'create');
    assert.equal(run([bot(81, WATCHDOG_MARKER)]), 'comment 81');
    assert.equal(run([human(70, WATCHDOG_MARKER)]), 'create');

    let code = 0;
    let stderr = '';
    try {
        execFileSync(process.execPath, [cli], {
            input: JSON.stringify([bot(90, WATCHDOG_MARKER), bot(91, WATCHDOG_MARKER)]),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err) {
        code = err.status;
        stderr = String(err.stderr);
    }
    assert.equal(code, 2, '多個 canonical issue 必須以非零退出碼中止 workflow');
    assert.match(stderr, /#90/, '錯誤訊息要指名重複的 issue');
    assert.match(stderr, /#91/);
});

// ── 前後端邏輯防漂移 ──
// nextOccurrenceUTC 在 lib（Node）與 competitions.astro（瀏覽器 is:inline）各有
// 一份實作——後者無法 import Node 模組。兩份若漂移，頁面與看門狗就會對同一筆
// 競賽給出不同的「下次截止日」。這個測試把 .astro 裡那份抽出來實際比對。
test('cycle：頁面與看門狗的推算結果必須完全一致', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url), 'utf8');
    const m = src.match(/function nextOccurrenceUTC\((?:[^)]*)\) \{[\s\S]*?\n      \}/);
    assert.ok(m, '在 competitions.astro 找不到 nextOccurrenceUTC——若已改名請同步更新本測試');

    const browserFn = new Function(`${m[0]}; return nextOccurrenceUTC;`)();

    const days = ['01-01', '01', '02-28', '02-29', '03', '06-30', '07-31', '08', '12', '12-31', '13-01', '02-30', '', 'x'];
    const bases = [Date.UTC(2026, 7, 2), Date.UTC(2027, 0, 1), Date.UTC(2028, 1, 29), Date.UTC(2026, 11, 31)];
    // 第三維：lastEditionUTC（null＝未知本屆；其餘為已過的本屆截止日）
    const lasts = [null, Date.UTC(2026, 7, 21), Date.UTC(2024, 0, 15), Date.UTC(2026, 6, 31), Date.UTC(2025, 11, 20), Date.UTC(2026, 0, 15)];
    for (const c of days) {
        for (const t of bases) {
            for (const le of lasts) {
                assert.equal(
                    browserFn(c, t, le),
                    nextOccurrenceUTC(c, t, le),
                    `closes=${c} today=${new Date(t).toISOString().slice(0, 10)} last=${le} 兩份實作結果不一致`,
                );
            }
        }
    }
});

test('cycle：已知本屆截止日時，下屆須在隔年——不可算成同月月底', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    // OPhO 實例：本屆 2026-08-21 辦完，週期僅精確到月（08），今天 2026-08-27。
    // 未傳 lastEdition 會得到同月的 08-31（誤報「下屆剩 4 天」）。
    const today = Date.UTC(2026, 7, 27);
    assert.equal(iso(nextOccurrenceUTC('08', today)), '2026-08-31', '未傳 lastEdition 時維持原行為');
    assert.equal(iso(nextOccurrenceUTC('08', today, Date.UTC(2026, 7, 21))), '2027-08-31');
    // MM-DD 精度同理
    assert.equal(iso(nextOccurrenceUTC('07-31', today, Date.UTC(2026, 6, 31))), '2027-07-31');
});

// 「本屆年份 + 1」在跨年季會整整漏掉一輪：截止日 2026-01-15、週期記 12 月時，
// 那個截止日屬於 2025-12 那一輪，下一輪是 2026-12 而非 2027-12。實際發生時，頁面
// 會把還能報名的一整年說成「下次約 2027」。現在改為先把本屆對應回最近的週期實例。
test('cycle：跨年季不可漏掉一整輪', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);

    // 月份精度：1 月的截止日屬於前一年 12 月那一輪
    assert.equal(iso(nextOccurrenceUTC('12', today, Date.UTC(2026, 0, 15))), '2026-12-31');
    // 日精度同理
    assert.equal(iso(nextOccurrenceUTC('12-20', today, Date.UTC(2026, 0, 5))), '2026-12-20');
    // 反向：12 月的截止日配 1 月的週期，屬於「隔年 1 月」那一輪，下一輪是再隔年
    assert.equal(iso(nextOccurrenceUTC('01', today, Date.UTC(2025, 11, 20))), '2027-01-31');
});

test('cycle：截止月與週期月相符時，錨定結果與原本一致', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);
    // 同月（OPhO）
    assert.equal(iso(nextOccurrenceUTC('08', today, Date.UTC(2026, 7, 21))), '2027-08-31');
    // 同月同日
    assert.equal(iso(nextOccurrenceUTC('10-30', today, Date.UTC(2025, 9, 30))), '2026-10-30');
});

test('cycle：週期在兩屆之間被改動時，取離本屆最近的實例當錨點', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);
    // 本屆確切截止 2026-03-10，但 cycle 已被更新成 10 月（主辦單位改期）。
    // 2026-10 仍在未來，不應該跳過它而報 2027-10。
    assert.equal(iso(nextOccurrenceUTC('10', today, Date.UTC(2026, 2, 10))), '2026-10-31');
});

test('cycle：跨年季且資料久未更新時，仍推到未來而非停在過去', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);
    // 本屆停在 2023-01-15、週期記 12 月：錨點是 2022-12，往後推須一路到 2026-12
    assert.equal(iso(nextOccurrenceUTC('12', today, Date.UTC(2023, 0, 15))), '2026-12-31');
});

test('cycle：lastEdition 已過一年以上時，持續往後推到未來', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);
    // 本屆停留在 2023 的資料：2024/2025/2026 的週期都已過，應推到 2027
    assert.equal(iso(nextOccurrenceUTC('03', today, Date.UTC(2023, 2, 1))), '2027-03-31');
});

// ── 狀態未知且太久沒重查 ─────────────────────────────────────
//
// 這一桶是看門狗先前完全沒有覆蓋到的：🔴 那一段只看已過期的 deadline，
// 🔁 那一段第一行就是「沒有 cycle 就跳過」。2026-08-29 實測 119 筆裡有 90 筆
// 兩邊都不屬於，而且沒有一筆帶已過期的 deadline——沒有任何東西會叫人回去看它們。
const TODAY = Date.UTC(2026, 7, 29); // 2026-08-29
const ago = (n) => new Date(TODAY - n * 86400000).toISOString().slice(0, 10);

test('recheck：沒有 deadline 也沒有 cycle、且太久沒查的才會被列出', () => {
    const list = [
        { title: '該列出', sourceCheckedAt: ago(120) },
        { title: '剛查過', sourceCheckedAt: ago(10) },
    ];
    const out = selectNeedsRecheck(list, TODAY, 90);
    assert.deepEqual(out.map((r) => r.title ?? r.label), ['該列出']);
    assert.equal(out[0].days, 120);
});

test('recheck：有 cycle.closes 的不在這一桶——它由「下屆將近」那一段負責', () => {
    const list = [{ title: '有週期', sourceCheckedAt: ago(400), cycle: { closes: '05' } }];
    assert.deepEqual(selectNeedsRecheck(list, TODAY, 90), []);
});

test('recheck：有確切 deadline 的不在這一桶（未來＝已知，已過＝由 🔴 負責）', () => {
    const list = [
        { title: '未來截止', deadline: '2026-12-01', sourceCheckedAt: ago(400) },
        { title: '已過截止', deadline: '2026-01-01', sourceCheckedAt: ago(400) },
    ];
    assert.deepEqual(selectNeedsRecheck(list, TODAY, 90), []);
});

test('recheck：完全沒有 sourceCheckedAt 的一律列出，而且排最前面', () => {
    const list = [
        { title: '查過但很久', sourceCheckedAt: ago(300) },
        { title: '從來沒查過' },
        { title: '格式壞掉', sourceCheckedAt: '2026/01/01' },
    ];
    const out = selectNeedsRecheck(list, TODAY, 90);
    assert.equal(out.length, 3);
    assert.equal(out[0].days, Infinity, '沒有查證紀錄的必須排最前面');
    assert.equal(out[0].checked, '（無）');
    assert.ok(out.some((r) => r.label === '格式壞掉'), '日期格式壞掉也算沒有查證紀錄');
});

test('recheck：依陳舊度由大到小排序', () => {
    const list = [
        { title: 'a', sourceCheckedAt: ago(100) },
        { title: 'c', sourceCheckedAt: ago(300) },
        { title: 'b', sourceCheckedAt: ago(200) },
    ];
    assert.deepEqual(selectNeedsRecheck(list, TODAY, 90).map((r) => r.days), [300, 200, 100]);
});

test('recheck：門檻是「大於等於」，剛好到門檻的那天就要被列出', () => {
    const list = [{ title: '剛好 90 天', sourceCheckedAt: ago(90) }];
    assert.equal(selectNeedsRecheck(list, TODAY, 90).length, 1);
    assert.equal(selectNeedsRecheck([{ title: 'x', sourceCheckedAt: ago(89) }], TODAY, 90).length, 0);
});

test('recheck：壞掉的輸入不得讓看門狗爆掉', () => {
    assert.deepEqual(selectNeedsRecheck(null, TODAY, 90), []);
    assert.deepEqual(selectNeedsRecheck([null, undefined, 42, 'x'], TODAY, 90), []);
    const out = selectNeedsRecheck([{ sourceCheckedAt: ago(999) }], TODAY, 90);
    assert.equal(out[0].label, '（未命名）', '沒有標題時要有可讀的替代字');
});

test('recheck：真實資料現在應該一筆都不該列出（全庫三天內查過）', async () => {
    const data = JSON.parse(await readFile(new URL('../public/advanced-resources/competitions.json', import.meta.url), 'utf8'));
    const out = selectNeedsRecheck(data.competitions, Date.UTC(2026, 7, 29), 90);
    assert.deepEqual(out, [], `不該有陳舊條目，實際：${JSON.stringify(out.slice(0, 3))}`);
    // 但這一桶本身必須是有東西的——否則上面那條會空洞地通過
    const wouldCover = selectNeedsRecheck(data.competitions, Date.UTC(2026, 7, 29), 0);
    assert.ok(wouldCover.length >= 60,
        `門檻放到 0 天時應涵蓋大量條目（實際 ${wouldCover.length}），否則這組測試在空集合上跑`);
});
