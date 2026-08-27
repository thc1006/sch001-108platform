#!/usr/bin/env node
/**
 * 連結健檢的 SSRF 防護與例外政策測試
 * --------------------------------------------------------------
 * 全部打本機 http server 或純函式，不依賴外網——外網測試會因防爬與站台狀態而飄。
 *
 * 為什麼要有這一份：「有寫防護」證明不了「防護擋得住」。這裡每一條都是先讓
 * 攻擊真的走一遍，再斷言它被擋下來，而不是只檢查程式碼裡有那個 if。
 *
 * 執行：  npm run test:link-health
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import {
    probe,
    classifyLink,
    describeResult,
    isDeadResult,
    isBlockedResult,
    staticUrlPolicy,
    blockedAddressReason,
    ipv6ToBytes,
    canonicalHost,
    resolveAndVerify,
    runProbes,
} from './link-health.lib.mjs';
import { probe as competitionsProbe } from './check-competitions.lib.mjs';
import { validatePolicy, matchPolicy, matchHijacked, normalizeUrl, MAX_HORIZON_DAYS } from './link-policy.lib.mjs';
import { selectCanonicalIssue, WATCHDOG_MARKER, EXTERNAL_LINKS_MARKER, ACTIONS_APP_LOGIN } from './watchdog-issue.lib.mjs';

/** 允許 loopback＝單元測試模式；正式執行走預設的嚴格模式。 */
const LOOPBACK_OK = { allowLoopback: true };

let base;
let server;
let hits;

before(async () => {
    hits = new Map();
    server = createServer((req, res) => {
        const u = req.url;
        hits.set(u, (hits.get(u) || 0) + 1);
        if (u === '/ok') { res.writeHead(200); return res.end('<html>ok</html>'); }
        if (u === '/404') { res.writeHead(404); return res.end('nope'); }
        if (u === '/410') { res.writeHead(410); return res.end('gone'); }
        if (u === '/403') { res.writeHead(403); return res.end('forbidden'); }
        if (u === '/429') { res.writeHead(429); return res.end('slow down'); }
        if (u === '/500') { res.writeHead(500); return res.end('boom'); }
        if (u === '/slow') { return; } // 不回應，用來測逾時
        // ── SSRF 的轉址繞道：起點無害，第二跳才指向內網／metadata ──
        if (u === '/to-metadata') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
        if (u === '/to-private') { res.writeHead(302, { Location: 'http://10.1.2.3/admin' }); return res.end(); }
        // 用 ULA 與 IPv4-mapped 而不是 ::1：這一組測試跑在「允許 loopback」的單元
        // 測試模式下（第一跳就是本機 server），::1 在該模式下本來就是允許的。
        if (u === '/to-ipv6-ula') { res.writeHead(302, { Location: 'http://[fd00::1]:9/x' }); return res.end(); }
        if (u === '/to-ipv4-mapped-metadata') { res.writeHead(302, { Location: 'http://[::ffff:169.254.169.254]/' }); return res.end(); }
        if (u === '/to-file') { res.writeHead(302, { Location: 'file:///etc/passwd' }); return res.end(); }
        // 167772161 是 10.0.0.1 的十進位寫法——混淆寫法 + 轉址繞道的組合
        if (u === '/to-decimal-private') { res.writeHead(302, { Location: 'http://167772161/x' }); return res.end(); }
        if (u === '/to-creds') { res.writeHead(302, { Location: 'http://user:pass@example.com/' }); return res.end(); }
        if (u === '/to-dns-private') { res.writeHead(302, { Location: 'http://10.0.0.1.nip.io/' }); return res.end(); }
        if (u === '/to-ok') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
        if (u === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
        // 一路轉到 /ok，用來確認「上限之內的多跳」仍然可行
        const chain = /^\/hop(\d+)$/.exec(u);
        if (chain) {
            const n = Number(chain[1]);
            res.writeHead(302, { Location: n <= 1 ? '/ok' : `/hop${n - 1}` });
            return res.end();
        }
        res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// ──────────────────────────────────────────────────────────────
// 一、三態分類（沿用競賽看門狗的語意，兩邊必須一致）
// ──────────────────────────────────────────────────────────────

test('三態：404 / 410 → dead', async () => {
    for (const p of ['/404', '/410']) {
        const r = await probe(`${base}${p}`, undefined, LOOPBACK_OK);
        assert.equal(classifyLink(r), 'dead', `${p} 應為 dead`);
    }
});

test('三態：403 / 429 / 500 → unverified（防爬與暫時性故障不可開 issue）', async () => {
    for (const p of ['/403', '/429', '/500']) {
        const r = await probe(`${base}${p}`, undefined, LOOPBACK_OK);
        assert.equal(classifyLink(r), 'unverified', `${p} 應為 unverified`);
    }
});

test('三態：200 與轉址後 200 → healthy', async () => {
    assert.equal(classifyLink(await probe(`${base}/ok`, undefined, LOOPBACK_OK)), 'healthy');
    assert.equal(classifyLink(await probe(`${base}/to-ok`, undefined, LOOPBACK_OK)), 'healthy');
});

test('三態：網域無法解析 → dead；逾時 → unverified', async () => {
    const nx = await probe('https://this-domain-must-not-exist-4b81f2a9.invalid/');
    assert.equal(nx.code, 'ENOTFOUND');
    assert.equal(classifyLink(nx), 'dead');
    assert.equal(isBlockedResult(nx), false, '解析不到是 dead，不是被政策擋下');

    const slow = await probe(`${base}/slow`, AbortSignal.timeout(300), LOOPBACK_OK);
    assert.equal(slow.status, 0);
    assert.equal(classifyLink(slow), 'unverified');
});

test('轉址上限之內可以一路跟到底，超過上限才放棄', async () => {
    const ok = await probe(`${base}/hop3`, undefined, LOOPBACK_OK);
    assert.equal(ok.status, 200, '3 跳應在上限之內');
    assert.equal(ok.redirects.length, 3, 'redirects 要記錄整條轉址鏈（/hop3→/hop2→/hop1→/ok 共 3 跳）');

    const loop = await probe(`${base}/loop`, undefined, LOOPBACK_OK);
    assert.equal(loop.code, 'ETOOMANYREDIRECTS');
    assert.equal(classifyLink(loop), 'unverified', '轉址迴圈不是「連結壞掉」，不可開 issue');

    const capped = await probe(`${base}/hop3`, undefined, { ...LOOPBACK_OK, maxRedirects: 2 });
    assert.equal(capped.code, 'ETOOMANYREDIRECTS', 'maxRedirects 必須真的生效');
});

test('一律用 GET（HEAD 不是使用者實際送的請求）', async () => {
    hits.clear();
    await probe(`${base}/ok`, undefined, LOOPBACK_OK);
    assert.ok(hits.get('/ok') >= 1, '必須真的送出請求');
});

// ──────────────────────────────────────────────────────────────
// 二、SSRF：靜態網址政策（不需 DNS，PR 階段就能確定性地跑）
// ──────────────────────────────────────────────────────────────

test('SSRF：只允許 http／https', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/', 'data:text/html,x', 'javascript:alert(1)']) {
        const v = staticUrlPolicy(u);
        assert.equal(v.ok, false, `${u} 必須被拒絕`);
        assert.match(v.reason, /只允許 http\/https|不是合法的網址/);
    }
    assert.equal(staticUrlPolicy('https://example.com/').ok, true);
    assert.equal(staticUrlPolicy('http://example.com/').ok, true);
});

test('SSRF：網址不得內嵌帳號密碼，且理由不可回顯帳密', () => {
    const v = staticUrlPolicy('https://alice:s3cret@example.com/');
    assert.equal(v.ok, false);
    assert.match(v.reason, /credential/);
    assert.ok(!v.reason.includes('s3cret'), '封鎖理由會進報告與 issue，不可把密碼寫出去');
});

test('SSRF：十進位／八進位／十六進位的 IP 混淆寫法一樣擋得住', () => {
    // new URL() 會把這些正規化成 127.0.0.1，所以靜態這一關就攔得到。
    for (const u of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://127.1/']) {
        const v = staticUrlPolicy(u);
        assert.equal(v.ok, false, `${u} 必須被拒絕`);
        assert.match(v.reason, /127\.0\.0\.0\/8/);
    }
});

test('SSRF：雲端 metadata 的位址與名稱都要擋', () => {
    for (const u of [
        'http://169.254.169.254/latest/meta-data/',
        'http://169.254.170.2/v2/credentials',
        'http://metadata.google.internal/computeMetadata/v1/',
        'http://metadata/computeMetadata/v1/',
        'http://instance-data.ec2.internal/',
    ]) {
        assert.equal(staticUrlPolicy(u).ok, false, `${u} 必須被拒絕`);
    }
});

test('SSRF：保留名稱空間（.internal／.local／.lan…）一律拒絕', () => {
    for (const h of ['db.internal', 'printer.local', 'nas.lan', 'gitlab.corp', 'x.home.arpa', 'app.localhost']) {
        assert.equal(staticUrlPolicy(`https://${h}/`).ok, false, `${h} 必須被拒絕`);
    }
    // 合法的公開網域不可被誤傷——.internal 是後綴比對，不能寫成子字串比對
    for (const h of ['internal.example.com', 'my-local-site.com', 'localhost.example.org']) {
        assert.equal(staticUrlPolicy(`https://${h}/`).ok, true, `${h} 不該被誤擋`);
    }
});

test('SSRF：主機名結尾的點不可用來繞過（localhost. ≡ localhost）', () => {
    assert.equal(canonicalHost('LOCALHOST.'), 'localhost');
    assert.equal(staticUrlPolicy('http://LOCALHOST./').ok, false);
    assert.equal(staticUrlPolicy('http://metadata.google.internal./').ok, false);
});

// ──────────────────────────────────────────────────────────────
// 三、SSRF：位址判定（IPv4 與 IPv6）
// ──────────────────────────────────────────────────────────────

test('SSRF：IPv4 私有／loopback／link-local／保留網段全部封鎖', () => {
    const mustBlock = [
        '0.0.0.0', '10.0.0.1', '10.255.255.254', '100.64.0.1', '127.0.0.1', '127.255.255.254',
        '169.254.1.1', '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.0.0.1', '192.0.2.5',
        '192.88.99.1', '192.168.0.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    ];
    for (const ip of mustBlock) assert.ok(blockedAddressReason(ip), `${ip} 必須被封鎖`);

    // 邊界：緊鄰私有網段之外的位址不可被誤擋
    for (const ip of ['9.255.255.255', '11.0.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '8.8.8.8', '140.112.172.16']) {
        assert.equal(blockedAddressReason(ip), null, `${ip} 不該被誤擋`);
    }
});

test('SSRF：IPv6 loopback／ULA／link-local／multicast 全部封鎖', () => {
    for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1', '100::1', '2001::1']) {
        assert.ok(blockedAddressReason(ip), `${ip} 必須被封鎖`);
    }
    assert.equal(blockedAddressReason('2606:4700:4700::1111'), null, '公開 IPv6 不該被誤擋');
});

test('SSRF：IPv4-mapped／6to4／NAT64 的內嵌位址要拆出來再判斷', () => {
    // 只看「這是 IPv6」而不拆內嵌位址，等於整份 IPv4 清單被繞過
    assert.match(blockedAddressReason('::ffff:127.0.0.1'), /127\.0\.0\.0\/8/);
    assert.match(blockedAddressReason('::ffff:169.254.169.254'), /169\.254\.0\.0\/16/);
    assert.match(blockedAddressReason('::ffff:10.0.0.1'), /10\.0\.0\.0\/8/);
    assert.match(blockedAddressReason('64:ff9b::169.254.169.254'), /169\.254\.0\.0\/16/);
    assert.match(blockedAddressReason('2002:7f00:0001::'), /127\.0\.0\.0\/8/);
    // IPv4-mapped 的公開位址不該被誤擋
    assert.equal(blockedAddressReason('::ffff:8.8.8.8'), null);
});

test('SSRF：ipv6ToBytes 對壓縮寫法與內嵌 IPv4 的解析正確', () => {
    assert.deepEqual([...ipv6ToBytes('::1')], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    assert.deepEqual([...ipv6ToBytes('::ffff:127.0.0.1')].slice(10), [0xff, 0xff, 127, 0, 0, 1]);
    assert.deepEqual([...ipv6ToBytes('fe80::1')].slice(0, 2), [0xfe, 0x80]);
    assert.equal(ipv6ToBytes('not-an-ip'), null);
    assert.equal(ipv6ToBytes('127.0.0.1'), null);
});

test('SSRF：allowLoopback 只放寬 loopback，其他一項都不放寬', () => {
    assert.equal(blockedAddressReason('127.0.0.1', LOOPBACK_OK), null);
    assert.equal(blockedAddressReason('::1', LOOPBACK_OK), null);
    assert.equal(blockedAddressReason('::ffff:127.0.0.1', LOOPBACK_OK), null);
    for (const ip of ['169.254.169.254', '10.0.0.1', '192.168.1.1', '172.16.0.1', 'fd00::1', 'fe80::1', '0.0.0.0']) {
        assert.ok(blockedAddressReason(ip, LOOPBACK_OK), `即使允許 loopback，${ip} 仍必須被封鎖`);
    }
    assert.equal(staticUrlPolicy('http://169.254.169.254/', LOOPBACK_OK).ok, false);
    assert.equal(staticUrlPolicy('http://metadata.google.internal/', LOOPBACK_OK).ok, false);
});

// ──────────────────────────────────────────────────────────────
// 四、SSRF：實際連線時真的被擋下來（不是只有純函式說會擋）
// ──────────────────────────────────────────────────────────────

test('SSRF：預設（嚴格）模式下連本機 http server 會被擋，且沒有送出任何請求', async () => {
    hits.clear();
    const r = await probe(`${base}/ok`);
    assert.equal(isBlockedResult(r), true);
    assert.equal(r.code, 'EBLOCKED');
    assert.match(r.reason, /127\.0\.0\.0\/8/);
    assert.equal(hits.size, 0, '被擋下時不可已經把請求送出去');
    assert.match(describeResult(r), /位址政策封鎖/);
});

test('SSRF：轉址的每一跳都要重新驗證——第二跳指向 metadata 必須被擋', async () => {
    for (const [path, pattern] of [
        ['/to-metadata', /169\.254\.0\.0\/16/],
        ['/to-private', /10\.0\.0\.0\/8/],
        ['/to-ipv6-ula', /fc00::\/7/],
        ['/to-ipv4-mapped-metadata', /169\.254\.0\.0\/16/],
        ['/to-file', /只允許 http\/https/],
        ['/to-decimal-private', /10\.0\.0\.0\/8/],
        ['/to-creds', /credential/],
    ]) {
        const r = await probe(`${base}${path}`, undefined, LOOPBACK_OK);
        assert.equal(isBlockedResult(r), true, `${path} 的第二跳必須被擋`);
        assert.match(r.reason, pattern);
        assert.equal(r.redirects.length, 1, '應該已經走過第一跳才被擋在第二跳');
    }
});

test('SSRF：DNS 解析結果才是判斷對象——公開網域解析到私網 IP 一樣要擋', async () => {
    // nip.io 是公開服務，10.0.0.1.nip.io 解析到 10.0.0.1。只看 hostname 完全看不出問題。
    const resolved = await resolveAndVerify('10.0.0.1.nip.io');
    if (resolved.ok) assert.fail('10.0.0.1.nip.io 應解析到 10.0.0.1 並被封鎖');
    if (resolved.code) {
        // 沒有網路或 DNS 不通時跳過——但不可靜默當成通過
        console.log(`      （略過：DNS 不可用，${resolved.code}）`);
        return;
    }
    assert.match(resolved.reason, /10\.0\.0\.0\/8/);

    const r = await probe('http://10.0.0.1.nip.io/');
    assert.equal(isBlockedResult(r), true);
    assert.match(r.reason, /10\.0\.0\.0\/8/);
});

test('SSRF：轉址到「解析成私網的公開網域」同樣要擋', async () => {
    const pre = await resolveAndVerify('10.0.0.1.nip.io');
    if (pre.ok || pre.code) {
        console.log('      （略過：DNS 不可用或 nip.io 行為改變）');
        return;
    }
    const r = await probe(`${base}/to-dns-private`, undefined, LOOPBACK_OK);
    assert.equal(isBlockedResult(r), true);
    assert.match(r.reason, /10\.0\.0\.0\/8/);
});

test('SSRF：被擋下的網址分類成 unverified，絕不可被說成 healthy 或 dead', async () => {
    const r = await probe('http://169.254.169.254/latest/meta-data/');
    assert.equal(isBlockedResult(r), true);
    assert.equal(classifyLink(r), 'unverified');
    assert.equal(isDeadResult(r), false, '沒驗到就說它壞了是編造');
});

test('SSRF：競賽看門狗的相容 probe 只放寬 loopback，metadata 仍然擋得死', async () => {
    // check-competitions.lib.mjs 的 probe 是為了讓既有 44 個單元測試打得到本機
    // server 而保留的別名。它只放寬 loopback——這裡把「沒有放寬別的」釘住。
    const ok = await competitionsProbe(`${base}/ok`);
    assert.equal(ok.status, 200, '既有單元測試仰賴這個別名連得上本機 server');

    for (const u of ['http://169.254.169.254/', 'http://10.0.0.1/', 'https://user:pass@example.com/', 'file:///etc/passwd']) {
        const r = await competitionsProbe(u);
        assert.equal(isBlockedResult(r), true, `${u} 在相容別名下仍必須被擋`);
    }
});

test('runProbes：把 allowLoopback 傳給每一次探測，且回報未檢查筆數', async () => {
    const { results, skipped } = await runProbes([`${base}/ok`, `${base}/404`], { concurrency: 2, allowLoopback: true });
    assert.equal(skipped, 0);
    assert.equal(classifyLink(results[0]), 'healthy');
    assert.equal(classifyLink(results[1]), 'dead');

    // 不傳 allowLoopback＝嚴格模式，本機位址全部被擋
    const strict = await runProbes([`${base}/ok`], { concurrency: 1 });
    assert.equal(isBlockedResult(strict.results[0]), true);
});

// ──────────────────────────────────────────────────────────────
// 五、例外政策（allowlist）
// ──────────────────────────────────────────────────────────────

const TODAY = '2026-08-27';
const validEntry = (over = {}) => ({
    match: { host: 'www.ptt.cc' },
    reason: 'PTT 封鎖資料中心 IP，runner 上一律 connection reset',
    owner: 'thc1006',
    expires: '2026-10-01',
    ...over,
});

test('政策：合法的一筆通過驗證', () => {
    const { errors } = validatePolicy({ version: 1, entries: [validEntry()] }, TODAY);
    assert.deepEqual(errors, []);
});

test('政策：缺 reason／owner／expires 一律拒絕', () => {
    for (const field of ['reason', 'owner', 'expires']) {
        const e = validEntry();
        delete e[field];
        const { errors } = validatePolicy({ version: 1, entries: [e] }, TODAY);
        assert.ok(errors.some((m) => m.includes(field)), `缺 ${field} 必須報錯，實際：${errors.join('；')}`);
    }
    // 敷衍的理由也不算理由
    const { errors } = validatePolicy({ version: 1, entries: [validEntry({ reason: 'x' })] }, TODAY);
    assert.ok(errors.some((m) => m.includes('reason')));
});

test('政策：過期的例外必須讓確定性 CI 失敗', () => {
    const { errors, entries } = validatePolicy({ version: 1, entries: [validEntry({ expires: '2026-08-26' })] }, TODAY);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /到期/);
    // 「今天到期」也算過期——邊界不可偏向繼續放行
    const today = validatePolicy({ version: 1, entries: [validEntry({ expires: TODAY })] }, TODAY);
    assert.match(today.errors[0], /到期/);

    // 過期的例外不可被回傳出去。只要它還在 entries 裡，任何呼叫 matchPolicy() 的
    // 地方就等於「過期的例外還在生效」——CI 紅了但實際行為沒變，是最糟的組合。
    assert.deepEqual(entries, [], '過期的例外不得出現在回傳的 entries 裡');
    assert.equal(matchPolicy(entries, 'https://www.ptt.cc/bbs/'), null);
    assert.deepEqual(today.entries, []);
});

test('政策：任何一項寫錯的例外都不得被回傳出去', () => {
    for (const broken of [
        validEntry({ expires: '2099-12-31' }),
        validEntry({ reason: 'x' }),
        validEntry({ match: { host: '*.ptt.cc' } }),
        (() => { const e = validEntry(); delete e.owner; return e; })(),
    ]) {
        const { errors, entries } = validatePolicy({ version: 1, entries: [broken] }, TODAY);
        assert.ok(errors.length > 0, `${JSON.stringify(broken)} 應該報錯`);
        assert.deepEqual(entries, [], `${JSON.stringify(broken)} 不得進入 entries`);
    }
});

test('政策：不得有無期限例外（超過上限的 expires 一樣拒絕）', () => {
    for (const far of ['2099-12-31', '2027-12-31']) {
        const { errors } = validatePolicy({ version: 1, entries: [validEntry({ expires: far })] }, TODAY);
        assert.ok(errors.some((m) => m.includes('無期限')), `${far} 必須被拒絕，實際：${errors.join('；')}`);
    }
    assert.ok(MAX_HORIZON_DAYS <= 365, '有效期上限本身也不該被放寬成一年以上');
});

test('政策：只接受精確網址或精確主機名，不接受萬用字元／子字串', () => {
    const bad = [
        { match: { host: '*.ptt.cc' } },
        { match: { host: 'ptt.cc/bbs' } },
        { match: { host: 'www.ptt.cc:443' } },
        { match: { url: 'https://www.ptt.cc/*' } },
        { match: { url: 'https://www.ptt.cc/x#frag' } },
        { match: { host: 'www.ptt.cc', url: 'https://www.ptt.cc/' } },
        { match: {} },
        { match: { prefix: 'https://www.ptt.cc' } },
    ];
    for (const m of bad) {
        const { errors } = validatePolicy({ version: 1, entries: [validEntry(m)] }, TODAY);
        assert.ok(errors.length > 0, `${JSON.stringify(m)} 必須被拒絕`);
    }
});

test('政策：例外的目標本身也必須通過位址政策', () => {
    for (const m of [
        { match: { host: 'metadata.google.internal' } },
        { match: { url: 'http://169.254.169.254/latest/meta-data/' } },
        { match: { host: 'localhost' } },
    ]) {
        const { errors } = validatePolicy({ version: 1, entries: [validEntry(m)] }, TODAY);
        assert.ok(errors.some((x) => x.includes('位址政策')), `${JSON.stringify(m)} 必須被拒絕`);
    }
});

test('政策：重複條目與未知欄位要報錯', () => {
    const dup = validatePolicy({ version: 1, entries: [validEntry(), validEntry()] }, TODAY);
    assert.ok(dup.errors.some((m) => m.includes('重複')));

    const unknown = validatePolicy({ version: 1, entries: [{ ...validEntry(), untilForever: true }] }, TODAY);
    assert.ok(unknown.errors.some((m) => m.includes('untilForever')));

    const topLevel = validatePolicy({ version: 1, entries: [], disableAllChecks: true }, TODAY);
    assert.ok(topLevel.errors.some((m) => m.includes('disableAllChecks')));
});

test('政策：比對是完全相等，不是子字串——相似網域不得被順帶放行', () => {
    const entries = validatePolicy(
        { version: 1, entries: [validEntry(), validEntry({ match: { url: 'https://example.com/a/b.pdf' }, expires: '2026-10-01' })] },
        TODAY,
    ).entries;

    assert.ok(matchPolicy(entries, 'https://www.ptt.cc/bbs/SENIORHIGH/index.html'), '同主機的任一路徑都在 host 例外內');
    assert.equal(matchPolicy(entries, 'https://evil-www.ptt.cc.example.com/'), null, '子字串比對會放行這個，必須不放行');
    assert.equal(matchPolicy(entries, 'https://ptt.cc/'), null, 'host 例外不含母網域');
    assert.equal(matchPolicy(entries, 'https://sub.www.ptt.cc/'), null, 'host 例外不含子網域');

    assert.ok(matchPolicy(entries, 'https://example.com/a/b.pdf'));
    assert.equal(matchPolicy(entries, 'https://example.com/a/b.pdf?x=1'), null, 'url 例外是精確比對，query 不同就不算');
    assert.equal(matchPolicy(entries, 'https://example.com/a/'), null, 'url 例外不是前綴比對');
});

test('政策：fragment 不影響比對（盤點存的網址本來就去掉 fragment）', () => {
    const entries = validatePolicy({ version: 1, entries: [validEntry({ match: { url: 'https://example.com/a' } })] }, TODAY).entries;
    assert.ok(matchPolicy(entries, 'https://example.com/a#section'));
    assert.equal(normalizeUrl('https://example.com/a#section'), 'https://example.com/a');
});

test('政策：repo 內的 link-policy.json 現在就是有效的', () => {
    const file = fileURLToPath(new URL('./link-policy.json', import.meta.url));
    const { errors } = validatePolicy(JSON.parse(readFileSync(file, 'utf8')), new Date().toISOString().slice(0, 10));
    assert.deepEqual(errors, [], `link-policy.json 無效：${errors.join('；')}`);
});

// ──────────────────────────────────────────────────────────────
// 六、例外政策在 runner 裡的實際效果
// ──────────────────────────────────────────────────────────────

test('政策：只降低 unverified 的噪音，404／410 一律不得被壓下去', async () => {
    // 這是 allowlist 最危險的失效模式：為了少幾則通知，把真的壞掉的連結一起藏起來。
    const host = `127.0.0.1`;
    const entries = validatePolicy(
        { version: 1, entries: [validEntry({ match: { host }, expires: '2026-10-01' })] },
        TODAY,
    ).entries;
    // 127.0.0.1 違反位址政策，所以連進不了 entries——這本身就是一道保險
    assert.equal(entries.length, 0, '指向 loopback 的例外連寫都不該寫得出來');

    // 改用純函式驗證「dead 不查政策」這條規則：check-external-links.mjs 的分支順序是
    //   dead → 直接進 dead 桶（不查政策）
    //   unverified → 才查政策
    const src = readFileSync(fileURLToPath(new URL('./check-external-links.mjs', import.meta.url)), 'utf8');
    const deadIdx = src.indexOf("if (verdict === 'dead')");
    const policyIdx = src.indexOf('matchPolicy(policyEntries');
    assert.ok(deadIdx > 0 && policyIdx > deadIdx, 'dead 分支必須排在查政策之前，且 dead 分支內不得呼叫 matchPolicy');
    const deadBranch = src.slice(deadIdx, policyIdx);
    assert.ok(!deadBranch.includes('matchPolicy'), 'dead 分支內不可查例外政策');
});

test('政策：403 這種 unverified 才會被例外壓下去', () => {
    const entries = validatePolicy({ version: 1, entries: [validEntry()] }, TODAY).entries;
    assert.ok(matchPolicy(entries, 'https://www.ptt.cc/bbs/SENIORHIGH/M.1272038439.A.517.html'));
});


// ──────────────────────────────────────────────────────────────
// 六之二、hijacked：被接管的網域（方向與 allowlist 相反）
// ──────────────────────────────────────────────────────────────

const validHijack = (over = {}) => ({
    match: { host: 'ieso-info.org' },
    reason: '舊網域已被轉作線上博弈站，與原賽事完全無關，且回 HTTP 200',
    evidence: '2026-08-28 實測 301 轉至 www 子網域，title 為 Best Online Pokies in Australia 2026',
    owner: 'thc1006',
    expires: '2026-10-01',
    ...over,
});
const hijackErrors = (over) => validatePolicy({ version: 1, entries: [], hijacked: [validHijack(over)] }, TODAY).errors;

test('hijacked：合法的一筆通過驗證', () => {
    const { errors, hijacked } = validatePolicy({ version: 1, entries: [], hijacked: [validHijack()] }, TODAY);
    assert.deepEqual(errors, []);
    assert.equal(hijacked.length, 1);
    assert.equal(hijacked[0]._key, 'hijacked:ieso-info.org');
});

test('hijacked：缺 evidence 一律拒絕（到期時要比對的就是它）', () => {
    assert.ok(hijackErrors({ evidence: undefined }).some((m) => m.includes('evidence')));
    assert.ok(hijackErrors({ evidence: 'x' }).some((m) => m.includes('evidence')), '敷衍的 evidence 不算');
});

test('hijacked：缺 reason／owner／expires 一律拒絕', () => {
    assert.ok(hijackErrors({ reason: undefined }).some((m) => m.includes('reason')));
    assert.ok(hijackErrors({ owner: undefined }).some((m) => m.includes('owner')));
    assert.ok(hijackErrors({ expires: undefined }).some((m) => m.includes('expires')));
});

test('hijacked：過期必須讓確定性 CI 失敗（強迫重新查證是否仍被接管）', () => {
    const errs = hijackErrors({ expires: '2026-08-27' });
    assert.ok(errs.some((m) => m.includes('到期')), `實際：${errs.join('；')}`);
    // 過期的那一筆絕不可以被回傳出去繼續生效
    const { hijacked } = validatePolicy({ version: 1, entries: [], hijacked: [validHijack({ expires: '2026-08-27' })] }, TODAY);
    assert.deepEqual(hijacked, []);
});

test('hijacked：不得有無期限警示（超過上限的 expires 一樣拒絕）', () => {
    assert.ok(hijackErrors({ expires: '2099-12-31' }).some((m) => m.includes('無期限')));
});

test('hijacked：只接受精確主機名，不接受萬用字元／路徑／網址', () => {
    assert.ok(hijackErrors({ match: { host: '*.ieso-info.org' } }).some((m) => m.includes('萬用字元')));
    assert.ok(hijackErrors({ match: { host: 'ieso-info.org/path' } }).some((m) => m.includes('主機名')));
    assert.ok(hijackErrors({ match: { host: 'IESO-Info.ORG' } }).some((m) => m.includes('小寫')));
    // 被接管是整台主機的性質，不是單一頁面，所以不收 url
    assert.ok(hijackErrors({ match: { url: 'https://ieso-info.org/x' } }).some((m) => m.includes('host')));
});

test('hijacked：目標本身也必須通過位址政策', () => {
    assert.ok(hijackErrors({ match: { host: 'metadata.google.internal' } }).some((m) => m.includes('位址政策')));
    assert.ok(hijackErrors({ match: { host: '127.0.0.1' } }).some((m) => m.includes('位址政策')));
});

test('hijacked：重複條目與未知欄位要報錯', () => {
    const dup = validatePolicy({ version: 1, entries: [], hijacked: [validHijack(), validHijack()] }, TODAY).errors;
    assert.ok(dup.some((m) => m.includes('重複')));
    assert.ok(hijackErrors({ note: 'x' }).some((m) => m.includes('note')));
});

test('hijacked：同一台主機不可同時是例外與被接管（自相矛盾的宣告）', () => {
    const { errors } = validatePolicy(
        {
            version: 1,
            entries: [validEntry({ match: { host: 'ieso-info.org' } })],
            hijacked: [validHijack()],
        },
        TODAY,
    );
    assert.ok(errors.some((m) => m.includes('同時出現在 entries')), `實際：${errors.join('；')}`);
});

test('hijacked：比對是完全相等，不得順帶涵蓋子網域或相似網域', () => {
    const { hijacked } = validatePolicy({ version: 1, entries: [], hijacked: [validHijack()] }, TODAY);
    assert.ok(matchHijacked(hijacked, 'https://ieso-info.org/'), '同主機命中');
    assert.ok(matchHijacked(hijacked, 'https://ieso-info.org/any/path?q=1'), '路徑不影響');
    assert.equal(matchHijacked(hijacked, 'https://www.ieso-info.org/'), null, '子網域不算');
    assert.equal(matchHijacked(hijacked, 'https://ieso-info.org.tw/'), null, '相似網域不算');
    assert.equal(matchHijacked(hijacked, 'https://evil-ieso-info.org/'), null, '子字串比對會誤中這個');
    assert.equal(matchHijacked(hijacked, 'not a url'), null);
    assert.equal(matchHijacked([], 'https://ieso-info.org/'), null);
});

test('hijacked：判定必須排在三態分類之前，否則 200 會被算成健康', () => {
    // 這是整份機制的重點：被接管的網域回的就是 200，一旦先跑 classifyLink，
    // 它就會進 healthy 而永遠不會被列出來——等於用檢查器替博弈站背書。
    // 註解裡提到 classifyLink 不算「呼叫」。比對前先把註解拿掉，否則這一條會被
    // 自己的說明文字騙過去——第一版就是這樣紅的：解釋順序的那句註解裡有
    // 「classifyLink」，位置比真正的 matchHijacked 還前面。
    const src = readFileSync(fileURLToPath(new URL('./check-external-links.mjs', import.meta.url)), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split(/\r?\n/)
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
    for (const scope of [/for \(let i = 0; i < targets\.length[\s\S]*?\n}/, /for \(let i = 0; i < bareHosts\.length[\s\S]*?\n    }/]) {
        const body = (src.match(scope) || [''])[0];
        assert.ok(body, '找不到分類迴圈，測試需要更新');
        const hijackIdx = body.indexOf('matchHijacked');
        const classifyIdx = body.indexOf('classifyLink');
        assert.ok(hijackIdx > 0, '分類迴圈裡必須查 hijacked 名單');
        assert.ok(hijackIdx < classifyIdx, 'matchHijacked 必須排在 classifyLink 之前');
    }
});

test('hijacked：repo 內的 link-policy.json 的 hijacked 現在就是有效的', () => {
    const file = fileURLToPath(new URL('./link-policy.json', import.meta.url));
    const { errors, hijacked } = validatePolicy(JSON.parse(readFileSync(file, 'utf8')), new Date().toISOString().slice(0, 10));
    assert.deepEqual(errors, [], `link-policy.json 無效：${errors.join('；')}`);
    assert.ok(hijacked.length > 0, 'hijacked 名單不應是空的——實測有三個被接管的網域');
    for (const h of hijacked) {
        assert.ok(/20\d\d-\d\d-\d\d/.test(h.evidence), `${h.match.host} 的 evidence 必須寫明實測日期`);
    }
});
// ──────────────────────────────────────────────────────────────
// 七、看門狗 issue 認領（沿用既有的 selectCanonicalIssue）
// ──────────────────────────────────────────────────────────────

const bot = (number, body) => ({ number, author: { login: ACTIONS_APP_LOGIN }, body });

test('issue 認領：兩支看門狗的標記不同，不可互相接管', () => {
    assert.notEqual(EXTERNAL_LINKS_MARKER, WATCHDOG_MARKER);
    const competitionsIssue = [bot(81, `${WATCHDOG_MARKER}\n\n上週報告`)];
    assert.deepEqual(
        selectCanonicalIssue(competitionsIssue, EXTERNAL_LINKS_MARKER),
        { action: 'create' },
        '外部連結看門狗不得接管競賽看門狗的 issue',
    );
    assert.deepEqual(selectCanonicalIssue(competitionsIssue), { action: 'comment', number: 81 });

    const externalIssue = [bot(90, `${EXTERNAL_LINKS_MARKER}\n\n上週報告`)];
    assert.deepEqual(selectCanonicalIssue(externalIssue, EXTERNAL_LINKS_MARKER), { action: 'comment', number: 90 });
    assert.deepEqual(selectCanonicalIssue(externalIssue), { action: 'create' });
});

test('issue 認領：多個 canonical issue 必須大聲失敗', () => {
    const r = selectCanonicalIssue([bot(91, EXTERNAL_LINKS_MARKER), bot(90, EXTERNAL_LINKS_MARKER)], EXTERNAL_LINKS_MARKER);
    assert.equal(r.action, 'fail');
    assert.deepEqual(r.numbers, [90, 91]);
});

test('issue 認領：空 marker 會讓認領退化成「只看作者」，必須拋錯', () => {
    for (const bad of ['', '   ', null, undefined === undefined ? 0 : 0]) {
        assert.throws(() => selectCanonicalIssue([bot(1, 'x')], bad), /marker/);
    }
});

// ──────────────────────────────────────────────────────────────
// 八、workflow 的安全不變量
// ──────────────────────────────────────────────────────────────
// YAML 裡的東西沒有型別檢查，改壞了不會有任何訊號——直到某週報告貼錯地方，
// 或某個分支被拿來當跳板。這幾條把「不可退讓的設定」釘成會紅的測試。

const workflow = () =>
    readFileSync(fileURLToPath(new URL('../.github/workflows/external-links-check.yml', import.meta.url)), 'utf8');

test('workflow：機器標記與程式碼裡的常數必須一致', () => {
    // 兩邊漂移的後果是：workflow 用舊標記去找 issue，永遠找不到自己上週開的那個，
    // 於是每週新開一個重複 issue，而且完全沒有錯誤訊號。
    assert.ok(
        workflow().includes(`MARKER: '${EXTERNAL_LINKS_MARKER}'`),
        `workflow 的 MARKER 必須等於 EXTERNAL_LINKS_MARKER（${EXTERNAL_LINKS_MARKER}）`,
    );
});

test('workflow：絕不可使用 pull_request_target 去探測 PR 提供的網址', () => {
    const y = workflow();
    assert.ok(!/^\s*pull_request_target\s*:/m.test(y), 'pull_request_target 會用可寫入的 token 跑 PR 的資料，等同現成的 SSRF 入口');
    assert.ok(!/^\s*pull_request\s*:/m.test(y), '外部站台的可用性是非確定性的，不該擋 PR');
});

test('workflow：只在 default branch 執行，且 shell 端另有一道相同的檢查', () => {
    const y = workflow();
    assert.match(y, /if: github\.ref == 'refs\/heads\/main'/, '必須有 job 層級的分支限制');
    assert.match(y, /GITHUB_REF" != "refs\/heads\/main"/, 'if: 被拿掉時要有第二道會 exit 1 的檢查');
    assert.match(y, /schedule\|workflow_dispatch\)/, '只接受 schedule 與 workflow_dispatch');
});

test('workflow：concurrency 不可取消進行中的 run', () => {
    const y = workflow();
    assert.match(y, /concurrency:\s*\n\s*group: external-links-watchdog\s*\n\s*cancel-in-progress: false/);
    assert.ok(!y.includes('competitions-watchdog'), '兩支排程不可共用同一個 concurrency group');
});

test('workflow：不得用 gh issue list --app（實測會靜默回 0 筆）', () => {
    // 只看實際會執行的那幾行。註解裡本來就寫著「刻意不用 --app」以及當初的實測
    // 數字，把註解一起比對會讓這個測試永遠是紅的。
    const code = workflow()
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .join('\n');
    assert.ok(!/--app\b/.test(code), '--app 對本 repo 回 0 筆且 exit 0，用它會每週新開重複 issue');
    assert.match(code, /gh issue list/, '仍然要真的去列出候選 issue');
    assert.match(code, /find-watchdog-issue\.mjs --marker/, '認領必須交給有單元測試覆蓋的 selectCanonicalIssue()');
});

test('workflow：第三方 action 一律 pin 完整 commit SHA', () => {
    const uses = [...workflow().matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1]);
    assert.ok(uses.length >= 2, '至少要用到 checkout 與 setup-node');
    for (const u of uses) {
        assert.match(u, /@[0-9a-f]{40}$/, `${u} 必須 pin 到 40 位 commit SHA，tag 是可移動的`);
    }
});

test('workflow：權限最小化與逾時上限', () => {
    const y = workflow();
    assert.match(y, /permissions:\s*\n\s*contents: read\s*\n\s*issues: write/, '只需要讀 repo 與開 issue');
    assert.match(y, /persist-credentials: false/, '不需要 authenticated git，不要把 token 留在 .git/config');
    assert.match(y, /timeout-minutes:/, 'job 必須有逾時上限');
});

test('issue 認領：CLI 的 --marker 有接線，且不接受空值', () => {
    const cli = fileURLToPath(new URL('./find-watchdog-issue.mjs', import.meta.url));
    const run = (payload, args = []) =>
        execFileSync(process.execPath, [cli, ...args], { input: JSON.stringify(payload), encoding: 'utf8' }).trim();

    assert.equal(run([bot(90, EXTERNAL_LINKS_MARKER)], ['--marker', EXTERNAL_LINKS_MARKER]), 'comment 90');
    assert.equal(run([bot(90, EXTERNAL_LINKS_MARKER)]), 'create', '不傳 marker 時用競賽標記，不該接管外部連結的 issue');
    assert.equal(run([bot(81, WATCHDOG_MARKER)], ['--marker', EXTERNAL_LINKS_MARKER]), 'create');

    let code = 0;
    try {
        execFileSync(process.execPath, [cli, '--marker'], { input: '[]', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
        code = err.status;
    }
    assert.equal(code, 1, '--marker 沒帶值時必須中止，不可安靜退回預設標記');
});
