// 全站外部連結健檢的判定與報告：每一筆探測結果歸到報告的哪一段、什麼情況要通知、報告與主控台寫什麼。
// 這裡只放不碰網路與檔案的純函式；讀檔、探測與寫檔在 check-external-links.mjs。測試直接餵探測結果，
// 檢查分組、通知條件與報告內容（link-health.test.mjs、hijack-signals.test.mjs）。

import { classifyLink, describeResult, isBlockedResult, unverifiedBucket } from './link-health.lib.mjs';
import { matchPolicy, matchHijacked, matchHijackedHop, matchContentCheck, expiringWithin } from './link-policy.lib.mjs';
import { detectHijackSignals, inertText } from './hijack-signals.lib.mjs';
import { probeUrlFor } from './bare-domains.lib.mjs';
import { SOFT404_PROBE, RECHECK } from './soft404.lib.mjs';
import { EXTERNAL_LINKS_MARKER } from './watchdog-issue.lib.mjs';

/** 這個資料檔另有專屬看門狗；重疊是刻意的縱深防禦，但報告要講清楚免得重複處理。競賽看門狗只探測 url 欄位。 */
const ALSO_COVERED_BY = [
    {
        file: 'advanced-resources/competitions.json',
        location: /^\/competitions\/\d+\/url$/,
        scope: 'url 欄位',
        by: 'competitions-check.yml（另含截止日與欄位的語意檢查）',
    },
];

/** EXPIRY_NOTICE_DAYS 是政策項目到期前幾天開始每週通知。到期當天起 check-link-policy 會讓所有 PR 失敗。 */
export const EXPIRY_NOTICE_DAYS = 30;

/**
 * CONTENT_PROBE 是主程式打內容 API 時交給 runProbes 的設定，報告寫的預算也從這裡來。回應讀到 256KB：
 * 2026-10-27 量 108 課綱資訊網單篇文章的 API 回應是 57836 bytes。打的都是同一台主機，併發數放低。
 */
export const CONTENT_PROBE = Object.freeze({ concurrency: 2, budgetMs: 2 * 60_000, readBodyBytes: 256 * 1024, retryIf: contentRetry });

/** parseObject 把回應解析成 JSON 物件，不是 JSON 回傳 undefined，是 JSON 但不是物件回傳 null。開頭的 BOM 不算。 */
function parseObject(text) {
    let data;
    try {
        data = JSON.parse((text ?? '').replace(/^\uFEFF/, ''));
    } catch {
        return undefined;
    }
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/** readObject 回傳讀完的 2xx 回應解析出的 JSON 物件，其餘回傳 undefined 或 null。 */
function readObject(r) {
    const read = r.status >= 200 && r.status < 300 && !r.bodyTruncated && !r.bodySkipped;
    return read ? parseObject(r.bodyHead) : undefined;
}

function isEmptyObject(r) {
    const data = readObject(r);
    return Boolean(data) && Object.keys(data).length === 0;
}

/**
 * contentRetry 判斷內容 API 的結果要不要重打一次：不是讀完的 2xx JSON 物件，或剛好是 {}，就重打。
 * 403、維護頁、中途斷線常常只是一時的，只看一次就通知會多開 issue。被位址政策擋下的重打也一樣，不重打。
 * @param {object} r 探測 API 的結果 @returns {boolean}
 */
export function contentRetry(r) {
    if (isBlockedResult(r)) return false;
    const data = readObject(r);
    return !data || Object.keys(data).length === 0;
}

// 回應的值是那台主機給的，字串、數字包成行內程式碼，issue 裡才不會變成連結或 @ 人。物件與陣列只寫型別，
// 很深的巢狀結構 JSON.stringify 會丟 RangeError。
function describeValue(data, key) {
    if (!Object.hasOwn(data, key)) return '沒有這個欄位';
    const v = data[key];
    if (v === null) return '是 null';
    if (typeof v === 'object') return Array.isArray(v) ? '是陣列' : '是物件';
    return `是 ${inertText(JSON.stringify(v).slice(0, 80))}`;
}

/**
 * judgeContent 用內容 API 的探測結果判定 contentChecks 裡的一個網址，回傳 { verdict, reason, bucket, notify }，
 * verdict 是 healthy、dead 或 unverified。r 是重打過的結果時，r.previous 是第一次的結果。兩次都是 2xx、剛好是 {} 才算 dead，
 * 108 課綱資訊網對不存在的 cid、oid 回的就是 {}；只有一次是 {} 的不通知。其餘照最後一次判：expect 的欄位都 ===
 * 才算 healthy，其他是 unverified，notify 表示要不要通知：4xx（429 除外）、被壓縮、超過讀取上限、不是 JSON 物件、
 * 格式和 expect 對不上，多半是網站改了 API；被位址政策擋下也通知。3xx、429、5xx、逾時、中途斷線不通知。
 * @param {{expect: object}} entry contentChecks 的一筆網址 @param {object|null|undefined} r 探測 API 的結果，沒有探測就是空的
 */
export function judgeContent(entry, r) {
    const unverified = (why, notify, bucket = 'other') => ({ verdict: 'unverified', bucket, notify, reason: `內容 API ${why}` });
    if (!r) return unverified('這次沒有檢查', false);
    if (isBlockedResult(r)) return unverified(`被位址政策擋下：${r.reason}`, true);
    if (!(r.status >= 200 && r.status < 300)) {
        return unverified(describeResult(r), r.status >= 400 && r.status < 500 && r.status !== 429, unverifiedBucket(r));
    }
    // content-encoding 的值是那台主機給的，截短再包成行內程式碼。
    if (r.bodySkipped) return unverified(`回應是壓縮過的，沒有解析（${inertText(String(r.bodySkipped).slice(0, 60))}）`, true);
    if (r.bodyAborted) return unverified('回應沒有收完，連線中途斷了', false, 'unreachable');
    if (r.bodyTruncated) return unverified('回應超過讀取上限', true);
    const data = parseObject(r.bodyHead);
    if (data === undefined) return unverified('回應不是 JSON', true);
    if (data === null) return unverified('回應不是 JSON 物件', true);
    if (Object.keys(data).length === 0) {
        if (r.retrySkipped) return unverified('回 {}，時間預算用完，沒有重打確認', false);
        if (!r.previous) return unverified('回 {}，沒有重打確認', false);
        if (!isEmptyObject(r.previous)) return unverified(`回 {}，前一次不是 {}（${judgeContent(entry, r.previous).reason}）`, false);
        return { verdict: 'dead', reason: '內容 API 回 {}，網站上查不到這一頁' };
    }
    for (const [key, want] of Object.entries(entry.expect)) {
        if (Object.hasOwn(data, key) && data[key] === want) continue;
        return unverified(`回應格式變了：${key} 應該是 ${JSON.stringify(want)}，回應裡${describeValue(data, key)}`, true);
    }
    return { verdict: 'healthy', reason: describeResult(r) };
}

/**
 * contentProbeTargets 列出這一輪要打的內容 API：頁面判成健康、又列在 contentChecks 的網址。回傳 { index, api }，
 * index 是在 targets 裡的位置。judgeUrl 用同樣的條件找內容檢查，該打卻沒有結果的算成沒有檢查。
 * @param {{url: string}[]} targets @param {(object|null)[]} results probe 的結果 @param {object[]} contentChecks
 */
export function contentProbeTargets(targets, results, contentChecks) {
    const out = [];
    targets.forEach((t, index) => {
        const hit = results[index] && classifyLink(results[index]) === 'healthy' ? matchContentCheck(contentChecks, t.url) : null;
        if (hit) out.push({ index, api: hit.entry.api });
    });
    return out;
}

/**
 * judgeUrl 決定盤點的一個網址在報告裡歸到哪一段，回傳 { bin, item, signal, content, hint }。bin 是 blocked、hijacked、
 * dead、soft404、suppressed、contentUnverified、soft404Unverified、unverified 或 healthy；signal 是自動偵測的訊號，沒有就是 null；
 * content 是內容 API 的判定，沒有看 API 就是 null；hint 是只列進報告的軟 404 提示，沒有就是 null。
 * @param {{url: string, occurrences?: object[]}} target 盤點的一筆 @param {object} r probe 的結果
 * @param {{hijacked: object[], entries: object[], contentChecks?: object[]}} policy validatePolicy 回傳的名單
 * @param {object|null} [apiResult] 探測內容 API 的結果 @param {object|null} [soft] runSoft404 對這個網址的判定
 */
export function judgeUrl(target, r, { hijacked, entries, contentChecks }, apiResult, soft) {
    const item = { url: target.url, occurrences: target.occurrences ?? [], reason: describeResult(r) };
    if (isBlockedResult(r)) return { bin: 'blocked', item: { ...item, reason: r.reason }, signal: null };
    // 接管的判定必須在三態分類之前：被接管的網域回的就是 200，
    // 走到 classifyLink 就會被算進 healthy，等於用檢查器替博弈站背書。
    // 轉址鏈經過名單上的主機也算，讀者點下去一樣會被帶過去，check-link-policy 只看得到起點。
    const hijack = matchHijacked(hijacked, target.url);
    const hop = hijack ? null : matchHijackedHop(hijacked, r);
    if (hijack || hop) {
        return { bin: 'hijacked', item: { ...item, policy: hijack ?? hop.policy, source: 'url', via: hop?.url }, signal: null };
    }
    // 自動訊號跑在分類之外：它只是多一段報告，不動 dead/unverified/healthy。
    const sig = detectHijackSignals(target.url, r);
    const signal = sig ? { ...sig, source: 'url', occurrences: item.occurrences } : null;
    // 頁面健康時才看內容 API。頁面本身失效或驗不到時，API 回什麼都改變不了結論。
    const check = classifyLink(r) === 'healthy' ? matchContentCheck(contentChecks, target.url) : null;
    const c = check ? judgeContent(check.entry, apiResult) : null;
    const content = c?.verdict ?? null;
    if (c) item.reason = c.reason;
    const verdict = content ?? classifyLink(r);
    // 例外政策不會在這裡出現。404/410 與網域解析不到一律照實回報，因為
    // allowlist 只降低 unverified 的噪音，把確定壞掉的連結壓下去等於廢掉整個檢查。
    if (verdict === 'dead') return { bin: 'dead', item, signal, content };
    if (verdict === 'healthy' && !c && soft) {
        const s = { ...item, reason: soft.reason, rules: soft.rules };
        // 軟 404 是推論，不是 404，只有精確網址的例外壓得下；主機層的例外壓不下。
        const policy = soft.verdict === 'dead' ? matchPolicy(entries.filter((e) => e.match.url !== undefined), target.url) : null;
        if (policy) return { bin: 'suppressed', item: { ...s, policy }, signal, content };
        if (soft.verdict === 'dead') return { bin: 'soft404', item: s, signal, content };
        if (soft.verdict === 'unverified') return { bin: 'soft404Unverified', item: s, signal, content };
        if (soft.verdict === 'hint') return { bin: 'healthy', item, signal, content, hint: s };
    }
    if (verdict === 'healthy') return { bin: 'healthy', item, signal, content };
    // 內容 API 驗不到的另列一段，例外壓不下：其中有幾種代表內容檢查本身壞了，要通知。
    if (c) return { bin: 'contentUnverified', item: { ...item, notify: c.notify }, signal, content };
    const policy = matchPolicy(entries, target.url);
    if (policy) return { bin: 'suppressed', item: { ...item, policy }, signal, content };
    // item 沒有 status 與 code，報告的分組要在這裡從探測結果算好。
    return { bin: 'unverified', item: { ...item, bucket: unverifiedBucket(r) }, signal, content };
}

/**
 * judgeBare 是 judgeUrl 的裸網域版：只寫在說明文字裡的主機，用 probeUrlFor 的網址探測。
 * 裸網域沒有例外政策，無法判定也不分組，報告裡整段收合。
 * @param {{host: string, url: string, occurrences?: object[]}} target @param {object} r probe 的結果
 * @param {{hijacked: object[]}} policy validatePolicy 回傳的 hijacked
 */
export function judgeBare(target, r, { hijacked }) {
    const item = { url: target.url, host: target.host, occurrences: target.occurrences ?? [], reason: describeResult(r) };
    if (isBlockedResult(r)) return { bin: 'blocked', item: { ...item, reason: r.reason }, signal: null };
    const hijack = matchHijacked(hijacked, item.url);
    if (hijack) return { bin: 'hijacked', item: { ...item, policy: hijack, source: 'bare' }, signal: null };
    const sig = detectHijackSignals(item.url, r);
    const signal = sig ? { ...sig, source: 'bare', host: item.host, occurrences: item.occurrences } : null;
    const verdict = classifyLink(r);
    return { bin: verdict === 'dead' || verdict === 'unverified' ? verdict : 'healthy', item, signal };
}

/**
 * expiringPolicyItems 列出 EXPIRY_NOTICE_DAYS 天以內到期的政策項目，每筆加上 list，標明是哪一份名單。
 * @param {object[]} entries @param {object[]} hijacked @param {string} todayISO 今天（YYYY-MM-DD，UTC）
 * @param {object[]} [contentChecks] 三份都是 validatePolicy 回傳的名單 @returns {object[]}
 */
export function expiringPolicyItems(entries, hijacked, todayISO, contentChecks = []) {
    return [
        ...expiringWithin(entries, todayISO, EXPIRY_NOTICE_DAYS).map((e) => ({ ...e, list: '例外' })),
        ...expiringWithin(hijacked, todayISO, EXPIRY_NOTICE_DAYS).map((e) => ({ ...e, list: '接管警示' })),
        ...expiringWithin(contentChecks, todayISO, EXPIRY_NOTICE_DAYS).map((e) => ({ ...e, list: '內容檢查' })),
    ];
}

// 三個訊號的精確度差很多，混在一起會讓高精確度的那兩個被雜訊淹掉。
// 實測（全站 508 個目標，2026-08-28）：
//   訊號 A 跨站轉址   11 個命中、全部是誤判
//     4 個是兄弟子網域（www.google.com → workspace.google.com、
//       premium.parenting.com.tw → www.parenting.com.tw ×2、
//       sciexplore.colife.org.tw → sciexplore2026.colife.org.tw）
//     7 個是機構改名／搬遷／短網址（anthropic→claude、comap.com→comap.org、
//       notion.so→notion.com、xmind.app→xmind.com、youtu.be→youtube.com、
//       roboticseducation.org→recf.org、zindi.africa→zindi.world）
//   訊號 B 內容標記    0 個（名單已先攔下 ieso-info.org）
//   訊號 C HTTP 盲區   1 個、真陽性（apho.org 已成 GoDaddy 待售停放頁）
//
// 那 4 個兄弟子網域要靠 PSL 才分得掉（www.google.com／workspace.google.com 的
// 共同後綴是兩段，a.edu.tw／b.edu.tw 也是兩段），另外 7 個任何規則都解不掉，
// 合法網站確實會轉去另一個註冊網域。所以訊號 A 的精確度上限就是這樣，
// 它適合放進報告給人瀏覽，不適合每週開一次 issue。
//
// needsAttention 因此只算需處理的那一級。

/**
 * splitSignals 把自動偵測的訊號分成需處理（actionable）與僅供瀏覽（browseOnly）兩級。
 * @param {{confidence: string}[]} autoSignals @returns {{actionable: object[], browseOnly: object[]}}
 */
export function splitSignals(autoSignals) {
    return {
        actionable: autoSignals.filter((a) => a.confidence === 'actionable'),
        browseOnly: autoSignals.filter((a) => a.confidence !== 'actionable'),
    };
}

/**
 * needsAttention 判斷這一輪要不要開 issue 或留言，參數是 buildReport 整理好的結果。
 * 接管命中只算盤點網址的：說明文字點名接管主機是在警告讀者，名單期限內每週通知只是重複一件已知的事，
 * 到期前 30 天起改由 expiringSoon 通知。直接連到接管主機的網址，workflow 先跑的 check-link-policy
 * 就會擋下；轉址才經過接管主機的，check-link-policy 看不到，靠這裡通知。需處理的自動訊號也要算，
 * 偵測到了卻不開 issue 的話，報告會躺在 job summary 裡沒人看，等於沒偵測。快到期的政策項目也要算，
 * 否則要等到期當天所有 PR 變紅才會發現。內容 API 驗不到時，judgeContent 標了 notify 的要算，那代表內容檢查本身壞了。
 * 軟 404 兩次都命中的要算；只命中一次的和提示不算。
 * @param {{dead: object[], blocked: object[], bareDead: object[], hijackedHits: object[], expiringSoon: object[], autoSignals: object[],
 *   coverageComplete: boolean, contentUnverified?: object[], soft404?: object[]}} s
 * @returns {boolean}
 */
export function needsAttention({ dead, blocked, bareDead, hijackedHits, expiringSoon, autoSignals, coverageComplete, contentUnverified = [], soft404 = [] }) {
    return (
        dead.length > 0 ||
        soft404.length > 0 ||
        contentUnverified.some((u) => u.notify) ||
        blocked.length > 0 ||
        bareDead.length > 0 ||
        hijackedHits.some((h) => h.source === 'url') ||
        expiringSoon.length > 0 ||
        splitSignals(autoSignals).actionable.length > 0 ||
        !coverageComplete
    );
}

// 資料 JSON 的出處帶上 JSON pointer，才知道是哪一筆；頁面的出處只列檔名
const sourcesOf = (item) => [...new Set(item.occurrences.map((o) => (o.file.endsWith('.json') ? `${o.file} ${o.location}` : o.file)))].sort();
// 出處全列會炸掉報告：同一個網址可能出現在 90 幾個頁面（例如共用的頁尾連結），
// 一筆失效就吃掉整個 issue 的可讀性。列前幾個、其餘只給數字。
const MAX_SOURCES_SHOWN = 5;
const sourceLines = (item) => {
    const all = sourcesOf(item);
    const out = all.slice(0, MAX_SOURCES_SHOWN).map((s) => `  - 出處：\`${s}\``);
    if (all.length > MAX_SOURCES_SHOWN) out.push(`  - …另有 ${all.length - MAX_SOURCES_SHOWN} 處引用（共 ${all.length} 處）`);
    return out;
};
const coveredElsewhere = (item) =>
    ALSO_COVERED_BY.filter((c) => item.occurrences.some((o) => o.file === c.file && c.location.test(o.location)));

/**
 * NO_CONTENT 是內容 API 的計數：checked 是頁面健康、有內容檢查的網址數，skipped 是該打卻沒有結果的，
 * pageUnverified 是有內容檢查、頁面這次驗不到而沒打 API 的網址。
 */
const NO_CONTENT = Object.freeze({ checked: 0, healthy: 0, dead: 0, unverified: 0, skipped: 0, pageUnverified: Object.freeze([]) });
const contentCounts = (c) => `健康 ${c.healthy}、失效 ${c.dead}、無法判定 ${c.unverified}`;

/** NO_SOFT404 是 runSoft404 沒有跑時的結果，欄位見 runSoft404。 */
const NO_SOFT404 = Object.freeze({ verdicts: Object.freeze([]), randoms: 0, randomsSkipped: 0, randomsFailed: 0, recheckSkipped: 0 });
// probedRandoms 是實際打了的隨機路徑數，週報和主控台都印這個。
const probedRandoms = (run) => run.randoms - run.randomsSkipped;
// skippedText 寫覆蓋不完整的數量。只有隨機路徑沒打時不寫「0 筆未檢查」。
const skippedText = (urls, randoms) =>
    [urls || !randoms ? `${urls} 筆未檢查` : '', randoms ? `軟 404 的隨機路徑 ${randoms} 個沒打` : ''].filter(Boolean).join('、');
const SOFT404_BUDGET_MIN = (SOFT404_PROBE.budgetMs + RECHECK.delayMs + RECHECK.budgetMs) / 60_000;

/**
 * renderReport 產生週報的 markdown，第一行是 issue 的機器標記。m 是 buildReport 整理好的結果：
 * 各段的項目、數量、盤點與預算資訊，以及算好的通知條件 attention。
 * @param {object} m @returns {string}
 */
export function renderReport(m) {
    const {
        todayISO, inventoryTotal, targetsCount, healthy, dead, blocked, urlBlockedCount, unverified, suppressed, hijackedHits,
        autoSignals, bareInfo, bareRejected, bareUnresolved, bareHostsCount, bareHealthy, bareDead, bareOther, skipped, bareSkipped,
        budgetMs, bareBudgetMs, expiringSoon, attention, content = NO_CONTENT, contentUnverified = [],
        soft404 = [], soft404Unverified = [], soft404Hints = [], soft404Run = NO_SOFT404,
    } = m;
    const { actionable: actionableSignals, browseOnly: browseOnlySignals } = splitSignals(autoSignals);
    const urlSkipped = skipped + bareSkipped + content.skipped + soft404Run.recheckSkipped;

    const lines = [EXTERNAL_LINKS_MARKER, '', '## 全站外部連結檢查報告', ''];
    lines.push(`- 檢查日期：${todayISO}（UTC）`);
    lines.push(`- 盤點：${inventoryTotal} 個去重外部網址，來自 check-built-site.mjs 的建置產物掃描`);
    lines.push(`- 本次檢查 ${targetsCount} 筆：健康 ${healthy}、失效 ${dead.length}、位址封鎖 ${urlBlockedCount}、無法判定 ${unverified.length + contentUnverified.length + soft404Unverified.length}、已列例外 ${suppressed.length}、軟 404 ${soft404.length}`);
    lines.push(
        `- 軟 404 檢查：打了同目錄的隨機路徑 ${probedRandoms(soft404Run)} 個（逾時、連不上或 5xx 的 ${soft404Run.randomsFailed ?? 0} 個），兩次都命中 ${soft404.length} 筆、` +
            `只命中一次 ${soft404Unverified.length} 筆、只列出的提示 ${soft404Hints.length} 筆`,
    );
    // 頁面驗不到的那幾筆一定要寫出來：runner 連不到的主機，API 一次都沒打，只寫 0 筆會被當成沒事。
    const notProbed = content.pageUnverified;
    lines.push(
        `- 內容 API 檢查 ${content.checked} 筆：${contentCounts(content)}。頁面驗不到、沒打 API 的 ${notProbed.length} 筆` +
            (notProbed.length ? `：${notProbed.join('、')}。怎麼在連得到的機器上檢查，見 scripts/link-policy.json 裡這些主機的 reason` : '') +
            '。contentChecks 列的主機對任何路徑都回 200，頁面健康之後再看 API 的回應',
    );
    lines.push(
        `- 內文裸網域：盤點候選 ${bareInfo.total}（${bareInfo.alreadyCoveredByUrls} 個已由盤點的網址涵蓋）、DNS 篩掉 ${bareRejected.length}、DNS 未答 ${bareUnresolved.length}、實際探測 ${bareHostsCount}（健康 ${bareHealthy}、失效 ${bareDead.length}、無法判定 ${bareOther.length}）`,
    );
    // 無條件寫，即使是 0。理由與主控台那一行相同，而且這裡更重要：主控台只在
    // job step 的 log 裡，這份報告才是貼進 issue／job summary、真的有人讀的東西。
    // 下面那一段只在有命中時才出現，所以少了這個數字的話，「這次沒偵測到」與
    // 「偵測根本沒接上線」在讀者眼裡長得一模一樣。
    lines.push(
        `- 自動偵測：需處理 ${actionableSignals.length}（內容標記／HTTP 層盲區）、` +
            `僅供瀏覽 ${browseOnlySignals.length}（跨站轉址；誤判率高，不觸發通知）` +
            '　兩者都不改變上面的三態分類',
    );
    lines.push('');

    if (expiringSoon.length) {
        lines.push(`### ⏰ 連結政策有 ${expiringSoon.length} 筆在 ${EXPIRY_NOTICE_DAYS} 天內到期`, '');
        lines.push(
            '到期當天起 check-link-policy 會讓所有 PR 失敗，排程健檢也會停在 Validate the exception policy 那一步，不再留言。',
            '請逐筆重新查證，仍然成立的延長期限並寫下這次查到的結果，不再成立的刪掉。',
            '',
        );
        for (const e of expiringSoon) lines.push(`- ${e.list} \`${e.match.host ?? e.match.url}\`　到期日：${e.expires}　負責人：${e.owner}`);
        lines.push('');
    }

    if (hijackedHits.length) {
        lines.push('### 🚨 已知不可信任的主機（狀態碼健康，內容不可信）', '');
        lines.push(
            '這些主機列在 `scripts/link-policy.json` 的 `hijacked`。它們多半回 HTTP 200，三態分類看不出異常，所以靠這份名單標出來，',
            '名單上的主機不算進健康。盤點的網址直接連到它們的，check-link-policy 會在 PR 擋下；轉址才經過它們的，',
            'check-link-policy 看不到，列在這裡並觸發通知。',
            '說明文字點名它們是在警告讀者，這種命中本身不觸發通知；名單到期前 30 天起由到期提醒通知，到期當天起確定性 CI 會紅，',
            '要重新查證它是否仍被接管。',
            '',
        );
        for (const h of hijackedHits) {
            const kindLabel = h.policy.kind === 'terminus' ? '接管鏈的終點（本來就不是教育網域）' : '這台主機本身已被接管';
            lines.push(`- **${h.policy.match.host}** — ${kindLabel}（本次探測：${h.reason}）`);
            lines.push(`  - 來源：${h.source === 'bare' ? '說明文字裡的裸網域（本身不觸發通知）' : '盤點的網址（會觸發通知，請換成現行網址）'}　\`${h.url}\``);
            // 轉址目標是被接管的主機給的，包成行內程式碼才不會在 issue 裡變成連結或 @ 人。
            if (h.via) lines.push(`  - 轉址經過：${inertText(h.via)}`);
            lines.push(`  - 情況：${h.policy.reason}`);
            lines.push(`  - 證據：${h.policy.evidence}`);
            lines.push(`  - 負責人：${h.policy.owner}　重新查證期限：${h.policy.expires}`);
            lines.push(...sourceLines(h));
        }
        lines.push('');
    }

    // 自動偵測到的訊號（#117）。與上面那份名單並列而不是混在一起：名單是「已經
    // 查證過、確定不可信」，這一段是「機器覺得可疑、還沒有人看過」。兩者的可信度
    // 不同，措辭也要不同，否則讀者會把未經查證的推測當成結論。
    if (actionableSignals.length) {
        lines.push('### 🕵️ 自動偵測到的可疑訊號（需要人工查證）', '');
        lines.push(
            '這一段不在任何名單裡，是這次探測當場算出來的。**它不改變上面的三態分類**，',
            '也不代表這些連結一定壞了——需要有人看一眼再決定。',
            '',
            '- **內容標記**：標題或描述命中蹲域名的變現詞組（博弈／成人／藥品／停放待售）。',
            '  只比對 <title> 與 meta description，一律用多字詞組並要求詞界，且**至少要兩個',
            '  相異詞組**才算命中——單一詞組會把「線上博弈防治研習」「機率論競賽：百家樂的',
            '  期望值分析」這類正當教育內容掃進來。',
            '- **HTTP 層看不到內容**：回應是一個很小、內容只有轉址構造的殼。這一條**不指控接管**，',
            '  它陳述的是檢查器的盲區——「healthy」在這裡只代表伺服器答了，不代表使用者看得到',
            '  正常內容。對一個競賽官網來說，那本身就值得看一眼。',
            '',
            '確認為接管 → 加進 `scripts/link-policy.json` 的 `hijacked`（要有 reason／owner／expires），',
            '並修掉指向它的資料。確認為誤判 → 回報，這代表偵測規則需要調整。',
            '',
        );
        for (const a of actionableSignals) {
            const where = a.source === 'bare' ? `說明文字裡的裸網域 \`${a.host}\`` : `盤點的網址 \`${a.url}\``;
            lines.push(`- **${where}**`);
            if (a.cross) {
                lines.push(`  - 🔀 轉址終點跨站：\`${a.cross.fromHost}\` → \`${a.cross.toHost}\``);
                for (const h of a.cross.hops) lines.push(`    - ${inertText(h)}`);
            }
            // shell.title 與 content.text 是被偵測的那台主機自己寫的字串，而這份報告會
            // 被 gh issue create --body-file 原樣送進 issue。不包成行內程式碼的話，一個
            // 被接管的網域就能讓看門狗的 issue 去 @ 人、cross-reference 別的 issue、
            // 或貼出可點的釣魚連結。命中的定義就是「那台主機不可信」，所以這裡沒有
            // 「應該還好吧」的空間。
            if (a.shell) {
                lines.push(`  - 🫥 HTTP 層看不到內容：回應只有 ${a.shell.bytes} bytes 且內容是轉址構造` +
                    (a.shell.title ? `（<title> 是 ${inertText(a.shell.title)}）` : '') + '，需要執行 JavaScript 才看得到真正的頁面。');
            }
            for (const c of a.content) {
                lines.push(`  - 🎰 內容標記：\`${c.phrase}\`（在 ${c.where}）`);
                lines.push(`    - 原文：${inertText(c.text)}`);
            }
            lines.push(...sourceLines(a));
        }
        lines.push('');
    }

    // 跨站轉址單獨一段，而且不觸發通知。實測（全站 508 個目標）它命中 11 筆、
    // 全部是誤判：4 筆兄弟子網域（沒有 PSL 分不出 www.google.com／workspace.google.com
    // 與 a.edu.tw／b.edu.tw 的差別）、7 筆機構改名或短網址（任何規則都解不掉，
    // 合法網站確實會轉去另一個註冊網域）。
    //
    // 保留它是因為真的接管確實會呈現這個形狀（www.sasmo.sg → arcade.now）；
    // 但用它每週開一次 issue，維護者會在第三週學會忽略整個看門狗。
    if (browseOnlySignals.length) {
        lines.push('### 🔀 轉址終點跨站（僅供瀏覽，不觸發通知）', '');
        lines.push(
            '使用者最後到達的主機不在起點的網域底下。**這一段的誤判率很高**——合法的機構',
            '改名、併購、短網址服務、以及同一個註冊網域下的兄弟子網域都會命中，而要分辨',
            '「兄弟子網域」與「同一個二段後綴下的不同機構」（a.edu.tw／b.edu.tw）需要公開',
            '後綴清單，本檢查刻意不引入那份資料。',
            '',
            '所以它只列在這裡供瀏覽，不計入待辦。真的接管會呈現這個形狀（www.sasmo.sg →',
            'arcade.now 就是），但它同時也是網路上很常見的正常行為。',
            '',
            '標成「JS 轉址」的那一跳，是只有 JavaScript 轉址的殼頁轉去同一個網域底下另一台主機的寫死網址，',
            '檢查器照一般轉址跟了下去，終點和起點同站時也列在這裡。目的頁沒有回 2xx／3xx 時，結果是殼本身，',
            '殼列在上面「需要人工查證」那一段。',
            '',
        );
        for (const a of browseOnlySignals) {
            const where = a.source === 'bare' ? `說明文字裡的裸網域 \`${a.host}\`` : `盤點的網址 \`${a.url}\``;
            lines.push(`- ${where}`);
            if (a.cross) {
                lines.push(`  - \`${a.cross.fromHost}\` → \`${a.cross.toHost}\``);
                for (const h of a.cross.hops) lines.push(`    - ${inertText(h)}`);
            }
        }
        lines.push('');
    }

    if (blocked.length) {
        lines.push('### 🛑 網址被位址政策擋下（請立刻檢查資料是否被竄改）', '');
        lines.push('這些網址指向 loopback／私有網段／link-local／雲端 metadata，健檢拒絕連線。', '');
        lines.push('（含只寫在說明文字裡的裸網域——不論從哪條路徑進來，指向內網都是同一件事。）', '');
        lines.push('正常的教育資源不會長這樣；出現在這裡代表資料檔被寫錯或被動過手腳。', '');
        for (const b of blocked) {
            lines.push(`- **${b.reason}**`);
            lines.push(`  - 網址：\`${b.url}\``);
            lines.push(...sourceLines(b));
        }
        lines.push('');
    }

    if (dead.length) {
        lines.push('### 🔗 連結失效（網域解析不到或頁面不存在，請更新）', '');
        for (const d of dead) {
            lines.push(`- **${d.reason}**：${d.url}`);
            lines.push(...sourceLines(d));
            for (const c of coveredElsewhere(d)) lines.push(`  - 註：此檔另由 ${c.by} 檢查，可能會在兩處看到同一筆`);
        }
        lines.push('');
    }

    if (soft404.length) {
        lines.push(`### 🪤 網址回 2xx，內容卻是錯誤頁或首頁（軟 404）${soft404.length} 筆`, '');
        lines.push(
            '頁面回 2xx，三態會判健康，但下面的規則顯示原本的內容已經不在了。隔一段時間重打一次，兩次都命中同一條規則才列在這裡。',
            '規則：1 轉址落在錯誤頁路徑；2 標題或 h1 寫著找不到，或 canonical 指向錯誤頁；3 canonical 指向上層目錄或根目錄；',
            '4 轉址的落點和同目錄隨機路徑的落點相同。請用瀏覽器確認，失效的就換成現行網址。',
            '確認是誤判的，在 `scripts/link-policy.json` 的 entries 加一筆 match.url 的例外（reason／owner／expires），只壓這個網址；match.host 的例外壓不下軟 404。',
            '',
        );
        for (const d of soft404) {
            lines.push(`- **第 ${d.rules.join('、')} 條**：${d.url}`);
            lines.push(`  - ${inertText(d.reason)}`);
            lines.push(...sourceLines(d));
        }
        lines.push('');
    }

    if (contentUnverified.length) {
        lines.push(`### 🧩 內容 API 驗不到 ${contentUnverified.length} 筆`, '');
        lines.push(
            '這些網址的主機對任何路徑都回 200，只能靠 `scripts/link-policy.json` 的 contentChecks 打 API 確認內容。',
            'API 回 4xx（429 除外）、回應被壓縮、超過讀取上限、不是 JSON 物件或格式和 expect 對不上，多半是網站改了 API，',
            '請照新的寫法改 contentChecks，否則這些網址等於沒有檢查；這幾種和被位址政策擋下的會觸發通知。',
            '3xx、429、5xx、逾時、連線中途斷了，以及回 {} 卻不是連兩次都 {} 的，不觸發通知。',
            '回應是讀完的 2xx、{} 以外的 JSON 物件時只打一次；其他結果除了被位址政策擋下的，時間預算內會重打一次，這裡寫的是最後一次的結果。',
            '',
        );
        for (const u of contentUnverified) lines.push(`- ${u.reason}：${u.url}`);
        lines.push('');
    }

    if (bareDead.length) {
        lines.push('### 🔤 說明文字裡的網域失效（請改寫內文或補上現行網址）', '');
        lines.push(
            '這些網域只出現在說明文字裡、沒有做成連結，所以讀者不會點到——但它們仍然值得每週看一次。',
            '',
            '有兩種情況，處理方式不同：',
            '',
            '1. **內文把它當成現行網址在介紹** → 資料錯了，請改寫敘述或補上正確的現行網址。',
            '2. **內文本來就說它已經停用**（例如「原 X 已轉址至 Y」）→ 資料是對的，不必改。',
            '   這一筆會一直出現在這裡，那是刻意的：我們的內文點名了一個沒有主人的網域，',
            '   而沒有主人的網域隨時可能被別人註冊走。ieso-info.org 與 www.sasmo.sg 就是這樣',
            '   變成博弈站與廣告漏斗的。持續盯著它，改天它從「解析不到」變成「HTTP 200」，',
            '   就是該把它加進 link-policy.json 的 hijacked 名單的時候。',
            '',
        );
        for (const d of bareDead) {
            lines.push(`- **${d.reason}**：${d.host}`);
            lines.push(...sourceLines(d));
        }
        lines.push('');
    }

    if (bareOther.length) {
        lines.push(
            `<details><summary>🔤 說明文字裡的網域無法判定 ${bareOther.length} 筆</summary>`,
            '',
        );
        for (const u of bareOther) lines.push(`- ${u.reason}：${u.host}`);
        lines.push('', '</details>', '');
    }

    if (bareUnresolved.length) {
        lines.push('### ⚠️ 裸網域的 TLD 這次查不到答案（本次未檢查）', '');
        lines.push(
            '判斷「這串字到底是不是網域」要查該 TLD 在 DNS 根區的 NS 記錄。下列候選這次沒有問到答案',
            '（SERVFAIL、逾時、連不到 resolver 等），因此**沒有被探測**。',
            '',
            '這一段與下面「被 DNS 篩掉」是兩件完全不同的事：那些是根區明確回答「沒有這個 TLD」，',
            '這些是我們根本沒問到。若整批候選都落在這裡，代表 runner 的 DNS 有問題，本次裸網域',
            '檢查等於沒有跑，**不可以視為正常**。',
            '',
        );
        for (const u of bareUnresolved) lines.push(`- ${u.host} — ${u.reason}`);
        lines.push('');
    }

    if (bareRejected.length) {
        lines.push(
            `<details><summary>🧪 被 DNS 篩掉的裸網域候選 ${bareRejected.length} 筆（根區確定沒有這個 TLD，不是網域）</summary>`,
            '',
            '擷取規則是純字串比對，會擷到檔名與縮寫。這裡用「該 TLD 在 DNS 根區存不存在」把它們篩掉，',
            '列出來是為了讓擷取規則退化時看得出來——這一區應該只有檔名，出現真的網域就是規則出問題了。',
            '',
        );
        for (const r of bareRejected) lines.push(`- ${r.host} — ${r.reason}`);
        lines.push('', '</details>', '');
    }

    if (urlSkipped || soft404Run.randomsSkipped) {
        lines.push('### ⏱️ 檢查未完成（覆蓋不完整）', '');
        lines.push(
            `本次有${skippedText(urlSkipped, soft404Run.randomsSkipped).replace(/^\d/, ' $&')}（逾 ${budgetMs / 60_000} + ${bareBudgetMs / 60_000} + ${CONTENT_PROBE.budgetMs / 60_000} + ${SOFT404_BUDGET_MIN} 分鐘預算）。` +
                '**未檢查不等於正常**，這批網址本次沒有被驗證過。',
            '',
            '起點每週輪替，長期覆蓋率會均勻；但若連續數週出現，代表預算或併發數需要調整。',
            '',
        );
    }

    if (unverified.length) {
        // 「無法判定」底下是幾種原因不同的東西，處理方式也不同，所以分組、每組的標題各自寫明。
        // 三態裡只有 dead（ENOTFOUND 與 404/410）會觸發通知，無法判定刻意不觸發，但報告必須讓人看得出差別。
        // 2026-10-25 在台灣本地抽查：10-19 週報裡逾時的 apcs.csie.ntnu.edu.tw、law.moj.gov.tw 等 5 台
        // 都連得上，runner 在境外資料中心才連不上；sdl.ntl.edu.tw 與 12basic.edu.tw 在本地也逾時。
        // 5xx 有真的壞掉的，也有 CDN 擋自動程式的：sch001.g0v.tw 的 dash 頁在 Chromium 裡一樣是 502，
        // sasmo.simcc.org 對 Chrome/126 的 UA 回 520，同一時間換成 Chrome/156 就是 200。
        const unreachable = unverified.filter((u) => u.bucket === 'unreachable');
        const serverErrors = unverified.filter((u) => u.bucket === 'server-error');
        const rejected = unverified.filter((u) => u.bucket === 'rejected');
        const other = unverified.filter((u) => u.bucket === 'other');

        if (unreachable.length) {
            lines.push(
                `<details open><summary>⚠️ 連不上或沒有回應的連結 ${unreachable.length} 筆（逾時、連線被拒或被重設，值得人工確認是否已停站）</summary>`,
                '',
                'runner 位於境外資料中心，台灣的政府／學校站台常整段封鎖這類 IP，所以不自動判定為失效。',
                '但若你在本地瀏覽器也開不起來，那就是真的停站了，請更新或移除連結。',
                '',
            );
            for (const u of unreachable) lines.push(`- ${u.reason}：${u.url}`);
            lines.push('', '</details>', '');
        }
        if (serverErrors.length) {
            lines.push(
                `<details open><summary>⚠️ 站台回報伺服器錯誤的連結 ${serverErrors.length} 筆（HTTP 5xx）</summary>`,
                '',
                '可能是站台故障，也可能是站台前面的 CDN 擋下了自動程式。用瀏覽器也打不開的話，請更新或移除連結。',
                '',
            );
            for (const u of serverErrors) lines.push(`- ${u.reason}：${u.url}`);
            lines.push('', '</details>', '');
        }
        if (rejected.length) {
            lines.push(
                `<details><summary>ℹ️ 被站台拒絕的連結 ${rejected.length} 筆（HTTP 403、429 等，常見原因是擋自動程式，瀏覽器多半打得開）</summary>`,
                '',
                '也有頁面在瀏覽器裡一樣被拒絕，那就是真的不公開或已經刪掉了。',
                '',
            );
            for (const u of rejected) lines.push(`- ${u.reason}：${u.url}`);
            lines.push('', '</details>', '');
        }
        if (other.length) {
            lines.push(
                `<details open><summary>⚠️ 其他無法判定的連結 ${other.length} 筆（憑證、轉址迴圈、DNS 暫時失敗等，要逐筆看原因）</summary>`,
                '',
                '憑證過期（CERT_HAS_EXPIRED）的站，瀏覽器一樣打不開。憑證鏈接不到 Node 內建的根憑證時',
                '（UNABLE_TO_GET_ISSUER_CERT_LOCALLY、UNABLE_TO_VERIFY_LEAF_SIGNATURE），瀏覽器多半會自己補齊而打得開。',
                '轉址迴圈有時只是因為這支檢查器不帶 cookie。',
                '',
            );
            for (const u of other) lines.push(`- ${u.reason}：${u.url}`);
            lines.push('', '</details>', '');
        }
    }

    if (soft404Unverified.length) {
        lines.push(
            `<details open><summary>⚠️ 軟 404 只命中一次的連結 ${soft404Unverified.length} 筆（重打沒有再命中，或預算用完沒有重打）</summary>`,
            '',
            '不觸發通知。下週還在的話，請用瀏覽器確認。',
            '',
        );
        for (const u of soft404Unverified) lines.push(`- 第 ${u.rules.join('、')} 條，${inertText(u.reason)}：${u.url}`);
        lines.push('', '</details>', '');
    }

    if (soft404Hints.length) {
        lines.push(
            `<details><summary>🔎 可能是軟 404，只列出、不通知 ${soft404Hints.length} 筆</summary>`,
            '',
            '第 5 條：只轉到上層目錄或根目錄，沒有其他佐證。合法的語系首頁、搬家的分類頁也長這樣。',
            '第 6 條：頁面可見文字很少，同目錄的隨機路徑也直接回 200，多半是前端殼，頁面刪掉了狀態碼也不變。',
            '查得到 API 的，照 `scripts/link-policy.json` 的 contentChecks 宣告，改看 API 的回應。',
            '',
        );
        for (const h of soft404Hints) lines.push(`- 第 ${h.rules.join('、')} 條，${inertText(h.reason)}：${h.url}`);
        lines.push('', '</details>', '');
    }

    if (suppressed.length) {
        lines.push(
            `<details><summary>📋 已列入例外政策的連結 ${suppressed.length} 筆（scripts/link-policy.json）</summary>`,
            '',
            '例外只降低 `unverified` 的噪音，精確網址的例外另外壓得下軟 404；若其中任何一筆變成 404/410 或網域解析不到，仍然會出現在上面的「連結失效」。',
            '',
        );
        for (const s of suppressed) {
            // 軟 404 的原因含那台主機給的標題與網址。
            lines.push(s.rules ? `- 軟 404 第 ${s.rules.join('、')} 條，${inertText(s.reason)}：${s.url}` : `- ${s.reason}：${s.url}`);
            lines.push(`  - 理由：${s.policy.reason}`);
            lines.push(`  - 負責人：${s.policy.owner}　到期日：${s.policy.expires}`);
        }
        lines.push('', '</details>', '');
    }

    if (ALSO_COVERED_BY.length) {
        lines.push('<details><summary>📁 另有專屬看門狗的資料檔</summary>', '');
        for (const c of ALSO_COVERED_BY) lines.push(`- \`${c.file}\`（${c.scope}）→ ${c.by}`);
        lines.push('', '這裡仍然會一起檢查（縱深防禦），只是同一筆失效可能在兩份報告都看得到。', '', '</details>', '');
    }

    // 有列出接管主機時不寫這句，免得和上面的警示互相矛盾。
    if (!attention && !unverified.length && !contentUnverified.length && !soft404Unverified.length && !bareOther.length && !hijackedHits.length) {
        lines.push('✅ 全部外部連結正常。', '');
    }

    return lines.join('\n');
}

/** consoleLines 產生主控台要印的行：summary 在寫報告之前印，tail 在寫完 GITHUB_OUTPUT 之後印。 */
function consoleLines(m) {
    const {
        inventoryPath, inventoryTotal, targetsCount, healthy, dead, blocked, urlBlockedCount, unverified, suppressed, hijackedHits,
        autoSignals, bareInfo, bareRejected, bareUnresolved, bareHostsCount, bareHealthy, bareDead, bareOther, skipped, bareSkipped,
        coverageComplete, expiringSoon, attention, limit, content, contentUnverified, soft404, soft404Unverified, soft404Hints, soft404Run,
    } = m;
    const { actionable: actionableSignals, browseOnly: browseOnlySignals } = splitSignals(autoSignals);
    const summary = [];
    summary.push('全站外部連結檢查');
    summary.push(`  盤點來源：${inventoryPath}（${inventoryTotal} 個去重網址）`);
    summary.push(`  本次檢查：${targetsCount}`);
    summary.push(`  健康　　：${healthy}`);
    summary.push(`  失效　　：${dead.length}`);
    summary.push(`  位址封鎖：${urlBlockedCount}`);
    summary.push(`  無法判定：${unverified.length + contentUnverified.length + soft404Unverified.length}`);
    summary.push(`  已列例外：${suppressed.length}`);
    summary.push(`  軟 404　：${soft404.length}（只命中一次 ${soft404Unverified.length}、提示 ${soft404Hints.length}、隨機路徑 ${probedRandoms(soft404Run)}）`);
    if (skipped) summary.push(`  未檢查　：${skipped}（逾時間預算）`);
    summary.push(`  內容 API：${content.checked}（${contentCounts(content)}；頁面驗不到、沒打 API 的 ${content.pageUnverified.length} 筆）`);
    summary.push('內文裸網域（只寫在說明文字裡的網域）');
    summary.push(`  盤點候選：${bareInfo.total}（其中 ${bareInfo.alreadyCoveredByUrls} 個已由盤點的網址涵蓋，不重複檢查）`);
    summary.push(`  DNS 篩掉：${bareRejected.length}（TLD 確定不存在＝檔名或縮寫，不是網域）`);
    if (bareUnresolved.length) summary.push(`  DNS 未答：${bareUnresolved.length}（查不到答案，本次未檢查——不等於它們不是網域）`);
    summary.push(`  實際探測：${bareHostsCount}`);
    summary.push(`  健康　　：${bareHealthy}`);
    summary.push(`  失效　　：${bareDead.length}`);
    summary.push(`  位址封鎖：${blocked.length - urlBlockedCount}`);
    summary.push(`  無法判定：${bareOther.length}`);
    if (bareSkipped) summary.push(`  未檢查　：${bareSkipped}（逾時間預算）`);
    if (expiringSoon.length) summary.push(`⏰ ${EXPIRY_NOTICE_DAYS} 天內到期的政策項目：${expiringSoon.length}`);
    if (hijackedHits.length) summary.push(`🚨 已知不可信任的主機：${hijackedHits.length}（盤點的網址 ${hijackedHits.filter((h) => h.source === 'url').length}）`);
    // 無條件印，即使是 0。只在有命中時才印的話，「這次沒偵測到」與「偵測根本沒跑」
    // 在 CI log 上長得一模一樣。
    summary.push(
        `🕵️ 自動偵測：需處理 ${actionableSignals.length}（內容標記／HTTP 盲區）、` +
            `僅供瀏覽 ${browseOnlySignals.length}（跨站轉址，誤判率高）`,
    );
    const tail = [];
    if (limit > 0) tail.push(`→ 使用了 --limit ${limit}：只驗了一部分，coverage_complete 一律為 false。`);
    const urlSkipped = skipped + bareSkipped + content.skipped + soft404Run.recheckSkipped;
    if (!coverageComplete) tail.push(`→ 覆蓋不完整：${skippedText(urlSkipped, soft404Run.randomsSkipped)}、${bareUnresolved.length} 筆未篩選，不可視為健康。`);
    tail.push(attention ? '→ 有項目需要處理，已寫入報告。' : '→ 無待辦項目。');
    return { consoleSummary: summary, consoleTail: tail };
}

/**
 * buildReport 把一輪探測的原始結果整理成週報、通知條件與主控台輸出。check-external-links.mjs 讀檔、
 * 探測之後把資料原樣交進來；通知條件只算一次，報告、GITHUB_OUTPUT 與主控台都用同一份。
 * @param {object} input 盤點與探測結果（targets、results、skipped）、裸網域的候選、篩選與探測結果
 *   （bareInfo、bareCandidates、screen、bareResults、bareSkipped）、policy（entries 與 hijacked）、
 *   todayISO、limit、inventoryPath、inventoryTotal、budgetMs、bareBudgetMs、contentResults，以及 runSoft404 的回傳值 soft404
 * @returns {{report: string, attention: boolean, coverageComplete: boolean, githubOutput: string, consoleSummary: string[], consoleTail: string[]}}
 */
export function buildReport(input) {
    const { todayISO, limit, targets, results, skipped, bareCandidates, screen, bareResults, bareSkipped, policy } = input;
    const contentResults = input.contentResults ?? [];
    const soft404Run = input.soft404 ?? NO_SOFT404;
    const dead = [];
    const blocked = [];
    const unverified = [];
    const suppressed = [];
    // 命中 hijacked 名單的主機，不論狀態碼都單獨列出、不算進健康。哪些要通知見 needsAttention。
    const hijackedHits = [];
    // 自動偵測到的可疑訊號（#117）。與上面那份名單的差別是它不需要有人先發現：
    // 訊號 A 看轉址終點有沒有離開起點的網域，訊號 B 看標題／描述有沒有蹲域名的
    // 變現詞組，訊號 C 看回應是不是沒有可見文字、只能靠 JavaScript 轉址前進的空殼。
    // 這些訊號都不改變三態分類，因為誤判的代價不對稱：把正常網站判成 dead 會讓人
    // 去修沒壞的東西，多報一筆可疑只是多看一眼。
    const autoSignals = [];
    let healthy = 0;
    const content = { ...NO_CONTENT, pageUnverified: [] };
    const contentUnverified = [];
    const soft404 = [];
    const soft404Unverified = [];
    const soft404Hints = [];
    const urlBins = { blocked, hijacked: hijackedHits, dead, soft404, suppressed, unverified, contentUnverified, soft404Unverified };
    for (let i = 0; i < targets.length; i++) {
        const r = results[i];
        const unchecked = !r || classifyLink(r) === 'unverified';
        if (unchecked && matchContentCheck(policy.contentChecks, targets[i].url)) content.pageUnverified.push(targets[i].url);
        if (!r) continue; // 預算用盡，未檢查
        const judged = judgeUrl(targets[i], r, policy, contentResults[i], soft404Run.verdicts[i]);
        const { bin, item, signal } = judged;
        if (judged.content) {
            content.checked++;
            content[judged.content]++;
            if (!contentResults[i]) content.skipped++;
        }
        if (signal) autoSignals.push(signal);
        if (judged.hint) soft404Hints.push(judged.hint);
        if (bin === 'healthy') healthy++;
        else urlBins[bin].push(item);
    }

    // url 路徑先前有幾筆被擋。裸網域被擋下的會併進同一個 blocked 桶（見下方註解），
    // 這裡先記住分界，好讓主控台的兩段數字仍然分得開。
    const urlBlockedCount = blocked.length;
    const occurrencesOfHost = new Map(bareCandidates.map((h) => [h.host, h.occurrences ?? []]));
    const bareDead = [];
    const bareOther = [];
    let bareHealthy = 0;
    // 被位址政策擋下＝這筆資料指向 loopback／私網／雲端 metadata。那是資料被
    // 竄改或寫錯的訊號，不是「網域失效、請改寫內文」，所以不放進下面「說明文字
    // 裡的網域失效」那一段稀釋掉，而是與 url 路徑共用同一個 blocked 桶子，不論
    // 從哪條路徑進來，報告都用同樣大聲的措辭。
    const bareBins = { blocked, hijacked: hijackedHits, dead: bareDead, unverified: bareOther };
    for (let i = 0; i < screen.accepted.length; i++) {
        const r = bareResults[i];
        if (!r) continue;
        const host = screen.accepted[i];
        const target = { host, url: probeUrlFor(host), occurrences: occurrencesOfHost.get(host) ?? [] };
        const { bin, item, signal } = judgeBare(target, r, { hijacked: policy.hijacked });
        if (signal) autoSignals.push(signal);
        if (bin === 'healthy') bareHealthy++;
        else bareBins[bin].push(item);
    }

    // 問不到 TLD 答案的候選並沒有被探測過，等同「未檢查」，不可以算進完整覆蓋。
    // --limit 同理：它是本機除錯用的旗標，只驗前 N 筆，其餘完全沒看過；算成完整覆蓋的話，
    // 一次只驗 3 筆的執行也會宣稱「全站都查過了」。
    const coverageComplete = limit <= 0 && skipped === 0 && bareSkipped === 0 && content.skipped === 0 && screen.unresolved.length === 0 &&
        soft404Run.randomsSkipped === 0 && soft404Run.recheckSkipped === 0;
    const expiringSoon = expiringPolicyItems(policy.entries, policy.hijacked, todayISO, policy.contentChecks);
    const model = {
        todayISO,
        inventoryTotal: input.inventoryTotal,
        targetsCount: targets.length,
        healthy,
        dead,
        blocked,
        urlBlockedCount,
        unverified,
        suppressed,
        hijackedHits,
        autoSignals,
        bareInfo: input.bareInfo,
        bareRejected: screen.rejected,
        bareUnresolved: screen.unresolved,
        bareHostsCount: screen.accepted.length,
        bareHealthy,
        bareDead,
        bareOther,
        skipped,
        bareSkipped,
        budgetMs: input.budgetMs,
        bareBudgetMs: input.bareBudgetMs,
        content,
        contentUnverified,
        soft404,
        soft404Unverified,
        soft404Hints,
        soft404Run,
        coverageComplete,
        expiringSoon,
    };
    const attention = needsAttention(model);
    return {
        report: renderReport({ ...model, attention }),
        attention,
        coverageComplete,
        githubOutput: `needs_attention=${attention}\ncoverage_complete=${coverageComplete}\n`,
        ...consoleLines({ ...model, attention, limit, inventoryPath: input.inventoryPath }),
    };
}
