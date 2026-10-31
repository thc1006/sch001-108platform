// 選題靈感頁「AI 個人化發想」的頁面測試，閘道任務是 topic-ideas。用 fake-gateway.js 的假閘道驗證
// 頁面怎麼送出、顯示進度與結果、處理錯誤與取消。
//
// 要先建置：playwright.config.js 的 webServer 以 8001 埠提供 .link-root。
const { test, expect } = require('@playwright/test');
const { sse, XSS_IMG, XSS_SCRIPT, stubBuiltInGateway, installFakeGateway, outsideLiveRegions, watchStatus, statusWrites, headingJumps } = require('./fake-gateway');

const BASE = process.env.SITE_BASE_URL || 'http://localhost:8001';
const PAGE = `${BASE}/sch001-108platform/autonomous-learning/topic-ideas.html`;

const ACCEPTED = sse('accepted', { requestId: 'req-1', task: 'topic-ideas' });
const THINKING = sse('progress', { phase: 'thinking', round: 1 });
const done = (result) => sse('done', { result, rounds: 1, continuations: [], usage: {}, elapsedMs: 1000 });

const RESULT = {
    ideas: [
        {
            title: '旅行中的心理復原力',
            description: '探討自助旅行如何影響高中生的壓力調適與自我效能。',
            methods: ['問卷調查', '深度訪談', '前後測比較'],
            challenges: ['樣本不易取得。', '心理變化難以量化。'],
            keywords: ['心理復原力', '自我效能', '背包客'],
        },
        {
            title: '上學路線的減碳設計',
            description: '記錄同學上學的交通方式，設計一條鼓勵步行的低碳路線。',
            methods: ['田野調查', '碳足跡計算'],
            challenges: ['交通資料要長期記錄。', '路線安全需要校方同意。', '天氣會影響步行意願。'],
            keywords: ['低碳交通', '校園規劃', '碳足跡', '永續城市'],
        },
        {
            title: '觀光客拍照行為的從眾心理',
            description: '觀察遊客在景點的拍照與消費行為，分析從眾心理的影響。',
            methods: ['觀察法', '文獻探討', '問卷調查', '照片分析'],
            challenges: ['觀察時不能干擾遊客。', '從眾心理難以直接測量。'],
            keywords: ['從眾心理', '觀光', '消費行為', '社會心理學', '田野觀察'],
        },
    ],
};

const xssIdea = (n) => ({
    title: `主題${n} ${XSS_IMG}`,
    description: `描述${n} ${XSS_SCRIPT} ${XSS_IMG}`,
    methods: [`方法${n} ${XSS_IMG}`, XSS_SCRIPT],
    challenges: [`挑戰${n} ${XSS_SCRIPT}`, XSS_IMG],
    keywords: [XSS_IMG, `關鍵字${n} ${XSS_SCRIPT}`, `${XSS_SCRIPT}${XSS_IMG}`],
});
const XSS_RESULT = { ideas: [xssIdea(1), xssIdea(2), xssIdea(3)] };

// 結果與錯誤送達時，進度區塊都會跟著移除：[情況, 要送的 SSE 片段, 檢查畫面的函式]。
const FORMAT_ERROR = 'AI 回覆的格式不正確，請再試一次。';
const SETTLE = [
    ['結果送達', done(RESULT), (page) => expectIdeas(page, RESULT.ideas)],
    ['閘道回報錯誤', sse('error', { code: 'format', message: FORMAT_ERROR, retryable: true }),
        (page) => expect(page.locator('#ideaResult')).toHaveText(FORMAT_ERROR)],
];

/** section 回傳主題卡片裡小標題是 heading 的那一區，例如「建議研究方法：」。 */
const section = (page, card, heading) => card.locator(':scope > div').filter({ has: page.locator('h4', { hasText: heading }) });

async function expectIdeas(page, ideas) {
    const cards = page.locator('#ideaResult > div');
    await expect(cards).toHaveCount(ideas.length);
    for (const [i, idea] of ideas.entries()) {
        const card = cards.nth(i);
        await expect(card.locator('h3')).toHaveText(idea.title);
        await expect(card.locator(':scope > h3 + div')).toHaveText(idea.description);
        await expect(section(page, card, '建議研究方法：').locator('span')).toHaveText(idea.methods);
        await expect(section(page, card, '潛在挑戰：').locator('li')).toHaveText(idea.challenges);
        await expect(section(page, card, '相關關鍵字：').locator('span')).toHaveText(idea.keywords);
    }
}

test.describe('選題靈感頁：AI 個人化發想（topic-ideas 任務）', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto(PAGE);
        await stubBuiltInGateway(page);
    });

    test('送出興趣 → 顯示 3 個主題的名稱、描述、研究方法、挑戰、關鍵字與搜尋連結；按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, THINKING, done(RESULT)] });
        await page.fill('#ideaInput', '  旅行、心理學、環保  ');
        await page.click('#generateIdeaBtn');

        await expectIdeas(page, RESULT.ideas);
        // 看得到的字三個連結都一樣，報讀器念的名稱帶著題目；箭頭不念。
        const links = page.locator('#ideaResult a');
        await expect(links).toHaveCount(3);
        for (const [i, { title }] of RESULT.ideas.entries()) {
            await expect(links.nth(i)).toHaveAccessibleName(new RegExp(`^用 Google 深入研究\\s?：${title}（另開新分頁）$`));
            await expect(links.nth(i)).toHaveAttribute('href', `https://www.google.com/search?q=${encodeURIComponent(title)}`);
        }
        await expect(page.locator('#ideaWorkspace > *')).toHaveCount(0);

        const calls = await page.evaluate(() => window.__calls);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://gateway.example/v1/tasks/topic-ideas');
        expect(JSON.parse(calls[0].body)).toEqual({ input: { interests: '旅行、心理學、環保' } });

        const button = page.locator('#generateIdeaBtn');
        await expect(button).toBeEnabled();
        await expect(button).toHaveText('產生靈感');
        await expect(button.locator('svg')).toHaveCount(1);
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
    });

    // 結果在功能的 h2 底下。標題跳級的話，用標題跳著讀的人會以為漏了一層
    test('結果的標題從 h3 開始，接在功能的 h2 底下，不跳級', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done({ ideas: RESULT.ideas.map((idea) => ({ ...idea, description: '## 背景\n' + idea.description })) })] });
        await page.fill('#ideaInput', '測試');
        await page.click('#generateIdeaBtn');
        const result = page.locator('#ideaResult');
        await expect(result.getByRole('heading', { level: 3 })).toHaveText(RESULT.ideas.map((idea) => idea.title));
        await expect(result.locator(':scope > div').first().getByRole('heading', { level: 4 })).toHaveText(['背景', '建議研究方法：', '潛在挑戰：', '相關關鍵字：']);
        expect(await headingJumps(result)).toEqual([]);
    });

    test('AI 回傳含 HTML 標籤的文字 → 每個欄位都當純文字原樣顯示，不產生 img／script 元素，也不執行', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED, done(XSS_RESULT)] });
        await page.fill('#ideaInput', '旅行');
        await page.click('#generateIdeaBtn');

        await expectIdeas(page, XSS_RESULT.ideas);
        await expect(page.locator('#ideaResult').locator('img, script, [onerror]')).toHaveCount(0);

        // img 的 onerror 要等圖片載入失敗才會跑，等一下才看得出有沒有被塞進去。
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
        expect(await page.evaluate(() => window.__xss)).toBeUndefined();
    });

    test('閘道網址沒有設定 → 以錯誤樣式顯示「尚未設定」，不送出請求', async ({ page }) => {
        await installFakeGateway(page, { withMeta: false });
        await page.fill('#ideaInput', '旅行');
        await page.click('#generateIdeaBtn');
        const result = page.locator('#ideaResult');
        await expect(result).toHaveText('AI 服務尚未設定完成，暫時無法使用。');
        await expect(result.locator('p')).toHaveClass(/text-red-700/);
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('沒有輸入（或只有空白）就按 → 以錯誤樣式提示先輸入，不送出請求', async ({ page }) => {
        await installFakeGateway(page);
        for (const value of ['', '   ']) {
            await page.fill('#ideaInput', value);
            await page.click('#generateIdeaBtn');
            await expect(page.locator('#ideaResult')).toHaveText('請先輸入你的興趣關鍵字！');
            await expect(page.locator('#ideaResult p')).toHaveClass(/text-red-700/);
        }
        expect(await page.evaluate(() => window.__calls.length)).toBe(0);
    });

    test('進行中焦點在輸入框上按 Esc → 和按「取消」一樣顯示「已取消。」，焦點留在輸入框；輸入法選字中的 Esc 不取消', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ideaInput', '測試');
        await page.click('#generateIdeaBtn');
        const progress = page.locator('#ideaWorkspace .platform-ai-progress');
        await expect(progress).toHaveCount(1);
        const target = page.locator('#ideaInput');
        await target.focus();
        await target.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
        await expect(progress).toHaveCount(1);
        await page.keyboard.press('Escape');
        await expect(page.locator('#ideaResult')).toHaveText('已取消。');
        await expect(progress).toHaveCount(0);
        await expect(target).toBeFocused();
        expect(await page.evaluate(() => window.__calls.length)).toBe(1);
    });

    test('進行中用鍵盤按「取消」→ 以提示樣式（不是錯誤）顯示「已取消。」，焦點回到「產生靈感」按鈕，按鈕恢復原狀', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ideaInput', '旅行');
        await page.click('#generateIdeaBtn');
        const button = page.locator('#generateIdeaBtn');
        await expect(button).toHaveAttribute('aria-disabled', 'true');
        await expect(button).toHaveText('產生中…');
        await expect(button).toContainClass('opacity-50 cursor-not-allowed');

        await page.locator('#ideaWorkspace').getByRole('button', { name: '取消' }).focus();
        await page.keyboard.press('Enter');
        const message = page.locator('#ideaResult p');
        await expect(message).toHaveText('已取消。');
        await expect(message).toHaveClass(/text-gray-600/);
        await expect(message).not.toHaveClass(/text-red-700/);
        await expect(page.locator('#ideaWorkspace > *')).toHaveCount(0);
        await expect(button).toBeEnabled();
        await expect(button).toHaveText('產生靈感');
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        // 取消鈕隨進度區塊移除。空的工作區看不到焦點框；焦點移進結果區的話，螢幕閱讀器會唸一次
        // 訊息，#ideaStatus 又唸一次。
        await expect(button).toBeFocused();
        for (const el of [button, page.locator('#ideaWorkspace'), page.locator('#ideaResult')]) await expect(el).not.toHaveAttribute('tabindex');
    });

    for (const [when, chunk, expectSettled] of SETTLE) {
        test(`等待時焦點在「取消」上，${when} → 焦點交給「產生靈感」按鈕，不掉回 <body>`, async ({ page }) => {
            await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
            await page.fill('#ideaInput', '旅行');
            await page.click('#generateIdeaBtn');
            await page.locator('#ideaWorkspace').getByRole('button', { name: '取消' }).focus();

            await page.evaluate((c) => window.__stream.push(c), chunk);
            await expectSettled(page);
            await expect(page.locator('#generateIdeaBtn')).toBeFocused();
        });
    }

    // disabled 的按鈕會失去焦點，瀏覽器下一次更新畫面時就把焦點移到 <body>。
    test('用鍵盤按「產生靈感」→ 進行中按鈕是 aria-disabled，再按不會重送；等待中與完成後，焦點都留在按鈕上', async ({ page }) => {
        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.fill('#ideaInput', '旅行');
        const button = page.locator('#generateIdeaBtn');
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
        await expectIdeas(page, RESULT.ideas);
        await expect(button).toBeEnabled();
        await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        await expect(button).toBeFocused();
    });

    test('輸入框最多 100 字（與閘道的任務規格相同），有無障礙名稱', async ({ page }) => {
        const input = page.locator('#ideaInput');
        await expect(input).toHaveAttribute('maxlength', '100');
        await expect(input).toHaveAccessibleName('你的興趣關鍵字');
    });

    // 進度區塊的計時器每秒更新，還有取消鈕。放在 live region 裡，Safari 搭配 VoiceOver 會反覆唸。
    test('結果區不是 live region，送出時先清空；進度區塊在不屬於任何 live region 的工作區，顯示閘道回報的進度', async ({ page }) => {
        const result = page.locator('#ideaResult');
        const workspace = page.locator('#ideaWorkspace');
        expect(await outsideLiveRegions(result)).toBe(true);
        await expect(workspace).not.toHaveAttribute('aria-live');

        await installFakeGateway(page, { chunks: [ACCEPTED, THINKING], hang: true });
        await page.click('#generateIdeaBtn');
        await expect(result).toHaveText('請先輸入你的興趣關鍵字！');

        await page.fill('#ideaInput', '旅行');
        await page.click('#generateIdeaBtn');
        await expect(workspace.locator('.platform-ai-progress')).toHaveCount(1);
        await expect(workspace.getByRole('status')).toHaveText('AI 正在思考…');
        await expect(workspace.getByRole('button', { name: '取消' })).toBeVisible();
        await expect(result.locator('*')).toHaveCount(0);
        await expect(result).toHaveText('');
        // WAI-ARIA 1.2 的 status、alert、log 角色隱含 aria-live，只找 aria-live 屬性會漏掉。
        await expect(page.locator(':is([aria-live], [role=status], [role=alert], [role=log]) .platform-ai-progress')).toHaveCount(0);

        await page.evaluate((chunk) => window.__stream.push(chunk), done(RESULT));
        await expectIdeas(page, RESULT.ideas);
        await expect(workspace.locator('*')).toHaveCount(0);
        expect(await outsideLiveRegions(result)).toBe(true);
    });

    // 結果有標題與清單，整段放進 live region 會被唸成一長串、聽不出結構
    test('結果區不在任何 live region 裡；#ideaStatus 是視覺上隱藏的 role="status"，提示、結果摘要與取消各唸一句，畫面照常顯示', async ({ page }) => {
        const result = page.locator('#ideaResult');
        const status = page.locator('#ideaStatus');
        await expect(status).toHaveAttribute('role', 'status');
        await expect(status).toHaveClass(/\bsr-only\b/);
        await expect(status).toBeEmpty();
        expect(await outsideLiveRegions(result)).toBe(true);
        await watchStatus(page, '#ideaStatus');

        await page.click('#generateIdeaBtn');
        await expect(result).toHaveText('請先輸入你的興趣關鍵字！');
        await expect(status).toHaveText('請先輸入你的興趣關鍵字！');
        // 同一句再出現一次，也要再唸一次
        await page.click('#generateIdeaBtn');
        await expect.poll(() => statusWrites(page)).toEqual(['請先輸入你的興趣關鍵字！', '請先輸入你的興趣關鍵字！']);

        await installFakeGateway(page, { chunks: [ACCEPTED, done(RESULT)] });
        await page.fill('#ideaInput', '旅行');
        await page.click('#generateIdeaBtn');
        await expect(result).toContainText(RESULT.ideas[2].title);
        await expect(status).toHaveText('已產生 3 個主題靈感。');
        expect(await outsideLiveRegions(result)).toBe(true);

        await installFakeGateway(page, { chunks: [ACCEPTED], hang: true });
        await page.click('#generateIdeaBtn');
        await expect(status).toBeEmpty();
        await page.locator('#ideaWorkspace').getByRole('button', { name: '取消' }).click();
        await expect(result).toHaveText('已取消。');
        await expect(status).toHaveText('已取消。');
        expect(await statusWrites(page)).toEqual(['請先輸入你的興趣關鍵字！', '請先輸入你的興趣關鍵字！', '已產生 3 個主題靈感。', '已取消。']);
    });
});

test('選題靈感頁：閘道回報排隊時，進度區塊提醒分批送出，status 只唸名次', async ({ page }) => {
    await page.goto(PAGE);
    await stubBuiltInGateway(page);
    await installFakeGateway(page, { chunks: [ACCEPTED, sse('progress', { phase: 'queued', position: 2 })], hang: true });
    await page.fill('#ideaInput', '旅行');
    await page.click('#generateIdeaBtn');
    const workspace = page.locator('#ideaWorkspace');
    await expect(workspace.getByRole('status')).toHaveText('排隊中，前面還有 1 位…');
    await expect(workspace.getByText('同一個網路同時使用的人多時，請分批送出。')).toBeVisible();
    await page.evaluate((chunk) => window.__stream.push(chunk), sse('progress', { phase: 'queued', position: 1 }));
    await expect(workspace.getByRole('status')).toHaveText('排隊中，下一個就輪到你…');
    await expect(workspace.getByText('請分批送出')).toHaveCount(1);
});

// 檔案回 404 或連線中斷時 PlatformAI 都不存在，頁面的處理相同。
test.describe('選題靈感頁：共用腳本 platform-ai.js 沒載入成功', () => {
    const FAILURES = [
        ['回 404', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })],
        ['連線中斷', (route) => route.abort()],
    ];

    for (const [name, failScript] of FAILURES) {
        test(`${name} → 按下按鈕以錯誤樣式顯示錯誤訊息，按鈕恢復原狀`, async ({ page }) => {
            await page.route('**/shared/platform-ai.js', failScript);
            await page.goto(PAGE);
            expect(await page.evaluate(() => typeof window.PlatformAI)).toBe('undefined');

            await page.fill('#ideaInput', '旅行');
            await page.click('#generateIdeaBtn');

            await expect(page.locator('#ideaResult')).toHaveText('抱歉，AI 服務發生錯誤，請稍後再試。');
            await expect(page.locator('#ideaResult p')).toHaveClass(/text-red-700/);
            const button = page.locator('#generateIdeaBtn');
            await expect(button).toBeEnabled();
            await expect(button).toHaveText('產生靈感');
            await expect(button.locator('svg')).toHaveCount(1);
            await expect(button).not.toHaveClass(/opacity-50|cursor-not-allowed/);
        });
    }
});
