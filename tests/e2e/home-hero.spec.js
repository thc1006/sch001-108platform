// 首頁標題的斷行與字級，以及筆電與寬螢幕上的版心寬度。標題只在詞組之間換行，字級跟著文字欄寬縮放，
// 視窗變寬時不會變小；視窗很窄或根字級放大時，標題也不能超出畫面。
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const HOME = `${BASE}/sch001-108platform/`;

// 手機、平板、筆電，以及 1280px 與 1440px 的筆電縮小到 90% 時的寬度，由窄到寬。
const WIDTHS = [320, 360, 390, 430, 768, 820, 1024, 1280, 1422, 1600, 1920];

// 標題只能在這些詞組之間換行；第二個詞組後面一定換行。
const PHRASES = ['在108課綱的', '迷霧中，', '為你點亮', '一盞燈。'];

/** openHome 用指定的視窗寬度開首頁，等字型載完。 */
async function openHome(page, width) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(HOME);
    await page.evaluate(() => document.fonts.ready.then(() => {}));
}

/** readHeadline 回傳標題每一行的文字（去掉空白）與左右緣、標題的左右緣與字級，以及頁面能橫向捲動多少。 */
function readHeadline(page) {
    return page.evaluate(() => {
        const h1 = document.querySelector('main h1');
        const lines = [];
        let lastTop = null;
        const walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            for (let i = 0; i < node.data.length; i++) {
                if (!node.data[i].trim()) continue;
                const range = document.createRange();
                range.setStart(node, i);
                range.setEnd(node, i + 1);
                const rect = range.getClientRects()[0];
                if (!rect) continue;
                if (lastTop === null || Math.abs(rect.top - lastTop) > 5) {
                    lines.push({ text: '', left: rect.left, right: rect.right });
                    lastTop = rect.top;
                }
                const line = lines[lines.length - 1];
                line.text += node.data[i];
                line.left = Math.min(line.left, rect.left);
                line.right = Math.max(line.right, rect.right);
            }
        }
        const box = h1.getBoundingClientRect();
        const root = document.documentElement;
        return {
            left: box.left,
            right: box.right,
            width: box.width,
            fontSize: parseFloat(getComputedStyle(h1).fontSize),
            overflow: root.scrollWidth - root.clientWidth,
            lines: lines.map((l) => ({ ...l, width: l.right - l.left })),
        };
    });
}

/** expectInside 檢查標題每一行都在標題的框裡，頁面也不能橫向捲動。 */
function expectInside(headline, label) {
    for (const line of headline.lines) {
        expect(line.left, `${label}「${line.text}」超出標題左緣`).toBeGreaterThanOrEqual(headline.left - 1);
        expect(line.right, `${label}「${line.text}」超出標題右緣`).toBeLessThanOrEqual(headline.right + 1);
    }
    expect(headline.overflow, `${label}頁面可以橫向捲動`).toBeLessThanOrEqual(0);
}

for (const width of WIDTHS) {
    test(`首頁標題在 ${width}px 只在詞組之間換行，不溢出`, async ({ page }) => {
        await openHome(page, width);
        const headline = await readHeadline(page);
        const { lines } = headline;

        expect(lines.map((l) => l.text).join('')).toBe(PHRASES.join(''));
        // 每一行都由完整的詞組組成：行尾一定落在詞組的邊界上。
        const ends = PHRASES.map((_, i) => PHRASES.slice(0, i + 1).join('').length);
        let consumed = 0;
        for (const line of lines) {
            consumed += line.text.length;
            expect(ends, `「${line.text}」斷在詞組中間`).toContain(consumed);
        }
        expect(lines.some((l) => l.text.endsWith('迷霧中，')), '兩句要分在不同行').toBe(true);
        expect(lines.length).toBeLessThanOrEqual(3);
        if (width >= 430) expect(lines.length).toBe(2);

        expectInside(headline, `${width}px：`);
        expect(headline.fontSize, '字級不小於 1.75rem').toBeGreaterThanOrEqual(28);
        // 平板以上留白：最寬的一行不超過標題寬度的九成。
        if (width >= 768) {
            const widest = Math.max(...lines.map((l) => l.width));
            expect(widest / headline.width).toBeLessThanOrEqual(0.9);
        }
    });
}

test('首頁標題的字級隨視窗變寬只增不減', async ({ page }) => {
    await openHome(page, WIDTHS[0]);
    let first = null;
    let prev = null;
    for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        const { fontSize } = await readHeadline(page);
        if (prev) expect(fontSize, `${prev.width}px 是 ${prev.fontSize}px，${width}px 是 ${fontSize}px`).toBeGreaterThanOrEqual(prev.fontSize);
        prev = { width, fontSize };
        first ??= prev;
    }
    // 不認得 cqi 時字級固定在後備的 text-4xl，上面的檢查照樣會過。
    expect(prev.fontSize, `${first.width}px 到 ${prev.width}px 的字級要跟著放大`).toBeGreaterThan(first.fontSize * 1.5);
});

// 最長的詞組「在 108 課綱的」在最小字級時約 176px 寬，文字欄比它窄時，詞組內也要能換行。
for (const width of [210, 195, 160]) {
    test(`首頁標題在 ${width}px 的視窗不超出畫面`, async ({ page }) => {
        await openHome(page, width);
        expectInside(await readHeadline(page), `${width}px：`);
    });
}

// 240px 時文字欄剛好 12rem，詞組不再拆開。
test('首頁標題在 240px 斷成四個詞組', async ({ page }) => {
    await openHome(page, 240);
    const { lines } = await readHeadline(page);
    expect(lines.map((l) => l.text)).toEqual(PHRASES);
});

// iPad 10.2 直向的螢幕是 810×1080。Safari 的網址列與分頁列約佔 103px，搜尋區的標題要在剩下的 977px 內。
test('810px 寬的平板直向，第一個畫面看得到搜尋區的標題', async ({ page }) => {
    await page.setViewportSize({ width: 810, height: 1080 });
    await page.goto(HOME);
    const m = await page.evaluate(() => ({
        searchBottom: document.querySelector('#search-section h2').getBoundingClientRect().bottom + scrollY,
        illustration: document.querySelector('main section svg').getBoundingClientRect().width,
    }));
    expect.soft(m.illustration, '插圖寬').toBeLessThanOrEqual(256);
    expect(m.searchBottom, '搜尋區標題的底緣').toBeLessThanOrEqual(977);
});

// 瀏覽器的預設字級調大時，rem 跟著放大。這幾個寬度用不到斷點，用 html 的 font-size 模擬結果相同。
for (const width of [320, 360, 375, 390]) {
    test(`根字級 200% 時首頁標題在 ${width}px 不超出畫面`, async ({ page }) => {
        await openHome(page, width);
        await page.addStyleTag({ content: 'html { font-size: 200%; }' });
        expectInside(await readHeadline(page), `${width}px、根字級 200%：`);
    });
}

test('首頁標題的可存取名稱和切成詞組之前相同', async ({ page }) => {
    await openHome(page, 390);
    // 名稱要向 Chromium 拿：它把 <wbr> 算成空格，Playwright 自己算的名稱看不出這個差別。
    const cdp = await page.context().newCDPSession(page);
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("main h1")' });
    const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { objectId: result.objectId, fetchRelatives: false });
    expect(nodes[0].role.value).toBe('heading');
    expect(nodes[0].name.value).toBe('在 108 課綱的迷霧中， 為你點亮一盞燈。');
});

// global.css 讓 container 在 lg 起兩側至少留 2rem，2xl 起停在 1280px。那條覆寫要排在 Tailwind 內建的
// container 後面才生效，排序出錯時這裡的寬度與左緣會不對。
const CONTAINER_WIDTHS = [[1024, 960], [1100, 1024], [1280, 1216], [1300, 1236], [1440, 1280], [1600, 1280], [1920, 1280]];

for (const [width, expected] of CONTAINER_WIDTHS) {
    test(`${width}px 的版心是 ${expected}px，導覽列與首頁標題離視窗左緣至少 56px`, async ({ page }) => {
        await openHome(page, width);
        const m = await page.evaluate(() => {
            const left = (selector) => document.querySelector(selector).getBoundingClientRect().left;
            return {
                nav: document.querySelector('header nav').getBoundingClientRect().width,
                hero: document.querySelector('main section .container').getBoundingClientRect().width,
                brandLeft: left('header nav a'),
                headlineLeft: left('main h1'),
            };
        });
        expect({ nav: m.nav, hero: m.hero }, '導覽列與主視覺的版心寬度').toEqual({ nav: expected, hero: expected });
        expect(m.brandLeft, '站名的左緣').toBeGreaterThanOrEqual(56);
        expect(m.headlineLeft, '首頁標題的左緣').toBeGreaterThanOrEqual(56);
    });
}
