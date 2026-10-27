/**
 * deploy/k3s/build-image.sh 在暫時的 git repo 裡整支執行。PATH 最前面放假的 sudo 與 buildah，記下依序收到的
 * 指令，再照測試給的內容回答：收尾中的 pod、ReplicaSet 與 pod 用的映像檔、k3s 與 buildah 裡的映像檔，或讓某一步失敗。
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

// 假指令在暫時的 repo 裡執行，這次的 tag 和腳本一樣從 HEAD 算。測試資料裡的 @TAG@ 是這個 tag 在建置
// 或匯入之前的樣子：k3s 匯入之後它改指新的 manifest（sha256:new），buildah 建置之後舊的那份變成 <none>。
// 有 same 檔時表示重建出一模一樣的映像檔，@TAG@ 照舊。kubectl 的 jsonpath 不對就失敗
const FAKE_SUDO = `#!/bin/sh
dir=$(dirname "$0")
printf 'sudo %s\\n' "$*" >> "$dir/calls"
tag=localhost/sch001-ai-gateway:$(git rev-parse --short=12 HEAD)
refs() {
  if grep -q '^sudo k3s ctr images import ' "$dir/calls" && [ ! -f "$dir/same" ]; then
    grep -v '^@TAG@ ' "$dir/k3s-refs" 2>/dev/null; echo "$tag sha256:new"; echo "sha256:cfgnew sha256:new"
  else
    sed "s#^@TAG@ #$tag #" "$dir/k3s-refs" 2>/dev/null
  fi
}
has() { printf '%s' "$*" | grep -qF -- "$1"; }
case "$*" in
  'k3s kubectl -n sch001-ai get pods -l '*) n=$(grep -c '^sudo k3s kubectl -n sch001-ai get pods -l ' "$dir/calls"); cat "$dir/pods-$n" 2>/dev/null ;;
  'k3s kubectl -n sch001-ai get pods -o '*)
    [ -f "$dir/fail-pods" ] && exit 1
    case "$*" in *'jsonpath={range .items[*].spec.containers[*]}{.image}'*) ;; *) exit 3 ;; esac
    cat "$dir/in-use" 2>/dev/null ;;
  'k3s kubectl -n sch001-ai get rs '*)
    [ -f "$dir/fail-rs" ] && exit 1
    case "$*" in *'get rs -l app=ai-gateway -o jsonpath={range .items[*].spec.template.spec.containers[*]}{.image}'*) ;; *) exit 3 ;; esac
    cat "$dir/rs-images" 2>/dev/null ;;
  'k3s kubectl -n sch001-ai rollout status '*) [ -f "$dir/fail-rollout" ] && exit 1 ;;
  'k3s ctr images ls name=='*) [ -f "$dir/fail-ls-name" ] && exit 1; echo 'REF TYPE DIGEST'; refs | awk -v r="\${5#name==}" '$1 == r { print $1, "x", $2 }' ;;
  'k3s ctr images ls') [ -f "$dir/fail-ls" ] && exit 1; echo 'REF TYPE DIGEST'; refs | awk '{ print $1, "x", $2 }' ;;
  'k3s ctr images rm sha256:'*) [ -f "$dir/fail-rm-sha" ] && exit 1 ;;
  'k3s ctr images rm '*) [ -f "$dir/fail-rm" ] && exit 1 ;;
esac
exit 0
`;
const FAKE_BUILDAH = `#!/bin/sh
dir=$(dirname "$0")
printf 'buildah %s\\n' "$*" >> "$dir/calls"
tag=localhost/sch001-ai-gateway:$(git rev-parse --short=12 HEAD)
case "$1" in
  images)
    [ -f "$dir/fail-buildah-images" ] && exit 1
    [ -f "$dir/fail-buildah-images-late" ] && grep -q '^buildah build ' "$dir/calls" && exit 1
    if grep -q '^buildah build ' "$dir/calls" && [ ! -f "$dir/same" ]; then
      sed 's/ @TAG@$/ <none>:<none>/' "$dir/buildah-images" 2>/dev/null; echo "newid0000000 $tag"
    else
      sed "s# @TAG@\\$# $tag#" "$dir/buildah-images" 2>/dev/null
    fi ;;
  rmi) [ -f "$dir/fail-rmi" ] && exit 125 ;;
esac
exit 0
`;

/**
 * runBuild 執行 build-image.sh。pods[i] 是第 i+1 次查收尾中的 pod 時 kubectl 的輸出；files 是放進假指令目錄的
 * 檔案（rs-images、in-use、k3s-refs、buildah-images 的內容，或 fail-* 讓那一步失敗）。
 * 回傳結束碼、依序的 sudo／buildah 呼叫，以及 app.yaml 有沒有被改。
 */
function runBuild(pods, { env = {}, files = {} } = {}) {
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
        writeFileSync(path.join(bin, 'sudo'), FAKE_SUDO);
        writeFileSync(path.join(bin, 'buildah'), FAKE_BUILDAH);
        chmodSync(path.join(bin, 'sudo'), 0o755);
        chmodSync(path.join(bin, 'buildah'), 0o755);
        pods.forEach((lines, i) => writeFileSync(path.join(bin, `pods-${i + 1}`), lines.map((l) => `${l}\n`).join('')));
        for (const [name, lines] of Object.entries(files)) {
            writeFileSync(path.join(bin, name), lines.map((l) => `${l}\n`).join(''));
        }
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

const CHECK = 'sudo k3s kubectl -n sch001-ai get pods -l ';
const APPLY_APP = 'sudo k3s kubectl apply -f ai-gateway/deploy/k3s/app.yaml';
const ROLLOUT = 'sudo k3s kubectl -n sch001-ai rollout status ';
const TERMINATING = `ai-gateway-7c9d6f5b4-x2kq8|Running|${new Date(Date.now() + 600_000).toISOString().replace(/\.\d{3}Z$/, 'Z')}|920`;
const img = (id) => `localhost/sch001-ai-gateway:${id.repeat(12)}`;

test('碰叢集之前查一次收尾中的 pod，匯入映像檔之後、改 app.yaml 之前再查一次', () => {
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

test('第一次查到收尾中的 pod 就停下，不建置、不碰叢集', () => {
    const r = runBuild([[TERMINATING]]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ai-gateway-7c9d6f5b4-x2kq8：已收尾/);
    assert.deepEqual(r.calls, [r.calls[0]]);
    assert.ok(r.calls[0].startsWith(CHECK));
    assert.ok(!r.appChanged);
});

test('建置期間才開始收尾的，第二次查到就停下，映像檔已匯入、app.yaml 沒改', () => {
    const r = runBuild([[], [TERMINATING]]);
    assert.equal(r.status, 1);
    assert.ok(r.calls.some((c) => c.startsWith('sudo k3s ctr images import ')));
    assert.ok(!r.calls.includes(APPLY_APP));
    assert.ok(!r.appChanged);
    const ok = runBuild([[], [TERMINATING]], { env: { ALLOW_ROLLOUT_OVERLAP: '1' } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.calls.includes(APPLY_APP));
});

// a 是目前的 ReplicaSet，f 是更早的那個（同一個 commit 重跑時，換版前在跑的就是這次的 tag）；c 還有
// pod 在用，例如覆寫重疊時收尾中的舊 pod。g 和 a 內容相同，指向同一個 manifest。sch001-ai-gateway-x 是別的 repo
const IMAGES = {
    'rs-images': [img('a'), img('f')],
    'in-use': [img('c')],
    'k3s-refs': [
        `${img('a')} sha256:da`, 'sha256:cfga sha256:da',
        `${img('b')} sha256:db`, 'sha256:cfgb sha256:db',
        `${img('c')} sha256:dc`,
        `${img('d')} sha256:dd`, 'sha256:cfgd sha256:dd',
        `${img('f')} sha256:df`,
        `${img('g')} sha256:da`,
        'docker.io/library/node:22 sha256:dn', 'sha256:cfgn sha256:dn',
        'sha256:other sha256:dx',
        'localhost/sch001-ai-gateway-x:111111111111 sha256:dpx', 'sha256:cfgpx sha256:dpx',
    ],
    'buildah-images': [
        `aaaaaaaaaaaa ${img('a')}`, `bbbbbbbbbbbb ${img('b')}`, `cccccccccccc ${img('c')}`,
        `eeeeeeeeeeee ${img('e')}`, `ffffffffffff ${img('f')}`,
        'nnnnnnnnnnnn docker.io/library/node:<none>', 'hhhhhhhhhhhh localhost/ahp-match:111111111111',
        'pxpxpxpxpxpx localhost/sch001-ai-gateway-x:111111111111',
        'zzzzzzzzzzzz <none>:<none>',
    ],
};
const removed = (calls, prefix) => calls.filter((c) => c.startsWith(prefix)).map((c) => c.slice(prefix.length));
const K3S_RM = 'sudo k3s ctr images rm ';
const BUILDAH_RM = 'buildah rmi ';

test('換版成功後刪掉其他版本與它們的 sha256 參照，留下這次的、各 ReplicaSet 的和還有 pod 在用的', () => {
    const r = runBuild([], { files: IMAGES });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /換版成功：localhost\/sch001-ai-gateway:[0-9a-f]{12}/);
    assert.deepEqual(removed(r.calls, K3S_RM), [img('b'), img('d'), img('g'), 'sha256:cfgb', 'sha256:cfgd']);
    assert.deepEqual(removed(r.calls, BUILDAH_RM), [img('b'), img('e')]);
    const firstRemove = r.calls.findIndex((c) => c.startsWith(K3S_RM));
    assert.ok(r.calls.findIndex((c) => c.startsWith(ROLLOUT)) < firstRemove, r.calls.join('\n'));
});

test('同一個 commit 重建時，刪掉被取代的那份', () => {
    const r = runBuild([], {
        files: { 'k3s-refs': ['@TAG@ sha256:dold', 'sha256:cfgold sha256:dold'], 'buildah-images': ['oldid0000000 @TAG@'] },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(removed(r.calls, K3S_RM), ['sha256:cfgold']);
    assert.deepEqual(removed(r.calls, BUILDAH_RM), ['oldid0000000']);
});

test('同一個 commit 重建出一模一樣的映像檔時，什麼都不刪', () => {
    const r = runBuild([], {
        files: { same: [], 'k3s-refs': ['@TAG@ sha256:dold', 'sha256:cfgold sha256:dold'], 'buildah-images': ['oldid0000000 @TAG@'] },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(removed(r.calls, K3S_RM), []);
    assert.deepEqual(removed(r.calls, BUILDAH_RM), []);
});

test('換版沒成功、或讀不到 ReplicaSet、pod、映像檔清單時，什麼都不刪', () => {
    for (const fail of ['fail-rollout', 'fail-rs', 'fail-pods', 'fail-ls', 'fail-ls-name', 'fail-buildah-images']) {
        const r = runBuild([], { files: { ...IMAGES, [fail]: [] } });
        assert.notEqual(r.status, 0, fail);
        assert.deepEqual(removed(r.calls, K3S_RM), [], fail);
        assert.deepEqual(removed(r.calls, BUILDAH_RM), [], fail);
    }
});

test('ctr 或 buildah 刪除、列清單失敗時腳本停下，不接著刪', () => {
    const tag = runBuild([], { files: { ...IMAGES, 'fail-rm': [] } });
    assert.notEqual(tag.status, 0);
    assert.deepEqual(removed(tag.calls, K3S_RM), [img('b')]);
    assert.deepEqual(removed(tag.calls, BUILDAH_RM), []);
    const sha = runBuild([], { files: { ...IMAGES, 'fail-rm-sha': [] } });
    assert.notEqual(sha.status, 0);
    assert.deepEqual(removed(sha.calls, K3S_RM), [img('b'), img('d'), img('g'), 'sha256:cfgb']);
    assert.deepEqual(removed(sha.calls, BUILDAH_RM), []);
    const list = runBuild([], { files: { ...IMAGES, 'fail-buildah-images-late': [] } });
    assert.notEqual(list.status, 0);
    assert.deepEqual(removed(list.calls, BUILDAH_RM), []);
    const rmi = runBuild([], { files: { ...IMAGES, 'fail-rmi': [] } });
    assert.notEqual(rmi.status, 0);
    assert.deepEqual(removed(rmi.calls, BUILDAH_RM), [img('b')]);
});

test('Deployment 只留一個舊的 ReplicaSet，對得上腳本只留換版前那一版的映像檔', () => {
    const manifest = readFileSync(path.join(K3S, 'app.yaml'), 'utf8');
    assert.match(manifest, /^kind: Deployment\n(?:.*\n)*?spec:\n(?: .*\n)*? {2}revisionHistoryLimit: 1\n/m);
});
