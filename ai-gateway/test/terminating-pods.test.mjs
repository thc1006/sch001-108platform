/**
 * deploy/k3s/terminating-pods.sh：舊 pod 還在收尾時擋下換版。PATH 最前面放一個假的 sudo，
 * 記下收到的參數，印出 kubectl jsonpath 會印的那幾行（名稱|phase|deletionTimestamp|deletionGracePeriodSeconds），
 * 或像連不到 API 時一樣失敗。jsonpath 由 kubectl 套用，要 kubectl 和一個（假的）apiserver，這裡不測。
 * build-image.sh 則在暫時的 git repo 裡用假的 sudo、buildah 整支執行，看它在哪兩處呼叫檢查。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const BUILD_SUDO = `#!/bin/sh
dir=$(dirname "$0")
printf 'sudo %s\n' "$*" >> "$dir/calls"
case "$*" in
  'k3s kubectl -n sch001-ai get pods '*) n=$(grep -c '^sudo k3s kubectl -n sch001-ai get pods ' "$dir/calls"); cat "$dir/pods-$n" 2>/dev/null ;;
  'k3s kubectl -n sch001-ai get deployment/'* | 'k3s ctr images ls -q') echo localhost/sch001-ai-gateway:aaaaaaaaaaaa ;;
esac
exit 0
`;

/**
 * runBuild 在暫時的 git repo 裡執行 build-image.sh。pods[i] 是第 i+1 次查收尾中的 pod 時 kubectl 的輸出。
 * 回傳結束碼、依序的 sudo／buildah 呼叫，以及 app.yaml 有沒有被改。
 */
function runBuild(pods, env = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'build-image-'));
    try {
        const repo = path.join(dir, 'repo');
        const bin = path.join(dir, 'bin');
        cpSync(K3S, path.join(repo, 'ai-gateway/deploy/k3s'), { recursive: true });
        for (const sub of ['src', 'licenses']) {
            mkdirSync(path.join(repo, 'ai-gateway', sub));
            writeFileSync(path.join(repo, 'ai-gateway', sub, 'x'), '');
        }
        mkdirSync(bin);
        writeFileSync(path.join(bin, 'sudo'), BUILD_SUDO);
        writeFileSync(path.join(bin, 'buildah'), `#!/bin/sh\nprintf 'buildah %s\\n' "$*" >> "$(dirname "$0")/calls"\n`);
        chmodSync(path.join(bin, 'sudo'), 0o755);
        chmodSync(path.join(bin, 'buildah'), 0o755);
        pods.forEach((lines, i) => writeFileSync(path.join(bin, `pods-${i + 1}`), lines.map((l) => `${l}\n`).join('')));
        const git = (...args) => {
            const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
            assert.equal(r.status, 0, r.stderr);
            return r.stdout;
        };
        git('init', '-q');
        git('add', '.');
        git('commit', '-qm', 'x');
        const { ALLOW_ROLLOUT_OVERLAP, ...base } = process.env;
        const result = spawnSync('bash', [path.join(repo, 'ai-gateway/deploy/k3s/build-image.sh')], {
            env: { ...base, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, ...env },
            encoding: 'utf8',
        });
        let calls = [];
        try {
            calls = readFileSync(path.join(bin, 'calls'), 'utf8').trimEnd().split('\n');
        } catch {}
        const appChanged = git('status', '--porcelain', '--', 'ai-gateway/deploy/k3s/app.yaml') !== '';
        return { ...result, calls, appChanged };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const CHECK = 'sudo k3s kubectl -n sch001-ai get pods ';
const APPLY_APP = 'sudo k3s kubectl apply -f ai-gateway/deploy/k3s/app.yaml';
const TERMINATING = `${OLD}|Running|${at(600)}|920`;

test('build-image.sh：碰叢集之前查一次，匯入映像檔之後、改 app.yaml 之前再查一次', () => {
    const r = runBuild([]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.appChanged);
    const checks = r.calls.flatMap((c, i) => (c.startsWith(CHECK) ? [i] : []));
    assert.equal(checks.length, 2, r.calls.join('\n'));
    assert.equal(checks[0], 0, '第一個呼叫就是檢查');
    const pinned = r.calls.findIndex((c) => /^sudo k3s ctr images label \S+ io\.cri-containerd\.pinned=pinned$/.test(c));
    assert.ok(pinned > 0 && pinned < checks[1], r.calls.join('\n'));
    assert.ok(checks[1] < r.calls.indexOf(APPLY_APP), r.calls.join('\n'));
});

test('build-image.sh：第一次查到收尾中的 pod 就停下，不建置、不碰叢集', () => {
    const r = runBuild([[TERMINATING]]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`${OLD}：已收尾`));
    assert.deepEqual(r.calls, [r.calls[0]]);
    assert.ok(r.calls[0].startsWith(CHECK));
    assert.ok(!r.appChanged);
});

test('build-image.sh：建置期間才開始收尾的，第二次查到就停下，映像檔已匯入、app.yaml 沒改', () => {
    const r = runBuild([[], [TERMINATING]]);
    assert.equal(r.status, 1);
    assert.ok(r.calls.some((c) => c.startsWith('sudo k3s ctr images import ')));
    assert.ok(!r.calls.includes(APPLY_APP));
    assert.ok(!r.appChanged);
    const ok = runBuild([[], [TERMINATING]], { ALLOW_ROLLOUT_OVERLAP: '1' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.calls.includes(APPLY_APP));
});
