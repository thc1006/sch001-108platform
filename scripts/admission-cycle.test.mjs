// admission-cycle.lib.mjs 的測試：哪些寫法算學年度、設定檔的規則、keep 放行的範圍、日期的邊界，
// 以及每週提醒的 workflow 設定。今天的日期一律由測試傳入，哪一天跑結果都一樣。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    checkContent,
    cycleHints,
    dueKeeps,
    findFraming,
    findYears,
    isPast,
    isRealDate,
    pendingForNext,
    remindWindow,
    taipeiToday,
    validateConfig,
} from './admission-cycle.lib.mjs';
import { ADMISSION_CYCLE_MARKER, EXTERNAL_LINKS_MARKER, WATCHDOG_MARKER } from './watchdog-issue.lib.mjs';

const cfg = (fields = {}) => ({
    cycle: 115,
    next: 116,
    remindAfter: '2026-12-15',
    remindReason: '測試用的日期，落在 116 學年度的範圍裡。',
    keep: [],
    ...fields,
});
const textKeep = (file, text, fields = {}) => ({ file, text, cycle: 115, reason: '測試用的保留理由，至少十個字。', ...fields });
const urlKeep = (url, fields = {}) => ({ url, cycle: 115, reason: '測試用的保留理由，至少十個字。', ...fields });
// 區間寫成「開頭-結尾」，例如 text:113-115。
const years = (src) => findYears(src).map((t) => `${t.kind}:${t.from === undefined ? '' : `${t.from}-`}${t.year}`);
const errorsOf = (files, config) => checkContent(files, config).errors;

test('findYears：內文的學年度，區間算一個，列舉每個都算', () => {
    const cases = [
        ['115 學年度起，臺大醫學系改採社會科', ['text:115']],
        ['核心能力定義自 113 至 115 學年度保持穩定', ['text:113-115']],
        ['113 學年度至 115 學年度', ['text:113-115']],
        ['111、113 至 115 學年度', ['text:111', 'text:113-115']],
        ['115 至 119 學年度入學適用第三期', ['text:115-119']],
        ['**113** 至 **115** 學年度', ['text:113-115']],
        ['**114** 學年度', ['text:114']],
        ['*114* 學年度和 ~~113 學年度~~', ['text:114', 'text:113']],
        ['<strong>114</strong> 學年度', ['text:114']],
        ['１１４學年度', ['text:114']],
        ['2026/115 學年度三大趨勢', ['text:115']],
        ['115 學年度約有 609 至 611 個校系', ['text:115']],
    ];
    for (const [src, want] of cases) assert.deepEqual(years(src), want, src);
    assert.deepEqual(findYears('113 學年度至 115 學年度').map((t) => t.phrase), ['113 學年度至 115 學年度']);
});

test('findYears：每一種列舉和區間的符號', () => {
    for (const sep of ['、', '／', '/', '及', '和', '與', '或']) {
        assert.deepEqual(years(`114 ${sep} 115 學年度`), ['text:114', 'text:115'], `列舉「${sep}」`);
    }
    for (const sep of ['至', '到', '~', '～', '〜', '-', '–', '—', '－']) {
        assert.deepEqual(years(`113${sep}115 學年度`), ['text:113-115'], `區間「${sep}」`);
        assert.deepEqual(years(`113 學年度${sep}115 學年度`), ['text:113-115'], `「學年度${sep}」`);
    }
    // 已知限制：逗號不當列舉，理由見 admission-cycle.lib.mjs。
    assert.deepEqual(years('114，115 學年度'), ['text:115']);
    assert.deepEqual(years('114,115 學年度'), ['text:115']);
});

test('findYears：分隔符號後面可以換行，換行前不行', () => {
    assert.deepEqual(years('113 至\n115 學年度'), ['text:113-115']);
    assert.deepEqual(years('112 學年度至\n115 學年度'), ['text:112-115']);
    assert.deepEqual(years('114、\n115 學年度'), ['text:114', 'text:115']);
    assert.deepEqual(years('113 至\n\n115 學年度'), ['text:115'], '空一行就是另一段');
    assert.deepEqual(years('### 114 學年度\n- 115 學年度的內容'), ['text:114', 'text:115']);
    assert.deepEqual(years('115\n學年度'), []);
    const [t] = findYears('前一行\n112 學年度至\n115 學年度');
    assert.equal(t.line, 2);
});

test('findYears：不算內文的地方', () => {
    for (const src of [
        '115 年度預算',
        '115 學年 的規定',
        '115 年 3 月 31 日放榜',
        '甄選會新聞稿只比較 113–115 三年',
        '1150 學年度',
        '[64 校 115 二階審查資料準備指引](https://example.com/)',
        '[簡章](https://example.com/114學年度.pdf)',
        '[簡章](/files/114學年度簡章.pdf)',
        '<https://example.com/114學年度.pdf>',
        '[ref]: https://example.com/114學年度.pdf "114 學年度簡章"',
        'https://example.com/114學年度.pdf',
        '<!-- 114 學年度 -->',
        '<!--\n114 學年度\n-->',
    ]) {
        assert.deepEqual(years(src), [], src);
    }
    assert.deepEqual(years('113 學年度至 115 年'), ['text:113'], '區間的結尾要是學年度才算區間');
    // 裸網址到非 ASCII 字元為止，後面的中文照樣檢查。
    assert.deepEqual(years('見https://example.com/a。114 學年度的資料'), ['text:114']);
    const [t] = findYears('<!--\n114 學年度\n-->\n115 學年度');
    assert.deepEqual([t.year, t.line], [115, 4]);
});

test('findYears：甄選會網址的 applyNNN／starNNN', () => {
    const one = (src) => findYears(src).map((t) => `${t.year} ${t.phrase}`);
    assert.deepEqual(one('[統計](https://www.cac.edu.tw/apply115/stat_2.php)'), ['115 https://www.cac.edu.tw/apply115/stat_2.php']);
    assert.deepEqual(one('見 www.cac.edu.tw/apply114/guide.php。'), ['114 www.cac.edu.tw/apply114/guide.php']);
    assert.deepEqual(one('https://cac.edu.tw/apply114/'), ['114 https://cac.edu.tw/apply114/']);
    assert.deepEqual(one('https://www2.cac.edu.tw/apply114/'), ['114 https://www2.cac.edu.tw/apply114/']);
    assert.deepEqual(one('https://www.cac.edu.tw/star114/index.php, 下一句'), ['114 https://www.cac.edu.tw/star114/index.php']);
    assert.deepEqual(one('**https://www.cac.edu.tw/apply114/**'), ['114 https://www.cac.edu.tw/apply114/']);
    for (const end of ['」', '』', '》', '：', '！', '？', '…', '）']) {
        assert.deepEqual(one(`「https://www.cac.edu.tw/apply114/a.php${end}`), ['114 https://www.cac.edu.tw/apply114/a.php'], end);
    }
    for (const src of [
        'notcac.edu.tw/apply114/',
        'https://www.cac.edu.tw/apply1150/',
        'https://www.cac.edu.tw/cacportal/apply_his_report/111/111_member_statistics.php',
    ]) {
        assert.deepEqual(findYears(src), [], src);
    }
});

test('findYears：行號與位置對得回原文', () => {
    const src = '---\ntitle: x\n---\n\n本頁以 **114 學年度**為準。\n';
    const [t] = findYears(src);
    assert.equal(t.line, 5);
    assert.equal(src.slice(t.start, t.end), '114 學年度');
});

test('validateConfig：正確的設定沒有錯誤', () => {
    assert.deepEqual(validateConfig(cfg()), []);
    assert.deepEqual(validateConfig(cfg({ keep: [textKeep('a.md', '111 學年度'), urlKeep('https://www.cac.edu.tw/apply114/')] })), []);
});

test('validateConfig：cycle、next、remindAfter', () => {
    const one = (fields, re) => {
        const errors = validateConfig(cfg(fields));
        assert.equal(errors.length, 1, errors.join('\n'));
        assert.match(errors[0], re);
    };
    one({ next: 117 }, /next 必須是 cycle \+ 1，也就是 116/);
    one({ next: '116' }, /next 必須是 cycle \+ 1/);
    one({ cycle: 1150 }, /cycle 必須是三位數的整數/);
    one({ remindAfter: '2026-12-32' }, /remindAfter 必須是存在的 YYYY-MM-DD 日期/);
    one({ remindAfter: '2027-02-29' }, /remindAfter 必須是存在的/);
    one({ remindReason: '太短' }, /remindReason/);
    one({ keep: undefined }, /keep 必須是陣列/);
    one({ extra: 1 }, /不認得的欄位「extra」/);
    assert.deepEqual(validateConfig(null), ['設定檔的最外層必須是物件']);
});

test('validateConfig：remindAfter 的範圍兩端都算，超出一天就錯', () => {
    assert.deepEqual(remindWindow(116), { from: '2026-08-01', to: '2027-03-31' });
    assert.deepEqual(remindWindow(117), { from: '2027-08-01', to: '2028-03-31' });
    for (const ok of ['2026-08-01', '2027-03-31']) assert.deepEqual(validateConfig(cfg({ remindAfter: ok })), [], ok);
    for (const bad of ['2026-07-31', '2027-04-01']) {
        assert.match(validateConfig(cfg({ remindAfter: bad })).join('\n'), /必須在 2026-08-01 到 2027-03-31 之間/, bad);
    }
});

test('validateConfig：keep 的欄位', () => {
    const one = (k, re) => assert.match(validateConfig(cfg({ keep: [k] })).join('\n'), re);
    one(textKeep('a.md', '114 學年度', { cycle: 114 }), /keep\[0\] 的 cycle 是 114，和設定檔的 cycle 115 不同/);
    one(textKeep('a.md', '114 學年度', { reason: '九個字的保留理由喔' }), /keep\[0\] 的 reason 要寫為什麼保留這個年度，至少 10 個字/);
    one(textKeep('a.md', '114 學年度', { reason: '   九個字的保留理由喔   ' }), /keep\[0\] 的 reason/);
    one(textKeep('a.md', '114 學年度', { recheckAfter: '2027-13-01' }), /recheckAfter/);
    one(textKeep('a.txt', '114 學年度'), /file 必須是 \.md/);
    one(textKeep('a.md', '114\n學年度'), /同一行/);
    one(textKeep('a.md', '   '), /同一行/);
    one(textKeep('a.md', '114 學年度', { url: 'https://www.cac.edu.tw/apply114/' }), /不認得的欄位「file」，網址 keep 只能有 url、cycle、reason、recheckAfter/);
    one(textKeep('a.md', '114 學年度', { reasons: '多打了一個 s' }), /不認得的欄位「reasons」，文字 keep 只能有 file、text、cycle、reason、recheckAfter/);
    one(urlKeep('https://www.cac.edu.tw/apply115/'), /本來就放行，不需要 keep/);
    one(urlKeep('https://www.cac.edu.tw/apply116/'), /本來就放行，不需要 keep/);
    one(urlKeep('https://example.com/apply114/'), /完整的甄選會/);
    one(urlKeep('看 https://www.cac.edu.tw/apply114/'), /完整的甄選會/);
    one(urlKeep('114 學年度'), /完整的甄選會/);
    for (const k of [null, 'keep', ['x']]) one(k, /keep\[0\] 必須是物件/);
    assert.deepEqual(validateConfig(cfg({ keep: [textKeep('a.md', '114 學年度', { reason: '十個字的保留理由喔喔' })] })), []);
    const dup = textKeep('a.md', '114 學年度');
    assert.match(validateConfig(cfg({ keep: [dup, { ...dup }] })).join('\n'), /keep\[1\] 和前面的 keep 重複/);
    const u = urlKeep('https://www.cac.edu.tw/apply114/');
    assert.match(validateConfig(cfg({ keep: [u, { ...u }] })).join('\n'), /keep\[1\] 和前面的 keep 重複/);
});

const FILE = 'src/content/a.md';
const doc = (...lines) => [{ path: FILE, text: lines.join('\n') }];

test('checkContent：cycle 和 next 放行，其他年度報出位置', () => {
    const files = doc('115 學年度', '116 學年度', '[x](https://www.cac.edu.tw/apply116/)', '**114** 學年度', 'https://www.cac.edu.tw/apply113/');
    const { errors, found } = checkContent(files, cfg());
    assert.equal(found, 5);
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.match(errors[0], /^src\/content\/a\.md:4 「114 學年度」裡的 114 不是 115 或 116\n    \*\*114\*\* 學年度$/);
    assert.match(errors[1], /^src\/content\/a\.md:5 網址 https:\/\/www\.cac\.edu\.tw\/apply113\/ 的 113 不是 115 或 116/);
});

test('checkContent：區間包含 cycle 或 next 就放行', () => {
    const files = doc('113 至 115 學年度', '115 至 119 學年度入學適用第三期', '116 至 118 學年度', '112 至 114 學年度', '117 至 119 學年度');
    const errors = errorsOf(files, cfg());
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.match(errors[0], /a\.md:4 「112 至 114 學年度」不包含 115 或 116/);
    assert.match(errors[1], /a\.md:5 「117 至 119 學年度」不包含 115 或 116/);
});

test('checkContent：keep 只放行 text 那一段，同一行其他地方的不算', () => {
    const files = doc('多來自 111 學年度的舊統計；114 學年度另計。');
    const config = cfg({ keep: [textKeep(FILE, '多來自 111 學年度的舊統計')] });
    const { errors, kept } = checkContent(files, config);
    assert.equal(kept, 1);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /「114 學年度」裡的 114/);
});

test('checkContent：keep 要包含完整的學年度字樣，區間要從開頭包起', () => {
    const missing = /keep\[0\] 的 text 沒有完整包含任何一處學年度，區間和列舉要從第一個年度包到「學年度」/;
    let errors = errorsOf(doc('多來自 111 學年度的舊統計'), cfg({ keep: [textKeep(FILE, '多來自 111 學年')] }));
    assert.match(errors.join('\n'), /「111 學年度」裡的 111/);
    assert.match(errors.join('\n'), missing);
    errors = errorsOf(doc('比較 110 至 112 學年度的統計'), cfg({ keep: [textKeep(FILE, '112 學年度的統計')] }));
    assert.match(errors.join('\n'), /「110 至 112 學年度」不包含 115 或 116/);
    assert.match(errors.join('\n'), missing);
    assert.deepEqual(errorsOf(doc('比較 110 至 112 學年度的統計'), cfg({ keep: [textKeep(FILE, '110 至 112 學年度')] })), []);
    errors = errorsOf(doc('見 https://www.cac.edu.tw/apply114/ 。'), cfg({ keep: [textKeep(FILE, 'https://www.cac.edu.tw/apply114/')] }));
    assert.match(errors.join('\n'), /keep\[0\] 的 text 只包含網址，網址要寫成網址 keep（url）/);
});

test('checkContent：殭屍 keep、重複出現的 text、本來就放行的 keep', () => {
    const files = doc('115 學年度的資料', '舊的 114 學年度', '舊的 114 學年度');
    const check = (k, re) => assert.match(errorsOf(files, cfg({ keep: [k] })).join('\n'), re);
    check(textKeep(FILE, '已經刪掉的 113 學年度'), /keep\[0\] 的 text 在 src\/content\/a\.md 裡找不到/);
    check(textKeep('src/content/gone.md', '113 學年度'), /keep\[0\] 的 file「src\/content\/gone\.md」不在比對的檔案裡/);
    check(textKeep(FILE, '舊的 114 學年度'), /keep\[0\] 的 text 在 src\/content\/a\.md 裡不只一處/);
    check(textKeep(FILE, '115 學年度的資料'), /keep\[0\] 的 text 裡的學年度本來就放行，不需要 keep/);
    check(urlKeep('https://www.cac.edu.tw/apply114/'), /keep\[0\] 的網址 https:\/\/www\.cac\.edu\.tw\/apply114\/ 已經不在內容裡/);
});

test('checkContent：同一個年度被兩筆 keep 放行要報錯', () => {
    const files = doc('坊間的數字多來自 111 學年度的舊統計');
    const errors = errorsOf(files, cfg({ keep: [textKeep(FILE, '多來自 111 學年度'), textKeep(FILE, '111 學年度的舊統計')] }));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /「111 學年度」同時被 keep\[0\]、keep\[1\] 放行/);
    // 其中一筆另外包到 115 的話，它不是本來就放行，只報重疊。
    const mixed = doc('115 學年度和 111 學年度的舊統計');
    const both = errorsOf(mixed, cfg({ keep: [textKeep(FILE, '115 學年度和 111 學年度'), textKeep(FILE, '111 學年度的舊統計')] }));
    assert.equal(both.length, 1, both.join('\n'));
});

test('checkContent：錯誤訊息附上前後各 30 個字', () => {
    const before = '一'.repeat(40);
    const [error] = errorsOf(doc(`${before}114 學年度${'二'.repeat(40)}`), cfg());
    assert.equal(error.split('\n    ')[1], `…${'一'.repeat(30)}114 學年度${'二'.repeat(30)}…`);
    const [cross] = errorsOf(doc('112 學年度至', '114 學年度'), cfg());
    assert.match(cross, /^src\/content\/a\.md:1 「112 學年度至 114 學年度」不包含 115 或 116\n    112 學年度至 114 學年度$/);
});

test('checkContent：網址 keep 只放行完全相同的網址', () => {
    const files = doc('[指引](https://www.cac.edu.tw/apply114/guide.php)', '[指引](https://www.cac.edu.tw/apply114/guide.php#top)');
    const errors = errorsOf(files, cfg({ keep: [urlKeep('https://www.cac.edu.tw/apply114/guide.php')] }));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /a\.md:2 網址 https:\/\/www\.cac\.edu\.tw\/apply114\/guide\.php#top 的 114/);
});

test('checkContent：沒有檔案，或一個學年度都找不到，都不能算通過', () => {
    assert.match(errorsOf([], cfg()).join('\n'), /沒有任何 \.md 檔/);
    assert.match(errorsOf(doc('沒有年度的內容'), cfg()).join('\n'), /1 個檔案裡找不到任何學年度或甄選會網址/);
});

test('findFraming：西元年當申請年度的寫法', () => {
    const hits = [
        ['## 2026 升學風向：從「軍備競賽」到「個人成長史」', '2026 升學'],
        ['### APCS 自 114 學年度起改制（2026 考生必讀）', '2026 考生'],
        ['title: 管理學群科系風向標：學群定位、各學類與 2026 升學趨勢', '2026 升學'],
        ['## 三、2026 招生管道全解析', '2026 招生'],
        ['以權威資料還原 2026 申請的真實規則。', '2026 申請'],
        ['2026 年備審多採「自製 PDF 上傳」', '2026 年備審'],
        ['但 2026 年的選才標準正在發生結構性位移', '2026 年的選才'],
        ['| 舊思維 | 2026 的審查風向 |', '2026 的審查'],
        ['2026 年大傳學群的審查核心', '2026 年大傳學群的審查'],
        ['## 一、2026 三大風向', '2026 三大風向'],
        ['## 2026 產業趨勢與選才方向', '2026 產業趨勢與選才'],
        ['**2026** 升學趨勢', '2026 升學'],
        ['２０２６ 升學趨勢', '2026 升學'],
        ['2027 年的申請', '2027 年的申請'],
        ['[2026 升學趨勢] 不是連結', '2026 升學'],
        ['[2026 升學趨勢][x] 沒有定義，不是連結', '2026 升學'],
        ['[某篇文章][a]談 2026 升學\n\n[a]: https://example.com/', '2026 升學'],
    ];
    for (const [src, phrase] of hits) assert.deepEqual(findFraming(src).map((h) => h.phrase), [phrase], src);
    const misses = [
        '2026 產業趨勢：工程的語言正在改變',
        '## 2026 傳播產業五大趨勢（直接影響面試與備審）',
        '在 AI 能流暢代寫的 2026 年，這條紅線延伸至「用 AI 代寫」',
        '一階篩選於 2026 年 3 月 31 日放榜',
        '> 對應 2026 年／115 學年度大學申請入學',
        '以 115 學年度（2026 年）申請入學為例',
        '2026/115 學年度三大趨勢',
        '本頁以 2026 年、即 115 學年度個人申請現況為準。',
        '甄選會 2026 年 10 月 27 日公告的 116 學年度參採科目一覽表',
        '2026 年傑出生技產業獎的審查',
        '收件 2026/4/27–7/6，報名',
        '- [Cheers「2026 大學申請全攻略」](https://example.com/)',
        '- [2026 大學「個人申請」面試必勝秘笈](https://example.com/2026-申請)',
        '依《2026 大學申請入學簡章》辦理',
        '- [Cheers「2026 大學申請全攻略」][cheers]\n\n[cheers]: https://example.com/',
        '- [2026 大學申請全攻略][]\n\n[2026 大學申請全攻略]: <https://example.com/> "2026 大學申請全攻略"',
        "- [2026 大學申請全攻略]\n\n   [2026 大學申請全攻略]: https://example.com/ '2026 大學申請'",
        '- [2026 升學趨勢][Ref]\n\n[ref]: https://example.com/',
        '- [２０２６ 升學趨勢][] [**2026 申請**][]\n\n[２０２６ 升學趨勢]: https://example.com/a\n[**2026 申請**]: https://example.com/b',
        '- [某篇][a]、[另一篇][b]\n\n[a]: https://example.com/a "2026 大學申請攻略"\n[b]: <https://example.com/b> (2026 申請)',
        '<!-- 2026 升學趨勢 -->',
        'https://example.com/2026升學趨勢',
        '12026 升學',
        '2026\n升學',
        '2026\n年的升學',
        '2026 年—升學',
        '2026 年·升學',
        '2026 年～升學',
        '2026 年 - 升學',
    ];
    for (const src of misses) assert.deepEqual(findFraming(src), [], src);
});

test('findFraming、findYears：定義只認寫在同一行的，下一行一律照查', () => {
    const framing = (...lines) => findFraming(lines.join('\n')).map((h) => `${h.line}:${h.phrase}`);
    assert.deepEqual(framing('[2026 升學趨勢][a]', '', '[a]: <https://x/> "2026 大學申請攻略"'), []);
    // 網址或標題寫到下一行的定義不認，那幾行照內文查，標籤也不算定義過。
    assert.deepEqual(framing('[某][a]', '', '[a]: https://x/', '(2026 升學趨勢)'), ['4:2026 升學']);
    assert.deepEqual(framing('[某][a]', '', '[a]: <https://x/>', "  '2026 申請'"), ['4:2026 申請']);
    assert.deepEqual(framing('[2026 升學趨勢][a]', '', '[a]:', '<https://x/> "2026 申請"'), ['1:2026 升學', '4:2026 申請']);
    assert.deepEqual(framing('[某][a]', '', '[a]: https://x/ "標題"', '(2026 升學趨勢是作者寫的)'), ['4:2026 升學']);
    assert.deepEqual(framing('[某][a]', '', '[a]: https://x/', '"2026 升學" 趨勢'), ['4:2026 升學']);
    assert.deepEqual(framing('[某][a]', '', '[a]:', '', '2026升學趨勢'), ['5:2026升學']);
    assert.deepEqual(framing('正文[^1]', '', '[^1]:', '    2026 升學趨勢是作者的話'), ['4:2026 升學']);
    assert.deepEqual(framing('正文[^1]', '', '[^1]: 註', '    "2026 升學趨勢"'), ['4:2026 升學'], '註腳的內容');
    assert.deepEqual(years('[某][a]\n\n[a]: https://x/ "標題"\n(115 學年度起適用)'), ['text:115']);
    assert.deepEqual(years('[某][a]\n\n[a]:\n(115 學年度起適用)'), ['text:115']);
});

test('findFraming、findYears：定義要在區塊開頭，插在段落或清單項目中間的 [id]: 不是定義，下一行照查', () => {
    const framing = (...lines) => findFraming(lines.join('\n')).map((h) => `${h.line}:${h.phrase}`);
    assert.deepEqual(years('這是一段話\n[注意]:\n今年115學年度起適用新制。'), ['text:115']);
    assert.deepEqual(framing('這是一段話', '[注意]:', '2026升學趨勢整理。'), ['3:2026升學']);
    assert.deepEqual(framing('- 項目文字', '  [a]: https://x/', '  (2026 升學趨勢)'), ['3:2026 升學']);
    assert.deepEqual(framing('一段文字', '[2026 升學趨勢]: https://x/', '', '[2026 升學趨勢] 是作者的話'), ['4:2026 升學']);
    assert.deepEqual(framing('# 標題', '[注意]:', '2026升學趨勢整理。'), ['3:2026升學']);
    // 文件開頭、空行、ATX 標題、另一個定義、圍欄結束的下一行可以是定義；setext 標題和 HTML 區塊的下一行不算。
    assert.deepEqual(framing('[2026 升學趨勢][a] [2026 申請][b]', '', '[a]: https://x/', '[b]: https://y/ "某篇"'), []);
    assert.deepEqual(framing('# 標題', '[a]: https://x/', '', '[2026 升學趨勢][a]'), []);
    assert.deepEqual(framing('```', 'x', '```', '[a]: https://x/', '', '[2026 升學趨勢][a]'), []);
    assert.deepEqual(framing('標題', '===', '[a]: https://x/', '', '[2026 升學趨勢][a]'), ['5:2026 升學']);
    assert.deepEqual(framing('<!-- 註解 -->', '[a]: https://x/', '', '[2026 升學趨勢][a]'), ['4:2026 升學']);
    assert.deepEqual(framing('<!--', '註解', '-->', '[a]: https://x/', '', '[2026 升學趨勢][a]'), ['6:2026 升學']);
});

test('findFraming：不合規則的定義、HTML 區塊和程式碼裡的定義不算，\\[x] 和程式碼裡的 [x] 不是連結', () => {
    for (const src of [
        '[2026 升學趨勢]:\n\n[2026 升學趨勢] 是作者的話',
        '[2026 升學趨勢]: 作者 整理\n\n[2026 升學趨勢] 是作者的話',
        "[2026 升學趨勢]: /u '標題\n\n後半'\n\n[2026 升學趨勢] 是作者的話",
        '<div>\n[2026 升學趨勢]: https://x/\n</div>\n\n[2026 升學趨勢] 是作者的話',
        '```md\n[2026 升學趨勢]: https://x/\n```\n\n[2026 升學趨勢] 是作者的話',
        '````\n```\n[2026 升學趨勢]: https://x/\n````\n\n[2026 升學趨勢] 是作者的話',
        '```\n~~~\n[2026 升學趨勢]: https://x/\n```\n\n[2026 升學趨勢] 是作者的話',
        '<!--\n[2026 升學趨勢]: https://x/\n\n[2026 升學趨勢] 是作者的話',
        '正文[^1]\n\n[^1]: 註\n[2026 升學趨勢]: /u\n\n[2026 升學趨勢] 是作者的話',
        '[2026 升學趨勢]: https://x/(\n\n[2026 升學趨勢] 是作者的話',
        '[2026 升學趨勢]: https://x/\u0001\n\n[2026 升學趨勢] 是作者的話',
        '<pre>\n\n[2026 升學趨勢]: https://x/\n</pre>\n\n[2026 升學趨勢] 是作者的話',
        '<?php\n\n[2026 升學趨勢]: https://x/\n?>\n\n[2026 升學趨勢] 是作者的話',
        '<![CDATA[\n\n[2026 升學趨勢]: https://x/\n]]>\n\n[2026 升學趨勢] 是作者的話',
        '<!DOCTYPE x\n\n[2026 升學趨勢]: https://x/\n>\n\n[2026 升學趨勢] 是作者的話',
        '<!--\n\n[2026 升學趨勢]: https://x/\n-->\n\n[2026 升學趨勢] 是作者的話',
        '---\ntitle: t\n\n[2026 升學趨勢]: https://x/\n---\n\n[2026 升學趨勢] 是作者的話',
    ]) assert.deepEqual(findFraming(src).map((h) => h.phrase).slice(-1), ['2026 升學'], src);
    assert.deepEqual(findFraming('\\[2026 升學趨勢]\n\n[2026 升學趨勢]: https://x/').map((h) => h.line), [1]);
    assert.deepEqual(findFraming('`[2026 升學趨勢]`\n\n[2026 升學趨勢]: https://x/').map((h) => h.line), [1]);
    assert.deepEqual(findFraming('[2026 升學趨勢`][a]`\n\n[a]: https://x/').map((h) => h.line), [1]);
    assert.deepEqual(findFraming('`a\n[2026 升學趨勢] b`\n\n[2026 升學趨勢]: https://x/').map((h) => h.line), [2], '跨行的程式碼');
    assert.deepEqual(findFraming('`` a ` [2026 升學趨勢]\n\n[2026 升學趨勢]: https://x/'), [], '反引號沒有成對');
    assert.deepEqual(findFraming('`` a ` [2026 升學趨勢] ` b\n\n[2026 升學趨勢]: https://x/').map((h) => h.line), [1], '反引號一樣長才成對');
    assert.deepEqual(findFraming('`a\n\n[2026 升學趨勢] b`\n\n[2026 升學趨勢]: https://x/'), [], '程式碼不跨空行');
    assert.deepEqual(findFraming('[2026 升學 *[某篇][a]*][a]\n\n[a]: https://x/').map((h) => h.phrase), ['2026 升學'], '連結文字裡不能有連結');
    assert.deepEqual(findFraming('2026[^1]升學趨勢\n\n[^1]: 註').map((h) => h.line), [1], '註腳的參照不是字');
});

test('findFraming、cycleHints：[X][Y](網址) 的連結文字是 Y，[X] 照內文', () => {
    assert.deepEqual(findFraming('[2026 升學趨勢][簡章](https://x/)').map((h) => h.phrase), ['2026 升學']);
    assert.deepEqual(findFraming('見[2026 年申請][官方簡章](https://x/)。').map((h) => h.phrase), ['2026 年申請']);
    assert.deepEqual(findFraming('[2026 升學趨勢][](https://x/)').map((h) => h.phrase), ['2026 升學']);
    assert.deepEqual(cycleHints('[PDF][2026 申請簡章](https://x/)', 115).map((h) => `${h.kind}:${h.phrase}`), ['title:2026 申請簡章']);
});

test('findFraming：參考式連結的標籤去掉頭尾空白、合併中間的空白，frontmatter、程式碼與 HTML 註解裡的定義不算', () => {
    assert.deepEqual(findFraming('[ 2026 升學趨勢 ][] [2026  升學趨勢][]\n\n[2026 升學趨勢]: https://x/'), []);
    for (const src of [
        '[2026 升學趨勢] 是我寫的\n\n```\n[2026 升學趨勢]: https://x/\n```',
        '[2026 升學趨勢] 是我寫的\n\n~~~~\n[2026 升學趨勢]: https://x/\n~~~~',
        '[2026 升學趨勢] 是我寫的\n\n<!--\n[2026 升學趨勢]: https://x/\n-->',
        '---\n[2026 升學趨勢]: x\n---\n[2026 升學趨勢] 是我寫的',
    ]) assert.deepEqual(findFraming(src).map((h) => h.phrase), ['2026 升學'], src);
});

test('checkContent：西元年當申請年度要報錯，附上位置和前後文', () => {
    const files = doc('115 學年度', '## 2026 升學趨勢', '2026 年 3 月 31 日放榜');
    const errors = errorsOf(files, cfg());
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.equal(errors[0], 'src/content/a.md:2 「2026 升學」用西元年當申請年度，一年後就過期。拿掉年份，或寫成「NNN 學年度」\n    ## 2026 升學趨勢');
    // keep 放不行。
    const kept = errorsOf(files, cfg({ keep: [textKeep(FILE, '2026 升學趨勢')] }));
    assert.match(kept.join('\n'), /a\.md:2 「2026 升學」用西元年當申請年度/);
});

test('cycleHints：cycle 這一屆的時程日期，申請入學那幾個月、同一行有時程的字才算', () => {
    const dates = (...lines) => cycleHints(lines.join('\n'), 115).filter((h) => h.kind === 'date').map((h) => `${h.line}:${h.phrase}`);
    assert.deepEqual(dates(
        '| 115 年 3 月 31 日（二）9 時 | 一階篩選結果公告 |',
        '| 一階篩選放榜 | 2026 年 3 月 31 日 |',
        '- **二階指定項目甄試**落在 **2026 年 5 月 14 日至 5 月 31 日**之間',
        '分發入學 2026 年 8 月放榜',
    ), ['1:115 年 3 月', '2:2026 年 3 月', '3:2026 年 5 月', '4:2026 年 8 月']);
    assert.deepEqual(dates(
        '甄選會 2026 年 9 月公告的一覽表',
        '台灣社會學會 2026 年 5 月舉行年會',
        '114 年 3 月 31 日放榜',
        '2025 年 3 月 31 日放榜',
        '2116 年 3 月 31 日放榜',
        '- [115 年 6 月簡則公告](https://example.com/)',
    ), []);
});

test('cycleHints：連結文字裡寫著 cycle 這一屆的標題', () => {
    const titles = (...lines) => cycleHints(lines.join('\n'), 115).filter((h) => h.kind === 'title').map((h) => `${h.line}:${h.phrase}`);
    assert.deepEqual(titles(
        '- [115 備審資料準備指引一覽 — TKB](https://example.com/a)',
        '- [64 校 115 二階審查資料準備指引(今周刊)](https://example.com/b)',
        '- [【115審查資料準備指引】](https://example.com/c)',
        '- [Cheers「2026 大學申請全攻略」](https://example.com/d)',
        '- [115 備審指引彙整][t]',
        '- [Cheers「2026 大學申請全攻略」][]',
        '',
        '[t]: https://example.com/t',
        '[cheers「2026 大學申請全攻略」]: https://example.com/c',
    ), ['1:115 備審資料準備指引一覽 — TKB', '2:64 校 115 二階審查資料準備指引(今周刊)', '3:【115審查資料準備指引】', '4:Cheers「2026 大學申請全攻略」',
        '5:115 備審指引彙整', '6:Cheers「2026 大學申請全攻略」']);
    assert.deepEqual(titles(
        '- [115 學年度申請入學統計資料](https://example.com/a)',
        '- [適用115至119學年度入學](https://example.com/b)',
        '- [113-115 年重點產業人才供需調查](https://example.com/c)',
        '- [寫於 115 年 6 月簡則公告前](https://example.com/d)',
        '- [114 備審資料準備指引](https://example.com/e)',
        '- [1150 個名額](https://example.com/f)',
        '- [2026 暑假高中生營隊總覽](https://example.com/g)',
        '- [TISF 2026 臺灣國際科學展覽會](https://example.com/h)',
        '115 備審資料準備指引',
        '- [指引](https://example.com/115-備審)',
        '- [115 備審資料準備指引][沒有定義]',
    ), []);
});

test('pendingForNext：換成 next 之後不放行的年度，keep 也列出來', () => {
    const files = doc(
        '115 學年度',
        '116 學年度',
        '117 學年度',
        '多來自 111 學年度的舊統計',
        'https://www.cac.edu.tw/apply115/',
        '113 至 115 學年度',
        '115 至 119 學年度入學適用第三期',
    );
    const config = cfg({ keep: [textKeep(FILE, '多來自 111 學年度的舊統計')] });
    const pending = pendingForNext(files, config).map((h) => [h.line, h.kind, h.year, h.by]);
    assert.deepEqual(pending, [
        [1, 'text', 115, []],
        [4, 'text', 111, [0]],
        [5, 'url', 115, []],
        [6, 'text', 115, []],
    ]);
});

test('日期：isRealDate、isPast 當天不算過、taipeiToday 用台灣的日曆日', () => {
    assert.ok(isRealDate('2028-02-29'));
    assert.ok(!isRealDate('2027-02-29'));
    assert.ok(!isRealDate('2026-1-05'));
    assert.ok(!isPast('2026-12-15', '2026-12-15'));
    assert.ok(isPast('2026-12-15', '2026-12-16'));
    assert.ok(!isPast('2026-12-15', '2026-12-14'));
    assert.equal(taipeiToday(new Date('2026-12-15T15:59:59Z')), '2026-12-15');
    assert.equal(taipeiToday(new Date('2026-12-15T16:00:00Z')), '2026-12-16');
});

test('dueKeeps：recheckAfter 過了才列，當天不列，沒填的不列', () => {
    const config = cfg({
        keep: [
            urlKeep('https://www.cac.edu.tw/apply114/guide.php', { recheckAfter: '2027-03-31' }),
            textKeep(FILE, '111 學年度'),
        ],
    });
    assert.deepEqual(dueKeeps(config, '2027-03-31'), []);
    assert.deepEqual(dueKeeps(config, '2027-04-01').map((d) => d.index), [0]);
});

test('admission-cycle.json：repo 裡的設定通過 validateConfig', () => {
    const config = JSON.parse(readFileSync(new URL('./admission-cycle.json', import.meta.url), 'utf8'));
    assert.deepEqual(validateConfig(config), []);
});

// 下面幾條釘住 admission-cycle-check.yml 的設定。YAML 改壞了不會有錯誤，要等哪一週 issue 開錯地方才發現。
// Windows 上 checkout 出來可能是 CRLF，比對前換成 LF。
const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOW = 'admission-cycle-check.yml';
const OTHER_WATCHDOGS = ['competitions-check.yml', 'civic-tech-check.yml', 'external-links-check.yml'];
// 註解裡也會提到 --app、標籤和檔名，只看會執行的行。
const code = () => workflow(WORKFLOW).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('workflow：機器標記和 ADMISSION_CYCLE_MARKER 相同，另外三支看門狗都沒有用它', () => {
    assert.ok(workflow(WORKFLOW).includes(`MARKER: '${ADMISSION_CYCLE_MARKER}'`));
    assert.notEqual(ADMISSION_CYCLE_MARKER, WATCHDOG_MARKER);
    assert.notEqual(ADMISSION_CYCLE_MARKER, EXTERNAL_LINKS_MARKER);
    for (const other of OTHER_WATCHDOGS) assert.ok(!workflow(other).includes(ADMISSION_CYCLE_MARKER), other);
});

test('workflow：只在 main 上由排程或手動執行，排程是每週一', () => {
    const y = workflow(WORKFLOW);
    const on = y.match(/^on:\n((?: {2}.*\n|\n)+)/m)[1];
    assert.deepEqual([...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]), ['schedule', 'workflow_dispatch']);
    assert.match(on, /^ {4}- cron: '\d+ \d+ \* \* 1'/m);
    assert.match(y, /if: github\.ref == 'refs\/heads\/main'/);
    assert.match(y, /GITHUB_REF" != "refs\/heads\/main"/, 'if: 被拿掉時要有第二道會 exit 1 的檢查');
    assert.match(y, /schedule\|workflow_dispatch\)/);
});

test('workflow：權限、concurrency、逾時，action 釘在 commit SHA', () => {
    const y = workflow(WORKFLOW);
    assert.match(y, /^permissions:\n {2}contents: read\n\njobs:/m, 'workflow 層級只能有 contents: read');
    assert.match(y, /permissions:\n {6}contents: read\n {6}issues: write\n/);
    assert.match(y, /concurrency:\n {2}group: admission-cycle-watchdog\n {2}cancel-in-progress: false\n/);
    assert.match(y, /timeout-minutes: \d+/);
    assert.match(y, /persist-credentials: false/);
    const uses = [...y.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
    assert.equal(uses.length, 2);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
});

test('workflow：開 issue 的那一步讀得到 --remind 的結果，檢查失敗時照樣執行', () => {
    const c = code();
    const id = c.match(/id: (\S+)\n\s+run: node scripts\/check-admission-cycle\.mjs --remind\n/)?.[1];
    assert.ok(id, '跑 --remind 的那一步要有 id');
    // 內容有錯時檢查以 1 結束，少了 always() 就不會開 issue。
    assert.ok(c.includes(`if: always() && steps.${id}.outputs.needs_attention == 'true'`), `開 issue 的條件要讀 steps.${id}`);
    assert.match(c, /if ! grep -qF -- "\$MARKER" admission-cycle-report\.md; then\n\s+echo .+\n\s+exit 1\n/, '報告沒有機器標記就中止');
    const reports = [...c.matchAll(/[\w.-]*report[\w.-]*\.md/g)].map((m) => m[0]);
    assert.deepEqual([...new Set(reports)], ['admission-cycle-report.md'], '報告檔名要和 check-admission-cycle.mjs 寫的一樣');
});

test('workflow：認領交給 find-watchdog-issue.mjs，標籤只有一個，不用 gh issue list --app', () => {
    const c = code();
    assert.match(c, /find-watchdog-issue\.mjs --marker "\$MARKER"/);
    assert.ok(!/--app\b/.test(c));
    const labels = [...c.matchAll(/(?:--label|gh label create --force) (\S+)/g)].map((m) => m[1]);
    assert.equal(labels.length, 3, '建立、列出、新開各用一次');
    assert.deepEqual([...new Set(labels)], ['admission-cycle-watchdog']);
});

test('workflow：排程時間和另外三支看門狗錯開', () => {
    const cron = (name) => [...workflow(name).matchAll(/cron: '([^']+)'/g)].map((m) => m[1]);
    const [mine, ...rest] = cron(WORKFLOW);
    assert.ok(mine && rest.length === 0);
    for (const other of OTHER_WATCHDOGS) assert.ok(!cron(other).includes(mine), `${other} 也排在 ${mine}`);
});
