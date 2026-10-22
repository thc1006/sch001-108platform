// 正式上線的任務清單。每個網站 AI 功能遷移過來時，在同一個 commit 裡把 prompt 從
// 頁面搬到這裡——diff 上看得到「從頁面刪掉、在這裡加上」，確認是搬移而不是改寫。
//
// 格式見 tasks.mjs 的 defineTask。

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

/** TASK_DEFINITIONS 是正式上線的任務，server.mjs 啟動時交給 createCatalog 逐一檢查。 */
export const TASK_DEFINITIONS = [
    {
        // 自主學習 › AI 自主學習教練（src/pages/autonomous-learning/index.astro）的「學習啟動包」。
        // 原本頁面要模型「以 JSON 格式回應」再自己找大括號解析、失敗時套假資料；現在由 schema
        // 約束輸出，閘道驗證過才交給頁面。
        // 指令比頁面原本的 prompt 多了兩處長度要求（探索問題一句話、資源類型只寫簡短名稱）：
        // schema 的 maxLength 是硬截斷，沒說長度時模型把資源類型寫成長篇說明，被切在 50 字
        // （WinLab 實測），學生看到半句話；maxLength 只當保險
        id: 'starter-pack',
        input: {
            topic: { label: '初步想法', maxLength: 200 },
        },
        // 不超過 QUEUE_TIMEOUT_MS 的預設值（見 limits.mjs）；WinLab 忙時第一個位元組等滿 2 分鐘，還剩 90 秒生成。
        timeoutMs: 210_000,
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
];
