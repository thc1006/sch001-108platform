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
  要有人負責接成下一輪——見下方「自動續寫」。

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

## 自動續寫（`src/generate.mjs`）

被截斷（`finish_reason: "length"`）時自動接成下一輪，直到寫完或用完 `LLM_MAX_ROUNDS`。
WinLab 不收 vLLM 原生的 `continue_final_message`，所以接續一律在對話層做：把已產出的
東西放回對話，再請模型接著做。每一輪結束後，依「這一輪」產出了什麼決定怎麼接：

| 這一輪產出了什麼 | 下一輪 | 思考強度 |
|---|---|---|
| 只有思考（還沒開始寫答案） | 思考筆記放回對話，請它接著想再作答；連續第二次就請它不要再想、直接作答 | 第一次維持 xhigh，第二次起一律 `none` |
| 文字任務的正文 | 已寫的正文放回對話，請它從斷點接著寫；接上前去掉重複的開頭 | `LLM_CONTINUATION_EFFORT` |
| JSON 任務的正文 | **不拼接**：草稿與思考筆記放回對話，整份重寫，保留 `response_format`；正文其實已經合格就直接收下（斷線前已收到也一樣）。以 stop 結束時也要合格才收下，否則一樣整份重寫，但提示詞改說它不符合格式，不說被截斷 | `LLM_CONTINUATION_EFFORT` |
| 思考完、只吐了幾個換行就被截斷 | 思考其實已經結束、只是額度用完：帶著筆記直接作答 | `none` |
| 一大串空白（guided decoding 退化：連續 8 個以上的換行，或 256 字元以上的空白） | 整輪只有空白：重做（JSON 任務改成不帶 `response_format`，之後每一輪都附上格式要求與整份 schema）；正文寫到一半才退化：空白丟掉、照常接續。程式碼的縮排與對齊用的空白照常保留 | 思考已完成就帶著筆記直接作答（`none`） |
| 沒有淨進展（下一輪的請求會跟這一輪一模一樣：整輪只有空白、只重複了已寫的內容、重寫出同一份草稿） | 下一輪加一句提醒；連續兩輪沒有淨進展就提前結束，不把剩下的輪數燒完 | 不變 |

- **JSON 為什麼不拼接**：活體測試中拼接會在字串中間接歪（上一輪停在 `"音樂結構分析`，
  下一輪另開 `"巴赫"`），整份變成不合法 JSON。整份重寫時不思考，額度全給正文，
  `json_schema` 的 guided decoding 又保證結構合法（退化過一次、拿掉 `response_format` 之後就
  沒有這個保證，所以結束時一律再驗證一次；HTTP 服務交出前還會依任務的 schema 與 check 再驗一次）。
- **怎樣算合格**：由呼叫端的 `acceptJson` 判斷，HTTP 服務傳入的就是交出前那一套驗證，兩邊的標準
  才不會不同：不會收下頂層欄位都在、細節卻不合規格的 JSON，也不會把包在說明文字裡的合格 JSON
  重寫到用完輪數。schema 表達不了的規則寫在任務的 check（例如 study-plan 的週次要依序），不通過
  一樣整份重寫；check 本身丟出例外算程式錯誤，第一輪就以 `internal` 結束，不拿去重寫。
  沒給 `acceptJson` 的話只看是不是完整的 JSON（可以包在 ```` ```json ```` 圍欄裡），
  而且頂層的必填欄位都在。最後一份正文是寫完的（以 stop 結束）卻不合格時，不論是用完輪數，
  還是之後連續兩輪沒有淨進展而提前結束，都以 `format` 結束（不是 `incomplete`）。
- **context 預算**：估算器依字元類別估 token 數（ASCII 字母 0.5、漢字與全形 1.2、emoji 與
  擴展區漢字 4……），對常見中文與英文高估不少、對罕用字與數字可能低估，所以只當第一步：
  - 第一輪：估算的可用額度有上限的九成以上就直接送；更少時先用 `max_tokens: 1` 探出精確
    大小再決定（探測是一次完整的 prefill，WinLab 忙碌時還要多排一次隊）。之後幾輪的題目都用
    這個精確值（或第一輪 `usage` 的精確值）。
  - 接續輪：帶回去的正文、思考筆記、JSON 草稿依「哪一輪寫的」分段，每段用那一輪 `usage` 的
    精確 token 數換算自己的比例（正文是 `completion_tokens − reasoning_tokens`，思考是
    `reasoning_tokens`）；拿不到的段落用估算值。每輪的 `usage`（減去題目）再回推一個整體的
    修正係數，同一種接法的下一輪沿用（已知限制：它也乘在已經有精確比例的段落上，退化或斷線
    之後內容組成大變時，下一輪可能估低而多一次 400 與探測）。放不下就裁掉（筆記與 JSON 草稿留頭尾、正文留結尾），
    優先保住完整的輸出額度；連最少的輸出量都擠不出來就以 `incomplete` 結束，附上已寫好的部分。
  - 仍被 vLLM 以 context 長度拒絕時：錯誤訊息寫出精確的輸入大小（新版 vLLM 的「your request
    has N input tokens」）就照用；只給下界（「at least N」）時，探出這組訊息的精確大小、校正後
    重新規劃再送（同一輪最多兩次，之後以 `incomplete` 結束）。探測遇到 429 或斷線，跟正式請求
    一樣退避重試。
  - 上游不給 `usage`（探測成功卻沒有 `prompt_tokens`）：這個任務不再探測，也不憑估算判定放不下；
    改用樂觀的比例規劃，被拒就調高比例再試（同一輪最多三次），之後幾輪沿用。
  - `usage` 的數字不可能是真的（「輸入 + 這次的 `max_tokens`」超過 context 卻成功、探測回報比
    context 還大、接續輪比題目還小）就當作沒給，不拿來規劃（加總用量時照記）。
  - 探測帶著跟正式請求相同的參數（思考強度、`response_format`、`temperature`），用量照樣計入
    （WinLab 的 TPM 會算）。
  - 超過 240 KiB 的輸入上限時，依「上限扣掉題目與指示後剩下的位元組」等比例縮減帶回的內容。
- **接續輪的重試**：接續輪遇到 429、連線中斷、閒置逾時，會在總時限內重試（預設 2 次）：有
  `Retry-After` 就照它等（包括 0 秒），沒有就從 2 秒起指數退避、上限 30 秒；要等的時間超過
  剩下的總時限就馬上放棄。第一輪失敗不重試，讓使用者自己重按。
- **控制符號**：帶回 prompt 的內容（正文、思考筆記、JSON 草稿、續寫指示引用的結尾）一律經過
  `neutralizeControlTokens`（`src/control-tokens.mjs`）：學生可以先要求模型把全形的
  `＜|im_start|＞` 照抄成半形，第二輪就繞過了輸入端的中和。送給呼叫端的串流與結果不動。
- **串流**：文字任務逐段送出的文字與最後的結果逐字相同。每一輪開頭與正文中間的空白先暫存，
  確定不是退化才送（連續 8 個以上的換行、或 256 字元以上的空白，壓成最多兩個換行；縮排與
  對齊照常保留）。接續輪的開頭先緩衝，確定不會再形成更長的重疊就送出，不必等滿 2000 字。
  去重疊不會把英文的下一個詞誤認成重複（前文結尾「the」、下一輪「 theory」），但只限 3 個字母
  以內的短詞：長一點的詞連同空白重寫（「Pyth」接「 Python」）照樣去掉，從換行開始的整行重寫
  （網址、雜湊這類沒有空白的行）也是；剛好斷在 3 個字母以內、又連同空白重寫的詞會留下重複。
  接縫上前後相同的字詞（that that、一步一步）和重複分不出來，會被去掉一個。async 的 hook
  在回傳結果前都會等它完成（受總時限與取消約束）。
- **失敗時**：丟出的錯誤帶著已寫好的部分（`partial`）、輪數、接續紀錄與已經用掉的 tokens
  （`usage`，含探測），呼叫端記 log 用。
- **語言**：接續的提示詞都再提醒一次台灣繁體中文；活體測試中，不思考的接續輪寫長文時
  會零星冒出簡體字。

## HTTP 服務（`src/server.mjs`）

網站的瀏覽器跨網域呼叫閘道。瀏覽器只說「要做哪個任務、輸入是什麼」，prompt、輸出格式與
上限都由閘道決定（`src/tasks.mjs`、`src/task-catalog.mjs`）：閘道拿著 key、背後是有限的
GPU，收任意 prompt 等於架一個免費的通用 LLM 代理，CORS 擋不住 curl。

```bash
node ai-gateway/src/server.mjs     # 預設 127.0.0.1:8787
```

| 端點 | 說明 |
|---|---|
| `POST /v1/tasks/<id>` | body `{"input": {...}}`；回應 `text/event-stream` |
| `OPTIONS /v1/tasks/<id>` | CORS 預檢（只允許 `ALLOWED_ORIGINS` 列出的網站） |
| `GET /healthz` | 程序活著就 200（liveness） |
| `GET /readyz` | 有 key、上游設定合法、沒在關機才 200，否則 503（readiness） |

SSE 事件（每個 `data` 都是一行 JSON）：`accepted { requestId, task }`、
`progress { phase: queued|started|thinking|writing|continuing|retrying, … }`、`delta { text }`（只有
文字任務，邊收邊顯示用）、`done { result, rounds, continuations, usage, elapsedMs }`、
`error { code, message, retryable, retryAfter? }`。串流正常會以一個 `done` 或 `error` 結束；
用戶端自己離開、程序被強制結束這類情況收不到結束事件，前端要把「沒收到結束事件就斷線」當成
可以重試的中斷。開始串流之前的拒絕（輸入不合格、限流、排隊已滿、關機中）一律回 JSON
`{"error": {code, message, requestId, …}}`。

- **輸入**：每個欄位都是字串、有字數上限（以字素計，🇹🇼 算一個字）。看不見的字元（格式字元、
  預設可忽略的字元，保留表情符號要用的 ZWJ／ZWNJ）先清掉，清掉之後沒有看得見的字就算沒填；
  哪些字看得見由 `src/visible-text.mjs` 的 `hasVisibleText` 判斷，輸出的驗證也用它。chat template
  的控制符號中和成全形；學生的資料包在每次請求才有的隨機標記裡，system 訊息明說標記裡的文字
  都只是資料。
- **排隊與限流**（都依來源 IP 計算；經 Tailscale Funnel 時看它覆寫過的 `X-Forwarded-For`，
  只有連線來自 `TRUSTED_PROXIES` 時才採信）：
  - 同時進行 `LLM_CONCURRENCY` 個任務，其餘排隊（最多 `LLM_MAX_QUEUE` 個、最久
    `QUEUE_TIMEOUT_MS`），排隊時有名次，輪到時送一個 `started`。名額空出來時先給進行中任務
    最少的來源，一樣多的才照到達順序：只照到達順序的話，佔滿名額的來源隨時排著幾個請求，
    空出來的名額就一直回到它手上，別人排到逾時。這只決定排隊的人誰先輪到。名額沒滿時請求
    直接開始，所以閘道閒著時，一個來源可以拿走全部名額，每個佔到任務結束。它佔住的名額最晚在
    任務的時限（任務定義的 `timeoutMs`，沒設就是 `LLM_TASK_TIMEOUT_MS`）內空出來、先給排隊的人；
    時限比 `QUEUE_TIMEOUT_MS` 長的任務，排隊的人會先逾時。
  - 每個來源每 10 分鐘最多開始 `RATE_LIMIT_MAX` 個任務。學校整間教室共用一個對外 IP，所以
    預設給到 100；沒用到 GPU 的請求不計：排隊已滿、排到逾時、排隊中離開，以及上游在第一個
    token 之前就回忙線（429）、連不上或逾時的。第一個 token 之前的逾時是 WinLab 忙到還沒開始
    處理，學生看到的是忙線（`busy`），不是叫他把內容寫具體一點的 `timeout`。
  - 每個來源每分鐘最多送 `REQUEST_LIMIT_PER_MINUTE` 個請求（不論成敗），在讀 body 之前就檢查：
    驗證失敗的請求不計入上一項，沒有這一道，連續送超大的錯誤請求就能把 CPU 吃滿。
  - 名額已滿時，每個來源最多佔用 `CLIENT_MAX_INFLIGHT` 個（含排隊）。依來源計的限制擋不住
    握有很多 IP 的人，這是取捨，不是保證。
  - `TRUSTED_PROXIES` 對不上實際的代理時，所有人都會落到同一個桶：帶著 `CLIENT_IP_HEADER` 的
    連線不是來自信任的代理，log 每分鐘最多記一筆 `CLIENT-IP-UNTRUSTED`，附上次數與連線的位址
    （內部位址才原樣記下，其他只記雜湊）；信任的代理沒送用戶端 IP 時記 `CLIENT-IP-MISSING`。
- **資源上限**：同時在收 body 的任務請求最多 1000 個，超過就立刻回 503 並關掉連線；body 要在
  `BODY_TIMEOUT_MS` 內收完，標頭最多 8 KiB，連線最多 2048 條。Funnel 收完標頭就轉送、body
  邊收邊送，慢慢上傳的連線每條約佔 50 KiB，沒有這些上限的話，幾十個來源就能讓 256Mi 的 pod
  被 OOMKill（2026-10-22 本機實測：3000 條慢速上傳、每條標頭 14 KB，RSS 從 71 MiB 漲到 266 MiB）。
  上限是拿 503 換掉 OOM。每個 IPv4 來源每分鐘最多送 `REQUEST_LIMIT_PER_MINUTE` 個請求、每個最多
  撐 `BODY_TIMEOUT_MS`，照預設平均同時佔 20 個，大約 50 個來源就能一直佔滿，這段期間所有新任務
  都拿到 503；9 個來源同時把一分鐘的額度用完，可以佔滿 10 秒。1000 是依記憶體選的：同一天把
  閘道放進 256 MiB 的 cgroup，用戶端一直維持 6000 條慢速上傳（標頭 8 KB，被關掉就重開，每秒新開
  五千多條），RSS 最高 162 MiB，上限 2000 時是 204 MiB。
- **心跳**：每 `HEARTBEAT_MS` 送一次 SSE 註解。前端連續 60 秒沒收到任何位元組就當成斷線，
  所以心跳上限是 30 秒，兩邊要一起改。
- **換版與關機**：收到 SIGTERM 後 readiness 改回 503、新請求回 503（`Retry-After: 5`、
  `connection: close`，讓代理改連新的 pod），排隊中的任務立刻中止，進行中的任務最多等
  `SHUTDOWN_GRACE_MS`；時間到了先送一個可重試的 `error` 再斷線。第二次 SIGTERM 立即結束。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `PORT`／`HOST` | `8787`／`127.0.0.1` | k3s 的 manifest 設 `0.0.0.0` |
| `ALLOWED_ORIGINS` | `https://thc1006.github.io` | 逗號分隔；只收 https（本機可用 http），比對前正規化成 origin |
| `CLIENT_IP_HEADER` | — | 由哪個標頭取得用戶端 IP；Funnel 用 `x-forwarded-for` |
| `TRUSTED_PROXIES` | — | 只有連線來自這些 IPv4／CIDR 時才採用上面的標頭 |
| `LLM_CONCURRENCY` | `4` | 上限 8（key 的並行上限） |
| `LLM_MAX_QUEUE` | `8` | |
| `QUEUE_TIMEOUT_MS` | `240000` | WinLab 忙的時候，進行中的任務光等第一個位元組就要一兩分鐘；任務的 `timeoutMs` 不要比它長。目前任務都不設，理由見 `src/task-catalog.mjs` 的 `TASK_DEFINITIONS` |
| `RATE_LIMIT_WINDOW_MS`／`RATE_LIMIT_MAX` | `600000`／`100` | |
| `REQUEST_LIMIT_PER_MINUTE` | `120` | |
| `CLIENT_MAX_INFLIGHT` | `6` | |
| `BODY_TIMEOUT_MS` | `10000` | 收完 body 的期限（Node 自己的逾時在開始關機後就不檢查） |
| `HEARTBEAT_MS` | `15000` | 上限 30000 |
| `SHUTDOWN_GRACE_MS` | `900000` | 不能比 `LLM_TASK_TIMEOUT_MS` 短 |
| `LOG_LEVEL` | `info` | |

log 一律一行一筆、跳脫控制字元與換行，不記學生的輸入與模型的輸出（只記長度與代號）。

## 簡轉繁（`src/s2t.mjs`）

提示詞再三要求台灣繁體中文，模型在不思考的接續輪寫長文時仍會零星冒出簡體字。閘道在送出前
逐字轉換一次：文字任務的每個片段與最後的結果、JSON 任務解析出來的字串值（鍵不轉）。JSON 先解析
再轉換，寫成 `\uXXXX` 跳脫序列的字也轉得到；轉完才驗證 schema，enum 的值才比對得上。

- 只收「一個簡體字只對應一個繁體字」的條目（OpenCC 的 STCharacters，套用 TWVariants 轉成
  台灣字形，例如「為」不是「爲」）。發／髮、後／后、系／係這類一對多的字一律不轉：逐字轉換
  一定會在某些詞裡轉錯，寧可留著。台灣本身就這樣寫的字（划船的划、菜肴的肴、南庄鄉的庄、
  教育部標準字的晒、陶坏的坏）不在表裡。
- 一對多但台灣幾乎只用一種寫法的字指定轉法：证→證、确→確、据→據（「拮据」例外）、适→適、
  个→個。
- 「么」要看前一個字：只在什么、怎么、这么、那么、多么、要么這類詞裡轉成「麼」，老么、么女
  不轉（那是台灣本來就這樣寫的字）。
- 對照表 `src/s2t-table.mjs` 由 `scripts/build-s2t-table.mjs` 從固定 commit 的 OpenCC 資料產生，
  不要手動改；OpenCC 的授權（Apache License 2.0）見 `licenses/OpenCC-LICENSE.txt`。

## 部署（`deploy/k3s/`）

跑在實驗室主機的 k3s 上（這台主機的出口 IP 在 WinLab key 的來源白名單內），慣例與 ahp-match
相同：buildah 建映像檔、匯入 k3s 的 containerd、以 git commit 當 tag。命名空間強制 Pod Security
restricted，網路預設全部拒絕，只開 DNS 與校內網段（含 WinLab）的 443，範圍與取捨見 `app.yaml`；
一般的 pod 連不進閘道，外部流量由主機上的 Tailscale Funnel 轉到 Service 的固定 ClusterIP
`10.43.0.87`。這個位址選在 Service 網段（k3s 預設 `10.43.0.0/16`）前 256 個位址的靜態區段：
Kubernetes 動態配置時先用上段，固定位址才不會被別的 Service 先拿走。clusterIP 建立之後不能
修改，要換位址得先刪掉 Service 再套用，Funnel 也要改指新的位址。主機與 hostNetwork pod 是
例外：kube-router 會放行主機本地發出的流量，主機連 ClusterIP 時來源又會被 masquerade 成
`10.42.0.1`（正好是 `TRUSTED_PROXIES`），所以主機上的任何程序、任何命名空間裡的 hostNetwork
pod 都連得進閘道，它們送的 `X-Forwarded-For` 會被採信，能繞過依來源的限流（2026-10-22 實測）。
這是取捨：Funnel 就在主機上，閘道分不出誰是 Funnel、誰是主機上的其他程序。

1. 建立 key 的 Secret（只做一次；key 不進 git，也不放環境變數，以檔案掛進 pod）：

   ```bash
   sudo k3s kubectl apply -f ai-gateway/deploy/k3s/namespace.yaml
   read -rsp 'LLM API key：' KEY; echo
   printf '%s' "$KEY" | sudo k3s kubectl -n sch001-ai create secret generic ai-gateway-env \
     --from-file=LLM_API_KEY=/dev/stdin
   unset KEY
   ```

   檔案裡只能有 key 本身：寫成 `LLM_API_KEY=…`、包在引號裡、或有好幾行，閘道都會當成沒設定、
   readiness 一直不就緒。換 key 時把上面的 `create` 換成
   `create … --dry-run=client -o yaml | sudo k3s kubectl replace -f -`（不用 `apply`：它會把整份
   Secret，含 key 的 base64，另外寫進 `kubectl.kubernetes.io/last-applied-configuration`
   註記，key 就多了一份副本），再
   `sudo k3s kubectl -n sch001-ai rollout restart deployment/ai-gateway`（key 只在啟動時讀一次）。
2. 建映像檔並換版：`ai-gateway/deploy/k3s/build-image.sh`。用到的檔案與 manifest 都要先 commit；
   腳本會把 `app.yaml` 的 image 換成這次的 tag 再套用。腳本不會 commit，換版成功後自己把那一行
   commit，否則下一次執行會因為 manifest 有沒 commit 的改動而停下。
   換版失敗時（`rollout status` 等了 180 秒還沒就緒，腳本就直接結束），Deployment 會停在新版的
   spec 上，要手動退回上一版：`sudo k3s kubectl -n sch001-ai rollout undo deployment/ai-gateway`，
   並用 `git checkout` 還原 `app.yaml`（腳本只改了 image 那一行）。
3. 確認：`curl http://10.43.0.87:8787/readyz` 回 200；`sudo k3s kubectl -n sch001-ai logs deployment/ai-gateway`
   的 START 一行列出設定與任務。readyz 只檢查 key 與上游網址有沒有設定、是不是正在關機，key 錯了
   或連不到 WinLab 時照樣回 200。要確認連得上，送一個學習啟動包的任務，看最後一個事件是不是
   `done`（會真的用到 GPU，WinLab 忙的時候要等一兩分鐘）：

   ```bash
   curl -sN -H 'Origin: https://thc1006.github.io' -H 'Content-Type: application/json' \
     -d '{"input":{"topic":"測試"}}' http://10.43.0.87:8787/v1/tasks/starter-pack | tail -n 3
   ```

   最後是 `error` 的話，看 log 的 `UPSTREAM-ERR`：`status` 401 代表 key 不對；504 或 408 是
   WinLab 或它前面的代理逾時，`detail` 是它附的訊息。沒有 `status`、`detail` 寫著「還沒收到任何
   token」的，是閘道的時限到了 WinLab 都還沒開始回應，多半是它正忙。這兩種逾時發生在第一個
   token 之前時，學生看到的是忙線。
   從主機直接送的請求沒有 `X-Forwarded-For`，log 會多一筆 `CLIENT-IP-MISSING`，可以不理。
4. 對外開放：在主機上用 Tailscale Funnel 把公網的 HTTPS 轉到 Service 的 ClusterIP，再確認設定：

   ```bash
   sudo tailscale funnel --bg --https=443 http://10.43.0.87:8787
   tailscale funnel status
   ```

   對外網址是 `https://<機器名稱>.<tailnet 名稱>.ts.net`，`tailscale funnel status` 會列出來；
   這個網址不寫進 repo。目標要寫完整的 `http://` 網址：只寫埠號的話，Funnel 會轉到主機的
   `127.0.0.1`，那裡沒有閘道在聽，每個請求都是 502。Funnel 要跑在主機上，不能放進 pod：主機連
   ClusterIP 時來源被 masquerade 成 `10.42.0.1`，也就是 `TRUSTED_PROXIES`，閘道才會採信 Funnel
   覆寫的 `X-Forwarded-For`。從別的地方轉進來的話，所有人都落到同一個限流桶，log 會出現
   `CLIENT-IP-UNTRUSTED`。
5. 接上網站：把對外網址填進 repository variable `AI_GATEWAY_URL`，再到 Actions 對 `CI` 按
   Run workflow 重新部署網站，建置時才會寫進每頁的 `<meta name="ai-gateway-url">`（細節見根目錄的
   README）。網站的 origin 要在 `ALLOWED_ORIGINS` 裡，否則瀏覽器的預檢會被擋下。

下架時先關掉 Funnel（`sudo tailscale funnel --https=443 off`），再刪 Service 或整個命名空間。
`--bg` 的設定會一直留著，原本的位址之後可能配給別的 Service，公網的流量就轉進那裡。

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
  進行中的任務才做得完）。k3s 上的 `terminationGracePeriodSeconds`（`deploy/k3s/app.yaml`）
  又要比它多出 preStop 的 5 秒與收尾的 6 秒（中止後等錯誤送出 1 秒、等上傳中的請求 5 秒），
  否則 kubelet 會在閘道送出可重試的錯誤之前就把它砍掉。
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
扣掉輔助檔的所有 JS／TS 檔（新增測試檔時忘了加進清單會被擋下）。`node --test` 會略過清單裡
找不到的檔案，source-hygiene 被移出清單時這項比對也跟著消失，所以 CI 在跑測試之前先不經清單
直接執行它；檔案被刪或改名時 `node --test` 找不到它，以 1 結束。

`test:ai-gateway` 不加 `--test-force-exit`。這個旗標讓每個測試檔的子程序跑完就呼叫
`process.exit()`，而 POSIX 上寫進 pipe 是非同步的，還沒送到主程序的測試結果會被丟掉。
2026-10-22 在負載高的機器上重複跑，20 次裡有 1 次少回報了 3 個測試，結束碼仍是 0；拿掉
旗標之後子程序自然結束，送完結果才離開。source-hygiene 會擋下把它加回去的改動。
