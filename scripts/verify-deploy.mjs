#!/usr/bin/env node
/**
 * 部署之後，去線上把站台抓下來，確認它真的在服務這一個 commit。
 * ================================================================
 * `actions/deploy-pages` 成功只證明「部署請求被接受」，證明不了站台在服務新內容。
 * #89 合併後實際發生過：CI 五個 job 有四個成功、GitHub 的 deployments API 有該
 * commit 的紀錄，但線上服務的仍是舊版本（vendor/fuse.min.js 回 404），而且完全
 * 沒有訊號——因為 deploy 只在 push 到 main 時跑，不可能列入 PR 的 required check。
 *
 * 這支把「部署成功」變成可驗證的事實：輪詢線上的 build-info.json，直到它服務的
 * commit 是這次要部署的那個、或是它的**後代**為止；逾時就以非零退出讓 run 變紅。
 *
 * 為什麼是「或它的後代」而不是「精確相等」：main 連續合併時，較新的那次部署可能在
 * 本 run 還在輪詢時就先上線了。那時線上是我們的後代，站台其實完全正常——但精確相等
 * 的判定會把它誤報成「本 commit 沒有部署」。這個誤報是真的會發生的：整條 CI 約 7
 * 分鐘，兩次合併只要間隔夠近就會重疊。
 *
 * 反過來，線上如果是我們的**祖先**，那才是真正的問題：部署順序被倒過來了（Actions
 * 的 concurrency 佇列是依「開始等待的時間」FIFO，不是依 commit 順序，而各 run 的 CI
 * 耗時本來就有落差），站台正在服務比 main 更舊的東西。舊版的精確相等判定會一直等到
 * 逾時才紅，訊息還說錯原因；現在會明講是順序倒置。
 *
 * 用法：
 *   node scripts/verify-deploy.mjs                 # 用 GITHUB_SHA 或 git HEAD
 *   node scripts/verify-deploy.mjs <commit-sha>
 * 環境變數：
 *   SITE_URL           站台根網址（預設正式站）
 *   VERIFY_TIMEOUT     逾時秒數（預設 660，必須大於線上的 max-age=600）
 *   GITHUB_REPOSITORY  owner/repo，用來查祖先／後代關係；沒有就退回精確相等
 *   GITHUB_TOKEN       查詢用（公開 repo 不給也能查，只是配額低很多）
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE = (process.env.SITE_URL || 'https://thc1006.github.io/sch001-108platform').replace(/\/+$/, '');
// 線上的 Cache-Control 是 max-age=600。輪詢預算必須大於它，否則「CDN 還沒過期」
// 本身就足以讓這一關誤報失敗——部署其實成功了，卻被判定沒落地。
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT || 660) * 1000;
const POLL_MS = 10_000;

function expectedCommit() {
    const fromArg = process.argv[2];
    if (fromArg) return fromArg.trim();
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.trim();
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

const want = expectedCommit();
if (!want || want === 'unknown') {
    console.error('拿不到要驗證的 commit（GITHUB_SHA／git HEAD 都取不到）。');
    console.error('寧可讓這一關失敗，也不要在不知道要比對什麼的情況下宣告部署成功。');
    process.exit(1);
}

const url = `${SITE}/build-info.json`;
const deadline = Date.now() + TIMEOUT_MS;
let attempt = 0;
let last = '（尚未取得）';
let landed = false;
// 同一個線上 commit 只查一次祖先關係，免得每 10 秒打一次 GitHub API
let probed = '';
let behindNote = '';

console.log(`驗證線上站台是否已服務 ${want.slice(0, 12)}`);
console.log(`  ${url}`);

/**
 * 逾時用明確的 AbortController ＋ clearTimeout，而不是 AbortSignal.timeout()。
 *
 * AbortSignal.timeout() 會留下一個到期前無法取消的 timer handle。搭配結尾的
 * process.exit() 時，Node 在 Windows 上會直接崩在 libuv 的斷言
 * （`!(handle->flags & UV_HANDLE_CLOSING)`，src/win/async.c:76），退出碼變成 127
 * ——訊息印對了，退出碼卻誤導成「找不到指令」。實測踩到：只跑成功路徑不會發現。
 */
async function fetchInfo() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
        // 刻意不加 cache-buster query string：實測 GitHub Pages 的 Fastly 邊緣**不把
        // query string 放進 cache key**。對照實驗（線上站台，5 個從未用過的 nonce）：
        //
        //   無 query（第一次）   X-Cache=MISS
        //   無 query（第二次）   X-Cache=HIT
        //   ?t=…（三個不同值）   X-Cache=HIT   ← 全部命中同一份物件
        //   不存在的路徑         X-Cache=MISS  ← 對照組，確認 X-Cache 判讀正確
        //
        // 請求標頭的 Cache-Control: no-cache / Pragma 同樣不會強制回源。
        // 唯一可用的新鮮度資訊是回應的 Age 標頭。
        const res = await fetch(url, { signal: ac.signal });
        const age = Number(res.headers.get('age') || 0);
        if (res.status !== 200) return { commit: '', label: `HTTP ${res.status}`, age };
        const info = await res.json();
        const commit = String(info.commit || '');
        return { commit, label: commit || '(無 commit 欄位)', age };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 線上服務的 commit 與這次要驗的 commit 是什麼關係。
 *
 * 回傳 GitHub compare API 的 status：'identical'／'ahead'（線上較新）／
 * 'behind'（線上較舊）／'diverged'，判不出來時回 null。
 *
 * 判不出來一律當成「還沒落地」繼續等——寧可逾時失敗，也不要在關係不明的情況下
 * 宣告部署成功。這條規則就是這支腳本存在的理由本身。
 */
async function compareWithLive(live) {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) return null;
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'verify-deploy' };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/compare/${want}...${live}`, {
            headers,
            signal: ac.signal,
        });
        if (!res.ok) return null;
        const j = await res.json();
        return typeof j.status === 'string' ? j.status : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

while (Date.now() < deadline) {
    attempt++;
    try {
        const r = await fetchInfo();
        last = r.label;
        if (r.commit && r.commit === want) {
            console.log(`✅ 第 ${attempt} 次嘗試：線上已是 ${want.slice(0, 12)}（Age=${r.age}s）`);
            landed = true;
            break;
        }
        // 線上不是我們，但可能是「更新的那一版已經先上線」。
        if (r.commit && r.commit !== probed) {
            probed = r.commit;
            const rel = await compareWithLive(r.commit);
            if (rel === 'ahead') {
                console.log(
                    `✅ 第 ${attempt} 次嘗試：線上是 ${r.commit.slice(0, 12)}，為 ${want.slice(0, 12)} 的後代。` +
                        '較新的部署已經先上線，本 commit 確實落地過。',
                );
                landed = true;
                break;
            }
            if (rel === 'behind' || rel === 'diverged') {
                behindNote =
                    `線上的 ${r.commit.slice(0, 12)} 是 ${want.slice(0, 12)} 的` +
                    (rel === 'behind' ? '祖先' : '分岔版本');
            }
        }
        // Age 說明這份回應是幾秒前回源取得的。Age 很大時，這個「不符」只代表
        // 我們拿到一份陳舊的快取副本，不代表部署失敗——所以只是繼續等，
        // 而總預算（預設 660 秒）本來就設得比 max-age=600 長。
        console.log(`  第 ${attempt} 次：線上仍是 ${last.slice(0, 12)}（Age=${r.age}s，快取副本），繼續等`);
    } catch (err) {
        last = String(err?.cause?.code || err?.message || err).slice(0, 60);
        console.log(`  第 ${attempt} 次：${last}，繼續等`);
    }
    if (Date.now() + POLL_MS >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
}

if (!landed) {
    console.error(
        `\n❌ 逾時：等了 ${Math.round(TIMEOUT_MS / 1000)} 秒，線上仍不是 ${want.slice(0, 12)}，` +
            `也不是它的後代（最後看到：${last}）。\n` +
            (behindNote
                ? `  ${behindNote}——部署順序被倒過來了，站台正在服務比這個 commit 更舊的版本。\n`
                : '') +
            '部署沒有真的落地。常見原因：deploy job 被取消、GitHub Pages 服務異常、\n' +
            '或 Pages 的來源設定不是 GitHub Actions。請到 Actions 頁確認該次 run 的 Deploy job。',
    );
}
// 設 exitCode 而不是 process.exit()：讓 Node 把未完成的 handle 收乾淨再結束。
process.exitCode = landed ? 0 : 1;
