#!/usr/bin/env node
/**
 * 連結健檢的 SSRF 防護與例外政策測試。
 * 全部打本機 http server 或純函式，DNS 結果在測試裡注入，不連外網也不查真的 DNS。外網會因
 * 防爬與站台狀態而飄，DNS 則要看執行的機器上 resolver 通不通。
 *
 * 為什麼要有這一份：「有寫防護」證明不了「防護擋得住」。這裡每一條都是先讓
 * 攻擊真的走一遍，再斷言它被擋下來，而不是只檢查程式碼裡有那個 if。
 *
 * 執行：  npm run test:link-health
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http, { createServer } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
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
    unverifiedBucket,
} from './link-health.lib.mjs';
import { probe as competitionsProbe } from './check-competitions.lib.mjs';
import { detectHijackSignals } from './hijack-signals.lib.mjs';
import { validatePolicy, matchPolicy, matchHijacked, matchHijackedHop, normalizeUrl, MAX_HORIZON_DAYS, expiringWithin, matchContentCheck, contentCheckGaps } from './link-policy.lib.mjs';
import { selectCanonicalIssue, WATCHDOG_MARKER, EXTERNAL_LINKS_MARKER, ACTIONS_APP_LOGIN } from './watchdog-issue.lib.mjs';
import { judgeUrl, judgeBare, needsAttention, renderReport, buildReport, expiringPolicyItems } from './check-external-links.lib.mjs';

/** 允許 loopback＝單元測試模式；正式執行走預設的嚴格模式。 */
const LOOPBACK_OK = { allowLoopback: true };
const PRIVATE_DNS_HOST = 'private-dns.example';

/**
 * onlyLoopbackNetwork 讓測試 t 的 http、https 請求只能送到 127.0.0.1，主機名一律查無此名，不查外部 DNS。
 * link-health.faults.mjs 拿掉防護之後，呼叫它的測試會真的連向目的地，其中有雲端 metadata 位址。
 * 名稱不能解析成被封鎖的位址，否則拿掉帳密檢查時，相容 probe 那條會被位址政策擋下而照樣通過。
 * @param {import('node:test').TestContext} t
 */
function onlyLoopbackNetwork(t) {
    for (const mod of [http, https]) {
        const send = mod.request;
        t.mock.method(mod, 'request', function (options, ...rest) {
            if (options?.hostname === '127.0.0.1') return send.call(this, options, ...rest);
            throw Object.assign(new Error(`測試攔下：不得連到 ${options?.hostname}`), { code: 'ETEST_TRANSPORT' });
        });
    }
    t.mock.method(dns.promises, 'lookup', async (host) => {
        const family = net.isIP(host);
        if (family) return [{ address: host, family }];
        throw Object.assign(new Error(`測試攔下：不查外部 DNS ${host}`), { code: 'ENOTFOUND' });
    });
}

let base;
let server;
let hits;
let headersOf;

/** SHELL 是只靠 JavaScript 轉走、不執行 JS 就看不到內容的殼，訊號 C 要抓的就是這種頁面。 */
const SHELL = '<html><head><script>window.location.replace("/next")</script></head><body></body></html>';

before(async () => {
    hits = new Map();
    headersOf = new Map();
    server = createServer((req, res) => {
        const u = req.url;
        hits.set(u, (hits.get(u) || 0) + 1);
        headersOf.set(u, req.headers);
        if (u === '/ok') { res.writeHead(200); return res.end('<html>ok</html>'); }
        if (u === '/404') { res.writeHead(404); return res.end('nope'); }
        if (u === '/410') { res.writeHead(410); return res.end('gone'); }
        if (u === '/403') { res.writeHead(403); return res.end('forbidden'); }
        if (u === '/429') { res.writeHead(429); return res.end('slow down'); }
        if (u === '/500') { res.writeHead(500); return res.end('boom'); }
        if (u === '/slow') { return; } // 不回應，用來測逾時
        if (u === '/reset') { return req.socket.destroy(); } // 收到請求就斷線，client 拿到 ECONNRESET
        // 回指定的狀態碼，分組的邊界（400、520、599）用得到
        const status = /^\/status\/(\d{3})$/.exec(u);
        if (status) { res.writeHead(Number(status[1])); return res.end(); }
        // 讀 body 的幾種結束方式：完整收到、超過讀取上限、chunked 回應中途斷線。
        if (u === '/shell') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(SHELL); }
        if (u === '/big-body') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('x'.repeat(4096)); }
        if (u === '/cut-shell') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.write(SHELL);
            return setTimeout(() => res.socket.destroy(), 20);
        }
        // 先送剛好 512 bytes，晚一點才送其餘的：讀到上限時 end 還沒來
        if (u === '/exact-then-more') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.write('x'.repeat(512));
            return setTimeout(() => res.end('y'.repeat(512)), 50);
        }
        // 300 bytes 的 Latin-1：0xE9 不是合法的 UTF-8，解碼後每個位元組都變成 3 bytes 的 U+FFFD
        if (u === '/latin1') { res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' }); return res.end(Buffer.alloc(300, 0xe9)); }
        // JS 轉址的殼與它的目的頁。https 的目的頁由 routeJsDest 改送到這台 server。
        const jsShell = { '/js-literal': 'window.location="https://dest.js-test.example/landing"',
            '/js-computed': 'window.location="https://dest.js-test.example/landing?t="+Date.now()',
            '/js-http': 'window.location="http://dest.js-test.example/landing"',
            '/js-other-org': 'window.location="https://dest.other-org.example/landing"',
            '/js-metadata': 'window.location="https://meta.js-test.example/latest/meta-data/"',
            '/js-to-shell': 'window.location="https://dest.js-test.example/dest-shell"',
            '/js-to-403': 'window.location="https://dest.js-test.example/forbidden"',
            '/js-creds': 'window.location="https://u:p@dest.js-test.example/landing"',
            '/dest-shell': 'location.replace("https://dest.js-test.example/x?t="+Date.now())' }[u];
        if (jsShell) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(`<html><head><title>x</title></head><body><script>${jsShell}</script></body></html>`); }
        if (u === '/js-404') { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html><body><script>window.location="https://dest.js-test.example/landing"</script></body></html>'); }
        if (u === '/forbidden') { res.writeHead(403); return res.end(); }
        if (u === '/to-js-literal') { res.writeHead(302, { Location: `http://shell.js-test.example:${server.address().port}/js-literal` }); return res.end(); }
        if (u === '/landing') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html><head><title>Landing</title></head><body>正常內容</body></html>'); }
        // SSRF 的轉址繞道：起點無害，第二跳才指向內網／metadata。
        if (u === '/to-metadata') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
        if (u === '/to-private') { res.writeHead(302, { Location: 'http://10.1.2.3/admin' }); return res.end(); }
        // 用 ULA 與 IPv4-mapped 而不是 ::1：這一組測試跑在「允許 loopback」的單元
        // 測試模式下（第一跳就是本機 server），::1 在該模式下本來就是允許的。
        if (u === '/to-ipv6-ula') { res.writeHead(302, { Location: 'http://[fd00::1]:9/x' }); return res.end(); }
        if (u === '/to-ipv4-mapped-metadata') { res.writeHead(302, { Location: 'http://[::ffff:169.254.169.254]/' }); return res.end(); }
        if (u === '/to-file') { res.writeHead(302, { Location: 'file:///etc/passwd' }); return res.end(); }
        // 167772161 是 10.0.0.1 的十進位寫法，這一條是混淆寫法加上轉址繞道。
        if (u === '/to-decimal-private') { res.writeHead(302, { Location: 'http://167772161/x' }); return res.end(); }
        if (u === '/to-creds') { res.writeHead(302, { Location: 'http://user:pass@example.com/' }); return res.end(); }
        if (u === '/to-dns-private') { res.writeHead(302, { Location: `http://${PRIVATE_DNS_HOST}/` }); return res.end(); }
        if (u === '/to-ok') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
        if (u === '/to-local-http') { res.writeHead(302, { Location: base + '/ok' }); return res.end(); }
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

test('讀 body：完整收到的不算截斷，訊號 C 看得到只靠 JavaScript 轉走的殼', async () => {
    const r = await probe(`${base}/shell`, undefined, { ...LOOPBACK_OK, readBodyBytes: 1024 });
    assert.equal(r.bodyHead, SHELL);
    assert.equal(r.bodyTruncated, undefined);
    assert.ok(detectHijackSignals(`${base}/shell`, r)?.shell);
});

test('讀 body：超過上限就算截斷，body 只留上限內的前綴', async () => {
    const r = await probe(`${base}/big-body`, undefined, { ...LOOPBACK_OK, readBodyBytes: 512 });
    assert.equal(r.bodyTruncated, true);
    assert.equal(r.bodyHead, 'x'.repeat(512));
});

test('讀 body：讀到上限時後面還有資料，也算截斷', async () => {
    const r = await probe(`${base}/exact-then-more`, undefined, { ...LOOPBACK_OK, readBodyBytes: 512 });
    assert.equal(r.bodyTruncated, true);
    assert.equal(r.bodyHead, 'x'.repeat(512));
});

test('讀 body：上限算的是原始位元組，非 UTF-8 的內容收完了就不算截斷', async () => {
    const r = await probe(`${base}/latin1`, undefined, { ...LOOPBACK_OK, readBodyBytes: 512 });
    assert.equal(r.bodyTruncated, undefined);
});

test('讀 body：chunked 回應中途斷線算截斷，同樣的殼不報訊號 C', async () => {
    const r = await probe(`${base}/cut-shell`, undefined, { ...LOOPBACK_OK, readBodyBytes: 1024 });
    assert.equal(r.bodyHead, SHELL);
    assert.equal(r.bodyTruncated, true);
    assert.equal(detectHijackSignals(`${base}/cut-shell`, r)?.shell ?? null, null);
});

test('沒有要讀 body 時，結果不帶 bodyHead 與 bodyTruncated', async () => {
    const r = await probe(`${base}/shell`, undefined, LOOPBACK_OK);
    assert.equal(r.bodyHead, undefined);
    assert.equal(r.bodyTruncated, undefined);
});

// 競賽看門狗與外部連結健檢共用這套三態分類。

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

// .invalid 也要經過機器上的 resolver，連不上 resolver 時拿到的是 EAI_AGAIN，所以錯誤直接在
// DNS 這一層注入。斷言寫在 mock 外面，mock 裡丟出的斷言錯誤會被當成 DNS 錯誤。
for (const { injected, reported, verdict } of [
    { injected: 'ENOTFOUND', reported: 'ENOTFOUND', verdict: 'dead' },
    // Windows 上名稱存在、卻沒有位址記錄（WSANO_DATA）時，Node 回報 ENOENT，Linux 則是 ENOTFOUND。
    { injected: 'ENOENT', reported: 'ENOTFOUND', verdict: 'dead' },
    // 暫時失敗不是失效。當成 ENOTFOUND 的話，resolver 一抖就會開 issue。
    { injected: 'EAI_AGAIN', reported: 'EAI_AGAIN', verdict: 'unverified' },
]) {
    test(`三態：DNS ${injected} → ${verdict}`, async (t) => {
        const lookup = t.mock.method(dns.promises, 'lookup', async () => {
            throw Object.assign(new Error(`測試注入的 DNS 錯誤 ${injected}`), { code: injected });
        });
        const r = await probe('https://dns-error.example/');
        assert.equal(lookup.mock.callCount(), 1, '必須真的走到 DNS 查詢');
        const [host, options] = lookup.mock.calls[0].arguments;
        assert.equal(host, 'dns-error.example');
        assert.equal(options?.all, true, '必須取回全部答案逐一檢查');
        assert.equal(r.status, 0);
        assert.equal(r.code, reported);
        assert.equal(classifyLink(r), verdict);
        assert.equal(isDeadResult(r), verdict === 'dead');
        assert.equal(isBlockedResult(r), false, 'DNS 失敗不是位址政策封鎖');
    });
}

test('三態：DNS 沒有回任何位址 → 視同 ENOTFOUND（dead），不是封鎖', async (t) => {
    const lookup = t.mock.method(dns.promises, 'lookup', async () => []);
    const r = await probe('https://dns-empty.example/');
    assert.equal(lookup.mock.callCount(), 1, '必須真的走到 DNS 查詢');
    assert.equal(r.code, 'ENOTFOUND');
    assert.equal(classifyLink(r), 'dead');
    assert.equal(isBlockedResult(r), false, '沒有答案不是位址政策封鎖');
});

test('三態：逾時 → unverified', async () => {
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

test('無法判定的分組：照本機 server 實際探測的結果分', async (t) => {
    const closed = createServer();
    await new Promise((r) => closed.listen(0, '127.0.0.1', r));
    const closedPort = closed.address().port;
    await new Promise((r) => closed.close(r));
    const groups = {
        rejected: [`${base}/403`, `${base}/429`, `${base}/status/400`],
        'server-error': [`${base}/500`, `${base}/status/520`, `${base}/status/599`],
        unreachable: [`http://127.0.0.1:${closedPort}/`, `${base}/reset`],
        // 用 https 連 http server，TLS 交握失敗，code 是 EPROTO。
        other: [`${base}/loop`, `${base.replace('http:', 'https:')}/ok`],
    };
    for (const [bucket, urls] of Object.entries(groups)) {
        for (const u of urls) {
            const r = await probe(u, undefined, LOOPBACK_OK);
            assert.equal(classifyLink(r), 'unverified', `${u}：${describeResult(r)}`);
            assert.equal(unverifiedBucket(r), bucket, `${u}：${describeResult(r)}`);
        }
    }
    const slow = await probe(`${base}/slow`, AbortSignal.timeout(300), LOOPBACK_OK);
    assert.equal(unverifiedBucket(slow), 'unreachable', describeResult(slow));
    // 憑證錯誤要有憑證才做得出來，主機或網路不可達、對方先關掉連線在本機也做不出來，這幾個直接用 code 測。
    for (const code of ['CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']) {
        assert.equal(unverifiedBucket({ status: 0, code }), 'other', code);
    }
    for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']) {
        assert.equal(unverifiedBucket({ status: 0, code }), 'unreachable', code);
    }
    // DNS 暫時失敗在 DNS 這一層注入。放在最後，因為 mock 也會攔下連本機 server 時的查詢。
    t.mock.method(dns.promises, 'lookup', async () => {
        throw Object.assign(new Error('測試注入的 DNS 錯誤 EAI_AGAIN'), { code: 'EAI_AGAIN' });
    });
    const again = await probe('https://dns-error.example/');
    assert.equal(again.code, 'EAI_AGAIN');
    assert.equal(unverifiedBucket(again), 'other');
});

test('一律用 GET（HEAD 不是使用者實際送的請求）', async () => {
    hits.clear();
    await probe(`${base}/ok`, undefined, LOOPBACK_OK);
    assert.ok(hits.get('/ok') >= 1, '必須真的送出請求');
});

test('UA：送出精簡格式的 Chrome UA，主版本不低於 134', async () => {
    headersOf.clear();
    await probe(`${base}/ok`, undefined, LOOPBACK_OK);
    const ua = headersOf.get('/ok')?.['user-agent'] ?? '';
    // 精簡後的 UA 只有主版本，其餘固定是 0.0.0。2026-10-25 實測 globalyouth.wharton.upenn.edu
    // 對 Chrome/120 到 133 都回 403。
    const m = /^Mozilla\/5\.0 \([^)]+\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/(\d+)\.0\.0\.0 Safari\/537\.36$/.exec(ua);
    assert.ok(m, `不是精簡格式的 Chrome UA：${ua}`);
    assert.ok(Number(m[1]) >= 134, `Chrome/${m[1]} 太舊`);
});

test('Sec-Fetch：轉址鏈的每一跳都送 UA，https 的每一跳都送 Sec-Fetch-*，轉到 http 的那一跳不送', async (t) => {
    // hops.example 的 https 請求改送到本機 http server：/to-ok 302 到同站的 /ok，/to-local-http 302 到 http 的本機 server。
    t.mock.method(dns.promises, 'lookup', async (host) => [{ address: host === 'hops.example' ? '8.8.8.8' : host, family: 4 }]);
    t.mock.method(https, 'request', (options, cb) =>
        http.request({ hostname: '127.0.0.1', port: server.address().port, path: options.path, headers: options.headers, agent: false }, cb));
    const sent = (path) => headersOf.get(path) ?? {};
    headersOf.clear();
    assert.equal((await probe('https://hops.example/to-ok', undefined, LOOPBACK_OK)).status, 200);
    for (const path of ['/to-ok', '/ok']) {
        assert.equal(sent(path)['sec-fetch-mode'], 'navigate', path);
        assert.match(sent(path)['user-agent'], /Chrome\/\d+\.0\.0\.0/, path);
    }
    headersOf.clear();
    assert.equal((await probe('https://hops.example/to-local-http', undefined, LOOPBACK_OK)).status, 200);
    assert.equal(sent('/to-local-http')['sec-fetch-mode'], 'navigate');
    assert.equal(sent('/ok')['sec-fetch-mode'], undefined, 'http 那一跳帶了 Sec-Fetch-*');
    assert.match(sent('/ok')['user-agent'], /Chrome\//);
});

test('Sec-Fetch：https 的請求帶 Chrome 直接開網頁時的四個 Sec-Fetch-*，http 的不帶', async (t) => {
    const secFetch = (headers) => Object.fromEntries(
        Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => k.startsWith('sec-fetch-')),
    );
    headersOf.clear();
    await probe(`${base}/ok`, undefined, LOOPBACK_OK);
    assert.deepEqual(secFetch(headersOf.get('/ok')), {}, 'http 的請求帶了 Sec-Fetch-*');

    // https 的請求不連出去：DNS 給公開位址，https.request 記下標頭就丟錯。
    t.mock.method(dns.promises, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
    let sent;
    t.mock.method(https, 'request', (options) => {
        sent = options?.headers;
        throw Object.assign(new Error('測試攔下：不連外'), { code: 'ETEST_TRANSPORT' });
    });
    await probe('https://sec-fetch.example/');
    assert.ok(sent, 'https.request 沒有被呼叫');
    assert.deepEqual(secFetch(sent), {
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'sec-fetch-user': '?1',
    });
});

/**
 * routeJsDest 讓殼頁的主機 shell.js-test.example 解析到本機 server；dest.js-test.example 與 dest.other-org.example
 * 解析成公開位址通過位址政策，https 請求改送到本機 server；meta.js-test.example 解析到雲端 metadata。
 * @param {import('node:test').TestContext} t
 */
function routeJsDest(t) {
    const answers = { 'shell.js-test.example': '127.0.0.1', 'start.elsewhere.example': '127.0.0.1', 'dest.js-test.example': '8.8.8.8', 'dest.other-org.example': '8.8.8.8', 'meta.js-test.example': '169.254.169.254' };
    t.mock.method(dns.promises, 'lookup', async (host) => {
        if (answers[host]) return [{ address: answers[host], family: 4 }];
        throw Object.assign(new Error(`測試攔下：不查外部 DNS ${host}`), { code: 'ENOTFOUND' });
    });
    t.mock.method(https, 'request', (options, cb) => {
        if (answers[options?.hostname] !== '8.8.8.8') throw Object.assign(new Error('測試攔下'), { code: 'ETEST_TRANSPORT' });
        return http.request({ hostname: '127.0.0.1', port: server.address().port, path: options.path, headers: options.headers, agent: false }, cb);
    });
}

const JS_BODY = { ...LOOPBACK_OK, readBodyBytes: 4096 };
const shellBase = () => `http://shell.js-test.example:${server.address().port}`;

test('JS 轉址：同一個可註冊網域底下的寫死 https 網址當成一跳，訊號看目的頁，轉址鏈標出那一跳', async (t) => {
    routeJsDest(t);
    const start = `${shellBase()}/js-literal`;
    const r = await probe(start, undefined, JS_BODY);
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.finalUrl, 'https://dest.js-test.example/landing');
    assert.deepEqual(r.redirects, [{ from: start, status: 200, to: 'https://dest.js-test.example/landing', via: 'js' }]);
    const sig = detectHijackSignals(start, r);
    assert.equal(sig?.shell, null, '目的頁有內容，不是殼');
    assert.equal(sig?.confidence, 'browse-only');
    assert.match(sig.cross.hops[0], /--JS 轉址-->/);
    // 和 HTTP 轉址算同一個上限，超過時回傳殼本身的結果；不讀 body 的呼叫端（競賽看門狗）看不到殼，不跟。
    const capped = await probe(start, undefined, { ...JS_BODY, maxRedirects: 0 });
    assert.equal(capped.finalUrl, start);
    assert.equal(detectHijackSignals(start, capped)?.confidence, 'actionable');
    assert.equal((await probe(start, undefined, LOOPBACK_OK)).finalUrl, start);
});

test('JS 轉址：目標是算出來的、http 或別的可註冊網域時不跟，殼照報；目的頁是殼照報', async (t) => {
    routeJsDest(t);
    for (const path of ['/js-computed', '/js-http', '/js-other-org']) {
        const r = await probe(`${shellBase()}${path}`, undefined, JS_BODY);
        assert.equal(r.finalUrl, `${shellBase()}${path}`, path);
        assert.equal(detectHijackSignals(`${shellBase()}${path}`, r)?.confidence, 'actionable', path);
    }
    const r = await probe(`${shellBase()}/js-to-shell`, undefined, JS_BODY);
    assert.equal(r.finalUrl, 'https://dest.js-test.example/dest-shell');
    const sig = detectHijackSignals(`${shellBase()}/js-to-shell`, r);
    assert.ok(sig?.shell, '目的頁是殼，訊號 C 要報');
    assert.equal(sig.confidence, 'actionable');
});

test('JS 轉址：目標被位址政策擋下時照封鎖處理', async (t) => {
    routeJsDest(t);
    const r = await probe(`${shellBase()}/js-metadata`, undefined, JS_BODY);
    assert.equal(isBlockedResult(r), true, JSON.stringify(r));
    assert.match(r.reason, /169\.254\.0\.0\/16/);
    assert.equal(r.redirects[0]?.via, 'js');
});

test('JS 轉址：盤點的起點 302 到別的網域，那裡的殼轉到同網域的另一台主機，不跟、殼照報', async (t) => {
    routeJsDest(t);
    const start = `http://start.elsewhere.example:${server.address().port}/to-js-literal`;
    const r = await probe(start, undefined, JS_BODY);
    assert.equal(r.finalUrl, `${shellBase()}/js-literal`);
    assert.equal(detectHijackSignals(start, r)?.confidence, 'actionable');
});

test('JS 轉址：目的頁不是 2xx／3xx 時回傳殼本身的結果，殼照報', async (t) => {
    routeJsDest(t);
    const r = await probe(`${shellBase()}/js-to-403`, undefined, JS_BODY);
    assert.equal(r.status, 200);
    assert.equal(r.finalUrl, `${shellBase()}/js-to-403`);
    assert.deepEqual(r.redirects, []);
    assert.equal(detectHijackSignals(`${shellBase()}/js-to-403`, r)?.confidence, 'actionable');
});

test('JS 轉址：404 的殼不跟、body 沒讀完不跟、帶帳密的目標照靜態政策擋下', async (t) => {
    routeJsDest(t);
    const gone = await probe(`${shellBase()}/js-404`, undefined, JS_BODY);
    assert.equal(gone.status, 404);
    assert.equal(gone.finalUrl, `${shellBase()}/js-404`);
    // 讀到 </script> 為止，轉址的寫法完整，只差 </body></html> 沒讀到。
    const cut = await probe(`${shellBase()}/js-literal`, undefined, { ...JS_BODY, readBodyBytes: 112 });
    assert.equal(cut.bodyTruncated, true);
    assert.equal(cut.finalUrl, `${shellBase()}/js-literal`, '只讀到前 112 bytes');
    const creds = await probe(`${shellBase()}/js-creds`, undefined, JS_BODY);
    assert.equal(isBlockedResult(creds), true, JSON.stringify(creds));
    assert.match(creds.reason, /credential/);
});

test('連線：每個位址的連線嘗試時間經過 Agent 交到 net.createConnection，比 Node 的預設長', async (t) => {
    // 連線嘗試真的等多久測不了：測試只能連 loopback，連不上的 loopback 位址會立刻被拒絕，不會等到逾時。
    const connect = t.mock.method(net, 'createConnection');
    const r = await probe(`${base}/ok`, undefined, LOOPBACK_OK);
    assert.equal(r.status, 200);
    assert.equal(connect.mock.callCount(), 1, '請求沒有經過 net.createConnection');
    const attempt = connect.mock.calls[0].arguments[0]?.autoSelectFamilyAttemptTimeout;
    assert.ok(attempt > net.getDefaultAutoSelectFamilyAttemptTimeout(), `autoSelectFamilyAttemptTimeout 是 ${attempt}`);
});

test('連線：https 的請求也帶上每個位址的連線嘗試時間', async (t) => {
    t.mock.method(dns.promises, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
    let attempt;
    t.mock.method(https, 'request', (options) => {
        attempt = options?.autoSelectFamilyAttemptTimeout;
        throw Object.assign(new Error('測試攔下：不連外'), { code: 'ETEST_TRANSPORT' });
    });
    await probe('https://attempt.example/');
    assert.ok(attempt > net.getDefaultAutoSelectFamilyAttemptTimeout(), `autoSelectFamilyAttemptTimeout 是 ${attempt}`);
});

// 靜態網址政策不需要 DNS，PR 階段就能確定性地跑。

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
    // 合法的公開網域不可被誤傷：.internal 是後綴比對，不能寫成子字串比對。
    for (const h of ['internal.example.com', 'my-local-site.com', 'localhost.example.org']) {
        assert.equal(staticUrlPolicy(`https://${h}/`).ok, true, `${h} 不該被誤擋`);
    }
});

test('SSRF：主機名結尾的點不可用來繞過（localhost. ≡ localhost）', () => {
    assert.equal(canonicalHost('LOCALHOST.'), 'localhost');
    assert.equal(staticUrlPolicy('http://LOCALHOST./').ok, false);
    assert.equal(staticUrlPolicy('http://metadata.google.internal./').ok, false);
});

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

// 下面到 runProbes 為止的測試走 probe 的實際連線流程，確認真的會擋下來，不只是純函式說會擋。

test('SSRF：預設（嚴格）模式下連本機 http server 會被擋，且沒有送出任何請求', async () => {
    hits.clear();
    const r = await probe(`${base}/ok`);
    assert.equal(isBlockedResult(r), true);
    assert.equal(r.code, 'EBLOCKED');
    assert.match(r.reason, /127\.0\.0\.0\/8/);
    assert.equal(hits.size, 0, '被擋下時不可已經把請求送出去');
    assert.match(describeResult(r), /位址政策封鎖/);
});

test('SSRF：轉址的每一跳都要重新驗證——第二跳指向 metadata 必須被擋', async (t) => {
    onlyLoopbackNetwork(t);
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

test('SSRF：DNS 解析結果才是判斷對象——公開網域解析到私網 IP 一樣要擋', async (t) => {
    // 名稱本身看不出問題，靜態政策會放行，問題只在解析結果。答案給兩個，公網在前、私網在後，
    // 只檢查第一個答案的實作也會被抓到。
    assert.equal(staticUrlPolicy(`http://${PRIVATE_DNS_HOST}/`).ok, true);
    const lookup = t.mock.method(dns.promises, 'lookup', async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
    ]);
    // 被擋下的答案若走到連線層就在送出前拋錯。requestOnce 會把例外吞成 status 0，
    // 測試失敗靠的是後面的斷言，不是這個例外。
    const request = t.mock.method(http, 'request', () => {
        throw Object.assign(new Error('測試攔下：被封鎖的 DNS 答案不得送出請求'), { code: 'ETEST_TRANSPORT' });
    });
    const resolved = await resolveAndVerify(PRIVATE_DNS_HOST);
    assert.equal(resolved.ok, false, '私網答案排在第二個也要擋下');
    assert.equal(resolved.code, undefined, '答案是私網位址，不是 DNS 失敗');
    assert.match(resolved.reason, /10\.0\.0\.0\/8/);

    const r = await probe(`http://${PRIVATE_DNS_HOST}/`);
    assert.equal(isBlockedResult(r), true, `應被位址政策擋下，實際：${JSON.stringify(r)}`);
    assert.match(r.reason, /10\.0\.0\.0\/8/);
    assert.equal(lookup.mock.callCount(), 2);
    for (const call of lookup.mock.calls) {
        assert.equal(call.arguments[0], PRIVATE_DNS_HOST);
        assert.equal(call.arguments[1]?.all, true, '必須取回全部答案逐一檢查');
    }
    assert.equal(request.mock.callCount(), 0, '被封鎖的 DNS 答案不得走到連線層');
});

test('SSRF：轉址到「解析成私網的公開網域」同樣要擋', async (t) => {
    const lookup = t.mock.method(dns.promises, 'lookup', async (host) =>
        host === '127.0.0.1' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }],
    );
    const originalRequest = http.request;
    // 第一跳是本機 server，照常送出；其他目的地在送出前拋錯，第二跳不會真的連出去。
    // 例外一樣會被 requestOnce 吞掉，測試失敗靠的是後面的斷言。
    const request = t.mock.method(http, 'request', function (options, ...args) {
        if (options?.hostname !== '127.0.0.1') {
            throw Object.assign(new Error(`測試攔下：不得送出到 ${options?.hostname}`), { code: 'ETEST_TRANSPORT' });
        }
        return originalRequest.call(this, options, ...args);
    });
    const r = await probe(`${base}/to-dns-private`, undefined, LOOPBACK_OK);
    assert.equal(isBlockedResult(r), true, `第二跳應被位址政策擋下，實際：${JSON.stringify(r)}`);
    assert.match(r.reason, /10\.0\.0\.0\/8/);
    assert.equal(r.redirects.length, 1, '應該已經走過第一跳才被擋在第二跳');
    const privateLookups = lookup.mock.calls.filter((call) => call.arguments[0] === PRIVATE_DNS_HOST);
    assert.equal(privateLookups.length, 1, `第二跳必須查 ${PRIVATE_DNS_HOST} 的 DNS`);
    assert.deepEqual(
        request.mock.calls.map((call) => call.arguments[0]?.hostname),
        ['127.0.0.1'],
        '只有第一跳的本機 server 可以送出',
    );
});

test('SSRF：被擋下的網址分類成 unverified，絕不可被說成 healthy 或 dead', async (t) => {
    onlyLoopbackNetwork(t);
    const r = await probe('http://169.254.169.254/latest/meta-data/');
    assert.equal(isBlockedResult(r), true);
    assert.equal(classifyLink(r), 'unverified');
    assert.equal(isDeadResult(r), false, '沒驗到就說它壞了是編造');
});

test('SSRF：競賽看門狗的相容 probe 只放寬 loopback，metadata 仍然擋得死', async (t) => {
    onlyLoopbackNetwork(t);
    // check-competitions.lib.mjs 的 probe 是為了讓看門狗的連線測試打得到本機 server
    // 而保留的別名，只放寬 loopback。這裡把「沒有放寬別的」釘住。
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
    // 「今天到期」也算過期，邊界不可偏向繼續放行。
    const today = validatePolicy({ version: 1, entries: [validEntry({ expires: TODAY })] }, TODAY);
    assert.match(today.errors[0], /到期/);

    // 過期的例外不可被回傳出去。只要它還在 entries 裡，任何呼叫 matchPolicy() 的
    // 地方就等於「過期的例外還在生效」：CI 紅了但實際行為沒變，是最糟的組合。
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

test('政策：只降低 unverified 的噪音，404／410 與網域解析不到一律不得被壓下去', () => {
    // 這是 allowlist 最危險的失效模式：為了少幾則通知，把真的壞掉的連結一起藏起來。
    const loopback = validatePolicy({ version: 1, entries: [validEntry({ match: { host: '127.0.0.1' } })] }, TODAY).entries;
    // 127.0.0.1 違反位址政策，所以連進不了 entries，這本身就是一道保險。
    assert.equal(loopback.length, 0, '指向 loopback 的例外連寫都不該寫得出來');

    const policy = { hijacked: [], entries: validatePolicy({ version: 1, entries: [validEntry()] }, TODAY).entries };
    const target = { url: 'https://www.ptt.cc/bbs/SENIORHIGH/index.html', occurrences: [] };
    for (const r of [{ status: 404 }, { status: 410 }, { status: 0, code: 'ENOTFOUND' }]) {
        assert.equal(judgeUrl(target, r, policy).bin, 'dead', `${describeResult(r)} 被例外壓下去了`);
    }
    assert.equal(judgeUrl(target, { status: 403 }, policy).bin, 'suppressed', '例外仍要能壓下 403');
});

// needsAttention 原本是頂層的 || 運算式，讀了宣告在後面的 const，只有前面的桶子全空的那一週才會崩潰（19f28e0）。
test('排程：needsAttention 在每一段都空的時候回 false，任何一段有東西就回 true', () => {
    const empty = { dead: [], blocked: [], bareDead: [], hijackedHits: [], expiringSoon: [], autoSignals: [], coverageComplete: true };
    assert.equal(needsAttention(empty), false);
    for (const [key, value] of [
        ['dead', [{}]],
        ['blocked', [{}]],
        ['bareDead', [{}]],
        ['hijackedHits', [{ source: 'url' }]],
        ['expiringSoon', [{}]],
        ['autoSignals', [{ confidence: 'actionable' }]],
        ['coverageComplete', false],
    ]) {
        assert.equal(needsAttention({ ...empty, [key]: value }), true, key);
    }
    assert.equal(needsAttention({ ...empty, hijackedHits: [{ source: 'bare' }] }), false, '說明文字裡的接管主機觸發了通知');
});

/** reportModel 是 renderReport 的參數：預設只有一個健康的網址、沒有裸網域，測試只覆寫自己關心的欄位。attention 沒給就照 needsAttention 算。 */
const reportModel = (over = {}) => {
    const m = {
        todayISO: TODAY, inventoryTotal: 1, targetsCount: 1, healthy: 1, dead: [], blocked: [], urlBlockedCount: 0,
        unverified: [], suppressed: [], hijackedHits: [], autoSignals: [], bareInfo: { total: 0, alreadyCoveredByUrls: 0 },
        bareRejected: [], bareUnresolved: [], bareHostsCount: 0, bareHealthy: 0, bareDead: [], bareOther: [],
        skipped: 0, bareSkipped: 0, budgetMs: 12 * 60_000, bareBudgetMs: 3 * 60_000, coverageComplete: true, expiringSoon: [], ...over,
    };
    return { attention: needsAttention(m), ...m };
};

/** reportSection 取出報告裡含 title 的那一段：從前面最近的 <details 到後面最近的 </details>。 */
function reportSection(report, title) {
    const at = report.indexOf(title);
    assert.ok(at >= 0, `報告裡沒有「${title}」`);
    return report.slice(report.lastIndexOf('<details', at), report.indexOf('</details>', at));
}

test('週報：資料 JSON 的出處帶 JSON pointer，競賽看門狗的註只附在 url 欄位的出處', () => {
    const comp = 'advanced-resources/competitions.json';
    const report = renderReport(reportModel({
        dead: [
            { url: 'https://a.example/', reason: 'HTTP 404', occurrences: [{ file: comp, location: '/competitions/3/url' }, { file: 'about.html', location: 'a[href]' }] },
            { url: 'https://b.example/', reason: 'HTTP 404', occurrences: [{ file: comp, location: '/competitions/89/description' }] },
        ],
    }));
    const a = report.slice(report.indexOf('https://a.example/'), report.indexOf('https://b.example/'));
    const b = report.slice(report.indexOf('https://b.example/'));
    assert.ok(a.includes(`出處：\`${comp} /competitions/3/url\``) && a.includes('出處：`about.html`'), a);
    assert.ok(a.includes('註：此檔另由 competitions-check.yml'), 'url 欄位的出處要附競賽看門狗的註');
    assert.ok(b.includes(`出處：\`${comp} /competitions/89/description\``), b);
    assert.ok(!b.includes('註：此檔另由'), '競賽看門狗只探測 url 欄位，說明文字的出處不附註');
});

test('週報：沒有待辦、也沒有無法判定的時候，才寫「全部外部連結正常」', () => {
    assert.ok(renderReport(reportModel()).includes('✅ 全部外部連結正常。'));
    const dead = [{ url: 'https://a.example/', reason: 'HTTP 404', occurrences: [] }];
    assert.ok(!renderReport(reportModel({ dead })).includes('全部外部連結正常'), '有失效連結時不可以寫全部正常');
    const unverified = [{ url: 'https://b.example/', reason: 'HTTP 403', occurrences: [], bucket: 'rejected' }];
    assert.ok(!renderReport(reportModel({ unverified })).includes('全部外部連結正常'), '有無法判定時不可以寫全部正常');
});

test('週報：盤點網址的無法判定照探測結果分組，各自列在對應的段落', () => {
    const cases = [
        ['https://a.example/', { status: 0, code: 'ABORT_ERR' }, 'unreachable', '連不上或沒有回應的連結'],
        ['https://b.example/', { status: 520 }, 'server-error', '站台回報伺服器錯誤的連結'],
        ['https://c.example/', { status: 403 }, 'rejected', '被站台拒絕的連結'],
        ['https://d.example/', { status: 0, code: 'CERT_HAS_EXPIRED' }, 'other', '其他無法判定的連結'],
    ];
    const unverified = cases.map(([url, r, bucket]) => {
        const { bin, item } = judgeUrl({ url, occurrences: [] }, r, { hijacked: [], entries: [] });
        assert.equal(bin, 'unverified', url);
        assert.equal(item.bucket, bucket, url);
        return item;
    });
    const report = renderReport(reportModel({ unverified }));
    for (const [url, , , title] of cases) {
        const section = reportSection(report, title);
        for (const [other] of cases) assert.equal(section.includes(other), other === url, `「${title}」那段與 ${other} 對不上`);
    }
    for (const title of ['連不上或沒有回應的連結', '站台回報伺服器錯誤的連結', '其他無法判定的連結']) {
        assert.match(reportSection(report, title), /^<details open>/, `「${title}」那段要展開`);
    }
    assert.match(reportSection(report, '被站台拒絕的連結'), /^<details><summary>/, '被站台拒絕那段收合');
});

/** SQUAT 是蹲域名的變現頁：標題與描述命中兩個以上的博弈詞組，訊號 B 要抓的就是這種頁面。 */
const SQUAT = '<html><head><title>Best Online Pokies 2026 - Play For Real Money</title>' +
    '<meta name="description" content="Claim free spins at trusted casinos with real money pokies"></head><body>x</body></html>';

test('週報：judgeUrl 與 judgeBare 把自動偵測的訊號連同來源交出來', () => {
    const occurrences = [{ file: 'a.html', location: 'a[href]' }];
    const shell = { status: 200, finalUrl: 'https://shell.example/', redirects: [], bodyHead: SHELL };
    const urlSignal = judgeUrl({ url: 'https://shell.example/', occurrences }, shell, { hijacked: [], entries: [] }).signal;
    assert.equal(urlSignal?.confidence, 'actionable', '只靠 JavaScript 轉走的殼要交出需處理的訊號');
    assert.equal(urlSignal.source, 'url');
    assert.deepEqual(urlSignal.occurrences, occurrences);
    const squat = { status: 200, finalUrl: 'https://squat.example/', redirects: [], bodyHead: SQUAT };
    const bareSignal = judgeBare({ host: 'squat.example', url: 'https://squat.example/', occurrences }, squat, { hijacked: [] }).signal;
    assert.equal(bareSignal?.confidence, 'actionable', '蹲域名的變現頁要交出需處理的訊號');
    assert.equal(bareSignal.source, 'bare');
    assert.equal(bareSignal.host, 'squat.example');
    assert.equal(judgeUrl({ url: 'https://ok.example/' }, { status: 200 }, { hijacked: [], entries: [] }).signal, null);
});

/** buildInput 是 buildReport 的參數：預設一個健康的網址、沒有裸網域、名單是空的，測試只覆寫自己關心的欄位。 */
const buildInput = (over = {}) => ({
    todayISO: TODAY, limit: 0, inventoryPath: '.reports/url-inventory.json', inventoryTotal: 1,
    targets: [{ url: 'https://ok.example/', occurrences: [] }], results: [{ status: 200 }], skipped: 0,
    bareInfo: { total: 0, alreadyCoveredByUrls: 0 }, bareCandidates: [], screen: { accepted: [], rejected: [], unresolved: [] },
    bareResults: [], bareSkipped: 0, policy: { entries: [], hijacked: [] }, budgetMs: 12 * 60_000, bareBudgetMs: 3 * 60_000,
    ...over,
});
/** bareHost 讓 buildInput 多一台只寫在說明文字裡、通過篩選的主機，r 是它的探測結果。 */
const bareHost = (host, r) => ({
    bareInfo: { total: 1, alreadyCoveredByUrls: 0 },
    bareCandidates: [{ host, occurrences: [{ file: 'advanced-resources/competitions.json', location: '/competitions/7/description' }] }],
    screen: { accepted: [host], rejected: [], unresolved: [] },
    bareResults: [r],
});
/** policyWith 回傳 validatePolicy 驗過的 hijacked 名單，每個參數覆寫一筆 validHijack 的欄位。 */
const policyWith = (...over) => validatePolicy({ version: 1, entries: [], hijacked: over.map((o) => validHijack(o)) }, TODAY).hijacked;

test('buildReport：沒有待辦時不通知，報告、GITHUB_OUTPUT 與主控台都照實寫', () => {
    const out = buildReport(buildInput());
    assert.equal(out.attention, false);
    assert.equal(out.coverageComplete, true);
    assert.equal(out.githubOutput, 'needs_attention=false\ncoverage_complete=true\n');
    assert.ok(out.report.includes('✅ 全部外部連結正常。'));
    assert.equal(out.consoleSummary[1], '  盤點來源：.reports/url-inventory.json（1 個去重網址）');
    assert.deepEqual(out.consoleTail, ['→ 無待辦項目。']);
});

test('buildReport：盤點網址的接管命中列進報告、不算例外，並觸發通知', () => {
    const url = 'https://ieso-info.org/x';
    const out = buildReport(buildInput({
        targets: [{ url, occurrences: [{ file: 'advanced-resources/competitions.json', location: '/competitions/17/url' }] }],
        results: [{ status: 200 }],
        policy: { entries: [], hijacked: policyWith({}) },
    }));
    assert.equal(out.attention, true, '盤點網址的接管命中沒有觸發通知');
    assert.equal(out.githubOutput, 'needs_attention=true\ncoverage_complete=true\n');
    const section = out.report.slice(out.report.indexOf('### 🚨 已知不可信任的主機'));
    assert.ok(section.startsWith('### 🚨'), '報告沒有列出接管主機');
    assert.ok(section.includes('- **ieso-info.org** — 這台主機本身已被接管（本次探測：HTTP 200）'), section.slice(0, 400));
    assert.ok(section.includes('出處：`advanced-resources/competitions.json /competitions/17/url`'), '接管主機要列出處');
    assert.ok(!out.report.includes('已列入例外政策的連結'), '接管命中被當成例外');
    assert.ok(!out.report.includes('全部外部連結正常'));
    assert.ok(out.consoleSummary.includes('🚨 已知不可信任的主機：1（盤點的網址 1）'));
    assert.deepEqual(out.consoleTail, ['→ 有項目需要處理，已寫入報告。']);
});

test('buildReport：說明文字裡點名的接管主機列在同一段，標明來源與 kind，本身不觸發通知', () => {
    const out = buildReport(buildInput({
        ...bareHost('arcade.now', { status: 200 }),
        policy: { entries: [], hijacked: policyWith({ match: { host: 'arcade.now' }, kind: 'terminus' }) },
    }));
    const section = out.report.slice(out.report.indexOf('### 🚨 已知不可信任的主機'));
    assert.ok(section.startsWith('### 🚨'), '說明文字裡的接管主機沒有列出來');
    assert.ok(section.includes('- **arcade.now** — 接管鏈的終點（本來就不是教育網域）（本次探測：HTTP 200）'), section.slice(0, 400));
    assert.ok(section.includes('來源：說明文字裡的裸網域（本身不觸發通知）'));
    assert.ok(out.consoleSummary.includes('  健康　　：0'), '接管主機算進了裸網域的健康數');
    assert.equal(out.attention, false, '說明文字裡的接管主機觸發了通知');
    assert.equal(out.githubOutput, 'needs_attention=false\ncoverage_complete=true\n');
    assert.ok(out.consoleSummary.includes('🚨 已知不可信任的主機：1（盤點的網址 0）'));
    assert.ok(!out.report.includes('全部外部連結正常'), '列出接管主機時不可以寫全部正常');
});

test('buildReport：需處理的自動訊號列進報告並觸發通知，盤點網址與裸網域都算', () => {
    const fromUrl = buildReport(buildInput({
        targets: [{ url: 'https://shell.example/', occurrences: [] }],
        results: [{ status: 200, finalUrl: 'https://shell.example/', redirects: [], bodyHead: SHELL }],
    }));
    assert.equal(fromUrl.attention, true, '盤點網址的需處理訊號沒有觸發通知');
    assert.ok(fromUrl.report.includes('### 🕵️ 自動偵測到的可疑訊號'), '報告沒有需處理的訊號那一段');
    assert.ok(fromUrl.report.includes('- **盤點的網址 `https://shell.example/`**'));
    const fromBare = buildReport(buildInput(bareHost('squat.example', { status: 200, finalUrl: 'https://squat.example/', redirects: [], bodyHead: SQUAT })));
    assert.equal(fromBare.attention, true, '裸網域的需處理訊號沒有觸發通知');
    assert.ok(fromBare.report.includes('- **說明文字裡的裸網域 `squat.example`**'));
});

test('buildReport：裸網域失效列進「說明文字裡的網域失效」並觸發通知，無法判定只列在收合的那一段', () => {
    const dead = buildReport(buildInput(bareHost('gone.example', { status: 0, code: 'ENOTFOUND' })));
    assert.equal(dead.attention, true);
    assert.ok(dead.report.includes('### 🔤 說明文字裡的網域失效'), '報告沒有說明文字裡的網域失效那一段');
    assert.ok(dead.report.includes('- **網域無法解析**：gone.example'));
    assert.ok(!dead.report.includes('說明文字裡的網域無法判定'));
    const other = buildReport(buildInput(bareHost('slow.example', { status: 403 })));
    assert.equal(other.attention, false, '裸網域的無法判定不該觸發通知');
    assert.ok(other.report.includes('<details><summary>🔤 說明文字裡的網域無法判定 1 筆</summary>'), '無法判定的裸網域被算成健康');
    assert.ok(other.report.includes('- HTTP 403：slow.example'));
});

test('buildReport：位址政策封鎖列在同一段，原因照探測結果寫，並觸發通知', () => {
    const out = buildReport(buildInput({
        targets: [{ url: 'https://evil.example/', occurrences: [] }],
        results: [{ status: 0, code: 'EBLOCKED', blocked: true, reason: '測試：evil.example 解析到被封鎖的位址' }],
        ...bareHost('evil-bare.example', { status: 0, code: 'EBLOCKED', blocked: true, reason: '測試：evil-bare.example 解析到被封鎖的位址' }),
    }));
    assert.equal(out.attention, true);
    const section = out.report.slice(out.report.indexOf('### 🛑 網址被位址政策擋下'));
    assert.ok(section.startsWith('### 🛑'), '報告沒有位址政策封鎖那一段');
    assert.ok(section.includes('- **測試：evil.example 解析到被封鎖的位址**'));
    assert.ok(section.includes('- **測試：evil-bare.example 解析到被封鎖的位址**'), '裸網域封鎖的原因要照探測結果寫');
    assert.ok(out.consoleSummary.filter((l) => l === '  位址封鎖：1').length === 2, '盤點網址與裸網域各一筆封鎖');
});

test('buildReport：DNS 沒答的裸網域、預算用完沒檢查的網址、--limit 都讓覆蓋不完整並觸發通知', () => {
    const unresolved = buildReport(buildInput({
        bareInfo: { total: 1, alreadyCoveredByUrls: 0 },
        bareCandidates: [{ host: 'weird.zz', occurrences: [] }],
        screen: { accepted: [], rejected: [], unresolved: [{ host: 'weird.zz', reason: '.zz 查不到答案（SERVFAIL）' }] },
    }));
    assert.equal(unresolved.coverageComplete, false);
    assert.equal(unresolved.githubOutput, 'needs_attention=true\ncoverage_complete=false\n');
    assert.ok(unresolved.report.includes('### ⚠️ 裸網域的 TLD 這次查不到答案（本次未檢查）'), '報告沒有 TLD 查不到那一段');
    assert.ok(unresolved.report.includes('- weird.zz — .zz 查不到答案（SERVFAIL）'));
    assert.ok(unresolved.consoleTail.includes('→ 覆蓋不完整：0 筆未檢查、1 筆未篩選，不可視為健康。'));
    const skipped = buildReport(buildInput({ results: [null], skipped: 1 }));
    assert.equal(skipped.githubOutput, 'needs_attention=true\ncoverage_complete=false\n');
    assert.ok(skipped.report.includes('### ⏱️ 檢查未完成（覆蓋不完整）'), '報告沒有檢查未完成那一段');
    assert.ok(skipped.report.includes('本次有 1 筆未檢查'));
    const limited = buildReport(buildInput({ limit: 3 }));
    assert.equal(limited.coverageComplete, false);
    assert.equal(limited.consoleTail[0], '→ 使用了 --limit 3：只驗了一部分，coverage_complete 一律為 false。');
});

test('buildReport：失效與例外照分類放，例外不觸發通知', () => {
    const entries = validatePolicy({ version: 1, entries: [validEntry()] }, TODAY).entries;
    const out = buildReport(buildInput({
        targets: [{ url: 'https://gone.example/', occurrences: [] }, { url: 'https://www.ptt.cc/bbs/x', occurrences: [] }],
        results: [{ status: 404 }, { status: 403 }],
        inventoryTotal: 2,
        policy: { entries, hijacked: [] },
    }));
    assert.ok(out.report.includes('- **HTTP 404**：https://gone.example/'));
    assert.ok(out.report.includes('<details><summary>📋 已列入例外政策的連結 1 筆'));
    const quiet = buildReport(buildInput({ targets: [{ url: 'https://www.ptt.cc/bbs/x', occurrences: [] }], results: [{ status: 403 }], policy: { entries, hijacked: [] } }));
    assert.equal(quiet.attention, false, '列入例外的 403 不該觸發通知');
});

test('政策：expiringWithin 列出 days 天以內到期的項目，照 UTC 日曆日算', () => {
    const at = (expires) => ({ match: { host: 'www.ptt.cc' }, expires });
    // TODAY 是 2026-08-27。明天與第 30 天到期的要列，第 31 天的不列；今天與昨天到期的是 validatePolicy 的錯誤，也不列。
    const items = ['2026-08-28', '2026-09-26', '2026-09-27', '2026-08-27', '2026-08-26'].map(at);
    assert.deepEqual(expiringWithin(items, TODAY, 30).map((e) => e.expires), ['2026-08-28', '2026-09-26']);
    assert.deepEqual(expiringWithin([at('2027-01-31'), at('2027-02-01')], '2027-01-01', 30).map((e) => e.expires), ['2027-01-31']);
    assert.deepEqual(expiringWithin(undefined, TODAY, 30), []);
});

test('排程：例外與接管警示在 30 天內到期時列進到期提醒，報告的第一段就是它', () => {
    const entry = validEntry({ expires: '2026-09-10' });
    const hijack = { match: { host: 'ieso-info.org' }, kind: 'hijacked', owner: 'test-owner', expires: '2026-09-26' };
    const later = { ...hijack, match: { host: 'hmun.org' }, expires: '2026-09-27' };
    const soon = expiringPolicyItems([entry], [hijack, later], TODAY);
    assert.deepEqual(soon.map((e) => [e.list, e.match.host, e.expires]), [['例外', 'www.ptt.cc', '2026-09-10'], ['接管警示', 'ieso-info.org', '2026-09-26']]);
    assert.equal(needsAttention({ dead: [], blocked: [], bareDead: [], hijackedHits: [], autoSignals: [], coverageComplete: true, expiringSoon: soon }), true);
    const report = renderReport(reportModel({ expiringSoon: soon }));
    const first = report.slice(report.indexOf('\n### '));
    assert.ok(first.startsWith('\n### ⏰ 連結政策有 2 筆在 30 天內到期'), first.slice(0, 80));
    assert.ok(first.includes('- 接管警示 `ieso-info.org`　到期日：2026-09-26') && first.includes('- 例外 `www.ptt.cc`　到期日：2026-09-10'));
    assert.ok(first.includes('不再留言'), '要寫明到期之後排程就不會再留言');
    assert.ok(!renderReport(reportModel()).includes('天內到期'), '沒有快到期的項目時不寫這一段');
});

test('buildReport：快到期的例外與接管警示觸發通知，報告的第一段與主控台都寫出來', () => {
    // 例外寫的是 match.url，到期提醒要印出網址，不是只會印 match.host。
    const entry = validEntry({ match: { url: 'https://www.ptt.cc/bbs/x' }, owner: 'test-owner', expires: '2026-09-10' });
    const { entries } = validatePolicy({ version: 1, entries: [entry] }, TODAY);
    const out = buildReport(buildInput({ policy: { entries, hijacked: policyWith({ owner: 'test-owner', expires: '2026-09-26' }) } }));
    assert.equal(out.attention, true, '快到期的項目沒有觸發通知');
    assert.equal(out.githubOutput, 'needs_attention=true\ncoverage_complete=true\n');
    const first = out.report.slice(out.report.indexOf('\n### '));
    assert.ok(first.startsWith('\n### ⏰ 連結政策有 2 筆在 30 天內到期'), first.slice(0, 80));
    assert.ok(first.includes('- 例外 `https://www.ptt.cc/bbs/x`　到期日：2026-09-10　負責人：test-owner'), first.slice(0, 600));
    assert.ok(first.includes('- 接管警示 `ieso-info.org`　到期日：2026-09-26　負責人：test-owner'), first.slice(0, 600));
    assert.ok(out.consoleSummary.includes('⏰ 30 天內到期的政策項目：2'));
    assert.deepEqual(out.consoleTail, ['→ 有項目需要處理，已寫入報告。']);
    assert.ok(!out.report.includes('全部外部連結正常'), '要通知時報告不可以寫全部正常');
});

test('buildReport：link-policy.json 最早的到期日前 30 天內，沒有其他待辦也會通知', (t) => {
    const policy = JSON.parse(readFileSync(new URL('./link-policy.json', import.meta.url), 'utf8'));
    const all = [...policy.entries, ...(policy.hijacked ?? [])];
    if (!all.length) return t.skip('link-policy.json 沒有任何項目');
    const earliest = all.map((e) => e.expires).sort()[0];
    // 到期前 27 天：在 30 天內，又離到期日夠遠，不會碰到 validatePolicy 的「已到期」。
    const today = new Date(Date.parse(`${earliest}T00:00:00Z`) - 27 * 86_400_000).toISOString().slice(0, 10);
    const { errors, entries, hijacked } = validatePolicy(policy, today);
    assert.deepEqual(errors, []);
    const out = buildReport(buildInput({ todayISO: today, policy: { entries, hijacked } }));
    assert.equal(out.attention, true, `${today} 起每週要通知 ${earliest} 到期的項目`);
    assert.ok(out.report.includes('### ⏰ 連結政策有'), '報告沒有到期提醒');
});

test('排程：說明文字裡的接管主機只列出、不觸發通知，盤點網址的接管命中才觸發', () => {
    const policy = { match: { host: 'ieso-info.org' }, kind: 'hijacked', reason: '測試用的接管說明', evidence: '測試用的證據', owner: 'test-owner', expires: '2026-10-01' };
    const bare = { url: 'https://ieso-info.org/', host: 'ieso-info.org', occurrences: [], reason: 'HTTP 200', policy, source: 'bare' };
    const linked = { url: 'https://hmun.org/x', occurrences: [], reason: 'HTTP 200', policy: { ...policy, match: { host: 'hmun.org' } }, source: 'url' };
    const quiet = { dead: [], blocked: [], bareDead: [], expiringSoon: [], autoSignals: [], coverageComplete: true };
    assert.equal(needsAttention({ ...quiet, hijackedHits: [bare] }), false, '說明文字裡的接管主機觸發了通知');
    assert.equal(needsAttention({ ...quiet, hijackedHits: [bare, linked] }), true, '盤點網址的接管命中沒有觸發通知');
    const onlyBare = renderReport(reportModel({ hijackedHits: [bare] }));
    assert.ok(onlyBare.includes('- **ieso-info.org**'), '說明文字裡的接管主機要照樣列出');
    assert.ok(!onlyBare.includes('全部外部連結正常'), '列出接管主機時不可以寫全部正常');
    const both = renderReport(reportModel({ hijackedHits: [bare, linked] }));
    const entry = (host) => both.slice(both.indexOf(`- **${host}**`)).split('\n').slice(0, 2).join('\n');
    assert.match(entry('ieso-info.org'), /來源：說明文字裡的裸網域（本身不觸發通知）/);
    assert.match(entry('hmun.org'), /來源：盤點的網址（會觸發通知/);
});

test('政策：403 這種 unverified 才會被例外壓下去', () => {
    const entries = validatePolicy({ version: 1, entries: [validEntry()] }, TODAY).entries;
    assert.ok(matchPolicy(entries, 'https://www.ptt.cc/bbs/SENIORHIGH/M.1272038439.A.517.html'));
});


// hijacked 名單列出不可信任的主機：不算進健康，盤點的網址不可以連到它們，說明文字裡的警告在期限內只列出、不通知。

const validHijack = (over = {}) => ({
    match: { host: 'ieso-info.org' },
    kind: 'hijacked',
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

test('hijacked：kind 必須是 hijacked 或 terminus', () => {
    // 名單裡有兩種不同的東西：hijacked 是「這台主機本身易主」（ieso-info.org），
    // terminus 是「接管鏈的終點，本來就不是教育網域」（arcade.now 是 www.sasmo.sg
    // 轉址到的廣告漏斗）。兩者處置相同，但把 terminus 稱作「被接管的網域」是不實
    // 敘述：arcade.now 沒有被誰接管，它就是接管方。標籤不實的警示沒有人會相信。
    assert.match(hijackErrors({ kind: undefined }).join('；'), /kind/);
    assert.match(hijackErrors({ kind: 'suspicious' }).join('；'), /kind/);
    assert.match(hijackErrors({ kind: '' }).join('；'), /kind/);
    for (const kind of ['hijacked', 'terminus']) {
        assert.deepEqual(hijackErrors({ kind }), [], `${kind} 必須是合法值`);
    }
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

test('政策：match.host 要寫成網址裡的主機名，國際化網域寫 punycode', () => {
    // 比對時網址的主機名已經正規化，Unicode 或全形的寫法通過驗證卻永遠比不到。
    // 訊息裡的寫法要是最後的形式：照著改一次就通過，不會改完小寫才看到要寫 punycode。
    const cases = [['例子.tw', 'xn--fsqu00a.tw'], ['ｈｍｕｎ.org', 'hmun.org'], ['ＨＭＵＮ.org', 'hmun.org'], ['Bücher.de', 'xn--bcher-kva.de']];
    for (const [host, fixed] of cases) {
        const { errors } = validatePolicy({ version: 1, entries: [validEntry({ match: { host } })] }, TODAY);
        assert.ok(errors.some((m) => m.includes(`：${fixed}（`) && m.includes('punycode')), `${host}：${errors.join('；')}`);
        assert.ok(hijackErrors({ match: { host } }).some((m) => m.includes(`：${fixed}（`)), host);
        assert.deepEqual(validatePolicy({ version: 1, entries: [validEntry({ match: { host: fixed } })] }, TODAY).errors, [], fixed);
    }
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
    const hmun = validatePolicy({ version: 1, entries: [], hijacked: [validHijack({ match: { host: 'hmun.org' } })] }, TODAY).hijacked;
    assert.ok(matchHijacked(hmun, 'https://HMUN.org./x'), '主機名的大小寫與結尾的點不影響比對');
});

test('hijacked：轉址鏈的任何一跳是名單上的主機也算命中', () => {
    const { hijacked } = validatePolicy({ version: 1, entries: [], hijacked: [validHijack()] }, TODAY);
    const via = (...to) => ({ status: 200, redirects: to.map((u) => ({ from: 'https://start.example/', status: 302, to: u })) });
    const hit = matchHijackedHop(hijacked, via('https://a.example/', 'https://ieso-info.org/x?y=1', 'https://b.example/'));
    assert.deepEqual(hit, { policy: hijacked[0], url: 'https://ieso-info.org/x?y=1' });
    assert.equal(matchHijackedHop(hijacked, via('https://www.ieso-info.org/')), null, '子網域不算');
    assert.equal(matchHijackedHop(hijacked, { status: 200 }), null, '沒有轉址');
});

test('hijacked：盤點的網址轉址經過名單上的主機也算接管命中，報告寫出轉址經過哪裡，而且點不了', () => {
    const { hijacked } = validatePolicy({ version: 1, entries: [], hijacked: [validHijack()] }, TODAY);
    // 轉址目標是接管主機給的，可以夾帶 @ 與 markdown 連結。
    const to = 'https://ieso-info.org/lp?ref=@someone&x=[click](https://evil.example/)';
    const r = { status: 200, finalUrl: to, redirects: [{ from: 'https://old.example/', status: 302, to }] };
    const { bin, item } = judgeUrl({ url: 'https://old.example/', occurrences: [] }, r, { hijacked, entries: [] });
    assert.equal(bin, 'hijacked', '轉址經過接管主機的網址被算成健康');
    assert.equal(item.source, 'url');
    assert.equal(item.via, to);
    const report = renderReport(reportModel({ hijackedHits: [item] }));
    assert.ok(report.includes(`  - 轉址經過：\`${to}\``), '轉址經過的網址要包成行內程式碼');
    assert.equal(needsAttention({ dead: [], blocked: [], bareDead: [], expiringSoon: [], autoSignals: [], coverageComplete: true, hijackedHits: [item] }), true);
});

test('buildReport：盤點的網址轉址經過接管主機，不算健康，列進報告並觸發通知', () => {
    const to = 'https://ieso-info.org/lp?subid=old.example';
    const out = buildReport(buildInput({
        targets: [{ url: 'https://old.example/', occurrences: [{ file: 'a.html', location: 'a[href]' }] }],
        results: [{ status: 200, finalUrl: to, redirects: [{ from: 'https://old.example/', status: 302, to }] }],
        policy: { entries: [], hijacked: policyWith({}) },
    }));
    assert.equal(out.attention, true, '轉址經過接管主機的網址沒有觸發通知');
    assert.equal(out.githubOutput, 'needs_attention=true\ncoverage_complete=true\n');
    assert.ok(out.report.includes(`  - 轉址經過：\`${to}\``), out.report);
    const urlHealthy = out.consoleSummary[out.consoleSummary.indexOf('  本次檢查：1') + 1];
    assert.equal(urlHealthy, '  健康　　：0', '轉址經過接管主機的網址算進了健康');
    assert.ok(out.consoleSummary.includes('🚨 已知不可信任的主機：1（盤點的網址 1）'));
});

test('hijacked：判定排在三態分類之前，回 200 的接管主機不算健康；位址政策封鎖又排在接管之前', () => {
    // 這是整份機制的重點：被接管的網域回的就是 200，一旦先跑 classifyLink，
    // 它就會進 healthy 而永遠不會被列出來，等於用檢查器替博弈站背書。
    const { hijacked } = validatePolicy({ version: 1, entries: [], hijacked: [validHijack()] }, TODAY);
    const url = judgeUrl({ url: 'https://ieso-info.org/', occurrences: [] }, { status: 200 }, { hijacked, entries: [] });
    assert.equal(url.bin, 'hijacked');
    assert.equal(url.item.source, 'url');
    const target = { host: 'ieso-info.org', url: 'https://ieso-info.org/', occurrences: [] };
    const bare = judgeBare(target, { status: 200 }, { hijacked });
    assert.equal(bare.bin, 'hijacked');
    assert.equal(bare.item.source, 'bare');
    const blockedResult = { status: 0, code: 'EBLOCKED', blocked: true, reason: '測試：解析到被封鎖的位址' };
    assert.equal(judgeUrl({ url: 'https://ieso-info.org/' }, blockedResult, { hijacked, entries: [] }).bin, 'blocked');
    assert.equal(judgeBare(target, blockedResult, { hijacked }).bin, 'blocked');
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

// contentChecks 列出對任何路徑都回 200 的主機，以及這些主機上每個網址要用哪個 API 驗內容。

const SPA = 'https://spa.example.org';
const validContentUrl = (over = {}) => ({
    url: `${SPA}/site/category?root=42&cid=42`,
    api: `${SPA}/api/Public?cid=42&first=true`,
    expect: { cid: 42 },
    ...over,
});
const validContentCheck = (over = {}) => ({
    match: { host: 'spa.example.org' },
    reason: '前端殼對任何路徑都回 200，內容由 API 載入',
    evidence: '2026-08-27 實測 /this/path/does/not/exist 也回同一個殼',
    owner: 'thc1006',
    expires: '2026-10-01',
    urls: [validContentUrl()],
    ...over,
});
const contentErrors = (over, extra = {}) =>
    validatePolicy({ version: 1, entries: [], hijacked: [], contentChecks: [validContentCheck(over)], ...extra }, TODAY).errors;

test('contentChecks：合法的一筆通過驗證；只連首頁的主機 urls 可以是空陣列', () => {
    const { errors, contentChecks } = validatePolicy({ version: 1, entries: [], contentChecks: [validContentCheck()] }, TODAY);
    assert.deepEqual(errors, []);
    assert.equal(contentChecks.length, 1);
    assert.equal(contentChecks[0]._key, 'contentChecks:spa.example.org');
    assert.deepEqual(contentErrors({ urls: [] }), []);
    // 最外層就寫錯時也回傳三份空名單，呼叫端不必另外判斷。
    for (const bad of ['x', { version: 1 }]) {
        const r = validatePolicy(bad, TODAY);
        assert.ok(r.errors.length > 0);
        assert.deepEqual([r.hijacked, r.contentChecks], [[], []]);
    }
});

test('contentChecks：缺 reason／evidence／owner／expires、過期或超過期限上限都拒絕，寫錯的不回傳', () => {
    for (const field of ['reason', 'evidence', 'owner', 'expires']) {
        const c = validContentCheck();
        delete c[field];
        const { errors, contentChecks } = validatePolicy({ version: 1, entries: [], contentChecks: [c] }, TODAY);
        assert.ok(errors.some((m) => m.includes(field)), `缺 ${field} 必須報錯，實際：${errors.join('；')}`);
        assert.deepEqual(contentChecks, []);
    }
    assert.ok(contentErrors({ expires: TODAY }).some((m) => /到期/.test(m)));
    assert.ok(contentErrors({ expires: '2099-12-31' }).some((m) => /無期限/.test(m)));
    assert.ok(contentErrors({ urls: undefined }).some((m) => m.includes('urls')));
    assert.ok(contentErrors({ extra: 1 }).some((m) => m.includes('未知欄位')));
});

test('contentChecks：match 只接受精確主機名，同一台主機不能重複，也不能同時列在 hijacked', () => {
    assert.ok(contentErrors({ match: { url: `${SPA}/` } }).some((m) => m.includes('match')));
    assert.ok(contentErrors({ match: { host: 'spa.example.org', url: `${SPA}/` } }).some((m) => m.includes('match')));
    assert.ok(contentErrors({ match: { host: '*.example.org' } }).some((m) => m.includes('萬用字元')));
    assert.ok(contentErrors({ match: { host: 'SPA.example.org' } }).some((m) => m.includes('要寫成網址裡的主機名')));
    const dup = validatePolicy({ version: 1, entries: [], contentChecks: [validContentCheck(), validContentCheck({ urls: [] })] }, TODAY);
    assert.ok(dup.errors.some((m) => m.includes('重複')));
    const hijack = { match: { host: 'spa.example.org' }, kind: 'hijacked', reason: '測試：已經易主的網域', evidence: '測試：2026-08-27 首頁是博弈站', owner: 'x', expires: '2026-10-01' };
    assert.deepEqual(validatePolicy({ version: 1, entries: [], hijacked: [hijack] }, TODAY).errors, []);
    assert.deepEqual(contentErrors({}, { hijacked: [hijack] }), ['contentChecks[0] 的主機 spa.example.org 列在 hijacked，不可信任的主機不必驗內容']);
});

test('contentChecks：網址要在宣告的主機上、寫成正規化的形式、不帶 fragment，也不能重複', () => {
    assert.ok(contentErrors({ urls: [validContentUrl({ url: 'https://other.example.org/x' })] }).some((m) => m.includes('要在同一台主機')));
    assert.ok(contentErrors({ urls: [validContentUrl({ url: 'HTTPS://spa.example.org/x' })] }).some((m) => m.includes('正規化')));
    assert.ok(contentErrors({ urls: [validContentUrl({ url: `${SPA}/x#top` })] }).some((m) => m.includes('fragment')));
    assert.ok(contentErrors({ urls: [validContentUrl(), validContentUrl()] }).some((m) => m.includes('重複')));
    assert.ok(contentErrors({ urls: [validContentUrl({ note: 'x' })] }).some((m) => m.includes('未知欄位')));
});

test('contentChecks：API 要用 https、和頁面同一台主機、不帶埠號，本身也要過位址政策', () => {
    assert.ok(contentErrors({ urls: [validContentUrl({ api: 'http://spa.example.org/api/Public?cid=42' })] }).some((m) => m.includes('https')));
    assert.ok(contentErrors({ urls: [validContentUrl({ api: 'https://api.example.net/Public?cid=42' })] }).some((m) => m.includes('同一台主機')));
    assert.ok(contentErrors({ urls: [validContentUrl({ api: 'https://169.254.169.254/latest/meta-data/' })] }).some((m) => m.includes('位址政策')));
    assert.ok(contentErrors({ urls: [validContentUrl({ api: `${SPA}/api/Public?cid=42#x` })] }).some((m) => m.includes('fragment')));
    assert.ok(contentErrors({ urls: [validContentUrl({ api: 'https://spa.example.org:8443/api/Public?cid=42' })] }).some((m) => m.includes('埠號')));
});

test('contentChecks：expect 是非空的物件，只比最外層的欄位，值只能是字串、有限的數字或布林', () => {
    for (const expect of [undefined, {}, [], { cid: { id: 42 } }, { cid: null }, { cid: Number.NaN }, { cid: [42] }]) {
        assert.ok(contentErrors({ urls: [validContentUrl({ expect })] }).some((m) => m.includes('expect')), `${JSON.stringify(expect)} 必須報錯`);
    }
    assert.deepEqual(contentErrors({ urls: [validContentUrl({ expect: { cid: 42, title: '自主學習專區', hide: false } })] }), []);
    assert.ok(contentErrors({ urls: [validContentUrl({ expect: { 'data.cid': 42 } })] }).some((m) => m.includes('最外層')), '巢狀欄位不支援，要報錯');
});

test('contentChecks：matchContentCheck 照正規化後的網址精確比對，回傳那一台主機的宣告與那一筆網址', () => {
    const { contentChecks } = validatePolicy({ version: 1, entries: [], contentChecks: [validContentCheck()] }, TODAY);
    const hit = matchContentCheck(contentChecks, `${SPA}/site/category?root=42&cid=42#main`);
    assert.equal(hit.check.match.host, 'spa.example.org');
    assert.deepEqual(hit.entry.expect, { cid: 42 });
    assert.equal(matchContentCheck(contentChecks, `${SPA}/site/category?root=42&cid=4`), null);
    assert.equal(matchContentCheck(contentChecks, `${SPA}/site/category?root=42&cid=42&x=1`), null);
    assert.equal(matchContentCheck(contentChecks, 'https://spa.example.org.evil.test/site/category?root=42&cid=42'), null);
    assert.equal(matchContentCheck(contentChecks, 'not a url'), null);
});

test('contentChecks：contentCheckGaps 列出宣告的主機上沒有內容檢查的網址，首頁與其他主機不列', () => {
    const { contentChecks } = validatePolicy({ version: 1, entries: [], contentChecks: [validContentCheck()] }, TODAY);
    const gaps = contentCheckGaps(contentChecks, [
        `${SPA}/site/category?root=42&cid=42`,
        `${SPA}/`,
        `${SPA}/#top`,
        `${SPA}/?lang=en`,
        `${SPA}/x`,
        'https://SPA.example.org./site/new',
        'http://spa.example.org/site/plain',
        'https://other.example.org/site/new',
    ]);
    assert.deepEqual(gaps.map((g) => g.url), [`${SPA}/?lang=en`, `${SPA}/x`, 'https://SPA.example.org./site/new', 'http://spa.example.org/site/plain']);
    assert.equal(gaps[1].check.match.host, 'spa.example.org');
});

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

// workflow 的安全不變量寫在 YAML 裡，沒有型別檢查，改壞了不會有任何訊號，直到某週
// 報告貼錯地方，或某個分支被拿來當跳板。這幾條把「不可退讓的設定」釘成會紅的測試。

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
