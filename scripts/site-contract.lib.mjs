/**
 * 站台契約檢查的純函式核心
 * --------------------------------------------------------------
 * 為什麼需要自己寫，而不是把更多 glob 丟給 lychee：
 *
 * lychee 是「連結檢查器」，它回答的是「這個 URL 解析得到東西嗎」。但本站有幾類
 * 契約它在語意上表達不了：
 *
 *   1. GitHub Pages 的目錄語意——`/foo/` 必須有 `foo/index.html`，不是目錄存在
 *      就算數。lychee 未給 --index-files 時只檢查目錄是否存在。
 *   2. 同源絕對網址——canonical、og:url、og:image、JSON-LD 都是
 *      `https://thc1006.github.io/sch001-108platform/...`，語意上是站內，但 scheme
 *      是 https，會被 --scheme file 整批排除。scheme ≠ origin。
 *   3. Runtime JSON reference——頁面在瀏覽器 fetch JSON 後才產生 <img>/<a>，那些
 *      相對路徑要相對「消費它的頁面」解析，而不是 JSON 自己的位置。plain-text
 *      擷取無法保留這個 base。
 *   4. 自我一致性——canonical 必須指向自己、每頁只能有一個 main#main-content。
 *      這根本不是連結檢查。
 *
 * 因此本檔負責站台契約，lychee 留作第二層 defense-in-depth。
 */

/** 允許但不需要檢查存在性的 scheme。 */
const IGNORED_SCHEMES = new Set(['mailto:', 'tel:', 'data:', 'blob:', 'about:']);
/** 一律視為錯誤的 scheme（可執行內容）。 */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'vbscript:']);

/**
 * 由 dist 的檔案清單建立「部署後 URL → 實體檔案」的對照。
 *
 * Astro 的 build.format:'preserve' 規則：
 *   dist/index.html      → {base}/
 *   dist/foo.html        → {base}/foo.html
 *   dist/foo/index.html  → {base}/foo/
 *   dist/picture/a.png   → {base}/picture/a.png
 *
 * @param {string[]} files dist 相對路徑（使用 / 分隔）
 * @param {string} base 例如 '/sch001-108platform'
 */
export function buildRouteMap(files, base) {
    const b = base.replace(/\/$/, '');
    /** @type {Map<string,string>} URL path → dist 相對路徑 */
    const routes = new Map();
    const distFiles = new Set(files);

    for (const f of files) {
        const url = `${b}/${f}`;
        routes.set(url, f);
        // index.html 另外提供目錄式 URL
        if (f === 'index.html') routes.set(`${b}/`, f);
        else if (f.endsWith('/index.html')) routes.set(`${b}/${f.slice(0, -'index.html'.length)}`, f);
    }
    return { routes, distFiles, base: b };
}

/** decodeURIComponent 對畸形 percent-encoding 會 throw；一律走這個安全版本。 */
function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value; // 解不開就保留原樣，後續查不到時會被當成錯誤回報，而不是讓整支崩潰
    }
}

/**
 * 把一個 reference 正規化成「站內 URL path」或判定為站外／忽略／非法。
 *
 * scheme 的判定一律以「解析後的 protocol」為準，不能只比對原始字串前綴。
 * WHATWG URL parser 會剝除 URL 中的換行與 tab，因此 `java\nscript:alert(1)`
 * 會被正規化成 `javascript:`——若只做字串前綴比對，這個值會漏過檢查而被當成
 * 「非 http(s) 故忽略」，等於靜默接受可執行內容。
 *
 * @param {string} ref 原始 href/src 值
 * @param {string} fromUrl 來源頁面的部署 URL path（例如 /sch001-108platform/foo/）
 * @param {{base:string, site:string}} ctx site 例如 'https://thc1006.github.io'
 * @returns {{kind:'internal'|'external'|'ignored'|'invalid', path?:string, fragment?:string, url?:string, reason?:string}}
 */
export function classifyReference(ref, fromUrl, ctx) {
    const rawRef = String(ref ?? '').trim();
    if (rawRef === '') return { kind: 'ignored', reason: '空值' };
    if (rawRef.includes('\0')) return { kind: 'invalid', reason: '含 NUL 字元' };

    // 純 fragment：指向來源頁自己。href="#" 是常見的 no-op 寫法，不視為 anchor 參照。
    if (rawRef.startsWith('#')) {
        const frag = safeDecode(rawRef.slice(1));
        return frag === ''
            ? { kind: 'ignored', reason: '空 fragment（no-op 連結）' }
            : { kind: 'internal', path: fromUrl, fragment: frag };
    }

    let u;
    try {
        // 以來源頁的絕對 URL 為 base 解析。relative、root-relative 與協定相對
        // （//host/path）都由 URL 解析處理——協定相對若指向本站，仍必須當成站內
        // 檢查，不能因為寫法不同就跳過。
        u = new URL(rawRef, `${ctx.site}${fromUrl}`);
    } catch {
        return { kind: 'invalid', reason: `無法解析的網址：${rawRef}` };
    }

    // 以解析後的 protocol 判定，避免上述換行／tab 繞過
    if (FORBIDDEN_SCHEMES.has(u.protocol)) {
        return { kind: 'invalid', reason: `不允許的 scheme：${u.protocol}` };
    }
    if (IGNORED_SCHEMES.has(u.protocol)) return { kind: 'ignored', reason: u.protocol };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        // 未知 scheme 不靜默忽略——寧可報出來人工判斷，也不要再開一個繞過孔
        return { kind: 'invalid', reason: `未預期的 scheme：${u.protocol}` };
    }
    if (u.username || u.password) return { kind: 'invalid', reason: '網址不得內嵌帳號密碼' };

    const siteOrigin = new URL(ctx.site).origin;
    if (u.origin !== siteOrigin) return { kind: 'external', url: u.toString() };

    // 同源：必須落在 base namespace 內，否則是逸出專案路徑的錯誤
    const b = ctx.base.replace(/\/$/, '');
    if (u.pathname !== b && !u.pathname.startsWith(`${b}/`)) {
        return { kind: 'invalid', reason: `同源網址逸出 base namespace：${u.pathname}` };
    }
    const frag = u.hash ? safeDecode(u.hash.slice(1)) : undefined;
    return {
        kind: 'internal',
        path: u.pathname,
        fragment: frag === '' ? undefined : frag,
    };
}


/**
 * 檢查站內 URL path 是否真的對應到一份部署得出來的檔案。
 * 目錄式 URL（結尾為 /）必須有 index.html——這正是 lychee 未給 --index-files
 * 時會漏掉的那一類。
 *
 * @returns {{ok:true, file:string}|{ok:false, reason:string}}
 */
export function resolveInternalPath(urlPath, routeMap) {
    const decoded = safeDecode(urlPath);
    if (decoded.includes('..')) return { ok: false, reason: '路徑含 .. 逸出' };

    const hit = routeMap.routes.get(decoded);
    if (hit) return { ok: true, file: hit };

    // 目錄式 URL 但沒有 index.html：明確指出，而不是含糊說「找不到」
    if (decoded.endsWith('/')) {
        const dirPrefix = decoded.slice(routeMap.base.length + 1);
        const anyInDir = [...routeMap.distFiles].some((f) => f.startsWith(dirPrefix));
        if (anyInDir) return { ok: false, reason: '目錄存在但缺少 index.html' };
    }
    return { ok: false, reason: '找不到對應的部署檔案' };
}

/** 從 HTML 抽出所有 id 與 legacy a[name]，供 fragment 檢查。 */
export function collectAnchors($) {
    const ids = new Set();
    $('[id]').each((_, el) => {
        const v = $(el).attr('id');
        if (v) ids.add(v);
    });
    $('a[name]').each((_, el) => {
        const v = $(el).attr('name');
        if (v) ids.add(v);
    });
    return ids;
}

/** srcset="a.png 1x, b.png 2x" → ['a.png','b.png'] */
export function parseSrcset(value) {
    return String(value ?? '')
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean);
}

/** CSS 中的 url(...)，忽略 data: 與絕對外部網址由 classifyReference 再判斷。 */
export function parseCssUrls(css) {
    const out = [];
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let m;
    while ((m = re.exec(String(css ?? ''))) !== null) out.push(m[2].trim());
    return out;
}

/**
 * 遞迴走訪 JSON，回傳 { pointer, value } 供錯誤訊息定位到確切欄位。
 * pointer 採 RFC 6901 形式（/competitions/17/url），比「第幾筆」好追。
 */
export function walkJsonStrings(node, pointer = '', out = []) {
    if (typeof node === 'string') {
        out.push({ pointer, value: node });
        return out;
    }
    if (Array.isArray(node)) {
        node.forEach((v, i) => walkJsonStrings(v, `${pointer}/${i}`, out));
        return out;
    }
    if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            walkJsonStrings(v, `${pointer}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, out);
        }
    }
    return out;
}
