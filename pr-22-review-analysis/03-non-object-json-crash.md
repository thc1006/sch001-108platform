# 問題 03:非物件 JSON 讓看門狗崩潰(而非優雅報錯)

## 一句話

當 `competitions.json` 內容是 JSON `null`,或 `competitions` 陣列含
`null`/數字等元素時,看門狗丟出未捕捉的 TypeError 並以堆疊追蹤崩潰,
而不是走既有的 `fail()` 友善報錯。

## 留言出處

- 來源:Claude 對抗式 self-review 的 Finding 1(**非** Copilot)
- 並經獨立 validator subagent 確認
- 嚴重度:低

## 問題在哪

`scripts/check-competitions.mjs`:

```js
data = JSON.parse(raw);                       // JSON 'null' → data === null(不丟錯)
if (!Array.isArray(data.competitions)) { ... } // null.competitions → TypeError
```

`JSON.parse('null')` 會「成功」回傳 `null`,所以 `catch` 不觸發;
下一行對 `null` 取屬性即崩潰。此行不在任何 try/catch 內。

`forEach` 內亦同:`comp.title`(對 `null`)或 `'title' in comp`
(`in` 右運算元為原始型別時)都會丟 TypeError。

## 為什麼是 bug

看門狗的職責是「優雅地報告資料錯誤」。對某些畸形輸入,它自己先崩潰,
印出的是 JS 堆疊而非設計好的中文訊息。雖然 CI 兩種情況都會紅燈,
但「驗證器自己崩潰」本身就是驗證器的失職。

## 修正(commit `5a2ea6a`)

- 外層加 `data === null || typeof data !== 'object'` 守衛
- `forEach` 開頭驗證每筆 `comp` 為有效物件,否則記為欄位錯誤並 `return`

## 這條是我自己抓到的

對抗式 review 方法論裡「檢查 nil / 空值 / 畸形輸入」這一項命中。
也展示了「驗證器要先能驗證自己的輸入」這個原則。

## 教訓

任何 `JSON.parse` 之後都要記得:`null` 是合法 JSON,但 `typeof null
=== 'object'`;存取屬性前要先擋掉 `null`。
