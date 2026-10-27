// 軟 404 的判定：網址回 2xx，落點卻是首頁、錯誤頁或對任何路徑都一樣的頁面（#213）。
// 判定是純函式，runSoft404 負責打同目錄的隨機路徑與命中後的重打，網路由呼叫端給的 probeFn 處理。
// 規則和門檻是 2026-10-27 對盤點 487 個網址全量量過的，見 #213 的留言。

import { randomBytes } from 'node:crypto';
import { runProbes, canonicalHost } from './link-health.lib.mjs';
import { extractHeadText, visibleText } from './hijack-signals.lib.mjs';
import { matchHijacked, matchContentCheck } from './link-policy.lib.mjs';

/** SOFT404_PROBE 是打隨機路徑時交給 runProbes 的設定。隨機路徑回 404 是預期的，不重試。 */
export const SOFT404_PROBE = Object.freeze({ concurrency: 4, budgetMs: 2 * 60_000, readBodyBytes: 16 * 1024, retryIf: () => false });
/** RECHECK 是命中之後重打的設定：等 delayMs 再打一次，預算另計。 */
export const RECHECK = Object.freeze({ delayMs: 30_000, budgetMs: 60_000 });
/** MIN_VISIBLE 是可見文字的下限。隨機路徑低於它時當成驗證頁或防火牆頁，不拿來比；網址本身低於它時列為前端殼。 */
export const MIN_VISIBLE = 200;

// 錯誤頁的路徑與標題。2026-10-27 量過：collego.edu.tw 轉到 /Login/Error404，ASP.NET 轉址帶 aspxerrorpath。
const ERROR_PATH = /(^|\/)(404|500|50x|error\d*|errors?|err|page-?not-?found|page_not_found|notfound|page-404|genericerrorpage)(\.\w+)?\/?$|aspxerrorpath/i;
// 404 與 not found 要在開頭、標點或 error 之後，EE 404、Room 404、HTTP 404 是什麼、Lost and Not Found 才不算。
// 2026-10-27 套在研究資料裡 266 個錯誤頁標題全部命中，盤點網址 0 個。只寫 Error 的只看標題，h1 常是表單的錯誤訊息。
const ERROR_TITLE = /(?:^|[^\w\s]\s*|(?:error|錯誤|status)\s*[:：]?\s*)404\b|(?:^|[^\w\s]\s*|(?:page|file)\s+)not\s*found\b|找不到(?:此|該|這個|您要的|你要的)?(?:網頁|頁面)|查無(?:此|該)?(?:網頁|頁面|頁)|頁面不存在|已無相關|網頁錯誤\s*[:：(（]?\s*\d{3}/i;
const ERROR_TITLE_ONLY = /^\s*error\s*(?:$|[|｜:：\-–])/i;
// coursemap.aca.ntu.edu.tw 的 F5 回 Request Rejected，Khan 一度回 Client Challenge，兩者都是 200。
const CHALLENGE_TITLE = /request rejected|client challenge|just a moment|attention required|access denied/i;

/** newToken 回傳一次健檢共用的隨機字串，放進每個目錄的隨機路徑。 */
export const newToken = () => `sch001-linkcheck-${randomBytes(6).toString('hex')}`;

/** isHome 判斷網址是不是首頁：路徑是 /、沒有查詢字串。首頁的存廢狀態碼看得出來，不套這些規則。 */
export function isHome(url) {
    const u = new URL(url);
    return u.pathname === '/' && !u.search;
}

/**
 * randomSibling 回傳和 url 同一個目錄的隨機路徑：最後一段換成 token，結尾是 / 的換倒數第二段，去掉查詢字串。
 * pixnet 的 /blog/post/、sites.google.com 的 /view/ 只在子目錄回 200。這類網址沒有轉址、可見文字也不少時不打，
 * 頁面刪掉了仍然抓不到。
 * @param {string} url @param {string} token @returns {string}
 */
export function randomSibling(url, token) {
    const u = new URL(url);
    const parts = u.pathname.split('/');
    const last = parts.length - 1;
    parts[parts[last] === '' && last > 1 ? last - 1 : last] = token;
    u.pathname = parts.join('/');
    u.search = '';
    u.hash = '';
    return u.href;
}

const decode = (s) => {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
};

/**
 * landing 把落點正規化成可以比的字串：主機、解碼後的路徑去掉結尾的 /，加上原樣的查詢字串，token 換成 TOKEN。
 * 查詢字串要留：iymc.info 的語系頁帶 return_to，www.hch.gov.tw 靠查詢字串分頁，去掉就會誤判。
 */
export function landing(url, token = null) {
    const u = new URL(url);
    const swap = (s) => (token ? s.split(token).join('TOKEN') : s);
    const path = swap(decode(u.pathname)).replace(/\/+$/, '') || '/';
    return `${canonicalHost(u.hostname)}${path}${u.search ? swap(u.search) : ''}`;
}

const dirPath = (p) => (decode(p).toLowerCase().replace(/\/(index|default|home)(\.\w+)?$/, '/').replace(/\/+$/, '') || '/');

/**
 * ancestorOf 判斷 other 是不是 start 的上層目錄或根目錄。other 在別的主機時只認根目錄；other 帶查詢字串時不算，
 * 那多半是語系頁或列表頁，不是上層目錄。
 * @param {string} start @param {string} other @returns {boolean}
 */
export function ancestorOf(start, other) {
    const s = new URL(start);
    const o = new URL(other);
    if (o.search) return false;
    const sp = dirPath(s.pathname);
    const op = dirPath(o.pathname);
    if (canonicalHost(s.hostname) !== canonicalHost(o.hostname)) return op === '/';
    return sp !== op && (op === '/' || sp.startsWith(`${op}/`));
}

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map((m) => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4]]));

/**
 * pageFacts 從探測結果的 body 取出規則要看的東西：title、第一個 h1、canonical（照落點解析成完整網址）、可見文字的長度。
 * body 被壓縮或沒有讀時回傳 null，probe 對壓縮的回應不給 bodyHead。
 * @param {object} r probe 的結果 @returns {{title: string, h1: string, canonical: string, visible: number, complete: boolean}|null}
 */
export function pageFacts(r) {
    if (typeof r?.bodyHead !== 'string') return null;
    const html = r.bodyHead;
    const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1\b[^>]*>/i)?.[1] ?? '';
    let canonical = '';
    for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
        const a = attrs(tag);
        if (!(a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical') || !a.href) continue;
        try {
            canonical = new URL(a.href.replace(/&amp;/g, '&'), r.finalUrl).href;
        } catch {
            canonical = '';
        }
        break;
    }
    return {
        title: extractHeadText(html).title,
        h1: h1.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200),
        canonical,
        visible: visibleText(html).length,
        complete: !r.bodyTruncated,
    };
}

const ok2 = (r) => Boolean(r) && !r.blocked && r.status >= 200 && r.status < 300;
const redirected = (r) => (r?.redirects?.length ?? 0) > 0;

/** comparable 判斷隨機路徑的結果能不能拿來比：2xx、有轉址、讀得到 body，而且不是驗證頁或防火牆頁。 */
function comparable(random) {
    if (!ok2(random) || !redirected(random)) return false;
    const f = pageFacts(random);
    return Boolean(f) && f.visible >= MIN_VISIBLE && !CHALLENGE_TITLE.test(f.title);
}

/**
 * judgeSoft404 用網址的探測結果 r 和同目錄隨機路徑的結果 random 套規則，回傳 { dead, hints }，兩者都是 { rule, reason } 的陣列。
 * dead 的四條：1 轉址落在錯誤頁路徑、2 標題或 h1 寫著找不到或 canonical 指向錯誤頁、3 canonical 指向上層目錄或根目錄、
 * 4 轉址的落點和隨機路徑相同。hints 只列進報告：5 只轉到上層目錄、6 可見文字很少，隨機路徑也直接回 200。
 * r 不是 2xx、網址是首頁時不套規則。random 是 null 時只看前三條。
 * @param {string} url @param {object} r @param {object|null} random @param {string} token
 */
export function judgeSoft404(url, r, random, token) {
    const dead = [];
    const hints = [];
    if (!ok2(r) || isHome(url)) return { dead, hints };
    const final = r.finalUrl ?? url;
    const f = pageFacts(r);
    const fu = new URL(final);
    const su = new URL(url);
    // 落點的錯誤頁路徑是起點本來就有的那一段（/api/errors 補尾斜線、搬到 /v2/api/errors）時不算。
    const errSeg = (p) => decode(p).match(ERROR_PATH)?.[2]?.toLowerCase();
    const fromStart = errSeg(su.pathname) !== undefined && errSeg(su.pathname) === errSeg(fu.pathname);
    if (redirected(r) && ((ERROR_PATH.test(decode(fu.pathname)) && !fromStart) || ERROR_PATH.test(decode(fu.search)))) {
        dead.push({ rule: 1, reason: `轉址落在錯誤頁 ${final}` });
    }
    if (f && (ERROR_TITLE.test(f.title) || ERROR_TITLE_ONLY.test(f.title) || ERROR_TITLE.test(f.h1))) {
        dead.push({ rule: 2, reason: `頁面寫著找不到（標題：${f.title.slice(0, 80)}${f.h1 ? `，h1：${f.h1.slice(0, 80)}` : ''}）` });
    } else if (f?.canonical && ERROR_PATH.test(decode(new URL(f.canonical).pathname)) && dirPath(new URL(f.canonical).pathname) !== dirPath(su.pathname)) {
        dead.push({ rule: 2, reason: `canonical 指向錯誤頁 ${f.canonical}` });
    }
    if (f?.canonical && ancestorOf(url, f.canonical) && dirPath(fu.pathname) !== dirPath(new URL(f.canonical).pathname)) {
        dead.push({ rule: 3, reason: `canonical 指向上層目錄或根目錄 ${f.canonical}` });
    }
    if (redirected(r) && comparable(random) && landing(final) === landing(random.finalUrl, token)) {
        dead.push({ rule: 4, reason: `落點和同目錄的隨機路徑相同：${final}` });
    }
    if (dead.length) return { dead, hints };
    if (redirected(r) && ancestorOf(url, final)) hints.push({ rule: 5, reason: `轉到上層目錄或根目錄 ${final}` });
    // SiteGround 的驗證頁回 202、沒有可見文字，那不是前端殼，所以這條只看 200。
    if (r.status === 200 && f?.complete && f.visible < MIN_VISIBLE && !CHALLENGE_TITLE.test(f.title) && random?.status === 200 && !random.blocked && !redirected(random)) {
        hints.push({ rule: 6, reason: `可見文字只有 ${f.visible} 字，同目錄的隨機路徑也回 ${random.status}` });
    }
    return { dead, hints };
}

/**
 * soft404Candidates 列出要套規則的網址：頁面回 2xx、不是首頁，主機不在 hijacked，也不是 contentChecks 裡寫了 API 的網址或
 * 沒有 missingTitles 的主機。回傳 { index, url, random }，random 是要打的隨機路徑，只有轉址過或可見文字很少的網址才打，
 * 其餘是 null。missingTitles 的主機不打，隨機路徑由 missing-titles.lib.mjs 打，這裡只套第 1 到 3 條。
 * @param {{url: string}[]} targets @param {(object|null)[]} results @param {{hijacked?: object[], contentChecks?: object[]}} policy
 * @param {string} token
 */
export function soft404Candidates(targets, results, policy, token) {
    const apiHosts = new Set((policy.contentChecks ?? []).filter((c) => !c.missingTitles).map((c) => c.match.host));
    const titleHosts = new Set((policy.contentChecks ?? []).filter((c) => c.missingTitles).map((c) => c.match.host));
    const out = [];
    targets.forEach(({ url }, index) => {
        const r = results[index];
        if (!ok2(r) || isHome(url) || matchHijacked(policy.hijacked, url) || matchContentCheck(policy.contentChecks, url)) return;
        const host = canonicalHost(new URL(url).hostname);
        if (apiHosts.has(host)) return;
        const f = pageFacts(r);
        const needRandom = !titleHosts.has(host) && (redirected(r) || Boolean(f?.complete && f.visible < MIN_VISIBLE));
        out.push({ index, url, random: needRandom ? randomSibling(url, token) : null });
    });
    return out;
}

const sameRules = (a, b) => a.filter((x) => b.some((y) => y.rule === x.rule));

/**
 * runSoft404 對 targets 套軟 404 的規則，回傳 { verdicts, randoms, randomsSkipped, randomsFailed, recheckSkipped }。verdicts[i] 對應 targets[i]，
 * 不套規則的是 null，其餘是 { verdict, rules, reason }：verdict 是 dead、unverified（命中卻沒有兩次一致）、hint 或 healthy。
 * 隨機路徑照（主機、目錄）只打一次。命中 dead 的等 delayMs 再打網址一次，第 4 條連隨機路徑也重打，兩次都命中的規則才算數。
 * randomsSkipped 是預算用完沒打的隨機路徑數，recheckSkipped 是沒重打完的網址數，兩者都要算進覆蓋不完整。
 * randomsFailed 是逾時、連不上或回 5xx 的隨機路徑數，只寫進報告。
 * @param {object} opts probeFn、allowLoopback、sleep，以及蓋過 SOFT404_PROBE、RECHECK 的設定
 */
export async function runSoft404(targets, results, policy, token, opts = {}) {
    const { probeFn, allowLoopback, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
    const probeCfg = { ...SOFT404_PROBE, ...opts.probe, probeFn, allowLoopback };
    const recheck = { ...RECHECK, ...opts.recheck };
    const cands = soft404Candidates(targets, results, policy, token);
    const randomUrls = [...new Set(cands.map((c) => c.random).filter(Boolean))];
    const { results: rr, skipped: randomsSkipped } = await runProbes(randomUrls, probeCfg);
    const randomOf = new Map(randomUrls.map((u, i) => [u, rr[i]]));
    const randomsFailed = rr.filter((x) => x && !x.blocked && (x.status === 0 || x.status >= 500)).length;

    const verdicts = new Array(targets.length).fill(null);
    const first = cands.map((c) => ({ c, j: judgeSoft404(c.url, results[c.index], c.random ? randomOf.get(c.random) : null, token) }));
    const hits = first.filter((x) => x.j.dead.length);
    for (const { c, j } of first) {
        if (!j.dead.length) verdicts[c.index] = j.hints.length ? { verdict: 'hint', rules: j.hints.map((h) => h.rule), reason: j.hints.map((h) => h.reason).join('；') } : { verdict: 'healthy', rules: [] };
    }
    const recheckSkipped = hits.length ? await recheckHits(hits, verdicts, randomOf, token, probeCfg, recheck, sleep) : 0;
    return { verdicts, randoms: randomUrls.length, randomsSkipped, randomsFailed, recheckSkipped };
}

/** recheckHits 等 delayMs 之後重打命中的網址，把判定寫進 verdicts，回傳預算用完沒重打的筆數。 */
async function recheckHits(hits, verdicts, randomOf, token, probeCfg, recheck, sleep) {
    await sleep(recheck.delayMs);
    const again = hits.map((h) => h.c.url);
    const againRandoms = [...new Set(hits.filter((h) => h.j.dead.some((d) => d.rule === 4)).map((h) => h.c.random))];
    const all = [...again, ...againRandoms];
    const { results: re } = await runProbes(all, { ...probeCfg, budgetMs: recheck.budgetMs });
    const reRandom = new Map(againRandoms.map((u, i) => [u, re[again.length + i]]));
    let recheckSkipped = 0;
    hits.forEach(({ c, j }, k) => {
        const r2 = re[k];
        const random2 = c.random ? (reRandom.has(c.random) ? reRandom.get(c.random) : randomOf.get(c.random)) : null;
        // 第 4 條的隨機路徑沒重打到時，不拿第一次的結果代替。
        if (!r2 || (reRandom.has(c.random) && !random2)) {
            recheckSkipped++;
            verdicts[c.index] = { verdict: 'unverified', rules: j.dead.map((d) => d.rule), reason: `${j.dead[0].reason}，時間預算用完，沒有重打確認` };
            return;
        }
        const both = sameRules(judgeSoft404(c.url, r2, random2, token).dead, j.dead);
        verdicts[c.index] = both.length
            ? { verdict: 'dead', rules: both.map((d) => d.rule), reason: both.map((d) => d.reason).join('；') }
            : { verdict: 'unverified', rules: j.dead.map((d) => d.rule), reason: `${j.dead[0].reason}，重打一次沒有再命中` };
    });
    return recheckSkipped;
}
