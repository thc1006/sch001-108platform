/**
 * 簡轉繁保險：活體測試看到的簡體字都要轉到；正確的繁體文字（含一對多、台灣標準字）
 * 一個字都不能被改動；串流逐段轉換與整段轉換逐字相同。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toTraditional, createTraditionalStream, S2T_SIZE } from '../src/s2t.mjs';
import { S2T_PAIRS } from '../src/s2t-table.mjs';

test('活體測試中出現過的簡體字都會被轉成台灣繁體', () => {
    assert.equal(toTraditional('每兩週產出阶段性報告'), '每兩週產出階段性報告');
    assert.equal(toTraditional('数据收集：选取五首经典乐曲'), '數據收集：選取五首經典樂曲');
    assert.equal(toTraditional('靜默自有其萬钧之力'), '靜默自有其萬鈞之力');
    assert.equal(toTraditional('是应对學測的重要加分項'), '是應對學測的重要加分項');
    assert.equal(toTraditional('相关係數'), '相關係數');
});

test('一對多、但台灣幾乎只用一種寫法的字照指定轉法：证、确、据、适、个', () => {
    assert.equal(toTraditional('证据确实，这个方法很适合'), '證據確實，這個方法很適合');
});

test('轉成台灣字形（為、偽、眾），不是 OpenCC 預設的爲、僞、衆', () => {
    assert.equal(toTraditional('为了避免伪造，众人'), '為了避免偽造，眾人');
});

test('正確的繁體文字原樣保留：一對多的字、台灣標準字、容易誤轉的詞一個都不動', () => {
    const traditional = [
        '台灣的高中生在自主學習時，應該先確認研究問題，再依據資料做分析。',
        '發展、頭髮、後來、皇后、裡面、公里、乾淨、幹部、干擾、系統、關係、只是、一隻、',
        '麵條、表面、復習、複雜、歷史、日曆、準備、批准、製造、制度、範圍、姓范、雲朵、',
        '人云亦云、拮据、峰會、起床、群組、爐灶、祕密、秘密、白痴、苧麻、菜肴、倒霉、粽子。',
    ].join('');
    assert.equal(toTraditional(traditional), traditional);
});

test('「拮据」的据不轉，其他的据照轉', () => {
    assert.equal(toTraditional('手頭拮据，根据数据'), '手頭拮据，根據數據');
});

// 庄（南庄鄉、客庄）、晒、坏（陶坏）、么（老么、么女）在台灣都是正字，對照表若照 OpenCC 轉成
// 莊、曬、壞、麼，會把正確的繁體文字改壞；代價是模型偶爾寫出的簡體 庄、晒、坏 不會被轉
test('台灣的正字不轉：庄、晒、坏、么（老么、么女）；旁邊的簡體字照轉', () => {
    const traditional = '家中老么、么女，苗栗縣南庄鄉、客庄，晒太陽，陶坏。';
    assert.equal(toTraditional(traditional), traditional);
    assert.equal(toTraditional('家中老么、么女，苗栗县南庄乡、客庄，晒太阳，陶坏。'), traditional);
});

test('么 看前一個字：什么、怎么、这么、那么、多么、要么 轉成麼；老么、么女的么不轉', () => {
    assert.equal(toTraditional('什么、怎么、这么、那么、多么、要么'), '什麼、怎麼、這麼、那麼、多麼、要麼');
    // 簡繁混用（前一個字已經是繁體）、甚么 也一樣
    assert.equal(toTraditional('這么、甚么'), '這麼、甚麼');
    // 前一個字不在清單裡，或前面是標點、換行、開頭：不轉
    assert.equal(toTraditional('么女、老么、\n么、么'), '么女、老么、\n么、么');
    // 冪等：轉過的再轉一次不變
    const once = toTraditional('什么是自主学习？怎么开始？');
    assert.equal(once, '什麼是自主學習？怎麼開始？');
    assert.equal(toTraditional(once), once);
});

test('轉換是冪等的：轉過的再轉一次不變', () => {
    const once = toTraditional('这是一个关于学习计划的问题，们应该认真对待。');
    assert.equal(toTraditional(once), once);
});

test('英數、標點、emoji 原樣保留', () => {
    const text = 'Python 3.12 & JSON {"a": 1} 😀👍🏽 ——「」';
    assert.equal(toTraditional(text), text);
});

test('串流逐段轉換＝整段轉換：任意切法（含拮据、么跨段，emoji 被切成兩半）', () => {
    const text = '手頭拮据。这是数据😀与𫛚的测试，们应该关注。什么、老么、怎么办？';
    const units = text.split(''); // 以 UTF-16 code unit 切，故意把代理對切開
    for (let seed = 1; seed <= 200; seed++) {
        let s = seed;
        const rand = () => {
            s = (s * 1103515245 + 12345) % 2 ** 31;
            return s / 2 ** 31;
        };
        const pieces = [];
        for (let i = 0; i < units.length;) {
            const size = 1 + Math.floor(rand() * 4);
            pieces.push(units.slice(i, i + size).join(''));
            i += size;
        }
        const convert = createTraditionalStream();
        const streamed = pieces.map(convert).join('') + convert.flush();
        assert.equal(streamed, toTraditional(text), `seed ${seed}: ${JSON.stringify(pieces)}`);
    }
});

test('串流：拮 與 据 分在兩段時仍保留', () => {
    const convert = createTraditionalStream();
    assert.equal(convert('手頭拮') + convert('据'), '手頭拮据');
});

test('串流：么 與前一個字分在兩段時，判斷與整段轉換相同（什|么 轉成麼、老|么 不轉）', () => {
    const cases = [['什', '么', '什麼'], ['怎', '么', '怎麼'], ['这', '么', '這麼'], ['老', '么', '老么']];
    for (const [first, second, expected] of cases) {
        const convert = createTraditionalStream();
        const streamed = convert(first) + convert(second) + convert.flush();
        assert.equal(streamed, expected);
        assert.equal(streamed, toTraditional(first + second));
    }
    // 一整段話在每一個位置切成兩段，結果都與整段轉換相同
    const text = '怎么办？家中老么也要学习，什么时候开始？';
    assert.equal(toTraditional(text), '怎麼辦？家中老么也要學習，什麼時候開始？');
    for (let cut = 0; cut <= text.length; cut++) {
        const convert = createTraditionalStream();
        const streamed = convert(text.slice(0, cut)) + convert(text.slice(cut)) + convert.flush();
        assert.equal(streamed, toTraditional(text), `切在第 ${cut} 個字`);
    }
});

test('對照表的完整性：一對一、沒有對到自己、沒有串連（轉出來的字不會再被轉）', () => {
    const chars = [...S2T_PAIRS];
    assert.equal(chars.length % 2, 0);
    const keys = new Set();
    const values = new Set();
    for (let i = 0; i < chars.length; i += 2) {
        assert.notEqual(chars[i], chars[i + 1], `${chars[i]} 對到自己`);
        assert.ok(!keys.has(chars[i]), `${chars[i]} 重複`);
        keys.add(chars[i]);
        values.add(chars[i + 1]);
    }
    assert.equal(keys.size, S2T_SIZE);
    for (const v of values) assert.ok(!keys.has(v), `${v} 既是轉換結果又是鍵，正確的繁體會被二次轉換`);
    for (const excluded of '峰床群灶痴秘粽肴霉苧发后台里干系只面庄晒坏么') {
        assert.ok(!keys.has(excluded), `${excluded} 不該在表裡`);
    }
});
