#!/usr/bin/env node
// 程式碼註解的兩項檢查，規範見 CONTRIBUTING.md 的「程式碼註解」。
//
//   node scripts/check-comments.mjs [--report] [檔案或目錄…]
//     每個檔案的註解行數不能超過程式行數。沒給路徑就檢查 git ls-files 列出的檔案，
//     給目錄時連還沒 git add 的新檔案一起檢查。認得哪些檔案見 check-comments.lib.mjs 的 languageOf。
//     --report 列出每個檔案的行數和沒有檢查的檔案類型，超過也不會失敗。
//   node scripts/check-comments.mjs --code-unchanged <git-ref> [檔案或目錄…]
//     和 <git-ref> 相比，工作區裡變動的 JS、TS、CSS、Astro 檔去掉註解之後必須一個 token 都不差。
//     languageOf 認得的其他類型（shell、YAML、Dockerfile 和整行註解的設定檔）掃描器有已知的漏判，
//     內容有變動就列出來請人工核對，結束碼是 1。HEAD 和工作區不同的檔案，HEAD 那一份也要比，push
//     出去的是它。新增、刪除、改名、改權限都算變動，分不出註解的檔案逐位元組比對。只改了內容的說明文件
//     不比，也就是 src/ 和 public/ 以外的 Markdown。git add 之後又改過的檔案直接失敗：commit 會送出
//     暫存區那一份，這裡比對不到。
//
// 相對路徑以執行的目錄為準。npm run 一律在 repo 根目錄執行腳本，打指令的目錄由 npm 放在 INIT_CWD。
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { languageOf, scan, countLines, firstDifference, ScanError } from './check-comments.lib.mjs';

/** EXCLUDED 列出不算行數的檔案和理由。--code-unchanged 不看這份清單：產生出來的檔案變了，程式也就變了。 */
const EXCLUDED = [
    [/(?:^|\/)node_modules\//, '第三方套件'],
    [/^dist\//, '建置產物'],
    [/^\.link-root\//, 'CI 給 lychee 建的路徑'],
    [/^public\/vendor\//, 'vendor-assets.mjs 從 node_modules 複製的檔案'],
    [/\.min\.js$/, '壓縮過的程式'],
    [/^ai-gateway\/src\/s2t-table\.mjs$/, '由 ai-gateway/scripts/build-s2t-table.mjs 產生'],
];
const COMPARED_LANGS = new Set(['js', 'css', 'astro']);

function usage(message) {
    console.error(`${message}\n用法：node scripts/check-comments.mjs [--report] [檔案或目錄…]\n      node scripts/check-comments.mjs --code-unchanged <git-ref> [檔案或目錄…]`);
    process.exit(2);
}

let root;
try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
} catch {
    usage('要在 git repo 裡執行。');
}

const cwd = process.env.INIT_CWD || process.cwd();
const git = (args) => execFileSync('git', args, { cwd: root, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
const gitList = ([cmd, ...rest]) => git([cmd, '-z', ...rest]).toString('utf8').split('\0').filter(Boolean);
const lineOf = (src, pos) => src.slice(0, pos).split('\n').length;

/** repoPath 把參數轉成 repo 裡以 / 分隔的路徑，repo 根目錄是 '.'。 */
function repoPath(p) {
    const rel = path.relative(root, path.resolve(cwd, p)).split(path.sep).join('/');
    if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) usage(`${p} 不在這個 repo 裡。`);
    return rel || '.';
}

/**
 * readRegularFile 讀出 abs 的內容，不存在或不是一般檔案時回傳 null；read 為 false 時只判斷，回傳空字串。
 * 判斷和讀取用同一個 fd，先 stat 路徑再讀的話，兩次碰到的可能不是同一個檔案。加 O_NONBLOCK，FIFO 才不會卡在 open。
 * @param {string} abs @param {boolean} read @returns {string|null}
 */
function readRegularFile(abs, read) {
    let fd;
    try {
        fd = openSync(abs, constants.O_RDONLY | constants.O_NONBLOCK);
    } catch (err) {
        if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR'].includes(err.code)) return null;
        throw err;
    }
    try {
        if (!fstatSync(fd).isFile()) return null;
        return read ? readFileSync(fd, 'utf8') : '';
    } finally {
        closeSync(fd);
    }
}

function lengthCheck(report, args) {
    const files = new Set();
    if (args.length === 0) gitList(['ls-files']).forEach((f) => files.add(f));
    for (const arg of args) {
        const rel = repoPath(arg);
        if (!existsSync(path.join(root, rel))) usage(`找不到 ${arg}。`);
        if (statSync(path.join(root, rel)).isDirectory()) {
            gitList(['ls-files', '--cached', '--others', '--exclude-standard', '--', rel]).forEach((f) => files.add(f));
        } else files.add(rel);
    }
    const rows = [];
    const skipped = [];
    const unknown = new Map();
    const errors = [];
    for (const file of [...files].sort()) {
        const lang = languageOf(file);
        const rule = lang && EXCLUDED.find(([re]) => re.test(file));
        const src = readRegularFile(path.join(root, file), Boolean(lang && !rule));
        if (src === null) continue;
        if (!lang) {
            const kind = path.posix.extname(file) || path.posix.basename(file);
            unknown.set(kind, (unknown.get(kind) ?? 0) + 1);
            continue;
        }
        if (rule) {
            skipped.push(`${file}（${rule[1]}）`);
            continue;
        }
        try {
            rows.push({ file, ...countLines(src, scan(src, lang)) });
        } catch (err) {
            if (!(err instanceof ScanError)) throw err;
            errors.push(`${file}:${lineOf(src, err.pos)}：${err.message}`);
        }
    }
    const over = rows.filter((r) => r.comment > r.code);
    if (report) {
        console.log('註解  程式  檔案');
        for (const r of rows) {
            console.log(`${String(r.comment).padStart(4)}  ${String(r.code).padStart(4)}  ${r.file}${r.comment > r.code ? '  ← 註解比程式多' : ''}`);
        }
        console.log(`\n${rows.length} 個檔案，其中 ${over.length} 個的註解行數超過程式行數。`);
        for (const s of skipped) console.log(`略過 ${s}`);
        const kinds = [...unknown].sort(([a], [b]) => a.localeCompare(b)).map(([kind, n]) => `${kind} ${n} 個`);
        if (kinds.length) console.log(`沒有檢查的檔案：${kinds.join('、')}`);
    } else if (over.length) {
        over.sort((a, b) => b.comment - b.code - (a.comment - a.code) || a.file.localeCompare(b.file));
        console.error(`${over.length} 個檔案的註解行數超過程式行數：`);
        for (const r of over) console.error(`  ${r.file}  註解 ${r.comment} 行，程式 ${r.code} 行`);
    } else if (rows.length) {
        console.log(`檢查了 ${rows.length} 個檔案，註解行數都沒有超過程式行數。`);
    }
    for (const e of errors) console.error(`無法分析 ${e}`);
    if (rows.length === 0 && errors.length === 0) {
        console.error('沒有可以檢查的檔案。');
        if (!report) for (const s of skipped) console.error(`略過 ${s}`);
        process.exit(1);
    }
    process.exit(errors.length || (!report && over.length) ? 1 : 0);
}

/** isDoc 判斷是不是說明文件。src/ 的 Markdown 會建成網頁、public/ 的檔案原樣上線，都不算。 */
const isDoc = (file) => file.endsWith('.md') && !/^(?:src|public)\//.test(file);

/**
 * changedFiles 列出 commit 和 to 之間變動的檔案，to 省略時和工作區比，連還沒 git add 的新檔案一起列出。
 * git diff --raw -z 的每筆是「:舊權限 新權限 舊 sha 新 sha 狀態」，後面接路徑，改名的有新舊兩個路徑。
 */
function changedFiles(commit, spec, to) {
    const parts = git(['diff', '--raw', '-z', '-M', commit, ...(to ? [to] : []), '--', ...spec]).toString('utf8').split('\0');
    const out = [];
    for (let k = 0; k + 1 < parts.length; ) {
        const [oldMode, newMode, , , status] = parts[k++].slice(1).split(' ');
        const old = parts[k++];
        out.push({ status: status[0], old, file: /^[RC]/.test(status) ? parts[k++] : old, oldMode, newMode, at: to });
    }
    if (!to) for (const file of gitList(['ls-files', '--others', '--exclude-standard', '--', ...spec])) out.push({ status: 'A', file });
    return out;
}

const GAP_NAMES = { '': '直接相連或只隔著註解', ' ': '隔著空白', '\n': '換行' };
const gapName = (gap) => GAP_NAMES[gap] ?? (gap[0] === '\n' ? `換行並縮排 ${gap.length - 1} 格` : `隔著 ${JSON.stringify(gap)}`);
const clip = (s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s);

function describe(diff, before, after) {
    const where = (tok, src, label) => {
        if (!tok) return `${label}到這裡就結束了`;
        const line = lineOf(src, tok.pos);
        return `${label}第 ${line} 行：${clip(src.split('\n')[line - 1].trim())}`;
    };
    const { before: a, after: b } = diff;
    let what;
    if (!a || !b) what = `${a ? '舊版' : '新版'}多出「${clip((a ?? b).text)}」`;
    else if (a.text !== b.text) what = `舊版是「${clip(a.text)}」，新版是「${clip(b.text)}」`;
    else what = `「${clip(a.text)}」前面：舊版${gapName(a.gap)}，新版${gapName(b.gap)}`;
    return [where(a, before, '舊版'), where(b, after, '新版'), what];
}

function codeUnchanged(ref, args) {
    if (!ref || ref.startsWith('--')) usage('--code-unchanged 後面要接一個 git ref。');
    let commit;
    try {
        commit = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).toString('utf8').trim();
    } catch {
        usage(`找不到 ${ref}。`);
    }
    const spec = args.map(repoPath);
    for (const [arg, rel] of args.map((a, k) => [a, spec[k]])) {
        if (existsSync(path.join(root, rel))) continue;
        try {
            git(['cat-file', '-e', `${commit}:${rel}`]);
        } catch {
            usage(`找不到 ${arg}。`);
        }
    }
    const problems = [];
    const manual = [];
    const docs = new Set();
    const compared = new Set();
    // commit 送出的是暫存區的版本，它和工作區不同時，這裡比對的就不是會送出的那一份。
    const unstaged = new Set(gitList(['diff', '--name-only', '--no-renames', '--', ...spec]));
    for (const file of gitList(['diff', '--cached', '--name-only', '--no-renames', '--', ...spec])) {
        if (unstaged.has(file)) problems.push([file, ['暫存區的版本和工作區不同，只有工作區的版本比對過；先 git add 或還原暫存區']]);
    }
    const dirty = new Set(gitList(['diff', '--name-only', '--no-renames', 'HEAD', '--', ...spec]));
    const changes = [...changedFiles(commit, spec, 'HEAD').filter((ch) => dirty.has(ch.file)), ...changedFiles(commit, spec)];
    for (const ch of changes) {
        if (ch.status === 'M' && ch.oldMode === ch.newMode && isDoc(ch.file)) {
            docs.add(ch.file);
            continue;
        }
        const name = ch.old === undefined || ch.old === ch.file ? ch.file : `${ch.old} → ${ch.file}`;
        const label = ch.at ? `${name}（HEAD 裡的版本）` : name;
        if (ch.status === 'A') {
            problems.push([label, ['新增的檔案，沒有舊版可以比對']]);
            continue;
        }
        if (ch.status === 'D') {
            problems.push([label, ['檔案被刪除了']]);
            continue;
        }
        if (ch.old !== ch.file) problems.push([label, ['檔案改名了，用到舊路徑的地方會找不到它']]);
        if (ch.oldMode !== ch.newMode) problems.push([label, [`檔案權限從 ${ch.oldMode} 變成 ${ch.newMode}`]]);
        const before = git(['show', `${commit}:${ch.old}`]);
        let after;
        try {
            after = ch.at ? git(['show', `${ch.at}:${ch.file}`]) : readFileSync(path.join(root, ch.file));
        } catch (err) {
            problems.push([label, [`讀不到新版：${err.message}`]]);
            continue;
        }
        const lang = languageOf(ch.file);
        if (!lang) {
            if (!before.equals(after)) problems.push([label, ['這種檔案分不出註解，內容有變動']]);
            continue;
        }
        if (!COMPARED_LANGS.has(lang)) {
            if (!before.equals(after)) manual.push(`${name}（${ch.at ? 'HEAD 裡的版本，' : ''}${lang}）`);
            continue;
        }
        compared.add(ch.file);
        const [a, b] = [before.toString('utf8'), after.toString('utf8')];
        try {
            const diff = firstDifference(a, b, lang);
            if (diff) problems.push([label, describe(diff, a, b)]);
        } catch (err) {
            if (!(err instanceof ScanError)) throw err;
            const src = err.message.startsWith('舊版') ? a : b;
            problems.push([label, [`無法分析（第 ${lineOf(src, err.pos)} 行）：${err.message}`]]);
        }
    }
    const base = `和 ${ref}（${commit.slice(0, 7)}）相比`;
    if (docs.size) console.log(`略過說明文件：${[...docs].join('、')}`);
    if (problems.length) {
        console.error(`${base}，下列檔案除了註解還有其他變動，或無法比對：`);
        for (const [file, lines] of problems) console.error(`  ${file}\n${lines.map((l) => `    ${l}`).join('\n')}`);
    } else if (compared.size) {
        console.log(`${base}，${compared.size} 個變動的檔案去掉註解之後程式都相同。`);
    } else if (!manual.length) {
        console.log(`${base}，沒有變動的程式檔案。`);
    }
    if (manual.length) {
        console.error(`${base}，下列檔案有變動，不在比對範圍，請人工核對：`);
        for (const m of manual) console.error(`  ${m}`);
    }
    if (problems.length || manual.length) process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === '--code-unchanged') {
    codeUnchanged(args[1], args.slice(2));
} else {
    const unknown = args.find((a) => a.startsWith('--') && a !== '--report');
    if (unknown) usage(`不認得的選項 ${unknown}。`);
    lengthCheck(args.includes('--report'), args.filter((a) => a !== '--report'));
}
