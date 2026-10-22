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
// build 是本 commit 的某一次部署，fields 照 build-info.mjs 寫的 runNumber、aiGatewayUrl。
const build = (fields, age = 0) => ({ body: JSON.stringify({ commit: SHA, ...fields }), age });
const relation = (status) => ({ body: JSON.stringify({ status }) });

/**
 * verify 起假伺服器，執行一次 verify-deploy.mjs。info 與 compare 依序回應，用完後重複最後一筆。
 * repo 為 false 時不設 GITHUB_REPOSITORY，腳本就不查 compare。budget 是 VERIFY_TIMEOUT 的秒數。
 * actions 為 true 時設 GITHUB_ACTIONS=true。env 最後蓋上去，例如 GITHUB_RUN_NUMBER。
 */
async function verify({ info, compare = [relation('ahead')], repo = true, budget = 1, actions = false, env: extra = {} }) {
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
        if (reply.disconnect) {
            request.socket.destroy();
            return;
        }
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
        // 預設的預算 1 秒比輪詢間隔 10 秒短，主迴圈只取一次；再確認只等 10 毫秒。
        // 開發機以 NODE_USE_ENV_PROXY 或 --use-env-proxy 開啟 proxy 時，fetch 會改走 HTTP_PROXY，
        // 請求到不了假伺服器。no_proxy 與 NO_PROXY 同時存在時以小寫的為準，所以兩個都設。
        const env = {
            ...process.env,
            SITE_URL: origin,
            GITHUB_API_URL: origin,
            GITHUB_SHA: SHA,
            VERIFY_TIMEOUT: String(budget),
            VERIFY_RECHECK: '0.01',
            NO_PROXY: '127.0.0.1',
            no_proxy: '127.0.0.1',
        };
        delete env.GITHUB_TOKEN;
        delete env.GITHUB_REPOSITORY;
        delete env.GITHUB_ACTIONS;
        delete env.NODE_USE_ENV_PROXY;
        // Actions 的每個 job 都有 GITHUB_RUN_NUMBER。繼承到的話，只寫了 commit 的 build-info 會被當成較早的 run。
        delete env.GITHUB_RUN_NUMBER;
        delete env.GITHUB_RUN_ATTEMPT;
        delete env.PUBLIC_AI_GATEWAY_URL;
        if (repo) env.GITHUB_REPOSITORY = 'owner/repo';
        if (actions) env.GITHUB_ACTIONS = 'true';
        Object.assign(env, extra);
        const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: (budget + 4) * 1000 });
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
    ['HTTP 404', { status: 404, body: 'missing' }, /未取得有效的線上 commit，最後看到：HTTP 404。/],
    ['HTTP 500', { status: 500, body: 'unavailable' }, /未取得有效的線上 commit，最後看到：HTTP 500。/],
    ['沒有 commit 欄位', { body: '{}' }, /未取得有效的線上 commit，最後看到：\(無 commit 欄位\)。/],
    ['commit 格式不合法', { body: JSON.stringify({ commit: '../untrusted' }) }, /未取得有效的線上 commit，最後看到：\(commit 欄位不是 40 位十六進位，已拒絕\)。/],
    ['JSON 壞掉', { body: '{' }, /再確認時取不到線上資料/],
    ['連線被重設', { disconnect: true }, /再確認時取不到線上資料/],
]) {
    test(`再確認取不到有效資料（${label}）：維持成功，但說明信心較低`, { timeout: 8000 }, async () => {
        const result = await verify({ info: [matching, reply] });
        // 初次已經命中，再確認的暫時故障不推翻成功，只扣信心。
        assert.equal(result.code, 0, result.stderr);
        assert.ok(result.requests.info >= 2);
        assert.ok(!result.stdout.includes(EXACT_RECHECK), result.stdout);
        assert.match(result.stdout, shown);
        assert.match(result.stdout, /維持原本的成功結論/);
        assert.match(result.stdout, /再確認有 1 次未取得有效線上資料/);
        assert.match(result.stdout, /信心較低/);
        assert.doesNotMatch(result.stdout, /compare API 有/);
    });
}

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

// 輪詢間隔固定 10 秒。預算 15 秒時主迴圈取兩次，這一案因此要等 10 秒。
test('主迴圈的 compare 先沒有回應、下一輪查到後代：成功且不扣信心', { timeout: 25000 }, async () => {
    const result = await verify({
        info: [live(NEWER)],
        compare: [{ status: 502, body: 'bad gateway' }, relation('ahead')],
        budget: 15,
    });
    assert.equal(result.code, 0, result.stderr);
    // 沒有回應的那次不記進 probed，第二輪會再查；再確認又查一次。
    assert.equal(result.requests.compare, 3);
    assert.match(result.stdout, /第 2 次嘗試：線上是 dddddddddddd，為 aaaaaaaaaaaa 的後代/);
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

for (const [age, note, code, shown] of [
    ['abc', '不合法，當成 0，判定退版', 1, /失敗發生在命中後的再確認/],
    ['500.5', '不是整數，當成 0，判定退版', 1, /失敗發生在命中後的再確認/],
    ['10, 500', '取第一個值 10，判定退版', 1, /失敗發生在命中後的再確認/],
    ['500, 10', '取第一個值 500，當成舊快取', 0, /拿到 Age=500s 的快取副本/],
]) {
    test(`再確認時 Age 是 ${JSON.stringify(age)}：${note}`, { timeout: 8000 }, async () => {
        const result = await verify({ info: [matching, live(OLDER, age)], compare: [relation('behind')] });
        assert.equal(result.code, code, result.stdout + result.stderr);
        assert.match(result.stdout + result.stderr, shown);
    });
}

test('再確認時 compare API 失敗：維持成功，警告記在 compare API', { timeout: 8000 }, async () => {
    const result = await verify({ info: [matching, live(OLDER)], compare: [{ status: 502, body: 'bad gateway' }] });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.requests.compare, 1);
    assert.match(result.stdout, /再確認時 compare API 有 1 次沒有回應/);
    assert.doesNotMatch(result.stdout, /再確認有/);
});

test('再確認時 compare 回文件沒有的 status：當成查不出關係', { timeout: 8000 }, async () => {
    const result = await verify({ info: [matching, live(OLDER)], compare: [relation('weird')] });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /再確認時 compare API 有 1 次沒有回應/);
    assert.doesNotMatch(result.stdout, /沒有退版/);
});

for (const [label, actions, info, expected] of [
    ['在 Actions 上、信心較低', true, [matching, { status: 404, body: 'missing' }], ['::warning title=部署驗證信心較低::再確認有 1 次未取得有效線上資料']],
    ['不在 Actions 上', false, [matching, { status: 404, body: 'missing' }], []],
    ['在 Actions 上、沒有疑慮', true, [matching, matching], []],
]) {
    test(`Actions 的 warning annotation（${label}）`, { timeout: 8000 }, async () => {
        const result = await verify({ info, actions });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('::')), expected);
    });
}

// 只改 repository variable 就重新部署時 commit 不變，產物卻不同，要靠 runNumber 分辨。
// 「還沒落地」的案例都確認只請求一次 build-info：主迴圈誤判命中時，再確認會再請求一次。
const RUN = { GITHUB_RUN_NUMBER: '42' };

test('線上是本 commit、但來自較早的 run：還沒落地', { timeout: 8000 }, async () => {
    const result = await verify({ info: [build({ runNumber: '41' })], env: RUN });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.requests.info, 1);
    assert.match(result.stderr, /線上站台是 aaaaaaaaaaaa，但不是這次 run 建的那一份（最後看到：aaaaaaaaaaaa 的較早部署（run #41，本 run 是 #42））/);
    assert.doesNotMatch(result.stderr, /也不是它的後代/);
    assert.equal(result.requests.compare, 0);
});

test('線上是較早 run 的快取副本（Age=300）：還沒落地', { timeout: 8000 }, async () => {
    const result = await verify({ info: [build({ runNumber: '41' }, 300)], env: RUN });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.requests.info, 1);
});

test('線上的 build-info 沒有 runNumber：本 commit 也算較早的部署', { timeout: 8000 }, async () => {
    const result = await verify({ info: [matching], env: RUN });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.requests.info, 1);
    assert.match(result.stderr, /較早部署（run #\?，本 run 是 #42）/);
});

for (const [runNumber, shown] of [
    ['42', /線上已是 aaaaaaaaaaaa/],
    ['43', /線上是 aaaaaaaaaaaa 較新的部署（run #43，本 run 是 #42）/],
]) {
    test(`線上是本 commit、run #${runNumber}：算落地`, { timeout: 8000 }, async () => {
        const result = await verify({ info: [build({ runNumber })], env: RUN });
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, shown);
        assert.ok(result.stdout.includes(EXACT_RECHECK), result.stdout);
    });
}

test('沒有 GITHUB_RUN_NUMBER 與 PUBLIC_AI_GATEWAY_URL 時只比 commit', { timeout: 8000 }, async () => {
    const result = await verify({ info: [build({ runNumber: '41', aiGatewayUrl: 'https://gateway.example' })] });
    assert.equal(result.code, 0, result.stderr);
});

// harness 漏擋 Actions 的變數時，在本機就會失敗，不必等到 CI。
test('測試程序帶著 Actions 的變數時，子行程仍然看不到', { timeout: 8000 }, async () => {
    const names = ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT', 'PUBLIC_AI_GATEWAY_URL'];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    Object.assign(process.env, { GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '2', PUBLIC_AI_GATEWAY_URL: 'https://gateway.example' });
    try {
        const result = await verify({ info: [matching] });
        assert.equal(result.code, 0, result.stdout + result.stderr);
    } finally {
        for (const name of names) {
            if (saved[name] === undefined) delete process.env[name];
            else process.env[name] = saved[name];
        }
    }
});

// Re-run all jobs 會重新建置，run 編號卻不變。
test('改了 variable 之後按 Re-run：run 編號相同、閘道網址不是這次建置用的，還沒落地', { timeout: 8000 }, async () => {
    const result = await verify({
        info: [build({ runNumber: '42', aiGatewayUrl: 'https://gateway-old.example' })],
        env: { ...RUN, GITHUB_RUN_ATTEMPT: '2', PUBLIC_AI_GATEWAY_URL: 'https://gateway-new.example' },
    });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.requests.info, 1);
    assert.match(result.stderr, /AI 閘道網址不是這次建置用的/);
    assert.doesNotMatch(result.stdout + result.stderr, /gateway-old|gateway-new/);
});

test('沒有 GITHUB_RUN_NUMBER、只帶了閘道網址：網址不同就還沒落地', { timeout: 8000 }, async () => {
    const result = await verify({
        info: [build({ runNumber: '41', aiGatewayUrl: 'https://gateway-old.example' })],
        env: { PUBLIC_AI_GATEWAY_URL: 'https://gateway-new.example' },
    });
    assert.equal(result.code, 1, result.stdout);
    assert.equal(result.requests.info, 1);
    assert.match(result.stderr, /AI 閘道網址不是這次建置用的/);
});

// Re-run failed jobs 不重跑成功過的建置，部署的是先前 attempt 的產物，所以不比 run_attempt。
for (const [label, aiGatewayUrl, configured] of [
    ['網址相同', 'https://gateway.example', 'https://gateway.example'],
    ['沒設 variable', null, ''],
]) {
    test(`Re-run failed jobs、run 編號相同、${label}：算落地`, { timeout: 8000 }, async () => {
        const result = await verify({
            info: [build({ runNumber: '42', aiGatewayUrl })],
            env: { ...RUN, GITHUB_RUN_ATTEMPT: '2', PUBLIC_AI_GATEWAY_URL: configured },
        });
        assert.equal(result.code, 0, result.stderr);
        assert.ok(result.stdout.includes(EXACT_RECHECK), result.stdout);
    });
}

// 同一個 commit 的兩個 run 重疊，例如 push 觸發的還在跑，又改了 variable 按 Run workflow。
const OURS = build({ runNumber: '42', aiGatewayUrl: 'https://gateway-old.example' });
const NEWER_RUN = build({ runNumber: '43', aiGatewayUrl: 'https://gateway-new.example' });
const OLD_GATEWAY = { ...RUN, PUBLIC_AI_GATEWAY_URL: 'https://gateway-old.example' };

test('輪詢時看到本 commit 較新的 run 換了閘道網址：跟後代一樣算落地', { timeout: 8000 }, async () => {
    const result = await verify({ info: [NEWER_RUN], env: OLD_GATEWAY });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /線上是 aaaaaaaaaaaa 較新的部署（run #43，本 run 是 #42）/);
});

test('再確認時看到本 commit 較新的 run 換了閘道網址：不算退版', { timeout: 8000 }, async () => {
    const result = await verify({ info: [OURS, NEWER_RUN], env: OLD_GATEWAY });
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /信心較低/);
});

test('再確認時線上變成本 commit 較早的 run：判定退版而失敗', { timeout: 8000 }, async () => {
    const result = await verify({ info: [build({ runNumber: '42' }), build({ runNumber: '41' })], env: RUN });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stderr, /線上已變成 aaaaaaaaaaaa 的較早部署（run #41，本 run 是 #42）——部署順序被倒過來了/);
    assert.match(result.stderr, /失敗發生在命中後的再確認/);
    assert.doesNotMatch(result.stderr, /也不是它的後代/);
});

// 和不同 commit 的退版用同一個標準：Age 超過門檻的副本不採信。
for (const [label, info, env] of [
    ['較早的 run', [build({ runNumber: '42' }), build({ runNumber: '41' }, 500)], RUN],
    ['閘道網址不同', [OURS, build({ runNumber: '42', aiGatewayUrl: 'https://gateway-new.example' }, 500)], OLD_GATEWAY],
]) {
    test(`再確認拿到本 commit 另一份部署（${label}）的舊快取副本：不採信，維持成功但扣信心`, { timeout: 8000 }, async () => {
        const result = await verify({ info, env });
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /拿到 Age=500s 的快取副本/);
        assert.match(result.stdout, /有 1 次因為快取副本太舊而未採信/);
        assert.ok(!result.stdout.includes(EXACT_RECHECK), result.stdout);
    });
}
