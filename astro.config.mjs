// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { CLUSTERS } from './src/data/clusters.ts';

// 台灣教育處方籤 — 部署於 GitHub Pages 專案頁(網址含 /sch001-108platform 前綴)。
//
// build.format:'preserve' 讓輸出 1:1 對應 src/pages 結構:
//   index.astro → index.html、competitions.astro → competitions.html、
//   advanced-resources/index.astro → advanced-resources/index.html。
// 完整保留既有網址、不破壞外部連結、書籤與 SEO。
// (註:'file' 會把 foo/index.astro 壓成 foo.html,破壞區段首頁網址,故不可用。)
//
// Tailwind v4 經由 @tailwindcss/vite 套用。Astro 7 帶的是 Vite 8，它的
// postcss-import 解析不了 @import "tailwindcss" 這種裸模組名
// (ENOENT ... open '...\tailwindcss')，所以 PostCSS 那條路在 Astro 7 已經走不通。
//
// 機制（升級當時插樁量到的，記在這裡免得日後有人再查一次）：Vite 8 把
// createIdResolver 換成 rolldown 的 oxc 解析器，而 Astro 的靜態建置跑在
// `prerender` 環境——不是 client/ssr，吃不到 Vite 的 back-compat 解析路徑。
// oxc 在此把 `tailwindcss` 判成 external 並原樣回傳（resolveId 得到
// {"id":"tailwindcss","external":true}），而 postcss-import 的 resolve 只看
// 回傳值是否為真、不看 external，於是 path.resolve('tailwindcss') 被接到專案
// 根目錄底下，變成上面那個 ENOENT。
//
// ── Markdown 管線也一起換了 ──
//
// Astro 7 的具名破壞性變更：Sätteri 取代 remark/rehype，@astrojs/markdown-remark
// 已不在相依樹內，換成 @astrojs/markdown-satteri。對本站輸出的影響清點為三類，
// 數字是 2026-08-29 對建置後 94 頁重新核對過的：
//
//   1. 表格對齊 align="left" → style="text-align: left"，542 處 / 17 頁
//      （<td> 445、<th> 97；站上 align="left" 已歸零，也沒有其他 align 值）。
//      **這一項要留意，因為它是「層疊優先序」的變更**：舊的 align 是
//      presentational hint，優先序比作者 CSS 低，一條普通選擇器就蓋得掉；
//      新的行內樣式優先序最高。日後若要用 CSS 改表格對齊，得用行內樣式或
//      !important 才蓋得掉。
//   2. 實體編碼 &#x26; → &amp;（站上 &#x26; 已歸零），解碼後同為 &。
//   3. 一處裸 > 改成 &gt;（全站 &gt; 由 13 處變 14 處）。
//
// 三類目前都沒有可見差異，記錄下來是為了「日後版面出問題時知道哪些東西動過」。
export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    // cssMinify 必須顯式指定 'esbuild'，不能吃 Vite 8 的預設。
    //
    // Vite 8 把 server consumer 的預設從 esbuild 改成 lightningcss
    // （dist/node/chunks/node.js：cssMinify ?? (consumer === "server" ? "lightningcss" : …)；
    //  Vite 7.3.3 同一行是 "esbuild"）。Astro 的 CSS 就是走 server consumer，於是升上
    // Astro 7 之後 lightningcss 把全站每一條斷點改寫成 MQ Level 4 的 range 語法：
    //
    //   @media(min-width:40rem)  →  @media (width>=40rem)     ← 全部 sm:/md:/lg:/xl:/2xl:
    //   @media(max-width:860px)  →  @media (width<=860px)
    //
    // range 語法要 Safari／iOS 16.4+。舊瀏覽器不會報錯，那些規則只是**永遠不匹配**，
    // 版面靜默塌回最窄的基準樣式——而 build 退出 0、CSS 也不是空的，所以「CSS 有產出」
    // 這種檢查完全擋不住。實測 main 上的產出確實含 12 條 range 語法、0 條 min-width 斷點。
    //
    // 釘回 esbuild 之後產出與 Astro 6 同一份 Tailwind 的結果位元組相同。
    // 這裡的原則和底下 compressHTML 那條一樣：瀏覽器支援度不該夾在框架升級裡悄悄移動。
    build: { cssMinify: 'esbuild' },
  },
  site: 'https://thc1006.github.io',
  base: '/sch001-108platform',
  trailingSlash: 'ignore',
  // Astro 7 把預設改成 compressHTML: 'jsx'，會移除元素之間的空白文字節點。
  // 實測 93 頁的版面幾何：73 頁有約 4px 的水平位移（原本靠 inline 空白提供的
  // 間距消失，例如麵包屑的分隔線）。元素數量完全相同、沒有內容遺失，但那是
  // 使用者看得到的變化，不該夾在版本升級裡悄悄發生。
  // 明確設回 true（Astro 6 的行為），要改樣式時再單獨決定。
  compressHTML: true,
  build: {
    format: 'preserve',
  },
  // @astrojs/sitemap 在 build.format:'preserve' 下預設產生無副檔名 URL,
  // 與本站實際的 .html 網址不符;以 serialize 修正 —— 區段首頁(foo/index.html)
  // 維持目錄式網址,其餘頁面補回 .html。
  integrations: [
    sitemap({
      serialize(item) {
        const base = '/sch001-108platform/';
        // 學群 slug —— 直接取自 src/data/clusters.ts 的 CLUSTERS,避免清單重複。
        const clusterSlugs = CLUSTERS.map((c) => c.slug);
        const sectionIndexes = new Set([
          'advanced-resources',
          'autonomous-learning',
          'career-exploration',
          'civic-tech-map',
          'learning-portfolio',
          // 學群探索系統:探索首頁 + 9 個學群中心頁(皆為 foo/index.astro)。
          'career-exploration/clusters',
          ...clusterSlugs.map((s) => `career-exploration/clusters/${s}`),
        ]);
        const rel = new URL(item.url).pathname.replace(base, '').replace(/\/$/, '');
        if (rel === '') return item; // 站台首頁,維持目錄式
        if (sectionIndexes.has(rel)) {
          item.url = `https://thc1006.github.io${base}${rel}/`;
        } else if (!item.url.endsWith('.html')) {
          item.url = `https://thc1006.github.io${base}${rel}.html`;
        }
        return item;
      },
    }),
  ],
});
