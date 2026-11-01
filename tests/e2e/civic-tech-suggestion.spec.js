// 公民科技專案頁的「讓 AI 幫你挑」（AI 閘道的 civic-tech-suggestion 任務）：用頁內的假閘道驗證頁面
// 怎麼送出、邊收邊顯示答案、處理錯誤與取消。假閘道見 fake-gateway.js。
//
// 進度區塊與草稿在工作區 #ai-workspace，最後的結果或訊息在結果區 #ai-results。兩者都不是 live region，
// 要唸的摘要與訊息寫進 #ai-status（role="status"）。
//
// 伺服器由 playwright.config.js 的 webServer 啟動（8001 埠是 .link-root，要先建置）。
const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway, watchDraws, drawStats, afterFrames, reloadWithoutPerFrame, outsideLiveRegions, watchStatus, statusWrites } = require('./fake-gateway');

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
// 答案與錯誤送達時，進度區塊都會跟著移除：[情況, 要送的 SSE 片段, 檢查畫面的函式]。錯誤之前已經收到草稿，
// 草稿標明沒有寫完、留在結果區，訊息接在最後。
const FORMAT_ERROR = 'AI 回覆的格式不正確，請再試一次。';
const SETTLE = [
    ['收到 done', done('**最後的答案**'), (page) => expect(page.locator('#ai-results .ai-result-text')).toHaveText('最後的答案')],
    ['閘道回報錯誤', sse('error', { code: 'format', message: FORMAT_ERROR, retryable: true }),
        (page) => expect(page.locator('#ai-results > div').last()).toHaveText(FORMAT_ERROR)],
];

test.describe('公民科技專案頁：讓 AI 幫你挑（civic-tech-suggestion 任務）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PAGE);
        await stubBuiltInGateway(page);
    });

    test('回答停在「**Cofacts」就斷了 → 草稿與沒寫完的回答都不留字面的 **', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('推薦 **Cofacts 真的假的')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        await expect(page.locator('#ai-workspace .ai-result-text')).toHaveText('推薦 Cofacts 真的假的');
        await push(page, sse('error', { code: 'incomplete', message: '沒寫完' }));
        await expect(page.locator('#ai-results .ai-result-text')).toHaveText('推薦 Cofacts 真的假的');
    });

    test('答案裡的 # 標題是框裡 h3「AI 推薦結果」底下的 h4，清單項目在 <ul> 裡，不多出空行', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('## 推薦專案\n- Cofacts 真的假的\n- 零時政府\n\n## 下一步\n到專案的頁面看看。')] });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const answer = page.locator('#ai-results .ai-result-text');
        await expect(answer.getByRole('heading', { level: 4 })).toHaveText(['推薦專案', '下一步']);
        await expect(answer.locator('ul > li')).toHaveText(['Cofacts 真的假的', '零時政府']);
        await expect(answer.locator('li:not(ul > li)')).toHaveCount(0);
        // 框有 whitespace-pre-line，輸出裡不能留下換行字元，否則每個標籤之間都多一行空白
        expect(await answer.evaluate((el) => el.innerHTML.includes('\n'))).toBe(false);
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
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).toContainClass('opacity-50 cursor-not-allowed');
        await expect(button).toHaveText('分析中…');

        await push(page, delta('\n探索建議：當查核志工。'));
        await expect(draft).toHaveText('Cofacts 真的假的推薦原因：你關心假訊息。探索建議：當查核志工。');

        // done 的結果和片段接起來的不同（多了後半句）：畫面要以 done 為準。
        await push(page, done('**Cofacts 真的假的**\n推薦原因：你關心假訊息。\n探索建議：當查核志工，整理查核技巧。'));
        const answer = results.locator('.ai-result-text');
        await expect(answer).toHaveText('Cofacts 真的假的推薦原因：你關心假訊息。探索建議：當查核志工，整理查核技巧。');
        await expect(answer.locator('strong')).toHaveText(['Cofacts 真的假的']);
        await expect(results.getByRole('heading', { name: 'AI 推薦結果' })).toBeVisible();
        await expect(results).toContainText('AI 的回答可能有錯，專案現況以各專案官網為準。');
        await expect(workspace.locator('*')).toHaveCount(0);
        expect(await hasBox(workspace)).toBe(false);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/civic-tech-suggestion');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { interest: '我關心假訊息' } });

        // 按鈕恢復可按，文字與圖示都還在。
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        await expect(button).toHaveText('推薦專案');
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

    test('閘道回 error 事件（之前沒有片段）→ 結果區用紅字顯示閘道的訊息，夾帶的標籤當純文字', async ({ page }) => {
        const message = `AI 服務暫時無法使用 ${XSS_IMG}`;
        await installFakeGateway(page, {
            chunks: [ACCEPTED, sse('error', { code: 'unavailable', message, retryable: true })],
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

    test('進行中焦點在按鈕上按 Esc → 和按「取消」一樣顯示「已取消。」，焦點留在按鈕；輸入法選字中的 Esc 不取消', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-interest-input', '測試');
        await page.click('#ai-submit-btn');
        const progress = page.locator('#ai-workspace .platform-ai-progress');
        await expect(progress).toHaveCount(1);
        const target = page.locator('#ai-submit-btn');
        await target.focus();
        await target.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
        await expect(progress).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#ai-results')).toHaveText('已取消。');
        await expect(progress).toHaveCount(0);
        await expect(target).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    test('草稿出現後用鍵盤按「取消」→ 草稿移除，結果區顯示「已取消。」（不是紅字），焦點回到「推薦專案」按鈕，按鈕恢復可按', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**Cofacts 真的假的**')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        const button = page.locator('#ai-submit-btn');
        await expect(workspace.locator('.ai-result-text strong')).toHaveText(['Cofacts 真的假的']);

        await workspace.getByRole('button', { name: '取消' }).focus();
        await page.keyboard.press('Enter');
        await expect(results).toHaveText('已取消。');
        await expect(results.locator('p')).toHaveClass(/text-gray-700/);
        await expect(workspace.locator('*')).toHaveCount(0);
        await expect(button).toBeEnabled();
        // 取消鈕跟著進度區塊移除，清空的工作區也藏起來了；焦點移進結果區的話，螢幕閱讀器會唸一次
        // 訊息，#ai-status 又唸一次。
        await expect(button).toBeFocused();
        for (const el of [button, workspace, results]) await expect(el).not.toHaveAttribute('tabindex');
    });

    for (const [when, chunk, expectSettled] of SETTLE) {
        test(`焦點在「取消」上時${when} → 草稿移除，焦點回到「推薦專案」按鈕`, async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED, delta('**草稿**')], hang: true });
            await page.fill('#ai-interest-input', '假訊息');
            await page.click('#ai-submit-btn');
            const workspace = page.locator('#ai-workspace');
            await expect(workspace.locator('.ai-result-text')).toHaveText('草稿');

            await workspace.getByRole('button', { name: '取消' }).focus();
            await push(page, chunk);
            await expectSettled(page);
            await expect(workspace.locator('*')).toHaveCount(0);
            await expect(page.locator('#ai-submit-btn')).toBeFocused();
            await expect(page.locator('#ai-results')).not.toHaveAttribute('tabindex');
        });
    }

    // 錯誤帶著已經收到、看得見的答案時都留下來（沒寫完、斷線、逾時、接續輪忙線），標明沒有寫完
    const PARTIAL_ERRORS = [
        ['incomplete', 'AI 的回答太長，沒能在時限內寫完。請把問題縮小一點再試。'],
        ['timeout', 'AI 思考的時間超過上限了，請稍後再試，或把內容寫得更具體一些。'],
    ];
    for (const [code, message] of PARTIAL_ERRORS) test(`已經收到答案之後收到 ${code} → 已收到的部分標明沒有寫完、留在結果區，紅字訊息接在下面；工作區清空，焦點回到「推薦專案」按鈕`, async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**Cofacts 真的假的**：'), delta('適合想')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        const button = page.locator('#ai-submit-btn');
        await expect(workspace.locator('.ai-result-text')).toHaveText('Cofacts 真的假的：適合想');

        await workspace.getByRole('button', { name: '取消' }).focus();
        await push(page, sse('error', { code, message, retryable: code !== 'incomplete' }));
        // 先放答案再放訊息
        const boxes = results.locator(':scope > div');
        await expect(boxes).toHaveCount(2);
        await expect(boxes.nth(0).locator('h3')).toHaveText('AI 推薦結果（沒有寫完）');
        await expect(boxes.nth(0).locator('.ai-result-text')).toHaveText('Cofacts 真的假的：適合想');
        await expect(boxes.nth(1)).toHaveText(message);
        await expect(boxes.nth(1).locator('p')).toHaveClass(/text-red-700/);
        await expect(workspace.locator('*')).toHaveCount(0);
        await expect(button).toBeFocused();
        for (const el of [button, workspace, results]) await expect(el).not.toHaveAttribute('tabindex');
    });

    test('一次收到 200 段：草稿畫的次數不超過畫面數，畫出來的是最新的全文', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        await expect(workspace.getByRole('button', { name: '取消' })).toBeVisible();
        await watchDraws(page);
        await push(page, ...Array.from({ length: 200 }, (_, i) => delta(`第 ${i + 1} 段。`)));
        await expect(workspace.locator('.ai-result-text')).toContainText('第 200 段。');
        const { renders, frames } = await drawStats(page);
        expect(renders).toBeLessThanOrEqual(frames);
    });

    // 草稿等下一個畫面才畫；結束事件在那之前就到了，之後的畫面不能把草稿畫回來。
    const ENDS = [
        ['done', done('**最後的答案**'), ['AI 推薦結果', '最後的答案']],
        // 沒寫完的答案停在 ** 的中間：落單的 ** 拿掉
        ['incomplete', sse('error', { code: 'incomplete', message: '沒寫完' }), ['AI 推薦結果（沒有寫完）', '最後']],
    ];
    for (const [code, end, [heading, expected]] of ENDS) test(`片段與 ${code} 在同一個畫面之前送達 → 結果區是最後的答案，之後的畫面不再畫出草稿`, async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        await expect(workspace.getByRole('button', { name: '取消' })).toBeVisible();
        await push(page, delta('**最'), delta('後'), end);
        await expect(page.locator('#ai-results h3')).toHaveText(heading);
        await expect(page.locator('#ai-results .ai-result-text')).toHaveText(expected);
        await afterFrames(page);
        await expect(workspace.locator('*')).toHaveCount(0);
    });

    test('片段送達、還沒畫出來就取消 → 結果區顯示「已取消。」，之後的畫面不再畫出草稿', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        await expect(workspace.getByRole('button', { name: '取消' })).toBeVisible();
        // 這個 requestAnimationFrame 排在頁面畫草稿的前面，取消發生在同一個畫面裡、草稿畫出來之前。
        await page.evaluate((chunk) => {
            window.__stream.push(chunk);
            requestAnimationFrame(() => document.querySelector('#ai-workspace button').click());
        }, delta('**草稿**'));
        await expect(page.locator('#ai-results')).toHaveText('已取消。');
        await afterFrames(page);
        await expect(workspace.locator('*')).toHaveCount(0);
    });

    test('platform-ai.js 是沒有 perFrame 的舊版 → 照樣送出請求、邊收邊畫草稿，收到 done 後結果區顯示答案；按鈕恢復，第二次照常', async ({ page }) => {
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await reloadWithoutPerFrame(page);
        await stubBuiltInGateway(page);
        expect(await page.evaluate(() => typeof PlatformAI.perFrame)).toBe('undefined');
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**草'), delta('稿**')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        await expect(workspace.locator('.ai-result-text')).toHaveText('草稿');
        await push(page, done('**最後的答案**'));
        await expect(page.locator('#ai-results .ai-result-text')).toHaveText('最後的答案');
        await expect(workspace.locator('*')).toHaveCount(0);
        const button = page.locator('#ai-submit-btn');
        await expect(button).not.toHaveAttribute('aria-disabled');
        await expect(button).toHaveText('推薦專案');
        await button.click();
        await expect(workspace.locator('.ai-result-text')).toHaveText('草稿');
        await push(page, done('**第二次的答案**'));
        await expect(page.locator('#ai-results .ai-result-text')).toHaveText('第二次的答案');
        expect(await page.evaluate(() => window.__calls.length)).toBe(2);
        expect(errors).toEqual([]);
    });

    // disabled 的按鈕會失去焦點，瀏覽器下一次更新畫面時就把焦點移到 <body>。
    test('用鍵盤按「推薦專案」→ 進行中按鈕是 aria-disabled，再按不會重送；等待中與完成後，焦點都留在按鈕上', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        const button = page.locator('#ai-submit-btn');
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).not.toHaveAttribute('disabled');
        // 等過一次畫面更新再看焦點。
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.keyboard.press('Enter');
        await expect(button).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);

        await push(page, done('**最後的答案**'));
        await expect(page.locator('#ai-results .ai-result-text')).toHaveText('最後的答案');
        await expect(button).toBeEnabled();
        await expect(button).toBeFocused();
    });

    test('串流在 done 之前就斷了 → 已收到的部分標明沒有寫完、留在結果區，連線中斷的紅字訊息接在下面；草稿移除', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**Cofacts 真的假的**')], hang: true });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        // 等草稿出現才結束串流（等於閘道重啟、通道斷線），才驗得到草稿有被移除。
        await expect(workspace.locator('.ai-result-text strong')).toHaveText(['Cofacts 真的假的']);
        await page.evaluate(() => window.__stream.end());
        const boxes = results.locator(':scope > div');
        await expect(boxes).toHaveCount(2);
        await expect(boxes.nth(0).locator('h3')).toHaveText('AI 推薦結果（沒有寫完）');
        await expect(boxes.nth(0).locator('.ai-result-text strong')).toHaveText(['Cofacts 真的假的']);
        await expect(boxes.nth(1)).toHaveText('和 AI 服務的連線中斷了，請再試一次。');
        await expect(boxes.nth(1).locator('p')).toHaveClass(/text-red-700/);
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

    test('輸入框最多 300 字（與閘道的任務規格相同），有無障礙名稱；字數「n / 300」是輸入框的描述，跟著更新', async ({ page }) => {
        const input = page.locator('#ai-interest-input');
        await expect(input).toHaveAttribute('maxlength', '300');
        await expect(input).toHaveAccessibleName('你的興趣或關心的議題');
        await expect(input).toHaveAccessibleDescription('0 / 300');
        await input.fill('環境保護');
        await expect(page.locator('#ai-char-count')).toHaveText('4 / 300');
        await expect(input).toHaveAccessibleDescription('4 / 300');
    });

    // 進度區塊與草稿一直在變，放進 live region 就會一直被唸；WebKit 連計時器的 aria-live="off" 也不理會。
    // 結果有標題、清單與提醒，整段放進 live region 會被唸成一長串。所以兩區都不是 live region。
    test('工作區與結果區都不在任何 live region 裡；工作區空的時候不佔版面，進度區塊與草稿只在工作區', async ({ page }) => {
        const workspace = page.locator('#ai-workspace');
        const results = page.locator('#ai-results');
        expect(await outsideLiveRegions(results)).toBe(true);
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
        expect(await outsideLiveRegions(results)).toBe(true);
    });

    test('#ai-status 是載入時就在、視覺上隱藏的 role="status"；完成時只唸一句摘要，錯誤與取消照原文唸，沒寫完的答案說出在哪個標題下', async ({ page }) => {
        const status = page.locator('#ai-status');
        const results = page.locator('#ai-results');
        await expect(status).toHaveAttribute('role', 'status');
        await expect(status).toHaveClass(/\bsr-only\b/);
        await expect(status).toBeEmpty();
        await watchStatus(page, '#ai-status');

        await installFakeGateway(page, { chunks: [ACCEPTED, delta('## 推薦'), done('## 推薦\n- Cofacts 真的假的\n- vTaiwan')] });
        await page.fill('#ai-interest-input', '假訊息');
        await page.click('#ai-submit-btn');
        await expect(results.locator('li')).toHaveText(['Cofacts 真的假的', 'vTaiwan']);
        await expect(status).toHaveText('已產生推薦結果，在「AI 推薦結果」標題下。');

        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.click('#ai-submit-btn');
        await expect(status).toBeEmpty();
        await page.locator('#ai-workspace').getByRole('button', { name: '取消' }).click();
        await expect(status).toHaveText('已取消。');

        const message = 'AI 的回答太長，沒能在時限內寫完。請把問題縮小一點再試。';
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('**Cofacts 真的假的**')], hang: true });
        await page.click('#ai-submit-btn');
        await expect(page.locator('#ai-workspace .ai-result-text')).toHaveText('Cofacts 真的假的');
        await push(page, sse('error', { code: 'incomplete', message }));
        await expect(results.locator('h3')).toHaveText('AI 推薦結果（沒有寫完）');
        await expect(status).toHaveText(message + '已收到的部分在「AI 推薦結果（沒有寫完）」標題下。');
        // 草稿、進度與結果都不會寫進 status，每次只唸一句
        expect(await statusWrites(page)).toEqual([
            '已產生推薦結果，在「AI 推薦結果」標題下。',
            '已取消。',
            message + '已收到的部分在「AI 推薦結果（沒有寫完）」標題下。',
        ]);
    });
});

// 共用腳本 public/shared/platform-ai.js 沒載入成功時，PlatformAI 不存在。404（檔案沒部署好、路徑錯）
// 與連線中斷（網路、被擋）頁面的處理應該相同：顯示錯誤訊息，按鈕不能卡在「分析中…」。
test.describe('公民科技專案頁：共用腳本 platform-ai.js 沒載入成功', () => {
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
            await expect(button).toHaveText('推薦專案');
            await expect(button.locator('svg')).toHaveCount(1);
        });
    }
});
