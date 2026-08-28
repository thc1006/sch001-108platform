#!/usr/bin/env node
/**
 * 版面幾何擷取：在 1280x900 逐頁抓每個可見元素的 x/y/w/h。
 *
 * 換字型必然會動版面，重點是量化「動多少」。這支負責擷取，layout-diff.mjs 負責比對。
 *
 * 量測競態的處理（本站有 3 頁的卡片是 JS 渲染 + CSS 交錯動畫延遲）：
 *  - emulateMedia({ reducedMotion: 'reduce' })：competitions 頁自己有
 *    @media (prefers-reduced-motion: reduce) { .comp-card { animation: none } }
 *  - 另外注入 `animation: none !important; transition: none !important`，
 *    蓋掉沒有 reduced-motion 守門的頁（senior-interviews 的 .fade-in、
 *    career-exploration 的 fadeIn）。這些動畫只動 opacity/transform，
 *    但 getBoundingClientRect() 回傳的是「套用 transform 之後」的框，
 *    所以動畫中途取樣會量到位移——那是取樣時機造成的，不是真差異。
 *  - 等 document.fonts.ready，確保字型已換入。
 *
 * 這些處理對不對，由 layout-diff.mjs 的「控制實驗」（同一份產出跟自己比）驗證：
 * 控制組的差異數必須是 0，否則量測本身就不可信，比出來的數字也不能用。
 *
 * 用法：node perf/layout-geom.mjs --root perf/roots/baseline --port 9401 --out perf/out/geom-baseline.json
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const arg = (n, d) => {
    const i = process.argv.indexOf('--' + n);
    return i === -1 ? d : process.argv[i + 1];
};
const ROOT = arg('root', 'perf/roots/baseline');
const PORT = Number(arg('port', 9401));
const OUT = arg('out', 'perf/out/geom.json');
const LIMIT = Number(arg('limit', 0));
/**
 * 覆寫 body 的 font-family。用途：這台量測機裝了 NotoSansTC-VF.ttf，系統字型堆疊
 * 會直接命中本機的 Noto Sans TC —— 也就是跟 webfont 同一套字，量出來的版面差異
 * 會接近 0，那對「沒裝 Noto 的使用者」完全沒有代表性。用這個參數把堆疊改成
 * 不含 Noto 的版本，就能量到 Windows 使用者實際會看到的 Microsoft JhengHei。
 * 站台的字型堆疊只宣告在 body 上，其餘靠繼承；有自己 font-family 的元素
 * （競賽頁的 Space Mono）不受影響，正是我們要的。
 */
const BODY_FONT = arg('bodyfont', '');

function walk(dir, prefix = '', out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
        else if (e.name.endsWith('.html')) out.push(rel);
    }
    return out;
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
        p.on('exit', (c) => !done && reject(new Error('server exited ' + c)));
        setTimeout(() => !done && reject(new Error('server timeout')), 15000);
    });
}

const KILL_ANIM = `*, *::before, *::after {
  animation-delay: 0s !important;
  animation-duration: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}`;

const server = await startServer();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
// reducedMotion 由 newContext 選項設定（emulateMedia 在 context 上不存在）
// 分析腳本會拖慢並帶進不必要的變異，版面幾何用不到
await context.route('**/*', (route) => {
    const h = (() => {
        try {
            return new URL(route.request().url()).hostname;
        } catch {
            return '';
        }
    })();
    if (/googletagmanager\.com|gc\.zgo\.at|google-analytics\.com|dicebear\.com/.test(h)) return route.abort();
    return route.continue();
});
const page = await context.newPage();
await page.emulateMedia({ reducedMotion: 'reduce' });
const cdp = await context.newCDPSession(page);
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');
let platformFonts = null;

const DIST = path.join(REPO, ROOT, 'sch001-108platform');
let pages = walk(DIST).filter((p) => !p.startsWith('google'));
if (LIMIT) pages = pages.slice(0, LIMIT);

const result = { root: ROOT, viewport: '1280x900', bodyFont: BODY_FONT || null, pages: {} };
let i = 0;
for (const rel of pages) {
    i++;
    await page.goto(`http://localhost:${PORT}/sch001-108platform/${rel}`, {
        waitUntil: 'networkidle',
        timeout: 60000,
    });
    // 資料驅動頁面要等 JS 把卡片渲染完（高度不再變）
    await page
        .waitForFunction(
            () => {
                const h = document.body.scrollHeight;
                if (window.__lastH === h) return true;
                window.__lastH = h;
                return false;
            },
            { timeout: 10000, polling: 300 },
        )
        .catch(() => {});
    await page.addStyleTag({ content: KILL_ANIM });
    if (BODY_FONT) await page.addStyleTag({ content: `body { font-family: ${BODY_FONT} !important; }` });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);

    // 用 CDP 問「這個文字節點實際上是用哪個平台字型畫出來的」。
    // 這是唯一能證明字型堆疊真的落到預期字型的方法——CSS 只是宣告意圖。
    if (!platformFonts) {
        try {
            const doc = await cdp.send('DOM.getDocument', { depth: -1 });
            const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'h1, h2, p' });
            if (q.nodeId) {
                const pf = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: q.nodeId });
                platformFonts = { page: rel, fonts: pf.fonts };
            }
        } catch (e) {
            platformFonts = { page: rel, error: String(e.message).slice(0, 120) };
        }
    }

    const geom = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] || '' : '';
            out.push([
                el.tagName.toLowerCase(),
                cls,
                Math.round(r.x * 100) / 100,
                Math.round((r.y + window.scrollY) * 100) / 100,
                Math.round(r.width * 100) / 100,
                Math.round(r.height * 100) / 100,
            ]);
        }
        return { els: out, docH: Math.round(document.body.scrollHeight), docW: Math.round(document.body.scrollWidth) };
    });
    result.pages[rel] = geom;
    process.stderr.write(`\r${ROOT} ${i}/${pages.length} ${rel.padEnd(52)}`);
}
process.stderr.write('\n');

await browser.close();
server.kill();
mkdirSync(path.dirname(path.resolve(REPO, OUT)), { recursive: true });
result.platformFonts = platformFonts;
writeFileSync(path.resolve(REPO, OUT), JSON.stringify(result));
console.log('實際使用的平台字型（首頁第一個 h1/h2/p）：' + JSON.stringify(platformFonts));
console.log('寫入 ' + OUT + `（${pages.length} 頁）`);
