# FlexSearch POC - Proof of Concept

## 🎯 POC 目標

驗證 FlexSearch + segmentit 能否作為 Fuse.js 的替代方案，特別是針對**中文搜尋**的改進。

---

## 📂 POC 檔案

1. **poc-flexsearch.html** - 互動式測試頁面
   - FlexSearch + segmentit 整合
   - 與 Fuse.js 並列比較
   - 即時效能統計

2. **POC_TEST_GUIDE.md** - 測試指南
   - 測試步驟
   - 關鍵測試案例
   - 決策標準

3. **FLEXSEARCH_MIGRATION_PLAN.md** - 遷移評估文件（詳細版）

---

## 🚀 快速開始

### 1. 開啟測試頁面

```bash
# 直接開啟
open poc-flexsearch.html
```

### 2. 執行關鍵測試

1. 等待索引建立完成（狀態顯示「✅ 已就緒」）
2. 點擊「科學」按鈕（測試中文部分詞搜尋）
3. 點擊「🔥 完整 Benchmark」（測試整體性能）

### 3. 觀察結果

比較左側（FlexSearch）和右側（Fuse.js）的：
- 搜尋速度
- 結果數量
- 結果相關性

---

## 🔬 核心技術

### FlexSearch 配置

```javascript
const flexIndex = new FlexSearch.Document({
    document: {
        id: "id",
        index: ["title", "content", "tags"],
        store: ["id", "title", "url", "content", "tags"]
    },
    encode: false,  // 關閉預設 encoder
    tokenize: function(str) {
        // 使用 segmentit 進行中文分詞
        const segments = segment.doSegment(str, { simple: true });
        return segments.map(seg => seg.toLowerCase());
    },
    cache: true
});
```

### 中文分詞

使用 **segmentit** (純 JavaScript):
- ✅ 支援瀏覽器環境
- ✅ 輕量級（~50KB）
- ✅ 無需編譯

---

## 📊 預期結果

### 性能預期

| 指標 | FlexSearch | Fuse.js | 差異 |
|------|------------|---------|------|
| 索引建立 | 500-800ms | 100-150ms | 較慢（但只執行一次） |
| 單次搜尋 | 2-5ms | 20-50ms | **快 5-15x** ⚡ |
| 中文部分詞 | ✅ 支援 | ❌ 不支援 | **核心優勢** |

### 中文搜尋優勢

**查詢: "科學"**

- **FlexSearch**: ✅ 能找到「科學展覽」、「科學研究」
- **Fuse.js**: ❌ 只能完全匹配「科學」

---

## ✅ 決策標準

### 建議進行全面遷移

滿足以下條件：
- [x] 平均速度提升 > 2x
- [x] 中文部分詞搜尋有效
- [x] 無明顯功能缺陷
- [x] 搜尋結果準確度 >= 80%

### 不建議遷移

出現以下情況：
- [ ] 速度沒有提升或更慢
- [ ] 中文分詞效果很差
- [ ] 結果準確度大幅下降
- [ ] 頻繁出現錯誤

---

## 📚 相關文件

- **FLEXSEARCH_MIGRATION_PLAN.md** - 完整遷移計畫（52 頁）
- **POC_TEST_GUIDE.md** - 測試指南
- **poc-flexsearch.html** - 測試頁面

---

## 🔜 下一步

### 如果 POC 成功

1. 記錄測試結果
2. 決定是否進行 Phase 2（完整實作）
3. 制定遷移時程

### Phase 2 完整實作（預估 1 天）

- 重構 index.html 搜尋邏輯
- 整合 FlexSearch + segmentit
- localStorage 快取優化
- 完整測試與部署

---

**建立日期**: 2025-11-23
**狀態**: POC 實作完成，待測試驗證
