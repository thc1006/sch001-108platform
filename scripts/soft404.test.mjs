#!/usr/bin/env node
// soft404.lib.mjs 的測試。網路的部分用本機 http server 重現 2026-10-27 查到的幾種網站，不連外網。
// 每個情境用自己的第一層目錄，同目錄的隨機路徑才不會撞在一起。
//
// 執行：  node --test scripts/soft404.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { runProbes } from './link-health.lib.mjs';
import { judgeSoft404, runSoft404, soft404Candidates, randomSibling, landing, ancestorOf, pageFacts, isHome, newToken, MIN_VISIBLE } from './soft404.lib.mjs';

const TOKEN = 'sch001-linkcheck-000000000000';
const LONG = '這一頁有正常的內容。'.repeat(40);
const page = (title, body = LONG, head = '') => `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;
const SHELL = page('App', '<div id="root"></div><script src="/app.js"></script>');

let server;
let base;
const hits = new Map();

// route 回傳 [狀態碼, 標頭, body]，body 是 null 時不回應（逾時），是 'hang' 以外的字串照送。
function route(path) {
    const n = (hits.get(path) ?? 0) + 1;
    hits.set(path, n);
    const to = (loc, status = 302) => [status, { location: loc }, ''];
    const ok = (html, extra = {}) => [200, { 'content-type': 'text/html; charset=utf-8', ...extra }, html];
    const [p, q] = path.split('?');
    if (p === '/collego/Highschool/Gone' || p === `/collego/Highschool/${TOKEN}`) return to('/collego/Login/Error404');
    if (p === '/collego/Login/Error404') return ok(page('Error', '發生錯誤'));
    if (p === '/fin/post-gone/') return ok(page('財金系網站', LONG, `<link rel="canonical" href="${base}/fin/">`));
    if (p === '/iymc/en/') return to('/iymc/en/language?return_to=%2Fiymc%2Fen%2F');
    if (p === `/iymc/${TOKEN}/`) return to('/iymc/en/language');
    if (p === '/iymc/en/language') return ok(page('IYMC'));
    if (p === '/hch/' && q === 'aid=81') return to('/hch/?aid=81&pid=74');
    if (p === '/hch/') return ok(page(q ? '活動花絮' : '首頁'));
    if (p === `/${TOKEN}/`) return to('/hch/');
    if (p === '/map/dept.php' || p === `/map/${TOKEN}`) return to('/notice/');
    if (p === '/notice/') return ok(page('系統維修公告'));
    if (p.startsWith('/shell/courses/')) return ok(SHELL);
    if (p.startsWith('/sg/')) return [202, { 'content-type': 'text/html' }, '<html><head><title></title></head><body><script>sgcaptcha()</script></body></html>'];
    if (p === '/ok/article/1') return ok(page('文章'));
    if (p === '/docs/old') return to('/docs/', 301);
    if (p === '/docs/') return ok(page('文件'));
    if (p === '/flaky/x') return n === 1 ? to('/flaky/err404') : ok(page('文章'));
    if (p === '/flaky/err404') return ok(page('找不到網頁'));
    if (p === '/slow/x' || p === '/e5/x' || p === '/gz/x' || p === '/big/x' || p === '/big/' + TOKEN) return to(`/${p.split('/')[1]}/`);
    if (p === `/slow/${TOKEN}`) return null;
    if (p === `/e5/${TOKEN}`) return [503, {}, 'busy'];
    if (p === `/gz/${TOKEN}`) return to('/gz/');
    if (p === '/gz/') return [200, { 'content-encoding': 'gzip' }, 'not really gzip'];
    if (p === '/big/') return ok(page('大頁面', LONG.repeat(20)));
    if (p === '/bigshell/x' || p === `/bigshell/${TOKEN}`) return ok(page('殼', `<script>${'x'.repeat(20000)}</script>`));
    if (['/slow/', '/e5/'].includes(p)) return ok(page('目錄'));
    if (p === '/chg/x') return n === 1 ? to('/chg/landing') : ok(page('找不到網頁'));
    if (p === `/chg/${TOKEN}`) return to('/chg/landing');
    if (p === '/chg/landing' || p === '/late/landing') return ok(page('首頁'));
    if (p === '/late/x') return n === 1 ? to('/late/landing') : null;
    if (p === `/late/${TOKEN}`) return to('/late/landing');
    return [404, {}, 'not found'];
}

before(async () => {
    server = createServer((req, res) => {
        const r = route(req.url);
        if (r === null) return; // 不回應，讓探測逾時
        res.writeHead(r[0], r[1]);
        res.end(r[2]);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
    server.closeAllConnections();
    server.close();
});

const POLICY = { hijacked: [], contentChecks: [], entries: [] };
const noSleep = async () => {};

/** probeAll 用和主程式相同的讀取上限探測 paths，回傳 targets 與 results。 */
async function probeAll(paths) {
    const targets = paths.map((p) => ({ url: `${base}${p}`, occurrences: [] }));
    const { results } = await runProbes(targets.map((t) => t.url), { allowLoopback: true, readBodyBytes: 16 * 1024 });
    return { targets, results };
}

/** soft 探測 paths 再跑 runSoft404，回傳每個 path 的判定與 runSoft404 的回傳值。 */
async function soft(paths, opts = {}) {
    hits.clear();
    const { targets, results } = await probeAll(paths);
    const out = await runSoft404(targets, results, opts.policy ?? POLICY, TOKEN, { allowLoopback: true, sleep: opts.sleep ?? noSleep, ...opts });
    return { by: Object.fromEntries(paths.map((p, i) => [p, out.verdicts[i]])), out, targets, results };
}

test('collego 式：轉到 /Login/Error404，第 1 條判失效', async () => {
    const { by } = await soft(['/collego/Highschool/Gone']);
    assert.equal(by['/collego/Highschool/Gone'].verdict, 'dead');
    assert.ok(by['/collego/Highschool/Gone'].rules.includes(1), JSON.stringify(by));
});

test('fin.wp 式：回首頁的內容、canonical 指向上層目錄，第 3 條判失效，不打隨機路徑', async () => {
    const { by, out } = await soft(['/fin/post-gone/']);
    assert.deepEqual(by['/fin/post-gone/'].rules, [3]);
    assert.equal(by['/fin/post-gone/'].verdict, 'dead');
    assert.equal(out.randoms, 0);
});

test('iymc 式：語系頁帶 return_to，和隨機路徑的落點只差查詢字串，判健康', async () => {
    const { by, out } = await soft(['/iymc/en/']);
    assert.deepEqual(by['/iymc/en/'], { verdict: 'healthy', rules: [] });
    assert.equal(out.randoms, 1);
    assert.equal(hits.get(`/iymc/${TOKEN}/`), 1, '隨機路徑要打同一個目錄');
});

test('hch 式：靠查詢字串分頁，隨機路徑轉回首頁，判健康', async () => {
    const { by } = await soft(['/hch/?aid=81']);
    assert.deepEqual(by['/hch/?aid=81'], { verdict: 'healthy', rules: [] });
});

test('整站維修：網址和隨機路徑都轉到維修公告，第 4 條判失效，重打時兩個都再打一次', async () => {
    const slept = [];
    const { by } = await soft(['/map/dept.php?code=7030'], { sleep: async (ms) => slept.push(ms) });
    assert.equal(by['/map/dept.php?code=7030'].verdict, 'dead');
    assert.deepEqual(by['/map/dept.php?code=7030'].rules, [4]);
    assert.deepEqual(slept, [30_000], '命中後要先等一段時間再重打');
    assert.equal(hits.get('/map/dept.php?code=7030'), 2);
    assert.equal(hits.get(`/map/${TOKEN}`), 2);
});

test('前端殼：可見文字很少、隨機路徑也回 200，只列為第 6 條的提示', async () => {
    const { by } = await soft(['/shell/courses/abc']);
    assert.equal(by['/shell/courses/abc'].verdict, 'hint');
    assert.deepEqual(by['/shell/courses/abc'].rules, [6]);
});

test('驗證頁：網址和隨機路徑都是 202 的驗證頁，不判失效也不列為前端殼', async () => {
    const { by } = await soft(['/sg/page/']);
    assert.deepEqual(by['/sg/page/'], { verdict: 'healthy', rules: [] });
});

test('正常的頁面不打隨機路徑；只轉到上層目錄的列為第 5 條的提示', async () => {
    const { by, out } = await soft(['/ok/article/1', '/docs/old']);
    assert.deepEqual(by['/ok/article/1'], { verdict: 'healthy', rules: [] });
    assert.deepEqual(by['/docs/old'].rules, [5]);
    assert.equal(by['/docs/old'].verdict, 'hint');
    assert.equal(out.randoms, 1);
    assert.equal(hits.get(`/docs/${TOKEN}`), 1, '隨機路徑回 404 是預期的，不重試');
});

test('重打一次沒有再命中：判無法判定，不判失效', async () => {
    const { by } = await soft(['/flaky/x']);
    assert.equal(by['/flaky/x'].verdict, 'unverified');
    assert.match(by['/flaky/x'].reason, /重打一次沒有再命中/);
});

test('隨機路徑逾時、回 5xx、被壓縮：不拿來比，只剩第 5 條的提示，逾時和 5xx 算進 randomsFailed', async () => {
    const { by, out } = await soft(['/slow/x', '/e5/x', '/gz/x'], { probe: { timeoutMs: 500 } });
    for (const p of ['/slow/x', '/e5/x', '/gz/x']) assert.equal(by[p].verdict, 'hint', `${p}：${JSON.stringify(by[p])}`);
    assert.equal(out.randomsFailed, 2);
});

test('兩次命中的規則不同：第一次第 4 條、第二次只有第 2 條，判無法判定', async () => {
    const { by } = await soft(['/chg/x']);
    assert.equal(by['/chg/x'].verdict, 'unverified', JSON.stringify(by));
});

test('重打時隨機路徑沒打到：不沿用第一次的結果，算進 recheckSkipped', async () => {
    const { by, out } = await soft(['/late/x'], { probe: { concurrency: 1, timeoutMs: 5000 }, recheck: { delayMs: 0, budgetMs: 300 } });
    assert.equal(out.recheckSkipped, 1);
    assert.equal(by['/late/x'].verdict, 'unverified');
});

test('截斷：隨機路徑讀到上限仍可以比；只讀到前綴的頁面不算前端殼', async () => {
    const { by } = await soft(['/big/x', '/bigshell/x']);
    assert.deepEqual(by['/big/x'].rules, [4]);
    assert.deepEqual(by['/bigshell/x'], { verdict: 'healthy', rules: [] });
});

test('預算用完：沒打的隨機路徑和沒重打的網址都要回報', async () => {
    const a = await soft(['/map/dept.php?code=7030'], { probe: { budgetMs: 0 } });
    assert.equal(a.out.randomsSkipped, 1);
    const b = await soft(['/map/dept.php?code=7030'], { recheck: { delayMs: 0, budgetMs: 0 } });
    assert.equal(b.out.recheckSkipped, 1);
    assert.equal(b.by['/map/dept.php?code=7030'].verdict, 'unverified');
    assert.match(b.by['/map/dept.php?code=7030'].reason, /沒有重打確認/);
});

test('contentChecks 與 hijacked 的主機、首頁、不是 2xx 的網址不套規則', async () => {
    hits.clear();
    const { targets, results } = await probeAll(['/collego/Highschool/Gone', '/ok/article/1']);
    const host = new URL(base).hostname;
    for (const policy of [{ ...POLICY, hijacked: [{ match: { host } }] }, { ...POLICY, contentChecks: [{ match: { host }, urls: [] }] }]) {
        assert.deepEqual(soft404Candidates(targets, results, policy, TOKEN), []);
    }
    assert.deepEqual(soft404Candidates([{ url: `${base}/` }], [{ status: 200, finalUrl: `${base}/` }], POLICY, TOKEN), []);
    assert.deepEqual(soft404Candidates([{ url: `${base}/a` }], [{ status: 404 }], POLICY, TOKEN), []);
});

const r200 = (finalUrl, html, redirects = [{ status: 302, to: finalUrl }]) => ({ status: 200, finalUrl, redirects, bodyHead: html });

test('judgeSoft404：隨機路徑落在驗證頁或防火牆頁時不比', () => {
    const url = 'https://x.test/a/b';
    const r = r200('https://x.test/landing', page('首頁'));
    for (const html of [page('Request Rejected'), page('Client Challenge'), page('首頁', '短'), page('首頁', '字'.repeat(150))]) {
        assert.deepEqual(judgeSoft404(url, r, r200('https://x.test/landing', html), TOKEN).dead, [], html.slice(0, 80));
    }
    assert.deepEqual(judgeSoft404(url, r, r200('https://x.test/landing', page('首頁')), TOKEN).dead.map((d) => d.rule), [4]);
    assert.deepEqual(judgeSoft404(url, r, { ...r200('https://x.test/landing', page('首頁')), redirects: [] }, TOKEN).dead, [], '隨機路徑沒有轉址時不比');
    assert.deepEqual(judgeSoft404(url, { ...r, redirects: [] }, r200('https://x.test/landing', page('首頁')), TOKEN).dead, [], '網址沒有轉址時不比');
});

test('judgeSoft404：第 1 條只豁免起點本來就有的錯誤頁那一段，查詢字串不豁免', () => {
    const at = (from, to) => judgeSoft404(from, r200(to, page('首頁'), [{ status: 301, to }]), null, TOKEN).dead.map((d) => d.rule);
    assert.deepEqual(at('https://x.test/a/b', 'https://x.test/a/b?aspxerrorpath=/a/b'), [1]);
    assert.deepEqual(at('https://x.test/errors', 'https://x.test/Error.aspx?aspxerrorpath=/errors'), [1]);
    assert.deepEqual(at('https://news.x.test/article/404', 'https://news.x.test/error'), [1]);
    assert.deepEqual(at('https://docs.x.test/docs/api/errors', 'https://docs.x.test/docs/v2/api/errors'), []);
    assert.deepEqual(at('https://x.test/help/404', 'https://x.test/help/404.html'), []);
    assert.deepEqual(at('https://x.test/ERRORS', 'https://x.test/errors/'), []);
    assert.deepEqual(at('https://x.test/a/err', 'https://y.test/404'), [1]);
});

test('judgeSoft404：第 2 條的標題只認指網頁或頁面的寫法', () => {
    const at = (title, h1 = '') => judgeSoft404('https://x.test/p/1', r200('https://x.test/p/1', page(title, `${h1 ? `<h1>${h1}</h1>` : ''}${LONG}`), []), null, TOKEN).dead.map((d) => d.rule);
    for (const t of ['EE 404 Signals', 'Room 404 會議室', 'HTTP 404 是什麼？網站錯誤代碼一次看懂', '專訪 Lost and Not Found 樂團', '《查無此人》影評', '網頁錯誤處理教學']) {
        assert.deepEqual(at(t), [], t);
    }
    assert.deepEqual(at('文章', 'Error'), [], 'h1 只寫 Error 不算');
    for (const t of ['404 | 中央社 CNA', 'Error 404 (Not Found)!!1', '錯誤: 404 頁面未找到', 'HTTP 404 [Not Found]', '科展資訊管理系統 - Not Found!', 'Page Not Found', '查無此頁', '網頁錯誤 404', 'Error | OBS']) {
        assert.deepEqual(at(t), [2], t);
    }
});

test('judgeSoft404：第 1、2 條不抓起點本來就是錯誤碼說明頁的網址，沒有轉址也不套第 1 條', () => {
    const doc = 'https://docs.x.test/en/api/errors';
    const self = page('Errors - API', LONG, `<link rel="canonical" href="${doc}">`);
    assert.deepEqual(judgeSoft404(doc, r200(doc, self, []), null, TOKEN).dead, []);
    const slash = 'https://docs.x.test/api/errors';
    assert.deepEqual(judgeSoft404(slash, r200(`${slash}/`, page('Errors - API')), null, TOKEN).dead, []);
    assert.deepEqual(judgeSoft404('https://x.test/help/404', r200('https://x.test/help/404.html', page('說明')), null, TOKEN).dead, []);
    assert.deepEqual(judgeSoft404('https://x.test/a/b', r200('https://x.test/Login/Error404', page('首頁'), []), null, TOKEN).dead, []);
});

test('judgeSoft404：文章標題寫「找不到興趣」不算找不到頁面', () => {
    const url = 'https://blog.x.test/post/123';
    const t = '高中生找不到興趣怎麼辦？';
    assert.deepEqual(judgeSoft404(url, r200(url, page(t, `<h1>${t}</h1>${LONG}`), []), null, TOKEN).dead, []);
    assert.deepEqual(judgeSoft404(url, r200(url, page('找不到您要的頁面'), []), null, TOKEN).dead.map((d) => d.rule), [2]);
});

test('judgeSoft404：第 6 條只看 200，202 的驗證頁和驗證頁的標題都不算前端殼', () => {
    const url = 'https://x.test/a/b';
    const random = { status: 200, finalUrl: `https://x.test/a/${TOKEN}`, redirects: [], bodyHead: SHELL };
    assert.deepEqual(judgeSoft404(url, { status: 200, finalUrl: url, redirects: [], bodyHead: SHELL }, random, TOKEN).hints.map((h) => h.rule), [6]);
    assert.deepEqual(judgeSoft404(url, { status: 202, finalUrl: url, redirects: [], bodyHead: SHELL }, random, TOKEN).hints, []);
    assert.deepEqual(judgeSoft404(url, { status: 200, finalUrl: url, redirects: [], bodyHead: page('Client Challenge', '') }, random, TOKEN).hints, []);
    assert.deepEqual(judgeSoft404(url, { status: 200, finalUrl: url, redirects: [], bodyHead: SHELL }, { ...random, status: 202 }, TOKEN).hints, []);
    const moved = { ...random, redirects: [{ status: 302, to: random.finalUrl }] };
    assert.deepEqual(judgeSoft404(url, { status: 200, finalUrl: url, redirects: [], bodyHead: SHELL }, moved, TOKEN).hints, [], '隨機路徑有轉址時不算前端殼');
});

test('judgeSoft404：標題、h1、canonical', () => {
    const url = 'https://x.test/a/b';
    const at = (html) => judgeSoft404(url, r200(url, html, []), null, TOKEN).dead.map((d) => d.rule);
    assert.deepEqual(at(page('404 Not Found')), [2]);
    assert.deepEqual(at(page('文章', '<h1>找不到這個頁面</h1>' + LONG)), [2]);
    assert.deepEqual(at(page('文章', LONG, '<link href="/Error.aspx" rel="canonical">')), [2]);
    assert.deepEqual(at(page('文章', LONG, "<link rel='canonical' href='https://x.test/'>")), [3]);
    assert.deepEqual(at(page('文章', LONG, '<link rel="canonical" href="https://x.test/a/b">')), []);
    assert.deepEqual(at(page('文章', LONG, '<link rel="canonical" href="https://x.test/?p=1">')), [], 'canonical 帶查詢字串的不算上層目錄');
    assert.deepEqual(at(page('Error 4040 號公報')), []);
    const up = r200('https://x.test/a/', page('文章', LONG, '<link rel="canonical" href="https://x.test/a/">'));
    assert.deepEqual(judgeSoft404(url, up, null, TOKEN).dead, [], '落點就是 canonical 時第 3 條不算，留給第 5 條');
});

test('judgeSoft404：轉址落點的錯誤頁路徑', () => {
    const url = 'https://x.test/a/b';
    for (const to of ['https://x.test/Login/Error404', 'https://x.test/404.html', 'https://x.test/page-not-found/', 'https://x.test/err?aspxerrorpath=/a/b', 'https://x.test/Home/Oops?aspxerrorpath=/a/b']) {
        assert.deepEqual(judgeSoft404(url, r200(to, page('首頁')), null, TOKEN).dead.map((d) => d.rule), [1], to);
    }
    assert.deepEqual(judgeSoft404(url, r200('https://x.test/errors-and-omissions/guide', page('首頁')), null, TOKEN).dead, []);
});

test('randomSibling、landing、ancestorOf、isHome', () => {
    assert.equal(randomSibling('https://x.test/blog/post/123?a=1#f', 'T'), 'https://x.test/blog/post/T');
    assert.equal(randomSibling('https://x.test/view/site/', 'T'), 'https://x.test/view/T/');
    assert.equal(randomSibling('https://x.test/?aid=1', 'T'), 'https://x.test/T');
    assert.equal(landing('https://X.test/a/T-1/?q=T-1', 'T-1'), 'x.test/a/TOKEN?q=TOKEN');
    assert.equal(landing('https://x.test/%E6%96%87/'), 'x.test/文');
    assert.notEqual(landing('https://x.test/en/language?return_to=%2Fen%2F'), landing('https://x.test/en/language'));
    assert.equal(ancestorOf('https://x.test/a/b/c', 'https://x.test/a/'), true);
    assert.equal(ancestorOf('https://x.test/a/b', 'https://x.test/a/index.php'), true);
    assert.equal(ancestorOf('https://x.test/a/b', 'https://x.test/ab'), false);
    assert.equal(ancestorOf('https://x.test/a/b', 'https://y.test/'), true);
    assert.equal(ancestorOf('https://x.test/a/b', 'https://y.test/a'), false);
    assert.equal(ancestorOf('https://x.test/a/b', 'https://x.test/?lang=en'), false);
    assert.equal(isHome('https://x.test/'), true);
    assert.equal(isHome('https://x.test/?a=1'), false);
    assert.match(newToken(), /^sch001-linkcheck-[0-9a-f]{12}$/);
    assert.notEqual(newToken(), newToken());
});

test('pageFacts：壓縮或沒有 body 時回 null，截斷的標成不完整', () => {
    assert.equal(pageFacts({ status: 200, bodySkipped: 'content-encoding: gzip' }), null);
    assert.equal(pageFacts({ status: 200 }), null);
    const f = pageFacts({ status: 200, finalUrl: 'https://x.test/a', bodyHead: page('T', LONG), bodyTruncated: true });
    assert.equal(f.complete, false);
    assert.ok(f.visible >= MIN_VISIBLE);
    const c = pageFacts({ status: 200, finalUrl: 'https://x.test/a', bodyHead: page('T', '', '<link rel="canonical" href="/a?x=1&amp;y=2">') });
    assert.equal(c.canonical, 'https://x.test/a?x=1&y=2');
});
