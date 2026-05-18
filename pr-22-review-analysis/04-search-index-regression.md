# 問題 04:搜尋索引的競賽項目會整批消失

## 一句話

把競賽資料移出 HTML 內嵌陣列後,`build-search-index.js` 再也抓不到
競賽,重建索引後全站搜尋會失去所有「競賽層級」的結果。

## 留言出處

- PR #22 review comment(Copilot)
- 輪次:第二輪
- 嚴重度:**高**(功能回歸,影響線上搜尋)

## 問題在哪

`build-search-index.js` 靠這條正則從 HTML 抓內嵌資料:

```js
/const\s+(\w+Data)\s*=\s*(\[[\s\S]*?\]);/
```

原本 `competitions.html` 有 `const competitionsData = [ ...10 筆... ]`,
於是索引裡會有「國內外競賽資訊 - 旺宏科學獎」等競賽層級項目。

PR 把它改成:

```js
let competitionsData = [];
```

既是 `let` 不是 `const`、陣列又是空的——正則完全抓不到。
CI 的 `build-and-index` job 重建 `search-index.json` 後,
競賽層級的搜尋結果就消失了。

## 為什麼是 bug

這是典型的「功能回歸」:PR 沒有改搜尋功能,卻間接讓它壞掉。
`search-index.json` 是**衍生檔**,由 CI 自動重建,所以問題不會在
PR 當下顯現,而是合併後才爆——更難察覺。

## 修正(commit `6e70cce`)

`build-search-index.js` 新增 `indexCompetitionsFromJson()`:掃描到
`competitions.html` 時,直接讀 `competitions.json` 為每筆競賽建索引項目
(`id` 為 `competitions-<n>`、`title` 為「國內外競賽資訊 - 競賽名」、
`url` 指向 `#competition-grid`)。本機實測重建索引:14 筆競賽完整重現。

## 我漏掉了——為什麼

**這是我對抗式 review 最嚴重的一次漏抓。**

我的 review 有看 `build-search-index.js`,但只問了一個太窄的問題:
「Node 18→24 會不會讓它壞?」我把它歸類成「不在 diff 內、只需確認相容性」。

我做了「正向追蹤」(我寫的程式對不對),卻沒做「反向追蹤」:
**我移除了 `const competitionsData = [...]`——原本有誰在消費這個資料形狀?**
搜尋索引就是消費者。Review 方法論明明寫了「檢查 generated code 是否同步
更新」,`search-index.json` 正是 generated code,我卻沒把這條連起來。

## 教訓

刪除或改變一個資料結構時,第一件事是「全 repo 搜尋:誰在讀它?」
正向追蹤(我的新碼)與反向追蹤(舊碼對舊形狀的依賴)兩者都要做。
