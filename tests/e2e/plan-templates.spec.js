// 計畫範本庫的空白進度表：表格語意、鍵盤展開、複製到剪貼簿，以及可下載的 CSV 和頁上的表格一致。
// AI 草擬計畫的部分在 study-plan.spec.js。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const DIR = `${BASE}/sch001-108platform/autonomous-learning`;
const COLUMNS = ['週次', '要做的事', '做完拿得出什麼', '實際做到哪裡'];

/** openProgress 用鍵盤展開 n 週的空白進度表，回傳裡面的表格。 */
async function openProgress(page, n) {
    const summary = page.locator('summary', { hasText: `${n} 週空白進度表` });
    await summary.focus();
    await page.keyboard.press('Enter');
    return page.getByRole('table', { name: `${n} 週空白進度表` });
}

for (const n of [6, 12, 18]) {
    test(`${n} 週空白進度表：按 Enter 展開，有欄標題與每週一列，中間那週標出回頭看`, async ({ page }) => {
        await page.goto(`${DIR}/plan-templates.html`);
        const table = await openProgress(page, n);
        await expect(table).toBeVisible();
        await expect(table.getByRole('columnheader')).toHaveText(COLUMNS);
        const weeks = table.getByRole('rowheader');
        await expect(weeks).toHaveCount(n);
        await expect(weeks.nth(n / 2 - 1)).toHaveText(`${n / 2}（回頭看）`);
    });
}

test('複製按鈕把表頭和每週一列放進剪貼簿，status 念出已複製，焦點留在按鈕上', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
    await page.goto(`${DIR}/plan-templates.html`);
    const table = await openProgress(page, 6);
    const section = page.locator('details', { has: table });
    const copy = section.getByRole('button', { name: '複製 6 週空白進度表' });
    await copy.focus();
    await page.keyboard.press('Enter');
    await expect(section.getByRole('status')).toHaveText('已複製 6 週空白進度表，可以貼到文件或試算表。');
    await expect(copy).toBeFocused();
    const lines = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
    expect(lines.slice(0, 3)).toEqual(['每週＿節，合計＿節', COLUMNS.join('\t'), '1\t\t\t']);
    expect(lines).toHaveLength(2 + 6);
});

test('剪貼簿不能用時，status 改說可以下載 CSV 檔', async ({ page }) => {
    await page.addInitScript(() => {
        const blocked = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
        navigator.clipboard.write = blocked;
        navigator.clipboard.writeText = blocked;
    });
    await page.goto(`${DIR}/plan-templates.html`);
    const table = await openProgress(page, 12);
    const section = page.locator('details', { has: table });
    await section.getByRole('button', { name: '複製 12 週空白進度表' }).click();
    await expect(section.getByRole('status')).toHaveText('沒有複製成功，可以改用下載 CSV 檔。');
});

test('三個 CSV 檔的內容和頁上的表格一樣', async ({ page, request }) => {
    await page.goto(`${DIR}/plan-templates.html`);
    for (const n of [6, 12, 18]) {
        const link = page.getByRole('link', { name: `下載 ${n} 週空白進度表（CSV）`, includeHidden: true });
        await expect(link).toHaveAttribute('download', '');
        const rows = await page.locator(`#progress-${n} tr`).evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent.trim()).join(',')));
        const res = await request.get(`${DIR}/${await link.getAttribute('href')}`);
        expect(res.ok()).toBe(true);
        // 開頭的 BOM 讓 Excel 用 UTF-8 讀，中文才不會變亂碼。
        const body = await res.body();
        expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(body.subarray(3).toString('utf8').trimEnd().split('\n')).toEqual(['每週＿節，合計＿節', ...rows]);
    }
});
