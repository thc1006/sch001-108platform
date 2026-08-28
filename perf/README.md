# perf/ —— 字型載入效能的量測工具

這裡的東西**不在建置流程裡，也不在 CI 裡**。它是一次性的分析工具，會入版控的理由
只有一個：本 PR 的每一個數字都是量出來的，而「量法」必須跟數字一起留下來，
否則下次有人想改字型策略時，只能重新猜一遍。

字型行為的長期把關者不是這裡，是 `tests/e2e/site-smoke.spec.js` 的「字型契約」——
那幾條會在每個 PR 跑。

## 為什麼需要專門的量測工具

字型改動有一種特別難抓的失效：**字型載入失敗時頁面照樣渲染**。瀏覽器安靜地退回
系統字型，畫面看起來差不多，測試全綠，傳輸位元組還會**變少**——看起來像優化成功。
所以這裡不只量位元組與 FCP，還用 CDP 的 `CSS.getPlatformFontsForNode` 問瀏覽器
「你實際上是用哪個字型把這些字畫出來的」，`isCustomFont` 可區分 webfont 與系統字型。

## 檔案

| 檔案 | 做什麼 |
|---|---|
| `apply-variant.mjs` | 把某個候選方案就地套用到 `src/`。**會改工作樹**，量完要 `git checkout -- src/` 還原 |
| `build-all.sh` | 依序套用／建置／收集每個變體到 `perf/roots/<變體>/`，每次都先還原 |
| `measure.mjs` | 冷快取＋固定節流下重複載入，收集傳輸位元組、FCP、LCP、CLS、`document.fonts.ready` |
| `layout-geom.mjs` | 1280×900 逐頁擷取每個可見元素的 x/y/w/h |
| `layout-diff.mjs` | 兩份幾何擷取的逐元素比對 |
| `layout-summary.mjs` | 把比對結果拆成「區塊元素結構變化」與「行內元素文字重排」 |
| `report.mjs` | 把 `perf/out/*.json` 整理成 PR 用的對照表 |
| `verify-caching.mjs` | 驗 GitHub Pages 的 `Cache-Control` / ETag 條件請求，以及到各主機的 RTT |

`perf/roots/`、`perf/out/`、`perf/fontsrc/`、`perf/fontout/` 是產物與大型二進位，
已在 `.gitignore` 排除。

## 量測方法（改動前後必須完全一致）

* 每次迭代開新的 `BrowserContext`，並以 CDP `Network.setCacheDisabled` 強制冷快取
  → 模擬「第一次造訪」。
* CDP `Network.emulateNetworkConditions` 固定節流（1.6 Mbps / 750 kbps / 150 ms RTT，
  即 DevTools 的 Slow 4G），CPU 節流 4×。**節流也套用在 localhost 上**——不節流的話
  本機資源是 0 ms，會系統性地誇大第三方字型的相對代價。
* 傳輸位元組取自 CDP `Network.loadingFinished` 的 `encodedDataLength`（含 header），
  不用 `performance.getEntriesByType('resource').transferSize`：跨來源且沒有
  `Timing-Allow-Origin` 時後者會回報 0。
* FCP／LCP／CLS 由 `PerformanceObserver` 在 `addInitScript` 中先掛好再導航。
* 收指標前明確 `await document.fonts.ready` 再等 2.5 秒。只等 `load` 的話，節流之下
  1 MB 的 CJK 字型還沒換入就結束取樣，字型造成的 CLS 會整個量不到。
* 預設封鎖分析腳本（gtag／goatcounter），把「字型」這個受測變因隔離出來。
* 每個變體每頁 12 次，取 p50／p95。**單次量測是雜訊不是趨勢**——實測過一次 2 次取樣
  給出 FCP 4792 ms 的離群值，12 次的 p50 是 1928 ms。

## 版面回歸的控制實驗

換字型一定會動版面，所以必須先證明「量測本身不會無中生有」。
`layout-geom.mjs` 對**同一份產出**擷取兩次，再用 `layout-diff.mjs` 比對，
結果必須是 0 個元素位移。本 PR 實測：18,453 個元素、93 頁，**位移 0**。

能做到 0 是因為處理了兩件事：本站有 3 頁的卡片由 JS 渲染並帶 CSS 交錯動畫延遲，
而 `getBoundingClientRect()` 回傳的是套用 `transform` **之後**的框，
固定等待時間會抓到不同動畫影格。處理方式是
`reducedMotion: 'reduce'` 加上注入 `animation-duration: 0s !important` 等規則。
沒有這個控制實驗，就會把取樣競態誤報成真實的版面差異。
