#!/usr/bin/env node
/**
 * 自架前端資產的大小預算
 * ================================================================
 * `public/vendor/` 被 .gitignore 排除，版控裡一個檔案都沒有。那些位元組是
 * **每一位訪客實際會下載的東西**，卻在每一次 diff 裡完全隱形。
 *
 * ── 與既有檢查的分工（不要重複做同一件事）──
 * vendor 步驟已經產出 `public/vendor/vendor-manifest.json`，裡面記了每個檔的
 * byte 數，`check-built-site.mjs` 會 stat 每一筆比對，不符就擋。那道檢查回答的是
 * **「產出之後有沒有被動過手腳」**（截斷、打包壞掉、空檔）。
 *
 * 但那份 manifest 也寫在 `public/vendor/` 底下，同樣不在版控裡。所以它答不了
 * 另一個問題：**「這一版跟上一版比，使用者要下載的東西變了多少？」**
 *
 * 這支就是補那一格：預算入版控，變動要出現在 diff 裡、要有人按下同意。
 *
 * ── 為什麼需要它（實際發生過）──
 * 2026-08-28 的 fuse.js 6→7 升級（PR #122），兩個人各自推論出相反的結論：
 *
 *   一方讀了 `resolveEntry('fuse.js', 'esm', …)` 的參數名，推論解析會取
 *   exports['.']，去量 npm 套件裡的 dist/fuse.mjs（50,392 B），據此在 PR 上寫了
 *   一則「會變糟 22%，先別合」的阻擋；
 *   另一方實際跑了 vendor 步驟，拿到 26,095 B（走 exports['./min']），−37%。
 *
 * 後者是對的。重點不是誰錯——是**那個錯誤的阻擋沒有被任何自動化擋下來**，
 * 爭論最後靠「兩個人各自手動跑一次」解決。反過來說，上游哪天真的把檔案變成
 * 三倍，同樣沒有任何東西會說話。`check:site` 與 `build:deployable` 對那個 PR
 * 全綠——它們驗的是「vendor 檔存在且被引用」，不看它跟上一版比變了多少。
 *
 * ── 兩個刻意的設計選擇 ──
 * **1. 完全不容許誤差，不設百分比餘裕。**
 *    有人提過「上游 patch 版動幾百 bytes 不該擋人」。不採用，理由是：容許 5% 的話，
 *    每次升級都在容許範圍內漂 5%，十次之後就胖了六成而沒有任何一次被看到。
 *    而「擋人」的實際成本是跑一次 --update 再把 diff 一起提交——那個 diff 正是
 *    我們要的東西。相依更新本來就會被審，讓位元組變動出現在同一個 PR 裡是加分。
 *
 * **2. gzip 只顯示、不比對。**
 *    本檔原本寫「gzip 的輸出長度取決於 Node 內建的 zlib 版本，跨環境會飄」。
 *    那句話沒有量過，而且實測不成立：同一份 public/vendor/ 在
 *
 *      Node v20.19.4（zlib 1.3.0.1-motley-82a5fec）
 *      Node v24.13.0（zlib 1.3.1-470d3a2）
 *
 *    下的 gzipSync(level 9) 長度**每一組都完全相同**
 *    （feather 20686 / fuse 11166 / ionicons-js 10749 / ionicons-svg 5009）。
 *    CI 的 .node-version 是 24，與本機同屬 zlib 1.3.1，更不可能有差。
 *
 *    真正的理由是別的兩點：
 *    (a) gzip 長度不帶任何 raw bytes 沒有的訊號——它是 raw bytes 的函數，
 *        raw bytes 沒變它就不會變，比它等於把同一件事比兩次；
 *    (b) 它確實**可能**跟著壓縮實作走（Node 若哪天換成 zlib-ng，或改了預設
 *        strategy），到時候整份預算會為了一個不帶訊號的欄位全面失效。
 *    以「量過、確定性」為由留在輸出裡供人參考，但不當契約。
 *
 * 執行：  node scripts/check-vendor-size.mjs
 *         node scripts/check-vendor-size.mjs --update   （人工執行，把實測值寫回預算）
 *
 * **--update 絕不可以被建置流程自動呼叫**——那會讓它從「守住預期」退化成
 * 「記錄現況」，變成一個形狀正確但什麼都不擋的檢查。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.resolve(process.env.VENDOR_DIR || path.join(ROOT, 'public', 'vendor'));
const BUDGET_PATH = path.resolve(process.env.VENDOR_BUDGET || path.join(ROOT, 'scripts', 'vendor-size-budget.json'));
const UPDATE = process.argv.includes('--update');

/**
 * 分組規則。刻意**不**逐檔記錄：ionicons 的檔名帶內容雜湊（p-BdioGpgU.js），
 * 上游一動檔名就全變，逐檔預算會在每次升級都全部失效而失去訊號。
 * 以「一個函式庫送出去多少位元組」為單位，才是使用者實際感受到的量。
 */
const GROUPS = [
    { name: 'fuse', match: (rel) => /^fuse[.-]/.test(rel) },
    { name: 'feather', match: (rel) => /^feather[.-]/.test(rel) },
    { name: 'ionicons-svg', match: (rel) => rel.startsWith('ionicons/svg/') && rel.endsWith('.svg') },
    { name: 'ionicons-js', match: (rel) => rel.startsWith('ionicons/') && rel.endsWith('.js') },
];

/**
 * manifest 是 vendor 步驟自己的產出（沒有任何頁面 fetch 它），不是要送給使用者的
 * 資產，不計入預算。
 *
 * 排除清單刻意**只有這一個檔名**。原本還排除了所有 .md／.txt，那是一個看不見的洞：
 * 排除發生在分組之前，所以被排掉的檔案既不計量、也不會落進「不屬於任何分組」那條
 * 紅線，等於完全隱形。實測在 public/vendor/ 放一個 683 KB 的 HUGE-LICENSE.txt，
 * 這支檢查照樣印「自架資產大小符合預算 ✅」。而 .txt 完全可能是真的要部署的資產
 * ——SIL OFL 授權的字型就規定 OFL.txt 必須隨檔散布。
 *
 * 現在 .md／.txt 會落進 unmatched 而變紅：真的需要它時就加一條 GROUPS 規則，
 * 那一行 diff 正是我們要的「有人看過並同意」。
 */
const NOT_AN_ASSET = (rel) => rel === 'vendor-manifest.json';

function die(lines) {
    console.error('自架資產的大小預算對不上 ❌\n');
    for (const l of lines) console.error(`  ${l}`);
    process.exit(1);
}

function walk(dir, prefix = '', out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), rel, out);
        else out.push(rel);
    }
    return out;
}

// ── 讀不到就擋，不要當成「沒有資產」──────────────────────────
if (!existsSync(VENDOR)) {
    die([
        `找不到 ${path.relative(ROOT, VENDOR)}/`,
        '這代表 vendor 步驟沒跑或跑失敗，不是「沒有自架資產」。',
        '請先執行 npm run vendor（或 npm run build:deployable）。',
    ]);
}
const files = walk(VENDOR).filter((f) => !NOT_AN_ASSET(f));
if (files.length === 0) {
    die([`${path.relative(ROOT, VENDOR)}/ 裡沒有任何資產。vendor 步驟沒有產出東西。`]);
}

// ── 量測 ────────────────────────────────────────────────────
const actual = {};
const gzipOf = {};
const unmatched = [];
for (const rel of files) {
    const g = GROUPS.find((x) => x.match(rel));
    if (!g) {
        unmatched.push(rel);
        continue;
    }
    const buf = readFileSync(path.join(VENDOR, rel));
    const a = (actual[g.name] ??= { files: 0, bytes: 0 });
    a.files += 1;
    a.bytes += buf.length;
    gzipOf[g.name] = (gzipOf[g.name] ?? 0) + gzipSync(buf, { level: 9 }).length;
}

// 新增的自架函式庫如果沒有對應的分組，就完全不會被計量——那等於偷偷多了一份
// 使用者要下載的東西而沒有人看到。必須擋下來，不是忽略。
if (unmatched.length) {
    die([
        `有 ${unmatched.length} 個檔案不屬於任何分組，等於沒有被計量：`,
        ...unmatched.slice(0, 12).map((f) => `    ${f}`),
        unmatched.length > 12 ? `    …另外 ${unmatched.length - 12} 個` : '',
        '新增自架函式庫時要一併在本檔的 GROUPS 加規則，',
        '否則它送給使用者的位元組不會出現在任何地方。',
    ].filter(Boolean));
}

const show = () => {
    for (const name of Object.keys(actual).sort()) {
        const a = actual[name];
        console.log(
            `  ${name.padEnd(14)} ${String(a.files).padStart(3)} 檔  ${String(a.bytes).padStart(8)} B` +
            `  （gzip 約 ${gzipOf[name]} B，僅供參考、不納入比對）`,
        );
    }
};

// ── 更新模式（人工執行）──────────────────────────────────────
if (UPDATE) {
    const out = {
        _readme:
            'public/vendor/ 不在版控裡，所以使用者實際下載的位元組在 diff 裡是隱形的。' +
            '這份檔案是它們唯一的版控紀錄。數字變動代表使用者下載的東西變了——' +
            '請在 PR 說明裡交代為什麼，不要當成雜訊順手更新。' +
            'gzip 刻意不記錄：實測 Node 20（zlib 1.3.0.1）與 Node 24（zlib 1.3.1）長度完全相同，' +
            '它是 raw bytes 的函數、不帶額外訊號，卻會跟著壓縮實作走。',
        generatedBy: 'node scripts/check-vendor-size.mjs --update',
        groups: {},
    };
    for (const name of Object.keys(actual).sort()) out.groups[name] = actual[name];
    writeFileSync(BUDGET_PATH, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
    console.log(`已寫回 ${path.relative(ROOT, BUDGET_PATH)}：`);
    show();
    process.exit(0);
}

// ── 比對 ────────────────────────────────────────────────────
let budget;
try {
    budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
} catch (err) {
    die([
        `讀不到或無法解析 ${path.relative(ROOT, BUDGET_PATH)}（${err.message}）。`,
        '第一次建立請執行：node scripts/check-vendor-size.mjs --update',
    ]);
}
if (!budget?.groups || typeof budget.groups !== 'object' || Object.keys(budget.groups).length === 0) {
    die([
        `${path.relative(ROOT, BUDGET_PATH)} 沒有可用的 groups。`,
        '空的預算檔會讓這支檢查什麼都不比，而輸出看起來仍然是綠的。',
    ]);
}

const problems = [];
for (const name of [...new Set([...Object.keys(budget.groups), ...Object.keys(actual)])].sort()) {
    const b = budget.groups[name];
    const a = actual[name];
    if (!b) {
        problems.push(`${name}：預算檔裡沒有這一組，但實際產出了 ${a.files} 個檔、${a.bytes} B`);
        continue;
    }
    if (!a) {
        problems.push(`${name}：預算檔有這一組，但實際一個檔都沒產出——vendor 步驟可能壞了`);
        continue;
    }
    for (const k of ['files', 'bytes']) {
        if (a[k] !== b[k]) {
            const d = a[k] - b[k];
            const pct = b[k] ? `${d > 0 ? '+' : ''}${((d / b[k]) * 100).toFixed(1)}%` : '∞';
            problems.push(
                `${name}.${k}：預算 ${b[k]} → 實際 ${a[k]}（${d > 0 ? '+' : ''}${d}，${pct}）` +
                (k === 'bytes' && d > 0 ? '  ← 使用者要下載的東西變多了' : ''),
            );
        }
    }
}

if (problems.length) {
    die([
        ...problems,
        '',
        '使用者實際下載的位元組變了。這不是雜訊——public/vendor/ 不在版控裡，',
        '這份預算檔是那些位元組唯一的版控紀錄。',
        '',
        '確認變動是預期的（例如相依升級）之後執行：',
        '    node scripts/check-vendor-size.mjs --update',
        '並把預算檔的 diff 一起提交，在 PR 說明裡交代為什麼變。',
    ]);
}

console.log('自架資產大小符合預算 ✅');
show();
