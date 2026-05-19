// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// 台灣教育處方籤 — 部署於 GitHub Pages 專案頁(網址含 /sch001-108platform 前綴)。
//
// build.format:'preserve' 讓輸出 1:1 對應 src/pages 結構:
//   index.astro → index.html、competitions.astro → competitions.html、
//   advanced-resources/index.astro → advanced-resources/index.html。
// 完整保留既有網址、不破壞外部連結、書籤與 SEO。
// (註:'file' 會把 foo/index.astro 壓成 foo.html,破壞區段首頁網址,故不可用。)
//
// Tailwind v4 透過 postcss.config.mjs 套用(不用 @tailwindcss/vite —— 該外掛
// 與 Astro 6 的 rolldown-vite 尚不相容)。
export default defineConfig({
  site: 'https://thc1006.github.io',
  base: '/sch001-108platform',
  trailingSlash: 'ignore',
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
        // 學群 slug —— 與 src/data/clusters.ts 的 CLUSTERS 一致。
        const clusterSlugs = [
          'engineering', 'info', 'management', 'finance', 'social-psychology',
          'mass-comm', 'design', 'life-science', 'medicine',
        ];
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
