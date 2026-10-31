// 學習資源地圖頁的「AI 學習路徑規劃師」（AI 閘道的 learning-path 任務）：用假閘道驗證頁面怎麼送出、
// 顯示進度與結果、處理錯誤與取消。假閘道見 fake-gateway.js。
//
// 伺服器由 playwright.config.js 的 webServer 啟動（8001 埠是 .link-root，要先建置）。

const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/autonomous-learning/resource-map.html`;

const ACCEPTED = sse('accepted', { requestId: 'req-1', task: 'learning-path' });
const done = (result) => sse('done', { result, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 });

const RESULT = {
    learning_path: [
        {
            title: '打好 Python 基礎',
            description: '先熟悉變數、迴圈、函式與串列，之後讀爬蟲程式才看得懂。',
            resource_type: '線上課程',
            actionable_suggestion: '搜尋「Python 入門 教學」，每天寫一個小練習。',
        },
        {
            title: '認識網頁結構',
            description: '了解 HTML 標籤與 CSS 選擇器，知道要抓的資料藏在哪裡。',
            resource_type: '知識型影片',
            actionable_suggestion: '打開瀏覽器的開發者工具，看新聞網站的標題用了哪個標籤。',
        },
        {
            title: '寫第一支爬蟲',
            description: '用 requests 取得網頁，再用 BeautifulSoup 取出需要的資料。',
            resource_type: '閱讀材料',
            actionable_suggestion: '搜尋「requests BeautifulSoup 教學」，抓下一個網站的文章標題。',
        },
        {
            title: '完成小專題',
            description: '選一個你關心的主題，把抓到的資料整理成表格或圖表。',
            resource_type: '實作專案',
            actionable_suggestion: '把結果存成 CSV，再用 pandas 畫出一張趨勢圖。',
        },
    ],
};

// AI 的輸出是不可信來源。每個欄位都夾了會執行的標籤，頁面該把它們當純文字顯示。
const xssStep = (n) => ({
    title: `標題${n} ${XSS_IMG}`,
    description: `描述${n} ${XSS_SCRIPT}`,
    resource_type: `資源${n} ${XSS_IMG}${XSS_SCRIPT}`,
    actionable_suggestion: `${XSS_SCRIPT} 行動${n} ${XSS_IMG}`,
});
const XSS_RESULT = { learning_path: [1, 2, 3, 4].map(xssStep) };

// 結果與錯誤送達時，進度區塊都會跟著移除：[情況, 要送的 SSE 片段, 檢查畫面的函式]。
const FORMAT_ERROR = 'AI 回覆的格式不正確，請再試一次。';
const SETTLE = [
    ['結果送達', done(RESULT), (page) => expect(page.locator('#pathResult > div')).toHaveCount(4)],
    ['閘道回報錯誤', sse('error', { code: 'format', message: FORMAT_ERROR, retryable: true }),
        (page) => expect(page.locator('#pathResult')).toHaveText(FORMAT_ERROR)],
];

const push = (page, chunk) => page.evaluate((c) => window.__stream.push(c), chunk);

// 半透明和禁止游標也要拿掉，否則按鈕能按，看起來卻像停用的。
async function expectButtonRestored(button) {
    await expect(button).toBeEnabled();
    await expect(button).toHaveText('規劃路徑');
    await expect(button.locator('svg')).toHaveCount(1);
    await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
}

test.describe('學習資源地圖頁：AI 學習路徑規劃師（learning-path 任務）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PAGE);
        await stubBuiltInGateway(page);
    });

    test('送出主題 → 依序顯示 4 個步驟的編號、標題、描述、資源類型與行動建議；按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, {
            chunks: [ACCEPTED, sse('progress', { phase: 'thinking', round: 1 }), done(RESULT)],
        });
        await page.fill('#pathInput', '  我想學 Python 爬蟲  ');
        await page.click('#generatePathBtn');

        const steps = page.locator('#pathResult > div');
        await expect(steps).toHaveCount(4);
        for (const [i, step] of RESULT.learning_path.entries()) {
            const item = steps.nth(i);
            await expect(item.locator('span').first()).toHaveText(String(i + 1));
            await expect(item.locator('h4')).toHaveText(step.title);
            await expect(item).toContainText(step.description);
            await expect(item).toContainText(`建議資源：${step.resource_type}`);
            await expect(item).toContainText(`下一步行動：${step.actionable_suggestion}`);
        }
        await expect(page.locator('#pathWork > *')).toHaveCount(0);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/learning-path');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { topic: '我想學 Python 爬蟲' } });

        await expectButtonRestored(page.locator('#generatePathBtn'));
    });

    test('AI 回傳含 HTML 標籤的文字 → 每個欄位都當純文字原樣顯示，不產生 img／script 元素，也不執行', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done(XSS_RESULT)] });
        await page.fill('#pathInput', 'Python');
        await page.click('#generatePathBtn');

        const result = page.locator('#pathResult');
        await expect(result.locator('h4')).toHaveText(XSS_RESULT.learning_path.map((step) => step.title));
        for (const step of XSS_RESULT.learning_path) {
            await expect(result).toContainText(step.description);
            await expect(result).toContainText(step.resource_type);
            await expect(result).toContainText(step.actionable_suggestion);
        }
        await expect(result.locator('img, script, [onerror]')).toHaveCount(0);

        // img 的 onerror 要等圖片載入失敗才會跑；若真的塞進了 <img src=x>，這一等就會讓它現形。
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('閘道網址沒有設定 → 顯示「尚未設定」，不送出請求', async ({ page }) => {
        await installFakeGateway(page, { withMeta: false });
        await page.fill('#pathInput', 'Python');
        await page.click('#generatePathBtn');
        await expect(page.locator('#pathResult')).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
        await expect(page.locator('#pathWork > *')).toHaveCount(0);
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('沒有輸入（或只有空白）就按 → 以錯誤的紅字提示先輸入，不送出請求', async ({ page }) => {
        await installFakeGateway(page);
        const message = page.locator('#pathResult p');
        for (const value of ['', '   ']) {
            await page.fill('#pathInput', value);
            await page.click('#generatePathBtn');
            await expect(page.locator('#pathResult')).toHaveText('請先輸入你想學習的主題！');
            await expect(message).toHaveClass(/text-red-700/);
            await expect(message).not.toHaveClass(/text-gray-600/);
        }
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('進行中焦點在按鈕上按 Esc → 和按「取消」一樣顯示「已取消。」，焦點留在按鈕；輸入法選字中的 Esc 不取消', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#pathInput', '測試');
        await page.click('#generatePathBtn');
        const progress = page.locator('#pathWork .platform-ai-progress');
        await expect(progress).toHaveCount(1);
        const target = page.locator('#generatePathBtn');
        await target.focus();
        await target.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
        await expect(progress).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#pathResult')).toHaveText('已取消。');
        await expect(progress).toHaveCount(0);
        await expect(target).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    test('進行中用鍵盤按「取消」→ 進度區塊移除，以一般的語氣顯示「已取消。」，焦點回到「規劃路徑」按鈕，按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#pathInput', 'Python');
        await page.click('#generatePathBtn');
        const button = page.locator('#generatePathBtn');
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).toHaveText('規劃中…');
        await expect(button).toHaveClass(/opacity-50/);
        await expect(button).toHaveClass(/cursor-not-allowed/);
        await expect(button.locator('svg')).toHaveCount(1);

        await page.locator('#pathWork').getByRole('button', { name: '取消' }).focus();
        await page.keyboard.press('Enter');
        const message = page.locator('#pathResult p');
        await expect(message).toHaveText('已取消。');
        await expect(message).toHaveClass(/text-gray-600/);
        await expect(message).not.toHaveClass(/text-red-700/);
        await expect(page.locator('#pathWork > *')).toHaveCount(0);
        await expectButtonRestored(button);
        // 取消鈕會隨進度區塊移除。空的工作區看不到焦點框；焦點移進結果區的話，螢幕閱讀器會唸一次
        // 訊息，live region 又唸一次。
        await expect(button).toBeFocused();
        for (const el of [button, page.locator('#pathWork'), page.locator('#pathResult')]) await expect(el).not.toHaveAttribute('tabindex');
    });

    for (const [when, chunk, expectSettled] of SETTLE) {
        test(`等待時焦點停在「取消」上，${when} → 焦點交給「規劃路徑」按鈕，不掉回 <body>`, async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await page.fill('#pathInput', 'Python');
            await page.click('#generatePathBtn');
            await page.locator('#pathWork').getByRole('button', { name: '取消' }).focus();

            await push(page, chunk);
            await expectSettled(page);
            await expect(page.locator('#generatePathBtn')).toBeFocused();
        });
    }

    // disabled 的按鈕會失去焦點，瀏覽器下一次更新畫面時就把焦點移到 <body>。
    test('用鍵盤按「規劃路徑」→ 進行中按鈕是 aria-disabled，再按不會重送；等待中與完成後，焦點都留在按鈕上', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#pathInput', 'Python');
        const button = page.locator('#generatePathBtn');
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).not.toHaveAttribute('disabled');
        // 等過一次畫面更新再看焦點。
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.keyboard.press('Enter');
        await expect(button).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);

        await push(page, done(RESULT));
        await expect(page.locator('#pathResult > div')).toHaveCount(4);
        await expectButtonRestored(button);
        await expect(button).toBeFocused();
    });

    test('閘道回報錯誤（error 事件）→ 進度區塊移除，以錯誤的紅字顯示閘道給的訊息', async ({ page }) => {
        const text = 'AI 回覆的格式不正確，請再試一次。';
        await installFakeGateway(page, { chunks: [ACCEPTED, sse('error', { code: 'format', message: text, retryable: true })] });
        await page.fill('#pathInput', 'Python');
        await page.click('#generatePathBtn');
        const message = page.locator('#pathResult p');
        await expect(message).toHaveText(text);
        await expect(message).toHaveClass(/text-red-700/);
        await expect(page.locator('#pathWork > *')).toHaveCount(0);
        await expect(page.locator('#generatePathBtn')).toBeEnabled();
    });

    test('再送出一次 → 舊的路徑先清掉，進度顯示在工作區', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done(RESULT)] });
        await page.fill('#pathInput', 'Python');
        await page.click('#generatePathBtn');
        await expect(page.locator('#pathResult > div')).toHaveCount(4);

        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.click('#generatePathBtn');
        await expect(page.locator('#pathWork .platform-ai-progress')).toHaveCount(1);
        await expect(page.locator('#pathResult > *')).toHaveCount(0);
    });

    test('輸入框最多 100 字（與閘道的任務規格相同），有無障礙名稱', async ({ page }) => {
        const input = page.locator('#pathInput');
        await expect(input).toHaveAttribute('maxlength', '100');
        await expect(input).toHaveAccessibleName('你想學習的主題');
    });

    // WebKit 連 aria-live="off" 的子樹也算進外層的 live region，進度區塊的計時器放在 live region 裡，
    // VoiceOver 會反覆朗讀。所以進度在工作區，結果區只放最後的結果或訊息。
    test('結果區 #pathResult 是 aria-live="polite"；進度區塊在不屬於任何 live region 的 #pathWork', async ({ page }) => {
        const work = page.locator('#pathWork');
        const result = page.locator('#pathResult');
        await expect(result).toHaveAttribute('aria-live', 'polite');

        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#pathInput', 'Python');
        await page.click('#generatePathBtn');
        await expect(work.getByRole('status')).toHaveText('已送出，等待 AI 開始…');
        await expect(work.locator('.platform-ai-progress')).toHaveCount(1);
        await expect(result.locator('.platform-ai-progress')).toHaveCount(0);
        const liveAncestor = await work.evaluate((el) => {
            const live = el.closest('[aria-live], [role="status"], [role="alert"], [role="log"]');
            return live && (live.id || live.outerHTML.slice(0, 80));
        });
        expect(liveAncestor).toBeNull();

        await push(page, done(RESULT));
        await expect(result.locator(':scope > div')).toHaveCount(4);
        await expect(work.locator(':scope > *')).toHaveCount(0);
        await expect(result).toHaveAttribute('aria-live', 'polite');
    });
});

// public/shared/platform-ai.js 回 404 或連線中斷時 PlatformAI 不存在。頁面仍要顯示錯誤訊息，
// 按鈕不能卡在「規劃中…」。
test.describe('學習資源地圖頁：共用腳本 platform-ai.js 沒載入成功', () => {
    const FAILURES = [
        ['回 404', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })],
        ['連線中斷', (route) => route.abort()],
    ];

    for (const [name, failScript] of FAILURES) {
        test(`${name} → 精選資源照常顯示；按下按鈕顯示錯誤訊息，按鈕恢復可按`, async ({ page }) => {
            await page.route('**/shared/platform-ai.js', failScript);
            await page.goto(PAGE);
            expect(await page.evaluate(() => typeof window.PlatformAI)).toBe('undefined');
            await expect(page.locator('#resource-grid .resource-card').first()).toBeVisible();

            await page.fill('#pathInput', 'Python');
            await page.click('#generatePathBtn');

            await expect(page.locator('#pathResult')).toHaveText('抱歉，AI 服務發生錯誤，請稍後再試。');
            await expectButtonRestored(page.locator('#generatePathBtn'));
        });
    }
});
