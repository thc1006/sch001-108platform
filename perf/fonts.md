# 自架字型資產（`public/fonts/`）

`public/fonts/` 裡的 woff2 不是建置產生的，是**手動產出後入版控**的。原因與重現方式寫在下面。

> **這份文件的位置**：說明刻意不放 `public/fonts/`——`public/` 會被 Astro 原樣複製到
> `dist/` 並發布上線，開發文件不該出現在
> `https://…/sch001-108platform/fonts/README.md`。同理 `latin-range.txt`
> （子集化的輸入）也放這裡。只有 OFL 授權全文留在 `public/fonts/`：OFL 要求授權必須
> 隨字型一起散布，那兩個檔案**必須**跟著部署。
>
> 也不放 `docs/`——那個目錄在 `.gitignore` 裡，是「一次性工作文件、不入版控」。
>
> **注意**：`perf/` 其餘內容自陳是一次性的量測工具，日後可能整個移除；
> **這一份與 `latin-range.txt` 是例外，描述的是已上線的資產，移除工具時要留下它們。**

## 為什麼要自架

站台原本從 Google Fonts 載入 `Inter` 與 `Noto Sans TC`。實測（見 #118）：
首頁單頁要下載 **1,240 KB** 的字型，佔整頁傳輸量 **73.5%**；學群頁更高達 **93.1%**。
其中幾乎全部是漢字。

漢字那一份改用使用者裝置上既有的系統字型，拉丁字仍用 Inter，於是：

* 首頁字型傳輸量 1,240.2 KB → **51.5 KB**（競賽頁另含 Space Mono，共 80.0 KB）
* 第三方連線（fonts.googleapis.com、fonts.gstatic.com）→ **0**

漢字改用系統字型在**水平方向**是安全的：實測 Noto Sans TC、Microsoft JhengHei、
Microsoft JhengHei UI、Microsoft YaHei 的**漢字前進寬都是 1.000 em**。

但**字重會退化**，這是系統字型方案的固有代價，不是實作缺陷：Microsoft JhengHei
家族只安裝 Light(300)/Regular(400)/Bold(700)，macOS 的 PingFang TC 最粗到 Bold(700)。
所以 CSS 的 `font-weight: 900/800`（`font-black`/`font-extrabold`）在漢字上會落到
Bold，`500`（`font-medium`）在 Windows 上會落到 Regular。實測數字見 #118。

## 字型堆疊裡有幾個「死條目」

`src/styles/global.css` 的 body 堆疊刻意寫得比實際會命中的多，因為同一份 CSS 要
覆蓋所有平台。以下條目在特定瀏覽器上永遠不會命中，留著只是為了覆蓋其他平台，
**不要以為它們在生效**：

* Chrome/Edge 完全不認 `-apple-system`（Blink 的 `font_family_names.json5` 只有
  `BlinkMacSystemFont`）
* Safari／iOS 上 `'PingFang TC'` 永遠碰不到：WebKit 的 `effectiveFamilyAt()` 會把
  `-apple-system` 展開成整條 CoreText cascade，漢字在那一步就被接走了，結果由
  `lang` 決定
* Android 上 `'Noto Sans CJK TC'` 永遠比對失敗：`fonts.xml` 的 CJK family 沒有
  `name` 屬性，Skia 的 `onMatchFamilyStyle()` 只查 `fNameToFamilyMap`

## `<html lang="zh-Hant">` 是繁簡字形的最後一道防線

漢字交給系統字型之後，`lang` 從「SEO／無障礙屬性」變成**排版正確性的相依項**。
堆疊裡的繁中字型若在使用者裝置上全部不存在，落到通用 `sans-serif` 時是繁是簡
完全由瀏覽器的 Han script 推斷決定，而 Blink 的 `ComputeScriptForHan()` 推斷不
出來時**預設簡體**。`tests/e2e/site-smoke.spec.js` 的字型契約有一條在釘這件事。

## 檔案

| 檔案 | 來源 | 子集範圍 | 大小 |
|---|---|---|---:|
| `public/fonts/Inter-subset.woff2` | google/fonts `ofl/inter/Inter[opsz,wght].ttf` | Google Fonts 的 `latin` unicode-range | 52,584 B |
| `public/fonts/SpaceMono-400.woff2` | google/fonts `ofl/spacemono/SpaceMono-Regular.ttf` | 同上 | 14,324 B |
| `public/fonts/SpaceMono-700.woff2` | google/fonts `ofl/spacemono/SpaceMono-Bold.ttf` | 同上 | 14,456 B |

`Inter-subset.woff2` 保留 `wght` 可變軸（400–900），因此 `font-weight: 600`／`800`
會渲染成**真正的** 600／800。原本從 Google Fonts 只取 400;500;700;900 四個離散字重時，
CSS 字型比對會把 600 往上吃到 700（實測 CDP `CSS.getPlatformFontsForNode` 回報
`Inter-Bold`），全站 224 處 `font-semibold` 都比設計意圖更粗。

子集**刻意涵蓋整個 `latin` unicode-range，而不是只涵蓋目前內容用到的字元**。
只涵蓋現有字元的話，日後新增一個帶重音的字母就會掉出子集、掉回系統字型，
而且沒有任何測試會抓到。

## 重現方式

需要 Python 的 fontTools（含 brotli），**不是** repo 的相依套件，也不在建置流程裡。
以下指令假設在一個暫存目錄執行：

```sh
pip install 'fonttools[woff]' brotli
cp perf/latin-range.txt .

# 取得上游原始檔
curl -L -o 'Inter[opsz,wght].ttf'  'https://raw.githubusercontent.com/google/fonts/main/ofl/inter/Inter%5Bopsz,wght%5D.ttf'
curl -L -o SpaceMono-Regular.ttf   'https://raw.githubusercontent.com/google/fonts/main/ofl/spacemono/SpaceMono-Regular.ttf'
curl -L -o SpaceMono-Bold.ttf      'https://raw.githubusercontent.com/google/fonts/main/ofl/spacemono/SpaceMono-Bold.ttf'

# Inter：固定 opsz、保留 wght 400–900
python -m fontTools.varLib.instancer 'Inter[opsz,wght].ttf' 'opsz=drop' 'wght=400:900' -o Inter-vf.ttf
python -m fontTools.subset Inter-vf.ttf --unicodes-file=latin-range.txt \
  --flavor=woff2 --layout-features='*' --output-file=Inter-subset.woff2

# Space Mono：兩個靜態字重
python -m fontTools.subset SpaceMono-Regular.ttf --unicodes-file=latin-range.txt \
  --flavor=woff2 --layout-features='*' --output-file=SpaceMono-400.woff2
python -m fontTools.subset SpaceMono-Bold.ttf --unicodes-file=latin-range.txt \
  --flavor=woff2 --layout-features='*' --output-file=SpaceMono-700.woff2

# 產物放回 public/fonts/
```

`perf/latin-range.txt` 的內容就是 Google Fonts 的 `latin` 子集範圍：

```
U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC,
U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191,
U+2193, U+2212, U+2215, U+FEFF, U+FFFD
```

## 授權

Inter 與 Space Mono 都是 SIL Open Font License 1.1。授權全文見
`public/fonts/Inter-OFL.txt` 與 `public/fonts/SpaceMono-OFL.txt`——OFL 要求授權條款
必須隨字型一起散布，所以那兩個檔案會跟著部署，**不能刪，也不能移出 `public/`**。

兩者的著作權宣告都**沒有** "with Reserved Font Name" 條款（Inter 是
「Copyright 2020 The Inter Project Authors」、Space Mono 是「Copyright 2016 The Space
Mono Project Authors」），因此子集化後沿用 `Inter` / `Space Mono` 這兩個家族名合乎授權。
