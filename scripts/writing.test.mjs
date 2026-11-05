import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';

import {
    PH, RULES, allowCovers, changedLines, pickAnnotations, allowOccurrences, allowProblems, compareBaseline, findHits, isMention, jsonBlocks, locate,
    lowerBaseline, freshBaselineProblems, maskQuotes, pageBlocks, scriptStrings, sourceIndex, verifyPolicy,
} from './writing.lib.mjs';

const block = (text, extra = {}) => ({ page: 'a.html', kind: 'html', tag: 'p', text, skip: maskQuotes(text, ' '.repeat(text.length)), bold: [], ...extra });
const rulesHit = (text, extra) => findHits([block(text, extra)]).hits.map((h) => h.rule);
const hitsOf = (id, text, extra) => rulesHit(text, extra).filter((r) => r === id).length;
const page = (body, head = '') => cheerio.load(`<html><head>${head}</head><body><main>${body}</main></body></html>`);

// CONTRIBUTING.md 的例句：改前要命中，改後不能命中。
const examples = [
    ['W01-hen-duo', '真相：差很多，選錯方向會影響大學四年的學習體驗。', '真相：不一樣。'],
    ['W04-filler-signpost', '換句話說，工程不只是理解理論。', '工程要能動手做出成品。'],
    ['W06-puffery', '「學習歷程自述」扮演至關重要的角色。', '「學習歷程自述」把修課紀錄、課程學習成果和多元表現串在一起。'],
    ['P01-double-dash', '每一大項之檔案大小以 5MB 為限——也就是說，多元表現就算放到 10 件。', '每一大項之檔案大小以 5MB 為限。'],
    ['P02-single-dash', '動機 — 「我關注這個議題，是因為……」', '動機：「我關注這個議題，是因為……」'],
    ['P04-halfwidth-punct', '不論你的學校有沒有相關資源,這些管道任何人都能使用。', '不論你的學校有沒有相關資源，這些管道任何人都能使用。'],
    ['P05-halfwidth-paren', '從聯合國永續發展目標 (SDGs) 中尋找靈感', '從聯合國永續發展目標（SDGs）中尋找靈感'],
    ['P07-emoji', '🤔 我該用哪種方法？', '我該用哪種方法？'],
    ['P09-quote-nesting', '我只知道『怎麼做』', '我只知道「怎麼做」'],
    ['K01-chat-residue', '希望以上整理對你有幫助。', '下面的四張卡片連到四個步驟。'],
    ['K04-chat-phrase', '讓我們陪你走完這趟探索之旅。', '下面的四張卡片連到四個步驟。'],
    ['W02-vague-quantity', '提供大量演算法題目', '提供演算法題目'],
    ['C01-vague-attribution', '教授普遍認為這個動機太小。', '北醫醫學系教授說，這個動機太小。'],
];
for (const [id, before, after] of examples) {
    test(`${id}：改前命中、改後不命中`, () => {
        assert.ok(hitsOf(id, before) > 0, before);
        assert.equal(hitsOf(id, after), 0, after);
    });
}

test('本站的正常用法不算命中', () => {
    for (const t of ['多元表現與核心素養', '第一階段在 9:00–21:00 開放', '西元 1811—1872 年', '臺北—左營', '最後一天、最晚 5/6、最多 3 件', '不一定要進醫院', '不少於 300 字', '相當於十分鐘', '採計「動機—探究—收穫—反思」的順序']) {
        assert.deepEqual(rulesHit(t).filter((r) => /^(W0[1-9]|W1|P0[12])/.test(r)), [], t);
    }
});

test('P02：步驟鏈要三段以上、沒有標點，英文 em dash 兩側不能是模板佔位符', () => {
    assert.equal(hitsOf('P02-single-dash', '「動機—做法—遇到的問題—改進—成果」'), 0);
    assert.equal(hitsOf('P02-single-dash', '「我想念的—是設計」'), 1);
    assert.equal(hitsOf('P02-single-dash', '「動機—反思」'), 1);
    assert.equal(hitsOf('P02-single-dash', `ab — c${PH}`), 1);
    assert.equal(hitsOf('P02-single-dash', '研究動機—'), 1);
    assert.equal(hitsOf('P02-single-dash', 'work—life'), 0);
    assert.equal(hitsOf('P02-single-dash', `${PH}—${PH}`), 1);
});

test('isMention：引號前後有談詞語的字才算在談這個詞', () => {
    const at = (t, w) => isMention(t, t.indexOf(w), w.length);
    assert.equal(at('把「很多」改成數字', '很多'), true);
    assert.equal(at('「很多」「許多」這類詞讓讀者猜', '許多'), true);
    assert.equal(at('「不是 X，而是 Y」的句型', '不是 X，而是 Y'), true);
    assert.equal(at('理解這四句「真心話」', '真心話'), false);
    assert.equal(at('宛如「至關重要」的使命', '至關重要'), false);
    assert.equal(at('把「我學到很多」改掉', '很多'), false);
    assert.equal(at('把「很多」「許多」改成數字', '許多'), true);
    assert.equal(at('「很多」「許多」這類詞', '很多'), true);
    assert.equal(hitsOf('W01-hen-duo', '把「很多」改成數字'), 0);
    for (const t of ['用「很多」會讓讀者猜', '別寫「很多」', '不要寫「很多」', '避免「很多」', 'App 叫「一次搞懂」', '名為「一次搞懂」的 App']) {
        const w = t.includes('很多') ? '很多' : '一次搞懂';
        assert.equal(at(t, w), true, t);
    }
});

test('引號：中文引文要接在「逐字」「原文」後面或緊接著前一段引文，冒號後面照查', () => {
    assert.equal(maskQuotes('逐字「A」「B」', '         '), '  qqqqqq ');
    assert.equal(maskQuotes('原文：「縣(市)」', '         '), '   qqqqqq');
    assert.equal(hitsOf('P01-double-dash', '可以這樣論述:「我想——讀企管」'), 1);
    assert.equal(hitsOf('P01-double-dash', '簡章逐字「我想——讀企管」'), 0);
    assert.equal(hitsOf('P01-double-dash', '見《學習——成長》一書'), 0);
});

test('引號：有英文字母、沒有中文的「」是外文原文，不寫「逐字」，引號裡的破折號與刪節號不檢查', () => {
    assert.equal(maskQuotes('寫「A — b」', '        '), ' fffffff');
    assert.equal(maskQuotes('寫「A，b」', '      '), '      ');
    assert.equal(hitsOf('P01-double-dash', '官網寫「Grades 9——12」'), 0);
    assert.equal(hitsOf('P01-double-dash', '簡章寫「我想——讀企管」'), 1);
    assert.equal(hitsOf('P01-double-dash', '簡章寫「AI 學習——成長」'), 1);
    assert.equal(hitsOf('P01-double-dash', '用「——」標出'), 1);
    // 外文引文不帶起連續引號，後面的中文引號照查
    assert.equal(hitsOf('P01-double-dash', '官網寫「Open」、「我想——讀企管」'), 1);
    assert.equal(hitsOf('P01-double-dash', '逐字「Open」、「我想——讀企管」'), 0);
    assert.equal(hitsOf('P02-single-dash', '官網寫「Deadline: TBA —」'), 0);
    assert.equal(hitsOf('P11-ellipsis', '官網寫「Entry ...」'), 0);
});

test('引號：跨過外文引文的句型照查', () => {
    assert.equal(hitsOf('S01-not-x-but-y', '不是「Python」而是「C++」'), 1);
    assert.equal(hitsOf('S02-not-only', '不僅「Python」更要會「C++」'), 1);
    assert.equal(hitsOf('K01-chat-residue', '希望「GPT」對你有幫助'), 1);
});

test('P09：依層次輪流用「」『』，開合不同種也算', () => {
    assert.equal(hitsOf('P09-quote-nesting', '「外「中」外」'), 1);
    assert.equal(hitsOf('P09-quote-nesting', '「外『中「內」中』外」'), 0);
    assert.equal(hitsOf('P09-quote-nesting', '「x』'), 1);
    assert.equal(hitsOf('P09-quote-nesting', '用『』標第二層'), 0);
});

test('P10：彎引號緊鄰中文或模板佔位符', () => {
    assert.equal(hitsOf('P10-curly-quote', '他說“好”'), 2);
    assert.equal(hitsOf('P10-curly-quote', `“${PH}”`), 2);
    assert.equal(hitsOf('P10-curly-quote', 'say “hi”'), 0);
});

test('S08：引號裡的字不算句子長度', () => {
    const long = '這'.repeat(81);
    assert.equal(hitsOf('S08-long-sentence', `${long}。`), 1);
    assert.equal(hitsOf('S08-long-sentence', `簡章寫「${long}」。`), 0);
});

test('scriptStrings：模板、巢狀模板、屬性、正規式與 console', () => {
    const code = [
        'const r = s.replace(/`([^`\\n]+)`/g, "<code>$1</code>");',
        'el.textContent = `顯示${x}文字`;',
        'console.log("不要", `也不要${q}`);',
        'w = `前${c.map((x) => `<li>${x}的能力</li>`).join("")}後`;',
        'img = `<img alt="《${b.title}》封面" data-alt="不收" title=說明>`;',
        'const y = a / b; z = "中文"; re = new RegExp("不是顯示");',
    ].join('\n');
    const out = scriptStrings(code).map((s) => s.text.replaceAll(PH, '〇'));
    assert.deepEqual(out, ['顯示〇文字', '〇的能力', '前〇後', '《〇》封面', '說明', '中文']);
});

test('pageBlocks：站外連結與程式碼略過，blockquote 照查，佔位符與重複的屬性不算', () => {
    const $ = page(
        '<p>內文<a href="https://example.org/">站外——標題</a><a href="/x/">站內——卡片</a><code>碼——</code></p>' +
        '<blockquote>提醒——內容</blockquote><span id="n">—</span><input placeholder="輸入——提示">',
        '<title>頁面——標題 - 學群 - 站名</title><meta name="description" content="內文">',
    );
    const blocks = pageBlocks($, 'a.html');
    const hits = findHits(blocks).hits.filter((h) => h.rule === 'P01-double-dash').map((h) => h.block.text.slice(h.index - 2, h.index + 4));
    assert.deepEqual(hits, ['站內——卡片', '提醒——內容', '頁面——標題', '輸入——提示']);
    assert.ok(blocks.some((b) => b.tag === 'attr:placeholder'));
    assert.ok(blocks.some((b) => b.tag === 'attr:title'));
    assert.ok(!blocks.some((b) => b.tag === 'attr:description'), '和內文重複的摘要不算');
    assert.ok(!blocks.some((b) => b.text.includes('碼——')));
    assert.ok(!blocks.some((b) => b.text.includes('—') && !b.text.includes('——')), '只有一個「—」的佔位符不算');
});

test('jsonBlocks：_html 解析成 HTML，專有名稱欄位標 name，tips 的 title 照查，_ 開頭的鍵不看', () => {
    const data = { _readme: '說明——不看', items: [{ title: '競賽——名稱', content_html: '<p>內文——一段</p>', tips: [{ title: '提示——標題' }] }] };
    const blocks = jsonBlocks(data, 'public/x.json', cheerio.load);
    assert.deepEqual(blocks.map((b) => [b.tag, b.text, b.pointer]), [
        ['name', '競賽——名稱', '/items/0/title'],
        ['p', '內文——一段', '/items/0/content_html'],
        ['p', '提示——標題', '/items/0/tips/0/title'],
    ]);
    assert.equal(findHits(blocks).hits.filter((h) => h.rule === 'P01-double-dash').length, 2);
});

test('locate：屬性比對保留屬性值的原文，片段不到 4 字不找', () => {
    const index = sourceIndex([
        { path: 'src/pages/a.astro', content: '<input placeholder="過程中雖然失敗很多次">\n<p>\n  跨行的\n  一段字很多\n</p>' },
        { path: 'src/content/b.md', content: '很多' },
    ]);
    const attr = block('過程中雖然失敗很多次', { tag: 'attr:placeholder' });
    assert.deepEqual(locate(index, attr, 8, 2), { file: 'src/pages/a.astro', line: 1, dup: 1 });
    const body = block('跨行的一段字很多');
    assert.deepEqual(locate(index, body, 6, 2), { file: 'src/pages/a.astro', line: 3, dup: 1 });
    assert.equal(locate(index, block('很多'), 0, 2), null);
});

test('locate：Markdown 參考式連結和行內連結一樣只比對連結文字，沒有定義的方括號照原文', () => {
    const index = sourceIndex([{
        path: 'src/content/c.md',
        content: [
            '---',
            '[寅]: 寫在 frontmatter',
            '---',
            '甲[乙][a]丙很多',
            '丁[Ex][]戊很多',
            '己[庚]辛很多',
            '**[沒定義]**的很多',
            '壬[ 癸  子 ][]丑很多',
            '卯[寅]**辰**很多',
            '午[巳]**未**很多',
            '酉[申]**戌**很多',
            '亥\\[a]**子**很多',
            '',
            '[a]: <https://example.org/a> "定義的標題很多"',
            "[ex]: https://example.org/b '單引號標題'",
            '   [庚]: https://example.org/c (括號標題)',
            '[癸 子]: https://example.org/d',
            '```',
            '[巳]: https://example.org/e',
            '```',
            '<!--',
            '[申]: https://example.org/f',
            '-->',
        ].join('\n'),
    }, {
        path: 'src/pages/d.astro',
        content: '<p>亥[乙]<b>甲</b>很多</p>\n\n[乙]: https://example.org/g',
    }]);
    const at = (text, tag = 'p') => locate(index, block(text, { tag }), text.indexOf('很多'), 2);
    const lines = ['甲乙丙很多', '丁Ex戊很多', '己庚辛很多', '[沒定義]的很多', '壬 癸 子 丑很多', '卯[寅]辰很多', '午[巳]未很多', '酉[申]戌很多', '亥[a]子很多'].map((t) => at(t)?.line);
    assert.deepEqual(lines, [4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(at('定義的標題很多', 'attr:title')?.line, 14);
    assert.deepEqual(at('亥[乙]甲很多'), { file: 'src/pages/d.astro', line: 1, dup: 1 });
});

const ids = new Set(RULES.map((r) => r.id));
const okEntry = { file: 'src/a.md', text: '只有一句「我學到很多」', rule: 'W01-hen-duo', kind: 'counterexample', reason: '引號裡是要學生避開的空話原句。' };
const errorsOf = (entries) => allowProblems(entries, ids, '2026-10-27').map((p) => p.errors.join('；'));

test('allowProblems：合格的條目沒有錯誤', () => {
    assert.deepEqual(allowProblems([okEntry, { ...okEntry, text: '別段', kind: 'name', source: 'https://example.org/x' }], ids, '2026-10-27'), [{ errors: [], warnings: [] }, { errors: [], warnings: [] }]);
});
test('allowProblems：kind 缺少或亂寫', () => {
    const { kind, ...noKind } = okEntry;
    assert.match(errorsOf([noKind])[0], /kind/);
    assert.match(errorsOf([{ ...okEntry, kind: 'other' }])[0], /kind/);
});
test('allowProblems：quote 和 name 要有含網域的 source', () => {
    for (const source of [undefined, 42, ['https://example.org'], 'javascript:alert(1)', 'ftp://x.org', 'https://localhost', 'https://', 'https://example.org/\n']) assert.match(errorsOf([{ ...okEntry, kind: 'quote', source }])[0], /source/, String(source));
});
test('allowProblems：reason 去掉空白、標點和零寬字元後至少 10 個字', () => {
    assert.match(errorsOf([{ ...okEntry, reason: '反例，。！ 　\u200B\u200B\u200B\u200B\u200B\u200B' }])[0], /reason/);
    assert.match(errorsOf([{ ...okEntry, reason: 7 }])[0], /reason/);
});
test('allowProblems：rule 要存在、file 與 page 恰好一個、不能重複', () => {
    assert.match(errorsOf([{ ...okEntry, rule: 'W99' }])[0], /rule/);
    assert.match(errorsOf([{ ...okEntry, page: 'a.html' }])[0], /file 和 page/);
    const { file, ...noFile } = okEntry;
    assert.match(errorsOf([noFile])[0], /file 和 page/);
    assert.match(errorsOf([{ ...okEntry, text: '' }])[0], /text/);
    assert.match(errorsOf([{ ...okEntry, text: '   ' }])[0], /text/);
    assert.match(errorsOf([{ ...okEntry, file: 5 }])[0], /file 和 page/);
    assert.deepEqual(errorsOf([{ ...okEntry, file: '', page: 'a.html' }]), ['']);
    assert.match(errorsOf([okEntry, okEntry])[1], /重複/);
});
test('allowProblems：recheckAfter 不存在的日期報錯不崩潰，過期只警告', () => {
    for (const d of ['2026-13-01', '2026-02-30', '2026/10/01', 20261001, null]) assert.match(errorsOf([{ ...okEntry, recheckAfter: d }])[0], /recheckAfter/, String(d));
    const [p] = allowProblems([{ ...okEntry, recheckAfter: '2026-10-01' }], ids, '2026-10-27');
    assert.deepEqual(p.errors, []);
    assert.equal(p.warnings.length, 1);
    assert.deepEqual(allowProblems([{ ...okEntry, recheckAfter: '2026-12-01' }], ids, '2026-10-27')[0].warnings, []);
});
test('allowOccurrences 與 allowCovers：片段要唯一，只放行片段裡的命中', () => {
    const b = block('只有一句「我學到很多」，很多人這樣寫');
    assert.equal(allowOccurrences(okEntry, [b]), 1);
    assert.equal(allowOccurrences({ ...okEntry, text: '很多' }, [b]), 2);
    assert.equal(allowCovers(okEntry, b, b.text.indexOf('很多'), 2), true);
    assert.equal(allowCovers(okEntry, b, b.text.lastIndexOf('很多'), 2), false);
});

const policy = { rules: { 'W01-hen-duo': { baseline: { 'a.md': 2, 'b.md': 1 } } } };
const only = [{ id: 'W01-hen-duo', severity: 'block' }];
test('compareBaseline：超過、少於，沒列在 policy 的 block 規則當成基準是空的', () => {
    assert.deepEqual(compareBaseline(policy, { 'W01-hen-duo': { 'a.md': 2, 'b.md': 1 } }, only), { over: [], under: [] });
    const r = compareBaseline(policy, { 'W01-hen-duo': { 'a.md': 3, 'c.md': 1 } }, only);
    assert.deepEqual(r.over.map((o) => o.key), ['a.md', 'c.md']);
    assert.deepEqual(r.under.map((o) => o.key), ['b.md']);
    assert.deepEqual(compareBaseline({ rules: {} }, { 'W01-hen-duo': { 'a.md': 1 } }, only).over.length, 1);
});
test('lowerBaseline：只下修，降到 0 的鍵刪掉，不新增也不調高', () => {
    const next = lowerBaseline(policy, { 'W01-hen-duo': { 'a.md': 5, 'c.md': 1 } });
    assert.deepEqual(next.rules['W01-hen-duo'].baseline, { 'a.md': 2 });
    assert.deepEqual(lowerBaseline(policy, { 'W01-hen-duo': { 'a.md': 1, 'b.md': 1 } }).rules['W01-hen-duo'].baseline, { 'a.md': 1, 'b.md': 1 });
});
test('verifyPolicy：擋基準變大、新鍵、刪規則、非整數，以及和 RULES 不一致', () => {
    const ok = { rules: { 'W01-hen-duo': { baseline: { 'a.md': 1 } } } };
    assert.deepEqual(verifyPolicy(policy, ok, only), []);
    assert.match(verifyPolicy(policy, { rules: { 'W01-hen-duo': { baseline: { 'a.md': 3 } } } }, only).join(), /變成/);
    assert.match(verifyPolicy(policy, { rules: { 'W01-hen-duo': { baseline: { 'x.md': 1 } } } }, only).join(), /多出/);
    assert.match(verifyPolicy(policy, { rules: { 'W01-hen-duo': { baseline: { 'a.md': -1 } } } }, only).join(), /非負整數/);
    assert.match(verifyPolicy(policy, { rules: { 'W01-hen-duo': { baseline: { 'a.md': 1.5 } } } }, only).join(), /非負整數/);
    assert.match(verifyPolicy(policy, { rules: {} }, only).join(), /刪了/);
    assert.match(verifyPolicy({ rules: {} }, { rules: {} }, only).join(), /policy 沒有/);
    assert.match(verifyPolicy({ rules: {} }, { rules: { 'W02': { baseline: {} } } }, only).join(), /不是 block/);
});
test('freshBaselineProblems：新規則的基準要等於現在的命中數，已有的規則不比', () => {
    const after = { rules: { ...policy.rules, K02: { baseline: { 'c.json': 2 } } } };
    assert.deepEqual(freshBaselineProblems(policy, after, { K02: { 'c.json': 2 } }), []);
    assert.deepEqual(freshBaselineProblems(policy, after, { 'W01-hen-duo': { 'a.md': 9 }, K02: { 'c.json': 2 } }), []);
    assert.match(freshBaselineProblems(policy, after, { K02: { 'c.json': 1 } }).join(), /基準是 2，現在有 1 筆/);
    assert.match(freshBaselineProblems(policy, after, { K02: { 'c.json': 2, 'd.md': 1 } }).join(), /d\.md/);
    assert.match(freshBaselineProblems(policy, after, {}).join(), /c\.json/);
});
test('verifyPolicy：規則 id 要是大寫字母、兩位數字、連字號和小寫說明', () => {
    for (const id of ['w01-x', 'W1-x', 'W01', 'W01-Hen', 'W01_hen']) {
        assert.match(verifyPolicy({ rules: {} }, { rules: { [id]: { baseline: {} } } }, [{ id, severity: 'block' }]).join(), /規則 id/, id);
    }
    assert.deepEqual(verifyPolicy({ rules: {} }, { rules: { 'K02-placeholder': { baseline: {} } } }, [{ id: 'K02-placeholder', severity: 'block' }]), []);
});
test('verifyPolicy：新加的規則可以帶著上線時的基準', () => {
    const two = [...only, { id: 'K02-placeholder', severity: 'block' }];
    assert.deepEqual(verifyPolicy(policy, { rules: { ...policy.rules, 'K02-placeholder': { baseline: { 'c.json': 2 } } } }, two), []);
    assert.match(verifyPolicy(policy, { rules: { ...policy.rules, 'K02-placeholder': { baseline: { 'c.json': 0.5 } } } }, two).join(), /非負整數/);
    assert.match(verifyPolicy({ rules: { 'K02-placeholder': { baseline: {} } } }, { rules: { ...policy.rules, 'K02-placeholder': { baseline: { 'c.json': 2 } } } }, two).join(), /多出/);
});

test('網址與網域整段標成 u，裡面的字不算命中', () => {
    const t = '見 https://example.org/很多——頁 與 abc.org.tw/很多';
    const m = maskQuotes(t, ' '.repeat(t.length));
    assert.equal(m[t.indexOf('https')], 'u');
    assert.equal(m[t.indexOf('abc.org')], 'u');
    assert.equal(rulesHit(t).filter((r) => r === 'W01-hen-duo' || r === 'P01-double-dash').length, 0);
});

test('alt 屬性照查，資料 JSON 的 url 欄位不看', () => {
    const blocks = pageBlocks(page('<p>內文</p><img alt="很多照片">'), 'a.html');
    assert.ok(blocks.some((b) => b.tag === 'attr:alt' && b.text === '很多照片'));
    assert.deepEqual(jsonBlocks({ url: '網址欄位很多', desc: '描述' }, 'public/x.json', cheerio.load).map((b) => b.text), ['描述']);
});

test('資料 JSON 不顯示的 recheckNote、sourceNote 不看', () => {
    const data = { items: [{ description: '描述', recheckNote: '重查依據很多', sourceNote: '查證紀錄——很多' }] };
    assert.deepEqual(jsonBlocks(data, 'public/x.json', cheerio.load).map((b) => b.text), ['描述']);
});

test('allowCovers：片段旁邊新加的命中不放行', () => {
    const b = block('很多只有一句「我學到很多」很多');
    assert.equal(allowCovers(okEntry, b, 0, 2), false);
    assert.equal(allowCovers(okEntry, b, b.text.length - 2, 2), false);
    assert.equal(allowCovers(okEntry, b, b.text.indexOf('我學到很多') + 3, 2), true);
});

test('scriptStrings：模板裡的 <b>、<strong> 和後面的冒號交給 F01', () => {
    const code = 'el.innerHTML = `<li><b>結構完整：</b> 計畫涵蓋完整流程</li><li><strong class="x">Week 1</strong> ：讀文獻</li><li><b>重點</b>在後面</li>`;';
    assert.deepEqual(scriptStrings(code)[0].bold, [{ own: '結構完整：', label: true }, { own: 'Week 1', label: true }, { own: '重點', label: false }]);
    const $ = cheerio.load(`<html><body><main><p>內文</p></main><script>${code}</script></body></html>`);
    const hits = findHits(pageBlocks($, 'a.html')).hits.filter((h) => h.rule === 'F01-bold-label').map((h) => h.match);
    assert.deepEqual(hits, ['結構完整：', 'Week 1']);
});

test('scriptStrings：正規式字元類別裡的 / 不結束正規式', () => {
    assert.deepEqual(scriptStrings('const r = /[/"]x/; a = "中文";').map((s) => s.text), ['中文']);
});

test('isMention：「例如」後面的引號算在談詞語', () => {
    assert.equal(isMention('例如「很多」', 3, 2), true);
    assert.equal(isMention('「很多」這兩個字', 1, 2), true);
});

test('C01：學類名稱「數據統計」不算「據統計」', () => {
    assert.equal(hitsOf('C01-vague-attribution', '據統計，八成學生選了理組。'), 1);
    assert.equal(hitsOf('C01-vague-attribution', '主要學類有資訊工程、數據統計。'), 0);
    assert.equal(hitsOf('C01-vague-attribution', '依據統計處的資料。'), 0);
});

// [規則, 要命中的句子, 不能命中的句子]。不能命中的多半是試跑時的誤判。
const blockCases = [
    ['W04-filler-signpost', [
        '總的來說，這是一份扎實的計畫。', '這點毋庸置疑。', '無庸置疑，這是對的。', '總體而言，這個學系適合理組學生。', '換言之，你要先確定興趣。',
        '不言可喻', '一言以蔽之', '說到底，還是要看興趣。', '總之，先報名再說。',
    ], ['這題不難。', '把分數加總之後除以 5', '彙總之後寄給老師', '說到底線，報名費 500 元。', '總結來說明欄位要填什麼', '由 x + 2 = 5 由此可見 x = 3', '綜合來看診斷結果之後，醫師會開立處方。']],
    ['W05-filler-addition', ['由此可見，選系要及早準備。', '顯而易見', '不難看出', '不可否認的事實是', '綜合來看'], ['這題不難。']],
    ['W06-puffery', ['這堂課讓你一次搞懂備審。', '一次看懂四種升學管道', '量身打造的學習計畫', '備審全攻略', '三個小撇步', '超實用'], [
        '性格特質是主動積極、變通開創、合作互助。', '克里斯汀生提出的顛覆性創新理論', '機器人要穩穩地把方塊放進指定區域', '服裝設計系學量身訂做西裝',
        '捕手要接住你投出的每一顆球。', '美國獨立戰爭與法國大革命的革命性質不同。', '我第一次看懂傅立葉轉換', '再一次搞懂這個證明', '頭一次看懂', '我這一次看懂了', '每一次看懂一個定理', '上一次看懂這張圖', '這場比賽要一次掌握三種感測器的讀值。',
    ]],
    ['W13-era-opener', [
        '在當今資訊爆炸的時代，自主學習變得愈來愈重要。', '隨著 AI 技術的快速發展，學習方式也在改變。', '在數位時代，', '身處 AI 時代，學生要會判讀資料。',
        '在網路時代，資訊素養更重要。', '在大數據時代，', '在後疫情時代，', '在全球化的浪潮下，', '在這個 AI 時代，', '處在資訊爆炸的年代，',
        '在人工智慧蓬勃發展的時代，', '在科技日益進步的今天，', '在二十一世紀的今天，', '隨著時代的進步，', '隨著社會變遷，',
        '隨著 ChatGPT 等生成式 AI 的問世，', '現今社會對跨領域人才的需求越來越高。', '當今時代，每個人都要會寫程式。',
        '在現今競爭激烈的社會中，', '世界瞬息萬變', '科技日新月異',
    ], [
        '在這個戰亂的時代，杜甫寫下〈春望〉。', '在這樣一個動盪的時代，魯迅選擇棄醫從文。', '在這個單元的時代背景介紹裡，老師會補充甲午戰爭。',
        '在當今日本的時代劇裡，武士多半說現代日語。', '這篇報導刊在數位時代雜誌 2026 年 4 月號。', '在今日世界大學排名中，台大排第 68 名。',
        '在這個遊戲的世界裡，玩家要用方塊蓋出電路。', '隨著社會企業的興起，政大開設了社企學程。', '本課程介紹在數位時代下的著作權與合理使用。',
        '隨著經濟系課程的發展，計量經濟改成大二必修。', '修過「當今社會問題分析」的同學可以抵免。', '在如今社會組也能報名的情況下，報名人數增加了三成。',
        '在現今社會學的研究方法裡，質性訪談很常見。', '隨著網路報名系統在 9 月 1 日開放，報名截止日改為 9 月 30 日。',
        '隨著 108 課綱上路，學習歷程檔案從 111 學年度起採計。', '在這個網站可以找到全世界的開放課程', '這門課伴隨著經濟發展史一起講', '這門課伴隨著科技發展一起講',
        '隨著你的英文進步', '隨著報名人數增加與賽制演進，第 20 屆起改為兩階段', '隨著 AI 發展出新工具', '在當今世界史的課堂上',
        '這是在數位時代雜誌上看到的', '本課程談在數位時代下的著作權', '這篇刊在數位時代，作者是記者。', '在現今高中的社會組，選物理的人不多。',
        '隨著臺南社會的發展，府城出現新的行業。', '1960 年代隨著經濟發展，政府在高雄設立加工出口區。', '在網路時代來臨之前，報名要郵寄紙本表格。',
        '隨著經濟發展，政府開放外資。', '在科技業的時代，', '2020 年在數位時代，',
    ]],
    // W13 已知的漏抓：沒有主題詞的時代開場，例如「在這個新的時代」「在現在這個社會」。
    ['W14-significance', [
        '這項研究具有重要的意義。', '這項研究具有相當重要的意義。', '這項研究具有極其重要的意義。', '這次修法有著重要的意義。', '這項發明具劃時代的意義。',
        '這次合作意義非凡。', '未來可期。', '參加國際賽讓你前景可期。', '為升學奠定堅實的基礎', '這門課為你打下紮實的基礎。', '這套教材開啟了嶄新的篇章。',
        '留下不可磨滅的印記',
    ], [
        '這次活動有 30 人參加。', '這意味著你要多修一門課', '為大二專業課奠定基礎', '他見證了台灣的民主化', '1945 年標誌著二戰結束',
        '工業革命對歐洲社會產生深遠影響，課本第 3 章有整理。', '這場比賽對台灣學生影響深遠。', '點連結會開啟新的一頁，原本的頁面不會關閉。',
        '這種蘭花的氣生根植於樹皮上。', '台灣的民主化根植於 1980 年代的黨外運動。', '排列組合題的答案有無限可能。', '迎接未來學院的新生要在 9 月 1 日報到。',
        '這項政策具有重要性，但要配合預算。', '這個詞的意義重新被定義了。',
    ]],
    // W14 已知的漏抓：「這是邁向未來的重要一步」。
    ['K02-placeholder', [
        '截止日 TBD。', '[填入參加人數]', '【請填日期】', '面試常問你為什麼想讀 XX 系。', '在20XX年舉辦', 'ＸＸ大學', '○○高中', '〇〇國中',
        'Lorem ipsum dolor', 'lorem ipsum', '日期 2026-XX-XX', '「截止日 TBD」', '「[填入人數]」', '報名截止日：20XX 年 3 月 31 日。',
        '20xx 年', '202X 年', '截止日 TBA，請留意官網。', 'XX 月 XX 日公布',
    ], [
        '「你為什麼想讀 XX 系？」這類題目常被問。', '「你為什麼想讀ＸＸ系？」這類題目', '「你為什麼想讀 xx 系？」這類題目', '「○○高中」這類寫法',
        'XXL 尺寸', '二〇〇八年', 'XX 染色體', '4xx 錯誤', 'RTX 40xx', '顯示卡 RTX 40xx 系列', '第 XX 屆超級盃在 1986 年舉行。', '羅馬數字 XX 是 20。',
        '請在程式裡留 TODO 註解，之後再回來改。', 'VS Code 的 TODO Highlight 擴充套件會標出待辦。', 'FIXME 是程式註解常用的標記。',
        '官網逐字「Final round: TBD」', '報名時程官網標示 TBA。', '官網明示下一屆截止日 TBD',
    ]],
    // K02 已知的漏抓：「X 月 X 日」「○月○日」「（請填入信箱）」「{主辦單位名稱}」「[Your Name]」「日期待補」。
    ['K03-markdown-residue', [
        '**重點：** 先寫結論', '## 研究動機', '```js', '詳見[官網](https://example.org/)', '見[說明](/about/)',
        '網址 https://example.org/?utm_source=chatgpt.com', '網址 https://example.org/?utm_source=perplexity', '__報名資格__：高中職在學學生。',
        '###### 備註', '說明 **重點** 在這裡',
    ], [
        '用 C# 寫程式', '第 1 名', 'Issue # 12', '網址 https://example.org/a**b**c', 'Python 用 2**3 表示 2 的 3 次方，3**2 是 9。',
        '指數的寫法 a**b**c 在 Python 是右結合。', '在 IG 貼文加上 # 主題標籤，例如 #SDGs。', 'Python 的 __init__ 方法',
        '在 Markdown 裡，用 ** 包住文字會變成粗體，例如 **重點** 這類寫法。', '網址 https://example.org/**中文**/x', '2**次方**是指數',
        '**Note:** 先寫結論',
    ]],
    // K03 已知的漏抓：只有英文的粗體「**Note:**」、段落中間的「## 標題」、「* 項目」「1. 項目」這類清單符號。
];
const warnCases = [
    ['W03-intensifier', ['這題極具挑戰'], ['這題有挑戰', '極具體的步驟寫在第 3 頁。']],
    ['W07-endorsement', ['對申請大有助益', '體現了團隊精神', '此計畫完整體現了科學方法', '革命性的工具', '顛覆性創新', '量身訂製', '事半功倍', '這堂課會接住你。'], [
        '對申請有幫助', '記錄一個具體現象', '兩場革命的革命性質不同', '立體現代建築的代表是貝聿銘。', '先了解整體現況',
    ]],
    ['W17-weighty-phrase', [
        '這次活動標誌著社團邁向新階段。', '這意味著你要多修一門課', '他見證了台灣的民主化', '產生深遠影響', '影響深遠', '根植於土地', '充滿無限可能',
        '擁抱未來', '迎接未來', '開啟新的一頁',
    ], ['這次活動有 30 人參加。', '這座城市的標誌著色是藍色。']],
    ['W15-grand-promise', ['陪你走完 108 課綱的每一步。', '把世界級的課程帶到每個孩子面前。', '世界級的開放課程', '陪你走過', '讓每個孩子都能學', '帶到學生面前'], [
        '平台列了 20 位學長姐的訪談。', '下一步是填寫報名表，每一步都有截圖。', '螞蟻的觸角可以感測氣味。',
    ]],
    ['W16-card-verdict', [
        '是培養國際觀的入門磚。', '以高品質動畫聞名。', '這是絕佳的機會。', '內容有趣、易懂', '這本小說是最受歡迎的入門書', '頻道名稱是高品質的入門',
        '撰寫者整理的高品質教材', '解說生動有趣', '數據整理成高品質圖表', '學生簡稱它是高品質的課', '官方頻道上的高品質影片', '附中文說明的高品質影片',
        '寫給高中生的高品質入門', '用說故事的方式，生動有趣',
    ], [
        '耶魯新聞稱那門課是耶魯史上最受歡迎的課。', '官網上它是最受歡迎的課程', '報導指出它是最受歡迎的課', '主辦單位表示這是最受歡迎的活動',
        '校刊寫它是最受歡迎的社團', '老師說這是高品質的教材', '提供數學與科學的教學影片。',
    ]],
    ['S03-not-x-is-y', ['教授要的不是完美答案，是看你會不會反思。'], ['教授要的不是完美答案，而是看你會不會反思。', '不是每個人都適合，是否報名要自己決定。']],
    ['S04-adverb-de', ['透過系統性地查找資料，更好地理解主題。', '更好地理解主題', '扎實地練習'], ['系統性的整理', '完整地址請見簡章。', '深入地底 3000 公尺的礦坑。', '有效地區為台北市與新北市。']],
    ['S06-rhetorical', ['你是否也曾覺得迷惘？', '想像一下，你站在台上。', '試想你是評審', '你是否有過這種經驗'], ['你是否符合資格，看簡章第 3 條。', '請確認你是否有填寫完畢。', '試想題的作答時間是 10 分鐘。']],
    ['P11-ellipsis', ['主辦單位⋯'], ['主辦單位……', '數列 1, 2, 3, ⋯, n 的總和。']],
];
for (const [id, yes, no] of [...blockCases, ...warnCases]) {
    test(`${id}：命中與不命中`, () => {
        for (const t of yes) assert.ok(hitsOf(id, t) > 0, t);
        for (const t of no) assert.equal(hitsOf(id, t), 0, t);
    });
}

test('W13 是 warn：歷史與事實敘述不會被任何 block 規則擋', () => {
    const block = new Set(RULES.filter((r) => r.severity === 'block').map((r) => r.id));
    assert.equal(RULES.find((r) => r.id === 'W13-era-opener').severity, 'warn');
    for (const t of ['1960 年代隨著經濟發展，政府在高雄設立加工出口區。', '在網路時代來臨之前，報名要郵寄紙本表格。', '在這個戰亂的時代，杜甫寫下〈春望〉。',
        '在這樣一個動盪的時代，魯迅選擇棄醫從文。', '隨著臺南社會的發展，府城出現新的行業。']) {
        assert.deepEqual(rulesHit(t).filter((id) => block.has(id)), [], t);
    }
});

test('K02：TODO、FIXME 只查資料 JSON', () => {
    assert.equal(hitsOf('K02-placeholder', 'TODO 補上', { kind: 'json' }), 1);
    assert.equal(hitsOf('K02-placeholder', 'FIXME', { kind: 'json' }), 1);
    assert.equal(hitsOf('K02-placeholder', 'TODO 補上'), 0);
});

test('U01：只看腳本和屬性裡的介面文字', () => {
    assert.equal(hitsOf('U01-ui-message', '抱歉，發生未知的錯誤。', { tag: 'script' }), 2);
    assert.equal(hitsOf('U01-ui-message', '有問題請回報網站管理員', { tag: 'attr:title' }), 1);
    assert.equal(hitsOf('U01-ui-message', '我很抱歉當時沒有準備。'), 0);
    assert.equal(hitsOf('U01-ui-message', '回報錯誤給網站管理員', { tag: 'attr:aria-label' }), 0);
    assert.equal(hitsOf('U01-ui-message', '輸入系統錯誤代碼', { tag: 'attr:placeholder' }), 0);
    assert.equal(hitsOf('U01-ui-message', '糟糕的姿勢與正確的姿勢對照圖', { tag: 'attr:alt' }), 0);
    assert.equal(hitsOf('U01-ui-message', '糟糕，出錯了', { tag: 'script' }), 2);
});

test('W01：「很」加上「多X」形容詞不算「很多」', () => {
    for (const t of ['評語很多餘，刪掉也不影響意思。', '山區的天氣很多變', '這位作家很多產，一年出版三本小說。', '學長很多才多藝', '葡萄柚很多汁', '他個性很多疑', '很多變的天氣']) {
        assert.equal(hitsOf('W01-hen-duo', t), 0, t);
    }
    for (const t of ['他有很多疑問。', '這幾年有很多變化', '很多產品', '學了很多才藝', '我學到很多。', '很多人以為選系只看分數。']) assert.equal(hitsOf('W01-hen-duo', t), 1, t);
});

test('K01：只擋聊天機器人留下的句子，其他聊天口吻放在 K04 只報不擋', () => {
    const blocked = [
        '希望以上整理對你有幫助！', '希望這篇文章對你有所幫助。', '希望這篇整理有幫助。', '希望以上內容能對大家有所幫助。', '希望本文對你有所幫助。', '希望對你有幫助！',
        '希望能對你有所幫助。', '希望這些資訊對大家有幫助。', '希望這份整理能對各位有所幫助。', '作為一個 AI，我無法查證。', '作為 AI 語言模型，我不能回答。',
        '作為一個 AI 模型，我沒辦法查證最新簡章。', '作為 AI 我無法提供即時資訊。', '截至我的知識截止日', '我們一起看看', '讓我們一起來看看各校的篩選倍率。',
        '讓我們一起探索大學科系的世界。', '如果你還有任何問題，歡迎隨時提問！', '好的！以下是各校篩選倍率的整理。', '當然！以下是四種升學管道的比較。',
    ];
    for (const t of blocked) assert.equal(hitsOf('K01-chat-residue', t), 1, t);
    const warned = ['如果你有疑問，歡迎寄信給承辦人。', '說明會結束後歡迎提問，現場有招生組老師。', '當然，下面這張表只列國立大學。', '好的，我們進入下一題。',
        '老師讓我們一起討論期末專題的題目。', '教授會讓我們來回答上週的問題。'];
    const plain = ['老師讓我們的專題報名科展。', '我修這門課，是希望對備審有幫助。', '研究團隊希望這篇論文對罕病治療有幫助。', '作者希望這篇報導能對政策討論有幫助。',
        '這本書適合作為 AI 入門的第一本書。', '講者分享自己如何作為 AI 工程師進入業界。', '學生可以把這個工具作為 AI 助理，查詢各校的招生名額。', '本站把開源模型作為 AI 助手，回答選課相關的問題。'];
    for (const t of [...warned, ...plain]) assert.equal(hitsOf('K01-chat-residue', t), 0, t);
    for (const t of warned) assert.ok(hitsOf('K04-chat-phrase', t) >= 1, t);
    for (const t of plain) assert.equal(hitsOf('K04-chat-phrase', t), 0, t);
});

test('W06：「至關重要」單獨就會命中', () => {
    assert.equal(hitsOf('W06-puffery', '這件事至關重要。'), 1);
});

test('W06：字面上常用的詞只報不擋，放在 W07', () => {
    for (const t of ['通訊系大二學編碼與解碼', '密碼學課會教加密與解碼的數學原理', '文藝復興時期的藝術', '電動輔助自行車的助力系統', '量測無縫鋼管的抗拉強度', '迪化街的乾貨批發', '日本的三種神器', '職場的潛規則如何影響升遷']) {
        assert.equal(hitsOf('W06-puffery', t), 0, t);
        assert.equal(hitsOf('W07-endorsement', t), 1, t);
    }
});

test('P02：數字之間的「—」是範圍', () => {
    assert.equal(hitsOf('P02-single-dash', '第 81—93 頁'), 0);
    assert.equal(hitsOf('P02-single-dash', '第 81 — 93 頁'), 0);
    assert.equal(hitsOf('P02-single-dash', '第８１—９３頁'), 0);
    assert.equal(hitsOf('P02-single-dash', '第八十一—九十三頁'), 1);
});

test('P02：範圍寫成「—」照擋，規則帶著改法', () => {
    for (const t of ['比賽開放國小—高中學生報名。', '報名期間 4 月—6 月，逾期不受理。', '上午 9:00—下午 5:00 開放現場報到。']) assert.equal(hitsOf('P02-single-dash', t), 1, t);
    assert.match(RULES.find((r) => r.id === 'P02-single-dash').hint, /國小到高中/);
});

test('P05：數學式的半形括號不算', () => {
    for (const t of ['計算 (3+5)×2 的結果，答案是 16。', '座標 (2, 3) 在第一象限。', '求 (a+b)² 的展開式。', '化簡 (x - 1) / 2']) assert.equal(hitsOf('P05-halfwidth-paren', t), 0, t);
    for (const t of ['目標 (SDGs) 中', '社團名稱是 IEEE (台大學生分會)。', '電腦輔助製圖(CAD)的課', '疫情 (COVID-19) 期間', '選項 (A) 是對的', '第 (3) 題']) assert.equal(hitsOf('P05-halfwidth-paren', t), 1, t);
});

test('changedLines 與 pickAnnotations：只標改到的行，每級最多 limit 個', () => {
    const diff = ['+++ b/src/a.md', '@@ -3 +3,2 @@', '+x', '+y', '+++ b/src/b.md', '@@ -0,0 +7 @@'].join('\n');
    assert.deepEqual([...changedLines(diff)], ['src/a.md:3', 'src/a.md:4', 'src/b.md:7']);
    const h = (key, line, rule = 'W01-hen-duo') => ({ key, line, rule });
    const hits = [h('src/a.md', 3), h('src/a.md', 4), h('src/a.md', 9), h('src/b.md', 7, 'W02'), h('src/b.md', 7, 'W02')];
    const r = pickAnnotations(hits, changedLines(diff), new Set(['W01-hen-duo|src/a.md']), 1);
    assert.deepEqual(r.annotations.map((a) => [a.level, a.hit.line]), [['error', 3], ['warning', 7]]);
    assert.equal(r.rest, 2);
});
