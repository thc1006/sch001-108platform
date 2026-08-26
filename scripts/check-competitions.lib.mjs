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

/** 必填的文字欄位——頁面會直接當字串用（例如 comp.form.includes()）。 */
export const TEXT_FIELDS = [
    'title',
    'organizer',
    'category',
    'level',
    'form',
    'region',
    'eligibility',
    'mode',
    'description',
    'url',
];

/**
 * 競賽物件允許出現的全部欄位。
 *
 * cycle 內部本來就有同類的白名單，但物件本身先前沒有——於是
 * "cyle": { "closes": "09" }（少一個 c）這種錯字只要必填欄位都在就會通過驗證，
 * 前端則靜默忽略它。該筆競賽的週期資訊等於憑空消失，且沒有任何訊號。
 */
export const ALLOWED_COMPETITION_FIELDS = new Set([
    ...TEXT_FIELDS,
    'deadline',
    'cycle',
    // 報名時程與賽事日期（皆選填，見下方 validateSchedule）
    'deadlineAt',
    'opensAt',
    'eventStartsAt',
    'eventEndsAt',
    'registrationNote',
    'sourceCheckedAt',
]);

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


// ── 報名時程與賽事日期 ──
//
// 原本只有一個 deadline（YYYY-MM-DD），它同時被拿來表達三件不同的事：報名截止、
// 賽事開始、以及「大概那個時候」。混在一起會產生實際的錯誤：
//
//   - OPhO 的 8/21 是「比賽日期」，卻被顯示成「報名截止」；
//   - Breakthrough 官方截止是 9/15 23:59 PDT，換算台灣是 9/16 14:59。只存日期的話，
//     台灣時間 9/15 凌晨就顯示「今日截止」（實際還有 39 小時），9/16 00:00 起就
//     顯示「已截止」（實際還有近 15 小時）。
//
// 下面這幾個欄位都是選填、可加可不加，不需要一次遷移全部資料。

/** YYYY-MM-DD（純日期，無時刻概念）。 */
export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * ISO 8601 時刻，**必須**帶明確的時區位移（Z 或 ±HH:MM）。
 *
 * 不接受省略時區的寫法（"2026-09-15T23:59:00"）：那會被瀏覽器當成使用者的本地
 * 時間解析，同一筆資料在不同時區的人眼中是不同的時刻——正是這一組欄位要修掉的
 * 問題本身。與其容忍它再猜一個時區，不如在 CI 就擋下來。
 */
export const INSTANT_RE =
    /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;

/** 日期是否真實存在（往返比對可抓出 2026-02-30 這種被 Date 靜默正規化的值）。 */
function isRealDate(y, mo, d) {
    const t = new Date(Date.UTC(y, mo - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** 驗證 YYYY-MM-DD 欄位（選填）。回傳是否有效。 */
export function validateDateOnly(value, field, label, errors) {
    if (value === undefined) return true;
    if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) {
        errors.push(`「${label}」的 ${field}「${value}」須為 YYYY-MM-DD`);
        return false;
    }
    const [y, mo, d] = value.split('-').map(Number);
    if (!isRealDate(y, mo, d)) {
        errors.push(`「${label}」的 ${field}「${value}」不是實際存在的日期`);
        return false;
    }
    return true;
}

/** 驗證帶時區的 ISO 時刻欄位（選填）。回傳是否有效。 */
export function validateInstant(value, field, label, errors) {
    if (value === undefined) return true;
    if (typeof value !== 'string' || !INSTANT_RE.test(value)) {
        errors.push(
            `「${label}」的 ${field}「${value}」須為帶時區位移的 ISO 時刻，` +
                '例如 2026-09-15T23:59:00-07:00（不可省略時區）',
        );
        return false;
    }
    const [y, mo, d] = value.slice(0, 10).split('-').map(Number);
    if (!isRealDate(y, mo, d)) {
        errors.push(`「${label}」的 ${field}「${value}」的日期部分不存在`);
        return false;
    }
    if (Number.isNaN(Date.parse(value))) {
        errors.push(`「${label}」的 ${field}「${value}」無法被解析為時刻`);
        return false;
    }
    return true;
}

/**
 * 驗證整組報名／賽事時程欄位，並檢查彼此的先後關係。
 *
 * 只驗證「同一種精度之間」的順序。跨精度（日期 vs 時刻）不比對——那需要假設一個
 * 時區，而假設時區正是這組欄位要消滅的東西。
 */
export function validateSchedule(comp, label, errors) {
    validateInstant(comp.deadlineAt, 'deadlineAt', label, errors);
    validateInstant(comp.opensAt, 'opensAt', label, errors);
    validateDateOnly(comp.eventStartsAt, 'eventStartsAt', label, errors);
    validateDateOnly(comp.eventEndsAt, 'eventEndsAt', label, errors);
    validateDateOnly(comp.sourceCheckedAt, 'sourceCheckedAt', label, errors);

    if (comp.registrationNote !== undefined) {
        if (typeof comp.registrationNote !== 'string' || comp.registrationNote.trim() === '') {
            errors.push(`「${label}」的 registrationNote 必須是非空字串`);
        } else if ([...comp.registrationNote.trim()].length > 30) {
            // 它會直接當成卡片的狀態列文字，過長會撐破版面。詳細說明請寫進 description。
            errors.push(`「${label}」的 registrationNote 過長（上限 30 字，目前 ${[...comp.registrationNote.trim()].length} 字）`);
        }
    }

    // 賽事結束不得早於開始
    if (
        typeof comp.eventStartsAt === 'string' &&
        typeof comp.eventEndsAt === 'string' &&
        DATE_ONLY_RE.test(comp.eventStartsAt) &&
        DATE_ONLY_RE.test(comp.eventEndsAt) &&
        comp.eventEndsAt < comp.eventStartsAt
    ) {
        errors.push(`「${label}」的 eventEndsAt（${comp.eventEndsAt}）早於 eventStartsAt（${comp.eventStartsAt}）`);
    }
    // 只有結束沒有開始，是資料寫了一半
    if (comp.eventEndsAt !== undefined && comp.eventStartsAt === undefined) {
        errors.push(`「${label}」有 eventEndsAt 卻沒有 eventStartsAt`);
    }

    // 報名開放不得晚於報名截止
    const opensMs = typeof comp.opensAt === 'string' ? Date.parse(comp.opensAt) : NaN;
    const closesMs = typeof comp.deadlineAt === 'string' ? Date.parse(comp.deadlineAt) : NaN;
    if (!Number.isNaN(opensMs) && !Number.isNaN(closesMs) && opensMs >= closesMs) {
        errors.push(`「${label}」的 opensAt 不早於 deadlineAt`);
    }

    // deadlineAt 存在時必須同時有 deadline。頁面的狀態列用 deadlineAt（精確時刻），
    // 但卡片底部那一欄讀的是 deadline——只填其中一個會出現「報名中 · 剩 70 天」
    // 配上「依官網公告」這種自相矛盾的卡片。
    if (typeof comp.deadlineAt === 'string' && comp.deadlineAt && !comp.deadline) {
        errors.push(`「${label}」有 deadlineAt 卻沒有 deadline，兩者必須並存`);
    }

    // 兩者並存時日期部分必須一致——不一致代表其中一個沒跟著更新，而頁面只會採用
    // deadlineAt，另一個會靜默地變成錯的。
    if (
        typeof comp.deadlineAt === 'string' &&
        INSTANT_RE.test(comp.deadlineAt) &&
        typeof comp.deadline === 'string' &&
        DATE_ONLY_RE.test(comp.deadline) &&
        comp.deadlineAt.slice(0, 10) !== comp.deadline
    ) {
        errors.push(
            `「${label}」的 deadline（${comp.deadline}）與 deadlineAt（${comp.deadlineAt.slice(0, 10)}）日期不一致`,
        );
    }
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
export function nextOccurrenceUTC(closes, todayUTC, lastEditionUTC = null) {
    if (typeof closes !== 'string' || !CYCLE_MMDD_RE.test(closes)) return null;
    const [mm, dd] = closes.split('-').map(Number);
    // dd 未給則取該月最後一天。給了 dd 但該年無此日（例如平年的 02-29）時同樣
    // 退回該月最後一天，避免 Date 靜默跨月（02-29 → 03-01）。
    const build = (y) => {
        if (!dd) return Date.UTC(y, mm, 0);
        const wanted = Date.UTC(y, mm - 1, dd);
        return new Date(wanted).getUTCMonth() === mm - 1 ? wanted : Date.UTC(y, mm, 0);
    };
    // lastEditionUTC＝已知「本屆」的確切截止日（必須是已過的日期）。有了它就不能
    // 只看今天：OPhO 本屆 8/21 結束、週期僅精確到月（08），單看今天會算出同月的
    // 8/31，誤報成「下屆剩 4 天」。
    //
    // 但也不能直接用「本屆年份 + 1」：跨年季會整整漏掉一輪。截止日 2026-01-15、
    // 週期記 12 月時，那個截止日屬於 2025-12 那一輪，下一輪是 2026-12——用 +1 會
    // 算成 2027-12，把學生還能報名的整整一年吃掉。所以要先問「本屆對應到週期的
    // 哪一個實例」：取離本屆截止日最近的那一年當錨點，再往後推一輪。
    let year;
    if (lastEditionUTC === null) {
        year = new Date(todayUTC).getUTCFullYear();
    } else {
        const ly = new Date(lastEditionUTC).getUTCFullYear();
        let anchor = ly;
        let best = Infinity;
        for (const y of [ly - 1, ly, ly + 1]) {
            const gap = Math.abs(build(y) - lastEditionUTC);
            if (gap < best) {
                best = gap;
                anchor = y;
            }
        }
        year = anchor + 1;
    }
    let candidate = build(year);
    // 資料若久未更新（本屆截止日已過一年以上），持續往後推到未來為止
    while (candidate < todayUTC) candidate = build(++year);
    return candidate;
}
