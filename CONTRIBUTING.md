# 貢獻指南

## 開發

### 本機開發

需要 Node.js 24 和 npm 11.16 以上。

```bash
npm ci
npm run dev
npm run verify:site
```

瀏覽器測試要先裝 Chromium，再照 GitHub Pages 的路徑放一份建置結果：

```bash
npx playwright install chromium
rm -rf .link-root && mkdir -p .link-root/sch001-108platform && cp -a dist/. .link-root/sch001-108platform/
npm test
```

### 內容放在哪裡

十大學群的文章在 `src/content/clusters/<學群>/<主題>.md`，學群和主題的清單在 `src/data/clusters.ts`。

競賽、線上課程、書單這類資料頁，內容從 `public/` 底下的 JSON 載入，改資料只要改 JSON。頁面和 JSON 的路徑相同，例如 `advanced-resources/competitions.html` 讀 `public/advanced-resources/competitions.json`，每一頁的對照在 `scripts/data-pages.json`。

公民科技專案頁在建置時讀 `public/civic-tech-map/projects.json` 產生，改專案只要改 JSON。AI 閘道的 `civic-tech-suggestion` 任務抄了專案名稱和狀態，`npm run test:ai-gateway` 會比對。

其他頁面的內容直接寫在 `src/pages/` 的 `.astro`。

### 部署

推到 `main` 後，`.github/workflows/ci.yml` 建置、檢查，再部署到 GitHub Pages。

建置時由環境變數 `PUBLIC_AI_GATEWAY_URL` 帶入 AI 閘道的網址。本機要試 AI 功能，先用 `ALLOWED_ORIGINS=http://localhost:4321 LLM_API_KEY=<key> node ai-gateway/src/server.mjs` 跑閘道（預設埠 8787；WinLab 的 key 只接受校內網段的來源 IP），再帶 `PUBLIC_AI_GATEWAY_URL=http://localhost:8787` 跑 `npm run dev`；這種網址過不了 `verify:site`，跑檢查前要拿掉。CI 用的值是 repository variable `AI_GATEWAY_URL`，在 Settings → Secrets and variables → Actions → Variables 設定。改了之後要等下一次部署才會生效，不推新 commit 的話就在 Actions 對 `CI` 手動執行 workflow_dispatch。閘道本身的部署見 [ai-gateway/README.md](ai-gateway/README.md)。

## 程式碼註解

註解寫給下一個讀程式的人。它回答程式碼回答不了的問題：為什麼這樣寫，有什麼前提，哪裡容易出錯。

規則以 Kubernetes 2022 年以前的[程式碼規範](https://github.com/kubernetes/community/blob/427ccfbc7d423d8763ed756f3b8c888b7de3cf34/contributors/guide/coding-conventions.md)為底，寫法照它沿用的 Go [慣例](https://go.dev/blog/godoc)。JSDoc、TypeScript 和 Astro 照各自的官方文件，排版跟著這個 repo 現有的寫法。

### 先讀程式

動筆前把程式重讀一遍，確認它現在真的這樣運作；改程式的時候，附近的註解也跟著檢查。讀的人通常先相信註解，註解說錯了，他會照著錯的去改。

`scripts/link-health.lib.mjs` 的 ipv6ToBytes，改寫前：

```js
/** 把合法的 IPv6 字串轉成 16 bytes。輸入須先過 net.isIPv6()。 */
export function ipv6ToBytes(text) {
    if (!net.isIPv6(text)) return null;
```

函式第一行就自己做了檢查，呼叫的人不必先過 `net.isIPv6()`。照程式現在的行為改寫：

```js
/**
 * ipv6ToBytes 把 IPv6 字串轉成 16 個位元組，解析不了時回傳 null。
 * @param {string} text
 * @returns {Uint8Array|null}
 */
export function ipv6ToBytes(text) {
    if (!net.isIPv6(text)) return null;
```

「解析不了」比「不是合法的 IPv6」準確：`fe80::1%eth0.100` 這種 zone ID 帶點的位址，`net.isIPv6()` 認為合法，這個函式照樣回傳 null。

引用實測數字時，寫出什麼時候、怎麼量的，例如「2026-08-29 對建置後 94 頁核對」。數字會過時，讀的人要能判斷它還準不準。

### 寫什麼

寫理由、前提和例外。理由是為什麼選這個做法；前提是呼叫的人必須知道、型別又表達不了的事；例外是邊界情況，或和規格、瀏覽器實作不一致的地方，能附出處就附。

審查時有人問「為什麼這樣寫」，就把答案寫進註解。PR 裡的討論不會進到 commit 歷史，讀程式時看不到。

程式碼已經說清楚的事不寫。修改的經過也不寫，那是 commit 訊息的工作，需要背景時附上 issue 或 PR 編號就好。已經不存在的舊做法、寫給這次審查者的話、被註解掉的程式碼，都刪掉。

`build-search-index.js` 讀資料檔的地方，改寫前：

```js
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
```

改寫後：

```js
    let parsed;
    // 後面的迴圈不放進 try，它丟出的錯誤才不會被標成「解析失敗」。
    try {
        parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch (e) {
        throw new Error(`必要的資料來源解析失敗：${cfg.json}：${e.message}`);
    }
```

第一段和前一個 if 的註解講同一件事，刪掉。第二段把「先前」的經過換成現在仍然成立的理由。原文說 try 只包住 JSON.parse，但讀檔也在 try 裡，這句不能照搬。

### 長度

註解不比它說明的程式長。整個檔案也一樣，註解行數不超過程式行數。CSS、YAML 和 shell 腳本也照這兩條。

兩條都比行數。有程式的行算程式行，即使後面接著註解；只有註解的行算註解行，連只有 `/**` 或 `*/` 的行也算；空行不算。`npm run check:comments` 照這個算法檢查 git 追蹤的檔案，也可以只檢查自己改過的：`npm run check:comments -- scripts/link-health.lib.mjs`。

寫到停不下來，通常表示程式該拆開，或那段說明該搬去 README 或 commit 訊息。

### 排版

用台灣繁體中文寫成句子，句尾加句號，行尾幾個字的短註除外。標點用全形，中文和英文、數字之間空一格。引用官方原文時照抄。

腳本和共用模組的開頭，用一兩句話說這個檔案做什麼，用法和前提接在後面。

不畫分隔線或橫幅。橫幅裡的標題只是重複下面的名稱，就跟著刪掉；說了程式看不出來的事，就改寫成一行普通的註解。

待辦寫成 `// TODO(帳號): 改成 X，見 #123。`，括號裡放最清楚這件事的人的 GitHub 帳號。

### JS 和 TS

函式和類別的說明寫成 [JSDoc](https://jsdoc.app/about-getting-started)；常數和變數只有在檔案最外層才這樣寫。`/** */` 緊貼在宣告上方，滑鼠停在名稱上就看得到。第一句以名稱開頭，說它做什麼，用 grep 找名稱時說明會跟著出現；接著寫呼叫的人該知道的前提，再用 `@param`、`@returns` [標型別](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)。別的檔案會用到的宣告都要寫說明；檔內自用的，名稱說得清楚就不寫。

其他註解用 `//`，放在它說明的程式上方。檔頭也用 `//`：寫成 `/** */` 的話，TypeScript 會把它當成下面第一個宣告的說明。

標籤一個一行會讓註解比函式長時，把標籤併成一行。`scripts/hijack-signals.lib.mjs` 的 sameSite 可以改寫成這樣：

```js
/**
 * sameSite 判斷兩個主機名是否相同，或一個是另一個的子網域，刻意不算 eTLD+1。
 * 只取最後兩段會把 a.edu.tw 和 b.edu.tw 當成同一站，要算對又得查公共後綴清單。
 * @param {string} aHost @param {string} bHost @returns {boolean}
 */
export function sameSite(aHost, bHost) {
    if (!aHost || !bHost) return false;
    if (aHost === bHost) return true;
    return aHost.endsWith(`.${bHost}`) || bHost.endsWith(`.${aHost}`);
}
```

給工具讀的註解照工具的規定寫，例如 `/** @type {…} */` 和 `/* c8 ignore next */`，不要改成 `//`。`// @ts-check` 是選用的；只改註解的改寫不要順手加，加了常會冒出得改程式才能解決的型別錯誤。

### Astro

`.astro` 模板裡的筆記用 `{/* */}`，因為 [Astro](https://docs.astro.build/en/reference/astro-syntax/#comments) 會把 `<!-- -->` 留在建置出來的 HTML 裡。frontmatter，以及除了 `src` 之外沒有其他屬性的 `<script>`，會經過[建置](https://docs.astro.build/en/guides/client-side-scripts/)，註解不會留下。`<script is:inline>` 這類帶了其他屬性的 `<script>`，還有 `public/` 底下的檔案，會原樣送到瀏覽器，註解也跟著下載，寫短一點。

### 語氣

只寫事實，不替程式背書。「強大」「完整」「優雅」「無縫」「確保」「務必」這類字通常可以刪掉。

不用「值得注意的是」「此外」「總之」「旨在」這類填充詞。不用粗體和表情符號，不用「注意：」或反問句開頭。

句子有長有短。破折號和括號能不用就不用，一句裡不疊三個形容詞。

## 網站內容

網站寫給準備升學的高中生和家長。只寫查得到的事實，不逢迎，句子長短交錯。多出來的字如果只是重講、預告或修飾，就刪掉。動筆前重讀原始資料，確認現在仍是這樣。這些規則管寫法，不判斷作者是誰。

### 寫出處

說法要寫出是誰說的，查不到出處就不要寫成多數人的意見。

> 教授普遍認為這個動機「太小、太狹隘」。

同一頁寫明出處是北醫醫學系教授：

> 北醫醫學系教授說，這個動機「太小、太狹隘了」。

### 寫數字

「很多」「許多」「非常」這類詞讓讀者猜。有數字就寫數字，沒有就刪掉這個詞。

> 真相：差很多，選錯方向會影響大學四年的學習體驗。

下一段已經逐系列出各系學什麼：

> 真相：不一樣。

### 不背書，不喊話

「至關重要」「精髓」「頂尖」「真正的」這類詞替讀者下結論，「讓我們」「務必」這類說法和驚嘆號是在喊話。寫出撐得起結論的事實。

> 「學習歷程自述」扮演至關重要的角色。

> 「學習歷程自述」把修課紀錄、課程學習成果和多元表現串在一起。

### 每句都帶來新資訊

刪掉一句，讀者會少知道什麼？答不出來就刪。「換句話說」「值得注意的是」這類詞和「不是 X，而是 Y」的句型常是訊號。

> 換句話說，工程不只是理解理論，更要能動手把理論變成可運作的成品。

前一句引的教育目標已經說了，刪掉。

### 標點

「——」「──」這類破折號不用，也不用「—」這種單一長橫線接句子；數字和日期的範圍照舊用連接號。中文用全形標點，引號第一層「」、第二層『』，刪節號寫成「……」。

> 每一大項之檔案大小以 5MB 為限——也就是說，多元表現就算放到 10 件，整個大項合計仍只有 5MB。

> 每一大項之檔案大小以 5MB 為限。多元表現就算放到 10 件，整個大項合計仍只有 5MB。

### 粗體、表情符號與引語

一段最多一處粗體。「粗體標籤：說明」的清單改成小標題、表格或句子，名詞解釋的清單可以留。不用表情符號。綜合整理的內容要標明是整理，只有真的訪談才用引號。

### 檢查與審查

`npm run check:writing` 報出命中的原始檔和行號，回推不到原始檔時報頁面路徑。會擋的規則以 `scripts/writing-policy.json` 的基準筆數上線，新增就擋；筆數比基準少時執行 `npm run check:writing -- --update-baseline` 下修，一類清完後基準就是空的。基準不收新的檔案，改名或搬移有命中的檔案時，要在同一個 PR 清掉那些命中。其他規則只報。程式碼、網址、站外連結文字、書名，和用 `<q>` 標出或寫明「逐字」「原文」的引文不檢查；照抄的外部原文、官方名稱和當反例引用的句子，在 `scripts/writing-allow.json` 寫明原文片段、出處和理由。在「」裡談某個詞時，前後寫上「這類」「例如」這類字，檢查才分得出是在談詞語。出處和有沒有新資訊，靠審查的人從頭讀一遍。commit 訊息和 PR 說明照同樣的寫法。
