#!/usr/bin/env node
/**
 * 在建置產物裡蓋一個「這份產物是哪一個 commit 建的」的戳記。
 *
 * 只看 CI 的狀態證明不了線上是哪一版：deploy 只在 push 到 main 時才跑，不可能當
 * PR 的 required check，所以 `CI Required` 不包含 deploy。Deploy 被取消時，即使 main
 * 看起來是綠的、GitHub 的 deployments API 也有一筆該 commit 的紀錄，線上仍可能在
 * 服務上一次部署的內容，沒有任何訊號（#89）。
 *
 * 而且 `actions/deploy-pages` 成功只代表 Pages API 回報部署完成，不代表 CDN 已經在
 * 服務新內容。要證明的唯一方法是去線上把它抓下來比對。
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
 * 兩者都拿不到時寫 'unknown' 而不是中止：本機建置不該因為沒有 git 就失敗，
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
    // 只改 repository variable 就重新部署時 commit 不變，verify-deploy 靠遞增的 run_number 分辨新舊。
    runNumber: process.env.GITHUB_RUN_NUMBER || null,
    // Re-run 時 run_number 不變，verify-deploy 再比這個；BaseLayout 寫進 meta 的也是這個變數。
    aiGatewayUrl: (process.env.PUBLIC_AI_GATEWAY_URL ?? '').trim() || null,
};

const out = path.join(DIST, 'build-info.json');
writeFileSync(out, JSON.stringify(info, null, 2) + '\n', 'utf8');
console.log(`build-info.json：commit ${info.commit.slice(0, 12)}`);
