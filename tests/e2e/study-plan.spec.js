// 計畫範本庫的「AI 計畫草擬工具」（AI 閘道的 study-plan 任務）：用假閘道驗證頁面怎麼送出、
// 顯示進度與結果、處理錯誤與取消。假閘道見 fake-gateway.js。
//
// 伺服器由 playwright.config.js 的 webServer 啟動（8001 埠是 .link-root，要先建置）。
const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway, outsideLiveRegions, watchStatus, statusWrites, headingJumps } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/autonomous-learning/plan-templates.html`;

const ACCEPTED = sse('accepted', { requestId: 'req-1', task: 'study-plan' });
const THINKING = sse('progress', { phase: 'thinking', round: 1 });
const done = (result) => sse('done', { result, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 });

// 有 aria-live 或隱含 live region 角色的元素；<output> 的隱含角色是 status，WebKit 把 alertdialog 也當成 live region。
const LIVE_REGION = '[aria-live], [role~="status"], [role~="log"], [role~="alert"], [role~="alertdialog"], output';

const RESULT = {
    learning_objectives: ['能說明手搖飲店常用的行銷策略。', '能用問卷與訪談蒐集顧客意見。', '能提出改善建議並上台報告。'],
    execution_methods: ['每週觀察兩家店的價格、菜單與促銷活動。', '設計問卷並訪談三位同學。'],
    weekly_plan: [
        { week: 'Week 1-2', tasks: '選定觀察的店家，設計訪察表。' },
        { week: 'Week 3-4', tasks: '發放問卷、訪談店員。' },
        { week: 'Week 5-6', tasks: '用 SWOT 整理資料，製作比較表。' },
        { week: 'Week 7-8', tasks: '撰寫報告並準備簡報。' },
    ],
    expected_outcome: ['一份行銷策略分析報告。', '一份五分鐘的簡報。'],
};

// 每個欄位都夾了會執行的標籤，包括 schema 只允許固定值的 week：頁面不能依賴閘道擋下它們。
const XSS_RESULT = {
    learning_objectives: [`目標一 ${XSS_IMG}`, `目標二 ${XSS_SCRIPT}`, `${XSS_IMG}${XSS_SCRIPT} 目標三`],
    execution_methods: [`方法一 ${XSS_IMG}`, `方法二 ${XSS_SCRIPT}`],
    weekly_plan: [
        { week: `Week 1-2 ${XSS_IMG}`, tasks: `任務一 ${XSS_SCRIPT}` },
        { week: `Week 3-4 ${XSS_SCRIPT}`, tasks: `任務二 ${XSS_IMG}` },
        { week: 'Week 5-6', tasks: `${XSS_IMG}${XSS_SCRIPT}` },
        { week: 'Week 7-8', tasks: '任務四' },
    ],
    expected_outcome: [`產出一 ${XSS_IMG}`, `產出二 ${XSS_SCRIPT}`],
};

// 結果與錯誤送達時，進度區塊都會跟著移除：[情況, 要送的 SSE 片段, 檢查畫面的函式]。
const FORMAT_ERROR = 'AI 回覆的格式不正確，請再試一次。';
const SETTLE = [
    ['結果送達', done(RESULT), (page) => expectPlan(page, RESULT)],
    ['閘道回報錯誤', sse('error', { code: 'format', message: FORMAT_ERROR, retryable: true }),
        (page) => expect(page.locator('#planResult')).toHaveText(FORMAT_ERROR)],
];

async function expectPlan(page, plan) {
    const result = page.locator('#planResult');
    await expect(result.locator('h3')).toHaveText(['學習目標', '執行方法', '週次進度', '預期產出']);
    await expect(result.locator('h3:has-text("學習目標") + ul > li')).toHaveText(plan.learning_objectives);
    await expect(result.locator('h3:has-text("執行方法") + ul > li')).toHaveText(plan.execution_methods);
    await expect(result.locator('h3:has-text("週次進度") + ol > li')).toHaveText(plan.weekly_plan.map(({ week, tasks }) => `${week}: ${tasks}`));
    await expect(result.locator('h3:has-text("預期產出") + ul > li')).toHaveText(plan.expected_outcome);
}

test.describe('計畫範本庫：AI 計畫草擬工具（study-plan 任務）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PAGE);
        await stubBuiltInGateway(page);
    });

    test('送出主題 → 顯示學習目標、執行方法、四段週次進度與預期產出；按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, THINKING, done(RESULT)] });
        await page.fill('#planInput', '  分析手搖飲店的行銷策略  ');
        await page.click('#generatePlanBtn');

        await expectPlan(page, RESULT);
        await expect(page.locator('.platform-ai-progress')).toHaveCount(0);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/study-plan');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { topic: '分析手搖飲店的行銷策略' } });

        const button = page.locator('#generatePlanBtn');
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        await expect(button).toHaveText('產生計畫草案');
        await expect(button.locator('svg')).toHaveCount(1);
    });

    test('以「1. 」開頭的項目照原樣顯示，不變成只有一項的清單；- 換成「• 」', async ({ page }) => {
        const plan = { ...RESULT, learning_objectives: ['1. 先選定主題', '- 再找資料'] };
        await installFakeGateway(page, { chunks: [ACCEPTED, done(plan)] });
        await page.fill('#planInput', '手搖飲');
        await page.click('#generatePlanBtn');
        const items = page.locator('#planResult ul').first().locator(':scope > li');
        await expect(items).toHaveText(['1. 先選定主題', '• 再找資料']);
        await expect(page.locator('#planResult li :is(ul, ol)')).toHaveCount(0);
    });

    // 結果在功能的 h2 底下。標題跳級的話，用標題跳著讀的人會以為漏了一層
    test('結果的標題從 h3 開始，接在功能的 h2 底下，不跳級', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done(RESULT)] });
        await page.fill('#planInput', '測試');
        await page.click('#generatePlanBtn');
        const result = page.locator('#planResult');
        await expect(result.getByRole('heading', { level: 3 })).toHaveText(['學習目標', '執行方法', '週次進度', '預期產出']);
        expect(await headingJumps(result)).toEqual([]);
    });

    test('AI 回傳含 HTML 標籤的文字 → 每個欄位都當純文字原樣顯示，不產生 img／script 元素，也不執行', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done(XSS_RESULT)] });
        await page.fill('#planInput', '手搖飲');
        await page.click('#generatePlanBtn');

        await expectPlan(page, XSS_RESULT);
        await expect(page.locator('#planResult').locator('img, script, [onerror]')).toHaveCount(0);

        // img 的 onerror 要等圖片載入失敗才會跑，多等一下才看得出它有沒有被執行。
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('閘道網址沒有設定 → 顯示「尚未設定」，不送出請求', async ({ page }) => {
        await installFakeGateway(page, { withMeta: false });
        await page.fill('#planInput', '手搖飲');
        await page.click('#generatePlanBtn');
        await expect(page.locator('#planResult')).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('沒有輸入（或只有空白）就按 → 以紅字提示先輸入，不送出請求', async ({ page }) => {
        await installFakeGateway(page);
        for (const value of ['', ' \t ']) {
            await page.fill('#planInput', value);
            await page.click('#generatePlanBtn');
            await expect(page.locator('#planResult')).toHaveText('請先輸入你的自主學習主題！');
            await expect(page.locator('#planResult p')).toHaveClass(/text-red-700/);
        }
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('進行中焦點在輸入框上按 Esc → 和按「取消」一樣顯示「已取消。」，焦點留在輸入框；輸入法選字中的 Esc 不取消', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#planInput', '測試');
        await page.click('#generatePlanBtn');
        const progress = page.locator('#planWorkspace .platform-ai-progress');
        await expect(progress).toHaveCount(1);
        const target = page.locator('#planInput');
        await target.focus();
        await target.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
        await expect(progress).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#planResult')).toHaveText('已取消。');
        await expect(progress).toHaveCount(0);
        await expect(target).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    test('進行中用鍵盤按「取消」→ 進度區塊移除，以一般語氣顯示「已取消。」，按鈕恢復，焦點回到按鈕', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#planInput', '手搖飲');
        await page.click('#generatePlanBtn');

        // 進行中只換按鈕的文字，圖示留著。
        const button = page.locator('#generatePlanBtn');
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).toContainClass('opacity-50 cursor-not-allowed');
        await expect(button).toHaveText('產生中…');
        await expect(button.locator('svg')).toHaveCount(1);

        await page.locator('#planWorkspace').getByRole('button', { name: '取消' }).focus();
        await page.keyboard.press('Enter');
        const message = page.locator('#planResult p');
        await expect(page.locator('#planResult')).toHaveText('已取消。');
        await expect(message).toHaveClass(/text-gray-600/);
        await expect(message).not.toHaveClass(/text-red-700/);
        await expect(page.locator('.platform-ai-progress')).toHaveCount(0);
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        await expect(button).toHaveText('產生計畫草案');
        // 取消鈕跟著進度區塊移除了，焦點不能停在清空的工作區，也不能移進結果區：螢幕閱讀器會唸一次
        // 訊息，#planStatus 又唸一次。
        await expect(button).toBeFocused();
        for (const el of [button, page.locator('#planWorkspace'), page.locator('#planResult')]) await expect(el).not.toHaveAttribute('tabindex');
    });

    for (const [when, chunk, expectSettled] of SETTLE) {
        test(`焦點停在「取消」上時${when} → 焦點回到按鈕`, async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await page.fill('#planInput', '手搖飲');
            await page.click('#generatePlanBtn');
            await page.locator('#planWorkspace').getByRole('button', { name: '取消' }).focus();

            await page.evaluate((c) => window.__stream.push(c), chunk);
            await expectSettled(page);
            await expect(page.locator('#generatePlanBtn')).toBeFocused();
        });
    }

    // disabled 的按鈕會失去焦點，瀏覽器下一次更新畫面時就把焦點移到 <body>。
    test('用鍵盤按「產生計畫草案」→ 進行中按鈕是 aria-disabled，再按不會重送；等待中與完成後，焦點都留在按鈕上', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#planInput', '手搖飲');
        const button = page.locator('#generatePlanBtn');
        await button.focus();
        await page.keyboard.press('Enter');
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).not.toHaveAttribute('disabled');
        // 等過一次畫面更新再看焦點。
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.keyboard.press('Enter');
        await expect(button).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);

        await page.evaluate((chunk) => window.__stream.push(chunk), done(RESULT));
        await expectPlan(page, RESULT);
        await expect(button).toBeEnabled();
        await expect(button).toBeFocused();
    });

    test('等待時焦點移到輸入框 → 結果送達後焦點留在輸入框', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#planInput', '手搖飲');
        await page.click('#generatePlanBtn');
        await expect(page.locator('#planWorkspace').getByRole('button', { name: '取消' })).toBeVisible();
        await page.focus('#planInput');

        await page.evaluate((chunk) => window.__stream.push(chunk), done(RESULT));
        await expectPlan(page, RESULT);
        await expect(page.locator('#planInput')).toBeFocused();
    });

    test('串流在 done 之前就斷了 → 進度區塊移除，顯示連線中斷的錯誤訊息', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, THINKING] });
        await page.fill('#planInput', '手搖飲');
        await page.click('#generatePlanBtn');
        await expect(page.locator('#planResult')).toHaveText('和 AI 服務的連線中斷了，請再試一次。');
        await expect(page.locator('#planResult p')).toHaveClass(/text-red-700/);
        await expect(page.locator('.platform-ai-progress')).toHaveCount(0);
        await expect(page.locator('#generatePlanBtn')).toBeEnabled();
    });

    test('輸入框最多 100 字（與閘道的任務規格相同），有無障礙名稱', async ({ page }) => {
        const input = page.locator('#planInput');
        await expect(input).toHaveAttribute('maxlength', '100');
        await expect(input).toHaveAccessibleName('你的自主學習主題');
    });

    // 結果有標題與清單，整段放進 live region 會被唸成一長串、聽不出結構
    test('結果區不在任何 live region 裡；#planStatus 是視覺上隱藏的 role="status"，提示、結果摘要與取消各唸一句，畫面照常顯示', async ({ page }) => {
        const result = page.locator('#planResult');
        const status = page.locator('#planStatus');
        await expect(status).toHaveAttribute('role', 'status');
        await expect(status).toHaveClass(/\bsr-only\b/);
        await expect(status).toBeEmpty();
        expect(await outsideLiveRegions(result)).toBe(true);
        await watchStatus(page, '#planStatus');

        await page.click('#generatePlanBtn');
        await expect(result).toHaveText('請先輸入你的自主學習主題！');
        await expect(status).toHaveText('請先輸入你的自主學習主題！');
        // 同一句再出現一次，也要再唸一次
        await page.click('#generatePlanBtn');
        await expect.poll(() => statusWrites(page)).toEqual(['請先輸入你的自主學習主題！', '請先輸入你的自主學習主題！']);

        await installFakeGateway(page, { chunks: [ACCEPTED, done(RESULT)] });
        await page.fill('#planInput', '手搖飲');
        await page.click('#generatePlanBtn');
        await expect(result).toContainText(RESULT.expected_outcome[1]);
        await expect(status).toHaveText('已產生計畫草案，共 4 項週次進度。');
        expect(await outsideLiveRegions(result)).toBe(true);

        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.click('#generatePlanBtn');
        await expect(status).toBeEmpty();
        await page.locator('#planWorkspace').getByRole('button', { name: '取消' }).click();
        await expect(result).toHaveText('已取消。');
        await expect(status).toHaveText('已取消。');
        expect(await statusWrites(page)).toEqual(['請先輸入你的自主學習主題！', '請先輸入你的自主學習主題！', '已產生計畫草案，共 4 項週次進度。', '已取消。']);
    });

    // 進度區塊放在 live region 裡的話，WebKit 會連計時器每秒的變化都通報（見頁面的註解）。
    test('結果區與工作區都不在任何 live region 裡；再送一次時舊結果先清掉，進度只出現在工作區', async ({ page }) => {
        const result = page.locator('#planResult');
        const workspace = page.locator('#planWorkspace');
        expect(await outsideLiveRegions(result)).toBe(true);
        expect(await workspace.evaluate((el, selector) => el.closest(selector) === null, LIVE_REGION)).toBe(true);

        await installFakeGateway(page, { chunks: [ACCEPTED, done(RESULT)] });
        await page.fill('#planInput', '手搖飲');
        await page.click('#generatePlanBtn');
        await expect(result).toContainText(RESULT.learning_objectives[0]);

        await installFakeGateway(page, { chunks: [ACCEPTED, THINKING], hang: true });
        await page.click('#generatePlanBtn');
        await expect(workspace.getByRole('status')).toHaveText('AI 正在思考…');
        await expect(result).toBeEmpty();
        await expect(result.locator('.platform-ai-progress')).toHaveCount(0);
        expect(await workspace.evaluate((el, selector) => el.closest(selector) === null, LIVE_REGION)).toBe(true);
    });
});

// platform-ai.js 沒載入成功時 PlatformAI 不存在，404 與連線中斷都要顯示錯誤、恢復按鈕。
test.describe('計畫範本庫：共用腳本 platform-ai.js 沒載入成功', () => {
    const FAILURES = [
        ['回 404', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })],
        ['連線中斷', (route) => route.abort()],
    ];

    for (const [name, failScript] of FAILURES) {
        test(`${name} → 按下按鈕顯示錯誤訊息，按鈕恢復可按`, async ({ page }) => {
            await page.route('**/shared/platform-ai.js', failScript);
            await page.goto(PAGE);
            expect(await page.evaluate(() => typeof window.PlatformAI)).toBe('undefined');

            await page.fill('#planInput', '手搖飲');
            await page.click('#generatePlanBtn');

            await expect(page.locator('#planResult')).toHaveText('抱歉，AI 服務發生錯誤，請稍後再試。');
            const button = page.locator('#generatePlanBtn');
            await expect(button).toBeEnabled();
            await expect(button).toHaveText('產生計畫草案');
            await expect(button.locator('svg')).toHaveCount(1);
        });
    }
});
