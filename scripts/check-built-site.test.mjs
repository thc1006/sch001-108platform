#!/usr/bin/env node
/**
 * 站台契約核心的確定性測試
 * --------------------------------------------------------------
 * 全部用假的檔案清單與字串，不跑真實 build、不連外網——這樣測試才會在
 * 「契約壞掉」時失敗，而不是在「今天網路不好」時失敗。
 *
 * 執行：  npm run test:site-integrity
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';

import {
    buildRouteMap,
    classifyReference,
    resolveInternalPath,
    collectAnchors,
    parseSrcset,
    parseCssUrls,
    walkJsonStrings,
} from './site-contract.lib.mjs';

const BASE = '/sch001-108platform';
const SITE = 'https://thc1006.github.io';
const CTX = { base: BASE, site: SITE };

const FILES = [
    'index.html',
    'about.html',
    'advanced-resources/index.html',
    'advanced-resources/competitions.html',
    'career-exploration/clusters/design/traits.html',
    'picture/logo.png',
    'img/tools/notion.svg',
    '_astro/site.css',
];
const MAP = buildRouteMap(FILES, BASE);

// ── route map：GitHub Pages 的目錄語意 ──

test('route map：三種 artifact 各自對應正確的部署 URL', () => {
    assert.equal(MAP.routes.get(`${BASE}/`), 'index.html');
    assert.equal(MAP.routes.get(`${BASE}/about.html`), 'about.html');
    assert.equal(MAP.routes.get(`${BASE}/advanced-resources/`), 'advanced-resources/index.html');
    assert.equal(MAP.routes.get(`${BASE}/picture/logo.png`), 'picture/logo.png');
});

test('目錄存在但缺 index.html 必須失敗（lychee 未給 --index-files 時會漏掉）', () => {
    // img/ 底下有檔案，但沒有 img/index.html
    const r = resolveInternalPath(`${BASE}/img/`, MAP);
    assert.equal(r.ok, false);
    assert.match(r.reason, /缺少 index\.html/);
});

test('完全不存在的路徑與目錄缺 index 要能分辨', () => {
    const r = resolveInternalPath(`${BASE}/nope/`, MAP);
    assert.equal(r.ok, false);
    assert.match(r.reason, /找不到/);
});

test('路徑含 .. 一律拒絕', () => {
    assert.equal(resolveInternalPath(`${BASE}/../etc/passwd`, MAP).ok, false);
});

// ── 同源絕對網址：scheme ≠ origin ──

test('同源絕對網址必須視為站內（--scheme file 會整批漏掉這一類）', () => {
    const r = classifyReference(
        `${SITE}${BASE}/advanced-resources/competitions.html`,
        `${BASE}/`,
        CTX,
    );
    assert.equal(r.kind, 'internal');
    assert.equal(r.path, `${BASE}/advanced-resources/competitions.html`);
    assert.equal(resolveInternalPath(r.path, MAP).ok, true);
});

test('同源但逸出 base namespace 視為錯誤', () => {
    const r = classifyReference(`${SITE}/other-project/x.html`, `${BASE}/`, CTX);
    assert.equal(r.kind, 'invalid');
    assert.match(r.reason, /base namespace/);
});

test('不同 origin 才是外部', () => {
    const r = classifyReference('https://example.org/x', `${BASE}/`, CTX);
    assert.equal(r.kind, 'external');
});

// ── 相對路徑要相對「來源頁」解析 ──

test('相對路徑以來源頁為 base 解析', () => {
    const r = classifyReference('competitions.html', `${BASE}/advanced-resources/`, CTX);
    assert.equal(r.kind, 'internal');
    assert.equal(r.path, `${BASE}/advanced-resources/competitions.html`);
});

test('資料 JSON 的相對資產要相對「消費它的頁面」，不是 JSON 自己的位置', () => {
    // tools.json 位於 learning-portfolio/，但它的 logo 由 learning-portfolio/tools.html 消費
    const r = classifyReference('img/tools/notion.svg', `${BASE}/`, CTX);
    assert.equal(r.path, `${BASE}/img/tools/notion.svg`);
    assert.equal(resolveInternalPath(r.path, MAP).ok, true);
});

test('root-relative 保持在 base namespace 內', () => {
    const r = classifyReference(`${BASE}/about.html`, `${BASE}/deep/page.html`, CTX);
    assert.equal(r.kind, 'internal');
    assert.equal(r.path, `${BASE}/about.html`);
});

// ── fragment ──

test('純 fragment 指向來源頁自己', () => {
    const r = classifyReference('#main-content', `${BASE}/about.html`, CTX);
    assert.equal(r.kind, 'internal');
    assert.equal(r.path, `${BASE}/about.html`);
    assert.equal(r.fragment, 'main-content');
});

test('帶 fragment 的站內連結要同時取出路徑與 fragment', () => {
    const r = classifyReference(
        `${BASE}/advanced-resources/competitions.html#competition-grid`,
        `${BASE}/`,
        CTX,
    );
    assert.equal(r.path, `${BASE}/advanced-resources/competitions.html`);
    assert.equal(r.fragment, 'competition-grid');
});

test('anchor 收集涵蓋 id 與 legacy a[name]', () => {
    const $ = cheerio.load('<main id="main-content"></main><a name="old"></a><div id="grid"></div>');
    const ids = collectAnchors($);
    assert.ok(ids.has('main-content'));
    assert.ok(ids.has('old'));
    assert.ok(ids.has('grid'));
    assert.ok(!ids.has('missing'));
});

// ── 安全 ──

test('javascript: 與 vbscript: 一律視為錯誤', () => {
    assert.equal(classifyReference('javascript:alert(1)', `${BASE}/`, CTX).kind, 'invalid');
    assert.equal(classifyReference('VBScript:x', `${BASE}/`, CTX).kind, 'invalid');
});

test('內嵌帳號密碼的網址視為錯誤', () => {
    assert.equal(classifyReference('https://u:p@example.org/', `${BASE}/`, CTX).kind, 'invalid');
});

test('mailto / tel / data 忽略而非報錯', () => {
    for (const v of ['mailto:a@b.c', 'tel:+886', 'data:image/png;base64,AAA']) {
        assert.equal(classifyReference(v, `${BASE}/`, CTX).kind, 'ignored', v);
    }
});

// ── 擷取工具 ──

test('srcset 只取網址部分', () => {
    assert.deepEqual(parseSrcset('a.png 1x, b.png 2x'), ['a.png', 'b.png']);
});

test('CSS url() 擷取（含引號與無引號）', () => {
    const urls = parseCssUrls('a{background:url("x.png")}b{background:url(y.svg)}');
    assert.deepEqual(urls, ['x.png', 'y.svg']);
});

test('JSON 走訪保留 RFC6901 pointer，錯誤能定位到確切欄位', () => {
    const found = walkJsonStrings({ tools: [{ logo: 'img/a.svg' }] });
    assert.deepEqual(found, [{ pointer: '/tools/0/logo', value: 'img/a.svg' }]);
});

// ── adversarial review 找到的四個漏洞的回歸測試 ──
// 這四項都是初版實作實際犯的錯，不是假想情境。

test('回歸：協定相對且同源的網址必須當成站內檢查', () => {
    // 初版把 // 開頭一律當外部，於是 //thc1006.github.io/... 這種寫法會跳過檢查
    const r = classifyReference(`//thc1006.github.io${BASE}/nope.html`, `${BASE}/`, CTX);
    assert.equal(r.kind, 'internal');
    assert.equal(r.path, `${BASE}/nope.html`);
});

test('回歸：畸形 percent-encoding 不得讓 checker 崩潰', () => {
    // 初版直接呼叫 decodeURIComponent，遇到 %ZZ 會 throw，整支 checker 掛掉
    for (const bad of ['#%ZZ', `${BASE}/a.html#%E0%A4%A`, `${BASE}/%ZZ.html`]) {
        assert.doesNotThrow(() => classifyReference(bad, `${BASE}/about.html`, CTX), bad);
    }
    assert.doesNotThrow(() => resolveInternalPath(`${BASE}/%ZZ.html`, MAP));
});

test('回歸：scheme 判定必須看解析後的 protocol，不能只比字串前綴', () => {
    // WHATWG URL parser 會剝除 URL 中的換行與 tab，java\nscript: 會被正規化成
    // javascript:。初版先做字串前綴比對，於是這個值落到「非 http(s) 故忽略」，
    // 等於靜默接受可執行內容。
    for (const evil of ['java\nscript:alert(1)', '\tjavascript:alert(1)', 'java\tscript:alert(1)']) {
        const r = classifyReference(evil, `${BASE}/`, CTX);
        assert.equal(r.kind, 'invalid', JSON.stringify(evil));
        assert.match(r.reason, /javascript:/);
    }
});

test('回歸：未知 scheme 不得靜默忽略', () => {
    const r = classifyReference('weird-scheme:payload', `${BASE}/`, CTX);
    assert.equal(r.kind, 'invalid');
    assert.match(r.reason, /未預期的 scheme/);
});

test('回歸：href="#" 是 no-op，不得當成 anchor 參照', () => {
    assert.equal(classifyReference('#', `${BASE}/about.html`, CTX).kind, 'ignored');
    // 但非空 fragment 仍要檢查
    assert.equal(classifyReference('#real', `${BASE}/about.html`, CTX).fragment, 'real');
});
