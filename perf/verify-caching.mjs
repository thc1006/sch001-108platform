#!/usr/bin/env node
/**
 * 驗證兩件會左右「自架 vs Google Fonts」判斷的事實，而不是引用傳言：
 *  1. GitHub Pages 的 Cache-Control 與 ETag 條件請求行為（max-age 到期後是
 *     整份重抓，還是 304？）——這決定 max-age=600 到底有多痛。
 *  2. 這台機器到 fonts.googleapis.com / fonts.gstatic.com 的實際 RTT，
 *     用來說明「節流量測對第三方多加了多少真實延遲」的偏差量級。
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

async function rtt(url, n = 8) {
    const ts = [];
    for (let i = 0; i < n; i++) {
        const t = process.hrtime.bigint();
        try { await fetch(url, { method: 'GET', headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' } }); } catch { continue; }
        ts.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    ts.sort((a, b) => a - b);
    return ts.length ? { n: ts.length, min: +ts[0].toFixed(0), p50: +ts[Math.floor(ts.length / 2)].toFixed(0), max: +ts[ts.length - 1].toFixed(0) } : null;
}

const GHP = 'https://thc1006.github.io/sch001-108platform/index.html';
const r1 = await fetch(GHP, { headers: { 'User-Agent': UA } });
const etag = r1.headers.get('etag');
const lastMod = r1.headers.get('last-modified');
const body1 = (await r1.arrayBuffer()).byteLength;
console.log('GitHub Pages 首次 GET：status=%s cache-control=%s etag=%s body=%d bytes', r1.status, r1.headers.get('cache-control'), etag, body1);

const r2 = await fetch(GHP, { headers: { 'User-Agent': UA, 'If-None-Match': etag } });
const body2 = (await r2.arrayBuffer()).byteLength;
console.log('帶 If-None-Match 再取：status=%s body=%d bytes  ← 304 代表 max-age 到期後只是重新驗證，不是整份重抓', r2.status, body2);

if (lastMod) {
    const r3 = await fetch(GHP, { headers: { 'User-Agent': UA, 'If-Modified-Since': lastMod } });
    console.log('帶 If-Modified-Since 再取：status=%s', r3.status);
}

console.log('\nRTT（含 TLS，非純網路 RTT，只取相對量級）：');
for (const u of ['https://thc1006.github.io/sch001-108platform/favicon.svg', 'https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap', 'https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2']) {
    console.log('  ' + new URL(u).hostname.padEnd(24), JSON.stringify(await rtt(u)));
}
