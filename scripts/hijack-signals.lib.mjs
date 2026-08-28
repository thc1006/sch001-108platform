/**
 * 自動偵測「狀態碼健康、內容已經換人」的網域（#117）
 * ================================================================
 * 三態分類（dead／unverified／healthy）只看狀態碼，對網域被接管**結構性失明**。
 * scripts/link-policy.json 的 hijacked 名單堵住了目前已知的四台主機，但名單只能堵
 * 已知的——每一筆都要有人先發現、查證、寫 evidence。
 *
 * 這支提供兩個**不需要名單、不需要存狀態**的訊號。它們是互補的，缺一不可：
 *
 *   訊號 A（轉址終點跨網域）  抓到 www.sasmo.sg → arcade.now、hmun.org → t.tenlets.com
 *   訊號 B（內容標記）        抓到 ieso-info.org（301 → www.ieso-info.org，**同網域**，
 *                             所以訊號 A 看不到它；title 是「Best Online Pokies…」）
 *
 * 兩個都**不改變三態分類**，只另外報一段給人看。理由是誤判的代價不對稱：把一個正常
 * 網站判成 dead 會讓維護者去「修」一個沒壞的東西，而多報一筆可疑只是多看一眼。
 */

/** 主機名正規化：小寫、去掉結尾的點（DNS 根標示）。 */
function host(u) {
    try {
        return new URL(u).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
        return null;
    }
}

/**
 * 兩個主機名是不是同一個「站」。
 *
 * 刻意**不計算 eTLD+1**。issue #117 原本把「怎麼算 eTLD+1 而不引入相依」列為前置
 * 難題——因為本站大量使用 .edu.tw／.gov.tw，簡化版「取最後兩段」會把
 * a.edu.tw 與 b.edu.tw 當成同一個網域，而那兩者是完全不同的機構。
 *
 * 但這個判斷根本不需要 eTLD+1。要問的是「轉址有沒有離開原本那台主機的網域」，
 * 用**點邊界的後綴關係**就夠：
 *
 *   ieso-info.org → www.ieso-info.org   起點是終點的後綴  → 同站（正常的 www 轉址）
 *   www.cac.edu.tw → cac.edu.tw          終點是起點的後綴  → 同站
 *   www.sasmo.sg → arcade.now            互不為後綴        → 跨站
 *   a.edu.tw → b.edu.tw                  互不為後綴        → 跨站（**正確**，那是兩個機構）
 *
 * 點邊界是必要的：沒有它的話 foo.com 會被判定為 evil-foo.com 的後綴。
 */
export function sameSite(aHost, bHost) {
    if (!aHost || !bHost) return false;
    if (aHost === bHost) return true;
    return aHost.endsWith(`.${bHost}`) || bHost.endsWith(`.${aHost}`);
}

/**
 * 訊號 A：轉址終點離開了起點的網域。
 *
 * 回傳 null（正常）或 { fromHost, toHost, hops }。
 * 只看**起點與終點**：中途經過哪裡對「使用者最後到了哪」沒有影響，而後者才是
 * 被接管的實質後果。中途的主機一併回報在 hops 裡供人判斷，但不參與判定。
 */
export function crossSiteRedirect(startUrl, finalUrl, redirects = []) {
    const from = host(startUrl);
    const to = host(finalUrl);
    if (!from || !to || sameSite(from, to)) return null;
    return {
        fromHost: from,
        toHost: to,
        hops: redirects.map((r) => `${host(r.from) || '?'} --${r.status}--> ${host(r.to) || '?'}`),
    };
}

/**
 * 訊號 B 的字彙表。
 *
 * 這是一份**拒絕清單**，和 hijacked 名單一樣有「只抓得到已知模式」的先天限制——
 * 但它的泛化能力完全不同：一個主機名只擋一台主機，而蹲域名的變現手法高度集中在
 * 少數幾個垂直領域（博弈、成人、藥品、停放待售）。抓那幾個模式就涵蓋了絕大多數
 * 未來會發生的接管，不需要有人先發現。
 *
 * **一律用多字詞組，不用單字。** 單字在教育網站的連結集合裡誤判率太高：
 * 「poker」可能出現在賽局理論的競賽頁、「slot」可能是「time slot」、
 * 「porn」可能出現在媒體識讀的討論。詞組（'poker room'、'slot machine'）幾乎
 * 不可能出現在正當的競賽官網標題裡。
 *
 * 只比對 <title> 與 meta description，不比對整份 body：標題是刻意寫的、很短，
 * 訊噪比遠高於內文；掃內文會把「某頁提到賭博成癮防治」誤判成賭場。
 */
export const SQUAT_PHRASES = [
    // 博弈——ieso-info.org 實際命中的類別
    'online casino', 'online pokies', 'real money pokies', 'real money casino',
    'casino bonus', 'casino games', 'free spins', 'no deposit bonus',
    'betting odds', 'sports betting', 'slot machine', 'slots online',
    'poker room', 'live casino', 'crypto casino', 'gambling site',
    '線上博弈', '娛樂城', '百家樂', '老虎機', '真人荷官',
    // 成人
    'porn video', 'porn site', 'free porn', 'adult video', 'sex cam', 'xxx video',
    // 藥品垃圾
    'buy viagra', 'cialis online', 'cheap pills', 'online pharmacy',
    // 停放／待售——過期的學術網域最常見的下場
    'domain is for sale', 'buy this domain', 'this domain may be for sale',
    'parked domain', 'domain parking', 'domain for sale',
    // 借貸垃圾
    'payday loan', 'quick cash loan',
];

/**
 * 從 HTML 前綴取出 <title> 與 meta description。取不到就回空字串，不猜。
 *
 * ── 兩條規則都是實測逼出來的 ──
 *
 * **引號一定要用反向參照鎖住同一個字元**，不可以用 `[^"']` 這種「兩種引號都排除」
 * 的字元類別。後者會把 content 截在**內容裡的撇號**上：
 *
 *   content="Australia's best online pokies"   →  取到的只有 "Australia"
 *
 * 實測（2026-08-28，全站 93 個含英文 description 的目標）有 3 個被這樣截斷：
 * iymc.info（196→244 字）、pmc.ncbi.nlm.nih.gov（124→166）、drivendata.org（143→164）。
 * 對訊號 B 而言這不只是少幾個字——撇號之後的字全部看不到，等於一個現成的規避法。
 *
 * **長度上限要在抽取「之後」才套用，不可以寫進正則的量詞。** `{0,300}?` 這種寫法
 * 在超過上限時不是截斷，而是**整條比對失敗**、回空字串——「太長」與「沒有 title」
 * 在下游長得一模一樣。上限的用意是別讓報告爆掉，不是別看長標題。
 */
const TITLE_MAX = 300;
const DESC_MAX = 400;
export function extractHeadText(html) {
    if (typeof html !== 'string' || !html) return { title: '', description: '' };
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const d =
        html.match(/<meta[^>]+name=(["'])description\1[^>]*content=(["'])([\s\S]*?)\2/i)?.[3] ??
        html.match(/<meta[^>]+content=(["'])([\s\S]*?)\1[^>]*name=(["'])description\3/i)?.[2] ??
        html.match(/<meta[^>]+property=(["'])og:description\1[^>]*content=(["'])([\s\S]*?)\2/i)?.[3] ??
        '';
    const clean = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { title: clean(t && t[1]).slice(0, TITLE_MAX), description: clean(d).slice(0, DESC_MAX) };
}

/**
 * 把**遠端可控**的文字變成 markdown 的惰性字串。
 *
 * 訊號 B 的 `text` 與訊號 C 的 `title` 是從外部站台的 <title>／description 抓來的，
 * 而報告會被 `gh issue create --body-file` 原樣送進 issue body——那是一個帶著
 * `issues: write` 的 job 在貼一段**攻擊者寫的**內容。實測：一個把 <title> 設成
 *
 *   Online Casino @thc1006 @github see #72 and [Click to claim](https://evil.example/phish)
 *
 * 的被接管網域，可以讓看門狗的 issue 真的 @ 那些人、在 #72 留下 cross-reference、
 * 並貼出一條看起來像維護者自動化貼的釣魚連結。這正是這三個訊號**唯一保證**會
 * 命中的場合：命中的定義就是那台主機不可信。
 *
 * 包成行內程式碼就夠了：`@`、`#`、`[]()` 在 code span 裡都不會被渲染。反引號本身
 * 先換成單引號，否則內容可以自己把 code span 關掉。
 */
export function inertText(s) {
    return `\`${String(s ?? '').replace(/`/g, "'")}\``;
}

/**
 * 詞界：連字號**算詞字元**。
 *
 * 純子字串比對不夠——寫測試的反例當場抓到 'free spins' 命中
 * 「Sign up for the free spins-off workshop」。JS 的 \b 也擋不住，因為 `-` 對 \b
 * 而言是詞界。把連字號納入詞字元集合，複合詞就穿不過去了：
 *
 *   'free spins' vs 'free spins-off workshop'  → 後面接 '-'  → 不命中 ✅
 *   'free spins' vs 'Enjoy free spins today'   → 後面接 ' '  → 命中   ✅
 */
const WORDISH = /[A-Za-z0-9_-]/;
const IS_ASCII = /^[\x20-\x7e]+$/;

function phraseHit(hay, phrase) {
    // CJK 詞組沒有 ASCII 的詞界概念（中文不用空白分詞），直接子字串比對。
    // 這些詞組本身夠長（娛樂城、百家樂、真人荷官），不會出現在正當的教育內容裡。
    if (!IS_ASCII.test(phrase)) return hay.includes(phrase);
    let i = hay.indexOf(phrase);
    while (i !== -1) {
        const before = i > 0 ? hay[i - 1] : '';
        const after = i + phrase.length < hay.length ? hay[i + phrase.length] : '';
        // 字串邊界（空字串）不是詞字元，所以開頭／結尾的命中一樣算數
        if (!WORDISH.test(before) && !WORDISH.test(after)) return true;
        i = hay.indexOf(phrase, i + 1);
    }
    return false;
}

/**
 * 訊號 B：標題／描述命中蹲域名的變現詞組。
 *
 * 回傳 [] 或 [{ phrase, where, text }]。text 是命中的原文（截斷），讓報告可以
 * 直接呈現給人判斷，而不是只說「可疑」。
 */
/**
 * 至少要**兩個相異詞組**才算命中。
 *
 * 第一版只要一個就報，敵意複查用這個站自己會有的內容打破了它：
 *
 *   「青少年網路成癮與線上博弈防治研習」          → 線上博弈
 *   「博弈產業與觀光管理學術研討會：娛樂城的社會成本」 → 娛樂城
 *   「機率論競賽：百家樂與二十一點的期望值分析」    → 百家樂
 *   「真人荷官詐騙手法解析 - 警政署宣導」          → 真人荷官
 *   「Slot Machine Psychology and Responsible Gaming Education」
 *   「Payday Loan Traps: Financial Literacy Competition」
 *
 * 這些全是正當的教育內容，而且本站已經有 finance/inquiry.md 這類金融素養主題——
 * 未來新增一個防詐或機率論競賽的連結就會踩到。
 *
 * 兩個詞組的門檻把它們全部濾掉，而真正的蹲域名頁面不會只提一次：
 * ieso-info.org 的標題「Best Online Pokies in Australia 2026 - Play For Real Money」
 * 命中 3 個。**用相異詞組計數，不是命中次數**——同一個詞在標題與描述各出現一次
 * 不該算成兩個。
 */
export const MIN_DISTINCT_PHRASES = 2;

export function contentSquatSignals(html) {
    const { title, description } = extractHeadText(html);
    const hits = [];
    for (const [where, text] of [['title', title], ['description', description]]) {
        if (!text) continue;
        const hay = text.toLowerCase();
        for (const phrase of SQUAT_PHRASES) {
            if (phraseHit(hay, phrase)) hits.push({ phrase, where, text: text.slice(0, 160) });
        }
    }
    const distinct = new Set(hits.map((h) => h.phrase)).size;
    return distinct >= MIN_DISTINCT_PHRASES ? hits : [];
}

/**
 * 訊號 C：這個網址在 HTTP 層**看不到內容**。
 *
 * 這一條刻意不指控「被接管」，它陳述的是**檢查器的盲區**——這正是這個 repo 一路在
 * 修的那個病：「healthy」在這裡只代表伺服器答了，不代表使用者看得到正常內容。
 *
 * 實測動機：hmun.org（已知被接管）在 HTTP 層回的是 470 bytes 的殼——
 *
 *   <html><head><title>Loading...</title></head><body><script>
 *   window.location.replace('https://hmun.org/?ch=1&js=<JWT>&sid=...')</script></body></html>
 *
 * 轉址目標是**同一台主機**帶 JWT 參數，所以訊號 A 看不到；沒有任何變現詞彙，
 * 所以訊號 B 也看不到。真正的變現發生在 JS 執行之後，非 JS 的探測器**在原理上**
 * 到不了那裡。
 *
 * 與其再猜一種接管樣態（樣本只有一個，那是在雜訊上調參），不如照實說：
 * 這個網址的內容無法在 HTTP 層驗證。對一個競賽官網來說，那本身就值得看一眼。
 *
 * 判準是**「唯一的前進方式需要執行 JavaScript」**，三個條件同時成立：
 *
 *   1. body 很小（正常的競賽官網不會只有 2KB）
 *   2. 有 JS 的 location 指派
 *   3. **沒有** <meta refresh>
 *
 * 第三個條件是關鍵，而且是實測逼出來的。第一版只有前兩條，對照組立刻出現兩個誤判：
 *
 *   www.cac.edu.tw      248 bytes  <meta refresh> → /cacportal/index.php  title「大學甄選入學委員會」
 *   tpmso.k12ea.gov.tw  235 bytes  <meta refresh> → /home/               title「Welcome to Taiwan Olympiad Portal」
 *   hmun.org            470 bytes  只有 window.location.replace →帶 JWT＋session id  title「Loading...」
 *
 * 前兩個是正當的舊式轉址頁：**`<meta refresh>` 不需要 JS 就能跟隨**，所以那些頁面的
 * 內容並沒有對檢查器隱藏——只是這支目前沒有去跟。第三個沒有 meta refresh，
 * 非 JS 的客戶端**在原理上**前進不了。
 *
 * 已知限制：有 meta refresh 的殼，這支目前不跟過去，所以訊號 B 看到的是殼的
 * <title> 而不是真正的頁面。要補的話是讓 probe 也跟隨 meta refresh——那是探測
 * 語意的變更，不屬於這個 issue 的範圍。
 */
/**
 * 「沒有可見內容」的門檻（字元）。
 *
 * 第一版用的是「body < 2048 bytes」。那個數字是靠**單一樣本**（hmun.org 470B）
 * 定的，敵意複查量了全站：470 與 4228 之間一個樣本都沒有，門檻就落在那個空隙裡，
 * 而 2.5KB 的殼會直接漏掉。位元組數從來不是我們真正想問的東西。
 *
 * 真正想問的是註解本來就宣稱的那件事：**使用者不執行 JS 的話看得到東西嗎？**
 * 所以改成「把 script／style／head 與所有標籤拿掉之後，剩下的可見文字少於這個長度」。
 *
 * 這同時修掉複查抓到的一批誤判：SPA 空殼有 <noscript> 提示、語系選擇頁有兩個
 * 按鈕、報名導向頁有一個按鈕——那些頁面**使用者看得到東西**，不是盲區。
 */
/**
 * 這個數字**不是調出來的門檻，是「幾乎等於零」**——只留給解析殘留（實體、空白）。
 *
 * 實測三種殼的可見文字：apho.org 0 字、hmun.org 0 字。而被複查打破的那些正當頁面
 * 最少的是語系選擇頁的「中文 English」10 字。刻意不取兩者中間的某個值——那會變成
 * 又一個靠少數樣本調出來的門檻（第一版的 2048 bytes 就是那樣來的，而全站量測顯示
 * 470 與 4228 之間根本沒有樣本）。
 *
 * 取 4 的意思是「可見文字必須實質為零」。代價是一個只有幾個字的殼會被漏掉——
 * 那個代價可以接受：訊號 C 是會觸發 issue 的那一個，誤判的成本遠高於漏檢。
 */
const VISIBLE_TEXT_MAX = 4;
const JS_LOCATION = /location\s*\.\s*(?:replace|assign|href)\s*[=(]|(?:window|parent|top|self)\s*\.\s*location\s*=/i;
const META_REFRESH = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i;

/** 拿掉 script／style／head／註解與所有標籤之後，使用者眼睛看得到的文字。 */
export function visibleText(html) {
    return String(html)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<head[\s\S]*?<\/head>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z#0-9]{2,8};/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param truncated body 是不是被截斷了（連線中途斷掉）。截斷的 body 看起來會像
 *   一個很小的殼，但那是**我們沒讀完**，不是頁面真的沒內容。複查實測：伺服器在
 *   body 中途 RST 時，一個宣稱 content-length: 200000 的頁面會以 202 bytes
 *   resolve 成 status 200，而報告會照樣寫「回應只有 202 bytes」。
 *   不確定的時候不要報——那正是這整支在防的東西。
 */
export function opaqueShell(bodyHead, truncated = false) {
    if (typeof bodyHead !== 'string' || !bodyHead) return null;
    if (truncated) return null;
    // <noscript> 有內容 ＝ 這一頁**直接對不執行 JS 的使用者說了話**。那正是
    // 「唯一的前進方式需要執行 JS」的反面，不需要再看長度。
    // 這一條是複查用 SPA 空殼打破長度門檻之後補的：那種頁面的 <noscript> 寫著
    // 「請開啟 JavaScript 才能使用本站的報名系統」——使用者看得到，不是盲區。
    const noscript = bodyHead.match(/<noscript[^>]*>([\s\S]*?)<\/noscript>/i);
    if (noscript && visibleText(noscript[1]).length > 0) return null;
    const bytes = Buffer.byteLength(bodyHead, 'utf8');
    const visible = visibleText(bodyHead);
    if (visible.length > VISIBLE_TEXT_MAX) return null;
    if (!JS_LOCATION.test(bodyHead)) return null;
    // 有 meta refresh ＝ 不需要 JS 也走得下去，不是盲區
    if (META_REFRESH.test(bodyHead)) return null;
    const { title } = extractHeadText(bodyHead);
    return { bytes, visible: visible.length, title: title.slice(0, 80) };
}

/**
 * 把三個訊號跑在一次探測結果上。
 *
 * 只在 result 是「最終回應且狀態健康」時才有意義——dead／blocked 已經有各自的
 * 桶子，再標一次可疑只是重複。
 */
export function detectHijackSignals(startUrl, result) {
    if (!result || result.blocked || !result.status || result.status >= 400) return null;
    const cross = crossSiteRedirect(startUrl, result.finalUrl || startUrl, result.redirects || []);
    const content = contentSquatSignals(result.bodyHead || '');
    const shell = opaqueShell(result.bodyHead || '', result.bodyTruncated === true);
    if (!cross && content.length === 0 && !shell) return null;
    // 訊號的精確度差很多，呼叫端要分得開。實測（全站 508 個目標）：
    //   訊號 A 跨站轉址   11 個命中、**全部是誤判**（機構改名、兄弟子網域、短網址）
    //   訊號 B 內容標記    0 個命中（名單已經先攔下 ieso-info.org）
    //   訊號 C HTTP 盲區   1 個命中、**真陽性**（apho.org 已成 GoDaddy 待售停放頁）
    // 所以 A 只適合放進報告給人瀏覽，不適合觸發 issue；B 與 C 才適合。
    const confidence = content.length > 0 || shell ? 'actionable' : 'browse-only';
    return { url: startUrl, finalUrl: result.finalUrl || startUrl, cross, content, shell, confidence };
}
