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

import { probe, isDeadResult, classifyLink, validateUrl, validateCycle, nextOccurrenceUTC, ALLOWED_FORMS } from './check-competitions.lib.mjs';

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
