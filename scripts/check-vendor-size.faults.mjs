#!/usr/bin/env node
/**
 * 自架資產大小預算的故障注入矩陣
 * --------------------------------------------------------------
 * 這支檢查的價值完全在於「該紅的時候會紅」。它在正常狀態下印四行綠字，
 * 跟「根本沒在比」長得一模一樣——那正是它自己存在的理由（見 check-vendor-size.mjs
 * 的檔頭：一則基於錯誤推論的 PR 阻擋，沒有被任何自動化擋下來）。
 *
 * 三類故障，缺一不可：
 *   A. 資產真的變了     → 必須紅（這是主要用途）
 *   B. 有東西沒被計量   → 必須紅（新增函式庫不能靜靜溜進去）
 *   C. 檢查本身變全盲   → 必須紅（預算檔不見／空的／vendor 目錄不見）
 *
 * 一律在副本上注入，public/vendor/ 與版控裡的預算檔都不會被更動。
 *
 * 執行：  npm run test:vendor-size-faults
 */
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const SRC_VENDOR = path.join(ROOT, 'public', 'vendor');
const SRC_BUDGET = path.join(ROOT, 'scripts', 'vendor-size-budget.json');
const WORK = path.join(ROOT, '.vendorsize-faultcheck');

if (!existsSync(SRC_VENDOR)) {
    console.error(`找不到 ${SRC_VENDOR}，請先執行 npm run vendor`);
    process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const WORK_VENDOR = path.join(WORK, 'vendor');
const WORK_BUDGET = path.join(WORK, 'budget.json');
console.log(`故障注入在副本 ${path.relative(ROOT, WORK)}/ 上進行，public/vendor/ 與預算檔不會被更動。\n`);

const reset = () => {
    rmSync(WORK_VENDOR, { recursive: true, force: true });
    cpSync(SRC_VENDOR, WORK_VENDOR, { recursive: true });
    cpSync(SRC_BUDGET, WORK_BUDGET);
};

function run() {
    try {
        const out = execFileSync(process.execPath, ['scripts/check-vendor-size.mjs'], {
            cwd: ROOT,
            stdio: 'pipe',
            env: { ...process.env, VENDOR_DIR: WORK_VENDOR, VENDOR_BUDGET: WORK_BUDGET },
        });
        return { code: 0, out: String(out) };
    } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
}

/** 不要寫死檔名（ionicons 的檔名帶內容雜湊，上游一動就全變）。 */
const listAssets = () => {
    const walk = (d, p = '', o = []) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const rel = p ? `${p}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), rel, o);
            else o.push(rel);
        }
        return o;
    };
    return walk(WORK_VENDOR).filter((f) => f.endsWith('.js') && f !== 'vendor-manifest.json');
};

/** 該組唯一的檔——刪掉它會讓整組消失。 */
const anyAsset = () => listAssets().find((f) => /^feather[.-]/.test(f)) ?? listAssets()[0];

/** 多檔的那一組裡的一個——刪掉它只會讓檔案數變少，組還在。 */
const multiFileAsset = () => {
    const f = listAssets().find((x) => x.startsWith('ionicons/') && x.endsWith('.js'));
    if (!f) throw new Error('找不到多檔分組的樣本（ionicons/*.js）——分組規則可能改了，請更新這一條');
    return f;
};

const cases = [
    // ── A：資產真的變了 ────────────────────────────────────
    {
        name: '某個資產變大（上游把檔案變胖，或換成未壓縮版）',
        inject: () => {
            const f = anyAsset();
            const p = path.join(WORK_VENDOR, f);
            writeFileSync(p, readFileSync(p, 'utf8') + '\n// '.padEnd(5000, 'x'), 'utf8');
            return `${f} 加了 5000 bytes`;
        },
        expect: /bytes：預算.*→ 實際.*使用者要下載的東西變多了|bytes：預算/s,
    },
    {
        name: '某個資產被截斷（打包壞掉、解壓不完整）',
        inject: () => {
            const f = anyAsset();
            const p = path.join(WORK_VENDOR, f);
            writeFileSync(p, readFileSync(p, 'utf8').slice(0, 100), 'utf8');
            return `${f} 截成 100 bytes`;
        },
        expect: /bytes：預算/,
    },
    {
        // 刻意挑**多檔的那一組**（ionicons-js 有 6 個），刪一個之後那一組還在，
        // 測到的才是「檔案數變少」。第一版隨便挑檔，剛好挑到 feather 組唯一的
        // 那個檔，整組消失，走的是下面那條「整組不見」的路徑——測試名稱與實際
        // 測到的東西對不上，是我自己寫測試時踩到的同一個病。
        name: '某一組的檔案數變少（多檔的組裡少了一個）',
        inject: () => {
            const f = multiFileAsset();
            rmSync(path.join(WORK_VENDOR, f));
            return `刪掉 ${f}`;
        },
        expect: /files：預算 \d+ → 實際/,
    },
    {
        name: '某一組整個不見（該函式庫沒被 vendor）',
        inject: () => {
            const f = anyAsset();
            rmSync(path.join(WORK_VENDOR, f));
            return `刪掉 ${f}（該組唯一的檔）`;
        },
        expect: /實際一個檔都沒產出/,
    },

    // ── B：有東西沒被計量 ──────────────────────────────────
    {
        name: '多了一個不屬於任何分組的資產（新函式庫靜靜溜進去）',
        inject: () => {
            writeFileSync(path.join(WORK_VENDOR, 'sneaky-lib.js'), 'x'.repeat(30000), 'utf8');
            return '新增 sneaky-lib.js（30KB）';
        },
        expect: /不屬於任何分組|沒有被計量/,
    },

    // ── C：檢查本身變全盲 ──────────────────────────────────
    {
        name: '預算檔不見了（不得當成「沒有預算所以都通過」）',
        inject: () => {
            rmSync(WORK_BUDGET);
            return '刪掉預算檔';
        },
        expect: /讀不到或無法解析/,
    },
    {
        name: '預算檔的 groups 是空的（比不出任何東西，卻可能印綠字）',
        inject: () => {
            writeFileSync(WORK_BUDGET, JSON.stringify({ groups: {} }, null, 2), 'utf8');
            return 'groups 設成 {}';
        },
        expect: /沒有可用的 groups/,
    },
    {
        name: '預算檔不是合法 JSON',
        inject: () => {
            writeFileSync(WORK_BUDGET, '{ 這不是 JSON', 'utf8');
            return '寫入壞掉的 JSON';
        },
        expect: /讀不到或無法解析/,
    },
    {
        name: 'vendor 目錄整個不見（不得當成「沒有自架資產」）',
        inject: () => {
            rmSync(WORK_VENDOR, { recursive: true, force: true });
            return '刪掉整個 vendor 目錄';
        },
        expect: /找不到|沒跑或跑失敗/,
    },
    {
        name: 'vendor 目錄是空的',
        inject: () => {
            rmSync(WORK_VENDOR, { recursive: true, force: true });
            mkdirSync(WORK_VENDOR, { recursive: true });
            return '清空 vendor 目錄';
        },
        expect: /沒有任何資產|是空的/,
    },
];

let pass = 0;
let fail = 0;

reset();
const base = run();
console.log(base.code === 0 ? '  ✅ 基準綠燈' : `  ❌ 基準就是紅的，後面的結果沒有意義：\n${base.out.slice(0, 300)}`);
if (base.code !== 0) {
    rmSync(WORK, { recursive: true, force: true });
    process.exit(1);
}
console.log('');

for (const c of cases) {
    reset();
    let detail;
    try {
        detail = c.inject();
    } catch (e) {
        fail++;
        console.log(`  ❌ ${c.name}  → 注入失敗：${e.message}`);
        continue;
    }
    const r = run();
    if (r.code === 0) {
        fail++;
        console.log(`  ❌ ${c.name}  → 沒擋下來！（${detail}）`);
    } else if (!c.expect.test(r.out)) {
        fail++;
        console.log(`  ❌ ${c.name}  → 擋了但訊息不符預期（${detail}）`);
        console.log(`       實際輸出：${r.out.replace(/\s+/g, ' ').slice(0, 180)}`);
    } else {
        pass++;
        console.log(`  ✅ ${c.name}`);
    }
}

reset();
const after = run();
console.log(`\n故障注入：${pass} 擋下 / ${fail} 漏掉（共 ${cases.length} 項）`);
console.log(after.code === 0 ? '還原後仍為綠燈 ✅' : '⚠ 還原後仍是紅的，副本沒復原乾淨');

rmSync(WORK, { recursive: true, force: true });
process.exit(fail === 0 && after.code === 0 ? 0 : 1);
