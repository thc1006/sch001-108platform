/**
 * 簡轉繁保險：活體測試看到的簡體字都要轉到；正確的繁體文字（含一對多、台灣標準字）
 * 一個字都不能被改動；串流逐段轉換與整段轉換逐字相同。整個 repo 的繁體文字見 s2t-corpus.test.mjs。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { toTraditional, createTraditionalStream, S2T_SIZE } from '../src/s2t.mjs';
import { S2T_PAIRS } from '../src/s2t-table.mjs';
import { S2T_ALWAYS, S2T_CURATED, S2T_DEFAULTS, S2T_GUARDS, S2T_PHRASES, S2T_SIMPLIFIED, S2T_TABLE_TRADITIONAL } from '../src/s2t-phrases.mjs';

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

test('詞組的最後一個字其實是下一個常用詞的開頭時不改：中国制度、仔细面对、机关系统', () => {
    const cases = [
        ['中国制度', '中國制度'],
        ['仔细面对问题', '仔細面對問題'],
        ['详细面试', '詳細面試'],
        ['机关系统', '機關系統'],
        ['海关系统', '海關系統'],
        ['因为中台湾', '因為中台灣'],
        // 志願 的簡體寫法 志愿 接在 标志 後面時，愿 照 志願 轉
        ['目标志愿', '目標志願'],
        ['填寫目標志愿', '填寫目標志願'],
        ['在苏昆虫类', '在蘇昆蟲類'],
        ['官网志工', '官網志工'],
        ['设备注意事项', '設備注意事項'],
        ['学习目标注重实作', '學習目標注重實作'],
        ['标注重点', '標註重點'],
        ['历史里程碑', '歷史里程碑'],
        ['协调表现', '協調表現'],
        ['没干扰', '沒干擾'],
        ['在两只有', '在兩只有'],
        ['视为准予', '視為准予'],
        ['这个计划算是成功', '這個計畫算是成功'],
        // 常用詞表的取捨：划船 收（常规划船），系上、里長、制服 不收（人际关系上、这里长出、绘制服装）
        ['常规划船训练这样', '常規划船訓練這樣'],
        ['人际关系上的困难', '人際關係上的困難'],
        ['这里长出新芽', '這裡長出新芽'],
        ['绘制服装设计图', '繪製服裝設計圖'],
        // 这么干 不收，干净 才轉得到
        ['教室这么干净', '教室這麼乾淨'],
        // 常用詞表從 jieba 詞典找出的詞（幸福、致謝、表面、回到、制裁）
        ['让双亲幸福', '讓雙親幸福'],
        ['最后要特别致谢指导老师', '最後要特別致謝指導老師'],
        ['这些压力表面上看不出来', '這些壓力表面上看不出來'],
        ['做梦回到小时候', '做夢回到小時候'],
        ['美国制裁伊朗', '美國制裁伊朗'],
        // 征服 在常用詞表，但 应征 不接常用詞：应征服役 的 征 屬於前面
        ['具体征服', '具體征服'],
        ['应征服役', '應徵服役'],
        ['股东游击队', '股東游擊隊'],
        // 接常用詞的鍵只把詞組最後一個字改回原字，前面該轉的字照轉（钟 → 鐘）
        ['这个钟表示时间', '這個鐘表示時間'],
        // 家伙、万里 佔住位置，伙计、里实 不跨過去
        ['这个家伙计划好了', '這個家伙計畫好了'],
        ['萬里实现', '萬里實現'],
        ['万里实现', '万里實現'],
        // 介詞 向 不被 向导、向应 改成 嚮（向应 不收、向导师 是擋詞）；当向导 照樣是 嚮導
        ['遇到困难可以向导师求助', '遇到困難可以向導師求助'],
        ['社团领导向导师请教', '社團領導向導師請教'],
        ['学校领导向应届毕业生致辞', '學校領導向應屆畢業生致辭'],
        ['也可以向应届考上的学长姐请教', '也可以向應屆考上的學長姐請教'],
        ['领导游客', '領導遊客'],
        ['这样会向导致失败的方向发展', '這樣會向導致失敗的方向發展'],
        ['可以向导游询问', '可以向導遊詢問'],
        ['当向导', '當嚮導'],
        // 詞組從獨立的單字開始時不吃掉下一個詞：过松山、会吊车、台风扇、系马上 是擋詞
        ['经过松山机场', '經過松山機場'],
        ['排名会吊车尾', '排名會吊車尾'],
        ['这台风扇很吵', '這台風扇很吵'],
        ['我们系马上要考试', '我們系馬上要考試'],
        ['鞋带过松', '鞋帶過鬆'],
        // 量詞 笔 後面的 划算、划不来、划得来 不切成 笔划；笔划 照樣是 筆劃
        ['这笔划算吗', '這筆划算嗎'],
        ['这笔划不来', '這筆划不來'],
        ['那笔划得来', '那筆划得來'],
        ['笔划不清', '筆劃不清'],
        // 过水面、换只、合儿 不收
        ['通过水面', '通過水面'],
        ['交换只不过', '交換只不過'],
        // 全簡的 复合儿童 會先被 复合 佔住，要用前面寫成繁體的句子才測得到 合儿
        ['複合儿童', '複合兒童'],
        ['三合儿子', '三合兒子'],
        // 一對多的字寫成繁體的 裡面、盡頭、裡頭 也佔住位置
        ['社團裡面团员很多', '社團裡面團員很多'],
        ['裡面条件很多', '裡面條件很多'],
        ['里面团体', '里面團體'],
        ['走到盡頭发现', '走到盡頭發現'],
        ['在裡頭发现', '在裡頭發現'],
        // CURATED 的繁體寫法佔住位置
        ['後面团队', '後面團隊'],
        // 之後、計畫 不佔位置，後面、画面 才接得上
        ['以後面团体', '以後面團體'],
        ['計畫面条件', '計畫面條件'],
        ['後台风格', '後台風格'],
        ['校系马上', '校系馬上'],
        // 常用詞以外照常轉
        ['关系很好', '關係很好'],
        ['这种关系所带来的', '這種關係所帶來的'],
        ['杂志工作', '雜誌工作'],
        ['两只猫', '兩隻貓'],
        ['面条', '麵條'],
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

test('CURATED（干部、准備）只在整句有簡體專用字時轉，句號、問號、換行隔開的句子各算各的', () => {
    assert.equal(toTraditional('熱音社干部與成果发表會'), '熱音社幹部與成果發表會');
    assert.equal(toTraditional('熱音社干部。成果发表會'), '熱音社干部。成果發表會');
    assert.equal(toTraditional('社團干部？提早准备\n社團干部'), '社團干部？提早準備\n社團干部');
    assert.equal(toTraditional('社團干部提早准備，并'), '社團幹部提早準備，並');
});

// 划 在台灣也是正字（划船、划算）。企划、策划 這類詞台灣一定寫成 劃，整句都是繁體也轉
test('ALWAYS 的 企划、策划、筹划、谋划、笔划、划分 一律轉成 劃，划船、划算 的 划 不動', () => {
    const cases = [
        // 第 3 輪 #388 審查的回答，整句只有 划 不是繁體
        ['讀法律常見出路包括律師、法官或檢察官、企業法務、公務員、企划或公關、觀護人或獄政人員', '讀法律常見出路包括律師、法官或檢察官、企業法務、公務員、企劃或公關、觀護人或獄政人員'],
        ['行銷企划', '行銷企劃'],
        ['活動策划', '活動策劃'],
        ['籌划', '籌劃'],
        ['謀划', '謀劃'],
        ['筆划很多', '筆劃很多'],
        ['學群的划分', '學群的劃分'],
        ['行政策划', '行政策劃'],
        ['活动策划', '活動策劃'],
        ['筹划活动', '籌劃活動'],
        ['这次企划由我负责', '這次企劃由我負責'],
        // 句尾有標點的全繁體句子也轉
        ['我想做企划。', '我想做企劃。'],
        ['活動策划！', '活動策劃！'],
        ['學群的划分。這樣', '學群的劃分。這樣'],
        // 前面是什麼詞都轉；後面接 划算、划不來、划得來、划不划算 時不轉（企划算 這類是擋詞）
        ['中國企划部', '中國企劃部'],
        ['國內外企划', '國內外企劃'],
        ['財政策划', '財政策劃'],
        ['針對策划案', '針對策劃案'],
        ['國企划算嗎', '國企划算嗎'],
        ['進外企划不划算', '進外企划不划算'],
        ['去陸企划算嗎', '去陸企划算嗎'],
        ['去台企划得來嗎', '去台企划得來嗎'],
        ['這是上策划算', '這是上策划算'],
        ['這個決策划算嗎', '這個決策划算嗎'],
        ['這項政策划不來', '這項政策划不來'],
        ['統籌划算', '統籌划算'],
        ['眾籌划不來', '眾籌划不來'],
        ['參謀划不划算', '參謀划不划算'],
        ['去陆企划算吗', '去陸企划算嗎'],
        ['这个决策划算吗', '這個決策划算嗎'],
        // 企劃＋算 也因此不轉，和 main 相同
        ['這份企划算是不錯', '這份企划算是不錯'],
        ['這筆划算嗎', '這筆划算嗎'],
        ['這筆划不來', '這筆划不來'],
        ['這筆划不划算', '這筆划不划算'],
        ['一筆划算', '一筆划算'],
        ['一筆划不划算', '一筆划不划算'],
        ['一笔划算', '一筆划算'],
        ['一笔划不来', '一筆划不來'],
        ['一笔划得来', '一筆划得來'],
        ['一笔划不划算', '一筆划不划算'],
        ['這筆划不太來', '這筆划不太來'],
        ['這筆划的來嗎', '這筆划的來嗎'],
        ['一筆划的來', '一筆划的來'],
        ['这笔划不太来', '這筆划不太來'],
        ['一笔划的来', '一筆划的來'],
        ['一笔划不太来', '一筆划不太來'],
        ['笔划不太清楚', '筆劃不太清楚'],
        // 企划、策划 不擋 不太来、的来
        ['企划的來源', '企劃的來源'],
        ['企划不太來得及', '企劃不太來得及'],
        ['策划的來源', '策劃的來源'],
        ['策划不太來得及', '策劃不太來得及'],
        // 繁體的 劃分 佔住位置，分 不跟後面湊成 分合
        ['劃分合并', '劃分合併'],
        // 刻划、比划、划入 不收：立刻划过去、相比划算、划入港口 的 划 是划船、划算
        ['立刻划过去', '立刻划過去'],
        ['立刻划過去', '立刻划過去'],
        ['和买新的相比划算', '和買新的相比划算'],
        ['和買新的相比划算', '和買新的相比划算'],
        ['划入港口这', '划入港口這'],
        ['划入港口', '划入港口'],
        ['企划船', '企划船'],
        ['下午去划船，這樣比較划算', '下午去划船，這樣比較划算'],
        ['下午去划船，这样比较划算', '下午去划船，這樣比較划算'],
    ];
    for (const [input, expected] of cases) assert.equal(toTraditional(input), expected, input);
    for (const head of ['陸企', '上策', '統籌', '參謀', '這筆', '一筆', '陆企', '统筹', '参谋', '这笔', '一笔']) {
        for (const tail of ['划算', '划不來', '划得來', '划不划算', '划不来', '划得来']) {
            assert.equal(toTraditional(head + tail), toTraditional(head) + tail.replace('来', '來'), head + tail);
        }
    }
    const traditional = '企劃、策劃、筆劃、籌劃、謀劃、劃分、劃撥、划船、划算、划得來、划不來、划槳、皮划艇、一筆劃';
    assert.equal(toTraditional(traditional), traditional);
    assert.equal(toTraditional(`${traditional}，这`), `${traditional}，這`);
    for (const sample of ['進外企划不划算？我想做企划或公關', '這筆划算嗎？行銷企划與政策划不來']) {
        const chars = [...sample];
        const whole = toTraditional(sample);
        for (let cut = 0; cut <= chars.length; cut++) {
            const convert = createTraditionalStream();
            const streamed = convert(chars.slice(0, cut).join('')) + convert(chars.slice(cut).join('')) + convert.flush();
            assert.equal(streamed, whole, `${sample} 切在第 ${cut} 個字`);
        }
    }
    assert.equal(toTraditional('進外企划不划算？我想做企划或公關'), '進外企划不划算？我想做企劃或公關');
    assert.equal(toTraditional('這筆划算嗎？行銷企划與政策划不來'), '這筆划算嗎？行銷企劃與政策划不來');
});

// 于、里、几、后、着、愿 在台灣也是正字（于美人、里長、茶几、皇后、一着、鄉愿），逐字對照不轉。
// 在于、這里、這几、之后、看着、愿意 這類詞台灣不會這樣寫，整句都是繁體也轉
test('ALWAYS 的 在于、這里、這几、之后、看着、愿意 這類詞整句都是繁體也轉；公里、里長、于美人、茶几、皇后、一着 不動', () => {
    const cases = [
        // 2026-11-12 #390、#391 審查看到的模型回答
        ['問題在于行動細節較少', '問題在於行動細節較少'],
        ['可以在情境里再多點出', '可以在情境裡再多點出'],
        ['計畫里要面對', '計畫裡要面對'],
        ['致辭這几件事寫成', '致辭這幾件事寫成'],
        ['要提前規划；', '要提前規劃；'],
        ['計划在（填入期限）', '計畫在（填入期限）'],
        ['屬于內在成長', '屬於內在成長'],
        ['個人敢于站在大家面前', '個人敢於站在大家面前'],
        ['人很多，于是只好', '人很多，於是只好'],
        ['還好最后有解決', '還好最後有解決'],
        ['后來我們', '後來我們'],
        ['事情的先后順序', '事情的先後順序'],
        ['實際卡在哪里，', '實際卡在哪裡，'],
        ['店里很忙碌', '店裡很忙碌'],
        ['也念了我几次', '也念了我幾次'],
        ['大家才比較愿意繼續練', '大家才比較願意繼續練'],
        ['投入志愿服務', '投入志願服務'],
        ['每天回家都對着鏡子練習', '每天回家都對著鏡子練習'],
        ['先不急着定組', '先不急著定組'],
        // 前一個字寫成簡體或繁體都對得上
        ['对于、對于、关于、關于、属于、屬于', '對於、對於、關於、關於、屬於、屬於'],
        ['这里、這里、这几、這几', '這裡、這裡、這幾、這幾'],
        // 兩個詞接在一起時，後一個詞其餘的字照它的轉法
        ['十几万人', '十幾萬人'],
        ['好几万元', '好幾萬元'],
        ['號稱几十万人、几百万、好几千万', '號稱幾十萬人、幾百萬、好幾千萬'],
        ['着急于完成', '著急於完成'],
        // 里 結尾的詞接 面、头 時，面、头 不跟後面湊成 面条、头发
        ['這里面条件很多', '這裡面條件很多'],
        ['在家里头发现', '在家裡頭發現'],
        // 里长 不放進 CONTINUE：家里長輩 要轉
        ['家里長輩', '家裡長輩'],
    ];
    for (const [input, expected] of cases) {
        assert.equal(toTraditional(input), expected, input);
        assert.equal(toTraditional(`${input}，这`), `${expected}，這`, input);
    }
    // 每個詞寫成繁體、只有 于 這些字寫錯時都轉（划 的詞見上一個測試）
    const words = `
        之後 以後 然後 最後 隨後 後來 後面 後續 先後 前後 背後 規劃 劃定 劃掉
        在於 由於 對於 關於 至於 屬於 等於 於是 敢於 善於 用於 位於 處於 基於 終於 過於 易於 低於 多於 少於
        源於 便於 急於 勇於 樂於 歸於 限於 免於 出於 鑑於 助於 利於 似於
        這裡 那裡 哪裡 心裡 家裡 店裡 眼裡 夜裡 夢裡 手裡 情境裡 計畫裡 報告裡 句子裡 過程裡 生活裡 活動裡 社團裡 學校裡
        課堂裡 文章裡
        幾乎 幾個 幾次 幾天 幾年 幾位 幾種 幾件 幾點 幾十 幾百 幾千 幾萬 幾分 幾期 幾人 幾首 幾周 好幾 這幾 那幾 哪幾
        十幾 第幾
        看著 跟著 接著 對著 急著 順著 隨著 帶著 拉著 學著 等著 想著 拿著 試著 靠著 朝著 沿著 忙著 抱著 穿著 寫著 聽著
        說著 笑著 有著 著急 著重 著手 著眼 著迷 著想
        願意 心願 願望 志願 意願 情願 不願 自願 但願 如願 寧願 甘願 祝願 許願`.split(/\s+/).filter(Boolean);
    const wrong = { 於: '于', 裡: '里', 幾: '几', 後: '后', 著: '着', 願: '愿', 劃: '划' };
    for (const word of [...words, '計畫']) {
        const input = word === '計畫' ? '計划' : [...word].map((ch) => wrong[ch] ?? ch).join('');
        assert.equal(toTraditional(input), word, input);
        assert.equal(toTraditional(`${input}。`), `${word}。`, input);
    }
    const traditional = '公里、五公里、里長、訪談里長、替里辦公室、鄰里、鄉里、故里、千里、萬里、里程、新里程、這里程碑、'
        + '國家里程碑、后里、目前后里區、首先后里區、所以后里的居民、雖然后里不大、當然后里也有名產、總之后里是個好地方、'
        + '以后里為中心、目前后豐鐵馬道、目前后庄里的里長、目前后盤村、之前后沃村、于美人、單于、淳于、茶几、茶几上、案几、皇后、皇后來了、天后宮、'
        + '球后來台、影后續約、一着、下一着棋、鄉愿、高于婕是我們班的同學、他比小于高、台大于教授、前往后壁、常規划船、讀設計划不划算、讀會計划得來嗎、我估計划不來、'
        + '走正規划算嗎、用常規划算、合計划算嗎、去讀統計划不划算、總計划得來、累計划不來、共計划不划算、'
        + '作家里爾克、國手里約奧運、選手里卡多、這家店里肌豬排';
    assert.equal(toTraditional(traditional), traditional);
    assert.equal(toTraditional(`${traditional}，这`), `${traditional}，這`);
    // 心里、店里、家里 結尾的里名，與 心里長
    const villages = '北投區中心里里長、一心里、正心里、民心里、平心里、田心里的里民、同心里、向心里、文心里辦公處、埔心里、溪心里、'
        + '歸心里、新店里的里民、頂店里、車店里、林家里、胡家里、德家里、興家里、頭家里、劉家里、林芷心里長表示';
    assert.equal(toTraditional(villages), villages);
    assert.equal(toTraditional(`${villages}，这`), `${villages}，這`);
    // 串流：切在每一個位置、一個字一個字送，都和整段相同
    for (const sample of [...cases.map(([input]) => input), traditional, villages, '問題在于。這里面条件，這里程碑！好几万人？家里头发现']) {
        const chars = [...sample];
        const whole = toTraditional(sample);
        for (let cut = 0; cut <= chars.length; cut++) {
            const convert = createTraditionalStream();
            const streamed = convert(chars.slice(0, cut).join('')) + convert(chars.slice(cut).join('')) + convert.flush();
            assert.equal(streamed, whole, `${sample} 切在第 ${cut} 個字`);
        }
        const convert = createTraditionalStream();
        assert.equal(chars.map((ch) => convert(ch)).join('') + convert.flush(), whole, sample);
    }
});

test('預設轉法的字寫成繁體也對得上擋詞：繁體的「獲准」對得上「获准」，准 不跟後面湊成 准备', () => {
    assert.equal(toTraditional('獲准備案这样'), '獲准備案這樣');
});

test('一句最多算 100 個字：CURATED 只看同一段裡有沒有簡體字，串流最多為此留 100 個字', () => {
    const long = '大'.repeat(120);
    assert.equal(toTraditional(`干部${'大'.repeat(90)}这`), `幹部${'大'.repeat(90)}這`);
    assert.equal(toTraditional(`干部${long}这`), `干部${long}這`);
    const convert = createTraditionalStream();
    const first = convert(`干部${long}`);
    assert.ok([...first].length >= 100, `只送出 ${[...first].length} 個字`);
    assert.equal(first + convert('这') + convert.flush(), `干部${long}這`);
    // 前面已經有一句時，下一句也從 0 算起
    const later = createTraditionalStream();
    const head = later(`你好。${'大'.repeat(200)}干部${long}`);
    assert.ok([...head].length >= 3 + 200 + 100, `只送出 ${[...head].length} 個字`);
});

test('詞組只改原文和鍵同一個字的位置：原文已經是繁體的字照原樣', () => {
    // 「頭发」對得上「头发」，頭 原樣，发 照詞組轉成 髮
    assert.equal(toTraditional('頭发'), '頭髮');
    // 原文已經寫成繁體、而且和詞組的轉法不同的字（抬头 是擋詞，头发 的 发 這裡寫成 發）照原樣
    assert.equal(toTraditional('抬头發现问题'), '抬頭發現問題');
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
    // 第二句：簡體字先出現，CURATED 的詞在段尾、還可能接成更長的詞，前一句的 taint 不能被提早清掉
    for (const sample of [text, '这是最后一天。我们以后一定会更好']) {
        const c = [...sample];
        for (let cut = 0; cut <= c.length; cut++) {
            const convert = createTraditionalStream();
            const streamed = convert(c.slice(0, cut).join('')) + convert(c.slice(cut).join('')) + convert.flush();
            assert.equal(streamed, toTraditional(sample), `${sample} 切在第 ${cut} 個字`);
        }
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
    // ALWAYS 不看整句就轉，繁體也用的字只能改這幾個（计划 的 划 轉成 畫）
    const always = { 划: '劃畫', 于: '於', 里: '裡', 几: '幾', 后: '後', 着: '著', 愿: '願', 万: '萬' };
    for (const [key, value] of entries(S2T_ALWAYS)) {
        baseline(key).forEach((ch, i) => assert.ok(ch === value[i] || simplified.has(ch) || always[ch]?.includes(value[i]), `${key.join('')} 的 ${ch} 改成 ${value[i]}`));
        assert.notDeepEqual(baseline(key), value, key.join(''));
    }
    // 產生腳本拿掉了和詞組同鍵的擋詞（同鍵時詞組先試，原文有簡體字時擋詞輪不到）
    const keys = new Set([...entries(S2T_PHRASES), ...entries(S2T_CURATED), ...entries(S2T_ALWAYS)].map(([key]) => key.join('')));
    for (const guard of S2T_GUARDS.split(' ')) assert.ok(!keys.has(guard), `擋詞 ${guard} 也是詞組`);
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

// 改了產生腳本的清單（CONTINUE、REJECT…）或逐字對照，卻忘了重產 s2t-phrases.mjs 時這裡會失敗
test('s2t-phrases.mjs 是用現在的產生腳本與逐字對照產生的', () => {
    const text = readFileSync(new URL('../src/s2t-phrases.mjs', import.meta.url), 'utf8').split('*/')[0];
    for (const file of ['scripts/build-s2t-phrases.mjs', 'src/s2t-table.mjs']) {
        const recorded = text.match(new RegExp(`ai-gateway/${file.replace('.', '\\.')}（sha256 ([0-9a-f]{64})）`))?.[1];
        const actual = createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex');
        assert.equal(recorded, actual, `${file} 改過，要重新產生 s2t-phrases.mjs（指令見產生腳本開頭）`);
    }
});

test('s2t-phrases.mjs 沒有被手改：表頭記的內容 sha256 和現在的內容相同', () => {
    const text = readFileSync(new URL('../src/s2t-phrases.mjs', import.meta.url), 'utf8');
    const at = text.indexOf(' */\n') + ' */\n'.length;
    const recorded = text.slice(0, at).match(/這段說明以下的內容 sha256 ([0-9a-f]{64})/)?.[1];
    assert.equal(recorded, createHash('sha256').update(text.slice(at)).digest('hex'), '表被手改過，要用產生腳本重產');
});
