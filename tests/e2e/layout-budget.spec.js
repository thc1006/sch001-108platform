/**
 * 版面預算：固定 chrome 不得吃掉手機畫面，且不得有水平溢出
 * ================================================================
 * 這個檔案的存在理由跟 #78 的故障注入一樣：問題修好了不代表不會回來。站台 header
 * 是 sticky 64px，好幾頁的篩選面板又 sticky 釘在它下面，兩者疊加後實測：
 *
 *   competitions      360px 視窗 76%   390px 視窗 58%
 *   online-courses    360px 視窗 70%   390px 視窗 53%
 *   senior-interviews 360px 視窗 45%
 *   reading-list      360px 視窗 44%
 *   competency-map    360px 視窗 28%
 *
 * 在 360px 的視窗（iPhone SE、多數舊 Android）競賽頁只剩 24% 的畫面在顯示內容。
 * 沒有人會發現這件事——它不會讓 build 失敗，也不會讓任何既有檢查變紅。
 *
 * 判定方式刻意不看 CSS 的 position 或 top 值。第一版用
 * `position: sticky && rect.top <= 8` 判斷「貼在上緣」，結果把所有堆疊的 sticky
 * 都漏掉了——競賽頁的控制列是 top: 68px（疊在 header 下面），實測 59% 卻完全沒
 * 出現在報告裡。改成行為判定：捲動後位置幾乎沒動的元素，就是被釘住的 chrome。
 * 這對 sticky／fixed／transform 各種實作方式都成立。
 */
const { test, expect } = require('@playwright/test');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const DIST = path.resolve(__dirname, '../../.link-root/sch001-108platform');

// 上限。目前全站最高是 10%（只剩 header），留一倍餘裕給未來的小幅調整；
// 超過就是有東西又開始把畫面吃掉了，該重新設計而不是調高這個數字。
const CHROME_BUDGET_PCT = 20;

function walk(dir, prefix = '', out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
        else if (e.name.endsWith('.html')) out.push(rel);
    }
    return out;
}

/** 量測「捲動中被釘住的元素」總共遮住多少畫面，以及是否有水平溢出。 */
async function measure(page) {
    // 資料驅動頁面要等 JS 渲染完
    await page
        .waitForFunction(
            () => {
                const h = document.body.scrollHeight;
                if (window.__lastH === h) return true;
                window.__lastH = h;
                return false;
            },
            { timeout: 8000, polling: 400 },
        )
        .catch(() => {});

    return page.evaluate(async () => {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const settle = (ms) => new Promise((r) => setTimeout(r, ms));
        const overflowOf = () => {
            const de = document.documentElement;
            return Math.max(de.scrollWidth, document.body.scrollWidth) - vw;
        };
        const wideOf = () => {
            const out = [];
            if (overflowOf() <= 1) return out;
            for (const el of document.querySelectorAll('body *')) {
                const r = el.getBoundingClientRect();
                if (r.right <= vw + 0.5 || r.height <= 0) continue;
                const c = getComputedStyle(el);
                if (c.overflowX === 'auto' || c.overflowX === 'scroll') continue;
                out.push(`${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/)[0] : ''} w=${Math.round(r.width)} right=${Math.round(r.right)}`);
                if (out.length >= 3) break;
            }
            return out;
        };

        // 在多個位置各量一次取最壞值。只量單一位置會漏掉東西：資料驅動的頁面
        // 在 JS 渲染完成前後 scrollHeight 差很多，用 scrollHeight/3 當唯一取樣點
        // 時，learning-portfolio/activity-database 這類頁面會量到「還沒進入釘住
        // 狀態」的位置而顯示為正常——實際上它有跟其他頁一樣的問題。
        const H = document.body.scrollHeight;
        const maxScroll = Math.max(0, H - vh);
        const STEP = 120;

        // 頁面根本捲不動時沒有「捲動中被遮住」這回事，直接回 0。
        // 不這樣做的話會誤判成 100%：scrollTo(target) 與 scrollTo(target + STEP)
        // 都會被夾在同一個位置，於是「捲了卻沒動」的判定對**每一個**元素都成立，
        // 連 1964px 高的 <main> 都會被算成釘住的 chrome。實際踩過，而且因為頁面
        // 高度取決於資料何時渲染完，症狀是時好時壞的 flaky。
        if (maxScroll < STEP + 40) {
            return { pct: 0, covered: 0, chrome: [], overflowX: overflowOf(), wide: wideOf() };
        }

        // 每個取樣點都要留得下 STEP 的捲動空間，否則同樣會夾在邊界。
        const cap = maxScroll - STEP - 10;
        const targets = [...new Set([700, Math.floor(H / 3), Math.floor(H / 2)].map((t) => Math.min(t, cap)))].filter(
            (t) => t > 0,
        );
        let worst = null;
        for (const target of targets) {
            const r = await sampleAt(target);
            if (r === null) continue; // 這一點沒有真的捲動，樣本無效
            if (!worst || r.covered > worst.covered) worst = r;
        }
        return worst || { pct: 0, covered: 0, chrome: [], overflowX: overflowOf(), wide: wideOf() };

        async function sampleAt(target) {
        window.scrollTo(0, target);
        await settle(320);

        const cands = [...document.querySelectorAll('body *')].filter((el) => {
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.height >= 8 && r.width >= 8 && r.bottom > 0 && r.top < vh;
        });
        const before = cands.map((el) => el.getBoundingClientRect().top);

        const yBefore = window.scrollY;
        window.scrollTo(0, target + STEP);
        await settle(320);
        // 真的捲動了才有判斷依據。沒捲動的話所有元素都會「看起來沒動」。
        if (Math.abs(window.scrollY - yBefore) < STEP - 20) return null;
        const after = cands.map((el) => el.getBoundingClientRect().top);

        const pinned = [];
        for (let i = 0; i < cands.length; i++) {
            if (Math.abs(after[i] - before[i]) > 12) continue;
            const r = cands[i].getBoundingClientRect();
            if (r.bottom <= 0 || r.top >= vh) continue;
            pinned.push({ el: cands[i], r });
        }
        const outer = pinned.filter((p) => !pinned.some((q) => q.el !== p.el && q.el.contains(p.el)));

        const bands = outer.map((p) => [Math.max(0, p.r.top), Math.min(vh, p.r.bottom)]).sort((a, b) => a[0] - b[0]);
        let covered = 0, s0 = null, e0 = null;
        for (const [s, e] of bands) {
            if (s0 === null) { s0 = s; e0 = e; continue; }
            if (s <= e0) e0 = Math.max(e0, e);
            else { covered += e0 - s0; s0 = s; e0 = e; }
        }
        if (s0 !== null) covered += e0 - s0;

        const overflowX = overflowOf();
        const wide = wideOf();

        return {
            pct: Math.round((covered / vh) * 100),
            covered: Math.round(covered),
            chrome: outer.map((p) => `${p.el.tagName.toLowerCase()}${typeof p.el.className === 'string' && p.el.className ? '.' + p.el.className.trim().split(/\s+/)[0] : ''} ${Math.round(p.r.height)}px`),
            overflowX,
            wide,
        };
        }
    });
}

// 360x640 是最嚴苛的常見尺寸（iPhone SE、多數舊 Android），過得了這關就過得了 390。
test.describe('版面預算（360x640）', () => {
    test.use({ viewport: { width: 360, height: 640 } });

    const pages = walk(DIST).filter((p) => !p.startsWith('google'));

    // 93 頁 × 每頁兩次捲動量測，會超過設定檔的預設單測逾時。
    test('每一頁的固定 chrome 都不得超過畫面上限，且不得有水平溢出', async ({ page }) => {
        test.setTimeout(300_000);
        expect(pages.length, '找不到建置產物——請先 npm run build:deployable 並 stage 到 .link-root/').toBeGreaterThan(50);

        const overBudget = [];
        const overflowing = [];
        for (const rel of pages) {
            await page.goto(`${BASE}/sch001-108platform/${rel}`, { waitUntil: 'networkidle' });
            const m = await measure(page);
            if (m.pct > CHROME_BUDGET_PCT) overBudget.push(`${rel}  ${m.pct}%（${m.covered}px）  ${m.chrome.join(' + ')}`);
            if (m.overflowX > 1) overflowing.push(`${rel}  +${m.overflowX}px  ${m.wide.join(' / ')}`);
        }

        expect(
            overBudget,
            `以下頁面捲動時被固定 chrome 遮住超過 ${CHROME_BUDGET_PCT}% 的畫面：\n  ${overBudget.join('\n  ')}`,
        ).toEqual([]);
        expect(
            overflowing,
            `以下頁面在 360px 視窗會被撐寬（手機上可以左右晃）：\n  ${overflowing.join('\n  ')}`,
        ).toEqual([]);
    });
});

// 量測會漏，結構性不變式不會。
//
// 實際發生過：我用量測稽核找出「5 個」有問題的頁面並修好，稽核也全綠了——但用
// grep 掃原始碼才發現實際上有 9 個。漏掉的 4 個全是資料驅動頁，它們在量測當下還
// 沒渲染完，捲動目標落在還沒進入釘住狀態的位置。
//
// 這條測試直接對建置產物檢查：凡是釘在站台 header 下方的元素，都必須掛上
// data-autohide-filters。它不依賴渲染時機，新增頁面時也一定會被抓到。
test.describe('結構：釘在 header 下方的面板都必須可讓開', () => {
    const pages = walk(DIST).filter((p) => !p.startsWith('google'));

    test('每個 sticky 面板都掛了 data-autohide-filters', async () => {
        const { readFileSync } = require('node:fs');
        const missing = [];
        for (const rel of pages) {
            const html = readFileSync(path.join(DIST, rel), 'utf8');
            // Tailwind 的 sticky top-[NNpx]，以及編譯後的 position:sticky;top:NNpx
            const tags = html.match(/<(?:div|nav|section|aside|header)\b[^>]*>/g) || [];
            for (const tag of tags) {
                // 只看「無條件釘住」的：有 md:／lg: 這類響應式前綴代表只在桌機釘住，
                // 而桌機垂直空間充足，不是這條規則要管的對象。真的在手機上釘住的話，
                // 上面那個版面預算測試會抓到。
                const isPinnedBelowHeader =
                    /(?<![:\w-])sticky\b/.test(tag) &&
                    /(?<![:\w-])top-\[(\d+)px\]/.test(tag) &&
                    Number(RegExp.$1) > 0;
                if (!isPinnedBelowHeader) continue;
                if (tag.includes('data-autohide-filters')) continue;
                missing.push(`${rel}  ${tag.slice(0, 110)}`);
            }
        }
        expect(
            missing,
            '以下元素釘在 header 下方卻沒有 data-autohide-filters，手機上會把畫面吃掉：\n  ' + missing.join('\n  '),
        ).toEqual([]);
    });
});

// 讓開畫面只是一半；另一半是「使用者要用的時候拿得回來」。這幾條沒有通過的話，
// 上面那個預算測試會是綠的，但篩選功能實際上被藏起來了。
test.describe('篩選面板的還原行為（360x640）', () => {
    test.use({ viewport: { width: 360, height: 640 } });

    const URL = `${BASE}/sch001-108platform/advanced-resources/competitions.html`;

    /** 面板目前是否露出在畫面上 */
    const visible = (page) =>
        page.evaluate(() => {
            const el = document.querySelector('[data-autohide-filters]');
            const r = el.getBoundingClientRect();
            return r.bottom > 8 && r.top < window.innerHeight;
        });

    async function scrollBy(page, dy) {
        await page.evaluate((d) => window.scrollBy(0, d), dy);
        await page.waitForTimeout(420);
    }

    test('向下捲動時讓開，向上捲動時立刻回來', async ({ page }) => {
        await page.goto(URL, { waitUntil: 'networkidle' });
        await page.locator('.comp-card').first().waitFor();

        await scrollBy(page, 1200);
        await scrollBy(page, 300);
        expect(await visible(page), '向下捲動後面板應讓開畫面').toBe(false);

        await scrollBy(page, -300);
        expect(await visible(page), '向上捲動後面板必須立刻回來').toBe(true);
    });

    test('回到頁面頂端一定看得到面板', async ({ page }) => {
        await page.goto(URL, { waitUntil: 'networkidle' });
        await page.locator('.comp-card').first().waitFor();

        await scrollBy(page, 1500);
        await scrollBy(page, 300);
        expect(await visible(page)).toBe(false);

        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(420);
        expect(await visible(page), '回到頂端時面板必須露出').toBe(true);
    });

    test('鍵盤焦點進入面板時必須現身，否則焦點會停在畫面外', async ({ page }) => {
        await page.goto(URL, { waitUntil: 'networkidle' });
        await page.locator('.comp-card').first().waitFor();

        await scrollBy(page, 1500);
        await scrollBy(page, 300);
        expect(await visible(page)).toBe(false);

        await page.evaluate(() => document.getElementById('search-input').focus());
        await page.waitForTimeout(300);
        expect(await visible(page), '面板內的元素取得焦點時，面板必須回到畫面上').toBe(true);
    });

    test('桌機寬度不套用（垂直空間充足，不需要讓開）', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(URL, { waitUntil: 'networkidle' });
        await page.locator('.comp-card').first().waitFor();

        await scrollBy(page, 1200);
        await scrollBy(page, 300);
        expect(await visible(page), '桌機上面板應維持釘住').toBe(true);
    });
});
