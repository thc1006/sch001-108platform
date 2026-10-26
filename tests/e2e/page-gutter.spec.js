// lg 起不用 container 的頁面也要和頁首對齊：內文左緣等於站名的左緣，至少 56px，版心變窄後內容也放得下。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';

for (const width of [1024, 1280]) {
    test(`競賽頁在 ${width}px 的內文左緣對齊站名`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${BASE}/sch001-108platform/advanced-resources/competitions.html`);
        const m = await page.evaluate(() => {
            const left = (selector) => document.querySelector(selector).getBoundingClientRect().left;
            const grid = document.querySelector('.comp-gridwrap');
            return {
                brand: left('header nav a'),
                hero: left('.comp-hero__inner'),
                controls: left('.comp-controls__inner'),
                grid: grid.getBoundingClientRect().left + parseFloat(getComputedStyle(grid).paddingLeft),
            };
        });
        expect(m.brand).toBeGreaterThanOrEqual(56);
        for (const part of ['hero', 'controls', 'grid']) expect(m[part], `${part} 的左緣`).toBeCloseTo(m.brand, 0);
    });

    test(`公民科技地圖在 ${width}px 的快速導航放得下全部連結`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${BASE}/sch001-108platform/civic-tech-map/index.html`);
        await page.evaluate(() => document.fonts.ready.then(() => {}));
        const m = await page.evaluate(() => {
            const strip = document.querySelector('[data-scroll-fade]');
            const last = strip.querySelector('a:last-of-type');
            return {
                overflow: strip.scrollWidth - strip.clientWidth,
                lastRight: last.getBoundingClientRect().right,
                stripRight: strip.getBoundingClientRect().right,
                text: last.textContent.trim(),
            };
        });
        expect(m.overflow, '捲動區可以橫向捲動').toBeLessThanOrEqual(0);
        expect(m.lastRight, `「${m.text}」被切掉`).toBeLessThanOrEqual(m.stripRight + 0.5);
    });
}
