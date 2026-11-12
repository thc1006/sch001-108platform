// 科系羅盤的搜尋（src/pages/career-exploration/index.astro 的 searchClusters）。
// 頁面腳本是 is:inline，沒有模組可以 import，所以把 majorData、ALIASES、NAME_ALIASES、searchClusters 切出來交給 vm 求值。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const PAGE = readFileSync(new URL('../src/pages/career-exploration/index.astro', import.meta.url), 'utf8');
const data = PAGE.match(/const majorData = (\[[\s\S]*?\n\s*\]);/)?.[1];
const search = PAGE.match(/\n( {8}const ALIASES = [\s\S]*?\n {8}function searchClusters\([\s\S]*?\n {8}\})\n/)?.[1];
assert.ok(data, '頁面裡找不到 const majorData = [...];');
assert.ok(search, '頁面裡找不到 ALIASES、NAME_ALIASES 和 searchClusters');
// runInThisContext：陣列和這裡的是同一個 Array，deepEqual 才比得起來。
const { majorData, ALIASES, NAME_ALIASES, searchClusters } = vm.runInThisContext(
    `(() => {\nconst majorData = ${data};\n${search}\nreturn { majorData, ALIASES, NAME_ALIASES, searchClusters };\n})()`,
);

const ids = (input) => searchClusters(majorData, input).map((r) => r.cluster.id);
const find = (input, id) => searchClusters(majorData, input).find((r) => r.cluster.id === id);

test('空白或沒有輸入時列出全部學群，不寫符合的項目', () => {
    for (const input of ['', '   ']) {
        const results = searchClusters(majorData, input);
        assert.deepEqual(results.map((r) => r.cluster.id), majorData.map((c) => c.id));
        assert.ok(results.every((r) => r.byName && !r.majors.length && !r.careers.length));
    }
});

test('打科系找得到學群，並寫出符合的科系', () => {
    assert.deepEqual(ids('護理'), ['medicine']);
    assert.deepEqual(find('護理', 'medicine'), { cluster: find('護理', 'medicine').cluster, byName: false, majors: ['護理'], careers: ['護理師'] });
    assert.deepEqual(ids('法律'), ['law']);
    assert.deepEqual(find('法律', 'law').majors, ['法律', '財經法律']);
    assert.deepEqual(ids('犯罪防治'), ['social_psychology', 'law']);
});

test('打職業找得到學群，並寫出符合的出路', () => {
    assert.deepEqual(ids('律師'), ['law']);
    assert.deepEqual(find('律師', 'law').careers, ['律師或司法官（法官或檢察官）']);
    assert.deepEqual(ids('記者'), ['mass_comm']);
    assert.deepEqual(find('ai', 'info').careers, ['AI 工程師']);
});

test('簡稱、系名和口語說法換成 majors 或 careers 裡的字再找', () => {
    assert.deepEqual(ids('資工'), ['engineering', 'info']);
    assert.deepEqual(find('資工', 'info').majors, ['資訊工程']);
    assert.deepEqual(ids('財金'), ['finance']);
    assert.deepEqual(ids('公行'), ['law']);
    assert.deepEqual(ids('醫生'), ['medicine']);
    assert.deepEqual(find('醫生', 'medicine').careers, ['醫師', '牙醫師']);
    assert.deepEqual(ids('寫程式'), ['info']);
    assert.deepEqual(find('寫程式', 'info').careers, ['軟體工程師']);
    assert.deepEqual(ids('公務員'), ['law']);
    assert.deepEqual(ids('外交官'), ['law']);
    assert.deepEqual(ids('商管'), ['management']);
    assert.ok(find('生技', 'life_sci').careers.includes('生技或製藥公司研發（多半要讀研究所）'));
    assert.deepEqual(ids('國貿'), ['management', 'finance']);
    assert.deepEqual(ids('室設'), ['design']);
    assert.deepEqual(ids('程式'), ['info']);
    assert.deepEqual(ids('醫科'), ['medicine']);
    assert.deepEqual(ids('公共行政'), ['law']);
    assert.deepEqual(ids('外交'), ['law']);
    assert.deepEqual(ids('地政'), ['law']);
    assert.deepEqual(find('地政', 'law').majors, ['土地資產']);
    assert.deepEqual(ids('電腦'), ['engineering', 'info']);
    assert.deepEqual(find('人工智慧', 'info').careers, ['AI 工程師']);
    assert.deepEqual(ids('資料科學'), ['info']);
    assert.deepEqual(ids('護士'), ['medicine']);
    assert.deepEqual(ids('銀行員'), ['finance']);
    assert.deepEqual(ids('人資'), ['management', 'social_psychology']);
});

test('ColleGo! 的學群名稱也找得到', () => {
    assert.deepEqual(ids('建築設計學群'), ['design']);
    assert.deepEqual(ids('社會心理學群'), ['social_psychology']);
    assert.deepEqual(ids('社會心理學系'), ['social_psychology']);
    assert.deepEqual(ids('社心'), ['social_psychology']);
    assert.deepEqual(ids('建築與設計'), ['design']);
});

test('開頭的「當」「想讀」「以後想當」「想成為」去掉再找，只打一個字時照原字找', () => {
    assert.deepEqual(ids('當醫生'), ['medicine']);
    assert.deepEqual(ids('想要當醫生'), ['medicine']);
    assert.deepEqual(ids('當律師'), ['law']);
    assert.deepEqual(ids('以後想當律師'), ['law']);
    assert.deepEqual(ids('我想讀資工'), ['engineering', 'info']);
    assert.deepEqual(ids('我要讀資工'), ['engineering', 'info']);
    assert.deepEqual(ids('想念法律系'), ['law']);
    assert.deepEqual(ids('唸法律'), ['law']);
    assert.deepEqual(ids('想成為設計師'), ['design']);
    assert.deepEqual(ids('我以後想當律師'), ['law']);
    assert.deepEqual(ids('未來想當律師'), ['law']);
    assert.deepEqual(ids('將來想當醫生'), ['medicine']);
    assert.deepEqual(ids('長大後想當律師'), ['law']);
    assert.deepEqual(ids('長大想當醫生'), ['medicine']);
    assert.deepEqual(ids('長大以後想當醫生'), ['medicine']);
    assert.deepEqual(ids('我很想當醫生'), ['medicine']);
    assert.deepEqual(ids('希望成為醫生'), ['medicine']);
    assert.deepEqual(ids('我希望當醫生'), ['medicine']);
    assert.deepEqual(ids('想去讀資工'), ['engineering', 'info']);
    assert.deepEqual(ids('我以後想去念法律系'), ['law']);
    assert.deepEqual(ids('想當一位律師'), ['law']);
    assert.deepEqual(ids('想當個律師'), ['law']);
    assert.deepEqual(ids('我想當一名律師'), ['law']);
    assert.deepEqual(ids('我想成為一名工程師'), ['engineering', 'info']);
    assert.deepEqual(ids('我也想當醫生'), ['medicine']);
    assert.deepEqual(ids('我好想當醫生'), ['medicine']);
    assert.deepEqual(ids('我真的很想讀資工'), ['engineering', 'info']);
    assert.deepEqual(ids('希望考上醫學系'), ['medicine']);
    assert.deepEqual(ids('想考上資工'), ['engineering', 'info']);
    assert.deepEqual(ids('希望能讀心理系'), ['social_psychology']);
    assert.deepEqual(ids('希望可以讀心理系'), ['social_psychology']);
    assert.deepEqual(ids('我以後想當醫生。'), ['medicine']);
    assert.deepEqual(ids('想當醫生？'), ['medicine']);
    assert.deepEqual(ids('想當醫生!!'), ['medicine']);
    assert.deepEqual(ids('想當一個醫生'), ['medicine']);
    assert.deepEqual(ids('想考醫學系'), ['medicine']);
    assert.deepEqual(ids('當'), []);
    // 只去開頭，中間的「當」不去。
    assert.deepEqual(ids('社工當'), []);
    for (const input of ['想讀書', '當兵', '想念家人', '考古', '考試', '我想考', '當個', '去當兵', '很想讀書', '去考試', '也當兵', '好讀書', '個人', '希望工程']) assert.deepEqual(ids(input), [], input);
});

test('打「系」「學系」「學類」結尾的系名和「師」「技師」結尾的職稱也找得到；去掉以後要整個相同', () => {
    assert.deepEqual(ids('護理系'), ['medicine']);
    assert.deepEqual(ids('護理學類'), ['medicine']);
    assert.deepEqual(ids('資工系'), ['engineering', 'info']);
    assert.deepEqual(ids('資訊工程學系'), ['engineering', 'info']);
    assert.deepEqual(ids('電機系'), ['engineering', 'info']);
    assert.deepEqual(ids('社會系'), ['social_psychology']);
    assert.deepEqual(ids('生物系'), ['life_sci']);
    assert.deepEqual(ids('資訊系'), ['info']);
    assert.deepEqual(ids('醫學系'), ['medicine']);
    assert.deepEqual(find('醫學系', 'medicine').majors, ['醫學']);
    assert.deepEqual(ids('廣告學系'), ['mass_comm']);
    assert.deepEqual(ids('人類學系'), ['social_psychology']);
    assert.deepEqual(ids('民族學系'), ['social_psychology']);
    assert.deepEqual(ids('人類民族學類'), ['social_psychology']);
    assert.deepEqual(ids('行銷學系'), ['management']);
    assert.deepEqual(ids('觀光系'), ['management']);
    assert.deepEqual(ids('統計學系'), ['info']);
    assert.deepEqual(ids('金融學系'), ['finance']);
    assert.deepEqual(ids('室內設計學系'), ['design']);
    assert.deepEqual(ids('食品科學系'), ['life_sci']);
    // 去掉字尾之後也比對出路。
    assert.deepEqual(ids('公關系'), ['mass_comm']);
    assert.deepEqual(find('公關系', 'mass_comm').careers, ['公關']);
    assert.deepEqual(ids('電機工程師'), ['engineering', 'info']);
    assert.deepEqual(find('電機工程師', 'engineering').majors, ['電機工程']);
    assert.deepEqual(ids('職能治療師'), ['medicine']);
    assert.deepEqual(ids('臨床心理師'), ['social_psychology']);
    assert.deepEqual(ids('土木技師'), ['engineering']);
    assert.deepEqual(ids('醫檢師'), ['medicine']);
    for (const input of ['老師', '物理師', '廚師']) assert.deepEqual(ids(input), [], input);
    assert.deepEqual(ids('物理系'), []);
    assert.deepEqual(ids('化學系'), []);
    assert.deepEqual(ids('理學系'), []);
    assert.deepEqual(ids('文學系'), []);
});

test('大小寫、全形英數和空白不影響比對', () => {
    for (const input of ['AI', 'ai', 'ＡＩ', 'AI工程師', 'ai 工程師']) assert.deepEqual(ids(input), ['info'], input);
    assert.deepEqual(find('AI', 'info').careers, ['AI 工程師']);
    assert.deepEqual(ids('護 理'), ['medicine']);
    assert.deepEqual(ids('資　工'), ['engineering', 'info']);
});

test('名稱符合的學群排在前面，其他照 majorData 的順序', () => {
    assert.deepEqual(ids('醫'), ['medicine', 'engineering', 'management', 'life_sci']);
    assert.deepEqual(ids('傳播'), ['mass_comm', 'info']);
});

test('名稱符合時標成 byName，畫面上不另外寫符合的項目', () => {
    assert.deepEqual(ids('法政'), ['law']);
    assert.equal(find('法政', 'law').byName, true);
    assert.equal(find('工程', 'engineering').byName, true);
    assert.equal(find('工程', 'info').byName, false);
    assert.equal(find('大傳', 'mass_comm').byName, true);
});

test('ALIASES 對到 majors 或 careers 裡的一項，NAME_ALIASES 對到學群名稱，別名本身不是學類名稱', () => {
    const majors = new Set(majorData.flatMap((c) => c.majors));
    const careers = new Set(majorData.flatMap((c) => c.careers));
    const norm = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    for (const [alias, value] of Object.entries(ALIASES)) {
        assert.equal(alias, norm(alias), `${alias}：鍵要是小寫、半形、沒有空白，不然查不到`);
        for (const target of [value].flat()) assert.ok(majors.has(target) || careers.has(target), `${alias}：${target} 不在 majors 或 careers 裡`);
        assert.ok(!majors.has(alias), `${alias} 已經是學類名稱，不用寫在 ALIASES`);
    }
    const names = new Set(majorData.map((c) => c.name));
    for (const [alias, name] of Object.entries(NAME_ALIASES)) assert.ok(names.has(name), `${alias}：${name} 不是學群名稱`);
});

// [別名, 輸入, [[學群 id, [符合的 majors 和 careers]], ...]]。每一條 ALIASES、NAME_ALIASES 都有一列，輸入選的是
// 拿掉那一條就找不到（或結果不同）的寫法。加別名時這裡也要加一列，下面第二項會檢查。
const ALIAS_CASES = [
    ['資工', '資工', [['engineering', ['資訊工程']], ['info', ['資訊工程']]]],
    ['資管', '資管', [['info', ['資訊管理']], ['management', ['資訊管理']]]],
    ['資傳', '資傳', [['info', ['資訊傳播']], ['mass_comm', ['資訊傳播']]]],
    ['生資', '生資', [['info', ['生物資訊']], ['life_sci', ['生物資訊']]]],
    ['電機', '電機系', [['engineering', ['電機工程']], ['info', ['電機工程']]]],
    ['電子', '電子系', [['engineering', ['電子工程']], ['info', ['電子工程']]]],
    ['通訊', '通訊系', [['info', ['通訊工程']]]],
    ['機械', '機械系', [['engineering', ['機械工程']]]],
    ['土木', '土木系', [['engineering', ['土木工程']]]],
    ['材料', '材料系', [['engineering', ['材料工程']]]],
    ['化工', '化工', [['engineering', ['化學工程']]]],
    ['企管', '企管', [['management', ['企業管理']]]],
    ['商管', '商管', [['management', ['企業管理']]]],
    ['國企', '國企', [['management', ['國際企業']], ['finance', ['國際企業']]]],
    ['國貿', '國貿', [['management', ['國際企業']], ['finance', ['國際企業']]]],
    ['工管', '工管', [['management', ['工業管理']]]],
    ['醫管', '醫管', [['management', ['醫務管理']]]],
    ['財金', '財金', [['finance', ['財務金融']]]],
    ['社會', '社會系', [['social_psychology', ['社會學']]]],
    ['社工', '社工系', [['social_psychology', ['社會工作']]]],
    ['心輔', '心輔', [['social_psychology', ['輔導諮商']]]],
    ['犯防', '犯防', [['social_psychology', ['犯罪防治']], ['law', ['犯罪防治']]]],
    ['大傳', '大傳', [['mass_comm', ['大眾傳播']]]],
    ['工設', '工設', [['design', ['工業設計']]]],
    ['商設', '商設', [['design', ['商業設計']]]],
    ['服設', '服設', [['design', ['服裝設計']]]],
    ['室設', '室設', [['design', ['空間設計']]]],
    ['都計', '都計', [['design', ['都市計畫']]]],
    ['生物', '生物', [['life_sci', ['生命科學', '生物科技', '生物資訊']], ['info', ['生物資訊']]]],
    ['生科', '生科', [['life_sci', ['生命科學']]]],
    ['生技', '生技系', [['life_sci', ['生物科技']]]],
    ['醫科', '醫科', [['medicine', ['醫學', '醫學檢驗']]]],
    ['醫檢', '醫檢', [['medicine', ['醫學檢驗']]]],
    ['物治', '物治', [['medicine', ['物理治療', '物理治療師']]]],
    ['職治', '職治', [['medicine', ['職能治療']]]],
    ['公衛', '公衛', [['medicine', ['公共衛生']]]],
    ['財法', '財法', [['law', ['財經法律']]]],
    ['公行', '公行', [['law', ['行政管理']]]],
    ['公共行政', '公共行政', [['law', ['行政管理']]]],
    ['外交', '外交', [['law', ['政治']]]],
    ['外交官', '外交官', [['law', ['政治']]]],
    ['地政', '地政系', [['law', ['土地資產']]]],
    ['廣告', '廣告系', [['mass_comm', ['廣告公關']]]],
    ['行銷', '行銷系', [['management', ['行銷經營']]]],
    ['金融', '金融系', [['finance', ['財務金融']]]],
    ['統計', '統計系', [['info', ['數據統計']]]],
    ['觀光', '觀光系', [['management', ['觀光事業']]]],
    ['餐旅', '餐旅系', [['management', ['餐旅管理']]]],
    ['餐飲', '餐飲', [['management', ['餐旅管理']]]],
    ['餐飲管理', '餐飲管理', [['management', ['餐旅管理']]]],
    ['廣電', '廣電系', [['mass_comm', ['廣電電影']]]],
    ['電影', '電影系', [['mass_comm', ['廣電電影']]]],
    ['傳播', '傳播系', [['mass_comm', ['大眾傳播']]]],
    ['生醫', '生醫系', [['engineering', ['生醫工程']], ['life_sci', ['生醫工程']]]],
    ['醫工', '醫工系', [['engineering', ['生醫工程']], ['life_sci', ['生醫工程']]]],
    ['醫學工程', '醫學工程', [['engineering', ['生醫工程']], ['life_sci', ['生醫工程']]]],
    ['食品', '食品系', [['life_sci', ['食品生技']]]],
    ['食品科學', '食品科學', [['life_sci', ['食品生技']]]],
    ['室內設計', '室內設計系', [['design', ['空間設計']]]],
    ['人類民族', '人類民族', [['social_psychology', ['人類學、民族學']]]],
    ['兒童家庭', '兒童家庭', [['social_psychology', ['兒童與家庭']]]],
    ['中醫', '中醫', [['medicine', ['醫學', '醫學檢驗']]]],
    ['電腦', '電腦', [['engineering', ['資訊工程']], ['info', ['資訊工程']]]],
    ['人工智慧', '人工智慧', [['info', ['AI 工程師']]]],
    ['資料科學', '資料科學', [['info', ['數據統計']]]],
    ['大數據', '大數據', [['info', ['數據統計']]]],
    ['醫生', '醫生', [['medicine', ['醫師', '牙醫師']]]],
    ['護士', '護士', [['medicine', ['護理師']]]],
    ['程式', '程式', [['info', ['軟體工程師']]]],
    ['寫程式', '寫程式', [['info', ['軟體工程師']]]],
    ['程式設計', '程式設計', [['info', ['軟體工程師']]]],
    ['公務員', '公務員', [['law', ['公務人員']]]],
    ['銀行員', '銀行員', [['finance', ['銀行行員']]]],
    ['人資', '人資', [['management', ['人力資源']], ['social_psychology', ['人力資源']]]],
    ['臨床心理', '臨床心理', [['social_psychology', ['臨床或諮商心理師（要讀研究所再考證照）']]]],
    ['心理醫生', '心理醫生', [['social_psychology', ['臨床或諮商心理師（要讀研究所再考證照）']], ['medicine', ['醫師', '牙醫師']]]],
    ['諮商師', '諮商師', [['social_psychology', ['臨床或諮商心理師（要讀研究所再考證照）']]]],
    ['心理諮商', '心理諮商', [['social_psychology', ['輔導諮商']]]],
    ['數據分析師', '數據分析師', [['info', ['資料分析師']]]],
    ['ui設計師', 'UI設計師', [['design', ['UI/UX 設計師']]]],
    ['資訊科學', '資訊科學系', [['engineering', ['資訊工程']], ['info', ['資訊工程']]]],
    ['國際貿易', '國際貿易學系', [['management', ['國際企業']], ['finance', ['國際企業']]]],
    ['輔導', '輔導系', [['social_psychology', ['輔導諮商']]]],
    ['心理輔導', '心理輔導學系', [['social_psychology', ['輔導諮商']]]],
    ['動畫', '動畫', [['design', ['媒體設計']]]],
    ['旅遊管理', '旅遊管理學系', [['management', ['觀光事業']]]],
    ['觀光管理', '觀光管理學系', [['management', ['觀光事業']]]],
    ['精神科醫師', '精神科醫師', [['medicine', ['醫師', '牙醫師']]]],
    ['藥劑', '藥劑師', [['medicine', ['藥師']]]],
    ['理財', '理財師', [['finance', ['理財專員']]]],
    ['化工工程', '化工工程師', [['engineering', ['化學工程']]]],
    ['電腦科學', '電腦科學', [['engineering', ['資訊工程']], ['info', ['資訊工程']]]],
    ['心理與諮商', '心理與諮商學系', [['social_psychology', ['輔導諮商']]]],
    ['數位媒體', '數位媒體', [['design', ['媒體設計']]]],
    ['數位媒體設計', '數位媒體設計學系', [['design', ['媒體設計']]]],
    ['旅遊', '旅遊', [['management', ['觀光事業']]]],
    ['心理醫師', '心理醫師', [['social_psychology', ['臨床或諮商心理師（要讀研究所再考證照）']], ['medicine', ['醫師', '牙醫師']]]],
    ['精神科醫生', '精神科醫生', [['medicine', ['醫師', '牙醫師']]]],
    ['建築設計', '建築設計', [['design', []]]],
    ['建築與設計', '建築與設計', [['design', []]]],
    ['社會心理', '社會心理', [['social_psychology', []]]],
    ['社心', '社心', [['social_psychology', []]]],
];

test('每一條別名的例子都找得到對的學群和對的項目', () => {
    const full = (input) => searchClusters(majorData, input).map((r) => [r.cluster.id, [...r.majors, ...r.careers]]);
    for (const [, input, expected] of ALIAS_CASES) assert.deepEqual(full(input), expected, input);
});

test('ALIAS_CASES 列了每一條 ALIASES 和 NAME_ALIASES', () => {
    assert.deepEqual(ALIAS_CASES.map(([alias]) => alias).sort(), [...Object.keys(ALIASES), ...Object.keys(NAME_ALIASES)].sort());
});

test('打 constructor、__proto__ 這類 Object 上的名稱時不會出錯', () => {
    for (const input of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'constructor系']) {
        assert.doesNotThrow(() => searchClusters(majorData, input), input);
        assert.deepEqual(ids(input), [], input);
    }
});
