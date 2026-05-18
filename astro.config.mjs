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
  integrations: [sitemap()],
});
