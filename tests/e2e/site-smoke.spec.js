/**
 * 部署產物的瀏覽器 smoke test。
 * scripts/check-built-site.mjs 是靜態分析：它能證明「這個 URL 指得到東西」，但
 * 證明不了「頁面在瀏覽器裡真的跑得起來」。競賽頁與資源頁都是資料驅動的：瀏覽器
 * 先 fetch() JSON 再渲染卡片。JSON 若壞掉、被改名、或前端 JS 丟例外，靜態檢查
 * 全綠、build 成功，使用者卻只看到一個空白容器或「載入失敗」。
 *
 * 這支測試就是補那一段：在真的瀏覽器裡開頁面，等資料渲染出來，並且不接受本站的
 * console error、pageerror 或失敗的網路請求。
 *
 * 前置：dist/ 已 build 並 stage 到 .link-root/sch001-108platform/
 *      （CI 由 ci.yml 解開下載的 artifact 放進去）
 */
const { test, expect } = require('@playwright/test');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const P = (p) => `${BASE}/sch001-108platform${p}`;

/** 掛上錯誤蒐集器。回傳一個取得目前錯誤清單的函式。 */
function watchForErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        // 外部主機在 playwright.config.js 一律解析失敗。被擋的樣式表、script、圖片與 fetch，
        // Chromium 都會各記一筆這個 error，位置是那個資源的網址。
        const blocked = m.text() === 'Failed to load resource: net::ERR_NAME_NOT_RESOLVED';
        if (blocked && !m.location().url.startsWith(BASE)) return;
        errors.push(`console.error: ${m.text()}`);
    });
    page.on('requestfailed', (r) => {
        // 只在乎本站資源。外部主機已由 playwright.config.js 設成解析失敗，失敗是預期的。
        if (r.url().startsWith(BASE)) errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
    });
    page.on('response', (r) => {
        if (r.url().startsWith(BASE) && r.status() >= 400) errors.push(`HTTP ${r.status()}: ${r.url()}`);
    });
    return () => errors;
}

// 設定被拿掉時這一條會紅，不必等到哪天字型或 GA 沒有回應才看到逾時。
test('測試瀏覽器解析不到外部主機（playwright.config.js 的 host-resolver-rules）', async ({ page }) => {
    await expect(page.goto('https://example.com/')).rejects.toThrow('net::ERR_NAME_NOT_RESOLVED');
});

test.describe('部署產物 smoke test', () => {
    test('導覽列只在選項就是這一頁時標 aria-current="page"，同區段的子頁標 "true"', async ({ page }) => {
        for (const [path, value, href] of [
            ['/career-exploration/index.html', 'page', '/career-exploration/index.html'],
            ['/career-exploration/clusters/law/index.html', 'true', '/career-exploration/index.html'],
            ['/civic-tech-map/index.html', 'true', '/autonomous-learning/index.html'],
            ['/about.html', 'page', '/about.html'],
            ['/index.html', null],
        ]) {
            await page.goto(P(path));
            const marked = page.locator('header a[aria-current]');
            await expect(marked, path).toHaveCount(value ? 2 : 0); // 桌機與手機選單各一個
            for (const a of await marked.all()) {
                await expect(a, path).toHaveAttribute('aria-current', value);
                await expect(a, path).toHaveAttribute('href', `/sch001-108platform${href}`);
            }
        }
    });

    test('關於我們的 #feedback 有 GitHub 表單選單和聯絡信箱的連結', async ({ page }) => {
        await page.goto(P('/about.html'));
        const feedback = page.locator('main #feedback');
        const github = feedback.getByRole('link', { name: /^回報\s?（另開新分頁）$/ });
        await expect(github).toBeVisible();
        await expect(github).toHaveAttribute('href', 'https://github.com/thc1006/sch001-108platform/issues/new/choose');
        await expect(github).toHaveAttribute('target', '_blank');
        await expect(github).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(feedback.getByRole('link', { name: 'hctsai@linux.com', exact: true })).toHaveAttribute('href', 'mailto:hctsai@linux.com');
    });

    test('頁尾連到隱私權說明，說明頁的聯絡信箱和頁尾的一樣', async ({ page }) => {
        const errors = watchForErrors(page);
        await page.goto(P('/index.html'));
        const mail = await page.locator('footer a[href^="mailto:"]').getAttribute('href');
        await page.locator('footer').getByRole('link', { name: '隱私權說明', exact: true }).click();
        await expect(page).toHaveURL(P('/privacy.html'));
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('隱私權說明');
        await expect(page.locator(`main a[href="${mail}"]`)).toBeVisible();
        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('頁尾的問題回報連到關於我們的 #feedback，段落不在 header 底下', async ({ page }) => {
        for (const path of ['/index.html', '/career-exploration/clusters/law/index.html']) {
            await page.goto(P(path));
            await expect(page.locator('footer').getByRole('link', { name: '問題回報', exact: true }), path)
                .toHaveAttribute('href', '/sch001-108platform/about.html#feedback');
        }
        // 視窗要矮，#feedback 離頁底才夠遠，捲動不會先停在頁底，量得出 scroll-mt。
        for (const size of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) {
            const at = `${size.width}x${size.height}`;
            await page.setViewportSize(size);
            await page.goto(P('/index.html'));
            await page.locator('footer').getByRole('link', { name: '問題回報', exact: true }).click();
            await expect(page).toHaveURL(/\/about\.html#feedback$/);
            const feedback = page.locator('#feedback');
            await expect(feedback, at).toBeInViewport();
            // html 有 scroll-smooth，等捲動停下來再量。
            await expect.poll(async () => {
                const y = await page.evaluate(() => scrollY);
                await page.waitForTimeout(100);
                return y === await page.evaluate(() => scrollY);
            }).toBe(true);
            const headerBottom = await page.locator('body > header').evaluate((el) => el.getBoundingClientRect().bottom);
            await expect.poll(() => feedback.evaluate((el) => el.getBoundingClientRect().top), at).toBeGreaterThanOrEqual(headerBottom);
        }
    });

    test('首頁載入且無錯誤', async ({ page }) => {
        const errors = watchForErrors(page);
        await page.goto(P('/'), { waitUntil: 'networkidle' });
        await expect(page.locator('main#main-content')).toBeVisible();
        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('競賽頁真的把資料渲染出來，而不是停在載入中', async ({ page }) => {
        const errors = watchForErrors(page);
        await page.goto(P('/advanced-resources/competitions.html'), { waitUntil: 'networkidle' });

        // 這是重點：卡片是 fetch() 回來之後才由 JS 產生的。靜態檢查看不到這一步。
        const cards = page.locator('.comp-card');
        await expect(cards.first()).toBeVisible({ timeout: 10_000 });
        expect(await cards.count()).toBeGreaterThan(50);

        // 每張卡都必須有狀態文字，空字串代表狀態機算出了未預期的 key。
        const statuses = await page.locator('.comp-card .comp-status').allTextContents();
        expect(statuses.length).toBe(await cards.count());
        for (const s of statuses) expect(s.trim()).not.toBe('');

        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('多元表現資料庫把每一筆活動都渲染出來', async ({ page, request }) => {
        const errors = watchForErrors(page);
        const { activities } = await (await request.get(P('/learning-portfolio/activity-database.json'))).json();
        await page.goto(P('/learning-portfolio/activity-database.html'), { waitUntil: 'networkidle' });

        const cards = page.locator('#activity-grid .activity-card');
        await expect(cards).toHaveCount(activities.length);
        // 精選截止後頁面會收起精選區塊。截止與否照列表裡那張卡片的狀態，不在測試裡另算一次日期。
        const featured = activities.find((a) => a.featured);
        const heading = featured && page.getByRole('heading', { name: featured.title, exact: true });
        const closed = featured && (await cards.filter({ has: heading }).locator('.rounded-full').textContent()) === '已截止';
        await expect(page.locator('#featured-section')).toBeVisible({ visible: Boolean(featured) && !closed });
        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('競賽頁的狀態篩選都篩得出東西（chip 與狀態 key 沒有脫節）', async ({ page }) => {
        await page.goto(P('/advanced-resources/competitions.html'), { waitUntil: 'networkidle' });
        await expect(page.locator('.comp-card').first()).toBeVisible({ timeout: 10_000 });
        const total = await page.locator('.comp-card').count();

        const chips = page.locator('.comp-chip[data-status]');
        const n = await chips.count();
        expect(n).toBeGreaterThan(3);

        let sum = 0;
        for (let i = 0; i < n; i++) {
            const chip = chips.nth(i);
            const key = await chip.getAttribute('data-status');
            await chip.click();
            const shown = await page.locator('.comp-card').count();
            if (key !== 'all') sum += shown;
        }
        // 各狀態相加不得超過總數；也不得是 0（0 代表所有 chip 都篩不到東西）
        expect(sum).toBeGreaterThan(0);
        expect(sum).toBeLessThanOrEqual(total);
    });

    test('資料 JSON 直接開得起來且結構正確', async ({ request }) => {
        const res = await request.get(P('/advanced-resources/competitions.json'));
        expect(res.status()).toBe(200);
        const data = await res.json();
        expect(Array.isArray(data.competitions)).toBe(true);
        expect(data.competitions.length).toBeGreaterThan(50);
    });

    test('搜尋索引開得起來且不是空的', async ({ request }) => {
        const res = await request.get(P('/search-index.json'));
        expect(res.status()).toBe(200);
        const data = await res.json();
        const items = Array.isArray(data) ? data : data.items || data.documents;
        expect(Array.isArray(items)).toBe(true);
        expect(items.length).toBeGreaterThan(0);
    });

    // ColleGo! 只認 current_college_id，寫成別的參數名稱會被轉到學群列表。代碼是 2026-10-29 逐一開
    // CollegeIntro?current_college_id=N 讀頁面標題對出來的，鍵是卡片升學指南連結裡的學群資料夾，後面是卡片標題和
    // ColleGo! 上的學群名稱。
    const CLUSTER_CARDS = {
        engineering: [2, '工程學群', '工程學群'],
        info: [1, '資訊學群', '資訊學群'],
        management: [16, '管理學群', '管理學群'],
        finance: [17, '財經學群', '財經學群'],
        'social-psychology': [10, '社會與心理學群', '社會心理學群'],
        'mass-comm': [11, '大眾傳播學群', '大眾傳播學群'],
        design: [8, '設計學群', '建築設計學群'],
        'life-science': [5, '生命科學學群', '生命科學學群'],
        medicine: [4, '醫藥衛生學群', '醫藥衛生學群'],
    };

    test('科系羅盤每張學群卡片的 ColleGo! 連結都指到同一個學群', async ({ page }) => {
        const errors = watchForErrors(page);
        await page.goto(P('/career-exploration/index.html'), { waitUntil: 'networkidle' });
        const buttons = page.locator('#cluster-list .cluster-btn');
        await expect(buttons).toHaveCount(Object.keys(CLUSTER_CARDS).length);

        const seen = [];
        for (let i = 0; i < Object.keys(CLUSTER_CARDS).length; i++) {
            await buttons.nth(i).click();
            const details = page.locator('#cluster-details');
            const guide = await details.locator('a', { hasText: '查看升學指南' }).getAttribute('href');
            const slug = guide.match(/^clusters\/([^/]+)\/index\.html$/)?.[1];
            expect(slug, guide).toBeTruthy();
            const url = new URL(await details.locator('a', { hasText: '前往 ColleGo!' }).getAttribute('href'));
            expect(`${url.origin}${url.pathname}`).toBe('https://collego.edu.tw/Highschool/CollegeIntro');
            expect([...url.searchParams.keys()], url.href).toEqual(['current_college_id']);
            expect(url.searchParams.get('current_college_id'), slug).toBe(String(CLUSTER_CARDS[slug][0]));
            await expect(details.locator('h3')).toHaveText(CLUSTER_CARDS[slug][1]);
            await expect(details.getByText(`ColleGo!「${CLUSTER_CARDS[slug][2]}」的簡要介紹`)).toHaveCount(1);
            seen.push(slug);
        }
        expect(seen.sort()).toEqual(Object.keys(CLUSTER_CARDS).sort());
        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('學群簡介的出處連到同一個學群的 ColleGo! 介紹', async ({ page }) => {
        const errors = watchForErrors(page);
        // 法政學群不在科系羅盤上，代碼是 2026-10-30 開 current_college_id=15 讀頁面標題對出來的。
        const clusters = { ...CLUSTER_CARDS, law: [15, '法政學群', '法政學群'] };
        await page.goto(P('/career-exploration/clusters/index.html'));
        await expect(page.locator('a[href="https://collego.edu.tw/Highschool/CollegeList"]')).toHaveCount(1);
        const cards = await page.locator('main a[href*="/career-exploration/clusters/"]').evaluateAll((as) =>
            as.map((a) => a.getAttribute('href').match(/clusters\/([^/]+)\/index\.html$/)?.[1]));
        expect(cards.sort()).toEqual(Object.keys(clusters).sort());
        for (const [slug, [id, , collegoName]] of Object.entries(clusters)) {
            await page.goto(P(`/career-exploration/clusters/${slug}/index.html`));
            const link = page.locator('a', { hasText: 'ColleGo!「' });
            await expect(link, slug).toHaveAttribute('href', `https://collego.edu.tw/Highschool/CollegeIntro?current_college_id=${id}`);
            await expect(link, slug).toHaveText(`ColleGo!「${collegoName}」的介紹`);
        }
        expect(errors(), errors().join('\n')).toEqual([]);
    });
});

/**
 * #14 的驗收標準：搜尋 A2／系統思考／環保／SDG 要找得到對應的公民科技專案。
 * 這幾條刻意在真的瀏覽器裡打字驗證，而不是拿 search-index.json 做字串比對。
 * 索引裡「有那個欄位」和「使用者打進去搜得到」之間隔著 Fuse 的 keys 權重與
 * threshold。只驗前者的話，把 keys 改壞、把 threshold 調到 0.1，測試照樣全綠。
 *
 * 同時驗證兩件靜態檢查看不到的事：
 *   1. 搜尋結果的錨點真的能跳到那個專案（#78 的壞錨點就是點了停在頁首）
 *   2. 分類標籤是用 textContent 塞進去的，不是 innerHTML
 */
test.describe('站內搜尋的素養／SDGs 分類（#14 驗收）', () => {
    /** 開首頁並等到搜尋引擎就緒（索引 fetch 回來、Fuse 初始化完才會解除 disabled）。 */
    async function openHome(page) {
        await page.goto(P('/'), { waitUntil: 'networkidle' });
        const input = page.locator('#search-input');
        await expect(input).toBeEnabled({ timeout: 15_000 });
        return input;
    }

    /** 打進關鍵字，回傳結果清單的 locator。 */
    async function searchFor(page, query) {
        const input = await openHome(page);
        await input.fill(query);
        const results = page.locator('#search-results-container a[role="option"]');
        await expect(results.first()).toBeVisible({ timeout: 10_000 });
        return results;
    }

    // 素養類查詢：命中的不只公民科技專案，生涯探索首頁的學群卡片也標了同一個
    // 素養（它的來源資料寫的是中文名，建索引時被正規化成代碼）。這裡驗的是
    // 精確度：整份結果清單都必須真的帶有那個素養標籤，而不是模糊比對撈進來的
    // 雜訊；同時公民科技專案必須在其中。只驗「第一筆是誰」擋不住 threshold 被
    // 調鬆之後撈進一堆無關項目。
    for (const { query, why, label } of [
        { query: 'A2', why: '核心素養代碼', label: 'A2 系統思考與解決問題' },
        { query: '系統思考', why: '素養的中文標籤', label: 'A2 系統思考與解決問題' },
    ]) {
        test(`搜尋「${query}」（${why}）命中的每一筆都真的標了該素養`, async ({ page }) => {
            const errors = watchForErrors(page);
            const results = await searchFor(page, query);

            const count = await results.count();
            expect(count).toBeGreaterThan(0);

            const chipSets = await results.evaluateAll((els) =>
                els.map((el) => [...el.querySelectorAll('span')].map((s) => s.textContent.trim())),
            );
            for (const chips of chipSets) {
                expect(chips, `搜尋「${query}」有一筆結果沒有標「${label}」：${chips.join(' / ')}`).toContain(label);
            }

            const hrefs = await results.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
            expect(
                hrefs.filter((h) => h.includes('civic-tech-map/index.html#')).length,
                `搜尋「${query}」的結果：${hrefs.join(', ')}`,
            ).toBeGreaterThan(0);

            expect(errors(), errors().join('\n')).toEqual([]);
        });
    }

    // 議題關鍵字與 SDGs：這兩個查詢只有公民科技專案帶有對應標籤，所以要求更嚴，
    // 第一筆就必須是公民科技專案。issue 要的是「權重較高地顯示」，只要「出現在
    // 某個位置」是不夠的。
    for (const { query, why } of [
        { query: '環保', why: '議題關鍵字' },
        { query: 'SDG', why: 'SDGs' },
    ]) {
        test(`搜尋「${query}」（${why}）第一筆就是公民科技專案`, async ({ page }) => {
            const errors = watchForErrors(page);
            const results = await searchFor(page, query);

            expect(await results.count()).toBeGreaterThan(0);
            const firstHref = await results.first().getAttribute('href');
            expect(firstHref, `搜尋「${query}」的第一筆是 ${firstHref}`).toContain('civic-tech-map/index.html#');

            expect(errors(), errors().join('\n')).toEqual([]);
        });
    }

    // 公民科技專案的卡片標題沒有英文名與單位，這些只在 name、org 裡，搜尋要照樣找得到
    for (const { query, id } of [
        { query: 'Civil IoT', id: 'civil-iot' },
        { query: 'National Treasure', id: 'national-treasure' },
        { query: 'MoeDict', id: 'amis-moedict' },
        { query: 'g0v', id: 'vtaiwan' },
    ]) {
        test(`搜尋「${query}」找得到 ${id}`, async ({ page }) => {
            const results = await searchFor(page, query);
            const hrefs = await results.evaluateAll((els) => els.map((el) => el.getAttribute('href')));
            expect(hrefs, `搜尋「${query}」的結果：${hrefs.join(', ')}`).toContain(`civic-tech-map/index.html#${id}`);
        });
    }

    test('素養代碼命中時會說明是「核心素養」命中的', async ({ page }) => {
        const results = await searchFor(page, 'A2');
        const summary = await results.first().locator('p').last().textContent();
        expect(summary).toContain('核心素養');
        expect(summary).toContain('A2');
    });

    test('分類標籤走 textContent，不會被當成 HTML 解析', async ({ page }) => {
        const results = await searchFor(page, 'SDG');
        const chips = results.first().locator('span');
        expect(await chips.count()).toBeGreaterThan(0);
        // textContent 塞進去的節點不可能有子元素；若哪天改成 innerHTML，
        // 標籤裡只要出現一個 < 就會長出子節點，這一條會紅。
        const childCounts = await chips.evaluateAll((els) => els.map((el) => el.childElementCount));
        expect(childCounts.every((n) => n === 0)).toBe(true);
        const texts = await chips.allTextContents();
        expect(texts.some((t) => t.startsWith('SDG '))).toBe(true);
    });

    test('點搜尋結果會跳到該專案，而不是停在頁首', async ({ page }) => {
        const errors = watchForErrors(page);
        const results = await searchFor(page, '假訊息');
        const href = await results.first().getAttribute('href');
        expect(href).toContain('#');
        const anchor = href.split('#')[1];

        await results.first().click();
        await page.waitForURL(new RegExp(`#${anchor}$`), { timeout: 10_000 });
        // 錨點必須真的存在於頁面上，否則瀏覽器只會停在頁首而不報任何錯
        await expect(page.locator(`#${anchor}`)).toBeVisible();
        expect(errors(), errors().join('\n')).toEqual([]);
    });
});

/**
 * 自架的第三方函式庫（#72 後續）。
 * fuse.js（搜尋引擎，載不到就整個搜尋失效）、feather-icons、ionicons 若從 CDN 載入，
 * 第三方網域的可用性會直接決定本站功能能不能用，而且沒有任何建置期檢查會發現它們
 * 掛掉：CDN 壞掉時 build 綠、check:site 綠，使用者打開才發現搜尋框永遠停在「載入中」。
 *
 * check:site 已經會擋下「vendor 檔案不見」（script[src] 解析不到就紅）。這裡補的是
 * 靜態檢查看不到的兩件事：函式庫在瀏覽器裡真的能用，以及沒有偷偷留下 CDN 請求。
 */
test.describe('自架的第三方函式庫', () => {
    /** 攔截所有對外請求，回傳取得清單的函式。 */
    function watchThirdParty(page) {
        const hits = [];
        page.on('request', (r) => {
            const u = r.url();
            if (/unpkg\.com|cdn\.jsdelivr\.net/.test(u)) hits.push(u);
        });
        return () => hits;
    }

    test('首頁的搜尋引擎來自本站，不是 CDN', async ({ page }) => {
        const cdn = watchThirdParty(page);
        await page.goto(P('/'), { waitUntil: 'networkidle' });

        // Fuse 真的載進來且可用：搜尋框解除 disabled 就代表索引與 Fuse 都就緒。
        await expect(page.locator('#search-input')).toBeEnabled({ timeout: 15_000 });
        expect(await page.evaluate(() => typeof window.Fuse)).toBe('function');

        expect(cdn(), `仍有 CDN 請求：${cdn().join(', ')}`).toEqual([]);
    });

    test('生涯探索頁的 ionicons 真的渲染出 SVG', async ({ page }) => {
        const cdn = watchThirdParty(page);
        const errors = watchForErrors(page);
        await page.goto(P('/career-exploration/index.html'), { waitUntil: 'networkidle' });

        // ion-icon 是 web component，載入成功後會在 shadow DOM 裡放一個 <svg>。
        // 找不到 SVG 時它不會報錯，只是不顯示，所以要直接檢查 shadow DOM。
        await page.waitForFunction(
            () => {
                const els = [...document.querySelectorAll('ion-icon')];
                return els.length > 0 && els.every((e) => e.shadowRoot && e.shadowRoot.querySelector('svg'));
            },
            { timeout: 15_000 },
        );
        const n = await page.locator('ion-icon').count();
        expect(n).toBeGreaterThan(5);

        expect(cdn(), `仍有 CDN 請求：${cdn().join(', ')}`).toEqual([]);
        expect(errors(), errors().join('\n')).toEqual([]);
    });

    test('素養地圖的 feather icons 真的被替換成 SVG', async ({ page }) => {
        const cdn = watchThirdParty(page);
        await page.goto(P('/career-exploration/competency-map.html'), { waitUntil: 'networkidle' });

        // feather.replace() 會把 <i data-feather> 換成 <svg class="feather">。
        // 沒被換掉代表 feather.min.js 沒載到或沒執行。
        await page.waitForFunction(() => document.querySelectorAll('svg.feather').length > 0, { timeout: 15_000 });
        expect(await page.locator('svg.feather').count()).toBeGreaterThan(2);

        expect(cdn(), `仍有 CDN 請求：${cdn().join(', ')}`).toEqual([]);
    });
});

/**
 * 搜尋框的無障礙契約（WCAG 4.1.2 A 級 / 4.1.3 AA 級）。
 * 這兩條守的失敗：
 *
 *   按 ArrowDown 之後 aria-activedescendant = null，9 個選項全部沒有 id
 *     → 焦點留在輸入框的 combobox 模式下，螢幕閱讀器使用者用方向鍵瀏覽時
 *       完全聽不到任何回饋。WCAG 4.1.2（A 級）失敗。
 *
 *   全頁沒有任何 aria-live / role=status
 *     → 打完字之後不會知道有沒有結果、有幾筆。WCAG 4.1.3（AA 級）失敗。
 *
 * 這兩件事在畫面上完全看不出來，視覺使用者一切正常。只有實際查 DOM 才會發現，
 * 所以必須有測試釘住。
 */
test.describe('搜尋框的無障礙契約', () => {
    async function openAndSearch(page, query) {
        await page.goto(P('/'), { waitUntil: 'networkidle' });
        const input = page.locator('#search-input');
        await expect(input).toBeEnabled({ timeout: 15_000 });
        await input.fill(query);
        return input;
    }

    test('方向鍵瀏覽時 aria-activedescendant 必須指向實際存在的選項', async ({ page }) => {
        const input = await openAndSearch(page, 'A2');
        await expect(page.locator('#search-results-container a[role="option"]').first()).toBeVisible({
            timeout: 10_000,
        });

        // 每個選項都要有 id，否則 aria-activedescendant 沒有東西可指
        const ids = await page
            .locator('#search-results-container a[role="option"]')
            .evaluateAll((els) => els.map((e) => e.id));
        expect(ids.every((i) => i && i.length > 0), `有選項沒有 id：${JSON.stringify(ids)}`).toBe(true);
        expect(new Set(ids).size, 'id 必須唯一').toBe(ids.length);

        await input.press('ArrowDown');
        const active1 = await input.getAttribute('aria-activedescendant');
        expect(active1, '按 ArrowDown 之後必須指向第一個選項').toBe(ids[0]);
        // 指向的 id 必須真的存在於文件中
        expect(await page.locator(`#${active1}`).count()).toBe(1);

        await input.press('ArrowDown');
        expect(await input.getAttribute('aria-activedescendant'), '再按一次要移到第二個').toBe(ids[1]);

        // 往回退到「沒有選取」時必須移除屬性，而不是留下空字串或舊值
        await input.press('ArrowUp');
        await input.press('ArrowUp');
        expect(await input.getAttribute('aria-activedescendant'), '退回未選取時必須移除屬性').toBeNull();
    });

    test('結果數量必須以 live region 播報，查無結果也要', async ({ page }) => {
        await openAndSearch(page, 'A2');
        const status = page.locator('[role="status"], [aria-live="polite"]');
        await expect(status.first()).toHaveCount(1, { timeout: 10_000 });

        await expect
            .poll(async () => (await status.first().textContent()) || '', { timeout: 10_000 })
            .toMatch(/找到 \d+ 筆/);

        // 查無結果是最需要回饋的情況，而它走的是提早 return 的那條路徑
        await page.locator('#search-input').fill('zzzz不可能存在的關鍵字zzzz');
        await expect
            .poll(async () => (await status.first().textContent()) || '', { timeout: 10_000 })
            .toMatch(/找不到/);
    });
});
