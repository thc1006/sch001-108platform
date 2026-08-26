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
