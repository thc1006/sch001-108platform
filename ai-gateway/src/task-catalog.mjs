// 正式上線的任務清單，格式見 tasks.mjs 的 defineTask。

/**
 * CAREER_CLUSTERS 是 career-chat 的參考資料：生涯探索首頁 majorData 裡的六個欄位，抄自頁面
 * （閘道的映像檔裡沒有那個檔案）。兩邊是否一致由 test/task-catalog.test.mjs 檢查。
 * 核心素養和重要學科分成兩欄、欄名寫明哪一個是素養、哪一個是學科：只有核心素養時，模型拿它推論數學重不重要；
 * 拿掉核心素養時，問「某學群重視哪些核心素養」答不出來。
 */
const CAREER_CLUSTERS = [
    { name: '工程學群', description: '結合基礎科學和工程技術，分成電機電子、機械工程、土木工程、化學工程、材料工程等領域。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], subjects: ['數學', '英語文', '物理', '資訊科技', '國語文', '化學'], majors: ['電機工程', '電子工程', '資訊工程', '機械工程', '土木工程', '化學工程', '材料工程', '生醫工程'], careers: ['半導體工程師', '電機或電子工程師', '機械工程師', '土木或結構技師', '廠務工程師'] },
    { name: '資訊學群', description: '學電腦軟硬體結構、作業系統原理和程式設計，也學資訊系統的規劃管理、資訊安全等。', competencies: ['科技資訊與媒體素養', '系統思考與解決問題'], subjects: ['數學', '資訊科技', '英語文', '國語文', '物理', '生活科技'], majors: ['資訊工程', '資訊管理', '電機工程', '電子工程', '通訊工程', '資訊傳播', '生物資訊', '數據統計'], careers: ['軟體工程師', '資料分析師', 'AI 工程師', '資安工程師'] },
    { name: '管理學群', description: '學溝通協調、領導規劃、系統分析、資源整合等，用來處理組織內外的人、事、物問題。', competencies: ['系統思考與解決問題', '人際關係與團隊合作'], subjects: ['英語文', '國語文', '數學', '資訊科技', '公民與社會', '生涯規劃'], majors: ['企業管理', '資訊管理', '工業管理', '國際企業', '行銷經營', '醫務管理', '觀光事業', '餐旅管理'], careers: ['專案經理', '行銷企劃', '人力資源', '管理顧問'] },
    { name: '財經學群', description: '探究金融體系怎麼運作，以經濟、財務金融、會計、保險學類為重心，課程包括資本市場、證券投資、資產管理等。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], subjects: ['英語文', '數學', '國語文', '公民與社會', '資訊科技', '生涯規劃'], majors: ['會計', '財務金融', '經濟', '國際企業', '財稅', '保險'], careers: ['銀行行員', '證券分析師', '會計師', '理財專員'] },
    { name: '社會與心理學群', description: '觀察分析社會結構與社會現象，探討個人的心理歷程，也學助人專業。', competencies: ['人際關係與團隊合作', '系統思考與解決問題'], subjects: ['國語文', '公民與社會', '英語文', '生命教育', '數學', '生涯規劃'], majors: ['心理', '社會學', '社會工作', '輔導諮商', '犯罪防治', '兒童與家庭', '人類學、民族學'], careers: ['臨床或諮商心理師（要讀研究所再考證照）', '社工師', '人力資源', '市場調查'] },
    { name: '大眾傳播學群', description: '學傳播理論，也學採訪編輯、公關、媒體製作等，把訊息用聲音、文字、影像等方式傳給大眾。', competencies: ['科技資訊與媒體素養', '人際關係與團隊合作'], subjects: ['國語文', '英語文', '公民與社會', '資訊科技', '藝術生活', '美術'], majors: ['新聞', '大眾傳播', '廣電電影', '廣告公關', '資訊傳播'], careers: ['記者', '影視導演或製作人', '廣告文案', '公關', '社群小編'] },
    { name: '設計學群', description: '學建築、空間設計、商業設計、藝術設計、工業設計、媒體設計等，讓物品和環境兼顧實用與美感。', competencies: ['藝術涵養與美感素養', '系統思考與解決問題'], subjects: ['美術', '藝術生活', '國語文', '英語文', '資訊科技', '歷史'], majors: ['建築', '空間設計', '都市計畫', '工業設計', '商業設計', '媒體設計', '服裝設計', '工藝'], careers: ['平面設計師', 'UI/UX 設計師', '建築師', '室內設計師', '產品設計師'] },
    { name: '生命科學學群', description: '探究生命現象，包括遺傳、演化、生物的構造與功能，以及細胞和分子層次的機制等。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], subjects: ['生物', '化學', '英語文', '數學', '國語文', '物理'], majors: ['生命科學', '生物科技', '生化', '生態', '生物資訊', '生醫工程', '食品生技', '植物保護'], careers: ['生技或製藥公司研發（多半要讀研究所）', '研究助理', '品管或檢驗人員', '農業或食品技術人員'] },
    { name: '醫藥衛生學群', description: '學維護身心健康的知識與技術，包括疾病和傷害的預防與治療，對象從個人到整個人群。', competencies: ['系統思考與解決問題', '人際關係與團隊合作'], subjects: ['生物', '英語文', '國語文', '健康與護理', '化學', '數學'], majors: ['醫學', '牙醫', '藥學', '護理', '物理治療', '職能治療', '醫學檢驗', '公共衛生'], careers: ['醫師', '牙醫師', '藥師', '護理師', '物理治療師', '醫事檢驗師'] },
    { name: '法政學群', description: '探究法律與政治制度，法律課程包括憲法、刑法、民事和刑事訴訟等，政治課程包括政府行政、國際政治等。', competencies: ['系統思考與解決問題', '道德實踐與公民意識'], subjects: ['公民與社會', '國語文', '英語文', '歷史', '數學', '生涯規劃'], majors: ['法律', '財經法律', '政治', '行政管理', '犯罪防治', '土地資產'], careers: ['律師或司法官（法官或檢察官）', '企業法務', '公務人員', '企劃或公關', '觀護人或監獄官', '地政士或不動產估價師'] },
];

/**
 * COLLEGO_OTHERS 是 ColleGo! 18 個學群裡 CAREER_CLUSTERS 沒有的 8 個和它們的主要學類（不含「跨學類」），
 * 照各學群介紹頁的標題與主要學類（2026-11-10 查）。放進指令時扣掉 CAREER_CLUSTERS 已有的科系：
 * 藝術學群列了服裝設計時，模型會說本站的設計學群沒有服裝設計。
 */
const COLLEGO_OTHERS = [
    ['數理化', ['數學', '化學', '物理', '自然科學', '生化', '數學教育', '數據統計']],
    ['地球環境', ['工程科學', '水利工程', '環境工程', '地球科學', '地理', '海洋科學', '大氣科學', '營建安全', '史地']],
    ['生物資源', ['獸醫', '植物保護', '生態', '農藝', '動物科學', '園藝', '森林', '海洋資源', '食品生技']],
    ['藝術', ['工業設計', '工藝', '商業設計', '服裝設計', '美術', '音樂', '表演藝術', '藝術設計', '舞蹈']],
    ['外語', ['英語文', '歐語文', '日語文', '東方語文', '英語教育']],
    ['文史哲', ['圖書資訊', '宗教', '文化產業', '中國語文', '歷史', '哲學', '台灣語文', '史地', '華語文教育']],
    ['教育', ['數位學習', '科技教育', '數學教育', '英語教育', '華語文教育', '教育', '特殊教育', '幼兒教育', '成人教育', '社科教育']],
    ['遊憩運動', ['運動保健', '體育', '舞蹈', '觀光事業', '運動管理', '餐旅管理', '休閒管理']],
];
const SITE_MAJORS = new Set(CAREER_CLUSTERS.flatMap((c) => c.majors));

/** STAR_ITEM 是 star-analysis 的 S、T、A、R 四項共用的 schema。 */
const STAR_ITEM = {
    type: 'object',
    properties: {
        comment: { type: 'string', minLength: 1, maxLength: 300 },
        suggestion: { type: 'string', minLength: 1, maxLength: 300 },
    },
    required: ['comment', 'suggestion'],
    additionalProperties: false,
};

/** WEEKS 是 study-plan 的四個週次標籤，weekly_plan 的四項依序各用一個。 */
const WEEKS = ['Week 1-2', 'Week 3-4', 'Week 5-6', 'Week 7-8'];

/**
 * TASK_DEFINITIONS 是正式上線的任務，server.mjs 啟動時交給 createCatalog 逐一檢查。
 * 任務都不設 timeoutMs，沿用 LLM_TASK_TIMEOUT_MS。時限從拿到名額就開始算，要容得下 WinLab 忙時等第一個
 * 位元組的 2 分鐘。xhigh 的思考長度變化很大，2026-10-23 經正式閘道實測，同一題 career-chat 是 40.1 秒和
 * 145.8 秒；思考寫滿一輪、接到第二輪的 civic-tech-suggestion 是 218.9 秒。145.8 秒與 218.9 秒加上 2 分鐘
 * 都超過 QUEUE_TIMEOUT_MS，不超過它的時限會切掉正常的請求。
 * 文字任務的 maxOutputChars 是指令寫的字數上限的 4 倍。competency-analysis 的指令沒寫字數，2026-10-23 經
 * 正式閘道的 8 次回答是 188～232 字，最長 232 字的 4 倍約 930，取 1000。
 */
export const TASK_DEFINITIONS = [
    {
        // 自主學習首頁的「AI 學習啟動包」（src/pages/autonomous-learning/index.astro）。
        // 指令寫明長度（探索問題一句話、資源類型只寫簡短名稱）：schema 的 maxLength 是硬截斷，
        // 沒說長度時模型把資源類型寫成長篇說明，被切在 50 字（WinLab 實測），學生看到半句話；
        // maxLength 只當保險。資源類型的例子會被照抄，例子只放高中生不用花錢就找得到的。
        id: 'starter-pack',
        input: {
            topic: { label: '初步想法', maxLength: 200 },
        },
        instructions: [
            '請為一位想自主學習的學生，依他的「初步想法」寫一份「學習啟動包」：',
            '- suggested_topic：將學生的模糊想法，聚焦為一個更具體的研究主題',
            '- research_questions：提供 3 個可以引導初步探索的開放式問題，每個問題一句話',
            '- resource_types：建議 3 種適合這個主題、高中生不用花錢就找得到的學習資源類型，每種只寫簡短的資源類型名稱（約 2～12 字），不要加說明，例如：圖書館的書、知識型影片、政府開放資料、訪談身邊的人等',
        ].join('\n'),
        output: {
            type: 'json',
            schema: {
                type: 'object',
                properties: {
                    suggested_topic: { type: 'string', minLength: 1, maxLength: 200 },
                    research_questions: {
                        type: 'array',
                        minItems: 3,
                        maxItems: 3,
                        items: { type: 'string', minLength: 1, maxLength: 300 },
                    },
                    resource_types: {
                        type: 'array',
                        minItems: 3,
                        maxItems: 3,
                        items: { type: 'string', minLength: 1, maxLength: 50 },
                    },
                },
                required: ['suggested_topic', 'research_questions', 'resource_types'],
                additionalProperties: false,
            },
        },
    },
    {
        // 生涯探索 › 核心素養對照表的「AI 對照核心素養」（src/pages/career-exploration/competency-map.astro）。
        // 指令列出九項素養的代號與名稱：只給代號的話，名稱得靠模型自己記，記錯就誤導學生。
        // 名稱抄自 scripts/taxonomy.json，因為閘道的映像檔裡沒有那個檔案；test/task-catalog.test.mjs 比對兩邊。
        // 開頭的角色設定留著：2026-11-05 WinLab 實測，拿掉之後 reasoning tokens 平均多了約四成。
        id: 'competency-analysis',
        input: {
            experience: { label: '活動經驗', maxLength: 1000 },
        },
        temperature: 0.5,
        instructions: [
            '你是一位專業的 108 課綱學習歷程顧問。請根據學生描述的「活動經驗」，分析其中最能體現的 2～3 項核心素養，',
            '並針對每項素養提供一句精簡的寫作建議，說明在學習歷程中怎麼呈現這項素養。',
            '用「- 」開頭的清單回傳，每項素養一項：先寫代號與名稱，接著寫建議，不用粗體。',
            '核心素養只能從這九項中選擇：A1 身心素質與自我精進、A2 系統思考與解決問題、',
            'A3 規劃執行與創新應變、B1 符號運用與溝通表達、B2 科技資訊與媒體素養、B3 藝術涵養與美感素養、',
            'C1 道德實踐與公民意識、C2 人際關係與團隊合作、C3 多元文化與國際理解。',
        ].join('\n'),
        output: { type: 'markdown' },
        // 指令沒寫字數，依據見 TASK_DEFINITIONS 的說明
        maxOutputChars: 1000,
    },
    {
        // 生涯探索首頁的「AI 推薦學群」（src/pages/career-exploration/index.astro）。畫面像聊天，
        // 但每次只送這一題，不帶先前的對話。
        id: 'career-chat',
        input: {
            question: { label: '問題', maxLength: 200 },
        },
        instructions: [
            '請回答學生的「問題」。',
            '請依據以下台灣的大學學群資料作為你回答的主要參考依據：',
            '---',
            CAREER_CLUSTERS.map((c) => [
                `學群：${c.name}`,
                `簡介：${c.description}`,
                `重視的核心素養（前兩名）：${c.competencies.join('、')}`,
                `重要學科（高中科目，依重要程度）：${c.subjects.join('、')}`,
                `科系：${c.majors.join('、')}`,
                `出路：${c.careers.join('、')}`,
            ].join('\n')).join('\n\n'),
            '---',
            // 沒有條件時，問讀書方法、自主學習、學習歷程和閒聊也被推薦學群（2026-11-09 WinLab 實測，兩輪各 21 次全都是）
            '學生問的是興趣、科系或學群時，你的回答應該包含：',
            '1. 根據學生的興趣，推薦 1～2 個最相關的學群。',
            '2. 簡單說明為什麼推薦這些學群。',
            '3. 給予一個具體的下一步探索建議。',
            // 「住鄉下沒錢補習，能讀什麼」同時符合問科系、說不出興趣、沒錢三條，所以沒錢那條寫明其餘照上面
            // （2026-11-10 實測有一次舉了 4 個學群）。test 會檢查這幾行的先後。
            '學生問不擅長某一科、想知道可以念哪些科系時，先回答他問的事，再從上面的學群舉 2 個當起點。',
            // 選組的說明原本和上一句寫在同一行，問數學不好時也被套用，寫成分科測驗會考到美術、藝術生活（2026-11-11 實測）
            '學生問要選自然組還是社會組時，先回答他問的事，再從上面的學群兩個方向各舉 1 個。選組的差別在高二、高三的加深加廣選修，分科測驗會考到這些選修，所以會影響準備得了哪幾科；報名時考科由自己選，可以查有興趣的科系採計哪些科目。',
            '某一科重不重要看上面的「重要學科」；會不會影響入學，請學生查校系分則。',
            '學生問某個學群重視哪些核心素養時，照上面的「重視的核心素養」回答，各用一句話說明在這個學群會用在哪裡，也可以請他到本頁大學科系羅盤的「核心素養」分頁看。',
            '學生說不出興趣時，用「如果你常…，可以先看…學群」舉 2 個方向不同（例如動手做、和人或文字打交道）的學群當起點，或請他把線索寫進問題框再送一次。',
            '問題提到沒錢、住得遠這類限制時，第一句先回應，下一步要不用花錢；其餘照上面的規則，學群最多 2 個。',
            '推薦或舉出上面的學群時，可以請他到本站的「十大學群探索」看那個學群的介紹。',
            // 沒列出名稱時，模型會自己編出「人文學群」「法學學群」；寫「這裡只有幾個學群」時常把資料裡的學群唸一遍；
            // 只寫「說出常見的科系」時會編出「劇場音樂」這類查不到的科系（2026-11-09～10 WinLab 實測）
            'ColleGo! 列了 18 個學群，上面沒有的 8 個學群和它們不在上面的學類是：',
            ...COLLEGO_OTHERS.map(([name, majors]) => `${name}學群：${majors.filter((m) => !SITE_MAJORS.has(m)).join('、')}`),
            '學生的興趣只對到這 8 個學群、上面的學群沒有相關科系時，說本站沒有它的資料，可以說出它的學類，再請他到 ColleGo! 看那個學群。',
            // 師資培育法第 11 條：學士學位、修畢師資職前教育課程、通過教師資格考試、教育實習及格，才發給教師證書
            '學生想當中小學或幼兒園老師時，說明讀想教科目的學系或師資培育學系（ColleGo! 的教育學群）都可以，要修教育學程（師資職前教育課程）、通過教師資格考試、完成教育實習，才拿得到教師證書。',
            // 號碼照衛福部「諮詢服務專線」頁（安心專線 1925，24 小時）與消防署報案頁（119），2026-11-11 查。不寫號碼時，模型會自己寫，
            // 寫過查不到的「校園安心專線 1132」；擁有者決定寫入查證過的號碼。
            '學生提到想傷害自己、不想活、想消失，或說活著好累時，第一句先回應他的感受，請他現在就告訴身邊信任的大人、導師或輔導室；也可以打衛福部安心專線 1925（24 小時），有立即危險時撥 119。這種回答不提學群。',
            '學生說很累、壓力大或心情低落，但沒有提到上面這些時，回答最後加一句「如果一直這樣，可以找導師或輔導室聊聊」。',
            '其他問題（包括某一科怎麼讀書）先回答他問的事，再給一個具體的下一步，不提學群。',
            '回答請簡潔，總長度不要超過 200 字。',
            '學生每次只送一個問題，你看不到之前的對話，之後也看不到這次的回答。',
            '下一步建議要是學生自己就能完成的事，不要用「下次」「再跟我說」這類需要接續對話的說法。',
            // 學生問到才用：2026-11-05 WinLab 實測，寫「提到校系規定時」的話，常識題 8 次裡有 2 次也叫學生查校系分則。
            '學生問到某個校系的規定時，請他查那個校系的網頁，或大學甄選入學委員會（繁星推薦、申請入學）、大學考試入學分發委員會（分發入學）的校系分則。',
        ].join('\n'),
        output: { type: 'markdown' },
        maxOutputChars: 800,
    },
    {
        // 學習歷程首頁（src/pages/learning-portfolio/index.astro）與反思引導提問集
        // （reflection-guide.astro）共用的「AI 學習歷程健檢」。
        // analysis 以 S、T、A、R 為鍵：閘道的 schema 子集沒有 prefixItems，用陣列保證不了四項剛好各一。
        // maxLength 是硬截斷（見 tasks.mjs），長度要求寫在指令裡。
        // 學生會照抄修改範例。2026-11-01～11-11 WinLab 實測，它會編心得裡沒有的做法與成果、把「我」「我們」互換、
        // 照抄括號的例子、把寫範例的規則寫進 suggestion，只用心得裡的事時又會幾乎照抄原文，所以有下面這些規則。
        // 只把做法和誰做的加進「不要自己編」時，2026-11-08 WinLab 實測括號從每份 2 處變成 4 處，所以誰做的另寫一句，括號最多兩處。
        // 開頭的角色設定留著：2026-11-05 WinLab 實測，拿掉之後 reasoning tokens 平均從約 3800 變成約 6800 到 8900。
        id: 'star-analysis',
        input: {
            reflection: { label: '心得反思', maxLength: 2000 },
        },
        instructions: [
            '你是一位專業的學習歷程檔案顧問。請根據 STAR 原則（Situation 情境、Task 任務、Action 行動、Result 結果），分析這位高中生寫的「心得反思」：',
            '- overall_comment：一段簡短的總評，約 50～150 字',
            '- analysis：S、T、A、R 四個項目各寫一則 comment（針對該項目的評論，點出優點或缺失）與 suggestion（具體的修改建議），各一到兩句。suggestion 直接寫要補什麼、怎麼改，不提括號和修改範例的寫法',
            '- revised_example：一小段修改後的文字範例，約 100～300 字，只用心得裡寫到的事，照情境、任務、行動、結果的順序重寫；心得沒寫任務時，用心得看得出來的事寫一句任務。心得寫「我」就寫「我」，寫「我們」或沒寫是誰做的，不要改成「我」，也不要加上心得裡沒有的人。心得裡沒有的做法、人數、時間、名次與成果不要自己編。心得只說做了某件事、沒說怎麼做的地方，可以在那一句裡用括號標出要補的內容，括號裡先寫「填入」，再寫要補的是哪件事；最多兩處，不放在同一句，沒有這種地方就不用括號。其他沒寫的就不寫',
        ].join('\n'),
        output: {
            type: 'json',
            schema: {
                type: 'object',
                properties: {
                    overall_comment: { type: 'string', minLength: 1, maxLength: 400 },
                    analysis: {
                        type: 'object',
                        properties: { S: STAR_ITEM, T: STAR_ITEM, A: STAR_ITEM, R: STAR_ITEM },
                        required: ['S', 'T', 'A', 'R'],
                        additionalProperties: false,
                    },
                    revised_example: { type: 'string', minLength: 1, maxLength: 1000 },
                },
                required: ['overall_comment', 'analysis', 'revised_example'],
                additionalProperties: false,
            },
        },
    },
    {
        // 自主學習 › 計畫範本庫的「AI 草擬學習計畫」（src/pages/autonomous-learning/plan-templates.astro）。
        // 頁面只送主題，計畫固定 8 週，和頁面上的範本相同。week 只能是四個標籤之一，模型寫不出
        // Week 3-5 這種週次；items 只能是單一 schema，表達不了標籤的順序，由 output.check 檢查。
        // 頁面不知道學生住哪裡、手邊有什麼，所以有最後一行。2026-11-09、11-10 在 qwen3.8-flash-next 上實測：
        // 寫「住家附近」「每週」會被照抄；要每份都寫網路替代時，水溝沒有了試紙和現場觀察；只寫不用花錢時，
        // 水彩改在報紙上練。方法不寫頻率，就不會有方法寫每週、週次只排一段的情形。
        id: 'study-plan',
        input: {
            topic: { label: '自主學習主題', maxLength: 100 },
        },
        instructions: [
            '請依學生的「自主學習主題」，設計一份為期 8 週的自主學習計畫大綱：',
            '- learning_objectives：3 個學習目標，每個目標一句話，約 15～40 字',
            '- execution_methods：2～3 個執行方法，每個方法一句話，寫出具體要做什麼，約 15～50 字',
            '- weekly_plan：把 8 週分成 4 個階段，每個階段兩週，week 依序寫 Week 1-2、Week 3-4、Week 5-6、Week 7-8；tasks 寫這兩週要完成的具體任務，一到兩句，約 20～60 字',
            '- expected_outcome：2～3 個預期產出，每個寫出具體的成品或成果，約 10～40 字',
            '做法要讓手邊資源少的學生也做得到：主題本身少不了的用品照常寫，其他用家裡或學校借得到的東西，學生不用另外花錢；只有特定店家、機構才看得到的，寫出改用網路資料的做法。用高中生看得懂的白話，用到專業名詞時順便用幾個字說明。execution_methods 不寫頻率，要重複做的事和次數寫在 weekly_plan 裡。',
        ].join('\n'),
        output: {
            type: 'json',
            schema: {
                type: 'object',
                properties: {
                    learning_objectives: {
                        type: 'array',
                        minItems: 3,
                        maxItems: 3,
                        items: { type: 'string', minLength: 1, maxLength: 120 },
                    },
                    execution_methods: {
                        type: 'array',
                        minItems: 2,
                        maxItems: 3,
                        items: { type: 'string', minLength: 1, maxLength: 150 },
                    },
                    weekly_plan: {
                        type: 'array',
                        minItems: 4,
                        maxItems: 4,
                        items: {
                            type: 'object',
                            properties: {
                                week: { type: 'string', enum: WEEKS },
                                tasks: { type: 'string', minLength: 1, maxLength: 200 },
                            },
                            required: ['week', 'tasks'],
                            additionalProperties: false,
                        },
                    },
                    expected_outcome: {
                        type: 'array',
                        minItems: 2,
                        maxItems: 3,
                        items: { type: 'string', minLength: 1, maxLength: 120 },
                    },
                },
                required: ['learning_objectives', 'execution_methods', 'weekly_plan', 'expected_outcome'],
                additionalProperties: false,
            },
            // 重複或亂序就整份重寫，不替它改標籤：寫給前兩週的任務，改了標籤也不會變成後面幾週的計畫
            check: ({ weekly_plan: plan }) => {
                const at = plan.findIndex((item, i) => item.week !== WEEKS[i]);
                return at === -1 ? null : `$.weekly_plan[${at}].week 應為 ${WEEKS[at]}`;
            },
        },
    },
    {
        // 公民科技地圖的「AI 探索建議」（src/pages/civic-tech-map/index.astro）。
        // 專案名稱用頁面卡片上的 title，名稱、簡介與狀態都照 public/civic-tech-map/projects.json 寫
        // （閘道的映像檔裡沒有那個檔案），test/task-catalog.test.mjs 比對名稱、簡介與狀態。不是 active 的
        // 專案寫明狀態，模型才不會把連不上的網站或已經結束的計畫當成現行的專案推薦。
        // 「寧可少推薦」與「推薦 3 個時寫得更精簡」兩句：2026-10 WinLab 實測少了它們，興趣不相關時
        // 也硬湊 3 個，推薦 3 個時常超過 400 字。改寫成「每個約 100 字」的話，思考的 tokens 多了好幾倍，
        // 一次要兩分多鐘。
        // 開頭的角色設定留著：2026-11-05 WinLab 實測，拿掉之後 reasoning tokens 平均多了約四成。
        id: 'civic-tech-suggestion',
        input: {
            interest: { label: '興趣或關心的議題', maxLength: 300 },
        },
        instructions: [
            '你是「台灣教育處方籤」平台的 AI 探索助手，正在協助一位台灣高中生找到適合的公民科技專案作為自主學習主題。',
            '以下是台灣的公民科技專案：',
            '1. Disfactory 農地違章工廠回報系統：民眾拍照回報農地上新增的工廠，地球公民基金會整理後向政府檢舉，並追蹤拆除進度；也可以比對空拍影像，找出 2016 年以後新增的建物。相關領域：地理、GIS 地理資訊系統、公民與社會、環境科學',
            '2. Cofacts 真的假的：把可疑訊息轉傳給 LINE 機器人，資料庫裡有人查過的話會回覆查核內容；回應是使用者寫的，任何人都可以加入查證。相關領域：資訊科技、媒體識讀、公民與社會、數據分析',
            '3. 阿美語萌典：線上阿美語辭典，查一個詞會列出各部辭典的解釋和例句，另有五種阿美語的學習詞表。相關領域：語言學、文化保存、資訊科技、多元文化',
            '4. 透明足跡：把環境部公開的工廠排放監測和環保裁罰紀錄整理成地圖與查詢頁；手機 App「掃了再買」掃商品條碼，就看得到製造商的違規紀錄。相關領域：化學、環境科學、經濟學、消費者權益',
            '5. 國家寶藏：志工到美國國家檔案館翻拍和台灣有關的檔案（1887 年到 1970 年代末），放上網站讓大家閱讀、搜尋、校正。組團的實地翻拍從 2020 年起暫停。相關領域：歷史、英文、數位典藏、國際關係',
            '6. LawTrace 立法足跡：把立法院各網站的法案資料放在一起，看得到一部法律歷次修正的條文，以及一讀、二讀、三讀、審查會、公聽會的過程。相關領域：公民與社會、法律、資訊科技、開放資料',
            '7. vTaiwan：公共政策的開放討論平台，議題列表依進度標示意見徵集、研擬草案或送交院會，近年討論過 AI 的風險評估和社群平台的言論審查。相關領域：公民與社會、審議民主、資訊科技、AI 治理',
            '8. 民生公共物聯網：整合空氣品質、水資源、地震、災防的感測資料。目前維護中：計畫已在 2025 年 12 月 31 日結束，原平台已經連不上，公告資料服務提供到 2026 年 12 月 1 日。相關領域：自然科學、地球科學、資訊科技、資料分析',
            '請依學生的「興趣或關心的議題」推薦 1 至 3 個最適合的專案。每個推薦以「### 專案名稱」開頭，下面寫一段話：',
            '先用 2～3 句說明為什麼適合，再用 1～2 句寫具體的自主學習方向，不要加「推薦原因」「探索建議」這類標籤。',
            '如果「興趣或關心的議題」與所有專案都不太相關，也請誠實說明，並嘗試找出最接近的連結點；',
            '寧可少推薦幾個，也不要牽強附會。',
            '回答請簡潔，不要超過 400 字；推薦 3 個專案時，每個推薦都要寫得更精簡。',
        ].join('\n'),
        output: { type: 'markdown' },
        maxOutputChars: 1600,
    },
    {
        // 自主學習 › 學習資源地圖的「AI 規劃學習路徑」（src/pages/autonomous-learning/resource-map.astro）。
        // 步驟編號由頁面依陣列順序給，不讓模型寫：schema 管不住編號是否連續。
        // resource_type 先列出頁面「資源類型」篩選的類型，名稱和頁面一致，test/task-catalog.test.mjs 比對。
        id: 'learning-path',
        input: {
            topic: { label: '學習主題', maxLength: 100 },
        },
        instructions: [
            '請為一位想自主學習的台灣高中生，依他的「學習主題」規劃一份剛好 4 個步驟的學習路徑（learning_path），步驟依學習的先後順序排列。每個步驟包含：',
            '- title：步驟標題，約 4～15 字',
            '- description：步驟描述，說明這一步要學什麼，一到兩句，約 30～80 字',
            '- resource_type：建議的資源類型，只寫簡短的類型名稱（約 2～10 字），不要加說明。寫學生可以找來用的資源：線上課程、知識型影片、知識型 Podcast、閱讀材料、互動模擬實驗、數位博物館與典藏，或更具體的名稱，例如圖鑑、工具書；不要寫練習或活動',
            '- actionable_suggestion：一個具體的行動建議，並附上相關的搜尋關鍵字，一到兩句，約 30～100 字',
        ].join('\n'),
        output: {
            type: 'json',
            schema: {
                type: 'object',
                properties: {
                    learning_path: {
                        type: 'array',
                        minItems: 4,
                        maxItems: 4,
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string', minLength: 1, maxLength: 50 },
                                description: { type: 'string', minLength: 1, maxLength: 300 },
                                resource_type: { type: 'string', minLength: 1, maxLength: 30 },
                                actionable_suggestion: { type: 'string', minLength: 1, maxLength: 300 },
                            },
                            required: ['title', 'description', 'resource_type', 'actionable_suggestion'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['learning_path'],
                additionalProperties: false,
            },
        },
    },
    {
        // 自主學習 › 選題靈感頁（src/pages/autonomous-learning/topic-ideas.astro）的「AI 個人化發想」。
        // 研究方法與關鍵字在頁面上顯示成小標籤，只放短詞。
        // 各欄的長度寫在指令裡，maxLength 只當保險，理由見 tasks.mjs 檔頭。
        // 開頭的角色設定留著：2026-11-05 在 qwen3.8-27b-fp8 上實測，拿掉之後 reasoning tokens 的中位數多了約兩成、平均多了約一成；
        // 換回之後中位數和 main 差不多，平均比 main 少。兩種寫法最長的一次 completion tokens 約 7400 和 7900，都接近 max_tokens。
        // challenges 要寫怎麼處理：2026-11-09 在 qwen3.8-flash-next 上 6 組興趣各跑 5 次，completion tokens 中位數
        // 1577 → 1623，最多 1737。
        id: 'topic-ideas',
        input: {
            interests: { label: '興趣關鍵字', maxLength: 100 },
        },
        instructions: [
            '你是一位專業的台灣高中教育顧問，專長是引導學生進行自主學習。請根據學生提供的「興趣關鍵字」，為他發想 3 個具體、高中生做得到的跨領域自主學習主題，放在 ideas 裡。每個主題包含：',
            '- title：主題名稱，約 10～25 字',
            '- description：簡短描述，約 50～120 字',
            '- methods：建議研究方法 2～4 種，每種只寫簡短的方法名稱（約 2～12 字），不要加說明',
            '- challenges：潛在挑戰 2～3 個，每個一句話，寫出挑戰和可以怎麼處理（約 15～60 字）',
            '- keywords：相關關鍵字 3～5 個，每個只寫一個簡短的詞（約 2～10 字）',
        ].join('\n'),
        output: {
            type: 'json',
            schema: {
                type: 'object',
                properties: {
                    ideas: {
                        type: 'array',
                        minItems: 3,
                        maxItems: 3,
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string', minLength: 1, maxLength: 80 },
                                description: { type: 'string', minLength: 1, maxLength: 300 },
                                methods: {
                                    type: 'array',
                                    minItems: 2,
                                    maxItems: 4,
                                    items: { type: 'string', minLength: 1, maxLength: 50 },
                                },
                                challenges: {
                                    type: 'array',
                                    minItems: 2,
                                    maxItems: 3,
                                    items: { type: 'string', minLength: 1, maxLength: 150 },
                                },
                                keywords: {
                                    type: 'array',
                                    minItems: 3,
                                    maxItems: 5,
                                    items: { type: 'string', minLength: 1, maxLength: 50 },
                                },
                            },
                            required: ['title', 'description', 'methods', 'challenges', 'keywords'],
                            additionalProperties: false,
                        },
                    },
                },
                required: ['ideas'],
                additionalProperties: false,
            },
        },
    },
];
