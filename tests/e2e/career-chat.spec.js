// 生涯探索首頁的「AI 推薦學群」（AI 閘道的 career-chat 任務）：用頁內的假閘道驗證頁面怎麼送出、
// 邊收邊顯示回答、處理錯誤與取消，以及焦點與對話紀錄的 live region 結構。假閘道見 fake-gateway.js。
//
// 伺服器由 playwright.config.js 的 webServer 啟動（8001 埠是 .link-root，要先建置）。
const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway, watchDraws, drawStats, afterFrames, reloadWithoutPerFrame, watchStatus, statusWrites } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/career-exploration/index.html`;

const ACCEPTED = sse('accepted', { requestId: 'req-1', task: 'career-chat' });
const done = (result) => sse('done', { result, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 });
const delta = (text) => sse('delta', { text });
const push = (page, ...chunks) => page.evaluate((chunks) => chunks.forEach((c) => window.__stream.push(c)), chunks);

// 對話紀錄裡的訊息（第一則是頁面本來就有的招呼）、第 n 則訊息的 AI 泡泡文字、接在紀錄後面的草稿、
// 輸入列下方的進度區塊。
const messages = (page) => page.locator('#chat-log > div');
const aiText = (page, n) => messages(page).nth(n).locator('.chat-bubble-ai p');
const draft = (page) => page.locator('#chat-log ~ *');
const progress = (page) => page.locator('#chat-progress .platform-ai-progress');
// 元素本身或它的祖先是不是 live region。
const LIVE = '[aria-live]:not([aria-live="off"]), [role="log"], [role="status"], [role="alert"]';
const inLiveRegion = (locator) => locator.evaluate((el, selector) => el.closest(selector) !== null, LIVE);

// 回答與錯誤送達時，進度區塊都會跟著移除：[情況, 要送的 SSE 片段, 檢查畫面的函式]。
const BUSY = '目前使用的人很多，請稍後再試。';
const SETTLE = [
    ['回答送達', done('推薦你 **設計學群**。'), (page) => expect(aiText(page, 2)).toHaveText('推薦你 設計學群。')],
    ['閘道回報錯誤', sse('error', { code: 'busy', message: BUSY, retryable: true }),
        (page) => expect(aiText(page, 2)).toHaveText(BUSY)],
];

async function ask(page, question) {
    await page.fill('#chat-input', question);
    await page.click('#chat-submit');
}

test.describe('生涯探索首頁：AI 推薦學群（career-chat 任務）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PAGE);
        await stubBuiltInGateway(page);
    });

    test('回答邊收邊顯示：片段先畫成紀錄後面的草稿，收到 done 換成紀錄裡的回答；按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, {
            chunks: [
                ACCEPTED,
                sse('progress', { phase: 'writing', round: 1 }),
                delta('推薦你 **資訊學群**：'),
                delta('你喜歡電腦。\n'),
            ],
            hang: true,
        });
        await ask(page, '  我喜歡動手做東西，也對電腦有興趣  ');

        const button = page.locator('#chat-submit');
        const input = page.locator('#chat-input');
        // 學生的問題（去掉前後空白）進了紀錄，輸入框清空，焦點交回輸入框。
        await expect(messages(page)).toHaveCount(2);
        await expect(messages(page).nth(1).locator('.chat-bubble-user')).toHaveText('我喜歡動手做東西，也對電腦有興趣');
        await expect(input).toHaveValue('');
        await expect(input).toBeFocused();

        // 草稿出現時進度區塊還在（可以取消）；按鈕停用但仍可取得焦點，外觀也變淡。
        await expect(draft(page).locator('strong')).toHaveText(['資訊學群']);
        await expect(progress(page).getByRole('status')).toHaveText('AI 正在撰寫回答…');
        await expect(progress(page).getByRole('button', { name: '取消' })).toBeVisible();
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).not.toHaveAttribute('disabled');
        await expect(button).toHaveClass(/opacity-50/);
        await expect(button).toHaveText('思考中...');
        await expect(input).toBeEditable();

        await push(page, delta('下一步可以參加 APCS'));
        await expect(draft(page)).toContainText('下一步可以參加 APCS');

        // done 的結果和片段接起來的不同（句尾多了「。」）：畫面要以 done 為準。
        await push(page, done('推薦你 **資訊學群**：你喜歡電腦。\n下一步可以參加 APCS。'));
        await expect(draft(page)).toHaveCount(0);
        await expect(messages(page)).toHaveCount(3);
        const answer = aiText(page, 2);
        await expect(answer.locator('strong')).toHaveText(['資訊學群']);
        await expect(answer).toHaveText('推薦你 資訊學群：你喜歡電腦。下一步可以參加 APCS。');
        await expect(progress(page)).toHaveCount(0);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/career-chat');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { question: '我喜歡動手做東西，也對電腦有興趣' } });

        // 按鈕恢復，文字與圖示都還在。
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveAttribute('aria-disabled');
        await expect(button).not.toHaveClass(/opacity-50/);
        await expect(button).toHaveText('發送');
        await expect(button.locator('ion-icon')).toHaveCount(1);
        await expect(input).toBeFocused();
    });

    test('在輸入框按 Enter 送出；進行中可以先打下一題，但 Enter 與按鈕都不會再送出', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        const input = page.locator('#chat-input');
        await input.fill('我喜歡畫畫');
        await input.press('Enter');
        await expect(messages(page).nth(1)).toHaveText('我喜歡畫畫');
        await expect(progress(page)).toHaveCount(1);
        await expect(input).toBeFocused();

        await input.fill('那數學呢？');
        await input.press('Enter');
        await page.locator('#chat-submit').click({ force: true });
        await expect(input).toHaveValue('那數學呢？');
        await expect(messages(page)).toHaveCount(2);
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);

        await push(page, done('推薦你 **設計學群**。'));
        await expect(messages(page)).toHaveCount(3);
        await input.press('Enter');
        await expect(messages(page).nth(3)).toHaveText('那數學呢？');
        expect(await page.evaluate(() => window.__calls.length)).toBe(2);
    });

    test('回答裡的 # 標題是 h2「AI 推薦學群」底下的 h3，清單項目在 <ul> 裡；草稿也一樣', async ({ page }) => {
        const answer = '# 資訊學群\n適合你的原因：\n- 喜歡電腦\n- 喜歡解題\n## 可以先做的事\n1. 學一種程式語言';
        await installFakeGateway(page, { chunks: [ACCEPTED, delta(answer)], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(draft(page).getByRole('heading', { level: 3, name: '資訊學群' })).toBeVisible();
        await push(page, done(answer));
        const bubble = messages(page).nth(2);
        await expect(bubble.getByRole('heading')).toHaveText(['資訊學群', '可以先做的事']);
        await expect(bubble.getByRole('heading', { level: 3 })).toHaveText(['資訊學群']);
        await expect(page.locator('#ai-advisor h2')).toHaveText('AI 推薦學群');
        await expect(bubble.getByRole('heading', { level: 4 })).toHaveText(['可以先做的事']);
        await expect(bubble.locator('ul > li')).toHaveText(['喜歡電腦', '喜歡解題']);
        await expect(bubble.locator('ol > li')).toHaveText(['學一種程式語言']);
        await expect(bubble.locator('li:not(ul > li, ol > li)')).toHaveCount(0);
    });

    test('用輸入法選字時按 Enter 是確定選字，不送出；選完再按 Enter 才送出', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        const input = page.locator('#chat-input');
        await input.fill('我喜歡畫畫');
        // Chrome、Firefox 選字中的 keydown 帶 isComposing；Safari 結束選字的那個是 false，keyCode 是 229
        await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
        await input.evaluate((el) => {
            const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
            Object.defineProperty(e, 'keyCode', { get: () => 229 });
            el.dispatchEvent(e);
        });
        await expect(messages(page)).toHaveCount(1);
        await expect(input).toHaveValue('我喜歡畫畫');
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);

        await input.press('Enter');
        await expect(messages(page).nth(1)).toHaveText('我喜歡畫畫');
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    test('回答停在「**資訊學群」就斷了 → 草稿與紀錄裡沒寫完的回答都不留字面的 **', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('推薦你 **資訊學群')], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(draft(page).locator('.chat-bubble-ai p')).toHaveText('推薦你 資訊學群');
        await push(page, sse('error', { code: 'incomplete', message: '沒寫完' }));
        await expect(aiText(page, 2)).toHaveText('推薦你 資訊學群');
    });

    test('連續問兩題：各送一個請求，body 只有這一題；每一題的草稿都接在紀錄後面，收到 done 就移除', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('推薦你')], hang: true });
        for (const [i, question] of ['我喜歡畫畫', '那如果我也喜歡數學呢？'].entries()) {
            await ask(page, question);
            await expect(draft(page)).toHaveText('推薦你');
            await push(page, delta(` **設計學群**（第 ${i + 1} 題）`));
            await expect(draft(page).locator('strong')).toHaveText(['設計學群']);
            await push(page, done(`推薦你 **設計學群**（第 ${i + 1} 題）。`));
            await expect(draft(page)).toHaveCount(0);
            await expect(aiText(page, 2 * i + 2)).toHaveText(`推薦你 設計學群（第 ${i + 1} 題）。`);
        }
        await expect(messages(page).nth(3)).toHaveText('那如果我也喜歡數學呢？');

        const calls = await page.evaluate(() => window.__calls);
        expect(calls.map((c) => JSON.parse(c.body))).toEqual([
            { input: { question: '我喜歡畫畫' } },
            { input: { question: '那如果我也喜歡數學呢？' } },
        ]);
    });

    test('學生的問題與 AI 的回答含 HTML 標籤 → 問題、草稿、最後的回答都當純文字顯示，不產生 img／script，也不執行', async ({ page }) => {
        const text = `* ${XSS_IMG} **${XSS_SCRIPT}**`;
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* ')], hang: true });
        await ask(page, `${XSS_IMG}${XSS_SCRIPT}`);

        const chat = page.locator('#chat-window');
        await expect(messages(page).nth(1)).toHaveText(`${XSS_IMG}${XSS_SCRIPT}`);
        // 分兩段送：第一段建立草稿，第二段走「更新草稿」那條路，兩條都要擋得住。
        await expect(draft(page)).toHaveCount(1);
        await push(page, delta(text.slice(2)));
        await expect(draft(page).locator('strong')).toHaveText([XSS_SCRIPT]);
        await expect(draft(page)).toContainText(XSS_IMG);
        await expect(chat.locator('img, script, [onerror]')).toHaveCount(0);

        await push(page, done(`${text}\n${XSS_IMG}${XSS_SCRIPT}`));
        await expect(draft(page)).toHaveCount(0);
        await expect(messages(page).nth(2)).toContainText(`${XSS_IMG}${XSS_SCRIPT}`);
        await expect(chat.locator('img, script, [onerror]')).toHaveCount(0);

        // img 的 onerror 要等圖片載入失敗才會跑；若真的塞進了 <img src=x>，這一等就會讓它現形。
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('閘道回 error 事件 → 錯誤訊息照字面顯示在 AI 的泡泡裡，訊息裡的 HTML 標籤不生效', async ({ page }) => {
        const message = `${XSS_IMG}目前使用的人很多，請稍後再試。`;
        await installFakeGateway(page, { chunks: [ACCEPTED, sse('error', { code: 'busy', message, retryable: true })] });
        await ask(page, '我喜歡畫畫');
        const notice = aiText(page, 2);
        await expect(notice).toHaveText(message);
        await expect(notice).toHaveClass(/text-red-700/);
        await expect(page.locator('#chat-window img')).toHaveCount(0);
    });

    test('閘道網址沒有設定 → 紀錄裡出現「尚未設定」的錯誤訊息，不送出請求', async ({ page }) => {
        await installFakeGateway(page, { withMeta: false });
        await ask(page, '我喜歡畫畫');
        const notice = aiText(page, 2);
        await expect(notice).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
        await expect(notice).toHaveClass(/text-red-700/);
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
        await expect(page.locator('#chat-submit')).toBeEnabled();
    });

    test('沒有輸入（或只有空白）就送出 → 顯示並唸出「請先輸入你的問題。」，不送請求，紀錄不變；送出問題後提示收起來', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('推薦你資訊學群。')] });
        await watchStatus(page, '#chat-status');
        const hint = page.locator('#chat-input-error');
        for (const value of ['', '   ']) {
            await page.fill('#chat-input', value);
            await page.click('#chat-submit');
            await expect(hint).toHaveText('請先輸入你的問題。');
            await expect(hint).toBeVisible();
            await page.locator('#chat-input').press('Enter');
        }
        await expect.poll(() => statusWrites(page)).toContain('請先輸入你的問題。');
        await expect(messages(page)).toHaveCount(1);
        await expect(progress(page)).toHaveCount(0);
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);

        await ask(page, '我喜歡電腦');
        await expect(hint).toBeHidden();
        // 提示也要從 status 清掉，瀏覽模式讀到輸入框後面時不會再唸一次。
        await expect(page.locator('#chat-status')).toHaveText('');
    });

    test('草稿出現後按「取消」→ 草稿移除，紀錄裡出現「已取消。」（不是錯誤的紅字），焦點回到輸入框；之後還能再問', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('推薦你 **資訊學群**')], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(draft(page).locator('strong')).toHaveText(['資訊學群']);

        await progress(page).getByRole('button', { name: '取消' }).click();
        const notice = aiText(page, 2);
        await expect(notice).toHaveText('已取消。');
        await expect(notice).toHaveClass(/text-gray-600/);
        await expect(notice).not.toHaveClass(/text-red-700/);
        await expect(draft(page)).toHaveCount(0);
        await expect(progress(page)).toHaveCount(0);
        await expect(page.locator('#chat-submit')).toBeEnabled();
        await expect(page.locator('#chat-input')).toBeFocused();
        // finish() 直接交給輸入框，不先交給 #chat-progress（得補上 tabindex）再搬一次。
        for (const el of ['#chat-input', '#chat-progress']) await expect(page.locator(el)).not.toHaveAttribute('tabindex');

        await ask(page, '那數學呢？');
        await expect(messages(page).nth(3)).toHaveText('那數學呢？');
        await push(page, done('推薦你 **工程學群**。'));
        await expect(aiText(page, 4).locator('strong')).toHaveText(['工程學群']);
        expect(await page.evaluate(() => window.__calls.length)).toBe(2);
    });

    test('進行中焦點在輸入框上按 Esc → 和按「取消」一樣，紀錄裡出現「已取消。」，焦點留在輸入框；輸入法選字中的 Esc 不取消', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await ask(page, '我喜歡畫畫');
        await expect(progress(page)).toHaveCount(1);
        const input = page.locator('#chat-input');
        await input.focus();
        await input.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
        await expect(progress(page)).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(aiText(page, 2)).toHaveText('已取消。');
        await expect(progress(page)).toHaveCount(0);
        await expect(input).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    test('串流在 done 之前就斷了 → 已收到的部分標明沒有寫完、進了紀錄，紀錄裡出現連線中斷的錯誤訊息；草稿移除，之後還能再問', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('推薦你 **資訊學群**')], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(draft(page).locator('strong')).toHaveText(['資訊學群']);

        // 草稿出現之後才結束串流，等於閘道重啟、通道斷線。
        await page.evaluate(() => window.__stream.end());
        await expect(messages(page).nth(2).locator('.chat-bubble-ai span')).toHaveText('AI 的回答（沒有寫完）');
        await expect(aiText(page, 2)).toHaveText('推薦你 資訊學群');
        const notice = aiText(page, 3);
        await expect(notice).toHaveText('和 AI 服務的連線中斷了，請再試一次。');
        await expect(notice).toHaveClass(/text-red-700/);
        await expect(draft(page)).toHaveCount(0);
        await expect(page.locator('#chat-submit')).toBeEnabled();

        await ask(page, '那數學呢？');
        await expect(messages(page).nth(4)).toHaveText('那數學呢？');
        await push(page, done('推薦你 **工程學群**。'));
        await expect(aiText(page, 5).locator('strong')).toHaveText(['工程學群']);
        expect(await page.evaluate(() => window.__calls.length)).toBe(2);
    });

    test('閘道說忙線、要等 30 秒 → 問題留在紀錄、也放回輸入框；等待期間按鈕停用、寫著「請稍候」，連按、按住 Enter 都不送出也不加訊息，30 秒到了才恢復', async ({ page }) => {
        await page.clock.install({ time: 0 });
        await page.clock.pauseAt(10_000);
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        // 不多等隨機的秒數，等待時間就是 30 秒
        await page.evaluate(() => { Math.random = () => 0; });
        await ask(page, '我喜歡電腦');
        await push(page, sse('error', { code: 'busy', message: BUSY, retryable: true, retryAfter: 30 }));
        await expect(aiText(page, 2)).toHaveText(BUSY.replace(/。$/, '（大約 30 秒後可以再試）。'));
        await expect(messages(page).nth(1)).toHaveText('我喜歡電腦');
        const input = page.locator('#chat-input');
        const button = page.locator('#chat-submit');
        await expect(input).toHaveValue('我喜歡電腦');
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).toHaveText('請稍候');

        for (let i = 0; i < 10; i++) await input.press('Enter');
        for (let i = 0; i < 20; i++) await page.keyboard.down('Enter');
        await page.keyboard.up('Enter');
        await button.click({ force: true });
        await expect(messages(page)).toHaveCount(3);
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);

        await page.clock.runFor(29_000);
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await page.clock.runFor(1_000);
        await expect(button).not.toHaveAttribute('aria-disabled');
        await expect(button).toHaveText('發送');
        await input.press('Enter');
        await expect(messages(page).nth(3)).toHaveText('我喜歡電腦');
        expect(await page.evaluate(() => window.__calls.length)).toBe(2);
    });

    test('接續的一輪碰到忙線、要等 30 秒 → 沒寫完的答案留在紀錄，問題不放回輸入框；按鈕停用到 30 秒後', async ({ page }) => {
        await page.clock.install({ time: 0 });
        await page.clock.pauseAt(10_000);
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('推薦你 **資訊學群**')], hang: true });
        await page.evaluate(() => { Math.random = () => 0; });
        await ask(page, '我喜歡電腦');
        // 時鐘暫停時草稿不會畫出來（每個畫面才畫一次），直接等錯誤
        await push(page, sse('error', { code: 'busy', message: BUSY, retryable: true, retryAfter: 30 }));
        await expect(messages(page).nth(2).locator('.chat-bubble-ai span')).toHaveText('AI 的回答（沒有寫完）');
        await expect(aiText(page, 2).locator('strong')).toHaveText(['資訊學群']);
        await expect(aiText(page, 3)).toHaveText(BUSY.replace(/。$/, '（大約 30 秒後可以再試）。'));
        const button = page.locator('#chat-submit');
        await expect(page.locator('#chat-input')).toHaveValue('');
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await page.clock.runFor(29_000);
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await page.clock.runFor(1_000);
        await expect(button).not.toHaveAttribute('aria-disabled');
    });

    test('不是要等的代號（timeout）即使帶著 retryAfter → 按鈕馬上恢復，問題不放回輸入框', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await ask(page, '我喜歡電腦');
        await push(page, sse('error', { code: 'timeout', message: 'AI 思考的時間超過上限了，請稍後再試。', retryable: true, retryAfter: 30 }));
        await expect(aiText(page, 2)).toContainText('AI 思考的時間超過上限了');
        await expect(page.locator('#chat-submit')).not.toHaveAttribute('aria-disabled');
        await expect(page.locator('#chat-submit')).toHaveText('發送');
        await expect(page.locator('#chat-input')).toHaveValue('');
    });

    test('等待期間學生已經打了下一題 → 輸入框留著下一題；只打了空白就放回原來的問題', async ({ page }) => {
        const input = page.locator('#chat-input');
        for (const [typed, expected] of [['那數學呢？', '那數學呢？'], ['   ', '我喜歡電腦']]) {
            await page.goto(PAGE);
            await stubBuiltInGateway(page);
            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await ask(page, '我喜歡電腦');
            await input.fill(typed);
            await push(page, sse('error', { code: 'busy', message: BUSY, retryable: true, retryAfter: 30 }));
            await expect(aiText(page, 2)).toContainText('秒後可以再試');
            await expect(input).toHaveValue(expected);
        }
    });

    // 失敗得很快（連不上、輸入不合格）時按鈕馬上能按，問題不放回輸入框，連按 Enter 才不會一直重送
    test('連不上閘道 → 問題不放回輸入框；之後連按 10 次 Enter 不再送出，紀錄不增加', async ({ page }) => {
        await installFakeGateway(page);
        await page.evaluate(() => {
            const realFetch = window.fetch;
            window.fetch = (url, init) => (String(url).startsWith('https://gateway.example/')
                ? (window.__calls.push({ url: String(url) }), Promise.reject(new TypeError('Failed to fetch')))
                : realFetch(url, init));
        });
        const input = page.locator('#chat-input');
        await input.fill('我喜歡電腦');
        for (let i = 0; i < 10; i++) await input.press('Enter');
        await expect(aiText(page, 2)).toHaveText('暫時連不上 AI 服務（可能是網路不穩，或服務正在維護），請稍後再試。');
        await expect(messages(page)).toHaveCount(3);
        await expect(input).toHaveValue('');
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    for (const [when, chunk, expectSettled] of SETTLE) {
        test(`焦點停在「取消」上時${when} → 焦點交給輸入框，#chat-progress 不留 tabindex`, async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await ask(page, '我喜歡畫畫');
            const cancel = progress(page).getByRole('button', { name: '取消' });
            await cancel.focus();
            await expect(cancel).toBeFocused();
            await push(page, chunk);
            await expectSettled(page);
            await expect(page.locator('#chat-input')).toBeFocused();
            for (const el of ['#chat-input', '#chat-progress']) await expect(page.locator(el)).not.toHaveAttribute('tabindex');
        });
    }

    // 錯誤帶著已經收到、看得見的答案時都留下來（沒寫完、斷線、逾時、接續輪忙線），標明沒有寫完
    const PARTIAL_ERRORS = [
        ['incomplete', 'AI 的回答太長，沒能在時限內寫完。請把問題縮小一點再試。'],
        ['timeout', 'AI 思考的時間超過上限了，請稍後再試，或把內容寫得更具體一些。'],
    ];
    for (const [code, message] of PARTIAL_ERRORS) test(`已經收到回答之後收到 ${code} → 已收到的部分標明沒有寫完、進了紀錄，紅字訊息接在後面；草稿移除，焦點回到輸入框`, async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('推薦你 **資訊學群**：'), delta('因為你')], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(draft(page).locator('strong')).toHaveText(['資訊學群']);

        await progress(page).getByRole('button', { name: '取消' }).focus();
        await push(page, sse('error', { code, message, retryable: code !== 'incomplete' }));
        await expect(messages(page)).toHaveCount(4);
        await expect(messages(page).nth(2).locator('.chat-bubble-ai span')).toHaveText('AI 的回答（沒有寫完）');
        await expect(aiText(page, 2)).toHaveText('推薦你 資訊學群：因為你');
        await expect(aiText(page, 2)).not.toHaveClass(/text-red-700/);
        await expect(aiText(page, 3)).toHaveText(message);
        await expect(aiText(page, 3)).toHaveClass(/text-red-700/);
        await expect(draft(page)).toHaveCount(0);
        await expect(page.locator('#chat-input')).toBeFocused();
        // 答案已經留在紀錄裡，問題不放回輸入框
        await expect(page.locator('#chat-input')).toHaveValue('');
        for (const el of ['#chat-input', '#chat-progress']) await expect(page.locator(el)).not.toHaveAttribute('tabindex');
    });

    test('收到的片段只有看不見的字元、之後收到錯誤：錯誤不帶 partial，草稿移除，紀錄裡只有紅字訊息', async ({ page }) => {
        const BUSY_MESSAGE = '目前使用的人比較多，請稍後再試。';
        // 零寬空白用 code point 產生，原始碼裡不放看不見的字元
        await installFakeGateway(page, { chunks: [ACCEPTED, delta(String.fromCodePoint(0x200B))], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(draft(page)).toHaveCount(1);
        await push(page, sse('error', { code: 'busy', message: BUSY_MESSAGE, retryable: true }));
        await expect(messages(page)).toHaveCount(3);
        await expect(aiText(page, 2)).toHaveText(BUSY_MESSAGE);
        await expect(aiText(page, 2)).toHaveClass(/text-red-700/);
        await expect(draft(page)).toHaveCount(0);
    });

    test('一次收到 200 段：草稿畫的次數不超過畫面數，畫出來的是最新的全文', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(progress(page)).toHaveCount(1);
        await watchDraws(page);
        await push(page, ...Array.from({ length: 200 }, (_, i) => delta(`第 ${i + 1} 段。`)));
        await expect(draft(page)).toContainText('第 200 段。');
        const { renders, frames } = await drawStats(page);
        expect(renders).toBeLessThanOrEqual(frames);
    });

    // 草稿等下一個畫面才畫；結束事件在那之前就到了，之後的畫面不能把草稿畫回來。
    const ENDS = [
        ['done', done('推薦你 **資訊學群**。'), '推薦你 資訊學群。'],
        // 沒寫完的回答停在 ** 的中間：落單的 ** 拿掉
        ['incomplete', sse('error', { code: 'incomplete', message: '沒寫完' }), '推薦你 資訊'],
    ];
    for (const [code, end, expected] of ENDS) test(`片段與 ${code} 在同一個畫面之前送達 → 紀錄裡是最後的回答，之後的畫面不再畫出草稿`, async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(progress(page)).toHaveCount(1);
        await push(page, delta('推薦你 **資'), delta('訊'), end);
        await expect(aiText(page, 2)).toHaveText(expected);
        await afterFrames(page);
        await expect(draft(page)).toHaveCount(0);
    });

    test('片段送達、還沒畫出來就取消 → 紀錄裡是「已取消。」，之後的畫面不再畫出草稿', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(progress(page)).toHaveCount(1);
        // 這個 requestAnimationFrame 排在頁面畫草稿的前面，取消發生在同一個畫面裡、草稿畫出來之前。
        await page.evaluate((chunk) => {
            window.__stream.push(chunk);
            requestAnimationFrame(() => document.querySelector('#chat-progress button').click());
        }, delta('推薦你 **資訊學群**'));
        await expect(aiText(page, 2)).toHaveText('已取消。');
        await afterFrames(page);
        await expect(draft(page)).toHaveCount(0);
    });

    test('platform-ai.js 是沒有 perFrame 的舊版 → 照樣送出請求、邊收邊畫草稿，收到 done 換成紀錄裡的回答；按鈕恢復，第二題照常', async ({ page }) => {
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await reloadWithoutPerFrame(page);
        await stubBuiltInGateway(page);
        expect(await page.evaluate(() => typeof PlatformAI.perFrame)).toBe('undefined');
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('推薦你 **資'), delta('訊學群**')], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(draft(page).locator('strong')).toHaveText(['資訊學群']);
        await push(page, done('推薦你 **資訊學群**。'));
        await expect(aiText(page, 2)).toHaveText('推薦你 資訊學群。');
        await expect(draft(page)).toHaveCount(0);
        const button = page.locator('#chat-submit');
        await expect(button).not.toHaveAttribute('aria-disabled');
        await expect(button).toHaveText('發送');
        await ask(page, '我也喜歡數學');
        await expect(draft(page).locator('strong')).toHaveText(['資訊學群']);
        await push(page, done('也可以看看 **數理化學群**。'));
        await expect(aiText(page, 4)).toHaveText('也可以看看 數理化學群。');
        expect(await page.evaluate(() => window.__calls.length)).toBe(2);
        expect(errors).toEqual([]);
    });

    test('回答到的時候不搬焦點：學生等待時把焦點移到別處，回答進了紀錄，焦點還在原處', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await ask(page, '我喜歡畫畫');
        await expect(progress(page)).toHaveCount(1);
        const search = page.locator('#search-bar');
        await search.focus();
        await push(page, done('推薦你 **設計學群**。'));
        await expect(aiText(page, 2).locator('strong')).toHaveText(['設計學群']);
        await expect(search).toBeFocused();
    });

    // Safari 點按鈕不給按鈕焦點（MDN <button> 的 Clicking and focus），mousedown 時還會清掉輸入框的
    // 焦點（WebKit 的 EventHandler::dispatchMouseEvent）。這裡在 mousedown 時 preventDefault 再 blur。
    test('像 Safari 那樣點按鈕不給焦點：用滑鼠送出、取消之後，焦點都回到輸入框', async ({ page }) => {
        await page.evaluate(() => document.addEventListener('mousedown', (e) => {
            if (!e.target.closest('button')) return;
            e.preventDefault();
            document.activeElement.blur();
        }, true));
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        const input = page.locator('#chat-input');

        await ask(page, '我喜歡畫畫');
        await expect(messages(page)).toHaveCount(2);
        await expect(input).toBeFocused();
        await push(page, done('推薦你 **設計學群**。'));
        await expect(messages(page)).toHaveCount(3);
        await expect(input).toBeFocused();

        await ask(page, '那數學呢？');
        await progress(page).getByRole('button', { name: '取消' }).click();
        await expect(aiText(page, 4)).toHaveText('已取消。');
        await expect(input).toBeFocused();
    });

    test('輸入框最多 200 字（與閘道的任務規格相同）；輸入框與按鈕都有無障礙名稱，窄螢幕上也是', async ({ page }) => {
        const input = page.locator('#chat-input');
        const button = page.locator('#chat-submit');
        await expect(input).toHaveAttribute('maxlength', '200');
        await expect(input).toHaveAccessibleName('你的問題');
        await expect(button).toHaveAccessibleName('發送');
        // 窄螢幕只顯示圖示，按鈕的名稱來自圖示的 aria-label。
        await page.setViewportSize({ width: 375, height: 800 });
        await expect(button.locator('span')).toBeHidden();
        await expect(button).toHaveAccessibleName('發送');
    });

    // career-chat 每次只送這一題，頁面卻排成對話。placeholder 一打字就消失，說明要寫在輸入框外面。
    test('輸入框下方寫著每一題分開回答，是輸入框的描述，不在 live region 裡；窄螢幕上也看得到、不超出版面', async ({ page }) => {
        const input = page.locator('#chat-input');
        const max = await input.getAttribute('maxlength');
        const HINT = `每一題都分開回答，AI 看不到前面的問答。想接著問，請把需要的背景寫進同一題，最多 ${max} 字。`;
        await expect(input).toHaveAccessibleDescription(HINT);
        const hint = page.locator(`#${await input.getAttribute('aria-describedby')}`);
        await expect(hint).toHaveText(HINT);
        expect(await inLiveRegion(hint)).toBe(false);
        for (const width of [1280, 375, 320]) {
            await page.setViewportSize({ width, height: 800 });
            // toBeVisible 只要求大於 0×0，sr-only 的 1×1 也算看得見，所以另外量大小。
            await expect(hint).toBeVisible();
            const m = await hint.evaluate((el) => {
                const input = document.getElementById('chat-input');
                const box = (node) => node.getBoundingClientRect().toJSON();
                return {
                    box: box(el),
                    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
                    input: box(input),
                    row: box(input.parentElement),
                    card: box(el.closest('#ai-advisor > div')),
                    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                };
            });
            expect(m.box.top, `${width}px 寬時說明不在輸入框下方`).toBeGreaterThanOrEqual(m.input.bottom);
            expect(m.box.height, `${width}px 寬時說明不到一行高`).toBeGreaterThanOrEqual(m.lineHeight);
            expect(m.box.width, `${width}px 寬時說明比輸入列窄`).toBeGreaterThanOrEqual(m.row.width - 1);
            expect(m.box.right, `${width}px 寬時說明超出卡片`).toBeLessThanOrEqual(m.card.right);
            expect(m.overflow, `${width}px 寬時頁面可以橫向捲動`).toBe(0);
        }
    });

    // 草稿每收到一段就重畫，放進 live region 會一路重唸。Safari 連 aria-live="off" 子樹裡的變化都算進
    // 外層的 live region，所以草稿與進度區塊（含計時器、取消鈕）不能有身為 live region 的祖先。
    test('對話紀錄是 role="log"；草稿與進度區塊不在任何 live region 裡，完成的回答加進紀錄，頭像不給螢幕閱讀器', async ({ page }) => {
        const log = page.locator('#chat-log');
        await expect(log).toHaveAttribute('role', 'log');
        await expect(log).not.toHaveAttribute('aria-live');
        await expect(log).toHaveAccessibleName('對話紀錄');

        await installFakeGateway(page, { chunks: [ACCEPTED, delta('草稿')], hang: true });
        await ask(page, '我喜歡電腦');
        await expect(draft(page)).toHaveText('草稿');
        await expect(progress(page)).toHaveCount(1);
        expect(await inLiveRegion(draft(page))).toBe(false);
        expect(await inLiveRegion(progress(page))).toBe(false);

        await push(page, done('最後的回答'));
        await expect(messages(page).nth(2)).toHaveText('最後的回答');
        await expect(draft(page)).toHaveCount(0);
        // ion-icon 預設是沒有名稱的 role="img"，頭像不藏起來，紀錄裡每則訊息都會多一張沒有名稱的圖。
        await expect(log.locator('ion-icon')).toHaveCount(3);
        await expect(log.locator('ion-icon:not([aria-hidden="true"])')).toHaveCount(0);
    });

    test('對話視窗用 Shift+Tab 從輸入框移得到，名稱是這一區的標題，焦點看得到，可以用鍵盤捲動', async ({ page }) => {
        const lines = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join('\n');
        await installFakeGateway(page, { chunks: [ACCEPTED, done(lines)] });
        await ask(page, '我喜歡電腦');
        await expect(messages(page)).toHaveCount(3);

        const chatWindow = page.getByRole('region', { name: 'AI 推薦學群', exact: true });
        await expect(page.locator('#chat-input')).toBeFocused();
        await page.keyboard.press('Shift+Tab');
        await expect(chatWindow).toBeFocused();
        const outline = await chatWindow.evaluate((el) => ({ style: getComputedStyle(el).outlineStyle, width: parseFloat(getComputedStyle(el).outlineWidth) }));
        expect(outline.style).not.toBe('none');
        expect(outline.width).toBeGreaterThanOrEqual(2);
        await page.keyboard.press('Home');
        await expect.poll(() => chatWindow.evaluate((el) => el.scrollTop)).toBe(0);
    });

    test('送出時捲到底；學生往上捲去看舊訊息時，新的片段與完成的回答不把他拉回底部', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        const chatWindow = page.locator('#chat-window');
        const atBottom = () => chatWindow.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
        const lines = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `第 ${from + i} 行`).join('\n');

        await ask(page, '我喜歡電腦');
        await push(page, delta(lines(1, 12)));
        await expect(draft(page)).toContainText('第 12 行');
        await expect.poll(atBottom).toBe(true);

        await chatWindow.evaluate((el) => { el.scrollTop = 0; });
        await push(page, delta(`\n${lines(13, 14)}`));
        await expect(draft(page)).toContainText('第 14 行');
        expect(await chatWindow.evaluate((el) => el.scrollTop)).toBe(0);

        // 捲回底部就又跟著新的片段走。
        await chatWindow.evaluate((el) => { el.scrollTop = el.scrollHeight; });
        await push(page, delta(`\n${lines(15, 16)}`));
        await expect(draft(page)).toContainText('第 16 行');
        await expect.poll(atBottom).toBe(true);

        await chatWindow.evaluate((el) => { el.scrollTop = 0; });
        await push(page, done(lines(1, 20)));
        await expect(messages(page).nth(2)).toContainText('第 20 行');
        expect(await chatWindow.evaluate((el) => el.scrollTop)).toBe(0);

        // 自己送出的問題一定捲到底。
        await ask(page, '那數學呢？');
        await expect(messages(page).nth(3)).toHaveText('那數學呢？');
        await expect.poll(atBottom).toBe(true);
    });
});

// 共用腳本 public/shared/platform-ai.js 沒載入成功時，PlatformAI 不存在。404（檔案沒部署好、路徑錯）
// 與連線中斷（網路、被擋）頁面的處理應該相同：顯示錯誤訊息，按鈕不能卡在「思考中...」。
test.describe('生涯探索首頁：共用腳本 platform-ai.js 沒載入成功', () => {
    const FAILURES = [
        ['回 404', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })],
        ['連線中斷', (route) => route.abort()],
    ];

    for (const [name, failScript] of FAILURES) {
        test(`${name} → 紀錄裡出現錯誤訊息，按鈕恢復可按`, async ({ page }) => {
            await page.route('**/shared/platform-ai.js', failScript);
            await page.goto(PAGE);
            expect(await page.evaluate(() => typeof window.PlatformAI)).toBe('undefined');

            await ask(page, '我喜歡畫畫');
            const notice = aiText(page, 2);
            await expect(notice).toHaveText('抱歉，AI 服務發生錯誤，請稍後再試。');
            await expect(notice).toHaveClass(/text-red-700/);
            const button = page.locator('#chat-submit');
            await expect(button).toBeEnabled();
            await expect(button).toHaveText('發送');
            await expect(button.locator('ion-icon')).toHaveCount(1);
        });
    }
});
