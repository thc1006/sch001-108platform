#!/usr/bin/env node
/** 把 perf/out/*.json 整理成 PR 用的對照表。用法：node perf/report.mjs baseline A B C D */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const variants = process.argv.slice(2);
const data = {};
for (const v of variants) {
    const p = path.join(REPO, 'perf/out', v + '.json');
    if (existsSync(p)) data[v] = JSON.parse(readFileSync(p, 'utf8'));
    else console.error('缺少 ' + p);
}
const names = Object.keys(data);
const PAGES = ['index', 'competitions', 'cluster-info'];
const kb = (n) => (n / 1024).toFixed(1);

function groups(p) {
    const g = p.bytesByGroup;
    const total = Object.values(g).reduce((a, b) => a + b.bytes, 0);
    const gf = (g['gfonts-css']?.bytes || 0) + (g['gfonts-files']?.bytes || 0);
    const fontLocal = (p.bytesDetail.local?.urls || []).filter((u) => /\.woff2?$/.test(u.url));
    const selfFont = fontLocal.reduce((a, b) => a + b.enc, 0);
    const req = Object.values(g).reduce((a, b) => a + b.requests, 0);
    const gfReq = (g['gfonts-css']?.requests || 0) + (g['gfonts-files']?.requests || 0);
    return { total, gf, selfFont, font: gf + selfFont, req, gfReq, selfFontReq: fontLocal.length };
}

console.log('\n══ 每頁傳輸位元組（冷快取、Slow-4G 節流、封鎖分析腳本；CDP encodedDataLength，含 header）══\n');
console.log(
    '| 頁面 | 變體 | 總傳輸 | 字型位元組 | 字型佔比 | 請求數 | 第三方字型請求 |',
);
console.log('|---|---|---:|---:|---:|---:|---:|');
for (const pg of PAGES) {
    for (const v of names) {
        const p = data[v].pages[pg];
        if (!p) continue;
        const g = groups(p);
        console.log(
            `| ${pg} | ${v} | ${kb(g.total)} KB | ${kb(g.font)} KB | ${((g.font / g.total) * 100).toFixed(1)}% | ${g.req} | ${g.gfReq} |`,
        );
    }
}

console.log('\n══ 載入指標（每個變體 12 次冷載入，p50 / p95，單位 ms；CLS 無單位）══\n');
console.log('| 頁面 | 變體 | FCP p50 | FCP p95 | LCP p50 | LCP p95 | fonts.ready p50 | CLS p50 | CLS p95 |');
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|');
for (const pg of PAGES) {
    for (const v of names) {
        const p = data[v].pages[pg];
        if (!p) continue;
        console.log(
            `| ${pg} | ${v} | ${p.fcp?.p50} | ${p.fcp?.p95} | ${p.lcp?.p50} | ${p.lcp?.p95} | ${p.fontsReady?.p50} | ${p.cls?.p50} | ${p.cls?.p95} |`,
        );
    }
}

console.log('\n══ 相對 baseline 的變化 ══\n');
console.log('| 頁面 | 變體 | 總傳輸 Δ | 字型 Δ | FCP p50 Δ | LCP p50 Δ | fonts.ready p50 Δ |');
console.log('|---|---|---:|---:|---:|---:|---:|');
for (const pg of PAGES) {
    const b = data.baseline?.pages[pg];
    if (!b) continue;
    const gb = groups(b);
    for (const v of names) {
        if (v === 'baseline') continue;
        const p = data[v].pages[pg];
        if (!p) continue;
        const g = groups(p);
        const pct = (a, bb) => (bb ? ((a - bb) / bb) * 100 : 0);
        console.log(
            `| ${pg} | ${v} | ${kb(g.total - gb.total)} KB (${pct(g.total, gb.total).toFixed(1)}%) | ${kb(g.font - gb.font)} KB (${pct(g.font, gb.font).toFixed(1)}%) | ${(p.fcp.p50 - b.fcp.p50).toFixed(0)} (${pct(p.fcp.p50, b.fcp.p50).toFixed(1)}%) | ${(p.lcp.p50 - b.lcp.p50).toFixed(0)} (${pct(p.lcp.p50, b.lcp.p50).toFixed(1)}%) | ${(p.fontsReady.p50 - b.fontsReady.p50).toFixed(0)} |`,
        );
    }
}

console.log('\n══ 量測設定 ══');
for (const v of names) {
    const d = data[v];
    console.log(
        `  ${v}: runs=${d.runs} 節流=${JSON.stringify(d.net)} cpuRate=${d.cpuRate} 分析腳本=${d.analytics ? '開' : '封鎖'}`,
    );
    for (const pg of PAGES) {
        const p = d.pages[pg];
        if (p) console.log(`     ${pg}: fonts.ready 狀態=${JSON.stringify(p.fontsStatus)} document.fonts.size=${JSON.stringify(p.fontCount)} 各次總位元組極差=${Math.max(...p.bytesTotalPerRun) - Math.min(...p.bytesTotalPerRun)} bytes`);
    }
}
