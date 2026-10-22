/**
 * 輸出前的簡轉繁保險：把模型零星冒出的簡體字逐字換成台灣繁體字。
 *
 * 只換對照表裡「沒有歧義」的字（見 scripts/build-s2t-table.mjs）：一對多的字（發／髮、
 * 後／后）一律不碰，台灣本身就這樣寫的字（峰、床、群）也不在表裡，所以正確的繁體文字
 * 經過這裡不會被改動。逐字轉換，只有兩個字看前一個字：「拮据」的据（經濟窘迫，是正確的
 * 繁體字）不轉成「據」；么 只在「什么、怎么、这么、那么、多么、要么」這類詞裡轉成「麼」，
 * 老么、么女的么是台灣的正字，不轉。
 */
import { S2T_PAIRS } from './s2t-table.mjs';

const TABLE = new Map();
{
    const chars = [...S2T_PAIRS];
    for (let i = 0; i < chars.length; i += 2) TABLE.set(chars[i], chars[i + 1]);
}

// 這些字後面的「么」是簡體的「麼」（什么、怎么、這么、那么、多么、要么、甚么）
const MO_PREFIXES = new Set([...'什怎這这那多要甚']);

function convertChar(ch, previous) {
    if (ch === '据' && previous === '拮') return ch;
    if (ch === '么') return MO_PREFIXES.has(previous) ? '麼' : ch;
    return TABLE.get(ch) ?? ch;
}

/** 整段轉換 */
export function toTraditional(text) {
    let out = '';
    let previous = '';
    for (const ch of String(text)) {
        out += convertChar(ch, previous);
        previous = ch;
    }
    return out;
}

/**
 * 串流用：回傳一個逐段轉換的函式，記住上一段的最後一個字，「拮据」被切在兩段之間時也正確。
 * 結尾若是半個代理對（emoji 或罕用字被切開）先留著，下一段再一起轉；串流結束時呼叫
 * flush() 取回留下的部分。所有片段（含 flush）接起來，等於整段 toTraditional 的結果。
 */
export function createTraditionalStream() {
    let previous = '';
    let carry = '';
    const convert = (text) => {
        let input = carry + String(text);
        carry = '';
        const last = input.charCodeAt(input.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
            carry = input.slice(-1);
            input = input.slice(0, -1);
        }
        let out = '';
        for (const ch of input) {
            out += convertChar(ch, previous);
            previous = ch;
        }
        return out;
    };
    convert.flush = () => {
        const rest = carry;
        carry = '';
        return rest;
    };
    return convert;
}

/** 對照表大小（測試與 log 用） */
export const S2T_SIZE = TABLE.size;
