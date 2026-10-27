/**
 * deploy/k3s/terminating-pods.sh：舊 pod 還在收尾時擋下換版。PATH 最前面放一個假的 sudo，
 * 記下收到的參數，印出 kubectl jsonpath 會印的那幾行（名稱|phase|deletionTimestamp|deletionGracePeriodSeconds），
 * 或像連不到 API 時一樣失敗。jsonpath 由 kubectl 套用，要 kubectl 和一個（假的）apiserver，這裡不測。
 * build-image.sh 在哪兩處呼叫它，見 build-image.test.mjs。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const K3S = fileURLToPath(new URL('../deploy/k3s/', import.meta.url));
const SCRIPT = path.join(K3S, 'terminating-pods.sh');

const FAKE_SUDO = `#!/bin/sh
dir=$(dirname "$0")
printf '%s\\n' "$*" > "$dir/args"
if [ -f "$dir/fail" ]; then echo 'The connection to the server was refused' >&2; exit 1; fi
cat "$dir/out"
`;
const REAL_DATE = spawnSync('sh', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim();

/**
 * run 用假的 sudo 執行 terminating-pods.sh；lines 是 kubectl 的輸出，null 表示 kubectl 失敗。
 * 有 now 時 date +%s 印 now；有 end 時 date -ud 印 end（換算期限的那一次）。其他 date 照常。
 */
function run(lines, env = {}, now, end) {
    const dir = mkdtempSync(path.join(tmpdir(), 'terminating-pods-'));
    try {
        writeFileSync(path.join(dir, 'sudo'), FAKE_SUDO);
        chmodSync(path.join(dir, 'sudo'), 0o755);
        if (now !== undefined || end !== undefined) {
            const fake = [`[ "$*" = +%s ] && [ -n '${now ?? ''}' ] && { echo '${now}'; exit 0; }`, `[ "$1" = -ud ] && [ -n '${end ?? ''}' ] && { echo '${end}'; exit 0; }`];
            writeFileSync(path.join(dir, 'date'), `#!/bin/sh\n${fake.join('\n')}\nexec ${REAL_DATE} "$@"\n`);
            chmodSync(path.join(dir, 'date'), 0o755);
        }
        if (lines === null) writeFileSync(path.join(dir, 'fail'), '');
        else writeFileSync(path.join(dir, 'out'), lines.map((l) => `${l}\n`).join(''));
        const { ALLOW_ROLLOUT_OVERLAP, ...base } = process.env;
        const result = spawnSync('bash', [SCRIPT], {
            env: { ...base, PATH: `${dir}:${process.env.PATH}`, ...env },
            encoding: 'utf8',
        });
        let args = '';
        try {
            args = readFileSync(path.join(dir, 'args'), 'utf8');
        } catch {}
        return { ...result, args };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// deletionTimestamp 的寫法：到秒、UTC
const at = (seconds, from = Date.now()) => new Date(from + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const OLD = 'ai-gateway-7c9d6f5b4-x2kq8';

test('沒有收尾中的 pod：以 0 結束、不輸出', () => {
    const r = run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, '');
});

test('收尾中的 pod：以 1 結束，列出收尾了多久、最多還要多久，以及怎麼處理', () => {
    const r = run([`${OLD}|Running|${at(600)}|920`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${OLD}：已收尾 32[01] 秒，最多再 (599|600) 秒\n`));
    assert.match(r.stderr, /describe pod/);
    assert.match(r.stderr, /ALLOW_ROLLOUT_OVERLAP=1 照樣換版/);
    // kubectl delete --grace-period=60 縮短過的：照 deletionGracePeriodSeconds，不照 spec 的 920
    assert.match(run([`${OLD}|Running|${at(20)}|60`]).stderr, new RegExp(`${OLD}：已收尾 4[01] 秒，最多再 (19|20) 秒`));
});

test('Succeeded、Failed 的容器都結束了，不算；Pending、Unknown 還沒確定結束，算', () => {
    assert.equal(run([`${OLD}|Succeeded|${at(600)}|920`, `ai-gateway-a-b|Failed|${at(600)}|920`]).status, 0);
    assert.equal(run([`${OLD}|Pending|${at(600)}|920`]).status, 1);
    assert.equal(run([`${OLD}|Unknown|${at(600)}|920`]).status, 1);
});

test('期限前 1 秒、剛好到、過了 1 秒；寬限 0、四位數', () => {
    const now = 1_800_000_000;
    const line = (s) => `${OLD}|Running|${at(s, now * 1000)}|920`;
    assert.match(run([line(1)], {}, now).stderr, new RegExp(`${OLD}：已收尾 919 秒，最多再 1 秒\n`));
    assert.match(run([line(0)], {}, now).stderr, new RegExp(`${OLD}：刪除期限已到，還沒從 API 刪除\n`));
    assert.match(run([line(-1)], {}, now).stderr, new RegExp(`${OLD}：刪除期限已過 1 秒，還沒從 API 刪除\n`));
    // 縮短寬限期時要求 0：期限設成當下、寬限是 0
    assert.match(run([`${OLD}|Running|${at(0, now * 1000)}|0`], {}, now).stderr, new RegExp(`${OLD}：刪除期限已到，還沒從 API 刪除\n`));
    assert.match(run([`${OLD}|Running|${at(600, now * 1000)}|3600`], {}, now).stderr, new RegExp(`${OLD}：已收尾 3000 秒，最多再 600 秒\n`));
});

test('刪除期限過了還在的照樣擋，不印收尾了多久', () => {
    const late = run([`${OLD}|Running|${at(-15)}|920`]);
    assert.equal(late.status, 1);
    assert.match(late.stderr, new RegExp(`${OLD}：刪除期限已過 1[56] 秒，還沒從 API 刪除\n`));
    // 縮短寬限期時新期限已經過了：apiserver 把期限設成當下、寬限設成 1
    const clamped = run([`${OLD}|Running|${at(0)}|1`]);
    assert.equal(clamped.status, 1);
    assert.match(clamped.stderr, new RegExp(`${OLD}：刪除期限已(到|過 1 秒)`));
    assert.doesNotMatch(clamped.stderr, /已收尾/);
});

test('讀不懂的欄位、算術出錯、kubectl 失敗都以非 0 結束，不當成沒有收尾中的 pod', () => {
    for (const line of [`${OLD}|Running|${at(600)}|`, `${OLD}|Running||920`, `${OLD}|Running|soon|920`, `${OLD}|Running|2026-13-45T00:00:00Z|920`, `${OLD}|Running|${at(600)}|0920`, `${OLD}|Running|${at(600)}|0720`]) {
        const r = run([line]);
        assert.notEqual(r.status, 0, line);
        assert.doesNotMatch(r.stderr, /已收尾|期限已過/, line);
    }
    assert.notEqual(run(null).status, 0);
    // 算術出錯（08 不是合法的八進位）時 bash 不觸發 set -e，迴圈後的檢查要接住
    assert.notEqual(run([`${OLD}|Running|${at(600)}|920`], {}, undefined, '08').status, 0);
    assert.notEqual(run(null, { ALLOW_ROLLOUT_OVERLAP: '1' }).status, 0);
});

test('ALLOW_ROLLOUT_OVERLAP=1 時照樣列出來、提醒一行，以 0 結束；其他值不算', () => {
    const r = run([`${OLD}|Running|${at(600)}|920`], { ALLOW_ROLLOUT_OVERLAP: '1' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, new RegExp(`${OLD}：已收尾`));
    assert.match(r.stderr, /ALLOW_ROLLOUT_OVERLAP=1：不等它們結束就換版\n$/);
    assert.equal(run([`${OLD}|Running|${at(600)}|920`], { ALLOW_ROLLOUT_OVERLAP: 'true' }).status, 1);
});

test('查的命名空間與 label 等於 app.yaml 裡 Deployment 的', () => {
    const manifest = readFileSync(path.join(K3S, 'app.yaml'), 'utf8');
    const ns = manifest.match(/^kind: Deployment\n(?:.*\n)*?\s+namespace: (\S+)/m)[1];
    const [, key, value] = manifest.match(/^ {4}matchLabels:\n {6}(\S+): (\S+)\n {2}\S/m);
    const { args } = run([]);
    assert.ok(args.includes(`-n ${ns} get pods -l ${key}=${value} `), args);
});
