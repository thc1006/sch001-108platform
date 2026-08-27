// 相依樹一致性檢查（不連網、純讀 package-lock.json）
// ================================================================
// npm 允許同一個套件在樹裡存在多份不同版本——那是巢狀解析的正常行為，絕大多數
// 情況下無害。但有少數套件一旦分裂，建置**照樣成功、沒有任何警告**，只是產出
// 悄悄變了。這支檢查只盯那幾個。
//
// 成立條件（本 repo 2026-08-28 逐項量測過）：
//   package.json 宣告 "tailwindcss": "^4.3.3"（caret 範圍）
//   @tailwindcss/vite@4.3.3 與 @tailwindcss/node@4.3.3 的 dependencies
//   都是 "tailwindcss": "4.3.3"（精確 pin）
//
// 一旦 tailwindcss 出了 4.3.4 而 @tailwindcss/vite 還沒跟上，只升 tailwindcss 就會
// 產生：
//   node_modules/tailwindcss                                 4.3.4  ← 根
//   node_modules/@tailwindcss/vite/node_modules/tailwindcss  4.3.3  ← 巢狀
//   node_modules/@tailwindcss/node/node_modules/tailwindcss  4.3.3  ← 巢狀
//
// 【實測，不是推論】把根釘回 4.3.2、其餘維持 4.3.3，在乾淨的樹上重建全站：
//   - npm install exit 0、零警告，3 份副本、2 個相異版本
//   - dist/_astro/BaseLayout.*.css 從 76,092 bytes 變成 75,938 bytes，
//     內容雜湊由 B5KU3mIi 變成 6YEeJfmH
//   - 差異是 --font-sans：4.3.3 的「-apple-system, BlinkMacSystemFont, Segoe UI, …」
//     被換成 4.3.2 的「ui-sans-serif, system-ui, …」——全站 93 頁的預設字體都會變
//   - 而且產出是**混血**：CSS 內容與純 4.3.2 建置逐位元組相同，但檔頭 banner 寫的是
//     「tailwindcss v4.3.3」。原因是 JS 編譯器由 @tailwindcss/node 解析（拿到巢狀的
//     4.3.3），而 global.css 的 @import "tailwindcss" 是從樣式檔所在目錄往上找
//     （拿到根的 4.3.2）。banner 會騙人，事後追查會被帶去錯的地方。
//
// 修法有兩層，本 repo 兩層都做，但它們的效力**不對等**：
//   1. .github/dependabot.yml 的 tailwind 分組——它只是把「當下剛好都有新版」的
//      更新併成一個 PR，**擋不住**單一套件先出新版。dependabot-core 的
//      message_builder.rb 對 dependencies.one? 有專屬分支（PR 標題會變成
//      「bump X … in the tailwind group」），也就是「一個群組、只有一筆更新」的 PR
//      是官方預期行為。分組是為了讓相關變更一起被審，不是預防機制。
//   2. 這支檢查——實際會擋下來的只有這一層。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 只列「分裂會靜默改變產出」的套件。一般套件重複版本是正常的，不要加進來。
//
// tailwindcss 是目前唯一「已經具備分裂條件」的（根 caret vs 上游精確 pin，三個
// 相依方）。其餘三個在目前的樹裡各自只有一個相依方，還分裂不了——列進來是前瞻性的：
// 只要再出現第二個相依方（例如把 @tailwindcss/postcss 加回來，它同樣精確 pin
// tailwindcss / @tailwindcss/node / @tailwindcss/oxide 三者），條件就成立了。
// @tailwindcss/node 與 @tailwindcss/oxide 的風險完全對稱，不該只列其中一個。
const MUST_BE_SINGLE_VERSION = [
    {
        name: 'tailwindcss',
        why: '@tailwindcss/vite 與 @tailwindcss/node 都精確 pin tailwindcss，而 package.json 用 caret 範圍。'
            + '版本錯開時 JS 編譯器與 CSS 的 @import 會落在不同副本，產出的 CSS 靜默改變'
            + '（實測：全站預設字體換掉，而檔頭 banner 仍寫著新版號）。',
    },
    {
        name: 'astro',
        why: '兩份 Astro 會讓 integration 與 renderer 對不上，錯誤訊息通常指向無關的地方。',
    },
    {
        name: '@tailwindcss/node',
        why: 'Vite 外掛就是透過它載入 tailwindcss 編譯器。它分裂等於編譯器分裂，'
            + '而分裂後的產出仍會宣稱自己是其中一個版本。',
    },
    {
        name: '@tailwindcss/oxide',
        why: 'Tailwind 的原生引擎。與 tailwindcss 版本錯開會編出不一致的 utility。',
    },
];

// 故障注入矩陣要能對著副本跑（見 check-dep-tree.faults.mjs），沿用本 repo 其他
// 看門狗的作法：以環境變數覆寫輸入路徑，預設仍是版控裡那份。
const LOCK_PATH = process.env.DEP_TREE_LOCK || path.join(ROOT, 'package-lock.json');
const LOCK_LABEL = path.relative(ROOT, LOCK_PATH) || LOCK_PATH;

/** 讀不到、讀不懂就要說人話並擋下來——絕不能因為「沒東西可檢查」而印綠字。 */
function die(lines) {
    console.error('相依樹檢查無法進行 ❌\n');
    for (const line of lines) console.error(`  ${line}`);
    process.exit(1);
}

let raw;
try {
    raw = readFileSync(LOCK_PATH, 'utf8');
} catch (err) {
    die([
        `讀不到 lock 檔：${LOCK_PATH}`,
        `原因：${err.code || err.message}`,
        '這支檢查完全依賴 package-lock.json。讀不到就等於什麼都沒檢查，',
        '而「什麼都沒檢查」和「檢查通過」是兩件事，所以在這裡擋下來。',
        '修法：確認工作目錄有 package-lock.json，或修正 DEP_TREE_LOCK 環境變數。',
        '改用其他套件管理器時，要一併改寫這支檢查而不是把它拿掉。',
    ]);
}

let lock;
try {
    lock = JSON.parse(raw);
} catch (err) {
    die([`${LOCK_LABEL} 不是合法的 JSON：${err.message}`, '檔案可能損毀或被別的工具覆寫過。']);
}

const packages = lock && typeof lock === 'object' ? lock.packages : undefined;
if (!packages || typeof packages !== 'object' || Object.keys(packages).length === 0) {
    die([
        `${LOCK_LABEL} 沒有可用的 packages 對照表`,
        `（lockfileVersion = ${lock?.lockfileVersion ?? '未標示'}，`
            + `packages 條目數 = ${packages && typeof packages === 'object' ? Object.keys(packages).length : 0}）`,
        'packages 是 npm 7+ 的 lockfileVersion 2／3 才有的欄位，這支檢查只看得懂它。',
        'lockfileVersion 1 只有 dependencies，逐層巢狀而沒有扁平路徑——在那種格式上',
        '本檢查會「一份副本都找不到」而印出綠字，那正是最危險的假象，所以改成擋下來。',
        '修法：用 npm 7 以上重新產生 lock（npm install），或擴充這支檢查以支援該格式。',
    ]);
}

/**
 * 樹裡某個套件的所有副本。
 * 除了 node_modules/<name> 與 .../node_modules/<name> 這種路徑相符的，
 * 也比對 entry.name——npm 別名（"foo": "npm:tailwindcss@4.3.3"）的 key 會是
 * node_modules/foo，只有 entry.name 才看得出它其實是誰。
 * 刻意排除根專案那筆 key ""（它也有 name／version，但不是樹裡的副本）。
 */
function copiesOf(name) {
    const suffix = `node_modules/${name}`;
    return Object.entries(packages)
        .filter(([key, entry]) => {
            if (key === suffix || key.endsWith(`/${suffix}`)) return true;
            if (!key.startsWith('node_modules/') && !key.includes('/node_modules/')) return false;
            return typeof entry?.name === 'string' && entry.name === name;
        })
        .map(([key, entry]) => ({
            path: key,
            // link:true 的 workspace／本機連結沒有 version 欄位。以前這裡會在列印時
            // 對 undefined 呼叫 padEnd 而丟 TypeError——擋是擋下來了，但訊息是一坨
            // 堆疊而不是原因。連結進來的是完全不同的一份程式碼，仍算一個相異版本。
            version: typeof entry?.version === 'string'
                ? entry.version
                : `link:${entry?.resolved ?? '?'}`,
        }));
}

const results = MUST_BE_SINGLE_VERSION.map(({ name, why }) => {
    const copies = copiesOf(name);
    const versions = [...new Set(copies.map((c) => c.version))];
    return { name, why, copies, versions, split: versions.length > 1 };
});

const problems = results.filter((r) => r.split);
const found = results.filter((r) => r.copies.length > 0);

// 清單裡一個都找不到時，這支檢查其實什麼都沒看——那和「通過」不是同一件事。
if (found.length === 0) {
    die([
        `${LOCK_LABEL} 裡找不到清單上的任何套件`,
        `（清單：${MUST_BE_SINGLE_VERSION.map((p) => p.name).join('、')}）`,
        'lock 指錯檔案、專案結構大改、或清單過期都會造成這種情況。',
        '不論哪一種，此刻這支檢查都是全盲的，所以擋下來而不是印綠字。',
    ]);
}

if (problems.length === 0) {
    console.log('相依樹一致 ✅');
    // 逐項印出「檢查了什麼」。只印一行總結的話，「全部通過」與「根本沒檢查到」
    // 在 CI log 上長得一模一樣——本 repo 的看門狗不接受那種綠燈。
    for (const r of results) {
        if (r.copies.length === 0) {
            console.log(`  ${r.name.padEnd(20)} 不在樹裡（沒有東西可檢查）`);
        } else {
            console.log(`  ${r.name.padEnd(20)} ${r.versions[0].padEnd(10)} ${r.copies.length} 份副本`);
        }
    }
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
    console.error('  修法：讓相關套件一起升到同一版，或把 package.json 的宣告改成與上游的 pin 相容。');
    console.error('  註：.github/dependabot.yml 的 tailwind 分組只是把更新併成一個 PR，擋不住這件事。');
    process.exitCode = 1;
}
