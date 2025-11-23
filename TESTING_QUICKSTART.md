# 🚀 自動化測試快速開始指南

**目的**: 使用 Playwright 自動化測試 FlexSearch POC 功能

---

## ⚡ 5 分鐘快速開始

### 步驟 1: 安裝依賴

```bash
# 安裝 Playwright
npm install

# 安裝瀏覽器（僅需執行一次）
npx playwright install
```

### 步驟 2: 執行測試

```bash
# 執行 FlexSearch POC 測試（推薦）
npm run test:flexsearch
```

**就這麼簡單！** ✅

測試會自動：
- 啟動本地伺服器
- 開啟瀏覽器
- 執行所有測試案例
- 生成測試報告

---

## 📊 測試報告位置

測試完成後，報告位於：

```
test-results/
├── html/           # HTML 報告（推薦）
│   └── index.html  # 在瀏覽器開啟此檔案
└── results.json    # JSON 格式報告
```

**查看報告**:
```bash
# 開啟 HTML 報告
start test-results/html/index.html  # Windows
```

---

## 🎯 測試內容

### 測試 1: 頁面組件載入
- ✅ 驗證標題、輸入框、按鈕等組件存在

### 測試 2: 中文部分詞搜尋 ⭐ **最重要**
- ✅ 查詢「科學」應找到「科學展覽」、「科學研究」
- ✅ 驗證 FlexSearch 的核心優勢

### 測試 3: 搜尋效能比較
- ✅ 測試多個查詢的效能
- ✅ 驗證 FlexSearch vs Fuse.js 速度

### 測試 4: 完整 Benchmark 🔥
- ✅ 執行 15 項查詢測試
- ✅ 驗證平均速度提升 > 2x

### 測試 5: 中文分詞視覺化
- ✅ 驗證分詞工具正常運作

### 測試 6: 搜尋準確度
- ✅ 驗證搜尋結果準確度 >= 80%

### 測試 7: 決策評估報告
- ✅ 自動生成決策建議
- ✅ 評估是否應進行 Phase 2

---

## 🔧 進階用法

### 以 UI 模式執行（推薦除錯）

```bash
npm run test:flexsearch:ui
```

**優點**:
- 視覺化介面
- 可以暫停測試
- 逐步執行每個測試
- 查看即時截圖

### 以有頭模式執行（觀看瀏覽器）

```bash
npm run test:flexsearch:headed
```

**優點**:
- 看到瀏覽器實際操作
- 適合理解測試流程
- 適合展示

### 執行單一測試

```bash
# 只執行測試 2（中文部分詞）
npx playwright test -g "測試 2"

# 只執行測試 4（完整 Benchmark）
npx playwright test -g "測試 4"
```

---

## 📋 測試結果解讀

### ✅ 全部通過

```
6 passed (30s)

📊 FlexSearch POC 測試報告
============================================================

⚡ 效能指標：
   平均速度提升: 8.52x
   FlexSearch 平均搜尋時間: 3.21ms
   Fuse.js 平均搜尋時間: 27.35ms

🇨🇳 中文分詞：
   中文部分詞搜尋: ✅ 有效
   測試查詢「科學」找到結果數: 12

✅ 決策標準檢核：
   ✅ 平均速度提升 > 2x
   ✅ 中文部分詞搜尋有效
   ✅ 無明顯功能缺陷
   ✅ 搜尋結果準確度 >= 80%

🎯 最終建議：
   ✅ 建議進行 Phase 2 全面遷移
   理由: 所有決策標準均已達成
```

**結論**: ✅ 可以進行 Phase 2

---

### ⚠️ 部分失敗

```
4 passed, 2 failed (25s)

❌ 測試 4: 完整 Benchmark 測試
   Error: expect(1.8).toBeGreaterThan(2)

🎯 最終建議：
   ⚠️ 建議暫緩 Phase 2
   理由: 以下標準未達成: speedup_gt_2x
```

**結論**: ⚠️ 暫緩 Phase 2，需要優化

---

## 🐛 常見問題

### Q1: 測試失敗：「頁面載入超時」

**解決方案**:
```bash
# 確保沒有其他程式佔用 8000 port
netstat -ano | findstr :8000

# 手動啟動伺服器測試
python -m http.server 8000
# 然後在瀏覽器開啟 http://localhost:8000/poc-flexsearch.html
```

### Q2: 測試失敗：「索引建立超時」

**原因**: 電腦效能較慢，索引建立需要更長時間

**解決方案**:
在 `playwright.config.js` 中增加 timeout:
```javascript
use: {
    actionTimeout: 20000,  // 從 10000 增加到 20000
    navigationTimeout: 60000,  // 從 30000 增加到 60000
}
```

### Q3: 想要看到瀏覽器實際操作

**解決方案**:
```bash
npm run test:flexsearch:headed
```

### Q4: 測試通過但想要看詳細報告

**解決方案**:
```bash
# 開啟 HTML 報告
start test-results/html/index.html
```

---

## 📊 預期測試時間

| 測試 | 預期時間 |
|------|----------|
| 測試 1-3 | 5 秒 |
| 測試 4 (Benchmark) | 15-20 秒 |
| 測試 5-6 | 3 秒 |
| 測試 7 (決策報告) | 20 秒 |
| **總計** | **~30 秒** |

---

## 🎯 成功標準

測試通過後，檢查以下標準：

- [ ] **平均速度提升 > 2x** (實際: ___ x)
- [ ] **中文部分詞搜尋有效** (「科學」找到「科學展覽」)
- [ ] **無明顯功能缺陷** (所有測試通過)
- [ ] **搜尋結果準確度 >= 80%** (實際: ___ %)

**如果全部達成** → ✅ 建議進行 Phase 2 全面遷移

**如果任一未達成** → ⚠️ 建議暫緩，分析原因

---

## 📝 下一步

### 如果測試全部通過 ✅

1. 查看詳細測試報告（`test-results/html/index.html`）
2. 記錄關鍵數據到 `POC_TEST_RESULTS.md`
3. 決定是否進行 Phase 2 遷移

### 如果測試失敗 ❌

1. 查看失敗截圖（`test-results/` 目錄）
2. 以 UI 模式重新執行（`npm run test:flexsearch:ui`）
3. 分析失敗原因
4. 修復問題後重新測試

---

## 🔗 相關文件

- [Playwright 官方文件](https://playwright.dev/)
- [POC_TESTING_STEPS.md](docs/search/poc/POC_TESTING_STEPS.md) - 手動測試指南
- [POC_TEST_RESULTS.md](docs/search/poc/POC_TEST_RESULTS.md) - 測試結果記錄表
- [TEST_RESULTS_SUMMARY.md](TEST_RESULTS_SUMMARY.md) - 綜合測試報告

---

**建立日期**: 2025-11-23
**版本**: 1.0
**維護者**: Claude Code

---

## 💡 提示

- **首次執行**: 建議使用 `npm run test:flexsearch:headed` 觀看測試過程
- **CI/CD**: 使用 `npm run test:flexsearch` 進行自動化測試
- **除錯**: 使用 `npm run test:flexsearch:ui` 進行逐步除錯
