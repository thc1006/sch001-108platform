#!/usr/bin/env node
/**
 * 站台契約的故障注入矩陣。
 *
 * 逐一破壞一個契約，確認 check-built-site.mjs 真的會擋下來。
 *
 * 為什麼要常駐在 repo 裡，而不是改完跑一次就算：
 * 「正常狀態綠燈」證明不了 checker 有在把關。
 * checker 可能因為 glob 寫錯、選擇器改名、或某個分支被短路而變成裝飾品，而這
 * 種退化在正常狀態下完全看不出來。只有持續地「故意弄壞、確認會紅」才擋得住。
 *
 * 本檔在 dist/ 的副本上逐項破壞再還原，最後確認副本回到綠燈。
 * 標了 expectGreen 的是反向項目：改動之後 checker 必須維持綠燈，守的是刻意不檢查的欄位，或不該誤報的寫法。
 *
 * 執行：  npm run test:site-faults    （需先 npm run build:deployable）
 */
import { readFileSync, writeFileSync, renameSync, readdirSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

// 注入點盡量從產物自己推導。用共用的掃描器（與 check-built-site.mjs、
// vendor-assets.mjs 同一份），才不會在「防寫死」的檢查裡自己寫死上游檔名。
import { staticImportSpecifiers } from './site-contract.lib.mjs';

// 故障注入一律在 dist/ 的副本上進行，被破壞的那份絕不能是要部署的那份。
//
// 還原邏輯本身是寫對的（每個 case 都有 finally，最後也會確認基準回到綠燈才
// exit 0），但只要有一個 case 在 undo 之前崩潰，dist/ 就會留著壞掉的內容，
// 後面檢查或上傳的就是它。用副本讓這個風險在結構上不存在，而不是靠還原寫得夠好。
const SOURCE = process.env.SITE_DIST_SOURCE || 'dist';
const DIST = process.env.SITE_DIST_WORK || 'dist-faultcheck';
if (!existsSync(SOURCE)) {
  console.error(`找不到建置產物 ${SOURCE}/，請先執行 npm run build:deployable`);
  process.exit(1);
}
rmSync(DIST, { recursive: true, force: true });
cpSync(SOURCE, DIST, { recursive: true });
console.log(`故障注入在副本 ${DIST}/ 上進行，${SOURCE}/ 不會被更動。\n`);

// AI 閘道的 case 要與「建置時有沒有設 PUBLIC_AI_GATEWAY_URL」無關：設了的話每頁本來就有一個
// 合格的 meta，再插一個只會得到「最多 1 個」，每個 case 的預期訊息都對不上。所以先把副本裡的
// 閘道 meta 全部拿掉，讓這些 case 都從「沒設定」出發；檢查時也不帶這個環境變數（見 run）
const GATEWAY_META = /<meta name="ai-gateway-url"[^>]*>/g;
const htmlFiles = (dir) => readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.html'))
  .map((f) => path.join(dir, f));
for (const file of htmlFiles(DIST)) {
  const html = readFileSync(file, 'utf8');
  const stripped = html.replace(GATEWAY_META, '');
  if (stripped !== html) writeFileSync(file, stripped);
}

// 每頁都插一個閘道 meta（about.html 可以給不同的值）；undo 用的是同一個 pattern
const injectGatewayEverywhere = (value, aboutValue = value) => {
  for (const file of htmlFiles(DIST)) {
    const html = readFileSync(file, 'utf8');
    if (!html.includes('</head>')) continue;
    const v = file.endsWith(`${path.sep}about.html`) ? aboutValue : value;
    writeFileSync(file, html.replace('</head>', `<meta name="ai-gateway-url" content="${v}"></head>`));
  }
};
const removeGatewayEverywhere = () => {
  for (const file of htmlFiles(DIST)) {
    const html = readFileSync(file, 'utf8');
    const stripped = html.replace(GATEWAY_META, '');
    if (stripped !== html) writeFileSync(file, stripped);
  }
};

const run = (extraEnv = {}) => {
  const env = { ...process.env, SITE_DIST: DIST, ...extraEnv };
  if (!('PUBLIC_AI_GATEWAY_URL' in extraEnv)) delete env.PUBLIC_AI_GATEWAY_URL;
  try {
    execSync('node scripts/check-built-site.mjs', { stdio: 'pipe', env });
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
    name: '競賽頁的描述寫死成 130＋ 項',
    expect: /應寫 competitions\.json 的 \d+ 筆/,
    file: `${DIST}/advanced-resources/competitions.html`,
    mutate: (t) => t.replace(/(<meta name="description" content="彙整 )\d+ 項/, (_, head) => `${head}130＋ 項`),
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
    name: '資料 JSON 的說明文字寫了站內網址，指向不存在的頁面',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/advanced-resources/competitions.json`,
    mutate: (t) => t.replace(/"description":\s*"/, '"description": "見 https://thc1006.github.io/sch001-108platform/missing-page.html 。'),
  },
  {
    name: '資料 JSON 的 HTML 欄位內文寫了站內網址，指向不存在的頁面',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/learning-portfolio/portfolio-gallery.json`,
    mutate: (t) => t.replace(/"analysis_html":\s*"/, '"analysis_html": "見 https://thc1006.github.io/sch001-108platform/missing-page.html 。'),
  },
  {
    name: '_readme 裡的網址範本不檢查',
    expectGreen: true,
    file: `${DIST}/advanced-resources/reading-list.json`,
    mutate: (t) => t.replace(/"_readme":\s*"/, '"_readme": "範本 https://thc1006.github.io/sch001-108platform/missing-page.html 。'),
  },
  {
    name: 'HTML 欄位相鄰兩段的文字不接成一個網址',
    expectGreen: true,
    file: `${DIST}/learning-portfolio/portfolio-gallery.json`,
    mutate: (t) => t.replace(/"analysis_html":\s*"/, '"analysis_html": "<p>https://thc1006.github.io/sch001-108platform/about.html</p><p>x</p>'),
  },
  {
    name: '說明文字裡寫給人照著做的網址（chrome://、localhost）不當成連結',
    expectGreen: true,
    file: `${DIST}/learning-portfolio/tools.json`,
    mutate: (t) => t.replace(/"description":\s*"/, '"description": "在網址列輸入 chrome://extensions，或開 http://localhost:8888/ 。'),
  },
  {
    name: 'HTML 欄位 style 裡的網址不當成內文',
    expectGreen: true,
    file: `${DIST}/learning-portfolio/portfolio-gallery.json`,
    mutate: (t) => t.replace(/"analysis_html":\s*"/, '"analysis_html": "<style>a{background:url(https://thc1006.github.io/sch001-108platform/missing-page.html)}</style>'),
  },
  {
    name: '資料 JSON 的 HTML 欄位用 iframe 嵌入不存在的站內頁面',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/learning-portfolio/portfolio-gallery.json`,
    mutate: (t) => t.replace(/"analysis_html":\s*"/, '"analysis_html": "<iframe src=\\"missing-page.html\\"></iframe>'),
  },
  {
    name: '資料 JSON 的 HTML 欄位用 srcset 指向不存在的站內圖片',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/learning-portfolio/portfolio-gallery.json`,
    mutate: (t) => t.replace(/"analysis_html":\s*"/, '"analysis_html": "<img srcset=\\"missing-page.png 2x\\">'),
  },
  {
    name: 'search-index 的 url 指向不存在的頁面',
    expect: /找不到對應的部署檔案/,
    file: `${DIST}/search-index.json`,
    mutate: (t) => t.replace(/"url":\s*"[^"]+"/, '"url": "definitely-missing-page.html"'),
  },
  {
    // 以下五項對應 #14 新增的搜尋分類層。少了它們，「索引裡的素養／SDG 標籤」
    // 這件事在建置產物上就完全沒有把關：標籤壞掉的症狀是「搜尋找不到」，
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
  {
    name: '內文露出沒轉成粗體的 **',
    expect: /\*\* 沒有轉成粗體：\*\*模擬聯合國（MUN）\*\*已是/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</main>', '<ul><li>**模擬聯合國（MUN）**已是</li></ul></main>'),
  },
  {
    name: '** 配錯對，產生巢狀的 strong',
    expect: /配錯對：<strong> 裡有 <strong>：甲（乙）丙丁/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</main>', '<p><strong>甲（乙）<strong>丙</strong>丁</strong></p></main>'),
  },
  {
    name: '粗體裡的斜體、斜體裡的粗體不算巢狀',
    expectGreen: true,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</main>', '<p><em><strong>粗斜</strong></em><strong>粗 <em>斜</em></strong></p></main>'),
  },
  {
    name: 'code、pre 裡的 ** 不算',
    expectGreen: true,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</main>', '<p><code>**kwargs</code></p><pre>a ** 2</pre></main>'),
  },
  // 自架函式庫的 ES module import 圖（#94）。
  //
  // 下面三項把 vendor 的 ES module 進入點所 import 的檔刪掉，或讓它 import bare
  // specifier，確認 check:site 會紅。只認 HTML 屬性的 checker 追不到 import 圖，
  // 只被 import、沒被屬性指名的檔不見了也看不出來。
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
    // 要刪哪一個 chunk 是從 loader 自己的 import 推導的，不是寫死檔名：chunk 名稱
    // 每個版本都不同（ionicons 7.1.0 是 p-d15ec307.js，8 是 p-BdioGpgU.js），寫死的話，
    // 這個用來防「寫死上游檔名」的檢查自己就會在升級後注入失敗。
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
    // import 圖走訪看不到 SVG，它根本不在圖上；清單看得到。
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
    // 只驗「存在」的話，被截斷的檔案照樣全綠：實測把 fuse.esm.js 截成 0 位元組，
    // check:site「錯誤：0 ✅ 全部通過」而全站搜尋已死。這是 artifact 上傳不完整／
    // 解壓被截斷的形狀，而本 repo 的 CI 前提就是「驗過的位元組＝被部署的位元組」。
    // 要截哪個檔從清單推導，不寫死檔名。
    name: 'vendor 清單：產出被截斷成 0 位元組（存在但內容沒了）',
    expect: /的大小與 vendor 步驟產出時不符：預期 \d+ 位元組，實際 0 位元組/,
    apply() {
      const manifest = JSON.parse(readFileSync(`${DIST}/vendor/vendor-manifest.json`, 'utf8'));
      const target = manifest.files.find((f) => f.bytes > 0 && f.path.endsWith('.js'));
      if (!target) throw new Error('清單裡沒有任何非空的 JS 產出，這個注入的前提不成立');
      this.file = `${DIST}/vendor/${target.path}`;
      this.body = readFileSync(this.file);
      writeFileSync(this.file, '');
    },
    undo() {
      writeFileSync(this.file, this.body);
    },
  },
  {
    name: 'AI 閘道網址不是 https',
    expect: /AI 閘道網址必須是 https/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</head>', '<meta name="ai-gateway-url" content="http://gateway.example"></head>'),
  },
  {
    name: 'AI 閘道網址帶了查詢字串',
    expect: /AI 閘道網址不能帶查詢字串或 #/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</head>', '<meta name="ai-gateway-url" content="https://gateway.example/?model=x"></head>'),
  },
  {
    name: 'AI 閘道網址一頁出現兩次',
    expect: /最多 1 個，實際 2 個/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</head>', '<meta name="ai-gateway-url" content="https://a.example"><meta name="ai-gateway-url" content="https://a.example"></head>'),
  },
  {
    // 只有一頁有、其他頁沒有：那些頁面的 AI 功能會一律回報「尚未設定」
    name: 'AI 閘道網址只出現在部分頁面',
    expect: /部分頁面缺少 AI 閘道網址/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</head>', '<meta name="ai-gateway-url" content="https://gateway.example"></head>'),
  },
  {
    name: 'AI 閘道網址指向內部網路（Tailscale 的 CGNAT 位址）',
    expect: /AI 閘道網址不能指向本機或內部網路/,
    file: `${DIST}/about.html`,
    mutate: (t) => t.replace('</head>', '<meta name="ai-gateway-url" content="https://100.64.0.1"></head>'),
  },
  {
    name: 'AI 閘道網址各頁不一致',
    expect: /各頁的 AI 閘道網址不一致/,
    apply: () => injectGatewayEverywhere('https://a.example', 'https://b.example'),
    undo: removeGatewayEverywhere,
  },
  {
    // BaseLayout 讀的變數名稱被改掉或打錯：產物整批沒有 meta，前後依然一致
    name: 'AI 閘道：建置時有設定，產物卻沒有',
    expect: /建置時設定了 PUBLIC_AI_GATEWAY_URL，產物卻沒有任何頁面帶著 AI 閘道網址/,
    env: { PUBLIC_AI_GATEWAY_URL: 'https://gateway.example' },
    apply: () => {},
    undo: () => {},
  },
  {
    name: 'AI 閘道：產物的網址和建置時的設定不同',
    expect: /產物的 AI 閘道網址和建置時的設定不同/,
    env: { PUBLIC_AI_GATEWAY_URL: 'https://b.example' },
    apply: () => injectGatewayEverywhere('https://a.example'),
    undo: removeGatewayEverywhere,
  },
  {
    name: 'AI 閘道：建置時沒有設定（空字串），產物卻有',
    expect: /建置時沒有設定 PUBLIC_AI_GATEWAY_URL，產物卻帶著 AI 閘道網址/,
    env: { PUBLIC_AI_GATEWAY_URL: '' },
    apply: () => injectGatewayEverywhere('https://a.example'),
    undo: removeGatewayEverywhere,
  },
  {
    // 清單自己不見也要紅，否則「刪掉清單」就等於把上面那一關關掉，一個編輯動作
    // 就能繞過保護。
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
    const r = run(c.env);
    const ok = c.expectGreen ? r.code === 0 : r.code !== 0 && c.expect.test(r.out);
    if (ok) {
      pass++;
      console.log(`  ✅ ${c.name}`);
    } else {
      fail++;
      if (c.expectGreen) console.log(`  ❌ ${c.name}  → exit=${r.code}（這項改動不該變紅）`);
      else console.log(`  ❌ ${c.name}  → exit=${r.code}${r.code === 0 ? '（沒擋下來！）' : '（擋了但訊息不符預期）'}`);
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

console.log(`\n故障注入：${pass} 項符合預期 / ${fail} 項不符（共 ${cases.length} 項）`);
const after = run();
console.log(after.code === 0 ? '還原後仍為綠燈 ✅' : `⚠ 還原後仍是紅的，${DIST} 沒復原乾淨`);

// 副本用完就刪。留著會讓下一次 check:site 之類的工具多掃一份重複產物。
rmSync(DIST, { recursive: true, force: true });

process.exit(fail === 0 && after.code === 0 ? 0 : 1);
