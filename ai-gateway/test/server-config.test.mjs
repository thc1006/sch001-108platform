/**
 * HTTP 服務的設定（loadServerConfig）：預設值、origin 與代理清單的驗證、警告。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadServerConfig } from '../src/config.mjs';

function load(env) {
    const warnings = [];
    const config = loadServerConfig(env, { warn: (msg) => warnings.push(msg) });
    return { config, warnings };
}

test('loadServerConfig：預設值', () => {
    const { config, warnings } = load({});
    assert.deepEqual(config, {
        port: 8787,
        host: '127.0.0.1',
        allowedOrigins: ['https://thc1006.github.io'],
        clientIpHeader: '',
        trustedProxies: [],
        concurrency: 4,
        maxQueue: 8,
        queueTimeoutMs: 240_000,
        rateLimitWindowMs: 600_000,
        rateLimitMax: 100,
        requestLimitPerMinute: 120,
        clientMaxInflight: 6,
        v6Prefix: 64,
        blockSources: [],
        bodyTimeoutMs: 10_000,
        heartbeatMs: 15_000,
        shutdownGraceMs: 900_000,
        logLevel: 'info',
    });
    assert.deepEqual(warnings, []);
});

test('ALLOWED_ORIGINS：只收 https 的 origin（本機可用 http）；結尾斜線可以', () => {
    const { config, warnings } = load({
        ALLOWED_ORIGINS: 'https://thc1006.github.io/, http://localhost:4321, http://127.0.0.1:8000, http://[::1]:3000',
    });
    assert.deepEqual(config.allowedOrigins, ['https://thc1006.github.io', 'http://localhost:4321', 'http://127.0.0.1:8000', 'http://[::1]:3000']);
    assert.deepEqual(warnings, []);
});

test('ALLOWED_ORIGINS：帶路徑、萬用字元、結尾帶點、遠端 http、亂寫的值一律略過並警告', () => {
    const bad = [
        'https://thc1006.github.io/sch001-108platform',
        'https://*.github.io',
        'https://thc1006.github.io.',
        'http://thc1006.github.io',
        'null',
        'file:///etc/passwd',
        'https://user:pw@thc1006.github.io',
    ];
    const { config, warnings } = load({ ALLOWED_ORIGINS: ['https://ok.example', ...bad].join(',') });
    assert.deepEqual(config.allowedOrigins, ['https://ok.example']);
    assert.equal(warnings.length, bad.length);
    for (const w of warnings) assert.match(w, /不是可用的 origin/);
    // 看得出是哪一項被略過，但帳密不顯示
    assert.match(warnings[0], /"https:\/\/thc1006\.github\.io\/sch001-108platform"/);
    assert.doesNotMatch(warnings.join('\n'), /user:pw/);
});

// 瀏覽器送的 Origin 一律是正規化過的：小寫主機、不寫預設埠、中文網域轉成 punycode
test('ALLOWED_ORIGINS：比對前正規化（寫明 :443、大寫主機、中文網域都收），重複的只留一個', () => {
    const { config, warnings } = load({
        ALLOWED_ORIGINS: 'https://thc1006.github.io:443, HTTPS://THC1006.GitHub.io, https://例子.tw, http://LOCALHOST:4321',
    });
    assert.deepEqual(config.allowedOrigins, ['https://thc1006.github.io', 'https://xn--fsqu00a.tw', 'http://localhost:4321']);
    assert.deepEqual(warnings, []);
});

test('ALLOWED_ORIGINS：警告顯示原本寫的值（看得出寫錯了哪裡）；含帳密時帳密換成 ***', () => {
    const { warnings } = load({ ALLOWED_ORIGINS: 'https://ok.example, https://a.example:8443/x, https://user:pw@b.example' });
    assert.match(warnings[0], /"https:\/\/a\.example:8443\/x"/);
    assert.match(warnings[1], /"https:\/\/\*\*\*@b\.example"/);
    assert.doesNotMatch(warnings.join('\n'), /user|pw@/);
});

test('ALLOWED_ORIGINS：全部不合法時退回預設並警告', () => {
    const { config, warnings } = load({ ALLOWED_ORIGINS: 'https://a.example/path' });
    assert.deepEqual(config.allowedOrigins, ['https://thc1006.github.io']);
    assert.match(warnings.at(-1), /沒有任何合法的 origin，改用預設值/);
});

test('CLIENT_IP_HEADER 與 TRUSTED_PROXIES：要一起設定才採用標頭', () => {
    const ok = load({ CLIENT_IP_HEADER: 'X-Forwarded-For', TRUSTED_PROXIES: '10.42.0.1, 10.42.0.0/16' });
    assert.equal(ok.config.clientIpHeader, 'x-forwarded-for');
    assert.deepEqual(ok.config.trustedProxies, ['10.42.0.1/32', '10.42.0.0/16']);
    assert.deepEqual(ok.warnings, []);

    const noProxy = load({ CLIENT_IP_HEADER: 'x-forwarded-for' });
    assert.match(noProxy.warnings.join('\n'), /沒有 TRUSTED_PROXIES：標頭一律不採用/);
});

test('CLIENT_IP_HEADER 不是合法的標頭名稱：警告並改看連線來源（而不是默默變成空字串）', () => {
    for (const header of ['X_Forwarded_For', 'x-forwarded-for,x-real-ip', 'x forwarded']) {
        const { config, warnings } = load({ CLIENT_IP_HEADER: header });
        assert.equal(config.clientIpHeader, '');
        assert.match(warnings.join('\n'), /不是合法的標頭名稱/, header);
    }
});

test('TRUSTED_PROXIES：不是 IPv4 位址或 CIDR 的項目略過並警告', () => {
    const { config, warnings } = load({ CLIENT_IP_HEADER: 'x-forwarded-for', TRUSTED_PROXIES: '10.0.0.1, 10.0.0.0/33, 300.1.1.1, ::1, abc, 192.168.0.0/24' });
    assert.deepEqual(config.trustedProxies, ['10.0.0.1/32', '192.168.0.0/24']);
    assert.equal(warnings.length, 4);
    assert.match(warnings[0], /"10\.0\.0\.0\/33"/);
});

test('TRUSTED_PROXIES：含 /0（等於信任所有來源）要警告；只設代理、沒設 CLIENT_IP_HEADER 也要警告', () => {
    const everyone = load({ CLIENT_IP_HEADER: 'x-forwarded-for', TRUSTED_PROXIES: '10.42.0.0/16, 0.0.0.0/0' });
    assert.deepEqual(everyone.config.trustedProxies, ['10.42.0.0/16', '0.0.0.0/0']);
    assert.equal(everyone.warnings.length, 1);
    assert.match(everyone.warnings[0], /"0\.0\.0\.0\/0" 等於信任所有來源/);

    const noHeader = load({ TRUSTED_PROXIES: '10.42.0.0/16' });
    assert.equal(noHeader.config.clientIpHeader, '');
    assert.match(noHeader.warnings.join('\n'), /設定了 TRUSTED_PROXIES 卻沒有 CLIENT_IP_HEADER/);
});

// 前端（public/shared/platform-ai.js 的 IDLE_TIMEOUT_MS）60 秒沒收到任何位元組就當成斷線
test('HEARTBEAT_MS 上限 30000：再慢的話，前端會把正常進行中的任務當成斷線', () => {
    assert.equal(load({ HEARTBEAT_MS: '30000' }).config.heartbeatMs, 30_000);
    const tooSlow = load({ HEARTBEAT_MS: '30001' });
    assert.equal(tooSlow.config.heartbeatMs, 15_000);
    assert.match(tooSlow.warnings[0], /HEARTBEAT_MS/);
});

test('PORT=0 由系統挑埠；REQUEST_LIMIT_PER_MINUTE 與 BODY_TIMEOUT_MS 的範圍', () => {
    assert.equal(load({ PORT: '0' }).config.port, 0);
    assert.equal(load({ REQUEST_LIMIT_PER_MINUTE: '300', BODY_TIMEOUT_MS: '5000' }).config.requestLimitPerMinute, 300);
    const bad = load({ REQUEST_LIMIT_PER_MINUTE: '5', BODY_TIMEOUT_MS: '500' });
    assert.equal(bad.config.requestLimitPerMinute, 120);
    assert.equal(bad.config.bodyTimeoutMs, 10_000);
    assert.equal(bad.warnings.length, 2);
});

test('LOG_LEVEL 不合法：退回 info，警告裡的原值經過跳脫（不能藉換行偽造 log）', () => {
    const { config, warnings } = load({ LOG_LEVEL: 'debug\n2026-10-21T00:00:00Z error FAKE' });
    assert.equal(config.logLevel, 'info');
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /\n/);
    assert.equal(load({ LOG_LEVEL: ' WARN ' }).config.logLevel, 'warn');
});

test('數值設定超出範圍：退回預設並警告', () => {
    const { config, warnings } = load({ RATE_LIMIT_MAX: '5000', CLIENT_MAX_INFLIGHT: '0', LLM_CONCURRENCY: '9', PORT: '70000' });
    assert.equal(config.rateLimitMax, 100);
    assert.equal(config.clientMaxInflight, 6);
    assert.equal(config.concurrency, 4);
    assert.equal(config.port, 8787);
    assert.equal(warnings.length, 4);
});

test('AI_V6_PREFIX：32～128 的整數；超出範圍或不是整數就用 64 並警告', () => {
    assert.equal(load({ AI_V6_PREFIX: '48' }).config.v6Prefix, 48);
    assert.equal(load({ AI_V6_PREFIX: ' 128 ' }).config.v6Prefix, 128);
    for (const raw of ['31', '129', '/48', '48.5', 'abc']) {
        const { config, warnings } = load({ AI_V6_PREFIX: raw });
        assert.equal(config.v6Prefix, 64, raw);
        assert.equal(warnings.length, 1, raw);
        assert.match(warnings[0], /AI_V6_PREFIX/, raw);
    }
});

test('AI_BLOCK_SOURCES：IPv4、IPv6 的位址或 CIDR，逗號、分號、空白與換行都可以分隔；寫錯的項目略過，警告只說第幾項', () => {
    const { config, warnings } = load({
        AI_BLOCK_SOURCES: ' 192.0.2.0/24, 2001:DB8::/32 ;198.51.100.7\n,,::ffff:203.0.113.0/120  192.0.2.0/33, fe80::1%eth0, [2001:db8::1], 2001:db8::/129, 300.1.1.1, abc',
    });
    assert.deepEqual(config.blockSources, ['192.0.2.0/24', '2001:db8::/32', '198.51.100.7/32', '203.0.113.0/24']);
    assert.deepEqual(warnings, [5, 6, 7, 8, 9, 10].map((n) => `設定 AI_BLOCK_SOURCES 的第 ${n} 項不是 IPv4、IPv6 位址或 CIDR，已略過`));
});

test('AI_BLOCK_SOURCES：涵蓋所有 IPv4、比 IPv4 /8 或 IPv6 /16 大、前綴之後還有 1 的項目都略過並警告', () => {
    const items = ['0.0.0.0/0', '::/0', '::/80', '::ffff:192.0.2.0/24', '203.0.113.0/2', '2001::/15', '198.51.100.7/24', '2001:db8::1/32', '::ffff:192.0.2.4/97', '10.0.0.0/8', '2001::/16'];
    const { config, warnings } = load({ AI_BLOCK_SOURCES: items.join(',') });
    assert.deepEqual(config.blockSources, ['10.0.0.0/8', '2001::/16']);
    assert.equal(warnings.length, 9);
    for (const [i, reason] of [[0, /涵蓋所有的 IPv4/], [3, /涵蓋所有的 IPv4/], [4, /範圍太大/], [5, /範圍太大/], [6, /在前綴之後還有 1/], [7, /在前綴之後還有 1/], [8, /範圍太大/]]) {
        assert.match(warnings[i], new RegExp(`第 ${i + 1} 項${reason.source}`), items[i]);
    }
    // 位址不進 log
    assert.ok(warnings.every((w) => items.every((item) => !w.includes(item.split('/')[0]))), warnings.join('\n'));
});
