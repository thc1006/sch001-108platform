/**
 * 正式上線的任務清單（task-catalog.mjs）：每個定義都過得了啟動時的檢查，各任務的輸入與輸出
 * 規格符合頁面的需要。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { TASK_DEFINITIONS } from '../src/task-catalog.mjs';
import { createCatalog, validateInput, buildMessages, finalizeOutput } from '../src/tasks.mjs';
import { loadServerConfig } from '../src/config.mjs';

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

// 閘道閒著時一個來源可以拿走全部名額，排隊的人要等到它的任務結束（見 limits.mjs）
test('starter-pack 的時限不超過 QUEUE_TIMEOUT_MS 的預設值：一個來源佔住全部名額時，排隊的人等得到', () => {
    const { timeoutMs } = catalog.get('starter-pack');
    assert.ok(Number.isInteger(timeoutMs));
    assert.ok(timeoutMs <= loadServerConfig({}).queueTimeoutMs, `timeoutMs=${timeoutMs}`);
});

// 時限從拿到名額就開始算，等第一個位元組的時間也在裡面。WinLab 忙的時候要等一兩分鐘（README 的
// 實測行為）；2026-10-22 在本機閘道同時送 4 個學習啟動包，生成最長 48.4 秒（思考 1873 tokens）。
test('starter-pack 的時限容得下 WinLab 忙的時候等 2 分鐘的第一個位元組，再加上實測最長的生成', () => {
    const { timeoutMs } = catalog.get('starter-pack');
    assert.ok(timeoutMs >= 120_000 + 48_400, `timeoutMs=${timeoutMs}`);
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
