#!/usr/bin/env node
// missing-titles.lib.mjs 與它在報告裡的分組的測試。網路的部分用本機 http server 重現 2026-10-27 量到的幾種網站，不連外網。
//
// 執行：  node --test scripts/missing-titles.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { runProbes } from './link-health.lib.mjs';
import { pageTitle, titleCheckFor, needsReread, judgeTitle, judgeRandom, runMissingTitles, TITLE_PROBE, TITLE_RECHECK, TITLE_BUDGET_MIN } from './missing-titles.lib.mjs';
import { buildReport, judgeUrl } from './check-external-links.lib.mjs';

const TOKEN = 'sch001-linkcheck-000000000000';
const HOME = '首頁 | 測試站';
const page = (title, body = '<p>內容</p>', head = '') => `<!doctype html><html><head>${title === null ? '' : `<title>${title}</title>`}${head}</head><body>${body}</body></html>`;
const pad = (n) => `<div>${'x'.repeat(n)}</div>`;

let server;
let base;
let host;
const hits = new Map();

// route 回傳 [狀態碼, 標頭, body]。
function route(path) {
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    const ok = (html, extra = {}) => [200, { 'content-type': 'text/html; charset=utf-8', ...extra }, html];
    const [p] = path.split('?');
    // aesea 式：存在的頁面標題在 <head>；不存在的頁面 <head> 沒有標題，<title> 在 body 裡、16KB 之後。
    if (p === '/next/live') return ok(page('iBridge 競賽'));
    if (p === '/next/gone' || p === `/next/${TOKEN}`) return ok(page(null, `${pad(20_000)}<title>${HOME}</title>`));
    // designwant 式：不存在的頁面整頁沒有 <title>，<head> 很長。
    if (p === '/nuxt/gone' || p === `/nuxt/${TOKEN}`) return ok(page(null, '', `<style>${'a{}'.repeat(40_000)}</style>`));
    // eden 式：補尾斜線之後回 200，標題和首頁相同。
    if (p === '/eden/a/gone') return [301, { location: '/eden/a/gone/' }, ''];
    if (p === `/eden/a/${TOKEN}`) return [301, { location: `/eden/a/${TOKEN}/` }, ''];
    if (p === '/eden/a/gone/' || p === `/eden/a/${TOKEN}/`) return ok(page(HOME));
    if (p === '/eden/a/live/') return ok(page('志工需求'));
    // 只有第一次回不存在的頁面。
    if (p === '/flaky/x') return ok(page(n === 1 ? HOME : '文章'));
    // 名單過期：隨機路徑的標題換了。
    if (p === `/stale/${TOKEN}`) return ok(page('Page Not Here'));
    if (p === '/stale/x') return ok(page('文章'));
    // 隨機路徑回 500。
    if (p === `/e5/${TOKEN}`) return [500, {}, page(HOME)];
    if (p === '/e5/x') return ok(page('系所'));
    // 壓縮、標題在 256KB 之後、<head> 不完整。
    if (p === '/gz/x') return [200, { 'content-encoding': 'gzip' }, 'not really gzip'];
    if (p === '/huge/x') return ok(page(null, `${pad(300_000)}<title>${HOME}</title>`));
    return [404, {}, 'not found'];
}

before(async () => {
    server = createServer((req, res) => {
        const r = route(req.url);
        res.writeHead(r[0], r[1]);
        res.end(r[2]);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    host = '127.0.0.1';
    base = `http://${host}:${server.address().port}`;
});
after(() => {
    server.closeAllConnections();
    server.close();
});

const check = (titles = [HOME, '']) => ({ match: { host }, missingTitles: titles, urls: [] });
const ok200 = (html, over = {}) => ({ status: 200, finalUrl: 'https://x.test/a', redirects: [], contentType: 'text/html; charset=utf-8', bodyHead: html, ...over });

/** run 用主程式的讀取上限探測 paths，再跑 runMissingTitles，回傳 targets、主程式的結果與 runMissingTitles 的回傳值。 */
async function run(paths, titles, opts = {}) {
    hits.clear();
    const targets = paths.map((p) => ({ url: `${base}${p}`, occurrences: [] }));
    const { results } = await runProbes(targets.map((t) => t.url), { allowLoopback: true, readBodyBytes: 16 * 1024 });
    const out = await runMissingTitles(targets, results, [check(titles)], TOKEN, { allowLoopback: true, sleep: async () => {}, ...opts });
    return { targets, results, out, judged: targets.map((t, i) => judgeTitle(check(titles), results[i], out.rereads[i])) };
}

test('pageTitle：不是 HTML 的回應沒有標題可比；名單有 "" 時，PDF、JSON、純文字、沒有 Content-Type 的 2xx 都不判失效', () => {
    const c = check(['']);
    for (const [body, type] of [['%PDF-1.4 x', 'application/pdf'], ['{"ok":true}', 'application/json'], ['維護中', 'text/plain'], ['<p>x</p>', undefined]]) {
        const x = ok200(body, { contentType: type });
        assert.equal(pageTitle(x), null, String(type));
        assert.equal(needsReread(c, x), false, String(type));
        assert.equal(judgeTitle(c, x, null).verdict, 'healthy', String(type));
        assert.deepEqual(judgeTitle(c, ok200('<html></html>'), { ...x, previous: x }), { verdict: 'unverified', bucket: 'other', notify: false,
            reason: `標題檢查 回應不是 HTML（\`${type ?? '沒有 Content-Type'}\`）` }, String(type));
        assert.equal(judgeRandom(c, { ...x, previous: x }).state, 'other');
    }
    assert.equal(pageTitle(ok200('<script>alert(1)</script>', { contentType: 'application/xhtml+xml' })), '');
    const shell = ok200('<script>alert("x");location.href="/";</script>');
    assert.equal(judgeTitle(c, shell, { ...shell, previous: shell }).verdict, 'dead', 'collego 的 alert 殼是 text/html，照樣判失效');
});

test('pageTitle：template、noscript、CDATA、textarea 裡的 <title> 不算；一連串沒有結尾的 <title 也很快做完', () => {
    for (const fake of ['<template><title>首頁 | 測試站</title></template>', '<noscript><title>首頁 | 測試站</title></noscript>',
        '<![CDATA[<title>首頁 | 測試站</title>]]>', '<textarea><title>首頁 | 測試站</title></textarea>', '<?php echo "<title>x</title>" ?>']) {
        assert.equal(pageTitle(ok200(`<head>${fake}<title>文章</title></head>`)), '文章', fake);
        assert.equal(judgeTitle(check(), ok200(`<head>${fake}<title>文章</title></head>`)).verdict, 'healthy', fake);
    }
    const started = Date.now();
    assert.equal(pageTitle(ok200('<title '.repeat(TITLE_PROBE.readBodyBytes / 7))), null);
    assert.ok(Date.now() - started < 2000, `花了 ${Date.now() - started} ms`);
});

test('pageTitle：第一個 <title>，跳過註解、script、style、svg 裡的，解開字元參照、正規化空白', () => {
    assert.equal(pageTitle(ok200('<head><title>\n  世新大學 &#8211; 財金  </title></head>')), '世新大學 – 財金');
    assert.equal(pageTitle(ok200('<title>A &amp; B&nbsp;C &#x41;&bogus;</title>')), 'A & B C A&bogus;');
    assert.equal(pageTitle(ok200('<!-- <title>x</title> --><script>"<title>y</title>"</script><svg><title>z</title></svg><title>真的</title>')), '真的');
    assert.equal(pageTitle(ok200('<head></head><body><div>很長的內容</div><title>在 body 裡</title></body>')), '在 body 裡');
    assert.equal(pageTitle(ok200('<html><head></head><body>沒有標題</body></html>')), '');
    assert.equal(pageTitle(ok200('<html><head></head><body>沒有標題', { bodyTruncated: true })), null, '沒讀完不知道後面有沒有');
    assert.equal(pageTitle(ok200('<html><head><title>只讀到一半', { bodyTruncated: true })), null);
    assert.equal(pageTitle(ok200('<html><head><title>沒有結尾')), null);
    assert.equal(pageTitle(ok200('<script>var t = "<title>x</title>";', { bodyTruncated: true })), null, '沒讀完的 script 裡的不算');
    assert.equal(pageTitle(ok200('<head><script>var s = "<!--";</script></head><body><title>Real</title></body>')), 'Real', 'script 裡的 <!-- 不算註解');
    assert.equal(pageTitle(ok200('<style>p::after { content: "<title>x</title>" }</style><title lang="zh">有屬性</title>')), '有屬性');
    assert.equal(pageTitle(ok200('<title>A &ndash; B &middot; C&hellip;</title>')), 'A – B · C…');
    assert.equal(pageTitle(ok200('<title>一</title><p>x</p><title>二</title>')), '一', '只取第一個 <title> 到它的結尾');
    assert.equal(pageTitle(ok200('<title>A &AMP; B</title>')), 'A & B', '具名參照不分大小寫');
    assert.equal(pageTitle(ok200('<title>&#99999999;&#x110000;&#0;</title>')), '&#99999999;&#x110000;&#0;', '超出範圍的數字參照照原樣');
    assert.equal(pageTitle(ok200('<title>&#x4E2D;&#25991;</title>')), '中文');
    assert.equal(pageTitle(ok200('<head><!-- 沒有結尾 <title>註解裡</title>')), '', '沒有結尾的註解一路算到最後');
    assert.equal(pageTitle(ok200('<title>空白</title  >')), '空白');
    assert.equal(pageTitle(ok200('<svg-icon></svg-icon><style-x></style-x><title>自訂元素</title>')), '自訂元素', '<svg-icon> 不是 svg');
    assert.equal(pageTitle(ok200('<svg/><title>真的</title>')), '真的');
    assert.equal(pageTitle(ok200('')), null, '空的回應不算沒有標題');
    assert.equal(pageTitle(ok200(' \n ')), null);
    assert.equal(pageTitle(ok200(undefined, { bodySkipped: 'content-encoding: gzip' })), null);
    assert.equal(pageTitle({ status: 0, code: 'ETIMEDOUT' }), null);
});

test('titleCheckFor：主機宣告了 missingTitles、路徑不是首頁、沒有寫 API 才看標題', () => {
    const c = { match: { host: 'spa.example.org' }, missingTitles: ['首頁'], urls: [{ url: 'https://spa.example.org/api-page', api: 'https://spa.example.org/api', expect: { a: 1 } }] };
    assert.equal(titleCheckFor([c], 'https://spa.example.org/x'), c);
    assert.equal(titleCheckFor([c], 'https://SPA.example.org./x'), c);
    assert.equal(titleCheckFor([c], 'https://spa.example.org/'), null);
    for (const p of ['/?lang=en', '/index.aspx', '/Default.asp?x=1', '/home', '/index.html']) assert.equal(titleCheckFor([c], `https://spa.example.org${p}`), null, p);
    for (const p of ['/indexes', '/a/index.html', '/homepage']) assert.equal(titleCheckFor([c], `https://spa.example.org${p}`), c, p);
    assert.equal(titleCheckFor([c], 'https://spa.example.org/api-page'), null);
    assert.equal(titleCheckFor([c], 'https://other.example.org/x'), null);
    assert.equal(titleCheckFor([{ ...c, missingTitles: undefined }], 'https://spa.example.org/x'), null);
    assert.equal(titleCheckFor([c], 'not a url'), null);
});

test('judgeTitle：16KB 讀得到標題又不在名單裡就健康，不重讀；兩次都是名單裡的標題才算失效', () => {
    const c = check();
    const live = ok200('<title>文章</title>');
    assert.equal(needsReread(c, live), false);
    assert.equal(judgeTitle(c, live, null).verdict, 'healthy');
    const gone = ok200(`<title>${HOME}</title>`);
    assert.equal(needsReread(c, gone), true);
    assert.deepEqual(judgeTitle(c, gone, { ...gone, previous: gone }), { verdict: 'dead', reason: `頁面標題是 \`${HOME}\`，是這台主機不存在的頁面的標題` });
    const noTitle = ok200('<script>alert("x");location.href="/";</script>');
    assert.deepEqual(judgeTitle(c, gone, { ...noTitle, previous: noTitle }), { verdict: 'dead', reason: '頁面標題是 ``，是這台主機不存在的頁面的標題' });
    assert.equal(judgeTitle(c, gone, { ...live, previous: gone }).verdict, 'healthy');
    const u = (reason, notify, bucket = 'other') => ({ verdict: 'unverified', bucket, notify, reason });
    const cases = [
        [null, u('標題檢查 這次沒有重讀', false)],
        [gone, u(`標題檢查 標題是 \`${HOME}\`，沒有重讀確認`, false)],
        [{ ...gone, retrySkipped: true }, u(`標題檢查 標題是 \`${HOME}\`，時間預算用完，沒有重讀確認`, false)],
        [{ ...gone, previous: { status: 503 } }, u(`標題檢查 標題是 \`${HOME}\`，前一次不是（HTTP 503）`, false)],
        [{ ...gone, previous: live }, u(`標題檢查 標題是 \`${HOME}\`，前一次不是（標題是 \`文章\`）`, false)],
        [{ status: 503 }, u('標題檢查 HTTP 503', false, 'server-error')],
        [{ status: 404 }, u('標題檢查 HTTP 404', false, 'rejected')],
        [{ status: 0, code: 'ETIMEDOUT' }, u('標題檢查 連線逾時', false, 'unreachable')],
        [{ status: 0, code: 'EBLOCKED', blocked: true, reason: '測試' }, u('標題檢查 被位址政策擋下：測試', true)],
        [ok200(undefined, { bodySkipped: 'content-encoding: br' }), u('標題檢查 回應是壓縮過的，沒有解析（`content-encoding: br`）', true)],
        [{ ...ok200(''), previous: ok200('') }, u('標題檢查 回應是空的', false)],
        [ok200('<head>', { bodyTruncated: true }), u('標題檢查 讀到 256KB 還沒讀完 <title>', true)],
        [ok200('<head>', { bodyTruncated: true, bodyAborted: true }), u('標題檢查 回應沒有收完，連線中途斷了', false, 'unreachable')],
    ];
    for (const [x, want] of cases) assert.deepEqual(judgeTitle(c, gone, x), want, JSON.stringify(x));
    // 標題是那台主機給的，包成行內程式碼。
    const evil = ok200('<title>@x [a](https://evil.test/)</title>');
    assert.match(judgeTitle(check(['@x [a](https://evil.test/)']), evil, evil).reason, /^標題檢查 標題是 `@x \[a\]\(https:\/\/evil\.test\/\)`/);
});

test('judgeRandom：標題在名單裡、兩次都不在名單裡、其他', () => {
    const c = check();
    const listed = ok200(`<title>${HOME}</title>`);
    const off = ok200('<title>新的錯誤頁</title>');
    assert.deepEqual(judgeRandom(c, listed), { state: 'listed', reason: `標題是 \`${HOME}\`` });
    assert.deepEqual(judgeRandom(c, { ...off, previous: off }), { state: 'stale', reason: '標題是 `新的錯誤頁`' });
    assert.deepEqual(judgeRandom(c, { ...off, previous: listed }), { state: 'other', reason: `標題是 \`新的錯誤頁\`，不在名單裡，前一次是 標題是 \`${HOME}\`` });
    assert.deepEqual(judgeRandom(c, { ...off, retrySkipped: true }), { state: 'other', skipped: true, reason: '標題是 `新的錯誤頁`，不在名單裡，時間預算用完，沒有重讀確認' });
    assert.deepEqual(judgeRandom(c, ok200(' ')), { state: 'other', reason: '回應是空的' });
    assert.deepEqual(judgeRandom(c, { status: 404 }), { state: 'other', reason: 'HTTP 404' });
    assert.deepEqual(judgeRandom(c, ok200('<head>', { bodyTruncated: true })), { state: 'other', reason: '沒讀完 <title>' });
    assert.deepEqual(judgeRandom(c, null), { state: 'other', skipped: true, reason: '時間預算用完，沒有打' });
});

test('實際探測：aesea、designwant、eden 式的不存在頁面判失效，各重讀兩次；存在的頁面不重讀', async () => {
    const { out, judged } = await run(['/next/live', '/next/gone', '/nuxt/gone', '/eden/a/gone', '/eden/a/live/']);
    assert.deepEqual(judged.map((j) => j.verdict), ['healthy', 'dead', 'dead', 'dead', 'healthy']);
    assert.equal(out.reads, 3);
    assert.equal(hits.get('/next/live'), 1, '16KB 讀得到標題的不重讀');
    assert.equal(hits.get('/next/gone'), 3, '主程式一次、重讀一次、確認一次');
    assert.equal(hits.get('/eden/a/gone/'), 3);
    assert.deepEqual(out.rereads.map((r) => r !== null), [false, true, true, true, false]);
    // 隨機路徑照（主機、目錄）只打一次，標題在名單裡的不重讀。
    assert.deepEqual(out.selfChecks.map((s) => [s.url.slice(base.length), s.state]), [[`/next/${TOKEN}`, 'listed'], [`/nuxt/${TOKEN}`, 'listed'], [`/eden/a/${TOKEN}`, 'listed'], [`/eden/a/${TOKEN}/`, 'listed']]);
    assert.equal(hits.get(`/next/${TOKEN}`), 1);
    assert.equal(out.skipped, 0);
});

test('實際探測：只有一次是名單裡的標題不算失效；壓縮、256KB 讀不到標題要通知', async () => {
    const { judged } = await run(['/flaky/x', '/gz/x', '/huge/x']);
    assert.equal(judged[0].verdict, 'healthy', '重讀時已經不是名單裡的標題');
    assert.deepEqual([judged[1].verdict, judged[1].notify], ['unverified', true]);
    assert.deepEqual([judged[2].verdict, judged[2].notify, judged[2].reason], ['unverified', true, '標題檢查 讀到 256KB 還沒讀完 <title>']);
    assert.equal(hits.get('/huge/x'), 2, '讀不到標題的重讀一次，不確認');
    assert.equal(hits.get('/gz/x'), 2);
});

test('實際探測：隨機路徑的標題兩次都不在名單裡算過期；回 500 不比；預算用完的算進 skipped', async () => {
    const { out } = await run(['/stale/x', '/e5/x']);
    assert.deepEqual(out.selfChecks.map((s) => [s.url.slice(base.length), s.state, s.reason]), [
        [`/stale/${TOKEN}`, 'stale', '標題是 `Page Not Here`'],
        [`/e5/${TOKEN}`, 'other', 'HTTP 500'],
    ]);
    assert.equal(hits.get(`/stale/${TOKEN}`), 2, '不在名單裡的再讀一次');
    assert.equal(hits.get(`/e5/${TOKEN}`), 1);
    // 頁面本身不健康的網址不打隨機路徑。
    const { out: dead } = await run(['/gone404/x']);
    assert.deepEqual(dead.selfChecks, []);
    assert.equal(hits.get(`/gone404/${TOKEN}`), undefined);
});

test('實際探測：確認前等 TITLE_RECHECK.delayMs，只確認名單裡的網址與不在名單裡的隨機路徑；確認時預算用完算進 skipped', async () => {
    const waits = [];
    const { out, judged } = await run(['/next/live', '/next/gone', '/stale/x'], undefined, { sleep: async (ms) => waits.push(ms) });
    assert.deepEqual(waits, [TITLE_RECHECK.delayMs]);
    assert.equal(judged[1].verdict, 'dead');
    assert.deepEqual([hits.get(`/next/${TOKEN}`), hits.get(`/stale/${TOKEN}`)], [1, 2]);
    assert.equal(out.skipped, 0);
    const none = [];
    await run(['/next/live'], undefined, { sleep: async (ms) => none.push(ms) });
    assert.deepEqual(none, [], '沒有要確認的不等');
    // 確認那一輪的預算用完：網址算無法判定，隨機路徑算沒有比對，兩者都算進 skipped。
    hits.clear();
    const targets = ['/next/gone', '/stale/x'].map((p) => ({ url: `${base}${p}` }));
    const { results } = await runProbes(targets.map((t) => t.url), { allowLoopback: true, readBodyBytes: 16 * 1024 });
    let calls = 0;
    const probeFn = async (url, signal, o) => {
        calls++;
        if (calls > 3) return new Promise((resolve) => signal.addEventListener('abort', () => resolve(null)));
        const { probe } = await import('./link-health.lib.mjs');
        return probe(url, signal, { ...o, allowLoopback: true });
    };
    const t0 = Date.now();
    const late = await runMissingTitles(targets, results, [check()], TOKEN, { probeFn, sleep: async () => {}, recheck: { budgetMs: 300 } });
    assert.ok(Date.now() - t0 < 5000, '確認那一輪用 recheck.budgetMs');
    assert.equal(late.skipped, 2);
    assert.match(judgeTitle(check(), results[0], late.rereads[0]).reason, /時間預算用完，沒有重讀確認/);
    assert.match(late.selfChecks.find((x) => x.url.includes('/stale/')).reason, /時間預算用完，沒有重讀確認/);
});

test('TITLE_PROBE：讀得下 designwant 不存在的整頁，報告寫的預算是同一個值', () => {
    assert.deepEqual({ ...TITLE_PROBE }, { concurrency: 2, budgetMs: 60_000, readBodyBytes: 256 * 1024 });
    assert.deepEqual({ ...TITLE_RECHECK }, { delayMs: 30_000, budgetMs: 30_000 });
    assert.equal(TITLE_BUDGET_MIN, 2);
    assert.ok(TITLE_PROBE.readBodyBytes > 151_861);
    assert.ok(Object.isFrozen(TITLE_PROBE));
});

const softNone = { verdicts: [], randoms: 0, randomsSkipped: 0, randomsFailed: 0, recheckSkipped: 0 };
/** report 用一個看標題的網址跑 buildReport。 */
function report(r, titles, extra = {}) {
    const url = 'https://t.test/a/1';
    const c = { match: { host: 't.test' }, missingTitles: [HOME], urls: [], expires: '2027-01-31' };
    return buildReport({
        todayISO: '2026-10-27', limit: 0, inventoryPath: 'inv.json', inventoryTotal: 1, targets: [{ url, occurrences: [{ file: 'a.html', location: 'a[href]' }] }],
        results: [r], skipped: 0, bareInfo: { total: 0, alreadyCoveredByUrls: 0 }, bareCandidates: [], screen: { accepted: [], rejected: [], unresolved: [] },
        bareResults: [], bareSkipped: 0, policy: { entries: [], hijacked: [], contentChecks: [c], ...extra.policy }, budgetMs: 60_000, bareBudgetMs: 60_000,
        soft404: softNone, titles,
    });
}
const run0 = (over = {}) => ({ rereads: [null], reads: 0, selfChecks: [], skipped: 0, ...over });

test('報告：兩次都是名單裡的標題列進連結失效並通知；健康的不通知；報告與主控台寫出標題檢查的數字', () => {
    const gone = ok200(`<title>${HOME}</title>`);
    const dead = report(gone, run0({ rereads: [{ ...gone, previous: gone }], reads: 1, selfChecks: [{ host: 't.test', url: 'https://t.test/a/T', state: 'listed', reason: 'x' }] }));
    assert.equal(dead.attention, true);
    assert.match(dead.report, /### 🔗 連結失效[\s\S]*- \*\*頁面標題是 `首頁 \| 測試站`，是這台主機不存在的頁面的標題\*\*：https:\/\/t\.test\/a\/1/);
    assert.match(dead.report, /- 標題檢查 1 筆：健康 0、失效 1、無法判定 0，重讀 1 筆。同目錄的隨機路徑 1 個：標題在名單裡 1、不在名單裡 0、沒有比對 0。/);
    assert.ok(dead.consoleSummary.includes('  標題檢查：1（健康 0、失效 1、無法判定 0；重讀 1、隨機路徑 1、標題不在名單裡 0）'), dead.consoleSummary.join('\n'));
    const live = report(ok200('<title>文章</title>'), run0());
    assert.equal(live.attention, false);
    assert.match(live.report, /- 標題檢查 1 筆：健康 1、失效 0、無法判定 0/);
    assert.ok(live.report.includes('✅ 全部外部連結正常。'));
    // 首頁、別台主機、有 API 的網址不看標題。
    assert.match(report({ status: 200, bodyHead: '' }, run0(), { policy: { contentChecks: [] } }).report, /- 標題檢查 0 筆/);
    // 頁面不健康時不看標題。
    assert.equal(judgeUrl({ url: 'https://t.test/a/1' }, { status: 403 }, { entries: [], hijacked: [], contentChecks: [{ match: { host: 't.test' }, missingTitles: [HOME], urls: [] }] }, null, null).title, null);
});

test('報告：驗不到的列在內容檢查那一段並照 notify 通知；只有一次的不通知；例外壓不下', () => {
    const gone = ok200(`<title>${HOME}</title>`);
    const once = report(gone, run0({ rereads: [gone], reads: 1 }));
    assert.equal(once.attention, false);
    assert.match(once.report, /### 🧩 內容檢查驗不到 1 筆[\s\S]*- 標題檢查 標題是 `首頁 \| 測試站`，沒有重讀確認：https:\/\/t\.test\/a\/1/);
    assert.ok(!once.report.includes('全部外部連結正常'));
    const huge = report(gone, run0({ rereads: [ok200('<head>', { bodyTruncated: true })], reads: 1 }));
    assert.equal(huge.attention, true);
    const entry = { match: { host: 't.test' }, reason: '測試：這台主機擋自動程式。', owner: 't', expires: '2026-12-01' };
    const suppressed = report(gone, run0({ rereads: [ok200('<head>', { bodyTruncated: true })], reads: 1 }), { policy: { entries: [entry] } });
    assert.equal(suppressed.attention, true, '例外壓下了標題檢查');
});

test('報告：隨機路徑的標題兩次都不在名單裡要通知；沒比對的收合列出、不通知；沒重讀、沒打的算覆蓋不完整', () => {
    const live = ok200('<title>文章</title>');
    const stale = report(live, run0({ selfChecks: [{ host: 't.test', url: 'https://t.test/a/T', state: 'stale', reason: '標題是 `新的錯誤頁`' }] }));
    assert.equal(stale.attention, true);
    assert.match(stale.report, /### 🏷️ 不存在的頁面標題變了 1 個[\s\S]*- \*\*t\.test\*\*：標題是 `新的錯誤頁`，隨機路徑 https:\/\/t\.test\/a\/T/);
    const other = report(live, run0({ selfChecks: [{ host: 't.test', url: 'https://t.test/a/T', state: 'other', reason: 'HTTP 500' }] }));
    assert.equal(other.attention, false);
    assert.match(other.report, /<details><summary>🏷️ 標題檢查的隨機路徑沒有比對 1 個（不通知）<\/summary>[\s\S]*- HTTP 500：https:\/\/t\.test\/a\/T/);
    assert.ok(other.report.includes('✅ 全部外部連結正常。'));
    const gone = ok200(`<title>${HOME}</title>`);
    const noReread = report(gone, run0({ reads: 1, skipped: 1 }));
    assert.equal(noReread.coverageComplete, false);
    assert.match(noReread.report, /本次有 1 筆未檢查（逾 1 \+ 1 \+ 2 \+ 3\.5 \+ 2 分鐘預算）/);
    const noRandom = report(live, run0({ skipped: 1, selfChecks: [{ host: 't.test', url: 'https://t.test/a/T', state: 'other', skipped: true, reason: '時間預算用完，沒有打' }] }));
    assert.equal(noRandom.coverageComplete, false);
    assert.equal(noRandom.attention, true);
    assert.match(noRandom.report, /本次有標題檢查的隨機路徑 1 個沒做完（逾/);
    assert.ok(noRandom.consoleTail.some((l) => l.startsWith('→ 覆蓋不完整：標題檢查的隨機路徑 1 個沒做完、')), noRandom.consoleTail.join('\n'));
    assert.equal(report(live, run0()).coverageComplete, true);
    // 確認那一輪沒讀到的，網址算未檢查，隨機路徑算沒做完，和覆蓋不完整一致。
    const unconfirmed = report(gone, run0({ rereads: [{ ...gone, retrySkipped: true }], reads: 1, skipped: 1 }));
    assert.equal(unconfirmed.coverageComplete, false);
    assert.match(unconfirmed.report, /### ⏱️ 檢查未完成[\s\S]*本次有 1 筆未檢查（逾/);
    const randomUnconfirmed = report(live, run0({ skipped: 1, selfChecks: [{ host: 't.test', url: 'https://t.test/a/T', state: 'other', skipped: true, reason: 'x' }] }));
    assert.match(randomUnconfirmed.report, /本次有標題檢查的隨機路徑 1 個沒做完（逾/);
});
