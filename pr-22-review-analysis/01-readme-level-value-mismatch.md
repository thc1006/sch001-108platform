# 問題 01:competitions.json 的 _readme 把 level 值寫錯

## 一句話

資料檔開頭的 `_readme` 說明把 `level` 的合法值列為「校際-地區/全國/國際」,
但驗證器與前端實際用的是「校際/地區」——照 README 填就會被擋下。

## 留言出處

- PR #22 review comment(Copilot)
- 輪次:第一輪
- 嚴重度:低(誤導性,不直接造成執行錯誤)

## 問題在哪

`competitions.json`:

```
"_readme": "...level 限 校際-地區/全國/國際;..."
```

`scripts/check-competitions.mjs`:

```js
const ALLOWED_LEVELS = ['校際/地區', '全國', '國際'];
```

`competitions.html` 篩選器:`<option value="校際/地區">`。

`/` 同時是「值的一部分」(校際/地區)又被我拿來當「分隔符」,
於是「校際/地區」在註解裡被誤寫成「校際-地區」。

## 為什麼是 bug

這是「文件 vs 程式碼」不一致。若有人照 `_readme` 指示新增一筆
`"level": "校際-地區"` 的競賽:

- 看門狗 `ALLOWED_LEVELS.includes('校際-地區')` → false → 報「不在允許清單」
- 前端篩選器永遠不會選到它

文件本來是要降低出錯率,寫錯反而誘導出錯。

## 修正(commit `222362c`)

`_readme` 改用引號標示每個值,消除分隔符歧義:

```
level 限「校際/地區」「全國」「國際」
```

## 我有沒有漏掉

這條是 Copilot 第一輪抓到,在我的對抗式 review 之前。但根因是
**我自己寫 `_readme` 時造成的**——用 `/` 當分隔符卻沒注意有個值內含 `/`。
我當時沒做「文件字串 vs 程式碼常數」的一致性自我比對。

## 教訓

任何「用文字描述合法值」的註解,都要和程式碼裡的單一真相來源
(此處是 `ALLOWED_LEVELS`)逐字對照。分隔符不可與值的內容字元相同。
