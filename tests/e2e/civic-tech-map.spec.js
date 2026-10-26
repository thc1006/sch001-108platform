// 公民科技地圖的專案快速導航：手機上連結列的寬度、還能捲動時的淡出提示、展開／收合全部的兩組按鈕。
// 8001 埠服務的是 .link-root，要先建置。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/civic-tech-map/index.html`;
const PHONES = [{ width: 360, height: 740 }, { width: 390, height: 844 }];
const DESKTOP = { width: 1280, height: 800 };

const nav = (page) => page.getByRole('navigation', { name: '專案快速導航' });
const scroller = (page) => nav(page).locator('[data-scroll-fade]');

test.describe('公民科技地圖：專案快速導航', () => {
    for (const viewport of PHONES) {
        test(`${viewport.width}px：專案連結的捲動區至少佔導航內容寬度的 90%`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await page.goto(PAGE);
            const { content, links } = await nav(page).evaluate((el) => {
                const cs = getComputedStyle(el);
                return {
                    content: el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
                    links: el.querySelector('[data-scroll-fade]').clientWidth,
                };
            });
            expect(links, `捲動區 ${links}px，導航內容 ${content}px`).toBeGreaterThanOrEqual(content * 0.9);
        });
    }

    test('還有連結沒露出的那一側才淡出，捲到底右側的淡出就消失', async ({ page }) => {
        await page.setViewportSize(DESKTOP);
        await page.goto(PAGE);
        const links = scroller(page);
        const mask = () => links.evaluate((el) => getComputedStyle(el).maskImage);
        // 淡出寬度由 --fade-left／--fade-right 決定，mask-image 不是 none 不代表那一側有淡出。
        const fade = (side) => links.evaluate((el, side) => getComputedStyle(el).getPropertyValue(`--fade-${side}`).trim(), side);
        // 1280px 時連結放得下，兩側都不淡出。
        await expect(links).not.toHaveAttribute('data-more-left');
        await expect(links).not.toHaveAttribute('data-more-right');
        expect(await mask()).toBe('none');

        await page.setViewportSize(PHONES[0]);
        await expect(links).toHaveAttribute('data-more-right');
        await expect(links).not.toHaveAttribute('data-more-left');
        expect(await mask()).not.toBe('none');
        expect([await fade('left'), await fade('right')]).toEqual(['', '2rem']);

        await links.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
        await expect(links).not.toHaveAttribute('data-more-right');
        await expect(links).toHaveAttribute('data-more-left');
        expect(await mask()).not.toBe('none');
        expect([await fade('left'), await fade('right')]).toEqual(['2rem', '']);
    });

    /** inset 回傳第 i 個連結的左右緣離 scroll-padding 內緣多遠，負的表示伸進淡出區。 */
    const inset = (page, i) =>
        scroller(page).evaluate((el, i) => {
            const pad = parseFloat(getComputedStyle(el).scrollPaddingLeft);
            const box = el.getBoundingClientRect();
            const r = el.querySelectorAll('a')[i].getBoundingClientRect();
            return { left: r.left - (box.left + pad), right: box.right - pad - r.right, width: r.width };
        }, i);

    // Chromium 對只露出一部分的連結不捲動。先讓下一個連結只有 20px 在 scroll-padding 以內，再按鍵。
    for (const [key, from, to] of [['Tab', 3, 4], ['Shift+Tab', 4, 3]]) {
        test(`360px：${key} 到只露出一部分的連結，連結捲到淡出區外`, async ({ page }) => {
            await page.setViewportSize(PHONES[0]);
            await page.goto(PAGE);
            const links = scroller(page).locator('a');
            await links.nth(from).focus();
            const before = await inset(page, to);
            const side = key === 'Tab' ? 'right' : 'left';
            // scrollLeft 加 dx，連結往左移 dx：right 變大、left 變小。
            const dx = side === 'right' ? 20 - before.width - before.right : before.left + before.width - 20;
            await scroller(page).evaluate((el, dx) => { el.scrollLeft += dx; }, dx);
            expect((await inset(page, to))[side], '前置：連結只有 20px 在 scroll-padding 以內').toBeCloseTo(20 - before.width, 0);

            await page.keyboard.press(key);
            await expect(links.nth(to)).toBeFocused();
            const after = await inset(page, to);
            // -0.5 是 Chromium 的捨入。WebKit 27.2 會捲到剛好貼齊 scroll-padding，加 WebKit project 時要放寬。
            expect(after.left, '連結左緣在淡出區裡').toBeGreaterThanOrEqual(-0.5);
            expect(after.right, '連結右緣在淡出區裡').toBeGreaterThanOrEqual(-0.5);
        });
    }

    // 滑鼠和觸控在 mousedown 時就讓連結取得焦點。這時捲動連結列，mouseup 會落在別處，點擊不算數。
    for (const hasTouch of [false, true]) {
        test.describe(() => {
            test.use({ hasTouch });
            test(`360px：${hasTouch ? '觸控' : '滑鼠點'}只露出一部分的連結，照樣跳到該專案`, async ({ page }) => {
                await page.setViewportSize(PHONES[0]);
                await page.goto(PAGE);
                // 導航捲到畫面上緣往下 300px，還沒釘住；點的座標要在畫面裡。
                await nav(page).evaluate((el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 300, behavior: 'instant' }));
                const before = await inset(page, 4);
                // 第 5 個連結（立法足跡）只露出 40px，點在露出部分的中間。
                const dx = 40 - before.width - before.right - (await scroller(page).evaluate((el) => parseFloat(getComputedStyle(el).scrollPaddingLeft)));
                await scroller(page).evaluate((el, dx) => { el.scrollLeft += dx; }, dx);
                const edge = await scroller(page).evaluate((el) => el.getBoundingClientRect().right);
                const link = await scroller(page).locator('a').nth(4).boundingBox();
                expect(edge - link.x, '前置：連結只露出 40px').toBeCloseTo(40, 0);

                const [x, y] = [edge - 20, link.y + link.height / 2];
                const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href'), [x, y]);
                expect(hit, '前置：點的位置在立法足跡上').toBe('#lawtrace');
                if (hasTouch) await page.touchscreen.tap(x, y);
                else await page.mouse.click(x, y);
                await expect(page).toHaveURL(/#lawtrace$/);
            });
        });
    }

    test('捲動區不當 Tab 停駐點，焦點落在捲動區本身時不捲動', async ({ page }) => {
        await page.setViewportSize(PHONES[0]);
        await page.goto(PAGE);
        await expect(scroller(page)).toHaveAttribute('tabindex', '-1');
        // 先按一次 Tab 進入鍵盤模式，再用程式讓捲動區取得焦點，模擬 Firefox 157 停在 div 上的情況。
        await page.keyboard.press('Tab');
        const r = await scroller(page).evaluate((el) => {
            el.scrollLeft = 200;
            const before = el.scrollLeft;
            el.focus();
            return { before, after: el.scrollLeft, visible: el.matches(':focus-visible') };
        });
        expect(r.visible, '前置：捲動區是鍵盤焦點').toBe(true);
        expect(r.after).toBe(r.before);
    });

    test('Tab 到連結時焦點框上下都在捲動區裡，不被裁掉', async ({ page }) => {
        await page.setViewportSize(PHONES[0]);
        await page.goto(PAGE);
        await page.keyboard.press('Tab');
        await scroller(page).locator('a').first().focus();
        const r = await scroller(page).evaluate((el) => {
            const a = document.activeElement;
            const cs = getComputedStyle(a);
            const ring = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
            const box = el.getBoundingClientRect(), link = a.getBoundingClientRect();
            return { style: cs.outlineStyle, top: link.top - ring - box.top, bottom: box.bottom - (link.bottom + ring) };
        });
        expect(r.style, '前置：連結畫出焦點框').not.toBe('none');
        expect(r.top, '焦點框上緣被裁掉').toBeGreaterThanOrEqual(-0.5);
        expect(r.bottom, '焦點框下緣被裁掉').toBeGreaterThanOrEqual(-0.5);
    });

    // 只改一邊的斷點，639 或 640px 兩組按鈕會同時出現或同時消失。
    for (const width of [639, 640]) {
        test(`${width}px：展開／收合全部只出現一組`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await page.goto(PAGE);
            await expect(page.getByRole('button', { name: '展開全部詳情' })).toHaveCount(1);
            await expect(page.getByRole('button', { name: '收合全部詳情' })).toHaveCount(1);
            await expect(nav(page).getByRole('button')).toHaveCount(width >= 640 ? 2 : 0);
        });
    }

    for (const [label, viewport, inNav] of [['手機', PHONES[0], false], ['桌機', DESKTOP, true]]) {
        test(`${label}：展開／收合全部${inNav ? '在導航列右側' : '在專案列表上方，不在 sticky 導航裡'}`, async ({ page }) => {
            await page.setViewportSize(viewport);
            await page.goto(PAGE);
            const expand = page.getByRole('button', { name: '展開全部詳情' });
            const collapse = page.getByRole('button', { name: '收合全部詳情' });
            // getByRole 只找得到看得見的那一組，另一組是 display: none。
            await expect(expand).toHaveCount(1);
            await expect(collapse).toHaveCount(1);
            await expect(nav(page).getByRole('button')).toHaveCount(inNav ? 2 : 0);
            if (!inNav) {
                const row = await expand.evaluate((el) => {
                    const list = document.getElementById('project-list').getBoundingClientRect();
                    return { position: getComputedStyle(el.parentElement).position, bottom: el.getBoundingClientRect().bottom, listTop: list.top };
                });
                expect(row.position).toBe('static');
                expect(row.bottom).toBeLessThanOrEqual(row.listTop);
            }

            const toggles = page.locator('.details-toggle');
            const count = await toggles.count();
            expect(count).toBeGreaterThan(0);
            await expand.click();
            await expect(page.locator('.details-toggle[aria-expanded="true"]')).toHaveCount(count);
            await expect(page.locator('.details-content.open')).toHaveCount(count);
            await collapse.click();
            await expect(page.locator('.details-toggle[aria-expanded="false"]')).toHaveCount(count);
            await expect(page.locator('.details-content.open')).toHaveCount(0);
        });
    }
});
