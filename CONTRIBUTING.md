# 貢獻指南

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
