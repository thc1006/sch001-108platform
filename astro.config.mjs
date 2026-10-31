// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { CLUSTERS } from './src/data/clusters.ts';
import { pdfLabel, tableScroll } from './src/markdown/a11y-plugins.mjs';

// 台灣教育處方籤部署在 GitHub Pages 的專案頁，網址帶 /sch001-108platform 前綴。
//
// Astro 7 用 @astrojs/markdown-satteri 轉換 Markdown，表格對齊會輸出成
// style="text-align: left" 這類行內樣式，作者 CSS 的選擇器蓋不過，要用 CSS 改表格對齊
// 得加 !important（#133）。
export default defineConfig({
  // Tailwind v4 走 Vite 外掛，因為 Astro 7 建置時，Vite 8 內建的 postcss-import 解析不了
  // @import "tailwindcss"（#105、#133）。cssMinify 不用 Vite 8 預設的 lightningcss：它把
  // min-width 斷點改寫成 (width>=40rem) 這種 range 語法，Safari／iOS 16.4 之前的版本
  // 不認得，斷點全部失效，建置卻照樣成功（#110）。
  vite: {
    plugins: [tailwindcss()],
    build: { cssMinify: 'esbuild' },
  },
  site: 'https://thc1006.github.io',
  base: '/sch001-108platform',
  trailingSlash: 'ignore',
  // Astro 7 預設的 'jsx' 會刪掉元素間含換行的空白，麵包屑分隔線兩側各少一個空格的寬度（#105）。
  compressHTML: true,
  // 'preserve' 照 src/pages 的結構輸出：competitions.astro 輸出成 competitions.html，
  // foo/index.astro 輸出成 foo/index.html，既有網址才不會變。'file' 會把後者壓成 foo.html。
  build: {
    format: 'preserve',
  },
  // @astrojs/sitemap 在 build.format:'preserve' 下預設產生無副檔名 URL，
  // 與本站實際的 .html 網址不符，以 serialize 修正：區段首頁（foo/index.html）
  // 維持目錄式網址，其餘頁面補回 .html。
  integrations: [
    // Sätteri 的外掛要加進預設 processor 的 options；Astro 保留它的參照，轉換時才讀得到。
    {
      name: 'markdown-a11y',
      hooks: {
        'astro:config:setup'({ config }) {
          config.markdown.processor.options.hastPlugins.push(tableScroll, pdfLabel);
        },
      },
    },
    sitemap({
      serialize(item) {
        const base = '/sch001-108platform/';
        const clusterSlugs = CLUSTERS.map((c) => c.slug);
        const sectionIndexes = new Set([
          'advanced-resources',
          'autonomous-learning',
          'career-exploration',
          'civic-tech-map',
          'learning-portfolio',
          // 學群探索首頁和各學群中心頁，都是 foo/index.astro。
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
