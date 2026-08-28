#!/usr/bin/env node
/**
 * 外部連結政策的確定性檢查
 * --------------------------------------------------------------
 * 這支跑在**每個 PR**上，而且完全不連外網——它檢查的是「政策本身有沒有腐爛」，
 * 那件事必須是確定性的，不能取決於今天某個站台連不連得上。
 *
 * 檢查三件事：
 *
 *   1. link-policy.json 的每一筆例外都合法：精確網址或精確主機名、有 reason／
 *      owner／expires、期限未過、期限不超過上限。**過期就讓 CI 紅**——這是刻意的：
 *      allowlist 最常見的腐爛方式就是「當初說暫時的，三年後還在」。
 *
 *   2. 建置產物裡的每一個外部網址都通過靜態位址政策（scheme、credential、
 *      字面 IP、保留主機名）。這一關把「有人在資料檔裡寫 http://169.254.169.254/」
 *      擋在合併之前，而不是等每週排程跑到才發現——排程那時候已經是 main 了。
 *
 *   3. 每一筆例外都真的對得上盤點裡的某個網址。對不上代表那個網址早就被改掉／
 *      刪掉了，例外卻還留著——這種殭屍條目會一直放行一個沒有人再檢視的目標。
 *      hijacked（被接管的網域）走同一條規則：內文已經不再提到那個網域時，這筆
 *      警示就該刪掉，而不是留著讓人以為還有東西在盯。
 *
 * 比對的目標包含兩種來源：url 欄位（inventory.urls）與只寫在說明文字裡的裸網域
 * （inventory.bareDomainCandidates）。少了後者，指向裸網域的政策會被誤判成殭屍。
 *
 * 網址來源是 .reports/url-inventory.json（由 check-built-site.mjs 產生），
 * 刻意不自己再掃一次：同一件事有兩份擷取邏輯正是 #72 一路在修的失效模式。
 *
 * 本機執行：  npm run check:link-policy   （需先 npm run check:site）
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { staticUrlPolicy } from './link-health.lib.mjs';
import { validatePolicy, matchPolicy, normalizeUrl, MAX_HORIZON_DAYS } from './link-policy.lib.mjs';

// fileURLToPath 而非手刻的 pathname 轉換：pathname 是 percent-encoded，路徑含
// 空白或非 ASCII 時會解析錯誤（本 repo 的 worktree 就在 .claude/ 底下）。
const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

const argOf = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const POLICY_PATH = path.resolve(ROOT, argOf('--policy', 'scripts/link-policy.json'));
const INVENTORY_PATH = path.resolve(ROOT, argOf('--inventory', '.reports/url-inventory.json'));

// 期限一律以 UTC 日曆日判定。用 runner 的本地時區會讓「今天到期」的那一天，
// 結果取決於 job 跑在哪個時區——期限檢查必須是確定性的。
const todayISO = new Date().toISOString().slice(0, 10);

const errors = [];

// ── ① 政策檔本身 ──
let policyRaw;
try {
    policyRaw = JSON.parse(await readFile(POLICY_PATH, 'utf8'));
} catch (err) {
    console.error(`❌ 讀不到或無法解析 ${POLICY_PATH}：${err.message}`);
    process.exit(1);
}
const { errors: policyErrors, entries, hijacked } = validatePolicy(policyRaw, todayISO);
errors.push(...policyErrors.map((m) => ({ where: 'link-policy.json', message: m })));

// ── ② + ③ 需要盤點才能做的兩項 ──
let inventory = null;
try {
    inventory = JSON.parse(await readFile(INVENTORY_PATH, 'utf8'));
} catch {
    inventory = null;
}

let urls = [];
if (inventory && Array.isArray(inventory.urls)) {
    // 故障注入（check-built-site.faults.mjs）會用 SITE_DIST 指向 dist 的副本，
    // 那一輪同樣會覆寫盤點檔。若日後有人把本檢查排到故障注入之後，驗到的就會是
    // 被刻意破壞過的那一份——而且完全沒有訊號。這裡直接拒絕。
    if (inventory.generatedFrom !== 'dist') {
        errors.push({
            where: INVENTORY_PATH,
            message: `盤點是從「${inventory.generatedFrom}」產生的，不是實際要部署的 dist/。請重跑 npm run check:site。`,
        });
    }
    urls = inventory.urls.map((u) => u.url);
} else {
    // 「沒有盤點就靜靜跳過」會讓這支變成裝飾品——CI 綠燈但其實什麼都沒查。
    // 明確報錯，讓呼叫順序寫錯時當場看得到。
    errors.push({
        where: INVENTORY_PATH,
        message: '找不到外部網址盤點。請先執行 npm run build:deployable && npm run check:site（盤點由 check-built-site.mjs 產生）。',
    });
}

for (const url of urls) {
    const verdict = staticUrlPolicy(url);
    if (!verdict.ok) {
        const occ = inventory.urls.find((u) => u.url === url)?.occurrences ?? [];
        errors.push({
            where: occ.map((o) => o.file).join('、') || '(未知出處)',
            message: `外部網址違反位址政策：${verdict.reason}`,
        });
    }
}

const inventorySet = new Set(urls.map(normalizeUrl));
const inventoryHosts = new Set();
for (const u of urls) {
    try {
        inventoryHosts.add(new URL(u).hostname.toLowerCase());
    } catch {
        /* 上面已經報過錯 */
    }
}
// 只寫在說明文字裡的裸網域也算「盤點裡有這個目標」。少了這一段，指向
// ieso-info.org 這種只活在內文裡的主機的政策，會被誤判成殭屍條目而讓 CI 紅。
const bareHosts = Array.isArray(inventory?.bareDomainCandidates?.hosts) ? inventory.bareDomainCandidates.hosts : [];
for (const b of bareHosts) {
    if (b && typeof b.host === 'string') inventoryHosts.add(b.host.toLowerCase());
}
if (urls.length) {
    for (const e of entries) {
        const hit =
            e.match.url !== undefined
                ? inventorySet.has(normalizeUrl(e.match.url))
                : inventoryHosts.has(String(e.match.host).toLowerCase());
        if (!hit) {
            errors.push({
                where: 'link-policy.json',
                message: `例外「${e._key}」在建置產物裡找不到對應的網址——目標已消失，例外卻還留著，請刪除這一筆。`,
            });
        }
    }
    for (const h of hijacked) {
        if (!inventoryHosts.has(String(h.match.host).toLowerCase())) {
            errors.push({
                where: 'link-policy.json',
                message: `接管警示「${h._key}」在建置產物裡找不到對應的主機——內文已經不再提到它，警示卻還留著，請刪除這一筆。`,
            });
        }
    }
}

// ── 報告 ──
console.log('外部連結政策檢查（確定性，不連外網）');
console.log(`  今天（UTC）：${todayISO}`);
const declared = Array.isArray(policyRaw?.entries) ? policyRaw.entries.length : 0;
console.log(`  例外筆數：宣告 ${declared} 筆、有效 ${entries.length} 筆（單筆有效期上限 ${MAX_HORIZON_DAYS} 天）`);
for (const e of entries) {
    console.log(`      ${e._key}  → ${e.expires} 到期（owner: ${e.owner}）`);
}
console.log(
    `  接管警示：${hijacked.length} 筆（放大訊號，不是例外；命中者不論狀態碼一律列出且永不計入健康）`,
);
for (const h of hijacked) {
    console.log(`      ${h.match.host}  [${h.kind}]  → ${h.expires} 需重新查證（owner: ${h.owner}）`);
}
console.log(`  盤點的外部網址：${urls.length}（另有 ${bareHosts.length} 個只寫在說明文字裡的裸網域）`);
console.log(`  錯誤：${errors.length}`);

if (errors.length) {
    console.error('\n政策錯誤：');
    for (const e of errors) console.error(`  ✗ [${e.where}] ${e.message}`);
    console.error(`\n共 ${errors.length} 項錯誤。`);
    process.exit(1);
}
console.log('\n✅ 例外與接管警示全部有效，且盤點內沒有違反位址政策的網址。');
