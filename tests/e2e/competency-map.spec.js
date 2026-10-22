// 素養地圖頁「AI 素養分析師」的頁面測試，閘道換成 fake-gateway.js 的假閘道。
// 8001 埠服務的是 .link-root，要先建置。
const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/career-exploration/competency-map.html`;

const ACCEPTED = sse('accepted', { requestId: 'req-1', task: 'competency-analysis' });
const done = (result) => sse('done', { result, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 });
const delta = (text) => sse('delta', { text });
const push = (page, ...chunks) => page.evaluate((chunks) => chunks.forEach((c) => window.__stream.push(c)), chunks);

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

test.describe('素養地圖頁：AI 素養分析師（competency-analysis 任務）', () => {
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
        await expect(draft.locator('li')).toHaveText(['• A2 系統思考與解決問題：寫出你怎麼從失敗的實驗找出原因。']);
        await expect(work.getByRole('status')).toHaveText('AI 正在撰寫回答…');
        await expect(work.getByRole('button', { name: '取消' })).toBeVisible();
        await expect(result).toBeEmpty();
        await expect(button).toBeDisabled();
        await expect(button).toContainClass('opacity-50 cursor-not-allowed');
        await expect(button).toHaveText('分析中…');

        await push(page, delta('* **A3 規劃執行與創新應變**：描述你如何調整實驗設計'));
        await expect(draft.locator('li')).toHaveCount(2);

        // done 的 result 句尾多了「。」，畫面要以它為準。
        await push(page, done([
            '* **A2 系統思考與解決問題**：寫出你怎麼從失敗的實驗找出原因。',
            '* **A3 規劃執行與創新應變**：描述你如何調整實驗設計。',
        ].join('\n')));

        await expect(result.locator('.prose li')).toHaveText([
            '• A2 系統思考與解決問題：寫出你怎麼從失敗的實驗找出原因。',
            '• A3 規劃執行與創新應變：描述你如何調整實驗設計。',
        ]);
        await expect(work).toBeEmpty();
        await expect(page.locator('#ai-analyst .prose')).toHaveCount(1);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/competency-analysis');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { experience: '我參加了科展' } });

        await expect(button).toBeEnabled();
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        await expect(button).toHaveText('開始分析');
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

    test('草稿出現後用鍵盤按「取消」→ 草稿移除，以 info 語氣顯示「已取消。」，焦點移到 #ai-work，按鈕恢復原狀', async ({ page }) => {
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
        await expect(result.locator('p')).not.toHaveClass(/text-red-500/);
        await expect(work).toBeEmpty();
        // 取消鈕跟著進度區塊移除了，焦點不能掉回 <body>。
        await expect(work).toBeFocused();
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
    });

    test('焦點在「取消」上時收到 done → 焦點移到 #ai-work', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 草稿')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        await expect(work.locator('.prose')).toHaveText('• 草稿');

        await work.getByRole('button', { name: '取消' }).focus();
        await push(page, done('* 最後的答案'));
        await expect(page.locator('#ai-result .prose')).toHaveText('• 最後的答案');
        await expect(work).toBeFocused();
    });

    test('用鍵盤按「開始分析」→ 進行中焦點留在按鈕上，再按 Enter 不會再送一次；完成後焦點仍在按鈕上', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 草稿')], hang: true });
        await page.fill('#ai-input', '科展');
        const button = page.locator('#ai-generate-btn');
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#ai-work .prose')).toHaveText('• 草稿');
        // 按鈕若變得不能聚焦，瀏覽器到更新畫面時才移走焦點（HTML 標準的 focus fixup），所以先等兩個畫格。
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(button).toBeFocused();
        await expect(button).toBeDisabled();

        await page.keyboard.press('Enter');
        await push(page, done('* 最後的答案'));
        await expect(page.locator('#ai-result .prose')).toHaveText('• 最後的答案');
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
        await expect(button).toBeEnabled();
        await expect(button).toBeFocused();
    });

    test('草稿出現後串流沒等到 done 就結束 → 草稿移除，顯示連線中斷的錯誤訊息', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* **A2 系統思考與解決問題**')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const work = page.locator('#ai-work');
        const result = page.locator('#ai-result');
        await expect(work.locator('.prose strong')).toHaveText(['A2 系統思考與解決問題']);

        // 閘道重啟、通道斷線時，串流就是這樣結束。
        await page.evaluate(() => window.__stream.end());
        await expect(result).toHaveText('和 AI 服務的連線中斷了，請再試一次。');
        await expect(result.locator('p')).toHaveClass(/text-red-500/);
        await expect(work).toBeEmpty();
        await expect(page.locator('#ai-generate-btn')).toBeEnabled();
    });

    test('再分析一次 → 上一次的答案先清掉，新的草稿只在 #ai-work', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('* 第一次的答案')] });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const result = page.locator('#ai-result');
        await expect(result.locator('.prose')).toHaveText('• 第一次的答案');
        await expect(page.locator('#ai-generate-btn')).toBeEnabled();

        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 第二次的草稿')], hang: true });
        await page.click('#ai-generate-btn');
        await expect(page.locator('#ai-work .prose')).toHaveText('• 第二次的草稿');
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

    // 進度區塊的 role="status" 會跟著 finish() 移除，答案與訊息要靠一直都在的 #ai-result 唸出來。
    // WebKit 會把 live region 裡任何子孫的變化送給 VoiceOver，子孫的 aria-live="off" 擋不住，
    // 所以進度區塊與草稿往上都不能有 live region。
    test('#ai-result 是 polite 的 live region，只放最後的答案；進度區塊與草稿在 #ai-work，往上沒有 live region', async ({ page }) => {
        const work = page.locator('#ai-work');
        const result = page.locator('#ai-result');
        await expect(result).toHaveAttribute('aria-live', 'polite');

        await installFakeGateway(page, { chunks: [ACCEPTED, delta('* 草稿')], hang: true });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        await expect(work.locator('.prose')).toHaveText('• 草稿');
        await expect(work.locator('.platform-ai-progress')).toHaveCount(1);
        await expect(result.locator('.platform-ai-progress, .prose')).toHaveCount(0);
        expect(await work.locator('.prose').evaluate(liveSettingsUpFrom)).toEqual([]);
        expect(await work.locator('.platform-ai-progress').evaluate(liveSettingsUpFrom)).toEqual([]);

        await push(page, done('* 最後的答案'));
        await expect(result.locator('.prose')).toHaveText('• 最後的答案');
        expect(await result.locator('.prose').evaluate(liveSettingsUpFrom)).toEqual(['ai-result:polite']);
        await expect(work).toBeEmpty();
    });

    test('閘道只回 done、沒有片段 → 直接顯示答案', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done('* **B1 符號運用與溝通表達**：上台報告的經驗很加分！')] });
        await page.fill('#ai-input', '科展');
        await page.click('#ai-generate-btn');
        const answer = page.locator('#ai-result .prose');
        await expect(answer.locator('li')).toHaveText(['• B1 符號運用與溝通表達：上台報告的經驗很加分！']);
        await expect(answer.locator('strong')).toHaveText(['B1 符號運用與溝通表達']);
    });
});

test.describe('素養地圖頁：共用腳本 platform-ai.js 沒載入成功', () => {
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
            await expect(button).toHaveText('開始分析');
            await expect(button.locator('svg')).toHaveCount(1);
        });
    }
});
