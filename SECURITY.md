# 安全性

## 回報漏洞

**請不要用公開 issue 回報安全問題** —— 那等於直接公開揭露。

請改用 GitHub 的私密回報：進入本 repo 的 **Security** 分頁 →
**Report a vulnerability**（[直接連結](https://github.com/thc1006/sch001-108platform/security/advisories/new)）。
只有維護者看得到，修好之前不會外流。

沒有 GitHub 帳號的話，寄到 <hctsai@linux.com>。

回應時間沒有 SLA —— 這是一個由個人維護的教育專案，不是商業產品。但我會盡快看。

## 這個專案的實際攻擊面

網站本身是**純靜態網站**（Astro 建置、部署在 GitHub Pages），沒有資料庫、沒有登入，
站上也不儲存使用者資料，所以典型的 web 漏洞（SQL injection、session 劫持）在網站這一側
沒有對應的東西。這個專案唯一的後端是 AI 閘道，另外在下一節說明。

網站這一側實際存在的風險集中在這幾處：

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
  七天跨過一個週末。兩個值要一起改：Dependabot 取兩者較大的天數當 cooldown
  （dependabot-core#15132），它更新 lockfile 時也沿用 `.npmrc`，npm 只會選滿七天的
  版本，間接相依也一樣。security update 不套用 cooldown，Dependabot 偵測得到 npm
  版本時還會帶 `--min-release-age=0` 略過 `.npmrc`。偵測不到時 `.npmrc` 照樣生效，
  發布未滿七天的修正要等滿七天，或手動帶 `--min-release-age=0` 升級。
  `--min-release-age=0` 作用在整次 `npm update`，同一個套件的其他副本也會升到相依範圍
  允許的最新版，不論那是不是修正版：#182 修 undici 7.x 時，unifont 底下的 8.x 就這樣
  升到發布才五天、不是修正版的 8.12.3。遇到這種情況，在 `min-release-age=7` 下自己跑
  `npm update <套件> --package-lock-only`，只會取到滿七天的版本（#186）。
- `package.json` 的 `allowScripts` 搭配 `strict-allow-scripts=true`：
  只有列在清單裡的套件能跑安裝腳本，其餘一律 fail-closed。目前只核准
  `esbuild`（需要它連結平台二進位），`core-js` 與 `fsevents` 都拒絕。
  核准是**釘版本**的，所以 esbuild 一升版 `npm ci` 就會紅——那是刻意的：
  唯一會在安裝期執行程式碼的套件換版本時，要有人看一眼。復原指令就印在錯誤
  訊息裡（`npm install-scripts approve esbuild`）。

  **這道閘門會靜默失效，所以它自己也要被把關。** 實測下限是 **npm 11.16.0**：
  11.15.0 把 `strict-allow-scripts` 當成未知設定，只印一行警告，缺核准的
  esbuild 照裝、`npm ci` exit 0；11.16.0 才回 `ESTRICTALLOWSCRIPTS`。
  環境變數或使用者層 `.npmrc` 也能把它蓋成 false，而專案檔原封不動。
  `scripts/check-install-gate.mjs` 因此在每次建置時驗這些：

  - **能力探測**：從沒有專案 `.npmrc` 的目錄問 npm 的內建預設，確認它真的認得
    這兩個設定。只比版本號擋不住「未來某版把設定改名或移除」——那時版本照樣夠新，
    功能卻沒了。
  - **npm 自己回報的**設定值（不是 `.npmrc` 寫了什麼），因為環境變數與使用者層
    設定都蓋得掉。
  - lock 裡每個 `hasInstallScript` 的套件是否都被核准或拒絕過。這一項與 npm 版本
    無關，是舊 npm 上唯一還有效的防線。核准清單裡的孤兒條目也會被擋，避免規則
    活得比前提久。
  - **每一筆相依都解析自 `registry.npmjs.org`。** 這條不只是潔癖：`hasInstallScript`
    只涵蓋 `install`／`preinstall`／`postinstall`——npm 的判定就寫在 arborist 的
    `isolated-classes.js`，`prepare` **不在裡面**。而 npm 對 git 相依會執行
    `prepare`，於是一個 git 相依可以在安裝期跑程式卻不帶旗標，核准清單完全看不到它。
    同一條規則一併擋掉任意 tarball 與被掉包的 registry，那兩者也讓
    `npm audit signatures` 驗不到。目前 367 筆相依全部來自官方 registry。
  - **根 `package.json` 自己的安裝期 script**（見下）。

  故障注入矩陣見 `check-install-gate.faults.mjs`（25 格，含「檢查自己變全盲」
  與「不該擋的要放行」兩類反例）；每一條規則都做過突變測試，拿掉任何一條都會
  讓矩陣翻紅。

  **它在 CI 裡每次 `npm ci` 之前都先跑。** 這不是風格問題：閘門擋的是
  安裝期執行的程式，等 `npm ci` 跑完才驗，該跑的早就跑完了。這支檢查只用 node
  內建模組、不需要 `node_modules`，才放得進那個位置。建置鏈裡也留了一份，
  讓本機與任何不經過 CI 的路徑同樣會被擋。

- **根 `package.json` 的安裝期 script 不受 allowScripts 管。** 這是實測出來的：
  `strict-allow-scripts=true` 之下，在根 `package.json` 加一行 `postinstall`，
  `npm ci` 照樣執行它、exit 0、閘門完全不出聲。也就是一個惡意 PR 只要加一行，
  就能在 CI 與每台開發機上執行程式，繞過整道閘門。本專案目前沒有任何
  `preinstall`／`install`／`postinstall`／`prepare`，而上面那支檢查會確保
  它維持如此——真的需要時必須連同理由明示放行。

  `package.json` 的 `engines.npm` 另外在**安裝期**就先警告。沒有設
  `engine-strict`——那會讓舊 npm 連裝都裝不了，而要防的是「以為有保護其實沒有」，
  不是阻止別人碰這個 repo。

**4. 內容正確性。** 這一項不是傳統資安，但對這個站是最實際的傷害來源：
本站提供升學政策資訊，**寫錯會影響學生的升學決策**。如果你發現任何政策敘述
與官方文件不符，那和漏洞一樣重要 —— 那個請直接開公開 issue，附上一手來源網址。

## AI 閘道

網站的 AI 功能都走自架的閘道（`ai-gateway/`）。它跑在實驗室主機的 k3s 上，
經 Tailscale Funnel 對外公開 `POST /v1/tasks/<任務>`，手上有 WinLab 的 API key，背後是有限的
GPU。架構、限流與部署方式見 `ai-gateway/README.md`。

下面這些屬於漏洞，請用上面的私密管道回報：key 外洩或推得出來；繞過限流或排隊，長時間佔住
GPU；讓任務做指令以外的事（prompt injection），或讓它對任意 prompt 回答；讓閘道當掉，例如
耗盡記憶體或 CPU；log 裡出現學生的輸入或模型的輸出。

已知的取捨，不算漏洞：限流依來源 IP 計算，擋不住握有很多 IP 的人，同一間學校的學生也共用
一份額度。閘道閒著時，一個來源可以拿走全部名額，每個最長佔到任務的時限；任務的時限比排隊
上限（`QUEUE_TIMEOUT_MS`）長時，其他人會排到逾時。主機上的任何程序與 hostNetwork 的 pod 都能
偽造 `X-Forwarded-For`，閘道分不出它們和 Funnel（見 `ai-gateway/README.md` 的「部署」）。

學生在改走閘道的 AI 功能裡輸入的文字，會經閘道送到 WinLab 的模型服務產生回答。閘道不儲存
輸入與輸出。log 一行一筆，記任務代號、結果、輪數、token 用量與耗時，用戶端只記位址的雜湊
（每次啟動換一次鹽，反推不回 IP）；輸入與輸出的內容不進 log，上游回了壞掉的串流時也只記
長度與開頭的字元。

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

- **`postcss-selector-parser` 的 GHSA-rj75-hqrm-r3gf（Dependabot alert #37）**：
  已關閉為 `tolerable_risk`。這個漏洞要在請求流程中解析攻擊者送來的選擇器才會觸發；
  本站只在建置時由 `@tailwindcss/typography` 解析它自己內建的選擇器，GHSA 也寫明
  建置期處理可信來源不受影響。typography 最新的 0.5.20 固定相依 6.0.10，修正版 7.1.6
  只能用 overrides 強制跨 major 升級，所以先不升。6.x 的修正版 6.1.5 收進 GHSA、
  而且發布滿 7 天（2026-10-26 23:02 以後），就改用同 major 的 override 升級。

- **缺少安全性 response header**：GitHub Pages 不支援自訂 response header，
  這是平台限制。但 CSP 不受此限——Astro 7 可以把政策寫成
  `<meta http-equiv="content-security-policy">`。所以**站上沒有 CSP 是還沒做，
  不是平台擋住**。這個站載入 Google Fonts、placehold.co、
  api.dicebear.com、images.pexels.com 等外部來源，allowlist 要先盤清楚再動。
