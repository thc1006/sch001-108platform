#!/usr/bin/env node
/**
 * SSRF 防護與例外政策的故障注入矩陣
 * --------------------------------------------------------------
 * 「有寫防護」與「防護擋得住」是兩件事，「測試會過」與「測試在把關」也是兩件事。
 * 這支逐一破壞一個東西，確認該紅的真的會紅：
 *
 *   A. 政策檔的每一條規則 → check-link-policy.mjs 必須以非零碼結束
 *   B. SSRF 防護的每一段   → link-health.test.mjs 必須失敗
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

const runMutantTests = () => {
    try {
        execFileSync(process.execPath, ['--test', path.join(MUTANT_DIR, 'link-health.test.mjs')], { encoding: 'utf8', stdio: 'pipe' });
        return { code: 0 };
    } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout || '') };
    }
};

// ──────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, why) => { fail++; console.log(`  ❌ ${name} → ${why}`); };

console.log('先確認基準狀態為綠：');
const basePolicy = write('policy-base.json', realPolicy);
const baseInv = write('inventory-base.json', baselineInventory);
const base = runPolicyCheck(basePolicy, baseInv);
if (base.code !== 0) {
    console.error(`  ❌ 基準已經是紅的，無法進行故障注入\n${base.out.slice(0, 800)}`);
    process.exit(1);
}
console.log('  ✅ 基準綠燈\n');

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
    const libSource = readFileSync(path.join(SCRIPTS, 'link-health.lib.mjs'), 'utf8');
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

console.log('\n最後確認基準仍為綠：');
const after = runPolicyCheck(basePolicy, baseInv);
const afterTests = (() => {
    try {
        execFileSync(process.execPath, ['--test', path.join(SCRIPTS, 'link-health.test.mjs')], { encoding: 'utf8', stdio: 'pipe' });
        return 0;
    } catch (e) {
        return e.status ?? 1;
    }
})();
console.log(after.code === 0 && afterTests === 0 ? '  ✅ 還原後仍為綠燈' : '  ❌ 還原後仍是紅的，副本沒有清乾淨');

rmSync(TMP, { recursive: true, force: true });

console.log(`\n故障注入：${pass} 擋下 / ${fail} 漏掉（共 ${policyCases.length + guardMutations.length} 項）`);
process.exit(fail === 0 && after.code === 0 && afterTests === 0 ? 0 : 1);
