/**
 * 正式上線的任務清單（task-catalog.mjs）：每個定義都過得了啟動時的檢查，各任務的輸入與輸出
 * 規格符合頁面的需要。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { TASK_DEFINITIONS } from '../src/task-catalog.mjs';
import { createCatalog, validateInput, buildMessages, finalizeOutput } from '../src/tasks.mjs';

const catalog = createCatalog(TASK_DEFINITIONS);

test('每個任務定義都過得了啟動時的檢查（id、欄位、schema），沒有重複的 id', () => {
    assert.equal(catalog.size, TASK_DEFINITIONS.length);
    assert.ok(catalog.size >= 1);
});

test('每個任務都組得出訊息：學生的資料只在 user 訊息、包在資料標記裡', () => {
    for (const task of catalog.values()) {
        const input = Object.fromEntries(Object.keys(task.input).map((name) => [name, '測試內容']));
        const [system, user] = buildMessages(task, validateInput(task, input));
        assert.equal(system.role, 'system');
        assert.doesNotMatch(system.content, /測試內容/, task.id);
        assert.match(user.content, /^<資料-[0-9a-f]{12} 欄位="[^"]+">\n測試內容\n<\/資料-[0-9a-f]{12}>/, task.id);
    }
});

// 語氣詞只能出現在否定的指令裡（「不寫……鼓勵」）。以逗號、分號、句號分句，分句要以否定的動詞開頭，
// 後面不能再有「要」「請」這類要求：「請不時鼓勵」「不只要清楚也要鼓勵」都算要求語氣。
// 只查全形驚嘆號：學群資料的出處 ColleGo! 帶半形的。
const TONE_WORDS = /親切|活潑|鼓勵|溫暖|熱情|加油|！/;
const NEGATED = /^\s*(?:不寫|不要|不用|避免|勿|別)(?:(?!要|請|應|需)[^])*$/;
function toneOutsideNegation(text) {
    return text.split(/[，；。\n]/).filter((clause) => TONE_WORDS.test(clause) && !NEGATED.test(clause));
}

test('toneOutsideNegation：要求語氣的句子抓得到，否定的指令不算', () => {
    for (const text of [
        '請用親切、鼓勵的語氣回答學生的問題。', '請用活潑、鼓勵的語氣，並以 Markdown 的星號列表格式回傳。', '語氣友善、鼓勵探索。',
        '結尾加一句加油', '回答要溫暖', '你做得很好！', '請不時鼓勵學生', '不只要清楚，也要鼓勵學生', '不只要清楚也要鼓勵學生',
        '不要只寫缺點也要鼓勵學生',
    ]) {
        assert.equal(toneOutsideNegation(text).length, 1, text);
    }
    for (const text of ['不寫客套話、空泛的稱讚與鼓勵，不用驚嘆號和表情符號。', '避免熱情的口號。', '以上取自 ColleGo! 的學群頁']) {
        assert.deepEqual(toneOutsideNegation(text), [], text);
    }
});

test('每個任務的 system 訊息都要求語氣平實，沒有要求親切、鼓勵這類語氣', () => {
    for (const task of catalog.values()) {
        const input = Object.fromEntries(Object.keys(task.input).map((name) => [name, '測試內容']));
        const [system] = buildMessages(task, validateInput(task, input));
        assert.match(system.content, /語氣平實/, task.id);
        assert.match(system.content, /不用驚嘆號和表情符號/, task.id);
        assert.deepEqual(toneOutsideNegation(system.content), [], task.id);
    }
});

// 依據見 task-catalog.mjs 的 TASK_DEFINITIONS。
test('任務都不設 timeoutMs，沿用 LLM_TASK_TIMEOUT_MS', () => {
    for (const task of catalog.values()) assert.equal(task.timeoutMs, undefined, task.id);
});

// 依據見 task-catalog.mjs 的 TASK_DEFINITIONS：指令寫了字數的是它的 4 倍
test('文字任務都有 maxOutputChars：指令寫了字數的是 4 倍，competency-analysis 是 1000；JSON 任務沒有', () => {
    const caps = Object.fromEntries([...catalog.values()].filter((t) => t.output.type === 'markdown').map((t) => [t.id, t.maxOutputChars]));
    assert.deepEqual(caps, { 'competency-analysis': 1000, 'career-chat': 800, 'civic-tech-suggestion': 1600 });
    for (const [id, limit] of [['career-chat', 200], ['civic-tech-suggestion', 400]]) {
        assert.match(catalog.get(id).instructions, new RegExp(`超過 ${limit} 字`), id);
    }
    for (const task of catalog.values()) {
        if (task.output.type === 'json') assert.equal(task.maxOutputChars, undefined, task.id);
    }
});

test('starter-pack：初步想法最多 200 字（頁面的輸入框同樣限制 200）', () => {
    const task = catalog.get('starter-pack');
    assert.equal(validateInput(task, { topic: '貓'.repeat(200) }).topic.length, 200);
    assert.throws(() => validateInput(task, { topic: '貓'.repeat(201) }), { code: 'invalid_input', field: 'topic' });
});

test('starter-pack：輸出要剛好 3 個探索問題與 3 種資源類型，主題不能是空的', () => {
    const task = catalog.get('starter-pack');
    const ok = {
        suggested_topic: '家貓的社會行為與人貓互動',
        research_questions: ['家貓怎麼表達情緒？', '貓與飼主的依附關係如何形成？', '環境豐富化對貓有什麼影響？'],
        resource_types: ['知識型影片', '學術論文', '訪談獸醫'],
    };
    assert.deepEqual(finalizeOutput(task, JSON.stringify(ok)), ok);
    for (const bad of [
        { ...ok, research_questions: ok.research_questions.slice(0, 2) },
        { ...ok, resource_types: [...ok.resource_types, '線上課程'] },
        { ...ok, suggested_topic: '' },
        { ...ok, extra: 'x' },
    ]) {
        assert.throws(() => finalizeOutput(task, JSON.stringify(bad)), { code: 'format' });
    }
});

// trim() 去不掉零寬空白（U+200B），只有它的字串過得了 minLength: 1 和文字任務的非空檢查。
test('starter-pack 與 career-chat：只有零寬空白的答案不收', () => {
    const zwsp = '\u200B';
    const pack = { suggested_topic: zwsp, research_questions: [zwsp, zwsp, zwsp], resource_types: [zwsp, zwsp, zwsp] };
    assert.throws(() => finalizeOutput(catalog.get('starter-pack'), JSON.stringify(pack)), { code: 'format' });
    assert.throws(() => finalizeOutput(catalog.get('career-chat'), zwsp), { code: 'empty' });
});

// schema 的 maxLength 是 guided decoding 的硬截斷（見 tasks.mjs 檔頭）：指令沒說長度時，模型把
// 資源類型寫成長篇說明、被切在 50 字，學生看到半句話。長度要求才是真正的防線，maxLength 只當保險
test('starter-pack：指令要求探索問題每個一句話、資源類型只寫簡短的名稱', () => {
    const { instructions } = catalog.get('starter-pack');
    assert.match(instructions, /research_questions：[^\n]*每個問題一句話/);
    assert.match(instructions, /resource_types：[^\n]*簡短[^\n]*不要加說明/);
});

test('competency-analysis：活動經驗最多 1000 字（頁面的輸入框同樣限制 1000）；文字任務、溫度 0.5', () => {
    const task = catalog.get('competency-analysis');
    assert.equal(task.output.type, 'markdown');
    assert.equal(task.temperature, 0.5);
    assert.equal(validateInput(task, { experience: '科'.repeat(1000) }).experience.length, 1000);
    assert.throws(() => validateInput(task, { experience: '科'.repeat(1001) }), { code: 'invalid_input', field: 'experience' });
});

// 閘道的映像檔裡沒有 scripts/taxonomy.json，指令只能抄一份。
test('competency-analysis：指令列出的核心素養與 scripts/taxonomy.json 一字不差，不多也不少', () => {
    const { instructions } = catalog.get('competency-analysis');
    const taxonomy = JSON.parse(readFileSync(new URL('../../scripts/taxonomy.json', import.meta.url), 'utf8'));
    const expected = Object.entries(taxonomy.competencies).map(([code, { label }]) => `${code} ${label}`);
    assert.equal(expected.length, 9);
    assert.deepEqual(instructions.match(/[A-Z]\d+ [^、。\n]+/g), expected);
});

const CAREER_PAGE = readFileSync(new URL('../../src/pages/career-exploration/index.astro', import.meta.url), 'utf8');

test('career-chat：問題最多 200 字，與頁面輸入框的 maxlength 相同；文字任務、不設溫度（頁面原本沒設）', () => {
    const task = catalog.get('career-chat');
    assert.equal(task.output.type, 'markdown');
    assert.equal(task.temperature, undefined);
    assert.equal(validateInput(task, { question: '問'.repeat(200) }).question.length, 200);
    assert.throws(() => validateInput(task, { question: '問'.repeat(201) }), { code: 'invalid_input', field: 'question' });
    const input = CAREER_PAGE.match(/<input\b[^>]*\bid="chat-input"[^>]*>/)?.[0] ?? '';
    assert.match(input, new RegExp(`\\bmaxlength="${task.input.question.maxLength}"`));
});

test('career-chat：指令要求推薦 1～2 個學群、說明原因、給一個下一步建議，200 字內，不約學生下次再談', () => {
    const { instructions } = catalog.get('career-chat');
    assert.match(instructions, /推薦 1～2 個最相關的學群/);
    assert.match(instructions, /說明為什麼推薦/);
    assert.match(instructions, /具體的下一步探索建議/);
    assert.match(instructions, /總長度不要超過 200 字/);
    assert.match(instructions, /你看不到之前的對話，之後也看不到這次的回答/);
    assert.match(instructions, /不要用「下次」「再跟我說」這類需要接續對話的說法/);
});

// 學群資料以頁面的 majorData 為準，科系羅盤顯示的就是它。閘道的映像檔裡沒有頁面，指令只能
// 自己抄一份，靠這個測試防止兩邊漂移。majorData 是 JS 物件字面值而不是 JSON，所以交給 vm 求值。
test('career-chat：指令裡的學群資料與頁面的 majorData 一致（名稱、簡介、核心素養、主要學類、相關職類）', () => {
    const { instructions } = catalog.get('career-chat');
    const literal = CAREER_PAGE.match(/const majorData = (\[[\s\S]*?\n\s*\]);/)?.[1];
    assert.ok(literal, '頁面裡找不到 const majorData = [...];');
    const majorData = vm.runInThisContext(literal);
    const blocks = majorData.map((c) => [
        `學群：${c.name}`,
        `簡介：${c.description}`,
        `重視程度前兩名的核心素養：${c.competencies.join('、')}`,
        `主要學類：${c.majors.join('、')}`,
        `相關職類：${c.careers.join('、')}`,
    ].join('\n'));
    // 學群資料夾在兩行 --- 之間，逐塊比對：多一個、少一個、順序不同或欄位多了字都會不一樣。
    const section = instructions.split('\n---\n')[1] ?? '';
    assert.deepEqual(section.split('\n\n'), blocks);
});

test('star-analysis：心得反思最多 2000 字（頁面的輸入框同樣限制 2000）', () => {
    const task = catalog.get('star-analysis');
    assert.equal(validateInput(task, { reflection: '寫'.repeat(2000) }).reflection.length, 2000);
    assert.throws(() => validateInput(task, { reflection: '寫'.repeat(2001) }), { code: 'invalid_input', field: 'reflection' });
});

test('star-analysis：S、T、A、R 四項剛好各一，每項都要有評論與建議；舊的陣列格式不收', () => {
    const task = catalog.get('star-analysis');
    const item = { comment: '情境交代清楚。', suggestion: '補上時間與地點。' };
    const ok = {
        overall_comment: '內容真誠，但結果與反思可以再具體。',
        analysis: { S: item, T: item, A: item, R: item },
        revised_example: '高二上學期，我在社團擔任活動長……',
    };
    assert.deepEqual(finalizeOutput(task, JSON.stringify(ok)), ok);
    const { R, ...withoutR } = ok.analysis;
    for (const bad of [
        { ...ok, analysis: withoutR },
        { ...ok, analysis: { ...ok.analysis, X: item } },
        { ...ok, analysis: { ...ok.analysis, R: { comment: '有反思。' } } },
        { ...ok, analysis: { ...ok.analysis, R: { ...item, comment: '' } } },
        { ...ok, analysis: ['S', 'T', 'A', 'R'].map((element) => ({ element, ...item })) },
        { ...ok, revised_example: '' },
        { ...ok, extra: 'x' },
    ]) {
        assert.throws(() => finalizeOutput(task, JSON.stringify(bad)), { code: 'format' });
    }
});

// maxLength 是硬截斷，指令沒寫長度的話，模型會寫到一半被切掉。
test('star-analysis：指令寫明總評、各項評論與建議、修改範例的長度', () => {
    const { instructions } = catalog.get('star-analysis');
    assert.match(instructions, /overall_comment：[^\n]*約 50～150 字/);
    assert.match(instructions, /analysis：[^\n]*各一到兩句/);
    assert.match(instructions, /revised_example：[^\n]*約 100～300 字/);
});

test('star-analysis：修改範例不自己編心得裡沒有的細節，用「（填入…）」標出要補的地方', () => {
    const { instructions } = catalog.get('star-analysis');
    assert.match(instructions, /revised_example：[^\n]*心得裡沒有的人數、時間、名次與成果不要自己編，用「（填入[^」]+）」/);
});

test('study-plan：自主學習主題最多 100 字（頁面的輸入框同樣限制 100）', () => {
    const task = catalog.get('study-plan');
    assert.equal(validateInput(task, { topic: '飲'.repeat(100) }).topic.length, 100);
    assert.throws(() => validateInput(task, { topic: '飲'.repeat(101) }), { code: 'invalid_input', field: 'topic' });
});

test('study-plan：3 個目標、2～3 個方法與產出、四段週次進度；缺項、多項、空字串、陌生的週次標籤都不收', () => {
    const task = catalog.get('study-plan');
    const ok = {
        learning_objectives: ['能說明手搖飲店的行銷策略。', '能設計問卷蒐集顧客意見。', '能提出改善建議並上台報告。'],
        execution_methods: ['每週觀察兩家店的促銷活動。', '設計問卷並訪談三位同學。'],
        weekly_plan: ['Week 1-2', 'Week 3-4', 'Week 5-6', 'Week 7-8'].map((week) => ({ week, tasks: '完成這兩週的任務。' })),
        expected_outcome: ['一份行銷策略分析報告。', '一份五分鐘的簡報。'],
    };
    const three = { ...ok, execution_methods: [...ok.execution_methods, '整理資料並製作比較表。'], expected_outcome: [...ok.expected_outcome, '一張比較表。'] };
    for (const good of [ok, three]) assert.deepEqual(finalizeOutput(task, JSON.stringify(good)), good);

    const withWeek = (i, item) => ok.weekly_plan.map((w, j) => (j === i ? item : w));
    const { expected_outcome, ...withoutOutcome } = ok;
    for (const bad of [
        { ...ok, learning_objectives: ok.learning_objectives.slice(0, 2) },
        { ...ok, learning_objectives: [...ok.learning_objectives, '多一個目標。'] },
        { ...ok, execution_methods: ok.execution_methods.slice(0, 1) },
        { ...three, execution_methods: [...three.execution_methods, '多一個方法。'] },
        { ...ok, expected_outcome: ok.expected_outcome.slice(0, 1) },
        { ...three, expected_outcome: [...three.expected_outcome, '多一項產出。'] },
        { ...ok, weekly_plan: ok.weekly_plan.slice(0, 3) },
        { ...ok, weekly_plan: [...ok.weekly_plan, { week: 'Week 7-8', tasks: '多一段。' }] },
        { ...ok, weekly_plan: withWeek(3, { week: 'Week 9-10', tasks: '完成。' }) },
        { ...ok, weekly_plan: withWeek(0, { week: '第 1-2 週', tasks: '完成。' }) },
        { ...ok, weekly_plan: withWeek(0, { week: 'Week 1-2' }) },
        { ...ok, weekly_plan: withWeek(0, { week: 'Week 1-2', tasks: ' ' }) },
        { ...ok, weekly_plan: withWeek(0, { week: 'Week 1-2', tasks: '完成。', note: 'x' }) },
        { ...ok, learning_objectives: ['', ...ok.learning_objectives.slice(1)] },
        { ...ok, execution_methods: ['', ok.execution_methods[1]] },
        { ...ok, expected_outcome: [ok.expected_outcome[0], ' '] },
        withoutOutcome,
        { ...ok, extra: 'x' },
    ]) {
        assert.throws(() => finalizeOutput(task, JSON.stringify(bad)), { code: 'format' });
    }
});

// schema 只管每個 week 是四個標籤之一，四個都寫 Week 1-2 也符合；順序由任務的 check 檢查。
test('study-plan：週次要依序是 Week 1-2、Week 3-4、Week 5-6、Week 7-8，重複或亂序都不收', () => {
    const task = catalog.get('study-plan');
    const weeks = ['Week 1-2', 'Week 3-4', 'Week 5-6', 'Week 7-8'];
    const plan = (labels) => ({
        learning_objectives: ['能說明手搖飲店的行銷策略。', '能設計問卷蒐集顧客意見。', '能提出改善建議並上台報告。'],
        execution_methods: ['每週觀察兩家店的促銷活動。', '設計問卷並訪談三位同學。'],
        weekly_plan: labels.map((week, i) => ({ week, tasks: `任務${i + 1}` })),
        expected_outcome: ['一份行銷策略分析報告。', '一份五分鐘的簡報。'],
    });
    assert.deepEqual(finalizeOutput(task, JSON.stringify(plan(weeks))), plan(weeks));
    for (const [labels, at] of [
        [['Week 1-2', 'Week 1-2', 'Week 1-2', 'Week 1-2'], 1],
        [['Week 3-4', 'Week 1-2', 'Week 5-6', 'Week 7-8'], 0],
        [['Week 7-8', 'Week 5-6', 'Week 3-4', 'Week 1-2'], 0],
        [['Week 1-2', 'Week 3-4', 'Week 5-6', 'Week 5-6'], 3],
    ]) {
        assert.throws(() => finalizeOutput(task, JSON.stringify(plan(labels))), (err) => {
            assert.equal(err.code, 'format');
            assert.equal(err.detail, `$.weekly_plan[${at}].week 應為 ${weeks[at]}`);
            return true;
        }, labels.join('、'));
    }
});

// 數量、長度與週次在 schema 和指令各寫一次：guided decoding 照 schema，模型照指令寫內容，兩邊要一致。
// maxLength 是硬截斷，留到指令長度上限的兩倍以上，模型稍微寫長也不會被切成半句。
test('study-plan：指令寫明每一項的數量與長度，和 schema 一致；maxLength 至少是指令長度上限的兩倍', () => {
    const { instructions, output } = catalog.get('study-plan');
    const { properties } = output.schema;
    const lines = instructions.split('\n');
    for (const [name, { minItems, maxItems, items }] of Object.entries(properties)) {
        const line = lines.find((l) => l.startsWith(`- ${name}：`)) ?? '';
        const count = minItems === maxItems ? `${minItems} 個` : `${minItems}～${maxItems} 個`;
        assert.ok(line.includes(count), `${name} 的數量`);
        const limit = /約 \d+～(\d+) 字/.exec(line);
        assert.ok(limit, `${name} 的長度`);
        const { maxLength } = name === 'weekly_plan' ? items.properties.tasks : items;
        assert.ok(maxLength >= 2 * Number(limit[1]), `${name}：maxLength ${maxLength}，指令上限 ${limit[1]} 字`);
    }
    assert.ok(instructions.includes(properties.weekly_plan.items.properties.week.enum.join('、')));
});

test('civic-tech-suggestion：興趣或關心的議題最多 300 字（頁面的輸入框同樣限制 300）；文字任務、不設溫度', () => {
    const task = catalog.get('civic-tech-suggestion');
    assert.equal(validateInput(task, { interest: '海'.repeat(300) }).interest.length, 300);
    assert.throws(() => validateInput(task, { interest: '海'.repeat(301) }), { code: 'invalid_input', field: 'interest' });
    assert.equal(task.output.type, 'markdown');
    assert.equal(task.temperature, undefined);
    // 文字任務沒有 schema：答案去掉前後空白就交給頁面，沒有看得見的字才算失敗。
    assert.equal(finalizeOutput(task, '\n**Cofacts 真的假的**：適合你。\n'), '**Cofacts 真的假的**：適合你。');
    assert.throws(() => finalizeOutput(task, ' \n '), { code: 'empty' });
});

// 文字任務沒有 schema 的 maxLength，長度靠指令；maxOutputChars 只擋遠超過指令的回答。
test('civic-tech-suggestion：指令要求推薦 1 至 3 個、原因 2～3 句、建議 1～2 句、不超過 400 字（推薦 3 個時寫得更精簡），不相關時誠實說明、寧可少推薦，不指定語氣', () => {
    const { instructions } = catalog.get('civic-tech-suggestion');
    assert.match(instructions, /推薦 1 至 3 個/);
    assert.match(instructions, /推薦原因（2～3 句）/);
    assert.match(instructions, /探索建議（1～2 句/);
    assert.match(instructions, /不要超過 400 字/);
    assert.match(instructions, /推薦 3 個專案時，每個推薦都要寫得更精簡/);
    assert.match(instructions, /不太相關，也請誠實說明/);
    assert.match(instructions, /寧可少推薦幾個/);
    assert.doesNotMatch(instructions, /語氣|鼓勵/);
});

// 專案名稱與狀態以 public/civic-tech-map/projects.json 為準，名稱用地圖上專案卡片的 title。
// 閘道的映像檔裡沒有那個檔案，指令只能自己抄一份，靠這個測試防止兩邊漂移。
test('civic-tech-suggestion：指令列出的專案與 projects.json 的 title 一一對應，不是 active 的專案註明了狀態', () => {
    const { instructions } = catalog.get('civic-tech-suggestion');
    const { projects } = JSON.parse(readFileSync(new URL('../../public/civic-tech-map/projects.json', import.meta.url), 'utf8'));
    // 每個專案一行：「編號. 名稱：簡介……」。
    const lines = new Map(instructions.split('\n').filter((line) => /^\d+\. /.test(line))
        .map((line) => [line.replace(/^\d+\. /, '').split('：')[0], line]));
    assert.deepEqual([...lines.keys()].sort(), projects.map(({ title }) => title).sort());
    const STATUS_NOTES = { maintenance: '維護中', dormant: '近期幾無活動' };
    for (const { title, status } of projects) {
        for (const [key, note] of Object.entries(STATUS_NOTES)) {
            assert.equal(lines.get(title).includes(note), status === key, `${title} 是 ${status}，指令${status === key ? '要' : '不要'}寫「${note}」`);
        }
    }
});

// 指令裡的簡介照 projects.json 的 description 與 status 寫。這兩欄改了（例如過了 recheckAfter 重查之後），
// 這裡的雜湊就對不上：照新的內容改 task-catalog.mjs 的那一行，再把雜湊換成失敗訊息裡的新值
const REVIEWED_PROJECTS = {
    'disfactory': '3b6e67cdb09a',
    'cofacts': '3845286e9e7d',
    'amis-moedict': '3132eb3b1d27',
    'thaubing': '69cd2318d3aa',
    'national-treasure': '84de664b8b13',
    'lawtrace': '541a118afbb6',
    'vtaiwan': '61bcf0d56826',
    'civil-iot': 'e309baf94cce',
};

test('civic-tech-suggestion：projects.json 的 description 或 status 改了，指令那一行要跟著重看', () => {
    const { projects } = JSON.parse(readFileSync(new URL('../../public/civic-tech-map/projects.json', import.meta.url), 'utf8'));
    assert.deepEqual(Object.keys(REVIEWED_PROJECTS).sort(), projects.map(({ id }) => id).sort());
    for (const { id, status, description } of projects) {
        const hash = createHash('sha256').update(`${status}\n${description}`).digest('hex').slice(0, 12);
        assert.equal(hash, REVIEWED_PROJECTS[id], `${id} 的 description 或 status 改了：照著改 task-catalog.mjs 的指令，再把這裡的值換成 ${hash}`);
    }
});

test('learning-path：學習主題最多 100 字（頁面的輸入框同樣限制 100）；JSON 任務、不設溫度', () => {
    const task = catalog.get('learning-path');
    assert.equal(task.output.type, 'json');
    assert.equal(task.temperature, undefined);
    assert.equal(validateInput(task, { topic: '學'.repeat(100) }).topic.length, 100);
    assert.throws(() => validateInput(task, { topic: '學'.repeat(101) }), { code: 'invalid_input', field: 'topic' });
});

test('learning-path：剛好 4 個步驟，每步的四個欄位都要有內容；步驟編號不收', () => {
    const task = catalog.get('learning-path');
    const step = (n) => ({
        title: `步驟${n}`,
        description: '認識網頁的結構，知道資料放在哪裡。',
        resource_type: '線上課程',
        actionable_suggestion: '搜尋「HTML 入門」，跟著做一個簡單的網頁。',
    });
    const ok = { learning_path: [1, 2, 3, 4].map(step) };
    assert.deepEqual(finalizeOutput(task, JSON.stringify(ok)), ok);
    const withLast = (last) => ({ learning_path: [step(1), step(2), step(3), last] });
    const bad = {
        '只有 3 步': { learning_path: ok.learning_path.slice(0, 3) },
        '有 5 步': { learning_path: [...ok.learning_path, step(5)] },
        '帶了步驟編號': withLast({ ...step(4), step: 4 }),
        '多了規格外的屬性': { ...ok, extra: 'x' },
    };
    for (const field of Object.keys(step(4))) {
        const { [field]: _omitted, ...missing } = step(4);
        bad[`缺 ${field}`] = withLast(missing);
        bad[`${field} 是空字串`] = withLast({ ...step(4), [field]: '' });
        bad[`${field} 只有空白`] = withLast({ ...step(4), [field]: '  ' });
    }
    for (const [name, value] of Object.entries(bad)) {
        assert.throws(() => finalizeOutput(task, JSON.stringify(value)), { code: 'format' }, name);
    }
});

// maxLength 是硬截斷，長度要寫在指令裡，模型才不會寫到一半被切掉。指令寫的是「約」，模型可能
// 寫得比上限長一些，maxLength 至少留到上限的兩倍。
test('learning-path：指令要求剛好 4 個步驟、依先後排列（頁面照順序編號），每個欄位都寫了長度，maxLength 至少是上限的兩倍', () => {
    const { instructions, output } = catalog.get('learning-path');
    assert.match(instructions, /剛好 4 個步驟/);
    assert.match(instructions, /依學習的先後順序排列/);
    assert.match(instructions, /resource_type：[^\n]*簡短[^\n]*不要加說明/);
    const fields = output.schema.properties.learning_path.items.properties;
    for (const [name, { maxLength }] of Object.entries(fields)) {
        const upper = Number(instructions.match(new RegExp(`${name}：[^\\n]*約 \\d+～(\\d+) 字`))?.[1]);
        assert.ok(upper > 0, `指令沒寫 ${name} 的長度`);
        assert.ok(maxLength >= 2 * upper, `${name} 的 maxLength ${maxLength} 不到指令上限 ${upper} 字的兩倍`);
    }
});

test('topic-ideas：興趣關鍵字最多 100 字（頁面的輸入框同樣限制 100）', () => {
    const task = catalog.get('topic-ideas');
    assert.equal(validateInput(task, { interests: '旅'.repeat(100) }).interests.length, 100);
    assert.throws(() => validateInput(task, { interests: '旅'.repeat(101) }), { code: 'invalid_input', field: 'interests' });
});

test('topic-ideas：剛好 3 個主題，每個主題的五個欄位都要有，個數不符或空字串都不收', () => {
    const task = catalog.get('topic-ideas');
    const idea = {
        title: '旅行中的心理復原力',
        description: '探討自助旅行如何影響高中生的壓力調適。',
        methods: ['問卷調查', '深度訪談'],
        challenges: ['樣本不易取得。', '心理變化難以量化。'],
        keywords: ['心理復原力', '自我效能', '背包客'],
    };
    const most = { ...idea, methods: ['甲', '乙', '丙', '丁'], challenges: ['甲', '乙', '丙'], keywords: ['甲', '乙', '丙', '丁', '戊'] };
    for (const ok of [{ ideas: [idea, idea, idea] }, { ideas: [most, most, most] }]) {
        assert.deepEqual(finalizeOutput(task, JSON.stringify(ok)), ok);
    }
    const third = (changes) => ({ ideas: [idea, idea, { ...idea, ...changes }] });
    const { keywords, ...withoutKeywords } = idea;
    for (const bad of [
        { ideas: [idea, idea] },
        { ideas: [idea, idea, idea, idea] },
        third({ methods: ['問卷調查'] }),
        third({ methods: [...most.methods, '戊'] }),
        third({ challenges: ['樣本不易取得。'] }),
        third({ challenges: [...most.challenges, '丁'] }),
        third({ keywords: ['甲', '乙'] }),
        third({ keywords: [...most.keywords, '己'] }),
        third({ title: '' }),
        third({ description: ' ' }),
        third({ methods: ['問卷調查', ''] }),
        third({ challenges: ['樣本不易取得。', ''] }),
        third({ keywords: ['心理復原力', '自我效能', ' '] }),
        third({ extra: 'x' }),
        { ideas: [idea, idea, withoutKeywords] },
        { ideas: [idea, idea, idea], extra: 'x' },
    ]) {
        assert.throws(() => finalizeOutput(task, JSON.stringify(bad)), { code: 'format' });
    }
});

// 照指令寫的輸出要過得了 schema：個數一致，字數上限不超過 maxLength 的一半，因為 maxLength 是硬截斷。
test('topic-ideas：指令寫明每個欄位的字數，個數與 schema 一致', () => {
    const { instructions, output } = catalog.get('topic-ideas');
    const { ideas } = output.schema.properties;
    assert.match(instructions, new RegExp(`發想 ${ideas.minItems} 個`));
    assert.equal(ideas.minItems, ideas.maxItems);
    for (const [name, spec] of Object.entries(ideas.items.properties)) {
        const line = instructions.split('\n').find((l) => l.startsWith(`- ${name}：`)) ?? '';
        const words = /約 (\d+)～(\d+) 字/.exec(line);
        assert.ok(words, `${name} 沒寫字數`);
        const maxLength = spec.type === 'array' ? spec.items.maxLength : spec.maxLength;
        assert.ok(Number(words[2]) * 2 <= maxLength, `${name}：指令寫到 ${words[2]} 字，maxLength 是 ${maxLength}`);
        if (spec.type === 'array') assert.match(line, new RegExp(`${spec.minItems}～${spec.maxItems} [種個]`), name);
    }
    assert.match(instructions, /methods：[^\n]*不要加說明/);
    assert.match(instructions, /challenges：[^\n]*每個一句話/);
});
