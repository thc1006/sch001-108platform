// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * 先前沒有這個設定檔，於是 tests/e2e/puter-ai.spec.js 的說明要求人工另開一個
 * terminal 跑 `npm run serve`。結果是：測試從來沒有真的被跑過，也進不了 CI。
 *
 * webServer 讓 Playwright 自己把伺服器帶起來。用自寫的 Node 靜態伺服器而不是
 * 原本的 `python -m http.server`：CI runner 不保證有 python。
 */
module.exports = defineConfig({
    testDir: './tests/e2e',
    // 這些是純前端邏輯測試，不該花到 30 秒
    timeout: 20_000,
    expect: { timeout: 5_000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? [['list'], ['github']] : 'list',
    use: {
        baseURL: process.env.BASE_URL || 'http://localhost:8000',
        trace: 'retain-on-failure',
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
    webServer: [
        // 8000：repo 根目錄，給 tests/fixtures 用
        {
            command: 'node scripts/static-server.mjs 8000',
            url: 'http://localhost:8000/tests/fixtures/puter-ai.html',
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
        },
        // 8001：.link-root，重現 GitHub Pages 的 /sch001-108platform/ 命名空間。
        // 站台的連結都是根相對路徑，路徑對不上就測不出真實行為。
        {
            command: 'node scripts/static-server.mjs 8001 .link-root',
            url: 'http://localhost:8001/sch001-108platform/index.html',
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
        },
    ],
});
