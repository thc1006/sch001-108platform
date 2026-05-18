# 問題 06:必填欄位只檢查「存在」,沒檢查「型別」

## 一句話

看門狗用 `field in comp` 只確認「鍵存在」,不檢查值的型別,於是
`form: 123`、`title: null` 這種資料能通過 CI,卻在前端
`comp.form.includes(...)` 直接崩潰。

## 留言出處

- PR #22 review comment(Copilot)
- 輪次:第二輪
- 嚴重度:中

## 問題在哪

原本的 `scripts/check-competitions.mjs`:

```js
for (const field of REQUIRED_FIELDS) {
    if (!(field in comp)) schemaErrors.push(/* 缺少欄位 */);
}
```

`'form' in comp` 對 `{ form: 123 }` 為 `true` → 視為通過。

而 `competitions.html` 的渲染:

```js
const matchesForm = ... || comp.form.includes(selectedForm);
```

若 `comp.form` 不是字串,`.includes` 會丟 TypeError,整個篩選/渲染中斷。

## 為什麼是 bug

看門狗的目的是「在 CI 擋下會弄壞頁面的資料」。它放行了型別錯誤的值,
等於把錯誤延後到使用者的瀏覽器才爆——這正是看門狗該防止的事。

## 修正(commit `6e70cce`)

除 `deadline` 外的 7 個文字欄位改用 `TEXT_FIELDS`,驗證
「型別為 `string` 且 `trim()` 後非空」;`deadline` 驗證為字串
(允許空字串＝依官網)。`null`、陣列、數字會在 CI 被擋下。

## 我抓到了——卻誤判而丟棄

這條最值得檢討。我的對抗式 review 在「Dropped candidate findings」
其實寫了:「空字串必填欄位會通過驗證——因需要規格決策,故丟棄」。

我**看到了相鄰的問題**,但停在「空字串算不算缺漏,見仁見智」就放掉了。
Copilot 把追蹤往前推了一步:值若不是字串,前端 `comp.form.includes()`
會**崩潰**——這不是規格模糊,是明確的執行期 bug。

我的錯誤是:追蹤停在「看起來是品味/規格問題」的模糊點,沒有再往下
問「最壞會怎樣」。只要再追一步到 `comp.form.includes`,結論就會從
「丟棄」翻成「應修正」。

## 教訓

候選問題在丟棄前,必須追到「具體的失敗點」。「這見仁見智」往往是
「我還沒追到它真正會爆的地方」。把追蹤推到呼叫端,再決定去留。
