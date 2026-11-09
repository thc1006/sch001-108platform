/**
 * 簡轉繁保險：活體測試看到的簡體字都要轉到；正確的繁體文字（含一對多、台灣標準字）
 * 一個字都不能被改動；串流逐段轉換與整段轉換逐字相同。整個 repo 的繁體文字見 s2t-corpus.test.mjs。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { toTraditional, createTraditionalStream, S2T_SIZE } from '../src/s2t.mjs';
import { S2T_PAIRS } from '../src/s2t-table.mjs';
import { S2T_CURATED, S2T_DEFAULTS, S2T_GUARDS, S2T_PHRASES, S2T_SIMPLIFIED, S2T_TABLE_TRADITIONAL } from '../src/s2t-phrases.mjs';

test('活體測試中出現過的簡體字都會被轉成台灣繁體', () => {
    assert.equal(toTraditional('每兩週產出阶段性報告'), '每兩週產出階段性報告');
    assert.equal(toTraditional('数据收集：选取五首经典乐曲'), '數據收集：選取五首經典樂曲');
    assert.equal(toTraditional('靜默自有其萬钧之力'), '靜默自有其萬鈞之力');
    assert.equal(toTraditional('是应对學測的重要加分項'), '是應對學測的重要加分項');
    assert.equal(toTraditional('相关係數'), '相關係數');
});

test('一對多、但台灣幾乎只用一種寫法的字照指定轉法：证、确、据、适、个、种', () => {
    assert.equal(toTraditional('证据确实，这个方法很适合'), '證據確實，這個方法很適合');
    assert.equal(toTraditional('可以從三种角度分析'), '可以從三種角度分析');
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

test('一對多的字照詞組轉：干部、发表、团队、当天、并且、头发、后来', () => {
    const cases = [
        ['社团干部', '社團幹部'],
        ['成果发表会', '成果發表會'],
        ['团队合作', '團隊合作'],
        ['当天下午', '當天下午'],
        ['并且要', '並且要'],
        ['头发很长', '頭髮很長'],
        ['后来呢', '後來呢'],
        ['理发店', '理髮店'],
        ['饭团', '飯糰'],
        ['叮当响', '叮噹響'],
        ['合并两家', '合併兩家'],
        ['很干净', '很乾淨'],
        ['复习功课', '複習功課'],
        ['恢复正常', '恢復正常'],
        ['尽管如此', '儘管如此'],
        ['一分钟', '一分鐘'],
        ['台风来了', '颱風來了'],
        // 确、种、适 逐字對照一律轉掉，也算簡體專用字，含它們的詞組才會套用
        ['准确度', '準確度'],
        ['用几种方法', '用幾種方法'],
        ['适用于艺术', '適用於藝術'],
        // 轉法保留姓氏、古字的 种、适、恒 的詞組不收，不在輸出留下簡體字
        ['三种放大', '三種放大'],
        ['洪适、南宫适', '洪適、南宮適'],
        ['恒大', '恆大'],
        ['虱目鱼', '虱目魚'],
    ];
    for (const [input, expected] of cases) assert.equal(toTraditional(input), expected, input);
});

test('台灣的寫法：台灣、計畫、發布 不照 OpenCC 換成 臺灣、計劃、發佈', () => {
    assert.equal(toTraditional('台湾的计划，新版发布'), '台灣的計畫，新版發布');
    assert.equal(toTraditional('參考書目；注释用'), '參考書目；注釋用');
    assert.equal(toTraditional('不收脚注'), '不收腳注');
});

test('擋詞：皇后来了 的后 不跟後面的字湊成 后来', () => {
    assert.equal(toTraditional('皇后来了'), '皇后來了');
    // 同一句有簡體字時，繁體的稱號也不跟後面湊成 后来、后面
    assert.equal(toTraditional('視后來台宣传'), '視后來台宣傳');
    assert.equal(toTraditional('視后面對记者'), '視后面對記者');
    assert.equal(toTraditional('棋后來訪，拳后面對记者'), '棋后來訪，拳后面對記者');
    assert.equal(toTraditional('若干部分要发表'), '若干部分要發表');
});

test('系所、系統、系列 的 系 不跟前面的 关 湊成 关系；相关系数 照樣轉成 係數', () => {
    assert.equal(toTraditional('相关系所的课程'), '相關系所的課程');
    assert.equal(toTraditional('相关系统、有关系统'), '相關系統、有關系統');
    assert.equal(toTraditional('读相关系列书籍'), '讀相關系列書籍');
    assert.equal(toTraditional('相关系数'), '相關係數');
    assert.equal(toTraditional('没有关系，有关系吗'), '沒有關係，有關係嗎');
});

test('擋詞讓前一個詞先佔住位置：强调制度、六年制药学系、转换只用、开车里程 不切錯', () => {
    const cases = [
        ['老师强调制度的重要', '老師強調制度的重要'],
        ['要强调表达能力', '要強調表達能力'],
        ['六年制药学系', '六年制藥學系'],
        ['确认准考证', '確認准考證'],
        ['转换只用在这里', '轉換只用在這裡'],
        ['开车里程', '開車里程'],
        // 照准 不當擋詞：按照准备 的 准备 要轉
        ['按照准备指引', '按照準備指引'],
        ['组合并不难', '組合並不難'],
        // 繁體的 批准、核准 是擋詞，准備 不被 CURATED 改掉
        ['批准備案这样', '批准備案這樣'],
        ['核准備案这样', '核准備案這樣'],
        // 擋詞以外照常轉
        ['坐在车里', '坐在車裡'],
        ['制药公司', '製藥公司'],
        ['以官网为准', '以官網為準'],
    ];
    for (const [input, expected] of cases) assert.equal(toTraditional(input), expected, input);
});

test('沒有詞組命中的一對多字：S2T_DEFAULTS 的字照預設轉，其他的不動', () => {
    assert.equal(toTraditional('只有三团报名，并请同学参加'), '只有三團報名，並請同學參加');
    // 复（復／複／覆）、干、后 沒有預設轉法
    assert.equal(toTraditional('复，干，后'), '复，干，后');
});

test('模型簡繁混寫：一對一的字寫成繁體也對得上詞組（团隊、发表會）', () => {
    assert.equal(toTraditional('補上你在干部团隊中的主要職責，以及当時最大的困難'), '補上你在幹部團隊中的主要職責，以及當時最大的困難');
    assert.equal(toTraditional('高二我擔任熱音社干部，負責期末成果发表會。'), '高二我擔任熱音社幹部，負責期末成果發表會。');
    assert.equal(toTraditional('檢查線路并請負責同學處理，隨后調整彩排順序'), '檢查線路並請負責同學處理，隨後調整彩排順序');
});

test('CURATED（干部、最后、准備）只在整句有簡體專用字時轉，句號、問號、換行隔開的句子各算各的', () => {
    assert.equal(toTraditional('熱音社干部與成果发表會'), '熱音社幹部與成果發表會');
    assert.equal(toTraditional('熱音社干部。成果发表會'), '熱音社干部。成果發表會');
    assert.equal(toTraditional('最后一天？提早准备\n最后一天'), '最后一天？提早準備\n最后一天');
    assert.equal(toTraditional('最后提早准備，并'), '最後提早準備，並');
});

test('預設轉法的字寫成繁體也對得上擋詞：繁體的「獲准」對得上「获准」，准 不跟後面湊成 准备', () => {
    assert.equal(toTraditional('獲准備案这样'), '獲准備案這樣');
});

test('一句最多算 100 個字：CURATED 只看同一段裡有沒有簡體字，串流最多為此留 100 個字', () => {
    const long = '大'.repeat(120);
    assert.equal(toTraditional(`最后${'大'.repeat(90)}这`), `最後${'大'.repeat(90)}這`);
    assert.equal(toTraditional(`最后${long}这`), `最后${long}這`);
    const convert = createTraditionalStream();
    const first = convert(`最后${long}`);
    assert.ok([...first].length >= 100, `只送出 ${[...first].length} 個字`);
    assert.equal(first + convert('这') + convert.flush(), `最后${long}這`);
});

test('詞組只改原文和鍵同一個字的位置：原文已經是繁體的字照原樣', () => {
    // 「頭发」對得上「头发」，頭 原樣，发 照詞組轉成 髮
    assert.equal(toTraditional('頭发'), '頭髮');
    assert.equal(toTraditional('成果發表会'), '成果發表會');
});

test('正確的繁體文字裡和詞組長得像的詞不動，旁邊有簡體字也一樣', () => {
    const traditional = '若干部分、不相干部門、皇后來了、皇后面前、天后宮、茶几、五公里、范仲淹、干擾、台風穩健、家具、計劃、一隻、只是、關聯系統、聯繫、准考證、批准備案、後來、頭髮、發表、隨後';
    assert.equal(toTraditional(traditional), traditional);
    // 同一句有簡體字時，詞組與 CURATED 也只碰得到寫成簡體的字
    assert.equal(toTraditional(`${traditional}，发表`), `${traditional}，發表`);
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

test('串流逐段轉換＝整段轉換：詞組、擋詞、CURATED 被切開也一樣', () => {
    const text = '熱音社干部與成果发表會。皇后来了，头发很长！最后一天\n提早准备，社团干部团隊？若干部分、饭团、并且';
    const chars = [...text];
    for (let cut = 0; cut <= chars.length; cut++) {
        const convert = createTraditionalStream();
        const streamed = convert(chars.slice(0, cut).join('')) + convert(chars.slice(cut).join('')) + convert.flush();
        assert.equal(streamed, toTraditional(text), `切在第 ${cut} 個字`);
    }
    // 一個字一個字送：CURATED 要等到這句的簡體字或句尾才送出，前面已確定的部分照常送出
    const convert = createTraditionalStream();
    assert.equal(chars.map((ch) => convert(ch)).join('') + convert.flush(), toTraditional(text));
    const pending = createTraditionalStream();
    assert.equal(pending('你好。熱音社干部'), '你好。熱音社');
    assert.equal(pending('與成果发表會。') + pending.flush(), '幹部與成果發表會。');
});

// 前兩個字本身不是詞、三個字以上才是詞的鍵（一干二净、一去不复返）：可能接成更長的詞時，結尾的字
// 都要留著，只留一個字就會轉錯
test('串流逐段轉換＝整段轉換：三個字以上的詞組被隨機切開也一樣', () => {
    const text = '他一干二净地走了，一去不复返。等一分钟，一干二净😀一去不复返吧；万事俱备只欠东风，一发不可收拾';
    const units = text.split('');
    for (let seed = 1; seed <= 300; seed++) {
        let s = seed;
        const rand = () => {
            s = (s * 1103515245 + 12345) % 2 ** 31;
            return s / 2 ** 31;
        };
        const convert = createTraditionalStream();
        let streamed = '';
        for (let i = 0; i < units.length;) {
            const size = 1 + Math.floor(rand() * 5);
            streamed += convert(units.slice(i, i + size).join(''));
            i += size;
        }
        assert.equal(streamed + convert.flush(), toTraditional(text), `seed ${seed}`);
    }
    assert.equal(toTraditional('他一干二净，一去不复返'), '他一乾二淨，一去不復返');
});

test('串流：拮 與 据 分在兩段時仍保留', () => {
    const convert = createTraditionalStream();
    assert.equal(convert('手頭拮') + convert('据') + convert.flush(), '手頭拮据');
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

test('詞組表的完整性：鍵和轉法一樣長、PHRASES 都有簡體專用字、預設轉法的字不在逐字對照裡', () => {
    const table = new Map();
    const chars = [...S2T_PAIRS];
    for (let i = 0; i < chars.length; i += 2) table.set(chars[i], chars[i + 1]);
    const simplified = new Set([...[...table.keys()].filter((ch) => !S2T_TABLE_TRADITIONAL.includes(ch)), ...S2T_SIMPLIFIED]);
    const entries = (text) => text.split(' ').map((entry) => {
        const c = [...entry];
        assert.equal(c.length % 2, 0, entry);
        return [c.slice(0, c.length / 2), c.slice(c.length / 2)];
    });
    const defaults = [...S2T_DEFAULTS];
    const fallback = new Map();
    for (let i = 0; i < defaults.length; i += 2) fallback.set(defaults[i], defaults[i + 1]);
    // 轉法要跟逐字對照加預設轉法不同，不然不必收
    const baseline = (key) => key.map((ch) => table.get(ch) ?? fallback.get(ch) ?? ch);
    for (const [key, value] of entries(S2T_PHRASES)) {
        assert.ok(key.some((ch) => simplified.has(ch)), `${key.join('')} 沒有簡體專用字`);
        assert.notDeepEqual(baseline(key), value, key.join(''));
    }
    for (const [key, value] of entries(S2T_CURATED)) assert.notDeepEqual(baseline(key), value, key.join(''));
    assert.ok(S2T_GUARDS.split(' ').length > 0);
    for (let i = 0; i < defaults.length; i += 2) {
        assert.ok(!table.has(defaults[i]) && S2T_SIMPLIFIED.includes(defaults[i]), `${defaults[i]} 不是一對多的簡體專用字`);
    }
    // 繁體也用的字不能算簡體專用字
    for (const ch of '干后台里系只面髮後裡庄晒坏么') assert.ok(!simplified.has(ch), `${ch} 被當成簡體專用字`);
    for (const ch of '发团当并来确种适') assert.ok(simplified.has(ch), `${ch} 應該是簡體專用字`);
    assert.ok(!simplified.has('据'), '据 在「拮据」裡是繁體');
});

// s2t-phrases.mjs 依 s2t-table.mjs 產生（簡體專用字、擋詞都看逐字對照）。只重產其中一個時這裡會失敗
test('兩張表出自同一版 OpenCC：commit 與 STCharacters、TWVariants 的 sha256 相同', () => {
    const header = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8').split('*/')[0];
    const source = (text) => ({
        commit: text.match(/commit ([0-9a-f]{40})/)?.[1],
        st: text.match(/STCharacters\.txt（sha256 ([0-9a-f]{64})）/)?.[1],
        tw: text.match(/TWVariants\.txt（sha256 ([0-9a-f]{64})）/)?.[1],
    });
    const table = source(header('s2t-table.mjs'));
    assert.ok(table.commit && table.st && table.tw, '讀不到 s2t-table.mjs 的來源');
    assert.deepEqual(source(header('s2t-phrases.mjs')), table);
    const keys = new Set([...S2T_PAIRS].filter((_, i) => i % 2 === 0));
    for (const ch of S2T_TABLE_TRADITIONAL) assert.ok(keys.has(ch), `${ch} 不在逐字對照裡`);
    for (const ch of S2T_SIMPLIFIED) assert.ok(!keys.has(ch), `${ch} 已經在逐字對照裡`);
});
