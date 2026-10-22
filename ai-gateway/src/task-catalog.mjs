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
];
