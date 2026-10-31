# ai-gateway

網站的 AI 功能由這個服務提供。它是不用任何 npm 套件的 Node 程式，跑在實驗室主機的 k3s 上，
代替學生的瀏覽器呼叫 WinLab 的自架模型（預設 `qwen3.8-27b-fp8`）。

```
學生的瀏覽器 → Tailscale Funnel（主機上）→ ai-gateway（k3s）→ WinLab
```

瀏覽器不能直接呼叫 WinLab。key 寫進公開的 JavaScript 就等於公開；WinLab 的 key 也只接受校內
網段的來源 IP，這台主機在白名單內，學生在家或用行動網路時不在。

瀏覽器只送任務名稱與輸入：`POST /v1/tasks/<任務>`，body 是 `{"input": {...}}`。prompt、輸出
格式與上限都由閘道決定，進度與結果用 SSE 串回去。任務清單在 `src/task-catalog.mjs`，端點與事件
寫在 `src/server.mjs` 的開頭。

## 設定

設定全部來自環境變數，啟動時讀一次。清單與預設值寫在 `src/config.mjs` 的檔頭與
`loadServerConfig` 上方，範圍見各個 `toInt` 的引數；k3s 上的值在 `deploy/k3s/app.yaml`。
數值不合法時退回預設並警告；key 或 `LLM_UPSTREAM` 不合法時當成沒有設定，`/readyz` 回 503。

下面幾組值要一起改：

- `LLM_MAX_ROUNDS`、`LLM_TASK_TIMEOUT_MS`、`SHUTDOWN_GRACE_MS`：任務的時限要容得下所有輪數；
  換版時要等進行中的任務做完，所以 `SHUTDOWN_GRACE_MS` 不能比任務時限短（比較短時啟動會記
  `CONFIG`）。`app.yaml` 的 `terminationGracePeriodSeconds` 要再多出 preStop 的 5 秒與收尾的
  6 秒；前端 `public/shared/platform-ai.js` 的 `DEFAULT_TASK_TIMEOUT_MS` 要比 `BODY_TIMEOUT_MS`、
  `QUEUE_TIMEOUT_MS` 與任務時限加起來更長（不夠長時啟動會記 `CONFIG`）。
- `HEARTBEAT_MS` 與 `platform-ai.js` 的 `IDLE_TIMEOUT_MS`：前端 60 秒沒收到任何位元組就當成斷線，
  所以心跳最慢 30 秒一次。
- `LLM_CONCURRENCY`：WinLab 的 key 同時只收 8 個請求，ahp-match 用同一把 key。兩邊合計不能超過 8，
  預設各 4 個，已經用滿。
- `LLM_MODEL`：換模型時，`LLM_CONTEXT_TOKENS` 照新模型改，`src/upstream.mjs` 的
  `MAX_CHARS_PER_TOKEN` 依新的詞表重新量過。

## 部署

manifest 與腳本在 `deploy/k3s/`，下面的指令都在 repo 根目錄執行。命名空間強制 Pod Security
restricted，網路預設全部拒絕，開了哪些連線見 `namespace.yaml` 與 `app.yaml`。

### 第一次部署

1. 建命名空間與 key 的 Secret。key 不進 git，也不放環境變數，以檔案掛進 pod：

   ```bash
   sudo k3s kubectl apply -f ai-gateway/deploy/k3s/namespace.yaml
   read -rsp 'LLM API key：' KEY; echo
   printf '%s' "$KEY" | sudo k3s kubectl -n sch001-ai create secret generic ai-gateway-env \
     --from-file=LLM_API_KEY=/dev/stdin
   unset KEY
   ```

   檔案裡只能有 key 本身。多行、寫成 `LLM_API_KEY=…` 或包在引號裡，閘道都當成沒有設定，
   啟動時的警告會說是哪一種。
2. 執行 `ai-gateway/deploy/k3s/build-image.sh`，見「換版」。
3. 照「檢查」確認閘道連得到 WinLab。
4. 在主機上用 Tailscale Funnel 把公網的 HTTPS 轉到 Service：

   ```bash
   ip=$(sudo k3s kubectl -n sch001-ai get svc ai-gateway -o jsonpath='{.spec.clusterIP}')
   sudo tailscale funnel --bg --https=443 "http://$ip:8787"
   tailscale funnel status
   ```

   目標要寫完整的 http 網址。只寫埠號的話，Funnel 會轉到主機的 127.0.0.1，每個請求都是 502。
   Funnel 要跑在主機上：只有從主機連進來時，來源位址才在 `TRUSTED_PROXIES` 裡，閘道才採信
   `X-Forwarded-For`；否則所有人共用一份限流額度，log 會出現 `CLIENT-IP-UNTRUSTED`。對外網址由
   `tailscale funnel status` 列出，不寫進 repo。Service 的 clusterIP 固定寫在 `app.yaml`，建立後
   不能修改；要換位址得先刪掉 Service 再套用，Funnel 也要改指新的位址。
5. 把對外網址填進 repository variable `AI_GATEWAY_URL`，到 Actions 對 CI 按 Run workflow 重新
   部署網站。網站的 origin 要列在 `ALLOWED_ORIGINS`，否則瀏覽器的預檢會被擋下。

主機上的其他程序與 hostNetwork 的 pod 連進閘道時，來源位址和 Funnel 相同，它們送的
`X-Forwarded-For` 一樣會被採信。這是已知的取捨，見 `app.yaml` 的 `ai-gateway-ingress`。

### 換版

`ai-gateway/deploy/k3s/build-image.sh` 以目前的 commit 當 tag 建映像檔並換版。建置用到的檔案與
manifest 要先 commit。腳本會改 `app.yaml` 的 image 但不會 commit：換版成功後把那一行 commit，
否則下一次執行會停下。換版成功後，腳本只留這次的、各 ReplicaSet 用的和還有 pod 在用的映像檔；
在換版前停下或清到一半失敗時，舊版可能以 `<none>` 留著，用 `sudo k3s crictl images` 與
`buildah images` 找出來手動刪。

舊 pod 收到刪除之後，會把進行中的任務做完才結束，最多 920 秒。這段期間再換版，舊 pod、目前的
pod 和新 pod 合計最多 12 個並行，不算 ahp-match 就已經超過 key 的 8 個上限。所以腳本遇到還在
收尾的 pod 會列出來並停下，等它們從 `get pods` 消失再執行。`rollout restart` 與 `rollout undo`
不經過這個檢查，執行前先跑 `ai-gateway/deploy/k3s/terminating-pods.sh`。等不了的時候用
`ALLOW_ROLLOUT_OVERLAP=1 ai-gateway/deploy/k3s/build-image.sh`，代價是 WinLab 可能回 429：
第一輪遇到的學生看到忙線，接續輪退避重試。

要看換版造成的 429，在舊 pod 收尾時把它的 log 存下來，pod 刪除之後就讀不到了：

```bash
sudo k3s kubectl -n sch001-ai logs -f <舊 pod 的名稱> > old-pod.log
```

新 pod 就緒到舊 pod 最後一筆 `TASK` 之間，兩個 pod 都在呼叫 WinLab。起點是新 pod 的 `Ready`
condition 的 `lastTransitionTime`（`get pod -o yaml` 的 `status.conditions`），至少比舊 pod 的
`SHUTDOWN` 早 15 秒：新 pod 就緒滿 10 秒（`minReadySeconds`）舊 pod 才收到刪除，再過 5 秒的
preStop 才記 `SHUTDOWN`。這段時間兩個 pod 的 `UPSTREAM-ERR` 裡 `status=429` 的，要和平時分開看。
接續輪的 429 退避重試成功時不記 `UPSTREAM-ERR`，只算進 `TASK` 的 `retries`。新 pod 的 log 用
`--since-time` 取，它只精確到秒，取出來再依每行開頭的 UTC 時間篩一次。

### 換 key

```bash
read -rsp 'LLM API key：' KEY; echo
printf '%s' "$KEY" | sudo k3s kubectl -n sch001-ai create secret generic ai-gateway-env \
  --from-file=LLM_API_KEY=/dev/stdin --dry-run=client -o yaml | sudo k3s kubectl replace -f -
unset KEY
ai-gateway/deploy/k3s/terminating-pods.sh && sudo k3s kubectl -n sch001-ai rollout restart deployment/ai-gateway
```

用 `replace` 而不用 `apply`：`apply` 會把整份 Secret 另外寫進 `last-applied-configuration`
註記，key 就多了一份副本。key 只在啟動時讀，所以要 restart。

### 退版

`build-image.sh` 等了 180 秒新 pod 還沒就緒就結束，Deployment 會停在新版。退回上一版：

```bash
ai-gateway/deploy/k3s/terminating-pods.sh && sudo k3s kubectl -n sch001-ai rollout undo deployment/ai-gateway
git checkout ai-gateway/deploy/k3s/app.yaml
```

Deployment 只留一個舊的 ReplicaSet，`rollout undo` 只退得回它。`rollout restart` 也會產生新的
ReplicaSet，restart 之後直接 undo 只會退回同一版；換版逾時、沒有 undo 就再換版的話，undo 退回的
是逾時的那一版。

### 檢查

```bash
ip=$(sudo k3s kubectl -n sch001-ai get svc ai-gateway -o jsonpath='{.spec.clusterIP}')
curl -s -o /dev/null -w '%{http_code}\n' "http://$ip:8787/readyz"
sudo k3s kubectl -n sch001-ai logs deployment/ai-gateway
```

`/readyz` 回 200 只代表有 key、上游網址合法、沒在關機；key 錯了或連不到 WinLab 時照樣是 200。
log 的 `START` 一行列出任務、允許的 origin、怎麼取用戶端 IP，以及 key 有沒有載入。

要確認連得到 WinLab，送一個真的任務，最後一個事件應該是 `done`。這會用到 GPU，WinLab 忙的時候
要等一兩分鐘：

```bash
ip=$(sudo k3s kubectl -n sch001-ai get svc ai-gateway -o jsonpath='{.spec.clusterIP}')
curl -sN -H 'Origin: https://thc1006.github.io' -H 'Content-Type: application/json' \
  -d '{"input":{"topic":"測試"}}' "http://$ip:8787/v1/tasks/starter-pack" | tail -n 3
```

最後是 `error` 的話，看 log 的 `UPSTREAM-ERR`。`status=401` 是 key 不對；408、504 是 WinLab 或
它前面的代理逾時；沒有 `status`、`reason` 寫著「還沒收到任何 token」的，是 WinLab 忙到閘道的
時限到了都還沒開始回應。`BREAKER state=open` 是連續兩個任務連回應標頭都沒等到就逾時，之後
30 秒新任務直接回忙線；`state=closed` 是又收到了回應。從主機直接送的請求沒有 `X-Forwarded-For`，
log 會多一筆 `CLIENT-IP-MISSING`，不用理會。

log 一行一筆。每個任務結束時記一行 `TASK`（結果、輪數、token 數與各階段的耗時），JSON 任務
寫完卻不合格時記 `JSON-REJECT`。學生的輸入與模型的輸出不進 log；上游錯誤欄位裡符合代號形狀的
短字串例外，見 `src/upstream.mjs` 的 `upstreamToken`。

### 下架

先關掉 Funnel（`sudo tailscale funnel --https=443 off`），再刪 Service 或整個命名空間。`--bg`
的設定會一直留著，Service 的位址之後可能配給別的 Service，公網的流量就會轉進那裡。

## 測試

```bash
npm run test:ai-gateway
```

測試打本機的假 WinLab（`test/fake-upstream.mjs`），不連外網，也不需要 key；CI 的 AI Gateway
Tests 跑的就是這一條。新增的測試檔要加進 `package.json` 的 `test:ai-gateway`，
`test/source-hygiene.test.mjs` 會比對清單與 `test/` 底下的檔案。
