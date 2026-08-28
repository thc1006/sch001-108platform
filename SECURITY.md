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

**3. 內容正確性。** 這一項不是傳統資安，但對這個站是最實際的傷害來源：
本站提供升學政策資訊，**寫錯會影響學生的升學決策**。如果你發現任何政策敘述
與官方文件不符，那和漏洞一樣重要 —— 那個請直接開公開 issue，附上一手來源網址。

## 不算漏洞的東西

- **本機測試伺服器 `scripts/static-server.mjs`**：只綁 localhost、只在
  Playwright 測試與本機預覽時執行、不進建置產物。
- **`public/vendor/` 的第三方前端函式庫**：從 npm 相依複製而來，
  版本由 Dependabot 追蹤。回報上游套件的漏洞請到上游。
- **缺少 CSP 等安全 header**：GitHub Pages 不支援自訂 response header，
  這是平台限制不是疏漏。
