// 頁首導覽列在平板與筆電寬度的排列：站名和選單的距離不小於選項之間的距離，選項不換行，也不超出導覽列。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';

for (const width of [768, 820, 1023, 1024, 1280]) {
    test(`頁首在 ${width}px 的站名和選單分得開，選項不換行`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${BASE}/sch001-108platform/`);
        await page.evaluate(() => document.fonts.ready.then(() => {}));
        const m = await page.evaluate(() => {
            const bar = document.querySelector('header nav > .container');
            const box = (el) => el.getBoundingClientRect();
            const links = [...bar.children[1].querySelectorAll('a')].map((a) => ({
                text: a.textContent.trim(),
                left: box(a).left,
                right: box(a).right,
                height: box(a).height,
                lineHeight: parseFloat(getComputedStyle(a).lineHeight),
            }));
            return {
                brandRight: box(bar.querySelector('a')).right,
                contentRight: box(bar).right - parseFloat(getComputedStyle(bar).paddingRight),
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                links,
            };
        });

        expect(m.links.length).toBe(5);
        const gaps = m.links.slice(1).map((l, i) => l.left - m.links[i].right);
        const brandGap = m.links[0].left - m.brandRight;
        expect(brandGap, `站名和「${m.links[0].text}」隔 ${brandGap}px，選項之間是 ${gaps.join('／')}px`).toBeGreaterThanOrEqual(Math.max(...gaps));
        // 選項間距只在 lg 以下縮成 24px。
        if (width >= 1024) expect(gaps, 'lg 起的選項間距').toEqual(gaps.map(() => 32));
        for (const l of m.links) expect(l.height, `「${l.text}」換行了`).toBeLessThanOrEqual(l.lineHeight + 1);
        expect(m.links[m.links.length - 1].right, '選單超出導覽列').toBeLessThanOrEqual(m.contentRight + 0.5);
        expect(m.overflow, '頁面可以橫向捲動').toBeLessThanOrEqual(0);
    });
}

// 桌機與手機的選項都在同一個「主選單」導覽地標裡；同一時間只有一組選項在無障礙樹上。
const ITEMS = ['台灣教育處方籤', '自主學習', '學習歷程', '生涯探索', '進階資源', '關於我們'];
for (const [width, open] of [[390, false], [390, true], [767, true], [768, false], [1280, false]]) {
    test(`${width}px${open ? '、手機選單展開' : ''}：頁首只有一個名為「主選單」的導覽地標，裡面的連結是站名和五個選項`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${BASE}/sch001-108platform/about.html`);
        if (open) await page.locator('#nav-toggle').click();
        const header = page.locator('header');
        await expect(header.getByRole('navigation')).toHaveCount(1);
        const nav = header.getByRole('navigation', { name: '主選單', exact: true });
        const shown = open || width >= 768;
        await expect(nav.getByRole('link')).toHaveText(shown ? ITEMS : ITEMS.slice(0, 1));
        if (shown) await expect(nav.getByRole('link', { name: '關於我們' })).toHaveAttribute('aria-current', 'page');
        if (width < 768) await expect(nav.getByRole('button', { name: '開啟導覽選單' })).toHaveAttribute('aria-expanded', String(open));
    });
}
