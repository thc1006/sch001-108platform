// contentChecks 宣告了 missingTitles 的主機：不存在的頁面回 200，標題是名單裡的字（#213）。
// 頁面健康之後看標題，讀兩次都在名單裡才算失效。另外打同目錄的隨機路徑，讀兩次標題都不在名單裡，名單可能過期。
// 判定是純函式，runMissingTitles 負責重讀與隨機路徑，網路由呼叫端給的 probeFn 處理。

import { runProbes, classifyLink, isBlockedResult, describeResult, unverifiedBucket, canonicalHost } from './link-health.lib.mjs';
import { matchContentCheck, normalizeTitle, HOME_PATH } from './link-policy.lib.mjs';
import { randomSibling } from './soft404.lib.mjs';
import { inertText, rawTitle } from './hijack-signals.lib.mjs';

/**
 * TITLE_PROBE 是重讀與打隨機路徑時交給 runProbes 的設定。2026-10-27 量過：www.aesea.org 不存在的頁面 <title>
 * 在第 29 KB 左右（</head> 之後），www.designwant.com 不存在的頁面整頁約 151 KB、沒有 <title>。
 */
export const TITLE_PROBE = Object.freeze({ concurrency: 2, budgetMs: 60_000, readBodyBytes: 256 * 1024 });
/** TITLE_RECHECK 是確認的設定：標題在名單裡的網址、標題不在名單裡的隨機路徑，等 delayMs 再讀一次，預算另計。 */
export const TITLE_RECHECK = Object.freeze({ delayMs: 30_000, budgetMs: 30_000 });
/** TITLE_BUDGET_MIN 是標題檢查最多用掉的分鐘數，報告照這個寫。 */
export const TITLE_BUDGET_MIN = (TITLE_PROBE.budgetMs + TITLE_RECHECK.delayMs + TITLE_RECHECK.budgetMs) / 60_000;

const NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', middot: '·', bull: '•', hellip: '…',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™',
};
const decode = (s) =>
    s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    });
// isHtml 判斷回應的 Content-Type 是不是 HTML。PDF、JSON、純文字本來就沒有 <title>，不拿來比名單裡的 ""。
const isHtml = (r) => /html/i.test(r?.contentType ?? '');

/**
 * pageTitle 回傳頁面的標題：rawTitle 取到的第一個 <title>，解開字元參照、空白照 normalizeTitle 正規化。不限 <head>：www.aesea.org
 * 不存在的頁面把 <title> 放在 body 裡。整頁讀完沒有 <title> 回傳 ''；不是 HTML、沒讀完、<title> 沒讀到結尾、
 * 回應是空的、壓縮或沒有 body 回傳 null。
 * @param {object} r probe 的結果 @returns {string|null}
 */
export function pageTitle(r) {
    if (typeof r?.bodyHead !== 'string' || r.bodySkipped || !r.bodyHead.trim() || !isHtml(r)) return null;
    const t = rawTitle(r.bodyHead);
    if (typeof t === 'string') return normalizeTitle(decode(t));
    return r.bodyTruncated || t === null ? null : '';
}

/**
 * titleCheckFor 回傳要看標題的網址所在主機的宣告：主機宣告了 missingTitles、路徑不是 HOME_PATH（不論查詢字串）、
 * 也沒有在 urls 寫 API。
 * 其餘回傳 null。
 * @param {object[]} contentChecks validatePolicy 回傳的 contentChecks @param {string} url
 */
export function titleCheckFor(contentChecks, url) {
    let u;
    try {
        u = new URL(url);
    } catch {
        return null;
    }
    const check = (contentChecks ?? []).find((c) => c.missingTitles && c.match.host === canonicalHost(u.hostname));
    return check && !HOME_PATH.test(u.pathname) && !matchContentCheck([check], url) ? check : null;
}

const ok2 = (r) => Boolean(r) && !isBlockedResult(r) && r.status >= 200 && r.status < 300;
const listed = (check, r) => ok2(r) && check.missingTitles.includes(pageTitle(r));
// offList：2xx、讀得到標題，標題不在名單裡。
const offList = (check, r) => ok2(r) && pageTitle(r) !== null && !check.missingTitles.includes(pageTitle(r));

// notHtml：2xx，但不是 HTML。
const notHtml = (r) => ok2(r) && !r.bodySkipped && !isHtml(r);

/** needsReread 判斷 r 不夠判斷、要用 TITLE_PROBE 重讀：不是 2xx、讀不到標題，或標題在名單裡。不是 HTML 的 2xx 不重讀。 */
export const needsReread = (check, r) => !offList(check, r) && !notHtml(r);

const describeOnce = (check, r) => (ok2(r) && pageTitle(r) !== null ? `標題是 ${inertText(pageTitle(r).slice(0, 80))}` : describeResult(r));

/**
 * judgeTitle 判定一個看標題的網址，回傳 { verdict, reason, bucket, notify }，欄位和 judgeContent 相同。
 * r 是主程式讀 16KB 的結果，標題讀得到又不在名單裡就是 healthy；其餘看 reread（TITLE_PROBE 重讀的結果，
 * 標題在名單裡的隔 TITLE_RECHECK.delayMs 再讀一次，reread.previous 是前一次）。兩次都是名單裡的標題才算 dead，只有一次的不通知。
 * 被壓縮、讀到上限還沒讀完 <title>、被位址政策擋下要通知，那代表標題檢查本身做不了。
 * @param {{missingTitles: string[]}} check @param {object} r @param {object|null|undefined} reread
 */
export function judgeTitle(check, r, reread) {
    const unverified = (why, notify, bucket = 'other') => ({ verdict: 'unverified', bucket, notify, reason: `標題檢查 ${why}` });
    if (!needsReread(check, r)) return { verdict: 'healthy', reason: describeResult(r) };
    const x = reread;
    if (!x) return unverified('這次沒有重讀', false);
    if (isBlockedResult(x)) return unverified(`被位址政策擋下：${x.reason}`, true);
    if (!ok2(x)) return unverified(describeResult(x), false, unverifiedBucket(x));
    if (x.bodySkipped) return unverified(`回應是壓縮過的，沒有解析（${inertText(String(x.bodySkipped).slice(0, 60))}）`, true);
    if (notHtml(x)) return unverified(`回應不是 HTML（${inertText(String(x.contentType ?? '沒有 Content-Type').slice(0, 60))}）`, false);
    // 維護中的主機可能回空的 200，那不是沒有標題的頁面。
    if (!x.bodyTruncated && !(x.bodyHead ?? '').trim()) return unverified('回應是空的', false);
    const title = pageTitle(x);
    if (title === null) {
        return x.bodyAborted
            ? unverified('回應沒有收完，連線中途斷了', false, 'unreachable')
            : unverified(`讀到 ${TITLE_PROBE.readBodyBytes / 1024}KB 還沒讀完 <title>`, true);
    }
    if (!check.missingTitles.includes(title)) return { verdict: 'healthy', reason: describeResult(x) };
    const once = (why) => unverified(`${describeOnce(check, x)}，${why}`, false);
    if (x.retrySkipped) return once('時間預算用完，沒有重讀確認');
    if (!x.previous) return once('沒有重讀確認');
    if (!listed(check, x.previous)) return once(`前一次不是（${describeOnce(check, x.previous)}）`);
    return { verdict: 'dead', reason: `頁面${describeOnce(check, x)}，是這台主機不存在的頁面的標題` };
}

/**
 * judgeRandom 判定同目錄的隨機路徑，回傳 { state, reason }。state 是 listed（標題在名單裡）、stale（讀兩次都是 2xx、
 * 標題都不在名單裡，名單可能過期）或 other（沒打、不是 2xx、讀不到標題、只有一次不在名單裡），other 只寫進報告。
 * 預算用完沒打或沒再讀的加上 skipped。
 * @param {{missingTitles: string[]}} check @param {object|null} r
 */
export function judgeRandom(check, r) {
    if (!r) return { state: 'other', skipped: true, reason: '時間預算用完，沒有打' };
    if (listed(check, r)) return { state: 'listed', reason: describeOnce(check, r) };
    if (offList(check, r) && offList(check, r.previous)) return { state: 'stale', reason: describeOnce(check, r) };
    if (offList(check, r)) {
        if (r.retrySkipped) return { state: 'other', skipped: true, reason: `${describeOnce(check, r)}，不在名單裡，時間預算用完，沒有重讀確認` };
        return { state: 'other', reason: `${describeOnce(check, r)}，不在名單裡，前一次${r.previous ? `是 ${describeOnce(check, r.previous)}` : '沒有讀'}` };
    }
    if (notHtml(r)) return { state: 'other', reason: `回應不是 HTML（${inertText(String(r.contentType ?? '沒有 Content-Type').slice(0, 60))}）` };
    if (ok2(r)) return { state: 'other', reason: r.bodySkipped ? '回應是壓縮過的' : (r.bodyHead ?? '').trim() ? '沒讀完 <title>' : '回應是空的' };
    return { state: 'other', reason: describeResult(r) };
}

/**
 * runMissingTitles 對 targets 裡看標題的網址做兩件事，回傳 { rereads, reads, selfChecks, skipped }：
 * 主程式的結果是健康、卻不夠判斷的，用 TITLE_PROBE 重讀，rereads[i] 對應 targets[i]，沒重讀的是 null；
 * 頁面健康的網址每個（主機、目錄）打一次同目錄的隨機路徑，selfChecks 是 { host, url, state, reason }。標題在名單裡的網址、
 * 不在名單裡的隨機路徑，照 TITLE_RECHECK 再讀一次。reads 是要重讀的網址數，skipped 是預算用完沒讀或沒再讀的數量。
 * @param {{url: string}[]} targets @param {(object|null)[]} results @param {object[]} contentChecks @param {string} token
 * @param {{probeFn?: Function, allowLoopback?: boolean, sleep?: (ms: number) => Promise<void>, recheck?: object}} [opts] recheck 蓋過 TITLE_RECHECK
 */
export async function runMissingTitles(targets, results, contentChecks, token, opts = {}) {
    const { probeFn, allowLoopback, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = opts;
    const recheck = { ...TITLE_RECHECK, ...opts.recheck };
    const reads = [];
    const randoms = new Map();
    targets.forEach(({ url }, index) => {
        const check = titleCheckFor(contentChecks, url);
        const r = results[index];
        if (!check || !r || classifyLink(r) !== 'healthy') return;
        randoms.set(randomSibling(url, token), check);
        if (needsReread(check, r)) reads.push({ index, url, check });
    });
    const checkOf = new Map([...reads.map((x) => [x.url, x.check]), ...randoms]);
    const urls = [...reads.map((x) => x.url), ...randoms.keys()];
    const cfg = { ...TITLE_PROBE, probeFn, allowLoopback, retryIf: () => false };
    const { results: rr, skipped } = await runProbes(urls, cfg);
    const confirm = urls.map((_, k) => k).filter((k) => (randoms.has(urls[k]) ? offList : listed)(checkOf.get(urls[k]), rr[k]));
    let confirmSkipped = 0;
    if (confirm.length) {
        await sleep(recheck.delayMs);
        const { results: again } = await runProbes(confirm.map((k) => urls[k]), { ...cfg, budgetMs: recheck.budgetMs });
        confirm.forEach((k, j) => {
            if (!again[j]) confirmSkipped++;
            rr[k] = again[j] ? { ...again[j], previous: rr[k] } : { ...rr[k], retrySkipped: true };
        });
    }
    const rereads = new Array(targets.length).fill(null);
    reads.forEach((x, k) => {
        rereads[x.index] = rr[k];
    });
    const selfChecks = [...randoms].map(([url, check], k) => ({ host: check.match.host, url, ...judgeRandom(check, rr[reads.length + k]) }));
    return { rereads, reads: reads.length, selfChecks, skipped: skipped + confirmSkipped };
}
