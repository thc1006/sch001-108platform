# 安全性

## 回報漏洞

**請不要用公開 issue 回報安全問題** —— 那等於直接公開揭露。

請改用 GitHub 的私密回報：進入本 repo 的 **Security** 分頁 →
**Report a vulnerability**（[直接連結](https://github.com/thc1006/sch001-108platform/security/advisories/new)）。
只有維護者看得到，修好之前不會外流。

沒有 GitHub 帳號的話，寄到 <hctsai@linux.com>。

回應時間沒有 SLA —— 這是一個由個人維護的教育專案，不是商業產品。但我會盡快看。

## 這個專案的實際攻擊面

本站是**純靜態網站**（Astro 建置、部署在 GitHub Pages），沒有後端、沒有資料庫、
不收集也不儲存任何使用者資料、沒有登入。所以典型的 web 漏洞（SQL injection、
session 劫持、伺服器端 RCE）在這裡沒有對應的東西。

實際存在的風險集中在三處：

**1. 連結健康檢查的 SSRF。** `scripts/check-external-links.mjs` 會拿 repo 資料裡的
網址去連線。它有一整套防護：只允許 HTTP/HTTPS、禁止 credential、封鎖 loopback／
private／link-local／metadata 位址、每一跳 redirect 都重新驗證、限制 redirect 次數、
用 `node:http` 搭配自訂 `lookup` 釘死已驗證的 IP 以消除 DNS rebinding 的 TOCTOU
（`fetch` 做不到這件事）。它**只在 default branch 的排程／手動觸發**執行，
且**刻意不使用 `pull_request_target`**。

如果你找到繞過方法，那是真的漏洞，請回報。

**2. CI/CD 供應鏈。** 所有 GitHub Actions 都 pin 到完整 commit SHA，
倉庫層級開啟 `sha_pinning_required`。每個 job 各自宣告最小 `GITHUB_TOKEN` 權限，
倉庫預設是 `read`。部署的位元組與通過測試的位元組是同一份（artifact 一路傳遞，
`download-artifact` 的雜湊不符會直接失敗），並在部署後回頭比對線上的 commit。

**3. npm 相依的安裝期執行。** 攻擊者奪取一個相依套件的發布權限後，最短的路徑是
在 `postinstall` 裡執行程式——那會在 CI 與每一台開發機上跑起來。兩道閘門：

- `.npmrc` 的 `min-release-age=7` **搭配 `dependabot.yml` 的 `cooldown.default-days: 7`**：
  都是拒絕採用發布未滿七天的版本。2025–2026 的投毒事件多半在數小時到數日內被揪出，
  七天跨過一個週末。兩邊缺一不可——`min-release-age` 只擋本機的 install/update，
  而相依更新的主要路徑是 Dependabot，它自己算 lockfile、`npm ci` 不重新解析，
  不設 cooldown 就整個繞過去。cooldown 不套用在 security update 上，
  所以安全性修正不會因此延後。
- `package.json` 的 `allowScripts` 搭配 `strict-allow-scripts=true`：
  只有列在清單裡的套件能跑安裝腳本，其餘一律 fail-closed。目前只核准
  `esbuild`（需要它連結平台二進位），`core-js` 與 `fsevents` 都拒絕。
  核准是**釘版本**的，所以 esbuild 一升版 `npm ci` 就會紅——那是刻意的：
  唯一會在安裝期執行程式碼的套件換版本時，要有人看一眼。復原指令就印在錯誤
  訊息裡（`npm install-scripts approve esbuild`）。需要 npm 11.7+ 才生效，
  更舊的 npm 會忽略並印 unknown-config 警告。

**4. 內容正確性。** 這一項不是傳統資安，但對這個站是最實際的傷害來源：
本站提供升學政策資訊，**寫錯會影響學生的升學決策**。如果你發現任何政策敘述
與官方文件不符，那和漏洞一樣重要 —— 那個請直接開公開 issue，附上一手來源網址。

## 不算漏洞的東西

- **本機測試伺服器 `scripts/static-server.mjs`**：只綁 localhost、只在
  Playwright 測試與本機預覽時執行、不進建置產物。
- **`public/vendor/` 的第三方前端函式庫**：從 npm 相依複製而來，
  版本由 Dependabot 追蹤。回報上游套件的漏洞請到上游。
- **`http-cache-semantics` 的 GHSA-ch52-4w7c-c8xp（Dependabot alert #36）**：
  已關閉為 `not_used`。上游沒有修正版（patched: None），所以不能用升版處理；
  判定依據是**觸及不到**，不是「風險可接受」。該套件只被
  `astro/dist/assets/build/remote.js` 使用，而那個檔只由 `generate.js` 的
  `loadRemoteImage` 呼叫。本站用不到那條路徑：`src/` 內 `astro:assets`／
  `<Image>`／`<Picture>`／`getImage` 共 0 處、`astro.config.mjs` 沒有 `image` 設定、
  `dist/_astro` 沒有任何點陣圖產物，外部圖片全部是裸 `<img src="https://…">`，
  由瀏覽器直接抓取。再者漏洞成立的前提是「多使用者共用的 HTTP 快取洩漏他人
  `Set-Cookie`」，而本站是建置在單租戶 CI 的純靜態站，沒有多使用者也沒有 cookie，
  該套件只存在於建置期相依、不隨站台發布。
  **上游釋出修正版時 Dependabot 會重新開啟，屆時照常升版即可。**

- **缺少安全性 response header**：GitHub Pages 不支援自訂 response header，
  這是平台限制。但 CSP 不受此限——Astro 7 可以把政策寫成
  `<meta http-equiv="content-security-policy">`。所以**站上沒有 CSP 是還沒做，
  不是平台擋住**。這個站載入 js.puter.com、Google Fonts、placehold.co、
  api.dicebear.com、images.pexels.com 等外部來源，allowlist 要先盤清楚再動。
