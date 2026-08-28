#!/usr/bin/env node
/**
 * SSRF 防護與例外政策的故障注入矩陣
 * --------------------------------------------------------------
 * 「有寫防護」與「防護擋得住」是兩件事，「測試會過」與「測試在把關」也是兩件事。
 * 這支逐一破壞一個東西，確認該紅的真的會紅：
 *
 *   A. 政策檔的每一條規則 → check-link-policy.mjs 必須以非零碼結束
 *   B. SSRF 防護的每一段   → link-health.test.mjs 必須失敗
 *   C. 裸網域擷取的每一條  → bare-domains.test.mjs 必須失敗
 *
 * C 是為了守住兩個「看起來對、其實已經退化」的方向：擷取規則被放寬之後會把
 * 檔名當網域（噪音），或被收緊之後悄悄漏掉真的網域（失明）。特別是
 * screenBareDomains 一旦改用「解析得到才算網域」，已經停用的網域就會被當成
 * 「不是網域」丟掉——檢查器對它唯一該偵測的目標永久失明，而所有測試照樣全綠。
 *
 * B 那一半是刻意做的突變測試：把防護拿掉之後，如果測試還是綠的，那些測試就是
 * 裝飾品。#72 的起因正是「lychee 看起來有在檢查、實際一個連結都沒驗」——同一
 * 類假象在自己的測試上也會發生。
 *
 * 一律在副本上動手：政策與盤點寫進暫存目錄，程式碼複製到 scripts-faultcheck/。
 * 原始檔案在結構上就不可能被改壞，而不是靠還原邏輯寫得夠好。
 *
 * 執行：  npm run test:link-faults
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const TMP = path.join(ROOT, '.faultcheck');
const SCRIPTS = path.join(ROOT, 'scripts');
const MUTANT_DIR = path.join(ROOT, 'scripts-faultcheck');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const realPolicy = JSON.parse(readFileSync(path.join(SCRIPTS, 'link-policy.json'), 'utf8'));

/** 只含政策目標的最小盤點，讓「殭屍條目」以外的規則不會被誤觸發。 */
const baselineInventory = {
    generatedFrom: 'dist',
    total: 3,
    urls: [
        { url: realPolicy.entries[0].match.url, occurrences: [{ file: 'x.html', location: 'a[href]' }] },
        { url: 'https://www.ptt.cc/bbs/SENIORHIGH/M.1272038439.A.517.html', occurrences: [{ file: 'y.html', location: 'a[href]' }] },
        { url: 'https://example.com/', occurrences: [{ file: 'z.html', location: 'a[href]' }] },
    ],
    // hijacked 的目標只活在說明文字裡，不是 url 欄位。少了這一段，基準狀態的
    // 殭屍檢查會把三筆接管警示全部判成「目標已消失」，整個矩陣還沒開始就是紅的。
    bareDomainCandidates: {
        total: (realPolicy.hijacked ?? []).length,
        alreadyCoveredByUrls: 0,
        hosts: (realPolicy.hijacked ?? []).map((h) => ({ host: h.match.host, occurrences: [{ file: 'data.json', location: '/0/description' }] })),
    },
};

const write = (name, obj) => {
    const p = path.join(TMP, name);
    writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return p;
};

const runPolicyCheck = (policyPath, inventoryPath) => {
    try {
        const out = execFileSync(
            process.execPath,
            [path.join(SCRIPTS, 'check-link-policy.mjs'), '--policy', policyPath, '--inventory', inventoryPath],
            { encoding: 'utf8', stdio: 'pipe' },
        );
        return { code: 0, out };
    } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
};

// 深拷貝一份可以隨意破壞的政策
const clonePolicy = () => JSON.parse(JSON.stringify(realPolicy));
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const policyCases = [
    {
        name: '例外過期 → 必須讓 CI 紅（強迫重新查證）',
        expect: /到期/,
        policy: () => { const p = clonePolicy(); p.entries[0].expires = yesterday; return p; },
    },
    {
        name: '例外設成 2099 年（等同無期限）',
        expect: /無期限/,
        policy: () => { const p = clonePolicy(); p.entries[0].expires = '2099-12-31'; return p; },
    },
    {
        name: '例外沒有 reason',
        expect: /reason/,
        policy: () => { const p = clonePolicy(); delete p.entries[0].reason; return p; },
    },
    {
        name: '例外沒有 owner',
        expect: /owner/,
        policy: () => { const p = clonePolicy(); delete p.entries[0].owner; return p; },
    },
    {
        name: '例外沒有 expires',
        expect: /expires/,
        policy: () => { const p = clonePolicy(); delete p.entries[0].expires; return p; },
    },
    {
        name: '例外使用萬用字元主機名',
        expect: /萬用字元/,
        policy: () => { const p = clonePolicy(); p.entries[1].match = { host: '*.ptt.cc' }; return p; },
    },
    {
        name: '例外把整個母網域放進來（子網域全放行）',
        expect: /找不到對應的網址/,
        policy: () => { const p = clonePolicy(); p.entries[1].match = { host: 'ptt.cc' }; return p; },
    },
    {
        name: '例外指向雲端 metadata',
        expect: /位址政策/,
        policy: () => { const p = clonePolicy(); p.entries[1].match = { host: 'metadata.google.internal' }; return p; },
    },
    {
        name: '例外的目標已經從網站上消失（殭屍條目）',
        expect: /找不到對應的網址/,
        policy: () => { const p = clonePolicy(); p.entries[1].match = { host: 'no-longer-linked.example.org' }; return p; },
    },
    {
        name: '政策檔多了一個沒人認得的開關',
        expect: /skipEverything/,
        policy: () => { const p = clonePolicy(); p.skipEverything = true; return p; },
    },
    // ── hijacked（被接管的網域）：紀律必須與 allowlist 一樣嚴 ──
    {
        name: '接管警示過期 → 必須讓 CI 紅（強迫重新查證是否仍被接管）',
        expect: /到期/,
        policy: () => { const p = clonePolicy(); p.hijacked[0].expires = yesterday; return p; },
    },
    {
        name: '接管警示設成 2099 年（等同無期限）',
        expect: /無期限/,
        policy: () => { const p = clonePolicy(); p.hijacked[0].expires = '2099-12-31'; return p; },
    },
    {
        name: '接管警示沒有 kind（無法分辨「本身被接管」與「接管鏈終點」）',
        expect: /kind/,
        policy: () => { const p = clonePolicy(); delete p.hijacked[0].kind; return p; },
    },
    {
        // 名單裡混進一個沒人認得的 kind，報告就只能亂貼標籤。arcade.now 標成
        // hijacked 會被寫成「這台主機本身已被接管」——它並沒有，它是接管方。
        name: '接管警示的 kind 不是 hijacked／terminus',
        expect: /kind/,
        policy: () => { const p = clonePolicy(); p.hijacked[0].kind = 'suspicious'; return p; },
    },
    {
        name: '接管警示沒有 evidence（到期時無從比對）',
        expect: /evidence/,
        policy: () => { const p = clonePolicy(); delete p.hijacked[0].evidence; return p; },
    },
    {
        name: '接管警示沒有 reason',
        expect: /reason/,
        policy: () => { const p = clonePolicy(); delete p.hijacked[0].reason; return p; },
    },
    {
        name: '接管警示沒有 owner',
        expect: /owner/,
        policy: () => { const p = clonePolicy(); delete p.hijacked[0].owner; return p; },
    },
    {
        name: '接管警示使用萬用字元主機名',
        expect: /萬用字元/,
        policy: () => { const p = clonePolicy(); p.hijacked[0].match = { host: '*.ieso-info.org' }; return p; },
    },
    {
        name: '接管警示改用網址而不是主機名（接管是整台主機的性質）',
        expect: /host/,
        policy: () => { const p = clonePolicy(); p.hijacked[0].match = { url: 'https://ieso-info.org/x' }; return p; },
    },
    {
        name: '接管警示指向雲端 metadata',
        expect: /位址政策/,
        policy: () => { const p = clonePolicy(); p.hijacked[0].match = { host: 'metadata.google.internal' }; return p; },
    },
    {
        name: '同一台主機同時是例外與被接管（自相矛盾）',
        expect: /同時出現在 entries/,
        policy: () => {
            const p = clonePolicy();
            p.entries[1].match = { host: p.hijacked[0].match.host };
            return p;
        },
    },
    {
        name: '接管警示的目標已經從內文消失（殭屍條目）',
        expect: /找不到對應的主機/,
        policy: () => { const p = clonePolicy(); p.hijacked[0].match = { host: 'no-longer-mentioned.example.org' }; return p; },
    },
    {
        name: '盤點少了裸網域這一段，接管警示就變成殭屍（下游必須看得到裸網域）',
        expect: /找不到對應的主機/,
        inventory: () => ({ ...baselineInventory, bareDomainCandidates: { total: 0, alreadyCoveredByUrls: 0, hosts: [] } }),
    },
    {
        name: '盤點裡出現指向雲端 metadata 的網址',
        expect: /169\.254\.0\.0\/16/,
        inventory: () => ({
            ...baselineInventory,
            urls: [...baselineInventory.urls, { url: 'http://169.254.169.254/latest/meta-data/', occurrences: [{ file: 'evil.json', location: '/0/url' }] }],
        }),
    },
    {
        name: '盤點裡出現內嵌帳密的網址',
        expect: /credential/,
        inventory: () => ({
            ...baselineInventory,
            urls: [...baselineInventory.urls, { url: 'https://admin:hunter2@intranet.example.com/', occurrences: [{ file: 'evil.json', location: '/0/url' }] }],
        }),
    },
    {
        name: '盤點裡出現指向本機服務的網址',
        expect: /127\.0\.0\.0\/8|localhost/,
        inventory: () => ({
            ...baselineInventory,
            urls: [...baselineInventory.urls, { url: 'http://localhost:8080/admin', occurrences: [{ file: 'evil.json', location: '/0/url' }] }],
        }),
    },
    {
        name: '盤點來自故障注入用的副本，不是要部署的 dist/',
        expect: /不是實際要部署的 dist/,
        inventory: () => ({ ...baselineInventory, generatedFrom: 'dist-faultcheck' }),
    },
    {
        name: '盤點檔不存在（不可靜靜跳過而變成綠燈）',
        expect: /找不到外部網址盤點/,
        inventoryPath: () => path.join(TMP, 'does-not-exist.json'),
    },
];

// ── B：SSRF 防護的突變測試 ──
// 每一項都是「把防護的一段拿掉」，然後跑 link-health.test.mjs。測試必須失敗。
const guardMutations = [
    {
        name: 'IPv4 封鎖網段清單被清空',
        // 這裡改的是「編譯後的網段表」而不是原始清單：第一版寫成
        // `const BLOCKED_IPV4 = [].concat([]) && [` ——文字確實變了，語意卻沒變
        // （`[] && x` 回傳 x），突變等於沒做，而 mutated !== libSource 這個守衛
        // 看不出來。這一整支腳本存在的理由就是這種「看起來有做、實際沒做」。
        apply: (s) => s.replace('const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map(', 'const BLOCKED_IPV4_RANGES = [].map('),
    },
    {
        name: 'blockedAddressReason 一律回傳「允許」',
        apply: (s) => s.replace('export function blockedAddressReason(ip, opts = {}) {', 'export function blockedAddressReason(ip, opts = {}) {\n    if (true) return null;'),
    },
    {
        name: '轉址只驗第一跳（等同 redirect: follow）',
        apply: (s) =>
            s
                .replace('const statik = staticUrlPolicy(current, opts);', 'const statik = hop === 0 ? staticUrlPolicy(current, opts) : { ok: true, url: new URL(current) };')
                .replace('const resolved = await resolveAndVerify(canonicalHost(url.hostname), opts);', 'const resolved = hop === 0 ? await resolveAndVerify(canonicalHost(url.hostname), opts) : { ok: true, addresses: await (await import("node:dns")).promises.lookup(canonicalHost(url.hostname), { all: true }) };'),
    },
    {
        name: '不再檢查網址內嵌的帳號密碼',
        apply: (s) => s.replace('if (url.username || url.password) {', 'if (false) {'),
    },
    {
        name: 'scheme 檢查被拿掉（file:／ftp: 也放行）',
        apply: (s) => s.replace('if (!ALLOWED_PROTOCOLS.has(url.protocol)) {', 'if (false) {'),
    },
    {
        name: 'IPv6 一律視為安全（只擋 IPv4）',
        apply: (s) => s.replace("    if (!net.isIPv6(ip)) return `無法辨識的位址：${ip}`;", '    return null;'),
    },
    {
        name: '保留主機名（localhost／metadata.*）的名單失效',
        apply: (s) => s.replace('if (BLOCKED_HOST_EXACT.has(host)) {', 'if (false) {').replace('for (const suffix of BLOCKED_HOST_SUFFIX) {', 'for (const suffix of []) {'),
    },
    {
        name: 'DNS 解析結果不再逐一檢查（只看 hostname）',
        apply: (s) => s.replace('        const why = blockedAddressReason(a.address, opts);\n        if (why) return { ok: false, reason: `${host} 解析到被封鎖的位址：${why}` };', '        void a;'),
    },
];

const runMutantTests = (testFile = 'link-health.test.mjs') => {
    try {
        execFileSync(process.execPath, ['--test', path.join(MUTANT_DIR, testFile)], { encoding: 'utf8', stdio: 'pipe' });
        return { code: 0 };
    } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout || '') };
    }
};

// ── C：裸網域擷取規則的突變測試 ──
// 每一項都是「把一條規則拿掉或反過來」，然後跑 bare-domains.test.mjs。測試必須失敗。
const bareDomainMutations = [
    {
        name: '網址不再先遮蔽（網址路徑會被當成裸網域重複擷出）',
        apply: (s) => s.replace('    let masked = maskWith(text, URL_LIKE);', '    let masked = text;'),
    },
    {
        name: '信箱不再遮蔽（郵件主機被當成網站去探測）',
        apply: (s) => s.replace('    masked = maskWith(masked, EMAIL_LIKE);', '    void EMAIL_LIKE;'),
    },
    {
        name: '左界的 lookbehind 被拿掉（路徑片段與網域中段都會被擷出）',
        apply: (s) => s.replace('(?<![A-Za-z0-9._@/\\\\=#?&-])', ''),
    },
    {
        // 這一條守的是「張冠李戴」：非 CJK 的 Unicode 字母緊貼網域時，少了這道
        // lookbehind 會把西里爾的 еvil.org 截成 vil.org、全形的 Ａbc.org 截成 bc.org，
        // 檢查器去驗了另一台主機還回報它健康——產生的是錯誤的保證，比漏檢更糟。
        name: '非 CJK 字母的左界被拿掉（homograph 會被截成另一台真實主機）',
        apply: (s) =>
            s.replace(
                '(?<=^|[^\\p{L}]|[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])',
                '',
            ),
    },
    {
        name: '主機名總長度上限不再檢查（253 字元以上也放行）',
        apply: (s) => s.replace('        if (host.length > 253) continue;', '        void host;'),
    },
    {
        name: 'TLD 不再要求純字母且長度 >= 2（版本號與 e.g. 會變成網域）',
        apply: (s) => s.replace('        if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) continue;', '        void tld;'),
    },
    {
        name: '與副檔名撞名的 TLD 不再排除（README.md、libc.so 變成網域）',
        apply: (s) => s.replace('        if (!opts.keepShadowedTlds && SHADOWED_BY_FILE_EXT.has(tld)) continue;', '        void SHADOWED_BY_FILE_EXT;'),
    },
    {
        name: 'TLD 存在與否不再判斷（Node.js、fuse.min.js 會被拿去探測）',
        apply: (s) => s.replace("        if (verdict === 'yes') accepted.push(host);", '        if (true) accepted.push(host);'),
    },
    {
        // DNS 沒回答時若被歸成「確定不是網域」，resolver 一掛掉就會把整批候選
        // 靜靜判成「不是網域」，報告乾乾淨淨、CI 全綠，而一個裸網域都沒檢查。
        // 實測（resolver 指向 192.0.2.1）：30 個候選全滅、coverage_complete=true。
        name: '「DNS 沒回答」被併回「確定不是網域」（resolver 一掛就靜默漏檢）',
        apply: (s) =>
            s.replace(
                "            verdict = DEFINITIVE_ABSENT.has(code) ? 'no' : 'unknown';",
                "            void code; verdict = 'no';",
            ),
    },
    {
        // _readme 或圖片欄位一旦變成陣列，pointer 會是 /_readme/0，最後一段是 "0"。
        // 只比最後一段的話跳過邏輯當場失效，檔名與圖片路徑會整批變成裸網域候選，
        // 而且沒有任何訊號。
        name: '欄位跳過改回「只比 pointer 最後一段」（陣列化就靜默失效）',
        apply: (s) =>
            s.replace(
                "    return (pointer) => !String(pointer).split('/').some((seg) => skip.has(seg));",
                "    return (pointer) => !skip.has(String(pointer).split('/').pop());",
            ),
    },
    {
        // 篩選階段跑在 runProbes 的預算之外。拿掉上限，resolver 一掛就會多花
        // 幾百秒（實測 208 秒），全部白白疊在 30 分鐘的 job 上。
        name: '篩選階段的時間預算被拿掉（resolver 掛掉會拖垮整個 job）',
        apply: (s) =>
            s.replace(
                '        if (now() >= deadline) {',
                '        if (false) {',
            ),
    },
    {
        name: 'TLD 查詢結果不再快取（同一個 TLD 會被查幾十次）',
        apply: (s) => s.replace('        if (cache.has(key)) return cache.get(key);', '        if (false) return cache.get(key);'),
    },
    {
        // 這一條守的是整份設計的樞紐。改用「解析得到才算網域」之後，
        // concordreview.org 這種已經停用的網域會被當成「不是網域」丟掉——
        // 檢查器對它唯一該偵測的目標永久失明，而報告會很乾淨地說一切正常。
        name: '改用「可不可解析」當作「是不是網域」的判準（會對死網域失明）',
        apply: (s) =>
            s.replace(
                "        if (verdict === 'yes') accepted.push(host);",
                [
                    "        if (verdict === 'yes') {",
                    '            try {',
                    '                if (deps.lookup) await deps.lookup(host);',
                    '                accepted.push(host);',
                    '            } catch {',
                    '                rejected.push({ host, reason: \'解析不到\' });',
                    '            }',
                    '        }',
                ].join('\n'),
            ),
    },
];

// ──────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, why) => { fail++; console.log(`  ❌ ${name} → ${why}`); };

/** 基準單元測試。初始與收尾共用同一支，避免兩邊的定義漂移。 */
function runBaselineTests() {
    try {
        execFileSync(
            process.execPath,
            ['--test', path.join(SCRIPTS, 'link-health.test.mjs'), path.join(SCRIPTS, 'bare-domains.test.mjs')],
            { encoding: 'utf8', stdio: 'pipe' },
        );
        return 0;
    } catch (e) {
        return e.status ?? 1;
    }
}

console.log('先確認基準狀態為綠：');
const basePolicy = write('policy-base.json', realPolicy);
const baseInv = write('inventory-base.json', baselineInventory);
const base = runPolicyCheck(basePolicy, baseInv);
if (base.code !== 0) {
    console.error(`  ❌ 基準已經是紅的，無法進行故障注入\n${base.out.slice(0, 800)}`);
    process.exit(1);
}
// 單元測試也要一起驗，而且必須在注入之前。否則 lib 本身已經壞掉時，B／C 兩段的
// 每一條 mutation 都只是「在紅底上再變一次紅」，會全部被記成「✅ 擋下來了」，
// 要等收尾那道檢查才抓得到——而摘要早就印成「43 擋下 / 0 漏掉」了。
// 實測：把 extractBareDomainCandidates 改成永遠回 []，初始基準仍顯示綠燈。
const baseTests = runBaselineTests();
if (baseTests !== 0) {
    console.error('  ❌ 基準單元測試已經是紅的，無法進行故障注入（請先修好 link-health.test.mjs／bare-domains.test.mjs）');
    process.exit(1);
}
console.log('  ✅ 基準綠燈（政策檢查 ＋ 單元測試）\n');

console.log('A. 例外政策的故障注入（check-link-policy.mjs 必須紅）：');
policyCases.forEach((c, i) => {
    const policyPath = c.policy ? write(`policy-${i}.json`, c.policy()) : basePolicy;
    const inventoryPath = c.inventoryPath ? c.inventoryPath() : c.inventory ? write(`inventory-${i}.json`, c.inventory()) : baseInv;
    const r = runPolicyCheck(policyPath, inventoryPath);
    if (r.code === 0) return bad(c.name, '沒擋下來！');
    if (!c.expect.test(r.out)) return bad(c.name, `擋了但訊息不符預期：${(r.out.match(/✗ .*/) || ['(無)'])[0].slice(0, 120)}`);
    ok(c.name);
});

console.log('\nB. SSRF 防護的突變測試（link-health.test.mjs 必須紅）：');
rmSync(MUTANT_DIR, { recursive: true, force: true });
try {
    // 換行一律正規化成 LF 再做字串比對。這個 repo 的檔案在 Windows 上是 CRLF，
    // 而下面每一條 mutation 的比對字串都是用 LF 寫的——不正規化的話，跨行的比對
    // 會靜默失敗（String.replace 找不到就原樣回傳，不會報錯），整條保護在 Windows
    // 上等於沒有測到，在 Linux CI 上卻是綠的。實際發生過：「DNS 解析結果不再逐一
    // 檢查」這一條在本機顯示「注入未生效」，在 CI 上卻正常。
    // mutant 只是丟棄用的副本，寫回 LF 沒有副作用。
    const libSource = readFileSync(path.join(SCRIPTS, 'link-health.lib.mjs'), 'utf8')
        .split(/\r?\n/)
        .join('\n');
    for (const m of guardMutations) {
        cpSync(SCRIPTS, MUTANT_DIR, { recursive: true });
        const mutated = m.apply(libSource);
        if (mutated === libSource) {
            bad(m.name, '注入未生效（replace 沒有改到任何東西——多半是原文改了，請更新這一條）');
            rmSync(MUTANT_DIR, { recursive: true, force: true });
            continue;
        }
        writeFileSync(path.join(MUTANT_DIR, 'link-health.lib.mjs'), mutated, 'utf8');
        const r = runMutantTests();
        if (r.code === 0) bad(m.name, '拿掉這段防護之後測試竟然還是綠的——那些測試沒有在把關');
        else ok(m.name);
        rmSync(MUTANT_DIR, { recursive: true, force: true });
    }
} finally {
    rmSync(MUTANT_DIR, { recursive: true, force: true });
}

console.log('\nC. 裸網域擷取規則的突變測試（bare-domains.test.mjs 必須紅）：');
try {
    // 同樣先正規化成 LF：本 repo 的檔案在 Windows 上是 CRLF，而下面每一條 mutation
    // 的比對字串都是用 LF 寫的。不正規化的話跨行比對會靜默失敗（replace 找不到就
    // 原樣回傳，不會報錯），整條規則在本機等於沒測到、在 Linux CI 上卻是綠的。
    const bareSource = readFileSync(path.join(SCRIPTS, 'bare-domains.lib.mjs'), 'utf8')
        .split(/\r?\n/)
        .join('\n');
    for (const m of bareDomainMutations) {
        cpSync(SCRIPTS, MUTANT_DIR, { recursive: true });
        const mutated = m.apply(bareSource);
        if (mutated === bareSource) {
            bad(m.name, '注入未生效（replace 沒有改到任何東西——多半是原文改了，請更新這一條）');
            rmSync(MUTANT_DIR, { recursive: true, force: true });
            continue;
        }
        writeFileSync(path.join(MUTANT_DIR, 'bare-domains.lib.mjs'), mutated, 'utf8');
        const r = runMutantTests('bare-domains.test.mjs');
        if (r.code === 0) bad(m.name, '拿掉這條規則之後測試竟然還是綠的——那些測試沒有在把關');
        else ok(m.name);
        rmSync(MUTANT_DIR, { recursive: true, force: true });
    }
} finally {
    rmSync(MUTANT_DIR, { recursive: true, force: true });
}

console.log('\n最後確認基準仍為綠：');
const after = runPolicyCheck(basePolicy, baseInv);
const afterTests = runBaselineTests();
console.log(after.code === 0 && afterTests === 0 ? '  ✅ 還原後仍為綠燈' : '  ❌ 還原後仍是紅的，副本沒有清乾淨');

rmSync(TMP, { recursive: true, force: true });

console.log(`\n故障注入：${pass} 擋下 / ${fail} 漏掉（共 ${policyCases.length + guardMutations.length + bareDomainMutations.length} 項）`);
process.exit(fail === 0 && after.code === 0 && afterTests === 0 ? 0 : 1);
