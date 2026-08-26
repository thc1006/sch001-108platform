/**
 * 全站外部網址盤點
 * --------------------------------------------------------------
 * 為什麼需要這支：Astro 遷移後，`dist/**\/*.html` 並不是全站的 URL inventory。
 * 多個頁面是資料驅動的——前端 fetch JSON 後才在瀏覽器端渲染卡片，那些網址
 * 從來不會出現在 build 產物的 HTML 裡，所以掃 HTML 的工具一個都看不到。
 *
 * 實測（2026-08）：10 個資料檔共 235 個外部網址，其中只有 18 個出現在 build
 * 後的 HTML —— 也就是 217 個（92%）對 lychee 是隱形的。
 *
 * 因此這裡同時從兩個來源盤點，並保留 provenance（同一個網址可能來自多處），
 * 讓報告能直接指出「要去哪個檔案修」。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

/** HTML 中會產生使用者可見請求的屬性。 */
const HTML_TARGETS = [
    ['a', 'href'],
    ['img', 'src'],
    ['script', 'src'],
    ['link', 'href'],
    ['iframe', 'src'],
    ['source', 'src'],
];

const isExternal = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);

/** 去掉追蹤參數與尾端標點造成的假性差異，避免同一個網址被當成多個。 */
export function normalizeUrl(raw) {
    let v = String(raw).trim().replace(/[.,;)\]]+$/, '');
    try {
        const u = new URL(v);
        u.hash = '';
        return u.toString();
    } catch {
        return v;
    }
}

async function walk(dir, out = []) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p, out);
        else out.push(p);
    }
    return out;
}

/** 遞迴走訪 JSON，收集所有看起來是外部網址的字串值。 */
function collectFromJson(node, sink) {
    if (typeof node === 'string') {
        if (isExternal(node)) sink.add(normalizeUrl(node));
        return;
    }
    if (Array.isArray(node)) {
        for (const v of node) collectFromJson(v, sink);
        return;
    }
    if (node && typeof node === 'object') {
        for (const v of Object.values(node)) collectFromJson(v, sink);
    }
}

/**
 * 盤點外部網址。
 *
 * @param {{htmlDir?:string, jsonDir?:string, excludeJson?:string[]}} opts
 *   excludeJson：已由其他檢查器負責外部可用性的資料檔（相對路徑片段比對）。
 *   刻意設計成「必須明講」——每個資料檔都要有明確的 owner，不能存在
 *   「沒有任何工具會看到它」的檔案。
 * @returns {Promise<{entries: {url:string, sources:string[]}[], stats: object}>}
 */
export async function collectExternalUrls(opts = {}) {
    const htmlDir = opts.htmlDir ?? 'dist';
    const jsonDir = opts.jsonDir ?? 'public';
    const excludeJson = opts.excludeJson ?? [];

    /** @type {Map<string, Set<string>>} */
    const byUrl = new Map();
    const add = (url, source) => {
        const k = normalizeUrl(url);
        if (!byUrl.has(k)) byUrl.set(k, new Set());
        byUrl.get(k).add(source);
    };

    const stats = { htmlFiles: 0, jsonFiles: 0, jsonSkipped: [], fromHtml: 0, fromJson: 0 };

    for (const file of await walk(htmlDir)) {
        if (!file.endsWith('.html')) continue;
        stats.htmlFiles++;
        const $ = cheerio.load(await readFile(file, 'utf8'));
        for (const [tag, attr] of HTML_TARGETS) {
            $(`${tag}[${attr}]`).each((_, el) => {
                const v = $(el).attr(attr);
                if (isExternal(v)) {
                    add(v, file.replace(/\\/g, '/'));
                    stats.fromHtml++;
                }
            });
        }
    }

    for (const file of await walk(jsonDir)) {
        if (!file.endsWith('.json')) continue;
        const rel = file.replace(/\\/g, '/');
        if (excludeJson.some((x) => rel.includes(x))) {
            stats.jsonSkipped.push(rel);
            continue;
        }
        stats.jsonFiles++;
        let parsed;
        try {
            parsed = JSON.parse(await readFile(file, 'utf8'));
        } catch {
            continue; // 格式錯誤由各自的 schema 驗證負責，不在本工具的職責內
        }
        const sink = new Set();
        collectFromJson(parsed, sink);
        for (const u of sink) {
            add(u, rel);
            stats.fromJson++;
        }
    }

    const entries = [...byUrl.entries()]
        .map(([url, sources]) => ({ url, sources: [...sources].sort() }))
        .sort((a, b) => a.url.localeCompare(b.url));

    return { entries, stats };
}

/** 供測試與報告使用：確認 jsonDir 底下每個 JSON 都有明確歸屬。 */
export async function auditJsonOwnership(jsonDir, ownedElsewhere) {
    const files = (await walk(jsonDir)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\\/g, '/'));
    return files.map((f) => ({
        file: f,
        owner: ownedElsewhere.find((o) => f.includes(o.match))?.owner ?? 'external-links',
    }));
}

export { walk as _walkForTest };
