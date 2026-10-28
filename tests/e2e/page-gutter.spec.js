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

// 學群主題頁的 Markdown 表格：比內文欄窄的置中，比內文欄寬的在表格內捲動。
const tableLayout = (page, path) =>
    page.goto(`${BASE}/sch001-108platform/career-exploration/clusters/${path}`).then(() =>
        page.evaluate(() => {
            const col = document.querySelector('.md-content').getBoundingClientRect();
            return [...document.querySelectorAll('.md-content table')].map((table) => {
                const rows = [...table.rows].map((row) => row.getBoundingClientRect());
                return {
                    left: Math.min(...rows.map((r) => r.left)) - col.left,
                    right: col.right - Math.max(...rows.map((r) => r.right)),
                    boxRight: table.getBoundingClientRect().right - col.right,
                    scrolls: table.scrollWidth > table.clientWidth,
                    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                };
            });
        }),
    );

for (const width of [768, 1280]) {
    test(`${width}px：比內文欄窄的表格左右留白相等`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const [t] = await tableLayout(page, 'social-psychology/myths.html');
        expect(t.left, '表格比內文欄窄').toBeGreaterThan(100);
        expect(t.left).toBeCloseTo(t.right, 0);
    });
}

test('360px：比內文欄寬的表格在表格內捲動，不撐寬頁面', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const t = (await tableLayout(page, 'info/overview.html'))[1];
    expect(t.scrolls).toBe(true);
    expect(t.boxRight).toBeLessThanOrEqual(0.5);
    expect(t.pageOverflow).toBeLessThanOrEqual(0);
});

// 儲存格文字靠左、上下置中：同一列裡只有一行的那格，文字上下的留白相等。
test('768px：表格儲存格文字靠左、上下置中', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`${BASE}/sch001-108platform/career-exploration/clusters/finance/overview.html`);
    const m = await page.evaluate(() => {
        const cells = [...document.querySelectorAll('.md-content th, .md-content td')];
        const styles = cells.map((c) => getComputedStyle(c));
        const gaps = [];
        const textBox = (cell) => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            return range.getBoundingClientRect();
        };
        for (const row of document.querySelectorAll('.md-content tr')) {
            const cs = [...row.cells].filter((c) => c.textContent.trim());
            const texts = cs.map(textBox);
            const heights = texts.map((t) => t.height);
            const i = heights.indexOf(Math.min(...heights));
            if (Math.max(...heights) - heights[i] < 20) continue;
            const box = cs[i].getBoundingClientRect();
            gaps.push(Math.abs((texts[i].top - box.top) - (box.bottom - texts[i].bottom)));
        }
        return {
            align: [...new Set(styles.map((s) => s.textAlign))],
            valign: [...new Set(styles.map((s) => s.verticalAlign))],
            gaps,
        };
    });
    expect(m.align).toEqual(['start']);
    expect(m.valign).toEqual(['middle']);
    expect(m.gaps.length, '至少有一列的儲存格高度不同').toBeGreaterThan(0);
    for (const gap of m.gaps) expect(gap).toBeLessThanOrEqual(2);
});
