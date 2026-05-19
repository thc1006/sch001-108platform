import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// 9 學群升學指南內容集合。
// 每筆 entry 是一個「學群 × 主題」的內容檔,
// 路徑為 src/content/clusters/<學群slug>/<主題slug>.md,
// entry id 即 "<學群slug>/<主題slug>"(供動態路由拆解)。
const clusters = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/clusters' }),
  schema: z.object({
    cluster: z.string(), // 學群完整中文名,如「工程學群」
    topic: z.string(), // 主題中文名,如「科系風向標」
    order: z.number(), // 主題在學群內的排序(1–6)
    title: z.string(), // 頁面 <title> / 主標題
    description: z.string(), // SEO 描述
  }),
});

export const collections = { clusters };
