#!/usr/bin/env node
/**
 * SSRF 防護、例外政策、接管偵測與裸網域擷取的故障注入矩陣。
 * 「有寫防護」與「防護擋得住」是兩件事，「測試會過」與「測試在把關」也是兩件事。
 * 這支逐一破壞一個東西，確認該紅的真的會紅：
 *
 *   A. 政策檔的每一條規則 → check-link-policy.mjs 必須以非零碼結束
 *   B. SSRF 防護、讀 body 與無法判定的分組 → link-health.test.mjs 必須失敗
 *   D. 接管偵測的每一段   → hijack-signals.test.mjs 必須失敗
 *   C. 裸網域擷取的每一條  → bare-domains.test.mjs 必須失敗
 *   E. 判定、通知與報告內容 → link-health.test.mjs 或 hijack-signals.test.mjs 必須失敗
 *   F. buildReport 的組裝   → link-health.test.mjs 或 hijack-signals.test.mjs 必須失敗
 *   G. 連結政策的檢查、比對與到期提醒 → link-health.test.mjs 必須失敗
 *
 * C 是為了守住兩個「看起來對、其實已經退化」的方向：擷取規則被放寬之後會把
 * 檔名當網域（噪音），或被收緊之後悄悄漏掉真的網域（失明）。特別是
 * screenBareDomains 一旦改用「解析得到才算網域」，已經停用的網域就會被當成
 * 「不是網域」丟掉，檢查器對它唯一該偵測的目標永久失明，而所有測試照樣全綠。
 *
 * B 到 G 六段是刻意做的突變測試：拿掉一段防護或規則之後，如果測試還是綠的，
 * 那些測試就是裝飾品。#72 的起因正是「lychee 看起來有在檢查、實際一個連結都沒驗」，
 * 同一類假象在自己的測試上也會發生。
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
// entries 用固定的測資：正式的例外可能一筆都不剩，entries 的規則仍要有東西可以破壞。hijacked 用正式名單。
const fixtureExpires = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
const policyFixture = {
    ...realPolicy,
    entries: [
        {
            match: { url: 'https://files.example.org/guide.pdf' },
            reason: '故障注入的測資：只放行這一個檔案，不放行整台主機。',
            owner: 'link-faults',
            expires: fixtureExpires,
        },
        {
            match: { host: 'www.example.net' },
            reason: '故障注入的測資：整台主機層級的例外，用 host 而不是單一網址。',
            owner: 'link-faults',
            expires: fixtureExpires,
        },
    ],
};

/** 只含政策目標的最小盤點，讓「殭屍條目」以外的規則不會被誤觸發。 */
const baselineInventory = {
    generatedFrom: 'dist',
    total: 3,
    urls: [
        { url: policyFixture.entries[0].match.url, occurrences: [{ file: 'x.html', location: 'a[href]' }] },
        { url: 'https://www.example.net/bbs/page.html', occurrences: [{ file: 'y.html', location: 'a[href]' }] },
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
const clonePolicy = () => JSON.parse(JSON.stringify(policyFixture));
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
        policy: () => { const p = clonePolicy(); p.entries[1].match = { host: '*.example.net' }; return p; },
    },
    {
        name: '例外把整個母網域放進來（子網域全放行）',
        expect: /找不到對應的網址/,
        policy: () => { const p = clonePolicy(); p.entries[1].match = { host: 'example.net' }; return p; },
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
    // hijacked 名單的紀律必須與 allowlist 一樣嚴。
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
        // hijacked 會被寫成「這台主機本身已被接管」，但它並沒有，它是接管方。
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
        // 全形的 ｉｅｓｏ 在網址裡會被正規化成 ieso，名單寫成這樣就永遠比不到。
        name: '接管警示的主機名寫成全形（國際化網域沒寫成 punycode 也一樣）',
        expect: /punycode/,
        policy: () => { const p = clonePolicy(); p.hijacked[0].match = { host: 'ｉｅｓｏ-info.org' }; return p; },
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
        // 基準盤點在說明文字裡點名每一台接管主機，照樣是綠的；這一條把其中一台寫成網址。
        name: '盤點的網址連到接管主機（說明文字只能寫裸網域）',
        expect: /連到接管警示的主機/,
        inventory: () => ({
            ...baselineInventory,
            urls: [...baselineInventory.urls, { url: `https://${realPolicy.hijacked[0].match.host}/`, occurrences: [{ file: 'data.json', location: '/0/url' }] }],
        }),
    },
    {
        name: '盤點的網址連到接管主機，主機名大寫又帶結尾的點（比對要先正規化）',
        expect: /連到接管警示的主機/,
        inventory: () => ({
            ...baselineInventory,
            urls: [...baselineInventory.urls, { url: `https://${realPolicy.hijacked[0].match.host.toUpperCase()}./x`, occurrences: [{ file: 'data.json', location: '/0/url' }] }],
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

// B 段是 SSRF 防護、讀 body 與無法判定分組的突變測試：每一項都把其中一段拿掉或改掉，
// 然後跑 link-health.test.mjs。測試必須失敗。
const guardMutations = [
    {
        name: 'IPv4 封鎖網段清單被清空',
        // 這裡動的是「編譯後的網段表」而不是原始清單：突變若把原始清單的開頭換成
        // `const BLOCKED_IPV4 = [].concat([]) && [`，文字確實變了，語意卻沒變
        // （`[] && x` 回傳 x），等於沒做，而 mutated !== libSource 這個守衛
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
        name: '讀 body 不再標截斷（只讀到前綴的頁面會被當成很小的殼）',
        apply: (s) => s.replace('bodyTruncated: !complete || read > wantBody,', 'bodyTruncated: false,'),
    },
    {
        name: '讀 body 時 close 也當成讀完（讀到上限時後面還有資料，不再標截斷）',
        apply: (s) => s.replace("res.on('close', finish);", "res.on('close', () => { complete = true; finish(); });"),
    },
    {
        name: '讀 body 的上限改算解碼後的長度（非 UTF-8 的頁面收完了也被標成截斷）',
        apply: (s) => s.replace('read += chunk.length;', "read += Buffer.byteLength(chunk.toString('utf8'), 'utf8');"),
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
    {
        // 公網答案排在前面、私網答案藏在後面時，只看第一個答案就會放行。
        name: 'DNS 答案只檢查第一個（後面的私網答案被放行）',
        apply: (s) => s.replace('    for (const a of addresses) {', '    for (const a of addresses.slice(0, 1)) {'),
    },
    {
        // 和「轉址只驗第一跳」不同，靜態政策還在，只拿掉轉址那一跳的 DNS 答案檢查。
        // IP 字面值的轉址測試抓不到這一種，要靠轉址到解析成私網的網域那個測試。
        // node:dns 用 import() 取得：lib 的匯入改名時，測試才不會只因 ReferenceError 而紅。
        name: '轉址那一跳的 DNS 答案不再檢查（靜態政策仍在）',
        apply: (s) =>
            s.replace(
                'const resolved = await resolveAndVerify(canonicalHost(url.hostname), opts);',
                "const resolved = hop === 0 ? await resolveAndVerify(canonicalHost(url.hostname), opts) : await (await import('node:dns')).promises.lookup(canonicalHost(url.hostname), { all: true, verbatim: true }).then((addresses) => ({ ok: true, addresses }), (err) => ({ ok: false, code: err?.code || 'EDNS', reason: String(err?.message || err) }));",
            ),
    },
    {
        // 這一條不是 SSRF，但同在 link-health.lib.mjs。resolver 暫時失敗被當成網域不存在的話，
        // runner 的 DNS 一抖就會把整批連結判成 dead 並開 issue。
        name: 'EAI_AGAIN 被正規化成 ENOTFOUND（暫時失敗誤判成失效）',
        apply: (s) =>
            s.replace(
                "const code = err?.code === 'ENOENT' ? 'ENOTFOUND' : err?.code || 'EDNS';",
                "const code = err?.code === 'ENOENT' || err?.code === 'EAI_AGAIN' ? 'ENOTFOUND' : err?.code || 'EDNS';",
            ),
    },
    {
        // 下面三條守週報的分組：分組錯了，三態照樣正確，只有讀報告的人看得出來。
        name: '無法判定的分組一律回 other（週報看不出連不上與被拒絕的差別）',
        apply: (s) => s.replace('export function unverifiedBucket(r) {', "export function unverifiedBucket(r) {\n    if (true) return 'other';"),
    },
    {
        name: '無法判定的分組不看狀態碼（403、429、5xx 被歸到其他）',
        apply: (s) => s.replace("    if (r.status >= 500 && r.status <= 599) return 'server-error';\n    if (r.status) return 'rejected';\n", ''),
    },
    {
        name: '5xx 併回被站台拒絕（伺服器錯誤收進收合的那一段）',
        apply: (s) => s.replace("    if (r.status >= 500 && r.status <= 599) return 'server-error';\n", ''),
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

// D 段是接管偵測的突變測試。這三個訊號的價值完全取決於誤判率：報得太兇會被當
// 雜訊關掉，關掉之後就回到「只能堵已知主機」。所以除了「拿掉偵測會不會漏」，
// 也要測「拿掉防誤判的那一層會不會開始亂報」，後者有兩條：詞界與 meta refresh。
const hijackMutations = [
    {
        name: '同站判定永遠回 true（跨站轉址完全偵測不到）',
        apply: (s) => s.replace('    if (aHost === bHost) return true;', '    if (aHost === bHost) return true;\n    return true;'),
    },
    {
        // 少了點邊界，foo.com 會被當成 evil-foo.com 的後綴 → 接管被判成同站
        name: '後綴比對的點邊界被拿掉（evil-foo.com 會被當成 foo.com 的自家主機）',
        apply: (s) =>
            s.replace(
                '    return aHost.endsWith(`.${bHost}`) || bHost.endsWith(`.${aHost}`);',
                '    return aHost.endsWith(`${bHost}`) || bHost.endsWith(`${aHost}`);',
            ),
    },
    {
        // 這一條守的是誤判：純子字串比對會讓 free spins 命中
        // 「free spins-off workshop」。
        name: '詞組比對退回純子字串（連字號複合詞會誤判）',
        apply: (s) =>
            s.replace(
                '    if (!IS_ASCII.test(phrase)) return hay.includes(phrase);',
                '    return hay.includes(phrase);',
            ),
    },
    {
        // CodeQL js/bad-tag-filter。`</script >` 是合法的結束標籤，瀏覽器照樣收工，
        // 而 `<\/script>` 對不上它，整段 JS 原始碼會被算成「可見文字」，
        // 訊號 C 直接瞎掉。被偵測的是敵意主機，多打一個空格就是一種繞法。
        name: 'script 的結束標籤退回不容許空白（多一個空格就繞過訊號 C）',
        apply: (s) =>
            s.replace(
                '.replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script\\b[^>]*>/gi, \' \')',
                '.replace(/<script[\\s\\S]*?<\\/script>/gi, \' \')',
            ),
    },
    {
        name: '內容標記永遠回空（ieso-info.org 那類接管會漏掉）',
        apply: (s) =>
            s.replace(
                'export function contentSquatSignals(html) {',
                'export function contentSquatSignals(html) {\n    return [];',
            ),
    },
    {
        // 這一條也是守誤判：不排除 meta refresh 的話，對照組裡
        // www.cac.edu.tw 與 tpmso.k12ea.gov.tw 的舊式轉址頁會被誤標。
        name: 'meta refresh 不再排除（正當的舊式轉址頁會被誤標成盲區）',
        apply: (s) =>
            s.replace(
                '    if (META_REFRESH.test(bodyHead)) return null;',
                '    void META_REFRESH;',
            ),
    },
    {
        name: 'HTTP 層盲區偵測永遠回 null（hmun.org 那類 JS 殼會漏掉）',
        apply: (s) =>
            s.replace(
                'export function opaqueShell(bodyHead, truncated = false) {',
                'export function opaqueShell(bodyHead, truncated = false) {\n    return null;',
            ),
    },
    {
        name: 'HTTP 層盲區偵測不理會截斷（只讀到前綴的頁面會被當成殼）',
        apply: (s) => s.replace('    if (truncated) return null;\n', ''),
    },
    {
        // 這一條守的是漏檢：description 的引號若改用「兩種引號都排除」的字元類別，
        // 內容裡有撇號就會被截在撇號上，撇號之後的變現詞組全部看不到。
        name: 'description 的引號退回字元類別（內容裡的撇號會把偵測截斷）',
        apply: (s) =>
            s.replace(
                'html.match(/<meta[^>]+name=(["\'])description\\1[^>]*content=(["\'])([\\s\\S]*?)\\2/i)?.[3] ??',
                'html.match(/<meta[^>]+name=(["\'])description\\1[^>]*content=(["\'])([^"\']*?)\\2/i)?.[3] ??',
            ),
    },
    {
        // 長度上限寫進量詞時，超過上限不是截斷而是整條比對失敗，「太長」與
        // 「沒有 title」在下游長得一模一樣，而蹲域名的頁面標題常常很長。
        name: '長度上限寫回正則量詞（過長的 title 會被整條丟掉而不是截斷）',
        apply: (s) =>
            s.replace(
                'const t = html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i);',
                'const t = html.match(/<title[^>]*>([\\s\\S]{0,300}?)<\\/title>/i);',
            ),
    },
    {
        // 遠端可控的 <title> 會被原樣送進 issue body（gh issue create --body-file），
        // 而命中的定義就是「那台主機不可信」。
        name: 'inertText 退化成原樣輸出（被接管的網域可以直接寫 issue 的 markdown）',
        apply: (s) =>
            s.replace(
                'export function inertText(s) {',
                "export function inertText(s) {\n    return String(s ?? '');",
            ),
    },
];

// C 段是裸網域擷取規則的突變測試：每一項都是「把一條規則拿掉或反過來」，然後跑
// bare-domains.test.mjs。測試必須失敗。
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
        // 檢查器去驗了另一台主機還回報它健康，產生的是錯誤的保證，比漏檢更糟。
        name: '非 CJK 字母的左界被拿掉（homograph 會被截成另一台真實主機）',
        apply: (s) =>
            s.replace(
                '(?<=^|[^\\p{L}]|[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}])',
                '',
            ),
    },
    {
        name: '全形標點不再算網址的結尾（官網https://a.org？ 會擷成無法解析的網址）',
        apply: (s) => s.replace('】！？…～“”‘’〈〉［］｛｝—⋯／｜]+/g;', '】]+/g;'),
    },
    {
        name: 'userinfo 收任何字元（網址後面接著信箱時，主機名會被當成 userinfo）',
        apply: (s) => s.replace("(?:[A-Za-z0-9._~!$&'()*+,;=:%-]*@)?", '(?:[^@/?#]*@)?'),
    },
    {
        name: '主機名後面緊接的字不再截斷（請上https://a.org查詢 會變成另一台主機）',
        apply: (s) => s.replace('let url = /^(?:[/?#]|$)/.test(match.slice(head[0].length)) ? match : head[0];', 'let url = match;'),
    },
    {
        name: '內文網址不去結尾的英文標點（句點會被當成網址的一部分）',
        apply: (s) => s.replace("if ('.,:;!?'.includes(last)) url = url.slice(0, -1);", 'if (false) url = url.slice(0, -1);'),
    },
    {
        name: '內文網址的右括號一律去掉（Foo_(bar) 這種路徑會被截斷）',
        apply: (s) => s.replace('else if (last in CLOSERS && url.split(last).length > url.split(CLOSERS[last]).length)', 'else if (last in CLOSERS)'),
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
        // concordreview.org 這種已經停用的網域會被當成「不是網域」丟掉，
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

// E 段是 check-external-links.lib.mjs 的突變測試：判定、通知條件與報告內容。這些改壞了，
// 三態與 SSRF 防護照樣正確，只有讀報告、等通知的人會發現。
const reportMutations = [
    {
        name: "盤點網址的接管比對被拿掉（被接管的網域回 200，算成健康）",
        apply: (s) => s.replace("    if (hijack) return { bin: 'hijacked', item: { ...item, policy: hijack, source: 'url' }, signal: null };", "    if (false) return { bin: 'hijacked', item: { ...item, policy: hijack, source: 'url' }, signal: null };"),
    },
    {
        name: "裸網域的接管比對被拿掉",
        apply: (s) => s.replace("    if (hijack) return { bin: 'hijacked', item: { ...item, policy: hijack, source: 'bare' }, signal: null };", "    if (false) return { bin: 'hijacked', item: { ...item, policy: hijack, source: 'bare' }, signal: null };"),
    },
    {
        name: "盤點網址的位址政策封鎖被拿掉（指向內網的網址混進無法判定）",
        apply: (s) => s.replace("    if (isBlockedResult(r)) return { bin: 'blocked', item: { ...item, reason: r.reason }, signal: null };\n    // 接管的判定", "    // 接管的判定"),
    },
    {
        name: "裸網域的位址政策封鎖被拿掉（指向內網的主機混進無法判定）",
        apply: (s) => s.replace("    if (isBlockedResult(r)) return { bin: 'blocked', item: { ...item, reason: r.reason }, signal: null };\n    const hijack = matchHijacked(hijacked, item.url);", "    const hijack = matchHijacked(hijacked, item.url);"),
    },
    {
        name: "dead 也查例外政策（確定壞掉的連結被壓下去）",
        apply: (s) => s.replace("    if (verdict === 'dead') return { bin: 'dead', item, signal };", "    if (verdict === 'dead' && !matchPolicy(entries, target.url)) return { bin: 'dead', item, signal };"),
    },
    {
        name: "分組用 item 算（item 沒有 status 與 code，全部落到其他）",
        apply: (s) => s.replace("bucket: unverifiedBucket(r)", "bucket: unverifiedBucket(item)"),
    },
    {
        name: "needsAttention 把跨站轉址也算進去",
        apply: (s) => s.replace("        splitSignals(autoSignals).actionable.length > 0 ||", "        autoSignals.length > 0 ||"),
    },
    {
        name: "needsAttention 拿掉需處理的自動訊號",
        apply: (s) => s.replace("        splitSignals(autoSignals).actionable.length > 0 ||\n", ""),
    },
    {
        name: "needsAttention 拿掉接管命中",
        apply: (s) => s.replace("        hijackedHits.length > 0 ||\n", ""),
    },
    {
        name: "訊號數只在有命中時才寫進報告",
        apply: (s) => s.replace("    lines.push(\n        `- 自動偵測：需處理", "    if (autoSignals.length) lines.push(\n        `- 自動偵測：需處理"),
    },
    {
        name: "出處不帶 JSON pointer",
        apply: (s) => s.replace("(o.file.endsWith('.json') ? `${o.file} ${o.location}` : o.file)", "o.file"),
    },
    {
        name: "競賽看門狗的註附在所有出處",
        apply: (s) => s.replace("o.file === c.file && c.location.test(o.location)", "o.file === c.file"),
    },
    {
        name: "報告對調 server-error 與 rejected 的篩選",
        apply: (s) => s.replace("const serverErrors = unverified.filter((u) => u.bucket === 'server-error');\n        const rejected = unverified.filter((u) => u.bucket === 'rejected');", "const serverErrors = unverified.filter((u) => u.bucket === 'rejected');\n        const rejected = unverified.filter((u) => u.bucket === 'server-error');"),
    },
    {
        name: "5xx 那段改回收合",
        apply: (s) => s.replace("`<details open><summary>⚠️ 站台回報伺服器錯誤", "`<details><summary>⚠️ 站台回報伺服器錯誤"),
    },
    {
        name: "有待辦時仍寫「全部外部連結正常」",
        apply: (s) => s.replace("if (!attention && !unverified.length && !bareOther.length)", "if (!unverified.length && !bareOther.length)"),
    },
    {
        name: "5xx 那段不列網址",
        apply: (s) => s.replace("for (const u of serverErrors) lines.push(`- ${u.reason}：${u.url}`);", ""),
    },
    {
        name: "judgeUrl 的自動訊號一律丟掉",
        apply: (s) => s.replace("const signal = sig ? { ...sig, source: 'url', occurrences: item.occurrences } : null;", "const signal = null;"),
    },
    {
        name: "judgeBare 的自動訊號一律丟掉",
        apply: (s) => s.replace("const signal = sig ? { ...sig, source: 'bare', host: item.host, occurrences: item.occurrences } : null;", "const signal = null;"),
    },
    {
        name: "judgeBare 把無法判定算成健康",
        apply: (s) => s.replace("return { bin: verdict === 'dead' || verdict === 'unverified' ? verdict : 'healthy', item, signal };", "return { bin: verdict === 'dead' ? 'dead' : 'healthy', item, signal };"),
    },
    {
        name: "裸網域封鎖的原因改用 describeResult",
        apply: (s) => s.replace("    if (isBlockedResult(r)) return { bin: 'blocked', item: { ...item, reason: r.reason }, signal: null };\n    const hijack = matchHijacked(hijacked, item.url);", "    if (isBlockedResult(r)) return { bin: 'blocked', item, signal: null };\n    const hijack = matchHijacked(hijacked, item.url);"),
    },
    {
        name: "接管主機不列出處",
        apply: (s) => s.replace("            lines.push(`  - 負責人：${h.policy.owner}　重新查證期限：${h.policy.expires}`);\n            lines.push(...sourceLines(h));", "            lines.push(`  - 負責人：${h.policy.owner}　重新查證期限：${h.policy.expires}`);"),
    },
    {
        name: "kind 標籤對調",
        apply: (s) => s.replace("h.policy.kind === 'terminus' ? '接管鏈的終點", "h.policy.kind !== 'terminus' ? '接管鏈的終點"),
    },
    {
        name: "報告不寫說明文字裡的網域失效那一段",
        apply: (s) => s.replace("    if (bareDead.length) {\n        lines.push(", "    if (false) {\n        lines.push("),
    },
    {
        name: "報告不寫位址政策封鎖那一段",
        apply: (s) => s.replace("    if (blocked.length) {\n        lines.push(", "    if (false) {\n        lines.push("),
    },
    {
        name: "報告不寫需處理的自動訊號那一段",
        apply: (s) => s.replace("    if (actionableSignals.length) {\n        lines.push(", "    if (false) {\n        lines.push("),
    },
    {
        name: "報告不寫 TLD 查不到那一段",
        apply: (s) => s.replace("    if (bareUnresolved.length) {\n        lines.push(", "    if (false) {\n        lines.push("),
    },
    {
        name: "報告不寫檢查未完成那一段",
        apply: (s) => s.replace("    if (skipped || bareSkipped) {\n        lines.push(", "    if (false) {\n        lines.push("),
    },
    {
        name: "EXPIRY_NOTICE_DAYS 改成 0（永遠不提醒，要等到期當天 PR 全紅才發現）",
        apply: (s) => s.replace("export const EXPIRY_NOTICE_DAYS = 30;", "export const EXPIRY_NOTICE_DAYS = 0;"),
    },
    {
        name: "報告不寫到期提醒那一段",
        apply: (s) => s.replace("    if (expiringSoon.length) {\n        lines.push(`### ⏰", "    if (false) {\n        lines.push(`### ⏰"),
    },
    {
        name: "needsAttention 拿掉快到期的政策項目",
        apply: (s) => s.replace("        expiringSoon.length > 0 ||\n", ""),
    },
    {
        name: "到期提醒只算例外，接管警示沒算",
        apply: (s) => s.replace("...expiringWithin(hijacked, todayISO, EXPIRY_NOTICE_DAYS)", "...expiringWithin(entries, todayISO, EXPIRY_NOTICE_DAYS)"),
    },
    {
        name: "到期提醒只印 match.host（寫 match.url 的例外印成 undefined）",
        apply: (s) => s.replace("${e.match.host ?? e.match.url}", "${e.match.host}"),
    },
    {
        name: "到期提醒不寫負責人",
        apply: (s) => s.replace("到期日：${e.expires}　負責人：${e.owner}`);", "到期日：${e.expires}`);"),
    },
];

// F 段是 buildReport 的突變測試：把探測結果分進各段、算覆蓋與通知條件，再交給報告、GITHUB_OUTPUT 與主控台。
// judgeUrl、renderReport 各自都對，這裡傳錯一個值，週報照樣會錯。
const assemblyMutations = [
    {
        name: "judgeUrl 拿到空的接管名單（盤點網址的接管命中算成健康）",
        apply: (s) => s.replace("{ hijacked: policy.hijacked, entries: policy.entries }", "{ hijacked: [], entries: policy.entries }"),
    },
    {
        name: "盤點網址的接管命中放進例外那一段",
        apply: (s) => s.replace("const urlBins = { blocked, hijacked: hijackedHits, dead, suppressed, unverified };", "const urlBins = { blocked, hijacked: suppressed, dead, suppressed, unverified };"),
    },
    {
        name: "judgeBare 拿到空的接管名單",
        apply: (s) => s.replace("judgeBare(target, r, { hijacked: policy.hijacked })", "judgeBare(target, r, { hijacked: [] })"),
    },
    {
        name: "裸網域失效放進無法判定那一段",
        apply: (s) => s.replace("dead: bareDead, unverified: bareOther }", "dead: bareOther, unverified: bareOther }"),
    },
    {
        name: "盤點網址的自動訊號沒收",
        apply: (s) => s.replace("        if (signal) autoSignals.push(signal);\n        if (bin === 'healthy') healthy++;", "        if (bin === 'healthy') healthy++;"),
    },
    {
        name: "裸網域的自動訊號沒收",
        apply: (s) => s.replace("        if (signal) autoSignals.push(signal);\n        if (bin === 'healthy') bareHealthy++;", "        if (bin === 'healthy') bareHealthy++;"),
    },
    {
        name: "通知條件沒拿到接管命中",
        apply: (s) => s.replace("    const attention = needsAttention(model);", "    const attention = needsAttention({ ...model, hijackedHits: [] });"),
    },
    {
        name: "報告沒拿到接管命中",
        apply: (s) => s.replace("report: renderReport({ ...model, attention }),", "report: renderReport({ ...model, hijackedHits: [], attention }),"),
    },
    {
        name: "報告的通知條件寫死 false（結尾和 GITHUB_OUTPUT 對不上）",
        apply: (s) => s.replace("report: renderReport({ ...model, attention }),", "report: renderReport({ ...model, attention: false }),"),
    },
    {
        name: "覆蓋不看 DNS 沒答的候選",
        apply: (s) => s.replace(" && screen.unresolved.length === 0;", ";"),
    },
    {
        name: "GITHUB_OUTPUT 寫死 coverage_complete=true",
        apply: (s) => s.replace("\\ncoverage_complete=${coverageComplete}\\n`", "\\ncoverage_complete=true\\n`"),
    },
    {
        name: "GITHUB_OUTPUT 寫死 needs_attention=false",
        apply: (s) => s.replace("`needs_attention=${attention}\\n", "`needs_attention=false\\n"),
    },
    {
        name: "主控台結尾寫死「無待辦項目」",
        apply: (s) => s.replace("tail.push(attention ? '→ 有項目需要處理，已寫入報告。' : '→ 無待辦項目。');", "tail.push('→ 無待辦項目。');"),
    },
    {
        name: "通知條件沒拿到自動訊號",
        apply: (s) => s.replace("    const attention = needsAttention(model);", "    const attention = needsAttention({ ...model, autoSignals: [] });"),
    },
    {
        name: "到期提醒沒算接管警示",
        apply: (s) => s.replace("expiringPolicyItems(policy.entries, policy.hijacked, todayISO)", "expiringPolicyItems(policy.entries, [], todayISO)"),
    },
    {
        name: "通知條件沒拿到快到期的項目",
        apply: (s) => s.replace("    const attention = needsAttention(model);", "    const attention = needsAttention({ ...model, expiringSoon: [] });"),
    },
    {
        name: "報告沒拿到快到期的項目",
        apply: (s) => s.replace("report: renderReport({ ...model, attention }),", "report: renderReport({ ...model, expiringSoon: [], attention }),"),
    },
    {
        name: "主控台不印快到期的項目",
        apply: (s) => s.replace("    if (expiringSoon.length) summary.push(", "    if (false) summary.push("),
    },
];

// G 段是 link-policy.lib.mjs 的突變測試。check-link-policy 與排程健檢共用這些函式，
// 比對或檢查改壞時，名單上的主機會靜靜地比不到。
const policyLibMutations = [
    {
        name: 'match.host 不再檢查網址正規化後的形式（Unicode、全形的寫法永遠比不到）',
        apply: (s) => s.replace('    if (normalized !== raw) {', '    if (false) {'),
    },
    {
        name: 'match.host 只比小寫與結尾的點（全形、Unicode 的寫法照樣通過，訊息給的寫法改完還要再改）',
        apply: (s) => s.replace('const normalized = canonicalHost(verdict.url.hostname);', 'const normalized = canonicalHost(raw);'),
    },
    {
        name: 'matchHijacked 不再正規化主機名（大寫或結尾帶點的網址比不到）',
        apply: (s) => s.replace('        host = canonicalHost(new URL(url).hostname);\n    } catch {\n        return null;', '        host = new URL(url).hostname;\n    } catch {\n        return null;'),
    },
    {
        name: "expiringWithin 永遠回空（到期當天 CI 才紅，事前沒有通知）",
        apply: (s) => s.replace("export function expiringWithin(items, todayISO, days) {", "export function expiringWithin(items, todayISO, days) {\n    if (true) return [];"),
    },
    {
        name: "到期提醒少算最後一天（第 30 天到期的不通知）",
        apply: (s) => s.replace("        return left > 0 && left <= days;", "        return left > 0 && left < days;"),
    },
];

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, why) => { fail++; console.log(`  ❌ ${name} → ${why}`); };

/** 基準單元測試。初始與收尾共用同一支，避免兩邊的定義漂移。 */
function runBaselineTests() {
    try {
        execFileSync(
            process.execPath,
            [
                '--test',
                path.join(SCRIPTS, 'link-health.test.mjs'),
                path.join(SCRIPTS, 'bare-domains.test.mjs'),
                // D 段的突變要跑這一支。基準也必須涵蓋它，否則「基準是綠的」這句話
                // 對接管偵測是盲的，而這個矩陣存在的理由就是不留這種盲點。
                path.join(SCRIPTS, 'hijack-signals.test.mjs'),
            ],
            { encoding: 'utf8', stdio: 'pipe' },
        );
        return 0;
    } catch (e) {
        return e.status ?? 1;
    }
}

console.log('先確認基準狀態為綠：');
const basePolicy = write('policy-base.json', policyFixture);
const baseInv = write('inventory-base.json', baselineInventory);
const base = runPolicyCheck(basePolicy, baseInv);
if (base.code !== 0) {
    console.error(`  ❌ 基準已經是紅的，無法進行故障注入\n${base.out.slice(0, 800)}`);
    rmSync(TMP, { recursive: true, force: true });
    process.exit(1);
}
// 單元測試也要一起驗，而且必須在注入之前。否則 lib 本身已經壞掉時，B 到 G 六段的
// 每一條 mutation 都只是「在紅底上再變一次紅」，會全部被記成「✅ 擋下來了」，
// 要等收尾那道檢查才抓得到，摘要照樣印出「0 漏掉」。例如讓
// extractBareDomainCandidates 永遠回 []，只跑政策檢查的話基準仍是綠的。
const baseTests = runBaselineTests();
if (baseTests !== 0) {
    console.error('  ❌ 基準單元測試已經是紅的，無法進行故障注入（請先修好 link-health.test.mjs／bare-domains.test.mjs／hijack-signals.test.mjs）');
    rmSync(TMP, { recursive: true, force: true });
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

console.log('\nB. SSRF 防護、讀 body 與無法判定分組的突變測試（link-health.test.mjs 必須紅）：');
rmSync(MUTANT_DIR, { recursive: true, force: true });
try {
    // 換行一律正規化成 LF 再做字串比對。這個 repo 的檔案在 Windows 上是 CRLF，
    // 而下面每一條 mutation 的比對字串都是用 LF 寫的。不正規化的話，跨行的比對
    // 會靜默失敗（String.replace 找不到就原樣回傳，不會報錯），整條保護在 Windows
    // 上等於沒有測到，在 Linux CI 上卻是綠的。
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

console.log('\nD. 接管偵測的突變測試（hijack-signals.test.mjs 必須紅）：');
try {
    const hijackSource = readFileSync(path.join(SCRIPTS, 'hijack-signals.lib.mjs'), 'utf8')
        .split(/\r?\n/)
        .join('\n');
    for (const m of hijackMutations) {
        cpSync(SCRIPTS, MUTANT_DIR, { recursive: true });
        const mutated = m.apply(hijackSource);
        if (mutated === hijackSource) {
            bad(m.name, '注入未生效（replace 沒有改到任何東西——多半是原文改了，請更新這一條）');
            rmSync(MUTANT_DIR, { recursive: true, force: true });
            continue;
        }
        writeFileSync(path.join(MUTANT_DIR, 'hijack-signals.lib.mjs'), mutated, 'utf8');
        const r = runMutantTests('hijack-signals.test.mjs');
        if (r.code === 0) bad(m.name, '拿掉這一段之後測試竟然還是綠的——那些測試沒有在把關');
        else ok(m.name);
        rmSync(MUTANT_DIR, { recursive: true, force: true });
    }
} finally {
    rmSync(MUTANT_DIR, { recursive: true, force: true });
}

// E、F 兩段突變的是同一個檔案，跑法相同。
const reportSource = readFileSync(path.join(SCRIPTS, 'check-external-links.lib.mjs'), 'utf8')
    .split(/\r?\n/)
    .join('\n');
for (const [title, mutations] of [
    ['E. 判定、通知與報告內容的突變測試（link-health.test.mjs 或 hijack-signals.test.mjs 必須紅）：', reportMutations],
    ['F. buildReport 組裝的突變測試（link-health.test.mjs 或 hijack-signals.test.mjs 必須紅）：', assemblyMutations],
]) {
    console.log(`\n${title}`);
    try {
        for (const m of mutations) {
            cpSync(SCRIPTS, MUTANT_DIR, { recursive: true });
            const mutated = m.apply(reportSource);
            if (mutated === reportSource) {
                bad(m.name, '注入未生效（replace 沒有改到任何東西——多半是原文改了，請更新這一條）');
                rmSync(MUTANT_DIR, { recursive: true, force: true });
                continue;
            }
            writeFileSync(path.join(MUTANT_DIR, 'check-external-links.lib.mjs'), mutated, 'utf8');
            // 兩支測試有一支紅就算擋下；兩支都要跑，報告的接線有一部分在 hijack-signals.test.mjs。
            const caught = ['link-health.test.mjs', 'hijack-signals.test.mjs'].some((f) => runMutantTests(f).code !== 0);
            if (!caught) bad(m.name, '改壞這一段之後測試竟然還是綠的——那些測試沒有在把關');
            else ok(m.name);
            rmSync(MUTANT_DIR, { recursive: true, force: true });
        }
    } finally {
        rmSync(MUTANT_DIR, { recursive: true, force: true });
    }
}

console.log('\nG. 連結政策檢查、比對與到期提醒的突變測試（link-health.test.mjs 必須紅）：');
try {
    const policySource = readFileSync(path.join(SCRIPTS, 'link-policy.lib.mjs'), 'utf8')
        .split(/\r?\n/)
        .join('\n');
    for (const m of policyLibMutations) {
        cpSync(SCRIPTS, MUTANT_DIR, { recursive: true });
        const mutated = m.apply(policySource);
        if (mutated === policySource) {
            bad(m.name, '注入未生效（replace 沒有改到任何東西——多半是原文改了，請更新這一條）');
            rmSync(MUTANT_DIR, { recursive: true, force: true });
            continue;
        }
        writeFileSync(path.join(MUTANT_DIR, 'link-policy.lib.mjs'), mutated, 'utf8');
        const r = runMutantTests();
        if (r.code === 0) bad(m.name, '改掉這一段之後測試竟然還是綠的——那些測試沒有在把關');
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

console.log(`\n故障注入：${pass} 擋下 / ${fail} 漏掉（共 ${policyCases.length + guardMutations.length + bareDomainMutations.length + hijackMutations.length + reportMutations.length + assemblyMutations.length + policyLibMutations.length} 項）`);
process.exit(fail === 0 && after.code === 0 && afterTests === 0 ? 0 : 1);
