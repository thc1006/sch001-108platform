const { test, expect } = require('@playwright/test');

test('Debug POC 頁面載入', async ({ page }) => {
    // 監聽控制台訊息
    page.on('console', msg => {
        console.log(`瀏覽器控制台 [${msg.type()}]:`, msg.text());
    });

    // 監聽網路失敗
    page.on('requestfailed', request => {
        console.log(`❌ 網路請求失敗: ${request.url()}`);
        console.log(`   失敗原因: ${request.failure().errorText}`);
    });

    // 監聽網路回應
    page.on('response', response => {
        if (!response.ok()) {
            console.log(`⚠️  HTTP ${response.status()}: ${response.url()}`);
        }
    });

    //監聽頁面錯誤
    page.on('pageerror', error => {
        console.log(`❌ 頁面錯誤: ${error.message}`);
        console.log(`   堆疊: ${error.stack}`);
    });

    console.log('\n開始載入頁面...\n');

    // 開啟頁面
    await page.goto('http://localhost:8000/poc-flexsearch.html');

    // 等待網路閒置
    await page.waitForLoadState('networkidle');

    console.log('\n頁面載入完成，等待 5 秒...\n');

    // 等待 5 秒
    await page.waitForTimeout(5000);

    // 獲取索引狀態
    const indexStatus = await page.locator('#index-status').textContent();
    console.log(`\n索引狀態: "${indexStatus}"\n`);

    // 獲取資料數量
    const dataCount = await page.locator('#data-count').textContent();
    console.log(`資料數量: "${dataCount}"\n`);

    // 截圖
    await page.screenshot({ path: 'test-results/debug-screenshot.png', fullPage: true });
    console.log('\n截圖已儲存: test-results/debug-screenshot.png\n');

    // 獲取頁面 HTML (前 1000 字元)
    const html = await page.content();
    console.log(`\nHTML 內容長度: ${html.length} 字元\n`);

    // 檢查是否有錯誤訊息
    const hasError = indexStatus.includes('❌');
    const isReady = indexStatus.includes('✅');

    console.log(`\n狀態檢查:`);
    console.log(`  有錯誤: ${hasError}`);
    console.log(`  已就緒: ${isReady}\n`);
});
