// 核心素養對照表頁「AI 對照核心素養」的頁面測試，閘道換成 fake-gateway.js 的假閘道。
// 8001 埠服務的是 .link-root，要先建置。
const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway, watchDraws, drawStats, afterFrames, reloadWithoutPerFrame, watchStatus, statusWrites } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/career-exploration/competency-map.html`;

const ACCEPTED = sse('accepted', { requestId: 'req-1', task: 'competency-analysis' });
const done = (result) => sse('done', { result, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 });
const delta = (text) => sse('delta', { text });
const push = (page, ...chunks) => page.evaluate((chunks) => chunks.forEach((c) => window.__stream.push(c)), chunks);

// 答案與錯誤送達時，進度區塊都會跟著移除：[情況, 要送的 SSE 片段, 檢查畫面的函式]。錯誤之前已經收到草稿，
// 草稿標明沒有寫完、留在結果區，訊息接在最後。
const FORMAT_ERROR = 'AI 回覆的格式不正確，請再試一次。';
// 2026-10-23 正式閘道的回答都是這樣三行的星號清單，沒有 # 標題。
const REAL_ANSWER = [
    '* **A3 規劃執行與創新應變**：建議你把「場地不夠→重畫配置圖→雨天改動線」的解決過程寫清楚，讓大學看到你能冷靜規劃、即時應變！',
    '* **C2 人際關係與團隊合作**：建議你點出如何與幹部分工、和總務處協調空間，展現你溝通協調、凝聚團隊的實力。',
    '* **C1 道德實踐與公民意識**：建議你補充捐款育幼院的動機與意義，把活動成果連結到回饋社區的公民行動，會讓亮點更有溫度！',
].join('\n');
const SETTLE = [
    ['收到 done', done('* 最後的答案'), (page) => expect(page.locator('#ai-result .prose')).toHaveText('最後的答案')],
    ['閘道回報錯誤', sse('error', { code: 'format', message: FORMAT_ERROR, retryable: true }),
        (page) => expect(page.locator('#ai-result > p')).toHaveText(FORMAT_ERROR)],
];

/**
 * liveSettingsUpFrom 從 el 往上（含自己）列出設了 aria-live、或 role 隱含 live 的元素，在頁面裡執行。
 * @param {Element} el @returns {string[]}
 */
function liveSettingsUpFrom(el) {
    const implicit = { status: 'polite', log: 'polite', alert: 'assertive' };
    const found = [];
    for (let node = el; node; node = node.parentElement) {
        const live = node.getAttribute('aria-live') || implicit[node.getAttribute('role')];
        if (live) found.push(`${node.id || node.tagName}:${live}`);
    }
    return found;
}

test.describe('核心素養對照表：AI 對照核心素養（competency-analysis 任務）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PAGE);
        await stubBuiltInGateway(page);
    });

    test('答案邊收邊顯示：片段在 #ai-work 畫成草稿，收到 done 才把答案放進 #ai-result；按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, {
            chunks: [
                ACCEPTED,
                sse('progress', { phase: 'writing', round: 1 }),
                delta('* **A2 系統思考與解決問題**：'),
                delta('寫出你怎麼從失敗的實驗找出原因。\n'),
            ],
            hang: true,
        });
        await page.fill('#ai-input', '  我參加了科展  ');
        await page.click('#ai-generate-btn');

        const work = page.locator('#ai-work');
        const result = page.locator('#ai-result');
        const draft = work.locator('.prose');
        const button = page.locator('#ai-generate-btn');

        await expect(draft.locator('strong')).toHaveText(['A2 系統思考與解決問題']);
        await expect(draft.locator('ul > li')).toHaveText(['A2 系統思考與解決問題：寫出你怎麼從失敗的實驗找出原因。']);
        await expect(work.getByRole('status')).toHaveText('AI 正在撰寫回答…');
        await expect(work.getByRole('button', { name: '取消' })).toBeVisible();
        await expect(result).toBeEmpty();
        await expect(button).toBeDisabled();
        await expect(button).toContainClass('opacity-50 cursor-not-allowed');
        await expect(button).toHaveText('分析中…');

        await push(page, delta('* **A3 規劃執行與創新應變**：描述你如何調整實驗設計'));
        await expect(draft.locator('ul > li')).toHaveCount(2);

        // done 的 result 句尾多了「。」，畫面要以它為準。
        await push(page, done([
            '* **A2 系統思考與解決問題**：寫出你怎麼從失敗的實驗找出原因。',
            '* **A3 規劃執行與創新應變**：描述你如何調整實驗設計。',
        ].join('\n')));

        await expect(result.locator('.prose ul > li')).toHaveText([
            'A2 系統思考與解決問題：寫出你怎麼從失敗的實驗找出原因。',
            'A3 規劃執行與創新應變：描述你如何調整實驗設計。',
        ]);
        await expect(work).toBeEmpty();
        await expect(page.locator('#ai-analyst .prose')).toHaveCount(1);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/competency-analysis');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { experience: '我參加了科展' } });

        await expect(button).toBeEnabled();
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        await expect(button).toHaveText('開始對照');
        await expect(button.locator('svg')).toHaveCount(1);
    });

    test('AI 回傳含 HTML 標籤的文字 → 草稿與最後的答案都當純文字顯示，不產生 img／script 元素，也不執行', async ({ page }) => {
        const text = `* ${XSS_IMG} **${XSS_SCRIPT}**`;
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* ')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');

        const section = page.locator('#ai-analyst');
        const draft = page.locator('#ai-work .prose');
        await expect(draft).toHaveCount(1);
        // 第二段換掉已經在畫面上的草稿。
        await push(page, delta(text.slice(2)));
        await expect(draft.locator('strong')).toHaveText([XSS_SCRIPT]);
        await expect(draft).toContainText(XSS_IMG);
        await expect(section.locator('img, script, [onerror]')).toHaveCount(0);

        await push(page, done(`${text}\n${XSS_IMG}${XSS_SCRIPT}`));
        await expect(page.locator('#ai-result .prose')).toContainText(`${XSS_IMG}${XSS_SCRIPT}`);
        await expect(section.locator('img, script, [onerror]')).toHaveCount(0);

        // onerror 要等圖片載入失敗才會跑；真的塞進了 <img src=x> 的話，這一等會讓它現形。
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('閘道網址沒有設定 → 顯示「尚未設定」，不送出請求', async ({ page }) => {
        await installFakeGateway(page, { withMeta: false });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        await expect(page.locator('#ai-result')).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('沒有輸入（或只有空白）就按 → 提示先輸入，不送出請求', async ({ page }) => {
        await installFakeGateway(page);
        for (const value of ['', ' \n\t ']) {
            await page.fill('#ai-input', value);
            await page.click('#ai-generate-btn');
            await expect(page.locator('#ai-result')).toHaveText('請先輸入你的活動經驗描述！');
        }
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('進行中焦點在輸入框上按 Esc → 和按「取消」一樣顯示「已取消。」，焦點留在輸入框；輸入法選字中的 Esc 不取消', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-input', '測試');
        await page.click('#ai-generate-btn');
        const progress = page.locator('#ai-work .platform-ai-progress');
        await expect(progress).toHaveCount(1);
        const target = page.locator('#ai-input');
        await target.focus();
        await target.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
        await expect(progress).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#ai-result')).toHaveText('已取消。');
        await expect(progress).toHaveCount(0);
        await expect(target).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    // 頁首的 Esc 處理只管焦點在頁首裡的情況，不能先把這一下用掉。
    test('手機選單開著、焦點在輸入框時按 Esc → 第一下就取消，選單照樣開著', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-input', '測試');
        await page.click('#ai-generate-btn');
        const progress = page.locator('#ai-work .platform-ai-progress');
        await expect(progress).toHaveCount(1);
        await page.locator('#nav-toggle').click();
        await expect(page.locator('#mobile-menu')).toBeVisible();
        // 像點了頁面上的文字：焦點離開漢堡鈕，但沒有移到別的元素上，選單不會收合。
        await page.evaluate(() => document.activeElement.blur());
        await page.locator('#ai-input').focus();
        await page.keyboard.press('Escape');
        await expect(page.locator('#ai-result')).toHaveText('已取消。');
        await expect(page.locator('#mobile-menu')).toBeVisible();
    });

    test('草稿出現後用鍵盤按「取消」→ 草稿移除，以 info 語氣顯示「已取消。」，焦點回到「開始對照」按鈕，按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* **A2 系統思考與解決問題**')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        const result = page.locator('#ai-result');
        const button = page.locator('#ai-generate-btn');
        await expect(work.locator('.prose strong')).toHaveText(['A2 系統思考與解決問題']);

        await work.getByRole('button', { name: '取消' }).focus();
        await page.keyboard.press('Enter');
        await expect(result).toHaveText('已取消。');
        await expect(result.locator('p')).toHaveClass(/text-gray-600/);
        await expect(result.locator('p')).not.toHaveClass(/text-red-700/);
        await expect(work).toBeEmpty();
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        // 取消鈕跟著進度區塊移除了。空的 #ai-work 看不到焦點框；焦點移進 #ai-result 的話，螢幕閱讀器
        // 會唸一次訊息，#ai-status 又唸一次。
        await expect(button).toBeFocused();
        for (const el of [button, work, result]) await expect(el).not.toHaveAttribute('tabindex');
    });

    for (const [when, chunk, expectSettled] of SETTLE) {
        test(`焦點在「取消」上時${when} → 草稿移除，焦點回到「開始對照」按鈕`, async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 草稿')], hang: true });
            await page.fill('#ai-input', '科展');
            await page.click('#ai-generate-btn');
            const work = page.locator('#ai-work');
            await expect(work.locator('.prose')).toHaveText('草稿');

            await work.getByRole('button', { name: '取消' }).focus();
            await push(page, chunk);
            await expectSettled(page);
            await expect(work).toBeEmpty();
            await expect(page.locator('#ai-generate-btn')).toBeFocused();
        });
    }

    // 錯誤帶著已經收到、看得見的答案時都留下來（沒寫完、斷線、逾時、接續輪忙線），標明沒有寫完
    const PARTIAL_ERRORS = [
        ['incomplete', 'AI 的回答太長，沒能在時限內寫完。請把問題縮小一點再試。'],
        ['timeout', 'AI 思考的時間超過上限了，請稍後再試，或把內容寫得更具體一些。'],
    ];
    for (const [code, message] of PARTIAL_ERRORS) test(`已經收到答案之後收到 ${code} → 已收到的部分標明沒有寫完、留在 #ai-result，紅字訊息接在下面；#ai-work 清空，焦點回到「開始對照」按鈕`, async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* **A2 系統思考與解決問題**：'), delta('寫出你怎麼')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        const result = page.locator('#ai-result');
        const button = page.locator('#ai-generate-btn');
        await expect(work.locator('.prose ul > li')).toHaveText(['A2 系統思考與解決問題：寫出你怎麼']);

        await work.getByRole('button', { name: '取消' }).focus();
        await push(page, sse('error', { code, message, retryable: code !== 'incomplete' }));
        await expect(result.locator('.prose ul > li')).toHaveText(['A2 系統思考與解決問題：寫出你怎麼']);
        await expect(result.getByRole('heading', { level: 3 })).toHaveText('AI 的回答（沒有寫完）');
        await expect(result.locator(':scope > p')).toHaveText(message);
        await expect(result.locator(':scope > p')).toHaveClass(/text-red-700/);
        // 先放答案再放訊息
        expect(await result.evaluate((el) => [...el.children].map((c) => c.tagName))).toEqual(['DIV', 'P']);
        expect(await result.locator('.prose').evaluate(liveSettingsUpFrom)).toEqual([]);
        await expect(page.locator('#ai-status')).toHaveText(message + '已收到的部分在「AI 的回答（沒有寫完）」標題下。');
        await expect(work).toBeEmpty();
        await expect(button).toBeFocused();
        for (const el of [button, work, result]) await expect(el).not.toHaveAttribute('tabindex');
    });

    test('一次收到 200 段：草稿畫的次數不超過畫面數，畫出來的是最新的全文', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        await expect(work.getByRole('button', { name: '取消' })).toBeVisible();
        await watchDraws(page);
        await push(page, ...Array.from({ length: 200 }, (_, i) => delta(`第 ${i + 1} 段。`)));
        await expect(work.locator('.prose')).toContainText('第 200 段。');
        const { renders, frames } = await drawStats(page);
        expect(renders).toBeLessThanOrEqual(frames);
    });

    // 草稿等下一個畫面才畫；結束事件在那之前就到了，之後的畫面不能把草稿畫回來。
    const ENDS = [
        ['done', done('* 最後的答案'), ['AI 的回答', '最後的答案']],
        ['incomplete', sse('error', { code: 'incomplete', message: '沒寫完' }), ['AI 的回答（沒有寫完）', '最後']],
    ];
    for (const [code, end, [heading, expected]] of ENDS) test(`片段與 ${code} 在同一個畫面之前送達 → #ai-result 是最後的答案，之後的畫面不再畫出草稿`, async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        await expect(work.getByRole('button', { name: '取消' })).toBeVisible();
        await push(page, delta('* 最'), delta('後'), end);
        await expect(page.locator('#ai-result h3')).toHaveText(heading);
        await expect(page.locator('#ai-result .prose')).toHaveText(expected);
        await afterFrames(page);
        await expect(work).toBeEmpty();
    });

    test('片段送達、還沒畫出來就取消 → 顯示「已取消。」，之後的畫面不再畫出草稿', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        await expect(work.getByRole('button', { name: '取消' })).toBeVisible();
        // 這個 requestAnimationFrame 排在頁面畫草稿的前面，取消發生在同一個畫面裡、草稿畫出來之前。
        await page.evaluate((chunk) => {
            window.__stream.push(chunk);
            requestAnimationFrame(() => document.querySelector('#ai-work button').click());
        }, delta('* 草稿'));
        await expect(page.locator('#ai-result')).toHaveText('已取消。');
        await afterFrames(page);
        await expect(work).toBeEmpty();
    });

    test('platform-ai.js 是沒有 perFrame 的舊版 → 照樣送出請求、邊收邊畫草稿，收到 done 把答案放進 #ai-result；按鈕恢復，第二次照常', async ({ page }) => {
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await reloadWithoutPerFrame(page);
        await stubBuiltInGateway(page);
        expect(await page.evaluate(() => typeof PlatformAI.perFrame)).toBe('undefined');
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 草'), delta('稿')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        await expect(work.locator('.prose')).toHaveText('草稿');
        await push(page, done('* 最後的答案'));
        await expect(page.locator('#ai-result .prose')).toHaveText('最後的答案');
        await expect(work).toBeEmpty();
        const button = page.locator('#ai-generate-btn');
        await expect(button).not.toHaveAttribute('aria-disabled');
        await expect(button).toHaveText('開始對照');
        await button.click();
        await expect(work.locator('.prose')).toHaveText('草稿');
        await push(page, done('* 第二次的答案'));
        await expect(page.locator('#ai-result .prose')).toHaveText('第二次的答案');
        expect(await page.evaluate(() => window.__calls.length)).toBe(2);
        expect(errors).toEqual([]);
    });

    test('用鍵盤按「開始對照」→ 進行中焦點留在按鈕上，再按 Enter 不會再送一次；完成後焦點仍在按鈕上', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 草稿')], hang: true });
        await page.fill('#ai-input', '科展');
        const button = page.locator('#ai-generate-btn');
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#ai-work .prose')).toHaveText('草稿');
        // 按鈕若變得不能聚焦，瀏覽器到更新畫面時才移走焦點（HTML 標準的 focus fixup），所以先等兩個畫格。
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(button).toBeFocused();
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).not.toHaveAttribute('disabled');

        await page.keyboard.press('Enter');
        await push(page, done('* 最後的答案'));
        await expect(page.locator('#ai-result .prose')).toHaveText('最後的答案');
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
        await expect(button).toBeEnabled();
        await expect(button).toBeFocused();
    });

    test('草稿出現後串流沒等到 done 就結束 → 已收到的部分標明沒有寫完、留在 #ai-result，連線中斷的紅字訊息接在下面；草稿移除', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* **A2 系統思考與解決問題**')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        const result = page.locator('#ai-result');
        await expect(work.locator('.prose strong')).toHaveText(['A2 系統思考與解決問題']);

        // 閘道重啟、通道斷線時，串流就是這樣結束。
        await page.evaluate(() => window.__stream.end());
        await expect(result.getByRole('heading', { level: 3 })).toHaveText('AI 的回答（沒有寫完）');
        await expect(result.locator('.prose strong')).toHaveText(['A2 系統思考與解決問題']);
        await expect(result.locator(':scope > p')).toHaveText('和 AI 服務的連線中斷了，請再試一次。');
        await expect(result.locator(':scope > p')).toHaveClass(/text-red-700/);
        await expect(work).toBeEmpty();
        await expect(page.locator('#ai-generate-btn')).toBeEnabled();
    });

    test('再分析一次 → 上一次的答案先清掉，新的草稿只在 #ai-work', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('* 第一次的答案')] });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const result = page.locator('#ai-result');
        await expect(result.locator('.prose')).toHaveText('第一次的答案');
        await expect(page.locator('#ai-generate-btn')).toBeEnabled();

        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 第二次的草稿')], hang: true });
        await page.click('#ai-generate-btn');
        await expect(page.locator('#ai-work .prose')).toHaveText('第二次的草稿');
        await expect(result).toBeEmpty();
    });

    test('輸入框最多 1000 字（與閘道的任務規格相同），下方看得到上限；有無障礙名稱，描述就是那行上限', async ({ page }) => {
        const input = page.locator('#ai-input');
        await expect(input).toHaveAttribute('maxlength', '1000');
        await expect(input).toHaveAccessibleName('你的活動經驗');
        await expect(input).toHaveAccessibleDescription('最多 1000 字');
        const hint = page.locator(`#${await input.getAttribute('aria-describedby')}`);
        await expect(hint).toBeVisible();
        await expect(hint).toHaveText('最多 1000 字');
    });

    // WebKit 會把 live region 裡任何子孫的變化送給 VoiceOver，子孫的 aria-live="off" 擋不住，
    // 所以進度區塊與草稿往上都不能有 live region。答案有標題與清單，整段唸出來聽不出結構，也不放進去。
    test('#ai-result 只放最後的答案；答案、進度區塊與草稿往上都沒有 live region', async ({ page }) => {
        const work = page.locator('#ai-work');
        const result = page.locator('#ai-result');
        expect(await result.evaluate(liveSettingsUpFrom)).toEqual([]);

        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 草稿')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        await expect(work.locator('.prose')).toHaveText('草稿');
        await expect(work.locator('.platform-ai-progress')).toHaveCount(1);
        await expect(result.locator('.platform-ai-progress, .prose')).toHaveCount(0);
        expect(await work.locator('.prose').evaluate(liveSettingsUpFrom)).toEqual([]);
        expect(await work.locator('.platform-ai-progress').evaluate(liveSettingsUpFrom)).toEqual([]);

        await push(page, done('* 最後的答案'));
        await expect(result.locator('.prose')).toHaveText('最後的答案');
        expect(await result.locator('.prose').evaluate(liveSettingsUpFrom)).toEqual([]);
        await expect(work).toBeEmpty();
    });

    // 進度區塊的 role="status" 會跟著 finish() 移除，答案的摘要與訊息由一直都在的 #ai-status 唸。
    test('#ai-status 是載入時就在、視覺上隱藏的 role="status"；提示、完成、取消各唸一句，同一句再出現也再唸', async ({ page }) => {
        const status = page.locator('#ai-status');
        await expect(status).toHaveAttribute('role', 'status');
        await expect(status).toHaveClass(/\bsr-only\b/);
        await expect(status).toBeEmpty();
        await watchStatus(page, '#ai-status');

        await page.click('#ai-generate-btn');
        await expect(status).toHaveText('請先輸入你的活動經驗描述！');
        await page.click('#ai-generate-btn');
        await expect.poll(() => statusWrites(page)).toEqual(['請先輸入你的活動經驗描述！', '請先輸入你的活動經驗描述。']);

        await installFakeGateway(page, { chunks: [ACCEPTED, delta(REAL_ANSWER.slice(0, 40)), done(REAL_ANSWER)] });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        await expect(page.locator('#ai-result .prose li')).toHaveCount(3);
        await expect(status).toHaveText('已產生 AI 的回答，在「AI 的回答」標題下。');

        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.click('#ai-generate-btn');
        await expect(status).toBeEmpty();
        await page.locator('#ai-work').getByRole('button', { name: '取消' }).click();
        await expect(status).toHaveText('已取消。');
        expect(await statusWrites(page)).toEqual(['請先輸入你的活動經驗描述！', '請先輸入你的活動經驗描述。', '已產生 AI 的回答，在「AI 的回答」標題下。', '已取消。']);
    });

    // 真實的回答沒有標題，按 H 跳標題的人要靠回答框的 h3 找到它。
    test('沒有標題的星號清單回答 → h2「AI 對照核心素養」之後是 h3「AI 的回答」，三項在同一個 <ul> 裡', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done(REAL_ANSWER)] });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const section = page.locator('#ai-analyst');
        await expect(section.locator('#ai-result .prose li')).toHaveCount(3);
        await expect(section.getByRole('heading')).toHaveText(['AI 對照核心素養', 'AI 的回答']);
        expect(await section.getByRole('heading').evaluateAll((hs) => hs.map((h) => h.tagName))).toEqual(['H2', 'H3']);
        const answer = section.locator('#ai-result .prose');
        await expect(answer.getByRole('list')).toHaveCount(1);
        await expect(answer.getByRole('listitem').first()).toHaveText(/^A3 規劃執行與創新應變：建議你把/);
    });

    test('回答裡有 # 標題時是 h3「AI 的回答」底下的 h4', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('# 對應的素養\n* **A2 系統思考與解決問題**：寫出失敗的原因。')] });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        await expect(page.locator('#ai-result').getByRole('heading', { level: 4 })).toHaveText(['對應的素養']);
        await expect(page.locator('#ai-result').getByRole('heading', { level: 3 })).toHaveText(['AI 的回答']);
    });

    test('回答停在「**A2 系統思考」就斷了 → 草稿與沒寫完的回答都不留字面的 **', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* **A2 系統思考與解決問題')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        await expect(page.locator('#ai-work .prose ul > li')).toHaveText(['A2 系統思考與解決問題']);
        await push(page, sse('error', { code: 'incomplete', message: '沒寫完' }));
        const answer = page.locator('#ai-result .prose');
        await expect(answer.locator('ul > li')).toHaveText(['A2 系統思考與解決問題']);
        await expect(answer).not.toContainText('*');
    });

    test('閘道只回 done、沒有片段 → 直接顯示答案', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('* **B1 符號運用與溝通表達**：上台報告的經驗很加分！')] });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const answer = page.locator('#ai-result .prose');
        await expect(answer.locator('ul > li')).toHaveText(['B1 符號運用與溝通表達：上台報告的經驗很加分！']);
        await expect(answer.locator('strong')).toHaveText(['B1 符號運用與溝通表達']);
    });
});

test.describe('核心素養對照表：共用腳本 platform-ai.js 沒載入成功', () => {
    const FAILURES = [
        ['回 404', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })],
        ['連線中斷', (route) => route.abort()],
    ];

    for (const [name, failScript] of FAILURES) {
        test(`${name} → 按下按鈕顯示錯誤訊息，按鈕恢復原狀`, async ({ page }) => {
            await page.route('**/shared/platform-ai.js', failScript);
            await page.goto(PAGE);
            expect(await page.evaluate(() => typeof window.PlatformAI)).toBe('undefined');

            await page.fill('#ai-input', '科展');
            await page.click('#ai-generate-btn');

            await expect(page.locator('#ai-result')).toHaveText('抱歉，AI 服務發生錯誤，請稍後再試。');
            const button = page.locator('#ai-generate-btn');
            await expect(button).toBeEnabled();
            await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
            await expect(button).toHaveText('開始對照');
            await expect(button.locator('svg')).toHaveCount(1);
        });
    }
});
