/*
 * ==================================================================
 * 自動化搜尋索引建立腳本
 * ==================================================================
 * 功能：
 * 1. 掃描指定資料夾內的所有 .html 檔案。
 * 2. 使用 cheerio 解析 HTML，智慧擷取頁面標題、描述、關鍵字與內文。
 * 3. 為動態內容頁面（如學長姐訪談、競賽資訊）額外抓取其 JavaScript 陣列中的資料。
 * 4. 將所有擷取到的資料整合成一個 JSON 檔案 (search-index.json)。
 *
 * 如何使用：
 * 在終端機中執行 `node build-search-index.js`
 * ==================================================================
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const projectRoot = __dirname;
const searchData = [];
let idCounter = 1;

// 要掃描的資料夾列表
const directoriesToScan = [
    '', // 根目錄
    'autonomous-learning',
    'learning-portfolio',
    'career-exploration',
    'advanced-resources'
];

console.log('🚀 開始建立搜尋索引...');

// 遞迴掃描函式
function scanDirectory(directory) {
    const dirPath = path.join(projectRoot, directory);
    if (!fs.existsSync(dirPath)) return;

    const files = fs.readdirSync(dirPath);

    files.forEach(file => {
        const filePath = path.join(dirPath, file);
        const fileUrl = path.join(directory, file).replace(/\\/g, '/');

        if (fs.statSync(filePath).isDirectory()) {
            // 如果是資料夾，就繼續往下掃
            scanDirectory(fileUrl);
        } else if (path.extname(file) === '.html') {
            // 如果是 HTML 檔案，就處理它
            processHtmlFile(filePath, fileUrl);
        }
    });
}

// 處理單一 HTML 檔案的函式
function processHtmlFile(filePath, fileUrl) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const $ = cheerio.load(fileContent);

    // --- 智慧擷取規則 ---
    const pageTitle = $('title').text().split(' - ')[0].trim() || path.basename(fileUrl, '.html');
    const description = $('meta[name="description"]').attr('content') || $('h1').first().text().trim();
    const keywords = $('meta[name="keywords"]').attr('content') || '';
    const bodyText = $('body').text().replace(/\s\s+/g, ' ').trim();

    // 將頁面本身加入索引
    searchData.push({
        id: `page-${idCounter++}`,
        title: pageTitle,
        content: description || `頁面內容包含：${bodyText.substring(0, 100)}...`,
        tags: keywords.split(',').map(k => k.trim()).filter(Boolean),
        url: fileUrl
    });
    console.log(`✅ 已索引頁面: ${fileUrl}`);

    // --- 特殊處理：抓取頁面內嵌的 JavaScript 資料 ---
    $('script').each((i, el) => {
        const scriptContent = $(el).html();
        if (!scriptContent) return;

        // 匹配看起來像資料陣列的變數
        const match = scriptContent.match(/const\s+(\w+Data)\s*=\s*(\[[\s\S]*?\]);/);
        if (match && match[1] && match[2]) {
            try {
                // 使用 Function 建構函式來安全地執行並取得陣列內容
                const dataArray = new Function(`return ${match[2]};`)();
                const dataType = match[1].replace('Data', ''); // e.g., 'interview'

                dataArray.forEach(item => {
                    // 根據常見的欄位名稱來建立索引
                    const itemTitle = item.name || item.title || item.question;
                    const itemContent = item.major || item.description || item.content_html || JSON.stringify(item);

                    if (itemTitle) {
                        searchData.push({
                            id: `${dataType}-${item.id || idCounter++}`,
                            title: `${pageTitle} - ${itemTitle}`,
                            content: cheerio.load(itemContent).text(), // 去除 HTML 標籤
                            tags: [dataType, pageTitle, ...(item.tags || [])],
                            url: `${fileUrl}#${dataType}-${item.id || ''}` // 加上錨點方便跳轉
                        });
                        console.log(`  ➡️ 已索引項目: ${itemTitle}`);
                    }
                });
            } catch (e) {
                console.warn(`⚠️ 解析 ${fileUrl} 中的內嵌資料時發生錯誤: ${e.message}`);
            }
        }
    });
}

// 從根目錄開始掃描
directoriesToScan.forEach(dir => scanDirectory(dir));

// 排除不需要的檔案
const finalSearchData = searchData.filter(item =>
    !item.url.includes('google2e2300e459be5c1b.html') &&
    !item.url.includes('sitemap.html')
);


// 將結果寫入 JSON 檔案
const outputPath = path.join(projectRoot, 'search-index.json');
fs.writeFileSync(outputPath, JSON.stringify(finalSearchData, null, 2));

console.log(`\n🎉 搜尋索引建立完成！ 總共處理了 ${finalSearchData.length} 個項目。`);
console.log(`✨ 索引檔案已儲存至: ${outputPath}`);
