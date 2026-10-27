# 台灣教育處方籤

[![專案狀態: 持續開發中](https://img.shields.io/badge/status-in%20progress-brightgreen.svg)](https://thc1006.github.io/sch001-108platform/)
[![授權: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![g0v jothon](https://img.shields.io/badge/g0v-jothon-blue.svg)](https://g0v.hackmd.io/@jothon/SyZRnFqQj)

> 「沒有歹小孩，只有歹命小孩。」

台灣教育處方籤是給高中生的 108 課綱學習資源網站。自主學習、學習歷程檔案、大學學群、競賽和線上課程的資料原本散在各處，這裡把它們整理在一起，讓偏鄉和資源較少的學生也找得到。

專案從 g0v 零時小學校的提案開始，是零時小學校 2021 年度的獲獎團隊之一。

* 網站：<https://thc1006.github.io/sch001-108platform/>
* g0v 提案頁：[零時小學校 2021 年度獲獎團隊（Internet Archive 2026-03-28 存檔）](https://web.archive.org/web/20260328115517/https://sch001.g0v.tw/dash/prj/3Cyfkt0EDc05-70AJd02ny2Yt)
* 介紹影片：[YouTube](https://www.youtube.com/watch?v=BxKFVSTmiYI)

標有 AI 的功能會把你輸入的文字送到另外部署的 [AI 閘道](ai-gateway/README.md)，由自架的語言模型回答。

## 網站內容

[網站首頁](https://thc1006.github.io/sch001-108platform/)有全站搜尋，查得到各頁的內容和資料頁裡的每一筆項目。

### [自主學習](https://thc1006.github.io/sch001-108platform/autonomous-learning/)

自主學習區首頁的 AI 自主學習教練依你的初步想法，給一份學習啟動包。

* [主題靈感產生器](https://thc1006.github.io/sch001-108platform/autonomous-learning/topic-ideas.html)：從學科和研究方法的組合、全球趨勢議題與社會議題範例找研究主題，也可以讓 AI 依興趣關鍵字發想。
* [計畫範本庫](https://thc1006.github.io/sch001-108platform/autonomous-learning/plan-templates.html)：自主學習計畫的範本。輸入主題，AI 會草擬一份 8 週的計畫。
* [學習資源地圖](https://thc1006.github.io/sch001-108platform/autonomous-learning/resource-map.html)：線上學習資源的清單。輸入學習主題，AI 會排出學習步驟。
* [研究方法工具箱](https://thc1006.github.io/sch001-108platform/autonomous-learning/methodology.html)：文獻探討、問卷調查、訪談、個案研究、內容分析和創作實踐六種方法的做法。

### [學習歷程](https://thc1006.github.io/sch001-108platform/learning-portfolio/)

學習歷程區首頁的 AI 學習歷程健檢依 STAR（情境、任務、行動、結果）檢查你寫的心得。

* [優質範例藝廊](https://thc1006.github.io/sch001-108platform/learning-portfolio/portfolio-gallery.html)：學習歷程檔案的範例與分析。
* [反思引導提問集](https://thc1006.github.io/sch001-108platform/learning-portfolio/reflection-guide.html)：STAR 敘事法的說明和情境式提問，頁面上也有 AI 學習歷程健檢。
* [多元表現資料庫](https://thc1006.github.io/sch001-108platform/learning-portfolio/activity-database.html)：課堂外可以參加的競賽、社會服務、研討會等活動，每一筆附報名狀態和官方連結。
* [線上製作工具箱](https://thc1006.github.io/sch001-108platform/learning-portfolio/tools.html)：簡報排版、心智圖、數據視覺化、筆記寫作、影音剪輯和團隊協作的線上工具。

### [生涯探索](https://thc1006.github.io/sch001-108platform/career-exploration/)

生涯探索區首頁的 AI 學涯導師回答升學和生涯的問題。每次只看當下這一題，不會參考先前的對話。

* [十大學群探索](https://thc1006.github.io/sch001-108platform/career-exploration/clusters/)：工程、資訊、管理、財經、社會與心理、大眾傳播、設計、生命科學、醫藥衛生、法政十個學群。每個學群分六個主題：科系風向標、特質與能力、多元表現亮點策略、自主學習與探究專題方向、常見迷思破解、申請備審與面試要點。
* [學長姐真心話](https://thc1006.github.io/sch001-108platform/career-exploration/senior-interviews.html)：學長姐的升學經驗。人物都用化名，內容綜合升學制度、公開數據和經驗分享寫成。
* [核心素養對照表](https://thc1006.github.io/sch001-108platform/career-exploration/competency-map.html)：108 課綱三面九項素養的說明，可以依學群篩選。貼上活動經驗，AI 會找出其中對應的素養。

### [進階資源](https://thc1006.github.io/sch001-108platform/advanced-resources/)

* [線上課程精選](https://thc1006.github.io/sch001-108platform/advanced-resources/online-courses.html)：Coursera、edX、Khan Academy、freeCodeCamp 等平台上適合高中生的課程。
* [開放教育資源](https://thc1006.github.io/sch001-108platform/advanced-resources/open-education.html)：AI 實驗室、開放科學、開放課程和國際科學社群的免費資源。
* [國內外競賽資訊](https://thc1006.github.io/sch001-108platform/advanced-resources/competitions.html)：高中生可以參加的競賽，標出開放報名和即將截止的項目，可以依領域、地區、級別、形式篩選。
* [主題書單推薦](https://thc1006.github.io/sch001-108platform/advanced-resources/reading-list.html)：十二個主題的書單，附推薦理由。

### [公民科技](https://thc1006.github.io/sch001-108platform/civic-tech-map/)

台灣公民科技專案和 108 課綱核心素養、SDGs 的對照，專案多數來自 g0v 社群。頁面也整理了 g0v Summit、g0v 雙月大松、零時小學校和 SITCON 的參與方式。寫下你的興趣或關心的議題，AI 會推薦可以投入的專案。

[關於我們](https://thc1006.github.io/sch001-108platform/about.html)寫了專案的由來，[網站地圖](https://thc1006.github.io/sch001-108platform/sitemap.html)列出所有頁面。

## 如何貢獻

這是一個開源專案，歡迎任何形式的貢獻：

* **學生** — 分享你的學習經驗，或對網站功能提出建議。
* **開發者 / 設計師** — 透過 GitHub 提交 Pull Request 或 Issue。
* **教育工作者** — 與我們交流，提供更多元的觀點。

請先到 [GitHub Issues](https://github.com/thc1006/sch001-108platform/issues) 看看有沒有可以協助的地方。提交程式碼前，建議先在本機執行 `npm run build` 確認站台可正常建置。程式碼註解的寫法見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 特別感謝

這個專案的成長，要感謝許多人與組織的幫助：

* **g0v 零時小學校** — 讓我們看見只要有心，全世界都會來幫你。
* **林奇葦（「島島阿學」專案）** — 啟發我們向零時小學校提案的前輩。
* **戴賢文老師** — 看見創辦人長才的伯樂。
* **創夢客** — 在地的協力組織。
* 以及所有參與過工作坊、訪談並給予回饋的學生與老師們。

## 授權

[MIT License](LICENSE)

聯絡信箱：`hctsai@linux.com`
