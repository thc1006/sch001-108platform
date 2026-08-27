#!/usr/bin/env node
/**
 * 相依樹一致性檢查的故障注入矩陣
 * --------------------------------------------------------------
 * check-dep-tree.mjs 擋的是「靜默分裂」——建置會成功、沒有警告，只有產出變了。
 * 這種把關本身也是靜默的：在正常狀態下，它印一行綠字，跟「根本沒在檢查」
 * 長得一模一樣。所以必須有常駐測試證明它真的會擋。
 *
 * 除了證明「該擋的有擋」，這裡還有一個同樣重要的反例：
 * npm 樹裡出現同一套件的多個版本是**正常**的，絕大多數情況無害。如果這支檢查
 * 變成「任何重複版本都紅」，它會在第一次無關的相依更新時就被當成雜訊關掉。
 * 所以最後一個案例刻意注入一個良性重複，斷言它**不會**被擋。
 *
 * 一律在副本上注入，版控裡的 package-lock.json 不會被更動。
 *
 * 執行：  npm run test:deps-faults
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const SOURCE_LOCK = path.join(ROOT, 'package-lock.json');
const WORK = path.join(ROOT, '.deptree-faultcheck');
const WORK_LOCK = path.join(WORK, 'package-lock.json');

if (!existsSync(SOURCE_LOCK)) {
    console.error(`找不到 ${SOURCE_LOCK}`);
    process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
console.log(`故障注入在副本 ${path.relative(ROOT, WORK)}/ 上進行，package-lock.json 不會被更動。\n`);

/** 跑檢查器，讓它讀副本 lock，回傳 exit code 與合併輸出。 */
function runCheck() {
    try {
        const out = execFileSync(process.execPath, ['scripts/check-dep-tree.mjs'], {
            stdio: 'pipe',
            cwd: ROOT,
            env: { ...process.env, DEP_TREE_LOCK: WORK_LOCK },
        });
        return { code: 0, out: String(out) };
    } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
}

const original = readFileSync(SOURCE_LOCK, 'utf8');

/**
 * 注入一份巢狀副本，模擬「上游精確 pin 舊版、根被單獨升上去」的分裂。
 *
 * 這裡是結構性變更而不是字串取代，所以「注入未生效」的守衛也要是結構性的：
 * 寫檔後重新讀回來，確認那個巢狀條目真的在裡面。（本 repo 過去多次踩到
 * 字串取代因為 CRLF 而靜默無效的坑，教訓是：注入一定要有事後驗證。）
 */
function injectSplit(name, hostPath, fakeVersion) {
    const lock = JSON.parse(original);
    const rootKey = `node_modules/${name}`;
    const rootEntry = lock.packages[rootKey];
    if (!rootEntry) throw new Error(`${name} 不在 lock 的根層，無法注入`);
    const nestedKey = `node_modules/${hostPath}/node_modules/${name}`;
    lock.packages[nestedKey] = { ...rootEntry, version: fakeVersion };
    writeFileSync(WORK_LOCK, JSON.stringify(lock, null, 2), 'utf8');

    const written = JSON.parse(readFileSync(WORK_LOCK, 'utf8'));
    if (written.packages[nestedKey]?.version !== fakeVersion) {
        throw new Error('注入未生效（副本裡找不到注入的巢狀條目）');
    }
    if (written.packages[rootKey].version === fakeVersion) {
        throw new Error('注入無意義（根與巢狀版本相同，本來就不該被擋）');
    }
    return `${name} 根 ${written.packages[rootKey].version} vs 巢狀 ${fakeVersion}`;
}

const cases = [
    {
        name: 'tailwindcss 分裂（@tailwindcss/vite 精確 pin 舊版，根被單獨升上去）',
        inject: () => injectSplit('tailwindcss', '@tailwindcss/vite', '4.2.9'),
        expectBlocked: true,
        expect: /tailwindcss/,
    },
    {
        name: 'astro 分裂（integration 與 renderer 會對不上）',
        inject: () => injectSplit('astro', '@astrojs/sitemap', '6.4.8'),
        expectBlocked: true,
        expect: /astro/,
    },
    {
        name: '@tailwindcss/oxide 分裂（引擎與 tailwindcss 錯開）',
        inject: () => injectSplit('@tailwindcss/oxide', '@tailwindcss/node', '4.2.9'),
        expectBlocked: true,
        expect: /oxide/,
    },
    {
        // 反例：證明這不是「任何重複版本都紅」的粗暴檢查。
        // tslib 在真實的 npm 樹裡本來就常常有多份，那是無害的。
        name: '良性重複（tslib 多版本）——必須**不**被擋',
        inject: () => {
            const lock = JSON.parse(original);
            const rootKey = 'node_modules/tslib';
            const rootEntry = lock.packages[rootKey];
            if (!rootEntry) throw new Error('tslib 不在 lock 裡，換一個良性套件當反例');
            const nestedKey = 'node_modules/@tybys/wasm-util/node_modules/tslib';
            lock.packages[nestedKey] = { ...rootEntry, version: '1.99.0' };
            writeFileSync(WORK_LOCK, JSON.stringify(lock, null, 2), 'utf8');
            const written = JSON.parse(readFileSync(WORK_LOCK, 'utf8'));
            if (written.packages[nestedKey]?.version !== '1.99.0') {
                throw new Error('注入未生效（副本裡找不到注入的巢狀條目）');
            }
            return 'tslib 根 vs 巢狀 1.99.0';
        },
        expectBlocked: false,
    },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
    try {
        const detail = c.inject();
        const r = runCheck();
        const blocked = r.code !== 0;
        if (blocked !== c.expectBlocked) {
            fail++;
            console.log(`  ❌ ${c.name}`);
            console.log(`       ${detail} → exit=${r.code}`
                + (c.expectBlocked ? '（沒擋下來！）' : '（不該擋卻擋了——檢查太粗暴，會變成雜訊）'));
        } else if (c.expectBlocked && !c.expect.test(r.out)) {
            fail++;
            console.log(`  ❌ ${c.name}  → 擋了但訊息沒指出是哪個套件`);
            console.log('       實際輸出片段：' + r.out.replace(/\s+/g, ' ').slice(0, 200));
        } else {
            pass++;
            console.log(`  ✅ ${c.name}`);
        }
    } catch (e) {
        fail++;
        console.log(`  ❌ ${c.name}  → 注入失敗：${e.message}`);
    }
}

// 還原：把未經修改的 lock 放回副本，確認檢查器回綠。
writeFileSync(WORK_LOCK, original, 'utf8');
const after = runCheck().code === 0;

console.log(`\n故障注入：${pass} 符合預期 / ${fail} 不符（共 ${cases.length} 項）`);
console.log(after ? '還原後仍為綠燈 ✅' : '⚠ 還原後仍是紅的，副本沒復原乾淨');

rmSync(WORK, { recursive: true, force: true });
process.exit(fail === 0 && after ? 0 : 1);
