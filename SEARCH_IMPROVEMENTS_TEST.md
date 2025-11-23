# 搜尋功能階段 1 改進 - 測試指南

## 已完成的改進

### ✅ Task 1: 修復 XSS 安全問題 (Critical)
**檔案**: `index.html` (Line 295-551)

**變更摘要**:
- 將所有 `innerHTML` 改為安全的 DOM API (`textContent`, `createElement`, `appendChild`)
- 保留 `highlight()` 函數的高亮功能（已正確使用 `escapeHTML`）
- 確保標籤也使用安全方式建立

**關鍵修改位置**:
- Line 379-383: 錯誤訊息顯示（原 Line 344）
- Line 412: 清空結果容器
- Line 443: 清除按鈕處理
- Line 468: 清除按鈕處理
- Line 475-534: 完全重寫 `displayResults()` 函數

---

### ✅ Task 2: 加入防抖機制 (High Priority)
**檔案**: `index.html` (Line 302, 404-423)

**變更摘要**:
- 新增 `debounceTimer` 變數追蹤計時器
- 修改 input 事件監聽器，使用 `setTimeout` 和 `clearTimeout`
- 防抖延遲設為 300ms

**關鍵修改位置**:
- Line 302: 宣告 `let debounceTimer;`
- Line 408: `clearTimeout(debounceTimer);`
- Line 409-422: 包裹在 `setTimeout(..., 300)` 中

**效能提升**:
- 避免每次按鍵都觸發搜尋
- 減少不必要的計算和 DOM 操作
- 提升結果數量從 10 筆到 20 筆（Line 416）

---

### ✅ Task 3: 鍵盤導航 (High Priority)
**檔案**: `index.html` (Line 303-304, 425-462)

**變更摘要**:
- 新增 `selectedIndex` 和 `resultElements` 變數追蹤選擇狀態
- 監聽 `keydown` 事件，處理 ↑↓方向鍵、Enter、Escape
- 實作 `updateSelection()` 函數，高亮選中的結果
- 使用 `scrollIntoView` 確保選中項目可見

**支援的按鍵**:
- `ArrowDown`: 向下選擇下一個結果
- `ArrowUp`: 向上選擇上一個結果
- `Enter`: 開啟選中的連結
- `Escape`: 清除搜尋並重置狀態

**關鍵修改位置**:
- Line 303-304: 變數宣告
- Line 425-448: 鍵盤事件監聽器
- Line 450-462: `updateSelection()` 函數
- Line 533: 結果改變時重置選擇

---

### ✅ Task 4: 無障礙標籤 (Medium Priority)
**檔案**: `index.html` (Line 181, 187, 479, 497-498, 454-459)

**變更摘要**:
- 在搜尋輸入框加入 ARIA 屬性（role, aria-autocomplete, aria-controls, aria-expanded, aria-label）
- 在結果容器加入 ARIA 屬性（role="listbox", aria-label）
- 動態更新 `aria-expanded` 狀態
- 每個結果連結加入 `role="option"` 和 `aria-selected`

**HTML 修改**:
- Line 181: 搜尋輸入框 ARIA 屬性
  ```html
  role="combobox"
  aria-autocomplete="list"
  aria-controls="search-results-container"
  aria-expanded="false"
  aria-label="全站搜尋輸入框"
  ```
- Line 187: 結果容器 ARIA 屬性
  ```html
  role="listbox"
  aria-label="搜尋結果列表"
  ```

**JavaScript 動態更新**:
- Line 479: 根據結果數量更新 `aria-expanded`
- Line 497-498: 結果連結加入 `role="option"` 和 `aria-selected="false"`
- Line 454-459: `updateSelection()` 中更新 `aria-selected` 狀態

---

### ✅ Task 5: localStorage 快取 (Medium Priority)
**檔案**: `index.html` (Line 306-346, 348-385, 387-402)

**變更摘要**:
- 定義快取 key、版本、過期時間常數
- 先嘗試從 localStorage 載入
- 檢查快取是否過期（24 小時）
- 如果快取無效，從網路載入並儲存
- 抽取初始化邏輯為獨立的 `initializeFuse()` 函數

**關鍵修改位置**:
- Line 306-309: 快取常數定義
  - `CACHE_KEY = 'search-index-cache'`
  - `CACHE_VERSION = '1.0'`
  - `CACHE_DURATION = 24 * 60 * 60 * 1000` (24小時)
- Line 323-346: 嘗試從快取載入
- Line 348-385: `loadSearchIndex()` 函數（從網路載入）
- Line 360-369: 儲存到 localStorage
- Line 387-402: `initializeFuse()` 函數（初始化搜尋引擎）

**效能提升**:
- 首次載入後，後續訪問從快取讀取
- 減少網路請求，加快頁面載入速度
- 快取有效期 24 小時，避免資料過時

---

## 其他改進

### ✅ 移除重複程式碼
**變更**: 刪除檔案結尾的重複搜尋初始化邏輯（原 Line 558-566）

**原因**:
- 該程式碼與主要的搜尋邏輯重複
- 可能導致競態條件和不可預測的行為
- 已在主要邏輯中統一處理輸入框啟用

---

## 測試清單

### 1️⃣ Task 1: XSS 安全測試

#### 基本功能測試
- [ ] 開啟 `index.html` 在瀏覽器中
- [ ] 在搜尋框輸入正常關鍵字（例如：「國文」）
- [ ] 確認搜尋結果正常顯示
- [ ] 確認高亮功能正常（關鍵字有黃色背景）

#### XSS 攻擊測試
- [ ] 輸入惡意腳本：`<script>alert('XSS')</script>`
- [ ] 確認**沒有**彈出警告框
- [ ] 確認惡意腳本被當作純文字顯示或顯示「找不到結果」
- [ ] 輸入 HTML 標籤：`<img src=x onerror=alert(1)>`
- [ ] 確認**沒有**執行任何腳本
- [ ] 輸入特殊字元：`<>&"'`
- [ ] 確認正確顯示且沒有破壞頁面結構

#### 開發者工具檢查
- [ ] 打開瀏覽器開發者工具（F12）
- [ ] 檢查 Console 是否有錯誤訊息
- [ ] 檢查 Elements 面板，確認搜尋結果的 HTML 結構正確
- [ ] 確認沒有未經過濾的使用者輸入直接插入 DOM

---

### 2️⃣ Task 2: 防抖機制測試

#### 基本防抖測試
- [ ] 快速連續輸入多個字元（例如：快速打「國文教學」）
- [ ] 觀察搜尋結果**不會**在每次按鍵後立即更新
- [ ] 停止輸入後約 300ms，搜尋結果才更新
- [ ] 打開開發者工具 Console
- [ ] 觀察 Fuse.js 搜尋**不會**在每次按鍵時觸發

#### 性能測試
- [ ] 快速輸入 10 個字元，然後停止
- [ ] 確認只觸發 1 次搜尋（Console 應只出現 1 次搜尋日誌）
- [ ] 輸入文字，等待 150ms 後刪除最後一個字元
- [ ] 確認前一次搜尋被取消，只執行最後一次搜尋

#### 邊界測試
- [ ] 輸入單一字元，立即刪除
- [ ] 確認搜尋結果清空，沒有執行不必要的搜尋
- [ ] 輸入多個空格
- [ ] 確認不觸發搜尋（因為 `trim()` 後長度為 0）

---

### 3️⃣ Task 3: 鍵盤導航測試

#### 基本導航測試
- [ ] 在搜尋框輸入關鍵字（例如：「教學」）
- [ ] 等待搜尋結果顯示
- [ ] 按 `↓` 方向鍵
- [ ] 確認第一個結果有藍色背景和藍色邊框（`bg-blue-100 ring-2 ring-blue-500`）
- [ ] 繼續按 `↓` 方向鍵
- [ ] 確認選擇向下移動，且只有一個結果被高亮
- [ ] 按 `↑` 方向鍵
- [ ] 確認選擇向上移動
- [ ] 選中某個結果後按 `Enter`
- [ ] 確認瀏覽器導航到該結果的 URL

#### 滾動測試
- [ ] 輸入關鍵字產生超過 10 個結果（例如：「國」）
- [ ] 按 `↓` 方向鍵多次，直到選中超出視窗範圍的結果
- [ ] 確認頁面自動滾動，選中的結果保持可見

#### Escape 鍵測試
- [ ] 輸入關鍵字並顯示結果
- [ ] 按 `Escape` 鍵
- [ ] 確認：
  - [ ] 搜尋框內容被清空
  - [ ] 搜尋結果被清除
  - [ ] 清除按鈕隱藏
  - [ ] 選擇狀態重置（`selectedIndex = -1`）

#### 邊界測試
- [ ] 在第一個結果上按 `↑`，確認選擇變為 -1（沒有選中任何結果）
- [ ] 在最後一個結果上按 `↓`，確認選擇不會超出範圍
- [ ] 沒有搜尋結果時按 `Enter`，確認沒有錯誤

---

### 4️⃣ Task 4: 無障礙測試

#### ARIA 屬性檢查
- [ ] 打開開發者工具 → Elements 面板
- [ ] 檢查搜尋輸入框（`<input id="search-input">`）
- [ ] 確認包含以下屬性：
  - [ ] `role="combobox"`
  - [ ] `aria-autocomplete="list"`
  - [ ] `aria-controls="search-results-container"`
  - [ ] `aria-expanded="false"` （無結果時）
  - [ ] `aria-label="全站搜尋輸入框"`
- [ ] 檢查結果容器（`<div id="search-results-container">`）
- [ ] 確認包含：
  - [ ] `role="listbox"`
  - [ ] `aria-label="搜尋結果列表"`

#### 動態 ARIA 更新測試
- [ ] 輸入關鍵字，等待結果顯示
- [ ] 檢查搜尋輸入框的 `aria-expanded` 屬性
- [ ] 確認變為 `"true"`
- [ ] 清除搜尋
- [ ] 確認 `aria-expanded` 變回 `"false"`
- [ ] 檢查每個結果連結（`<a>` 元素）
- [ ] 確認包含：
  - [ ] `role="option"`
  - [ ] `aria-selected="false"` （未選中時）
- [ ] 使用 `↓` 鍵選中某個結果
- [ ] 確認該結果的 `aria-selected` 變為 `"true"`
- [ ] 其他結果保持 `"false"`

#### 螢幕閱讀器測試（選用）
如果您有 NVDA 或 JAWS 等螢幕閱讀器：
- [ ] 啟用螢幕閱讀器
- [ ] 導航到搜尋框
- [ ] 確認讀出「全站搜尋輸入框」
- [ ] 輸入關鍵字
- [ ] 確認讀出結果數量和「搜尋結果列表」
- [ ] 使用方向鍵導航結果
- [ ] 確認讀出每個結果的標題和內容

---

### 5️⃣ Task 5: localStorage 快取測試

#### 首次載入測試
- [ ] 打開開發者工具 → Application → Local Storage
- [ ] 刪除 `search-index-cache` 項目（如果存在）
- [ ] 重新整理頁面
- [ ] 打開 Console，確認看到：
  ```
  🔍 搜尋索引已快取到 localStorage
  🔍 搜尋引擎已準備就緒！共 X 筆資料
  ```
- [ ] 檢查 Local Storage，確認存在 `search-index-cache` 項目
- [ ] 展開該項目，確認包含：
  - [ ] `version: "1.0"`
  - [ ] `data: [...]` （陣列）
  - [ ] `timestamp: <數字>`

#### 快取載入測試
- [ ] 確保 `search-index-cache` 存在於 Local Storage
- [ ] 重新整理頁面
- [ ] 打開 Console，確認看到：
  ```
  🔍 搜尋引擎已從快取載入！
  🔍 搜尋引擎已準備就緒！共 X 筆資料
  ```
- [ ] 確認**沒有**網路請求到 `search-index.json`（Network 面板）
- [ ] 測試搜尋功能，確認正常運作

#### 快取過期測試
- [ ] 打開 Local Storage
- [ ] 手動修改 `timestamp` 為 25 小時前（`Date.now() - 25 * 60 * 60 * 1000`）
- [ ] 重新整理頁面
- [ ] 確認 Console 顯示：
  ```
  🔍 快取已過期或版本不符，重新載入...
  🔍 搜尋索引已快取到 localStorage
  🔍 搜尋引擎已準備就緒！共 X 筆資料
  ```
- [ ] 確認有網路請求到 `search-index.json`

#### 版本更新測試
- [ ] 手動修改 Local Storage 中的 `version` 為 `"0.9"`
- [ ] 重新整理頁面
- [ ] 確認重新載入索引（Console 顯示「快取已過期或版本不符」）

#### 快取損壞測試
- [ ] 手動修改 Local Storage 中的 `data` 為無效 JSON（例如：`"invalid"`）
- [ ] 重新整理頁面
- [ ] 確認 Console 顯示警告：`快取載入失敗: ...`
- [ ] 確認回退到網路載入

---

## 整合測試

### 完整使用流程
- [ ] 首次訪問網站
- [ ] 等待搜尋索引載入（應顯示「搜尋引擎已準備就緒」）
- [ ] 快速輸入「國文教學」
- [ ] 確認：
  - [ ] 防抖機制運作（輸入完成 300ms 後才顯示結果）
  - [ ] 結果安全顯示（無 XSS）
  - [ ] ARIA 屬性正確更新
- [ ] 使用 `↓` 鍵選擇第二個結果
- [ ] 確認選中結果有藍色高亮
- [ ] 按 `Enter` 開啟連結
- [ ] 確認導航到正確頁面

### 性能測試
- [ ] 清除快取並重新載入頁面，記錄載入時間
- [ ] 重新整理頁面（使用快取），記錄載入時間
- [ ] 確認使用快取時明顯更快

### 跨瀏覽器測試（建議）
- [ ] Chrome/Edge：所有功能正常
- [ ] Firefox：所有功能正常
- [ ] Safari：所有功能正常（如果可用）

---

## 已知問題與限制

### localStorage 限制
- **配額限制**: localStorage 通常限制 5-10MB，如果搜尋索引過大可能失敗
- **無痕模式**: 某些瀏覽器的無痕模式可能禁用 localStorage
- **跨域限制**: localhost 和 GitHub Pages 的快取是獨立的

### 鍵盤導航限制
- **焦點管理**: 當前實作只高亮結果，未實際移動焦點（螢幕閱讀器可能需要改進）
- **滾動行為**: `scrollIntoView` 在某些瀏覽器可能不支援 `smooth` 選項

---

## 修改檔案清單

1. **`index.html`**
   - Line 181: 搜尋輸入框 ARIA 屬性
   - Line 187: 結果容器 ARIA 屬性
   - Line 295-551: 搜尋功能完整重寫
   - 刪除 Line 558-566: 移除重複程式碼

---

## 技術債務與未來改進

### 階段 2 建議改進（未包含在本次實作）
1. **模糊搜尋容錯**: 處理拼音、簡繁體轉換
2. **搜尋歷史**: 記錄最近搜尋，提供快速存取
3. **搜尋建議**: 在輸入時顯示自動完成建議
4. **結果分類**: 依檔案類型、標籤分組顯示
5. **高級篩選**: 依日期、作者、標籤篩選
6. **效能優化**: 虛擬滾動處理大量結果
7. **焦點管理**: 改進螢幕閱讀器的焦點追蹤

### 程式碼品質改進
- [ ] 考慮將搜尋邏輯抽取為獨立模組
- [ ] 加入 TypeScript 類型定義（如果專案支援）
- [ ] 加入單元測試（使用 Jest 或 Vitest）
- [ ] 加入 E2E 測試（使用 Playwright 或 Cypress）

---

## 結論

所有 5 個任務已成功完成並通過基本驗證。建議按照上述測試清單進行完整測試，確保在不同瀏覽器和場景下都能正常運作。

**測試優先順序**:
1. ✅ Task 1 (Critical): XSS 安全測試
2. ✅ Task 3 (High): 鍵盤導航測試
3. ✅ Task 2 (High): 防抖機制測試
4. ✅ Task 4 (Medium): 無障礙測試
5. ✅ Task 5 (Medium): localStorage 快取測試
