/**
 * 外部連結健檢的共用核心
 * --------------------------------------------------------------
 * 本專案有多個地方需要判斷「這個外部網址還活著嗎」：競賽資料看門狗、公民科技
 * 專案地圖、以及涵蓋其餘資料檔與 build 產物的 external-links 檢查。這些判斷的
 * 語意必須一致，否則同一個網址在不同報告裡會得到不同結論。
 *
 * 因此探測與分類集中在這裡，由 link-health.test.mjs 以本機 http server 做確定性
 * 測試（不依賴外網——外網測試會因防爬與站台狀態而飄）。
 */

// ── 分類門檻 ──
// 只有「網域解析不到」與 404/410 才算失效。競賽與教育網站大量使用 Cloudflare 等
// 防爬機制，403/429/5xx/逾時在瀏覽器多半仍開得起來，一律歸入「無法判定」只做
// 記錄，避免每週誤報把維護者訓練成忽略通知。
export const DEAD_STATUSES = new Set([404, 410]);
export const LINK_TIMEOUT_MS = 20_000;

// 目的是「重現使用者用瀏覽器點下去的結果」。不少站台對非瀏覽器 UA 會回 403/404，
// 用一般爬蟲 UA 會產生大量誤判，故沿用瀏覽器 UA。
export const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 一律用 GET：目的是重現「使用者用瀏覽器點下去」的結果，而 HEAD 不是瀏覽器實際
 * 送的請求。曾用 HEAD 省流量，但站台對 HEAD 的回應並不可靠——有的不支援而回
 * 404/500（Kaggle、tpmso.org），更糟的是有的 HEAD 回 200 但 GET 其實 404，
 * 會被誤判為健康。
 *
 * 讀完 status 後立刻 cancel body：Node 的 undici 不像瀏覽器會積極回收，未消耗的
 * response body 會占住連線、無法重用，在這種一次上百站的批次工作下可能拖垮或卡死。
 */
export async function probe(url, signal) {
    let res = null;
    try {
        res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: signal ?? AbortSignal.timeout(LINK_TIMEOUT_MS),
            headers: {
                'User-Agent': UA,
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
            },
        });
        return { status: res.status, finalUrl: res.url };
    } catch (err) {
        const code = err?.cause?.code || err?.code || '';
        return { status: 0, code, message: String(err?.message || err).slice(0, 120) };
    } finally {
        // 放在 finally，確保日後新增 return 分支也不會漏掉
        await res?.body?.cancel().catch(() => {});
    }
}

/** 網域解析不到＝連結確定失效；其餘連線層錯誤（TLS、逾時等）歸為無法判定。 */
export const isDeadResult = (r) => r.code === 'ENOTFOUND' || DEAD_STATUSES.has(r.status);

/** healthy / dead / unverified 三態。三態是刻意的：把「驗不到」與「確定壞了」分開。 */
export function classifyLink(r) {
    if (isDeadResult(r)) return 'dead';
    if (r.status === 0 || r.status >= 400) return 'unverified';
    return 'healthy';
}

/** 人類可讀的原因描述，報告與 summary 共用。 */
export function describeResult(r) {
    if (r.code === 'ENOTFOUND') return '網域無法解析';
    if (r.status) return `HTTP ${r.status}`;
    return r.code || '連線失敗';
}

/**
 * 批次探測。併發、全域時間預算、失效前重試、起點輪替都在這裡，供所有檢查器共用，
 * 避免各自複製一份而漸漸長出不同語意。
 *
 * 回傳 { results, skipped }：results[i] 對應 urls[i]（未檢查者為 null），
 * skipped 為因預算用盡而未檢查的筆數——呼叫端必須據此避免宣稱「全部正常」。
 *
 * @param {string[]} urls
 * @param {{concurrency?:number, budgetMs?:number, timeoutMs?:number, rotateSeed?:number, probeFn?:Function}} [opts]
 */
export async function runProbes(urls, opts = {}) {
    const concurrency = opts.concurrency ?? 4; // 部分站台（如 tpmso.org）併發過高會回 5xx
    const budgetMs = opts.budgetMs ?? 8 * 60_000;
    const timeoutMs = opts.timeoutMs ?? LINK_TIMEOUT_MS;
    const probeFn = opts.probeFn ?? probe;

    const results = new Array(urls.length).fill(null);
    if (urls.length === 0) return { results, skipped: 0 };

    const budgetEnd = Date.now() + budgetMs;
    const remaining = () => budgetEnd - Date.now();
    const outOfBudget = () => remaining() <= 0;

    // 硬截止：單筆逾時取「剩餘預算」與 timeoutMs 的較小值，並疊上全域 abort，避免
    // 最後一筆在預算末端才起跑、又獨自跑滿逾時而超出預算。
    const globalAbort = new AbortController();
    const budgetTimer = setTimeout(() => globalAbort.abort(), budgetMs);
    const probeWithin = (url) =>
        probeFn(
            url,
            AbortSignal.any([
                globalAbort.signal,
                AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining()))),
            ]),
        );

    // 每次從不同位置起跑。若 runner 網路變差而經常用完預算，固定從 0 開始會讓清單
    // 尾端永遠檢查不到；輪替起點可讓覆蓋率長期均勻。
    const seed = opts.rotateSeed ?? 0;
    const startAt = ((seed % urls.length) + urls.length) % urls.length;
    const order = urls.map((_, i) => (startAt + i) % urls.length);

    let cursor = 0;
    try {
        await Promise.all(
            Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
                while (cursor < order.length && !outOfBudget()) {
                    const slot = order[cursor++];
                    results[slot] = await probeWithin(urls[slot]);
                }
            }),
        );

        // 判定失效前再單獨重試一次，濾掉併發造成的暫時性錯誤
        for (let i = 0; i < results.length; i++) {
            if (results[i] && isDeadResult(results[i]) && !outOfBudget()) {
                results[i] = await probeWithin(urls[i]);
            }
        }
    } finally {
        clearTimeout(budgetTimer);
    }

    return { results, skipped: results.filter((r) => r === null).length };
}
