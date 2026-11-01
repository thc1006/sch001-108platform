// 螢幕報讀器讀得到的東西：篩選結果的筆數、切換按鈕的狀態、外文的 lang、開新分頁的提示、
// 標題層級和表格語意。看得到的畫面另有其他測試，這裡只看無障礙樹和屬性。
const { test, expect } = require('@playwright/test');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const P = (p) => `${BASE}/sch001-108platform/${p}`;
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

// sr-only 的文字是絕對定位，Chromium 算名稱時會在它前後補空白，所以字和字之間容許一個空白。
const loose = (name) => new RegExp(`^${[...name].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s?')}$`);

// 和 axe 的 heading-order 一樣：報讀器看得到的標題，下一個最多只比上一個深一層。
for (const p of PAGES) {
    test(`${p}：標題不跳級，開新分頁的連結都說會開新分頁，aria-label 包含看得到的字`, async ({ page }) => {
        await page.goto(P(p), { waitUntil: 'networkidle' });
        const { skips, silent, mismatched } = await page.evaluate(() => {
            const shown = (el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest('[aria-hidden="true"]');
            const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
                .filter(shown)
                .map((h) => [Number(h.tagName[1]), h.textContent.trim()]);
            // 名稱來自 aria-label 的連結，字要寫在 aria-label 裡；其他的看連結裡的文字。
            const silent = [...document.querySelectorAll('a[target="_blank"]')]
                .map((a) => a.getAttribute('aria-label') ?? a.textContent)
                .filter((name) => !name.includes('（另開新分頁）'));
            // 說「點前往官網」的語音指令要找得到：名稱來自 aria-label 時，要包含畫面上的字（WCAG 2.5.3）。比對時不看空白與標點。
            const norm = (s) => s.replace(/[\s\p{P}]/gu, '');
            const mismatched = [...document.querySelectorAll('a[aria-label], button[aria-label]')]
                .filter((el) => el.checkVisibility() && norm(el.innerText) && !norm(el.getAttribute('aria-label')).includes(norm(el.innerText)))
                .map((el) => `${el.innerText.trim()} → ${el.getAttribute('aria-label')}`);
            return { skips: levels.filter(([level], i) => i > 0 && level > levels[i - 1][0] + 1), silent, mismatched };
        });
        expect(skips).toEqual([]);
        expect(silent).toEqual([]);
        expect(mismatched).toEqual([]);
    });
}

// 區首頁的 h1、<title> 和導覽列上標著 aria-current="page" 的選項用同一個名稱。
test.describe('區首頁的名稱和導覽列相同', () => {
    for (const section of ['autonomous-learning', 'learning-portfolio', 'career-exploration', 'advanced-resources']) {
        test(section, async ({ page }) => {
            await page.goto(P(`${section}/index.html`));
            const current = page.locator('header a[aria-current="page"]:visible');
            await expect(current).toHaveCount(1);
            const name = (await current.textContent()).trim();
            await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(name);
            await expect(page).toHaveTitle(`${name} - 台灣教育處方籤`);
        });
    }
});

// [頁面, 卡片, 篩選動作]。#result-status 寫在頁面的 HTML 裡，資料載入前就在，之後只換文字；
// 載入時不念，使用者改了條件才寫入。
const FILTERS = [
    ['learning-portfolio/activity-database.html', '.activity-card', (page) => page.selectOption('#category-filter', { index: 1 })],
    ['advanced-resources/online-courses.html', '.course-card', (page) => page.selectOption('#language-filter', '英文')],
    ['advanced-resources/reading-list.html', '.book-card', (page) => page.fill('#search-input', '哈拉瑞')],
    ['autonomous-learning/resource-map.html', '#resource-grid > a', (page) => page.selectOption('#type-filter', '知識型影片')],
    ['learning-portfolio/portfolio-gallery.html', '.portfolio-card', (page) => page.selectOption('#category-filter', { index: 1 })],
    ['learning-portfolio/tools.html', '.tool-card', (page) => page.getByRole('button', { name: '心智圖' }).click()],
    ['autonomous-learning/plan-templates.html', '#template-grid > div', (page) => page.getByRole('button', { name: '資訊科技' }).click()],
    ['career-exploration/senior-interviews.html', '.interview-card', (page) => page.getByRole('button', { name: '資訊', exact: true }).click()],
    ['career-exploration/index.html', '.cluster-btn', (page) => page.fill('#search-bar', '工程')],
    ['advanced-resources/open-education.html', '.resource-card', (page) => page.getByRole('button', { name: '開放科學' }).click()],
];

test.describe('篩選之後念出顯示幾筆', () => {
    for (const [p, card, filter] of FILTERS) {
        test(p, async ({ page, request }) => {
            expect(await (await request.get(P(p))).text()).toContain('<p id="result-status" role="status" class="sr-only"></p>');
            await page.goto(P(p), { waitUntil: 'networkidle' });
            const status = page.getByRole('status').and(page.locator('#result-status'));
            await expect(status).toBeEmpty();
            await filter(page);
            const count = await page.locator(card).count();
            expect(count).toBeGreaterThan(0);
            await expect(status).toHaveText(`顯示 ${count} 筆`);
        });
    }

    test('搜尋框打字時，停下來才念筆數', async ({ page }) => {
        await page.goto(P('advanced-resources/reading-list.html'), { waitUntil: 'networkidle' });
        const status = page.locator('#result-status');
        await page.locator('#search-input').pressSequentially('哈拉', { delay: 50 });
        await expect(status).toBeEmpty();
        await expect(status).toHaveText(`顯示 ${await page.locator('.book-card').count()} 筆`);
    });
});

// [頁面, 按鈕所在的容器, 要按的按鈕]
const TOGGLES = [
    ['learning-portfolio/tools.html', '#category-filters', '心智圖'],
    ['autonomous-learning/plan-templates.html', '[aria-label="依分類篩選"]', '資訊科技'],
    ['career-exploration/senior-interviews.html', '#category-filters', '資訊'],
    ['learning-portfolio/reflection-guide.html', '#reflection-category-btns', '志工服務'],
    ['autonomous-learning/topic-ideas.html', '#matrix-category', '科學'],
    ['autonomous-learning/topic-ideas.html', '#matrix-method', '實驗'],
    ['career-exploration/index.html', '[role="group"][aria-label="學群清單"]', '管理學群'],
];

test.describe('切換按鈕用 aria-pressed 標出選中的那一個', () => {
    for (const [p, group, name] of TOGGLES) {
        test(`${p} ${group}`, async ({ page }) => {
            await page.goto(P(p), { waitUntil: 'networkidle' });
            const buttons = page.locator(group).getByRole('button');
            await buttons.getByText(name, { exact: true }).click();
            await expect(buttons.and(page.locator('[aria-pressed="true"]'))).toHaveText([name]);
            await expect(buttons.and(page.locator(':not([aria-pressed])'))).toHaveCount(0);
        });
    }

    test('科系羅盤的分頁按鈕在有名稱的群組裡，不是英文名稱的導覽地標', async ({ page }) => {
        await page.goto(P('career-exploration/index.html'), { waitUntil: 'networkidle' });
        await expect(page.locator('[aria-label="Tabs"]')).toHaveCount(0);
        const tabs = page.getByRole('group', { name: '工程學群的資訊' });
        await tabs.getByRole('button', { name: '生涯發展' }).click();
        await expect(tabs.getByRole('button', { pressed: true })).toHaveText(['生涯發展']);
        await expect(page.locator('#tab-careers')).toBeVisible();
        await expect(page.locator('#tab-competencies')).toBeHidden();
    });
});

test.describe('按了按鈕才出現的結果', () => {
    test('研究方法：答「否」之後焦點移到下一題，推薦結果在 role="status" 裡', async ({ page }) => {
        await page.goto(P('autonomous-learning/methodology.html'), { waitUntil: 'networkidle' });
        const q1 = page.getByRole('group', { name: '1. 你的研究主要是想了解「人們的想法或經驗」嗎？' });
        await q1.getByRole('button', { name: '否' }).press('Enter');
        await expect(page.getByRole('group', { name: /^2\. / })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.getByRole('group', { name: /^2\. / }).getByRole('button', { name: '是' })).toBeFocused();
        await page.keyboard.press('Enter');
        const result = page.locator('#recommendation-result[role="status"]');
        await expect(result).toContainText('聽起來你的研究偏向「量化」');
        expect(await result.getByRole('listitem').count()).toBeGreaterThan(1);
    });

    test('靈感矩陣與情境提問的結果在 role="status" 裡', async ({ page }) => {
        await page.goto(P('autonomous-learning/topic-ideas.html'));
        await page.locator('#matrix-category').getByRole('button', { name: '科學' }).click();
        await page.locator('#matrix-method').getByRole('button', { name: '實驗' }).click();
        await expect(page.locator('#matrix-result[role="status"]')).toHaveText('設計實驗，比較不同品牌運動飲料的電解質含量。');
        await page.goto(P('learning-portfolio/reflection-guide.html'));
        await page.getByRole('button', { name: '社團幹部' }).click();
        await expect(page.locator('#reflection-question-output[role="status"] p')).toHaveCount(1);
    });
});

test.describe('外文標上 lang', () => {
    test('競賽說明裡照抄的英文引文標 lang="en"，裡面沒有中文', async ({ page }) => {
        await page.goto(P('advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        const spans = page.locator('.comp-card__desc span[lang="en"]');
        expect(await spans.count()).toBeGreaterThan(100);
        const texts = await spans.allTextContents();
        expect(texts.filter((t) => /[\u3001-\u9fff]/.test(t))).toEqual([]);
    });

    test('書單的原文書名照 original_lang 標 lang', async ({ page, request }) => {
        const { themes } = await (await request.get(P('advanced-resources/reading-list.json'))).json();
        const books = themes.flatMap((t) => t.books).filter((b) => b.original_title);
        expect(books.filter((b) => !b.original_lang).map((b) => b.title)).toEqual([]);
        await page.goto(P('advanced-resources/reading-list.html'), { waitUntil: 'networkidle' });
        await expect(page.locator('.book-card p[lang]')).toHaveCount(books.length);
        for (const [lang, title] of [['ja', '嫌われる勇気'], ['de', 'Die Kunst des klaren Denkens'], ['no', 'Sofies verden'], ['fr', 'Passerelles: Philosophie Terminales L.ES.S']]) {
            await expect(page.locator(`.book-card p[lang="${lang}"]`).getByText(title, { exact: true }).first()).toBeAttached();
        }
    });

    test('學群文章參考資料的英文標題標 lang="en"', async ({ page }) => {
        await page.goto(P('career-exploration/clusters/engineering/inquiry.html'));
        await expect(page.locator('.md-content a span[lang="en"]')).toHaveText(['On Indefinite Reflection of Light Beam Off of Convex Decreasing Curves']);
    });
});

test.describe('連結名稱', () => {
    test('重複的連結文字後面接著項目名稱', async ({ page }) => {
        await page.goto(P('advanced-resources/online-courses.html'), { waitUntil: 'networkidle' });
        const first = page.locator('.course-card').first();
        const title = await first.locator('h2').textContent();
        await expect(first.getByRole('link')).toHaveAccessibleName(loose(`前往課程：${title}（另開新分頁）`));
        await page.goto(P('advanced-resources/open-education.html'), { waitUntil: 'networkidle' });
        const card = page.locator('.resource-card').first();
        await expect(card.getByRole('link')).toHaveAccessibleName(loose(`前往資源：${await card.locator('h2').textContent()}（另開新分頁）`));
        await page.goto(P('advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        const comp = page.locator('.comp-card').first();
        await expect(comp.getByRole('link')).toHaveAccessibleName(loose(`前往官網：${await comp.locator('h2').textContent()}（另開新分頁）`));
    });

    test('連到 PDF 的連結後面標「（PDF）」', async ({ page }) => {
        await page.goto(P('career-exploration/clusters/law/highlights.html'));
        const pdf = page.locator('.md-content a[href$=".pdf"]');
        expect(await pdf.count()).toBeGreaterThan(0);
        for (const text of await pdf.allTextContents()) expect(text).toMatch(/（PDF）$/);
        // 標示和前一個字放在同一個不換行的 span。
        await expect(pdf.locator('span.whitespace-nowrap')).toHaveCount(await pdf.count());
        for (const tail of await pdf.locator('span.whitespace-nowrap').allTextContents()) expect(tail).toMatch(/^.+（PDF）$/);
    });

    test('上一篇、下一篇的連結名稱帶著方向，箭頭不念', async ({ page }) => {
        await page.goto(P('career-exploration/clusters/finance/traits.html'));
        await expect(page.getByRole('link', { name: loose('上一篇：科系風向標') })).toBeVisible();
        await expect(page.getByRole('link', { name: loose('下一篇：多元表現亮點策略') })).toBeVisible();
    });
});

test('學群文章的表格保留表格語意，放不下要捲的外框才是有名稱、可以用鍵盤捲動的區塊', async ({ page }) => {
    await page.goto(P('career-exploration/clusters/finance/overview.html'));
    const table = page.locator('.md-content table').nth(1);
    await expect(table).toHaveCSS('display', 'table');
    await expect(table.getByRole('columnheader').first()).toHaveText('比較項目');
    await expect(page.locator('.table-scroll[role], .table-scroll[tabindex]')).toHaveCount(0);

    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(P('career-exploration/clusters/finance/traits.html'));
    const region = page.getByRole('region', { name: '表格：多元能力' });
    await expect(region).toHaveAttribute('tabindex', '0');
    await expect(region.getByRole('table')).toHaveCSS('display', 'table');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.locator('.table-scroll[role], .table-scroll[tabindex]')).toHaveCount(0);
});

test('和旁邊文字重複的圖片 alt 是空字串', async ({ page }) => {
    for (const [p, img] of [
        ['about.html', 'img.rounded-full'],
        ['advanced-resources/reading-list.html', '.book-card img'],
        ['advanced-resources/online-courses.html', '.course-card img'],
        ['learning-portfolio/tools.html', '.tool-card img'],
        ['learning-portfolio/portfolio-gallery.html', '.portfolio-card img'],
    ]) {
        await page.goto(P(p), { waitUntil: 'networkidle' });
        const alts = await page.locator(img).evaluateAll((els) => els.map((e) => e.getAttribute('alt')));
        expect(alts.length, p).toBeGreaterThan(0);
        expect(new Set(alts), p).toEqual(new Set(['']));
    }
});

test.describe('核心素養對照表', () => {
    test('依學群篩選：相關的卡片名稱多出「（相關）」，status 念出筆數', async ({ page }) => {
        await page.goto(P('career-exploration/competency-map.html'));
        const status = page.locator('#filter-status[role="status"]');
        await expect(status).toBeEmpty();
        await page.selectOption('#cluster-filter', '資訊');
        await expect(status).toHaveText('2 項素養與「資訊」學群相關');
        await expect(page.getByRole('button', { name: /（相關）$/ })).toHaveText([
            'A2 系統思考與解決問題（相關）',
            'B2 科技資訊與媒體素養（相關）',
        ]);
        await page.selectOption('#cluster-filter', 'all');
        await expect(status).toHaveText('顯示全部 9 項素養');
        await expect(page.getByRole('button', { name: /（相關）/ })).toHaveCount(0);
    });

    test('收合的說明不在無障礙樹裡，展開後才在', async ({ page }) => {
        await page.goto(P('career-exploration/competency-map.html'));
        const toggle = page.getByRole('heading', { level: 3, name: 'A1 身心素質與自我精進' }).getByRole('button');
        const content = page.locator('#content-A1-身心素質與自我精進');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(content).toHaveCSS('visibility', 'hidden');
        await expect(page.getByRole('heading', { name: '如何展現這項素養？' })).toHaveCount(0);
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'true');
        await expect(content).toHaveCSS('visibility', 'visible');
        await expect(content.getByRole('heading', { level: 4, name: '如何展現這項素養？' })).toBeVisible();
        await toggle.click();
        await expect(content).toHaveCSS('visibility', 'hidden');
    });
});
