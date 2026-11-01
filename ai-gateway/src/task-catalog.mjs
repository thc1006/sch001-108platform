// 正式上線的任務清單，格式見 tasks.mjs 的 defineTask。

/**
 * CAREER_CLUSTERS 是 career-chat 的參考資料：生涯探索首頁 majorData 裡的五個欄位，抄自頁面
 * （閘道的映像檔裡沒有那個檔案），頁面又照 ColleGo! 的學群頁。兩邊是否一致由
 * test/task-catalog.test.mjs 檢查。
 */
const CAREER_CLUSTERS = [
    { name: '工程學群', description: '將基礎科學的知識與工程技術結合，依生產實務區分為各專門領域，以培育高層技術人才。包括所有與「工程」相關的學系。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], majors: ['資訊工程', '電機工程', '光電工程', '電子工程', '通訊工程', '工程科學', '機械工程', '航空工程', '土木工程', '水利工程', '化學工程', '材料工程', '生醫工程', '環境工程', '建築', '科技教育', '工業管理', '運輸物流', '電機資訊', '工程跨學類'], careers: ['工程／研發／生技相關職類', '資訊／軟體／系統相關職類'] },
    { name: '資訊學群', description: '以資訊處理各層次的理論與實務技術，包括電腦程式設計與系統、電腦軟硬體結構、網路架設、資訊安全保密、資訊系統的統整、規劃與管理。', competencies: ['科技資訊與媒體素養', '系統思考與解決問題'], majors: ['資訊工程', '生物資訊', '資訊傳播', '媒體設計', '圖書資訊', '數位學習', '資訊管理', '電機工程', '光電工程', '電子工程', '通訊工程', '電機資訊', '數據統計'], careers: ['資訊／軟體／系統相關職類', '工程／研發／生技相關職類'] },
    { name: '管理學群', description: '管理學群主要處理組織系統內外人事物的各種問題，學習從事溝通協調、領導規劃或系統分析、資源整合等，以促使組織或企業工作流程順暢、工作效率提升、工作環境人性化、合理化，以收最大效益。', competencies: ['系統思考與解決問題', '人際關係與團隊合作'], majors: ['資訊管理', '工業管理', '醫務管理', '文化產業', '勞工關係', '行政管理', '企業管理', '行銷經營', '運輸物流', '土地資產', '國際企業', '觀光事業', '運動管理', '餐旅管理', '休閒管理', '管理跨學類'], careers: ['資訊／軟體／系統相關職類'] },
    { name: '財經學群', description: '財經學群主要探究財務金融體制與系統運作機制，以資金為供給與需求探討金融體系的運作形式，可以提供對個人、組織、國家、國際等不同層面，在財務規劃與分析之原理概念，財務實務上的配置與管理技術。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], majors: ['會計', '財務金融', '國際企業', '財稅', '保險', '經濟'], careers: ['財務／金融／保險相關職類'] },
    { name: '社會與心理學群', description: '社會心理學群著重社會結構及社會現象的觀察、分析批判，關懷人類心智行為形成成因、表現形式、後端影響的系統結構、個體心理狀態的探討，並且提供各種助人專業訓練，以提升眾人、個體的生活福祉。', competencies: ['人際關係與團隊合作', '系統思考與解決問題'], majors: ['心理', '社會學', '社會工作', '人類民族', '兒童家庭', '宗教', '輔導諮商', '犯罪防治', '勞工關係'], careers: ['教育／學術／研究相關職類'] },
    { name: '大眾傳播學群', description: '大眾傳播學群主要學習傳播理論，以各種媒體將訊息以聲音、文字、影像等方式傳遞給人群，包括對訊息收集、媒體認識製作、評估訊息傳播的影響、傳播政策之擬定、傳播機構管理及資訊服務訓練等。', competencies: ['科技資訊與媒體素養', '人際關係與團隊合作'], majors: ['資訊傳播', '大眾傳播', '廣電電影', '新聞', '廣告公關'], careers: ['傳播／娛樂／藝術相關職類', '廣告／公關／設計相關職類'] },
    { name: '設計學群', description: '建築設計學群主要探究自然社會環境、都市建築規畫、以及室內設計、商業設計等結合人文藝術與工程技術領域，對物體、空間或環境同時能賦予實用與美學之特性。', competencies: ['藝術涵養與美感素養', '系統思考與解決問題'], majors: ['媒體設計', '建築', '都市計畫', '空間設計', '工業設計', '工藝', '商業設計', '服裝設計', '藝術設計'], careers: ['廣告／公關／設計相關職類', '營建／製圖／施作相關職類'] },
    { name: '生命科學學群', description: '生命科學學群著重於動植物生活型態、生命現象的知識探究，包括生命的發生、遺傳、演化、構造、功能、細胞及分子層次機制等。', competencies: ['系統思考與解決問題', '規劃執行與創新應變'], majors: ['生物資訊', '生醫工程', '生化', '生命科學', '生物科技', '植物保護', '生態', '食品生技'], careers: ['工程／研發／生技相關職類', '教育／學術／研究相關職類'] },
    { name: '醫藥衛生學群', description: '醫藥衛生學群學習維護人類身心健康相關之知識及技術，從個人到整個人群，包括身心健康的維持、疾病或傷害的預防與治療。', competencies: ['系統思考與解決問題', '人際關係與團隊合作'], majors: ['醫學', '公共衛生', '牙醫', '物理治療', '職能治療', '護理', '醫學檢驗', '影像放射', '藥學', '食品營養', '呼吸治療', '健康照護', '化妝品', '職業安全', '獸醫', '醫務管理', '運動保健', '視光', '語療聽力'], careers: ['醫療／美容／生命相關職類', '教育／學術／研究相關職類'] },
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
        // 生涯探索 › 核心素養對照表的「AI 對照核心素養」（src/pages/career-exploration/competency-map.astro）。
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
            '你是一位專業的高中生學涯輔導老師，請用親切、鼓勵的語氣回答學生的「問題」。',
            '請依據以下台灣的大學學群資料作為你回答的主要參考依據：',
            '---',
            CAREER_CLUSTERS.map((c) => [
                `學群：${c.name}`,
                `簡介：${c.description}`,
                `重視程度前兩名的核心素養：${c.competencies.join('、')}`,
                `主要學類：${c.majors.join('、')}`,
                `相關職類：${c.careers.join('、')}`,
            ].join('\n')).join('\n\n'),
            '---',
            '以上取自 ColleGo! 的學群頁，相關職類是大分類，不是完整的出路清單；推薦時以簡介與主要學類為主。',
            '你的回答應該包含：',
            '1. 根據學生的興趣，推薦 1～2 個最相關的學群。',
            '2. 簡單說明為什麼推薦這些學群。',
            '3. 給予一個具體的下一步探索建議。',
            '回答請簡潔，總長度不要超過 200 字。',
            '學生每次只送一個問題，你看不到之前的對話，之後也看不到這次的回答。',
            '下一步建議要是學生自己就能完成的事，不要用「下次」「再跟我說」這類需要接續對話的說法。',
        ].join('\n'),
        output: { type: 'markdown' },
        maxOutputChars: 800,
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
        // Week 3-5 這種週次；items 只能是單一 schema，表達不了標籤的順序，由 output.check 檢查。
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
            '5. 國家寶藏：志工到美國國家檔案館翻拍和台灣有關的檔案（1887 到 1977 年），放上網站讓大家閱讀、搜尋、校對。目前維護中：實地翻拍從 2020 年起暫停，已經上傳的檔案照常開放。相關領域：歷史、英文、數位典藏、國際關係',
            '6. LawTrace 立法足跡：把立法院各網站的法案資料放在一起，看得到一部法律歷次修正的條文，以及一讀、二讀、三讀、審查會、公聽會的過程。相關領域：公民與社會、法律、資訊科技、開放資料',
            '7. vTaiwan：公共政策的開放討論平台，議題列表依進度標示意見徵集、研擬草案或送交院會，近年討論過 AI 的風險評估和社群平台的言論審查。相關領域：公民與社會、審議民主、資訊科技、AI 治理',
            '8. 民生公共物聯網：整合空氣品質、水資源、地震、災防的感測資料。目前維護中：計畫已在 2025 年 12 月 31 日結束，原平台已經連不上，公告資料服務提供到 2026 年 12 月 1 日。相關領域：自然科學、地球科學、資訊科技、資料分析',
            '請依學生的「興趣或關心的議題」推薦 1 至 3 個最適合的專案，並說明原因。每個推薦請包含：',
            '專案名稱、推薦原因（2～3 句）、探索建議（1～2 句具體的自主學習方向）。',
            '如果「興趣或關心的議題」與所有專案都不太相關，也請誠實說明，並嘗試找出最接近的連結點；',
            '寧可少推薦幾個，也不要牽強附會。',
            '回答請簡潔有力，不要超過 400 字；推薦 3 個專案時，每個推薦都要寫得更精簡。',
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
