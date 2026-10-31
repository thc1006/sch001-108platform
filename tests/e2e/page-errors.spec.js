// 每一頁載入時都不能有未捕捉的 JS 錯誤。頁面的 inline script 一丟錯就整段停掉，
// 例如兩個分支在同一段宣告了同名的 let，卡片和篩選都不會出現；只有幾頁有測試會發現。
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

test('找得到頁面', () => {
    expect(PAGES.length).toBeGreaterThan(50);
});

for (const p of PAGES) {
    test(`${p} 載入時沒有未捕捉的 JS 錯誤`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${BASE}/sch001-108platform/${p}`, { waitUntil: 'load' });
        expect(errors).toEqual([]);
    });
}
