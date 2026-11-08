/**
 * 輸出前的簡轉繁保險：把模型零星冒出的簡體字換成台灣繁體字。
 *
 * 只改正確的繁體文字裡不會出現的東西，所以正確的繁體文字經過這裡不會被改動：
 *
 * 逐字對照（s2t-table.mjs）只收沒有歧義的字：一對多的字（發／髮、後／后）不在表裡，台灣本身就這樣
 * 寫的字（峰、床、群）也不在。只有兩個字看前一個字：「拮据」的据（經濟窘迫，是正確的繁體字）
 * 不轉成「據」；么 只在「什么、怎么、这么、那么、多么、要么」這類詞裡轉成「麼」，老么、么女的么
 * 是台灣的正字，不轉。
 *
 * 一對多的字靠詞組（s2t-phrases.mjs）：從左到右取最長的詞（头发 → 頭髮、后来 → 後來），比對時
 * 一對一的字簡繁都算（团隊 對得上 团队）。PHRASES 只在比對到的那段原文有簡體專用字時套用；
 * CURATED 是寫成繁體也不成詞的（干部、最后），整句（到句尾，最多 50 個字）有簡體專用字時才套用。都只改原文和鍵同一個字
 * 的位置。擋詞（皇后、若干）只佔位置不改字。沒有詞組命中的一對多字，只有 S2T_DEFAULTS 的字
 * 有預設轉法。
 */
import { createConverter } from './s2t-core.mjs';
import { S2T_PAIRS } from './s2t-table.mjs';
import { S2T_CURATED, S2T_DEFAULTS, S2T_GUARDS, S2T_PHRASES, S2T_SIMPLIFIED, S2T_TABLE_TRADITIONAL } from './s2t-phrases.mjs';

const pairs = (text) => {
    const chars = [...text];
    const out = [];
    for (let i = 0; i < chars.length; i += 2) out.push([chars[i], chars[i + 1]]);
    return out;
};
// 「鍵轉法」以空白分隔，鍵和轉法一樣長
const entries = (text) => text.split(' ').filter(Boolean).map((entry) => {
    const chars = [...entry];
    return [chars.slice(0, chars.length / 2).join(''), chars.slice(chars.length / 2).join('')];
});

const TABLE = pairs(S2T_PAIRS);
// 簡體專用字：逐字對照的鍵扣掉也當繁體字用的，加上一對多的簡體專用字
const SIMPLIFIED = new Set([...TABLE.map(([key]) => key).filter((ch) => !S2T_TABLE_TRADITIONAL.includes(ch)), ...S2T_SIMPLIFIED]);

export const { toTraditional, createTraditionalStream } = createConverter({
    pairs: TABLE,
    defaults: pairs(S2T_DEFAULTS),
    phrases: entries(S2T_PHRASES),
    curated: entries(S2T_CURATED),
    guards: S2T_GUARDS.split(' ').filter(Boolean),
    simplified: SIMPLIFIED,
});

/** 逐字對照的大小（測試與 log 用） */
export const S2T_SIZE = TABLE.length;
