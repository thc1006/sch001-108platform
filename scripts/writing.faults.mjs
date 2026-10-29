#!/usr/bin/env node
// check:writing 的故障注入，一次改一處，確認該紅的會紅：
//   A. 串接：在 dist 副本注入命中、改壞放行清單與基準，check-writing.mjs 必須以 1 結束；乾淨的副本、下修基準、
//      ref 存在的 --verify 與 --annotate 要以 0 結束。有些案例另外檢查報表、下修後的基準或輸出。
//   B. 判斷：改壞 writing.lib.mjs，writing.test.mjs 必須失敗
//   C. 串接程式：改壞 check-writing.mjs，A 段至少一項不符
// A、C 段各自在 .writing-faultcheck/w<N>/ 的 dist、基準、放行清單與報表副本上跑，四個一起跑；版控裡的檔案不會
// 被改到。需要先建置。
//
// 執行：  npm run test:writing-faults
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const WORK = path.join(ROOT, '.writing-faultcheck');
const WORKERS = 4;
const original = readFileSync(path.join(ROOT, 'scripts/writing.lib.mjs'), 'utf8');

// [說明, 原文, 改成]。原文必須在 writing.lib.mjs 裡恰好出現一次。
const mutations = [
    ['kind 多收一種', "new Set(['quote', 'name', 'counterexample'])", "new Set(['quote', 'name', 'counterexample', 'other'])"],
    ['quote、name 不必有 source', "if ((e.kind === 'quote' || e.kind === 'name') &&", 'if (false &&'],
    ['source 不必有網域', '/^https?:\\/\\/[^\\s/.]+(\\.[^\\s/.]+)+(\\/\\S*)?$/', '/^https?:\\/\\//'],
    ['reason 門檻降低', 'charCount(e.reason) < 10', 'charCount(e.reason) < 2'],
    ['reason 的標點與零寬字元也算字數', '/[\\s\\p{P}\\p{S}\\u200B-\\u200D\\u2060\\uFEFF]/gu', '/\\s/gu'],
    ['rule 不必存在', 'if (!ruleIds.has(e.rule))', 'if (false)'],
    ['file 和 page 不檢查', "if (target.length !== 1 || typeof target[0] !== 'string')", 'if (false)'],
    ['file 是數字也收', " || typeof target[0] !== 'string')", ')'],
    ['text 只有空白也收', "!e.text.trim()) errors.push('缺 text')", "!e.text) errors.push('缺 text')"],
    ['重複的條目不報', "if (seen.has(key)) errors.push('和前面的條目重複')", "if (false) errors.push('和前面的條目重複')"],
    ['text 不必有', "if (typeof e.text !== 'string' || !e.text.trim())", 'if (false)'],
    ['recheckAfter 不驗日期', 'if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3])', 'if (!d)'],
    ['recheckAfter 過期不警告', 'else if (today > e.recheckAfter)', 'else if (false)'],
    ['片段出現幾次都算一次', 'b.text.split(entry.text).length - 1', 'Math.min(1, b.text.split(entry.text).length - 1)'],
    ['片段外的命中也放行', 'at + len <= p + entry.text.length', 'true'],
    ['談詞語的前導詞放寬成單字「如」', '(把|像是|例如|比如|諸如|', '(如|把|像是|例如|比如|諸如|'],
    ['談詞語的後接詞少了句型', '|之類|的句型|句型|的寫法|這個寫法)', '|之類)'],
    ['引號裡有其他字也算在談詞語', 'if (/\\p{Script=Han}/u.test(text.slice(open + 1, index) + text.slice(index + len, close))) return false;', ''],
    ['不往前找相連的引號', 'text.slice(0, a).match(/「[^「」]{1,12}」[、\\s]?$/)', 'text.slice(0, a).match(/^\\uFFFF$/)'],
    ['不往後找相連的引號', 'text.slice(b).match(/^[、\\s]?「[^「」]{1,12}」/)', 'text.slice(b).match(/^\\uFFFF$/)'],
    ['原文後面不接受冒號', '/(逐字|原文)\\s*[：:]?\\s*$/u', '/(逐字|原文)\\s*$/u'],
    ['連續引號不算引文', '|| chained)', ')'],
    ['書名不算引文', '/《[^《》]*》|〈[^〈〉]*〉/gu', '/《\\uFFFF》/gu'],
    ['站外連結文字照查', "ext ? 'a' : quote ? 'q'", "ext ? ' ' : quote ? 'q'"],
    ['blockquote 一律當引文', "(name === 'blockquote' && (", "(name === 'blockquote' || ("],
    ['佔位符元素照查', "if (/^\\s*[—–\\-…]\\s*$/.test(el.text())", "if (false && /^\\s*[—–\\-…]\\s*$/.test(el.text())"],
    ['和內文重複的屬性照算', ' || mainText.includes(key)) return;', ') return;'],
    ['_ 開頭的鍵照看', "!k.startsWith('_')", 'true'],
    ['tips 的 title 當成專有名稱', "!(key === 'title' && ptr.includes('/tips/'))", 'true'],
    ['引號層次不輪流', "stack.length % 2 === 0 ? '「' : '『'", "'「'"],
    ['開合不同種不報', "if ((open === '「') !== (c === '」'))", 'if (false)'],
    ['模板的 ${…} 不留佔位符', 'text += PH;', "text += '';"],
    ['巢狀模板不取出', 'onNested?.(r.text, j);', ';'],
    ['屬性抽取連 data-* 也收', '(?<![\\w-])(?:alt|title|aria-label|placeholder)', '(?:alt|title|aria-label|placeholder)'],
    ['不收沒加引號的屬性', "|'([^']*)'|([^\\s\"'>=`]+))/g", "|'([^']*)')/g"],
    ['不認正規式字面值', "if (c === '/' && /(^|[=(:[!&|?{};,+\\-*%<>~^]|\\breturn|\\btypeof)\\s*$/", "if (false && /(^|[=(:[!&|?{};,+\\-*%<>~^]|\\breturn|\\btypeof)\\s*$/"],
    ['console 的引數照收', 'if (skipRanges.some(([a, b]) => start >= a && start <= b)) return;', ''],
    ['傳給 RegExp 的字串照收', '(new RegExp|', '(new RegExpX|'],
    ['模板兩側的 em dash 當英文', '!b.includes(PH) && !a.includes(PH)', 'true'],
    ['步驟鏈兩段就算', 'parts.length >= 3 &&', ''],
    ['彎引號不看佔位符', '(?=${HAN}|${PH})', '(?=${HAN})'],
    ['長句連引號裡的字也算', 'quoted.has(m.index + k) || ', ''],
    ['略過的範圍照算', 'if (f.len > 0 && r.skip &&', 'if (false &&'],
    ['談詞語的引號照算', 'if (f.len > 0 && isMention(b.text, f.index, f.len))', 'if (false)'],
    ['回推時短片段也找', 'if (snip.length < 4) continue;', 'if (snip.length < 2) continue;'],
    ['屬性只比對去掉標籤的文字', "const kinds = block.tag.startsWith('attr') || block.tag === 'script' ? ['raw', 'text'] : ['text', 'raw'];", "const kinds = ['text'];"],
    ['行號一律回第 1 行', 'return { file, line: lineAt(starts, pos), dup };', 'return { file, line: 1, dup };'],
    ['超過基準一筆不報', 'if (n > (baseline[key] ?? 0)) over.push', 'if (n > (baseline[key] ?? 0) + 1) over.push'],
    ['少於基準不報', 'if ((now[key] ?? 0) < n) under.push', 'if (false) under.push'],
    ['沒列在 policy 的 block 規則不檢查', "for (const rule of rules.filter((r) => r.severity === 'block').map((r) => r.id)) {", 'for (const rule of Object.keys(policy.rules)) {'],
    ['下修變成照現值', 'Math.min(counts[rule]?.[key] ?? 0, n)', '(counts[rule]?.[key] ?? n)'],
    ['降到 0 的鍵留著', 'if (v > 0) next[key] = v;', 'next[key] = v;'],
    ['基準變大不擋', 'else if (n > old[key])', 'else if (false)'],
    ['新鍵不擋', 'else if (!(key in old))', 'else if (false)'],
    ['刪規則不擋', "if (!(id in after.rules)) problems.push(`${id}：目標分支", "if (false) problems.push(`${id}：目標分支"],
    ['非整數基準不擋', 'if (!isCount(n))', 'if (false)'],
    ['policy 少了 block 規則不擋', "if (!(id in after.rules)) problems.push(`${id}：RULES", "if (false) problems.push(`${id}：RULES"],
    ['policy 多了非 block 規則不擋', 'if (!block.has(id)) problems.push', 'if (false) problems.push'],
    ['後接詞少了這兩個字', '|這兩個字|這幾個字|', '|'],
    ['英文 em dash 不看拉丁字母', "if (/[A-Za-z]/.test(b.slice(-1)) && /[A-Za-z]/.test(a[0] ?? '')) return '英文裡的 em dash';", "if (true) return '英文裡的 em dash';"],
    ['改到的行少算一行', 'k < Number(m[2] ?? 1)', 'k < Number(m[2] ?? 1) - 1'],
    ['annotation 不限數量', 'if (sent[level]++ >= limit) rest++;', 'if (false) rest++;'],
    ['annotation 一律是 warning', "overKeys.has(`${h.rule}|${h.key}`) ? 'error' : 'warning'", "'warning'"],
    ['沒改到的行也標', 'hits.filter((x) => x.line && changed.has(`${x.key}:${x.line}`))', 'hits.filter((x) => x.line)'],
];

const CLI = path.join(ROOT, 'scripts/check-writing.mjs');
const cliSource = readFileSync(CLI, 'utf8');
// [說明, 原文, 改成, 最可能擋下它的 A 段案例]。原文必須在 check-writing.mjs 裡恰好出現一次。
const cliMutations = [
    ['結束碼一律是 0', 'process.exit(over.length || allowErrors.length ? 1 : 0);', 'process.exit(0);', '內文加「很多」'],
    ['放行清單的錯誤不擋', 'process.exit(over.length || allowErrors.length ? 1 : 0);', 'process.exit(over.length ? 1 : 0);', '放行條目的 kind 寫錯'],
    ['不讀資料 JSON', 'for (const f of dataFiles) {', 'for (const f of []) {', '資料 JSON 加「很多」'],
    ['不掃 shared 的 js', " || /^shared\\/[^/]+\\.js$/.test(f)", '', 'shared 的 js 加「——」'],
    ['不讀頁面', 'htmlPages.forEach((page, i) =>', 'htmlPages.slice(0, 0).forEach((page, i) =>', '乾淨的副本'],
    ['不掃 header 與 footer', 'withChrome: i === 0', 'withChrome: false', 'header 加「很多」'],
    ['頁面不完整也照查', 'if (htmlPages.length === 0 || pagesWithText < htmlPages.length) {', 'if (htmlPages.length === 0) {', '清空每頁的 <main>'],
    ['頁數門檻容許一頁', 'pagesWithText < htmlPages.length)', 'pagesWithText < htmlPages.length - 1)', '清空一頁的 <main>'],
    ['放行只看命中的開頭', 'allowCovers(e, h.block, h.index, h.len)', 'allowCovers(e, h.block, h.index, 1)', '命中從放行片段裡延伸到片段外'],
    ['annotation 不看 public', "git('diff', '-U0', annotateRef, '--', 'src', 'public')", "git('diff', '-U0', annotateRef, '--', 'src')", '--annotate 標到 public 的資料檔'],
    ['有錯的放行條目照用', 'return errors.length === 0;', 'return true;', '有錯的放行條目不放行'],
    ['放行不看規則', 'usable.some((e) => e.rule === h.rule &&', 'usable.some((e) => true &&', '放行條目換成別的規則'],
    ['放行不看檔案', '(e.page ? e.page === h.block.page : e.file === w.key) &&', 'true &&', '放行改指到另一頁'],
    ['內文也去重', "if (w.line && h.block.tag.startsWith('attr') && seen.has(dupKey)) continue;", 'if (w.line && seen.has(dupKey)) continue;', '內文重複一次'],
    ['資料 JSON 找不到行也記成檔案', 'if (i >= 0) return { key: b.page, line: i + 1 };', 'return { key: b.page, line: i + 1 };', '資料 JSON 多一個原始檔沒有的欄位'],
    ['annotation 一律 warning', 'new Set(over.map((o) => `${o.rule}|${o.key}`))', 'new Set()', '--annotate 超過基準的檔案是 error'],
    ['--update-baseline 不寫檔', 'writeFileSync(POLICY, `${JSON.stringify(lowerBaseline(policy, counts), null, 1)}\\n`);', '', '--update-baseline 下修'],
    ['--update-baseline 超過基準也是 0', 'process.exit(over.length ? 1 : 0);\n}', 'process.exit(0);\n}', '--update-baseline 遇到超過基準'],
    ['--verify 一律通過', 'process.exit(problems.length ? 1 : 0);', 'process.exit(0);', '--verify 基準調高'],
    ['--verify 找不到 ref 也通過', "console.error(`找不到 ${ref}，無法比對基準。`);\n        process.exit(1);", "console.error(`找不到 ${ref}，無法比對基準。`);\n        process.exit(0);", '--verify ref 不存在'],
    ['--verify 讀不出基準也通過', "console.error(`${ref} 的 writing-policy.json 讀不出來：${err.message}`);\n        process.exit(1);", "console.error(`${ref} 的 writing-policy.json 讀不出來：${err.message}`);\n        process.exit(0);", '--verify 目標分支的基準壞掉'],
];

if (!existsSync(path.join(ROOT, 'dist'))) {
    console.error('找不到 dist/，請先執行 npm run build:deployable。');
    process.exit(1);
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const policyText = readFileSync(path.join(ROOT, 'scripts/writing-policy.json'), 'utf8');
const allowText = readFileSync(path.join(ROOT, 'scripts/writing-allow.json'), 'utf8');

// --verify 要比對的目標分支：用 git 的低階指令做只含 scripts/writing-policy.json 的 commit 物件，不動索引和分支。
// CI 上沒有設定 git 的使用者，commit-tree 需要的作者資料在這裡給。
const who = { GIT_AUTHOR_NAME: 'writing-faults', GIT_AUTHOR_EMAIL: 'writing-faults@example.invalid', GIT_COMMITTER_NAME: 'writing-faults', GIT_COMMITTER_EMAIL: 'writing-faults@example.invalid' };
const gitIn = (args, input) => execFileSync('git', args, { cwd: ROOT, input, encoding: 'utf8', env: { ...process.env, ...who } }).trim();
function baseWith(policy) {
    const blob = gitIn(['hash-object', '-w', '--stdin'], policy);
    const scripts = gitIn(['mktree'], `100644 blob ${blob}\twriting-policy.json\n`);
    return gitIn(['commit-tree', gitIn(['mktree'], `040000 tree ${scripts}\tscripts\n`), '-m', 'writing faults base']);
}
const BASE = baseWith(policyText);
const BROKEN = baseWith('{ 壞掉的 JSON');

/** sandbox 建一份給一個 worker 用的副本，回傳路徑與還原用的函式。 */
function sandbox(n) {
    const dir = path.join(WORK, `w${n}`);
    const dist = path.join(dir, 'dist');
    cpSync(path.join(ROOT, 'dist'), dist, { recursive: true });
    const html = readdirSync(dist, { recursive: true }).map(String).filter((f) => f.endsWith('.html')).sort();
    const touched = new Map();
    const box = {
        dir, dist, html, policy: path.join(dir, 'policy.json'), allow: path.join(dir, 'allow.json'), report: path.join(dir, 'report.json'),
        cli: path.join(ROOT, `scripts/.check-writing.faultcheck-${n}.mjs`),
        file: (rel) => path.join(dist, rel),
        edit(rel, fn) {
            const p = path.join(dist, rel);
            if (!touched.has(p)) touched.set(p, readFileSync(p, 'utf8'));
            writeFileSync(p, fn(touched.get(p)));
        },
        reset() {
            for (const [p, text] of touched) writeFileSync(p, text);
            touched.clear();
            writeFileSync(box.policy, policyText);
            writeFileSync(box.allow, allowText);
            rmSync(box.report, { force: true });
        },
    };
    return box;
}

const editPolicy = (fn) => (b) => { const p = JSON.parse(policyText); fn(p.rules); writeFileSync(b.policy, JSON.stringify(p)); };
const editAllow = (fn) => (b) => { const a = JSON.parse(allowText); fn(a.entries); writeFileSync(b.allow, JSON.stringify(a)); };
const firstKey = (rules, id) => Object.keys(rules[id].baseline)[0];
const inPage = (html) => (b) => b.edit('about.html', (t) => t.replace('</main>', `${html}</main>`));
const W01_ENTRY = '「我必須在備審資料中展現我已經懂很多專業理論。」';
const clearMains = (count) => (b) => { for (const f of b.html.slice(0, count)) b.edit(f, (t) => t.replace(/(<main[^>]*>)[\s\S]*<\/main>/, '$1</main>')); };
const hitWith = (r, text) => r?.hits.find((h) => h.context.includes(text));
const FINANCE_APPLICATION = 'src/content/clusters/finance/application.md';

// [說明, 改動, 參數, 預期結束碼, 另外的檢查 (報表, 跑完的基準, 輸出) => boolean]
const cases = [
    ['乾淨的副本', () => {}, [], 0],
    ['內文加「很多」', inPage('<p>這裡有很多事。</p>'), [], 1],
    ['內文加「——」', inPage('<p>一段——說明</p>'), [], 1],
    ['alt 加「很多」', inPage('<img alt="很多照片">'), [], 1],
    ['header 加「很多」', (b) => b.edit(b.html[0], (t) => t.replace(/(<header[^>]*>)/, '$1<p>頁首很多字</p>')), [], 1],
    ['shared 的 js 加「——」', (b) => b.edit('shared/platform-ai.js', (t) => `${t}\nwindow.__writingFault = '一段——說明';\n`), [], 1],
    ['資料 JSON 加「很多」', (b) => b.edit('career-exploration/senior-interviews.json', (t) => t.replace('"content_html": "', '"content_html": "<p>注入的很多</p>')), [], 1],
    // 原始檔沒有這個欄位，pointer 找不到行，命中只能記成頁面路徑。
    ['資料 JSON 多一個原始檔沒有的欄位', (b) => b.edit('career-exploration/senior-interviews.json', (t) => { const d = JSON.parse(t); d.interviews[0].faultNote = '注入的欄位很多'; return JSON.stringify(d); }), [], 1,
        (r) => hitWith(r, '注入的欄位很多')?.file === 'page:public/career-exploration/senior-interviews.json'],
    // 同一行原始碼、同樣前後文的內文命中各算一筆，只有屬性跨頁才合併。結束碼也會因放行片段出現兩次而是 1，
    // 所以另外確認有一筆內文命中變成兩筆。
    ['內文重複一次', (b) => b.edit('career-exploration/clusters/finance/application.html', (t) => t.replace(/(<main[^>]*>)([\s\S]*)<\/main>/, '$1$2$2</main>')), [], 1,
        (r) => !!r?.hits.some((h) => h.file === FINANCE_APPLICATION && r.hits.filter((x) => x.file === h.file && x.rule === h.rule && x.line === h.line && x.match === h.match && x.context === h.context).length === 2)],
    ['清空每頁的 <main>', clearMains(Infinity), [], 1, (r) => r === null],
    ['清空一頁的 <main>', clearMains(1), [], 1, (r) => r === null],
    ['放行條目的 kind 寫錯', editAllow((e) => { e[0].kind = 'other'; }), [], 1],
    ['有錯的放行條目不放行', editAllow((e) => { e[0].kind = 'other'; }), [], 1, (r) => r?.over.some((o) => o.rule === JSON.parse(allowText).entries[0].rule)],
    ['放行片段不唯一', editAllow((e) => { e.push({ ...e[0], text: '學', reason: '故障注入：只有一個字的片段不唯一。' }); }), [], 1],
    // 片段結尾的「—」和片段外的「—」連成一筆「——」，命中只有開頭在片段裡，不能放行。
    ['命中從放行片段裡延伸到片段外', (b) => {
        inPage('<p>前文說明——後文</p>')(b);
        editAllow((e) => e.push({ page: 'about.html', text: '前文說明—', rule: 'P01-double-dash', kind: 'counterexample', reason: '故障注入：片段只包住命中的前半。' }))(b);
    }, [], 1],
    ['放行條目換成別的規則', editAllow((e) => { e.find((x) => x.text === W01_ENTRY).rule = 'W06-puffery'; }), [], 1],
    ['放行改指到另一頁', (b) => {
        inPage(`<p>${W01_ENTRY}</p>`)(b);
        editAllow((e) => { const x = e.find((y) => y.text === W01_ENTRY); delete x.file; x.page = 'about.html'; })(b);
    }, [], 1],
    ['基準少一筆', editPolicy((r) => { r['W01-hen-duo'].baseline[firstKey(r, 'W01-hen-duo')] -= 1; }), [], 1],
    ['規則鍵不見', editPolicy((r) => { delete r['P01-double-dash']; }), [], 1],
    ['基準多一筆只警告', editPolicy((r) => { r['W01-hen-duo'].baseline[firstKey(r, 'W01-hen-duo')] += 1; }), [], 0],
    ['--update-baseline 下修', editPolicy((r) => { r['W01-hen-duo'].baseline[firstKey(r, 'W01-hen-duo')] += 1; }), ['--update-baseline'], 0,
        (r, p) => p === JSON.stringify(JSON.parse(policyText), null, 1) + '\n'],
    ['--update-baseline 遇到超過基準', inPage('<p>這裡有很多事。</p>'), ['--update-baseline'], 1],
    ['--verify 沒有放寬', () => {}, ['--verify', BASE], 0],
    ['--verify 基準調高', editPolicy((r) => { r['W01-hen-duo'].baseline[firstKey(r, 'W01-hen-duo')] += 1; }), ['--verify', BASE], 1],
    ['--verify 刪規則鍵', editPolicy((r) => { delete r['W04-filler-signpost']; }), ['--verify', BASE], 1],
    ['--verify 多出新鍵', editPolicy((r) => { r['W04-filler-signpost'].baseline['src/none.md'] = 1; }), ['--verify', BASE], 1],
    ['--verify ref 不存在', () => {}, ['--verify', 'no-such-ref-for-writing-faults'], 1],
    ['--verify 目標分支的基準壞掉', () => {}, ['--verify', BROKEN], 1],
    ['--annotate 乾淨的副本', () => {}, ['--annotate', 'HEAD'], 0],
    // BASE 裡只有基準檔，src 的每一行都算改到；重複的內文讓那個檔超過基準，annotation 要是 error。
    ['--annotate 超過基準的檔案是 error', (b) => b.edit('career-exploration/clusters/finance/application.html', (t) => t.replace(/(<main[^>]*>)([\s\S]*)<\/main>/, '$1$2$2</main>')), ['--annotate', BASE], 1,
        (r, p, out) => /^::error file=src\/content\/clusters\/finance\/application\.md,/m.test(out)],
    // 只改 public/ 的資料檔時也要標到那一行。
    ['--annotate 標到 public 的資料檔', (b) => b.edit('career-exploration/senior-interviews.json', (t) => t.replace('"content_html": "', '"content_html": "<p>注入的很多</p>')), ['--annotate', BASE], 1,
        (r, p, out) => /^::error file=public\/career-exploration\/senior-interviews\.json,line=\d+/m.test(out)],
];

/** runCase 在 box 裡用 cli 跑一個案例，回傳不符的原因，符合時回傳 null。 */
function runCase(box, cli, [, change, args, want, check]) {
    return new Promise((resolve) => {
        box.reset();
        change(box);
        const env = { ...process.env, SITE_DIST: box.dist, WRITING_POLICY: box.policy, WRITING_ALLOW: box.allow, WRITING_REPORT: box.report, GITHUB_STEP_SUMMARY: '' };
        execFile(process.execPath, [cli, ...args], { cwd: ROOT, env, maxBuffer: 1 << 26 }, (err, stdout) => {
            const code = err ? err.code ?? 1 : 0;
            if (code !== want) return resolve(`結束碼 ${code}，預期 ${want}`);
            const report = existsSync(box.report) ? JSON.parse(readFileSync(box.report, 'utf8')) : null;
            resolve(check && !check(report, readFileSync(box.policy, 'utf8'), stdout) ? '報表、基準或輸出不符' : null);
        });
    });
}

/** pool 用 WORKERS 個副本跑 tasks，每個 task 是 (box) => Promise。 */
async function pool(tasks) {
    const results = new Array(tasks.length);
    let next = 0;
    await Promise.all(boxes.map(async (box) => {
        for (let k = next++; k < tasks.length; k = next++) results[k] = await tasks[k](box);
    }));
    return results;
}

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, why) => { fail++; console.log(`  ❌ ${name}：${why}`); };
const boxes = Array.from({ length: WORKERS }, (_, n) => sandbox(n));

console.log('A. 串接：');
const a = await pool(cases.map((c) => (box) => runCase(box, CLI, c)));
cases.forEach(([name], k) => (a[k] ? bad(name, a[k]) : ok(name)));

console.log('\nB. 改壞判斷（writing.test.mjs 必須失敗）：');
const testsPass = (dir) => new Promise((resolve) => execFile(process.execPath, ['--test', path.join(dir, 'writing.test.mjs')], { cwd: ROOT }, (err) => resolve(!err)));
const libDir = (k) => { const d = path.join(WORK, `m${k}`); mkdirSync(d, { recursive: true }); cpSync(path.join(ROOT, 'scripts/writing.test.mjs'), path.join(d, 'writing.test.mjs')); return d; };
const clean = libDir('clean');
writeFileSync(path.join(clean, 'writing.lib.mjs'), original);
if (!(await testsPass(clean))) bad('沒有改動', 'writing.test.mjs 已經失敗，突變結果沒有意義');
const b = await pool(mutations.map(([, from, to], k) => async () => {
    const n = original.split(from).length - 1;
    if (n !== 1) return `原文在 writing.lib.mjs 出現 ${n} 次`;
    const d = libDir(k);
    writeFileSync(path.join(d, 'writing.lib.mjs'), original.replace(from, () => to));
    return (await testsPass(d)) ? '改壞之後測試還是通過' : null;
}));
mutations.forEach(([name], k) => (b[k] ? bad(name, b[k]) : ok(name)));

console.log('\nC. 改壞串接程式（A 段至少一項不符）：');
const c = await pool(cliMutations.map(([, from, to, hint]) => async (box) => {
    const n = cliSource.split(from).length - 1;
    if (n !== 1) return `原文在 check-writing.mjs 出現 ${n} 次`;
    writeFileSync(box.cli, cliSource.replace(from, () => to));
    // 先跑最可能擋下它的案例，擋下就不必跑完全部。
    const order = [...cases].sort((x, y) => (y[0] === hint) - (x[0] === hint));
    for (const kase of order) if (await runCase(box, box.cli, kase)) return null;
    return 'A 段全部照樣符合';
}));
cliMutations.forEach(([name], k) => (c[k] ? bad(name, c[k]) : ok(name)));

for (const box of boxes) rmSync(box.cli, { force: true });
const after = (await runCase(boxes[0], CLI, cases[0])) === null;
rmSync(WORK, { recursive: true, force: true });
const total = cases.length + mutations.length + cliMutations.length;
console.log(`\n${after ? '還原後仍是綠燈。' : '還原後不是綠燈。'}故障注入：${pass} 項符合，${fail} 項不符（共 ${total} 項）。`);
process.exit(fail === 0 && after ? 0 : 1);
