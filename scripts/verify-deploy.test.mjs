// scripts/verify-deploy.mjs 的測試。每個案例起一台本機 HTTP 伺服器，同時扮演站台的
// /build-info.json 與 GitHub 的 compare API，再用子行程執行腳本，檢查退出碼與輸出。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./verify-deploy.mjs', import.meta.url));
const SHA = 'a'.repeat(40); // 這次要驗的 commit
const NEWER = 'd'.repeat(40); // 後代
const OLDER = 'b'.repeat(40); // 祖先，或分岔的另一條歷史
const EXACT_RECHECK = '再確認：線上仍是本 commit。';

const live = (commit, age = 0) => ({ body: JSON.stringify({ commit }), age });
const relation = (status) => ({ body: JSON.stringify({ status }) });

/**
 * verify 起假伺服器，執行一次 verify-deploy.mjs。info 與 compare 依序回應，用完後重複最後一筆。
 * repo 為 false 時不設 GITHUB_REPOSITORY，腳本就不查 compare。
 */
async function verify({ info, compare = [relation('ahead')], repo = true }) {
    const requests = { info: 0, compare: 0, comparePaths: [] };
    const server = http.createServer((request, response) => {
        const isInfo = request.url === '/build-info.json';
        const isCompare = request.url.startsWith('/repos/owner/repo/compare/');
        if (!isInfo && !isCompare) {
            response.writeHead(404);
            response.end();
            return;
        }
        if (isCompare) requests.comparePaths.push(request.url);
        const queue = isInfo ? info : compare;
        const index = isInfo ? requests.info++ : requests.compare++;
        const reply = queue[Math.min(index, queue.length - 1)];
        const headers = { 'content-type': 'application/json' };
        if (reply.age !== undefined) headers.age = String(reply.age);
        response.writeHead(reply.status || 200, headers);
        response.end(reply.body);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        // 預算 1 秒比輪詢間隔 10 秒短，主迴圈只取一次；再確認只等 10 毫秒。
        // 開發機以 NODE_USE_ENV_PROXY 或 --use-env-proxy 開啟 proxy 時，fetch 會改走 HTTP_PROXY，
        // 請求到不了假伺服器。no_proxy 與 NO_PROXY 同時存在時以小寫的為準，所以兩個都設。
        const env = {
            ...process.env,
            SITE_URL: origin,
            GITHUB_API_URL: origin,
            GITHUB_SHA: SHA,
            VERIFY_TIMEOUT: '1',
            VERIFY_RECHECK: '0.01',
            NO_PROXY: '127.0.0.1',
            no_proxy: '127.0.0.1',
        };
        delete env.GITHUB_TOKEN;
        delete env.GITHUB_REPOSITORY;
        delete env.NODE_USE_ENV_PROXY;
        if (repo) env.GITHUB_REPOSITORY = 'owner/repo';
        const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('close', resolve);
        });
        return { code, stdout, stderr, requests };
    } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}

const matching = live(SHA);

test('精確命中、再確認仍是本 commit：成功且沒有警告', { timeout: 8000 }, async () => {
    const result = await verify({ info: [matching, matching] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.info, 2);
    assert.ok(result.stdout.includes(EXACT_RECHECK), result.stdout);
    assert.doesNotMatch(result.stdout, /信心較低/);
});

for (const [label, reply, shown] of [
    ['HTTP 404', { status: 404, body: 'missing' }, /最後看到：HTTP 404/],
    ['commit 格式不合法', { body: JSON.stringify({ commit: '../untrusted' }) }, /最後看到：\(commit 欄位不是 40 位十六進位，已拒絕\)/],
]) {
    test(`初次取得的資料無效（${label}）：不能判定成功`, { timeout: 8000 }, async () => {
        const result = await verify({ info: [reply], repo: false });
        assert.equal(result.code, 1, result.stdout + result.stderr);
        // 請求數與「最後看到」確認失敗來自這個回應，而不是連不上伺服器。
        assert.equal(result.requests.info, 1);
        assert.match(result.stderr, shown);
    });
}

test('線上是別的 commit、查不出關係：不能判定成功', { timeout: 8000 }, async () => {
    const result = await verify({ info: [live(OLDER)], repo: false });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.requests.info, 1);
    assert.match(result.stderr, /最後看到：b{40}/);
});

test('主迴圈的 compare 沒有回應：不能判定成功，失敗訊息記下次數', { timeout: 8000 }, async () => {
    const result = await verify({ info: [live(OLDER)], compare: [{ status: 502, body: 'bad gateway' }] });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.requests.compare, 1);
    assert.match(result.stderr, /注意：compare API 有 1 次沒有回應/);
});

// 失敗訊息結尾的常見原因固定提到部署順序倒過來，所以比對說明兩者關係的那一句。
for (const [name, status, note] of [
    ['線上是祖先：失敗並指出部署順序倒置', 'behind', /線上的 bbbbbbbbbbbb 是 aaaaaaaaaaaa 的祖先/],
    ['線上與本 commit 分岔：失敗並指出分岔', 'diverged', /線上的 bbbbbbbbbbbb 與 aaaaaaaaaaaa 分岔/],
]) {
    test(name, { timeout: 8000 }, async () => {
        const result = await verify({ info: [live(OLDER, 500)], compare: [relation(status)] });
        assert.equal(result.code, 1, result.stdout);
        assert.match(result.stderr, note);
        assert.match(result.stderr, /已等滿 1 秒的輪詢預算/);
    });
}

test('線上是後代：成功，再確認仍是後代也不扣信心', { timeout: 8000 }, async () => {
    const result = await verify({ info: [live(NEWER), live(NEWER)] });
    assert.equal(result.code, 0, result.stderr);
    // base 是本 commit、head 是線上的 commit，ahead 才代表線上較新。
    assert.equal(result.requests.comparePaths[0], `/repos/owner/repo/compare/${SHA}...${NEWER}`);
    assert.match(result.stdout, /為 aaaaaaaaaaaa 的後代/);
    assert.match(result.stdout, /（ahead），沒有退版/);
    assert.doesNotMatch(result.stdout, /信心較低/);
});

for (const [status, note] of [
    ['behind', /線上已變成 bbbbbbbbbbbb，那是 aaaaaaaaaaaa 的祖先/],
    ['diverged', /線上已變成 bbbbbbbbbbbb，與 aaaaaaaaaaaa 分岔/],
]) {
    test(`再確認時線上變成新鮮的 ${status}：判定退版而失敗`, { timeout: 8000 }, async () => {
        const result = await verify({ info: [matching, live(OLDER, 0)], compare: [relation(status)] });
        assert.equal(result.code, 1, result.stdout);
        assert.match(result.stderr, note);
        assert.match(result.stderr, /失敗發生在命中後的再確認/);
    });
}

test('再確認拿到很舊的快取副本：不採信，維持成功但扣信心', { timeout: 8000 }, async () => {
    const result = await verify({ info: [matching, live(OLDER, 500)], compare: [relation('behind')] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /有 1 次因為快取副本太舊而未採信/);
    assert.match(result.stdout, /信心較低/);
});

test('再確認時 compare API 失敗：維持成功，警告記在 compare API', { timeout: 8000 }, async () => {
    const result = await verify({ info: [matching, live(OLDER)], compare: [{ status: 502, body: 'bad gateway' }] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.compare, 1);
    assert.match(result.stdout, /compare API 有 1 次沒有回應/);
});
