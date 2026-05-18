# 問題 07:目錄被重複掃描,索引項目整批重複

## 一句話

`build-search-index.js` 的 `directoriesToScan` 同時列出根目錄 `''`
(會遞迴進所有子目錄)與各子目錄,導致子目錄被掃兩次、索引項目整批重複。

## 留言出處

- 來源:Claude 在「測試問題 04 的修正」時撞到(**非** Copilot、非留言)
- 輪次:第二輪期間
- 嚴重度:中(既有 bug,非本 PR 引入)

## 問題在哪

```js
const directoriesToScan = ['', 'autonomous-learning',
    'learning-portfolio', 'career-exploration', 'advanced-resources'];
directoriesToScan.forEach(dir => scanDirectory(dir));
```

`scanDirectory('')` 會從根目錄遞迴進入**所有**未排除的子目錄——
已經涵蓋那 4 個子目錄。接著 `forEach` 又把那 4 個子目錄各掃一次。
於是子目錄裡每個頁面、每個項目都被索引兩次。

修問題 04 後我本機重建索引,`competitions-` 項目數出現 **28(= 14 × 2)**,
才循線發現這個既有的重複掃描 bug。

## 為什麼是 bug

`search-index.json` 整批重複:搜尋結果出現成對的重複項、索引檔
無謂膨脹。屬於既有 bug(PR 前就存在),但我加的競賽索引也被連帶
複製成兩份。

## 修正(commit `6e70cce`)

`directoriesToScan` 改為只含根目錄 `['']`——`scanDirectory` 本來
就會遞迴。被索引的頁面集合完全不變,只是不再重複。修正後本機實測:
`competitions-` 項目 14 筆、全索引重複項 0 筆。

## 我漏掉了——為什麼

我的對抗式 review 把 `build-search-index.js` **讀**過,確認沒有危險
API,但**沒有實際執行它**。只要 `node build-search-index.js` 跑一次,
`competitions-` 項目數 28≠14 立刻刺眼。

靜態閱讀能看出 API 誤用,卻看不出「執行期的數量級錯誤」。這個 bug
是我在「測試另一個修正」時被動撞到的,不是主動 review 出來的。

## 教訓

Review 涉及的腳本,能跑就跑一次,並對輸出做數量級的合理性檢查
(「應該 14 筆,為什麼 28?」)。「讀過了」不等於「驗證過了」。
