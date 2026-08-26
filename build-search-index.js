/*
 * ==================================================================
 * 自動化搜尋索引建立腳本
 * ==================================================================
 * 功能：
 * 1. 掃描 dist/ 內的所有 .html 檔案。
 * 2. 使用 cheerio 解析 HTML，智慧擷取頁面標題、描述、關鍵字與內文。
 * 3. 為動態內容頁面（如學長姐訪談、競賽資訊）額外抓取其 JavaScript 陣列中的資料。
 * 4. 把來源資料的 108 課綱核心素養代碼與 SDGs 編號展開成可搜尋的中文標籤
 *    （代碼與標籤的對照表在 scripts/taxonomy.json）。
 * 5. 將所有擷取到的資料整合成一個 JSON 檔案 (search-index.json)。
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
// SEARCH_INDEX_DIST 可指向另一份建置產物。故障注入需要一份可以隨意破壞的副本，
// 不能動到真正要部署的那一份（與 check-built-site.mjs 的 SITE_DIST 同一個道理）。
const projectRoot = path.resolve(__dirname, process.env.SEARCH_INDEX_DIST || 'dist');
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
            // try 只包住「把疑似資料陣列的字面值求值出來」這一步。上面那條正規
            // 表示式是啟發式的，會匹配到不是資料的東西，求值失敗只代表「這段不是
            // 資料」，警告後略過是對的。
            //
            // 但底下的項目迴圈不一樣：那裡失敗代表資料本身有問題（例如素養代碼
            // 打錯），先前整段都在 try 裡，一個錯字會讓整頁的項目靜默消失、只留
            // 一行 warning 而 CI 全綠。實際踩過：career-exploration 的學群卡片一
            // 出現不認得的素養值，索引就從 405 筆掉到 396 筆。
            let dataArray;
            try {
                // 使用 Function 建構函式來安全地執行並取得陣列內容
                dataArray = new Function(`return ${match[2]};`)();
            } catch (e) {
                console.warn(`⚠️ 解析 ${fileUrl} 中的內嵌資料時發生錯誤: ${e.message}`);
                return;
            }
            if (Array.isArray(dataArray)) {
                const dataType = match[1].replace('Data', ''); // e.g., 'interview'

                dataArray.forEach(item => {
                    if (!item || typeof item !== 'object') return;
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
                            // 內嵌資料目前都沒有分類欄位，但仍走同一個展開函式：
                            // 兩條路徑各自實作，第二條遲早會忘記加，而症狀是
                            // 「標籤靜默消失」——那正是本檔一路在防的東西。
                            ...taxonomyFor(item, itemTitle),
                            // 錨點必須真的存在於建置產物中才加上。先前無條件產生
                            // `#${dataType}-${item.id}`，但頁面是把項目 client-render 進
                            // 容器（如 #sdg-grid），根本沒有逐項的 id——結果 17 筆搜尋結果
                            // 指向不存在的錨點，點了只會停在頁面頂端。
                            url: buildItemUrl(fileUrl, `${dataType}-${item.id || ''}`, pageAnchorIds)
                        });
                        console.log(`  ➡️ 已索引項目: ${itemTitle}`);
                    }
                });
            }
        }
    });

    // --- 已外移到 JSON 的資料驅動頁面：資料不再內嵌於 HTML，上方的
    //     const ...Data 陣列擷取規則抓不到，改由此處讀對應 JSON 索引 ---
    const jsonPageCfg = JSON_DATA_PAGES[fileUrl];
    if (jsonPageCfg) {
        indexJsonDataPage(pageTitle, fileUrl, jsonPageCfg, pageAnchorIds);
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

// 108 課綱核心素養與 SDGs 的代碼→中文標籤對照。與 scripts/taxonomy.lib.mjs 讀的是
// 同一份 JSON：本檔是 CommonJS、scripts/*.mjs 是 ESM，共用設定只能走 JSON。
const TAXONOMY = require('./scripts/taxonomy.json');
// 同一個 competencies 欄位在既有資料裡有兩種寫法：公民科技專案存代碼（"A2"），
// 生涯學群卡片（career-exploration/index.astro 的內嵌資料）存中文名
// （"系統思考與解決問題"）。兩者指的是同一件事，索引時一律正規化成代碼——
// 否則使用者打「A2」只會找到其中一半，而另一半沒有任何跡象顯示它被漏掉了。
const COMPETENCY_BY_LABEL = new Map(
    Object.entries(TAXONOMY.competencies).map(([code, v]) => [v.label, code]),
);

// 各資料頁的項目欄位不盡相同（如競賽用 title、訪談用 name、書單用 recommendation），
// 故以下採欄位聯集。
const ITEM_TITLE_FIELDS = ['title', 'name', 'question'];
const ITEM_TEXT_FIELDS = ['organizer', 'provider', 'platform', 'major', 'university', 'quote', 'description', 'author', 'original_title', 'recommendation'];
const ITEM_HTML_FIELDS = dataPagesConfig.htmlFields;
// 會被攤平成搜尋標籤的陣列欄位。tags 是議題關鍵字（環保、假訊息…），
// subjects 是學科領域（地理 (GIS)、公民與社會…），兩者都是使用者會直接打進搜尋框的字。
const ITEM_TAG_ARRAY_FIELDS = ['tags', 'subjects'];

/**
 * 把來源資料上的 competencies（A1-C3 代碼）與 sdgs（1-17 整數）展開成搜尋索引的
 * 三個欄位：competencies（代碼原樣，讓使用者打「A2」就命中）、sdgs（"SDG11" 字串，
 * 見 issue #14 的 schema 提案）、taxonomy（中文標籤，讓使用者打「系統思考」
 * 「永續城鄉」「社會參與」也命中）。
 *
 * fail closed：代碼不合法就直接 throw 讓建置紅燈。這裡若改成「跳過不認得的值」，
 * 症狀會是「搜尋找不到那個標籤」而不是「建置失敗」——沒有人會回報那種症狀，
 * 而 CI 會一路全綠。這正是 #78 修掉的那類假象。
 *
 * 沒有任何分類欄位的項目回傳空物件，索引項目維持原樣（不塞空陣列進去）。
 */
function taxonomyFor(item, label) {
    const out = {};
    const labels = [];

    if (item.competencies !== undefined) {
        if (!Array.isArray(item.competencies)) {
            throw new Error(`「${label}」的 competencies 必須是陣列`);
        }
        const codes = [];
        for (const raw of item.competencies) {
            // 代碼（"A2"）或官方中文名（"系統思考與解決問題"）都收，一律正規化成代碼
            const code = typeof raw === 'string'
                ? (TAXONOMY.competencies[raw] ? raw : COMPETENCY_BY_LABEL.get(raw))
                : undefined;
            const entry = code ? TAXONOMY.competencies[code] : undefined;
            if (!entry) {
                throw new Error(
                    `「${label}」的 competencies「${raw}」不是合法的核心素養代碼`
                    + `（須為 ${Object.keys(TAXONOMY.competencies).join('、')}，或其官方中文名稱）`,
                );
            }
            codes.push(code);
            labels.push(`${code} ${entry.label}`);
            // 三面九項的「面向」也要能搜到：打「社會參與」應該找得到 C1/C2/C3 的專案
            if (!labels.includes(entry.domain)) labels.push(entry.domain);
        }
        out.competencies = codes;
    }

    if (item.sdgs !== undefined) {
        if (!Array.isArray(item.sdgs)) {
            throw new Error(`「${label}」的 sdgs 必須是陣列`);
        }
        const tags = [];
        for (const n of item.sdgs) {
            const name = Number.isInteger(n) ? TAXONOMY.sdgs[String(n)] : undefined;
            if (!name) {
                throw new Error(`「${label}」的 sdgs「${n}」不是合法的 SDG 編號（須為 1-17 的整數）`);
            }
            tags.push(`SDG${n}`);
            // 與 civic-tech-map 頁面上的標籤同字串（SDG 與數字之間有空白）
            labels.push(`SDG ${n} ${name}`);
        }
        out.sdgs = tags;
    }

    if (labels.length) out.taxonomy = labels;
    return out;
}

// 搜尋結果的 URL：錨點存在才加，否則只回頁面路徑。
// 指向不存在的錨點不會讓連結壞掉（頁面仍載入），但會讓「跳到該項目」這個承諾
// 失效，且靜默——這正是 scripts/check-built-site.mjs 現在會擋下的那一類。
function buildItemUrl(fileUrl, anchor, anchorIds) {
    return anchorIds && anchorIds.has(anchor) ? `${fileUrl}#${anchor}` : fileUrl;
}

// 通用：讀一個資料 JSON，為其中每筆項目建立搜尋索引項目。
function indexJsonDataPage(pageTitle, fileUrl, cfg, pageAnchorIds) {
    const jsonPath = path.join(projectRoot, cfg.json);
    // fail closed：這些 JSON 是 JSON_DATA_PAGES 明確設定的必要資料來源，不是
    // 選配。先前缺檔時只 warn 後略過，整個資料頁的搜尋項目會靜默消失而 CI 全綠
    // ——「少了一整頁的搜尋結果」不該是一個警告，而該是建置失敗。
    if (!fs.existsSync(jsonPath)) {
        throw new Error(`必要的資料來源不存在：${cfg.json}（供 ${fileUrl} 使用）`);
    }
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch (e) {
        // 同上：設定過的資料來源解析不了，代表搜尋功能已經殘缺，應直接讓建置與
        // 部署失敗，而不是產出一份「看起來成功、實際少了東西」的索引。
        //
        // try 只包住 JSON.parse。先前整個項目迴圈都在 try 裡，任何 schema 錯誤
        // 都會被改寫成「資料來源解析失敗」，訊息把讀的人指向錯的地方。
        throw new Error(`必要的資料來源解析失敗：${cfg.json}：${e.message}`);
    }
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
        const itemTags = ITEM_TAG_ARRAY_FIELDS
            .flatMap(f => (Array.isArray(item[f]) ? item[f] : []))
            .filter(v => typeof v === 'string' && v);
        searchData.push({
            id: `${cfg.idPrefix}-${idCounter++}`,
            title: `${pageTitle} - ${itemTitle}`,
            content: [...textParts, ...htmlParts].join(' ').replace(/\s+/g, ' ').trim(),
            tags: [cfg.tag, pageTitle, item.category, item.level, ...itemTags].filter(Boolean),
            ...taxonomyFor(item, itemTitle),
            url: `${fileUrl}#${resolveDataPageAnchor(cfg, item, itemTitle, fileUrl, pageAnchorIds)}`
        });
        console.log(`  ➡️ 已索引項目: ${itemTitle}`);
    });
}

/**
 * 決定一筆資料頁項目的頁內錨點，並確認它真的存在於建置產物中。
 *
 *   cfg.anchor      整頁共用的容器錨點。資料是瀏覽器 fetch 後才 client-render 的
 *                   頁面（競賽、書單…）沒有逐項 id，只能指向容器。
 *   cfg.anchorField 用項目的哪一個欄位當錨點。頁面在 .astro 內靜態寫死、每筆都有
 *                   自己的 id 時使用（公民科技專案地圖）。
 *
 * 兩者都 fail closed：對不上就讓建置失敗。這裡刻意不沿用 buildItemUrl 的「錨點
 * 不存在就退回頁面路徑」——那條路適用於「本來就不保證有錨點」的內嵌資料；而這裡
 * 的錨點是 data-pages.json 明講的契約，靜默退回只會讓整批結果指向頁首而沒有任何
 * 訊號。#78 修掉的 17 筆壞錨點正是那樣產生的。
 */
function resolveDataPageAnchor(cfg, item, itemTitle, fileUrl, pageAnchorIds) {
    const hasFixed = typeof cfg.anchor === 'string' && cfg.anchor.length > 0;
    const hasField = typeof cfg.anchorField === 'string' && cfg.anchorField.length > 0;
    if (hasFixed === hasField) {
        throw new Error(`${fileUrl} 的設定必須且只能有 anchor 或 anchorField 其中一個`);
    }
    const anchor = hasFixed ? cfg.anchor : item[cfg.anchorField];
    if (typeof anchor !== 'string' || !anchor) {
        throw new Error(`「${itemTitle}」缺少 anchorField 指定的欄位 ${cfg.anchorField}`);
    }
    if (!pageAnchorIds || !pageAnchorIds.has(anchor)) {
        throw new Error(
            `${fileUrl} 沒有 id="${anchor}"，搜尋結果會指向不存在的錨點（項目：${itemTitle}）`,
        );
    }
    return anchor;
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
