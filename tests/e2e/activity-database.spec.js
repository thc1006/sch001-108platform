// 多元表現資料庫用固定的資料和時間渲染，檢查卡片的狀態與截止欄、精選卡和詳細資訊對話框。
// 真實資料由 site-smoke.spec.js 檢查，getActivityStatus 的邊界由 scripts/activity-database.test.mjs 檢查。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/learning-portfolio/activity-database.html`;

const entry = (title, fields) => ({
    title,
    organizer: '主辦單位',
    category: '研討會',
    form: '個人',
    description: '說明',
    deadline: null,
    featured: false,
    url: 'https://example.com/',
    ...fields,
});
const ACTIVITIES = [
    entry('隨時可以報名', { rolling: true }),
    entry('還沒公布', { details: '第一段。\n\n第二段寫報名方式。\n<b>x</b>' }),
    entry('昨天截止', { deadline: '2026-10-24' }),
    entry('今天截止', { deadline: '2026-10-25' }),
    entry('十五天後截止', { deadline: '2026-11-09', featured: true, details: '精選的詳細資訊。' }),
];

/** open 在台灣時間 2026-10-25 00:30 開頁面，資料換成 activities，等卡片渲染完。 */
async function open(page, activities) {
    await page.clock.setFixedTime(new Date('2026-10-25T00:30:00+08:00'));
    await page.route('**/learning-portfolio/activity-database.json', (route) =>
        route.fulfill({ json: { activities } }),
    );
    await page.goto(PAGE);
    await expect(page.locator('#activity-grid .activity-card')).toHaveCount(activities.length);
}

/** featuredOn 回傳把精選改成 title 那一筆的資料。 */
const featuredOn = (title) => ACTIVITIES.map((a) => ({ ...a, featured: a.title === title }));

test('卡片的狀態、截止欄與精選卡', async ({ page }) => {
    await open(page, ACTIVITIES);

    const shown = await page.locator('#activity-grid .activity-card').evaluateAll((els) =>
        els.map((el) => [
            el.querySelector('h3').textContent,
            el.querySelector('.rounded-full').textContent,
            el.querySelector('.rounded-b-lg .font-semibold').textContent,
        ]),
    );
    expect(shown).toEqual([
        ['隨時可以報名', '全年招募', '全年招募'],
        ['還沒公布', '依官網公告', '依官網公告'],
        ['昨天截止', '已截止', '2026-10-24'],
        ['今天截止', '即將截止', '2026-10-25'],
        ['十五天後截止', '報名中', '2026-11-09'],
    ]);

    const featured = page.locator('#featured-section');
    await expect(featured).toBeVisible();
    await expect(featured.locator('h3')).toHaveText('十五天後截止');
    await expect(featured.locator('.rounded-full').first()).toHaveText('報名中');
    await expect(featured).toContainText('報名截止：2026-11-09');
});

// loadData 先跑 renderFeatured 才渲染卡片，open 等到卡片出現才回來，所以這裡的隱藏不是還沒渲染。
test('精選活動截止後收起精選區塊，卡片還在列表裡', async ({ page }) => {
    await open(page, featuredOn('昨天截止'));
    await expect(page.locator('#featured-section')).toBeHidden();
    const heading = page.getByRole('heading', { name: '昨天截止', exact: true });
    await expect(page.locator('#activity-grid .activity-card', { has: heading }).locator('.rounded-full')).toHaveText('已截止');
});

test('精選活動截止當天還放在精選區塊', async ({ page }) => {
    await open(page, featuredOn('今天截止'));
    const featured = page.locator('#featured-section');
    await expect(featured).toBeVisible();
    await expect(featured.locator('h3')).toHaveText('今天截止');
    await expect(featured.locator('.rounded-full').first()).toHaveText('即將截止');
});

for (const [title, badge] of [['隨時可以報名', '全年招募'], ['還沒公布', '依官網公告']]) {
    test(`沒有截止日的精選照常顯示：${badge}`, async ({ page }) => {
        await open(page, featuredOn(title));
        const featured = page.locator('#featured-section');
        await expect(featured).toBeVisible();
        await expect(featured.locator('h3')).toHaveText(title);
        await expect(featured.locator('.rounded-full').first()).toHaveText(badge);
    });
}

/** card 回傳名稱是 title 的那張卡片。 */
const card = (page, title) =>
    page.locator('#activity-grid .activity-card', { has: page.getByRole('heading', { name: title, exact: true }) });

test('只有填了 details 的卡片有「詳細資訊」，連結和競賽頁一樣寫「前往官網」', async ({ page }) => {
    await open(page, ACTIVITIES);
    const titles = await page.locator('#activity-grid .activity-card').evaluateAll((cards) =>
        cards.filter((c) => c.querySelector('button')).map((c) => c.querySelector('h3').textContent));
    expect(titles).toEqual(['還沒公布', '十五天後截止']);
    const button = card(page, '還沒公布').getByRole('button');
    // sr-only 的文字前後，Chromium 算名稱時會補空白。
    await expect(button).toHaveAccessibleName(/^詳細資訊\s?：還沒公布$/);
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(card(page, '還沒公布').getByRole('link')).toHaveAccessibleName(/^前往官網\s?：還沒公布（另開新分頁）$/);
});

test('Enter 開啟對話框，details 一行一段，Esc 關閉後焦點回到按鈕', async ({ page }) => {
    await open(page, ACTIVITIES);
    const button = card(page, '還沒公布').getByRole('button');
    await button.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '還沒公布', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(dialog.locator('.activity-dialog__text')).toHaveText('說明');
    await expect(dialog.locator('.activity-dialog__details p')).toHaveText(['第一段。', '第二段寫報名方式。', '<b>x</b>']);
    // details 是純文字，標籤照原樣顯示，不產生元素。
    await expect(dialog.locator('b')).toHaveCount(0);
    await expect(dialog.getByRole('link')).toHaveAccessibleName(/^前往官網\s?：還沒公布（另開新分頁）$/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
    await expect(page.locator('#activity-dialog')).toBeEmpty();
});

test('按「關閉」關掉對話框，焦點回到精選區的按鈕', async ({ page }) => {
    await open(page, ACTIVITIES);
    const button = page.locator('#featured-section').getByRole('button');
    await expect(button).toHaveAccessibleName(/^詳細資訊\s?：十五天後截止$/);
    await button.click();
    const dialog = page.getByRole('dialog', { name: '十五天後截止', exact: true });
    await expect(dialog.locator('.activity-dialog__details p')).toHaveText(['精選的詳細資訊。']);
    await expect(dialog.getByRole('button', { name: '關閉', exact: true })).toHaveCount(2);
    await dialog.getByRole('button', { name: '關閉', exact: true }).last().click();
    await expect(dialog).toBeHidden();
    await expect(button).toBeFocused();
});

test('搜尋也找得到摘要和詳細資訊裡的字', async ({ page }) => {
    await open(page, ACTIVITIES);
    await page.fill('#search-input', '報名方式');
    await expect(page.locator('#activity-grid .activity-card h3')).toHaveText(['還沒公布']);
});

test('列表上方有競賽入口，筆數和競賽資料相同', async ({ page, request }) => {
    await open(page, ACTIVITIES);
    const { competitions } = await (await request.get(`${BASE}/sch001-108platform/advanced-resources/competitions.json`)).json();
    const entry = page.locator('#competitions-entry');
    await expect(entry).toContainText(`國內外競賽資訊有 ${competitions.length} 項`);
    const link = entry.getByRole('link', { name: '國內外競賽資訊', exact: true });
    await expect(link).toHaveAttribute('href', '../advanced-resources/competitions.html');
    await link.click();
    await expect(page).toHaveURL(/\/advanced-resources\/competitions\.html$/);
});
