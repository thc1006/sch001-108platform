#!/usr/bin/env node
/**
 * 相依樹一致性檢查的故障注入矩陣
 * --------------------------------------------------------------
 * check-dep-tree.mjs 擋的是「靜默分裂」——建置會成功、沒有警告，只有產出變了。
 * 這種把關本身也是靜默的：在正常狀態下，它印幾行綠字，跟「根本沒在檢查」
 * 長得一模一樣。所以必須有常駐測試證明它真的會擋。
 *
 * 這個矩陣涵蓋三類故障，缺一不可：
 *   A. 該擋的分裂有沒有擋（tailwindcss／astro／@tailwindcss/node／oxide）
 *   B. 不該擋的良性重複有沒有放行（否則這支檢查會在第一次無關更新時被當雜訊關掉）
 *   C. 「讀不到東西」時會不會誤印綠字——這一類才是最危險的。空的 packages、
 *      lockfileVersion 1、lock 檔不見了，全都會讓檢查變成全盲；全盲必須是紅的。
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

/** 寫檔並讀回來確認內容真的落地——本 repo 過去多次踩到注入靜默無效的坑。 */
function writeLock(lock) {
    writeFileSync(WORK_LOCK, JSON.stringify(lock, null, 2), 'utf8');
    return JSON.parse(readFileSync(WORK_LOCK, 'utf8'));
}

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
    const written = writeLock(lock);

    if (written.packages[nestedKey]?.version !== fakeVersion) {
        throw new Error('注入未生效（副本裡找不到注入的巢狀條目）');
    }
    if (written.packages[rootKey].version === fakeVersion) {
        throw new Error('注入無意義（根與巢狀版本相同，本來就不該被擋）');
    }
    return `${name} 根 ${written.packages[rootKey].version} vs 巢狀 ${fakeVersion}`;
}

const cases = [
    // ── A. 該擋的分裂 ────────────────────────────────────────────
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
        name: '@tailwindcss/node 分裂（載入 tailwindcss 編譯器的就是它）',
        inject: () => injectSplit('@tailwindcss/node', '@tailwindcss/vite', '4.2.9'),
        expectBlocked: true,
        expect: /@tailwindcss\/node/,
    },
    {
        name: '@tailwindcss/oxide 分裂（引擎與 tailwindcss 錯開）',
        inject: () => injectSplit('@tailwindcss/oxide', '@tailwindcss/node', '4.2.9'),
        expectBlocked: true,
        expect: /oxide/,
    },
    {
        // npm 別名（"tw": "npm:tailwindcss@4.2.0"）的 key 是 node_modules/tw，
        // 只看路徑會完全看不到它。這一格釘住「也要比對 entry.name」這件事。
        name: 'npm 別名藏起來的分裂（node_modules/<別名> + entry.name）',
        inject: () => {
            const lock = JSON.parse(original);
            const rootKey = 'node_modules/tailwindcss';
            if (!lock.packages[rootKey]) throw new Error('tailwindcss 不在 lock 的根層，無法注入');
            lock.packages['node_modules/tw-alias'] = {
                name: 'tailwindcss',
                version: '4.2.0',
                resolved: 'https://registry.npmjs.org/tailwindcss/-/tailwindcss-4.2.0.tgz',
            };
            const written = writeLock(lock);
            if (written.packages['node_modules/tw-alias']?.name !== 'tailwindcss') {
                throw new Error('注入未生效（副本裡找不到別名條目）');
            }
            if (written.packages[rootKey].version === '4.2.0') {
                throw new Error('注入無意義（根與別名版本相同）');
            }
            return `別名 tw-alias → tailwindcss 4.2.0 vs 根 ${written.packages[rootKey].version}`;
        },
        expectBlocked: true,
        expect: /tw-alias/,
    },
    {
        // link:true 的條目沒有 version 欄位。舊版在列印時對 undefined 呼叫 padEnd，
        // 丟出 TypeError——擋是擋下來了，但畫面是一坨堆疊而不是原因。
        name: 'link:true 條目（沒有 version 欄位）——要擋，而且不准丟堆疊',
        inject: () => {
            const lock = JSON.parse(original);
            lock.packages['node_modules/tailwindcss'] = { resolved: 'vendored/tailwindcss', link: true };
            lock.packages['node_modules/@tailwindcss/vite/node_modules/tailwindcss'] = { version: '4.3.3' };
            const written = writeLock(lock);
            if (written.packages['node_modules/tailwindcss'].link !== true) {
                throw new Error('注入未生效（副本裡的根條目不是 link:true）');
            }
            return '根為 link:true（無 version）vs 巢狀 4.3.3';
        },
        expectBlocked: true,
        expect: /tailwindcss/,
        forbid: /TypeError|at ModuleJob|node:internal/,
    },

    // ── B. 不該擋的良性重複 ──────────────────────────────────────
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
            const written = writeLock(lock);
            if (written.packages[nestedKey]?.version !== '1.99.0') {
                throw new Error('注入未生效（副本裡找不到注入的巢狀條目）');
            }
            if (written.packages[rootKey].version === '1.99.0') {
                throw new Error('注入無意義（根與巢狀版本相同，本來就不會被視為重複）');
            }
            return `tslib 根 ${written.packages[rootKey].version} vs 巢狀 1.99.0`;
        },
        expectBlocked: false,
    },
    {
        // 名字結尾像但不是同一個套件，不可以誤判——否則這支檢查會製造假紅燈。
        name: '名稱相似但無關的套件（my-tailwindcss）——必須**不**被擋',
        inject: () => {
            const lock = JSON.parse(original);
            lock.packages['node_modules/my-tailwindcss'] = { version: '9.9.9' };
            lock.packages['node_modules/foo/node_modules/x-tailwindcss'] = { version: '8.8.8' };
            const written = writeLock(lock);
            if (!written.packages['node_modules/my-tailwindcss']) {
                throw new Error('注入未生效（副本裡找不到相似名稱條目）');
            }
            return 'my-tailwindcss 9.9.9 / x-tailwindcss 8.8.8';
        },
        expectBlocked: false,
    },

    // ── C. 全盲時必須紅，不准印綠字 ──────────────────────────────
    {
        name: 'packages 是空的——檢查其實什麼都沒看，必須擋',
        inject: () => {
            const lock = JSON.parse(original);
            lock.packages = {};
            const written = writeLock(lock);
            if (Object.keys(written.packages).length !== 0) throw new Error('注入未生效（packages 不是空的）');
            return 'packages = {}';
        },
        expectBlocked: true,
        expect: /packages/,
    },
    {
        name: 'lockfileVersion 1（只有 dependencies、沒有 packages）——必須擋',
        inject: () => {
            const lock = JSON.parse(original);
            delete lock.packages;
            lock.lockfileVersion = 1;
            lock.dependencies = {
                tailwindcss: { version: '4.3.4' },
                '@tailwindcss/vite': { version: '4.3.3', dependencies: { tailwindcss: { version: '4.3.3' } } },
            };
            const written = writeLock(lock);
            if (written.packages !== undefined) throw new Error('注入未生效（packages 還在）');
            return 'lockfileVersion 1，內含真正的 tailwindcss 分裂';
        },
        expectBlocked: true,
        expect: /lockfileVersion/,
    },
    {
        name: 'lock 檔根本不存在——必須擋，而且要說人話不是丟堆疊',
        inject: () => {
            rmSync(WORK_LOCK, { force: true });
            if (existsSync(WORK_LOCK)) throw new Error('注入未生效（副本 lock 還在）');
            return '副本 lock 已刪除';
        },
        expectBlocked: true,
        expect: /讀不到 lock 檔/,
        forbid: /ENOENT: no such file|at ModuleJob|node:internal/,
    },
    {
        name: 'lock 檔內容不是合法 JSON——必須擋，而且要說人話',
        inject: () => {
            writeFileSync(WORK_LOCK, '{ this is not json', 'utf8');
            return '副本 lock 已寫入壞掉的 JSON';
        },
        expectBlocked: true,
        expect: /不是合法的 JSON/,
        forbid: /at ModuleJob|node:internal/,
    },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
    try {
        const detail = c.inject();
        const r = runCheck();
        const blocked = r.code !== 0;
        const flat = r.out.replace(/\s+/g, ' ');
        if (blocked !== c.expectBlocked) {
            fail++;
            console.log(`  ❌ ${c.name}`);
            console.log(`       ${detail} → exit=${r.code}`
                + (c.expectBlocked ? '（沒擋下來！）' : '（不該擋卻擋了——檢查太粗暴，會變成雜訊）'));
        } else if (c.expectBlocked && c.expect && !c.expect.test(r.out)) {
            fail++;
            console.log(`  ❌ ${c.name}  → 擋了但訊息沒指出原因`);
            console.log('       實際輸出片段：' + flat.slice(0, 200));
        } else if (c.forbid && c.forbid.test(r.out)) {
            fail++;
            console.log(`  ❌ ${c.name}  → 訊息裡出現了不該出現的原始堆疊`);
            console.log('       實際輸出片段：' + flat.slice(0, 200));
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
