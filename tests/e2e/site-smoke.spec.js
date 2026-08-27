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
