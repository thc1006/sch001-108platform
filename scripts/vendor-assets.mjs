#!/usr/bin/env node
/**
 * 把第三方前端函式庫從 node_modules 複製到 public/vendor/
 * ================================================================
 * 為什麼不直接用 CDN：本站原本有四個 runtime CDN 依賴，全部沒有 SRI——
 *
 *   cdn.jsdelivr.net/npm/fuse.js@6.6.2      搜尋引擎；載不到就整個搜尋失效
 *   unpkg.com/feather-icons@4.29.2          兩頁的圖示
 *   unpkg.com/ionicons@7.1.0（esm ＋ nomodule）  一頁的 16 個圖示
 *
 * 這是三個第三方網域的可用性直接決定本站功能能不能用，而且沒有任何建置期檢查會
 * 發現它們掛掉——CDN 壞掉時 build 是綠的、check:site 是綠的，使用者打開才發現
 * 搜尋框永遠停在「載入中」。
 *
 * 改成自架之後：
 *   - 版本由 package-lock.json 鎖定（比 SRI 更完整：連相依都鎖）
 *   - 檔案缺少時 scripts/check-built-site.mjs 會在 CI 就擋下（script[src] 會被驗證）
 *   - 沒有第三方 runtime 請求
 *
 * public/vendor/ 不入版控（見 .gitignore）：它完全由 node_modules 推導得出，
 * commit 進去只會造成「lockfile 更新了但 vendor 忘了重跑」的漂移。
 */
import { mkdirSync, copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const NM = path.join(ROOT, 'node_modules');
const OUT = path.join(ROOT, 'public', 'vendor');

/** 缺檔一律中止。靜默略過會讓建置產物少一個檔案，而那正是要防的失效模式。 */
function need(rel) {
    const p = path.join(NM, rel);
    if (!existsSync(p)) {
        console.error(`找不到 node_modules/${rel}\n請先執行 npm ci（版本由 package-lock.json 鎖定）。`);
        process.exit(1);
    }
    return p;
}

function copy(srcAbs, destRel) {
    const dest = path.join(OUT, destRel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(srcAbs, dest);
    return dest;
}

/** 逐一走訪 src/ 底下可能含有圖示名稱的檔案。 */
function eachSourceFile(fn) {
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(astro|html|js|mjs|json)$/.test(e.name)) fn(p, readFileSync(p, 'utf8'));
        }
    };
    walk(path.join(ROOT, 'src'));
}

/**
 * 各頁用到哪些圖示，一律從原始碼推導而不是寫死。
 *
 * 寫死清單的話，日後有人加一個新圖示，vendor 步驟不會知道，該圖示在 runtime 靜默
 * 404——而 ion-icon 找不到 SVG 時不會報錯，只是不顯示。單一來源就是原始碼本身。
 *
 * `icon: 'x'` 這個形狀兩個圖示庫都在用（資料驅動的卡片），所以必須依「這個檔案
 * 載的是哪一個庫」來歸屬。第一版沒有分辨，把 competency-map 的 feather 名稱
 * （user-check／message-circle／users）當成 ionicon 去找，直接讓 vendor 失敗。
 */
function collectIconNames() {
    const ion = new Set();
    const feather = new Set();
    eachSourceFile((_p, src) => {
        const usesIon = /<ion-icon|ionicons/.test(src);
        const usesFeather = /data-feather|feather-icons|feather\.min\.js/.test(src);

        for (const m of src.matchAll(/<ion-icon[^>]*\bname="([a-z0-9-]+)"/g)) ion.add(m[1]);
        for (const m of src.matchAll(/\bdata-feather="([a-z0-9-]+)"/g)) feather.add(m[1]);

        // 資料驅動的動態圖示名：歸給這個檔案實際載入的那個庫
        for (const m of src.matchAll(/\bicon:\s*['"]([a-z0-9-]+)['"]/g)) {
            if (usesIon && !usesFeather) ion.add(m[1]);
            else if (usesFeather && !usesIon) feather.add(m[1]);
            // 兩個庫都載入的檔案無法歸屬，略過——目前沒有這種檔案，真的出現時
            // 下面的名稱驗證會因為找不到而報錯，不會靜默通過。
        }
    });
    return { ion: [...ion].sort(), feather: [...feather].sort() };
}

rmSync(OUT, { recursive: true, force: true });

// ── 搜尋引擎 ──
copy(need('fuse.js/dist/fuse.min.js'), 'fuse.min.js');

// ── feather-icons ──
copy(need('feather-icons/dist/feather.min.js'), 'feather.min.js');

// ── ionicons：loader ＋ 只複製真的用到的 SVG ──
// dist/ionicons/ 底下的 *.js 是 loader 與它 lazy-load 的 chunk，必須整組帶走
// （檔名帶 hash，挑著複製只會在 runtime 少一塊）。svg/ 有 1338 個檔約 2.5MB，
// 本站只用得到十幾個，所以逐一挑。
const ioniconsDir = path.join(NM, 'ionicons/dist/ionicons');
if (!existsSync(ioniconsDir)) {
    console.error('找不到 node_modules/ionicons/dist/ionicons，請先執行 npm ci。');
    process.exit(1);
}
let loaderCount = 0;
for (const f of readdirSync(ioniconsDir)) {
    if (!f.endsWith('.js')) continue;
    copy(path.join(ioniconsDir, f), path.join('ionicons', f));
    loaderCount++;
}

const { ion: wantedIon, feather: wantedFeather } = collectIconNames();

const missingIon = [];
for (const name of wantedIon) {
    const svg = path.join(ioniconsDir, 'svg', `${name}.svg`);
    if (!existsSync(svg)) {
        missingIon.push(name);
        continue;
    }
    copy(svg, path.join('ionicons', 'svg', `${name}.svg`));
}

// feather 的圖示全部內嵌在 feather.min.js 裡，不需要挑檔；但名稱打錯同樣是
// 「安靜地不顯示」，所以一併驗證。
const featherIcons = JSON.parse(readFileSync(need('feather-icons/dist/icons.json'), 'utf8'));
const missingFeather = wantedFeather.filter((n) => !(n in featherIcons));

if (missingIon.length || missingFeather.length) {
    // 名字打錯時兩個庫都只會安靜地不顯示，不會有任何錯誤——在這裡就擋下來。
    if (missingIon.length) console.error(`原始碼用到的 ionicon 在套件中不存在：${missingIon.join('、')}`);
    if (missingFeather.length) console.error(`原始碼用到的 feather icon 不存在：${missingFeather.join('、')}`);
    console.error('請確認名稱拼寫，或確認該檔案載入的是哪一個圖示庫。');
    process.exit(1);
}

console.log(
    `vendor 完成：fuse.min.js、feather.min.js、ionicons loader ${loaderCount} 檔、\n` +
        `  ionicon SVG ${wantedIon.length} 個：${wantedIon.join('、')}\n` +
        `  feather 名稱驗證 ${wantedFeather.length} 個：${wantedFeather.join('、')}`,
);
