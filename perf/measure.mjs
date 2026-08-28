#!/usr/bin/env node
/**
 * 字型載入效能量測工具。不在建置或 CI 流程裡，見 perf/README.md。
 *
 * 方法論（每個變體都用完全相同的流程）：
 *  - 每次迭代開新的 BrowserContext，並以 CDP Network.setCacheDisabled 強制冷快取，
 *    模擬「第一次造訪」。
 *  - CDP Network.emulateNetworkConditions 套用固定的網路節流（含 localhost），
 *    讓 HTML/CSS/字型都走同一條模擬鏈路；不節流的話本機資源是 0ms，會系統性地
 *    誇大第三方字型的相對代價。
 *  - CDP Emulation.setCPUThrottlingRate 固定 CPU 節流。
 *  - 傳輸位元組取自 CDP Network.loadingFinished 的 encodedDataLength（含 header），
 *    不用 performance.getEntriesByType('resource').transferSize —— 跨來源且沒有
 *    Timing-Allow-Origin 時後者會回報 0。
 *  - FCP/LCP/CLS 由 PerformanceObserver 在 addInitScript 中先掛好再導航。
 *  - 預設封鎖分析腳本（gtag/goatcounter），把「字型」這個受測變因隔離出來；
 *    --analytics 可關閉此封鎖做真實世界對照。
 *
 * 用法：
 *   node perf/measure.mjs --variant baseline --root perf/roots/baseline --port 9101 \
 *        --runs 20 --out perf/out/baseline.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function arg(name, dflt) {
    const i = process.argv.indexOf('--' + name);
    if (i === -1) return dflt;
    const v = process.argv[i + 1];
    return v && !v.startsWith('--') ? v : true;
}

const VARIANT = arg('variant', 'baseline');
const ROOT = arg('root', 'perf/roots/baseline');
const PORT = Number(arg('port', 9101));
const RUNS = Number(arg('runs', 20));
const OUT = arg('out', `perf/out/${VARIANT}.json`);
const ALLOW_ANALYTICS = !!arg('analytics', false);
const NO_THROTTLE = !!arg('no-throttle', false);

// 固定的節流設定。數字取自 Chrome DevTools 內建的 "Slow 4G" 預設值，
// 是可重現的基準，不是對任何特定使用者網路的宣稱。
const NET = {
    offline: false,
    downloadThroughput: (1.6 * 1024 * 1024) / 8, // 1.6 Mbps
    uploadThroughput: (750 * 1024) / 8, // 750 kbps
    latency: 150, // ms RTT
};
const CPU_RATE = 4;

const PAGES = [
    { name: 'index', url: 'index.html' },
    { name: 'competitions', url: 'advanced-resources/competitions.html' },
    { name: 'cluster-info', url: 'career-exploration/clusters/info/index.html' },
];

const ANALYTICS_HOSTS = ['googletagmanager.com', 'gc.zgo.at', 'google-analytics.com', 'goatcounter.com'];

function originGroup(url) {
    try {
        const h = new URL(url).hostname;
        if (h === 'localhost' || h === '127.0.0.1') return 'local';
        if (h === 'fonts.googleapis.com') return 'gfonts-css';
        if (h === 'fonts.gstatic.com') return 'gfonts-files';
        if (ANALYTICS_HOSTS.some((a) => h.endsWith(a))) return 'analytics';
        return 'other-3p:' + h;
    } catch {
        return 'other';
    }
}

function startServer() {
    return new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [path.join(REPO, 'scripts/static-server.mjs'), String(PORT), ROOT], {
            cwd: REPO,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let done = false;
        p.stdout.on('data', (d) => {
            if (!done && String(d).includes('靜態伺服器')) {
                done = true;
                resolve(p);
            }
        });
        p.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
        p.on('exit', (c) => {
            if (!done) reject(new Error('static server exited ' + c));
        });
        setTimeout(() => !done && reject(new Error('static server timeout')), 15000);
    });
}

const INIT = `
window.__perf = { fcp: null, lcp: null, cls: 0, shifts: [] };
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__perf.fcp = e.startTime;
  }).observe({ type: 'paint', buffered: true });
} catch (e) {}
try {
  new PerformanceObserver((l) => {
    const es = l.getEntries();
    const last = es[es.length - 1];
    if (last) window.__perf.lcp = last.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
} catch (e) {}
try {
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      if (e.hadRecentInput) continue;
      window.__perf.cls += e.value;
      window.__perf.shifts.push({ t: e.startTime, v: e.value });
    }
  }).observe({ type: 'layout-shift', buffered: true });
} catch (e) {}
`;

async function measureOnce(browser, pageDef) {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        // 不設 deviceScaleFactor / reducedMotion —— 保持與其他測試一致的預設
    });
    await context.addInitScript({ content: INIT });

    if (!ALLOW_ANALYTICS) {
        await context.route('**/*', (route) => {
            const h = (() => {
                try {
                    return new URL(route.request().url()).hostname;
                } catch {
                    return '';
                }
            })();
            if (ANALYTICS_HOSTS.some((a) => h.endsWith(a))) return route.abort();
            return route.continue();
        });
    }

    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    if (!NO_THROTTLE) {
        await cdp.send('Network.emulateNetworkConditions', NET);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    }

    const reqUrl = new Map(); // requestId -> url
    const reqType = new Map();
    const headers = new Map();
    const bytes = []; // {url, group, encodedDataLength, type}
    cdp.on('Network.requestWillBeSent', (e) => {
        reqUrl.set(e.requestId, e.request.url);
        reqType.set(e.requestId, e.type);
    });
    cdp.on('Network.responseReceived', (e) => {
        reqUrl.set(e.requestId, e.response.url);
        reqType.set(e.requestId, e.type);
        headers.set(e.response.url, e.response.headers);
    });
    cdp.on('Network.loadingFinished', (e) => {
        const url = reqUrl.get(e.requestId) || '?';
        bytes.push({
            url,
            group: originGroup(url),
            type: reqType.get(e.requestId) || '?',
            enc: e.encodedDataLength || 0,
        });
    });

    const url = `http://localhost:${PORT}/sch001-108platform/${pageDef.url}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    // `load` 不保證字型已下載完 —— webfont 是非阻塞的。只等 load + 固定秒數的話，
    // 節流之下 1MB 的 CJK 字型還沒換入就結束取樣，字型造成的 CLS 會整個量不到。
    // 明確等 document.fonts.ready，並記下它相對於導航起點的時間（無 webfont 的
    // 變體會立刻 resolve，這本身就是可比較的數字）。
    const fontsReady = await page.evaluate(async () => {
        const raced = await Promise.race([
            document.fonts.ready.then(() => 'ready'),
            new Promise((r) => setTimeout(() => r('timeout'), 25000)),
        ]);
        return { at: performance.now(), status: raced, count: document.fonts.size };
    });
    // 字型換入後仍要留時間讓重排、以及 JS 卡片渲染完成，才收得到最終 LCP/CLS。
    await page.waitForTimeout(2500);
    const perf = await page.evaluate(() => ({ ...window.__perf }));
    const wall = Date.now() - t0;

    const hdrs = {};
    for (const [u, h] of headers) {
        const g = originGroup(u);
        if (g.startsWith('gfonts')) hdrs[u] = { 'cache-control': h['cache-control'], 'content-type': h['content-type'] };
    }

    await context.close();
    return { ...perf, wall, fontsReady: fontsReady.at, fontsStatus: fontsReady.status, fontCount: fontsReady.count, bytes, headers: hdrs };
}

function stats(arr) {
    const a = arr.filter((x) => typeof x === 'number' && isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))];
    const r = (x) => Math.round(x * 1e5) / 1e5;
    return {
        n: a.length,
        min: r(a[0]),
        p50: r(q(0.5)),
        p75: r(q(0.75)),
        p95: r(q(0.95)),
        max: r(a[a.length - 1]),
        mean: r(a.reduce((s, x) => s + x, 0) / a.length),
        raw: a.map(r),
    };
}

const server = await startServer();
const browser = await chromium.launch();
const result = { variant: VARIANT, root: ROOT, runs: RUNS, net: NO_THROTTLE ? 'none' : NET, cpuRate: NO_THROTTLE ? 1 : CPU_RATE, analytics: ALLOW_ANALYTICS, pages: {} };

try {
    for (const pd of PAGES) {
        const samples = [];
        for (let i = 0; i < RUNS; i++) {
            samples.push(await measureOnce(browser, pd));
            process.stderr.write(`\r${VARIANT} ${pd.name} ${i + 1}/${RUNS}   `);
        }
        process.stderr.write('\n');

        // 位元組是決定性的：取第一次（並記錄各次是否一致）
        const byGroup = {};
        for (const b of samples[0].bytes) {
            byGroup[b.group] = byGroup[b.group] || { bytes: 0, requests: 0, urls: [] };
            byGroup[b.group].bytes += b.enc;
            byGroup[b.group].requests += 1;
            byGroup[b.group].urls.push({ url: b.url, enc: b.enc, type: b.type });
        }
        const totalsPerRun = samples.map((s) => s.bytes.reduce((a, b) => a + b.enc, 0));

        result.pages[pd.name] = {
            url: pd.url,
            fcp: stats(samples.map((s) => s.fcp)),
            lcp: stats(samples.map((s) => s.lcp)),
            cls: stats(samples.map((s) => s.cls)),
            wall: stats(samples.map((s) => s.wall)),
            fontsReady: stats(samples.map((s) => s.fontsReady)),
            fontsStatus: [...new Set(samples.map((s) => s.fontsStatus))],
            fontCount: [...new Set(samples.map((s) => s.fontCount))],
            bytesByGroup: Object.fromEntries(
                Object.entries(byGroup).map(([k, v]) => [k, { bytes: v.bytes, requests: v.requests }]),
            ),
            bytesDetail: byGroup,
            bytesTotalPerRun: totalsPerRun,
            bytesTotalStats: stats(totalsPerRun),
            gfontsHeaders: samples[0].headers,
            clsShiftsSample: samples[0].shifts,
        };
    }
    mkdirSync(path.dirname(path.resolve(REPO, OUT)), { recursive: true });
    writeFileSync(path.resolve(REPO, OUT), JSON.stringify(result, null, 2));
} finally {
    await browser.close();
    server.kill();
}

console.log('寫入 ' + OUT);
for (const [name, p] of Object.entries(result.pages)) {
    const g = p.bytesByGroup;
    const total = Object.values(g).reduce((a, b) => a + b.bytes, 0);
    const gf = (g['gfonts-css']?.bytes || 0) + (g['gfonts-files']?.bytes || 0);
    console.log(
        `${name.padEnd(14)} total=${(total / 1024).toFixed(1)}KB  gfonts=${(gf / 1024).toFixed(1)}KB (${((gf / total) * 100).toFixed(1)}%)  ` +
            `FCP p50=${p.fcp?.p50} p95=${p.fcp?.p95}  LCP p50=${p.lcp?.p50} p95=${p.lcp?.p95}  CLS p50=${p.cls?.p50} p95=${p.cls?.p95}  fontsReady p50=${p.fontsReady?.p50}`,
    );
}
