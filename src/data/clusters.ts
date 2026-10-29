// 十大學群的中繼資料，學群探索頁、學群中心頁、主題子頁和 astro.config.mjs 的 sitemap 設定共用。
// slug 對應 src/content/clusters/<slug>/ 內容目錄與 /career-exploration/clusters/<slug>/ 路由。

export interface ClusterMeta {
  slug: string;
  name: string;
  shortName: string;
  // ColleGo! 學群介紹頁的 current_college_id 與學群名稱，description 改寫自該頁。
  collegoId: number;
  collegoName: string;
  description: string;
}

export const CLUSTERS: ClusterMeta[] = [
  { slug: 'engineering', name: '工程學群', shortName: '工程', collegoId: 2, collegoName: '工程學群', description: '結合基礎科學和工程技術，分成電機電子、機械工程、土木工程、化學工程、材料工程等領域。' },
  { slug: 'info', name: '資訊學群', shortName: '資訊', collegoId: 1, collegoName: '資訊學群', description: '學電腦軟硬體結構、作業系統原理和程式設計，也學資訊系統的規劃管理、資訊安全等。' },
  { slug: 'management', name: '管理學群', shortName: '管理', collegoId: 16, collegoName: '管理學群', description: '學溝通協調、領導規劃、系統分析、資源整合等，用來處理組織內外的人、事、物問題。' },
  { slug: 'finance', name: '財經學群', shortName: '財經', collegoId: 17, collegoName: '財經學群', description: '探究金融體系怎麼運作，以經濟、財務金融、會計、保險學類為重心，課程包括資本市場、證券投資、資產管理等。' },
  { slug: 'social-psychology', name: '社會與心理學群', shortName: '社會與心理', collegoId: 10, collegoName: '社會心理學群', description: '觀察分析社會結構與社會現象，探討個人的心理歷程，也學助人專業。' },
  { slug: 'mass-comm', name: '大眾傳播學群', shortName: '大眾傳播', collegoId: 11, collegoName: '大眾傳播學群', description: '學傳播理論，也學採訪編輯、公關、媒體製作等，把訊息用聲音、文字、影像等方式傳給大眾。' },
  { slug: 'design', name: '設計學群', shortName: '設計', collegoId: 8, collegoName: '建築設計學群', description: '學建築、空間設計、商業設計、藝術設計、工業設計、媒體設計等，讓物品和環境兼顧實用與美感。' },
  { slug: 'life-science', name: '生命科學學群', shortName: '生命科學', collegoId: 5, collegoName: '生命科學學群', description: '探究生命現象，包括遺傳、演化、生物的構造與功能，以及細胞和分子層次的機制等。' },
  { slug: 'medicine', name: '醫藥衛生學群', shortName: '醫藥衛生', collegoId: 4, collegoName: '醫藥衛生學群', description: '學維護身心健康的知識與技術，包括疾病和傷害的預防與治療，對象從個人到整個人群。' },
  { slug: 'law', name: '法政學群', shortName: '法政', collegoId: 15, collegoName: '法政學群', description: '探究法律與政治制度，法律課程包括憲法、刑法、民事和刑事訴訟等，政治課程包括政府行政、國際政治等。' },
];

export interface TopicMeta {
  slug: string;
  name: string;
  short: string;
  order: number;
}

// 每個學群統一的 6 個主題（對應 src/content/clusters/<slug>/<topic>.md）。
export const TOPICS: TopicMeta[] = [
  { slug: 'overview', name: '科系風向標', short: '風向標', order: 1 },
  { slug: 'traits', name: '特質與能力', short: '特質與能力', order: 2 },
  { slug: 'highlights', name: '多元表現亮點策略', short: '多元表現', order: 3 },
  { slug: 'inquiry', name: '自主學習與探究專題方向', short: '自主學習', order: 4 },
  { slug: 'myths', name: '常見迷思破解', short: '迷思破解', order: 5 },
  { slug: 'application', name: '申請備審與面試要點', short: '備審面試', order: 6 },
];

export const getCluster = (slug: string): ClusterMeta | undefined =>
  CLUSTERS.find((c) => c.slug === slug);

export const getTopic = (slug: string): TopicMeta | undefined =>
  TOPICS.find((t) => t.slug === slug);
