/**
 * 部署產物的瀏覽器 smoke test
 * --------------------------------------------------------------
 * scripts/check-built-site.mjs 是靜態分析：它能證明「這個 URL 指得到東西」，但
 * 證明不了「頁面在瀏覽器裡真的跑得起來」。競賽頁與資源頁都是資料驅動的——瀏覽器
 * 先 fetch() JSON 再渲染卡片。JSON 若壞掉、被改名、或前端 JS 丟例外，靜態檢查
 * 全綠、build 成功，使用者卻只看到一個空白容器或「載入失敗」。
 *
 * 這支測試就是補那一段：在真的瀏覽器裡開頁面，等資料渲染出來，並且不接受任何
 * console error、pageerror 或失敗的網路請求。
 *
 * 前置：dist/ 已 build 並 stage 到 .link-root/sch001-108platform/
 *      （見 ci.yml 的 Stage GitHub Pages path namespace）
 */
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const P = (p) => `${BASE}/sch001-108platform${p}`;

/** 掛上錯誤蒐集器。回傳一個取得目前錯誤清單的函式。 */
function watchForErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
    });
    page.on('requestfailed', (r) => {
        // 只在乎本站資源；外部第三方（Puter CDN、字型）在離線的 CI 上失敗是預期的
        if (r.url().startsWith(BASE)) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
    });
    page.on('response', (r) => {
        if (r.url().startsWith(BASE) && r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
    });
    return () => errors;
}

test.describe('部署產物 smoke test', () => {
    test('首頁載入且無錯誤', async ({ page }) => {
        const errors = watchForErrors(page);
        await page.goto(P('/'), { waitUntil: 'networkidle' });
        await expect(page.locator('main#main-content')).toBeVisible();
        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('競賽頁真的把資料渲染出來，而不是停在載入中', async ({ page }) => {
        const errors = watchForErrors(page);
        await page.goto(P('/advanced-resources/competitions.html'), { waitUntil: 'networkidle' });

        // 這是重點：卡片是 fetch() 回來之後才由 JS 產生的。靜態檢查看不到這一步。
        const cards = page.locator('.comp-card');
        await expect(cards.first()).toBeVisible({ timeout: 10_000 });
        expect(await cards.count()).toBeGreaterThan(50);

        // 每張卡都必須有狀態文字——空字串代表狀態機算出了未預期的 key
        const statuses = await page.locator('.comp-card .comp-status').allTextContents();
        expect(statuses.length).toBe(await cards.count());
        for (const s of statuses) expect(s.trim()).not.toBe('');

        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('競賽頁的狀態篩選都篩得出東西（chip 與狀態 key 沒有脫節）', async ({ page }) => {
        await page.goto(P('/advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        await expect(page.locator('.comp-card').first()).toBeVisible({ timeout: 10_000 });
        const total = await page.locator('.comp-card').count();

        const chips = page.locator('.comp-chip[data-status]');
        const n = await chips.count();
        expect(n).toBeGreaterThan(3);

        let sum = 0;
        for (let i = 0; i < n; i++) {
            const chip = chips.nth(i);
            const key = await chip.getAttribute('data-status');
            await chip.click();
            const shown = await page.locator('.comp-card').count();
            if (key !== 'all') sum += shown;
        }
        // 各狀態相加不得超過總數；也不得是 0（0 代表所有 chip 都篩不到東西）
        expect(sum).toBeGreaterThan(0);
        expect(sum).toBeLessThanOrEqual(total);
    });

    test('資料 JSON 直接開得起來且結構正確', async ({ request }) => {
        const res = await request.get(P('/advanced-resources/competitions.json'));
        expect(res.status()).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data.competitions)).toBe(true);
        expect(data.competitions.length).toBeGreaterThan(50);
    });

    test('搜尋索引開得起來且不是空的', async ({ request }) => {
        const res = await request.get(P('/search-index.json'));
        expect(res.status()).toBe(200);
        const data = await res.json();
        const items = Array.isArray(data) ? data : data.items || data.documents;
        expect(Array.isArray(items)).toBe(true);
        expect(items.length).toBeGreaterThan(0);
    });
});

/**
 * #14 的驗收標準：搜尋 A2／系統思考／環保／SDG 要找得到對應的公民科技專案。
 * --------------------------------------------------------------
 * 這幾條刻意在真的瀏覽器裡打字驗證，而不是拿 search-index.json 做字串比對。
 * 索引裡「有那個欄位」和「使用者打進去搜得到」之間隔著 Fuse 的 keys 權重與
 * threshold——只驗前者的話，把 keys 改壞、把 threshold 調到 0.1，測試照樣全綠。
 *
 * 同時驗證兩件靜態檢查看不到的事：
 *   1. 搜尋結果的錨點真的能跳到那個專案（#78 的壞錨點就是點了停在頁首）
 *   2. 分類標籤是用 textContent 塞進去的，不是 innerHTML
 */
test.describe('站內搜尋的素養／SDGs 分類（#14 驗收）', () => {
    /** 開首頁並等到搜尋引擎就緒（索引 fetch 回來、Fuse 初始化完才會解除 disabled）。 */
    async function openHome(page) {
        await page.goto(P('/'), { waitUntil: 'networkidle' });
        const input = page.locator('#search-input');
        await expect(input).toBeEnabled({ timeout: 15_000 });
        return input;
    }

    /** 打進關鍵字，回傳結果清單的 locator。 */
    async function searchFor(page, query) {
        const input = await openHome(page);
        await input.fill(query);
        const results = page.locator('#search-results-container a[role="option"]');
        await expect(results.first()).toBeVisible({ timeout: 10_000 });
        return results;
    }

    // 素養類查詢：命中的不只公民科技專案，「未來生涯GPS」的學群卡片也標了同一個
    // 素養（它的來源資料寫的是中文名，建索引時被正規化成代碼）。這裡驗的是
    // 精確度——整份結果清單都必須真的帶有那個素養標籤，而不是模糊比對撈進來的
    // 雜訊；同時公民科技專案必須在其中。只驗「第一筆是誰」擋不住 threshold 被
    // 調鬆之後撈進一堆無關項目。
    for (const { query, why, label } of [
        { query: 'A2', why: '核心素養代碼', label: 'A2 系統思考與解決問題' },
        { query: '系統思考', why: '素養的中文標籤', label: 'A2 系統思考與解決問題' },
    ]) {
        test(`搜尋「${query}」（${why}）命中的每一筆都真的標了該素養`, async ({ page }) => {
            const errors = watchForErrors(page);
            const results = await searchFor(page, query);

            const count = await results.count();
            expect(count).toBeGreaterThan(0);

            const chipSets = await results.evaluateAll((els) =>
                els.map((el) => [...el.querySelectorAll('span')].map((s) => s.textContent.trim())),
            );
            for (const chips of chipSets) {
                expect(chips, `搜尋「${query}」有一筆結果沒有標「${label}」：${chips.join(' / ')}`).toContain(label);
            }

            const hrefs = await results.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
            expect(
                hrefs.filter((h) => h.includes('civic-tech-map/index.html#')).length,
                `搜尋「${query}」的結果：${hrefs.join(', ')}`,
            ).toBeGreaterThan(0);

            expect(errors(), errors().join('\n')).toEqual([]);
        });
    }

    // 議題關鍵字與 SDGs：這兩個查詢只有公民科技專案帶有對應標籤，所以要求更嚴——
    // 第一筆就必須是公民科技專案。issue 要的是「權重較高地顯示」，只要「出現在
    // 某個位置」是不夠的。
    for (const { query, why } of [
        { query: '環保', why: '議題關鍵字' },
        { query: 'SDG', why: 'SDGs' },
    ]) {
        test(`搜尋「${query}」（${why}）第一筆就是公民科技專案`, async ({ page }) => {
            const errors = watchForErrors(page);
            const results = await searchFor(page, query);

            expect(await results.count()).toBeGreaterThan(0);
            const firstHref = await results.first().getAttribute('href');
            expect(firstHref, `搜尋「${query}」的第一筆是 ${firstHref}`).toContain('civic-tech-map/index.html#');

            expect(errors(), errors().join('\n')).toEqual([]);
        });
    }

    test('素養代碼命中時會說明是「核心素養」命中的', async ({ page }) => {
        const results = await searchFor(page, 'A2');
        const summary = await results.first().locator('p').last().textContent();
        expect(summary).toContain('核心素養');
        expect(summary).toContain('A2');
    });

    test('分類標籤走 textContent，不會被當成 HTML 解析', async ({ page }) => {
        const results = await searchFor(page, 'SDG');
        const chips = results.first().locator('span');
        expect(await chips.count()).toBeGreaterThan(0);
        // textContent 塞進去的節點不可能有子元素；若哪天改成 innerHTML，
        // 標籤裡只要出現一個 < 就會長出子節點，這一條會紅。
        const childCounts = await chips.evaluateAll((els) => els.map((el) => el.childElementCount));
        expect(childCounts.every((n) => n === 0)).toBe(true);
        const texts = await chips.allTextContents();
        expect(texts.some((t) => t.startsWith('SDG '))).toBe(true);
    });

    test('點搜尋結果會跳到該專案，而不是停在頁首', async ({ page }) => {
        const errors = watchForErrors(page);
        const results = await searchFor(page, '假訊息');
        const href = await results.first().getAttribute('href');
        expect(href).toContain('#');
        const anchor = href.split('#')[1];

        await results.first().click();
        await page.waitForURL(new RegExp(`#${anchor}$`), { timeout: 10_000 });
        // 錨點必須真的存在於頁面上，否則瀏覽器只會停在頁首而不報任何錯
        await expect(page.locator(`#${anchor}`)).toBeVisible();
        expect(errors(), errors().join('\n')).toEqual([]);
    });
});

/**
 * 自架的第三方函式庫（#72 後續）
 * --------------------------------------------------------------
 * 本站原本有四個 runtime CDN 依賴且全都沒有 SRI：fuse.js（搜尋引擎，載不到就整個
 * 搜尋失效）、feather-icons、ionicons。第三方網域的可用性直接決定本站功能能不能用，
 * 而且沒有任何建置期檢查會發現它們掛掉——CDN 壞掉時 build 綠、check:site 綠，
 * 使用者打開才發現搜尋框永遠停在「載入中」。
 *
 * check:site 已經會擋下「vendor 檔案不見」（script[src] 解析不到就紅）。這裡補的是
 * 靜態檢查看不到的兩件事：函式庫在瀏覽器裡真的能用，以及沒有偷偷留下 CDN 請求。
 */
test.describe('自架的第三方函式庫', () => {
    /** 攔截所有對外請求，回傳取得清單的函式。 */
    function watchThirdParty(page) {
        const hits = [];
        page.on('request', (r) => {
            const u = r.url();
            if (/unpkg\.com|cdn\.jsdelivr\.net/.test(u)) hits.push(u);
        });
        return () => hits;
    }

    test('首頁的搜尋引擎來自本站，不是 CDN', async ({ page }) => {
        const cdn = watchThirdParty(page);
        await page.goto(P('/'), { waitUntil: 'networkidle' });

        // Fuse 真的載進來且可用——搜尋框解除 disabled 就代表索引與 Fuse 都就緒
        await expect(page.locator('#search-input')).toBeEnabled({ timeout: 15_000 });
        expect(await page.evaluate(() => typeof window.Fuse)).toBe('function');

        expect(cdn(), `仍有 CDN 請求：${cdn().join(', ')}`).toEqual([]);
    });

    test('生涯探索頁的 ionicons 真的渲染出 SVG', async ({ page }) => {
        const cdn = watchThirdParty(page);
        const errors = watchForErrors(page);
        await page.goto(P('/career-exploration/index.html'), { waitUntil: 'networkidle' });

        // ion-icon 是 web component，載入成功後會在 shadow DOM 裡放一個 <svg>。
        // 找不到 SVG 時它不會報錯，只是不顯示——所以要直接檢查 shadow DOM。
        await page.waitForFunction(
            () => {
                const els = [...document.querySelectorAll('ion-icon')];
                return els.length > 0 && els.every((e) => e.shadowRoot && e.shadowRoot.querySelector('svg'));
            },
            { timeout: 15_000 },
        );
        const n = await page.locator('ion-icon').count();
        expect(n).toBeGreaterThan(5);

        expect(cdn(), `仍有 CDN 請求：${cdn().join(', ')}`).toEqual([]);
        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('素養地圖的 feather icons 真的被替換成 SVG', async ({ page }) => {
        const cdn = watchThirdParty(page);
        await page.goto(P('/career-exploration/competency-map.html'), { waitUntil: 'networkidle' });

        // feather.replace() 會把 <i data-feather> 換成 <svg class="feather">。
        // 沒被換掉代表 feather.min.js 沒載到或沒執行。
        await page.waitForFunction(() => document.querySelectorAll('svg.feather').length > 0, { timeout: 15_000 });
        expect(await page.locator('svg.feather').count()).toBeGreaterThan(2);

        expect(cdn(), `仍有 CDN 請求：${cdn().join(', ')}`).toEqual([]);
    });
});

/**
 * 字型契約
 * --------------------------------------------------------------
 * 這個檔案要擋的是一種特別陰險的失效：**字型載入失敗時，頁面照樣渲染**。
 * 瀏覽器會安靜地退回系統字型，畫面看起來「差不多」，Playwright 全綠，
 * 傳輸位元組還會**變少**——看起來像優化成功，實際上是資產壞掉。
 * 只驗「有沒有發出請求」或「位元組多少」的檢查，在這種情況下會印綠字。
 *
 * 所以這裡不看宣告、也不看位元組，直接用 CDP 的 CSS.getPlatformFontsForNode
 * 問瀏覽器：「你剛剛實際上是用哪一個字型把這些字畫出來的？」
 * 回傳的 isCustomFont 會區分「@font-face 載進來的」與「系統既有的」。
 *
 * 三條契約：
 *   1. 拉丁字必須由自架的 Inter（isCustomFont=true）畫出來——證明 woff2 真的載到且生效
 *   2. 漢字**不得**由任何 webfont 畫出來——這是本次改動的核心：漢字走系統字型，
 *      不再下載 1.2MB 的 CJK webfont。哪天有人把 CJK webfont 加回來，這條會紅
 *   3. 全站不得再對 fonts.googleapis.com / fonts.gstatic.com 發出任何請求
 *
 * 刻意**不**斷言漢字用的是哪一個具體字型：那取決於執行環境
 * （Windows=Microsoft JhengHei、macOS=PingFang TC、Linux CI 可能什麼都沒有）。
 * 斷言「不是 webfont」在每個平台上都成立，而且正是我們要釘住的性質。
 */
test.describe('字型契約', () => {
    /** 取得某個元素實際使用的平台字型（CDP，僅 Chromium）。 */
    async function platformFontsOf(page, selector) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const doc = await cdp.send('DOM.getDocument', { depth: -1 });
        const q = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
        expect(q.nodeId, `找不到選擇器 ${selector}`).toBeTruthy();
        const res = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: q.nodeId });
        await cdp.detach();
        return res.fonts;
    }

    test('拉丁字真的是用自架的 Inter 畫出來的（不是安靜退回系統字型）', async ({ page }) => {
        await page.goto(P('/'), { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);

        // 先問瀏覽器「Inter 這個 face 有沒有真的可用」
        expect(await page.evaluate(() => document.fonts.check('16px Inter')), 'document.fonts.check 說 Inter 不可用').toBe(true);

        // 再問「實際畫圖時用了誰」——這才是無法被 fallback 蒙混過去的那一問
        await page.evaluate(() => {
            const s = document.createElement('span');
            s.id = 'font-probe-latin';
            s.textContent = 'Latin probe ABCdef 12345';
            document.querySelector('main#main-content').appendChild(s);
            s.getBoundingClientRect();
        });
        await page.waitForTimeout(300);
        const fonts = await platformFontsOf(page, '#font-probe-latin');
        const inter = fonts.find((f) => /Inter/i.test(f.familyName) && f.isCustomFont);
        expect(
            inter,
            `拉丁字沒有用自架 Inter 畫出來，實際用了：${JSON.stringify(fonts)}。` +
                'woff2 沒載到、路徑錯、或 @font-face 沒生效時就會這樣——而頁面看起來完全正常。',
        ).toBeTruthy();
        expect(inter.glyphCount, 'Inter 被列出但沒有畫出任何字符').toBeGreaterThan(0);
    });

    test('漢字走系統字型，不得由任何 webfont 畫出來', async ({ page }) => {
        await page.goto(P('/'), { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => {
            const s = document.createElement('span');
            s.id = 'font-probe-han';
            s.textContent = '學習歷程課綱探索';
            document.querySelector('main#main-content').appendChild(s);
            s.getBoundingClientRect();
        });
        await page.waitForTimeout(300);
        const fonts = await platformFontsOf(page, '#font-probe-han');
        const custom = fonts.filter((f) => f.isCustomFont);
        expect(
            custom,
            `漢字被 webfont 畫出來了：${JSON.stringify(custom)}。` +
                '本站刻意讓漢字使用裝置既有字型——CJK webfont 是每頁 1.2MB 的成本。',
        ).toEqual([]);
    });

    test('全站不再對第三方字型主機發出請求', async ({ page }) => {
        const hits = [];
        page.on('request', (r) => {
            if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(r.url())) hits.push(r.url());
        });
        for (const p of ['/', '/advanced-resources/competitions.html', '/career-exploration/clusters/info/']) {
            await page.goto(P(p), { waitUntil: 'networkidle' });
            await page.evaluate(() => document.fonts.ready);
        }
        expect(hits, `仍有第三方字型請求：${hits.join(', ')}`).toEqual([]);
    });

    test('沒有殘留指向字型主機的 preconnect（開了連線卻沒人用）', async ({ page }) => {
        await page.goto(P('/'), { waitUntil: 'domcontentloaded' });
        const hints = await page.$$eval('link[rel~="preconnect"], link[rel~="dns-prefetch"]', (els) =>
            els.map((e) => e.getAttribute('href') || ''),
        );
        expect(hints.filter((h) => /fonts\.(googleapis|gstatic)\.com/.test(h))).toEqual([]);
    });

    test('自架的 woff2 真的取得到（不是 404 之後安靜退回系統字型）', async ({ request }) => {
        for (const f of ['Inter-subset.woff2', 'SpaceMono-400.woff2', 'SpaceMono-700.woff2']) {
            const r = await request.get(`${BASE}/sch001-108platform/fonts/${f}`);
            expect(r.status(), `${f} 取不到`).toBe(200);
            const buf = await r.body();
            expect(buf.length, `${f} 太小，可能不是真的字型檔`).toBeGreaterThan(5000);
            // woff2 的 magic number 是 'wOF2'
            expect(buf.subarray(0, 4).toString('latin1'), `${f} 不是 woff2`).toBe('wOF2');
        }
    });

    test('競賽頁的 Space Mono 真的生效', async ({ page }) => {
        await page.goto(P('/advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        await page.locator('.comp-card').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        const fonts = await platformFontsOf(page, '.stat-num');
        expect(
            fonts.find((f) => /Space Mono/i.test(f.familyName) && f.isCustomFont),
            `.stat-num 沒有用 Space Mono 畫出來，實際用了：${JSON.stringify(fonts)}`,
        ).toBeTruthy();
    });

    /**
     * 漢字改走系統字型之後，「不是 webfont」已經被上面那條釘住了，但那條**擋不住
     * 品質退化**：把堆疊改成 'Microsoft YaHei', 'PingFang SC'（簡體字形），或是把
     * 繁中字型整段刪掉只留 sans-serif，上面 6 條會**全部通過**——實際做過故障注入，
     * 兩種情況都是 6 passed。
     *
     * 對台灣讀者來說，簡體字形的繁體字（骨／直／內／過／起 等字的字形差異）是看得
     * 出來的品質問題。所以這裡改用「靜態檢查算出來的堆疊」而不是「實際命中的字型」：
     *   - 實際命中哪一個字型取決於執行環境（CI 的 ubuntu runner 沒有任何繁中字型），
     *     拿它來斷言必然是 flaky 的。
     *   - 堆疊本身是我們寫的、每個平台都一樣，是可以確定性斷言的東西。
     *
     * 順帶釘住第二件事：body 的字型堆疊在 global.css 之外還被 20 個頁面各自
     * 重複宣告一次。改了 global.css 卻漏改那 20 份，頁面會安靜地留在舊堆疊——
     * 所以下面刻意挑幾個「有覆寫」的頁面一起驗，讓漂移會紅。
     */
    test('漢字堆疊必須偏好繁體字形，且 20 份重複宣告不得與 global.css 漂移', async ({ page }) => {
        // 繁中字形：台灣讀者預期看到的
        const TC = [
            'PingFang TC',
            'Microsoft JhengHei UI',
            'Microsoft JhengHei',
            'Noto Sans TC',
            'Noto Sans CJK TC',
            'Source Han Sans TC',
            'Source Han Sans TW',
        ];
        // 簡中字形：出現在繁中字型「之前」就會讓台灣讀者看到簡體字形
        const SC = [
            'PingFang SC',
            'Microsoft YaHei',
            'Microsoft YaHei UI',
            'Noto Sans SC',
            'Noto Sans CJK SC',
            'Source Han Sans SC',
            'Source Han Sans CN',
            'SimHei',
            'SimSun',
            'Heiti SC',
            'STHeiti',
        ];

        // '/' 走 global.css；其餘三頁各自有一份重複的 body { font-family }
        const PAGES = ['/', '/about.html', '/civic-tech-map/index.html', '/sitemap.html'];
        const seen = new Map();

        for (const p of PAGES) {
            await page.goto(P(p), { waitUntil: 'domcontentloaded' });

            // lang 在這個改動之後才變成「排版正確性」的相依項：以前漢字一律由
            // Noto Sans TC webfont 畫，繁簡字形與 lang 無關；現在漢字交給系統字型，
            // 一旦堆疊裡的繁中字型在該裝置上都不存在，落到通用 sans-serif 時是繁是簡
            // 就完全由瀏覽器的 Han script 推斷決定。Blink 的 ComputeScriptForHan()
            // 在推斷不出來時**預設簡體**，於是 lang 少一個或被改成 "zh"，
            // 台灣讀者就會看到簡體字形。
            const lang = await page.evaluate(() => document.documentElement.lang);
            expect(
                lang,
                `${p} 的 <html lang> 是「${lang}」。漢字改用系統字型後，lang 是繁簡字形的最後一道` +
                    '防線（Blink 推斷不出 Han script 時預設簡體），必須是 zh-Hant。',
            ).toBe('zh-Hant');

            const families = await page.evaluate(() =>
                getComputedStyle(document.body)
                    .fontFamily.split(',')
                    .map((s) => s.trim().replace(/^['"]|['"]$/g, '')),
            );
            seen.set(p, families.join(', '));

            const firstTC = families.findIndex((f) => TC.includes(f));
            const firstSC = families.findIndex((f) => SC.includes(f));

            expect(
                firstTC,
                `${p} 的 body 字型堆疊裡沒有任何繁體中文字型，漢字會落到瀏覽器的通用 ` +
                    `fallback，字形正確與否完全看使用者的作業系統。實際堆疊：${families.join(', ')}`,
            ).toBeGreaterThanOrEqual(0);

            if (firstSC >= 0) {
                expect(
                    firstSC,
                    `${p} 的堆疊把簡體中文字型「${families[firstSC]}」排在繁體字型 ` +
                        `「${families[firstTC]}」之前，台灣讀者會看到簡體字形的繁體字` +
                        `（骨／直／內／過／起 等字的字形差異）。實際堆疊：${families.join(', ')}`,
                ).toBeGreaterThan(firstTC);
            }

            expect(
                families[families.length - 1],
                `${p} 的堆疊結尾不是通用 sans-serif —— 全部落空時沒有最後的保底。` +
                    `實際堆疊：${families.join(', ')}`,
            ).toBe('sans-serif');
        }

        // 四頁算出來的堆疊必須完全一致；不一致代表 global.css 與頁內覆寫已經漂移
        const distinct = [...new Set(seen.values())];
        expect(
            distinct.length,
            '不同頁面算出來的 body 字型堆疊不一致，代表 global.css 與頁內重複宣告已經漂移：\n' +
                [...seen].map(([p, v]) => `  ${p}\n    ${v}`).join('\n'),
        ).toBe(1);
    });
});

/**
 * 搜尋框的無障礙契約（WCAG 4.1.2 A 級 / 4.1.3 AA 級）
 * --------------------------------------------------------------
 * 這兩條都是實測抓到的既有失敗，不是假想情境：
 *
 *   按 ArrowDown 之後 aria-activedescendant = null，9 個選項全部沒有 id
 *     → 焦點留在輸入框的 combobox 模式下，螢幕閱讀器使用者用方向鍵瀏覽時
 *       完全聽不到任何回饋。WCAG 4.1.2（A 級）失敗。
 *
 *   全頁沒有任何 aria-live / role=status
 *     → 打完字之後不會知道有沒有結果、有幾筆。WCAG 4.1.3（AA 級）失敗。
 *
 * 這兩件事在畫面上完全看不出來——視覺使用者一切正常。只有實際查 DOM 才會發現，
 * 所以必須有測試釘住。
 */
test.describe('搜尋框的無障礙契約', () => {
    async function openAndSearch(page, query) {
        await page.goto(P('/'), { waitUntil: 'networkidle' });
        const input = page.locator('#search-input');
        await expect(input).toBeEnabled({ timeout: 15_000 });
        await input.fill(query);
        return input;
    }

    test('方向鍵瀏覽時 aria-activedescendant 必須指向實際存在的選項', async ({ page }) => {
        const input = await openAndSearch(page, 'A2');
        await expect(page.locator('#search-results-container a[role="option"]').first()).toBeVisible({
            timeout: 10_000,
        });

        // 每個選項都要有 id，否則 aria-activedescendant 沒有東西可指
        const ids = await page
            .locator('#search-results-container a[role="option"]')
            .evaluateAll((els) => els.map((e) => e.id));
        expect(ids.every((i) => i && i.length > 0), `有選項沒有 id：${JSON.stringify(ids)}`).toBe(true);
        expect(new Set(ids).size, 'id 必須唯一').toBe(ids.length);

        await input.press('ArrowDown');
        const active1 = await input.getAttribute('aria-activedescendant');
        expect(active1, '按 ArrowDown 之後必須指向第一個選項').toBe(ids[0]);
        // 指向的 id 必須真的存在於文件中
        expect(await page.locator(`#${active1}`).count()).toBe(1);

        await input.press('ArrowDown');
        expect(await input.getAttribute('aria-activedescendant'), '再按一次要移到第二個').toBe(ids[1]);

        // 往回退到「沒有選取」時必須移除屬性，而不是留下空字串或舊值
        await input.press('ArrowUp');
        await input.press('ArrowUp');
        expect(await input.getAttribute('aria-activedescendant'), '退回未選取時必須移除屬性').toBeNull();
    });

    test('結果數量必須以 live region 播報，查無結果也要', async ({ page }) => {
        await openAndSearch(page, 'A2');
        const status = page.locator('[role="status"], [aria-live="polite"]');
        await expect(status.first()).toHaveCount(1, { timeout: 10_000 });

        await expect
            .poll(async () => (await status.first().textContent()) || '', { timeout: 10_000 })
            .toMatch(/找到 \d+ 筆/);

        // 查無結果是最需要回饋的情況，而它走的是提早 return 的那條路徑
        await page.locator('#search-input').fill('zzzz不可能存在的關鍵字zzzz');
        await expect
            .poll(async () => (await status.first().textContent()) || '', { timeout: 10_000 })
            .toMatch(/找不到/);
    });
});
