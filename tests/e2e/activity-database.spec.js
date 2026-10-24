// 多元表現資料庫用固定的資料和時間渲染，檢查卡片的狀態與截止欄，以及精選卡。
// 真實資料由 site-smoke.spec.js 檢查，getActivityStatus 的邊界由 scripts/activity-database.test.mjs 檢查。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/learning-portfolio/activity-database.html`;

const entry = (title, fields) => ({
    title,
    organizer: '主辦單位',
    category: '競賽',
    form: '個人',
    description: '說明',
    deadline: null,
    featured: false,
    url: 'https://example.com/',
    ...fields,
});
const ACTIVITIES = [
    entry('隨時可以報名', { rolling: true }),
    entry('還沒公布', {}),
    entry('昨天截止', { deadline: '2026-10-24' }),
    entry('今天截止', { deadline: '2026-10-25' }),
    entry('十五天後截止', { deadline: '2026-11-09', featured: true }),
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
