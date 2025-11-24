# Puter.js Gemini API 修復計畫

> **建立日期：** 2025-11-23
> **專案：** 台灣教育處方籤 (sch001-108platform)
> **目標：** 修復 Puter.js Gemini API 失效問題，升級至 Gemini 3 Pro

---

## 📋 執行摘要

本專案是一個教育資源平台，使用 Puter.js 整合 Google Gemini AI 來提供多項 AI 輔助功能。經過全面掃描，發現 **7個 HTML 檔案**使用了錯誤的模型名稱，導致 Gemini API 無法正常運作。

**核心問題：**
- ❌ 使用了不正確的模型前綴 `google/`
- ❌ 使用了已棄用的模型名稱（如 `google/gemini-pro`）
- ❌ 未升級至最新的 Gemini 3 Pro 模型

**預期效果：**
- ✅ 所有 AI 功能恢復正常運作
- ✅ 使用最新的 Gemini 3 Pro 模型獲得更好的回應品質
- ✅ 統一所有檔案的模型配置，便於未來維護

---

## 🔍 問題分析

### 1. 受影響的檔案清單

| # | 檔案路徑 | 行號 | 當前模型 | 功能描述 |
|---|----------|------|----------|----------|
| 1 | `autonomous-learning/topic-ideas.html` | 171 | `google/gemini-2.5-pro` | AI 個人化發想工具 |
| 2 | `autonomous-learning/resource-map.html` | 257 | `google/gemini-2.5-pro` | AI 學習路徑規劃師 |
| 3 | `autonomous-learning/index.html` | 179 | `google/gemini-2.5-pro` | AI 自主學習教練 |
| 4 | `learning-portfolio/index.html` | 190 | `google/gemini-2.5-pro` | AI 學習歷程健檢工具 |
| 5 | `learning-portfolio/reflection-guide.html` | 226 | `google/gemini-2.5-pro` | AI 學習歷程健檢 |
| 6 | `career-exploration/competency-map.html` | 211 | `google/gemini-pro` | AI 素養分析師 |
| 7 | `career-exploration/index.html` | 447 | `google/gemini-2.0-flash-lite-001` | AI 學涯導師（流式輸出） |

### 2. 根本原因分析

根據官方文檔 `gemini-api.md` 的說明：

**正確的 Puter.js 模型呼叫方式：**
```javascript
puter.ai.chat(prompt, {
    model: 'gemini-3-pro-preview'  // ✅ 正確：直接使用模型名稱
});
```

**錯誤的呼叫方式：**
```javascript
puter.ai.chat(prompt, {
    model: 'google/gemini-2.5-pro'  // ❌ 錯誤：使用了 google/ 前綴
});
```

### 3. 可用的 Gemini 模型列表

根據 `gemini-api.md`，Puter.js 支援以下模型：

| 模型名稱 | 適用場景 | 特色 |
|---------|----------|------|
| **`gemini-3-pro-preview`** ⭐ | **複雜推理、代理工作流程** | **最新模型，進階推理能力** |
| `gemini-2.5-pro` | 複雜任務、長文本處理 | 高階模型 |
| `gemini-2.5-flash` | 快速回應 | 平衡速度與品質 |
| `gemini-2.5-flash-lite` | 高速回應 | 輕量級 |
| `gemini-2.0-flash` | 多模態處理 | 支援圖像分析 |
| `gemini-2.0-flash-lite` | 基礎任務 | 最快速 |
| `gemini-1.5-flash` | 舊版快速模型 | 向後相容 |

---

## 🎯 修復策略

### 策略 A：全面升級至 Gemini 3 Pro（推薦）⭐

**優點：**
- ✅ 使用最新最強的模型
- ✅ 提供最佳的回應品質與推理能力
- ✅ 符合用戶明確要求

**缺點：**
- ⚠️ 可能回應時間稍長（但品質更好）
- ⚠️ 若 Gemini 3 Pro 有使用限制，可能需要備案

**適用檔案：** 全部 7 個檔案

**修復方式：** 將所有 `model` 參數統一改為 `'gemini-3-pro-preview'`

### 策略 B：差異化配置（備選方案）

針對不同功能特性選擇最適合的模型：

| 功能類型 | 建議模型 | 理由 |
|---------|----------|------|
| 複雜分析（STAR分析、素養分析） | `gemini-3-pro-preview` | 需要深度推理 |
| 快速發想（主題靈感、資源推薦） | `gemini-2.5-flash` | 平衡速度與品質 |
| 即時對話（流式聊天機器人） | `gemini-2.0-flash` | 快速回應體驗 |

---

## 📝 詳細修復清單

### 檔案 1: `autonomous-learning/topic-ideas.html`

**位置：** 第 171 行

**當前程式碼：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "google/gemini-2.5-pro"
});
```

**修復後程式碼（方案 A）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "gemini-3-pro-preview"
});
```

**修復後程式碼（方案 B）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "gemini-2.5-flash"  // 主題發想不需最強模型，快速回應即可
});
```

---

### 檔案 2: `autonomous-learning/resource-map.html`

**位置：** 第 257 行

**當前程式碼：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "google/gemini-2.5-pro"
});
```

**修復後程式碼（方案 A）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "gemini-3-pro-preview"
});
```

**修復後程式碼（方案 B）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "gemini-2.5-flash"  // 學習路徑規劃
});
```

---

### 檔案 3: `autonomous-learning/index.html`

**位置：** 第 179 行

**當前程式碼：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "google/gemini-2.5-pro"
});
```

**修復後程式碼（方案 A）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "gemini-3-pro-preview"
});
```

**修復後程式碼（方案 B）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "gemini-2.5-flash"  // 學習啟動包生成
});
```

---

### 檔案 4: `learning-portfolio/index.html`

**位置：** 第 190 行

**當前程式碼：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: 'google/gemini-2.5-pro'
});
```

**修復後程式碼（方案 A）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: 'gemini-3-pro-preview'  // STAR 分析需要深度推理
});
```

**修復後程式碼（方案 B）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: 'gemini-3-pro-preview'  // STAR 分析建議用最強模型
});
```

---

### 檔案 5: `learning-portfolio/reflection-guide.html`

**位置：** 第 226 行

**當前程式碼：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "google/gemini-2.5-pro"
});
```

**修復後程式碼（方案 A）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "gemini-3-pro-preview"
});
```

**修復後程式碼（方案 B）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: "gemini-3-pro-preview"  // 反思分析建議用最強模型
});
```

---

### 檔案 6: `career-exploration/competency-map.html`

**位置：** 第 211 行

**當前程式碼：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: 'google/gemini-pro'  // ⚠️ 此模型名稱已不存在
});
```

**修復後程式碼（方案 A）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: 'gemini-3-pro-preview'  // 素養分析需要深度推理
});
```

**修復後程式碼（方案 B）：**
```javascript
const response = await puter.ai.chat(prompt, {
    model: 'gemini-3-pro-preview'  // 素養分析建議用最強模型
});
```

---

### 檔案 7: `career-exploration/index.html`

**位置：** 第 447 行（流式輸出場景）

**當前程式碼：**
```javascript
const responseStream = await puter.ai.chat(prompt, {
    model: 'google/gemini-2.0-flash-lite-001',
    stream: true
});
```

**修復後程式碼（方案 A）：**
```javascript
const responseStream = await puter.ai.chat(prompt, {
    model: 'gemini-3-pro-preview',  // 使用最新模型
    stream: true
});
```

**修復後程式碼（方案 B）：**
```javascript
const responseStream = await puter.ai.chat(prompt, {
    model: 'gemini-2.5-flash',  // 聊天機器人平衡速度與品質
    stream: true
});
```

---

## 🚀 實施步驟

### 階段一：準備與測試（30分鐘）

1. **備份專案**
   ```bash
   # 建立 Git 分支
   git checkout -b fix/gemini-api-upgrade

   # 或建立完整備份
   cp -r . ../sch001-108platform-backup
   ```

2. **建立測試環境**
   - 在本地開啟其中一個 HTML 檔案
   - 測試當前 API 是否真的失效
   - 記錄錯誤訊息

3. **小範圍試驗**
   - 先修改 1 個檔案（建議：`autonomous-learning/topic-ideas.html`）
   - 測試修改後是否正常運作
   - 確認回應品質

### 階段二：全面修復（1小時）

按照上述「詳細修復清單」，依序修改所有 7 個檔案：

1. ✅ `autonomous-learning/topic-ideas.html` → Line 171
2. ✅ `autonomous-learning/resource-map.html` → Line 257
3. ✅ `autonomous-learning/index.html` → Line 179
4. ✅ `learning-portfolio/index.html` → Line 190
5. ✅ `learning-portfolio/reflection-guide.html` → Line 226
6. ✅ `career-exploration/competency-map.html` → Line 211
7. ✅ `career-exploration/index.html` → Line 447

**每次修改後檢查：**
- [ ] 語法正確（引號、逗號、括號）
- [ ] 模型名稱拼寫正確
- [ ] 移除 `google/` 前綴

### 階段三：功能測試（1小時）

逐一測試每個 AI 功能：

| 功能 | 測試輸入範例 | 預期結果 |
|------|------------|----------|
| 主題靈感產生器 | "旅行、心理學、環保" | 產生 3 個主題建議 |
| 學習路徑規劃師 | "我想學 Python 爬蟲" | 產生 4 步驟學習路徑 |
| 自主學習教練 | "我想研究跟「貓咪」有關的主題" | 提供聚焦主題與資源建議 |
| 學習歷程健檢 | 貼上一段學習心得 | 提供 STAR 分析 |
| 素養分析師 | 描述一個活動經驗 | 分析對應素養 |
| AI 學涯導師 | "我喜歡動手做東西，也對電腦有興趣" | 推薦相關學群 |

**測試標準：**
- ✅ API 呼叫成功（無錯誤訊息）
- ✅ 回應時間合理（< 10秒）
- ✅ 回應內容品質良好（符合 prompt 要求）
- ✅ UI 正常顯示（無排版錯誤）

### 階段四：部署與監控（30分鐘）

1. **提交變更**
   ```bash
   git add .
   git commit -m "fix: 修復 Gemini API 模型配置，升級至 Gemini 3 Pro

   - 移除錯誤的 google/ 前綴
   - 統一使用 gemini-3-pro-preview 模型
   - 修復 7 個 HTML 檔案的 AI 功能
   - 參考 gemini-api.md 官方文檔

   Closes #<issue_number>"
   ```

2. **推送至遠端**
   ```bash
   git push origin fix/gemini-api-upgrade
   ```

3. **建立 Pull Request**
   - 標題：`修復 Puter.js Gemini API 並升級至 Gemini 3 Pro`
   - 說明：引用本文檔的修復清單
   - 請求 Code Review

4. **部署後監控**
   - 追蹤使用者是否回報 AI 功能異常
   - 監控 API 呼叫成功率
   - 收集使用者對 AI 回應品質的反饋

---

## 🛡️ 風險評估與應對

### 風險 1: Gemini 3 Pro 可能有使用限制或配額

**機率：** 中
**影響：** 高

**應對方案：**
- 準備降級方案：若 `gemini-3-pro-preview` 超過限額，自動降級至 `gemini-2.5-pro`
- 實作範例：
  ```javascript
  const MODELS = ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'];

  async function callAIWithFallback(prompt) {
      for (const model of MODELS) {
          try {
              const response = await puter.ai.chat(prompt, { model });
              return response;
          } catch (error) {
              console.warn(`Model ${model} failed, trying next...`);
          }
      }
      throw new Error('All models failed');
  }
  ```

### 風險 2: 回應時間變慢影響使用者體驗

**機率：** 低
**影響：** 中

**應對方案：**
- 實作更明確的 Loading 動畫
- 在較慢的功能上加入「AI 正在深度思考中...」的提示
- 考慮針對即時對話（如學涯導師）使用較快的模型

### 風險 3: 修改後仍無法正常運作

**機率：** 低
**影響：** 高

**應對方案：**
- 保留完整的錯誤日誌（console.error）
- 確保有清楚的錯誤提示給使用者
- 準備快速回滾機制（Git revert）

---

## 📊 進階優化建議（選擇性實施）

### 優化 1: 統一錯誤處理機制

**目的：** 提供一致的錯誤提示，改善除錯體驗

**實作位置：** 可在每個檔案開頭加入共用函式

```javascript
// 統一的 AI 呼叫包裝函式
async function callPuterAI(prompt, options = {}) {
    const defaultOptions = {
        model: 'gemini-3-pro-preview',
        ...options
    };

    try {
        const response = await puter.ai.chat(prompt, defaultOptions);

        // 統一的回應解析邏輯
        let responseText = '';
        if (response.message && response.message.content) {
            responseText = response.message.content;
        } else if (typeof response === 'string') {
            responseText = response;
        } else {
            responseText = JSON.stringify(response);
        }

        return responseText;

    } catch (error) {
        console.error("Puter.js AI 呼叫失敗:", error);

        // 統一的錯誤提示
        throw new Error('AI 服務暫時無法使用，請稍後再試。');
    }
}
```

### 優化 2: 加入 Prompt 版本控制

**目的：** 方便未來調整 AI 提示詞，並進行 A/B 測試

**實作範例：**
```javascript
const PROMPTS = {
    topic_ideas_v1: (interests) => `你是一位專業的台灣高中教育顧問...`,
    topic_ideas_v2: (interests) => `你是一位經驗豐富的學習教練...`,
};

// 使用時可輕易切換版本
const prompt = PROMPTS.topic_ideas_v2(interests);
```

### 優化 3: 加入使用分析

**目的：** 了解哪些 AI 功能最常被使用，哪些需要改進

**實作建議：**
```javascript
// 簡易的使用追蹤（可連接 Google Analytics 或其他工具）
function trackAIUsage(feature, model, success) {
    console.log(`[Analytics] Feature: ${feature}, Model: ${model}, Success: ${success}`);

    // 可選：送至分析平台
    // gtag('event', 'ai_usage', { feature, model, success });
}
```

### 優化 4: 實作 Rate Limiting 保護

**目的：** 防止濫用或意外的大量 API 呼叫

```javascript
// 簡易的節流控制
const rateLimiter = {
    lastCall: 0,
    minInterval: 2000, // 最小 2 秒間隔

    canCall() {
        const now = Date.now();
        if (now - this.lastCall < this.minInterval) {
            return false;
        }
        this.lastCall = now;
        return true;
    }
};

// 在按鈕點擊時使用
if (!rateLimiter.canCall()) {
    alert('請稍候再試，不要點太快哦！');
    return;
}
```

---

## 🧪 測試檢查清單

執行修復後，請逐項確認：

### 功能性測試

- [ ] **主題靈感產生器** - 輸入興趣後能產生 3 個主題建議
- [ ] **學習路徑規劃師** - 輸入學習主題後能產生 4 步驟路徑
- [ ] **自主學習教練** - 輸入模糊想法後能聚焦主題
- [ ] **學習歷程健檢（首頁）** - 貼上心得後能進行 STAR 分析
- [ ] **學習歷程健檢（反思頁）** - 同上，確保兩處都正常
- [ ] **素養分析師** - 輸入活動經驗後能分析核心素養
- [ ] **AI 學涯導師** - 能正常對話並推薦學群

### 技術測試

- [ ] Console 中無 JavaScript 錯誤
- [ ] API 呼叫成功（Network 面板顯示 200 狀態）
- [ ] 回應時間在可接受範圍內（< 10秒）
- [ ] Loading 動畫正確顯示與隱藏
- [ ] JSON 解析正常（無 parsing 錯誤）

### 使用者體驗測試

- [ ] 錯誤提示清晰友善
- [ ] 載入動畫不會讓使用者焦慮
- [ ] 回應內容符合使用者期待
- [ ] 在手機上也能正常使用

---

## 📚 參考資料

1. **官方文檔：** `gemini-api.md` （專案內部）
2. **Puter.js 官方文檔：** https://docs.puter.com/
3. **Gemini API 說明：** https://ai.google.dev/gemini-api/docs
4. **專案 README：** `README.md`

---

## 🎓 專案深度分析與長期維護建議

### 1. 專案架構優勢

**優點：**
- ✅ 純靜態網站，部署簡單（GitHub Pages）
- ✅ 使用 Puter.js 免費提供 AI 功能，無需後端
- ✅ Tailwind CSS 確保一致的 UI 設計
- ✅ 程式碼結構清晰，每個頁面功能獨立

**可改進之處：**
- ⚠️ JavaScript 程式碼有大量重複（每個檔案都有類似的 AI 呼叫邏輯）
- ⚠️ 缺乏統一的錯誤處理與回應解析機制
- ⚠️ Prompt 工程散落各處，不易維護與優化

### 2. 潛在技術債務

#### 問題 A: 程式碼重複（DRY 原則違反）

**影響：** 當需要修改 AI 呼叫邏輯時，需要修改 7 個檔案

**解決方案（長期）：**
建立共用的 JavaScript 模組 `shared/ai-utils.js`：

```javascript
// shared/ai-utils.js
export const AIService = {
    async chat(prompt, options = {}) {
        const config = {
            model: 'gemini-3-pro-preview',
            ...options
        };

        try {
            const response = await puter.ai.chat(prompt, config);
            return this.parseResponse(response);
        } catch (error) {
            console.error('AI Service Error:', error);
            throw new Error('AI 服務暫時無法使用，請稍後再試。');
        }
    },

    parseResponse(response) {
        if (response.message?.content) {
            return response.message.content;
        }
        if (typeof response === 'string') {
            return response;
        }
        return JSON.stringify(response);
    },

    parseJSON(responseText) {
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        throw new Error('No valid JSON found in response');
    }
};

// 使用範例
import { AIService } from './shared/ai-utils.js';
const result = await AIService.chat(prompt);
```

#### 問題 B: 缺乏版本控制策略

**影響：** 難以追蹤哪個版本的 Prompt 表現最好

**解決方案（長期）：**
建立 Prompt 版本庫：

```javascript
// shared/prompts.js
export const PROMPTS = {
    topic_ideas: {
        version: 'v2.1',
        lastUpdated: '2025-11-23',
        template: (interests) => `你是一位專業的台灣高中教育顧問...`,
        changelog: {
            'v2.1': '優化 JSON 格式要求',
            'v2.0': '加入跨領域主題發想',
            'v1.0': '初始版本'
        }
    },
    // ... 其他 prompts
};
```

#### 問題 C: 無錯誤監控機制

**影響：** 使用者遇到問題時，開發者無法得知

**解決方案（長期）：**
整合錯誤追蹤服務（如 Sentry）：

```javascript
// 在 <head> 中加入
<script src="https://js.sentry-cdn.com/..."></script>
<script>
  Sentry.init({
    dsn: 'YOUR_SENTRY_DSN',
    environment: 'production',
    beforeSend(event) {
      // 過濾敏感資訊
      return event;
    }
  });
</script>
```

### 3. 效能優化建議

#### 優化 A: Lazy Loading AI 功能

**目的：** 只在使用者真正需要時才載入 AI 相關程式碼

```javascript
// 只在按鈕點擊時才動態載入 Puter.js
async function initAI() {
    if (!window.puter) {
        const script = document.createElement('script');
        script.src = 'https://js.puter.com/v2/';
        document.head.appendChild(script);

        await new Promise(resolve => {
            script.onload = resolve;
        });
    }
}

generateIdeaBtn.addEventListener('click', async () => {
    await initAI();
    // ... 執行 AI 功能
});
```

#### 優化 B: 回應快取機制

**目的：** 相同的問題不需重複呼叫 API

```javascript
const responseCache = new Map();

async function getCachedAIResponse(prompt, options) {
    const cacheKey = `${prompt}-${JSON.stringify(options)}`;

    if (responseCache.has(cacheKey)) {
        console.log('Using cached response');
        return responseCache.get(cacheKey);
    }

    const response = await puter.ai.chat(prompt, options);
    responseCache.set(cacheKey, response);

    // 限制快取大小
    if (responseCache.size > 50) {
        const firstKey = responseCache.keys().next().value;
        responseCache.delete(firstKey);
    }

    return response;
}
```

### 4. 搜尋功能分析

**發現：** 專案已有完整的搜尋功能（index.html 使用 Fuse.js）

**優點：**
- ✅ 使用 Fuse.js 提供模糊搜尋
- ✅ 動態載入 search-index.json
- ✅ 智能權重配置（標題 0.7、標籤 0.5、內容 0.2）

**潛在問題：**
- ⚠️ `search-index.json` 需要手動維護，容易過時
- ⚠️ 當內容更新時，搜尋索引可能不同步

**改進建議：**
自動化搜尋索引生成（使用 `build-search-index.js`）：

```javascript
// 在 Git pre-commit hook 中自動執行
// .git/hooks/pre-commit
#!/bin/sh
node build-search-index.js
git add search-index.json
```

### 5. 無障礙性（Accessibility）檢查

**發現問題：**
- ⚠️ 部分按鈕缺少 `aria-label`
- ⚠️ 載入動畫缺少螢幕閱讀器提示

**改進建議：**

```html
<!-- 改進前 -->
<button id="generateIdeaBtn" class="...">產生靈感</button>
<div class="loader"></div>

<!-- 改進後 -->
<button id="generateIdeaBtn" class="..."
        aria-label="使用 AI 產生主題靈感">
    產生靈感
</button>
<div class="loader" role="status" aria-live="polite">
    <span class="sr-only">AI 思考中，請稍候...</span>
</div>
```

### 6. SEO 優化建議

**已做得很好的部分：**
- ✅ 完整的 Open Graph 標籤
- ✅ 結構化資料（JSON-LD）
- ✅ `sitemap.xml` 與 `robots.txt`

**可進一步改進：**

```html
<!-- 加入 FAQ Schema -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "什麼是108課綱自主學習？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "自主學習是108課綱的核心特色之一..."
      }
    }
  ]
}
</script>
```

### 7. 安全性檢查

**潛在風險：**
- ⚠️ 使用者輸入直接傳給 AI（可能被注入攻擊）
- ⚠️ AI 回應直接用 `innerHTML` 渲染（XSS 風險）

**修復建議：**

```javascript
// 輸入驗證
function sanitizeInput(userInput) {
    // 限制長度
    if (userInput.length > 1000) {
        throw new Error('輸入內容過長');
    }

    // 移除危險字元
    return userInput
        .replace(/<script>/gi, '')
        .replace(/javascript:/gi, '')
        .trim();
}

// 輸出轉義（已有 escapeHTML 函式，要確保都有使用）
function renderAIResponse(response) {
    const escaped = escapeHTML(response);
    element.innerHTML = escaped.replace(/\n/g, '<br>');
}
```

---

## ✅ 最終建議決策

### 立即執行（本次修復）

**選擇方案 A：全面升級至 Gemini 3 Pro** ⭐

**理由：**
1. ✅ 符合使用者明確要求
2. ✅ 提供最佳的 AI 回應品質
3. ✅ 統一所有檔案配置，降低維護複雜度
4. ✅ Gemini 3 Pro 的進階推理能力特別適合本專案的複雜任務（STAR 分析、素養對照）

**實施步驟：**
依照「詳細修復清單」，將全部 7 個檔案的 `model` 參數改為 `'gemini-3-pro-preview'`

### 短期優化（1-2週內）

1. **加入統一錯誤處理**（參考「優化 1」）
2. **實作使用分析追蹤**（參考「優化 3」）
3. **改善無障礙性**（參考「無障礙性檢查」）

### 長期規劃（1-3個月內）

1. **重構為模組化架構**（解決程式碼重複問題）
2. **建立 Prompt 版本控制系統**（便於 A/B 測試）
3. **整合錯誤監控服務**（如 Sentry）
4. **自動化搜尋索引生成**

---

## 📞 聯絡與支援

如在執行修復過程中遇到問題：

1. **技術問題：** 參考 Puter.js 官方文檔或 Discord 社群
2. **專案問題：** 查看 GitHub Issues 或建立新 Issue
3. **緊急問題：** 立即回滾至上個穩定版本

---

**文檔版本：** v1.0
**最後更新：** 2025-11-23
**作者：** Claude (AI 助手)
**審核者：** 待定

---

## 附錄

### 附錄 A: Gemini 模型性能比較

| 特性 | Gemini 3 Pro | Gemini 2.5 Pro | Gemini 2.5 Flash |
|------|--------------|----------------|------------------|
| 推理能力 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| 回應速度 | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| 適合場景 | 複雜分析 | 通用任務 | 快速互動 |
| 成本 | 高 | 中 | 低 |

### 附錄 B: 快速回滾指令

```bash
# 回滾到修復前的版本
git revert HEAD

# 或直接回到特定 commit
git reset --hard <commit-hash>

# 強制推送（謹慎使用）
git push --force
```

### 附錄 C: 常見錯誤訊息解讀

| 錯誤訊息 | 可能原因 | 解決方法 |
|---------|----------|----------|
| `Model not found` | 模型名稱錯誤 | 確認是否移除 `google/` 前綴 |
| `Rate limit exceeded` | API 呼叫過於頻繁 | 加入節流控制 |
| `Invalid JSON` | AI 回應格式錯誤 | 改善 Prompt 或容錯處理 |
| `Timeout` | AI 回應時間過長 | 考慮使用較快的模型 |

---

**🎉 祝修復順利！如有任何疑問，請隨時提出。**
