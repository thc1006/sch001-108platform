// 低視能與鍵盤使用者：焦點不被 sticky header 或篩選面板整個蓋住、面板放得進視窗、文字對比、
// 減少動態偏好、強制色彩模式下的焦點、矮視窗的手機選單。
const { test, expect } = require('@playwright/test');
const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const P = (p) => `${BASE}/sch001-108platform/${p}`;

/** frames 等三個 animation frame，sticky-filters.js 在 rAF 裡改面板的位置。 */
const frames = (page) =>
    page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));

/**
 * covered 回傳焦點元素上取樣的 9 個點裡，有幾個被別的元素蓋住或在視窗外。9 表示整個看不到。
 * 寬或高是 0 的元素（例如還沒展開的跳至主要內容）回傳 0。
 */
const covered = (page) =>
    page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return { hidden: 0 };
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return { hidden: 0 };
        let hidden = 0;
        for (const fx of [0.1, 0.5, 0.9]) {
            for (const fy of [0.15, 0.5, 0.85]) {
                const x = r.left + r.width * fx;
                const y = r.top + r.height * fy;
                const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y);
                if (!hit || !(hit === el || el.contains(hit) || hit.contains(el))) hidden++;
            }
        }
        const text = (el.textContent || el.getAttribute('aria-label') || el.id).replace(/\s+/g, ' ').trim().slice(0, 20);
        return { hidden, what: `${el.tagName.toLowerCase()}「${text}」 top=${Math.round(r.top)}` };
    });

test.describe('焦點不會整個被 sticky header 或篩選面板蓋住', () => {
    test.describe.configure({ timeout: 120_000 });
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    const PAGES = [
        'index.html',
        'advanced-resources/competitions.html',
        'advanced-resources/reading-list.html',
        'autonomous-learning/resource-map.html',
        'career-exploration/clusters/info/overview.html',
        'career-exploration/competency-map.html',
    ];
    for (const viewport of [{ width: 1280, height: 900 }, { width: 320, height: 256 }]) {
        for (const rel of PAGES) {
            test(`${rel} ${viewport.width}x${viewport.height}：Tab 從頁首、Shift+Tab 從頁尾各走 60 步`, async ({ page }) => {
                await page.setViewportSize(viewport);
                await page.goto(P(rel), { waitUntil: 'networkidle' });
                const bad = [];
                let stops = 0;
                for (const key of ['Tab', 'Shift+Tab']) {
                    if (key === 'Shift+Tab') {
                        // 從頁尾最後面往回走。
                        await page.evaluate(() => {
                            const end = document.createElement('button');
                            end.textContent = 'end';
                            document.querySelector('footer').append(end);
                            end.focus();
                        });
                    } else {
                        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
                    }
                    const seen = new Set();
                    // 每個方向走 60 個就夠涵蓋 header、篩選面板和面板後面的卡片，競賽頁全部走完要好幾分鐘。
                    for (let i = 0; i < 60; i++) {
                        await page.keyboard.press(key);
                        await frames(page);
                        const id = await page.evaluate(() => {
                            const el = document.activeElement;
                            if (!el.__lvId) el.__lvId = Math.random();
                            return el.__lvId;
                        });
                        if (seen.has(id)) break;
                        seen.add(id);
                        stops++;
                        const c = await covered(page);
                        if (c.hidden === 9) bad.push(`${key} ${c.what}`);
                    }
                }
                expect(stops, '前置：要走過可以聚焦的元素').toBeGreaterThan(10);
                expect(bad, '焦點整個被蓋住').toEqual([]);
            });
        }
    }
});

test.describe('矮視窗的篩選面板', () => {
    const PAGES = [
        'advanced-resources/competitions.html',
        'advanced-resources/online-courses.html',
        'advanced-resources/reading-list.html',
        'autonomous-learning/resource-map.html',
        'career-exploration/competency-map.html',
        'career-exploration/senior-interviews.html',
        'learning-portfolio/activity-database.html',
        'learning-portfolio/portfolio-gallery.html',
    ];
    /** panel 回傳面板的 position，以及釘住時面板下緣在視窗高度的比例。 */
    const panel = (page) =>
        page.locator('[data-autohide-filters]').evaluate((el) => ({
            position: getComputedStyle(el).position,
            share: (parseFloat(getComputedStyle(el).top) + el.getBoundingClientRect().height) / innerHeight,
        }));
    for (const viewport of [{ width: 320, height: 256 }, { width: 740, height: 360 }]) {
        for (const rel of PAGES) {
            test(`${rel} ${viewport.width}x${viewport.height}：釘住的面板加上 header 最多佔視窗的 3/4`, async ({ page }) => {
                await page.setViewportSize(viewport);
                await page.goto(P(rel), { waitUntil: 'networkidle' });
                const m = await panel(page);
                if (m.position === 'sticky') expect(m.share).toBeLessThanOrEqual(3 / 4);
                else expect(m.position).toBe('static');
            });
        }
    }

    // 手機直立時面板照舊釘住，往下捲讓開、往上捲回來。
    for (const viewport of [{ width: 360, height: 640 }, { width: 360, height: 740 }]) {
        test(`${viewport.width}x${viewport.height}：每一頁的面板都釘住`, async ({ page }) => {
            await page.setViewportSize(viewport);
            for (const rel of PAGES) {
                await page.goto(P(rel), { waitUntil: 'networkidle' });
                expect((await panel(page)).position, rel).toBe('sticky');
            }
        });
    }

    test('390x844 轉成 844x390 時焦點在面板裡，照樣重新決定要不要釘住', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(P('advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        await page.locator('#search-input').focus();
        expect((await panel(page)).position, '前置：直立時釘住').toBe('sticky');
        await page.setViewportSize({ width: 844, height: 390 });
        await frames(page);
        const m = await panel(page);
        if (m.position === 'sticky') expect(m.share).toBeLessThanOrEqual(3 / 4);
    });

    test('面板放不進視窗時不釘住，視窗變高之後又釘住', async ({ page }) => {
        await page.setViewportSize({ width: 320, height: 256 });
        await page.goto(P('advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        expect((await panel(page)).position).toBe('static');
        await page.setViewportSize({ width: 320, height: 800 });
        await expect.poll(async () => (await panel(page)).position).toBe('sticky');
    });

    // 手機網址列收起、螢幕鍵盤彈出都只改視窗高度，面板不能跟著切換釘住，搜尋框也不能跳走。
    test('360x740 只把視窗變矮時，面板維持釘住，搜尋框不動', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await page.goto(P('advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        await page.locator('.comp-card').first().waitFor();
        await page.evaluate(() => window.scrollTo({ top: 2000, behavior: 'instant' }));
        await page.locator('#search-input').focus();
        const before = await page.locator('#search-input').evaluate((el) => el.getBoundingClientRect().top);
        await page.setViewportSize({ width: 360, height: 400 });
        await frames(page);
        expect((await panel(page)).position).toBe('sticky');
        expect(await page.locator('#search-input').evaluate((el) => el.getBoundingClientRect().top)).toBeCloseTo(before, 0);
        await page.locator('#search-input').blur();
        await page.setViewportSize({ width: 360, height: 700 });
        await frames(page);
        expect((await panel(page)).position, '比看過的最大高度矮也不切換').toBe('sticky');
    });

    // 分割畫面或把桌機視窗拉矮時沒有在打字，照現在的高度重新決定。
    test('360x740 拉矮成 360x400、焦點不在輸入框時，面板不再佔掉 3/4 以上', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        for (const rel of ['advanced-resources/competitions.html', 'advanced-resources/online-courses.html']) {
            await page.goto(P(rel), { waitUntil: 'networkidle' });
            expect((await panel(page)).position, `${rel} 前置：釘住`).toBe('sticky');
            await page.setViewportSize({ width: 360, height: 400 });
            await frames(page);
            const m = await panel(page);
            if (m.position === 'sticky') expect(m.share, rel).toBeLessThanOrEqual(3 / 4);
            await page.setViewportSize({ width: 360, height: 740 });
        }
    });

    // 面板正在滑回來時（位移還是負的），焦點移到它後面的元素也不能停在它底下。
    test('resource-map 390x844：每 400ms 按一次 Shift+Tab，焦點不會整個被正在滑回來的面板蓋住', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(P('autonomous-learning/resource-map.html'), { waitUntil: 'networkidle' });
        // 先瞬間捲到頁底，不然第一次按鍵時平滑捲動還沒停。
        await page.evaluate(() => {
            const end = document.createElement('button');
            end.textContent = 'end';
            document.querySelector('footer').append(end);
            end.focus({ preventScroll: true });
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        });
        const bad = [];
        for (let i = 0; i < 40; i++) {
            await page.keyboard.press('Shift+Tab');
            await page.waitForTimeout(400);
            const c = await covered(page);
            if (c.hidden === 9) bad.push(c.what);
        }
        expect(bad).toEqual([]);
    });

    test('competitions 1280x900：焦點離開後拿掉讓開面板用的 scroll-padding', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(P('advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        await page.locator('.comp-card').first().waitFor();
        // 捲到面板釘住，在面板後面第一個連結前面放一個按鈕，從它 Tab 到連結。
        await page.locator('[data-autohide-filters]').evaluate((panel) => {
            window.scrollTo({ top: panel.getBoundingClientRect().top + scrollY - 64 + 300, behavior: 'instant' });
            const link = [...document.querySelectorAll('main a[href]')].find(
                (a) => a.checkVisibility() && panel.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING,
            );
            const before = document.createElement('button');
            before.textContent = 'before';
            link.before(before);
            before.focus({ preventScroll: true });
        });
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.documentElement.style.scrollPaddingTop), '前置：面板釘住時 pad() 有設').not.toBe('');
        await page.evaluate(() => document.activeElement.blur());
        expect(await page.evaluate(() => document.documentElement.style.scrollPaddingTop)).toBe('');
    });
});

/**
 * 在頁面裡把任何 CSS 顏色轉成 [r, g, b, a]，再算 WCAG 對比。Tailwind v4 的顏色是 oklch()，預設的 placeholder
 * 是半透明的 color-mix()，前景色要先疊到背景色上再算。
 */
const CONTRAST = `
    const rgba = (c) => {
        const cv = document.createElement('canvas').getContext('2d');
        cv.fillStyle = '#000';
        cv.fillStyle = c;
        cv.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
    };
    const lum = ([r, g, b]) => {
        const [x, y, z] = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * x + 0.7152 * y + 0.0722 * z;
    };
    window.__ratio = (fg, bg) => {
        const b = rgba(bg);
        const f = rgba(fg);
        const over = f.slice(0, 3).map((v, i) => v * f[3] + b[i] * (1 - f[3]));
        const [x, y] = [lum(over), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
    };
    window.__stops = (bg) => bg.match(/(rgba?|oklch|oklab)\\([^)]*\\)|#[0-9a-f]{3,8}\\b/gi) || [];
`;

test.describe('文字對比', () => {
    test('漸層標題字兩端在白底與 gray-100 底上都有 4.5:1', async ({ page }) => {
        for (const [rel, selector, backgrounds] of [
            ['index.html', '.gradient-text', ['#ffffff', '#f3f4f6']],
            ['advanced-resources/index.html', '.gradient-text-advanced', ['#ffffff', '#f3f4f6']],
            ['advanced-resources/competitions.html', '.comp-title__accent', ['#ffffff', '#eef4ff']],
        ]) {
            await page.goto(P(rel));
            await page.addScriptTag({ content: CONTRAST });
            const ratios = await page.locator(selector).first().evaluate((el, bgs) => {
                const stops = window.__stops(getComputedStyle(el).backgroundImage);
                return { stops, ratios: stops.flatMap((s) => bgs.map((bg) => window.__ratio(s, bg))) };
            }, backgrounds);
            expect(ratios.stops.length, `${rel}：讀不到漸層的顏色`).toBe(2);
            for (const r of ratios.ratios) expect(r, `${rel} ${selector} ${ratios.stops.join(' → ')}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    test('頁尾的版權文字有 4.5:1', async ({ page }) => {
        await page.goto(P('index.html'));
        await page.addScriptTag({ content: CONTRAST });
        const r = await page.locator('footer').getByText('All Rights Reserved').evaluate((el) =>
            window.__ratio(getComputedStyle(el).color, getComputedStyle(el.closest('footer')).backgroundColor),
        );
        expect(r).toBeGreaterThanOrEqual(4.5);
    });

    test('白底輸入框的 placeholder 有 4.5:1', async ({ page }) => {
        await page.goto(P('autonomous-learning/topic-ideas.html'));
        await page.addScriptTag({ content: CONTRAST });
        const r = await page.locator('#ideaInput').evaluate((el) => window.__ratio(getComputedStyle(el, '::placeholder').color, '#ffffff'));
        expect(r).toBeGreaterThanOrEqual(4.5);
    });
});

test.describe('減少動態偏好', () => {
    test('不平滑捲動，首頁的 SVG 動畫不播', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(P('index.html'));
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
        expect(await page.evaluate(() => document.getAnimations().map((a) => a.animationName))).toEqual([]);
    });

    test('沒有偏好時平滑捲動，首頁的 SVG 動畫 5 秒內停下（WCAG 2.2.2）', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.goto(P('index.html'));
        expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('smooth');
        const ends = await page.evaluate(() => document.getAnimations().map((a) => a.effect.getComputedTiming().endTime));
        expect(ends.length, '前置：首頁有 SVG 動畫').toBeGreaterThan(0);
        for (const end of ends) expect(end).toBeLessThanOrEqual(5000);
    });
});

test('強制色彩模式下，輸入框與下拉選單取得焦點時有外框', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    for (const [rel, selectors] of [
        ['advanced-resources/competitions.html', ['#search-input', '#sort-select']],
        ['autonomous-learning/resource-map.html', ['#search-input', '#category-filter']],
        ['career-exploration/index.html', ['#search-bar', '#chat-input']],
    ]) {
        await page.goto(P(rel));
        for (const selector of selectors) {
            const outline = await page.locator(selector).evaluate((el) => {
                el.focus();
                const cs = getComputedStyle(el);
                return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
            });
            expect(outline.style, `${rel} ${selector}`).not.toBe('none');
            expect(outline.width, `${rel} ${selector}`).toBeGreaterThan(0);
        }
    }
});

test.describe('手機選單（320x256）', () => {
    test.use({ viewport: { width: 320, height: 256 } });

    test('選單在自己裡面捲動，最後一個選項拿得到焦點也看得到；Esc 收合並把焦點放回漢堡鈕', async ({ page }) => {
        await page.goto(P('index.html'));
        await page.locator('#nav-toggle').click();
        const menu = page.locator('#mobile-menu');
        await expect(menu).toBeVisible();
        expect(await menu.evaluate((el) => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(256);
        await menu.locator('a').last().focus();
        expect((await covered(page)).hidden, '最後一個選項被蓋住或在視窗外').toBe(0);
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
        await expect(page.locator('#nav-toggle')).toBeFocused();
        await expect(page.locator('#nav-toggle')).toHaveAttribute('aria-expanded', 'false');
    });
});

test('競賽卡片的狀態說明在 320px 寬不會超出卡片', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto(P('advanced-resources/competitions.html'));
    await page.locator('.comp-card').first().waitFor();
    const clipped = await page.locator('.comp-card').evaluateAll((cards) =>
        cards
            .filter((card) => {
                const c = card.getBoundingClientRect();
                return [...card.querySelectorAll('*')].some((el) => el.getBoundingClientRect().right > c.right + 1);
            })
            .map((card) => card.querySelector('.comp-card__title').textContent),
    );
    expect(clipped).toEqual([]);
});

test('已截止的競賽卡片，次要文字仍有 4.5:1', async ({ page }) => {
    // 卡片有淡入動畫，減少動態偏好下不播，量到的就是停下來的樣子。
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(P('advanced-resources/competitions.html'));
    const card = page.locator('.comp-card').first();
    await card.waitFor();
    await card.evaluate((el) => el.classList.add('is-closed'));
    await page.addScriptTag({ content: CONTRAST });
    const m = await card.evaluate((el) => ({
        opacity: getComputedStyle(el).opacity,
        org: window.__ratio(getComputedStyle(el.querySelector('.comp-card__org')).color, getComputedStyle(el).backgroundColor),
    }));
    expect(m.opacity).toBe('1');
    expect(m.org).toBeGreaterThanOrEqual(4.5);
});

test.describe('手機選單收合的時機（320x256）', () => {
    test.use({ viewport: { width: 320, height: 256 } });

    test('焦點移出頁首時收合；開著對話框時 Esc 不動選單', async ({ page }) => {
        await page.goto(P('index.html'));
        const menu = page.locator('#mobile-menu');
        await page.evaluate(() => {
            const d = document.createElement('dialog');
            d.textContent = 'dialog';
            document.body.append(d);
            d.show();
        });
        await page.locator('#nav-toggle').click();
        await page.keyboard.press('Escape');
        await expect(menu, '對話框開著，這次 Esc 是給對話框的').toBeVisible();
        await page.evaluate(() => document.querySelector('dialog[open]').close());
        await menu.locator('a').last().focus();
        await page.keyboard.press('Tab');
        await expect(menu).toBeHidden();
    });
});

test('學長姐訪談的「連結已複製」提示看不見時不擋住點擊', async ({ page }) => {
    await page.goto(P('career-exploration/senior-interviews.html'));
    // 提示是 fixed 在右下角、opacity 0 的方塊，捲到哪裡都疊在內容上面。
    await expect(page.locator('#copy-notification')).toHaveCSS('pointer-events', 'none');
});

// 能力地圖每一欄的標題在 md 以上釘在篩選面板下方，焦點移到它後面的卡片時也不能被它整個蓋住。
for (const viewport of [{ width: 1024, height: 600 }, { width: 844, height: 390 }]) {
    test(`competency-map ${viewport.width}x${viewport.height}：Shift+Tab 時焦點不會被欄位標題整個蓋住`, async ({ page }) => {
        test.setTimeout(90_000);
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(P('career-exploration/competency-map.html'), { waitUntil: 'networkidle' });
        await page.evaluate(() => {
            const end = document.createElement('button');
            end.textContent = 'end';
            document.querySelector('footer').append(end);
            end.focus({ preventScroll: true });
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
        });
        const bad = [];
        for (let i = 0; i < 30; i++) {
            await page.keyboard.press('Shift+Tab');
            await frames(page);
            const c = await covered(page);
            if (c.hidden === 9) bad.push(c.what);
        }
        expect(bad).toEqual([]);
    });
}

// 頁首是 sticky，一直在畫面上。焦點移進頁首時整頁不能捲動（<html> 的 scroll-padding 曾讓 Chrome 把它當成看不到）。
test.describe('焦點移進頁首時整頁不捲', () => {
    test.use({ contextOptions: { reducedMotion: 'reduce' } });

    for (const rel of ['about.html', 'advanced-resources/competitions.html']) {
        for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
            test(`${rel} ${viewport.width}x${viewport.height}：從內容 Shift+Tab 走進頁首`, async ({ page }) => {
                await page.setViewportSize(viewport);
                await page.goto(P(rel), { waitUntil: 'networkidle' });
                // 在 main 最前面放一個按鈕，捲到頁面中段，從它往回走就進到頁首。
                await page.evaluate(() => {
                    const start = document.createElement('button');
                    start.textContent = 'start';
                    document.querySelector('main').prepend(start);
                    window.scrollTo({ top: 1500, behavior: 'instant' });
                    start.focus({ preventScroll: true });
                });
                const steps = viewport.width >= 768 ? 6 : 2;
                for (let i = 0; i < steps; i++) {
                    await page.keyboard.press('Shift+Tab');
                    await frames(page);
                    const m = await page.evaluate(() => ({ y: scrollY, inHeader: !!document.activeElement.closest('body > header') }));
                    expect(m.inHeader, `第 ${i + 1} 次 Shift+Tab 要在頁首裡`).toBe(true);
                    expect(m.y, `第 ${i + 1} 次 Shift+Tab`).toBe(1500);
                }
            });
        }

        test(`${rel} 390x844：手機選單按 Esc 收合，焦點回到漢堡鈕時整頁不捲`, async ({ page }) => {
            await page.setViewportSize({ width: 390, height: 844 });
            await page.goto(P(rel), { waitUntil: 'networkidle' });
            await page.evaluate(() => window.scrollTo({ top: 1500, behavior: 'instant' }));
            const before = await page.evaluate(() => scrollY);
            await page.locator('#nav-toggle').click();
            await page.locator('#mobile-menu a').nth(1).focus();
            await page.keyboard.press('Escape');
            await frames(page);
            await expect(page.locator('#nav-toggle')).toBeFocused();
            // 選單展開時頁首變高，Chrome 的捲動錨定會把 scrollY 加上選單的高度；收合後應該回到原處。
            expect(await page.evaluate(() => scrollY)).toBe(before);
        });
    }
});

test('外框藏起來的輸入框，焦點時的 ring 在白底至少 3:1', async ({ page }) => {
    for (const [rel, ids] of [
        ['autonomous-learning/plan-templates.html', ['planInput']],
        ['learning-portfolio/index.html', ['reflectionInput']],
        ['learning-portfolio/reflection-guide.html', ['reflectionInput']],
        ['learning-portfolio/activity-database.html', ['search-input', 'category-filter', 'form-filter']],
        ['learning-portfolio/portfolio-gallery.html', ['category-filter', 'type-filter', 'tag-filter']],
    ]) {
        await page.goto(P(rel));
        await page.addScriptTag({ content: CONTRAST });
        for (const id of ids) {
            const best = await page.locator(`#${id}`).evaluate((el) => {
                el.focus();
                return Math.max(...window.__stops(getComputedStyle(el).boxShadow).map((c) => window.__ratio(c, '#ffffff')));
            });
            expect(best, `${rel} #${id}`).toBeGreaterThanOrEqual(3);
        }
    }
});

// 選單在自己裡面捲動。<html> 的 scroll-padding 被頁首裡的負 scroll-margin 抵掉了，選單自己要再加回來。
for (const viewport of [{ width: 390, height: 260 }, { width: 320, height: 256 }]) {
    test(`手機選單 ${viewport.width}x${viewport.height}：Tab 往下、Shift+Tab 往回，每個選項都整個看得到，整頁不捲`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(P('about.html'));
        await page.locator('#nav-toggle').focus();
        await page.keyboard.press('Enter');
        const links = await page.locator('#mobile-menu a').count();
        const y = await page.evaluate(() => scrollY);
        /** shown 回傳焦點所在選項露在選單可見範圍裡的比例。 */
        const shown = () =>
            page.evaluate(() => {
                const a = document.activeElement;
                const m = document.getElementById('mobile-menu');
                if (!m.contains(a) || a === m) return { text: a.id || a.tagName, ratio: 0 };
                const r = a.getBoundingClientRect();
                const mr = m.getBoundingClientRect();
                const top = Math.max(mr.top, 0);
                const bottom = Math.min(mr.bottom, innerHeight);
                return { text: a.textContent.trim(), ratio: Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top)) / r.height };
            });
        for (const [key, times] of [['Tab', links], ['Shift+Tab', links - 1]]) {
            for (let i = 0; i < times; i++) {
                await page.keyboard.press(key);
                const s = await shown();
                expect(s.ratio, `${key} 第 ${i + 1} 次：${s.text}`).toBeGreaterThan(0.99);
            }
        }
        expect(await page.evaluate(() => scrollY)).toBe(y);
    });
}

// 輸入框和下拉選單的外框（或底色）和旁邊的底色至少 3:1，看得出哪裡可以輸入（WCAG 1.4.11）。
// 只開 HTML 裡有表單元件的頁面。
const DIST = path.resolve(__dirname, '../../.link-root/sch001-108platform');
const walk = (dir, prefix = '') =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : e.name.endsWith('.html') ? [`${prefix}${e.name}`] : [],
    );
const FORM_PAGES = walk(DIST).filter((p) => /<(input|select|textarea)\b/.test(readFileSync(path.join(DIST, p), 'utf8')));

/** fieldBoundaries 回傳每個看得到的文字輸入框、下拉選單、多行輸入框，外框與底色對外面底色的對比。在頁面裡執行。 */
function fieldBoundaries() {
    const cv = document.createElement('canvas').getContext('2d');
    const rgba = (c) => {
        cv.clearRect(0, 0, 1, 1);
        cv.fillStyle = 'rgba(0, 0, 0, 0)';
        cv.fillStyle = c;
        cv.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = cv.getImageData(0, 0, 1, 1).data;
        return [r, g, b, a / 255];
    };
    const over = (top, bottom) => [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3])).concat(1);
    const lum = (c) => {
        const [x, y, z] = c.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * x + 0.7152 * y + 0.0722 * z;
    };
    const ratio = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
    };
    // 外面的底色：父元素往上第一個不透明的底色，中間半透明的一層層疊上去。
    const backdrop = (el) => {
        const layers = [];
        for (let n = el; n; n = n.parentElement) {
            const c = rgba(getComputedStyle(n).backgroundColor);
            if (c[3] > 0) layers.push(c);
            if (c[3] === 1) break;
        }
        return layers.reverse().reduce((under, c) => over(c, under), [255, 255, 255, 1]);
    };
    const fields = document.querySelectorAll('input:not([type=hidden], [type=checkbox], [type=radio]), select, textarea');
    return [...fields].filter((el) => el.checkVisibility()).map((el) => {
        const cs = getComputedStyle(el);
        const outside = backdrop(el.parentElement);
        const fill = ratio(over(rgba(cs.backgroundColor), outside), outside);
        const border = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' ? ratio(over(rgba(cs.borderTopColor), outside), outside) : 0;
        return { field: el.id || el.name, fill, border };
    });
}

for (const p of FORM_PAGES) {
    test(`${p}：輸入框與下拉選單的外框對旁邊至少 3:1`, async ({ page }) => {
        await page.goto(P(p), { waitUntil: 'networkidle' });
        const fields = await page.evaluate(fieldBoundaries);
        expect(fields.length).toBeGreaterThan(0);
        expect(fields.filter((f) => Math.max(f.fill, f.border) < 3)).toEqual([]);
    });
}

// 只放大文字到 200%（WCAG 1.4.4）：卡片都是 overflow: hidden，裡面的長英文字、標籤列超出卡片就被切掉。
test.describe('只放大文字到 200%，卡片裡的字不被切掉', () => {
    for (const [rel, card] of [
        ['advanced-resources/competitions.html', '.comp-card'],
        ['advanced-resources/online-courses.html', '.course-card'],
        ['advanced-resources/reading-list.html', '.book-card'],
    ]) {
        test(rel, async ({ page }) => {
            await page.emulateMedia({ reducedMotion: 'reduce' });
            await page.goto(P(rel), { waitUntil: 'networkidle' });
            await page.locator(card).first().waitFor();
            await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
            const clipped = await page.locator(card).evaluateAll((cards) => cards.flatMap((c) => {
                const out = c.scrollWidth > c.clientWidth + 1 ? [`${c.querySelector('h2, h3').textContent.trim()}：寬 ${c.scrollWidth} > ${c.clientWidth}`] : [];
                // 固定高度的標題，字多到超出就疊到下一段上。
                for (const h of c.querySelectorAll('h2, h3')) if (h.scrollHeight > h.clientHeight + 1) out.push(`${h.textContent.trim()}：標題高 ${h.scrollHeight} > ${h.clientHeight}`);
                return out;
            }));
            expect(clipped).toEqual([]);
        });
    }
});
