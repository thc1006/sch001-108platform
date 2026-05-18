# 問題 05:致命錯誤時看門狗不會自動開 issue

## 一句話

當 `competitions.json` 讀不到或無法解析,看門狗在寫報告、設定輸出之前
就 `process.exit(1)`,導致 workflow 的「開 issue」步驟被跳過——
這類錯誤不會通知維護者。

## 留言出處

- PR #22 review comment(Copilot)
- 輪次:第二輪
- 嚴重度:中

## 問題在哪

`scripts/check-competitions.mjs` 的 `fail()` 原本只是:

```js
console.error(...); process.exit(1);
```

而 `competitions-check.yml` 的開 issue 步驟條件是:

```yaml
if: steps.check.outputs.needs_attention == 'true'
```

GitHub Actions 的 `if:` 不含狀態函式時,**隱含 `success()`**——
前一步失敗(exit 1)時,這步直接被跳過。而且 `needs_attention`
輸出根本還沒被寫入。

於是「JSON 格式錯誤」這種看門狗文件明列為檢查項目 #1 的問題,
反而不會開 issue,只會讓 workflow 紅燈。

## 為什麼是 bug

看門狗設計的通知管道是「開 issue」。維護者盯的是 issue,不一定會
天天看排程 workflow 的紅綠燈。「最嚴重的資料錯誤反而最安靜」
是反直覺且危險的。

## 修正(commit `6e70cce`)

- `fail()` 改 async:結束前先寫出標示「致命錯誤」的 report,
  並對 `GITHUB_OUTPUT` 設 `needs_attention=true`,再 `exit 1`
- workflow 開 issue 步驟條件改為
  `if: always() && steps.check.outputs.needs_attention == 'true'`

這樣致命錯誤會有「紅燈 + 開 issue」兩個訊號。

## 我漏掉了——為什麼

我的 review 分別檢查過「腳本的 `fail()`」和「workflow 的 issue 生命週期」,
各自看起來都對。但我沒有把這條**跨檔案、跨系統的互動路徑**走一遍:
「腳本 `exit 1`」×「workflow step 的隱含 `success()` 閘門」。
元件各自正確,接起來卻有洞。

## 教訓

Review 不能停在「每個元件各自正確」。要挑出**跨元件的執行路徑**
(特別是錯誤路徑),端到端走一遍:這裡是「腳本結束碼如何影響
下游 workflow 步驟的觸發」。
