/**
 * 自主學習頁的「學習啟動包」（AI 閘道的 starter-pack 任務）：用頁內的假閘道驗證頁面怎麼送出、
 * 顯示進度與結果、處理錯誤與取消。真的閘道與 WinLab 不在 CI 裡測。
 *
 * 伺服器由 playwright.config.js 的 webServer 啟動（8001 埠是 .link-root，要先建置）。
 * 建置時有沒有設定 PUBLIC_AI_GATEWAY_URL（頁面有沒有帶 <meta name="ai-gateway-url">）都要全數通過。
 */
const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway, outsideLiveRegions, watchStatus, statusWrites } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/autonomous-learning/index.html`;

const RESULT = {
    suggested_topic: '家貓的社會行為與人貓互動',
    research_questions: ['家貓怎麼表達情緒？', '貓與飼主的依附關係如何形成？', '環境豐富化對貓有什麼影響？'],
    resource_types: ['知識型影片', '學術論文', '訪談獸醫'],
};

// 每個欄位都夾了可執行的標籤。
const XSS_RESULT = {
    suggested_topic: `貓咪的行為 ${XSS_IMG} ${XSS_SCRIPT}`,
    research_questions: [`問題一 ${XSS_IMG}`, `問題二 ${XSS_SCRIPT}`, `${XSS_IMG}${XSS_SCRIPT} 問題三`],
    resource_types: [XSS_IMG, XSS_SCRIPT, `影片 ${XSS_IMG} ${XSS_SCRIPT}`],
};

test.describe('自主學習頁：學習啟動包（starter-pack 任務）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PAGE);
        await stubBuiltInGateway(page);
    });

    test('送出初步想法 → 顯示 AI 回傳的主題、3 個探索問題與 3 種資源類型；按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, {
            chunks: [
                sse('accepted', { requestId: 'req-1', task: 'starter-pack' }),
                sse('progress', { phase: 'thinking', round: 1 }),
                sse('done', { result: RESULT, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 }),
            ],
        });
        await page.fill('#coachInput', '  我想研究貓咪  ');
        await page.click('#generateCoachBtn');

        const result = page.locator('#coachResult');
        await expect(result.getByRole('heading', { name: '建議主題方向' })).toBeVisible();
        await expect(result).toContainText(RESULT.suggested_topic);
        await expect(result.locator('ul li')).toHaveText(RESULT.research_questions);
        for (const type of RESULT.resource_types) await expect(result).toContainText(type);
        await expect(page.locator('.platform-ai-progress')).toHaveCount(0);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/starter-pack');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { topic: '我想研究貓咪' } });

        // 按鈕恢復可按，文字與圖示都還在（頁面只換按鈕裡 span 的文字，不能把整個按鈕換成純文字）。
        const button = page.locator('#generateCoachBtn');
        await expect(button).toBeEnabled();
        await expect(button).toHaveText('請求指導');
        await expect(button.locator('svg')).toHaveCount(1);
    });

    test('AI 回傳含 HTML 標籤的文字 → 當純文字原樣顯示，不產生 img／script 元素，也不執行', async ({ page }) => {
        await installFakeGateway(page, {
            chunks: [
                sse('accepted', { requestId: 'req-1', task: 'starter-pack' }),
                sse('done', { result: XSS_RESULT, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 }),
            ],
        });
        await page.fill('#coachInput', '貓咪');
        await page.click('#generateCoachBtn');

        const result = page.locator('#coachResult');
        await expect(result.getByRole('heading', { name: '建議主題方向' })).toBeVisible();

        // 標籤是畫面上看得到的字，不是元素：三個欄位的文字都要原樣出現
        await expect(result).toContainText(XSS_RESULT.suggested_topic);
        await expect(result.locator('ul li')).toHaveText(XSS_RESULT.research_questions);
        for (const type of XSS_RESULT.resource_types) await expect(result).toContainText(type);
        await expect(result.locator('img, script, [onerror]')).toHaveCount(0);

        // img 的 onerror 要等圖片載入失敗才會跑；若真的塞進了 <img src=x>，這一等就會讓它現形
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('閘道網址沒有設定 → 顯示「尚未設定」，不送出請求', async ({ page }) => {
        await installFakeGateway(page, { withMeta: false });
        await page.fill('#coachInput', '貓咪');
        await page.click('#generateCoachBtn');
        await expect(page.locator('#coachResult')).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('沒有輸入就按 → 提示先輸入，取代上一次的結果，不送出請求', async ({ page }) => {
        await installFakeGateway(page, {
            chunks: [
                sse('accepted', { requestId: 'req-1', task: 'starter-pack' }),
                sse('done', { result: RESULT, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 }),
            ],
        });
        await page.fill('#coachInput', '貓咪');
        await page.click('#generateCoachBtn');
        await expect(page.locator('#coachResult')).toContainText(RESULT.suggested_topic);

        await page.fill('#coachInput', '');
        await page.click('#generateCoachBtn');
        await expect(page.locator('#coachResult')).toHaveText('請先輸入你的初步想法！');
        await expect(page.locator('#coachResult h4')).toHaveCount(0);
        expect(await page.evaluate(() => window.__calls.length)).toBe(1); // 只有第一次
    });

    test('進行中用鍵盤按「取消」→ 進度收掉，用提示的灰字顯示「已取消。」，焦點回到「請求指導」按鈕，按鈕恢復可按', async ({ page }) => {
        await installFakeGateway(page, { chunks: [sse('accepted', { requestId: 'req-1', task: 'starter-pack' })], hang: true });
        await page.fill('#coachInput', '貓咪');
        await page.click('#generateCoachBtn');
        await expect(page.locator('#generateCoachBtn')).toBeDisabled();
        await page.locator('#coachProgress').getByRole('button', { name: '取消' }).focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#coachResult')).toHaveText('已取消。');
        await expect(page.locator('#coachResult p')).toHaveClass(/\btext-gray-600\b/);
        await expect(page.locator('.platform-ai-progress')).toHaveCount(0);
        await expect(page.locator('#generateCoachBtn')).toBeEnabled();
        // 空的 #coachProgress 看不到焦點框。焦點移進 #coachResult 的話，螢幕閱讀器會唸一次訊息，
        // #coachStatus 又唸一次。
        await expect(page.locator('#generateCoachBtn')).toBeFocused();
        await expect(page.locator('#generateCoachBtn')).not.toHaveAttribute('tabindex');
        await expect(page.locator('#coachResult')).not.toHaveAttribute('tabindex');
    });

    test('進行中焦點在輸入框上按 Esc → 和按「取消」一樣顯示「已取消。」，焦點留在輸入框；輸入法選字中的 Esc 不取消', async ({ page }) => {
        await installFakeGateway(page, { chunks: [sse('accepted', { requestId: 'req-1', task: 'starter-pack' })], hang: true });
        await page.fill('#coachInput', '測試');
        await page.click('#generateCoachBtn');
        const progress = page.locator('#coachProgress .platform-ai-progress');
        await expect(progress).toHaveCount(1);
        const target = page.locator('#coachInput');
        await target.focus();
        await target.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
        await expect(progress).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#coachResult')).toHaveText('已取消。');
        await expect(progress).toHaveCount(0);
        await expect(target).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    // disabled 的按鈕會失去焦點，瀏覽器下一次更新畫面時就把焦點移到 <body>。
    test('用鍵盤送出 → 進行中再按不會重送；等待中與完成後，焦點都留在按鈕上', async ({ page }) => {
        await installFakeGateway(page, { chunks: [sse('accepted', { requestId: 'req-1', task: 'starter-pack' })], hang: true });
        await page.fill('#coachInput', '貓咪');
        const button = page.locator('#generateCoachBtn');
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(button).toBeDisabled();
        // 等過一次畫面更新再看焦點。
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.keyboard.press('Enter');
        await expect(button).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);

        await page.evaluate((text) => window.__stream.push(text), sse('done', { result: RESULT, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 }));
        await expect(page.locator('#coachResult')).toContainText(RESULT.suggested_topic);
        await expect(button).toBeEnabled();
        await expect(button).toBeFocused();
    });

    // 用 canvas 把計算後的顏色（Tailwind 4 是 oklch）換成 sRGB 再算對比
    test('錯誤訊息的文字對白底的對比至少 4.5:1（WCAG 1.4.3）', async ({ page }) => {
        await installFakeGateway(page, { withMeta: false });
        await page.fill('#coachInput', '貓咪');
        await page.click('#generateCoachBtn');
        const message = page.locator('#coachResult p');
        await expect(message).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
        const ratio = await message.evaluate((el) => {
            const ctx = document.createElement('canvas').getContext('2d');
            ctx.fillStyle = getComputedStyle(el).color;
            ctx.fillRect(0, 0, 1, 1);
            const channel = (v) => {
                const c = v / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            };
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
            const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
            return 1.05 / (luminance + 0.05);
        });
        expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    test('輸入框最多 200 字，與閘道的任務規格相同', async ({ page }) => {
        await expect(page.locator('#coachInput')).toHaveAttribute('maxlength', '200');
    });

    // 結果有標題與清單，整段放進 live region 會被唸成一長串、聽不出結構
    test('結果區不在任何 live region 裡；#coachStatus 是視覺上隱藏的 role="status"，提示、結果摘要與取消各唸一句，畫面照常顯示', async ({ page }) => {
        const result = page.locator('#coachResult');
        const status = page.locator('#coachStatus');
        await expect(status).toHaveAttribute('role', 'status');
        await expect(status).toHaveClass(/\bsr-only\b/);
        await expect(status).toBeEmpty();
        expect(await outsideLiveRegions(result)).toBe(true);
        await watchStatus(page, '#coachStatus');

        await page.click('#generateCoachBtn');
        await expect(result).toHaveText('請先輸入你的初步想法！');
        await expect(status).toHaveText('請先輸入你的初步想法！');
        // 同一句再出現一次，也要再唸一次
        await page.click('#generateCoachBtn');
        await expect.poll(() => statusWrites(page)).toEqual(['請先輸入你的初步想法！', '請先輸入你的初步想法！']);

        await installFakeGateway(page, { chunks: [sse('accepted', { requestId: 'req-1', task: 'starter-pack' }), sse('done', { result: RESULT, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 })] });
        await page.fill('#coachInput', '貓咪');
        await page.click('#generateCoachBtn');
        await expect(result).toContainText(RESULT.suggested_topic);
        await expect(status).toHaveText('已產生學習啟動包，共 3 個探索問題。');
        expect(await outsideLiveRegions(result)).toBe(true);

        await installFakeGateway(page, { chunks: [sse('accepted', { requestId: 'req-1', task: 'starter-pack' })], hang: true });
        await page.click('#generateCoachBtn');
        await expect(status).toBeEmpty();
        await page.locator('#coachProgress').getByRole('button', { name: '取消' }).click();
        await expect(result).toHaveText('已取消。');
        await expect(status).toHaveText('已取消。');
        expect(await statusWrites(page)).toEqual(['請先輸入你的初步想法！', '請先輸入你的初步想法！', '已產生學習啟動包，共 3 個探索問題。', '已取消。']);
    });

    // 進度區塊在 live region 裡的話，取消按鈕與每秒更新的秒數都可能被唸出來。
    test('進行中：進度區塊不在任何 live region 裡，上一次的結果先清掉', async ({ page }) => {
        await installFakeGateway(page, {
            chunks: [
                sse('accepted', { requestId: 'req-1', task: 'starter-pack' }),
                sse('done', { result: RESULT, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 }),
            ],
        });
        await page.fill('#coachInput', '貓咪');
        await page.click('#generateCoachBtn');
        await expect(page.locator('#coachResult')).toContainText(RESULT.suggested_topic);

        await installFakeGateway(page, { chunks: [sse('accepted', { requestId: 'req-2', task: 'starter-pack' })], hang: true });
        await page.click('#generateCoachBtn');
        const progress = page.locator('.platform-ai-progress');
        await expect(progress.getByRole('button', { name: '取消' })).toBeVisible();
        const liveAncestor = await progress.evaluate((el) => {
            const live = el.closest('[aria-live="polite" i], [aria-live="assertive" i], [role~="status"], [role~="alert"], [role~="alertdialog"], [role~="log"], output');
            return live && live.outerHTML.slice(0, 80);
        });
        expect(liveAncestor).toBeNull();
        await expect(page.locator('#coachResult')).toBeEmpty();
    });
});

// 共用腳本 public/shared/platform-ai.js 沒載入成功時，PlatformAI 不存在。404（檔案沒部署好、路徑錯）
// 與連線中斷（網路、被擋）頁面的處理應該相同：顯示錯誤訊息，按鈕不能卡在「產生中…」
test.describe('自主學習頁：共用腳本 platform-ai.js 沒載入成功', () => {
    const FAILURES = [
        ['回 404', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })],
        ['連線中斷', (route) => route.abort()],
    ];

    for (const [name, failScript] of FAILURES) {
        test(`${name} → 按下按鈕顯示錯誤訊息，按鈕恢復可按`, async ({ page }) => {
            await page.route('**/shared/platform-ai.js', failScript);
            await page.goto(PAGE);
            expect(await page.evaluate(() => typeof window.PlatformAI)).toBe('undefined');

            await page.fill('#coachInput', '貓咪');
            await page.click('#generateCoachBtn');

            await expect(page.locator('#coachResult')).toHaveText('抱歉，AI 服務發生錯誤，請稍後再試。');
            const button = page.locator('#generateCoachBtn');
            await expect(button).toBeEnabled();
            await expect(button).toHaveText('請求指導');
            await expect(button.locator('svg')).toHaveCount(1);
        });
    }
});
