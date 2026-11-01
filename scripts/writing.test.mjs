import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';

import {
    PH, RULES, allowCovers, changedLines, pickAnnotations, allowOccurrences, allowProblems, compareBaseline, findHits, isMention, jsonBlocks, locate,
    lowerBaseline, maskQuotes, pageBlocks, scriptStrings, sourceIndex, verifyPolicy,
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
    ['K01-chat-residue', '讓我們陪你走完這趟探索之旅。', '下面的四張卡片連到四個步驟。'],
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
    const out = scriptStrings(code).map((s) => s.replaceAll(PH, '〇'));
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

test('scriptStrings：正規式字元類別裡的 / 不結束正規式', () => {
    assert.deepEqual(scriptStrings('const r = /[/"]x/; a = "中文";'), ['中文']);
});

test('isMention：「例如」後面的引號算在談詞語', () => {
    assert.equal(isMention('例如「很多」', 3, 2), true);
    assert.equal(isMention('「很多」這兩個字', 1, 2), true);
});

test('W06：「至關重要」單獨就會命中', () => {
    assert.equal(hitsOf('W06-puffery', '這件事至關重要。'), 1);
});

test('P02：數字之間的「—」是範圍', () => {
    assert.equal(hitsOf('P02-single-dash', '第 81—93 頁'), 0);
    assert.equal(hitsOf('P02-single-dash', '第 81 — 93 頁'), 0);
    assert.equal(hitsOf('P02-single-dash', '第８１—９３頁'), 0);
    assert.equal(hitsOf('P02-single-dash', '第八十一—九十三頁'), 1);
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
