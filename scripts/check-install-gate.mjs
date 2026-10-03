#!/usr/bin/env node
/**
 * 安裝期腳本閘門的有效性檢查（不連網、純讀 lock 與 package.json）
 * ================================================================
 * .npmrc 的 strict-allow-scripts 讓 npm 擋下未核准的安裝腳本，核准清單放在
 * package.json 的 allowScripts。這整套會**靜默失效**，而且有三種失效方式：
 *
 *   1. npm 太舊。實測：11.15.0 把 strict-allow-scripts 當成未知設定，只印一行
 *      警告，缺核准的 esbuild 照裝、exit 0；11.16.0 才回 ESTRICTALLOWSCRIPTS。
 *      下限是量出來的，不是從變更紀錄推的。
 *   2. 被蓋掉。環境變數或使用者層 .npmrc 都能把它改成 false，專案檔原封不動。
 *   3. 清單過期。新相依帶進 postinstall 時，在不強制的 npm 上沒有人會發現。
 *
 * 所以這裡不看設定檔寫了什麼，看三件事：npm 版本夠不夠、npm 自己回報的設定值
 * 對不對、lock 裡每個 hasInstallScript 的套件是否都被核准過。第三項與 npm 版本
 * 無關，是舊 npm 上唯一還有效的防線。
 */
import { readFileSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = process.env.INSTALL_GATE_LOCK || path.join(ROOT, 'package-lock.json');
const MANIFEST_PATH = process.env.INSTALL_GATE_MANIFEST || path.join(ROOT, 'package.json');

const MIN_NPM = '11.16.0'; // 實測下限：11.15.0 不擋，11.16.0 擋
const MIN_AGE = 7; // 與 .npmrc 及 dependabot.yml 的 cooldown 一致

/** 讀不到、讀不懂就擋下來並說人話——「沒東西可檢查」不等於「檢查通過」。 */
function die(lines) {
    console.error('安裝期腳本閘門檢查無法進行 ❌\n');
    for (const line of lines) console.error(`  ${line}`);
    process.exit(1);
}

function readJson(file, label) {
    let raw;
    try {
        raw = readFileSync(file, 'utf8');
    } catch (err) {
        die([
            `讀不到 ${label}：${file}`,
            `原因：${err.code || err.message}`,
            '這支檢查完全依賴這個檔案，讀不到就等於什麼都沒檢查。',
        ]);
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        die([`${label} 不是合法的 JSON：${err.message}`, '檔案可能損毀或被別的工具覆寫過。']);
    }
}

/**
 * 跑 npm 並取回 stdout。
 * 優先用 npm_execpath（npm 執行 script 時放進來的 CLI 路徑）直接餵給 node：
 * 既避開 Windows 上 execFileSync 拒絕執行 .cmd 的限制（CVE-2024-27980 的修補），
 * 也不必開 shell——shell 搭配 args 陣列會觸發 Node 的 DEP0190。
 */
function npm(args, cwd = ROOT) {
    const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd };
    const cli = process.env.npm_execpath;
    if (cli && cli.endsWith('.js')) return execFileSync(process.execPath, [cli, ...args], opts);
    if (process.platform === 'win32') return execSync(['npm', ...args].join(' '), opts);
    return execFileSync('npm', args, opts);
}

/**
 * 這個 npm 認不認得這些設定——能力探測，不是版本比對。
 * 版本下限擋不住「未來某版把設定改名或移除」：那時版本比對照樣過，功能卻沒了。
 * 從沒有專案 .npmrc 的目錄、並把 user／global 設定指到不存在的檔案，問 npm 的
 * 內建預設；不認得的鍵根本不會出現在輸出裡（實測 11.15.0 沒有
 * strict-allow-scripts、11.19.0 有，預設 false）。
 * 回傳「不認得的鍵」清單，探測失敗回 null。
 */
function npmUnknownKeys(keys) {
    if (process.env.INSTALL_GATE_KNOWN !== undefined) {
        const known = new Set(process.env.INSTALL_GATE_KNOWN.split(',').map((k) => k.trim()).filter(Boolean));
        return keys.filter((k) => !known.has(k));
    }
    // 兩個路徑必須相異：npm 會以「double-loading config」拒絕同一個檔案被當成
    // user 又當成 global（實測 11.6.2 會因此整個 exit）。
    const absent = (which) => path.join(tmpdir(), `sch001-npmrc-absent-${which}`);
    try {
        const json = JSON.parse(npm(
            ['config', 'ls', '-l', '--json', '--userconfig', absent('user'), '--globalconfig', absent('global')],
            tmpdir(),
        ));
        return keys.filter((k) => !Object.hasOwn(json, k));
    } catch {
        return null;
    }
}

/** npm 版本：由 npm run 執行時環境變數就有，直接跑才需要 spawn。 */
function npmVersion() {
    if (process.env.INSTALL_GATE_NPM) return process.env.INSTALL_GATE_NPM;
    const m = /^npm\/(\S+)/.exec(process.env.npm_config_user_agent || '');
    if (m) return m[1];
    try {
        return npm(['--version']).trim();
    } catch {
        return null;
    }
}

/**
 * 問 npm 本人實際生效的值，而不是讀 .npmrc。
 * npm 11.19 不會把 min-release-age 注入 npm_config_*（11.6.2 反而會，因為它當成
 * 未知設定原樣傳遞），所以環境變數不可靠，一定要 spawn。
 */
function npmConfig() {
    const parse = (text) => Object.fromEntries(
        String(text).split(/[\r\n,]+/).map((l) => l.trim()).filter(Boolean)
            .map((l) => {
                const i = l.indexOf('=');
                return [l.slice(0, i), l.slice(i + 1)];
            }),
    );
    if (process.env.INSTALL_GATE_CONFIG !== undefined) return parse(process.env.INSTALL_GATE_CONFIG);
    try {
        return parse(npm(['config', 'get', 'strict-allow-scripts', 'min-release-age']));
    } catch {
        return null;
    }
}

const cmp = (a, b) => {
    const n = (v) => String(v).split('-')[0].split('.').map(Number);
    const [x, y] = [n(a), n(b)];
    for (let i = 0; i < 3; i += 1) {
        if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
    }
    return 0;
};

/** allowScripts 的 key 可能是 name 或 name@version；scoped 名稱的前導 @ 不算分隔。 */
function splitKey(key) {
    const at = key.lastIndexOf('@');
    return at > 0 ? { name: key.slice(0, at), pin: key.slice(at + 1) } : { name: key, pin: null };
}

const lock = readJson(LOCK_PATH, 'package-lock.json');
const manifest = readJson(MANIFEST_PATH, 'package.json');

const packages = lock && typeof lock === 'object' ? lock.packages : undefined;
if (!packages || typeof packages !== 'object' || Object.keys(packages).length === 0) {
    die([
        `lock 沒有可用的 packages 對照表（lockfileVersion = ${lock?.lockfileVersion ?? '未標示'}）`,
        'hasInstallScript 只存在於 lockfileVersion 2／3。在舊格式上這支檢查會「一個',
        '安裝腳本都找不到」而印綠字，那正是最危險的假象，所以改成擋下來。',
        '修法：用 npm 7 以上重新產生 lock。',
    ]);
}

// lock 裡所有會在安裝期執行程式的套件。用 lock 而不是走訪 node_modules，是為了
// 涵蓋其他平台才會安裝的套件——fsevents 只裝在 macOS，但 npm 11.17 會把它算進
// 核准範圍而 11.19 不會，漏列就會在不同 npm 版本下行為不一致。
const scripted = [];
for (const [p, e] of Object.entries(packages)) {
    if (!e || e.hasInstallScript !== true) continue;
    const i = p.lastIndexOf('node_modules/');
    scripted.push({
        name: e.name || (i >= 0 ? p.slice(i + 'node_modules/'.length) : p),
        version: e.version,
        note: [e.optional ? 'optional' : null, (e.os || []).join('/') || null].filter(Boolean).join(', '),
    });
}
if (scripted.length === 0) {
    die([
        'lock 裡找不到任何 hasInstallScript 的套件。',
        '這棵樹至少有 esbuild 會在安裝期執行程式，所以 0 筆代表這支檢查其實什麼都沒看到',
        '（lock 格式變了、或 hasInstallScript 旗標消失了），而不是代表很安全。',
        '若確實把所有含安裝腳本的相依都移除了，請一併更新這支檢查。',
    ]);
}

const allow = manifest.allowScripts;
if (!allow || typeof allow !== 'object' || Array.isArray(allow)) {
    die([
        'package.json 沒有 allowScripts 物件。',
        '沒有核准清單時 strict-allow-scripts 會擋下所有安裝腳本，npm ci 直接失敗；',
        '而在不支援的舊 npm 上則是全部放行。兩種都不該靜默發生。',
        '修法：npm install-scripts approve <套件>（需 npm 11.19+），或手動補回 allowScripts。',
    ]);
}

const problems = [];

// ── 1. 覆蓋率：每個會跑安裝腳本的套件都要被核准或拒絕過 ──
const rows = [];
for (const s of scripted) {
    const pinned = `${s.name}@${s.version}`;
    const key = Object.hasOwn(allow, pinned) ? pinned : (Object.hasOwn(allow, s.name) ? s.name : null);
    if (!key) {
        const stale = Object.keys(allow).find((k) => splitKey(k).name === s.name);
        problems.push(stale
            ? `${s.name} 的核准釘在 ${splitKey(stale).pin}，但 lock 裡是 ${s.version}——`
              + `釘版本的核准不會自動跟著升版。修法：npm install-scripts approve ${s.name}`
            : `${s.name}@${s.version} 會在安裝期執行程式，但沒有人核准或拒絕過它。`
              + `修法：npm install-scripts approve ${s.name}（需要它）或 deny ${s.name}（不需要）`);
        continue;
    }
    if (typeof allow[key] !== 'boolean') {
        problems.push(`allowScripts["${key}"] 是 ${JSON.stringify(allow[key])}，必須是 true 或 false。`);
        continue;
    }
    rows.push({ ...s, decision: allow[key] ? '核准' : '拒絕', pinned: splitKey(key).pin !== null });
}

// ── 2. 孤兒：核准清單裡已經沒有對應套件的條目 ──
// 留著不會立刻出事，但規則活得比前提久正是這個 repo 反覆踩到的坑（見 dependabot.yml）。
const names = new Set(scripted.map((s) => s.name));
for (const k of Object.keys(allow)) {
    if (!names.has(splitKey(k).name)) {
        problems.push(`allowScripts["${k}"] 已經沒有對應的套件，請移除——過期的核准會讓清單失去意義。`);
    }
}

// ── 3. 根專案自己的安裝期 script ──
// allowScripts 只管相依，管不到本專案。實測：strict-allow-scripts=true 之下，
// 在根 package.json 加一行 postinstall，npm ci 照樣執行它、exit 0、閘門一聲不吭。
// 也就是一個惡意 PR 加一行就能在 CI 與每台開發機上執行程式，完全繞過這道閘門。
const ROOT_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare'];
const hooks = ROOT_HOOKS.filter((h) => manifest.scripts && manifest.scripts[h]);
if (hooks.length) {
    problems.push(`根 package.json 有安裝期 script：${hooks.join('、')}。`
        + '這些會在 npm ci 時直接執行，而 allowScripts 管不到本專案自己。'
        + '確實需要的話，請連同理由一起在這支檢查裡明示放行，不要讓它悄悄通過。');
}

// ── 4. npm 版本、能力、與實際生效的設定 ──
const ver = npmVersion();
if (!ver) {
    problems.push('問不到 npm 版本，無法判斷 strict-allow-scripts 會不會被強制執行。');
} else if (cmp(ver, MIN_NPM) < 0) {
    problems.push(`npm ${ver} 不支援 strict-allow-scripts（下限 ${MIN_NPM}，實測 11.15.0 只警告不擋）。`
        + '在這個版本上整道閘門是靜默無效的。修法：npm i -g npm@latest');
}

const unknown = npmUnknownKeys(['strict-allow-scripts', 'min-release-age']);
if (unknown === null) {
    problems.push('探測不到這個 npm 支援哪些設定（npm config ls 失敗），無法確認閘門是否真的生效。');
} else if (unknown.length) {
    problems.push(`這個 npm 不認得 ${unknown.join('、')}——未知設定會被原樣忽略，`
        + '閘門只是裝飾。版本比對擋不住這種情況（設定被改名或移除時版本照樣夠新），所以這裡直接探測能力。');
}

const cfg = npmConfig();
if (!cfg) {
    problems.push('問不到 npm 實際生效的設定值（npm config get 失敗）。');
} else {
    if (cfg['strict-allow-scripts'] !== 'true') {
        problems.push(`npm 實際生效的 strict-allow-scripts 是 ${JSON.stringify(cfg['strict-allow-scripts'])}，`
            + '不是 true。.npmrc 可能被環境變數或使用者層設定蓋掉了。');
    }
    const age = Number(cfg['min-release-age']);
    if (!Number.isFinite(age) || age < MIN_AGE) {
        problems.push(`npm 實際生效的 min-release-age 是 ${JSON.stringify(cfg['min-release-age'])}，`
            + `應為至少 ${MIN_AGE}（與 dependabot.yml 的 cooldown 一致）。`);
    }
}

if (problems.length === 0) {
    console.log('安裝期腳本閘門有效 ✅');
    console.log(`  npm ${ver}（下限 ${MIN_NPM}）  strict-allow-scripts=${cfg['strict-allow-scripts']}`
        + `  min-release-age=${cfg['min-release-age']}`);
    for (const r of rows) {
        console.log(`  ${r.name.padEnd(20)} ${String(r.version).padEnd(10)} ${r.decision}`
            + `${r.pinned ? '（釘版本）' : ''}${r.note ? `  [${r.note}]` : ''}`);
    }
    process.exitCode = 0;
} else {
    console.error('安裝期腳本閘門失效 ❌\n');
    for (const p of problems) console.error(`  ${p}`);
    console.error('\n  這道閘門擋的是「相依被奪權後用 postinstall 執行程式」。它失效時不會有任何徵兆，');
    console.error('  npm ci 照樣 exit 0——所以必須在這裡擋下來。');
    process.exitCode = 1;
}
