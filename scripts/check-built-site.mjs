#!/usr/bin/env node
/**
 * 建置產物的站台契約檢查
 * --------------------------------------------------------------
 * 驗證的是「實際會被部署的那一份 dist/」，涵蓋 lychee 在語意上表達不了的幾類契約：
 *
 *   1. 目錄式 URL（/foo/）必須有 foo/index.html——GitHub Pages 的實際服務語意
 *   2. 同源絕對網址（canonical、og:url、og:image、JSON-LD）必須映射回本地檔案
 *      ——scheme 是 https 但語意上是站內，--scheme file 會整批漏掉
 *   3. fragment（#main-content、搜尋結果的 #competition-grid）必須真的存在
 *   4. 資料驅動頁面在瀏覽器 fetch JSON 後才產生的 <img>/<a>——那些相對路徑要
 *      相對「消費它的頁面」解析，而不是 JSON 自己的位置
 *   5. search-index.json 產生的 url 與 anchor
 *   6. 每頁自我一致性：canonical 指向自己、恰好一個 main#main-content、id 不重複
 *
 * 外部網址只輸出 inventory，不在此處連線——外部站台的可用性屬於非確定性，
 * 不該讓無關的 PR 因為某間大學今天連不上而變紅。
 *
 * 本機執行：  npm run check:site      （需先 npm run build:deployable）
 */

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

import {
    buildRouteMap,
    classifyReference,
    resolveInternalPath,
    collectAnchors,
    parseSrcset,
    parseCssUrls,
    walkJsonStrings,
    staticImportSpecifiers,
} from './site-contract.lib.mjs';
import { validateIndexedTaxonomy } from './taxonomy.lib.mjs';
import { collectBareDomains, makeSkipFieldFilter } from './bare-domains.lib.mjs';

// fileURLToPath 而非手刻的 pathname 轉換：pathname 是 percent-encoded，路徑含
// 空白或非 ASCII 時會解析錯誤（本 repo 的 worktree 就在 .claude/ 底下）。
const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

// 要檢查哪一份建置產物。預設 dist/，可用 SITE_DIST 指定——故障注入需要一份
// 可以隨意破壞的副本，不能動到真正要部署的那一份。
const DIST = path.resolve(ROOT, process.env.SITE_DIST || 'dist');
const BASE = '/sch001-108platform';
const SITE = 'https://thc1006.github.io';
const CTX = { base: BASE, site: SITE };
const INVENTORY_PATH = path.join(ROOT, '.reports', 'url-inventory.json');

const dataPages = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'data-pages.json'), 'utf8'));

// 走過的 vendor ES module 數（報告用；在 import 圖那一節填入）
let vendorModuleCount = 0;

// 不是由 BaseLayout 產生的檔案，不套用版面契約（canonical、main#main-content）。
// 目前只有 Google Search Console 的驗證檔；它必須維持 Google 指定的原樣。
const NON_LAYOUT_PAGES = new Set(['google2e2300e459be5c1b.html']);

// ── 收集 dist 檔案 ──
async function walkFiles(dir, prefix = '', out = []) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walkFiles(abs, rel, out);
        else out.push(rel);
    }
    return out;
}

let distFiles;
try {
    distFiles = await walkFiles(DIST);
} catch {
    console.error('❌ 找不到 dist/。請先執行 npm run build:deployable。');
    process.exit(1);
}
const routeMap = buildRouteMap(distFiles, BASE);
const urlOf = (rel) => (rel === 'index.html' ? `${BASE}/` : rel.endsWith('/index.html') ? `${BASE}/${rel.slice(0, -10)}` : `${BASE}/${rel}`);

// ── 收集 reference ──
const errors = [];
/** @type {Map<string,{url:string, occurrences:{file:string,location:string}[]}>} */
const external = new Map();
/** 待檢查的站內 reference */
const internal = [];
/**
 * 內文裸網域候選：只寫在說明文字裡、沒有做成 url 的網域（例如「原 tpmso.org 已
 * 轉址至 tpmso.k12ea.gov.tw」）。這裡只做**純字串**擷取——本檢查是擋 PR 的確定性
 * 檢查，不可以連網；「這個 TLD 到底存不存在」需要 DNS，由排程健檢負責篩選。
 */
const bareDomains = new Map();
// 被忽略的 reference 依理由計數。「靜默忽略」正是本 issue 一路在修的失效模式，
// 所以忽略了什麼、為什麼忽略，必須出現在正常輸出裡，而不是只在出錯時才看得到。
const ignored = new Map();
let refCount = 0;

const addError = (file, location, message) => errors.push({ file, location, message });
const record = (ref, fromUrl, file, location) => {
    refCount++;
    const r = classifyReference(ref, fromUrl, CTX);
    if (r.kind === 'invalid') return addError(file, location, `${r.reason}（值：${String(ref).slice(0, 90)}）`);
    if (r.kind === 'ignored') {
        const key = r.reason || '未標示理由';
        if (!ignored.has(key)) ignored.set(key, { count: 0, sample: String(ref).slice(0, 60) });
        ignored.get(key).count++;
        return;
    }
    if (r.kind === 'external') {
        const key = r.url.split('#')[0];
        if (!external.has(key)) external.set(key, { url: key, occurrences: [] });
        external.get(key).occurrences.push({ file, location });
        return;
    }
    internal.push({ path: r.path, fragment: r.fragment, file, location, ref });
};

// ── HTML ──
const anchorCache = new Map(); // dist 相對路徑 → Set<id>
const htmlFiles = distFiles.filter((f) => f.endsWith('.html'));

for (const rel of htmlFiles) {
    const html = await readFile(path.join(DIST, rel), 'utf8');
    const $ = cheerio.load(html);
    const fromUrl = urlOf(rel);
    anchorCache.set(rel, collectAnchors($));

    // 非 BaseLayout 產生的檔案（如 Google Search Console 驗證檔）不套用版面契約。
    // build-search-index.js 也明確排除同一個檔案，此處與之一致。
    const isLayoutPage = !NON_LAYOUT_PAGES.has(rel);

    // 重複 id：fragment 契約的前提，重複代表頁面本身已經壞了
    const seen = new Set();
    $('[id]').each((_, el) => {
        const id = $(el).attr('id');
        if (!id) return;
        if (seen.has(id)) addError(rel, `id="${id}"`, '同一頁出現重複的 id，fragment 目標將不確定');
        seen.add(id);
    });

    // BaseLayout 契約：恰好一個 main#main-content（每頁的「跳至主要內容」都指向它）
    if (isLayoutPage) {
        const mains = $('main#main-content').length;
        if (mains !== 1) addError(rel, 'main#main-content', `應恰好有 1 個，實際 ${mains} 個`);
    }

    for (const [sel, attr] of [
        ['a[href]', 'href'], ['area[href]', 'href'],
        ['img[src]', 'src'], ['script[src]', 'src'], ['iframe[src]', 'src'],
        ['source[src]', 'src'], ['video[src]', 'src'], ['audio[src]', 'src'],
        ['embed[src]', 'src'], ['object[data]', 'data'], ['form[action]', 'action'],
    ]) {
        $(sel).each((_, el) => {
            const v = $(el).attr(attr);
            if (v != null) record(v, fromUrl, rel, `${sel}[${attr}]`);
        });
    }
    // <link> 要看 rel。rel=preconnect／dns-prefetch 只是連線提示，瀏覽器不會對它
    // 發出任何請求；把它當成一般連結送進排程健檢會得到穩定的假失效——實測
    // GET https://fonts.googleapis.com/ 與 https://fonts.gstatic.com/ 都回 404，
    // 而這兩個網址在全部 94 個頁面上都只是 preconnect。每週固定誤報兩筆，正是
    // 最會把維護者訓練成忽略通知的那種訊號。
    $('link[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (href == null) return;
        const linkRel = ($(el).attr('rel') || '').toLowerCase().split(/\s+/);
        if (linkRel.includes('preconnect') || linkRel.includes('dns-prefetch')) {
            refCount++;
            const key = 'link rel=preconnect／dns-prefetch（連線提示，瀏覽器不會擷取）';
            if (!ignored.has(key)) ignored.set(key, { count: 0, sample: String(href).slice(0, 60) });
            ignored.get(key).count++;
            return;
        }
        record(href, fromUrl, rel, 'link[href]');
    });
    $('[srcset]').each((_, el) => {
        for (const u of parseSrcset($(el).attr('srcset'))) record(u, fromUrl, rel, 'srcset');
    });
    // meta 型的網址（og:url、og:image、twitter:image）——同源絕對網址的主要來源
    $('meta[content]').each((_, el) => {
        const prop = ($(el).attr('property') || $(el).attr('name') || '').toLowerCase();
        if (!/^(og:(url|image(:secure_url)?)|twitter:image)$/.test(prop)) return;
        record($(el).attr('content'), fromUrl, rel, `meta[${prop}]`);
    });
    // JSON-LD 內的 url／logo
    $('script[type="application/ld+json"]').each((_, el) => {
        let parsed;
        try {
            parsed = JSON.parse($(el).text());
        } catch (e) {
            return addError(rel, 'ld+json', `JSON-LD 無法解析：${e.message}`);
        }
        for (const { pointer, value } of walkJsonStrings(parsed)) {
            if (/^https?:\/\//i.test(value) || value.startsWith('/')) record(value, fromUrl, rel, `ld+json${pointer}`);
        }
    });

    // canonical 必須存在、唯一，且指向自己
    const canon = $('link[rel="canonical"]');
    if (!isLayoutPage) {
        // 驗證檔沒有 canonical 是預期的
    } else if (canon.length !== 1) {
        addError(rel, 'link[rel=canonical]', `應恰好有 1 個，實際 ${canon.length} 個`);
    } else {
        const c = classifyReference(canon.attr('href'), fromUrl, CTX);
        if (c.kind !== 'internal') addError(rel, 'canonical', `canonical 不是站內網址：${canon.attr('href')}`);
        else if (c.path !== fromUrl) addError(rel, 'canonical', `canonical 指向 ${c.path}，但本頁的部署網址是 ${fromUrl}`);
        const ogUrl = $('meta[property="og:url"]').attr('content');
        if (ogUrl && ogUrl !== canon.attr('href')) addError(rel, 'og:url', `og:url 與 canonical 不一致：${ogUrl}`);
    }
}

// ── CSS ──
for (const rel of distFiles.filter((f) => f.endsWith('.css'))) {
    const css = await readFile(path.join(DIST, rel), 'utf8');
    for (const u of parseCssUrls(css)) record(u, urlOf(rel), rel, 'css url()');
}

// ── sitemap ──
for (const rel of distFiles.filter((f) => /sitemap.*\.xml$/.test(f))) {
    const xml = await readFile(path.join(DIST, rel), 'utf8');
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) record(m[1].trim(), `${BASE}/`, rel, '<loc>');
}

// ── search-index.json：其 url 帶 fragment，先前完全不在檢查面內 ──
const searchIndexRel = 'search-index.json';
/** @type {any[] | null} 供下方「來源分類欄位是否真的進了索引」比對用 */
let searchIndex = null;
if (distFiles.includes(searchIndexRel)) {
    const idx = JSON.parse(await readFile(path.join(DIST, searchIndexRel), 'utf8'));
    if (!Array.isArray(idx)) addError(searchIndexRel, '', '最外層應為陣列');
    else {
        searchIndex = idx;
        idx.forEach((item, i) => {
            if (item && typeof item.url === 'string') record(item.url, `${BASE}/`, searchIndexRel, `/${i}/url`);
            if (!item || typeof item !== 'object') return;
            // 分類欄位（competencies／sdgs／taxonomy）的合法性與自洽性。非法代碼
            // 不會讓頁面壞掉，只會讓那個標籤永遠搜不到——那種症狀沒有人會回報。
            const taxErrors = [];
            validateIndexedTaxonomy(item, `索引項目 #${i}（${item.title || item.url || '未命名'}）`, taxErrors);
            for (const e of taxErrors) addError(searchIndexRel, `/${i}`, e);
        });
    }
} else {
    addError('dist/', searchIndexRel, '找不到 search-index.json——請確認建置有跑 build-search-index.js');
}

// ── 資料驅動頁面的 runtime reference ──
// 相對路徑要相對「消費它的頁面」解析，不是 JSON 自己的位置。
for (const [page, cfg] of Object.entries(dataPages.pages)) {
    const jsonRel = cfg.json;
    if (!distFiles.includes(jsonRel)) {
        addError(jsonRel, '', `資料頁 ${page} 需要的 JSON 不在建置產物中`);
        continue;
    }
    if (!distFiles.includes(page)) {
        addError(page, '', `data-pages.json 設定的頁面不在建置產物中`);
        continue;
    }
    const consumerUrl = urlOf(page);
    let data;
    try {
        data = JSON.parse(await readFile(path.join(DIST, jsonRel), 'utf8'));
    } catch (e) {
        addError(jsonRel, '', `JSON 無法解析：${e.message}`);
        continue;
    }
    // ── 來源 JSON 的分類欄位是否真的進了 search-index.json ──
    // 只對「每筆項目都有自己錨點」的頁面做（anchorField），因為只有那種頁面的
    // 索引 url 是可預測的。少了這一條，把 civic-tech-map 從 data-pages.json 拿掉、
    // 或 build-search-index.js 不再輸出 competencies，站台檢查都會照樣全綠而
    // 搜尋功能已經沒了——「CI 綠不等於有在把關」的典型。
    if (cfg.anchorField && searchIndex) {
        const byUrl = new Map(searchIndex.filter((it) => it && typeof it.url === 'string').map((it) => [it.url, it]));
        const top = Array.isArray(data[cfg.arrayKey]) ? data[cfg.arrayKey] : [];
        const items = cfg.nestedKey
            ? top.flatMap((g) => (g && Array.isArray(g[cfg.nestedKey]) ? g[cfg.nestedKey] : []))
            : top;
        for (const item of items) {
            if (!item || typeof item !== 'object') continue;
            const anchor = item[cfg.anchorField];
            if (typeof anchor !== 'string' || !anchor) {
                addError(jsonRel, cfg.anchorField, `項目缺少 anchorField 指定的欄位 ${cfg.anchorField}`);
                continue;
            }
            const indexed = byUrl.get(`${page}#${anchor}`);
            if (!indexed) {
                addError(searchIndexRel, `${page}#${anchor}`, `來源資料有這筆項目，搜尋索引卻沒有對應的 url`);
                continue;
            }
            for (const [field, expected] of [
                ['competencies', Array.isArray(item.competencies) ? item.competencies : null],
                ['sdgs', Array.isArray(item.sdgs) ? item.sdgs.map((n) => `SDG${n}`) : null],
            ]) {
                if (!expected || expected.length === 0) continue;
                const actual = Array.isArray(indexed[field]) ? indexed[field] : [];
                const missing = expected.filter((v) => !actual.includes(v));
                if (missing.length) {
                    addError(searchIndexRel, `${page}#${anchor}`, `來源的 ${field} 有「${missing.join('、')}」，索引裡卻沒有`);
                }
            }
        }
    }

    for (const { pointer, value } of walkJsonStrings(data)) {
        const field = pointer.split('/').pop();
        if (dataPages.localAssetFields.includes(field)) {
            record(value, consumerUrl, jsonRel, pointer);
        } else if (dataPages.htmlFields.includes(field)) {
            const $$ = cheerio.load(value);
            $$('a[href]').each((_, el) => record($$(el).attr('href'), consumerUrl, jsonRel, `${pointer} a[href]`));
            $$('img[src]').each((_, el) => record($$(el).attr('src'), consumerUrl, jsonRel, `${pointer} img[src]`));
        } else if (/^https?:\/\//i.test(value)) {
            // 其餘外部網址只進 inventory，交給排程健康檢查
            record(value, consumerUrl, jsonRel, pointer);
        }
    }

    // ── 內文裸網域 ──
    // 兩種欄位要跳過，都是實測出來的誤判來源：
    //   localAssetFields  存的是檔案路徑而不是說明文字
    //   _readme           是給維護者看的欄位說明，裡面全是本 repo 的檔名
    //                     （check-competitions.mjs、competitions.html…）。實測不跳過
    //                     的話，56 個候選裡有 11 個是 _readme 的檔名。
    // 比對 pointer 的**每一段**而不是只比最後一段：_readme 或圖片欄位一旦變成陣列，
    // pointer 會是 /_readme/0，最後一段是 "0"，只比最後一段的話跳過邏輯會靜默失效。
    const acceptField = makeSkipFieldFilter([...dataPages.localAssetFields, '_readme']);
    for (const [host, pointers] of collectBareDomains(data, acceptField)) {
        if (!bareDomains.has(host)) bareDomains.set(host, { host, occurrences: [] });
        for (const p of pointers) bareDomains.get(host).occurrences.push({ file: jsonRel, location: p });
    }
}

// ── 解析所有站內 reference ──
// 順帶記下「從 HTML 屬性解析到的 vendor JS」，那是下面 import 圖走訪的起點。
const vendorJsSeeds = new Set();
for (const ref of internal) {
    const res = resolveInternalPath(ref.path, routeMap);
    if (!res.ok) {
        addError(ref.file, ref.location, `${res.reason}：${ref.path}`);
        continue;
    }
    if (/^vendor\/.+\.[cm]?js$/.test(res.file)) vendorJsSeeds.add(res.file);
    if (!ref.fragment) continue;
    if (!res.file.endsWith('.html')) {
        addError(ref.file, ref.location, `對非 HTML 檔案使用 fragment：${ref.path}#${ref.fragment}`);
        continue;
    }
    let anchors = anchorCache.get(res.file);
    if (!anchors) {
        const $ = cheerio.load(await readFile(path.join(DIST, res.file), 'utf8'));
        anchors = collectAnchors($);
        anchorCache.set(res.file, anchors);
    }
    if (!anchors.has(ref.fragment)) {
        addError(ref.file, ref.location, `目標頁面沒有 id="${ref.fragment}"：${ref.path}#${ref.fragment}`);
    }
}

// ── vendor 的 ES module import 圖（遞移）──
//
// 為什麼一定要在這裡做，而不是只靠 vendor 步驟自己驗：
// 本檔原本只認 HTML 屬性（script[src]、link[href]…）。自架的函式庫改成 ES
// module 之後，被屬性指名的往往只是一個很小的進入點，真正的程式碼躲在它的
// import 後面——那一整層對本檔是隱形的。實測過兩個洞，兩個都是「CI 全綠而
// 功能已死」：
//
//   rm dist/vendor/fuse.esm.js            → 舊版：錯誤 0、✅ 全部通過；全站搜尋已死
//   rm dist/vendor/ionicons/p-*.js        → 舊版：錯誤 0、✅ 全部通過；
//                                            瀏覽器實測 17 個 ion-icon 全部沒有 shadowRoot
//
// 曾經試過的替代方案：在頁面補 <link rel="modulepreload">，把進入點的相依也
// 寫成 HTML 屬性。那對 fuse 有效，但（a）刪掉那一行就悄悄退回原狀，(b) ionicons
// 的 chunk 檔名帶 hash，根本沒辦法寫進 .astro。也就是說它把「保護」寄託在
// 一行可以被任何人順手刪掉的樣板上。所以改成從產物本身走 import 圖——
// 那是刪不掉的：只要頁面還載那個進入點，這一關就會跟著跑。
// modulepreload 因此回到它本來的身分：純粹的效能提示。
//
// 範圍限定在 vendor/：那是 scripts/vendor-assets.mjs 手動複製出來的樹，也是
// 漂移真正會發生的地方。_astro/ 底下的 chunk 由 Vite 自己產生與命名，它的
// import 圖一致性由打包器保證，重複驗只是多一份會壞掉的邏輯。
//
// 只驗靜態 import。stencil 的 loader 是 import(變數) 去 lazy-load chunk 的，
// 那種靜態分析不到——所以這一關的主張僅止於「靜態 import 的目標都在」，
// 不宣稱「所有會被載入的檔都驗過」（後者由 vendor 步驟整個目錄搬過來，
// 以及 tests/e2e 的 shadow DOM 檢查負責）。
const distFileSet = new Set(distFiles);
{
    const visited = new Set();
    const queue = [...vendorJsSeeds];
    while (queue.length) {
        const rel = queue.shift();
        if (visited.has(rel)) continue;
        visited.add(rel);
        let src;
        try {
            src = await readFile(path.join(DIST, rel), 'utf8');
        } catch (e) {
            addError(rel, 'import', `讀不到這個檔案：${e.message}`);
            continue;
        }
        for (const spec of staticImportSpecifiers(src)) {
            if (!spec.startsWith('./') && !spec.startsWith('../')) {
                addError(rel, 'ESM import', `靜態 import 了「${spec}」——不是相對路徑，瀏覽器沒有 import map 解析不了`);
                continue;
            }
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec.split(/[?#]/)[0]));
            if (target.startsWith('..')) {
                addError(rel, 'ESM import', `靜態 import 了「${spec}」，解析後逸出建置產物：${target}`);
                continue;
            }
            if (!distFileSet.has(target)) {
                addError(rel, 'ESM import', `靜態 import 了「${spec}」，但 ${target} 不在建置產物裡`);
                continue;
            }
            queue.push(target);
        }
    }
    vendorModuleCount = visited.size;
}

// ── vendor 產出清單（scripts/vendor-assets.mjs 寫的）──
//
// 上面的 import 圖走訪有三個結構性盲點，每一個都被實測打穿過：
//
//   · 動態 import 看不到。stencil 用 import(變數) 載 ion-icon 的 entry chunk，
//     刪掉它 → 走訪毫無反應、check:site 全綠，而瀏覽器是 17 個 ion-icon
//     全部有 shadowRoot 但 0 個有 <svg>，console 印
//     TypeError: Failed to fetch dynamically imported module。
//     ionicons 8 上，走訪只碰得到 9 個產出裡的 2 個。
//   · 非 JS 的產出不在圖上。刪掉 vendor/ionicons/svg/search-outline.svg → 全綠。
//   · 走訪會被餓死。它的起點來自 HTML 屬性，所以只要頁面改用 inline import()
//     載 vendor 程式碼，起點就是空集合——實測印出「走訪 0 個模組」、「錯誤：0」、
//     「✅ 全部通過」，而引擎與 chunk 都已經被刪掉。
//
// 清單沒有這三個盲點：vendor 步驟本來就精確知道自己產出了哪些檔，把那個集合寫
// 下來、在這裡逐一確認它們進了 dist/ 就好。不管 HTML 長什麼樣、不管靜態還是
// 動態、也不管副檔名。這是同一個保護第四次被搬家而不是被關上，到此為止。
//
// 清單本身不見時也要紅：否則刪掉清單就等於把這一關關掉。只有「dist 裡完全沒有
// vendor/ 產出」時才不要求（那種站台沒有自架函式庫可談）。
const VENDOR_MANIFEST_REL = 'vendor/vendor-manifest.json';
let vendorManifestCount = 0;
{
    const hasVendorOutput = distFiles.some((f) => f.startsWith('vendor/'));
    if (hasVendorOutput && !distFileSet.has(VENDOR_MANIFEST_REL)) {
        addError(
            VENDOR_MANIFEST_REL,
            'vendor 產出清單',
            'dist/ 裡有 vendor/ 產出卻找不到這份清單。它由 scripts/vendor-assets.mjs 產生，缺了它等於整個 vendor 產物沒有人在驗。',
        );
    } else if (hasVendorOutput) {
        let manifest;
        try {
            manifest = JSON.parse(await readFile(path.join(DIST, VENDOR_MANIFEST_REL), 'utf8'));
        } catch (e) {
            addError(VENDOR_MANIFEST_REL, 'vendor 產出清單', `無法解析：${e.message}`);
        }
        const list = Array.isArray(manifest?.files) ? manifest.files : null;
        if (manifest && !list) {
            addError(VENDOR_MANIFEST_REL, 'vendor 產出清單', 'files 欄位不是陣列，清單格式不對');
        } else if (list) {
            if (list.length === 0) {
                addError(VENDOR_MANIFEST_REL, 'vendor 產出清單', '清單是空的——vendor 步驟不可能沒有任何產出，這代表清單本身壞了');
            }
            vendorManifestCount = list.length;
            for (const entry of list) {
                if (typeof entry !== 'string' || entry.startsWith('/') || entry.includes('..')) {
                    addError(VENDOR_MANIFEST_REL, 'vendor 產出清單', `不合法的清單項目：${String(entry).slice(0, 80)}`);
                    continue;
                }
                if (!distFileSet.has(`vendor/${entry}`)) {
                    addError(VENDOR_MANIFEST_REL, 'vendor 產出清單', `vendor 步驟產出過 ${entry}，但它不在建置產物裡`);
                }
            }
        }
    }
}

// ── 外部網址 inventory（供排程健康檢查使用）──
// 已經寫成 url 的主機名不必再從內文查一次（實測 44 個候選裡有 14 個是重複的）。
// 比對用「完全相同的主機名」：ctf.hitcon.org 與 hitcon.org 是不同主機，
// www.amt.edu.au 與 amt.edu.au 也是，一律不做 www. 或母網域的正規化。
// 這一步必須等 HTML 與 JSON 都掃完才做，否則 external 還不完整就會誤判成「沒被涵蓋」。
const coveredHosts = new Set();
for (const u of external.keys()) {
    try {
        coveredHosts.add(new URL(u).hostname.toLowerCase());
    } catch {
        /* 非法網址在 record() 就已經報過錯 */
    }
}
const bareOnly = [...bareDomains.values()]
    .filter((b) => !coveredHosts.has(b.host))
    .sort((a, b) => a.host.localeCompare(b.host));

await mkdir(path.dirname(INVENTORY_PATH), { recursive: true });
await writeFile(
    INVENTORY_PATH,
    JSON.stringify(
        // generatedFrom 記的是「這份盤點掃的是哪一個目錄」，不是固定字串。
        // 故障注入會用 SITE_DIST 指向 dist 的副本，那一輪同樣會覆寫這個檔案；
        // 下游（check-link-policy.mjs）據此拒絕拿被破壞過的副本當成正式盤點。
        {
            generatedFrom: path.basename(DIST),
            total: external.size,
            urls: [...external.values()].sort((a, b) => a.url.localeCompare(b.url)),
            bareDomainCandidates: {
                total: bareDomains.size,
                alreadyCoveredByUrls: bareDomains.size - bareOnly.length,
                hosts: bareOnly,
            },
        },
        null,
        2,
    ),
    'utf8',
);

// ── 報告 ──
console.log('建置產物站台契約檢查');
console.log(`  HTML ${htmlFiles.length} 檔、dist 檔案 ${distFiles.length} 個`);
console.log(`  檢查的 reference：${refCount}`);
console.log(`  站內需解析：${internal.length}`);
console.log(`  vendor ES module import 圖：走訪 ${vendorModuleCount} 個模組（起點來自 HTML 屬性；追不到動態 import）`);
console.log(`  vendor 產出清單：${vendorManifestCount} 筆全部存在於 dist/（不受 HTML 形狀與動態 import 影響）`);
// 去重數與出現次數都要列出：只列去重數會讓總和對不起來，讀的人會誤以為有
// 一批 reference 憑空消失（我自己在 review 時就這樣誤判過一次）。
const externalOccurrences = [...external.values()].reduce((a, b) => a + b.occurrences.length, 0);
console.log(`  外部網址（僅列入 inventory）：${external.size} 個去重網址／${externalOccurrences} 處引用`);
// 裸網域是「候選」不是「網域」：TLD 存不存在要等排程健檢用 DNS 判斷。這裡的
// 數字刻意分成三個，否則「候選 44」會被誤讀成「新增了 44 個要查的網址」。
console.log(
    `  內文裸網域候選：${bareDomains.size} 個（${bareDomains.size - bareOnly.length} 個已由 url 欄位涵蓋，${bareOnly.length} 個待排程健檢以 DNS 篩選）`,
);
const ignoredTotal = [...ignored.values()].reduce((a, b) => a + b.count, 0);
console.log(`  略過不檢查：${ignoredTotal}`);
for (const [reason, info] of [...ignored].sort((a, b) => b[1].count - a[1].count)) {
    console.log(`      ${String(info.count).padStart(5)}  ${reason}   （例：${info.sample}）`);
}
console.log(`  錯誤：${errors.length}`);

if (errors.length) {
    console.error('\n站台契約錯誤：');
    const byFile = new Map();
    for (const e of errors) {
        if (!byFile.has(e.file)) byFile.set(e.file, []);
        byFile.get(e.file).push(e);
    }
    for (const [file, list] of [...byFile].sort()) {
        console.error(`\n  ${file}`);
        for (const e of list) console.error(`    ✗ [${e.location}] ${e.message}`);
    }
    console.error(`\n共 ${errors.length} 項錯誤。`);
    process.exit(1);
}
console.log('\n✅ 站台契約全部通過。');
