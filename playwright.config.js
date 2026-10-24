// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// 瀏覽器只解析得到測試伺服器的主機，其他一律 ERR_NAME_NOT_RESOLVED。頁面會向外部主機載入
// 字型、GA、GoatCounter 與圖片，只要有一個沒有回應，goto 就等到逾時；每開一頁也會往正式站的
// GA 送 pageview。BASE_URL、SITE_BASE_URL 可以把測試伺服器換到別的主機，所以一併放行。
// 用 ^NOTFOUND：URL 的主機名不允許 ^，改寫時請求就失敗。常見的 ~NOTFOUND 是 URL 允許的主機名，
// 要送進解析器、被判定不合格才失敗。不用 page.route 擋：啟用 routing 會停用 HTTP cache。
const testHosts = new Set(['localhost']);
for (const url of [process.env.BASE_URL, process.env.SITE_BASE_URL]) {
    // Chromium 比對的主機名不含 IPv6 位址的方括號。
    if (url) testHosts.add(new URL(url).hostname.replace(/^\[(.*)\]$/, '$1'));
}
const hostResolverRules = ['MAP * ^NOTFOUND', ...[...testHosts].map((h) => `EXCLUDE ${h}`)].join(', ');

/**
 * webServer 讓 Playwright 自己把伺服器帶起來，測試不必先手動開伺服器，CI 也能直接跑。
 * 用自寫的 Node 靜態伺服器而不是 `python -m http.server`：CI runner 不保證有 python。
 */
module.exports = defineConfig({
    testDir: './tests/e2e',
    // 這些是純前端邏輯測試，不該花到 30 秒
    timeout: 20_000,
    expect: { timeout: 5_000 },
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    // retry 的用途是拿到 flaky 的診斷（trace、report），不是讓 flaky 過關。
    // 沒有這一行的話，重試後通過的 test 仍然算綠燈，間歇性失敗被當成成功，
    // 而那正是最需要被看見的訊號。有這一行，本來就穩定的 run 不會變慢也不會變紅，
    // 只有會被 retry 蓋掉的 flake 變成明確失敗。
    failOnFlakyTests: !!process.env.CI,
    reporter: process.env.CI ? [['list'], ['github']] : 'list',
    use: {
        baseURL: process.env.BASE_URL || 'http://localhost:8000',
        trace: 'retain-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'], launchOptions: { args: [`--host-resolver-rules=${hostResolverRules}`] } },
        },
    ],
    webServer: [
        // 8000：repo 根目錄，給 tests/fixtures 用
        {
            command: 'node scripts/static-server.mjs 8000',
            url: 'http://localhost:8000/tests/fixtures/platform-ai.html',
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
