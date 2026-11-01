// 自動偵測「狀態碼健康、內容已經換人」的網域（#117）。三態分類（dead／unverified／healthy）只看狀態碼，
// 看不出網域被接管；scripts/link-policy.json 的 hijacked 名單只擋得住有人發現、查證過的主機。
// 這裡的三個訊號不需要名單，也不需要保存狀態，彼此互補：
//   訊號 A 轉址終點跨站：抓到 www.sasmo.sg → arcade.now、hmun.org → t.tenlets.com。
//   訊號 B 內容標記：ieso-info.org 301 到同站的 www.ieso-info.org，A 看不到，但標題是「Best Online Pokies…」。
//   訊號 C HTTP 層看不到內容：hmun.org 也回過只靠 JS 轉址的殼，A、B 都看不到。
// 三個訊號都不改變三態分類，只另外報一段給人看。誤判的代價不對稱：把正常網站判成 dead
// 會讓維護者去修沒壞的東西，多報一筆可疑只是多看一眼。

/** 主機名正規化：小寫、去掉結尾的點（DNS 根標示）。 */
function host(u) {
    try {
        return new URL(u).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
        return null;
    }
}

/**
 * sameSite 判斷兩個主機名是否相同，或一個是另一個的子網域，刻意不算 eTLD+1。
 * 只取最後兩段會把 a.edu.tw 和 b.edu.tw 當成同一站，要算對又得查公共後綴清單。
 * @param {string} aHost @param {string} bHost @returns {boolean}
 */
export function sameSite(aHost, bHost) {
    if (!aHost || !bHost) return false;
    if (aHost === bHost) return true;
    return aHost.endsWith(`.${bHost}`) || bHost.endsWith(`.${aHost}`);
}

/**
 * crossSiteRedirect 是訊號 A：轉址終點離開了起點的網域時回傳 { fromHost, toHost, hops }，否則回傳 null。
 * 只看起點與終點，使用者最後到了哪裡才是被接管的實質後果；中途的主機列在 hops 裡給人判斷，不參與判定。
 * 例外是 JS 轉址：轉址鏈有 JS 轉址時，終點和起點同站也要回傳，那一跳才不會從報告上消失。
 */
export function crossSiteRedirect(startUrl, finalUrl, redirects = []) {
    const from = host(startUrl);
    const to = host(finalUrl);
    if (!from || !to || (sameSite(from, to) && !redirects.some((r) => r.via === 'js'))) return null;
    return {
        fromHost: from,
        toHost: to,
        hops: redirects.map((r) => `${host(r.from) || '?'} --${r.via === 'js' ? 'JS 轉址' : r.status}--> ${host(r.to) || '?'}`),
    };
}

/**
 * SQUAT_PHRASES 是訊號 B 的字彙表。它和 hijacked 名單一樣只抓得到已知的模式，但名單一筆只擋一台主機，
 * 蹲域名的變現手法卻集中在博弈、成人、藥品、停放待售幾類，抓這幾類就能發現還沒有人查證過的接管。
 * 一律用多字詞組，單字的誤判太多：poker 可能出現在賽局理論的競賽頁，slot 可能是 time slot。
 * 只比對 <title> 和 meta description，不掃內文：掃內文會把提到賭博成癮防治的頁面當成賭場。
 */
export const SQUAT_PHRASES = [
    // 博弈：ieso-info.org 實際命中的類別
    'online casino', 'online pokies', 'real money pokies', 'real money casino',
    'casino bonus', 'casino games', 'free spins', 'no deposit bonus',
    'betting odds', 'sports betting', 'slot machine', 'slots online',
    'poker room', 'live casino', 'crypto casino', 'gambling site',
    '線上博弈', '娛樂城', '百家樂', '老虎機', '真人荷官',
    // 成人
    'porn video', 'porn site', 'free porn', 'adult video', 'sex cam', 'xxx video',
    // 藥品垃圾
    'buy viagra', 'cialis online', 'cheap pills', 'online pharmacy',
    // 停放／待售：過期的學術網域最常見的下場
    'domain is for sale', 'buy this domain', 'this domain may be for sale',
    'parked domain', 'domain parking', 'domain for sale',
    // 借貸垃圾
    'payday loan', 'quick cash loan',
];

const TITLE_MAX = 300;
const DESC_MAX = 400;

// 不是頁面標記的部分：註解，其他 <!…> 與 <?…>（<![CDATA[ 也是，和瀏覽器一樣到第一個 > 為止），script、style 這類內容是
// 純文字的元素，開著 JS 時的 noscript，不在文件裡的 template，有自己 <title> 的 svg、math。由左到右一次掃，
// script 字串裡的 <!-- 才不會吃掉後面；沒有結尾的一路算到讀到的最後。<title> 的內容是文字，整段留下。
// 這不是解析器：屬性值裡的 <!-- 或 <script、沒有結尾的 svg 之後的 HTML 標籤、foreignObject 都會判錯。2026-10-27 錄到的完整頁面，標題和 parse5 取到的相同。
const INERT = /<!--(?:-?>|[\s\S]*?(?:--!?>|$))|<[!?][^>]*(?:>|$)|<(?:svg|math)(?=[\t\n\f\r /])[^>]*\/>|<(script|style|textarea|xmp|iframe|noembed|noframes|noscript|template|svg|math)(?=[\t\n\f\r />])[\s\S]*?(?:<\/\1(?=[\t\n\f\r />])[^>]*>|$)|(<title(?=[\t\n\f\r />])[\s\S]*?(?:<\/title(?=[\t\n\f\r />])[^>]*>|$))/gi;

/**
 * pageMarkup 拿掉 INERT 那些部分，給取 <title>、meta、h1、canonical 的規則用：註解裡的 <title>404</title> 不是頁面的標題。
 * 拿掉的地方不補空白，和瀏覽器一樣：<link<!-- -->rel=canonical> 不是 <link rel=canonical>。
 * @param {string} html @returns {string}
 */
export function pageMarkup(html) {
    return String(html).replace(INERT, (m, tag, title) => title ?? '');
}

/**
 * rawTitle 回傳 pageMarkup 留下的第一個 <title> 的內容，沒有 <title> 回傳 undefined，沒有 </title> 回傳 null。
 * 直接取 INERT 的比對結果：另外用 regex 找的話，一連串沒有結尾的 <title 會讓比對變成平方時間。
 * @param {string} html @returns {string|null|undefined}
 */
export function rawTitle(html) {
    for (const m of String(html).matchAll(INERT)) {
        if (m[2] !== undefined) return m[2].match(/^<title[^>]*>([\s\S]*?)<\/title(?=[\t\n\f\r />])[^>]*>$/i)?.[1] ?? null;
    }
    return undefined;
}

/**
 * extractHeadText 從 HTML 前綴取出 <title> 與 meta description，只看 pageMarkup 留下的部分，取不到就回空字串，不猜。
 * 引號用反向參照鎖住同一個字元。寫成 `[^"']` 的話，content="Australia's best online pokies"
 * 只取得到 "Australia"，撇號之後的字全部看不到，等於現成的規避法。2026-08-28 實測，
 * 全站 93 個含英文 description 的目標有 3 個這樣被截斷。
 * 長度上限在取出之後才套用，不寫進量詞：`{0,300}?` 超過上限時整條比對失敗，「太長」會和
 * 「沒有 title」分不開。上限的用意是別讓報告爆掉，不是別看長標題。
 */
export function extractHeadText(raw) {
    if (typeof raw !== 'string' || !raw) return { title: '', description: '' };
    const html = pageMarkup(raw);
    const t = rawTitle(raw);
    const d =
        html.match(/<meta[^>]+name=(["'])description\1[^>]*content=(["'])([\s\S]*?)\2/i)?.[3] ??
        html.match(/<meta[^>]+content=(["'])([\s\S]*?)\1[^>]*name=(["'])description\3/i)?.[2] ??
        html.match(/<meta[^>]+property=(["'])og:description\1[^>]*content=(["'])([\s\S]*?)\2/i)?.[3] ??
        '';
    const clean = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return { title: clean(t).slice(0, TITLE_MAX), description: clean(d).slice(0, DESC_MAX) };
}

/** inertText 把遠端可控的文字包成行內程式碼，`@`、`#` 和連結不會渲染；反引號換成單引號，內容就關不掉它。 */
export function inertText(s) {
    return `\`${String(s ?? '').replace(/`/g, "'")}\``;
}

/** WORDISH 是詞字元，連字號也算。用 \b 的話 - 算詞界，'free spins' 會命中「free spins-off」。 */
const WORDISH = /[A-Za-z0-9_-]/;
const IS_ASCII = /^[\x20-\x7e]+$/;

function phraseHit(hay, phrase) {
    // CJK 詞組沒有 ASCII 的詞界概念（中文不用空白分詞），直接子字串比對。
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

/** MIN_DISTINCT_PHRASES 是訊號 B 的門檻。一個詞組就報的話，「線上博弈防治研習」這類正當的教育內容也會命中。 */
export const MIN_DISTINCT_PHRASES = 2;

/**
 * contentSquatSignals 是訊號 B：標題與描述合計命中至少 MIN_DISTINCT_PHRASES 個相異詞組時，
 * 回傳每一筆命中的 { phrase, where, text }，否則回傳 []。text 是截短的原文，讓報告直接給人判斷。
 * 算的是相異詞組，不是命中次數，同一個詞在標題與描述各出現一次只算一個。真正的蹲域名頁面
 * 不會只提一次：ieso-info.org 的標題與描述命中 online pokies、real money pokies、free spins 三個。
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
    const distinct = new Set(hits.map((h) => h.phrase)).size;
    return distinct >= MIN_DISTINCT_PHRASES ? hits : [];
}

/** VISIBLE_TEXT_MAX 幾乎是零，只留給解析殘留：#125 實測的殼是 0 字，正當頁面最少也有 10 字。 */
const VISIBLE_TEXT_MAX = 4;
const JS_LOCATION = /location\s*\.\s*(?:replace|assign|href)\s*[=(]|(?:window|parent|top|self)\s*\.\s*location\s*=/i;
const META_REFRESH = /<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/i;

/**
 * visibleText 回傳拿掉 script／style／head／註解與所有標籤之後，使用者眼睛看得到的文字。
 * 結束標籤可以帶空白與屬性，瀏覽器把 `</script >`、`</script foo>` 也當成結束標籤，這裡一併比對，
 * CodeQL 的 js/bad-tag-filter 查的正是這一條。對不上的話，下面的未閉合規則會把結束標籤後面的
 * 正常內容一起吃掉，有內容的頁面可能被判成殼。沒有結束標籤時照解析器的做法吃到檔尾，
 * 不然被接管的網域少打一個結束標籤，就能讓整段 JavaScript 原始碼算進可見文字。
 */
export function visibleText(html) {
    return String(html)
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
        // 未閉合：一路吃到檔尾，與解析器的行為一致
        .replace(/<script\b[^>]*>[\s\S]*$/i, ' ')
        .replace(/<style\b[^>]*>[\s\S]*$/i, ' ')
        .replace(/<head\b[^>]*>[\s\S]*?<\/head\b[^>]*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z#0-9]{2,8};/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * opaqueShell 是訊號 C：頁面只能靠執行 JavaScript 前進，內容在 HTTP 層看不到。它不指控接管，
 * 只指出檢查器的盲區。2026-08-28 實測 hmun.org 回的是 470 bytes 的殼，用 window.location.replace
 * 轉到同一台主機，訊號 A、B 都看不到。
 * 判準是可見文字不超過 VISIBLE_TEXT_MAX、有 JS 的 location 指派、沒有 <meta refresh>，<noscript> 也沒有內容。
 * 看可見文字而不看位元組數，因為要問的是不執行 JS 的人看不看得到東西；#125 量過全站的回應大小，
 * 470 到 4228 bytes 之間沒有樣本，位元組門檻放在哪裡都是猜。只有幾個字的殼會漏掉，
 * 但訊號 C 會觸發 issue，誤判的成本比漏檢高。
 * <meta refresh> 不需要 JS 就能跟隨，www.cac.edu.tw、tpmso.k12ea.gov.tw 這類舊式轉址頁不算盲區。
 * probe 不跟隨 meta refresh，這類頁面在訊號 B 看到的是殼的 <title>，不是真正的頁面。
 * @param truncated body 沒有讀完：超過讀取上限，或有長度、chunked 的回應中途斷線。截斷的 body 看起來也像很小的殼，不確定就不報。
 */
export function opaqueShell(bodyHead, truncated = false) {
    if (typeof bodyHead !== 'string' || !bodyHead) return null;
    if (truncated) return null;
    // <noscript> 有內容，代表這一頁直接對不執行 JS 的使用者說了話，例如 SPA 的「請開啟 JavaScript」，不是盲區。
    // 結束標籤同樣要容許空白與屬性：對不上就等於找不到 noscript，正當的 SPA 反而會被標成盲區。
    const noscript = bodyHead.match(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\b[^>]*>/i);
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

// jsRedirectTarget 只認這幾種寫法，大小寫照寫；檢查器不解析 JavaScript，註解與字串裡的也算數。
const JS_SINKS = /\blocation\s*\.\s*(?:href\s*=(?!=)|replace\s*\(|assign\s*\()|\b(?:window|parent|top|self)\s*\.\s*location\s*=(?!=)/g;
// 寫死的目標：引號裡是 https:// 開頭的網址，後面只接 ; ) }、</script> 或頁尾，沒有接運算。
const LITERAL_SINK = new RegExp(`(?:${JS_SINKS.source})\\s*(["'])(https:\\/\\/[^"'\\\\\\s<>]+)\\1(?=\\s*(?:[;)}]|<\\/script\\b|$))`, 'g');
// 頁面裡有這些別的 location 寫法就不跟：認不出它們會把頁面帶去哪裡。
const OTHER_LOCATION =
    /(?<![\w$.])location\s*=(?!=)|\bdocument\s*\.\s*location\b|\blocation\s*\[|\[\s*["'`]location["'`]\s*\]|\blocation\s*\.\s*(?:host|hostname|pathname|search|hash|protocol|port)\s*=(?!=)/;
// 這些後綴底下每一台主機各屬不同的人，粗估會把它們併成同一個網域，遇到就不跟。只是常見的幾個，不是完整清單。
const SHARED_SUFFIXES = ['github.io', 'githubusercontent.com', 'herokuapp.com', 'netlify.app', 'pages.dev', 'vercel.app', 'web.app',
    'firebaseapp.com', 'blogspot.com', 'wordpress.com', 'carrd.co', 'game.tw', 'club.tw', 'ebiz.tw', 'tokyo.jp', 'osaka.jp',
    'nsw.edu.au', 'vic.edu.au', 'qld.edu.au', 'sch.uk', 'seoul.kr', 'busan.kr', 'blog.br'];

/**
 * registrableDomain 粗估主機的可註冊網域（eTLD+1），估不出來或主機在 SHARED_SUFFIXES 底下時回傳 null。
 * repo 沒有公共後綴清單：兩個字母的國碼底下、第二層只有三個字以內（com.tw、edu.tw、co.uk、go.jp）取三段，
 * 其餘取兩段。估得太細時兩站被當成不同網域，結果是不跟；估得太粗的後綴只擋得住清單上的那幾個。
 * @param {string|null} h 已正規化的主機名 @returns {string|null}
 */
export function registrableDomain(h) {
    if (!h || /^[\d.]+$/.test(h) || h.includes(':')) return null;
    if (SHARED_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`))) return null;
    const labels = h.split('.');
    const n = labels.length >= 3 && labels.at(-1).length === 2 && labels.at(-2).length <= 3 ? 3 : 2;
    return labels.length >= n ? labels.slice(-n).join('.') : null;
}

/**
 * jsRedirectTarget 回傳殼頁（見 opaqueShell）用 JS 轉去的網址，可以當成一跳轉址跟下去時才回傳，否則回傳 null。
 * 寫法只認 location.href=、location.replace(…)、location.assign(…) 與 window、parent、top、self 的 location=，
 * 註解與字串裡的也算數；每一處都要是同一個 https:// 開頭、不帶查詢字串與片段的字面網址，有別的 location 寫法就不跟。
 * 起點、殼頁與目標要在同一個可註冊網域，目標不是殼頁那台主機，例如 ctf.hitcon.org 轉到當屆的 ctf2026.hitcon.org。
 * 轉去別的組織的網域，是被接管、停放的網域常見的樣子；2026-10-26 抓的 hmun.org 殼轉回同一台主機，查詢字串帶
 * 每次重簽的 token。片段一樣能夾帶給目的頁 JS 讀的參數。這些都留給訊號 C。
 * @param {string} pageUrl @param {string} bodyHead @param {boolean} [truncated]
 * @param {string} [startUrl] 盤點的起點，預設是 pageUrl @returns {string|null}
 */
export function jsRedirectTarget(pageUrl, bodyHead, truncated = false, startUrl = pageUrl) {
    if (!opaqueShell(bodyHead, truncated) || OTHER_LOCATION.test(bodyHead)) return null;
    const sinks = bodyHead.match(JS_SINKS) ?? [];
    const targets = [...bodyHead.matchAll(LITERAL_SINK)].map((m) => m[2]);
    if (targets.length === 0 || targets.length !== sinks.length || new Set(targets).size !== 1) return null;
    let url;
    try {
        url = new URL(targets[0]);
    } catch {
        return null;
    }
    const from = host(pageUrl);
    const to = host(url.href);
    if (url.protocol !== 'https:' || url.search || url.hash || from === to) return null;
    const domain = registrableDomain(host(startUrl));
    return domain && domain === registrableDomain(from) && domain === registrableDomain(to) ? url.href : null;
}

/**
 * detectHijackSignals 把三個訊號跑在一次探測結果上，只看狀態碼低於 400 的最終回應，
 * 其餘結果已經有各自的桶子，再標一次可疑只是重複。
 * confidence 照精確度分級：有訊號 B 或 C 時是 actionable，適合觸發 issue；只有訊號 A 時
 * 是 browse-only，只放進報告給人瀏覽。2026-08-28 全站 508 個目標實測，訊號 A 的 11 個命中
 * 全是誤判，訊號 C 的 1 個命中是真陽性，細節見 check-external-links.mjs。
 */
export function detectHijackSignals(startUrl, result) {
    if (!result || result.blocked || !result.status || result.status >= 400) return null;
    const cross = crossSiteRedirect(startUrl, result.finalUrl || startUrl, result.redirects || []);
    const content = contentSquatSignals(result.bodyHead || '');
    const shell = opaqueShell(result.bodyHead || '', result.bodyTruncated === true);
    if (!cross && content.length === 0 && !shell) return null;
    const confidence = content.length > 0 || shell ? 'actionable' : 'browse-only';
    return { url: startUrl, finalUrl: result.finalUrl || startUrl, cross, content, shell, confidence };
}
