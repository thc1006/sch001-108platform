// 正式上線的任務清單，格式見 tasks.mjs 的 defineTask。

/**
 * CAREER_CLUSTERS 是 career-chat 的參考資料：職涯探索首頁 majorData 裡的四個欄位，抄自頁面
 * （閘道的映像檔裡沒有那個檔案）。兩邊是否一致由 test/task-catalog.test.mjs 檢查。
 */
const CAREER_CLUSTERS = [
    { name: '工程學群', description: '應用科學與數學原理，解決實務問題，從晶片設計到橋樑建造都屬此範疇。', competencies: ['系統思考與解決問題', '科技資訊與媒體素養'], careers: ['半導體工程師', '結構技師', '廠務工程師'] },
    { name: '資訊學群', description: '專注於電腦科學、軟體開發、數據分析與網路通訊，是數位時代的核心驅動力。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], careers: ['軟體工程師', '資料分析師', 'AI工程師', '資安專家'] },
    { name: '管理學群', description: '學習組織、領導、規劃與控制等管理職能，以達成組織目標。', competencies: ['人際關係與團隊合作', '規劃執行與創新應變'], careers: ['專案經理', '行銷企劃', '人力資源', '管理顧問'] },
    { name: '財經學群', description: '研究金融市場、投資、公司理財與經濟現象，是資本社會的運作基礎。', competencies: ['系統思考與解決問題', '符號運用與溝通表達'], careers: ['銀行行員', '證券分析師', '會計師', '理財專員'] },
    { name: '社會與心理學群', description: '關心人類的心理歷程、社會行為與結構，旨在理解並改善個人與社會的福祉。', competencies: ['人際關係與團隊合作', '道德實踐與公民意識'], careers: ['臨床心理師', '社工師', '人力資源', '市調人員'] },
    { name: '大眾傳播學群', description: '學習訊息的產製、傳遞與效果，包含新聞、廣告、廣播、影視等領域。', competencies: ['符號運用與溝通表達', '科技資訊與媒體素養'], careers: ['記者', '導演', '廣告文案', '社群小編'] },
    { name: '設計學群', description: '結合美感與實用性，解決生活中的問題，從平面設計到建築設計皆屬此範疇。', competencies: ['藝術涵養與美感素養', '系統思考與解決問題'], careers: ['平面設計師', 'UI/UX設計師', '建築師', '產品設計師'] },
    { name: '生命科學學群', description: '探討生命的奧秘，從分子、細胞到生態系，是生物科技與醫學研究的基礎。', competencies: ['系統思考與解決問題', '科技資訊與媒體素養'], careers: ['生物研究員', '藥廠研發', '農業技術專家'] },
    { name: '醫藥衛生學群', description: '致力於人體健康的維護與疾病的治療，包含醫師、藥師、護理師、物理治療師等專業。', competencies: ['道德實踐與公民意識', '身心素質與自我精進'], careers: ['醫師', '藥師', '護理師', '物理治療師'] },
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

/**
 * TASK_DEFINITIONS 是正式上線的任務，server.mjs 啟動時交給 createCatalog 逐一檢查。
 * 任務都不設 timeoutMs，沿用 LLM_TASK_TIMEOUT_MS。時限從拿到名額就開始算，要容得下 WinLab 忙時等第一個
 * 位元組的 2 分鐘。xhigh 的思考長度變化很大，2026-10-23 經正式閘道實測，同一題 career-chat 是 40.1 秒和
 * 145.8 秒；思考寫滿一輪、接到第二輪的 civic-tech-suggestion 是 218.9 秒。145.8 秒與 218.9 秒加上 2 分鐘
 * 都超過 QUEUE_TIMEOUT_MS，不超過它的時限會切掉正常的請求。
 */
export const TASK_DEFINITIONS = [
    {
        // 自主學習 › AI 自主學習教練（src/pages/autonomous-learning/index.astro）的「學習啟動包」。
        // 指令寫明長度（探索問題一句話、資源類型只寫簡短名稱）：schema 的 maxLength 是硬截斷，
        // 沒說長度時模型把資源類型寫成長篇說明，被切在 50 字（WinLab 實測），學生看到半句話；
        // maxLength 只當保險。
        id: 'starter-pack',
        input: {
            topic: { label: '初步想法', maxLength: 200 },
        },
        instructions: [
            '你是一位專業的台灣高中教育顧問，請為一位想自主學習的學生，依他的「初步想法」生成一份「學習啟動包」：',
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
        // 職涯探索 › 素養地圖的「AI 素養分析師」（src/pages/career-exploration/competency-map.astro）。
        // 指令列出九項素養的代號與名稱：只給代號的話，名稱得靠模型自己記，記錯就誤導學生。
        // 名稱抄自 scripts/taxonomy.json，因為閘道的映像檔裡沒有那個檔案；test/task-catalog.test.mjs 比對兩邊。
        id: 'competency-analysis',
        input: {
            experience: { label: '活動經驗', maxLength: 1000 },
        },
        temperature: 0.5,
        instructions: [
            '你是一位專業的 108 課綱學習歷程顧問。請根據學生描述的「活動經驗」，分析其中最能體現的 2～3 項核心素養，',
            '並針對每項素養提供一句精簡的寫作建議，引導學生如何在學習歷程中呈現這個亮點。',
            '請用活潑、鼓勵的語氣，並以 Markdown 的星號列表格式回傳。',
            '核心素養只能從這九項中選擇（寫出代號與名稱）：A1 身心素質與自我精進、A2 系統思考與解決問題、',
            'A3 規劃執行與創新應變、B1 符號運用與溝通表達、B2 科技資訊與媒體素養、B3 藝術涵養與美感素養、',
            'C1 道德實踐與公民意識、C2 人際關係與團隊合作、C3 多元文化與國際理解。',
        ].join('\n'),
        output: { type: 'markdown' },
    },
    {
        // 職涯探索首頁的「AI 學涯導師」（src/pages/career-exploration/index.astro）。畫面像聊天，
        // 但每次只送這一題，不帶先前的對話。
        id: 'career-chat',
        input: {
            question: { label: '問題', maxLength: 200 },
        },
        instructions: [
            '你是一位專業的高中生學涯輔導老師，請用親切、鼓勵的語氣回答學生的「問題」。',
            '請依據以下台灣的大學學群資料作為你回答的主要參考依據：',
            '---',
            CAREER_CLUSTERS.map((c) => [
                `學群：${c.name}`,
                `簡介：${c.description}`,
                `適合特質：${c.competencies.join('、')}`,
                `未來出路：${c.careers.join('、')}`,
            ].join('\n')).join('\n\n'),
            '---',
            '你的回答應該包含：',
            '1. 根據學生的興趣，推薦 1～2 個最相關的學群。',
            '2. 簡單說明為什麼推薦這些學群。',
            '3. 給予一個具體的下一步探索建議。',
            '回答請簡潔，總長度不要超過 200 字。',
            '學生每次只送一個問題，你看不到之前的對話，之後也看不到這次的回答。',
            '下一步建議要是學生自己就能完成的事，不要用「下次」「再跟我說」這類需要接續對話的說法。',
        ].join('\n'),
        output: { type: 'markdown' },
    },
    {
        // 學習歷程首頁（src/pages/learning-portfolio/index.astro）與反思引導提問集
        // （reflection-guide.astro）共用的「AI 學習歷程健檢」。
        // analysis 以 S、T、A、R 為鍵：閘道的 schema 子集沒有 prefixItems，用陣列保證不了四項剛好各一。
        // maxLength 是硬截斷（見 tasks.mjs），長度要求寫在指令裡。
        id: 'star-analysis',
        input: {
            reflection: { label: '心得反思', maxLength: 2000 },
        },
        instructions: [
            '你是一位專業的學習歷程檔案顧問。請根據 STAR 原則（Situation 情境、Task 任務、Action 行動、Result 結果），分析這位高中生寫的「心得反思」：',
            '- overall_comment：一段簡短的總評，約 50～150 字',
            '- analysis：S、T、A、R 四個項目各寫一則 comment（針對該項目的評論，點出優點或缺失）與 suggestion（具體的修改建議），各一到兩句',
            '- revised_example：根據你的建議，提供一小段修改後的文字範例，約 100～300 字，使其更符合 STAR 原則',
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
        // 自主學習 › 計畫範本庫的「AI 計畫草擬工具」（src/pages/autonomous-learning/plan-templates.astro）。
        // 頁面只送主題，計畫固定 8 週，和頁面上的範本相同。week 只能是四個標籤之一，模型寫不出
        // Week 3-5 這種週次；標籤依序、不重複只靠指令要求，items 只能是單一 schema，表達不了。
        id: 'study-plan',
        input: {
            topic: { label: '自主學習主題', maxLength: 100 },
        },
        instructions: [
            '你是一位專業的台灣高中教育顧問，請依學生的「自主學習主題」，設計一份為期 8 週的自主學習計畫大綱：',
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
                                week: { type: 'string', enum: ['Week 1-2', 'Week 3-4', 'Week 5-6', 'Week 7-8'] },
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
        },
    },
    {
        // 公民科技地圖的「AI 探索建議」（src/pages/civic-tech-map/index.astro）。
        // 專案名稱與狀態抄自 public/civic-tech-map/projects.json（閘道的映像檔裡沒有那個檔案），
        // test/task-catalog.test.mjs 比對兩邊。國家寶藏註明維護中，模型才不會叫學生去做已經放緩的翻拍。
        // 「寧可少推薦」與「推薦 3 個時寫得更精簡」兩句：2026-10 WinLab 實測少了它們，興趣不相關時
        // 也硬湊 3 個，推薦 3 個時常超過 400 字。改寫成「每個約 100 字」的話，思考的 tokens 多了好幾倍，
        // 一次要兩分多鐘。
        id: 'civic-tech-suggestion',
        input: {
            interest: { label: '興趣或關心的議題', maxLength: 300 },
        },
        instructions: [
            '你是「台灣教育處方籤」平台的 AI 探索助手，正在協助一位台灣高中生找到適合的公民科技專案作為自主學習主題。',
            '以下是台灣的公民科技專案：',
            '1. Disfactory 農地違章工廠回報系統：透過衛星圖資與群眾外包標記台灣農地上的違章工廠。相關領域：地理、GIS 地理資訊系統、公民與社會、環境科學',
            '2. Cofacts 真的假的：LINE 聊天機器人加協作查核資料庫，打擊假訊息傳播。相關領域：資訊科技、媒體識讀、公民與社會、數據分析',
            '3. Amis MoeDict 阿美語萌典：台灣第一部數位化原住民語線上辭典，保存瀕危語言。相關領域：語言學、文化保存、資訊科技、多元文化',
            '4. 透明足跡 / 掃了再買：環境資訊公開平台，可查詢企業環境違規紀錄並掃描商品條碼。相關領域：化學、環境科學、經濟學、消費者權益',
            '5. 國家寶藏 (National Treasure)：從海外（主要為美國國家檔案局）翻拍與台灣歷史相關的文件。目前維護中：新檔案的數位化已經放緩，既有的檔案資料庫仍開放研究使用。相關領域：歷史、英文、數位典藏、國際關係',
            '6. LawTrace 立法足跡：整合立法院法案資料，呈現法律從提案到歷次修正的完整立法歷程。相關領域：公民與社會、法律、資訊科技、開放資料',
            '7. vTaiwan 數位民主審議平台：結合線上意見分群與實體審議的數位民主平台，近年聚焦 AI 治理。相關領域：公民與社會、審議民主、資訊科技、AI 治理',
            '8. 民生公共物聯網 Civil IoT Taiwan：整合空品、地震、防災、水資源的開放感測資料與即時監測平台。相關領域：自然科學、地球科學、資訊科技、資料分析',
            '請依學生的「興趣或關心的議題」推薦 1 至 3 個最適合的專案，並說明原因。每個推薦請包含：',
            '專案名稱、推薦原因（2～3 句）、探索建議（1～2 句具體的自主學習方向）。',
            '語氣友善、鼓勵探索。如果「興趣或關心的議題」與所有專案都不太相關，也請誠實說明，並嘗試找出最接近的連結點；',
            '寧可少推薦幾個，也不要牽強附會。',
            '回答請簡潔有力，不要超過 400 字；推薦 3 個專案時，每個推薦都要寫得更精簡。',
        ].join('\n'),
        output: { type: 'markdown' },
    },
    {
        // 自主學習 › 學習資源地圖的「AI 學習路徑規劃師」（src/pages/autonomous-learning/resource-map.astro）。
        // 步驟編號由頁面依陣列順序給，不讓模型寫：schema 管不住編號是否連續。
        id: 'learning-path',
        input: {
            topic: { label: '學習主題', maxLength: 100 },
        },
        instructions: [
            '你是一位專業的學習顧問，請為一位想自主學習的台灣高中生，依他的「學習主題」規劃一份剛好 4 個步驟的學習路徑（learning_path），步驟依學習的先後順序排列。每個步驟包含：',
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
        id: 'topic-ideas',
        input: {
            interests: { label: '興趣關鍵字', maxLength: 100 },
        },
        instructions: [
            '你是一位專業的台灣高中教育顧問，專長是引導學生進行自主學習。請根據學生提供的「興趣關鍵字」，為他發想 3 個具體、創新且可執行的跨領域自主學習主題，放在 ideas 裡。每個主題包含：',
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
