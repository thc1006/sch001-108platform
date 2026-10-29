// 句子中間的連結要有底線。只靠顏色的話，text-blue-600 和周圍的灰字對比不到 1.5:1，
// 不符合 WCAG 1.4.1。麵包屑的連結和目前頁面的文字也只差明暗，一起檢查；導覽列、按鈕與卡片連結不在這裡。
// 只看 display 是 inline 的連結，要點開才顯示的內容也不在範圍內。
const { test, expect } = require('@playwright/test');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const DIST = path.resolve(__dirname, '../../.link-root/sch001-108platform');

function walk(dir, prefix = '', out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
        else if (e.name.endsWith('.html')) out.push(rel);
    }
    return out;
}

// google 開頭的是搜尋引擎的網站驗證檔，不是本站頁面。
const PAGES = walk(DIST).filter((p) => !p.startsWith('google')).sort();
// 這幾頁一定有句中連結；選擇條件寫錯、一個都沒選到時，其他頁會照樣通過。
const HAS_INLINE = new Set([
    'career-exploration/clusters/index.html',
    'career-exploration/clusters/law/index.html',
    'career-exploration/clusters/info/application.html',
    'autonomous-learning/topic-ideas.html',
]);

test('一定有句中連結的頁面都還在', () => {
    expect([...HAS_INLINE].filter((p) => !PAGES.includes(p))).toEqual([]);
});

for (const p of PAGES) {
    test(`${p} 句中的連結都有底線`, async ({ page }) => {
        await page.goto(`${BASE}/sch001-108platform/${p}`);
        const links = await page.evaluate(() => {
            const isInline = (el) => /^(inline|contents)$/.test(getComputedStyle(el).display);
            const hasOtherText = (block) => {
                const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
                    acceptNode: (n) => (n.parentElement.closest('a, button, [hidden]') || !n.parentElement.checkVisibility()
                        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
                });
                while (walker.nextNode()) if (/[\p{L}\p{N}]/u.test(walker.currentNode.data)) return true;
                return false;
            };
            return [...document.querySelectorAll('main a[href]')]
                .filter((a) => isInline(a) && a.getClientRects().length)
                .filter((a) => {
                    let block = a.parentElement;
                    while (isInline(block)) block = block.parentElement;
                    return hasOtherText(block);
                })
                .map((a) => [a.textContent.trim(), getComputedStyle(a).textDecorationLine]);
        });
        if (HAS_INLINE.has(p)) expect(links.length).toBeGreaterThan(0);
        expect(links.filter(([, line]) => !line.includes('underline'))).toEqual([]);
    });
}
