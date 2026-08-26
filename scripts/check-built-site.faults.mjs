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
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const DIST = 'dist';
const run = () => {
  try {
    execSync('node scripts/check-built-site.mjs', { stdio: 'pipe' });
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
console.log(after.code === 0 ? '還原後仍為綠燈 ✅' : '⚠ 還原後仍是紅的，dist 可能沒復原乾淨');
process.exit(fail === 0 && after.code === 0 ? 0 : 1);
