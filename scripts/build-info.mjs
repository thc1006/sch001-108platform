#!/usr/bin/env node
/**
 * 在建置產物裡蓋一個「這份產物是哪一個 commit 建的」的戳記。
 * ================================================================
 * 存在的理由是一次實際發生的失效：#89 合併後，main 的 CI 五個 job 有四個成功，
 * 只有 Deploy 被取消——而 `CI Required` 不包含 deploy（deploy 只在 push 到 main
 * 時才跑，不可能當 PR 的 required check）。結果是：
 *
 *   - main 看起來是綠的
 *   - GitHub 的 deployments API 甚至有一筆該 commit 的紀錄
 *   - 但線上服務的仍然是舊版本（vendor/fuse.min.js 回 404）
 *   - 沒有任何訊號
 *
 * 而且 `actions/deploy-pages` 成功本身也證明不了站台真的在服務新內容——它只證明
 * 「部署請求被接受」。要證明的唯一方法是去線上把它抓下來比對。
 *
 * 這支寫出戳記，scripts/verify-deploy.mjs 負責比對。
 */
import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = path.join(ROOT, 'dist');

if (!existsSync(DIST)) {
    console.error('找不到 dist/，build-info 必須在 astro build 之後執行。');
    process.exit(1);
}

/**
 * CI 上用 GITHUB_SHA（push 到 main 時就是該 commit）；本機退回 git rev-parse。
 * 兩者都拿不到時寫 'unknown' 而不是中止——本機建置不該因為沒有 git 就失敗，
 * 但 verify-deploy 看到 unknown 會拒絕比對（見該檔）。
 */
function currentCommit() {
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
        return 'unknown';
    }
}

const info = {
    commit: currentCommit(),
    // 這裡刻意不寫建置時間：它每次都不同，會讓「產物是否逐位元相同」的比對永遠失敗，
    // 而那個比對是 #81 用來證明「部署的就是被驗證的那一份」的方法。
    ref: process.env.GITHUB_REF || null,
    runId: process.env.GITHUB_RUN_ID || null,
};

const out = path.join(DIST, 'build-info.json');
writeFileSync(out, JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log(`build-info.json：commit ${info.commit.slice(0, 12)}`);
