// 十大學群的中繼資料 —— 學群探索頁、學群中心頁、主題子頁共用。
// slug 對應 src/content/clusters/<slug>/ 內容目錄與 /career-exploration/clusters/<slug>/ 路由。

export interface ClusterMeta {
  slug: string;
  name: string;
  shortName: string;
  description: string;
}

export const CLUSTERS: ClusterMeta[] = [
  { slug: 'engineering', name: '工程學群', shortName: '工程', description: '應用科學與數學原理解決實務問題,從晶片設計、橋樑建造到能源系統。' },
  { slug: 'info', name: '資訊學群', shortName: '資訊', description: '電腦科學、軟體開發、數據分析與人工智慧,數位時代的核心驅動力。' },
  { slug: 'management', name: '管理學群', shortName: '管理', description: '組織、領導、規劃與行銷,讓團隊與企業有效運作、達成目標。' },
  { slug: 'finance', name: '財經學群', shortName: '財經', description: '金融市場、投資、公司理財與經濟現象,是資本社會的運作基礎。' },
  { slug: 'social-psychology', name: '社會與心理學群', shortName: '社會與心理', description: '人類的心理歷程、社會行為與結構,理解並改善個人與社會的福祉。' },
  { slug: 'mass-comm', name: '大眾傳播學群', shortName: '大眾傳播', description: '訊息的產製、傳遞與影響,涵蓋新聞、廣告、廣電影視與公共關係。' },
  { slug: 'design', name: '設計學群', shortName: '設計', description: '結合美感與實用性,從平面、工業到建築設計,解決生活中的問題。' },
  { slug: 'life-science', name: '生命科學學群', shortName: '生命科學', description: '從分子、細胞到生態系探討生命,是生物科技與醫學研究的基礎。' },
  { slug: 'medicine', name: '醫藥衛生學群', shortName: '醫藥衛生', description: '人體健康的維護與疾病治療,涵蓋醫師、藥師、護理與治療等專業。' },
  { slug: 'law', name: '法政學群', shortName: '法政', description: '法律、政治、公共行政與外交,探討規範、權力分配與公共事務的運作。' },
];

export interface TopicMeta {
  slug: string;
  name: string;
  short: string;
  order: number;
}

// 每個學群統一的 6 個主題(對應 src/content/clusters/<slug>/<topic>.md)。
export const TOPICS: TopicMeta[] = [
  { slug: 'overview', name: '科系風向標', short: '風向標', order: 1 },
  { slug: 'traits', name: '教授看重的特質與能力', short: '特質與能力', order: 2 },
  { slug: 'highlights', name: '多元表現亮點策略', short: '多元表現', order: 3 },
  { slug: 'inquiry', name: '自主學習與探究專題方向', short: '自主學習', order: 4 },
  { slug: 'myths', name: '常見迷思破解', short: '迷思破解', order: 5 },
  { slug: 'application', name: '申請備審與面試要點', short: '備審面試', order: 6 },
];

export const getCluster = (slug: string): ClusterMeta | undefined =>
  CLUSTERS.find((c) => c.slug === slug);

export const getTopic = (slug: string): TopicMeta | undefined =>
  TOPICS.find((t) => t.slug === slug);
