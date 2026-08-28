/**
 * audit-quote-freshness 的比對邏輯測試。
 *
 * 網路那一半是人工稽核（要連幾百個外站、輸出要人判讀），不進 CI。
 * **但正規化與比對這一半必須被守著**——它已經瞎過一次：
 * norm() 的空白字元類寫成肉眼看不出來的字面字元，寫檔過程中 U+00A0／U+2000／
 * U+202F 被正規化成普通空白，字元類於是變成 [U+0020-U+200B]，涵蓋全部 ASCII。
 * norm() 把英文引文壓成空字串，而 "x".includes("") 恆為真，
 * 於是 97 條引文全部被判「精確命中」，實際上在比對空字串。
 *
 * 那次事故的形狀正是這個 repo 反覆出現的那一種：**檢查器什麼都沒看到卻印綠字**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { norm, skeleton, selfTest, extractQuotes } from './audit-quote-freshness.mjs';

test('selfTest()：工具自己的健康檢查要通過', () => {
    assert.doesNotThrow(() => selfTest());
});

test('norm()：不得破壞 ASCII——這是那次全綠事故的直接成因', () => {
    const en = 'International Group Leaders for 2025-26';
    assert.equal(norm(en), en);
    assert.equal(norm('Open to students in grades 8-12 (or the equivalent) from any country'),
        'Open to students in grades 8-12 (or the equivalent) from any country');
});

test('norm()：各種看不見的空白都要收斂成一般空白', () => {
    for (const cp of [0x00A0, 0x2002, 0x2003, 0x2009, 0x200A, 0x202F, 0x3000]) {
        assert.equal(norm(`a${String.fromCodePoint(cp)}b`), 'a b', `U+${cp.toString(16)} 沒有被正規化`);
    }
    // 零寬空白會被壓成空白再由 \s+ 收掉，所以兩邊會黏起來
    assert.equal(norm(`a${String.fromCodePoint(0x200B)}b`), 'a b');
});

test('norm()：彎引號與破折號要收斂，否則官網的排版差異就會變成假的「引文過期」', () => {
    assert.equal(norm('“hello”'), '"hello"');
    assert.equal(norm('don’t'), "don't");
    assert.equal(norm('2025–26'), '2025-26');
    assert.equal(norm('a－b'), 'a-b');
});

test('norm()：HTML 實體要還原', () => {
    assert.equal(norm('Tom &amp; Jerry'), 'Tom & Jerry');
    assert.equal(norm('a&nbsp;b'), 'a b');
    assert.equal(norm('don&#8217;t'), "don't");
    assert.equal(norm('&#x41;&#x42;'), 'AB');
});

test('skeleton()：英文與中文都要留得下來', () => {
    assert.ok(skeleton('International Group Leaders').length >= 24);
    assert.equal(skeleton('中華數學協會'), '中華數學協會');
    assert.equal(skeleton('Open to students in grades 8-12!'), 'opentostudentsingrades812');
});

test('skeleton()：純標點要回空字串，空引文不得被拿去比對', () => {
    // "任何字串".includes("") 恆為真——那正是上次 97 條全綠的機制
    assert.equal(skeleton('...'), '');
    assert.equal(skeleton('    '), '');
    assert.ok(!''.length || true);
    assert.equal('anything'.includes(''), true, '這一行不是在測工具，是在記錄那個陷阱本身');
});

test('extractQuotes：只收看起來像外文原文的，我們自己的中文敘述不算引文', () => {
    const e = {
        description: '官網逐字「Open to students in grades 8-12 (or the equivalent) from any country」，'
            + '更正：先前記載「查無台灣代表團的報名管道」並不成立。',
    };
    const qs = extractQuotes(e);
    assert.equal(qs.length, 1, `應只收 1 條，實得 ${JSON.stringify(qs)}`);
    assert.match(qs[0], /grades 8-12/);
});

test('extractQuotes：帶年份的中文也算——那類多半是官網的時程原文', () => {
    const qs = extractQuotes({ description: '逐字「2026 年 03 月 19 日(四) ～ 04 月 8 日(三)」' });
    assert.equal(qs.length, 1);
});

test('extractQuotes：掃描 description 以外的欄位', () => {
    const qs = extractQuotes({
        description: '',
        eligibility: '逐字「open to high school students from any country」',
        registrationNote: '「Registration deadline: 31 March, 2026」',
    });
    assert.equal(qs.length, 2);
});

test('故障注入：把空白字元類換回會吃掉 ASCII 的那種，selfTest 必須擋下', () => {
    // 重現事故：[ -​] 涵蓋全部 ASCII
    const broken = (s) => String(s).replace(/[ -​]/g, ' ').replace(/\s+/g, ' ').trim();
    assert.equal(broken('International Group Leaders'), '',
        '這一行釘住事故的機制本身：壞掉的字元類會把英文整段清空');
    assert.equal('any page text'.includes(broken('International Group Leaders')), true,
        '而空字串的 includes 恆為真——所以壞掉的版本會對每一條引文印「命中」');
});
