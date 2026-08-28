# public/fonts —— 自架字型資產

這裡的 woff2 不是建置產生的，是**手動產出後入版控**的。原因與重現方式都寫在下面。

## 為什麼要自架

站台原本從 Google Fonts 載入 `Inter` 與 `Noto Sans TC`。實測（見 本 PR）：
首頁單頁要下載 **1,240 KB** 的字型，佔整頁傳輸量 **73.5%**；學群頁更高達 **93.1%**。
其中幾乎全部是漢字。

漢字那一份改用使用者裝置上既有的系統字型（PingFang TC / Microsoft JhengHei /
Noto Sans CJK TC），拉丁字仍用 Inter，於是：

* 字型傳輸量 1,240 KB → **37 KB**
* 第三方連線（fonts.googleapis.com、fonts.gstatic.com）→ **0**

漢字改用系統字型在版面上是安全的：實測 Noto Sans TC、Microsoft JhengHei、
Microsoft JhengHei UI 的**漢字前進寬都是 1.000 em**，水平方向本來就對齊。

## 檔案

| 檔案 | 來源 | 子集範圍 | 大小 |
|---|---|---|---:|
| `Inter-subset.woff2` | google/fonts `ofl/inter/Inter[opsz,wght].ttf` | Google Fonts 的 `latin` unicode-range | 52,584 B |
| `SpaceMono-400.woff2` | google/fonts `ofl/spacemono/SpaceMono-Regular.ttf` | 同上 | 14,324 B |
| `SpaceMono-700.woff2` | google/fonts `ofl/spacemono/SpaceMono-Bold.ttf` | 同上 | 14,456 B |

`Inter-subset.woff2` 保留 `wght` 可變軸（400–900），因此 `font-weight: 600`／`800`
會渲染成**真正的** 600／800。原本從 Google Fonts 只取 400;500;700;900 四個離散字重時，
CSS 字型比對會把 600 往上吃到 700（實測 CDP `CSS.getPlatformFontsForNode` 回報
`Inter-Bold`），全站 224 處 `font-semibold` 都比設計意圖更粗。

子集**刻意涵蓋整個 `latin` unicode-range，而不是只涵蓋目前內容用到的字元**。
只涵蓋現有字元的話，日後新增一個帶重音的字母就會掉出子集、掉回系統字型，
而且沒有任何測試會抓到。

## 重現方式

需要 Python 的 fontTools（含 brotli），**不是** repo 的相依套件，也不在建置流程裡：

```sh
pip install 'fonttools[woff]' brotli

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
```

`latin-range.txt` 的內容就是 Google Fonts 的 `latin` 子集範圍：

```
U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC,
U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191,
U+2193, U+2212, U+2215, U+FEFF, U+FFFD
```

## 授權

Inter 與 Space Mono 都是 SIL Open Font License 1.1。授權全文見同目錄的
`Inter-OFL.txt` 與 `SpaceMono-OFL.txt`——OFL 要求授權條款必須隨字型一起散布，
所以這兩個檔案會跟著部署，不能刪。
