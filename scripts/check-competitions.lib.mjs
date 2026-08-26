/**
 * 競賽資料看門狗的可測試核心
 * --------------------------------------------------------------
 * 連結探測與欄位驗證的邏輯抽到這裡，讓 check-competitions.probe.test.mjs
 * 能以本機 http server 做確定性測試，不必依賴外網。
 */

import { probe as guardedProbe } from './link-health.lib.mjs';

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

// ── 連結健檢（實作已移到 link-health.lib.mjs）──
//
// 為什麼要搬：競賽看門狗與全站外部連結健檢都會在 runner 上、帶著寫入權限的
// token 去連我們資料檔裡寫的任意網址。那是一條 SSRF 路徑，而防護只寫在其中
// 一邊等於沒寫——所以探測與分類只能有一份實作。
//
// 這裡保留原本的 export 名稱，讓既有的呼叫端與 check-competitions.probe.test.mjs
// 不必改動。
export { DEAD_STATUSES, LINK_TIMEOUT_MS, UA, isDeadResult, classifyLink } from './link-health.lib.mjs';

/**
 * ⚠ 這個 probe 是**單元測試專用**的相容別名，唯一的放寬是允許 loopback
 * （127.0.0.0/8 與 ::1）——check-competitions.probe.test.mjs 的每一個連線測試都
 * 打本機 http server，嚴格模式下會全部被擋。
 *
 * 除了 loopback 之外沒有任何放寬：private、link-local、雲端 metadata、
 * credential、非 http(s) scheme 在這裡一樣擋得死死的（link-health.test.mjs
 * 有對應測試把這件事釘住）。
 *
 * 真正的看門狗 runner（check-competitions.mjs）不用這個別名，它直接 import
 * link-health.lib.mjs 的嚴格版 probe——所以競賽資料裡若出現指向本機服務的
 * 網址，實際執行時仍然會被擋下。
 */
export const probe = (url, signal) => guardedProbe(url, signal, { allowLoopback: true });

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
