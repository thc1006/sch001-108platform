/*
 * ==================================================================
 * 自動化搜尋索引建立腳本
 * ==================================================================
 * 功能：
 * 1. 掃描 dist/ 內的所有 .html 檔案。
 * 2. 使用 cheerio 解析 HTML，智慧擷取頁面標題、描述、關鍵字與內文。
 * 3. 為動態內容頁面（如學長姐訪談、競賽資訊）額外抓取其 JavaScript 陣列中的資料。
 * 4. 將所有擷取到的資料整合成一個 JSON 檔案 (search-index.json)。
 *
 * 如何使用：
 * 本腳本掃描的是 `astro build` 的產物 dist/，因此「務必」先執行 astro build，
 * 再執行本腳本：
 *   npx astro build && node build-search-index.js
 * （遷移到 Astro 後，實際頁面與資產 JSON 都會被 Astro 複製到 dist/，
 *   不再放在 repo 根目錄。）輸出的 search-index.json 也寫在 dist/ 根，
 *   這樣會跟著 dist/ 一起被部署到 GitHub Pages。
 * ==================================================================
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

// 掃描起點改為 astro build 的輸出目錄 dist/（遷移前是 repo 根目錄 __dirname）。
// 頁面與資產 JSON 都在 dist/ 下，JSON_DATA_PAGES 的相對路徑於 dist/ 內維持不變。
const projectRoot = path.join(__dirname, 'dist');
const searchData = [];
let idCounter = 1;

// 要掃描的資料夾列表。只需根目錄：scanDirectory 會遞迴進入所有未排除的子目錄。
// （先前同時列出 '' 與各子目錄，導致子目錄被掃描兩次、索引項目整批重複。）
const directoriesToScan = [''];

console.log('🚀 開始建立搜尋索引...');

// 防呆：dist/ 不存在代表尚未執行 astro build，直接中止並提示。
if (!fs.existsSync(projectRoot)) {
    console.error('❌ 找不到 dist/ 目錄。請先執行 `npx astro build` 再執行本腳本。');
    process.exit(1);
}

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

    // 該頁實際存在的錨點，供下方產生搜尋結果 URL 時驗證用
    const pageAnchorIds = new Set();
    $('[id]').each((_, el) => { const v = $(el).attr('id'); if (v) pageAnchorIds.add(v); });
    $('a[name]').each((_, el) => { const v = $(el).attr('name'); if (v) pageAnchorIds.add(v); });

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
                    // 只取人類可讀的文字欄位;絕不用 JSON.stringify(item) 當內文,
                    // 否則像 {id,title,color} 這類 UI 查找表會把整包原始 JSON 塞進搜尋索引。
                    const itemContent = item.major || item.description || item.content_html || item.title || item.name || '';

                    if (itemTitle) {
                        searchData.push({
                            id: `${dataType}-${item.id || idCounter++}`,
                            title: `${pageTitle} - ${itemTitle}`,
                            content: cheerio.load(itemContent).text(), // 去除 HTML 標籤
                            tags: [dataType, pageTitle, ...(item.tags || [])],
                            // 錨點必須真的存在於建置產物中才加上。先前無條件產生
                            // `#${dataType}-${item.id}`，但頁面是把項目 client-render 進
                            // 容器（如 #sdg-grid），根本沒有逐項的 id——結果 17 筆搜尋結果
                            // 指向不存在的錨點，點了只會停在頁面頂端。
                            url: buildItemUrl(fileUrl, `${dataType}-${item.id || ''}`, pageAnchorIds)
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
// 註：鍵（HTML 頁面相對路徑）與 json 路徑皆相對於掃描起點 projectRoot，
//     遷移後即 dist/；資產 JSON 由 astro build 複製進 dist/ 後路徑不變。
//   json      ：資料 JSON 路徑（相對 dist/）
//   arrayKey  ：JSON 中存放項目陣列的鍵名
//   nestedKey ：（可選）若 JSON 為巢狀結構——arrayKey 取出的是「分組陣列」，
//               每個分組底下才有真正的項目陣列——則填入該項目陣列的鍵名，
//               索引時會以 groups.flatMap(g => g[nestedKey]) 攤平成單層清單。
//               扁平結構（arrayKey 直接就是項目陣列）不需填此欄位。
//   idPrefix  ：搜尋索引 id 前綴（與 arrayKey 解耦，避免不同頁鍵名相同時難追溯來源）
//   tag       ：給使用者看的中文分類標籤（不用內部英文鍵名兼差）
//   anchor    ：頁內錨點 id
// 資料驅動頁面的設定改由 scripts/data-pages.json 提供，與 check-built-site.mjs 共用。
// 先前這份對應表只存在於本檔，站台契約檢查若要知道「JSON 的相對路徑該相對哪個
// 頁面解析」就得手抄第二份——手抄必然漂移，那正是 #72 一路在修的失效模式。
const dataPagesConfig = require('./scripts/data-pages.json');
const JSON_DATA_PAGES = dataPagesConfig.pages;

// 各資料頁的項目欄位不盡相同（如競賽用 title、訪談用 name、書單用 recommendation），
// 故以下採欄位聯集。
const ITEM_TITLE_FIELDS = ['title', 'name', 'question'];
const ITEM_TEXT_FIELDS = ['organizer', 'provider', 'platform', 'major', 'university', 'quote', 'description', 'author', 'original_title', 'recommendation'];
const ITEM_HTML_FIELDS = dataPagesConfig.htmlFields;

// 搜尋結果的 URL：錨點存在才加，否則只回頁面路徑。
// 指向不存在的錨點不會讓連結壞掉（頁面仍載入），但會讓「跳到該項目」這個承諾
// 失效，且靜默——這正是 scripts/check-built-site.mjs 現在會擋下的那一類。
function buildItemUrl(fileUrl, anchor, anchorIds) {
    return anchorIds && anchorIds.has(anchor) ? `${fileUrl}#${anchor}` : fileUrl;
}

// 通用：讀一個資料 JSON，為其中每筆項目建立搜尋索引項目。
function indexJsonDataPage(pageTitle, fileUrl, cfg) {
    const jsonPath = path.join(projectRoot, cfg.json);
    // fail closed：這些 JSON 是 JSON_DATA_PAGES 明確設定的必要資料來源，不是
    // 選配。先前缺檔時只 warn 後略過，整個資料頁的搜尋項目會靜默消失而 CI 全綠
    // ——「少了一整頁的搜尋結果」不該是一個警告，而該是建置失敗。
    if (!fs.existsSync(jsonPath)) {
        throw new Error(`必要的資料來源不存在：${cfg.json}（供 ${fileUrl} 使用）`);
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const topLevel = Array.isArray(parsed[cfg.arrayKey]) ? parsed[cfg.arrayKey] : [];
        // 巢狀結構（有 nestedKey）：arrayKey 取到的是分組陣列，需再攤平出真正的項目清單。
        // 扁平結構：arrayKey 取到的就是項目清單。
        const items = cfg.nestedKey
            ? topLevel.flatMap(group =>
                (group && Array.isArray(group[cfg.nestedKey])) ? group[cfg.nestedKey] : [])
            : topLevel;
        // 同一筆資料可能跨分組重複出現（如同一本書跨多個主題），以 isbn 去重，只索引一次。
        const seenIsbn = new Set();
        items.forEach(item => {
            if (!item || typeof item !== 'object') return;
            if (item.isbn) {
                if (seenIsbn.has(item.isbn)) return;
                seenIsbn.add(item.isbn);
            }
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
        // 同上：設定過的資料來源解析不了，代表搜尋功能已經殘缺，應直接讓建置與
        // 部署失敗，而不是產出一份「看起來成功、實際少了東西」的索引。
        throw new Error(`必要的資料來源解析失敗：${cfg.json}：${e.message}`);
    }
}

// 從根目錄開始掃描
directoriesToScan.forEach(dir => scanDirectory(dir));

// 排除不需要的檔案
const finalSearchData = searchData.filter(item =>
    !item.url.includes('google2e2300e459be5c1b.html') &&
    !item.url.includes('sitemap.html')
);


// 將結果寫入 JSON 檔案。
// projectRoot 已是 dist/，故輸出落在 dist/search-index.json，會隨 dist/ 一起部署。
const outputPath = path.join(projectRoot, 'search-index.json');
fs.writeFileSync(outputPath, JSON.stringify(finalSearchData, null, 2));

console.log(`\n🎉 搜尋索引建立完成！ 總共處理了 ${finalSearchData.length} 個項目。`);
console.log(`✨ 索引檔案已儲存至: ${outputPath}`);
