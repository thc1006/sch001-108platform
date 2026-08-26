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

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DIST = path.join(ROOT, 'dist');
const BASE = '/sch001-108platform';
const SITE = 'https://thc1006.github.io';
const CTX = { base: BASE, site: SITE };
const INVENTORY_PATH = path.join(ROOT, '.reports', 'url-inventory.json');

const dataPages = JSON.parse(await readFile(path.join(ROOT, 'scripts', 'data-pages.json'), 'utf8'));

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
        ['a[href]', 'href'], ['link[href]', 'href'], ['area[href]', 'href'],
        ['img[src]', 'src'], ['script[src]', 'src'], ['iframe[src]', 'src'],
        ['source[src]', 'src'], ['video[src]', 'src'], ['audio[src]', 'src'],
        ['embed[src]', 'src'], ['object[data]', 'data'], ['form[action]', 'action'],
    ]) {
        $(sel).each((_, el) => {
            const v = $(el).attr(attr);
            if (v != null) record(v, fromUrl, rel, `${sel}[${attr}]`);
        });
    }
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
if (distFiles.includes(searchIndexRel)) {
    const idx = JSON.parse(await readFile(path.join(DIST, searchIndexRel), 'utf8'));
    if (!Array.isArray(idx)) addError(searchIndexRel, '', '最外層應為陣列');
    else idx.forEach((item, i) => {
        if (item && typeof item.url === 'string') record(item.url, `${BASE}/`, searchIndexRel, `/${i}/url`);
    });
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
}

// ── 解析所有站內 reference ──
for (const ref of internal) {
    const res = resolveInternalPath(ref.path, routeMap);
    if (!res.ok) {
        addError(ref.file, ref.location, `${res.reason}：${ref.path}`);
        continue;
    }
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

// ── 外部網址 inventory（供排程健康檢查使用）──
await mkdir(path.dirname(INVENTORY_PATH), { recursive: true });
await writeFile(
    INVENTORY_PATH,
    JSON.stringify(
        { generatedFrom: 'dist', total: external.size, urls: [...external.values()].sort((a, b) => a.url.localeCompare(b.url)) },
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
// 去重數與出現次數都要列出：只列去重數會讓總和對不起來，讀的人會誤以為有
// 一批 reference 憑空消失（我自己在 review 時就這樣誤判過一次）。
const externalOccurrences = [...external.values()].reduce((a, b) => a + b.occurrences.length, 0);
console.log(`  外部網址（僅列入 inventory）：${external.size} 個去重網址／${externalOccurrences} 處引用`);
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
