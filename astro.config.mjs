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
  // TODO(PR 3 / 切換部署):@astrojs/sitemap 在 build.format:'preserve' 下會
  // 產生無副檔名 URL(/about),與本站實際的 .html 網址不符。切換部署時需:
  // 以 serialize 補 .html(區段首頁維持目錄式)、移除舊 sitemap.xml、並把
  // robots.txt 的 Sitemap: 指向 sitemap-index.xml。
  integrations: [sitemap()],
});
