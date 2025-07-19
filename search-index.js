/**
 * =================================================================================
 * Search Index Builder Script
 * =================================================================================
 *
 * 說明：
 * 這個 Node.js 腳本會自動掃描指定的 HTML 檔案，
 * 根據預設的規則擷取標題、內容、標籤等資訊，
 * 最後產生一個 search-index.js 檔案供前端搜尋功能使用。
 *
 * 使用方法：
 * 1. 確認已安裝 Node.js。
 * 2. 在終端機執行 `npm install glob cheerio`。
 * 3. 執行 `node build-search-index.js` 來產生索引檔。
 *
 */

const fs = require('fs');
const path = require('path');
const glob = require('glob');
const cheerio = require('cheerio');

// --- 設定區 ---
const CONTENT_DIR = './'; // 網站內容的根目錄
const OUTPUT_FILE = './search-index.js'; // 產生的索引檔案路徑
// --- 結束設定區 ---

// 檔案擷取規則設定
// 這裡定義了要掃描哪些檔案，以及如何從中擷取資料
const EXTRACTION_CONFIG = [
    {
        name: '學長姐真心話',
        path: 'career-exploration/senior-interviews.html',
        selector: 'div[id^="info-"]', // 選取所有 id 以 "info-" 開頭的 div
        fields: {
            title: 'h3',
            content: 'p', // 會合併所有 p 標籤的文字
            tags: ($, el) => {
                const title = $(el).find('h3').text();
                // 簡單從標題產生標籤
                return ['學長姐真心話', ...title.match(/[\u4e00-\u9fa5a-zA-Z]+/g) || []];
            }
        }
    },
    {
        name: '計畫範本',
        path: 'autonomous-learning/plan-templates.html',
        selector: '.bg-white.p-8.rounded-xl.shadow-lg',
        fields: {
            title: 'h3',
            content: 'p',
            tags: ['自主學習', '計畫範本']
        }
    },
    {
        name: '主題點子',
        path: 'autonomous-learning/topic-ideas.html',
        selector: '.bg-white.p-8.rounded-xl.shadow-lg',
        fields: {
            title: 'h3',
            content: 'p',
            tags: ['自主學習', '主題點子']
        }
    },
    {
        name: '線上課程',
        path: 'advanced-resources/online-courses.html',
        selector: '.bg-white.rounded-lg.shadow-md.p-6',
        fields: {
            title: 'h4',
            content: 'p.text-gray-600',
            tags: ($, el) => {
                const platform = $(el).find('p > strong').text();
                return ['進階資源', '線上課程', platform].filter(Boolean);
            }
        }
    },
    {
        name: '國內外競賽',
        path: 'advanced-resources/competitions.html',
        selector: '.bg-white.rounded-lg.shadow-md.p-6',
        fields: {
            title: 'h4',
            content: 'p.text-gray-600',
            tags: ['進階資源', '競賽']
        }
    },
    {
        name: '主題書單',
        path: 'advanced-resources/reading-list.html',
        selector: '.bg-white.rounded-lg.shadow-md.p-6',
        fields: {
            title: 'h4',
            content: 'p.text-gray-600',
            tags: ['進階資源', '書單']
        }
    }
];

function buildSearchIndex() {
    console.log('🚀 開始建立搜尋索引...');
    let searchData = [];
    let entryId = 1;

    EXTRACTION_CONFIG.forEach(config => {
        const filePath = path.join(CONTENT_DIR, config.path);
        if (!fs.existsSync(filePath)) {
            console.warn(`⚠️ 警告：找不到檔案 ${filePath}，跳過處理。`);
            return;
        }

        const htmlContent = fs.readFileSync(filePath, 'utf-8');
        const $ = cheerio.load(htmlContent);
        
        $(config.selector).each((i, element) => {
            const entry = {
                id: `${config.name.replace(/\s/g, '-')}-${entryId++}`,
                category: config.name,
            };

            // 根據設定擷取欄位
            Object.keys(config.fields).forEach(field => {
                const rule = config.fields[field];
                if (typeof rule === 'string') {
                    // 如果是 CSS 選擇器字串
                    entry[field] = $(element).find(rule).map((_, el) => $(el).text().trim()).get().join(' ');
                } else if (Array.isArray(rule)) {
                    // 如果是固定的標籤陣列
                    entry[field] = rule;
                } else if (typeof rule === 'function') {
                    // 如果是自訂函式
                    entry[field] = rule($, element);
                }
            });
            
            // 產生 URL
            const elementId = $(element).attr('id');
            entry.url = elementId ? `${config.path}#${elementId}` : config.path;

            searchData.push(entry);
        });
        console.log(`✅ 已處理 ${config.name}，找到 ${$(config.selector).length} 筆資料。`);
    });

    // 產生檔案內容
    const fileContent = `
/**
 * =================================================================================
 * 台灣教育處方籤 - 全站搜尋索引檔 (Search Index)
 * =================================================================================
 *
 * !!! 注意：這個檔案是由 build-search-index.js 自動產生的，請勿手動修改 !!!
 *
 * 最後更新時間：${new Date().toISOString()}
 *
 */

const searchData = ${JSON.stringify(searchData, null, 2)};
    `;

    // 寫入檔案
    fs.writeFileSync(OUTPUT_FILE, fileContent.trim(), 'utf-8');
    console.log(`\n🎉 搜尋索引建立成功！總共 ${searchData.length} 筆資料已寫入至 ${OUTPUT_FILE}`);
}

// 執行主函式
buildSearchIndex();
