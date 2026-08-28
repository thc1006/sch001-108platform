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

/** 從 HTML 前綴取出 <title> 與 meta description。取不到就回空字串，不猜。 */
export function extractHeadText(html) {
    if (typeof html !== 'string' || !html) return { title: '', description: '' };
    const t = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
    const d =
        html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{0,400})["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']{0,400})["'][^>]*name=["']description["']/i) ||
        html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']{0,400})["']/i);
    const clean = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { title: clean(t && t[1]), description: clean(d && d[1]) };
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
    return hits;
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
const SHELL_MAX_BYTES = 2048;
const JS_LOCATION = /location\s*\.\s*(?:replace|assign|href)\s*[=(]|(?:window|parent|top|self)\s*\.\s*location\s*=/i;
const META_REFRESH = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i;

export function opaqueShell(bodyHead) {
    if (typeof bodyHead !== 'string' || !bodyHead) return null;
    const bytes = Buffer.byteLength(bodyHead, 'utf8');
    if (bytes > SHELL_MAX_BYTES) return null;
    if (!JS_LOCATION.test(bodyHead)) return null;
    // 有 meta refresh ＝ 不需要 JS 也走得下去，不是盲區
    if (META_REFRESH.test(bodyHead)) return null;
    const { title } = extractHeadText(bodyHead);
    return { bytes, title: title.slice(0, 80) };
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
    const shell = opaqueShell(result.bodyHead || '');
    if (!cross && content.length === 0 && !shell) return null;
    return { url: startUrl, finalUrl: result.finalUrl || startUrl, cross, content, shell };
}
