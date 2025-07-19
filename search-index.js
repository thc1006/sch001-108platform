/**
 * =================================================================================
 * 台灣教育處方籤 - 全站搜尋索引檔 (Search Index)
 * =================================================================================
 *
 * 說明：
 * 這個檔案包含了網站上所有可被搜尋的資源。
 * 每一筆資料都是一個 JavaScript 物件，包含以下欄位：
 *
 * - id: 唯一識別碼，方便未來維護。
 * - category: 資源的中文分類，用於在搜尋結果中顯示。
 * - title: 資源的標題，是搜尋權重最高的欄位。
 * - content: 資源的簡短描述或摘要。
 * - tags: 一組關鍵字陣列，用於強化搜尋的廣度與深度。
 * - url: 點擊搜尋結果後要前往的頁面連結。
 *
 * 維護建議：
 * 當網站新增或修改內容時，請記得同步更新此檔案中的對應條目，以確保搜尋結果的準確性。
 *
 */

const searchData = [
  //================================================
  // 1. 學長姐真心話 (Career Exploration)
  // 檔案來源: career-exploration/senior-interviews.html
  //================================================
  {
    "id": "interview-wu-yi-hua",
    "category": "學長姐真心話",
    "title": "吳宜樺 (臺灣大學 生物產業傳播暨發展學系)",
    "content": "從傳播、行銷、設計到教育，生傳系是個跨領域的學系。學習歷程的重點在於呈現你的特質，以及你與這個科系的連結。",
    "tags": ["學長姐真心話", "吳宜樺", "台大", "臺灣大學", "生物產業傳播暨發展學系", "生傳系", "農學院", "文組", "跨領域", "行銷", "設計", "教育", "學習歷程"],
    "url": "/sch001-108platform/career-exploration/senior-interviews.html#info-01"
  },
  {
    "id": "interview-wu-en-en",
    "category": "學長姐真心話",
    "title": "吳恩恩 (臺灣大學 資訊工程學系)",
    "content": "學習歷程的重點不是「做了什麼」，而是從中「學到什麼」。資工系看重的是你的學習能力、對資訊領域的熱情與潛力。",
    "tags": ["學長姐真心話", "吳恩恩", "台大", "臺灣大學", "資訊工程學系", "資工系", "CS", "程式設計", "Python", "Discord Bot", "學習歷C程", "二類", "電資學群"],
    "url": "/sch001-108platform/career-exploration/senior-interviews.html#info-02"
  },
  {
    "id": "interview-yu-hui-yu",
    "category": "學長姐真心話",
    "title": "游惠瑜 (清華大學 竹師教育學院學士班)",
    "content": "特殊選才著重的是「獨特性」與「專一性」。你需要找到自己真正熱愛且專精的領域，並透過學習歷程完整地展現出來。",
    "tags": ["學長姐真心話", "游惠瑜", "清大", "清華大學", "竹師教育學院", "教育", "特殊選才", "師資培育", "學習歷程", "教育學群"],
    "url": "/sch001-108platform/career-exploration/senior-interviews.html#info-03"
  },
  {
    "id": "interview-tsai-hsiu-chi",
    "category": "學長姐真心話",
    "title": "蔡秀吉 (屏東大學 科學傳播學系)",
    "content": "從農家子弟到科學傳播，關鍵在於找到自己的興趣並勇敢嘗試。學習歷程是展現你探索過程的最好機會。",
    "tags": ["學長姐真心話", "蔡秀吉", "屏東大學", "屏大", "科學傳播學系", "科學傳播", "科普", "設計", "在地連結", "學習歷程"],
    "url": "/sch001-108platform/career-exploration/senior-interviews.html#info-04"
  },

  //================================================
  // 2. 自主學習 (Autonomous Learning)
  // 檔案來源: autonomous-learning/*.html
  //================================================
  {
    "id": "plan-template-discord-bot",
    "category": "計畫範本",
    "title": "用 Python 打造一個 Discord 訂便當機器人",
    "content": "學習目標是掌握 Python 基礎語法與 API 串接，並透過實作一個實用的 Discord Bot 來驗證學習成果。",
    "tags": ["自主學習", "計畫範本", "資訊科技", "專案導向", "Python", "API", "Discord", "程式設計", "機器人"],
    "url": "/sch001-108platform/autonomous-learning/plan-templates.html"
  },
  {
    "id": "plan-template-social-survey",
    "category": "計畫範本",
    "title": "探討Z世代的迷因識讀能力—以屏東地區高中生為例",
    "content": "本研究旨在探討屏東地區高中生的迷因使用習慣與識讀能力，採用問卷調查法與訪談法進行研究。",
    "tags": ["自主學習", "計畫範本", "社會科學", "議題探究", "研究報告", "問卷調查", "訪談法", "迷因", "媒體識讀", "Z世代"],
    "url": "/sch001-108platform/autonomous-learning/plan-templates.html"
  },
  {
    "id": "topic-idea-cat-stray",
    "category": "主題點子",
    "title": "校園流浪貓是不是一個問題？",
    "content": "從生態、管理、生命教育等多個角度，探討校園流浪貓議題，並提出具體的解決方案。",
    "tags": ["自主學習", "主題點子", "社會議題", "生命教育", "生態", "流浪動物", "校園觀察"],
    "url": "/sch001-108platform/autonomous-learning/topic-ideas.html"
  },
  {
    "id": "topic-idea-hand-shaken-drinks",
    "category": "主題點子",
    "title": "為什麼台灣人這麼愛喝手搖飲？",
    "content": "從文化、經濟、健康等面向，分析台灣獨特的手搖飲文化，並可以結合地理資訊系統(GIS)進行店家分佈研究。",
    "tags": ["自主學習", "主題點子", "文化觀察", "經濟", "GIS", "手搖飲", "台灣文化"],
    "url": "/sch001-108platform/autonomous-learning/topic-ideas.html"
  },
  {
    "id": "page-methodology",
    "category": "方法論",
    "title": "自主學習研究方法工具箱",
    "content": "介紹各種自主學習常用的研究方法，包含質性研究、量化研究、文獻分析法、訪談法、問卷調查法等。",
    "tags": ["自主學習", "方法論", "研究方法", "質性研究", "量化研究", "文獻分析", "訪談", "問卷"],
    "url": "/sch001-108platform/autonomous-learning/methodology.html"
  },

  //================================================
  // 3. 學習歷程 (Learning Portfolio)
  // 檔案來源: learning-portfolio/*.html
  //================================================
  {
    "id": "gallery-example-01",
    "category": "範例藝廊",
    "title": "從在地到國際：一份社會實踐的學習歷程",
    "content": "這份範例從「動機與目的」出發，詳細記錄了社會實踐的過程，並在最後進行了深刻的「省思與反思」。",
    "tags": ["學習歷程", "範例藝廊", "多元表現", "社會實踐", "在地關懷", "反思"],
    "url": "/sch001-108platform/learning-portfolio/portfolio-gallery.html"
  },
  {
    "id": "tool-canva",
    "category": "工具箱",
    "title": "Canva：線上設計平台",
    "content": "Canva 是一款強大的線上設計工具，內建大量範本，非常適合用來製作學習歷程檔案、簡報、海報等視覺化內容。",
    "tags": ["學習歷程", "工具箱", "設計", "簡報製作", "排版", "Canva", "視覺化"],
    "url": "/sch001-108platform/learning-portfolio/tools.html"
  },
  {
    "id": "tool-google-forms",
    "category": "工具箱",
    "title": "Google 表單：線上問卷調查",
    "content": "Google 表單是進行量化研究、收集意見回饋的絕佳工具，操作簡單且功能完整。",
    "tags": ["學習歷程", "工具箱", "問卷調查", "研究方法", "Google Forms", "數據收集"],
    "url": "/sch001-108platform/learning-portfolio/tools.html"
  },
  {
    "id": "page-reflection-guide",
    "category": "反思",
    "title": "學習歷程反思寫作指南",
    "content": "提供撰寫學習歷程「省思與反思」的具體指引，包含 STAR 原則、反思的層次等實用技巧。",
    "tags": ["學習歷程", "反思", "寫作", "STAR原則", "多元表現", "心得"],
    "url": "/sch001-108platform/learning-portfolio/reflection-guide.html"
  },


  //================================================
  // 4. 進階資源 (Advanced Resources)
  // 檔案來源: advanced-resources/*.html
  //================================================
  {
    "id": "course-cs50x",
    "category": "線上課程",
    "title": "CS50x: Introduction to Computer Science",
    "content": "哈佛大學最受歡迎的計算機科學入門通識課，內容涵蓋 C 語言、Python、SQL、網頁開發等，挑戰性高但收穫滿滿。",
    "tags": ["進階資源", "線上課程", "資訊", "程式設計", "CS", "哈佛大學", "Harvard", "edX", "免費"],
    "url": "/sch001-108platform/advanced-resources/online-courses.html"
  },
  {
    "id": "course-google-da",
    "category": "線上課程",
    "title": "Google Data Analytics Professional Certificate",
    "content": "由 Google 開設的資料分析專業證照課程，教你使用 SQL、R 語言、Tableau 等工具，適合想入門資料科學領域的同學。",
    "tags": ["進階資源", "線上課程", "資訊", "資料科學", "Data", "Google", "Coursera", "SQL", "R", "Tableau"],
    "url": "/sch001-108platform/advanced-resources/online-courses.html"
  },
  {
    "id": "competition-ysf",
    "category": "國內外競賽",
    "title": "臺灣國際科學展覽會 (TISF)",
    "content": "台灣規模最大、最具代表性的高中科學研究競賽，優勝者有機會代表台灣參加國外的科學競賽。",
    "tags": ["進階資源", "競賽", "數理", "自然科學", "科展", "TISF", "研究"],
    "url": "/sch001-108platform/advanced-resources/competitions.html"
  },
  {
    "id": "competition-info-app",
    "category": "國內外競賽",
    "title": "全國高中職資訊應用競賽",
    "content": "專為高中職學生舉辦的資訊競賽，比賽項目包含 App 開發、網頁設計、遊戲製作等，是展現程式實作能力的好機會。",
    "tags": ["進階資源", "競賽", "資訊", "程式設計", "App", "網頁", "遊戲"],
    "url": "/sch001-108platform/advanced-resources/competitions.html"
  },
  {
    "id": "reading-sapiens",
    "category": "主題書單",
    "title": "《人類大歷史：從野獸到扮演上帝》",
    "content": "以色列歷史學家哈拉瑞的巨作，用宏觀的視角講述人類的發展史，能帶給你許多跨學科的啟發。",
    "tags": ["進階資源", "書單", "歷史", "社會科學", "人類學", "哈拉瑞", "Sapiens"],
    "url": "/sch001-108platform/advanced-resources/reading-list.html"
  },
  {
    "id": "reading-atomic-habits",
    "category": "主題書單",
    "title": "《原子習慣》",
    "content": "探討如何建立良好習慣、戒除壞習慣的實用書籍，對於自主學習與個人成長非常有幫助。",
    "tags": ["進階資源", "書單", "自我成長", "心理學", "習慣", "原子習慣", "Atomic Habits"],
    "url": "/sch001-108platform/advanced-resources/reading-list.html"
  }
];
