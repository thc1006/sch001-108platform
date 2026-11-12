// public/shared/platform-ai.js 的 findPhoneNumbers、linkPhoneNumbers：career-chat 回答裡的求助專線
// 哪些換成 tel: 連結。用 vm 載入前端腳本；DOM 只做 linkPhoneNumbers 用到的部分，沒有 innerHTML。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/shared/platform-ai.js', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(source, sandbox);
const { _findPhoneNumbers: find, linkPhoneNumbers } = sandbox.PlatformAI;

// 與 src/pages/career-exploration/index.astro 的 HELP_NUMBERS 相同。
const NUMBERS = ['1925', '113', '119', '110'];
// 前端腳本在另一個 realm，陣列先轉成這邊的，deepEqual 才比得了。
const hits = (text) => [...find(text, NUMBERS)];
const numbersIn = (text) => hits(text).map((hit) => hit.number);

test('前面是撥、打、專線、電話，或後面是報警、專線的號碼都算', () => {
    const cases = [
        ['也可以打衛福部安心專線 1925（24 小時），有立即危險時撥 119。', ['1925', '119']],
        ['請現在立刻撥打 110 報警，確保自己安全。', ['110']],
        ['也可以打衛福部保護專線 113（24 小時）尋求協助。', ['113']],
        ['正在被攻擊撥110。', ['110']],
        ['先撥 119；也可以打 1925', ['119', '1925']],
        ['緊急時打 110，也可打 113 諮詢。', ['110', '113']],
        ['113 家庭暴力保護專線', ['113']],
        ['1925 安心專線', ['1925']],
        ['先 110 報警', ['110']],
        ['保護專線（113）', ['113']],
        ['可以打給 113', ['113']],
        ['電話 1925', ['1925']],
        ['致電 1925', ['1925']],
        ['113 求救', ['113']],
        ['113 家暴專線', ['113']],
        ['安心專線：1925', ['1925']],
        ['保護專線: 113', ['113']],
        ['撥「110」報警', ['110']],
        ['撥「110」', ['110']],
        ['請「110」報警', ['110']],
        ['可以打 1925 分享你的感受', ['1925']],
        ['撥 113 分機 5', ['113']],
        ['113 保護專線', ['113']],
        ['113 求助', ['113']],
        ['撥(110)', ['110']],
        ['1925（安心專線）', ['1925']],
        ['- 1925（安心專線，24 小時）', ['1925']],
    ];
    for (const [text, expected] of cases) assert.deepEqual(numbersIn(text), expected, text);
});

test('接在算數的號碼後面、中間只有「、」「或」這類字時也算；中間有別的字就不算', () => {
    assert.deepEqual(numbersIn('撥 119、1925、110、113'), ['119', '1925', '110', '113']);
    assert.deepEqual(numbersIn('撥打 110 或 119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 110 或是 119'), ['110', '119']);
    assert.deepEqual(numbersIn('先撥 110，113 學年度起改了'), ['110']);
    assert.deepEqual(numbersIn('撥 110 報警，第 113 頁有說明'), ['110']);
    assert.deepEqual(numbersIn('110 或 113 學年度'), []);
    assert.deepEqual(numbersIn('撥 110 報警或 119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 1925（安心專線）或 119'), ['1925', '119']);
    assert.deepEqual(numbersIn('撥 110/119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 110 和 119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 110 和 119 分別是報警和救護'), ['110', '119']);
    assert.deepEqual(numbersIn('撥打 110，或 119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 110, 或 119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 110 及 119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 110 與 119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 110／119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥打「110」或「119」'), ['110', '119']);
    assert.deepEqual(numbersIn('撥（110）或（119）'), ['110', '119']);
    assert.deepEqual(numbersIn('打「1925」、「113」'), ['1925', '113']);
    assert.deepEqual(numbersIn('撥 110 報警或「119」'), ['110', '119']);
    assert.deepEqual(numbersIn('撥打 110 或者 119'), ['110', '119']);
    assert.deepEqual(numbersIn('撥 1925 以及 113'), ['1925', '113']);
    assert.deepEqual(numbersIn('撥 110、113 年的資料'), ['110']);
    assert.deepEqual(numbersIn('撥 110，或 113 年的簡章'), ['110']);
    assert.deepEqual(numbersIn('撥 110，113 也可以'), ['110']);
    // 前後文不跨行
    assert.deepEqual(numbersIn('撥 110\n或 119'), ['110']);
    assert.deepEqual(numbersIn('可以撥打\n113 號'), []);
    assert.deepEqual(numbersIn('113\n專線'), []);
});

test('年度、頁數、金額、分數裡的數字，後面接著單位的，以及前後接著數字（含全形、-、.）的都不算', () => {
    const texts = [
        '1100 元',
        '110 學年度的分科測驗',
        '第 113 頁',
        '1925 年成立',
        '113 學年度起',
        '考了 119 分',
        '撥 1100',
        '打 11000 字',
        '專線 1130',
        '撥 0119',
        '電話 02-21190110',
        '110113119',
        '0110 報警',
        '21130 專線',
        '打 110 分',
        '我打 110 個字',
        '打 113 頁的報告',
        '撥打 113 名',
        '打 119 次',
        '撥 110 學年度',
        '撥打 113-1234',
        '撥 110.5',
        '撥 110０',
        '撥 ０110',
        '撥 3.110',
        '撥 2-110',
        '０110 報警',
        '3.110 報警',
        '2-110 報警',
        '２.110 報警',
        '撥 113－1234',
        '撥 113–1234',
        '2–110 報警',
        '3．110 報警',
        '撥 110．5',
        '撥 113-１２３４',
        '113 校安專線',
        '打 113 字',
        '打 113 年的比賽',
        '專線：113 年度',
    ];
    for (const text of texts) assert.deepEqual(numbersIn(text), [], text);
});

// 改寫前的 PHONE_JOIN 有四段相連的空白，1000 個空白要算一分鐘以上；PHONE_BEFORE 寫成三段相連的空白時，
// 2000 個要兩秒多。regex 跑完之前 timeout 不會觸發，所以另外量時間。後面接「號」：接「年」的話 PHONE_UNIT
// 先擋下，PHONE_JOIN、PHONE_BEFORE 不會跑到。
test('號碼前後接一長串空白時不會卡住', { timeout: 2000 }, () => {
    for (const space of [' ', '\u3000', '\t']) {
        const started = performance.now();
        assert.deepEqual(numbersIn('撥 110' + space.repeat(1000) + '，113 號'), ['110'], JSON.stringify(space));
        assert.ok(performance.now() - started < 500, `${JSON.stringify(space)} 花了 ${Math.round(performance.now() - started)} ms`);
        const before = performance.now();
        assert.deepEqual(numbersIn('撥' + space.repeat(2000) + 'x113 號'), [], JSON.stringify(space));
        assert.ok(performance.now() - before < 500, `撥 + ${JSON.stringify(space)} 花了 ${Math.round(performance.now() - before)} ms`);
    }
});

test('回傳號碼在文字裡的位置', () => {
    const text = '撥 119 或 110';
    assert.deepEqual(hits(text).map((hit) => [hit.index, hit.number]), [[2, '119'], [8, '110']]);
    assert.equal(text.slice(8, 11), '110');
});

// 夠 linkPhoneNumbers 用的 DOM：文字節點、元素，沒有 innerHTML。
const siblings = (node) => (node.parentNode ? node.parentNode.childNodes : [node]);
class Text {
    constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null; }
    get nextSibling() { const list = siblings(this); return list[list.indexOf(this) + 1] || null; }
    splitText(offset) {
        const rest = new Text(this.data.slice(offset));
        this.data = this.data.slice(0, offset);
        this.parentNode.insertAfter(rest, this);
        return rest;
    }
}
class Element {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.className = ''; this.childNodes = []; this.parentNode = null; this.ownerDocument = doc; }
    get firstChild() { return this.childNodes[0] || null; }
    get nextSibling() { const list = siblings(this); return list[list.indexOf(this) + 1] || null; }
    appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }
    insertAfter(node, ref) { node.parentNode = this; this.childNodes.splice(this.childNodes.indexOf(ref) + 1, 0, node); }
    replaceChild(node, old) { node.parentNode = this; old.parentNode = null; this.childNodes[this.childNodes.indexOf(old)] = node; }
    set textContent(text) { this.childNodes = []; this.appendChild(new Text(text)); }
}
const doc = { createElement: (tag) => new Element(tag) };
// 字串是文字節點，[tag, ...children] 是元素
function build(tag, ...children) {
    const el = new Element(tag);
    for (const c of children) el.appendChild(typeof c === 'string' ? new Text(c) : build(...c));
    return el;
}
const p = (...children) => build('p', ...children);
// 照順序列出 <a> 和文字，<a> 寫成 [href, 文字, class]，<br> 寫成 '<br>'
function flat(el) {
    return el.childNodes.flatMap((n) => {
        if (n instanceof Text) return n.data ? [n.data] : [];
        if (n.tagName === 'A') return [[n.href, n.childNodes.map((t) => t.data).join(''), n.className]];
        if (n.tagName === 'BR') return ['<br>'];
        return flat(n);
    });
}

test('linkPhoneNumbers：號碼換成 tel: 連結，前後的文字不變；同一個文字節點裡有好幾支也對', () => {
    const el = p('有立即危險時撥 119，想傷害自己時打安心專線 1925（24 小時）。110 學年度不算。');
    linkPhoneNumbers(el, NUMBERS, 'underline');
    assert.deepEqual(flat(el), [
        '有立即危險時撥 ',
        ['tel:119', '119', 'underline'],
        '，想傷害自己時打安心專線 ',
        ['tel:1925', '1925', 'underline'],
        '（24 小時）。110 學年度不算。',
    ]);
});

test('linkPhoneNumbers：前後文跨過粗體也看得到；號碼被拆在兩個節點裡就不換', () => {
    const el = p('可以打保護專線 ', ['strong', '113'], '，正在被打時撥 ', ['strong', '11'], '0。');
    linkPhoneNumbers(el, NUMBERS);
    assert.deepEqual(flat(el), ['可以打保護專線 ', ['tel:113', '113', ''], '，正在被打時撥 ', '11', '0。']);
});

test('linkPhoneNumbers：前後文不跨過 <br>、標題、清單項目', () => {
    const cases = [
        p('可以撥打', ['br'], '113 號的資料'),
        // renderMarkdown 的標題、清單後面直接接文字
        build('div', ['h3', '求助專線'], '113 號的資料'),
        build('div', ['ul', ['li', '可以撥打']], '113 號的資料'),
        build('ul', ['li', '可以撥打'], ['li', '113 號的資料']),
        build('div', '可以撥打', ['p', '113 號的資料']),
    ];
    for (const el of cases) {
        linkPhoneNumbers(el, NUMBERS);
        assert.equal(flat(el).filter(Array.isArray).length, 0, JSON.stringify(flat(el)));
    }
    const el = p('想傷害自己時', ['br'], '可以撥打 1925');
    linkPhoneNumbers(el, NUMBERS);
    assert.deepEqual(flat(el), ['想傷害自己時', '<br>', '可以撥打 ', ['tel:1925', '1925', '']]);
});

test('linkPhoneNumbers：沒有號碼時節點不變；numbers 是空的也一樣', () => {
    const el = p('推薦你 ', ['strong', '資訊學群'], '。撥 110');
    const before = JSON.stringify(flat(el));
    linkPhoneNumbers(el, NUMBERS.slice(0, 2));
    linkPhoneNumbers(el, []);
    assert.equal(JSON.stringify(flat(el)), before);
    assert.equal(el.childNodes.length, 3);
});

test('linkPhoneNumbers：同一個元素換兩次，連結不會包成兩層', () => {
    const el = p('撥 110 報警，或打保護專線 ', ['strong', '113'], '。');
    linkPhoneNumbers(el, NUMBERS);
    const once = JSON.stringify(flat(el));
    linkPhoneNumbers(el, NUMBERS);
    assert.equal(JSON.stringify(flat(el)), once);
    const nested = (n) => (n.childNodes || []).some((c) => (c.tagName === 'A' && c.childNodes.some((d) => d.tagName === 'A')) || nested(c));
    assert.equal(nested(el), false);
});
