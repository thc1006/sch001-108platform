// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright 配置文件
 * 文件: https://playwright.dev/docs/test-configuration
 */

module.exports = defineConfig({
  testDir: './tests',

  /* 最大失敗次數 */
  maxFailures: 5,

  /* 並行執行測試 */
  fullyParallel: true,

  /* CI 環境配置 */
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  /* 並行工作者數量 */
  workers: process.env.CI ? 1 : undefined,

  /* 測試報告 */
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'test-results/results.json' }],
    ['list']
  ],

  /* 全域測試設定 */
  use: {
    /* 基礎 URL */
    baseURL: 'http://localhost:8000',

    /* 失敗時截圖 */
    screenshot: 'only-on-failure',

    /* 失敗時錄影 */
    video: 'retain-on-failure',

    /* 追蹤記錄 */
    trace: 'on-first-retry',

    /* 等待超時 */
    actionTimeout: 10000,
    navigationTimeout: 30000,
  },

  /* 測試專案配置 */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    // 可以取消註解來測試其他瀏覽器
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },
  ],

  /* 本地開發伺服器 */
  webServer: {
    command: 'python -m http.server 8000',
    url: 'http://localhost:8000',
    reuseExistingServer: !process.env.CI,
    timeout: 10000,
  },
});
