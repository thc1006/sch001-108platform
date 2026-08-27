#!/usr/bin/env node
/**
 * 把第三方前端函式庫從 node_modules 複製到 public/vendor/
 * ================================================================
 * 為什麼不直接用 CDN：本站原本有四個 runtime CDN 依賴，全部沒有 SRI——
 *
 *   cdn.jsdelivr.net/npm/fuse.js@6.6.2      搜尋引擎；載不到就整個搜尋失效
 *   unpkg.com/feather-icons@4.29.2          兩頁的圖示
 *   unpkg.com/ionicons@7.1.0（esm ＋ nomodule）  一頁的 16 個圖示
 *
 * 這是三個第三方網域的可用性直接決定本站功能能不能用，而且沒有任何建置期檢查會
 * 發現它們掛掉——CDN 壞掉時 build 是綠的、check:site 是綠的，使用者打開才發現
 * 搜尋框永遠停在「載入中」。
 *
 * 改成自架之後：
 *   - 版本由 package-lock.json 鎖定（比 SRI 更完整：連相依都鎖）
 *   - 檔案缺少時 CI 會擋下，而且**權威在 check:site 而不是在這裡**：
 *       · scripts/check-built-site.mjs 從建置產物出發，先解析 HTML 屬性
 *         （script[src]、link[href]…），再從解析到的 vendor JS 遞移走它們的
 *         ES module import 圖，要求每個靜態 import 的目標都在 dist/ 裡。
 *         那一關不依賴任何人在 .astro 裡寫對什麼，所以刪不掉。
 *       · 本腳本檔尾也有一份同樣語意的檢查，但它的價值只是「更早失敗、訊息更
 *         具體」（講得出是哪個套件的哪個欄位）。真的漏掉時，check:site 會擋。
 *         兩份共用 site-contract.lib.mjs 的同一個掃描器，不是兩套邏輯。
 *   - 沒有第三方 runtime 請求
 *
 * public/vendor/ 不入版控（見 .gitignore）：它完全由 node_modules 推導得出，
 * commit 進去只會造成「lockfile 更新了但 vendor 忘了重跑」的漂移。
 *
 *
 * 為什麼不寫死 dist 路徑（#94）
 * ----------------------------------------------------------------
 * 第一版把三個檔案的位置直接寫死（fuse.js/dist/fuse.min.js、
 * ionicons/dist/ionicons/），缺檔時印的是「請先執行 npm ci」。dependabot #94
 * （fuse.js ^6.6.2 → ^7.5.0、ionicons ^7.1.0 → ^8.1.0）於是變成一則**誤診**：
 * npm ci 明明跑過而且成功了，真正的原因是 fuse.js 7 把 UMD build 整個刪掉。
 * 把維護者指向一個沒有問題的地方，比沒有訊息更糟。
 *
 * 量到的事實（npm view ＋ npm pack --dry-run）：
 *
 *   fuse.js 6.6.2   main=./dist/fuse.common.js  module=./dist/fuse.esm.js
 *                   unpkg=./dist/fuse.js        沒有 exports 欄位
 *                   dist/ 有 fuse.min.js（UMD，23.5kB）
 *   fuse.js 7.5.0   main=./dist/fuse.cjs        module=./dist/fuse.mjs
 *                   exports['./min'].import=./dist/fuse.min.mjs（26.1kB）
 *                   dist/ 底下只剩 .cjs 與 .mjs——UMD／IIFE build 一個都沒有，
 *                   所以「掛出 window.Fuse 的 classic script」這條路徑不存在了
 *
 *   ionicons 7.1.0  unpkg=dist/ionicons.js  ← stencil 的舊版相容 shim（962B），
 *                   它自己 appendChild 出 dist/ionicons/ionicons.esm.js
 *                   與 nomodule 的 dist/ionicons/ionicons.js（ES5，119,689 B）
 *   ionicons 8.1.0  unpkg=dist/ionicons/ionicons.esm.js
 *                   dist/ionicons/ionicons.js 與全部 *.system.js 都不存在了
 *                   ——ES5／SystemJS 那一半整個被移除，nomodule 沒有東西可載
 *
 * 所以：要複製哪一個檔，一律問套件自己的 package.json（exports／module／
 * unpkg／jsdelivr／main），而且解析出來的檔還要再驗一次「它真的是我們要的那種
 * 模組格式」。大版號一動，要嘛照樣解析得到（fuse 6→7 就是這樣走完的），要嘛
 * 停在一個講得出「哪個套件、裝的是哪一版、它現在不再提供什麼」的訊息上。
 *
 * 被否決的做法：
 *   - 「在 package.json 釘死 6.x／7.x」：把問題變成永遠不升級，而升級不了的
 *     相依最後都會變成安全性通知。
 *   - 「解析不到就靜默略過」：建置產物會少一個檔，而那正是這支腳本要防的失效
 *     模式。缺檔一律中止，一個都不例外。
 *   - 「改用 import.meta.resolve()／require.resolve()」：那兩個只看得到 exports
 *     的 '.' 與明確列出的子路徑，拿不到 unpkg／jsdelivr 這兩個「瀏覽器 build」
 *     專用欄位——ionicons 8 的 loader 位置正是只寫在 unpkg。
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 靜態 import 掃描與本檔、與 scripts/check-built-site.mjs 共用同一份實作。
// 同一件事有兩份擷取邏輯正是這一系列 issue 一路在修的失效模式；而且那份實作
// 會先剝掉註解與字串，避免把 banner 裡的使用範例誤判成真的 import。
import { staticImportSpecifiers, stripJsCommentsAndStrings } from './site-contract.lib.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'public', 'vendor');
// 產出清單的檔名。scripts/check-built-site.mjs 也認同一個名字——改名要兩邊一起改，
// 而漏改會被那邊的「有 vendor/ 產出卻找不到清單」擋下，不會靜默失效。
const VENDOR_MANIFEST = 'vendor-manifest.json';

/** 一律中止並印出理由。靜默略過會讓建置產物少一個檔，而那正是要防的失效模式。 */
function die(...lines) {
    for (const l of lines) console.error(l);
    process.exit(1);
}

function copy(srcAbs, destRel) {
    const dest = path.join(OUT, destRel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(srcAbs, dest);
    return dest;
}

function emit(destRel, text) {
    const dest = path.join(OUT, destRel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, text, 'utf8');
    return dest;
}

// ────────────────────────────────────────────────────────────────
// 從套件自己的 package.json 推導「瀏覽器要載的是哪一個檔」
// ────────────────────────────────────────────────────────────────

/**
 * 讀套件的 manifest。這裡才是真正的「沒安裝」——訊息就只講這件事，不要像上一版
 * 那樣把「套件裝好了但檔名變了」也說成「請先執行 npm ci」。
 */
function readManifest(name) {
    const p = path.join(NM, name, 'package.json');
    if (!existsSync(p)) {
        die(`找不到 node_modules/${name}/package.json——這個套件沒有安裝。`, '請先執行 npm ci（版本由 package-lock.json 鎖定）。');
    }
    return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * exports 欄位的最小解析器。
 *
 * 只做本腳本需要的那一段：子路徑（'.'／'./min'）＋ 條件（browser／import／
 * module／default）。刻意不支援萬用字元子路徑（'./*'）——目前三個套件都沒用到，
 * 而且沒解析到只會走到下一個候選欄位，不會靜默拿到錯的檔。
 *
 * **依物件的 key 順序取第一個成立的條件**，不是依我們偏好的順序去挑。這是
 * Node 與所有 bundler／CDN 的規則（條件物件是有序的，先寫的先贏），而第一版
 * 是反過來跑白名單——那會讓同一份 package.json 在這裡解析到 A、在 Node／
 * webpack／unpkg 解析到 B。故意偏好某個條件是一回事，跟整個生態系不一致而且
 * 沒人講是另一回事。實測畸形 manifest
 * `{ default: node 專用 build, browser: 瀏覽器 build }`：Node 會取 default，
 * 舊寫法取 browser。
 *
 * 白名單的作用改成「哪些 key 算數」：不在白名單的 key（types／node／deno…）
 * 直接跳過，不當成成立的條件。fuse.js 7 的
 * exports['./min'].import 是 { types: './dist/fuse.d.ts', default: './dist/fuse.min.mjs' }，
 * types 排第一但被跳過，所以拿到的是 .min.mjs 而不是 .d.ts。
 * （即使如此，.d.ts 仍在 vetCandidate 再擋一次——單靠條件順序防守太薄。）
 */
function pickCondition(node, conditions) {
    if (node == null) return null;
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) {
        for (const alt of node) {
            const hit = pickCondition(alt, conditions);
            if (hit) return hit;
        }
        return null;
    }
    for (const key of Object.keys(node)) {
        if (!conditions.includes(key)) continue;
        const hit = pickCondition(node[key], conditions);
        if (hit) return hit;
    }
    return null;
}

function resolveExports(exportsField, subpath, conditions) {
    if (exportsField == null) return null;
    if (typeof exportsField === 'string') return subpath === '.' ? exportsField : null;
    // exports 可以是「條件物件」或「子路徑對照表」；只要有 key 以 '.' 開頭就是後者
    const isSubpathMap = Object.keys(exportsField).some((k) => k.startsWith('.'));
    if (!isSubpathMap) return subpath === '.' ? pickCondition(exportsField, conditions) : null;
    if (!Object.hasOwn(exportsField, subpath)) return null;
    return pickCondition(exportsField[subpath], conditions);
}

const ESM_CONDITIONS = ['browser', 'import', 'module', 'default'];

/**
 * 候選欄位的順序＝「最像瀏覽器要的那一個」在前。
 *
 * exports['./min'] 排第一，是因為那是套件自己宣告的壓縮版；fuse.js 7 就是靠
 * 這一格拿到 dist/fuse.min.mjs（26.1kB）而不是 dist/fuse.mjs（50.4kB）。
 * fuse.js 6 沒有 exports 欄位，會一路掉到 module=./dist/fuse.esm.js（41.3kB）。
 *
 * 這裡有一個要講清楚的代價，不要用「差距遠小於此」帶過。首頁實際下載的那個檔
 * 從 fuse.min.js 變成 fuse.esm.js，實測（gzip -9）：
 *
 *     23,539 B → 41,322 B   未壓縮 +75%
 *      7,293 B → 10,814 B   gzip   +48%
 *
 * 也就是說在 #94 真的合併進來之前，每一位造訪首頁的人都要多付這 3.5kB
 * （gzip 後）。6 的 dist/ 其實有一個 fuse.esm.min.js（15,745 B／gzip 5,297 B）
 * 比原本還小，但它沒有被任何 metadata 指名；用「把 X.js 換成 X.min.js 再試試
 * 看」去猜檔名，正是這次要拔掉的那種寫死。換到的是「升級時不會猜錯檔」，而且
 * 這個代價在 #94 落地後自動消失（7 的 exports['./min'] 直接給壓縮版）。
 * 頁面另外加了 <link rel="modulepreload">，把 shim 帶來的那一趟序列化往返
 * 補回來（見 src/pages/index.astro）。
 */
function browserEntryCandidates(m) {
    return [
        ["exports['./min']", resolveExports(m.exports, './min', ESM_CONDITIONS)],
        ["exports['.']", resolveExports(m.exports, '.', ESM_CONDITIONS)],
        ['module', typeof m.module === 'string' ? m.module : null],
        ['unpkg', typeof m.unpkg === 'string' ? m.unpkg : null],
        ['jsdelivr', typeof m.jsdelivr === 'string' ? m.jsdelivr : null],
        ['browser', typeof m.browser === 'string' ? m.browser : null],
        ['main', typeof m.main === 'string' ? m.main : null],
    ];
}

/**
 * 候選路徑的前置檢查：位置合法、是檔案、副檔名不是一望即知載不了的東西。
 *
 * 回傳 null 代表可以往下驗語法；回傳字串代表「這個候選被否決，理由是這句」。
 * 位置不合法則直接中止（見下面 ① 的理由）。
 *
 * 每一條都是實際打出來的洞：
 *   ① exports 指到套件外面（`"." : "../../SECRET.js"`）。Node 的規格本來就
 *      禁止逃出套件根目錄，但 path.join 不會擋——舊版會安然 exit 0，把套件
 *      外的檔案複製進 public/ 這個會被部署出去的目錄。這不是「上游改了檔名」
 *      那種可以往下試下一個候選的情況，是 manifest 壞掉或有惡意，直接中止。
 *
 *      **字面比對不夠**：套件裡放一個指向外面的 symlink，路徑字串完全乾淨，
 *      舊版照樣 exit 0 把外面的檔案 vendor 出去。而 pnpm 與 yarn workspace 的
 *      node_modules 整棵樹本來就是 symlink 組出來的，這不是理論上的情況。
 *      所以兩邊都先 realpathSync 再比。
 *   ② 欄位指到一個目錄（`"main": "./lib"`，folder-as-module 是合法寫法）。
 *      existsSync 對目錄回 true，舊版會在 readFileSync 噴 EISDIR 的原始
 *      stack trace——那正是這支腳本要消滅的那一類訊息。
 *   ③ 0 位元組。截斷的檔案（下載中斷、磁碟滿）語法檢查一定通過——它什麼特徵
 *      都沒有——然後 vendor 得乾乾淨淨、build 全綠，而圖示全部消失。
 *   ④ .cjs／.d.ts／.ts：瀏覽器一定載不了。.d.ts 特別要擋，因為型別宣告檔在
 *      語法上是合法的 ES module，光靠下面的語法嗅探會直接放行
 *      （實測 `exports['./min'].browser = './dist/fuse.d.ts'` → 舊版 exit 0
 *      並把 .d.ts 當成搜尋引擎 vendor 出去）。
 *
 * 回傳的理由字串不自帶括號——呼叫端會用「（…）」包起來，自帶會變成雙層括號。
 */
function vetCandidate(pkgRoot, rel, name, field) {
    const abs = path.resolve(pkgRoot, rel);
    const escapes = (root, target) => {
        const inside = path.relative(root, target);
        return inside === '' || inside.startsWith('..') || path.isAbsolute(inside);
    };
    const bail = (realAbs) =>
        die(
            `${name} 的 package.json 用 ${field} 指到套件根目錄外面：${rel}`,
            `解析後的絕對路徑：${realAbs}`,
            `套件根目錄：${(() => {
                try {
                    return realpathSync(pkgRoot);
                } catch {
                    return pkgRoot;
                }
            })()}`,
            'Node 的 exports 規格禁止這種寫法。這裡直接中止而不是換下一個候選——',
            'vendor 出來的東西會被部署到公開的 public/vendor/，把套件外的檔案複製進去不是「降級」而是外洩。',
        );
    // 先做字面比對：不必碰檔案系統就能擋掉最明顯的那一種
    if (escapes(pkgRoot, abs)) bail(abs);
    if (!existsSync(abs)) return '此檔已不存在';
    // 再解 symlink 比一次。pnpm／yarn workspace 的樹就是 symlink 組成的，
    // 字面乾淨不代表真的在套件裡。
    try {
        const realRoot = realpathSync(pkgRoot);
        const realAbs = realpathSync(abs);
        if (escapes(realRoot, realAbs)) bail(realAbs);
    } catch {
        // realpath 失敗（權限、競態）就維持字面比對的結論，不放寬
    }
    const st = statSync(abs);
    if (!st.isFile()) return '是目錄不是檔案，folder-as-module 這種寫法瀏覽器載不了';
    if (st.size === 0) return '是 0 位元組的空檔，不可能是可用的 build';
    if (/\.cjs$/i.test(abs)) return 'CommonJS，瀏覽器載不了';
    if (/\.d\.[cm]?ts$/i.test(abs)) return '是型別宣告檔（.d.ts），不是可執行的 build';
    if (/\.[cm]?tsx?$/i.test(abs)) return '是 TypeScript 原始碼，不是可執行的 build';
    return null;
}

/**
 * 解析出來的檔到底是不是 ES module／是不是 classic script。
 *
 * 這一關是必要的：欄位語意會騙人。ionicons 兩個大版的 module 欄位都指向
 * dist/index.js（那是給 bundler 用的 addIcons API，不是瀏覽器 loader），
 * feather-icons 的 unpkg 指向 UMD。只信欄位名稱就會 vendor 出一個「載進去
 * 什麼都不會發生」的檔——而那在 runtime 是靜默失效。
 *
 * 是語法嗅探不是 parser，判準刻意收窄：
 *   - export {／export *／export default／export const|let|var|function|class|async
 *   - import {／import *／import "…"／import 名字
 *   - 不算 import(：動態 import 在 classic script 裡完全合法
 * UMD build 裡的 `exports.Fuse=` 不會誤判成 export（後面接的是 s 不是 {）。
 */
const ESM_SYNTAX =
    /(?:^|[\s;{}()])export\s*(?:\{|\*|default\b|(?:const|let|var|function|class|async)\b)|(?:^|[\s;{}()])import\s*(?:\{|\*|["'])|(?:^|[\s;{}()])import\s+[A-Za-z_$]/;

/**
 * classic script 這一側改成**要求正面訊號**，不再只是「排除 ESM 與 CJS」。
 *
 * 為什麼不能只用排除法：那是一個沒有下限的篩子。實測把 feather.min.js 截成
 * 0 位元組——不是 ESM、也沒有 CJS 特徵——舊版直接放行，vendor 乾淨、build 全綠，
 * 而整頁的 feather 圖示消失。純 CJS 也一樣：`module.exports = …` 用
 * <script src> 載進去就是 ReferenceError: module is not defined，圖示同樣
 * 安靜消失。（0 位元組那條現在也在 vetCandidate 提早擋掉，這裡是第二層。）
 *
 * 正面訊號＝這個檔真的會在瀏覽器裡掛出全域：
 *   - UMD banner：有 AMD 分支（`define.amd` 或 `define([…]`）。UMD 就是設計成
 *     三種環境都能用，所以它同時有 CJS 特徵是正常的。
 *   - 明確指派全域：`window.x=`／`self.x=`／`globalThis.x=`／`global.x=`。
 *
 * 實測 feather-icons 4.29.2 的 dist/feather.min.js：
 *   `…?module.exports=n():"function"==typeof define&&define.amd?define([],n):…e.feather=n()`
 * 命中 UMD_BANNER，通過。
 *
 * 判斷一律對「抹掉註解與字串之後」的內容做。不然一句
 *   // this build no longer does window.feather = ...
 * 就足以冒充正面訊號，而那正是這一系列修改一路在消滅的「用文件製造綠燈」。
 *
 * 已知的取捨，要說得準確——被否決的不只是「老派」寫法，而是**目前兩大打包器的
 * iife 輸出**。實測會被否決的形狀：
 *     esbuild   var feather=(()=>{…})();
 *     rollup    var feather=function(){…}();
 * 兩者都靠「頂層 var 在 classic script 裡就是全域」，檔案裡不會出現任何
 * window/self/globalThis 字樣，也沒有 AMD 分支。這個取捨仍然是刻意的：寧可停在
 * 一個講得出「我找的是什麼、在這個檔裡沒找到」的訊息上，讓人五秒內看懂並決定，
 * 也不要放行一個載進去什麼都不會發生的檔。真的遇到時的正確處置是在這裡加一條
 * 新的正面訊號，而不是把檢查拿掉。
 * （Object.defineProperty(window,"x",…) 是合法的掛全域方式，已列入正面訊號。）
 */
const CJS_SYNTAX = /(?:^|[^\w$.])(?:module\s*\.\s*exports\b|exports\s*\.\s*[A-Za-z_$]|require\s*\(\s*["'])/;
const UMD_BANNER = /\bdefine\s*\.\s*amd\b|\bdefine\s*\(\s*(?:\[|["'])/;
const GLOBAL_ASSIGN =
    /\b(?:window|self|globalThis|global)\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*[\"'][^\"']*[\"']\s*\])\s*=(?!=)|\bObject\s*\.\s*defineProperty\s*\(\s*(?:window|self|globalThis|global)\b/;
// UMD 變體：AMD 分支被拿掉，全域是「把 this／self 當參數傳進工廠函式」再用別名
// 指派的（`}(this, function(){…})` ＋ 內部的 `g.feather=f()`）。這種檔看得出是
// UMD 家族，但看不出它把全域掛在哪個名字上——所以仍然否決，但理由要說對：
// 它不是「純 CommonJS」。第一版把它歸成純 CJS，那是一句錯的診斷。
const GLOBAL_FACTORY_ARG = /\}\s*\)?\s*\(\s*(?:this|self|window|globalThis)\s*[,)]|typeof\s+self\s*[?:]/;

function isEsModule(src) {
    return ESM_SYNTAX.test(src);
}

/** classic 的正面訊號：這個檔會不會在瀏覽器裡掛出全域。一律看抹白後的內容。 */
function assignsBrowserGlobal(src) {
    const clean = stripJsCommentsAndStrings(src);
    return UMD_BANNER.test(clean) || GLOBAL_ASSIGN.test(clean);
}

function isCommonJsOnly(src) {
    const clean = stripJsCommentsAndStrings(src);
    return CJS_SYNTAX.test(clean) && !assignsBrowserGlobal(src) && !GLOBAL_FACTORY_ARG.test(clean);
}

/** UMD 家族但認不出全域掛在哪：仍然否決，只是理由不同於「純 CommonJS」。 */
function isUnrecognisedUmd(src) {
    return !assignsBrowserGlobal(src) && GLOBAL_FACTORY_ARG.test(stripJsCommentsAndStrings(src));
}

/**
 * 從 metadata 找出符合指定模組格式的瀏覽器進入點。
 *
 * flavor：'esm'（會被 <script type="module"> 或 import 載入）
 *         'classic'（靠 <script src> 掛出全域變數）
 */
function resolveEntry(name, flavor, purpose) {
    const m = readManifest(name);
    const pkgRoot = path.join(NM, name);
    const tried = [];
    for (const [field, rel] of browserEntryCandidates(m)) {
        if (!rel) continue; // 套件沒提供這一格，不值得列進錯誤訊息
        const fault = vetCandidate(pkgRoot, rel, name, field);
        if (fault) {
            tried.push(`  ${field} = ${rel}（${fault}）`);
            continue;
        }
        const abs = path.resolve(pkgRoot, rel);
        const src = readFileSync(abs, 'utf8');
        const esm = isEsModule(src);
        if (flavor === 'esm' && !esm) {
            tried.push(`  ${field} = ${rel}（不是 ES module）`);
            continue;
        }
        if (flavor === 'classic' && esm) {
            tried.push(`  ${field} = ${rel}（是 ES module，掛不出全域變數）`);
            continue;
        }
        if (flavor === 'classic' && isCommonJsOnly(src)) {
            tried.push(`  ${field} = ${rel}（是純 CommonJS，用 <script src> 載會丟 ReferenceError: module is not defined）`);
            continue;
        }
        if (flavor === 'classic' && isUnrecognisedUmd(src)) {
            tried.push(`  ${field} = ${rel}（是 UMD 變體但沒有 AMD 分支，全域透過參數別名指派，認不出它掛在哪個名字上）`);
            continue;
        }
        if (flavor === 'classic' && !assignsBrowserGlobal(src)) {
            tried.push(`  ${field} = ${rel}（找不到 UMD banner 或 window/self/globalThis 的全域指派，載進去不會掛出任何東西）`);
            continue;
        }
        return { abs, rel, field, version: m.version };
    }
    die(
        `${name}@${m.version} 找不到可用的${flavor === 'esm' ? ' ES module ' : ' classic script '}瀏覽器 build。`,
        `用途：${purpose}`,
        tried.length ? `已依序試過它自己 package.json 宣告的：\n${tried.join('\n')}` : '  它的 package.json 沒有宣告任何進入點欄位。',
        `這通常代表 ${name} 在某個大版把這一種 build 移除了（fuse.js 7 就移除了全部 UMD build）。`,
        `請先確認 ${name} 現在提供哪些 build（npm pack ${name} --dry-run 會列出全部檔案），`,
        '再決定 scripts/vendor-assets.mjs 與載入端要怎麼改；不要只是回退版本——那只是把升級成本往後推。',
    );
}

/**
 * stencil 的 lazy-load loader 目錄。
 *
 * ionicons 不是「複製一個檔」而是「複製一整個目錄」：loader 進入點會去 lazy-load
 * 一堆 p-<hash>.js chunk，檔名帶 hash，挑著複製只會在 runtime 少一塊。
 *
 * 判準是「這個目錄裡同時有 *.esm.js 進入點與 p-*.js chunk」——那是驗證出來的
 * 事實，不是猜的。兩個大版都通得過：
 *   ionicons 7：unpkg=dist/ionicons.js 是舊版相容 shim（檔案裡有 stencil 自己
 *               印的 data-stencil-namespace），它轉送到 dist/ionicons/
 *   ionicons 8：unpkg 直接就是 dist/ionicons/ionicons.esm.js
 */
function isStencilLoaderDir(dir) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
    const files = readdirSync(dir);
    return files.some((f) => /^p-[A-Za-z0-9_-]+\.(?:entry\.)?js$/.test(f)) && files.some((f) => f.endsWith('.esm.js'));
}

function resolveStencilLoaderDir(name, purpose) {
    const m = readManifest(name);
    const pkgRoot = path.join(NM, name);
    const tried = [];
    for (const [field, rel] of browserEntryCandidates(m)) {
        if (!rel) continue;
        // 與 resolveEntry 共用同一組前置檢查——逃出套件根目錄、目錄當進入點、
        // .d.ts 這幾個洞在這條路徑上一樣會出現（這裡下面也要 readFileSync）。
        const fault = vetCandidate(pkgRoot, rel, name, field);
        if (fault) {
            tried.push(`  ${field} = ${rel}（${fault}）`);
            continue;
        }
        const abs = path.resolve(pkgRoot, rel);
        // ① 候選檔本身就在 loader 目錄裡
        if (isStencilLoaderDir(path.dirname(abs))) {
            return { dir: path.dirname(abs), entry: path.basename(abs), field, version: m.version };
        }
        // ② 候選檔是 stencil 的舊版相容 shim。它在 runtime 會 appendChild 出
        //    <ns>/<ns>.esm.js，約定是「dist/<ns>.js 轉送到 dist/<ns>/」；照這個
        //    約定推一次，再用上面同一個判準驗證，驗不過就當作沒解析到。
        if (/data-stencil-namespace/.test(readFileSync(abs, 'utf8'))) {
            const fwdDir = abs.replace(/\.js$/, '');
            const fwdEntry = `${path.basename(fwdDir)}.esm.js`;
            if (isStencilLoaderDir(fwdDir) && existsSync(path.join(fwdDir, fwdEntry))) {
                return { dir: fwdDir, entry: fwdEntry, field: `${field}（stencil 相容 shim 轉送）`, version: m.version };
            }
            tried.push(`  ${field} = ${rel}（stencil 相容 shim，但它轉送的 ${path.relative(path.join(NM, name), fwdDir)}/ 不是 loader 目錄）`);
            continue;
        }
        tried.push(`  ${field} = ${rel}（所在目錄沒有 stencil 的 p-*.js chunk）`);
    }
    die(
        `${name}@${m.version} 找不到 stencil 的 lazy-load loader 目錄。`,
        `用途：${purpose}`,
        tried.length ? `已依序試過它自己 package.json 宣告的：\n${tried.join('\n')}` : '  它的 package.json 沒有宣告任何進入點欄位。',
        `請先確認 ${name} 現在把 loader 放在哪裡（npm pack ${name} --dry-run 會列出全部檔案），再決定要怎麼改。`,
    );
}

// ────────────────────────────────────────────────────────────────
// 從原始碼推導「要哪些圖示」與「頁面實際引用了哪些 vendor 檔」
// ────────────────────────────────────────────────────────────────

/**
 * 逐一走訪 src/ 底下可能含有圖示名稱或 vendor 引用的檔案。
 *
 * 副檔名清單原本只有 astro|html|js|mjs|json，而 src/ 實際上是 60 個 .md、
 * 28 個 .astro、2 個 .ts、1 個 .css——也就是**九成的檔案根本沒被掃到**。
 * 下面 collectIconNames 的整套推導都建立在這個 walker 上，所以在
 * src/data/clusters.ts 或任何內容 .md 裡新增一個 <ion-icon name="…">／
 * `icon: '…'`，vendor 步驟不會知道，那個 SVG 就在 runtime 靜默 404——
 * 正是那段註解宣稱要堵住的洞。清單改成涵蓋 src/ 會出現的所有文字型原始碼。
 */
function eachSourceFile(fn) {
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(astro|html|jsx?|[cm]js|tsx?|[cm]ts|json|mdx?)$/.test(e.name)) fn(p, readFileSync(p, 'utf8'));
        }
    };
    walk(path.join(ROOT, 'src'));
}

/**
 * 各頁用到哪些圖示，一律從原始碼推導而不是寫死。
 *
 * 寫死清單的話，日後有人加一個新圖示，vendor 步驟不會知道，該圖示在 runtime 靜默
 * 404——而 ion-icon 找不到 SVG 時不會報錯，只是不顯示。單一來源就是原始碼本身。
 *
 * `icon: 'x'` 這個形狀兩個圖示庫都在用（資料驅動的卡片），所以必須依「這個檔案
 * 載的是哪一個庫」來歸屬。第一版沒有分辨，把 competency-map 的 feather 名稱
 * （user-check／message-circle／users）當成 ionicon 去找，直接讓 vendor 失敗。
 */
function collectIconNames() {
    const ion = new Set();
    const feather = new Set();
    eachSourceFile((_p, src) => {
        const usesIon = /<ion-icon|ionicons/.test(src);
        const usesFeather = /data-feather|feather-icons|feather\.min\.js/.test(src);

        for (const m of src.matchAll(/<ion-icon[^>]*\bname="([a-z0-9-]+)"/g)) ion.add(m[1]);
        for (const m of src.matchAll(/\bdata-feather="([a-z0-9-]+)"/g)) feather.add(m[1]);

        // 資料驅動的動態圖示名：歸給這個檔案實際載入的那個庫
        for (const m of src.matchAll(/\bicon:\s*['"]([a-z0-9-]+)['"]/g)) {
            if (usesIon && !usesFeather) ion.add(m[1]);
            else if (usesFeather && !usesIon) feather.add(m[1]);
            // 兩個庫都載入的檔案無法歸屬，略過——目前沒有這種檔案，真的出現時
            // 下面的名稱驗證會因為找不到而報錯，不會靜默通過。
        }
    });
    return { ion: [...ion].sort(), feather: [...feather].sort() };
}

/**
 * 頁面實際指名哪些 vendor 檔（<script src>、<link href>…），從原始碼推導。
 *
 * 這一關把「上游改檔名 → vendor 出來的名字跟著變 → 頁面還指著舊名字」擋在
 * 建置期，比 check:site 早、訊息也更具體（講得出是哪個套件改了什麼）。
 * 但**它不是最後一道防線**：真正擋不掉的是 scripts/check-built-site.mjs
 * 從建置產物走 import 圖那一關，因為那一關不依賴任何人在樣板裡寫對什麼。
 *
 * 兩個必要的收窄，都是被實際打出來的：
 *
 *   ① 先剝掉 HTML 註解。原本的版本會把**說明文字**當成引用——這個檔案的註解
 *      裡就寫著「實測 `rm dist/vendor/fuse.esm.js`」，於是即使把
 *      <link rel="modulepreload"> 整行刪掉，這一關照樣印出
 *      「頁面引用驗證 … fuse.esm.js」宣稱它被引用了。一個由自己的說明文件
 *      製造出來的綠燈，比沒有這一關更糟。
 *   ② 要求前面有 src=／href= 屬性。散文提到路徑不算引用。
 *
 * 剩下的死角要講明白：這是文字比對，只抓得到**字面常數**。
 * `src={`${vendorBase}/vendor/${lib}.js`}` 這種把檔名算出來的寫法看不到。
 * 目前三個引用都是字面常數；真要動態組檔名時，這一關就保護不到——但
 * check:site 那一關仍然會從建置產物把它抓出來。
 */
function collectVendorRefs() {
    const refs = new Set();
    eachSourceFile((_p, src) => {
        const withoutComments = src.replace(/<!--[\s\S]*?-->/g, ' ');
        const re = /(?:\bsrc|\bhref)\s*=\s*[^>]{0,80}?\/vendor\/([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:js|mjs|css|svg))/g;
        for (const m of withoutComments.matchAll(re)) refs.add(m[1]);
    });
    return [...refs].sort();
}

/** 遞迴列出 public/vendor/ 底下所有檔案（相對 OUT 的 POSIX 路徑）。 */
function listEmitted(dir = OUT, prefix = '', out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) listEmitted(path.join(dir, e.name), rel, out);
        else out.push(rel);
    }
    return out;
}

/**
 * 產出的自我一致性：vendor 出來的每一個 ES module，它靜態 import 的東西都要
 * 真的在 public/vendor/ 裡，而且必須是瀏覽器解析得出來的相對路徑。
 *
 * 這一關**不是**最後防線，別把它寫成最後防線——真正擋不掉的是
 * scripts/check-built-site.mjs：它從建置產物出發、遞移走同一張 import 圖，
 * 不依賴任何人在 .astro 或在這裡寫對什麼。兩邊共用
 * site-contract.lib.mjs 的同一個掃描器，所以不是兩套會各自腐爛的邏輯。
 *
 * 那為什麼還留著：失敗得更早（不必等 astro build 跑完）而且訊息更具體——
 * 這裡講得出「是 fuse.js@7 的 exports['./min'] 換了檔名」，check:site 只講得出
 * 「dist 裡少了某個檔」。升級相依時，前者才是你想看到的那一句。
 *
 * 擋的兩類同上：相對路徑的目標必須存在；bare specifier（`node:fs`、`lodash`）
 * 與絕對網址一律否決——瀏覽器沒有 import map 解析不了，而那正是「manifest 指到
 * node 專用 build」會留下的痕跡。pickCondition 照 Node 的 key 順序走，若某個
 * 套件真把 node build 排在前面，會在這裡被抓住而不是等使用者開頁面才發現。
 */
function verifyEmittedImportGraph() {
    const emitted = new Set(listEmitted());
    const problems = [];
    for (const rel of emitted) {
        if (!/\.[cm]?js$/.test(rel)) continue;
        const src = readFileSync(path.join(OUT, rel), 'utf8');
        for (const spec of staticImportSpecifiers(src)) {
            if (!spec.startsWith('./') && !spec.startsWith('../')) {
                problems.push(`${rel} 靜態 import 了「${spec}」——不是相對路徑，瀏覽器沒有 import map 解析不了`);
                continue;
            }
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec.split(/[?#]/)[0]));
            if (!emitted.has(target)) problems.push(`${rel} 靜態 import 了「${spec}」，但 ${target} 不在這一輪的產出裡`);
        }
    }
    if (problems.length) {
        die(
            'vendor 產出的 import 圖不完整：',
            ...problems.map((p) => `  ${p}`),
            `這一輪產出的是：${[...emitted].sort().join('、')}`,
            '（同一張圖 check:site 也會走一次，但在這裡就停下來比較省事：那邊只講得出「dist 少了某個檔」。）',
        );
    }
    return emitted;
}

// ════════════════════════════════════════════════════════════════
// 實際複製
// ════════════════════════════════════════════════════════════════
rmSync(OUT, { recursive: true, force: true });

// ── 搜尋引擎（fuse.js）──
// 載入端改成 ES module，理由見 src/pages/index.astro：fuse.js 7 起不再有任何
// UMD build，classic script 那條路整個消失了；ESM 則是 6 與 7 都有。
const fuse = resolveEntry('fuse.js', 'esm', '首頁搜尋框的模糊搜尋引擎');
copy(fuse.abs, 'fuse.esm.js');

// 輸出檔名固定成 fuse.esm.js，再產一個把它掛成 window.Fuse 的 shim。
//
// 為什麼要多這一個檔：外部 module script 的 export 不會變成全域，而首頁的搜尋
// 邏輯是一段 classic script（Astro 的 is:inline，拿不到 static import 需要的
// 字面 specifier，而 base 路徑還是 /sch001-108platform/）。
//
// 被否決的做法：把搜尋邏輯整段改成 inline module。inline module 連 src 都沒有，
// check:site 驗的是 HTML 屬性——那等於把「vendor 檔不見時 CI 會紅」這個保護整個
// 拆掉，而那正是當初自架取代 CDN 的主要理由。現在頁面只認 vendor/fuse-global.js
// 這一個穩定網址，上游檔名怎麼改都不必動 .astro。
//
// shim 這個間接層曾經削弱過 CI 的保護：被 script[src] 指名的只剩這 7 行，
// 而 check:site 當時只認 HTML 屬性，所以它 import 的 41kB 引擎是隱形的
// （實測刪掉引擎，check:site 照樣「錯誤：0 ✅ 全部通過」）。
// 現在 check:site 會從產物遞移走 ES module 的 import 圖，那個洞已經補在
// checker 本身，不再靠頁面上寫什麼——頁面的 <link rel="modulepreload">
// 因此退回它本來的身分：純粹的效能提示。
emit(
    'fuse-global.js',
    [
        '// 由 scripts/vendor-assets.mjs 產生，請勿手動編輯。',
        `// 來源：fuse.js@${fuse.version} 的 ${fuse.field} → ${fuse.rel}`,
        '// fuse.js 6 與 7 的瀏覽器 build 檔名不同（6：dist/fuse.esm.js，',
        '// 7：dist/fuse.min.mjs），但兩版都 export default。首頁的搜尋邏輯因此',
        '// 不必知道上游檔名，也不必隨大版升級改 <script src>。',
        "import Fuse from './fuse.esm.js';",
        'window.Fuse = Fuse;',
        '',
    ].join('\n'),
);

// ── feather-icons ──
// 這個仍然是 classic script：頁面靠 window.feather.replace() 就地換掉
// [data-feather] 元素，而 feather 4 只提供 UMD（unpkg=dist/feather.min.js）。
const feather = resolveEntry('feather-icons', 'classic', '兩個頁面的 data-feather 圖示');
copy(feather.abs, 'feather.min.js');

// ── ionicons：loader ＋ 只複製真的用到的 SVG ──
const ion = resolveStencilLoaderDir('ionicons', '生涯探索頁的 ion-icon web component');

// ESM loader 與它 lazy-load 的 p-*.js chunk 必須整組帶走（檔名帶 hash）。
// ES5／SystemJS 那一半則刻意不帶：
//   - 它只會被 <script nomodule src=".../ionicons.js"> 這個進入點載到，而那一行
//     已經從 career-exploration/index.astro 移除（理由見該檔）。
//   - ionicons 8 根本不再提供這一半，不帶走等於讓 7 與 8 vendor 出來的檔案集合
//     語意一致，升級時不會有「7 有 8 沒有」的差異要解釋。
//   - 實測 ionicons 7.1.0：ionicons.js（119,689 B）＋ 五個 *.system*.js
//     （合計 22,742 B）＝ 142,431 B，從來沒有任何頁面請求過。
//     ESM loader（ionicons.esm.js）唯一的靜態 import 是 ./p-d15ec307.js；
//     ion-icon 的 entry chunk（p-1c0b2c47.entry.js）是 runtime 才 lazy-load 的，
//     靜態分析看不到——所以這裡不能只複製「靜態 import 得到的」，必須整個目錄搬。
//     ES5 那一半的入口 ionicons.js 引用的是 p-60d56620.system.js，兩組完全不相交。
// 用排除法而不是列舉法：不認識的檔一律照樣複製，只有這兩類「確定只屬於 nomodule
// 進入點」的才跳過——猜錯的方向必須是多複製，不能是少複製。
//
// ES5 loader 的檔名是「把進入點的 .esm.js 換成 .js」推出來的，所以只有在進入點
// 真的叫 <ns>.esm.js 時才成立。否則寧可不推：推錯會讓 es5Loader 剛好等於進入點
// 自己，把唯一要載的那個檔跳過——那是「少複製」，正是上面說不能發生的方向。
const es5Loader = ion.entry.endsWith('.esm.js') ? ion.entry.replace(/\.esm\.js$/, '.js') : null;
const skippedEs5 = [];
let loaderCount = 0;
for (const f of readdirSync(ion.dir)) {
    if (!f.endsWith('.js')) continue;
    if (f === es5Loader || /\.system\./.test(f)) {
        skippedEs5.push(f);
        continue;
    }
    copy(path.join(ion.dir, f), path.join('ionicons', f));
    loaderCount++;
}
if (!existsSync(path.join(OUT, 'ionicons', ion.entry))) {
    die(
        `ionicons@${ion.version} 的 loader 進入點 ${ion.entry} 沒有被複製出來。`,
        `loader 目錄：${path.relative(NM, ion.dir)}（由 ${ion.field} 解析而得）`,
        skippedEs5.length ? `這一輪跳過的是：${skippedEs5.join('、')}` : '這一輪沒有跳過任何檔。',
        '這是這支腳本的邏輯錯誤，不是相依的問題——排除規則不該把進入點本身排掉。',
    );
}

const { ion: wantedIon, feather: wantedFeather } = collectIconNames();

// svg/ 有一千多個檔約 2.5MB，本站只用得到十幾個，所以逐一挑。
const svgDir = path.join(ion.dir, 'svg');
if (!existsSync(svgDir)) {
    die(
        `ionicons@${ion.version} 的 loader 目錄底下沒有 svg/。`,
        `loader 目錄：${path.relative(NM, ion.dir)}（由 ${ion.field} 解析而得）`,
        'ion-icon 找不到 SVG 時不會報錯，只是不顯示——所以這裡直接中止，不讓它變成 runtime 的靜默失效。',
    );
}
const missingIon = [];
for (const name of wantedIon) {
    const svg = path.join(svgDir, `${name}.svg`);
    if (!existsSync(svg)) {
        missingIon.push(name);
        continue;
    }
    copy(svg, path.join('ionicons', 'svg', `${name}.svg`));
}

// feather 的圖示全部內嵌在 feather.min.js 裡，不需要挑檔；但名稱打錯同樣是
// 「安靜地不顯示」，所以一併驗證。
//
// 名單改成 import 套件本身（走它的 main）而不是讀 dist/icons.json：後者又是一條
// 寫死的 dist 路徑，套件換個目錄結構就會變成一則誤診訊息，正是這次要拔掉的東西。
let featherIcons;
try {
    const mod = await import('feather-icons');
    featherIcons = mod.icons ?? mod.default?.icons;
} catch (err) {
    die(`載入 feather-icons@${feather.version} 取圖示名單失敗：${err.message}`, '請確認該套件是否改變了進入點格式（例如改為純 ESM）。');
}
if (!featherIcons || typeof featherIcons !== 'object') {
    die(
        `feather-icons@${feather.version} 沒有匯出 icons 物件，無法驗證圖示名稱。`,
        '名稱打錯時 feather 只會安靜地不顯示，所以這個驗證不能略過。',
    );
}
const missingFeather = wantedFeather.filter((n) => !(n in featherIcons));

if (missingIon.length || missingFeather.length) {
    // 名字打錯時兩個庫都只會安靜地不顯示，不會有任何錯誤——在這裡就擋下來。
    const lines = [];
    if (missingIon.length) lines.push(`原始碼用到的 ionicon 在 ionicons@${ion.version} 中不存在：${missingIon.join('、')}`);
    if (missingFeather.length) lines.push(`原始碼用到的 feather icon 在 feather-icons@${feather.version} 中不存在：${missingFeather.join('、')}`);
    lines.push('請確認名稱拼寫、確認該檔案載入的是哪一個圖示庫，或確認該圖示是否在新版被更名／移除。');
    die(...lines);
}

// ── 最後兩關 ──
// ① 頁面用 HTML 屬性指名的 vendor 檔，這一輪真的產出來了嗎
const vendorRefs = collectVendorRefs();
const missingRefs = vendorRefs.filter((r) => !existsSync(path.join(OUT, r)));
if (missingRefs.length) {
    die(
        `src/ 底下的頁面引用了這些 vendor 檔，但這一輪沒有產出：${missingRefs.join('、')}`,
        `這一輪產出的是：${listEmitted().sort().join('、')}`,
        '通常代表上游改了檔名（或這支腳本改了輸出檔名），而頁面還指著舊名字。',
    );
}
// ② HTML 屬性看不到的那一層：產出之間的 import 圖
const emittedFiles = verifyEmittedImportGraph();
const emittedJs = [...emittedFiles].filter((f) => /\.[cm]?js$/.test(f));

// ③ 把「這一輪到底產出了哪些檔」寫成清單，交給 check:site 逐一確認它們真的
//    進了 dist/。
//
// 為什麼需要這個而不是再擴充 import 圖走訪：走訪這件事本身有三個結構性的盲點，
// 而且每一個都被實測打穿過——
//
//   · 動態 import 看不到。stencil 用 import(變數) 載 ion-icon 的 entry chunk，
//     刪掉它 → check:site 全綠，瀏覽器 17 個 ion-icon 全部有 shadowRoot 但
//     0 個有 <svg>，console 是 TypeError: Failed to fetch dynamically imported
//     module。ionicons 8 上走訪只碰得到 9 個產出裡的 2 個。
//   · 非 JS 的產出根本不在圖上。刪掉 svg/search-outline.svg → 全綠。
//   · 走訪會被餓死。它的起點來自 HTML 屬性，所以只要哪天頁面改用 inline
//     import() 載 vendor 程式碼，起點就是空集合——實測印出「走訪 0 個模組」、
//     「錯誤：0」、「✅ 全部通過」，而引擎跟 chunk 都已經被刪掉。
//
// 清單沒有這三個盲點：它不管 HTML 長什麼樣、不管靜態還是動態、也不管副檔名。
// 這是同一個保護第四次被搬家而不是被關上，到此為止。
//
// 清單不包含它自己（它是索引不是被索引者）；check:site 那邊也會在「有 vendor/
// 產出卻沒有清單」時報錯，否則刪掉清單就等於把這一關關掉。
const manifestEntries = listEmitted().sort();
emit(
    VENDOR_MANIFEST,
    JSON.stringify(
        {
            generatedBy: 'scripts/vendor-assets.mjs',
            note: '這一輪 vendor 出來的完整檔案清單。scripts/check-built-site.mjs 會要求每一筆都存在於 dist/。不要手改：它由建置產生，改它只會讓檢查對不上真實產物。',
            files: manifestEntries,
        },
        null,
        2,
    ) + '\n',
);

console.log(
    'vendor 完成：\n' +
        `  fuse.esm.js ← fuse.js@${fuse.version} 的 ${fuse.field} → ${fuse.rel}\n` +
        '  fuse-global.js（產生的 window.Fuse shim）\n' +
        `  feather.min.js ← feather-icons@${feather.version} 的 ${feather.field} → ${feather.rel}\n` +
        `  ionicons/ ← ionicons@${ion.version} 的 ${ion.field}：ESM loader ${ion.entry} ＋ 共 ${loaderCount} 個 .js` +
        (skippedEs5.length ? `（跳過只屬於 nomodule 的 ${skippedEs5.length} 個：${skippedEs5.join('、')}）` : '') +
        `\n  ionicon SVG ${wantedIon.length} 個：${wantedIon.join('、')}\n` +
        `  feather 名稱驗證 ${wantedFeather.length} 個：${wantedFeather.join('、')}\n` +
        `  頁面引用驗證 ${vendorRefs.length} 個：${vendorRefs.join('、')}\n` +
        `  import 圖驗證 ${emittedJs.length} 個 JS 產出，靜態 import 全部指得到
` +
        `  產出清單 ${VENDOR_MANIFEST}：${manifestEntries.length} 筆（check:site 會逐一確認它們都進了 dist/）`,
);
