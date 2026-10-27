#!/usr/bin/env node
// 網站內容的寫作檢查，規範見 CONTRIBUTING.md 的「網站內容」，判斷在 writing.lib.mjs。
//
//   node scripts/check-writing.mjs [--annotate <git-ref>]
//     檢查建置後的 dist（SITE_DIST 可指定別份）：<main>、header、footer、頁面標題與屬性、頁面腳本裡會顯示的字串，
//     以及頁面在瀏覽器端讀的資料 JSON。block 規則任何檔案的筆數超過 writing-policy.json 的基準、
//     writing-allow.json 有錯，或掃到的頁面不完整，就以 1 結束；warn 規則只報。完整結果寫進
//     .reports/writing.json。--annotate 只對和 <git-ref> 相比改到的行發 GitHub annotation。
//   node scripts/check-writing.mjs --update-baseline
//     把基準下修成 min(現值, 基準)，不新增鍵也不調高。有檔案超過基準時以 1 結束。
//   node scripts/check-writing.mjs --verify <git-ref>
//     比較 <git-ref> 和工作區的 writing-policy.json，見 writing.lib.mjs 的 verifyPolicy。不讀 dist。
//
// commit 訊息與 PR 說明還沒有檢查。
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

import { RULES, allowCovers, changedLines, pickAnnotations, scriptStrings, allowOccurrences, allowProblems, compareBaseline, findHits, jsonBlocks, locate, lowerBaseline, pageBlocks, sourceIndex, verifyPolicy } from './writing.lib.mjs';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const DIST = path.resolve(ROOT, process.env.SITE_DIST || 'dist');
// 故障注入用 WRITING_POLICY、WRITING_ALLOW、WRITING_REPORT 指到副本，版控裡的檔案不會被改到。
const POLICY = path.resolve(ROOT, process.env.WRITING_POLICY || 'scripts/writing-policy.json');
const ALLOW = path.resolve(ROOT, process.env.WRITING_ALLOW || 'scripts/writing-allow.json');
const REPORT = path.resolve(ROOT, process.env.WRITING_REPORT || '.reports/writing.json');
const ANNOTATION_LIMIT = 10;
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
const args = process.argv.slice(2);
const argAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };

if (args.includes('--verify')) {
    const ref = argAfter('--verify');
    if (!ref) usage('--verify 後面要接一個 git ref。');
    // ref 本身不存在（例如淺層 clone 拿不到 HEAD^1）要失敗；只有 ref 存在、裡面還沒有這個檔案時才放行。
    try {
        git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    } catch {
        console.error(`找不到 ${ref}，無法比對基準。`);
        process.exit(1);
    }
    try {
        git('cat-file', '-e', `${ref}:scripts/writing-policy.json`);
    } catch {
        console.log(`${ref} 還沒有 writing-policy.json，不比對。`);
        process.exit(0);
    }
    let before;
    try {
        before = JSON.parse(git('show', `${ref}:scripts/writing-policy.json`));
    } catch (err) {
        console.error(`${ref} 的 writing-policy.json 讀不出來：${err.message}`);
        process.exit(1);
    }
    const problems = verifyPolicy(before, JSON.parse(readFileSync(POLICY, 'utf8')));
    for (const p of problems) console.error(p);
    if (!problems.length) console.log(`writing-policy.json 和 ${ref} 相比沒有放寬。`);
    process.exit(problems.length ? 1 : 0);
}

function usage(message) {
    console.error(`${message}\n用法：node scripts/check-writing.mjs [--annotate <git-ref>] | --update-baseline | --verify <git-ref>`);
    process.exit(2);
}

function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== '_astro') walk(p, out); } else out.push(p);
    }
    return out;
}

if (!existsSync(DIST)) usage(`找不到 ${path.relative(ROOT, DIST)}/，請先執行 npm run build:deployable。`);
const distFiles = walk(DIST).map((f) => path.relative(DIST, f).split(path.sep).join('/')).sort();
const htmlPages = distFiles.filter((f) => f.endsWith('.html') && !/^google[0-9a-f]+\.html$/.test(f));

// ---- 取文字 ----
const blocks = [];
const seenScripts = new Set();
htmlPages.forEach((page, i) => blocks.push(...pageBlocks(cheerio.load(readFileSync(path.join(DIST, page), 'utf8')), page, { withChrome: i === 0, seenScripts })));
const pagesWithText = new Set(blocks.filter((b) => b.page !== '(layout)' && !b.tag.startsWith('attr') && b.tag !== 'script').map((b) => b.page)).size;
const dataFiles = distFiles.filter((f) => (f.endsWith('.json') && !/(^|\/)(search-index|build-info)\.json$/.test(f)) || /^shared\/[^/]+\.js$/.test(f));
for (const f of dataFiles) {
    const content = readFileSync(path.join(DIST, f), 'utf8');
    if (f.endsWith('.js')) {
        for (const t of scriptStrings(content)) blocks.push({ page: `public/${f}`, kind: 'json', tag: 'script', text: t, skip: ' '.repeat(t.length), bold: [] });
    } else blocks.push(...jsonBlocks(JSON.parse(content), `public/${f}`, cheerio.load));
}
// 每頁都要掃到文字。版面或抽取壞掉時，檢查不能因為沒東西可查而通過。
if (htmlPages.length === 0 || pagesWithText < htmlPages.length) {
    console.error(`只從 ${pagesWithText} 頁取到文字，dist 有 ${htmlPages.length} 頁。`);
    process.exit(1);
}

// ---- 回推原始檔 ----
const sources = git('ls-files', '-z', 'src', 'public').split('\0').filter((f) => /\.(md|astro|ts|js|mjs|json)$/.test(f) && !f.includes('/vendor/'));
const index = sourceIndex(sources.map((p) => ({ path: p, content: readFileSync(path.join(ROOT, p), 'utf8') })));
const jsonCache = new Map();
function preferred(page) {
    if (page.startsWith('public/')) return [page];
    if (page === '(layout)') return ['src/components/Header.astro', 'src/components/Footer.astro', 'src/layouts/BaseLayout.astro'];
    const m = page.match(/^career-exploration\/clusters\/([^/]+)\/([^/]+)\.html$/);
    if (m && m[2] !== 'index') return [`src/content/clusters/${m[1]}/${m[2]}.md`];
    if (m) return ['src/pages/career-exploration/clusters/[cluster]/index.astro', 'src/data/clusters.ts'];
    const base = page.replace(/\.html$/, '');
    return [`src/pages/${base}.astro`, `src/pages/${base}/index.astro`, 'src/layouts/BaseLayout.astro'];
}
/** where 回傳命中的原始檔與行號；資料 JSON 用 pointer 找那個欄位所在的行，找不到時鍵是 page:頁面路徑。 */
function where(b, at, len) {
    if (b.pointer && existsSync(path.join(ROOT, b.page))) {
        if (!jsonCache.has(b.page)) { const raw = readFileSync(path.join(ROOT, b.page), 'utf8'); jsonCache.set(b.page, { lines: raw.split('\n'), data: JSON.parse(raw) }); }
        const { lines, data } = jsonCache.get(b.page);
        const ptrKey = `${b.page}#${b.pointer}`;
        if (!jsonCache.has(ptrKey)) {
            const v = b.pointer.split('/').slice(1).reduce((o, k) => o?.[k], data);
            const needle = typeof v === 'string' ? JSON.stringify(v).slice(1, 80) : null;
            jsonCache.set(ptrKey, needle ? lines.findIndex((l) => l.includes(needle)) : -1);
        }
        const i = jsonCache.get(ptrKey);
        if (i >= 0) return { key: b.page, line: i + 1 };
    }
    const hit = locate(index, b, at, len, preferred(b.page));
    return hit ? { key: hit.file, line: hit.line } : { key: `page:${b.page}`, line: null };
}

// ---- 放行 ----
const ruleIds = new Set(RULES.map((r) => r.id));
const allow = JSON.parse(readFileSync(ALLOW, 'utf8')).entries;
const today = process.env.WRITING_TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const blockKey = new Map();
const keyOf = (b) => { if (!blockKey.has(b)) blockKey.set(b, where(b, 0, Math.min(b.text.length, 12)).key); return blockKey.get(b); };
const allowErrors = [];
const allowWarnings = [];
const problems = allowProblems(allow, ruleIds, today);
const usable = allow.filter((e, i) => {
    const { errors, warnings } = problems[i];
    const n = allowOccurrences(e, blocks.filter((b) => (e.page ? b.page === e.page : keyOf(b) === e.file)));
    if (n !== 1) errors.push(n === 0 ? '原文片段找不到' : `原文片段出現 ${n} 次，請加長片段`);
    for (const w of warnings) allowWarnings.push(`${e.file ?? e.page}「${e.text}」：${w}`);
    for (const err of errors) allowErrors.push(`${e.file ?? e.page}「${e.text}」：${err}`);
    return errors.length === 0;
});

// ---- 比對 ----
const { hits: raw, skipped } = findHits(blocks);
const hits = [];
const seen = new Set();
for (const h of raw.sort((x, y) => (x.block.tag.startsWith('attr') ? 1 : 0) - (y.block.tag.startsWith('attr') ? 1 : 0))) {
    const w = where(h.block, h.index, h.len);
    if (usable.some((e) => e.rule === h.rule && (e.page ? e.page === h.block.page : e.file === w.key) && allowCovers(e, h.block, h.index, h.len))) continue;
    // 頁面標題和摘要常和內文出自同一行，同一規則、同一行、同一個字只算一次。同一行模板產生的多頁命中
    // （例如 [cluster]/index.astro 的 description）也因此算一筆。
    const dupKey = `${h.rule}|${w.key}:${w.line}|${h.match}|${h.block.text.slice(Math.max(0, h.index - 8), h.index + h.len + 8)}`;
    if (w.line && h.block.tag.startsWith('attr') && seen.has(dupKey)) continue;
    seen.add(dupKey);
    hits.push({ ...h, ...w });
}
const counts = {};
for (const h of hits) { counts[h.rule] ??= {}; counts[h.rule][h.key] = (counts[h.rule][h.key] ?? 0) + 1; }

const policy = JSON.parse(readFileSync(POLICY, 'utf8'));
if (args.includes('--update-baseline')) {
    const { over, under } = compareBaseline(policy, counts);
    writeFileSync(POLICY, `${JSON.stringify(lowerBaseline(policy, counts), null, 1)}\n`);
    console.log(`下修了 ${under.length} 個基準。`);
    for (const o of over) console.error(`超過基準，不會調高：${o.rule}  ${o.key}  ${o.count} 筆，基準 ${o.baseline}`);
    process.exit(over.length ? 1 : 0);
}
const { over, under } = compareBaseline(policy, counts);

// ---- 輸出 ----
const severity = Object.fromEntries(RULES.map((r) => [r.id, r.severity]));
const context = (h) => h.block.text.slice(Math.max(0, h.index - 20), h.index + h.len + 20);
const rows = RULES.map((r) => [r.id, r.severity, hits.filter((h) => h.rule === r.id).length]);
console.log('規則  嚴重度  筆數');
for (const [id, sev, n] of rows) console.log(`${id}  ${sev}  ${n}`);
console.log(`\n掃了 ${htmlPages.length} 頁、${dataFiles.length} 個資料檔，${blocks.length} 個區塊。`);
for (const w of allowWarnings) console.log(`警告：writing-allow.json ${w}`);
if (under.length) console.log(`\n${under.length} 處比基準少，執行 npm run check:writing -- --update-baseline 下修基準。`);
for (const e of allowErrors) console.error(`writing-allow.json ${e}，這一條不放行。`);
if (over.length) {
    console.error(`\n${over.length} 處超過基準：`);
    for (const o of over) {
        console.error(`  ${o.rule}  ${o.key}  ${o.count} 筆，基準 ${o.baseline}`);
        for (const h of hits.filter((x) => x.rule === o.rule && x.key === o.key)) console.error(`    ${h.line ? `第 ${h.line} 行` : h.block.page}：${context(h)}`);
    }
}

mkdirSync(path.dirname(REPORT), { recursive: true });
writeFileSync(REPORT, JSON.stringify({
    pages: htmlPages.length, dataFiles: dataFiles.length, counts, skipped, over, under, allowErrors, allowWarnings,
    hits: hits.map((h) => ({ rule: h.rule, severity: severity[h.rule], file: h.key, line: h.line, page: h.block.page, match: h.match, context: context(h) })),
}, null, 1));

if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ['### 寫作檢查', '', '| 規則 | 嚴重度 | 筆數 |', '| --- | --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`), ''];
    if (over.length) md.push(`超過基準 ${over.length} 處：`, '', ...over.map((o) => `- ${o.rule} ${o.key}：${o.count} 筆，基準 ${o.baseline}`), '');
    if (allowErrors.length) md.push('writing-allow.json 的錯誤：', '', ...allowErrors.map((e) => `- ${e}`), '');
    md.push('完整清單在 artifact 的 writing.json。', '');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n'));
}

const annotateRef = argAfter('--annotate');
if (annotateRef) {
    const { annotations, rest } = pickAnnotations(hits, changedLines(git('diff', '-U0', annotateRef, '--', 'src', 'public')), new Set(over.map((o) => `${o.rule}|${o.key}`)), ANNOTATION_LIMIT);
    const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    for (const { level, hit } of annotations) console.log(`::${level} file=${hit.key},line=${hit.line},title=${hit.rule}::${esc(context(hit))}`);
    if (rest) console.log(`改到的行還有 ${rest} 筆命中沒有標，見 step summary 和 artifact 的 writing.json。`);
}

process.exit(over.length || allowErrors.length ? 1 : 0);
