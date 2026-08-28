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

// 模組層級走訪一次，底下兩個 describe 共用同一份清單。
// sort() 讓測試順序（以及報告裡的順序）不受檔案系統回傳順序影響——沒有它的話，
// 同一份建置產物在不同機器上會產生順序不同的測試清單。
// google 開頭的是搜尋引擎的網站驗證檔，不是本站頁面。
const PAGES = walk(DIST)
    .filter((p) => !p.startsWith('google'))
    .sort();

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
        // 這段量測依賴 prefers-reduced-motion（見底下 describe 的 test.use）。
        // 偏好被拿掉的話 sticky-filters.js 會把 transition 設回 .22s，面板在第二個
        // frame 只移動了一部分，於是不會被判定成「捲動時沒動」的釘住 chrome——量出來
        // 的數字會偏低，而且不會有任何錯誤訊息。寧可在這裡大聲失敗。
        if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
            throw new Error(
                '量測需要 prefers-reduced-motion: reduce，否則面板的 .22s 位移動畫會讓遮蔽比例被低估',
            );
        }

        const vh = window.innerHeight;
        const vw = window.innerWidth;

        // 捲動一律用 behavior:'instant'，並用「兩個 animation frame」取代固定 sleep。
        //
        // 為什麼不能用 scrollTo(0, y)：BaseLayout 在 <html> 上掛了 Tailwind 的
        // scroll-smooth，而那個兩參數形式等同 behavior:'auto'，會照 CSS 走平滑捲動
        // 動畫。實測（360x640、reduce 偏好）捲到 700：兩個 frame 後只到 2px，就算等滿
        // 320ms 也才 614px——舊版的固定 sleep 一直是在動畫途中量的。Chromium 不會因為
        // reduce 偏好就關掉平滑捲動（全站只有 civic-tech-map 自己寫了
        // scroll-behavior:auto，實測也只有它會落定）。真實使用者用手指或滾輪捲動本來
        // 就不走這段動畫，所以 instant 反而更接近實際情形，取樣位置也變成確定值。
        //
        // 捲動瞬間完成之後，兩個 frame 就足夠：
        //   frame 1 —— scroll 事件在這一格派送，sticky-filters.js 的 onScroll 會把
        //              onFrame 排進同一格的 rAF 佇列並套上 transform（reduce 偏好下
        //              transition 是 none，所以立即生效）
        //   frame 2 —— 樣式與 layout 落定，量到的是最終位置
        //
        // 實測 10 個有釘住面板的頁面，改前改後的 pct／covered／overflow 完全相同，
        // 三個取樣點也都仍然有效，單頁量測從約 1990ms 降到約 220ms。
        const jumpTo = (y) => window.scrollTo({ top: y, behavior: 'instant' });
        // 三個 frame，不是兩個。實測（competitions.html、360x640、reduce）捲動之後，
        // 面板的 transform 是在**第 2 個** frame 才套上去的：
        //
        //   scrollTo 當下   transform: none      top=68    ← 面板整片還在畫面上
        //   第 1 個 frame   transform: none      top=68
        //   第 2 個 frame   translateY(-409px)   top=-341  ← 這裡才生效
        //
        // 因為 sticky-filters.js 的 onScroll 是在 scroll 事件裡「再排一個 rAF」。兩個
        // frame 剛好夠，但餘裕只有「同一個 frame 內 callback 的先後順序」：sticky 的
        // rAF 在 frame 1 的 scroll 事件中註冊，我們的第二個 rAF 在 frame 1 的 callback
        // 中註冊，所以前者排在前面。任何人在那條鏈上多加一層 rAF，兩個 frame 就會在
        // 面板還在畫面上時取值——而且是**靜默地綠**（遮蔽比例被低估）。第三個 frame
        // 把餘裕變成一整個 frame，代價是每次取樣多約 16ms。
        const settle = () =>
            new Promise((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            });
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
        jumpTo(target);
        await settle();

        const cands = [...document.querySelectorAll('body *')].filter((el) => {
            const cs = getComputedStyle(el);
            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.height >= 8 && r.width >= 8 && r.bottom > 0 && r.top < vh;
        });
        const before = cands.map((el) => el.getBoundingClientRect().top);

        const yBefore = window.scrollY;
        jumpTo(target + STEP);
        await settle();
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
//
// 每一頁各自是一個 test，而不是一個 test 跑 93 頁的迴圈。Playwright 的平行單位是
// test，迴圈內部不會被拆給不同 worker——原本這 93 頁全部序列跑在單一 worker 上，
// 其他 worker 只能空等它跑完。拆開之後另外還有四個好處：
//   1. 失敗的頁面有自己的測試名稱，不必從一整串 aggregate 訊息裡找
//   2. CI 的 retries: 1 只重試壞掉的那一頁，而不是整批 93 頁重跑
//   3. report 直接看得出哪一頁最慢
//   4. 多頁同時壞掉時仍然全部列出——每一頁各自是一個失敗的 test
test.describe('版面預算（360x640）', () => {
    // 這一組刻意跑在「減少動態」偏好下：面板在 reduce 下仍然讓開畫面，只是不做動畫
    // （見 public/shared/sticky-filters.js 的 applyTransition，transition 會被設成
    // none）。所以這不放寬被測的行為，只是把那段 .22s 的位移動畫拿掉，量測才能在幾個
    // animation frame 之後就取值。
    //
    // 必須寫成 contextOptions.reducedMotion，不可以直接寫 reducedMotion。Playwright
    // 1.56.1 註冊成 test option 的只有 colorScheme／contextOptions／locale／viewport
    // 這幾個（見 node_modules/playwright/lib/index.js），**沒有 reducedMotion**——直接
    // 寫會是一個沒人認得的鍵，被安靜丟掉。實測：同一個 test.use 物件裡 viewport 生效、
    // reducedMotion 不生效，頁面裡的 matchMedia 仍回報 no-preference；改成
    // contextOptions.reducedMotion 之後就是 true。
    //
    // 這個坑很深：偏好沒生效的話，面板位移會是一段 .22s 的動畫，量測在最後一個 frame
    // 只看到它移動了一點點，於是「捲動時位置沒動」不成立，面板**不會**被算成釘住的
    // chrome——遮蔽比例被低估，而測試全綠。measure() 裡那條 matchMedia 斷言就是在守
    // 這件事；本次改動第一次跑，正是它把無效設定抓出來的。
    test.use({
        viewport: { width: 360, height: 640 },
        contextOptions: { reducedMotion: 'reduce' },
    });

    // 設定檔的預設單測逾時是 20s，對單頁不夠：goto 用 networkidle，而每一頁都會載入
    // GoatCounter（gc.zgo.at）這個外部 script，networkidle 必須等它有結果才算安靜。
    //
    // 90s 不是拍腦袋：本機 4 個 worker 實測單頁中位數約 1.6s、最慢 3.8s，但 worker 互相
    // 搶 CPU 時，同一頁曾經跑到 20.2s（單獨跑只要 2.2s）。CI 只有 2 個 worker，餘裕要
    // 留夠。它仍然是真正的上限——卡住的頁面 90s 就失敗，而且只有它自己會被重試，不像
    // 原本會拖著整批 93 頁。
    //
    // 注意 measure() 裡那個 waitForFunction **不是**「最多 8 秒的渲染穩定等待」：實測
    // Playwright 只呼叫述詞兩次、相隔約 14ms（polling: 400 不影響次數），所以它實際上
    // 只是一次很短的抽樣。真正的 readiness 契約是下一階段的事（data-site-ready），
    // 那時 networkidle 與這個述詞會一起被換掉。
    test.describe.configure({ timeout: 90_000 });

    // 沒有這一條的話，PAGES 是空陣列時上面的迴圈一個 test 都產生不出來，整個檔案會以
    // 「全綠」收場——那正是這種測試最該防的假象。
    //
    // 門檻是 85 而不是 50：實測目前有 93 頁，用 50 當底線的話，光是
    // career-exploration/clusters/** 就可以少掉 42 頁（全站約 45%）而測試全綠、沒有
    // 任何訊號。實測把 42 頁移走後仍然是 57 passed、EXIT=0。日後真的刪頁而讓這條紅
    // 起來時，請連同這個數字一起更新。
    test('建置產物有被 stage 進來', () => {
        expect(
            PAGES.length,
            `只找到 ${PAGES.length} 頁建置產物。請先 npm run build:deployable 並 stage 到 ` +
                '.link-root/；若確實刪了頁面，請一併更新這裡的門檻。',
        ).toBeGreaterThan(85);
    });

    for (const rel of PAGES) {
        test(`${rel}：固定 chrome 與水平溢出`, async ({ page }) => {
            const res = await page.goto(`${BASE}/sch001-108platform/${rel}`, { waitUntil: 'networkidle' });

            // 一定要驗回應狀態。少了這一條，整批 93 頁對著一個全部回 404 的伺服器也會
            // 全綠：404 頁面捲不動，measure() 的「捲不動就回 0」短路直接給出 pct 0，
            // 而 matchMedia 斷言在錯誤頁上一樣成立。實測把 SITE_BASE_URL 指到不存在的
            // 路徑，加這條之前是 94 passed、EXIT=0。
            expect(res, `${rel}：goto 沒有回傳回應`).toBeTruthy();
            expect(res.status(), `${rel}：伺服器回 HTTP ${res.status()}`).toBeLessThan(400);

            const m = await measure(page);

            // 用 soft：同一頁兩種問題都發生時要兩條都列出來。原本的 aggregate 版本
            // 是兩份清單各自 expect，兩種問題都看得到；一般的 expect 會在第一條就
            // 中斷，那會少掉一半診斷。
            expect
                .soft(m.pct, `${rel}  ${m.pct}%（${m.covered}px）  ${m.chrome.join(' + ')}`)
                .toBeLessThanOrEqual(CHROME_BUDGET_PCT);

            expect
                .soft(m.overflowX, `${rel}  +${m.overflowX}px  ${m.wide.join(' / ')}`)
                .toBeLessThanOrEqual(1);
        });
    }
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
    test('每個 sticky 面板都掛了 data-autohide-filters', async () => {
        const { readFileSync } = require('node:fs');
        const missing = [];
        for (const rel of PAGES) {
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
