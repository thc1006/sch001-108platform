#!/usr/bin/env node
/**
 * 產生 ai-gateway/src/s2t-phrases.mjs：逐字對照（s2t-table.mjs）不轉的一對多簡體字，靠詞組決定
 * 轉法（头发 → 頭髮、后来 → 後來、干部 → 幹部）。
 *
 * 原則跟逐字對照一樣：正確的台灣繁體文字一個字都不能被改動。
 *   - 簡體專用字：STCharacters 的鍵，但不出現在任何條目的繁體那一側、TWVariants 裡，也不是逐字對照
 *     刻意不轉的台灣正字（庄、晒）。正確的繁體文字不會有這種字
 *   - PHRASES：取自 OpenCC 的 STPhrases，只收含簡體專用字、轉法和逐字對照不同的詞。s2t.mjs 只在
 *     比對到的那段原文真的有簡體專用字時才套用
 *   - CURATED：寫成繁體也不成詞、跟前後的字也湊不成繁體詞的 STPhrases 詞（干部、規划、最后），整句有
 *     簡體專用字時套用。例如回答寫「熱音社干部與成果发表會」，干部 兩個字本身都是繁體也用的字。
 *     联系 不收：「關聯系統」裡就有 聯系
 *   - DEFAULTS：一對多的簡體專用字沒有詞組命中時的轉法。只挑另一種寫法只出現在固定詞裡的字（髮：头发；
 *     糰：饭团；噹：叮当；併：合并），那些詞由 PHRASES 處理。簡體專用字不會出現在繁體文字裡，預設轉法
 *     改不到繁體文字
 *   - GUARDS：轉法和逐字對照相同、但和 PHRASES 重疊的 STPhrases 詞（皇后、若干），加上 GUARD_WORDS。
 *     最長的詞先贏，「皇后来了」才不會變成「皇後來了」。擋詞不改字
 *   - 換過的字套用 TWVariants；原字在台灣也正確的維持原字（KEEP）；計劃 改成台灣常用的 計畫；
 *     OVERRIDE 的詞照台灣的用法；REJECT 的詞不收
 *   - 拆成較短的詞或預設轉法就轉得對、也沒有別的詞從它中間接出去的詞不收，表比較小
 *
 * 跟 build-s2t-table.mjs 一樣不連網，資料來源固定在同一個 OpenCC commit：
 *   curl -o STPhrases.txt https://raw.githubusercontent.com/BYVoid/OpenCC/<commit>/data/dictionary/STPhrases.txt
 *   node ai-gateway/scripts/build-s2t-phrases.mjs STCharacters.txt TWVariants.txt STPhrases.txt > ai-gateway/src/s2t-phrases.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { createConverter } from '../src/s2t-core.mjs';
import { S2T_PAIRS } from '../src/s2t-table.mjs';

const SOURCE = {
    repo: 'https://github.com/BYVoid/OpenCC',
    commit: '178f05dbc5dbcedd09d4ab39d501094f4d9d8820',
    files: ['data/dictionary/STCharacters.txt', 'data/dictionary/TWVariants.txt', 'data/dictionary/STPhrases.txt'],
};

const DEFAULTS = new Map(Object.entries({
    发: '發', 团: '團', 当: '當', 并: '並', 别: '別', 参: '參', 录: '錄', 术: '術', 药: '藥', 获: '獲', 恶: '惡', 摆: '擺',
    历: '歷', 须: '須', 坛: '壇', 纤: '纖', 针: '針', 弥: '彌', 枪: '槍', 苏: '蘇', 链: '鏈', 闲: '閒', 鉴: '鑑', 夹: '夾',
}));
// 回答裡看過的（2026-11-05、11-08 的量測）
const CURATED = new Set(['干部', '规划', '计划', '准备', '随后', '最后', '之后', '以后', '然后', '后来', '后面']);
// OpenCC 換成另一個字、但原字在台灣也是正確寫法的（台灣、櫃台、發布、念書、占領、弦樂），維持原字
const KEEP = new Map(Object.entries({
    台: '臺檯', 布: '佈', 念: '唸', 占: '佔', 弦: '絃', 折: '摺', 升: '昇', 背: '揹', 夫: '伕',
    坐: '座', 彩: '綵', 周: '週', 巨: '鉅', 杰: '傑', 岩: '巖', 修: '脩', 挨: '捱', 玩: '翫', 凶: '兇',
}));
// 把繁體文字轉成簡體再轉回來（站上內容與 2026 年 10–11 月的調研資料，約 1800 萬字）時，切錯詞的次數
// 不比轉對少的：这只是、别只看、一个中文字、核对准考证、考试制度、校系数、学生发表、成长历程、
// 并发布、互相冲突。扎实、回归 台灣通常照原字寫
const REJECT = new Set([
    '这只', '别只', '单只', '个中', '个旧', '对表', '喜欢表', '旧表', '码表', '马表', '科学面', '凭准', '长胡',
    '试制', '制为', '改制为', '轮回', '回銮', '云阳', '系数', '系为', '系个', '系怀', '系条', '系带', '系结', '系获',
    '对准', '电表', '评注', '松开', '扎实', '扎扎实实', '稳扎', '稳扎稳打', '回归',
    '生发', '理发', '养发', '括发', '金发', '长发', '落发', '换发', '发结', '发卡', '长历', '年历', '国历', '国历年',
    '大历', '商历', '长须', '拔须', '并发', '并为', '并产', '并兼', '并合', '并叠', '交并', '购并', '并购买',
    '行复', '不复', '开复', '明复', '相冲', '对冲', '根烟', '上签', '先尝', '断发', '发长', '认准',
]);
// 一定當擋詞的詞：头发 前面常接的詞（口头发表、回头发现、开头发言）；后 結尾、STPhrases 沒收的稱號
// （視后來台、棋后面對）；相关系所、有关系统 的 系 不跟前面湊成 关系；强调制度、六年制药学系、
// 转换只用、开车里程 不切成 调制、制药、换只、车里
const GUARD_WORDS = ['口头', '带头', '回头', '开头', '镜头', '码头', '念头', '源头', '街头', '心头', '关头', '尽头',
    '里头', '外头', '上头', '起头', '苗头', '势头', '年头', '风头', '舌头', '额头', '眉头', '骨头', '拳头',
    '视后', '棋后', '拳后', '相关', '有关系统', '强调', '年制', '转换', '开车'];
// 台灣的用法跟 OpenCC 不同的詞
const OVERRIDE = new Map([['申复', '申復']]);

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

const [stFile, twFile, phraseFile] = process.argv.slice(2);
if (!stFile || !twFile || !phraseFile) {
    console.error('用法：node build-s2t-phrases.mjs <STCharacters.txt> <TWVariants.txt> <STPhrases.txt>');
    process.exit(1);
}
const fail = (message) => {
    console.error(message);
    process.exit(1);
};

const pairs = [];
{
    const chars = [...S2T_PAIRS];
    for (let i = 0; i < chars.length; i += 2) pairs.push([chars[i], chars[i + 1]]);
}
const table = new Map(pairs);
const characters = parse(stFile);
const variants = parse(twFile);
const twVariant = new Map();
for (const [key, values] of variants) {
    if ([...key].length === 1 && [...values[0]].length === 1) twVariant.set(key, values[0]);
}

// 繁體那一側出現過的字，加上逐字對照刻意不轉的一對一鍵（庄、晒），都可能出現在正確的繁體文字裡
const traditional = new Set();
for (const [, values] of [...characters, ...variants]) for (const value of values) for (const ch of value) traditional.add(ch);
for (const [key, values] of characters) if (values.length === 1 && !table.has(key)) traditional.add(key);
const simplifiedOnly = new Set(characters.map(([key]) => key).filter((key) => !traditional.has(key)));
const readings = new Map(characters);
for (const [ch, value] of DEFAULTS) {
    if (!simplifiedOnly.has(ch) || table.has(ch) || !readings.get(ch).includes(value)) fail(`DEFAULTS 的 ${ch}→${value} 不是一對多的簡體專用字`);
}

const baseline = (key) => [...key].map((ch) => table.get(ch) ?? DEFAULTS.get(ch) ?? ch).join('');
const target = (key, value) => {
    const k = [...key];
    // TWVariants 只套在換過的字上，跟逐字對照一樣
    return [...value].map((ch, i) => (ch === k[i] || KEEP.get(k[i])?.includes(ch) ? k[i] : twVariant.get(ch) ?? ch)).join('').replaceAll('計劃', '計畫');
};
const hasSimplified = (key) => [...key].some((ch) => simplifiedOnly.has(ch));

const curated = new Map();
const candidates = new Map();
const others = new Map();
for (const [key, values] of parse(phraseFile)) {
    if ([...key].length !== [...values[0]].length || REJECT.has(key) || candidates.has(key) || others.has(key) || curated.has(key)) continue;
    const value = OVERRIDE.get(key) ?? target(key, values[0]);
    if (CURATED.has(key)) curated.set(key, value);
    else if (value !== baseline(key) && hasSimplified(key)) candidates.set(key, value);
    else others.set(key, value);
}
for (const key of CURATED) if (!curated.has(key)) fail(`CURATED 的 ${key} 不在 STPhrases 裡`);

// 跟 s2t-core.mjs 的 norm 相同
const norm = (s) => [...s].map((ch) => table.get(ch) ?? DEFAULTS.get(ch) ?? ch);
const converter = (phrases, guards = []) => createConverter({
    pairs,
    defaults: [...DEFAULTS],
    phrases: [...phrases],
    curated: [...curated],
    guards,
    simplified: simplifiedOnly,
});

// 有別的詞從它中間開始、接到它後面去：拿掉它，那個詞就會接出去
const properPrefixes = new Set();
for (const key of [...candidates.keys(), ...curated.keys()]) {
    const k = norm(key);
    for (let len = 1; len < k.length; len++) properPrefixes.add(k.slice(0, len).join(''));
}
const reachedInto = (key) => {
    const k = norm(key);
    for (let j = 1; j < k.length; j++) if (properPrefixes.has(k.slice(j).join(''))) return true;
    return false;
};

// 由短到長：一個詞拆開後轉得對不對，只看比它短的詞
const kept = new Map();
const byLength = [...candidates].sort(([a], [b]) => [...a].length - [...b].length);
for (let start = 0; start < byLength.length;) {
    const length = [...byLength[start][0]].length;
    let end = start;
    while (end < byLength.length && [...byLength[end][0]].length === length) end++;
    const { toTraditional } = converter(kept);
    for (const [key, value] of byLength.slice(start, end)) {
        if (toTraditional(key) !== value || reachedInto(key)) kept.set(key, value);
    }
    start = end;
}

// 擋詞：有收進來的詞從它中間開始（或從同一個位置開始但比它短），而且會把它範圍內的字轉得跟它不同
function findGuards() {
    const byPrefix = new Map();
    for (const [key, value] of [...kept, ...curated]) {
        const k = norm(key);
        for (let len = 1; len <= k.length; len++) {
            const prefix = k.slice(0, len).join('');
            if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
            byPrefix.get(prefix).push([k, [...value]]);
        }
    }
    const guarded = (key, value) => {
        const k = norm(key);
        const v = [...value];
        for (let j = 0; j < k.length; j++) {
            const rest = k.slice(j);
            // 從 j 開始、比它剩下的部分長
            for (const [pk, pv] of byPrefix.get(rest.join('')) ?? []) {
                if (j === 0 && pk.length <= k.length) continue;
                if (pv.some((ch, t) => j + t < k.length && ch !== v[j + t])) return true;
            }
            // 從 j 開始、整個落在它裡面
            for (let len = 1; len <= rest.length; len++) {
                if (j === 0 && len === k.length) break;
                for (const [pk, pv] of byPrefix.get(rest.slice(0, len).join('')) ?? []) {
                    if (pk.length === len && pv.some((ch, t) => ch !== v[j + t])) return true;
                }
            }
        }
        return false;
    };
    const found = [...others].filter(([key, value]) => value === baseline(key) && guarded(key, value)).map(([key]) => key);
    return [...new Set([...found, ...GUARD_WORDS])];
}

// 加上擋詞後再驗一次：轉錯的詞收回來，直到全部轉對
let guards = findGuards();
for (;;) {
    const { toTraditional } = converter(kept, guards);
    const wrong = [...candidates].filter(([key, value]) => !kept.has(key) && toTraditional(key) !== value);
    if (wrong.length === 0) break;
    for (const [key, value] of wrong) kept.set(key, value);
    guards = findGuards();
}
{
    const { toTraditional } = converter(kept, guards);
    const wrong = [...kept].filter(([key, value]) => toTraditional(key) !== value);
    if (wrong.length) fail(`收進來的詞轉不對：${wrong.slice(0, 10).join('、')}`);
}

const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const list = (map) => [...map].sort(([a], [b]) => byCode(a, b)).map(([k, v]) => k + v).join(' ');
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

process.stdout.write(`/**
 * 簡體詞組 → 台灣繁體的對照：詞組 ${kept.size} 條、CURATED ${curated.size} 條、擋詞 ${guards.length} 條、預設轉法 ${DEFAULTS.size} 個字。
 * 由 ai-gateway/scripts/build-s2t-phrases.mjs 產生，不要手動修改。
 *
 * 衍生自 OpenCC（${SOURCE.repo}）commit ${SOURCE.commit}：
 *   ${SOURCE.files[0]}（sha256 ${sha(stFile)}）
 *   ${SOURCE.files[1]}（sha256 ${sha(twFile)}）
 *   ${SOURCE.files[2]}（sha256 ${sha(phraseFile)}）
 * 授權：Apache License 2.0，全文見 ai-gateway/licenses/OpenCC-LICENSE.txt。
 * 修改：STPhrases 只取含簡體專用字、轉法與逐字對照不同、拆開會轉錯的詞，另取與它們重疊的詞當擋詞；
 * 換過的字套用 TWVariants；${[...KEEP].map(([k, v]) => k + '（' + v + '）').join('')}維持原字，計劃 改成 計畫；
 * ${[...OVERRIDE].map(([k, v]) => k + ' 轉成 ' + v).join('、')}；不收 ${[...REJECT].join('、')}；
 * 另加擋詞 ${GUARD_WORDS.join('、')}；
 * 指定 ${[...CURATED].join('、')} 在整句有簡體字時轉換；
 * 一對多字的預設轉法 ${[...DEFAULTS].map(([k, v]) => k + '→' + v).join('、')}。
 */
export const S2T_PHRASES = '${list(kept)}';
export const S2T_CURATED = '${list(curated)}';
export const S2T_GUARDS = '${guards.sort(byCode).join(' ')}';
export const S2T_DEFAULTS = '${[...DEFAULTS].map(([k, v]) => k + v).join('')}';
export const S2T_SIMPLIFIED = '${[...simplifiedOnly].filter((ch) => !table.has(ch)).sort(byCode).join('')}';
export const S2T_TABLE_TRADITIONAL = '${[...table.keys()].filter((ch) => !simplifiedOnly.has(ch)).sort(byCode).join('')}';
`);
