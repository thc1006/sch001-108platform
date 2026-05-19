// Tailwind v4 經由 PostCSS 套用(Astro 會自動讀取此設定檔)。
import tailwindcss from '@tailwindcss/postcss';

export default {
  plugins: [tailwindcss()],
};
