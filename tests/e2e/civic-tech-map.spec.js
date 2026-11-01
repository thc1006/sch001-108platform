// 公民科技專案頁由 projects.json 產生：每個專案一張卡片，專案一覽連得到卡片，其他頁連進來的錨點看得到。
// 8001 埠服務的是 .link-root，要先建置。
const { test, expect } = require('@playwright/test');
const { projects } = require('../../public/civic-tech-map/projects.json');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/civic-tech-map/index.html`;

test.describe('公民科技專案頁', () => {
    test('每個專案一張卡片，依序寫出名稱（連到官網）、資料或工具、題目例子和做法', async ({ page }) => {
        await page.goto(PAGE);
        const cards = page.locator('article');
        await expect(cards).toHaveCount(projects.length);
        for (const [i, p] of projects.entries()) {
            const card = cards.nth(i);
            await expect(card).toHaveAttribute('id', p.id);
            // 名稱後面的「（官網）」只給螢幕報讀器，和專案一覽連到卡片的連結分開。sr-only 是絕對定位，
            // Chromium 算名稱時會在前面補一個空白。
            const name = new RegExp(`^${p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s?（官網）$`);
            const heading = card.getByRole('heading', { level: 3 });
            await expect(heading).toHaveAccessibleName(name);
            await expect(heading.getByRole('link', { name })).toHaveAttribute('href', p.url);
            await expect(card.locator('dt')).toHaveText(['可以用的資料或工具', '題目例子', '做法']);
            await expect(card.locator('dd').nth(1)).toHaveText(p.topic);
            await expect(card.locator('dd li')).toHaveCount(p.tools.length);
        }
    });

    test('專案一覽的連結依序指向每張卡片', async ({ page }) => {
        await page.goto(PAGE);
        const links = page.getByRole('region', { name: '專案一覽' }).getByRole('link');
        expect(await links.evaluateAll((els) => els.map((a) => a.getAttribute('href')))).toEqual(projects.map((p) => `#${p.id}`));
    });

    test('標題層級依序是 h1、h2、h3，沒有跳級', async ({ page }) => {
        await page.goto(PAGE);
        const levels = await page.locator('main').locator('h1, h2, h3, h4').evaluateAll((els) => els.map((el) => Number(el.tagName[1])));
        expect(levels[0]).toBe(1);
        for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `第 ${i + 1} 個標題`).toBeLessThanOrEqual(1);
    });

    // 主題靈感產生器連到這三個錨點。
    for (const id of ['thaubing', 'national-treasure', 'cofacts']) {
        test(`#${id} 跳到卡片，標題不被頁首蓋住`, async ({ page }) => {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.goto(`${PAGE}#${id}`);
            const header = await page.locator('header').evaluate((el) => el.getBoundingClientRect().bottom);
            // <html> 有 scroll-smooth，跳到錨點要等捲動停下來。
            const top = () => page.locator(`#${id} h3`).evaluate((el) => el.getBoundingClientRect().top);
            await expect.poll(top).toBeLessThan(header + 100);
            expect(await top()).toBeGreaterThanOrEqual(header);
        });
    }

    for (const width of [320, 390, 768, 1280]) {
        test(`${width}px 沒有橫向捲動`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await page.goto(PAGE);
            expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
        });
    }
});
