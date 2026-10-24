// admission-cycle.lib.mjs 的測試：哪些寫法算學年度、設定檔的規則、keep 放行的範圍，以及日期的邊界。
// 今天的日期一律由測試傳入，哪一天跑結果都一樣。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    checkContent,
    dueKeeps,
    findYears,
    isPast,
    isRealDate,
    remindWindow,
    taipeiToday,
    validateConfig,
} from './admission-cycle.lib.mjs';

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

