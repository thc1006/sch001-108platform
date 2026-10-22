// 公民科技地圖的「AI 探索建議」（AI 閘道的 civic-tech-suggestion 任務）：用頁內的假閘道驗證頁面
// 怎麼送出、邊收邊顯示答案、處理錯誤與取消。假閘道見 fake-gateway.js。
//
// 進度區塊與草稿在工作區 #ai-workspace，最後的結果或訊息在結果區 #ai-results（live region）。
//
// 伺服器由 playwright.config.js 的 webServer 啟動（8001 埠是 .link-root，要先建置）。
const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/civic-tech-map/index.html`;

const ACCEPTED = sse('accepted', { requestId: 'req-1', task: 'civic-tech-suggestion' });
const done = (result) => sse('done', { result, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 });
const delta = (text) => sse('delta', { text });
const push = (page, ...chunks) => page.evaluate((chunks) => chunks.forEach((c) => window.__stream.push(c)), chunks);
// display: none 的元素沒有 box。不用 toBeHidden()：高度 0 的元素它也算看不見。
const hasBox = (locator) => locator.evaluate((el) => el.checkVisibility());
// 這些角色與 <output>（隱含 role="status"）不寫 aria-live 也是 live region。
const LIVE_REGION = '[aria-live], [role="alert"], [role="log"], [role="marquee"], [role="status"], [role="timer"], output';

test.describe('公民科技地圖：AI 探索建議（civic-tech-suggestion 任務）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PAGE);
        await stubBuiltInGateway(page);
    });

    test('答案邊收邊顯示：草稿在工作區，收到 done 後結果區顯示 done 的答案；按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, {
            chunks: [
                ACCEPTED,
                sse('progress', { phase: 'writing', round: 1 }),
                delta('**Cofacts 真的假的**\n'),
                delta('推薦原因：你關心假訊息。'),
            ],
            hang: true,
        });
        await page.fill('#ai-interest-input', '  我關心假訊息  ');
        await page.click('#ai-submit-btn');

        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        const button = page.locator('#ai-submit-btn');

        // 草稿出現時進度區塊還在（可以取消），兩者都在工作區，結果區是空的；按鈕仍停用。
        const draft = workspace.locator('.ai-result-text');
        await expect(draft.locator('strong')).toHaveText(['Cofacts 真的假的']);
        await expect(draft).toHaveText('Cofacts 真的假的推薦原因：你關心假訊息。');
        await expect(workspace.getByRole('status')).toHaveText('AI 正在撰寫回答…');
        await expect(workspace.getByRole('button', { name: '取消' })).toBeVisible();
        await expect(results.locator('*')).toHaveCount(0);
        await expect(button).toBeDisabled();
        await expect(button).toHaveText('分析中…');

        await push(page, delta('\n探索建議：當查核志工。'));
        await expect(draft).toHaveText('Cofacts 真的假的推薦原因：你關心假訊息。探索建議：當查核志工。');

        // done 的結果和片段接起來的不同（多了後半句）：畫面要以 done 為準。
        await push(page, done('**Cofacts 真的假的**\n推薦原因：你關心假訊息。\n探索建議：當查核志工，整理查核技巧。'));
        const answer = results.locator('.ai-result-text');
        await expect(answer).toHaveText('Cofacts 真的假的推薦原因：你關心假訊息。探索建議：當查核志工，整理查核技巧。');
        await expect(answer.locator('strong')).toHaveText(['Cofacts 真的假的']);
        await expect(results.getByRole('heading', { name: 'AI 推薦結果' })).toBeVisible();
        await expect(results).toContainText('AI 建議僅供參考，實際專案內容請以各專案官網為準。');
        await expect(workspace.locator('*')).toHaveCount(0);
        expect(await hasBox(workspace)).toBe(false);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/civic-tech-suggestion');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { interest: '我關心假訊息' } });

        // 按鈕恢復可按，文字與圖示都還在。
        await expect(button).toBeEnabled();
        await expect(button).toHaveText('探索推薦');
        await expect(button.locator('svg')).toHaveCount(1);
    });

    test('閘道只回 done、沒有片段 → 直接在結果區顯示答案', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('**LawTrace 立法足跡**\n推薦原因：你想讀法律。')] });
        await page.fill('#ai-interest-input', '法律');
        await page.click('#ai-submit-btn');
        const answer = page.locator('#ai-results .ai-result-text');
        await expect(answer).toHaveText('LawTrace 立法足跡推薦原因：你想讀法律。');
        await expect(answer.locator('strong')).toHaveText(['LawTrace 立法足跡']);
    });

    test('AI 回傳含 HTML 標籤的文字 → 草稿與最後的答案都當純文字顯示，不產生 img／script 元素，也不執行', async ({ page }) => {
        const text = `**${XSS_SCRIPT}** ${XSS_IMG}`;
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');

        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        const injected = page.locator('#ai-workspace img, #ai-workspace script, #ai-workspace [onerror], #ai-results img, #ai-results script, #ai-results [onerror]');
        // 分兩段送：第一段建立草稿，第二段走「更新草稿」那條路，兩條都要擋得住。
        await expect(workspace.locator('.ai-result-text')).toHaveCount(1);
        await push(page, delta(text.slice(2)));
        await expect(workspace.locator('.ai-result-text strong')).toHaveText([XSS_SCRIPT]);
        await expect(workspace).toContainText(XSS_IMG);
        await expect(injected).toHaveCount(0);

        await push(page, done(`${text}\n${XSS_IMG}${XSS_SCRIPT}`));
        await expect(results.locator('.ai-result-text')).toContainText(`${XSS_IMG}${XSS_SCRIPT}`);
        await expect(results.locator('.ai-result-text strong')).toHaveText([XSS_SCRIPT]);
        await expect(injected).toHaveCount(0);

        // img 的 onerror 要等圖片載入失敗才會跑；若真的塞進了 <img src=x>，這一等就會讓它現形。
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('閘道回 error 事件 → 草稿移除，結果區用紅字顯示閘道的訊息，夾帶的標籤當純文字', async ({ page }) => {
        const message = `AI 服務暫時無法使用 ${XSS_IMG}`;
        await installFakeGateway(page, {
            chunks: [ACCEPTED, delta('草稿'), sse('error', { code: 'unavailable', message, retryable: true })],
        });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const results = page.locator('#ai-results');
        await expect(results).toHaveText(message);
        await expect(results.locator('p')).toHaveClass(/text-red-700/);
        await expect(results.locator('img, [onerror]')).toHaveCount(0);
        await expect(page.locator('#ai-workspace *')).toHaveCount(0);
    });

    test('閘道網址沒有設定 → 結果區顯示「尚未設定」，不送出請求', async ({ page }) => {
        await installFakeGateway(page, { withMeta: false });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        await expect(page.locator('#ai-results')).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
        await expect(page.locator('#ai-workspace *')).toHaveCount(0);
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('沒有輸入（或只有空白）就按 → 焦點回到輸入框，不送出請求，也不顯示任何東西', async ({ page }) => {
        await installFakeGateway(page);
        for (const value of ['', ' \n\t ']) {
            await page.fill('#ai-interest-input', value);
            await page.click('#ai-submit-btn');
            await expect(page.locator('#ai-interest-input')).toBeFocused();
        }
        await expect(page.locator('#ai-results *, #ai-workspace *')).toHaveCount(0);
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('草稿出現後按「取消」→ 草稿移除，結果區顯示「已取消。」（不是紅字）並取得焦點，按鈕恢復可按', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**Cofacts 真的假的**')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        await expect(workspace.locator('.ai-result-text strong')).toHaveText(['Cofacts 真的假的']);

        await workspace.getByRole('button', { name: '取消' }).click();
        await expect(results).toHaveText('已取消。');
        await expect(results.locator('p')).toHaveClass(/text-gray-700/);
        await expect(workspace.locator('*')).toHaveCount(0);
        // 取消鈕跟著進度區塊移除，焦點不能掉回 <body>。
        await expect(results).toBeFocused();
        await expect(page.locator('#ai-submit-btn')).toBeEnabled();
    });

    test('串流在 done 之前就斷了 → 草稿移除，結果區用紅字顯示連線中斷', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**Cofacts 真的假的**')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        // 等草稿出現才結束串流（等於閘道重啟、通道斷線），才驗得到草稿有被移除。
        await expect(workspace.locator('.ai-result-text strong')).toHaveText(['Cofacts 真的假的']);
        await page.evaluate(() => window.__stream.end());
        await expect(results).toHaveText('和 AI 服務的連線中斷了，請再試一次。');
        await expect(results.locator('p')).toHaveClass(/text-red-700/);
        await expect(workspace.locator('*')).toHaveCount(0);
        await expect(page.locator('#ai-submit-btn')).toBeEnabled();
    });

    test('再送一次時，上一次的結果先清掉', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('**Cofacts 真的假的**')] });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const results = page.locator('#ai-results');
        await expect(results.locator('.ai-result-text')).toHaveText('Cofacts 真的假的');

        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.click('#ai-submit-btn');
        await expect(page.locator('#ai-workspace').getByRole('button', { name: '取消' })).toBeVisible();
        await expect(results.locator('*')).toHaveCount(0);
    });

    test('輸入框最多 300 字（與閘道的任務規格相同），看得到上限說明，有無障礙名稱；字數跟著更新', async ({ page }) => {
        const input = page.locator('#ai-interest-input');
        await expect(input).toHaveAttribute('maxlength', '300');
        await expect(input).toHaveAccessibleName('你的興趣或關心的議題');
        await expect(input).toHaveAccessibleDescription('最多 300 字。');
        await expect(page.locator('#ai-interest-hint')).toBeVisible();
        await input.fill('環境保護');
        await expect(page.locator('#ai-char-count')).toHaveText('4 / 300');
    });

    // 進度區塊與草稿一直在變，放進 live region 就會一直被唸；WebKit 連計時器的 aria-live="off" 也不理會。
    // 所以它們在工作區，結果區只放最後的結果或訊息。
    test('結果區是 aria-live="polite"、一開始就沒有被隱藏；工作區不在任何 live region 裡、空的時候不佔版面，進度區塊與草稿只在工作區', async ({ page }) => {
        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        await expect(results).toHaveAttribute('aria-live', 'polite');
        // display: none 的 live region 不在無障礙樹裡，第一則訊息出現時才一起冒出來，不會被唸。
        expect(await hasBox(results)).toBe(true);
        // 工作區有 mt-6，空的時候沒藏起來，AI 區塊底下就會多出這段外距。
        expect(await hasBox(workspace)).toBe(false);

        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**草稿**')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const draft = workspace.locator('.ai-result-text');
        await expect(draft).toHaveText('草稿');
        await expect(workspace.locator('.platform-ai-progress')).toHaveCount(1);
        await expect(results.locator('*')).toHaveCount(0);
        // 從草稿往上找，草稿的外框也算在內；等草稿出現才找，送出後才由程式加上的屬性也抓得到。
        expect(await draft.evaluate((el, selector) => el.closest(selector), LIVE_REGION)).toBeNull();

        await push(page, done('**最後的答案**'));
        await expect(results.locator('.ai-result-text')).toHaveText('最後的答案');
        await expect(workspace.locator('*')).toHaveCount(0);
        await expect(results).toHaveAttribute('aria-live', 'polite');
    });
});

// 共用腳本 public/shared/platform-ai.js 沒載入成功時，PlatformAI 不存在。404（檔案沒部署好、路徑錯）
// 與連線中斷（網路、被擋）頁面的處理應該相同：顯示錯誤訊息，按鈕不能卡在「分析中…」。
test.describe('公民科技地圖：共用腳本 platform-ai.js 沒載入成功', () => {
    const FAILURES = [
        ['回 404', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })],
        ['連線中斷', (route) => route.abort()],
    ];

    for (const [name, failScript] of FAILURES) {
        test(`${name} → 按下按鈕顯示錯誤訊息，按鈕恢復可按`, async ({ page }) => {
            await page.route('**/shared/platform-ai.js', failScript);
            await page.goto(PAGE);
            expect(await page.evaluate(() => typeof window.PlatformAI)).toBe('undefined');

            await page.fill('#ai-interest-input', '假訊息');
            await page.click('#ai-submit-btn');

            await expect(page.locator('#ai-results')).toHaveText('抱歉，AI 服務發生錯誤，請稍後再試。');
            const button = page.locator('#ai-submit-btn');
            await expect(button).toBeEnabled();
            await expect(button).toHaveText('探索推薦');
            await expect(button.locator('svg')).toHaveCount(1);
        });
    }
});
