/**
 * 「看得見的字」的判斷（visible-text.mjs）：輸入與輸出的驗證共用，兩端對同一個字要得到同樣的結論。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hasVisibleText } from '../src/visible-text.mjs';
import { defineTask, validateInput } from '../src/tasks.mjs';

// 特殊字元一律用 code point 產生：原始碼裡不出現看不見的字元，也不怕編輯工具把跳脫序列轉成實際字元
const cp = (...points) => String.fromCodePoint(...points);
const hex = (text) => [...text].map((ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ') || '（空字串）';

test('hasVisibleText：空白、控制字元、格式字元、預設可忽略的字元都不算', () => {
    const blanks = [
        '', ' \n\t', cp(0x3000), cp(0x00A0), cp(0x1680),
        cp(0x0007), cp(0x0085),
        cp(0x200B), cp(0x2060), cp(0xFEFF), cp(0x00AD), cp(0xFFF9), cp(0xE0041, 0xE007F),
        // 韓文填充字屬於字母，但是預設可忽略
        cp(0x3164), cp(0x115F), cp(0xFFA0),
        cp(0x200D), cp(0xFE0F), cp(0x200B, 0xFEFF, 0x20, 0x0A),
    ];
    for (const text of blanks) assert.equal(hasVisibleText(text), false, hex(text));
});

test('hasVisibleText：點字空白、物件替代字元、單獨的組合符號、私用區、未指派的 code point、孤立的代理都不算', () => {
    for (const text of [cp(0x2800), cp(0xFFFC), cp(0x2800, 0xFFFC), cp(0x0301), cp(0x20E3), cp(0xE000), cp(0x0378), cp(0xD83D), cp(0x16FE4)]) {
        assert.equal(hasVisibleText(text), false, hex(text));
    }
});

test('hasVisibleText：有一個字母、數字、標點或符號就算；表情符號組合、夾著零寬字元的字都算', () => {
    const visibles = [
        'a', '1', '。', '∑', 'ㄅ', cp(0xFFFD),
        '😀', `👩${cp(0x200D)}💻`, `❤${cp(0xFE0F)}`, `1${cp(0xFE0F, 0x20E3)}`, '🇹🇼',
        `a${cp(0x200B)}b`, `${cp(0x200B)}答${cp(0x200B)}`, `e${cp(0x0301)}`, `${cp(0x2800)}有字`,
    ];
    for (const text of visibles) assert.equal(hasVisibleText(text), true, hex(text));
});

// 輸出端直接判斷原文，輸入端先清掉看不見的字元再判斷。兩端對每個字的結論要相同，
// 否則同一個字，學生寫的會被擋下，模型寫的卻收下（或反過來）。
test('hasVisibleText：每個 code point 的結論都跟輸入端 validateInput 收不收相同', () => {
    const task = defineTask({ id: 'visible', input: { text: { label: '文字', maxLength: 10 } }, output: { type: 'markdown' }, instructions: '做事' });
    const accepted = (text) => {
        try {
            validateInput(task, { text });
            return true;
        } catch (err) {
            if (err.message !== '請填寫文字') throw err;
            return false;
        }
    };
    // BMP 全部，加上星號平面裡有格式字元、預設可忽略的字元、表情符號、私用區的幾段
    const ranges = [
        [0x0000, 0xFFFF], [0x16FE0, 0x16FFF], [0x1BCA0, 0x1BCA3], [0x1D100, 0x1D1FF], [0x1F1E6, 0x1F1FF],
        [0x1F300, 0x1F6FF], [0xE0000, 0xE0FFF], [0xF0000, 0xF00FF], [0x10FFF0, 0x10FFFF],
    ];
    const mismatches = [];
    for (const [from, to] of ranges) {
        for (let point = from; point <= to; point++) {
            if (hasVisibleText(cp(point)) !== accepted(cp(point))) mismatches.push(cp(point));
        }
    }
    assert.equal(mismatches.length, 0, `結論不同的字（前 20 個）：${mismatches.slice(0, 20).map(hex).join('、')}`);
});
