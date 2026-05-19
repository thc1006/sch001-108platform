# 台灣教育處方籤

> 高中 108 課綱教育資源整合平台 — Taiwan K-12 Education Resource Integration Platform

[![專案狀態: 持續開發中](https://img.shields.io/badge/status-in%20progress-brightgreen.svg)](https://thc1006.github.io/sch001-108platform/)
[![授權: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![g0v jothon](https://img.shields.io/badge/g0v-jothon-blue.svg)](https://g0v.hackmd.io/@jothon/SyZRnFqQj)

> 「沒有歹小孩，只有歹命小孩。」

---

## 專案簡介

**台灣教育處方籤** 是一個專為台灣高中生打造的 **108 課綱教育資源整合平台**。我們相信學生的潛力不應被出身或地區所限制，因此將原本散落各處、卻乏人問津的學術與升學資源加以梳理、整合，協助偏鄉與資源弱勢的高中生在自主學習、學習歷程與生涯探索上少走冤枉路。

本平台由 g0v 零時小學校提案社群發起，是一個 **開源、靜態、可長期維護** 的公共資源網站。

* **專案網站**：<https://thc1006.github.io/sch001-108platform/>
* **g0v 提案連結**：[零時小學校 2021 年度獲獎團隊](https://sch001.g0v.tw/dash/prj/3Cyfkt0EDc05-70AJd02ny2Yt)
* **專案介紹影片**：[YouTube](https://youtu.be/BxKFVSTmiYI)
* **原始碼**：[GitHub Repository](https://github.com/thc1006/sch001-108platform)

---

## 技術棧

| 類別 | 採用技術 |
| --- | --- |
| 靜態網站框架 | [Astro 6](https://astro.build/) |
| 樣式 | [Tailwind CSS v4](https://tailwindcss.com/)（透過 PostCSS 套用） |
| 內容管理 | Astro Content Collections（十大學群內容以 Markdown 撰寫） |
| 資料驅動頁 | `public/**/*.json` 資料檔 + 建置後處理腳本 |
| 站內搜尋 | Fuse.js + 建置時產生的 `search-index.json` |
| 部署 | GitHub Pages（GitHub Actions 自動建置與部署） |

設計重點：

* 全站採 **靜態輸出**，無後端伺服器，部署成本低、易於長期維運。
* `astro.config.mjs` 設定 `build.format: 'preserve'`，輸出的目錄結構與 `src/pages/` 一對一對應，完整保留既有網址、書籤與 SEO。
* 部署於 GitHub Pages 專案頁，網址含 `/sch001-108platform` 前綴（`base` 設定）。
* `sitemap.xml` 由 `@astrojs/sitemap` 於建置時自動產生（`dist/sitemap-index.xml`、`dist/sitemap-0.xml`），無需手動維護。

---

## 本機開發與建置

### 環境需求

* Node.js 24（見 `.node-version`）
* npm

### 安裝與啟動

```bash
# 安裝相依套件
npm install

# 啟動本機開發伺服器（預設 http://localhost:4321）
npm run dev

# 建置正式版靜態檔（輸出到 dist/）
npm run build
```

### 搜尋索引

站內搜尋使用的 `search-index.json` 是 **建置後製產物**，並非由 Astro 直接產生。建置流程如下：

```bash
# 1. 先建置，產出 dist/
npx astro build

# 2. 掃描 dist/ 內所有 HTML 與資料 JSON，重建搜尋索引
node build-search-index.js
```

`build-search-index.js` 會掃描 `dist/` 下的所有頁面，擷取標題、描述、關鍵字與內文，並讀取資料驅動頁對應的 JSON（競賽、線上課程、學長姐訪談等），輸出 `dist/search-index.json` 隨網站一起部署。

> GitHub Actions 部署流程（`.github/workflows/deploy.yml`）已自動串接「`astro build` → `build-search-index.js` → 上傳 Pages artifact」，推送到 `main` 後即自動部署，毋需手動操作。

---

## 專案結構

```
.
├── astro.config.mjs          # Astro 設定（base、sitemap serialize 規則）
├── build-search-index.js     # 建置後製：掃描 dist/ 產生搜尋索引
├── postcss.config.mjs        # Tailwind v4 透過 PostCSS 套用
├── public/                   # 靜態資產，原樣複製到 dist/
│   ├── picture/              # 圖片
│   ├── shared/               # 共用前端資源
│   ├── robots.txt
│   └── **/*.json             # 資料驅動頁的資料檔
├── scripts/
│   └── check-competitions.mjs  # 競賽連結健檢腳本
├── src/
│   ├── components/           # Header、Footer 等共用元件
│   ├── layouts/              # BaseLayout.astro
│   ├── pages/                # 頁面路由（與輸出網址一對一）
│   ├── content/              # Content Collections
│   │   └── clusters/         # 十大學群的 Markdown 內容
│   ├── content.config.ts     # Content Collections schema
│   ├── data/
│   │   └── clusters.ts       # 十大學群與主題的中繼資料
│   └── styles/               # 全域樣式
├── tests/                    # Playwright E2E 測試
└── .github/workflows/        # CI：部署、競賽健檢、連結檢查
```

---

## 主要功能區

平台依高中生的需求劃分為五大功能區：

### 自主學習啟航站（`autonomous-learning/`）

協助學生找到並規劃自主學習主題：

* **主題靈感產生器** — 透過策展與 AI 協助發想研究主題。
* **計畫範本庫** — 自主學習計畫的優質範本。
* **學習資源地圖** — 精選全球線上學習資源。
* **研究方法工具箱** — 文獻探討、問卷、訪談等研究方法。

### 學習歷程煉金室（`learning-portfolio/`）

聚焦學習歷程檔案的製作與反思：

* **優質範例藝廊** — 跨學科的學習歷程檔案範例與亮點分析。
* **反思引導提問集** — 深化學習心得的提問框架。
* **多元表現資料庫** — 全台營隊、競賽、志工資訊。
* **線上製作工具箱** — 簡報、心智圖、筆記等實用工具。

### 未來生涯 GPS（`career-exploration/`）

協助學生探索升學方向，核心是 **十大學群探索系統**：

* **十大學群升學指南** — 涵蓋工程、資訊、管理、財經、社會與心理、大眾傳播、設計、生命科學、醫藥衛生、法政等十大學群。每個學群皆有 6 個固定主題：科系風向標、教授看重的特質與能力、多元表現亮點策略、自主學習與探究專題方向、常見迷思破解、申請備審與面試要點。
* **學長姐真心話** — 各校系學長姐的真實升學經驗。
* **核心素養對照表** — 108 課綱三面九項素養的內涵與實踐方法。

### 進階資源探索區（`advanced-resources/`）

為學有餘力的學生提供延伸資源：

* **線上課程精選** — Coursera、edX 等頂尖線上課程。
* **國內外競賽資訊** — 指標性競賽資訊。
* **主題書單推薦** — 建立知識體系的經典書單。
* **開放教育資源** — AI 實驗室、開放科學、開放課程與國際科學社群的開放資源。

### 公民科技專案地圖（`civic-tech-map/`）

* **專案與課綱對照表** — 將 g0v 公民科技專案對應到 108 課綱素養與聯合國 SDGs，作為自主學習與議題探究的素材。

此外還有 **關於我們**（`about.astro`）與 **網站地圖**（`sitemap.astro`）等頁面。

---

## 資料驅動頁的維護方式

部分頁面的內容並未寫死在 `.astro` 檔內，而是從 `public/` 下的 JSON 資料檔載入。要新增、修改或下架這類內容，**只需編輯對應的 JSON 檔**，無需改動頁面程式碼：

| 頁面 | 資料檔 |
| --- | --- |
| 國內外競賽資訊 | `public/advanced-resources/competitions.json` |
| 線上課程精選 | `public/advanced-resources/online-courses.json` |
| 開放教育資源 | `public/advanced-resources/open-education.json` |
| 研究方法工具箱 | `public/autonomous-learning/methodology.json` |
| 學長姐真心話 | `public/career-exploration/senior-interviews.json` |
| 優質範例藝廊 | `public/learning-portfolio/portfolio-gallery.json` |
| 線上製作工具箱 | `public/learning-portfolio/tools.json` |

十大學群的內容則以 Markdown 維護於 `src/content/clusters/<學群>/<主題>.md`，學群與主題的清單（slug、名稱）集中定義於 `src/data/clusters.ts`。

> 修改資料檔後，記得重新執行 `astro build` 與 `build-search-index.js`，站內搜尋索引才會同步更新；推送到 `main` 後 CI 會自動處理。

---

## 如何貢獻

這是一個開源專案，歡迎任何形式的貢獻：

* **學生** — 分享你的學習經驗，或對網站功能提出建議。
* **開發者 / 設計師** — 透過 GitHub 提交 Pull Request 或 Issue。
* **教育工作者** — 與我們交流，提供更多元的觀點。

請先到 [GitHub Issues](https://github.com/thc1006/sch001-108platform/issues) 看看有沒有可以協助的地方。提交程式碼前，建議先在本機執行 `npm run build` 確認站台可正常建置。

---

## 特別感謝

這個專案的成長，要感謝許多人與組織的幫助：

* **g0v 零時小學校** — 讓我們看見只要有心，全世界都會來幫你。
* **林奇葦（「島島阿學」專案）** — 啟發我們向零時小學校提案的前輩。
* **戴賢文老師** — 看見創辦人長才的伯樂。
* **創夢客** — 在地的協力組織。
* 以及所有參與過工作坊、訪談並給予回饋的學生與老師們。

---

## 授權方式

本專案採用 [MIT License](LICENSE) 授權。

聯絡信箱：`hctsai@linux.com`
