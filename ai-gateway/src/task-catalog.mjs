/**
 * 正式上線的任務清單。每個網站 AI 功能遷移過來時，在同一個 commit 裡把 prompt 從
 * 頁面搬到這裡——diff 上看得到「從頁面刪掉、在這裡加上」，確認是搬移而不是改寫。
 *
 * 格式見 tasks.mjs 的 defineTask。
 */
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
];
