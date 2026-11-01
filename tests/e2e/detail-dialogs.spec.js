// 卡片詳情對話框（public/shared/detail-dialog.js）：鍵盤和螢幕閱讀器能開關，滑鼠點卡片照舊。
//
// 伺服器由 playwright.config.js 的 webServer 啟動（8001 埠是 .link-root，要先建置）。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const ROOT = `${BASE}/sch001-108platform`;

// grid 是卡片的容器，button 是卡片上開啟對話框的按鈕，tabs 表示對話框裡有分頁。
const PAGES = [
    { name: '研究方法工具箱', path: '/autonomous-learning/methodology.html', grid: '#methodology-grid', button: 'h3 > button' },
    { name: '計畫範本庫', path: '/autonomous-learning/plan-templates.html', grid: '#template-grid', button: 'h3 > button', tabs: true },
    { name: '優質範例藝廊', path: '/learning-portfolio/portfolio-gallery.html', grid: '#portfolio-grid', button: 'h3 > button' },
    { name: '學長姐真心話', path: '/career-exploration/senior-interviews.html', grid: '#interview-grid', button: 'h2 > button', tabs: true },
];

for (const { name, path, grid, button, tabs } of PAGES) {
    test.describe(`${name}的卡片詳情`, () => {
        test.beforeEach(async ({ page }) => {
            await page.goto(ROOT + path);
            await expect(page.locator(`${grid} ${button}`).first()).toBeVisible();
        });

        test('Tab 走得到每張卡片的按鈕', async ({ page }) => {
            const buttons = page.locator(`${grid} ${button}`);
            await expect(buttons).toHaveCount(await page.locator(`${grid} > *`).count());
            const names = await buttons.allTextContents();
            const reached = new Set();
            for (let i = 0; i < 200 && reached.size < names.length; i++) {
                await page.keyboard.press('Tab');
                const text = await page.evaluate((sel) => {
                    const el = document.activeElement;
                    return el.matches(sel) ? el.textContent : null;
                }, `${grid} ${button}`);
                if (text !== null) reached.add(text);
            }
            expect([...reached].sort()).toEqual([...names].sort());
        });

        test('Enter 開啟，焦點移進對話框，Esc 關閉後回到按鈕', async ({ page }) => {
            const opener = page.locator(`${grid} ${button}`).nth(1);
            const title = await opener.textContent();
            await opener.focus();
            await page.keyboard.press('Enter');
            const dialog = page.getByRole('dialog', { name: title, exact: true });
            await expect(dialog).toBeVisible();
            await expect(dialog).toBeFocused();
            await page.keyboard.press('Escape');
            await expect(dialog).toBeHidden();
            await expect(opener).toBeFocused();
        });

        test('空白鍵開啟，按「關閉」後回到按鈕，開著時 Tab 不會離開對話框', async ({ page }) => {
            const opener = page.locator(`${grid} ${button}`).first();
            await opener.focus();
            await page.keyboard.press('Space');
            const dialog = page.getByRole('dialog', { name: await opener.textContent(), exact: true });
            await expect(dialog).toBeVisible();
            // 背景是 inert，焦點只會在對話框裡，或是離開頁面時的 <body>。
            for (let i = 0; i < 12; i++) {
                await page.keyboard.press('Tab');
                const where = await dialog.evaluate((d) => d.contains(document.activeElement) || document.activeElement === document.body);
                expect(where).toBe(true);
            }
            const close = dialog.getByRole('button', { name: '關閉', exact: true });
            await close.focus();
            await page.keyboard.press('Enter');
            await expect(dialog).toBeHidden();
            await expect(opener).toBeFocused();
        });

        test('滑鼠點卡片任何地方都會開啟，點對話框外面關閉', async ({ page }) => {
            const card = page.locator(`${grid} > *`).nth(2);
            const opener = card.locator(button);
            const box = await card.boundingBox();
            await card.click({ position: { x: 10, y: box.height - 10 } });
            const dialog = page.getByRole('dialog', { name: await opener.textContent(), exact: true });
            await expect(dialog).toBeVisible();
            // 從對話框裡拖曳到外面放開不算點外面。
            const inner = await dialog.boundingBox();
            await page.mouse.move(inner.x + 20, inner.y + 20);
            await page.mouse.down();
            await page.mouse.move(5, 5);
            await page.mouse.up();
            await expect(dialog).toBeVisible();
            await page.mouse.click(5, 5);
            await expect(dialog).toBeHidden();
            await expect(opener).toBeFocused();
        });

        test('開著時頁面不捲動，關閉後捲動位置不變', async ({ page }) => {
            // 卡片淡入時位置還在變，click 會判定不穩定而重新捲動，量到的 y 就不是點擊時的位置。
            await page.locator(grid).evaluate((g) => Promise.all(g.getAnimations({ subtree: true }).map((a) => a.finished)));
            const card = page.locator(`${grid} > *`).nth(2);
            await card.scrollIntoViewIfNeeded();
            const y = await page.evaluate(() => window.scrollY);
            await card.locator(button).click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
            await page.mouse.move(5, 5);
            await page.mouse.wheel(0, 600);
            await page.keyboard.press('Escape');
            await expect(dialog).toBeHidden();
            await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
            // 關閉後若有平滑捲動，要等它停下才量：連續 10 個畫面 scrollY 都沒變才算停下。
            const settled = await page.evaluate(() => new Promise((resolve) => {
                let last = scrollY;
                let same = 0;
                const tick = () => {
                    same = scrollY === last ? same + 1 : 0;
                    last = scrollY;
                    if (same >= 10) resolve(last);
                    else requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            }));
            expect(settled).toBe(y);
        });

        test('320x256 也捲得到對話框最底下的按鈕，一般尺寸不會多出捲軸', async ({ page }) => {
            const opener = page.locator(`${grid} ${button}`).first();
            await opener.click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            expect(await dialog.evaluate((d) => d.scrollHeight - d.clientHeight)).toBe(0);
            await page.keyboard.press('Escape');

            await page.setViewportSize({ width: 320, height: 256 });
            await opener.click();
            const last = dialog.getByRole('button').last();
            await last.scrollIntoViewIfNeeded();
            const box = await last.boundingBox();
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.y + box.height).toBeLessThanOrEqual(256);
        });

        if (tabs) {
            test('對話框裡的分頁可以用方向鍵切換', async ({ page }) => {
                await page.locator(`${grid} ${button}`).first().click();
                const dialog = page.getByRole('dialog');
                const tab = dialog.getByRole('tab');
                await expect(tab).toHaveCount(2);
                const [first, second] = [tab.nth(0), tab.nth(1)];
                const panelOf = async (t) => dialog.getByRole('tabpanel', { name: await t.textContent(), exact: true });
                await expect(first).toHaveAttribute('aria-selected', 'true');
                await expect(await panelOf(first)).toBeVisible();
                await expect(await panelOf(second)).toBeHidden();

                // 只有選取的分頁在 Tab 順序裡，下一站是它的內容。
                await first.focus();
                await page.keyboard.press('Tab');
                await expect(await panelOf(first)).toBeFocused();

                await first.focus();
                await page.keyboard.press('ArrowRight');
                await expect(second).toBeFocused();
                await expect(second).toHaveAttribute('aria-selected', 'true');
                await expect(first).toHaveAttribute('aria-selected', 'false');
                await expect(await panelOf(second)).toBeVisible();
                await expect(await panelOf(first)).toBeHidden();
                await page.keyboard.press('ArrowRight');
                await expect(first).toBeFocused();
                await page.keyboard.press('End');
                await expect(second).toBeFocused();
                await page.keyboard.press('Home');
                await expect(first).toHaveAttribute('aria-selected', 'true');
                // Alt+方向鍵是瀏覽器的上一頁、下一頁，不能拿來切分頁。
                await page.keyboard.press('Alt+ArrowRight');
                await expect(first).toHaveAttribute('aria-selected', 'true');

                await second.click();
                await expect(second).toHaveAttribute('aria-selected', 'true');
                await expect(await panelOf(second)).toBeVisible();
            });
        }
    });
}

test.describe('研究方法工具箱的推薦', () => {
    test('推薦結果的按鈕開啟對話框，關閉後焦點回到那個按鈕', async ({ page }) => {
        await page.goto(`${ROOT}/autonomous-learning/methodology.html`);
        await expect(page.locator('#methodology-grid h3 > button').first()).toBeVisible();
        await page.getByRole('button', { name: '是', exact: true }).first().click();
        const pick = page.locator('#recommendation-result button').first();
        await pick.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: await pick.textContent(), exact: true });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: '關閉', exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(pick).toBeFocused();
    });
});

test.describe('優質範例藝廊', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(`${ROOT}/learning-portfolio/portfolio-gallery.html`);
        await expect(page.locator('#portfolio-grid h3 > button').first()).toBeVisible();
    });

    test('三個篩選器有名稱，篩選照舊', async ({ page }) => {
        for (const label of ['學科領域', '成果類型', '能力標籤']) {
            await expect(page.getByRole('combobox', { name: label, exact: true })).toBeVisible();
        }
        const category = page.getByLabel('學科領域', { exact: true });
        const value = await category.locator('option').nth(1).getAttribute('value');
        await category.selectOption(value);
        const shown = page.locator('#portfolio-grid > * .text-green-700');
        await expect(shown.first()).toBeVisible();
        for (const text of await shown.allTextContents()) expect(text).toBe(value);
    });

    test('焦點範例的按鈕開啟對話框，關閉後焦點回到它', async ({ page }) => {
        const featured = page.getByRole('button', { name: '深度剖析此範例', exact: true });
        await featured.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(featured).toBeFocused();
    });
});

test.describe('學長姐真心話', () => {
    test('?view= 直接開啟那篇訪談，關閉後焦點回到那張卡片，網址拿掉 view', async ({ page }) => {
        const res = await page.request.get(`${ROOT}/career-exploration/senior-interviews.json`);
        const { interviews } = await res.json();
        const { id, name } = interviews[3];
        await page.goto(`${ROOT}/career-exploration/senior-interviews.html?view=${id}`);
        const dialog = page.getByRole('dialog', { name, exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(page.locator('#interview-grid h2 > button', { hasText: name })).toBeFocused();
        expect(new URL(page.url()).searchParams.has('view')).toBe(false);
        await page.reload();
        await expect(page.locator('#interview-grid h2 > button').first()).toBeVisible();
        await expect(page.getByRole('dialog')).toBeHidden();
    });

    // 第二次用 textarea 的備用作法：Clipboard API 不能用時（非 HTTPS），writeText 會丟錯。
    for (const fallback of [false, true]) {
        test(`複製連結會寫進剪貼簿並通知螢幕閱讀器，焦點留在按鈕上${fallback ? '（沒有 Clipboard API）' : ''}`, async ({ page, context }) => {
            await context.grantPermissions(['clipboard-read', 'clipboard-write']);
            if (fallback) {
                await page.addInitScript(() => {
                    navigator.clipboard.writeText = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
                });
            }
            await page.goto(`${ROOT}/career-exploration/senior-interviews.html`);
            await page.locator('#interview-grid h2 > button').first().click();
            const dialog = page.getByRole('dialog');
            const copy = dialog.getByRole('button', { name: '複製此訪談連結' });
            await copy.focus();
            await page.keyboard.press('Enter');
            await expect(dialog.getByRole('status')).toHaveText('連結已複製！');
            await expect(copy).toBeFocused();
            const copied = await page.evaluate(() => navigator.clipboard.readText());
            expect(new URL(copied).searchParams.get('view')).toBeTruthy();
        });
    }

    test('搜尋之後的卡片一樣能用鍵盤開啟', async ({ page }) => {
        await page.goto(`${ROOT}/career-exploration/senior-interviews.html`);
        await page.getByPlaceholder('搜尋科系、學校或關鍵字...').fill('台大');
        const buttons = page.locator('#interview-grid h2 > button');
        await expect(buttons.first()).toBeVisible();
        expect(await buttons.count()).toBeLessThan(await page.evaluate(() => interviewData.length));
        await buttons.first().focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog', { name: await buttons.first().textContent(), exact: true })).toBeVisible();
    });
});
