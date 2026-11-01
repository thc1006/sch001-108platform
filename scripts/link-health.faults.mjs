#!/usr/bin/env node
/**
 * SSRF 防護、例外政策、接管偵測與裸網域擷取的故障注入矩陣。
 * 「有寫防護」與「防護擋得住」是兩件事，「測試會過」與「測試在把關」也是兩件事。
 * 這支逐一破壞一個東西，確認該紅的真的會紅：
 *
 *   A. 政策檔的每一條規則 → check-link-policy.mjs 必須以非零碼結束
 *   B. SSRF 防護、讀 body、JS 轉址與無法判定的分組 → link-health.test.mjs 必須失敗
 *   D. 接管偵測的每一段   → hijack-signals.test.mjs 必須失敗；取 <title> 之前拿掉的部分另外看 missing-titles、soft404 的測試
 *   C. 裸網域擷取的每一條  → bare-domains.test.mjs 必須失敗
 *   E. 判定、通知與報告內容 → link-health.test.mjs 或 hijack-signals.test.mjs 必須失敗
 *   F. buildReport 的組裝   → link-health.test.mjs 或 hijack-signals.test.mjs 必須失敗
 *   G. 連結政策的檢查、比對與到期提醒 → link-health.test.mjs 必須失敗
 *   H. 主程式交給 buildReport 的名單與交給 probe 的選項 → check-external-links.test.mjs 必須失敗
 *   I. 軟 404 的規則、隨機路徑與重打，以及它們在報告裡的分組 → soft404.test.mjs 必須失敗
 *   J. contentChecks 的主機層宣告（JSON pointer、子網域的 API、deadStatus、missingTitles）→ link-health.test.mjs、
 *      missing-titles.test.mjs 或 check-external-links.test.mjs 必須失敗
 *
 * C 是為了守住兩個「看起來對、其實已經退化」的方向：擷取規則被放寬之後會把
 * 檔名當網域（噪音），或被收緊之後悄悄漏掉真的網域（失明）。特別是
 * screenBareDomains 一旦改用「解析得到才算網域」，已經停用的網域就會被當成
 * 「不是網域」丟掉，檢查器對它唯一該偵測的目標永久失明，而所有測試照樣全綠。
 *
 * B 到 J 九段是刻意做的突變測試：拿掉一段防護或規則之後，如果測試還是綠的，
 * 那些測試就是裝飾品。#72 的起因正是「lychee 看起來有在檢查、實際一個連結都沒驗」，
 * 同一類假象在自己的測試上也會發生。
 *
 * 一律在副本上動手：政策與盤點寫進暫存目錄，程式碼複製到 scripts-faultcheck-N/。
 * 原始檔案在結構上就不可能被改壞，而不是靠還原邏輯寫得夠好。
 *
 * 執行：  npm run test:link-faults
 */

import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const TMP = path.join(ROOT, '.faultcheck');
const SCRIPTS = path.join(ROOT, 'scripts');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const realPolicy = JSON.parse(readFileSync(path.join(SCRIPTS, 'link-policy.json'), 'utf8'));
// entries 與 contentChecks 用固定的測資：正式名單可能一筆都不剩，規則仍要有東西可以破壞。hijacked 用正式名單。
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
    contentChecks: [
        {
            match: { host: 'spa.example.org' },
            reason: '故障注入的測資：前端殼對任何路徑都回 200。',
            evidence: '故障注入的測資：內容由 /api/item 載入。',
            owner: 'link-faults',
            expires: fixtureExpires,
            urls: [{ url: 'https://spa.example.org/item?id=1', api: 'https://spa.example.org/api/item?id=1', expect: { id: 1 } }],
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
        { url: 'https://spa.example.org/item?id=1', occurrences: [{ file: 's.html', location: 'a[href]' }] },
        { url: 'https://spa.example.org/', occurrences: [{ file: 's.html', location: 'a[href]' }] },
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
    // contentChecks 宣告的主機上，網址都要有內容檢查。
    {
        name: '內容檢查的主機上多了一個沒有內容檢查的網址',
        expect: /對任何路徑都回 200/,
        inventory: () => ({
            ...baselineInventory,
            urls: [...baselineInventory.urls, { url: 'https://spa.example.org/item?id=2', occurrences: [{ file: 'new.html', location: 'a[href]' }] }],
        }),
    },
    {
        name: '內容檢查的網址已經從網站上消失（殭屍條目）',
        expect: /找不到，請刪除這一筆網址/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].urls[0].url = 'https://spa.example.org/item?id=9'; p.contentChecks[0].urls[0].api = 'https://spa.example.org/api/item?id=9'; return p; },
    },
    {
        name: '內容檢查的主機已經從網站上消失（殭屍條目）',
        expect: /找不到這台主機/,
        policy: () => { const p = clonePolicy(); p.contentChecks.push({ ...p.contentChecks[0], match: { host: 'gone.example.org' }, urls: [] }); return p; },
    },
    {
        name: '內容檢查的 API 指到別的網站',
        expect: /或它的子網域上/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].urls[0].api = 'https://collector.example.net/api/item?id=1'; return p; },
    },
    {
        name: '內容檢查的 API 用 http',
        expect: /https/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].urls[0].api = 'http://spa.example.org/api/item?id=1'; return p; },
    },
    {
        name: '內容檢查的 API 指向雲端 metadata',
        expect: /位址政策/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].urls[0].api = 'https://169.254.169.254/latest/meta-data/'; return p; },
    },
    {
        name: '內容檢查的 expect 是空物件（什麼都不比也算健康）',
        expect: /expect/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].urls[0].expect = {}; return p; },
    },
    {
        name: '內容檢查的 deadStatus 列了 5xx',
        expect: /deadStatus/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].urls[0].deadStatus = [500]; return p; },
    },
    {
        name: '內容檢查的 missingTitles 是空陣列（宣告了等於沒宣告，網址卻不必寫 API）',
        expect: /missingTitles/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].missingTitles = []; return p; },
    },
    {
        name: 'missingTitles 的主機上多了一個路徑是首頁、帶查詢字串的網址',
        expect: /路徑是首頁、又帶查詢字串，標題檢查不看它/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].missingTitles = ['首頁']; return p; },
        inventory: () => ({
            ...baselineInventory,
            urls: [...baselineInventory.urls, { url: 'https://spa.example.org/index.php?id=5', occurrences: [{ file: 'new.html', location: 'a[href]' }] }],
        }),
    },
    {
        name: '內容檢查過期',
        expect: /到期/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].expires = yesterday; return p; },
    },
    {
        name: '內容檢查沒有 evidence',
        expect: /evidence/,
        policy: () => { const p = clonePolicy(); delete p.contentChecks[0].evidence; return p; },
    },
    {
        name: '內容檢查的主機同時列在 hijacked',
        expect: /列在 hijacked/,
        policy: () => { const p = clonePolicy(); p.contentChecks[0].match.host = p.hijacked[0].match.host; p.contentChecks[0].urls = []; return p; },
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

// B 段是 SSRF 防護、讀 body、JS 轉址與無法判定分組的突變測試：每一項都把其中一段拿掉或改掉，
// 然後跑 link-health.test.mjs。測試必須失敗。
const guardMutations = [
    {
        name: '沒到上限就斷線的回應不另外標 bodyAborted',
        apply: (s) => s.replace('                        ...(!complete && read < wantBody ? { bodyAborted: true } : {}),\n', ''),
    },
    {
        name: '剛好讀到上限的回應也標 bodyAborted',
        apply: (s) => s.replace('!complete && read < wantBody ?', '!complete && read <= wantBody ?'),
    },
    {
        name: '重試的結果沒留第一次的結果（503 之後回 {} 就判失效）',
        apply: (s) => s.replace('{ ...(await probeWithin(urls[i])), previous: first }', 'await probeWithin(urls[i])'),
    },
    {
        name: 'probe 沒把 bodyAborted 傳出去',
        apply: (s) => s.replace('            ...(r.bodyAborted ? { bodyAborted: true } : {}),\n', ''),
    },
    {
        name: '預算用完只看 Date.now（被預算中止的探測回來後又起跑下一筆）',
        apply: (s) => s.replace('const outOfBudget = () => globalAbort.signal.aborted || Date.now() >= budgetEnd;', 'const outOfBudget = () => Date.now() >= budgetEnd;'),
    },
    {
        name: '單筆逾時又截到剩餘預算（比全域 abort 早觸發時又起跑下一筆）',
        apply: (s) => s.replace('AbortSignal.timeout(timeoutMs)]', 'AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, budgetEnd - Date.now())))]'),
    },
    {
        name: '預算用完沒重試的結果不標 retrySkipped',
        apply: (s) => s.replace('outOfBudget() ? { ...first, retrySkipped: true } :', 'outOfBudget() ? first :'),
    },
    {
        name: 'runProbes 不看 retryIf（內容 API 回 {} 不重打）',
        apply: (s) => s.replace('const retryIf = opts.retryIf ?? isDeadResult;', 'const retryIf = isDeadResult;'),
    },
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
        name: '釘選位址的 lookup 改回同步回呼（每個位址都同步連線失敗時，https 的 socket error 沒人接）',
        apply: (s) => s.replace('lookup: (_hostname, lookupOpts, cb) => setImmediate(() => {', 'lookup: (_hostname, lookupOpts, cb) => ((f) => f())(() => {'),
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
        name: 'JS 轉址那一跳沒有標成 js（報告看不出經過 JS 轉址）',
        apply: (s) => s.replace("...(js ? { via: 'js' } : {})", '...{}'),
    },
    {
        name: 'JS 目的頁失敗時不回傳殼本身的結果（訊號 C 跟著消失）',
        apply: (s) => s.replace('const settle = (res) => (shell && !(res.status >= 200 && res.status < 400) ? shell : res);', 'const settle = (res) => res;'),
    },
    {
        name: 'JS 轉址不限 2xx（404 的殼也被跟走）',
        apply: (s) => s.replace('const js = r.status >= 200 && r.status < 300 && r.bodyHead !== undefined', 'const js = r.bodyHead !== undefined'),
    },
    {
        name: 'JS 轉址沒有拿到 bodyTruncated（只讀到前綴的殼也跟）',
        apply: (s) => s.replace('jsRedirectTarget(url.href, r.bodyHead, r.bodyTruncated === true, String(rawUrl))', 'jsRedirectTarget(url.href, r.bodyHead, false, String(rawUrl))'),
    },
    {
        name: 'JS 轉址那一跳跳過靜態政策（帶帳密的目標也連）',
        apply: (s) => s.replace('const statik = staticUrlPolicy(current, opts);', "const statik = chain.at(-1)?.via === 'js' ? { ok: true, url: new URL(current) } : staticUrlPolicy(current, opts);"),
    },
    {
        name: 'JS 轉址不看盤點的起點（probe 沒把 rawUrl 傳進去）',
        apply: (s) => s.replace(', r.bodyTruncated === true, String(rawUrl))', ', r.bodyTruncated === true)'),
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

// 突變之間互不相干，同時跑幾支。每支用自己的 scripts-faultcheck-N 目錄，和 scripts 同一層：
// 測試用相對路徑找 repo 根目錄與 .github。
const PARALLEL = Math.min(4, os.availableParallelism());
const execFileAsync = promisify(execFile);
const testPasses = async (dir, testFile) => {
    try {
        await execFileAsync(process.execPath, ['--test', path.join(dir, testFile)], { encoding: 'utf8' });
        return true;
    } catch {
        return false;
    }
};

/**
 * runMutants 把 mutations 一條一條套在 scripts/file 的副本上，跑 tests，有一支紅就算擋下，照原來的順序印結果。
 * 換行先正規化成 LF：這個 repo 的檔案在 Windows 上是 CRLF，mutation 的比對字串用 LF 寫，不正規化的話跨行比對
 * 會靜默失敗（replace 找不到就原樣回傳），在 Windows 上等於沒測到，在 Linux CI 上卻是綠的。
 */
async function runMutants(title, file, mutations, tests, survived) {
    console.log(`\n${title}`);
    const source = readFileSync(path.join(SCRIPTS, file), 'utf8').split(/\r?\n/).join('\n');
    const verdicts = new Array(mutations.length);
    let next = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async (_, slot) => {
        const dir = path.join(ROOT, `scripts-faultcheck-${slot}`);
        while (next < mutations.length) {
            const i = next++;
            const mutated = mutations[i].apply(source);
            if (mutated === source) {
                verdicts[i] = '注入未生效（replace 沒有改到任何東西，多半是原文改了，請更新這一條）';
                continue;
            }
            rmSync(dir, { recursive: true, force: true });
            cpSync(SCRIPTS, dir, { recursive: true });
            writeFileSync(path.join(dir, file), mutated, 'utf8');
            let caught = false;
            for (const t of tests) if (!caught && !(await testPasses(dir, t))) caught = true;
            verdicts[i] = caught ? null : survived;
            rmSync(dir, { recursive: true, force: true });
        }
    }));
    mutations.forEach((m, i) => (verdicts[i] ? bad(m.name, verdicts[i]) : ok(m.name)));
}

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
        name: 'JS 轉址不看同一台主機（hmun.org 那種轉回自己的殼會被跟下去）',
        apply: (s) => s.replace("if (url.protocol !== 'https:' || url.search || url.hash || from === to) return null;", "if (url.protocol !== 'https:' || url.search || url.hash) return null;"),
    },
    {
        name: 'JS 轉址不看查詢字串（帶追蹤或簽章參數的殼會被跟下去）',
        apply: (s) => s.replace("url.protocol !== 'https:' || url.search || url.hash ||", "url.protocol !== 'https:' || url.hash ||"),
    },
    {
        name: 'JS 轉址不看可註冊網域（轉去別的組織的網域也跟）',
        apply: (s) => s.replace('return domain && domain === registrableDomain(from) && domain === registrableDomain(to) ? url.href : null;', 'return url.href;'),
    },
    {
        name: '可註冊網域一律取最後兩段（a.edu.tw 與 b.edu.tw 被當成同一個網域）',
        apply: (s) => s.replace("labels.at(-2).length <= 3 ? 3 : 2", 'false ? 3 : 2'),
    },
    {
        name: 'JS 轉址不要求每一處都是同一個寫死的網址',
        apply: (s) => s.replace('if (targets.length === 0 || targets.length !== sinks.length || new Set(targets).size !== 1) return null;', 'if (targets.length === 0) return null;'),
    },
    {
        name: 'JS 轉址連 http 的目標也跟',
        apply: (s) => s.replace('(https:\\\\/\\\\/[^', '(https?:\\\\/\\\\/[^').replace("if (url.protocol !== 'https:' || url.search", 'if (url.search'),
    },
    {
        name: 'JS 轉址的字面網址後面不檢查接什麼（接 <、換行接運算子都會被當成語句結束）',
        apply: (s) => s.replace("(?=\\\\s*(?:[;)}]|<\\\\/script\\\\b|$))`, 'g')", "`, 'g')"),
    },
    {
        name: 'JS 轉址不看頁面裡別的 location 寫法',
        apply: (s) => s.replace(' || OTHER_LOCATION.test(bodyHead)) return null;', ') return null;'),
    },
    {
        name: 'JS 轉址的寫法不分大小寫',
        apply: (s) => s.replace("location\\s*=(?!=)/g;", "location\\s*=(?!=)/gi;").replace("\\1(?=\\\\s*(?:[;)}]|<\\\\/script\\\\b|$))`, 'g')", "\\1(?=\\\\s*(?:[;)}]|<\\\\/script\\\\b|$))`, 'gi')"),
    },
    {
        name: 'JS 轉址用頁面網址當 base（//host 這種目標也跟）',
        apply: (s) => s.replace('(https:\\\\/\\\\/[^', '((?:https:)?\\\\/\\\\/[^').replace('url = new URL(targets[0]);', 'url = new URL(targets[0], pageUrl);'),
    },
    {
        name: 'JS 轉址不看盤點的起點（起點 302 到別的網域，那裡的殼轉到自己的 www 也跟）',
        apply: (s) => s.replace('const domain = registrableDomain(host(startUrl));', 'const domain = registrableDomain(from);'),
    },
    {
        name: '共用主機的後綴清單失效（github.io 底下不同使用者的站被當成同一個網域）',
        apply: (s) => s.replace('if (SHARED_SUFFIXES.some(', 'if (false && SHARED_SUFFIXES.some('),
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
                '/^<title[^>]*>([\\s\\S]*?)<\\/title',
                '/^<title[^>]*>([\\s\\S]{0,300}?)<\\/title',
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
        name: '內容 API 的 expect 比對永遠成立',
        apply: (s) => s.replace('        if (got.found && got.value === want) continue;', '        continue;'),
    },
    {
        name: '報告不寫內容 API 那一行',
        apply: (s) => s.replace('    lines.push(\n        `- 內容 API 檢查 ${content.checked} 筆', '    if (false) lines.push(\n        `- 內容 API 檢查 ${content.checked} 筆'),
    },
    {
        name: '欄位對不上算失效（網站改了格式也誤報）',
        apply: (s) => s.replace('        return unverified(`回應格式變了：', '        return { verdict: \'dead\', reason: \'x\' }; return unverified(`回應格式變了：'),
    },
    {
        name: '內容 API 被位址政策擋下時不寫「內容 API」',
        apply: (s) => s.replace('    if (isBlockedResult(r)) return unverified(`被位址政策擋下：${r.reason}`, true);', '    if (isBlockedResult(r)) return { verdict: \'unverified\', bucket: \'other\', notify: true, reason: r.reason };'),
    },
    {
        name: '內容 API 被位址政策擋下時不通知',
        apply: (s) => s.replace('    if (isBlockedResult(r)) return unverified(`被位址政策擋下：${r.reason}`, true);', '    if (isBlockedResult(r)) return unverified(`被位址政策擋下：${r.reason}`, false);'),
    },
    {
        name: 'contentRetry 不重打（403、維護頁只看一次就通知）',
        apply: (s) => s.replace('export function contentRetry(r) {\n', 'export function contentRetry(r) {\n    if (r) return false;\n'),
    },
    {
        name: 'contentRetry 把沒讀完的回應當成讀完',
        apply: (s) => s.replace('    const read = r.status >= 200 && r.status < 300 && !r.bodyTruncated && !r.bodySkipped;', '    const read = r.status >= 200 && r.status < 300 && !r.bodySkipped;'),
    },
    {
        name: '中途斷線算成回應超過讀取上限並通知',
        apply: (s) => s.replace('    if (r.bodyAborted) return unverified(\'回應沒有收完，連線中途斷了\', false, \'unreachable\');\n', ''),
    },
    {
        name: '預算用完沒重打的 {} 照樣判失效',
        apply: (s) => s.replace('        if (r.retrySkipped) return unverified(\'回 {}，時間預算用完，沒有重打確認\', false);\n', ''),
    },
    {
        name: '前一次不是 {}、重打回 {} 也判失效',
        apply: (s) => s.replace('        if (!isEmptyObject(r.previous)) return unverified(', '        if (false) return unverified('),
    },
    {
        name: '沒有重打過的 {} 判失效',
        apply: (s) => s.replace("        if (!r.previous) return unverified('回 {}，沒有重打確認', false);\n", ''),
    },
    {
        name: '前一次是 404 的 {} 也算 {}（判斷前一次不看狀態碼）',
        apply: (s) => s.replace('    const read = r.status >= 200 && r.status < 300 && !r.bodyTruncated && !r.bodySkipped;', '    const read = !r.bodyTruncated && !r.bodySkipped;'),
    },
    {
        name: 'expect 只比第一個欄位',
        apply: (s) => s.replace('        return unverified(`回應格式變了：${key}', '        if (key !== Object.keys(entry.expect)[0]) continue;\n        return unverified(`回應格式變了：${key}'),
    },
    {
        name: 'API 最後停在 3xx 也通知',
        apply: (s) => s.replace('r.status >= 400 && r.status < 500 && r.status !== 429', 'r.status >= 300 && r.status < 500 && r.status !== 429'),
    },
    {
        name: '只有一次 {} 也通知',
        apply: (s) => s.replace('前一次不是 {}（${judgeContent(entry, r.previous).reason}）`, false)', '前一次不是 {}（${judgeContent(entry, r.previous).reason}）`, true)'),
    },
    {
        name: '開頭有 BOM 的 JSON 算成不是 JSON',
        apply: (s) => s.replace("JSON.parse((text ?? '').replace(/^\\uFEFF/, ''))", "JSON.parse(text ?? '')"),
    },
    {
        name: 'API 回 400 不通知',
        apply: (s) => s.replace('r.status >= 400 && r.status < 500 && r.status !== 429', 'r.status > 400 && r.status < 500 && r.status !== 429'),
    },
    {
        name: '例外壓得下內容 API 驗不到（內容檢查壞了也不通知）',
        apply: (s) => s.replace("    if (c) return { bin: 'contentUnverified', item: { ...item, notify: c.notify }, signal, content, title };\n    const policy = matchPolicy(entries, target.url);\n    if (policy) return { bin: 'suppressed', item: { ...item, policy }, signal, content, title };\n",
            "    const policy = matchPolicy(entries, target.url);\n    if (policy) return { bin: 'suppressed', item: { ...item, policy }, signal, content, title };\n    if (c) return { bin: 'contentUnverified', item: { ...item, notify: c.notify }, signal, content, title };\n"),
    },
    {
        name: '週報沒指到 link-policy.json 的 reason',
        apply: (s) => s.replace('。怎麼在連得到的機器上檢查，見 scripts/link-policy.json 裡這些主機的 reason', ''),
    },
    {
        name: 'content-encoding 的值不經 inertText、不截短',
        apply: (s) => s.replace('${inertText(String(r.bodySkipped).slice(0, 60))}', '${r.bodySkipped}'),
    },
    {
        name: 'expect 的鍵用 in 判斷欄位在不在（鍵是 constructor 時取到原型鏈上的函式）',
        apply: (s) => s.replace("    if (!key.startsWith('/')) return Object.hasOwn(data, key)", "    if (!key.startsWith('/')) return key in data"),
    },
    {
        name: '回應的值不截短',
        apply: (s) => s.replace('inertText(JSON.stringify(v).slice(0, 80))', 'inertText(JSON.stringify(v))'),
    },
    {
        name: '頁面驗不到、沒打 API 的網址沒列出來',
        apply: (s) => s.replace('content.pageUnverified.push(targets[i].url);', 'void 0;'),
    },
    {
        name: '內容 API 的讀取上限改成頁首的 16KB',
        apply: (s) => s.replace('readBodyBytes: 256 * 1024', 'readBodyBytes: 16 * 1024'),
    },
    {
        name: '內容 API 的時間預算改成 runProbes 的預設',
        apply: (s) => s.replace('budgetMs: 2 * 60_000, readBodyBytes', 'budgetMs: 8 * 60_000, readBodyBytes'),
    },
    {
        name: '內容 API 不重打',
        apply: (s) => s.replace('retryIf: contentRetry });', '});'),
    },
    {
        name: 'judgeUrl 只在頁面回 2xx 時看 API（停在 3xx 的頁面不檢查內容）',
        apply: (s) => s.replace("    const check = classifyLink(r) === 'healthy' ? matchContentCheck(", "    const check = r.status >= 200 && r.status < 300 ? matchContentCheck("),
    },
    {
        name: '內容 API 不是 2xx 也去解析',
        apply: (s) => s.replace('    if (!(r.status >= 200 && r.status < 300)) {\n        return unverified(describeResult(r), r.status >= 400 && r.status < 500 && r.status !== 429, unverifiedBucket(r));\n    }\n', ''),
    },
    {
        name: '內容 API 沒讀完的回應照樣解析',
        apply: (s) => s.replace('    if (r.bodyTruncated) return unverified(\'回應超過讀取上限\', true);\n', ''),
    },
    {
        name: '內容 API 驗不到的混進一般的無法判定（不通知）',
        apply: (s) => s.replace('    if (c) return { bin: \'contentUnverified\',', '    if (false) return { bin: \'contentUnverified\','),
    },
    {
        name: '內容 API 回的值不經 inertText（遠端字串直接進 issue）',
        apply: (s) => s.replace('    return `是 ${inertText(JSON.stringify(v).slice(0, 80))}`;', '    return `是 ${JSON.stringify(v).slice(0, 80)}`;'),
    },
    {
        name: '分組用 item 算（item 沒有 status 與 code，全部落到其他）',
        apply: (s) => s.replace('bucket: unverifiedBucket(r) }, signal, content, title };', 'bucket: unverifiedBucket(item) }, signal, content, title };'),
    },
    {
        name: '盤點網址的接管命中放進例外那一段',
        apply: (s) => s.replace('const urlBins = { blocked, hijacked: hijackedHits, dead,', 'const urlBins = { blocked, hijacked: suppressed, dead,'),
    },
    {
        name: '回應的物件照樣 stringify（很深的巢狀結構讓整支健檢當掉）',
        apply: (s) => s.replace('    if (typeof v === \'object\') return Array.isArray(v) ? \'是陣列\' : \'是物件\';\n', ''),
    },
    {
        name: '內容 API 回 4xx 不通知',
        apply: (s) => s.replace('r.status >= 400 && r.status < 500 && r.status !== 429', 'false'),
    },
    {
        name: '內容 API 回 5xx 也通知',
        apply: (s) => s.replace('r.status >= 400 && r.status < 500 && r.status !== 429', 'r.status >= 400'),
    },
    {
        name: '內容 API 回的不是 JSON 不通知',
        apply: (s) => s.replace('unverified(\'回應不是 JSON\', true)', 'unverified(\'回應不是 JSON\', false)'),
    },
    {
        name: '內容 API 的格式變了不通知',
        apply: (s) => s.replace('${describeValue(got)}`, true)', '${describeValue(got)}`, false)'),
    },
    {
        name: 'needsAttention 不看內容 API 驗不到的',
        apply: (s) => s.replace('        contentUnverified.some((u) => u.notify) ||\n', ''),
    },
    {
        name: '報告不寫內容 API 驗不到那一段',
        apply: (s) => s.replace('    if (contentUnverified.length) {\n        lines.push(`### 🧩', '    if (false) {\n        lines.push(`### 🧩'),
    },
    {
        name: '報告的無法判定不算內容 API 驗不到的',
        apply: (s) => s.replace('無法判定 ${unverified.length + contentUnverified.length + soft404Unverified.length}、', '無法判定 ${unverified.length + soft404Unverified.length}、'),
    },
    {
        name: 'judgeUrl 不看內容檢查（前端殼永遠算健康）',
        apply: (s) => s.replace('    const check = classifyLink(r) === \'healthy\' ? matchContentCheck(contentChecks, target.url) : null;', '    const check = matchContentCheck([], target.url);'),
    },
    {
        name: 'judgeUrl 頁面失效時也看內容 API（404 被 API 蓋過）',
        apply: (s) => s.replace('    const check = classifyLink(r) === \'healthy\' ? matchContentCheck(contentChecks, target.url) : null;', '    const check = matchContentCheck(contentChecks, target.url);'),
    },
    {
        name: '到期提醒沒算內容檢查',
        apply: (s) => s.replace('        ...expiringWithin(contentChecks, todayISO, EXPIRY_NOTICE_DAYS).map((e) => ({ ...e, list: \'內容檢查\' })),\n', ''),
    },
    {
        name: 'contentProbeTargets 不看頁面是否健康',
        apply: (s) => s.replace('results[index] && classifyLink(results[index]) === \'healthy\' ? matchContentCheck', 'results[index] ? matchContentCheck'),
    },
    {
        name: "盤點網址的接管比對被拿掉（被接管的網域回 200，算成健康）",
        apply: (s) => s.replace("    if (hijack || hop) {", "    if (false) {"),
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
        apply: (s) => s.replace("    if (verdict === 'dead') return { bin: 'dead', item, signal, content, title };", "    if (verdict === 'dead' && !matchPolicy(entries, target.url)) return { bin: 'dead', item, signal, content, title };"),
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
        apply: (s) => s.replace("        hijackedHits.some((h) => h.source === 'url') ||\n", ""),
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
        apply: (s) => s.replace("if (!attention && !unverified.length", "if (!unverified.length"),
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
        apply: (s) => s.replace("    if (urlSkipped || soft404Run.randomsSkipped || titleRandomsSkipped(titleRun)) {\n        lines.push(", "    if (false) {\n        lines.push("),
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
    {
        name: "盤點網址的接管命中標成 bare（直接連到也不通知）",
        apply: (s) => s.replace("policy: hijack ?? hop.policy, source: 'url'", "policy: hijack ?? hop.policy, source: 'bare'"),
    },
    {
        name: "裸網域的接管命中標成 url（回到每週通知）",
        apply: (s) => s.replace("policy: hijack, source: 'bare' }", "policy: hijack, source: 'url' }"),
    },
    {
        name: "needsAttention 改回所有接管命中都通知",
        apply: (s) => s.replace("hijackedHits.some((h) => h.source === 'url')", "hijackedHits.length > 0"),
    },
    {
        name: "列出接管主機時仍寫「全部外部連結正常」",
        apply: (s) => s.replace(" && !bareOther.length && !hijackedHits.length) {", " && !bareOther.length) {"),
    },
    {
        name: "報告的來源標籤對調",
        apply: (s) => s.replace("h.source === 'bare' ? '說明文字裡的裸網域（本身不觸發通知）'", "h.source !== 'bare' ? '說明文字裡的裸網域（本身不觸發通知）'"),
    },
    {
        name: "轉址鏈命中被忽略（只比起點）",
        apply: (s) => s.replace("    if (hijack || hop) {", "    if (hijack) {"),
    },
    {
        name: "轉址鏈命中標成 bare（不通知）",
        apply: (s) => s.replace("source: 'url', via: hop?.url", "source: hop ? 'bare' : 'url', via: hop?.url"),
    },
    {
        name: "轉址鏈拿例外名單比對（永遠比不到）",
        apply: (s) => s.replace("matchHijackedHop(hijacked, r)", "matchHijackedHop(entries, r)"),
    },
    {
        name: "「轉址經過」不經 inertText（接管主機給的網址在 issue 裡點得到）",
        apply: (s) => s.replace("轉址經過：${inertText(h.via)}", "轉址經過：${h.via}"),
    },
];

// F 段是 buildReport 的突變測試：把探測結果分進各段、算覆蓋與通知條件，再交給報告、GITHUB_OUTPUT 與主控台。
// judgeUrl、renderReport 各自都對，這裡傳錯一個值，週報照樣會錯。
const assemblyMutations = [
    {
        name: '內容 API 驗不到的沒交給報告',
        apply: (s) => s.replace('        content,\n        contentUnverified,\n', '        content,\n'),
    },
    {
        name: 'judgeUrl 沒拿到內容 API 的結果',
        apply: (s) => s.replace('judgeUrl(targets[i], r, policy, contentResults[i],', 'judgeUrl(targets[i], r, policy, undefined,'),
    },
    {
        name: '覆蓋不看沒有結果的內容 API',
        apply: (s) => s.replace(' && content.skipped === 0', ''),
    },
    {
        name: '沒有結果的內容 API 不算未檢查',
        apply: (s) => s.replace('            if (!contentResults[i]) content.skipped++;\n', ''),
    },
    {
        name: '到期提醒沒拿到內容檢查',
        apply: (s) => s.replace('todayISO, policy.contentChecks)', 'todayISO)'),
    },
    {
        name: "judgeUrl 拿到空的接管名單（盤點網址的接管命中算成健康）",
        apply: (s) => s.replace("judgeUrl(targets[i], r, policy, contentResults[i],", "judgeUrl(targets[i], r, { ...policy, hijacked: [] }, contentResults[i],"),
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
        apply: (s) => s.replace("        if (signal) autoSignals.push(signal);\n        if (judged.hint)", "        if (judged.hint)"),
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
        apply: (s) => s.replace(" && screen.unresolved.length === 0 &&", " &&"),
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
        apply: (s) => s.replace("expiringPolicyItems(policy.entries, policy.hijacked, todayISO, policy.contentChecks)", "expiringPolicyItems(policy.entries, [], todayISO, policy.contentChecks)"),
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
    {
        name: "主控台的接管主機那行不分來源（盤點的網址算成全部）",
        apply: (s) => s.replace("（盤點的網址 ${hijackedHits.filter((h) => h.source === 'url').length}）", "（盤點的網址 ${hijackedHits.length}）"),
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
    {
        name: "matchHijackedHop 永遠回 null（轉址到接管主機的連結被算成健康）",
        apply: (s) => s.replace("export function matchHijackedHop(hijacked, r) {", "export function matchHijackedHop(hijacked, r) {\n    if (true) return null;"),
    },
    {
        name: 'matchContentCheck 不正規化網址（帶 fragment 的網址比不到，內容檢查靜靜跳過）',
        apply: (s) => s.replace('    const normalized = normalizeUrl(url);\n    for (const check of contentChecks ?? []) {', '    const normalized = url;\n    for (const check of contentChecks ?? []) {'),
    },
    {
        name: 'contentCheckGaps 不列任何網址（新加的網址沒有內容檢查也通過）',
        apply: (s) => s.replace('        gaps.push({ url, check });', ''),
    },
    {
        name: 'contentCheckGaps 把帶查詢字串的首頁也當成首頁放過',
        apply: (s) => s.replace("(u.pathname === '/' && !u.search)", "u.pathname === '/'"),
    },
    {
        name: 'contentCheckGaps 把只有一層路徑的網址當成首頁放過',
        apply: (s) => s.replace("(u.pathname === '/' && !u.search)", "(u.pathname.split('/').length <= 2 && !u.search)"),
    },
    {
        name: '內容檢查的 match 可以多帶其他欄位',
        apply: (s) => s.replace("Object.keys(e.match).join() !== 'host'", '!e.match.host'),
    },
    {
        name: '內容檢查的 API 不看主機（政策檔可以把請求送到別的網站）',
        apply: (s) => s.replace("    else if (host && site && !underSite(verdict.url.hostname, host)) why =", '    else if (false) why ='),
    },
    {
        name: 'expect 的值不限型別（物件、null 也收）',
        apply: (s) => s.replace('if (!values.length || !values.every(scalar)) {', 'if (!values.length) {'),
    },
    {
        name: '內容檢查的 API 可以帶埠號',
        apply: (s) => s.replace(' && new URL(u.api).port) push(', ' && false) push('),
    },
    {
        name: 'expect 的鍵可以含「.」（想比巢狀欄位的人靜靜比不到）',
        apply: (s) => s.replace("} else if (key.includes('.')) {", '} else if (false) {'),
    },
    {
        name: 'contentCheckGaps 只看 https 的網址',
        apply: (s) => s.replace('        const check = (contentChecks ?? []).find(', "        if (u.protocol !== 'https:') continue;\n        const check = (contentChecks ?? []).find("),
    },
    {
        name: '寫錯的內容檢查照樣回傳出去',
        apply: (s) => s.replace('        if (host && errors.length === errorsBefore) out.push', '        if (host) out.push'),
    },
];

// I 段是軟 404 的突變測試。規則放寬會把好網址判成失效，收緊會漏掉 collego、coursemap 這類網站，
// 隨機路徑或重打的處理改壞時，逾時、5xx、兩次落點不同的結果會被當成證據。
const soft404Mutations = [
    {
        name: '比對落點時去掉查詢字串（iymc 的語系頁、hch 的分頁會誤判）',
        apply: (s) => s.replace("${u.search ? swap(u.search) : ''}", ''),
    },
    {
        name: '隨機路徑落在防火牆頁也拿來比',
        apply: (s) => s.replace(' && !CHALLENGE_TITLE.test(f.title);', ';'),
    },
    {
        name: '隨機路徑的可見文字很少也拿來比（驗證頁）',
        apply: (s) => s.replace('f.visible >= MIN_VISIBLE &&', ''),
    },
    {
        name: '隨機路徑沒有轉址也拿來比',
        apply: (s) => s.replace('if (!ok2(random) || !redirected(random)) return false;', 'if (!ok2(random)) return false;'),
    },
    {
        name: '網址沒有轉址也套第 4 條',
        apply: (s) => s.replace('if (redirected(r) && comparable(random)', 'if (comparable(random)'),
    },
    {
        name: '隨機路徑一律打根目錄',
        apply: (s) => s.replace("parts[parts[last] === '' && last > 1 ? last - 1 : last] = token;", "parts.splice(1, parts.length - 1, token);"),
    },
    {
        name: '第 1 條不看是否轉址',
        apply: (s) => s.replace('if (redirected(r) && ((ERROR_PATH.test(decode(fu.pathname))', 'if (((ERROR_PATH.test(decode(fu.pathname))'),
    },
    {
        name: 'pageFacts 的 h1、canonical 直接看原文',
        apply: (s) => s.replace('    const markup = pageMarkup(html);\n', '    const markup = html;\n'),
    },
    {
        name: '第 3 條不排除落點就是 canonical',
        apply: (s) => s.replace(' && dirPath(fu.pathname) !== dirPath(new URL(f.canonical).pathname)) {', ') {'),
    },
    {
        name: '可見文字的下限從 200 改成 20',
        apply: (s) => s.replace('export const MIN_VISIBLE = 200;', 'export const MIN_VISIBLE = 20;'),
    },
    {
        name: '第 1 條不豁免起點本來就有的錯誤頁那一段',
        apply: (s) => s.replace(' && !fromStart) ||', ') ||'),
    },
    {
        name: '第 1 條只要起點像錯誤頁就豁免',
        apply: (s) => s.replace('errSeg(su.pathname) !== undefined && errSeg(su.pathname) === errSeg(fu.pathname);', 'errSeg(su.pathname) !== undefined;'),
    },
    {
        name: '第 1 條的豁免也套到查詢字串',
        apply: (s) => s.replace('&& !fromStart) || ERROR_PATH.test(decode(fu.search)))', '|| ERROR_PATH.test(decode(fu.search))) && !fromStart)').replace('if (redirected(r) && ((ERROR_PATH', 'if (redirected(r) && (((ERROR_PATH'),
    },
    {
        name: '標題的 404 不看前面接什麼（課號、房號也算）',
        apply: (s) => s.replace('const ERROR_TITLE = /(?:^|[^\\w\\s]\\s*|(?:error|錯誤|status)\\s*[:：]?\\s*)404\\b|', 'const ERROR_TITLE = /\\b404\\b|'),
    },
    {
        name: '標題的 not found 不看前面接什麼',
        apply: (s) => s.replace('|(?:^|[^\\w\\s]\\s*|(?:page|file)\\s+)not\\s*found\\b|', '|not found|'),
    },
    {
        name: '查無不限網頁或頁面',
        apply: (s) => s.replace('查無(?:此|該)?(?:網頁|頁面|頁)', '查無'),
    },
    {
        name: '網頁錯誤不要求代碼',
        apply: (s) => s.replace('網頁錯誤\\s*[:：(（]?\\s*\\d{3}', '網頁錯誤'),
    },
    {
        name: '只寫 Error 的 h1 也算',
        apply: (s) => s.replace('ERROR_TITLE.test(f.h1)', 'ERROR_TITLE.test(f.h1) || ERROR_TITLE_ONLY.test(f.h1)'),
    },
    {
        name: '只寫 Error 的標題不算',
        apply: (s) => s.replace(' || ERROR_TITLE_ONLY.test(f.title)', ''),
    },
    {
        name: '第 2 條的 canonical 指向自己也算錯誤頁',
        apply: (s) => s.replace(' && dirPath(new URL(f.canonical).pathname) !== dirPath(su.pathname)) {', ') {'),
    },
    {
        name: '標題的「找不到」不限網頁或頁面',
        apply: (s) => s.replace('找不到(?:此|該|這個|您要的|你要的)?(?:網頁|頁面)', '找不到'),
    },
    {
        name: '重打只要有任何一條命中就算',
        apply: (s) => s.replace('const sameRules = (a, b) => a.filter((x) => b.some((y) => y.rule === x.rule));', 'const sameRules = (a, b) => (b.length ? a : []);'),
    },
    {
        name: '重打時隨機路徑沒打到，沿用第一次的結果',
        apply: (s) => s.replace('if (!r2 || (reRandom.has(c.random) && !random2)) {', 'if (!r2) {'),
    },
    {
        name: '隨機路徑失敗的數量不算',
        apply: (s) => s.replace('(x.status === 0 || x.status >= 500)', 'false'),
    },
    {
        name: '命中之後不等就重打',
        apply: (s) => s.replace('    await sleep(recheck.delayMs);\n', ''),
    },
    {
        name: '不重打確認，第一次命中就判失效',
        apply: (s) => s.replace('const both = sameRules(judgeSoft404(c.url, r2, random2, token).dead, j.dead);', 'const both = j.dead;'),
    },
    {
        name: '第 4 條重打時不打隨機路徑',
        apply: (s) => s.replace('const againRandoms = [...new Set(hits.filter((h) => h.j.dead.some((d) => d.rule === 4)).map((h) => h.c.random))];', 'const againRandoms = [];'),
    },
    {
        name: '隨機路徑回 404 也重試',
        apply: (s) => s.replace(', retryIf: () => false })', ' })'),
    },
    {
        name: '沒打的隨機路徑不回報',
        apply: (s) => s.replace('return { verdicts, randoms: randomUrls.length, randomsSkipped, randomsFailed, recheckSkipped };', 'return { verdicts, randoms: randomUrls.length, randomsSkipped: 0, randomsFailed, recheckSkipped };'),
    },
    {
        name: '沒重打的網址不回報',
        apply: (s) => s.replace('            recheckSkipped++;\n', ''),
    },
    {
        name: 'hijacked 的主機也套規則',
        apply: (s) => s.replace(' || matchHijacked(policy.hijacked, url) ||', ' ||'),
    },
    {
        name: 'contentChecks 的主機也套規則',
        apply: (s) => s.replace('        if (apiHosts.has(host)) return;\n', ''),
    },
    {
        name: 'missingTitles 的主機也打隨機路徑',
        apply: (s) => s.replace('const needRandom = !titleHosts.has(host) && (', 'const needRandom = ('),
    },
    {
        name: 'missingTitles 的主機不套規則',
        apply: (s) => s.replace("const apiHosts = new Set((policy.contentChecks ?? []).filter((c) => !c.missingTitles)", 'const apiHosts = new Set((policy.contentChecks ?? [])'),
    },
    {
        name: '可見文字很少的網址不打隨機路徑（前端殼看不到）',
        apply: (s) => s.replace('(redirected(r) || Boolean(f?.complete && f.visible < MIN_VISIBLE));', 'redirected(r);'),
    },
    {
        name: '前端殼不看狀態碼（202 的驗證頁被當成殼）',
        apply: (s) => s.replace('if (r.status === 200 && f?.complete', 'if (f?.complete'),
    },
    {
        name: '前端殼不看網址本身是不是驗證頁',
        apply: (s) => s.replace(' && !CHALLENGE_TITLE.test(f.title) && random?.status === 200', ' && random?.status === 200'),
    },
    {
        name: '前端殼不看隨機路徑的狀態碼',
        apply: (s) => s.replace(' && random?.status === 200 && !random.blocked', ' && random && !random.blocked'),
    },
    {
        name: '前端殼不看截斷（只讀到前綴的頁面被當成殼）',
        apply: (s) => s.replace('if (r.status === 200 && f?.complete &&', 'if (r.status === 200 &&'),
    },
    {
        name: '不看 h1',
        apply: (s) => s.replace(' || ERROR_TITLE.test(f.h1)', ''),
    },
    {
        name: 'canonical 不照落點解析（相對網址的 canonical 看不到）',
        apply: (s) => s.replace("new URL(a.href.replace(/&amp;/g, '&'), r.finalUrl)", "new URL(a.href.replace(/&amp;/g, '&'))"),
    },
    {
        name: '帶查詢字串的 canonical 也算上層目錄',
        apply: (s) => s.replace('    if (o.search) return false;\n', ''),
    },
    {
        name: '首頁也套規則',
        apply: (s) => s.replace('if (!ok2(r) || isHome(url) || matchHijacked', 'if (!ok2(r) || matchHijacked'),
    },
];

// 軟 404 在報告裡的分組也在 I 段，測試在 soft404.test.mjs。
const soft404ReportMutations = [
    {
        name: '軟 404 不觸發通知',
        apply: (s) => s.replace('        soft404.length > 0 ||\n', ''),
    },
    {
        name: '主機層的例外也壓得下軟 404',
        apply: (s) => s.replace('matchPolicy(entries.filter((e) => e.match.url !== undefined), target.url)', 'matchPolicy(entries, target.url)'),
    },
    {
        name: '只命中一次的軟 404 算健康',
        apply: (s) => s.replace("if (soft.verdict === 'unverified') return { bin: 'soft404Unverified', item: s, signal, content, title };", ''),
    },
    {
        name: '看標題的網址不用軟 404 的判定',
        apply: (s) => s.replace("if (verdict === 'healthy' && (!c || title) && soft) {", "if (verdict === 'healthy' && !c && soft) {"),
    },
    {
        name: '內容檢查的網址也用軟 404 的判定',
        apply: (s) => s.replace("if (verdict === 'healthy' && (!c || title) && soft) {", "if (verdict === 'healthy' && soft) {"),
    },
    {
        name: '沒打的隨機路徑不算進覆蓋不完整',
        apply: (s) => s.replace('soft404Run.randomsSkipped === 0 && soft404Run.recheckSkipped === 0 && ', ''),
    },
    {
        name: '精確網址的例外也壓得下只命中一次的軟 404',
        apply: (s) => s.replace("const policy = soft.verdict === 'dead' ? matchPolicy", "const policy = soft.verdict !== 'hint' ? matchPolicy"),
    },
    {
        name: '沒重打完的網址不算進覆蓋不完整',
        apply: (s) => s.replace(' && soft404Run.recheckSkipped === 0 && ', ' && '),
    },
    {
        name: '週報的隨機路徑數不扣沒打的',
        apply: (s) => s.replace('const probedRandoms = (run) => run.randoms - run.randomsSkipped;', 'const probedRandoms = (run) => run.randoms;'),
    },
    {
        name: '只有隨機路徑沒打時不出覆蓋不完整一段',
        apply: (s) => s.replace('if (urlSkipped || soft404Run.randomsSkipped || titleRandomsSkipped(titleRun)) {', 'if (urlSkipped || titleRandomsSkipped(titleRun)) {'),
    },
    {
        name: '只命中一次的軟 404 不擋「全部正常」',
        apply: (s) => s.replace(' && !soft404Unverified.length && !bareOther.length', ' && !bareOther.length'),
    },
    {
        name: '主控台的未檢查筆數不算沒重打的網址',
        apply: (s) => s.replace('    const urlSkipped = skipped + bareSkipped + content.skipped + soft404Run.recheckSkipped + titles.skipped;\n    const randomsText', '    const urlSkipped = skipped + bareSkipped + content.skipped + titles.skipped;\n    const randomsText'),
    },
    {
        name: '只有隨機路徑沒打時也寫 0 筆未檢查',
        apply: (s) => s.replace("        urls || !(randoms || titleRandoms) ? `${urls} 筆未檢查` : '',", "        `${urls} 筆未檢查`,"),
    },
    {
        name: '軟 404 的原因不經 inertText（那台主機給的標題在 issue 裡會渲染）',
        apply: (s) => s.replace('lines.push(`  - ${inertText(d.reason)}`);', 'lines.push(`  - ${d.reason}`);'),
    },
];

// H 段是 check-external-links.mjs 的突變測試。主程式讀檔、探測之後把名單交給 buildReport，
// 交錯一份或對錯位置，buildReport 的單元測試照樣全綠。
const mainMutations = [
    {
        name: '內容 API 沒用 CONTENT_PROBE 的設定（不重打、不讀 body、預算不對）',
        apply: (s) => s.replace('{ ...CONTENT_PROBE, probeFn }', '{ probeFn }'),
    },
    {
        name: '內容 API 沒接上重播（改成連網探測）',
        apply: (s) => s.replace('{ ...CONTENT_PROBE, probeFn }', '{ ...CONTENT_PROBE }'),
    },
    {
        name: '內容 API 的探測開了 allowLoopback',
        apply: (s) => s.replace('{ ...CONTENT_PROBE, probeFn }', '{ ...CONTENT_PROBE, probeFn, allowLoopback: true }'),
    },
    {
        name: '重播不檢查轉址的每一跳',
        apply: (s) => s.replace('            if (!next.ok) return blocked(next.reason, hop.to);', '            if (false) return blocked(next.reason, hop.to);'),
    },
    {
        name: '重播的封鎖原因寫成起點的主機',
        apply: (s) => s.replace('${new URL(at).hostname} 解析到被封鎖的位址', '${new URL(url).hostname} 解析到被封鎖的位址'),
    },
    {
        name: '錄製檔沒有 version 也接受',
        apply: (s) => s.replace('    if (rec?.version !== 1) await die(', '    if (rec?.version !== undefined && rec.version !== 1) await die('),
    },
    {
        name: '裸網域的探測不讀 body（訊號 B、C 對裸網域失明）',
        apply: (s) => s.replace('        readBodyBytes: HEAD_BYTES,\n        probeFn,\n    }));', '        probeFn,\n    }));'),
    },
    {
        name: '盤點網址的探測開了 allowLoopback',
        apply: (s) => s.replace('readBodyBytes: HEAD_BYTES, probeFn }', 'readBodyBytes: HEAD_BYTES, probeFn, allowLoopback: true }'),
    },
    {
        name: '裸網域的探測開了 allowLoopback',
        apply: (s) => s.replace('        readBodyBytes: HEAD_BYTES,\n        probeFn,\n    }));', '        readBodyBytes: HEAD_BYTES,\n        probeFn,\n        allowLoopback: true,\n    }));'),
    },
    {
        name: '盤點網址的探測不讀 body（訊號 B、C 看不到東西）',
        apply: (s) => s.replace('readBodyBytes: HEAD_BYTES, probeFn }', 'probeFn }'),
    },
    {
        name: '頁首的讀取上限放大成 64KB',
        apply: (s) => s.replace('const HEAD_BYTES = 16 * 1024;', 'const HEAD_BYTES = 64 * 1024;'),
    },
    {
        name: '重播不套靜態位址政策',
        apply: (s) => s.replace('        if (!statik.ok) return blocked(statik.reason, url);\n', ''),
    },
    {
        name: '重播不看錄下的位址',
        apply: (s) => s.replace('            if (why) return blocked(', '            if (false) return blocked('),
    },
    {
        name: '重播不照讀取上限截斷 body',
        apply: (s) => s.replace("            r.bodyHead = Buffer.from(r.bodyHead).subarray(0, limit).toString('utf8');\n", ''),
    },
    {
        name: '錄製檔的 version 不檢查',
        apply: (s) => s.replace('    if (rec?.version !== 1) await die(', '    if (false) await die('),
    },
    {
        name: '錄製不記 NS 查詢',
        apply: (s) => s.replace('            return (recorded.ns[name] = await baseNs(name));', '            return await baseNs(name);'),
    },
    {
        name: '重播同一個網址永遠回最後一筆',
        apply: (s) => s.replace('list[Math.min(n, list.length - 1)]', 'list[list.length - 1]'),
    },
    {
        name: '錄製只留最後一次探測（重試的結果蓋掉第一次）',
        apply: (s) => s.replace('        recorded.probes[url] = prev === undefined ? r : [].concat(prev, [r]);', '        recorded.probes[url] = r;'),
    },
    {
        name: 'contentChecks 沒交給 buildReport',
        apply: (s) => s.replace('policy: { entries: policyEntries, hijacked: hijackedEntries, contentChecks }', 'policy: { entries: policyEntries, hijacked: hijackedEntries }'),
    },
    {
        name: '內容 API 的結果沒交給 buildReport',
        apply: (s) => s.replace('    contentResults,\n    soft404,', '    soft404,'),
    },
    {
        name: '內容 API 的結果對錯位置',
        apply: (s) => s.replace('contentResults[c.index] = apiResults[k];', 'contentResults[k] = apiResults[k];'),
    },
    {
        name: '交給 buildReport 的盤點換成整份 inventory.urls（--limit 之後名單和探測結果對不上）',
        apply: (s) => s.replace('    targets,\n    results,', '    targets: inventory.urls,\n    results,'),
    },
    {
        name: '例外名單沒交給 buildReport',
        apply: (s) => s.replace('policy: { entries: policyEntries,', 'policy: { entries: [],'),
    },
    {
        name: '接管名單沒交給 buildReport',
        apply: (s) => s.replace('policy: { entries: policyEntries, hijacked: hijackedEntries, contentChecks }', 'policy: { entries: policyEntries, hijacked: [], contentChecks }'),
    },
    {
        name: '裸網域候選沒交給 buildReport（報告找不到出處）',
        apply: (s) => s.replace('    bareCandidates,\n    screen,', '    bareCandidates: [],\n    screen,'),
    },
    {
        name: '篩選結果沒用上（DNS 篩掉的候選也去探測，結果對錯主機）',
        apply: (s) => s.replace('screen.accepted.map(probeUrlFor)', 'bareCandidates.map((h) => probeUrlFor(h.host))'),
    },
    {
        name: '裸網域的探測結果換成盤點網址的',
        apply: (s) => s.replace('    bareResults,\n    bareSkipped,', '    bareResults: results,\n    bareSkipped,'),
    },
    {
        name: '--limit 沒交給 buildReport（只驗幾筆也宣稱完整覆蓋）',
        apply: (s) => s.replace('    limit,\n    inventoryPath', '    limit: 0,\n    inventoryPath'),
    },
    {
        name: 'GITHUB_OUTPUT 沒寫',
        apply: (s) => s.replace('if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, out.githubOutput);', ''),
    },
    {
        name: '致命錯誤時 GITHUB_OUTPUT 寫成不用處理',
        apply: (s) => s.replace("'needs_attention=true\\ncoverage_complete=false\\n'", "'needs_attention=false\\ncoverage_complete=false\\n'"),
    },
    {
        name: '重播沒接到盤點網址的 runProbes（改成連網探測）',
        apply: (s) => s.replace('readBodyBytes: HEAD_BYTES, probeFn }', 'readBodyBytes: HEAD_BYTES }'),
    },
    {
        name: '重播時不用錄製檔記下的隨機字串',
        apply: (s) => s.replace('    randomToken = rec.randomToken ?? randomToken;\n', ''),
    },
    {
        name: '錄製檔沒有記下隨機字串',
        apply: (s) => s.replace('recorded = { version: 1, probes: {}, ns: {}, randomToken };', 'recorded = { version: 1, probes: {}, ns: {} };'),
    },
    {
        name: '軟 404 的結果沒交給 buildReport',
        apply: (s) => s.replace('    soft404,\n    titles,', '    titles,'),
    },
    {
        name: '錄製檔裡沒有的網址當成健康',
        apply: (s) => s.replace("{ status: 0, code: 'EREPLAY', finalUrl: url, redirects: [] }", "{ status: 200, finalUrl: url, redirects: [] }"),
    },
];

// J 段是 contentChecks 主機層宣告的突變測試，宣告寫錯或判定改壞時，內容檢查會靜靜比不到。
const hostPolicyMutations = [
    {
        name: 'expect 的 JSON pointer 不檢查寫法（/a//b 這種比不到的鍵也通過）',
        apply: (s) => s.replace('if (!JSON_POINTER.test(key)) push(', 'if (false) push('),
    },
    {
        name: '內容檢查的 API 只能在同一台主機（api.hahow.in 這種子網域被拒絕）',
        apply: (s) => s.replace('checkPolicyUrl(u.api, `${uat}.api`, host, push, true)', 'checkPolicyUrl(u.api, `${uat}.api`, host, push)'),
    },
    {
        name: 'API 可以在上層網域（a.edu.tw 的 API 寫成 edu.tw）',
        apply: (s) => s.replace('const underSite = (apiHost, host) => apiHost === siteBase(host) || apiHost.endsWith(`.${siteBase(host)}`);', 'const underSite = (apiHost, host) => apiHost === siteBase(host) || apiHost.endsWith(`.${siteBase(host)}`) || siteBase(host).endsWith(`.${apiHost}`);'),
    },
    {
        name: 'API 的主機不去掉 www.（www.hahow.in 配不了 api.hahow.in）',
        apply: (s) => s.replace("    const stripped = host.replace(/^www\\./, '');", '    const stripped = host;'),
    },
    {
        name: 'www. 後面是公共後綴也去掉（www.edu.tw 的 API 可以是任意的 *.edu.tw）',
        apply: (s) => s.replace('    return domain && stripped.endsWith(domain) ? stripped : host;', '    return stripped;'),
    },
    {
        name: 'API 的主機名結尾帶點也通過',
        apply: (s) => s.replace('    else if (site && verdict.url.hostname !== canonicalHost(verdict.url.hostname)) why =', '    else if (false) why ='),
    },
    {
        name: 'deadStatus 不檢查狀態碼（列 500 也通過）',
        apply: (s) => s.replace(' && ds.every(isDeadStatus))', ')'),
    },
    {
        name: 'deadStatus 可以列 429（限流被當成頁面不存在）',
        apply: (s) => s.replace(' && n !== 408 && n !== 429;', ' && n !== 408;'),
    },
    {
        name: 'missingTitles 不檢查空白（多一個空白的標題永遠比不到）',
        apply: (s) => s.replace("typeof t === 'string' && t === normalizeTitle(t)))) {", "typeof t === 'string'))) {"),
    },
    {
        name: '宣告了 missingTitles 的主機，網址照樣要逐筆寫 API',
        apply: (s) => s.replace('        if (check.missingTitles && !(HOME_PATH.test(u.pathname) && u.search)) continue;\n', ''),
    },
    {
        name: 'missingTitles 的主機上，路徑是首頁又帶查詢字串的網址也不必寫 API（標題檢查不看它，沒有任何檢查）',
        apply: (s) => s.replace('if (check.missingTitles && !(HOME_PATH.test(u.pathname) && u.search)) continue;', 'if (check.missingTitles) continue;'),
    },
    {
        name: '內容檢查的網址也只要同站（頁面可以寫在子網域上）',
        apply: (s) => s.replace('function checkPolicyUrl(raw, at, host, push, site = false) {', 'function checkPolicyUrl(raw, at, host, push, site = true) {'),
    },
];
const hostJudgeMutations = [
    {
        name: 'deadStatus 的狀態碼一次就判失效',
        apply: (s) => s.replace("        if (!r.previous) return once('沒有重打確認');\n        if (!deadStatus(r.previous)) return once(", "        if (false) return once("),
    },
    {
        name: 'deadStatus 不看前一次的狀態碼',
        apply: (s) => s.replace('        if (!deadStatus(r.previous)) return once(', '        if (false) return once('),
    },
    {
        name: 'deadStatus 的狀態碼預算用完也判失效',
        apply: (s) => s.replace("        if (r.retrySkipped) return once('時間預算用完，沒有重打確認');\n", ''),
    },
    {
        name: '沒有 deadStatus 的網址，API 連兩次 404 也判失效',
        apply: (s) => s.replace('(entry.deadStatus ?? []).includes(x.status)', '(entry.deadStatus ?? [404]).includes(x.status)'),
    },
    {
        name: 'expect 的 JSON pointer 當成最外層的欄位名',
        apply: (s) => s.replace("    if (!key.startsWith('/')) return Object.hasOwn(data, key)", '    if (true) return Object.hasOwn(data, key)'),
    },
    {
        name: 'JSON pointer 對陣列不看索引的寫法（/list/length 也取得到）',
        apply: (s) => s.replace(' && (!Array.isArray(cur) || /^(0|[1-9]\\d*)$/.test(token))', ''),
    },
    {
        name: 'JSON pointer 先解 ~0 再解 ~1（~01 被解成 /）',
        apply: (s) => s.replace(".map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))", ".map((t) => t.replace(/~0/g, '~').replace(/~1/g, '/'))"),
    },
    {
        name: 'JSON pointer 不解開 ~1',
        apply: (s) => s.replace(".map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))", ".map((t) => t.replace(/~0/g, '~'))"),
    },
    {
        name: 'JSON pointer 取到原型鏈上的欄位',
        apply: (s) => s.replace('&& Object.hasOwn(cur, token);', '&& token in cur;'),
    },
];

// missingTitles 的判定、重讀與隨機路徑。標題讀錯會把好網址判成失效，重讀或隨機路徑改壞時名單過期也看不出來。
const titleMutations = [
    { name: 'pageTitle 不跳過 script、svg 裡的 <title>', apply: (s) => s.replace('const t = rawTitle(r.bodyHead);', 'const t = r.bodyHead.match(/<title\\b[^>]*>([\\s\\S]*?)<\\/title\\s*>/i)?.[1];') },
    { name: '具名參照分大小寫', apply: (s) => s.replace('NAMED[e.toLowerCase()]', 'NAMED[e]') },
    { name: '數字參照不檢查範圍（&#99999999; 丟 RangeError）', apply: (s) => s.replace('return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;', 'return String.fromCodePoint(n);') },
    { name: '不看 Content-Type（PDF、JSON 沒有 <title> 也比 ""）', apply: (s) => s.replace("const isHtml = (r) => /html/i.test(r?.contentType ?? '');", 'const isHtml = () => true;') },
    { name: '不是 HTML 的 2xx 也重讀', apply: (s) => s.replace('export const needsReread = (check, r) => !offList(check, r) && !notHtml(r);', 'export const needsReread = (check, r) => !offList(check, r);') },
    { name: '重讀時不是 HTML 的不另外說明', apply: (s) => s.replace("    if (notHtml(x)) return unverified(", '    if (false) return unverified(') },
    { name: '確認那一輪不用 recheck.budgetMs', apply: (s) => s.replace('{ ...cfg, budgetMs: recheck.budgetMs }', '{ ...cfg, budgetMs: TITLE_RECHECK.budgetMs }') },
    { name: '頁面不健康的網址也打隨機路徑', apply: (s) => s.replace("        if (!check || !r || classifyLink(r) !== 'healthy') return;", '        if (!check) return;') },
    { name: 'pageTitle 把空的回應當成沒有標題', apply: (s) => s.replace(' || !r.bodyHead.trim() || !isHtml(r)) return null;', ' || !isHtml(r)) return null;') },
    { name: '空的回應也判失效', apply: (s) => s.replace("    if (!x.bodyTruncated && !(x.bodyHead ?? '').trim()) return unverified('回應是空的', false);\n", '') },
    { name: '只解開 6 個具名參照', apply: (s) => s.replace("ndash: '–', ", '') },
    { name: 'pageTitle 沒讀完也當成沒有標題（aesea 刪掉的頁面看不到）', apply: (s) => s.replace("return r.bodyTruncated || t === null ? null : '';", "return '';") },
    { name: 'pageTitle 不解開字元參照', apply: (s) => s.replace('return normalizeTitle(decode(t));', 'return normalizeTitle(t);') },
    { name: '16KB 讀不到標題也不重讀', apply: (s) => s.replace('export const needsReread = (check, r) => !offList(check, r) && !notHtml(r);', 'export const needsReread = () => false;') },
    { name: '名單裡的標題一次就判失效', apply: (s) => s.replace("    if (!x.previous) return once('沒有重讀確認');\n    if (!listed(check, x.previous)) return once(", '    if (false) return once(') },
    { name: '不看前一次的標題', apply: (s) => s.replace('    if (!listed(check, x.previous)) return once(', '    if (false) return once(') },
    { name: '讀到上限還沒讀完 <title> 不通知', apply: (s) => s.replace('還沒讀完 <title>`, true)', '還沒讀完 <title>`, false)') },
    { name: '回應被壓縮不通知', apply: (s) => s.replace('沒有解析（${inertText(String(x.bodySkipped).slice(0, 60))}）`, true)', '沒有解析（${inertText(String(x.bodySkipped).slice(0, 60))}）`, false)') },
    { name: '隨機路徑確認時沒再讀到不算沒做完', apply: (s) => s.replace("return { state: 'other', skipped: true, reason: `${describeOnce(check, r)}，不在名單裡，時間預算用完", "return { state: 'other', reason: `${describeOnce(check, r)}，不在名單裡，時間預算用完") },
    { name: '隨機路徑一次不在名單裡就算過期', apply: (s) => s.replace('if (offList(check, r) && offList(check, r.previous)) return', 'if (offList(check, r)) return') },
    { name: '隨機路徑不在名單裡不再讀一次', apply: (s) => s.replace('(randoms.has(urls[k]) ? offList : listed)', '(randoms.has(urls[k]) ? () => false : listed)') },
    { name: '名單裡的網址不再讀一次', apply: (s) => s.replace('(randoms.has(urls[k]) ? offList : listed)', '(randoms.has(urls[k]) ? offList : () => false)') },
    { name: '再讀之前不等', apply: (s) => s.replace('        await sleep(recheck.delayMs);\n', '') },
    { name: '再讀時預算用完不算進 skipped', apply: (s) => s.replace('            if (!again[j]) confirmSkipped++;\n', '') },
    { name: '再讀沒讀到時拿第一次的結果當確認', apply: (s) => s.replace(': { ...rr[k], retrySkipped: true };', ': { ...rr[k], previous: rr[k] };') },
    { name: '首頁也看標題', apply: (s) => s.replace('return check && !HOME_PATH.test(u.pathname) && !matchContentCheck', 'return check && !matchContentCheck') },
    { name: '帶查詢字串的首頁也看標題', apply: (s) => s.replace('return check && !HOME_PATH.test(u.pathname) && !matchContentCheck', "return check && !(u.pathname === '/' && !u.search) && !matchContentCheck") },
    { name: '寫了 API 的網址也看標題', apply: (s) => s.replace(' && !matchContentCheck([check], url) ? check : null;', ' ? check : null;') },
    { name: '重讀只讀 16KB', apply: (s) => s.replace('readBodyBytes: 256 * 1024 });', 'readBodyBytes: 16 * 1024 });') },
    { name: '不打隨機路徑', apply: (s) => s.replace('        randoms.set(randomSibling(url, token), check);\n', '') },
];
// 取 <title>、meta、h1、canonical 之前拿掉的那些部分，三支測試各自用到一部分。
const markupMutations = [
    { name: 'pageMarkup 什麼都不拿掉', apply: (s) => s.replace("return String(html).replace(INERT, (m, tag, title) => title ?? '');", 'return String(html);') },
    { name: 'extractHeadText 直接看原文', apply: (s) => s.replace('    const html = pageMarkup(raw);\n', '    const html = raw;\n') },
    { name: 'rawTitle 直接在原文找第一個 <title>', apply: (s) => s.replace('for (const m of String(html).matchAll(INERT)) {', 'for (const m of String(html).matchAll(/()(<title(?=[\\t\\n\\f\\r />])[\\s\\S]*?(?:<\\/title(?=[\\t\\n\\f\\r />])[^>]*>|$))/gi)) {') },
    { name: 'rawTitle 改成在 pageMarkup 的結果上另外找（一連串沒有結尾的 <title 要平方時間）', apply: (s) => s.replace('    for (const m of String(html).matchAll(INERT)) {', "    const left = pageMarkup(html);\n    if (true) return left.match(/<title\\b[^>]*>([\\s\\S]*?)<\\/title\\s*>/i)?.[1] ?? (/<title\\b/i.test(left) ? null : undefined);\n    for (const m of String(html).matchAll(INERT)) {") },
    { name: '不拿掉 style', apply: (s) => s.replace('|<(script|style|textarea|', '|<(script|textarea|') },
    { name: '不拿掉 template', apply: (s) => s.replace('|noscript|template|svg|math)(', '|noscript|svg|math)(') },
    { name: '不拿掉 noscript', apply: (s) => s.replace('|noframes|noscript|template|', '|noframes|template|') },
    { name: '不拿掉 textarea', apply: (s) => s.replace('|<(script|style|textarea|', '|<(script|style|') },
    { name: '<![CDATA[ 一路到 ]]>（瀏覽器在 HTML 裡只到第一個 >）', apply: (s) => s.replace('|<[!?][^>]*(?:>|$)|', '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>|$)|<[!?][^>]*(?:>|$)|') },
    { name: '不拿掉 iframe', apply: (s) => s.replace('|xmp|iframe|noembed|', '|xmp|noembed|') },
    { name: '不拿掉 math', apply: (s) => s.replace('|template|svg|math)(', '|template|svg)(') },
    { name: '不拿掉 xmp、noembed、noframes', apply: (s) => s.replace('|xmp|iframe|noembed|noframes|', '|iframe|') },
    { name: '結束標籤不認 </script >', apply: (s) => s.replace('(?:<\\/\\1(?=[\\t\\n\\f\\r />])[^>]*>|$)', '(?:<\\/\\1>|$)') },
    { name: '拿掉的地方補空白（<link<!-- -->rel=canonical> 變成 canonical）', apply: (s) => s.replace("(m, tag, title) => title ?? '');", "(m, tag, title) => title ?? ' ');") },
    { name: '<svg-icon> 當成 svg', apply: (s) => s.replace('|svg|math)(?=[\\t\\n\\f\\r />])', '|svg|math)\\b') },
    { name: '不認 <svg/>', apply: (s) => s.replace('|<(?:svg|math)(?=[\\t\\n\\f\\r /])[^>]*\\/>|', '|') },
    { name: '沒有結尾的註解不吃到最後', apply: (s) => s.replace('<!--(?:-?>|[\\s\\S]*?(?:--!?>|$))|', '<!--(?:-?>|[\\s\\S]*?--!?>)|') },
    { name: '<!---> 不算空註解', apply: (s) => s.replace('<!--(?:-?>|', '<!--(?:>|') },
    { name: '註解不認 --!> 結尾', apply: (s) => s.replace('(?:--!?>|$)', '(?:-->|$)') },
    { name: '標籤名稱後面的空白改回 \\s（NBSP 也算）', apply: (s) => s.replaceAll('[\\t\\n\\f\\r />]', '[\\s/>]').replaceAll('[\\t\\n\\f\\r /]', '[\\s/]') },
    { name: '<!--> 不算空註解', apply: (s) => s.replace('<!--(?:-?>|[\\s\\S]*?', '<!--(?:[\\s\\S]*?') },
    { name: '<title> 貪婪比對到最後', apply: (s) => s.replace('(<title(?=[\\t\\n\\f\\r />])[\\s\\S]*?(?:', '(<title(?=[\\t\\n\\f\\r />])[\\s\\S]*(?:') },
    { name: '</title > 帶空白就認不出來', apply: (s) => s.replaceAll('<\\/title(?=[\\t\\n\\f\\r />])[^>]*>', '<\\/title>') },
    { name: '不認帶屬性的 <title>', apply: (s) => s.replace('(<title(?=[\\t\\n\\f\\r />])', '(<title(?=>)').replace('/^<title[^>]*>(', '/^<title>(') },
];
const titleReportMutations = [
    { name: 'needsAttention 不看過期的名單', apply: (s) => s.replace('        titleStale.length > 0 ||\n', '') },
    { name: '隨機路徑沒打完也算完整覆蓋', apply: (s) => s.replace(' && titleRun.skipped === 0;', ';') },
    { name: 'judgeUrl 不用重讀的結果', apply: (s) => s.replace('judgeTitle(titleCheck, r, reread)', 'judgeTitle(titleCheck, r, null)') },
    { name: 'buildReport 沒把重讀的結果交給 judgeUrl', apply: (s) => s.replace('soft404Run.verdicts[i], titleRun.rereads[i]);', 'soft404Run.verdicts[i], null);') },
    { name: '頁面不健康也看標題', apply: (s) => s.replace("const titleCheck = !check && classifyLink(r) === 'healthy' ? titleCheckFor", 'const titleCheck = !check ? titleCheckFor') },
    { name: '報告不寫名單過期那一段', apply: (s) => s.replace('    if (titleStale.length) {', '    if (false) {') },
    { name: '沒重讀的網址不算未檢查', apply: (s) => s.replace('            if ((!reread || reread.retrySkipped) && needsReread(', '            if (false && needsReread(') },
    { name: '確認時沒再讀到的網址不算未檢查', apply: (s) => s.replace('if ((!reread || reread.retrySkipped) && needsReread(', 'if (!reread && needsReread(') },
];
const probeTypeMutations = [
    { name: 'probe 不帶回 Content-Type', apply: (s) => s.replace('            ...(r.contentType !== undefined ? { contentType: r.contentType } : {}),\n', '') },
];
const titleMainMutations = [
    { name: '標題檢查的結果沒交給 buildReport', apply: (s) => s.replace('    titles,\n    policy:', '    policy:') },
    { name: '標題檢查沒接上重播的 probe', apply: (s) => s.replace('randomToken, { probeFn, ...(REPLAY_PATH', 'randomToken, { ...(REPLAY_PATH') },
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
                '--test-reporter=spec',
                path.join(SCRIPTS, 'link-health.test.mjs'),
                path.join(SCRIPTS, 'bare-domains.test.mjs'),
                // D 段的突變要跑這一支。基準也必須涵蓋它，否則「基準是綠的」這句話
                // 對接管偵測是盲的，而這個矩陣存在的理由就是不留這種盲點。
                path.join(SCRIPTS, 'hijack-signals.test.mjs'),
                path.join(SCRIPTS, 'check-external-links.test.mjs'),
                path.join(SCRIPTS, 'soft404.test.mjs'),
                path.join(SCRIPTS, 'missing-titles.test.mjs'),
            ],
            { encoding: 'utf8', stdio: 'pipe' },
        );
        return 0;
    } catch (e) {
        // 失敗時印出完整輸出；測試結束後才丟的例外不在最後的失敗清單裡。
        console.error(`${e.stdout ?? ''}${e.stderr ?? ''}\nstatus=${e.status} signal=${e.signal} code=${e.code}`);
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
// 單元測試也要一起驗，而且必須在注入之前。否則 lib 本身已經壞掉時，B 到 J 九段的
// 每一條 mutation 都只是「在紅底上再變一次紅」，會全部被記成「✅ 擋下來了」，
// 要等收尾那道檢查才抓得到，摘要照樣印出「0 漏掉」。例如讓
// extractBareDomainCandidates 永遠回 []，只跑政策檢查的話基準仍是綠的。
const baseTests = runBaselineTests();
if (baseTests !== 0) {
    console.error('  ❌ 基準單元測試已經是紅的，無法進行故障注入（請先修好 link-health.test.mjs／bare-domains.test.mjs／hijack-signals.test.mjs／check-external-links.test.mjs／soft404.test.mjs／missing-titles.test.mjs）');
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

const RED = (what) => `改壞${what}之後測試還是綠的，那些測試沒有在把關`;
await runMutants('B. SSRF 防護、讀 body 與無法判定分組的突變測試（link-health.test.mjs 必須紅）：',
    'link-health.lib.mjs', guardMutations, ['link-health.test.mjs'], RED('這段防護'));
await runMutants('C. 裸網域擷取規則的突變測試（bare-domains.test.mjs 必須紅）：',
    'bare-domains.lib.mjs', bareDomainMutations, ['bare-domains.test.mjs'], RED('這條規則'));
await runMutants('D. 接管偵測的突變測試（hijack-signals.test.mjs 必須紅）：',
    'hijack-signals.lib.mjs', hijackMutations, ['hijack-signals.test.mjs'], RED('這一段'));
await runMutants('D. 取 <title>、meta 之前拿掉的部分（hijack-signals.test.mjs、missing-titles.test.mjs 或 soft404.test.mjs 必須紅）：',
    'hijack-signals.lib.mjs', markupMutations, ['hijack-signals.test.mjs', 'missing-titles.test.mjs', 'soft404.test.mjs'], RED('這一段'));
// E、F 兩段突變的是同一個檔案。兩支測試有一支紅就算擋下，報告的接線有一部分在 hijack-signals.test.mjs。
await runMutants('E. 判定、通知與報告內容的突變測試（link-health.test.mjs 或 hijack-signals.test.mjs 必須紅）：',
    'check-external-links.lib.mjs', reportMutations, ['link-health.test.mjs', 'hijack-signals.test.mjs'], RED('這一段'));
await runMutants('F. buildReport 組裝的突變測試（link-health.test.mjs 或 hijack-signals.test.mjs 必須紅）：',
    'check-external-links.lib.mjs', assemblyMutations, ['link-health.test.mjs', 'hijack-signals.test.mjs'], RED('這一段'));
await runMutants('G. 連結政策檢查、比對與到期提醒的突變測試（link-health.test.mjs 必須紅）：',
    'link-policy.lib.mjs', policyLibMutations, ['link-health.test.mjs'], RED('這一段'));
await runMutants('H. 主程式交給 buildReport 的名單與交給 probe 的選項（check-external-links.test.mjs 必須紅）：',
    'check-external-links.mjs', mainMutations, ['check-external-links.test.mjs'], RED('這一段'));
await runMutants('I. 軟 404 的規則、隨機路徑與重打（soft404.test.mjs 必須紅）：',
    'soft404.lib.mjs', soft404Mutations, ['soft404.test.mjs'], RED('這條規則'));
await runMutants('I. 軟 404 在報告裡的分組（soft404.test.mjs 必須紅）：',
    'check-external-links.lib.mjs', soft404ReportMutations, ['soft404.test.mjs'], RED('這一段'));
await runMutants('J. contentChecks 主機層宣告的檢查（link-health.test.mjs 必須紅）：',
    'link-policy.lib.mjs', hostPolicyMutations, ['link-health.test.mjs'], RED('這一段'));
await runMutants('J. contentChecks 主機層宣告的判定（link-health.test.mjs 必須紅）：',
    'check-external-links.lib.mjs', hostJudgeMutations, ['link-health.test.mjs'], RED('這一段'));
await runMutants('J. missingTitles 的判定、重讀與隨機路徑（missing-titles.test.mjs 必須紅）：',
    'missing-titles.lib.mjs', titleMutations, ['missing-titles.test.mjs'], RED('這一段'));
await runMutants('J. missingTitles 在報告裡的分組（missing-titles.test.mjs 必須紅）：',
    'check-external-links.lib.mjs', titleReportMutations, ['missing-titles.test.mjs'], RED('這一段'));
await runMutants('J. probe 帶回 Content-Type（missing-titles.test.mjs 必須紅）：',
    'link-health.lib.mjs', probeTypeMutations, ['missing-titles.test.mjs'], RED('這一段'));
await runMutants('J. 主程式接上標題檢查（check-external-links.test.mjs 必須紅）：',
    'check-external-links.mjs', titleMainMutations, ['check-external-links.test.mjs'], RED('這一段'));

console.log('\n最後確認基準仍為綠：');
const after = runPolicyCheck(basePolicy, baseInv);
const afterTests = runBaselineTests();
console.log(after.code === 0 && afterTests === 0 ? '  ✅ 還原後仍為綠燈' : '  ❌ 還原後仍是紅的，副本沒有清乾淨');

rmSync(TMP, { recursive: true, force: true });

console.log(`\n故障注入：${pass} 擋下 / ${fail} 漏掉（共 ${policyCases.length + guardMutations.length + bareDomainMutations.length + hijackMutations.length + reportMutations.length + assemblyMutations.length + policyLibMutations.length + mainMutations.length + soft404Mutations.length + soft404ReportMutations.length + hostPolicyMutations.length + hostJudgeMutations.length +
    titleMutations.length + markupMutations.length + titleReportMutations.length + titleMainMutations.length + probeTypeMutations.length} 項）`);
process.exit(fail === 0 && after.code === 0 && afterTests === 0 ? 0 : 1);
