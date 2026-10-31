// 學習歷程的「AI 學習歷程健檢」（AI 閘道的 star-analysis 任務）：用頁內的假閘道驗證頁面怎麼送出、
// 顯示進度與結果、處理錯誤與取消。假閘道見 fake-gateway.js。
//
// 這個功能出現在不只一頁，元素的 id 與行為相同，同一組測試對 PAGES 裡的每一頁各跑一次。
// PAGES 記下測試會碰到的差異：R 項的名稱、按鈕有沒有圖示。
//
// 伺服器由 playwright.config.js 的 webServer 啟動（8001 埠是 .link-root，要先建置）。

const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';

const PAGES = [
    { name: '學習歷程首頁', path: '/learning-portfolio/index.html', rName: '結果', icon: true },
    { name: '反思引導提問集', path: '/learning-portfolio/reflection-guide.html', rName: '結果與反思', icon: false },
];

const ACCEPTED = sse('accepted', { requestId: 'req-1', task: 'star-analysis' });
const done = (result) => sse('done', { result, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 });

const RESULT = {
    overall_comment: '內容真誠，能看出你在活動中的投入，但結果與反思可以再具體。',
    // 鍵的順序故意打亂。閘道驗證時不看鍵的順序，頁面要自己照 S、T、A、R 排。
    analysis: {
        R: { comment: '只寫了活動很成功。', suggestion: '加上可衡量的成果與你的收穫。' },
        A: { comment: '行動描述詳細。', suggestion: '說明你為什麼這樣做。' },
        T: { comment: '任務目標不夠明確。', suggestion: '寫出你負責的具體工作。' },
        S: { comment: '交代了社團成果展的背景。', suggestion: '補上時間與你的角色。' },
    },
    revised_example: '高二上學期，我擔任熱舞社的活動長，負責籌辦期末成果展……',
};

// AI 的輸出是不可信來源。這組資料每個欄位都夾了會執行的標籤，頁面該把它們當純文字顯示。
const xssItem = (n) => ({ comment: `評論${n} ${XSS_IMG}`, suggestion: `建議${n} ${XSS_SCRIPT}` });
const XSS_RESULT = {
    overall_comment: `總評 ${XSS_IMG} ${XSS_SCRIPT}`,
    analysis: { S: xssItem(1), T: xssItem(2), A: xssItem(3), R: xssItem(4) },
    revised_example: `${XSS_SCRIPT}${XSS_IMG} 範例`,
};

// 結果與錯誤送達時，進度區塊都會跟著移除：[情況, 要送的 SSE 片段, 檢查畫面的函式]。
const FORMAT_ERROR = 'AI 回覆的格式不正確，請再試一次。';
const SETTLE = [
    ['結果送達', done(RESULT), (page) => expect(page.locator('#analysisResult')).toContainText(RESULT.overall_comment)],
    ['閘道回報錯誤', sse('error', { code: 'format', message: FORMAT_ERROR, retryable: true }),
        (page) => expect(page.locator('#analysisResult')).toHaveText(FORMAT_ERROR)],
];

for (const p of PAGES) {
    const PAGE = `${BASE}/sch001-108platform${p.path}`;

    test.describe(`${p.name}：AI 學習歷程健檢（star-analysis 任務）`, () => {
        test.beforeEach(async ({ page }) => {
            await page.goto(PAGE);
            await stubBuiltInGateway(page);
        });

        test('送出心得反思 → 依 S、T、A、R 的順序顯示總評、四項評論與建議、修改範例；按鈕恢復原狀', async ({ page }) => {
            await installFakeGateway(page, {
                chunks: [ACCEPTED, sse('progress', { phase: 'thinking', round: 1 }), done(RESULT)],
            });
            await page.fill('#reflectionInput', '  我在熱舞社擔任活動長……  ');
            await page.click('#analyzeBtn');

            const result = page.locator('#analysisResult');
            await expect(result).toContainText(RESULT.overall_comment);
            await expect(result.locator('h4')).toHaveText(['S (情境)', 'T (任務)', 'A (行動)', `R (${p.rName})`]);
            for (const element of ['S', 'T', 'A', 'R']) {
                const { comment, suggestion } = RESULT.analysis[element];
                const item = result.locator('h4', { hasText: `${element} (` }).locator('..');
                await expect(item).toContainText(`評語：${comment}`);
                await expect(item).toContainText(`建議：${suggestion}`);
            }
            await expect(result).toContainText(RESULT.revised_example);

            const calls = await page.evaluate(() => window.__calls);
            expect(calls).toHaveLength(1);
            expect(calls[0].url).toBe('https://gateway.example/v1/tasks/star-analysis');
            expect(JSON.parse(calls[0].body)).toEqual({ input: { reflection: '我在熱舞社擔任活動長……' } });

            const button = page.locator('#analyzeBtn');
            await expect(button).toBeEnabled();
            await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
            await expect(button).toHaveText('開始健檢');
            await expect(button.locator('svg')).toHaveCount(p.icon ? 1 : 0);
        });

        test('總評與修改範例裡的 # 標題是 h3 底下的 h4，清單項目在 <ul> 裡；評語與建議裡的 # 照舊是粗體', async ({ page }) => {
            const marked = {
                ...RESULT,
                overall_comment: '## 優點\n- 投入\n- 真誠',
                analysis: { ...RESULT.analysis, S: { comment: '# 背景', suggestion: '補上時間。' } },
                revised_example: '## 改寫\n高二上學期……',
            };
            await installFakeGateway(page, { chunks: [ACCEPTED, done(marked)] });
            await page.fill('#reflectionInput', '心得');
            await page.click('#analyzeBtn');
            const result = page.locator('#analysisResult');
            await expect(result.getByRole('heading', { level: 3 })).toHaveText(['健檢總評', 'STAR 分析與建議', '修改範例']);
            await expect(result.getByRole('heading', { level: 4 })).toHaveText(['優點', 'S (情境)', 'T (任務)', 'A (行動)', `R (${p.rName})`, '改寫']);
            await expect(result.locator('ul > li')).toHaveText(['投入', '真誠']);
            await expect(result.locator('span strong')).toHaveText(['背景']);
        });

        test('收到 progress 事件 → 工作區的進度文字跟著換，例如「AI 正在思考（第 2 輪）…」', async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await page.fill('#reflectionInput', '心得');
            await page.click('#analyzeBtn');
            await page.evaluate((chunk) => window.__stream.push(chunk), sse('progress', { phase: 'thinking', round: 2 }));
            await expect(page.locator('#analysisWork').getByRole('status')).toHaveText('AI 正在思考（第 2 輪）…');
        });

        test('AI 回傳含 HTML 標籤的文字 → 每個欄位都當純文字原樣顯示，不產生 img／script 元素，也不執行', async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED, done(XSS_RESULT)] });
            await page.fill('#reflectionInput', '心得');
            await page.click('#analyzeBtn');

            const result = page.locator('#analysisResult');
            await expect(result).toContainText(XSS_RESULT.overall_comment);
            for (const { comment, suggestion } of Object.values(XSS_RESULT.analysis)) {
                await expect(result).toContainText(comment);
                await expect(result).toContainText(suggestion);
            }
            await expect(result).toContainText(XSS_RESULT.revised_example);
            await expect(result.locator('img, script, [onerror]')).toHaveCount(0);

            // img 的 onerror 要等圖片載入失敗才會執行，所以等一下再檢查。
            await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
            expect(await page.evaluate(() => window.__xss)).toBeUndefined();
        });

        test('閘道網址沒有設定 → 以錯誤的樣式顯示「尚未設定」，不送出請求', async ({ page }) => {
            await installFakeGateway(page, { withMeta: false });
            await page.fill('#reflectionInput', '心得');
            await page.click('#analyzeBtn');
            const result = page.locator('#analysisResult');
            await expect(result).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
            await expect(result.locator('p')).toHaveClass(/text-red-700/);
            expect(await page.evaluate(() => window.__calls.length)).toBe(0);
        });

        test('沒有輸入（或只有空白）就按 → 提示先輸入，不送出請求', async ({ page }) => {
            await installFakeGateway(page);
            for (const value of ['', ' \n\t ']) {
                await page.fill('#reflectionInput', value);
                await page.click('#analyzeBtn');
                await expect(page.locator('#analysisResult')).toHaveText('請先貼上你的心得反思文字！');
            }
            expect(await page.evaluate(() => window.__calls.length)).toBe(0);
        });

        test('進行中用鍵盤按「取消」→ 以提示的樣式（不是錯誤）顯示「已取消。」，焦點回到「開始健檢」按鈕，按鈕恢復可按', async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await page.fill('#reflectionInput', '心得');
            await page.click('#analyzeBtn');
            const button = page.locator('#analyzeBtn');
            await expect(button).toHaveAttribute('aria-disabled', 'true');
            await expect(button).toHaveText('健檢中…');
            await page.locator('#analysisWork').getByRole('button', { name: '取消' }).focus();
            await page.keyboard.press('Enter');
            const result = page.locator('#analysisResult');
            await expect(result).toHaveText('已取消。');
            await expect(result.locator('p')).toHaveClass(/text-gray-600/);
            await expect(result.locator('p')).not.toHaveClass(/text-red-700/);
            await expect(button).toBeEnabled();
            // 取消鈕隨進度區塊移除。空的工作區看不到焦點框；焦點移進結果區的話，螢幕閱讀器會唸一次
            // 訊息，live region 又唸一次。
            await expect(button).toBeFocused();
            for (const el of [button, page.locator('#analysisWork'), result]) await expect(el).not.toHaveAttribute('tabindex');
        });

        for (const [when, chunk, expectSettled] of SETTLE) {
            test(`等待時焦點停在「取消」上，${when} → 焦點交給「開始健檢」按鈕，不掉回 <body>`, async ({ page }) => {
                await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
                await page.fill('#reflectionInput', '心得');
                await page.click('#analyzeBtn');
                const cancel = page.locator('#analysisWork').getByRole('button', { name: '取消' });
                await cancel.focus();
                await expect(cancel).toBeFocused();
                await page.evaluate((c) => window.__stream.push(c), chunk);
                await expectSettled(page);
                await expect(page.locator('#analyzeBtn')).toBeFocused();
            });
        }

        // disabled 的按鈕會失去焦點，瀏覽器下一次更新畫面時就把焦點移到 <body>。
        test('用鍵盤按「開始健檢」→ 進行中按鈕是 aria-disabled，再按不會重送；等待中與完成後，焦點都留在按鈕上', async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await page.fill('#reflectionInput', '心得');
            const button = page.locator('#analyzeBtn');
            await button.focus();
            await page.keyboard.press('Enter');
            await expect(button).toHaveAttribute('aria-disabled', 'true');
            await expect(button).not.toHaveAttribute('disabled');
            await expect(button).toContainClass('opacity-50 cursor-not-allowed');
            // 等過一次畫面更新再看焦點。
            await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.keyboard.press('Enter');
            await expect(button).toBeFocused();
            expect(await page.evaluate(() => window.__calls.length)).toBe(1);

            await page.evaluate((chunk) => window.__stream.push(chunk), done(RESULT));
            await expect(page.locator('#analysisResult')).toContainText(RESULT.overall_comment);
            await expect(button).toBeEnabled();
            await expect(button).not.toHaveAttribute('aria-disabled');
            await expect(button).toBeFocused();
        });

        test('輸入框最多 2000 字（與閘道的任務規格相同），下方寫著這個上限；有無障礙名稱，上限說明是它的描述', async ({ page }) => {
            const LIMIT_TEXT = '最多 2000 字，超過的部分貼不進來。';
            const input = page.locator('#reflectionInput');
            await expect(input).toHaveAttribute('maxlength', '2000');
            await expect(input).toHaveAccessibleName('你的心得反思');
            await expect(input).toHaveAccessibleDescription(LIMIT_TEXT);
            // 被 aria-describedby 指到的元素就算隱藏了，描述也照樣算得出來，所以另外檢查看不看得到。
            const hint = page.locator(`#${await input.getAttribute('aria-describedby')}`);
            await expect(hint).toBeVisible();
            await expect(hint).toHaveText(LIMIT_TEXT);
        });

        // 進度區塊不能在 live region 裡：WebKit 把 aria-live="off" 子樹的變化也算進外層的 live region，
        // Safari + VoiceOver 會反覆唸出計時器與取消鈕。
        test('進度區塊在沒有 aria-live 的工作區；結果區是 aria-live="polite"，只放最後的結果', async ({ page }) => {
            const work = page.locator('#analysisWork');
            const result = page.locator('#analysisResult');
            await expect(work).not.toHaveAttribute('aria-live');
            await expect(result).toHaveAttribute('aria-live', 'polite');

            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await page.fill('#reflectionInput', '心得');
            await page.click('#analyzeBtn');
            await expect(work.locator('.platform-ai-progress')).toHaveCount(1);
            await expect(page.locator(':is([aria-live], [role=status], [role=alert], [role=log]) .platform-ai-progress')).toHaveCount(0);
            await expect(result).toBeEmpty();

            await page.evaluate((chunk) => window.__stream.push(chunk), done(RESULT));
            await expect(result).toContainText(RESULT.overall_comment);
            await expect(work).toBeEmpty();
        });

        test('再送出一次 → 上一次的結果先清掉，等待時結果區是空的', async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED, done(RESULT)] });
            await page.fill('#reflectionInput', '心得');
            await page.click('#analyzeBtn');
            const result = page.locator('#analysisResult');
            await expect(result).toContainText(RESULT.overall_comment);

            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await page.click('#analyzeBtn');
            await expect(page.locator('#analysisWork .platform-ai-progress')).toHaveCount(1);
            await expect(result).toBeEmpty();
        });
    });

    // platform-ai.js 沒載入時 PlatformAI 不存在。404 與連線中斷都要顯示錯誤訊息，按鈕不能卡在「健檢中…」。
    test.describe(`${p.name}：共用腳本 platform-ai.js 沒載入成功`, () => {
        const FAILURES = [
            ['回 404', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })],
            ['連線中斷', (route) => route.abort()],
        ];

        for (const [name, failScript] of FAILURES) {
            test(`${name} → 按下按鈕顯示錯誤訊息，按鈕恢復可按`, async ({ page }) => {
                await page.route('**/shared/platform-ai.js', failScript);
                await page.goto(PAGE);
                expect(await page.evaluate(() => typeof window.PlatformAI)).toBe('undefined');

                await page.fill('#reflectionInput', '心得');
                await page.click('#analyzeBtn');

                await expect(page.locator('#analysisResult')).toHaveText('抱歉，AI 服務發生錯誤，請稍後再試。');
                const button = page.locator('#analyzeBtn');
                await expect(button).toBeEnabled();
                await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
                await expect(button).toHaveText('開始健檢');
                await expect(button.locator('svg')).toHaveCount(p.icon ? 1 : 0);
            });
        }
    });
}
