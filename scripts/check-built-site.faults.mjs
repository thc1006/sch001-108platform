#!/usr/bin/env node
/**
 * 站台契約的故障注入矩陣
 * --------------------------------------------------------------
 * 逐一破壞一個契約，確認 check-built-site.mjs 真的會擋下來。
 *
 * 為什麼要常駐在 repo 裡，而不是改完跑一次就算：
 * 「正常狀態綠燈」證明不了 checker 有在把關——那正是本 issue 要修的假象本身。
 * checker 可能因為 glob 寫錯、選擇器改名、或某個分支被短路而變成裝飾品，而這
 * 種退化在正常狀態下完全看不出來。只有持續地「故意弄壞、確認會紅」才擋得住。
 *
 * 本檔會暫時修改 dist/ 再還原，最後會確認基準狀態仍為綠燈。
 *
 * 執行：  npm run test:site-faults    （需先 npm run build:deployable）
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

// 注入點盡量從產物自己推導。用共用的掃描器（與 check-built-site.mjs、
// vendor-assets.mjs 同一份），才不會在「防寫死」的檢查裡自己寫死上游檔名。
import { staticImportSpecifiers } from './site-contract.lib.mjs';

// 故障注入一律在 dist/ 的副本上進行——被破壞的那份絕不能是要部署的那份。
//
// 還原邏輯本身是寫對的（每個 case 都有 finally，最後也會確認基準回到綠燈才
// exit 0），但只要有一個 case 在 undo 之前崩潰，dist/ 就會留著壞掉的內容，而
// CI 下一步就把它上傳部署。用副本讓這個風險在結構上不存在，而不是靠還原寫得夠好。
const SOURCE = process.env.SITE_DIST_SOURCE || 'dist';
const DIST = process.env.SITE_DIST_WORK || 'dist-faultcheck';
if (!existsSync(SOURCE)) {
  console.error(`找不到建置產物 ${SOURCE}/，請先執行 npm run build:deployable`);
  process.exit(1);
}
rmSync(DIST, { recursive: true, force: true });
cpSync(SOURCE, DIST, { recursive: true });
console.log(`故障注入在副本 ${DIST}/ 上進行，${SOURCE}/ 不會被更動。\n`);

const run = () => {
  try {
    execSync('node scripts/check-built-site.mjs', { stdio: 'pipe', env: { ...process.env, SITE_DIST: DIST } });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
  }
};

const cases = [
  {
    name: '目錄存在但缺 index.html',
    expect: /缺少 index\.html|找不到對應的部署檔案/,
    apply: () => renameSync(`${DIST}/advanced-resources/index.html`, `${DIST}/advanced-resources/index.html.bak`),
    undo: () => renameSync(`${DIST}/advanced-resources/index.html.bak`, `${DIST}/advanced-resources/index.html`),
  },
  {
    name: 'fragment 目標 id 被改名',
    expect: /沒有 id="main-content"/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('id="main-content"', 'id="main-contentX"'),
  },
  {
    name: 'canonical 指向別的頁面',
    expect: /canonical 指向/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace(/(<link rel="canonical" href=")[^"]+/, '$1https://thc1006.github.io/sch001-108platform/index.html'),
  },
  {
    name: '同源絕對網址的 og:image 指向不存在的檔案',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace(/(<meta property="og:image" content=")[^"]+/, '$1https://thc1006.github.io/sch001-108platform/picture/does-not-exist.png'),
  },
  {
    name: '資料 JSON 的本地資產不存在（runtime reference）',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/learning-portfolio/tools.json`,
    mutate: (t) => t.replace(/"logo":\s*"[^"]+"/, '"logo": "img/tools/definitely-missing.svg"'),
  },
  {
    name: '資料 JSON 的 HTML 欄位含壞掉的站內連結',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/learning-portfolio/portfolio-gallery.json`,
    mutate: (t) => t.replace(/"analysis_html":\s*"/, '"analysis_html": "<a href=\\"missing-page.html\\">x</a>'),
  },
  {
    name: 'search-index 的 url 指向不存在的頁面',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/search-index.json`,
    mutate: (t) => t.replace(/"url":\s*"[^"]+"/, '"url": "definitely-missing-page.html"'),
  },
  {
    // 以下五項對應 #14 新增的搜尋分類層。少了它們，「索引裡的素養／SDG 標籤」
    // 這件事在建置產物上就完全沒有把關——標籤壞掉的症狀是「搜尋找不到」，
    // 頁面看起來一切正常，沒有人會回報。
    name: 'search-index 出現非法的核心素養代碼',
    expect: /不是合法的核心素養代碼/,
    file: `${DIST}/search-index.json`,
    mutate: (t) => t.replace('"A2",', '"Z9",'),
  },
  {
    name: 'search-index 出現不存在的 SDG 編號',
    expect: /不是合法的 SDG 標籤/,
    file: `${DIST}/search-index.json`,
    mutate: (t) => t.replace('"SDG11",', '"SDG99",'),
  },
  {
    name: 'search-index 有素養代碼卻少了對應的中文標籤',
    expect: /taxonomy 卻缺少對應的中文標籤/,
    file: `${DIST}/search-index.json`,
    mutate: (t) => t.replace('"A2 系統思考與解決問題",', '"（標籤不見了）",'),
  },
  {
    name: '來源 JSON 有的專案，search-index 裡卻找不到',
    expect: /搜尋索引卻沒有對應的 url/,
    file: `${DIST}/search-index.json`,
    mutate: (t) => t.replace('"civic-tech-map/index.html#disfactory"', '"civic-tech-map/index.html#cofacts"'),
  },
  {
    // 逐項錨點的契約：頁面上的 id 改名，索引裡的 fragment 就成了空頭支票。
    // #78 修掉的 17 筆壞錨點正是這個失效模式，這裡確保它不會再悄悄回來。
    name: '公民科技專案的頁內錨點被改名',
    expect: /沒有 id="disfactory"/,
    file: `${DIST}/civic-tech-map/index.html`,
    mutate: (t) => t.replace('id="disfactory"', 'id="disfactory-renamed"'),
  },
  {
    name: 'search-index.json 整份不見',
    expect: /找不到 search-index\.json/,
    apply: () => renameSync(`${DIST}/search-index.json`, `${DIST}/search-index.json.bak`),
    undo: () => renameSync(`${DIST}/search-index.json.bak`, `${DIST}/search-index.json`),
  },
  {
    name: 'sitemap 的 <loc> 指向不存在的頁面',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/sitemap-0.xml`,
    mutate: (t) => t.replace(/<loc>[^<]+<\/loc>/, '<loc>https://thc1006.github.io/sch001-108platform/no-such-page.html</loc>'),
  },
  {
    name: '同一頁出現重複 id',
    expect: /重複的 id/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('<main id="main-content"', '<span id="main-content"></span><main id="main-content"'),
  },
  {
    name: 'href 使用 javascript:',
    expect: /不允許的 scheme/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('<main id="main-content"', '<a href="javascript:alert(1)">x</a><main id="main-content"'),
  },
  {
    name: 'main#main-content 消失',
    expect: /main#main-content/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('<main id="main-content"', '<main id="other"'),
  },
  // ── 自架函式庫的 ES module import 圖（#94 後續）──
  //
  // 這三項對應兩個實際發生過、而且 checker 當時完全沒反應的失效：把 vendor 的
  // ES module 進入點所 import 的檔刪掉，站台功能全死而 check:site 全綠。
  // 原因是 checker 只認 HTML 屬性，追不到 import 圖。有了這三項，那一層退化
  // 就不可能再悄悄發生——這正是本檔存在的理由。
  {
    // fuse-global.js 只有 7 行，真正的搜尋引擎在它 import 的 fuse.esm.js 裡。
    // 刪掉引擎 → 首頁搜尋框永遠停在載入中。
    name: 'vendor：搜尋引擎（shim 所 import 的檔）被刪掉',
    expect: /靜態 import 了「\.\/fuse\.esm\.js」/,
    apply: () => renameSync(`${DIST}/vendor/fuse.esm.js`, `${DIST}/vendor/fuse.esm.js.bak`),
    undo: () => renameSync(`${DIST}/vendor/fuse.esm.js.bak`, `${DIST}/vendor/fuse.esm.js`),
  },
  {
    // ionicons 的 chunk 檔名帶 hash，寫不進 .astro，所以只可能靠 import 圖驗。
    // 刪掉之後實測：17 個 ion-icon 全部沒有 shadowRoot，一個圖示都不顯示。
    //
    // 要刪哪一個 chunk 是從 loader 自己的 import 推導的，不是寫死檔名。
    // 第一版寫死了 ionicons 7.1.0 的 p-d15ec307.js，在 ionicons 8（chunk 叫
    // p-BdioGpgU.js）直接注入失敗——把「寫死上游檔名」的毛病原封不動搬進了
    // 這個用來防它的檢查裡。
    name: 'vendor：ionicons 的 lazy-load chunk 被刪掉',
    expect: /靜態 import 了「[^」]+」，但 vendor\/ionicons\//,
    apply() {
      const dir = `${DIST}/vendor/ionicons`;
      const loader = `${dir}/ionicons.esm.js`;
      const spec = staticImportSpecifiers(readFileSync(loader, 'utf8')).find((s) => s.startsWith('./'));
      if (!spec) throw new Error('ionicons loader 沒有任何相對的靜態 import，這個注入的前提不成立');
      this.chunk = path.join(dir, spec);
      renameSync(this.chunk, `${this.chunk}.bak`);
    },
    undo() {
      renameSync(`${this.chunk}.bak`, this.chunk);
    },
  },
  {
    // bare specifier 在瀏覽器沒有 import map 時解析不了。這是「manifest 指到
    // node 專用 build」會留下的痕跡，症狀同樣是靜默失效。
    name: 'vendor：ES module 靜態 import 了 bare specifier',
    expect: /不是相對路徑，瀏覽器沒有 import map 解析不了/,
    file: `${DIST}/vendor/fuse-global.js`,
    mutate: (t) => `import x from "node:fs";\n${t}`,
  },
  {
    // import 圖走訪看不到 SVG——它根本不在圖上。清單看得到。
    name: 'vendor 清單：非 JS 產出（ionicon SVG）不見了',
    expect: /vendor 步驟產出過 ionicons\/svg\/[\w-]+\.svg，但它不在建置產物裡/,
    apply() {
      const dir = `${DIST}/vendor/ionicons/svg`;
      const first = readdirSync(dir).find((f) => f.endsWith('.svg'));
      if (!first) throw new Error('vendor 沒有任何 ionicon SVG，這個注入的前提不成立');
      this.svg = `${dir}/${first}`;
      renameSync(this.svg, `${this.svg}.bak`);
    },
    undo() {
      renameSync(`${this.svg}.bak`, this.svg);
    },
  },
  {
    // 清單自己不見也要紅。否則「刪掉清單」就等於把上面那一關關掉——這一系列
    // issue 反覆出現的正是這種「保護可以被一個編輯動作繞過」。
    name: 'vendor 清單：清單檔本身被刪掉',
    expect: /找不到這份清單/,
    apply: () => renameSync(`${DIST}/vendor/vendor-manifest.json`, `${DIST}/vendor/vendor-manifest.json.bak`),
    undo: () => renameSync(`${DIST}/vendor/vendor-manifest.json.bak`, `${DIST}/vendor/vendor-manifest.json`),
  },
];

console.log('先確認基準狀態為綠：');
const base = run();
console.log(base.code === 0 ? '  ✅ 基準綠燈\n' : `  ❌ 基準已經是紅的，無法進行故障注入\n${base.out.slice(0, 500)}`);
if (base.code !== 0) process.exit(1);

let pass = 0;
let fail = 0;
for (const c of cases) {
  let original = null;
  try {
    if (c.file) {
      original = readFileSync(c.file, 'utf8');
      const mutated = c.mutate(original);
      if (mutated === original) throw new Error('注入未生效（mutate 沒有改到任何東西）');
      writeFileSync(c.file, mutated, 'utf8');
    } else {
      c.apply();
    }
    const r = run();
    const caught = r.code !== 0 && c.expect.test(r.out);
    if (caught) {
      pass++;
      console.log(`  ✅ ${c.name}`);
    } else {
      fail++;
      console.log(`  ❌ ${c.name}  → exit=${r.code}${r.code === 0 ? '（沒擋下來！）' : '（擋了但訊息不符預期）'}`);
      if (r.code !== 0) console.log('       實際訊息片段：' + (r.out.match(/✗ .*/) || ['(無)'])[0].slice(0, 100));
    }
  } catch (e) {
    fail++;
    console.log(`  ❌ ${c.name}  → 注入失敗：${e.message}`);
  } finally {
    if (c.file && original !== null) writeFileSync(c.file, original, 'utf8');
    else if (c.undo) { try { c.undo(); } catch {} }
  }
}

console.log(`\n故障注入：${pass} 擋下 / ${fail} 漏掉（共 ${cases.length} 項）`);
const after = run();
console.log(after.code === 0 ? '還原後仍為綠燈 ✅' : `⚠ 還原後仍是紅的，${DIST} 沒復原乾淨`);

// 副本用完就刪。留著會讓下一次 check:site 之類的工具多掃一份重複產物。
rmSync(DIST, { recursive: true, force: true });

process.exit(fail === 0 && after.code === 0 ? 0 : 1);
