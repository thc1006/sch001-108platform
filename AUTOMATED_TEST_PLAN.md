# 🤖 自動化並行測試計畫

**建立時間**: 2025-11-23
**狀態**: 執行中
**優先級**: 🔴 Critical - Gemini API 功能為核心

---

## 🎯 測試目標

### 核心目標（Critical）⭐
1. **驗證 Gemini API 功能正常運作** - 網站的核心價值
   - puter.ai.chat 是否可正常呼叫
   - gemini-3-pro-preview 模型是否正常回應
   - 錯誤處理機制是否完善
   - Timeout 機制是否正常

### 次要目標（High Priority）
2. **驗證 FlexSearch POC 可行性**
   - 中文部分詞搜尋效果
   - 效能提升程度（vs Fuse.js）
   - 搜尋結果準確度

### 延伸目標（Medium Priority）
3. **整合測試**
   - 搜尋功能 + Gemini AI 整合測試
   - 前端 UX 測試

---

## 🚀 並行測試架構

### Agent 分工（4 個並行 Agents）

```
測試協調者 (Main Thread)
    │
    ├── Agent 1: Gemini API 功能測試 (frontend-developer) ⭐ 最高優先
    │   └── 測試所有使用 puter.ai.chat 的頁面
    │
    ├── Agent 2: FlexSearch POC 測試 (tdd-orchestrator)
    │   └── 執行 poc-flexsearch.html 自動化測試
    │
    ├── Agent 3: 程式碼審查 (code-reviewer)
    │   └── 檢查 Gemini API 實作品質與安全性
    │
    └── Agent 4: 錯誤偵測 (error-detective)
        └── 找出潛在問題與改進建議
```

---

## 📋 測試項目清單

### 🔴 Agent 1: Gemini API 功能測試（Critical）

#### 測試頁面清單
- [ ] `autonomous-learning/index.html` - 主動學習頁面
- [ ] `autonomous-learning/topic-ideas.html` - 主題構想頁面
- [ ] `autonomous-learning/resource-map.html` - 資源地圖頁面
- [ ] `learning-portfolio/index.html` - 學習歷程頁面
- [ ] `learning-portfolio/reflection-guide.html` - 反思指南頁面
- [ ] `career-exploration/index.html` - 職涯探索頁面
- [ ] `career-exploration/competency-map.html` - 能力地圖頁面

#### 測試案例
1. **基本功能測試**
   ```javascript
   // 測試 1: 簡單文字生成
   puter.ai.chat("測試訊息", { model: "gemini-3-pro-preview" })

   // 測試 2: Timeout 機制
   puter.ai.chat("複雜問題", {
     model: "gemini-3-pro-preview",
     signal: AbortSignal.timeout(30000)
   })

   // 測試 3: 錯誤處理
   // 模擬網路失敗、API 錯誤等情況
   ```

2. **回應格式測試**
   ```javascript
   // 驗證回應結構
   - response.message.content 存在
   - JSON 解析正常
   - 錯誤訊息清晰
   ```

3. **效能測試**
   ```javascript
   // 測試回應時間
   - 正常回應: < 30 秒
   - Timeout 觸發: 30 秒
   - 錯誤處理: < 3 秒
   ```

#### 成功標準
- ✅ 所有 7 個頁面的 Gemini API 呼叫都正常運作
- ✅ 錯誤處理機制完善
- ✅ Timeout 機制正常
- ✅ 回應格式正確且可解析

---

### 🟡 Agent 2: FlexSearch POC 測試（High Priority）

#### 測試檔案
- `poc-flexsearch.html`

#### 測試案例
1. **中文部分詞搜尋測試** ⭐
   ```
   查詢: "科學"
   預期: 應找到 "科學展覽"、"科學研究" 等
   ```

2. **效能 Benchmark 測試**
   ```
   執行 15 項查詢測試
   記錄 FlexSearch vs Fuse.js 速度差異
   目標: 速度提升 > 2x
   ```

3. **準確度測試**
   ```
   測試搜尋結果準確度
   目標: >= 80%
   ```

#### 成功標準
- ✅ 中文部分詞搜尋有效
- ✅ 平均速度提升 > 2x
- ✅ 無明顯功能缺陷
- ✅ 搜尋結果準確度 >= 80%

---

### 🔵 Agent 3: 程式碼審查（Medium Priority）

#### 審查項目
1. **Gemini API 實作品質**
   - [ ] 錯誤處理是否完善
   - [ ] Timeout 設定是否合理
   - [ ] 回應解析是否健壯
   - [ ] 安全性檢查（XSS 防護等）

2. **最佳實踐檢查**
   - [ ] 是否使用正確的模型名稱 (`gemini-3-pro-preview`)
   - [ ] 是否有適當的 Loading 狀態
   - [ ] 是否有使用者友善的錯誤訊息

3. **效能優化建議**
   - [ ] 是否有不必要的 API 呼叫
   - [ ] 是否有快取機制
   - [ ] 是否有防抖動機制

#### 輸出
- 程式碼品質報告
- 改進建議清單
- 優先級排序

---

### 🟢 Agent 4: 錯誤偵測（Medium Priority）

#### 偵測項目
1. **潛在錯誤**
   - [ ] 未處理的 Promise rejection
   - [ ] 潛在的 null/undefined 錯誤
   - [ ] 錯誤的 JSON 解析
   - [ ] 記憶體洩漏風險

2. **邊界案例**
   - [ ] 空字串輸入
   - [ ] 超長輸入
   - [ ] 特殊字元處理
   - [ ] 網路中斷情況

3. **相容性問題**
   - [ ] 瀏覽器相容性
   - [ ] 行動裝置支援
   - [ ] 低速網路情況

#### 輸出
- 潛在問題清單
- 風險評估（High/Medium/Low）
- 修復建議

---

## 📊 測試執行流程

### Phase 1: 並行啟動（同時執行）

```bash
時間: 0 分鐘
├── Agent 1 啟動: Gemini API 測試
├── Agent 2 啟動: FlexSearch POC 測試
├── Agent 3 啟動: 程式碼審查
└── Agent 4 啟動: 錯誤偵測
```

### Phase 2: 執行與監控（5-10 分鐘）

```
Agent 1: 測試 7 個頁面的 Gemini API 功能
Agent 2: 執行 poc-flexsearch.html 測試
Agent 3: 審查程式碼品質
Agent 4: 偵測潛在錯誤
```

### Phase 3: 結果整合（2-3 分鐘）

```
收集所有 Agent 的測試結果
生成統一的測試報告
評估整體品質
```

### Phase 4: 決策（1-2 分鐘）

```
根據測試結果決定：
- Gemini API 是否需要修復
- FlexSearch 是否進行 Phase 2 遷移
- 其他改進優先級
```

---

## ✅ 成功標準

### 必要條件（全部滿足才算成功）

#### Gemini API ⭐
- [x] 所有頁面的 puter.ai.chat 呼叫正常
- [x] 錯誤處理機制完善
- [x] Timeout 機制正常運作
- [x] 回應格式正確且可解析

#### FlexSearch POC
- [ ] 中文部分詞搜尋有效
- [ ] 平均速度提升 > 2x
- [ ] 無明顯功能缺陷
- [ ] 搜尋結果準確度 >= 80%

### 建議條件（滿足越多越好）
- [ ] 程式碼品質評分 >= 8/10
- [ ] 無 High Priority 錯誤
- [ ] Medium Priority 錯誤 < 3 個
- [ ] 有明確的改進路線圖

---

## 📝 測試報告格式

### 各 Agent 輸出格式

#### Agent 1: Gemini API 測試報告
```markdown
## Gemini API 功能測試報告

### 測試摘要
- 測試頁面數: X/7
- 成功率: XX%
- 平均回應時間: XX 秒

### 詳細結果
| 頁面 | 狀態 | 回應時間 | 錯誤訊息 |
|------|------|---------|---------|
| ... | ... | ... | ... |

### 問題清單
1. [High] 問題描述
2. [Medium] 問題描述

### 建議
- ...
```

#### Agent 2: FlexSearch POC 測試報告
```markdown
## FlexSearch POC 測試報告

### 測試摘要
- 中文部分詞: ✅/❌
- 速度提升: XX 倍
- 準確度: XX%

### Benchmark 結果
| 查詢 | FlexSearch | Fuse.js | 提升 |
|------|-----------|---------|------|
| ... | ... | ... | ... |

### 決策建議
- ✅ 建議遷移 / ❌ 不建議遷移
```

---

## 🎯 預期時間

| 階段 | 時間 | 說明 |
|------|------|------|
| Phase 1: 啟動 | 1 分鐘 | 並行啟動 4 個 Agents |
| Phase 2: 執行 | 5-10 分鐘 | Agents 並行測試 |
| Phase 3: 整合 | 2-3 分鐘 | 整合結果 |
| Phase 4: 決策 | 1-2 分鐘 | 評估與決策 |
| **總計** | **9-16 分鐘** | 全自動化執行 |

---

## 🚨 風險與應對

### 風險 1: Gemini API 完全失效
**應對**:
- 檢查 Puter.js SDK 版本
- 檢查網路連線
- 查看 Puter.js 官方文件是否有 breaking changes

### 風險 2: FlexSearch POC 測試失敗
**應對**:
- 繼續使用 Fuse.js
- 評估其他搜尋方案

### 風險 3: 測試時間超出預期
**應對**:
- 優先完成 Gemini API 測試（最重要）
- 其他測試可以延後或簡化

---

**建立者**: Claude Code
**版本**: 1.0
**狀態**: 準備執行
