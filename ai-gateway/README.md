# ai-gateway：本地 LLM 閘道

網站（GitHub Pages 上的靜態 Astro 站）的 AI 功能原本走 Puter.js。這個目錄是取代它的
後端：一個沒有任何 npm 相依的 Node 服務，跑在實驗室主機的 k3s 上，代替瀏覽器呼叫
WinLab 的自架模型（`qwen3.8-27b-fp8`）。

```
GitHub Pages（靜態站）→ 學生的瀏覽器 → HTTPS 通道 → ai-gateway（k3s）→ WinLab → GPU
```

為什麼一定要有這一層，而不是讓瀏覽器直接打 WinLab：

- **key 不能進前端。** 任何寫進公開 JavaScript 的 key，訪客都讀得到。
- **WinLab 的 key 只接受校內網段的來源 IP。** 學生在家、用手機網路時的出口 IP
  不在白名單裡；閘道所在的主機在。
- **單次輸出上限 8192 tokens（含思考）。** xhigh 想得深的題目一輪可能寫不完，
  要有人負責接成下一輪。

## WinLab 的實測行為（2026-10-21）

文件沒寫、但會直接影響實作的行為，全部實際打過：

| 行為 | 實測結果 |
|---|---|
| `max_tokens` 上限 | 8192 可以；8193 回 400「單次輸出上限為 8192 tokens(含思考)」 |
| 模型 context | 32768 tokens；「輸入 + `max_tokens`」超過就回 400，**不會**自動縮小 `max_tokens`。錯誤訊息裡的「at least N input tokens」只是下界（上限 − 要求的輸出 + 1），不是實際大小（實際 26017、訊息寫 24577） |
| 精確的輸入大小 | 用 `max_tokens: 1` 送同樣的訊息，`usage.prompt_tokens` 就是精確值（多一次 prefill 的成本） |
| 文字輸入上限 | messages 合計 256 KiB，超過回 400 |
| `reasoning_effort` | 只收 `none`／`low`／`medium`／`xhigh`；`high`、`max` 回 400 |
| 欄位白名單 | `continue_final_message`、`add_generation_prompt`、`extra_body` 一律 400 |
| `response_format` | `json_object` 與 `json_schema`（strict，含 `minItems`、`enum`、`pattern`）在 xhigh 下都有效 |
| 串流 | SSE 正常；思考內容在 `delta.reasoning_content` |
| 速度 | 單一請求約 46 tokens/s；「學習啟動包」xhigh 約 7 秒（思考 185 tokens） |
| 忙碌時的等待 | 2026-10-22 一個極小的請求等了 82.6 秒才收到第一個位元組（串流也一樣，標頭要等開始處理才送）：`LLM_IDLE_TIMEOUT_MS` 不能設得太短 |
| usage | 有 `completion_tokens_details.reasoning_tokens`（2026-10-22 實測） |
| 並行上限 | key 同時最多 8 個請求，超過回 429 |
| 沒送 `max_tokens` | 只給 2048，思考完答案就被截斷（ahp-match 踩過） |

## 設定

名稱沿用 ahp-match 的 `scripts/serve-local.js`（同一台 k3s、同一個 WinLab）。數值打錯時
退回預設並警告（警告只顯示短而且明顯不是 key 的值，其他只說有幾個字元）；key 與上游網址
錯了則當成沒有設定（不退回正式站），由 `configProblems()` 列出——HTTP 服務的 readiness
檢查要依它回報未就緒。key 檔去掉頭尾的空白，零寬字元（ZWSP、ZWNJ、ZWJ、WORD JOINER、BOM）
在任何位置都清掉；中間還有空白或換行（多行、`.env` 格式）、寫成「名稱=值」或「名稱: 值」、
或整個包在引號裡，都視為沒有設定，免得變成一把錯的 key、每個請求都 401（base64 key 結尾
補位的 `=` 不算「名稱=值」）。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `LLM_UPSTREAM` | `https://llm.winlab.tw` | 只取 origin；http 只允許本機；不能含帳密 |
| `LLM_API_KEY_FILE` | — | 從檔案讀 key，有設就優先（k3s 把 Secret 掛成檔案） |
| `LLM_API_KEY` | — | 直接給 key，只建議本機開發用 |
| `LLM_MODEL` | `qwen3.8-27b-fp8` | |
| `LLM_REASONING_EFFORT` | `xhigh` | 第一輪與第一次思考接續的強度；不分大小寫 |
| `LLM_CONTINUATION_EFFORT` | `none` | 正文接續與 JSON 重寫的強度（強制作答一律 `none`） |
| `LLM_MAX_TOKENS` | `8192` | 每一輪的上限，含思考；超過 8192 必定被 WinLab 拒絕 |
| `LLM_CONTEXT_TOKENS` | `32768` | 模型的 context 長度，用來算每一輪放得下多少 |
| `LLM_MAX_ROUNDS` | `3` | 連同第一輪最多幾輪 |
| `LLM_TASK_TIMEOUT_MS` | `900000` | 一個任務所有輪（含重試）合計的時限 |
| `LLM_IDLE_TIMEOUT_MS` | `180000` | 上游多久沒送任何位元組就當成卡死；上限 300000（undici 的預設逾時） |

- 輪數與時限是一起選的：被截斷的那一輪一定用滿 8192 tokens，一輪約 3 分鐘；WinLab 忙碌時
  每一輪的第一個位元組還要再等一兩分鐘，3 輪都寫滿、沒有任何額外請求（探測、重試）時約
  13 分鐘，所以預設 15 分鐘——大約只容得下一次額外的排隊，再多就以時限結束、交出已寫好的
  部分。調高輪數時，時限要跟著調；HTTP 服務的 `SHUTDOWN_GRACE_MS` 也不能比它短（換版時
  進行中的任務才做得完）。
- `LLM_TASK_TIMEOUT_MS` 刻意不叫 ahp-match 的 `LLM_MAX_GENERATION_MS`：那邊是單一請求的
  上限，這裡涵蓋一個任務的所有接續輪，同名不同義容易設錯。

## 錯誤與 log

上游的錯誤內容只讀前 8 KiB，遮罩後留 500 字給 log（`redact()`，在 `src/upstream.mjs`）：

- 看不見的字元先清掉（被零寬字元或控制字元切開的 key 會重新接起來），JSON 在解析後的值與
  鍵上清，跳脫序列（`\uXXXX`、`\xXX`、`\b` 這類）最多還原三層——LiteLLM 會把內層錯誤
  整段序列化成字串再包一層。
- 遮掉：key 的各種寫法（原樣、JSON 跳脫、URL 編碼、十六進位、base64 三種對齊與
  base64url、被空白切開）、`sk-` 開頭的 key、Bearer token、長十六進位（key 的雜湊）、email、
  內部位址（私有與 CGNAT 的 IPv4、IPv6 迴路／ULA／link-local、k8s 與 `.internal`、`.local`、
  `.ts.net` 這類網域、網址裡只有一段的主機名稱、帶 port 的叢集短名）、網址裡的帳密。
  帶 port 的短名有兩個取捨：只有一段的名稱要有連字號才遮（`litellm-proxy:4000`；`vllm:8000`
  只有出現在網址裡才遮），免得 `code:400` 這類文字被遮；兩段以上的名稱靠一份常見頂級網域與
  原始碼副檔名的清單判斷不是叢集短名，不在清單裡的公開網域（例如 `.xyz`）帶 port 會被多遮，
  namespace 剛好叫 `ai`、`dev`、`io` 的叢集短名則會漏遮。
- 內容被截斷時（只讀了 8 KiB，或超過 64 KiB），尾端再丟掉 256 字：截斷點可能切在 key
  中間，殘段比對不到任何寫法。
- 上游給的 content-type 也是上游的文字，同樣遮罩後放進 `detail`，不進錯誤訊息。
- 回應不是正常的串流（200 卻不是 SSE、事件不是 JSON 或不是物件）時，`detail` 只記長度與開頭的
  字元。這時的內容多半是模型的正文，常照抄學生的輸入，不能進 log。
- 狀態碼已經決定錯誤的分類，錯誤內容只是給 log 看的：讀它用收尾期限（5 秒），內容慢慢滴時
  不必等滿閒置逾時。
- vLLM 的請求 id（`chatcmpl-…`）保留，回報問題時用得到；traceback 裡的 `檔名.py:行號`、
  公開網域帶 port 不當成內部位址。

## 測試

```bash
npm run test:ai-gateway
```

全部打本機的假 WinLab（`test/fake-upstream.mjs`），不連外網、不需要 key；CI 的
「AI Gateway Tests」job 跑的就是這一條。`test/source-hygiene.test.mjs` 另外檢查：
原始碼裡不能有看不見的字元（控制、格式與預設可忽略的字元、特殊空白，寫在正規表示式裡時
畫面上完全看不出來），以及 `test:ai-gateway` 明列的測試檔要剛好等於 `test/` 底下（含子目錄）
扣掉輔助檔的所有 JS／TS 檔（新增測試檔時忘了加進清單會被擋下）。反過來，清單裡的檔案不存在時
`node --test` 不會報錯（參數被當成 glob，沒比對到就略過），所以 CI 在跑測試之前另外檢查清單
裡的每個檔案都在。

`test:ai-gateway` 不加 `--test-force-exit`。這個旗標讓每個測試檔的子程序跑完就呼叫
`process.exit()`，而 POSIX 上寫進 pipe 是非同步的，還沒送到主程序的測試結果會被丟掉。
2026-10-22 在負載高的機器上重複跑，20 次裡有 1 次少回報了 3 個測試，結束碼仍是 0；拿掉
旗標之後子程序自然結束，送完結果才離開。source-hygiene 會擋下把它加回去的改動。
