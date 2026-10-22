#!/usr/bin/env node
/**
 * 產生 ai-gateway/src/s2t-table.mjs：簡體字 → 台灣繁體字的逐字對照，只收沒有歧義的字。
 *
 * 為什麼需要：WinLab 的模型在不思考（reasoning_effort none）的輪次寫長文時，會零星冒出
 * 簡體字（活體測試看到「阶段」「数据收集」「萬钧」「应对」）。提示詞再怎麼提醒也擋不乾淨，
 * 閘道在送出前逐字轉換一次是最後一道保險。
 *
 * 只收「一個簡體字只對應一個繁體字」的條目：發／髮、後／后、臺／台這類一對多的字，逐字轉換
 * 一定會在某些詞裡轉錯（頭发 → 頭發），寧可不轉。另外：
 *   - 套用 OpenCC 的 TWVariants，轉成台灣的字形（为 → 為，不是 爲）；套用後與原字相同的
 *     條目（峰、床、群、灶、痴、秘、粽：台灣本來就這樣寫）自動剔除
 *   - EXCLUDE：在台灣本身就是合法常用字的，不轉（例：苧麻的苧、菜肴的肴、倒霉的霉、南庄鄉的庄、
 *     教育部標準字的晒、陶坏的坏）。么 也在這裡：老么、么女的么是正字，「什么」的么由 s2t.mjs
 *     依前一個字轉換
 *   - CURATED：一對多但台灣幾乎只用一種寫法的，指定轉法（证 → 證、确 → 確、据 → 據、适 → 適、个 → 個；
 *     「拮据」的据由 s2t.mjs 例外處理）
 *
 * 資料來源固定在 OpenCC 的一個 commit（見 SOURCE），檔案先手動下載再交給本腳本，
 * 本腳本不連網：
 *   curl -o STCharacters.txt https://raw.githubusercontent.com/BYVoid/OpenCC/<commit>/data/dictionary/STCharacters.txt
 *   curl -o TWVariants.txt  https://raw.githubusercontent.com/BYVoid/OpenCC/<commit>/data/dictionary/TWVariants.txt
 *   node ai-gateway/scripts/build-s2t-table.mjs STCharacters.txt TWVariants.txt > ai-gateway/src/s2t-table.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const SOURCE = {
    repo: 'https://github.com/BYVoid/OpenCC',
    commit: '178f05dbc5dbcedd09d4ab39d501094f4d9d8820',
    files: ['data/dictionary/STCharacters.txt', 'data/dictionary/TWVariants.txt'],
};

// 在台灣本身就是合法常用字：轉了反而改壞正確的繁體文字
const EXCLUDE = new Set([...'肴霉苧沄蒏蔂庄晒坏么']);
// 一對多、但台灣幾乎只用第一種寫法的字。适 的另一個對應是同形的古字（音 kuò，只見於古人名），
// 現代文字裡的「适」都是「適」（适合、舒适）；个 的另一個對應「箇」只見於「箇中」這類文言用法
const CURATED = new Map([['证', '證'], ['确', '確'], ['据', '據'], ['适', '適'], ['个', '個']]);

function parse(file) {
    const entries = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const [key, values] = line.split('\t');
        if (!values) continue;
        entries.push([key, values.trim().split(' ')]);
    }
    return entries;
}

const [stFile, twFile] = process.argv.slice(2);
if (!stFile || !twFile) {
    console.error('用法：node build-s2t-table.mjs <STCharacters.txt> <TWVariants.txt>');
    process.exit(1);
}

const twVariant = new Map();
for (const [key, values] of parse(twFile)) {
    if ([...key].length === 1 && [...values[0]].length === 1) twVariant.set(key, values[0]);
}

const table = new Map();
for (const [key, values] of parse(stFile)) {
    if ([...key].length !== 1 || values.length !== 1) continue;
    const target = twVariant.get(values[0]) ?? values[0];
    if (target === key || EXCLUDE.has(key)) continue;
    table.set(key, target);
}
for (const [key, target] of CURATED) table.set(key, target);

const pairs = [...table].sort(([a], [b]) => a.codePointAt(0) - b.codePointAt(0)).map(([k, v]) => k + v).join('');
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

process.stdout.write(`/**
 * 簡體字 → 台灣繁體字的逐字對照（只收沒有歧義的字），共 ${table.size} 組。
 * 由 ai-gateway/scripts/build-s2t-table.mjs 產生，不要手動修改。
 *
 * 衍生自 OpenCC（${SOURCE.repo}）commit ${SOURCE.commit}：
 *   ${SOURCE.files[0]}（sha256 ${sha(stFile)}）
 *   ${SOURCE.files[1]}（sha256 ${sha(twFile)}）
 * 授權：Apache License 2.0，全文見 ai-gateway/licenses/OpenCC-LICENSE.txt。
 * 修改：只取一對一的條目、套用 TWVariants、排除 ${[...EXCLUDE].join('')}、另指定 ${[...CURATED].map(([k, v]) => k + '→' + v).join('、')}。
 */
export const S2T_PAIRS = '${pairs}';
`);
