#!/usr/bin/env node
/**
 * 安裝期腳本閘門檢查的故障注入矩陣
 * --------------------------------------------------------------
 * check-install-gate.mjs 擋的是「閘門自己悄悄失效」。這種把關在正常狀態下
 * 只印幾行綠字，跟根本沒在檢查長得一模一樣，所以要有常駐測試證明它會擋。
 *
 * 三類故障缺一不可：
 *   A. 該擋的有沒有擋（未核准、釘版本過期、孤兒條目、npm 太舊、設定被蓋掉）
 *   B. 不該擋的有沒有放行（否則第一次無關更新就會被當雜訊關掉）
 *   C. 「讀不到東西」時會不會誤印綠字——這一類才是最危險的
 *
 * 一律在副本上注入，版控裡的 package-lock.json 與 package.json 不會被更動。
 *
 * 執行：  npm run test:install-gate-faults
 */
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const SOURCE_LOCK = path.join(ROOT, 'package-lock.json');
const SOURCE_MANIFEST = path.join(ROOT, 'package.json');
const WORK = path.join(ROOT, '.installgate-faultcheck');
const WORK_LOCK = path.join(WORK, 'package-lock.json');
const WORK_MANIFEST = path.join(WORK, 'package.json');

for (const f of [SOURCE_LOCK, SOURCE_MANIFEST]) {
    if (!existsSync(f)) {
        console.error(`找不到 ${f}`);
        process.exit(1);
    }
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
console.log(`故障注入在副本 ${path.relative(ROOT, WORK)}/ 上進行，版控裡的檔案不會被更動。\n`);

const originalLock = readFileSync(SOURCE_LOCK, 'utf8');
const originalManifest = readFileSync(SOURCE_MANIFEST, 'utf8');

// npm 版本、能力與實際設定都要能注入，否則這個矩陣只在某一台機器上成立——
// 實測：少了 INSTALL_GATE_KNOWN，在 npm 11.6.2 上每一格都會被能力探測擋下，
// 連「不該擋」的反例也會翻紅，整個矩陣失去鑑別力。
const GOOD_NPM = '11.19.0';
const GOOD_CONFIG = 'strict-allow-scripts=true,min-release-age=7';
const GOOD_KNOWN = 'strict-allow-scripts,min-release-age';

function runCheck({ npmVersion = GOOD_NPM, config = GOOD_CONFIG, known = GOOD_KNOWN } = {}) {
    const env = {
        ...process.env,
        INSTALL_GATE_LOCK: WORK_LOCK,
        INSTALL_GATE_MANIFEST: WORK_MANIFEST,
        INSTALL_GATE_NPM: npmVersion,
        INSTALL_GATE_CONFIG: config,
        INSTALL_GATE_KNOWN: known,
    };
    try {
        return { code: 0, out: String(execFileSync(process.execPath,
            ['scripts/check-install-gate.mjs'], { stdio: 'pipe', cwd: ROOT, env })) };
    } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
}

/** 寫檔後讀回來確認落地——本 repo 多次踩到注入靜默無效的坑。 */
function write(file, obj) {
    writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
    return JSON.parse(readFileSync(file, 'utf8'));
}

/** 每一格都從乾淨副本開始，避免前一格的注入殘留。 */
function reset() {
    writeFileSync(WORK_LOCK, originalLock, 'utf8');
    writeFileSync(WORK_MANIFEST, originalManifest, 'utf8');
}

const lockOf = () => JSON.parse(readFileSync(WORK_LOCK, 'utf8'));
const manifestOf = () => JSON.parse(readFileSync(WORK_MANIFEST, 'utf8'));

/** 在 lock 裡塞一個會跑安裝腳本的套件。 */
function addScripted(name, version, extra = {}) {
    const lock = lockOf();
    lock.packages[`node_modules/${name}`] = { version, hasInstallScript: true, ...extra };
    const written = write(WORK_LOCK, lock);
    if (written.packages[`node_modules/${name}`]?.hasInstallScript !== true) {
        throw new Error('注入未生效（副本裡找不到注入的套件）');
    }
    return `lock 新增 ${name}@${version}（hasInstallScript）`;
}

function setAllow(value) {
    const m = manifestOf();
    if (value === undefined) delete m.allowScripts; else m.allowScripts = value;
    const written = write(WORK_MANIFEST, m);
    if (JSON.stringify(written.allowScripts) !== JSON.stringify(value)) {
        throw new Error('注入未生效（allowScripts 沒落地）');
    }
    return `allowScripts = ${JSON.stringify(value)}`;
}

const cases = [
    // ── A. 該擋的 ──────────────────────────────────────────────
    {
        name: '新相依帶進 postinstall 卻沒人核准——必須擋',
        inject: () => addScripted('evil-postinstall', '1.0.0'),
        blocked: true,
        expect: /evil-postinstall/,
    },
    {
        name: '核准釘在舊版、lock 已升版——必須擋，且要說是釘版本的問題',
        inject: () => setAllow({ 'esbuild@0.28.1': true, 'core-js': false, fsevents: false }),
        blocked: true,
        expect: /釘在 0\.28\.1/,
    },
    {
        name: 'allowScripts 整個不見——必須擋',
        inject: () => setAllow(undefined),
        blocked: true,
        expect: /allowScripts/,
    },
    {
        name: 'allowScripts 的值是字串 "true" 而非布林——必須擋',
        inject: () => setAllow({ 'esbuild@0.28.2': 'true', 'core-js': false, fsevents: false }),
        blocked: true,
        expect: /必須是 true 或 false/,
    },
    {
        name: '孤兒核准（套件早就不在樹裡）——必須擋，否則清單會慢慢爛掉',
        inject: () => setAllow({ 'esbuild@0.28.2': true, 'core-js': false, fsevents: false, 'left-pad': true }),
        blocked: true,
        expect: /left-pad/,
    },
    {
        name: 'npm 11.15.0（設定會被當成未知而靜默忽略）——必須擋',
        inject: () => 'npm 降到 11.15.0',
        run: { npmVersion: '11.15.0' },
        blocked: true,
        expect: /11\.16\.0/,
    },
    {
        name: 'strict-allow-scripts 被環境變數蓋成 false——必須擋',
        inject: () => '設定覆寫為 false',
        run: { config: 'strict-allow-scripts=false,min-release-age=7' },
        blocked: true,
        expect: /strict-allow-scripts/,
    },
    {
        name: 'min-release-age 被調低到 3——必須擋（與 cooldown 不一致）',
        inject: () => 'min-release-age=3',
        run: { config: 'strict-allow-scripts=true,min-release-age=3' },
        blocked: true,
        expect: /min-release-age/,
    },
    {
        name: 'min-release-age 根本沒設——必須擋',
        inject: () => 'min-release-age 留空',
        run: { config: 'strict-allow-scripts=true,min-release-age=' },
        blocked: true,
        expect: /min-release-age/,
    },
    {
        // 版本夠新但設定被改名／移除：版本比對會放行，只有能力探測擋得住。
        name: 'npm 版本夠新但不認得 strict-allow-scripts——必須擋',
        inject: () => '能力探測回報不認得',
        run: { known: 'min-release-age' },
        blocked: true,
        expect: /不認得/,
    },
    {
        name: '根 package.json 自己有 postinstall——必須擋（allowScripts 管不到本專案）',
        inject: () => {
            const m = manifestOf();
            m.scripts = { ...m.scripts, postinstall: 'node -e "0"' };
            const written = write(WORK_MANIFEST, m);
            if (!written.scripts.postinstall) throw new Error('注入未生效');
            return '根 scripts.postinstall 已注入';
        },
        blocked: true,
        expect: /安裝期 script/,
    },
    {
        name: '根 package.json 有 prepare——必須擋（npm ci 一樣會跑）',
        inject: () => {
            const m = manifestOf();
            m.scripts = { ...m.scripts, prepare: 'husky' };
            write(WORK_MANIFEST, m);
            return '根 scripts.prepare 已注入';
        },
        blocked: true,
        expect: /prepare/,
    },

    // ── B. 不該擋的（反例：證明這不是粗暴檢查）────────────────────
    {
        name: '核准不釘版本（esbuild: true）——必須**不**擋',
        inject: () => setAllow({ esbuild: true, 'core-js': false, fsevents: false }),
        blocked: false,
    },
    {
        name: '拒絕（false）也算覆核過——必須**不**擋',
        inject: () => setAllow({ 'esbuild@0.28.2': false, 'core-js': false, fsevents: false }),
        blocked: false,
    },
    {
        name: 'npm 剛好等於下限 11.16.0——必須**不**擋',
        inject: () => 'npm = 11.16.0',
        run: { npmVersion: '11.16.0' },
        blocked: false,
    },
    {
        name: 'min-release-age 比要求更嚴（14）——必須**不**擋',
        inject: () => 'min-release-age=14',
        run: { config: 'strict-allow-scripts=true,min-release-age=14' },
        blocked: false,
    },
    {
        // scoped 名稱的前導 @ 不是版本分隔符。切錯的話 @scope/pkg 會被拆成
        // name="" + pin="scope/pkg"，然後被誤判成未核准。
        name: 'scoped 套件的釘版本核准（@scope/pkg@1.0.0）——必須**不**擋',
        inject: () => {
            const d = addScripted('@scope/pkg', '1.0.0');
            setAllow({ 'esbuild@0.28.2': true, 'core-js': false, fsevents: false, '@scope/pkg@1.0.0': true });
            return d;
        },
        blocked: false,
    },

    // ── C. 全盲時必須紅 ────────────────────────────────────────
    {
        name: 'lock 裡一個 hasInstallScript 都沒有——是全盲不是安全，必須擋',
        inject: () => {
            const lock = lockOf();
            let n = 0;
            for (const e of Object.values(lock.packages)) {
                if (e && e.hasInstallScript) { delete e.hasInstallScript; n += 1; }
            }
            const written = write(WORK_LOCK, lock);
            if (Object.values(written.packages).some((e) => e && e.hasInstallScript)) {
                throw new Error('注入未生效（還有 hasInstallScript 殘留）');
            }
            return `移除了 ${n} 個 hasInstallScript 旗標`;
        },
        blocked: true,
        expect: /找不到任何 hasInstallScript/,
    },
    {
        name: 'packages 是空的——必須擋',
        inject: () => {
            const lock = lockOf();
            lock.packages = {};
            const written = write(WORK_LOCK, lock);
            if (Object.keys(written.packages).length !== 0) throw new Error('注入未生效');
            return 'packages = {}';
        },
        blocked: true,
        expect: /packages/,
    },
    {
        name: 'lock 檔不存在——必須擋，而且要說人話不是丟堆疊',
        inject: () => {
            rmSync(WORK_LOCK, { force: true });
            if (existsSync(WORK_LOCK)) throw new Error('注入未生效');
            return '副本 lock 已刪除';
        },
        blocked: true,
        expect: /讀不到 package-lock\.json/,
        forbid: /ENOENT: no such file|at ModuleJob|node:internal/,
    },
    {
        name: 'lock 不是合法 JSON——必須擋，而且要說人話',
        inject: () => {
            writeFileSync(WORK_LOCK, '{ not json', 'utf8');
            return '副本 lock 寫入壞掉的 JSON';
        },
        blocked: true,
        expect: /不是合法的 JSON/,
        forbid: /at ModuleJob|node:internal/,
    },
    {
        name: 'package.json 不是合法 JSON——必須擋，而且要說人話',
        inject: () => {
            writeFileSync(WORK_MANIFEST, '{ not json', 'utf8');
            return '副本 package.json 寫入壞掉的 JSON';
        },
        blocked: true,
        expect: /不是合法的 JSON/,
        forbid: /at ModuleJob|node:internal/,
    },
];

let pass = 0;
let fail = 0;
for (const c of cases) {
    reset();
    try {
        const detail = c.inject();
        const r = runCheck(c.run);
        const blocked = r.code !== 0;
        const flat = r.out.replace(/\s+/g, ' ');
        if (blocked !== c.blocked) {
            fail += 1;
            console.log(`  ❌ ${c.name}`);
            console.log(`       ${detail} → exit=${r.code}`
                + (c.blocked ? '（沒擋下來！）' : '（不該擋卻擋了——檢查太粗暴，會變成雜訊）'));
            console.log(`       輸出片段：${flat.slice(0, 180)}`);
        } else if (c.blocked && c.expect && !c.expect.test(r.out)) {
            fail += 1;
            console.log(`  ❌ ${c.name}  → 擋了但訊息沒指出原因`);
            console.log(`       輸出片段：${flat.slice(0, 180)}`);
        } else if (c.forbid && c.forbid.test(r.out)) {
            fail += 1;
            console.log(`  ❌ ${c.name}  → 訊息裡出現了不該出現的原始堆疊`);
            console.log(`       輸出片段：${flat.slice(0, 180)}`);
        } else {
            pass += 1;
            console.log(`  ✅ ${c.name}`);
        }
    } catch (e) {
        fail += 1;
        console.log(`  ❌ ${c.name}  → 注入失敗：${e.message}`);
    }
}

// 還原：未經修改的副本必須回綠，否則上面的紅燈可能只是副本沒復原乾淨。
reset();
const after = runCheck().code === 0;

console.log(`\n故障注入：${pass} 符合預期 / ${fail} 不符（共 ${cases.length} 項）`);
console.log(after ? '還原後仍為綠燈 ✅' : '⚠ 還原後仍是紅的，副本沒復原乾淨');

rmSync(WORK, { recursive: true, force: true });
process.exit(fail === 0 && after ? 0 : 1);
