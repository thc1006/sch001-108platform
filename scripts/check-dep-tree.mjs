// 相依樹一致性檢查（不連網、純讀 package-lock.json）
// ================================================================
// npm 允許同一個套件在樹裡存在多份不同版本——那是巢狀解析的正常行為，絕大多數
// 情況下無害。但有少數套件一旦分裂，建置**照樣成功、沒有任何警告**，只是產出
// 悄悄變了。這支檢查只盯那幾個。
//
// 實際案例（本 repo 2026-08-28 驗證過）：
//   package.json 宣告 "tailwindcss": "^4.3.3"（caret）
//   @tailwindcss/vite@4.3.3 的 dependencies 是 "tailwindcss": "4.3.3"（精確 pin）
//
// 這兩個條件同時成立時，只要 tailwindcss 出了 4.3.4 而 @tailwindcss/vite 還沒跟上，
// Dependabot 單獨升 tailwindcss 就會產生：
//   node_modules/tailwindcss                             4.3.4  ← 根
//   node_modules/@tailwindcss/vite/node_modules/tailwindcss  4.3.3  ← 巢狀
//   node_modules/@tailwindcss/node/node_modules/tailwindcss  4.3.3  ← 巢狀
//
// 實測把 tailwindcss 釘回 4.3.2 可以重現同樣的分裂：3 份副本、2 個版本、
// `npm install` exit 0、零警告。Vite 外掛用它自己那份巢狀的引擎編譯 CSS，
// 而 @tailwindcss/typography 這類 plugin 是對著根那份解析的——版本一旦錯開，
// 兩邊對 utility 的認知就不一致，產出的 CSS 會變，而沒有任何東西會告訴你。
//
// 修法有兩層，本 repo 兩層都做：
//   1. .github/dependabot.yml 把 tailwindcss 與 @tailwindcss/* 分在同一組，
//      讓它們只會被一起升（預防）
//   2. 這支檢查（保險）——分組設定可能被改壞、也擋不住手動安裝
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 只列「分裂會靜默改變產出」的套件。一般套件重複版本是正常的，不要加進來。
const MUST_BE_SINGLE_VERSION = [
    {
        name: 'tailwindcss',
        why: '@tailwindcss/vite 精確 pin tailwindcss，而 package.json 用 caret 範圍。'
            + '版本錯開時 Vite 外掛與 CSS plugin 會用到不同引擎，產出的 CSS 靜默改變。',
    },
    {
        name: 'astro',
        why: '兩份 Astro 會讓 integration 與 renderer 對不上，錯誤訊息通常指向無關的地方。',
    },
    {
        name: '@tailwindcss/oxide',
        why: 'Tailwind 的原生引擎。與 tailwindcss 版本錯開會編出不一致的 utility。',
    },
];

// 故障注入矩陣要能對著副本跑（見 check-dep-tree.faults.mjs），沿用本 repo 其他
// 看門狗的作法：以環境變數覆寫輸入路徑，預設仍是版控裡那份。
const LOCK_PATH = process.env.DEP_TREE_LOCK || path.join(ROOT, 'package-lock.json');
const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
const packages = lock.packages || {};

/** 樹裡某個套件的所有副本——根層的 node_modules/<name> 與任何巢狀的 .../node_modules/<name>。 */
function copiesOf(name) {
    const suffix = `node_modules/${name}`;
    return Object.entries(packages)
        .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
        .map(([key, entry]) => ({ path: key, version: entry.version }));
}

const problems = [];
for (const { name, why } of MUST_BE_SINGLE_VERSION) {
    const copies = copiesOf(name);
    if (copies.length === 0) continue; // 沒用到就跳過，不是錯
    const versions = [...new Set(copies.map((c) => c.version))];
    if (versions.length > 1) problems.push({ name, why, versions, copies });
}

if (problems.length === 0) {
    const summary = MUST_BE_SINGLE_VERSION
        .map(({ name }) => {
            const copies = copiesOf(name);
            return copies.length ? `${name}@${copies[0].version}` : null;
        })
        .filter(Boolean)
        .join('、');
    console.log(`相依樹一致 ✅  ${summary}`);
    process.exitCode = 0;
} else {
    console.error('相依樹分裂 ❌\n');
    for (const p of problems) {
        console.error(`  ${p.name} 在樹裡有 ${p.copies.length} 份副本、${p.versions.length} 個相異版本：`);
        for (const c of p.copies) {
            console.error(`      ${c.version.padEnd(10)} ${c.path.replace(/node_modules\//g, '')}`);
        }
        console.error(`    為什麼這是問題：${p.why}`);
        console.error('');
    }
    console.error('  這種分裂不會讓建置失敗，也不會有警告——所以必須在這裡擋下來。');
    console.error('  修法：讓相關套件一起升到同一版（見 .github/dependabot.yml 的 tailwind 分組），');
    console.error('  或把 package.json 的宣告改成與上游的 pin 相容。');
    process.exitCode = 1;
}
