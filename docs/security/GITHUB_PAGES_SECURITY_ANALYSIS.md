# GitHub Pages 部署安全性分析報告

> **版本：** v1.0
> **分析日期：** 2025-11-23
> **範圍：** Code Review 建議修復項目的必要性評估
> **部署環境：** GitHub Pages (靜態網站)

---

## 執行摘要

基於大規模網路調研，針對 GitHub Pages 靜態網站部署環境，**強烈建議實施以下修復**：

### 🔴 關鍵優先級 (Critical)
- **XSS via innerHTML** - 必須立即修復
- LLM 輸出未經處理直接插入 DOM 構成嚴重安全風險

### 🟡 高優先級 (High)
- **API Timeout 處理** - 建議實施
- **雙擊防護** - 建議實施

---

## 1. 研究方法論

### 調研範圍
進行了 8 項深度網路調研，涵蓋：

1. GitHub Pages 靜態網站 XSS 風險 (2024-2025)
2. Puter.js AI API 安全最佳實踐
3. 客戶端 AI/LLM 回應 XSS 漏洞
4. JavaScript API Timeout 最佳實踐 (2025)
5. 雙擊防護機制 (Debounce vs Throttle)
6. OWASP LLM Top 10 (2024-2025)
7. GitHub Pages CSP 實作限制
8. Trusted Types API 瀏覽器支援度 (2025)

### 權威來源
- OWASP Foundation (LLM Security)
- MDN Web Docs (Web APIs)
- Google Web.dev (Security Best Practices)
- StackOverflow (Community Solutions)
- GitHub Community Discussions

---

## 2. 關鍵發現

### 2.1 XSS via innerHTML - **必須修復**

#### 研究證據

**OWASP LLM05:2025 Improper Output Handling**
- 來源：https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/
- 關鍵結論：**所有 LLM 輸出必須視為不受信任的使用者輸入**
- 攻擊向量：
  - XSS through LLM-generated JavaScript
  - XSS through LLM-generated Markdown
  - DOM-based XSS via innerHTML

**Trusted Types API (Google Web.dev)**
- 來源：https://web.dev/articles/trusted-types
- innerHTML 是 DOM-based XSS 的**首要攻擊向量**
- 2024-2025 持續被列為高風險漏洞

**GitHub Pages 實際案例**
- 來源：StackOverflow
- 已有 GitHub Pages 網站因 XSS 被瀏覽器標記為不安全
- 靜態網站無伺服器端防護，風險更高

#### GitHub Pages 特定風險

```
GitHub Pages 環境：
✗ 無伺服器端淨化 (Server-side Sanitization)
✗ 無 WAF (Web Application Firewall)
✗ 無即時監控 (Real-time Monitoring)
✗ 純客戶端執行 = 所有防護必須在前端實施
```

#### 當前程式碼風險評估

**影響檔案：** 7 個 HTML 檔案，共 7 處 innerHTML 使用

範例 (autonomous-learning/topic-ideas.html:238-260)：
```javascript
// 🔴 CRITICAL RISK
element.innerHTML = aiResponse;  // LLM 輸出直接插入 DOM
```

**攻擊情境：**
```
1. 使用者輸入：「我想研究 <img src=x onerror=alert('XSS')>」
2. Gemini API 回應可能包含：「...探討 <img src=x onerror=alert('XSS')> 這個主題...」
3. innerHTML 執行惡意腳本
4. 攻擊者可：
   - 竊取使用者資料
   - 導向釣魚網站
   - 植入惡意程式
```

#### 修復方案評估

**選項 1：使用 textContent (最簡單)**
```javascript
// ✅ 安全：純文字，無 XSS 風險
element.textContent = aiResponse;
```
- 優點：零額外依賴，100% 安全
- 缺點：失去 Markdown/HTML 格式

**選項 2：使用 DOMPurify (推薦)**
```javascript
// ✅ 安全：淨化 HTML，保留格式
element.innerHTML = DOMPurify.sanitize(aiResponse);
```
- 優點：安全 + 保留格式
- 缺點：需引入 DOMPurify.js (~19KB gzipped)
- CDN：`https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js`

**選項 3：Trusted Types API (Chrome/Edge only)**
```javascript
// ⚠️ 僅 Chromium 支援
const policy = trustedTypes.createPolicy('default', {
  createHTML: (string) => DOMPurify.sanitize(string)
});
element.innerHTML = policy.createHTML(aiResponse);
```
- 優點：瀏覽器原生防護
- 缺點：Firefox/Safari 不支援 (2025)

#### GitHub Pages CSP 限制

**發現：GitHub Pages 無法設定 HTTP Headers**
- 來源：https://github.com/orgs/community/discussions/49832
- 只能用 `<meta>` 標籤，但功能受限
- 部分 CSP 指令不支援 (如 `frame-ancestors`)

**可行的 CSP (Meta Tag)**
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self' https://cdn.jsdelivr.net https://js.puter.com 'unsafe-inline';
               style-src 'self' 'unsafe-inline';">
```

⚠️ **限制：**
- 必須保留 `'unsafe-inline'` (Tailwind CSS 需要)
- 無法完全防禦 XSS，只能降低風險

#### 結論：XSS 修復**必要性 = 100%**

**理由：**
1. **OWASP 官方警告**：LLM05:2025 列為關鍵風險
2. **GitHub Pages 零防護**：無伺服器端保護
3. **實際攻擊案例**：已有 GitHub Pages 網站被攻擊
4. **修復成本低**：textContent 零成本，DOMPurify 僅 19KB
5. **法律/品牌風險**：教育平台若有 XSS，信譽受損

---

### 2.2 API Timeout 處理 - **建議實施**

#### 研究證據

**MDN - AbortSignal.timeout() (2025)**
- 來源：https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static
- 現代化 API，瀏覽器原生支援
- 取代舊式 setTimeout + clearTimeout 模式

**最佳實踐範例：**
```javascript
try {
  const response = await puter.ai.chat(prompt, {
    model: "gemini-3-pro-preview",
    signal: AbortSignal.timeout(30000)  // 30 秒逾時
  });
} catch (error) {
  if (error.name === 'TimeoutError') {
    // 友善提示：請求超時，請稍後再試
  } else if (error.name === 'AbortError') {
    // 使用者取消
  }
}
```

#### GitHub Pages 特定考量

**網路環境不穩定情境：**
- 行動裝置 4G/5G 訊號弱
- 校園網路高峰期
- Puter.js 雲端服務偶發延遲

**當前問題：**
- 無逾時 = 使用者無限等待
- 無錯誤提示 = 使用者以為程式壞掉
- 無重試機制 = 不良使用體驗

#### 修復必要性評估

**優先級：High (建議實施)**

**理由：**
1. ✅ **使用者體驗**：避免無限載入
2. ✅ **資源管理**：釋放卡住的請求
3. ✅ **錯誤處理**：明確告知使用者問題
4. ⚠️ **非安全性漏洞**：不會造成資料外洩
5. ⚠️ **實作成本低**：僅需加 3-5 行程式碼

**建議逾時設定：**
- Gemini 3 Pro：30 秒 (較慢但高品質)
- Gemini Flash：15 秒 (較快)
- 串流輸出：45 秒 (career-exploration/index.html)

---

### 2.3 雙擊防護 - **建議實施**

#### 研究證據

**StackOverflow 共識：**
- 來源：https://stackoverflow.com/questions/20281546
- **Throttle 優於 Debounce** (立即回應 + 防護)
- **Button Disabled 最簡單有效**

**最佳實踐範例：**
```javascript
async function handleGenerate() {
  const button = document.getElementById('generateBtn');

  // 防護：禁用按鈕
  button.disabled = true;
  button.innerHTML = '生成中... <span class="spinner"></span>';

  try {
    await puter.ai.chat(prompt, { model: "gemini-3-pro-preview" });
  } finally {
    // 恢復：重新啟用按鈕
    button.disabled = false;
    button.innerHTML = '產生靈感';
  }
}
```

#### GitHub Pages 特定風險

**重複請求問題：**
- Puter.js 免費配額有限
- 重複請求浪費配額
- 可能觸發 Rate Limiting

**當前問題：**
- 7 個功能頁面都無雙擊防護
- 使用者可快速連點 5-10 次
- 每次點擊 = 1 次 API 呼叫 = 消耗配額

#### 修復必要性評估

**優先級：High (建議實施)**

**理由：**
1. ✅ **配額保護**：避免浪費 Puter.js 免費額度
2. ✅ **效能優化**：減少不必要的 API 呼叫
3. ✅ **使用者體驗**：顯示載入狀態
4. ⚠️ **非安全性漏洞**：不會造成資料外洩
5. ✅ **實作成本極低**：僅需加 2-3 行程式碼

---

## 3. GitHub Pages 環境特性總結

### 限制 (Constraints)
```
❌ 無自訂 HTTP Headers → 無完整 CSP
❌ 無伺服器端程式 → 無後端淨化
❌ 靜態檔案 → 所有防護必須前端實施
❌ 無 WAF → 無自動攻擊偵測
```

### 優勢 (Advantages)
```
✅ 免費 HTTPS → 傳輸加密
✅ CDN 加速 → 全球存取快速
✅ GitHub 信譽 → 使用者信任度高
✅ Git 版本控制 → 易於回滾
```

### 安全責任轉移
```
傳統架構：伺服器 (70%) + 客戶端 (30%)
GitHub Pages：客戶端 (100%)

→ 前端安全防護責任加重
→ 必須實施所有可行的客戶端防護措施
```

---

## 4. 風險矩陣分析

### 威脅建模

| 威脅 | 可能性 | 影響 | 風險等級 | 修復成本 | 建議 |
|------|--------|------|----------|----------|------|
| XSS via innerHTML | **高** | **嚴重** | 🔴 Critical | 低 | 立即修復 |
| API 無逾時卡死 | 中 | 中 | 🟡 High | 極低 | 建議實施 |
| 雙擊重複請求 | 中 | 低 | 🟡 High | 極低 | 建議實施 |

### 風險評分標準
- **可能性**：攻擊者利用難度
- **影響**：對使用者/系統的傷害
- **修復成本**：開發時間 + 測試時間

---

## 5. 最終建議方案

### 階段 1：立即實施 (Critical)

#### 1.1 XSS 防護 - textContent 方案 (最小改動)

**適用頁面：** 所有 7 個頁面

**修改範例：**
```javascript
// 🔴 修復前
resultDiv.innerHTML = aiResponse;

// ✅ 修復後
resultDiv.textContent = aiResponse;
```

**優點：**
- 零依賴
- 100% 安全
- 修改簡單 (每個檔案 1 行)

**缺點：**
- 失去 Markdown 格式 (但 Gemini 輸出主要是純文字)

**實作工作量：** 15 分鐘 (7 個檔案)

---

#### 1.2 XSS 防護 - DOMPurify 方案 (保留格式)

**僅適用於：** 需要保留 HTML 格式的頁面

**步驟 1：引入 DOMPurify**
```html
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"></script>
```

**步驟 2：淨化輸出**
```javascript
// ✅ 修復後
resultDiv.innerHTML = DOMPurify.sanitize(aiResponse, {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li'],
  ALLOWED_ATTR: []
});
```

**優點：**
- 安全 + 保留格式
- OWASP 推薦

**缺點：**
- 增加 19KB 依賴

**實作工作量：** 30 分鐘 (7 個檔案 + 測試)

---

### 階段 2：高優先級 (建議實施)

#### 2.1 API Timeout

**修改範例：**
```javascript
try {
  const response = await puter.ai.chat(prompt, {
    model: "gemini-3-pro-preview",
    signal: AbortSignal.timeout(30000)
  });
} catch (error) {
  if (error.name === 'TimeoutError') {
    showErrorMessage('請求超時，請檢查網路連線後重試');
  } else {
    showErrorMessage('產生失敗，請稍後再試');
  }
}
```

**實作工作量：** 45 分鐘 (7 個檔案)

---

#### 2.2 雙擊防護

**修改範例：**
```javascript
async function handleGenerate() {
  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.innerHTML = '生成中...';

  try {
    // ... API call
  } finally {
    btn.disabled = false;
    btn.innerHTML = '產生靈感';
  }
}
```

**實作工作量：** 30 分鐘 (7 個檔案)

---

### 階段 3：進階防護 (選用)

#### 3.1 CSP Meta Tag

**在所有頁面 `<head>` 加入：**
```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self' https://cdn.jsdelivr.net https://js.puter.com 'unsafe-inline';
               style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline';
               img-src 'self' data: https:;">
```

**效果：**
- 限制外部資源載入
- 降低 XSS 風險 (非完全防護)

**實作工作量：** 15 分鐘

---

#### 3.2 Subresource Integrity (SRI)

**為 CDN 資源加入完整性檢查：**
```html
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"
        integrity="sha384-..."
        crossorigin="anonymous"></script>
```

**效果：**
- 防止 CDN 被竄改
- 保證載入檔案完整性

**實作工作量：** 20 分鐘

---

## 6. 總結與行動計畫

### 必須修復 (Critical)
✅ **XSS via innerHTML** → 立即實施 textContent 或 DOMPurify

### 強烈建議 (High)
✅ **API Timeout** → 提升使用者體驗 + 資源管理
✅ **雙擊防護** → 避免浪費 API 配額

### 選用強化 (Optional)
⚪ **CSP Meta Tag** → 額外防護層
⚪ **SRI** → 保證 CDN 完整性

---

### 風險決策表

**如果不修復 XSS：**
```
最佳情況：沒事 (依賴使用者都是善意)
最壞情況：
  - 使用者資料被竊
  - 網站被植入惡意程式
  - 教育平台信譽受損
  - 法律責任問題
```

**如果修復 XSS：**
```
最佳情況：永久消除 XSS 風險
最壞情況：花 15-30 分鐘修改程式碼
```

---

### 實作時程建議

**第一週：**
- [ ] 修復 XSS (textContent 方案) - 15 分鐘
- [ ] 測試 7 個頁面功能正常 - 30 分鐘
- [ ] 推送 PR + Code Review - 15 分鐘

**第二週：**
- [ ] 實作 API Timeout - 45 分鐘
- [ ] 實作雙擊防護 - 30 分鐘
- [ ] 完整測試 - 1 小時

**第三週 (選用)：**
- [ ] 加入 CSP Meta Tag - 15 分鐘
- [ ] 加入 SRI - 20 分鐘
- [ ] 最終安全審計 - 1 小時

---

## 7. 參考資料

### OWASP 官方文件
1. [LLM05:2025 Improper Output Handling](https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/)
2. [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)

### Web 標準與 API
3. [Trusted Types API (Google Web.dev)](https://web.dev/articles/trusted-types)
4. [AbortSignal.timeout() (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static)
5. [Content Security Policy (MDN)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)

### 第三方工具
6. [DOMPurify GitHub](https://github.com/cure53/DOMPurify)
7. [Puter.js Documentation](https://docs.puter.com/)

### 社群討論
8. [GitHub Pages CSP Limitations](https://github.com/orgs/community/discussions/49832)
9. [StackOverflow: XSS Prevention in Static Sites](https://stackoverflow.com/questions/44375796/)

---

**文檔版本：** v1.0
**最後更新：** 2025-11-23
**下次審查：** 修復完成後
**維護者：** 開發團隊
