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

// 要掃描的資料夾列表。只需根目錄：scanDirectory 會遞迴進入所有未排除的子目錄。
// （先前同時列出 '' 與各子目錄，導致子目錄被掃描兩次、索引項目整批重複。）
const directoriesToScan = [''];

console.log('🚀 開始建立搜尋索引...');

// 檢查是否應該排除的目錄
function shouldExcludeDirectory(dirName) {
    const excludePatterns = ['node_modules', 'tests', 'test-results', 'playwright-report', '.git', '.github', '.claude'];
    return excludePatterns.some(pattern => dirName.includes(pattern));
}

// 遞迴掃描函式
function scanDirectory(directory) {
    const dirPath = path.join(projectRoot, directory);
    if (!fs.existsSync(dirPath)) return;

    const files = fs.readdirSync(dirPath);

    files.forEach(file => {
        const filePath = path.join(dirPath, file);
        const fileUrl = path.join(directory, file).replace(/\\/g, '/');

        if (fs.statSync(filePath).isDirectory()) {
            // 檢查是否應該排除此目錄
            if (shouldExcludeDirectory(file)) {
                console.log(`⏭️  跳過目錄: ${fileUrl}`);
                return;
            }
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

    // --- 已外移到 JSON 的資料驅動頁面：資料不再內嵌於 HTML，上方的
    //     const ...Data 陣列擷取規則抓不到，改由此處讀對應 JSON 索引 ---
    const jsonPageCfg = JSON_DATA_PAGES[fileUrl];
    if (jsonPageCfg) {
        indexJsonDataPage(pageTitle, fileUrl, jsonPageCfg);
    }
}

// 已將資料外移到 JSON 的頁面設定：HTML 路徑 → 該頁索引設定。
// 之後若有更多頁面改為資料驅動，只要在此新增一筆即可。
//   json     ：資料 JSON 路徑（相對 repo 根目錄）
//   arrayKey ：JSON 中存放項目陣列的鍵名
//   idPrefix ：搜尋索引 id 前綴（與 arrayKey 解耦，避免不同頁鍵名相同時難追溯來源）
//   tag      ：給使用者看的中文分類標籤（不用內部英文鍵名兼差）
//   anchor   ：頁內錨點 id
const JSON_DATA_PAGES = {
    'advanced-resources/competitions.html': {
        json: 'advanced-resources/competitions.json',
        arrayKey: 'competitions', idPrefix: 'competition', tag: '競賽',
        anchor: 'competition-grid',
    },
    'advanced-resources/online-courses.html': {
        json: 'advanced-resources/online-courses.json',
        arrayKey: 'courses', idPrefix: 'course', tag: '線上課程',
        anchor: 'course-grid',
    },
    'career-exploration/senior-interviews.html': {
        json: 'career-exploration/senior-interviews.json',
        arrayKey: 'interviews', idPrefix: 'interview', tag: '學長姐訪談',
        anchor: 'interview-grid',
    },
    'learning-portfolio/portfolio-gallery.html': {
        json: 'learning-portfolio/portfolio-gallery.json',
        arrayKey: 'portfolio', idPrefix: 'portfolio', tag: '作品集',
        anchor: 'portfolio-grid',
    },
    'autonomous-learning/methodology.html': {
        json: 'autonomous-learning/methodology.json',
        arrayKey: 'methods', idPrefix: 'method', tag: '研究方法',
        anchor: 'methodology-grid',
    },
    'learning-portfolio/tools.html': {
        json: 'learning-portfolio/tools.json',
        arrayKey: 'tools', idPrefix: 'tool', tag: '線上工具',
        anchor: 'tool-grid',
    },
};

// 各資料頁的項目欄位不盡相同（如競賽用 title、訪談用 name），故以下採欄位聯集。
const ITEM_TITLE_FIELDS = ['title', 'name', 'question'];
const ITEM_TEXT_FIELDS = ['organizer', 'provider', 'platform', 'major', 'university', 'quote', 'description'];
const ITEM_HTML_FIELDS = ['content_html', 'analysis_html'];

// 通用：讀一個資料 JSON，為其中每筆項目建立搜尋索引項目。
function indexJsonDataPage(pageTitle, fileUrl, cfg) {
    const jsonPath = path.join(projectRoot, cfg.json);
    if (!fs.existsSync(jsonPath)) {
        console.warn(`⚠️ 找不到 ${cfg.json}，略過 ${fileUrl} 的項目索引`);
        return;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const items = Array.isArray(parsed[cfg.arrayKey]) ? parsed[cfg.arrayKey] : [];
        items.forEach(item => {
            if (!item || typeof item !== 'object') return;
            const itemTitle = ITEM_TITLE_FIELDS.map(f => item[f]).find(v => typeof v === 'string' && v);
            if (!itemTitle) return;
            // 內文：純文字欄位 + 去除標籤後的 HTML 欄位
            const textParts = ITEM_TEXT_FIELDS
                .map(f => item[f]).filter(v => typeof v === 'string' && v);
            const htmlParts = ITEM_HTML_FIELDS
                .map(f => item[f]).filter(v => typeof v === 'string' && v)
                .map(h => cheerio.load(h).text());
            const itemTags = Array.isArray(item.tags) ? item.tags : [];
            searchData.push({
                id: `${cfg.idPrefix}-${idCounter++}`,
                title: `${pageTitle} - ${itemTitle}`,
                content: [...textParts, ...htmlParts].join(' ').replace(/\s+/g, ' ').trim(),
                tags: [cfg.tag, pageTitle, item.category, item.level, ...itemTags].filter(Boolean),
                url: `${fileUrl}#${cfg.anchor}`
            });
            console.log(`  ➡️ 已索引項目: ${itemTitle}`);
        });
    } catch (e) {
        console.warn(`⚠️ 解析 ${cfg.json} 時發生錯誤: ${e.message}`);
    }
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
