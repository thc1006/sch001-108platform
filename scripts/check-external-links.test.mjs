#!/usr/bin/env node
// check-external-links.mjs 的端到端測試：用 --replay 餵錄好的探測結果跑完整支主程式，不連網。
// buildReport 的行為由 link-health.test.mjs 直接餵資料測；這裡守的是主程式讀檔之後交給它的名單與交給 probe
// 的選項，名單換掉、對錯位置或選項錯了，報告、GITHUB_OUTPUT 和主控台都會跟著變。
//
// 網址一律用 .test 底下的主機（RFC 2606 保留）。重播沒有接上時，探測會查 DNS，但查不到位址，不會連到任何主機。
//
// 執行：  node --test scripts/check-external-links.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-external-links.mjs', import.meta.url));
const daysFromNow = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const occ = (file, location = 'a[href]') => [{ file, location }];

/** inventory 是最小的盤點：五個網址各有一個出處，說明文字裡有三個候選。 */
const inventory = () => ({
    generatedFrom: 'dist',
    total: 5,
    urls: [
        { url: 'https://gone.example.test/page', occurrences: occ('dist/a/index.html') },
        { url: 'https://ok.example.test/', occurrences: occ('dist/b/index.html') },
        { url: 'https://waf.example.test/doc', occurrences: occ('dist/c/index.html') },
        { url: 'https://moved.example.test/', occurrences: occ('advanced-resources/competitions.json', '/competitions/3/url') },
        { url: 'https://ok2.example.test/x', occurrences: occ('dist/e/index.html') },
    ],
    bareDomainCandidates: {
        total: 3,
        alreadyCoveredByUrls: 0,
        // 被篩掉的放第一個：篩選結果沒用上的話，後面兩筆會對到錯的探測結果。
        hosts: [
            { host: 'fuse.min.js', occurrences: occ('dist/f/index.html', 'text') },
            { host: 'squat.example.test', occurrences: occ('advanced-resources/competitions.json', '/competitions/7/description') },
            { host: 'old.example.test', occurrences: occ('advanced-resources/competitions.json', '/competitions/9/description') },
        ],
    },
});

const hijackedEntry = (host) => ({
    match: { host },
    kind: 'hijacked',
    reason: '端到端測試的接管警示，主機已經易主。',
    evidence: '端到端測試：首頁標題是博弈站。',
    owner: 'e2e',
    expires: daysFromNow(90),
});

/** policy 有一筆例外（waf 的 403 壓下去）與兩筆接管警示（轉址經過的 trap、說明文字點名的 squat）。 */
const policy = () => ({
    version: 1,
    entries: [{ match: { host: 'waf.example.test' }, reason: '端到端測試：這台主機擋自動程式。', owner: 'e2e', expires: daysFromNow(90) }],
    hijacked: [hijackedEntry('trap.example.test'), hijackedEntry('squat.example.test')],
});

const ok = (url) => ({ status: 200, finalUrl: url, redirects: [], bodyHead: '<html><head><title>OK</title></head><body>正常的頁面內容</body></html>' });

/** recording 是錄好的探測結果與 TLD 的 NS 查詢結果，格式和 --record 寫出來的一樣。 */
const recording = () => ({
    version: 1,
    probes: {
        'https://gone.example.test/page': { status: 404, finalUrl: 'https://gone.example.test/page', redirects: [] },
        'https://ok.example.test/': ok('https://ok.example.test/'),
        'https://waf.example.test/doc': { status: 403, finalUrl: 'https://waf.example.test/doc', redirects: [] },
        'https://moved.example.test/': {
            ...ok('https://trap.example.test/landing'),
            redirects: [{ from: 'https://moved.example.test/', status: 302, to: 'https://trap.example.test/landing' }],
        },
        'https://ok2.example.test/x': ok('https://ok2.example.test/x'),
        'https://squat.example.test/': ok('https://squat.example.test/'),
        'https://old.example.test/': { status: 0, code: 'ENOTFOUND', finalUrl: 'https://old.example.test/', redirects: [] },
    },
    ns: { 'test.': ['ns.example.test'], 'js.': { code: 'ENOTFOUND' } },
});

/**
 * run 把盤點、政策與錄製檔寫進暫存目錄，用 --replay 跑主程式，回傳結束碼、報告、GITHUB_OUTPUT、主控台輸出，
 * 以及 args 裡的 $RECORD 換成的那個 --record 檔。
 * @param {{inventory?: object, policy?: object, recording?: object, args?: string[]}} [over]
 */
async function run(over = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ext-links-e2e-'));
    try {
        const file = (name, obj) => {
            const p = path.join(dir, name);
            writeFileSync(p, JSON.stringify(obj), 'utf8');
            return p;
        };
        const report = path.join(dir, 'report.md');
        const output = path.join(dir, 'github-output.txt');
        const recordTo = path.join(dir, 'recorded.json');
        const args = [
            SCRIPT,
            '--inventory', file('inventory.json', over.inventory ?? inventory()),
            '--policy', file('policy.json', over.policy ?? policy()),
            '--report', report,
            '--replay', file('recording.json', over.recording ?? recording()),
            ...(over.args ?? []).map((x) => (x === '$RECORD' ? recordTo : x)),
        ];
        let code = 0;
        let stdout;
        try {
            ({ stdout } = await promisify(execFile)(process.execPath, args, { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } }));
        } catch (e) {
            code = e.code ?? 1;
            stdout = String(e.stdout || '') + String(e.stderr || '');
        }
        const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
        return { code, stdout, report: read(report), output: read(output), recorded: read(recordTo) };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** section 回傳報告裡從 title 那一行到下一個 ### 之前的文字，沒有這一段就回傳 null。 */
function section(report, title) {
    const start = report.indexOf(title);
    if (start < 0) return null;
    const next = report.indexOf('\n### ', start + title.length);
    return report.slice(start, next < 0 ? undefined : next);
}

test('主程式：--replay 不連網跑完整份健檢，交給 buildReport 的盤點、政策與裸網域名單都是讀進來的那一份', async () => {
    const r = await run();
    assert.equal(r.code, 0, r.stdout);
    assert.ok(r.report, '沒有寫出報告');
    assert.match(r.report, /- 本次檢查 5 筆：健康 2、失效 1、位址封鎖 0、無法判定 0、已列例外 1/);
    assert.match(r.report, /- 內文裸網域：盤點候選 3（0 個已由盤點的網址涵蓋）、DNS 篩掉 1、DNS 未答 0、實際探測 2（健康 0、失效 1、無法判定 0）/);

    const dead = section(r.report, '### 🔗 連結失效');
    assert.ok(dead, '少了連結失效那一段');
    assert.match(dead, /- \*\*HTTP 404\*\*：https:\/\/gone\.example\.test\/page\n  - 出處：`dist\/a\/index\.html`/);
    assert.doesNotMatch(dead, /ok\.example\.test|waf\.example\.test/);

    const hijacked = section(r.report, '### 🚨 已知不可信任的主機');
    assert.ok(hijacked, '少了接管主機那一段');
    assert.match(hijacked, /\*\*trap\.example\.test\*\*[\s\S]*盤點的網址（會觸發通知[^\n]*`https:\/\/moved\.example\.test\/`\n  - 轉址經過：`https:\/\/trap\.example\.test\/landing`/);
    assert.match(hijacked, /出處：`advanced-resources\/competitions\.json \/competitions\/3\/url`/);
    assert.match(hijacked, /\*\*squat\.example\.test\*\*[\s\S]*說明文字裡的裸網域（本身不觸發通知）[\s\S]*出處：`advanced-resources\/competitions\.json \/competitions\/7\/description`/);

    const bareDead = section(r.report, '### 🔤 說明文字裡的網域失效');
    assert.ok(bareDead, '少了說明文字裡的網域失效那一段');
    assert.match(bareDead, /- \*\*網域無法解析\*\*：old\.example\.test\n  - 出處：`advanced-resources\/competitions\.json \/competitions\/9\/description`/);

    assert.match(r.report, /被 DNS 篩掉的裸網域候選 1 筆[\s\S]*- fuse\.min\.js — \.js 不是 DNS 根區裡的 TLD/);
    assert.match(r.report, /已列入例外政策的連結 1 筆[\s\S]*- HTTP 403：https:\/\/waf\.example\.test\/doc\n  - 理由：端到端測試：這台主機擋自動程式。/);

    assert.equal(r.output, 'needs_attention=true\ncoverage_complete=true\n');
    assert.match(r.stdout, /本次檢查：5\n {2}健康　　：2\n {2}失效　　：1/);
    assert.match(r.stdout, /→ 有項目需要處理，已寫入報告。/);
});

test('主程式：contentChecks 的網址在頁面健康之後打 API，連兩次回 {} 才算失效，結果對回正確的網址', async () => {
    const spa = 'https://spa.example.test';
    const shell = { status: 200, redirects: [], bodyHead: '<html><head><title>SPA</title></head><body><noscript>請開啟 JavaScript</noscript><div id="root"></div></body></html>' };
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const inv = inventory();
    // 有內容檢查的網址夾在中間，對錯位置時會換到別的網址身上。
    inv.urls.splice(1, 0, ...ids.slice(0, 2).map((id) => ({ url: `${spa}/item?id=${id}`, occurrences: occ(`dist/s${id}/index.html`) })));
    inv.urls.push(...ids.slice(2).map((id) => ({ url: `${spa}/item?id=${id}`, occurrences: occ(`dist/s${id}/index.html`) })));
    inv.total = inv.urls.length;
    const pol = policy();
    pol.contentChecks = [{
        match: { host: 'spa.example.test' },
        reason: '端到端測試：前端殼對任何路徑都回 200。',
        evidence: '端到端測試：不存在的 id 回 {}。',
        owner: 'e2e',
        expires: daysFromNow(90),
        urls: ids.map((id) => ({ url: `${spa}/item?id=${id}`, api: `${spa}/api/item?id=${id}`, expect: { id } })),
    }];
    // id=1 的 API 在子網域上。id=8 的 API 對不存在的項目回 404。
    pol.contentChecks[0].urls[0].api = 'https://api.spa.example.test/item?id=1';
    pol.contentChecks[0].urls[7].deadStatus = [404];
    const rec = recording();
    const api = (id, bodyHead, over = {}) => ({ status: 200, finalUrl: `${spa}/api/item?id=${id}`, redirects: [], bodyHead, ...over });
    for (const id of ids) rec.probes[`${spa}/item?id=${id}`] = { ...shell, finalUrl: `${spa}/item?id=${id}` };
    // id=1 的回應超過頁首用的 16KB，讀取上限不對時會被截斷。
    rec.probes['https://api.spa.example.test/item?id=1'] = api(1, JSON.stringify({ id: 1, des: 'x'.repeat(20 * 1024) }), { finalUrl: 'https://api.spa.example.test/item?id=1' });
    rec.probes[`${spa}/api/item?id=2`] = [api(2, '{}'), api(2, '{}')];
    rec.probes[`${spa}/api/item?id=3`] = api(3, '{"status":false}', { status: 401 });
    rec.probes[`${spa}/api/item?id=4`] = [api(4, '{}'), api(4, '{"id":4}')];
    rec.probes[`${spa}/api/item?id=5`] = api(5, '{"id":5}', { addresses: ['127.0.0.1'] });
    // id=7 第一次 503、重打回 {}，不是連兩次 {}，不算失效。
    rec.probes[`${spa}/api/item?id=7`] = [api(7, '', { status: 503 }), api(7, '{}')];
    rec.probes[`${spa}/api/item?id=8`] = [api(8, '{"name":"NotFound"}', { status: 404 }), api(8, '{"name":"NotFound"}', { status: 404 })];
    // id=6 的頁面逾時，API 不打，內容 API 那一行要列出它。
    rec.probes[`${spa}/item?id=6`] = { status: 0, code: 'ETIMEDOUT', finalUrl: `${spa}/item?id=6`, redirects: [] };
    const r = await run({ inventory: inv, policy: pol, recording: rec });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.report, /- 本次檢查 13 筆：健康 4、失效 3、位址封鎖 0、無法判定 4、已列例外 1/);
    assert.match(r.report, /- 內容 API 檢查 7 筆：健康 2、失效 2、無法判定 3。頁面驗不到、沒打 API 的 1 筆：https:\/\/spa\.example\.test\/item\?id=6。/);
    const dead = section(r.report, '### 🔗 連結失效');
    assert.match(dead, /- \*\*內容 API 回 \{\}，網站上查不到這一頁\*\*：https:\/\/spa\.example\.test\/item\?id=2\n {2}- 出處：`dist\/s2\/index\.html`/);
    assert.match(dead, /- \*\*內容 API 回 HTTP 404，網站上查不到這一頁\*\*：https:\/\/spa\.example\.test\/item\?id=8\n {2}- 出處：`dist\/s8\/index\.html`/);
    assert.doesNotMatch(dead, /id=[134567]/);
    const unv = section(r.report, '### 🧩 內容檢查驗不到');
    assert.match(unv, /^### 🧩 內容檢查驗不到 3 筆\n[\s\S]*\n- 內容 API HTTP 401：https:\/\/spa\.example\.test\/item\?id=3\n/);
    assert.match(unv, /\n- 內容 API 被位址政策擋下：spa\.example\.test 解析到被封鎖的位址：127\.0\.0\.1[^\n]*：https:\/\/spa\.example\.test\/item\?id=5\n/);
    assert.equal(r.output, 'needs_attention=true\ncoverage_complete=true\n');
    assert.match(unv, /\n- 內容 API 回 \{\}，前一次不是 \{\}（內容 API HTTP 503）：https:\/\/spa\.example\.test\/item\?id=7\n/);
    assert.match(r.stdout, / {2}內容 API：7（健康 2、失效 2、無法判定 3；頁面驗不到、沒打 API 的 1 筆）/);
});

test('主程式：--limit 只驗前 N 筆，交給 buildReport 的 limit 讓覆蓋算成不完整', async () => {
    const r = await run({ args: ['--limit', '2'] });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.report, /- 本次檢查 2 筆：健康 1、失效 1、位址封鎖 0、無法判定 0、已列例外 0/);
    assert.equal(r.output, 'needs_attention=true\ncoverage_complete=false\n');
    assert.match(r.stdout, /使用了 --limit 2/);
});

test('主程式：沒有待辦時不通知，報告寫「全部外部連結正常」', async () => {
    const inv = inventory();
    inv.urls = inv.urls.filter((u) => u.url.startsWith('https://ok'));
    inv.total = inv.urls.length;
    inv.bareDomainCandidates = { total: 0, alreadyCoveredByUrls: 0, hosts: [] };
    const pol = policy();
    pol.entries = [];
    pol.hijacked = [];
    const r = await run({ inventory: inv, policy: pol });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.report, /- 本次檢查 2 筆：健康 2、失效 0/);
    assert.match(r.report, /✅ 全部外部連結正常。/);
    assert.equal(r.output, 'needs_attention=false\ncoverage_complete=true\n');
});

test('主程式：錄製檔裡沒有的網址與 TLD 不算健康，網址歸到無法判定，TLD 歸到 DNS 未答', async () => {
    const rec = recording();
    delete rec.probes['https://ok2.example.test/x'];
    delete rec.ns['js.'];
    const r = await run({ recording: rec });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.report, /- 本次檢查 5 筆：健康 1、失效 1、位址封鎖 0、無法判定 1、已列例外 1/);
    assert.match(r.report, /其他無法判定的連結 1 筆[\s\S]*- EREPLAY：https:\/\/ok2\.example\.test\/x/);
    assert.match(r.report, /DNS 未答 1/);
    assert.equal(r.output, 'needs_attention=true\ncoverage_complete=false\n');
});

test('主程式：重播照 probe 的規則套位址政策與讀 body 的上限，交給 probe 的選項錯了報告會變', async () => {
    const squat = '<html><head><title>Online Casino Free Spins</title></head><body>x</body></html>';
    const inv = {
        generatedFrom: 'dist',
        total: 4,
        urls: [
            { url: 'http://127.0.0.1:8080/admin', occurrences: occ('dist/a/index.html') },
            { url: 'https://rebind.example.test/', occurrences: occ('dist/b/index.html') },
            { url: 'https://parked.example.test/', occurrences: occ('dist/c/index.html') },
            { url: 'https://hop.example.test/', occurrences: occ('dist/e/index.html') },
        ],
        bareDomainCandidates: {
            total: 2,
            alreadyCoveredByUrls: 0,
            hosts: ['rebind6.example.test', 'casino.example.test'].map((host) => ({ host, occurrences: occ('dist/d/index.html', 'text') })),
        },
    };
    const rec = {
        version: 1,
        probes: {
            'http://127.0.0.1:8080/admin': ok('http://127.0.0.1:8080/admin'),
            'https://rebind.example.test/': {
                ...ok('https://inner.example.test/'),
                redirects: [{ from: 'https://rebind.example.test/', status: 302, to: 'https://inner.example.test/' }],
                addresses: ['127.0.0.1'],
            },
            'https://hop.example.test/': {
                ...ok('http://169.254.169.254/latest/meta-data/'),
                redirects: [{ from: 'https://hop.example.test/', status: 302, to: 'http://169.254.169.254/latest/meta-data/' }],
            },
            'https://rebind6.example.test/': { ...ok('https://rebind6.example.test/'), addresses: ['::1'] },
            'https://casino.example.test/': { ...ok('https://casino.example.test/'), bodyHead: squat },
            // 標題排在 16KB 之後就讀不到：重播照讀取上限截斷，訊號 B 只看得到前 16KB。
            'https://parked.example.test/': { ...ok('https://parked.example.test/'), bodyHead: squat },
        },
        ns: { 'test.': ['ns.example.test'] },
    };
    const r = await run({ inventory: inv, policy: { version: 1, entries: [], hijacked: [] }, recording: rec });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.report, /- 本次檢查 4 筆：健康 1、失效 0、位址封鎖 3/);
    const blocked = section(r.report, '### 🛑 網址被位址政策擋下');
    assert.match(blocked, /`http:\/\/127\.0\.0\.1:8080\/admin`/);
    assert.match(blocked, /inner\.example\.test 解析到被封鎖的位址：127\.0\.0\.1 落在 127\.0\.0\.0\/8/);
    assert.match(blocked, /169\.254\.169\.254 落在 169\.254\.0\.0\/16[^\n]*\n {2}- 網址：`https:\/\/hop\.example\.test\/`/, '轉址的每一跳都要過靜態政策');
    assert.match(blocked, /rebind6\.example\.test 解析到被封鎖的位址：::1 是 IPv6 loopback/);
    assert.match(r.report, /- 自動偵測：需處理 2/, '盤點網址與裸網域都要讀 body');

    for (const u of ['https://parked.example.test/', 'https://casino.example.test/']) rec.probes[u].bodyHead = `<!--${'x'.repeat(16 * 1024)}-->${squat}`;
    assert.match((await run({ inventory: inv, policy: { version: 1, entries: [], hijacked: [] }, recording: rec })).report, /- 自動偵測：需處理 0/);
});

test('主程式：--record 把探測與 NS 查詢的結果照錄製檔的格式寫出來，重試過的網址存成陣列', async () => {
    const r = await run({ args: ['--record', '$RECORD'] });
    assert.equal(r.code, 0, r.stdout);
    const out = JSON.parse(r.recorded);
    const rec = recording();
    assert.equal(out.version, 1);
    // ok2 的 /x 可見文字很少，要打同目錄的隨機路徑；錄製檔沒有它，重播回 EREPLAY，照樣錄下來。
    assert.match(out.randomToken, /^sch001-linkcheck-[0-9a-f]{12}$/);
    const random = `https://ok2.example.test/${out.randomToken}`;
    assert.deepEqual(Object.keys(out.probes).sort(), [...Object.keys(rec.probes), random].sort());
    assert.equal(out.probes[random].code, 'EREPLAY');
    assert.deepEqual(out.probes['https://gone.example.test/page'], [rec.probes['https://gone.example.test/page'], rec.probes['https://gone.example.test/page']]);
    assert.deepEqual(out.probes['https://waf.example.test/doc'], rec.probes['https://waf.example.test/doc']);
    assert.deepEqual(out.ns, rec.ns);
});

test('主程式：同一個網址錄成陣列時，重播照順序回傳，第一次就健康的不重試', async () => {
    const rec = recording();
    const gone = rec.probes['https://gone.example.test/page'];
    rec.probes['https://gone.example.test/page'] = [gone, ok('https://gone.example.test/page')];
    rec.probes['https://ok2.example.test/x'] = [ok('https://ok2.example.test/x'), { ...gone, finalUrl: 'https://ok2.example.test/x' }];
    const r = await run({ recording: rec });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.report, /- 本次檢查 5 筆：健康 3、失效 0、位址封鎖 0、無法判定 0、已列例外 1/);
});

test('主程式：軟 404 的隨機路徑用錄製檔記下的字串重播，兩次都落在同一個維修頁才判軟 404', async () => {
    const token = 'sch001-linkcheck-0123456789ab';
    const url = 'https://maint.example.test/map/dept?code=1';
    const notice = (from) => ({
        ...ok('https://maint.example.test/notice/'),
        bodyHead: `<html><head><title>系統維修公告</title></head><body>${'維修中。'.repeat(80)}</body></html>`,
        redirects: [{ from, status: 302, to: 'https://maint.example.test/notice/' }],
    });
    const rec = recording();
    rec.randomToken = token;
    rec.probes[url] = notice(url);
    rec.probes[`https://maint.example.test/map/${token}`] = notice(`https://maint.example.test/map/${token}`);
    const inv = inventory();
    inv.urls = [...inv.urls, { url, occurrences: occ('dist/m/index.html') }];
    const r = await run({ recording: rec, inventory: inv, args: ['--record', '$RECORD'] });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.report, /- 本次檢查 6 筆：健康 2、失效 1、位址封鎖 0、無法判定 0、已列例外 1、軟 404 1/);
    assert.ok(r.report.includes(`- **第 4 條**：${url}`), r.report);
    assert.equal(r.output, 'needs_attention=true\ncoverage_complete=true\n');
    const out = JSON.parse(r.recorded);
    assert.equal(out.randomToken, token, '重播時要沿用錄製檔的字串');
    assert.equal(out.probes[url].length, 2, '命中之後要重打網址');
    assert.equal(out.probes[`https://maint.example.test/map/${token}`].length, 2, '第 4 條要連隨機路徑一起重打');
});

test('主程式：missingTitles 的主機看標題，16KB 讀不到標題的重讀，打同目錄的隨機路徑，錄製檔記下這些請求', async () => {
    const token = 'sch001-linkcheck-0123456789ab';
    const site = 'https://news.example.test';
    const home = '新聞站 - 首頁';
    const html = (title, before = '') => `<html><head></head><body>${before}<title>${title}</title><p>${'內容。'.repeat(80)}</p></body></html>`;
    const page = (path, body) => ({ status: 200, finalUrl: `${site}${path}`, redirects: [], contentType: 'text/html', bodyHead: body });
    const rec = recording();
    rec.randomToken = token;
    // /news/1 健康；/news/2 的標題在 16KB 之後，重讀兩次都是首頁的標題；/topic/3 健康，但隨機路徑的標題換了。
    rec.probes[`${site}/news/1`] = page('/news/1', html('第一篇'));
    rec.probes[`${site}/news/2`] = page('/news/2', html(home, `<div>${'x'.repeat(20 * 1024)}</div>`));
    rec.probes[`${site}/topic/3`] = page('/topic/3', html('主題'));
    rec.probes[`${site}/news/${token}`] = page(`/news/${token}`, html(home));
    rec.probes[`${site}/topic/${token}`] = page(`/topic/${token}`, html('Oops'));
    const inv = inventory();
    inv.urls.push(...['/news/1', '/news/2', '/topic/3', '/'].map((p) => ({ url: `${site}${p}`, occurrences: occ(`dist${p}x/index.html`) })));
    rec.probes[`${site}/`] = page('/', html(home));
    const pol = policy();
    pol.contentChecks = [{
        match: { host: 'news.example.test' },
        reason: '端到端測試：不存在的文章回 200 和首頁的標題。',
        evidence: '端到端測試：/news/99999 回 200，標題是首頁的。',
        owner: 'e2e',
        expires: daysFromNow(90),
        urls: [],
        missingTitles: [home],
    }];
    const r = await run({ recording: rec, inventory: inv, policy: pol, args: ['--record', '$RECORD'] });
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.report, /- 標題檢查 3 筆：健康 2、失效 1、無法判定 0，重讀 1 筆。同目錄的隨機路徑 2 個：標題在名單裡 1、不在名單裡 1、沒有比對 0。/);
    assert.ok(r.report.includes(`- **頁面標題是 \`${home}\`，是這台主機不存在的頁面的標題**：${site}/news/2`), r.report);
    assert.match(r.report, /### 🏷️ 不存在的頁面標題變了 1 個[\s\S]*- \*\*news\.example\.test\*\*：標題是 `Oops`，隨機路徑 https:\/\/news\.example\.test\/topic\/sch001-linkcheck-0123456789ab/);
    assert.match(r.stdout, / {2}標題檢查：3（健康 2、失效 1、無法判定 0；重讀 1、隨機路徑 2、標題不在名單裡 1）/);
    assert.equal(r.output, 'needs_attention=true\ncoverage_complete=true\n');
    const out = JSON.parse(r.recorded);
    assert.equal(out.probes[`${site}/news/2`].length, 3, '主程式一次、重讀兩次');
    assert.ok(Buffer.byteLength(out.probes[`${site}/news/2`][1].bodyHead) > 16 * 1024, '重讀用 TITLE_PROBE 的上限');
    assert.equal(out.probes[`${site}/topic/${token}`].length, 2, '標題不在名單裡的隨機路徑再讀一次');
    assert.ok(!Array.isArray(out.probes[`${site}/news/${token}`]));
    assert.ok(!Array.isArray(out.probes[`${site}/news/1`]), '16KB 讀得到標題的不重讀');
});

test('主程式：錄製檔的 version 不是 1 或沒有寫時不重播，寫出致命錯誤', async () => {
    const { version, ...noVersion } = recording();
    for (const rec of [{ ...noVersion, version: version + 1 }, noVersion]) {
        const r = await run({ recording: rec });
        assert.notEqual(r.code, 0);
        assert.match(r.report, /錄製檔 .* 的 version 不是 1/);
        assert.equal(r.output, 'needs_attention=true\ncoverage_complete=false\n');
    }
});

test('主程式：盤點是空的時寫出致命錯誤的報告、needs_attention=true，以非零碼結束', async () => {
    const r = await run({ inventory: { generatedFrom: 'dist', urls: [] } });
    assert.notEqual(r.code, 0);
    assert.match(r.report, /### ❌ 致命錯誤：無法執行檢查\n\n- 外部網址盤點是空的。/);
    assert.equal(r.output, 'needs_attention=true\ncoverage_complete=false\n');
});

// 每條測試另開一支程式，彼此不共用檔案，並行跑。
describe('check-external-links.mjs', { concurrency: true }, () => {
    for (const [name, fn] of cases) it(name, fn);
});
