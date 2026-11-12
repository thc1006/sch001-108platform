// 用注音選字時，搜尋框裡先出現「ㄏ」這種還沒選字的內容，input 事件的 isComposing 是 true。框裡有注音符號時
// 不搜尋、不念筆數，選完（compositionend）才補搜；Gboard 打英文這種沒有注音符號的選字照常搜、照常念。
// 沒有跳過時 compositionend 不重畫，組字途中點卡片才不會點空。
// 合成事件照兩種順序送：Chrome、Safari 是選完那次 input 在 compositionend 前面，Firefox 是 compositionend
// 之後再送一次 isComposing 是 false 的 input。另外用 CDP 的 Input.imeSetComposition 送 Chromium 真的輸入法事件。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const P = (p) => `${BASE}/sch001-108platform/${p}`;

// 大學科系羅盤的搜尋框是 #search-bar，學長姐訪談是 #search-box，其他頁是 #search-input，一頁只有其中一個。
const SEARCH = '#search-input, #search-bar, #search-box';

/** composing 在搜尋框裡放 value，送 compositionstart（第一次）和 isComposing 的 input。 */
const composing = (page, value) =>
    page.locator(SEARCH).evaluate((el, value) => {
        el.focus();
        if (!el.dataset.composing) el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        el.dataset.composing = '1';
        el.value = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertCompositionText', isComposing: true }));
    }, value);

/** end 送 compositionend；firefox 為 true 時再送一次 isComposing 是 false 的 input。 */
const end = (page, firefox) =>
    page.locator(SEARCH).evaluate((el, firefox) => {
        delete el.dataset.composing;
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: el.value }));
        if (firefox) el.dispatchEvent(new InputEvent('input', { bubbles: true, data: el.value, inputType: 'insertCompositionText', isComposing: false }));
    }, firefox);

/** watchWrites 開始記錄 selector 的文字被寫入幾次，writes 讀出來。 */
const watchWrites = (page, selector) =>
    page.evaluate((selector) => {
        window.__writes = 0;
        new MutationObserver(() => window.__writes++).observe(document.querySelector(selector), { childList: true, characterData: true, subtree: true });
    }, selector);
const writes = (page) => page.evaluate(() => window.__writes);

// 比 announceCount(400) 和各頁的 debounce（最長 200 毫秒）都久。
const SETTLE = 800;

// [頁面, 卡片, 筆數的 live region, 卡片裡的標題]。競賽頁的筆數在 #result-count，render 時更新。
const PAGES = [
    ['learning-portfolio/activity-database.html', '.activity-card', '#result-status', 'h2, h3'],
    ['advanced-resources/reading-list.html', '.book-card', '#result-status', 'h2, h3'],
    ['advanced-resources/online-courses.html', '.course-card', '#result-status', 'h2, h3'],
    ['advanced-resources/open-education.html', '.resource-card', '#result-status', 'h2, h3'],
    ['advanced-resources/competitions.html', '.comp-card', '#result-count', 'h2, h3'],
    ['career-exploration/index.html', '.cluster-btn', '#result-status', 'span'],
    ['career-exploration/senior-interviews.html', '.interview-card', '#result-status', 'h2'],
    ['autonomous-learning/resource-map.html', '.resource-card', '#result-status', 'h3'],
];

for (const [p, card, live, heading] of PAGES) {
    test.describe(`${p}：選字時的搜尋`, () => {
        let before;
        let liveText;
        test.beforeEach(async ({ page }) => {
            await page.goto(P(p), { waitUntil: 'networkidle' });
            await page.locator(card).first().waitFor();
            before = await page.locator(card).count();
            liveText = await page.locator(live).textContent();
        });

        test('框裡有注音符號時不搜、不念筆數', async ({ page }) => {
            await watchWrites(page, live);
            await composing(page, 'ㄏ');
            await page.waitForTimeout(SETTLE);
            await expect(page.locator(card)).toHaveCount(before);
            await expect(page.locator(live)).toHaveText(liveText);
            expect(await writes(page)).toBe(0);
        });

        test('注音打得快：前一次沒有注音符號、緊接著有注音符號時不搜、不念', async ({ page }) => {
            await watchWrites(page, live);
            await composing(page, '科');
            await composing(page, '科ㄏ');
            await page.waitForTimeout(SETTLE);
            expect(await writes(page)).toBe(0);
            expect(await page.locator(card).count()).toBeGreaterThan(0);
        });

        test('選字途中沒有注音符號（Gboard 打英文、注音組字區的字）時照常搜、照常念', async ({ page }) => {
            const title = (await page.locator(card).first().locator(heading).first().textContent()).trim().slice(0, 2);
            await watchWrites(page, live);
            await composing(page, title);
            await expect.poll(() => writes(page)).toBeGreaterThan(0);
            expect(await page.locator(card).count()).toBeGreaterThan(0);
            if (live === '#result-status') await expect(page.locator(live)).toHaveText(`顯示 ${await page.locator(card).count()} 筆`);
        });

        test('選字途中沒有注音符號、搜到 0 筆時（Gboard 打錯字）照常顯示 0 筆、照常念', async ({ page }) => {
            for (const value of ['z', 'zz', 'zzq', 'zzqx']) await composing(page, value);
            await page.waitForTimeout(SETTLE);
            await expect(page.locator(card)).toHaveCount(0);
            await expect(page.locator(live)).toHaveText(live === '#result-status' ? '顯示 0 筆' : '0 項結果');
        });

        test('組字途中點卡片（Chrome 先送 compositionend）：最後一次 input 沒有跳過時不重畫，卡片還在', async ({ page }) => {
            const title = (await page.locator(card).first().locator(heading).first().textContent()).trim().slice(0, 2);
            // 先打一個會跳過的注音：之後沒跳過的 input 要把旗標設回 false。
            await composing(page, 'ㄎ');
            await composing(page, title);
            await page.waitForTimeout(SETTLE);
            const first = await page.locator(card).first().elementHandle();
            await end(page, false);
            await page.waitForTimeout(SETTLE);
            expect(await first.evaluate((el) => el.isConnected)).toBe(true);
        });

        test('Chrome 的順序：compositionend 時搜', async ({ page }) => {
            await composing(page, 'ㄏ');
            await page.waitForTimeout(SETTLE);
            await end(page, false);
            await expect(page.locator(card)).toHaveCount(0);
            if (live === '#result-status') await expect(page.locator(live)).toHaveText('顯示 0 筆');
        });

        test('Firefox 的順序：compositionend 後再來一次 input，筆數只寫一次', async ({ page }) => {
            await composing(page, 'ㄏ');
            await page.waitForTimeout(SETTLE);
            await watchWrites(page, live);
            await end(page, true);
            await expect(page.locator(card)).toHaveCount(0);
            await page.waitForTimeout(SETTLE);
            expect(await writes(page)).toBe(1);
        });
    });
}

test('閱讀清單：Chromium 的輸入法事件（CDP），組字時不搜，送出選好的字才搜', async ({ page }) => {
    await page.goto(P('advanced-resources/reading-list.html'), { waitUntil: 'networkidle' });
    const cards = page.locator('.book-card');
    await cards.first().waitFor();
    const before = await cards.count();
    await page.locator('#search-input').focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'ㄏ', selectionStart: 1, selectionEnd: 1 });
    await page.waitForTimeout(SETTLE);
    await expect(page.locator('#search-input')).toHaveValue('ㄏ');
    await expect(cards).toHaveCount(before);
    await expect(page.locator('#result-status')).toBeEmpty();
    await cdp.send('Input.insertText', { text: '哈拉瑞' });
    await expect(page.locator('#search-input')).toHaveValue('哈拉瑞');
    await expect.poll(() => cards.count()).toBeLessThan(before);
    expect(await cards.count()).toBeGreaterThan(0);
    await expect(page.locator('#result-status')).toHaveText(`顯示 ${await cards.count()} 筆`);
});

test.describe('首頁的全站搜尋', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(P('index.html'), { waitUntil: 'networkidle' });
        await expect(page.locator('#search-input')).toBeEnabled();
    });
    const results = (page) => page.locator('#search-results-container');

    test('框裡有注音符號時不搜，選完才搜', async ({ page }) => {
        await composing(page, 'ㄏ');
        await page.waitForTimeout(SETTLE);
        await expect(results(page)).toBeEmpty();
        await end(page, false);
        await expect(results(page)).not.toBeEmpty();
    });

    test('選字途中沒有注音符號時照常搜', async ({ page }) => {
        await composing(page, 'python');
        await expect(results(page)).not.toBeEmpty();
    });

    test('注音打得快：前一次沒有注音符號、緊接著有注音符號時不搜「科ㄏ」', async ({ page }) => {
        await composing(page, '科');
        await end(page, false);
        await composing(page, '科ㄏ');
        await page.waitForTimeout(SETTLE);
        await expect(results(page)).not.toContainText('科ㄏ');
        await expect(page.getByRole('status').filter({ hasText: '科ㄏ' })).toHaveCount(0);
    });

    test('框裡有注音符號、模糊比對找得到東西時也不搜（「科學ㄧ」）', async ({ page }) => {
        await composing(page, '科學ㄧ');
        await page.waitForTimeout(SETTLE);
        await expect(results(page)).toBeEmpty();
    });

    test('選字途中 × 就出現', async ({ page }) => {
        await composing(page, 'ㄏ');
        await expect(page.locator('#search-clear-btn')).toBeVisible();
    });

    test('組字途中點結果（Chrome 先送 compositionend）：最後一次 input 沒有跳過時不重畫，連結還在', async ({ page }) => {
        // 先打一個會跳過的注音：之後沒跳過的 input 要把旗標設回 false。
        await composing(page, 'ㄎ');
        await composing(page, 'python');
        await expect(results(page).locator('a').first()).toBeVisible();
        const first = await results(page).locator('a').first().elementHandle();
        await end(page, false);
        await page.waitForTimeout(SETTLE);
        expect(await first.evaluate((el) => el.isConnected)).toBe(true);
    });

    test('方向鍵選了一筆之後，選字時按 Enter 不會打開那一筆', async ({ page }) => {
        const url = page.url();
        await page.fill('#search-input', 'python');
        await expect(results(page).locator('a').first()).toBeVisible();
        await page.locator('#search-input').press('ArrowDown');
        await expect(page.locator('#search-input')).toHaveAttribute('aria-activedescendant', /.+/);
        await composing(page, 'pythonㄎ');
        await page.locator('#search-input').evaluate((el) => {
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(500);
        expect(page.url()).toBe(url);
        // Safari 先送 compositionend，選字的 Enter 的 isComposing 是 false、keyCode 是 229。兩個事件一起送，
        // compositionend 排的搜尋（200 毫秒後）還沒把選取清掉。
        await page.locator('#search-input').evaluate((el) => {
            delete el.dataset.composing;
            el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: el.value }));
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: false, bubbles: true, cancelable: true }));
        });
        await page.waitForTimeout(500);
        expect(page.url()).toBe(url);
    });
});

test('競賽頁：選字時按 Esc 不清空搜尋框', async ({ page }) => {
    await page.goto(P('advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
    await page.locator('.comp-card').first().waitFor();
    await composing(page, 'ㄏ');
    await page.locator('#search-input').evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('#search-input')).toHaveValue('ㄏ');
});
