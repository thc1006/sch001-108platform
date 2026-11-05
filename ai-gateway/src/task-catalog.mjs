// 正式上線的任務清單，格式見 tasks.mjs 的 defineTask。

/**
 * CAREER_CLUSTERS 是 career-chat 的參考資料：生涯探索首頁 majorData 裡的五個欄位，抄自頁面
 * （閘道的映像檔裡沒有那個檔案）。兩邊是否一致由 test/task-catalog.test.mjs 檢查。
 */
const CAREER_CLUSTERS = [
    { name: '工程學群', description: '結合基礎科學和工程技術，分成電機電子、機械工程、土木工程、化學工程、材料工程等領域。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], majors: ['電機工程', '電子工程', '資訊工程', '機械工程', '土木工程', '化學工程', '材料工程', '生醫工程'], careers: ['半導體工程師', '電機或電子工程師', '機械工程師', '土木或結構技師', '廠務工程師'] },
    { name: '資訊學群', description: '學電腦軟硬體結構、作業系統原理和程式設計，也學資訊系統的規劃管理、資訊安全等。', competencies: ['科技資訊與媒體素養', '系統思考與解決問題'], majors: ['資訊工程', '資訊管理', '電機工程', '電子工程', '通訊工程', '資訊傳播', '生物資訊', '數據統計'], careers: ['軟體工程師', '資料分析師', 'AI 工程師', '資安工程師'] },
    { name: '管理學群', description: '學溝通協調、領導規劃、系統分析、資源整合等，用來處理組織內外的人、事、物問題。', competencies: ['系統思考與解決問題', '人際關係與團隊合作'], majors: ['企業管理', '資訊管理', '工業管理', '國際企業', '行銷經營', '醫務管理', '觀光事業', '餐旅管理'], careers: ['專案經理', '行銷企劃', '人力資源', '管理顧問'] },
    { name: '財經學群', description: '探究金融體系怎麼運作，以經濟、財務金融、會計、保險學類為重心，課程包括資本市場、證券投資、資產管理等。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], majors: ['會計', '財務金融', '經濟', '國際企業', '財稅', '保險'], careers: ['銀行行員', '證券分析師', '會計師', '理財專員'] },
    { name: '社會與心理學群', description: '觀察分析社會結構與社會現象，探討個人的心理歷程，也學助人專業。', competencies: ['人際關係與團隊合作', '系統思考與解決問題'], majors: ['心理', '社會學', '社會工作', '輔導諮商', '犯罪防治', '兒童與家庭', '人類學、民族學'], careers: ['臨床或諮商心理師（要讀研究所再考證照）', '社工師', '人力資源', '市場調查'] },
    { name: '大眾傳播學群', description: '學傳播理論，也學採訪編輯、公關、媒體製作等，把訊息用聲音、文字、影像等方式傳給大眾。', competencies: ['科技資訊與媒體素養', '人際關係與團隊合作'], majors: ['新聞', '大眾傳播', '廣電電影', '廣告公關', '資訊傳播'], careers: ['記者', '影視導演或製作人', '廣告文案', '公關', '社群小編'] },
    { name: '設計學群', description: '學建築、空間設計、商業設計、藝術設計、工業設計、媒體設計等，讓物品和環境兼顧實用與美感。', competencies: ['藝術涵養與美感素養', '系統思考與解決問題'], majors: ['建築', '空間設計', '都市計畫', '工業設計', '商業設計', '媒體設計', '服裝設計', '工藝'], careers: ['平面設計師', 'UI/UX 設計師', '建築師', '室內設計師', '產品設計師'] },
    { name: '生命科學學群', description: '探究生命現象，包括遺傳、演化、生物的構造與功能，以及細胞和分子層次的機制等。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], majors: ['生命科學', '生物科技', '生化', '生態', '生物資訊', '生醫工程', '食品生技', '植物保護'], careers: ['生技或製藥公司研發（多半要讀研究所）', '研究助理', '品管或檢驗人員', '農業或食品技術人員'] },
    { name: '醫藥衛生學群', description: '學維護身心健康的知識與技術，包括疾病和傷害的預防與治療，對象從個人到整個人群。', competencies: ['系統思考與解決問題', '人際關係與團隊合作'], majors: ['醫學', '牙醫', '藥學', '護理', '物理治療', '職能治療', '醫學檢驗', '公共衛生'], careers: ['醫師', '牙醫師', '藥師', '護理師', '物理治療師', '醫事檢驗師'] },
];

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
        // maxLength 只當保險。
        id: 'starter-pack',
        input: {
            topic: { label: '初步想法', maxLength: 200 },
        },
        instructions: [
            '請為一位想自主學習的學生，依他的「初步想法」寫一份「學習啟動包」：',
            '- suggested_topic：將學生的模糊想法，聚焦為一個更具體的研究主題',
            '- research_questions：提供 3 個可以引導初步探索的開放式問題，每個問題一句話',
            '- resource_types：建議 3 種適合這個主題的學習資源類型，每種只寫簡短的資源類型名稱（約 2～12 字），不要加說明，例如：知識型影片、線上課程、學術論文、訪談專家等',
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
        id: 'competency-analysis',
        input: {
            experience: { label: '活動經驗', maxLength: 1000 },
        },
        temperature: 0.5,
        instructions: [
            '請根據學生描述的「活動經驗」，找出這段經驗最看得出來的 2～3 項核心素養，',
            '並針對每項素養提供一句精簡的寫作建議，說明在學習歷程檔案裡怎麼呈現這項素養。',
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
                `重視程度前兩名的核心素養：${c.competencies.join('、')}`,
                `相關科系：${c.majors.join('、')}`,
                `常見出路（舉例）：${c.careers.join('、')}`,
            ].join('\n')).join('\n\n'),
            '---',
            '你的回答應該包含：',
            '1. 根據學生的興趣，推薦 1～2 個最相關的學群。',
            '2. 簡單說明為什麼推薦這些學群。',
            '3. 給予一個具體的下一步探索建議。',
            '學生說不出興趣時，從日常喜歡做的事或擅長的科目幫他找線索。',
            '回答請簡潔，總長度不要超過 200 字。',
            '學生每次只送一個問題，你看不到之前的對話，之後也看不到這次的回答。',
            '下一步建議要是學生自己就能完成的事，不要用「下次」「再跟我說」這類需要接續對話的說法。',
            '提到校系規定時，請學生查該校系網頁，或大學甄選入學委員會（繁星推薦、申請入學）、大學考試入學分發委員會（分科測驗）的校系分則。',
        ].join('\n'),
        output: { type: 'markdown' },
        maxOutputChars: 800,
    },
    {
        // 學習歷程首頁（src/pages/learning-portfolio/index.astro）與反思引導提問集
        // （reflection-guide.astro）共用的「AI 學習歷程健檢」。
        // analysis 以 S、T、A、R 為鍵：閘道的 schema 子集沒有 prefixItems，用陣列保證不了四項剛好各一。
        // maxLength 是硬截斷（見 tasks.mjs），長度要求寫在指令裡。
        // 2026-11-01 WinLab 實測，修改範例會寫出心得裡沒有的獎項、人數與地點，學生可能照抄，所以要標出待補的地方。
        // 開頭的角色設定留著：2026-11-05 WinLab 實測，拿掉之後 reasoning tokens 平均從約 3800 變成約 6800 到 8900。
        id: 'star-analysis',
        input: {
            reflection: { label: '心得反思', maxLength: 2000 },
        },
        instructions: [
            '你是一位專業的學習歷程檔案顧問。請根據 STAR 原則（Situation 情境、Task 任務、Action 行動、Result 結果），分析這位高中生寫的「心得反思」：',
            '- overall_comment：一段簡短的總評，約 50～150 字',
            '- analysis：S、T、A、R 四個項目各寫一則 comment（針對該項目的評論，點出優點或缺失）與 suggestion（具體的修改建議），各一到兩句',
            '- revised_example：根據你的建議，提供一小段修改後的文字範例，約 100～300 字，使其更符合 STAR 原則。心得裡沒有的人數、時間、名次與成果不要自己編，用「（填入參加人數）」這樣的括號標出要補的地方',
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
        id: 'learning-path',
        input: {
            topic: { label: '學習主題', maxLength: 100 },
        },
        instructions: [
            '請為一位想自主學習的台灣高中生，依他的「學習主題」規劃一份剛好 4 個步驟的學習路徑（learning_path），步驟依學習的先後順序排列。每個步驟包含：',
            '- title：步驟標題，約 4～15 字',
            '- description：步驟描述，說明這一步要學什麼，一到兩句，約 30～80 字',
            '- resource_type：建議的資源類型，只寫簡短的類型名稱（約 2～10 字），不要加說明，例如：線上課程、知識型影片、閱讀材料、互動模擬實驗',
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
        // 開頭的角色設定留著：2026-11-05 WinLab 實測，拿掉之後 reasoning tokens 的中位數多了約兩成，最長一次接近 max_tokens。
        id: 'topic-ideas',
        input: {
            interests: { label: '興趣關鍵字', maxLength: 100 },
        },
        instructions: [
            '你是一位專業的台灣高中教育顧問，專長是引導學生進行自主學習。請根據學生提供的「興趣關鍵字」，為他發想 3 個具體、高中生做得到的跨領域自主學習主題，放在 ideas 裡。每個主題包含：',
            '- title：主題名稱，約 10～25 字',
            '- description：簡短描述，約 50～120 字',
            '- methods：建議研究方法 2～4 種，每種只寫簡短的方法名稱（約 2～12 字），不要加說明',
            '- challenges：潛在挑戰 2～3 個，每個一句話（約 15～50 字）',
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
