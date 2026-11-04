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

        test('「關閉」按鈕至少 24x24', async ({ page }) => {
            await page.locator(`${grid} ${button}`).first().click();
            const box = await page.getByRole('dialog').getByRole('button', { name: '關閉' }).boundingBox();
            expect(box.width).toBeGreaterThanOrEqual(24);
            expect(box.height).toBeGreaterThanOrEqual(24);
        });

        test('320x256 能讀的區域至少有視窗高度的六成，捲到底看得到內文最後一段', async ({ page }) => {
            await page.setViewportSize({ width: 320, height: 256 });
            await page.locator(`${grid} ${button}`).first().click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            const m = await dialog.evaluate((d) => {
                // 從內文區往上找真的在捲的那一層，量它的高度；捲到底之後內文最後一個元素要在它裡面。
                const body = d.querySelector(':scope > .overflow-y-auto');
                let box = body;
                while (box !== d && !(/auto|scroll/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 1)) box = box.parentElement;
                box.scrollTop = box.scrollHeight;
                const last = [...body.querySelectorAll('*')].filter((el) => el.checkVisibility()).pop();
                return { area: box.clientHeight, lastBottom: last.getBoundingClientRect().bottom, boxBottom: box.getBoundingClientRect().bottom };
            });
            expect(m.area).toBeGreaterThanOrEqual(256 * 0.6);
            expect(m.lastBottom).toBeLessThanOrEqual(m.boxBottom + 1);
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

// 競賽頁只有填了 details 的卡片有按鈕，所以不放進上面的 PAGES，那一組的檢查在這裡照做一次。資料換成固定的幾筆。
test.describe('國內外競賽的詳細資訊', () => {
    const entry = (title, fields) => ({
        title, organizer: '主辦單位', category: '資訊', level: '全國', form: '個人', region: '台灣',
        eligibility: '公開報名', mode: '線上', url: 'https://example.com/', description: `${title}的摘要`, ...fields,
    });
    const LONG = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 段寫報名方式、評分標準和獎項，字數多到對話框要捲動才看得完。`).join('\n');
    // 真實資料的名稱中位數 16 字，最長 62 字。
    const LONG_TITLE = 'Wharton Global High School Investment Competition 華頓商學院全球高中生投資競賽（線上）';
    const COMPETITIONS = [
        entry('沒有詳細資訊', {}),
        entry('有詳細資訊', { details: '第一段。\n第二段寫報名方式，只有這裡有甲乙丙。\n\n第三段。\n<b>x</b>', sourceCheckedAt: '2026-11-01' }),
        entry('詳細資訊是空字串', { details: '' }),
        entry('詳細資訊只有空白', { details: '  \n ' }),
        entry('詳細資訊很長', { details: LONG }),
        entry(LONG_TITLE, { details: LONG }),
    ];
    /** opener 回傳名稱是 title 的卡片上的「詳細資訊」按鈕。 */
    const opener = (page, title) =>
        page.locator('.comp-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button');

    test.beforeEach(async ({ page }) => {
        await page.route('**/advanced-resources/competitions.json', (route) => route.fulfill({ json: { competitions: COMPETITIONS } }));
        await page.goto(`${ROOT}/advanced-resources/competitions.html`);
        await expect(page.locator('.comp-card')).toHaveCount(COMPETITIONS.length);
    });

    test('只有 details 不是空白的卡片有按鈕', async ({ page }) => {
        const titles = await page.locator('.comp-card').evaluateAll((cards) =>
            cards.filter((c) => c.querySelector('button')).map((c) => c.querySelector('h2').textContent));
        expect(titles).toEqual(['有詳細資訊', '詳細資訊很長', LONG_TITLE]);
        // sr-only 的文字前後，Chromium 算名稱時會補空白。
        await expect(opener(page, '有詳細資訊')).toHaveAccessibleName(/^詳細資訊\s?：有詳細資訊$/);
        await expect(opener(page, '有詳細資訊')).toHaveAttribute('aria-haspopup', 'dialog');
    });

    test('畫面上類型與狀態在名稱上面，DOM 裡名稱在前面', async ({ page }) => {
        const card = page.locator('.comp-card').first();
        const top = (sel) => card.locator(sel).evaluate((el) => el.getBoundingClientRect().top);
        expect(await top('.comp-kicker')).toBeLessThan(await top('h2'));
        expect(await card.locator('.comp-card__body > *').first().evaluate((el) => el.matches('h2.comp-card__title'))).toBe(true);
    });

    test('Enter 開啟，焦點移進對話框，details 一行一段，Esc 關閉後回到按鈕', async ({ page }) => {
        const button = opener(page, '有詳細資訊');
        await button.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog', { name: '有詳細資訊', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toBeFocused();
        await expect(dialog.locator('.comp-dialog__details p')).toHaveText(['第一段。', '第二段寫報名方式，只有這裡有甲乙丙。', '第三段。', '<b>x</b>']);
        // details 是純文字，標籤照原樣顯示，不產生元素。
        await expect(dialog.locator('b')).toHaveCount(0);
        await expect(dialog.getByRole('link')).toHaveAccessibleName(/^前往官網\s?：有詳細資訊（另開新分頁）$/);
        await expect(dialog.locator('.comp-checked')).toHaveText('官網查證 2026-11-01');
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(button).toBeFocused();
        await expect(page.locator('#comp-dialog')).toBeEmpty();
    });

    test('空白鍵開啟，按「關閉」後回到按鈕，開著時 Tab 不會離開對話框', async ({ page }) => {
        const button = opener(page, '有詳細資訊');
        await button.focus();
        await page.keyboard.press('Space');
        const dialog = page.getByRole('dialog', { name: '有詳細資訊', exact: true });
        await expect(dialog).toBeVisible();
        // 背景是 inert，焦點只會在對話框裡，或是離開頁面時的 <body>。
        for (let i = 0; i < 12; i++) {
            await page.keyboard.press('Tab');
            const where = await dialog.evaluate((d) => d.contains(document.activeElement) || document.activeElement === document.body);
            expect(where).toBe(true);
        }
        // 頂端的 × 和最後面的「關閉」都叫「關閉」。
        const close = dialog.getByRole('button', { name: '關閉', exact: true }).first();
        await expect(close.locator('span')).toHaveAttribute('aria-hidden', 'true');
        const box = await close.boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(24);
        expect(box.height).toBeGreaterThanOrEqual(24);
        await close.focus();
        await page.keyboard.press('Enter');
        await expect(dialog).toBeHidden();
        await expect(button).toBeFocused();
    });

    test('Tab 順序是 ×、「前往官網」、「關閉」；320x256 捲到底按「關閉」，焦點回到按鈕', async ({ page }) => {
        const button = opener(page, LONG_TITLE);
        await button.focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeFocused();
        const closes = dialog.getByRole('button', { name: '關閉', exact: true });
        await expect(closes).toHaveCount(2);
        await page.keyboard.press('Tab');
        await expect(closes.first()).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(dialog.getByRole('link')).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(closes.last()).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(button).toBeFocused();

        await page.setViewportSize({ width: 320, height: 256 });
        await page.keyboard.press('Enter');
        await expect(dialog).toBeVisible();
        await dialog.evaluate((d) => { d.scrollTop = d.scrollHeight; });
        const end = closes.last();
        const box = await end.boundingBox();
        expect(box.y + box.height).toBeLessThanOrEqual(256);
        await end.click();
        await expect(dialog).toBeHidden();
        await expect(button).toBeFocused();
    });

    test('點對話框外面關閉，從對話框裡拖曳到外面放開不算', async ({ page }) => {
        const button = opener(page, '有詳細資訊');
        await button.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        const inner = await dialog.boundingBox();
        await page.mouse.move(inner.x + 20, inner.y + 20);
        await page.mouse.down();
        await page.mouse.move(5, 5);
        await page.mouse.up();
        await expect(dialog).toBeVisible();
        await page.mouse.click(5, 5);
        await expect(dialog).toBeHidden();
        await expect(button).toBeFocused();
    });

    test('開著時頁面不捲動，關閉後捲動位置不變', async ({ page }) => {
        // 置中時按鈕要在釘住的篩選面板下面，click 才不會為了避開面板再捲一次。
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.locator('#competition-grid').evaluate((g) => Promise.all(g.getAnimations({ subtree: true }).map((a) => a.finished)));
        const button = opener(page, '詳細資訊很長');
        await button.scrollIntoViewIfNeeded();
        const y = await page.evaluate(() => window.scrollY);
        expect(y, '前置：頁面要捲過').toBeGreaterThan(0);
        await button.click();
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

    test('320x256 也捲得到對話框最後的「前往官網」，內容短時不會多出捲軸', async ({ page }) => {
        await opener(page, '有詳細資訊').click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate((d) => d.scrollHeight - d.clientHeight)).toBe(0);
        await page.keyboard.press('Escape');

        await page.setViewportSize({ width: 320, height: 256 });
        await opener(page, LONG_TITLE).click();
        const link = dialog.getByRole('link');
        await link.scrollIntoViewIfNeeded();
        const box = await link.boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(256);
    });

    test('Enter 開啟後按 PageDown，捲動的是對話框', async ({ page }) => {
        await opener(page, '詳細資訊很長').focus();
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeFocused();
        await page.keyboard.press('PageDown');
        await expect.poll(() => dialog.evaluate((d) => d.scrollTop)).toBeGreaterThan(0);
    });

    for (const { width, height, zoom } of [{ width: 320, height: 256 }, { width: 360, height: 640, zoom: true }, { width: 1280, height: 720, zoom: true }]) {
        test(`${width}x${height}${zoom ? ' 只放大文字到 200%' : ''}：能讀的區域至少有視窗高度的六成，捲到底看得到最後一段`, async ({ page }) => {
            await page.setViewportSize({ width, height });
            await opener(page, LONG_TITLE).click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            if (zoom) await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
            const m = await dialog.evaluate((d) => {
                // 從內文區往上找真的在捲的那一層，量它的高度；捲到底之後內文最後一個元素要在它裡面。
                const body = d.querySelector('.comp-dialog__body');
                let box = body;
                while (box !== d && !(/auto|scroll/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight + 1)) box = box.parentElement;
                box.scrollTop = box.scrollHeight;
                const last = [...body.querySelectorAll('*')].filter((el) => el.checkVisibility()).pop();
                return { area: box.clientHeight, lastBottom: last.getBoundingClientRect().bottom, boxBottom: box.getBoundingClientRect().bottom };
            });
            expect(m.area).toBeGreaterThanOrEqual(height * 0.6);
            expect(m.lastBottom).toBeLessThanOrEqual(m.boxBottom + 1);
        });
    }

    for (const width of [1280, 320]) {
        test(`${width}px 打開對話框後只放大文字到 200%，裡面的字不超出右緣`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            // 先開再放大：先放大的話，釘住的篩選面板會蓋住卡片上的按鈕。
            await opener(page, '有詳細資訊').click();
            const dialog = page.getByRole('dialog');
            await expect(dialog).toBeVisible();
            await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
            const out = await dialog.evaluate((d) => {
                const right = d.getBoundingClientRect().right;
                const bad = d.scrollWidth > d.clientWidth + 1 ? [`寬 ${d.scrollWidth} > ${d.clientWidth}`] : [];
                const walker = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
                for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                    if (!n.textContent.trim() || n.parentElement.closest('.sr-only')) continue;
                    const range = document.createRange();
                    range.selectNodeContents(n);
                    if ([...range.getClientRects()].some((r) => r.right > right + 1)) bad.push(n.textContent.trim().slice(0, 20));
                }
                return bad;
            });
            expect(out).toEqual([]);
        });
    }

    // 篩選後卡片在畫面上的順序和資料的順序不同，按鈕要開它自己那一筆，關閉後焦點回到它。
    test('搜尋之後開啟，對話框是那張卡片的，關閉後焦點回到它的按鈕', async ({ page }) => {
        await page.locator('#search-input').fill('很長');
        await expect(page.locator('.comp-card h2')).toHaveText(['詳細資訊很長']);
        const button = opener(page, '詳細資訊很長');
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('dialog', { name: '詳細資訊很長', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(button).toBeFocused();
    });

    // 搜尋框停 160ms 才重新渲染卡片，這段時間內開啟對話框，按鈕會在對話框開著時被換掉。
    for (const [term, where] of [['', '同一筆的新按鈕'], ['很長', '搜尋框']]) {
        test(`開著時卡片被重新渲染，關閉後焦點交給${where}`, async ({ page }) => {
            const button = opener(page, '有詳細資訊');
            await button.click();
            await expect(page.getByRole('dialog')).toBeVisible();
            const old = await button.elementHandle();
            await page.locator('#search-input').evaluate((el, t) => { el.value = t; el.dispatchEvent(new Event('input')); }, term);
            await expect.poll(() => old.evaluate((el) => el.isConnected)).toBe(false);
            await page.keyboard.press('Escape');
            await expect(page.getByRole('dialog')).toBeHidden();
            await expect(term ? page.locator('#search-input') : opener(page, '有詳細資訊')).toBeFocused();
        });
    }

    test('搜尋只出現在 details 的字也找得到那張卡片', async ({ page }) => {
        await page.locator('#search-input').fill('甲乙丙');
        await expect(page.locator('.comp-card h2')).toHaveText(['有詳細資訊']);
    });
});

// 擁有者要同一列的卡片長度一致：摘要和截止欄的行數不同時，「詳細資訊」和截止欄仍要對齊。
test.describe('國內外競賽卡片同一列對齊', () => {
    const NOTES = ['由學校報名', '經各縣市初賽選拔後由學校統一報名，不受理個人報名'];
    const COMPETITIONS = [1, 8, 3, 6, 1, 4].map((n, i) => ({
        title: `第 ${i + 1} 項競賽`, organizer: '主辦單位', category: '資訊', level: '全國', form: '個人', region: '台灣',
        eligibility: '公開報名', mode: '線上', url: 'https://example.com/',
        description: '這一段摘要的長度每張不同。'.repeat(n), details: '詳細內容。', registrationNote: NOTES[i % 2],
    }));

    for (const width of [1280, 768]) {
        test(`${width}px：同一列卡片的「詳細資訊」與截止欄 top 相同`, async ({ page }) => {
            await page.setViewportSize({ width, height: 900 });
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.route('**/advanced-resources/competitions.json', (route) => route.fulfill({ json: { competitions: COMPETITIONS } }));
            await page.goto(`${ROOT}/advanced-resources/competitions.html`);
            await expect(page.locator('.comp-card .comp-more')).toHaveCount(COMPETITIONS.length);
            const rows = await page.locator('.comp-card').evaluateAll((cards) => {
                const byRow = new Map();
                for (const c of cards) {
                    const top = Math.round(c.getBoundingClientRect().top);
                    const at = (sel) => c.querySelector(sel).getBoundingClientRect();
                    if (!byRow.has(top)) byRow.set(top, []);
                    byRow.get(top).push({ more: at('.comp-more').top, foot: at('.comp-foot').top, desc: at('.comp-card__desc').height });
                }
                return [...byRow.values()];
            });
            const wide = rows.filter((r) => r.length > 1);
            expect(wide.length, '前置：要有兩張以上卡片排在同一列').toBeGreaterThan(0);
            expect(wide.some((r) => new Set(r.map((c) => Math.round(c.desc))).size > 1), '前置：同一列的摘要高度要不同').toBe(true);
            for (const r of wide) {
                for (const key of ['more', 'foot']) {
                    const tops = r.map((c) => c[key]);
                    expect(Math.max(...tops) - Math.min(...tops), key).toBeLessThanOrEqual(1);
                }
            }
        });
    }
});

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
        const featured = page.getByRole('button', { name: '看這份範例的分析', exact: true });
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
    test('卡片上的大頭照是裝飾，化名只在按鈕唸一次', async ({ page }) => {
        await page.goto(`${ROOT}/career-exploration/senior-interviews.html`);
        const cards = page.locator('#interview-grid > *');
        await expect(cards.first()).toBeVisible();
        const alts = await cards.locator('img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('alt')));
        expect(alts.length).toBe(await cards.count());
        expect(alts.filter((alt) => alt !== '')).toEqual([]);
    });

    test('對話框裡的大頭照是裝飾，名字只在標題唸一次', async ({ page }) => {
        await page.goto(`${ROOT}/career-exploration/senior-interviews.html`);
        await page.locator('#interview-grid h2 > button').first().click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.locator('img')).toHaveAttribute('alt', '');
    });

    test('對話框「關閉」按鈕裡的圖示不給螢幕閱讀器', async ({ page }) => {
        await page.goto(`${ROOT}/career-exploration/senior-interviews.html`);
        await page.locator('#interview-grid h2 > button').first().click();
        const close = page.getByRole('dialog').getByRole('button', { name: '關閉' });
        await expect(close.locator('svg')).toHaveAttribute('aria-hidden', 'true');
    });

    test('搜尋框、探索 TIPS、複製連結按鈕的圖示也不給螢幕閱讀器', async ({ page }) => {
        await page.goto(`${ROOT}/career-exploration/senior-interviews.html`);
        await page.locator('#interview-grid h2 > button').first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        const icons = page.locator('svg.feather');
        expect(await icons.count()).toBeGreaterThan(3);
        expect(await icons.evaluateAll((svgs) => svgs.filter((s) => s.getAttribute('aria-hidden') !== 'true').map((s) => s.getAttribute('class')))).toEqual([]);
    });

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
