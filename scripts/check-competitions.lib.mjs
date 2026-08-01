/**
 * 競賽資料看門狗的可測試核心
 * --------------------------------------------------------------
 * 連結探測與欄位驗證的邏輯抽到這裡，讓 check-competitions.probe.test.mjs
 * 能以本機 http server 做確定性測試，不必依賴外網。
 */

// ── 欄位允許值（與 competitions.json 的 _readme 一致）──
export const ALLOWED_CATEGORIES = ['科學', '數理', '資訊', '語文人文', '商業管理', '藝術設計', '社會永續', '跨領域'];
export const ALLOWED_LEVELS = ['校際/地區', '全國', '國際'];
export const ALLOWED_REGIONS = ['台灣', '美國', '英國', '歐盟', '東亞', '全球線上', '其他'];
export const ALLOWED_ELIGIBILITY = ['公開報名', '國家隊選拔', '邀請制'];
export const ALLOWED_MODES = ['線上', '實體', '混合'];
export const ALLOWED_FORMS = ['個人', '團體', '個人/團體'];

// ── 連結健檢 ──
export const DEAD_STATUSES = new Set([404, 410]);
export const LINK_TIMEOUT_MS = 20_000;
// 目的是「重現學生用瀏覽器點下去的結果」。不少競賽官網對非瀏覽器 UA 會回
// 403/404，用一般爬蟲 UA 會產生大量誤判，故沿用瀏覽器 UA。
export const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * 一律用 GET：目的是重現「學生用瀏覽器點下去」的結果，而 HEAD 不是瀏覽器實際送的
 * 請求。曾用 HEAD 省流量，但站台對 HEAD 的回應並不可靠——有的不支援而回 404/500
 * （Kaggle、tpmso.org），更糟的是有的 HEAD 回 200 但 GET 其實 404，會被誤判為健康。
 *
 * 讀完 status 後立刻 cancel body：Node 的 undici 不像瀏覽器會積極回收，未消耗的
 * response body 會占住連線、無法重用，在這種每週上百站的批次工作下可能拖垮或卡死。
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

/**
 * 只有「網域解析不到」與 404/410 才算失效並觸發 issue。競賽網站大量使用
 * Cloudflare 等防爬機制，403/429/5xx/逾時在瀏覽器多半仍開得起來，一律歸入
 * 「無法判定」只做記錄，避免每週誤報。
 */
export function classifyLink(r) {
    if (isDeadResult(r)) return 'dead';
    if (r.status === 0 || r.status >= 400) return 'unverified';
    return 'healthy';
}

/**
 * url 必須解析得出、且為 https。先前只檢查「非空字串」，像 htps://… 這種拼錯
 * 協定的值會通過 schema，再被連結健檢的正規表示式靜默濾掉——兩關都不報錯。
 */
export function validateUrl(value, label, errors) {
    let parsed = null;
    try {
        parsed = new URL(value);
    } catch {
        errors.push(`「${label}」的 url「${value}」不是合法的網址`);
        return null;
    }
    if (parsed.protocol !== 'https:') {
        errors.push(`「${label}」的 url 必須使用 https（目前為 ${parsed.protocol}）`);
        return null;
    }
    if (parsed.username || parsed.password) {
        errors.push(`「${label}」的 url 不得內嵌帳號密碼`);
        return null;
    }
    // new URL() 會容忍前後空白，但那通常是資料手誤，仍應攔下
    if (value !== value.trim()) {
        errors.push(`「${label}」的 url 前後有多餘空白`);
        return null;
    }
    return parsed;
}

// ── 年度週期（cycle）──
// 許多競賽每年固定時節舉辦（Foyle 每年 7/31 截止、APMO 每年 3 月）。先前這類
// 資訊只寫在 description 裡，程式算不出來，於是「本屆已截止」的處理方式變成把
// deadline 清空、顯示「依官網公告」——資訊反而被丟掉，而且下一輪看門狗又會
// 重新警告。cycle 把這個週期結構化，讓「已截止但知道下次何時」成為有效狀態。
export const CYCLE_MMDD_RE = /^(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

/** 驗證 cycle 欄位；錯誤推入 errors。cycle 為選填。 */
export function validateCycle(cycle, label, errors) {
    if (cycle === undefined) return;
    if (cycle === null || typeof cycle !== 'object' || Array.isArray(cycle)) {
        errors.push(`「${label}」的 cycle 必須是物件`);
        return;
    }
    for (const key of Object.keys(cycle)) {
        if (!['opens', 'closes', 'note'].includes(key)) {
            errors.push(`「${label}」的 cycle 含未知欄位「${key}」`);
        }
    }
    for (const key of ['opens', 'closes']) {
        if (cycle[key] === undefined) continue;
        if (typeof cycle[key] !== 'string' || !CYCLE_MMDD_RE.test(cycle[key])) {
            errors.push(`「${label}」的 cycle.${key}「${cycle[key]}」須為 MM 或 MM-DD`);
            continue;
        }
        // 正規表示式只管 01-12 與 01-31，攔不掉 02-30、04-31 這種不存在的日期。
        // 沿用 deadline 那套「日期往返檢查」：Date 會把 02-30 正規化成 3 月，
        // 比對回來就抓得到。不做這關的話，二月的競賽會被算成「下次約 3/2」。
        const [mm, dd] = cycle[key].split('-').map(Number);
        if (dd !== undefined) {
            // 用閏年（2024）驗證，讓 02-29 這種「僅閏年存在」的日期視為合法
            const probeDate = new Date(Date.UTC(2024, mm - 1, dd));
            if (probeDate.getUTCMonth() !== mm - 1 || probeDate.getUTCDate() !== dd) {
                errors.push(`「${label}」的 cycle.${key}「${cycle[key]}」不是實際存在的日期`);
            }
        }
    }
    if (cycle.note !== undefined && (typeof cycle.note !== 'string' || !cycle.note.trim())) {
        errors.push(`「${label}」的 cycle.note 必須是非空字串`);
    }
    if (cycle.opens === undefined && cycle.closes === undefined && cycle.note === undefined) {
        errors.push(`「${label}」的 cycle 至少須含 opens、closes 或 note 其一`);
    }
}

/**
 * 依 cycle.closes 推算「下一次截止日」的 UTC 毫秒值。
 * 只知月份時以該月最後一天為準（保守，不會把還開放的競賽說成已截止）。
 * todayUTC 由呼叫端以 Asia/Taipei 日曆日算出，確保頁面與看門狗一致。
 */
export function nextOccurrenceUTC(closes, todayUTC) {
    if (typeof closes !== 'string' || !CYCLE_MMDD_RE.test(closes)) return null;
    const [mm, dd] = closes.split('-').map(Number);
    const year = new Date(todayUTC).getUTCFullYear();
    // dd 未給則取該月最後一天。給了 dd 但該年無此日（例如平年的 02-29）時同樣
    // 退回該月最後一天，避免 Date 靜默跨月（02-29 → 03-01）。
    const build = (y) => {
        if (!dd) return Date.UTC(y, mm, 0);
        const wanted = Date.UTC(y, mm - 1, dd);
        return new Date(wanted).getUTCMonth() === mm - 1 ? wanted : Date.UTC(y, mm, 0);
    };
    const thisYear = build(year);
    return thisYear >= todayUTC ? thisYear : build(year + 1);
}
