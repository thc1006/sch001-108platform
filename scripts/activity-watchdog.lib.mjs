// 競賽看門狗對多元表現資料庫做的判斷：精選活動快截止或已截止，以及該回官網重查的活動。
// selectRecheckDue 也用在競賽。
// 判斷放在這裡給 activity-watchdog.test.mjs 測試，分級與寫報告在 check-competitions.mjs。
import { DATE_ONLY_RE } from './check-competitions.lib.mjs';

const DAY_MS = 86_400_000;

/** dayUTC 回傳 YYYY-MM-DD 那天的 UTC 零點，不是存在的日期時回傳 null。 */
function dayUTC(value) {
    if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) return null;
    const [y, m, d] = value.split('-').map(Number);
    const ms = Date.UTC(y, m - 1, d);
    // Date.UTC 會把 2027-02-29 捲成 3/1，轉回字串對不上的就不是存在的日期。
    return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

const labelOf = (a) => (typeof a.title === 'string' && a.title.trim() ? a.title : '（未命名）');

/**
 * featuredAlert 在頁面精選的那一筆 soonDays 天內截止或已經截止時回傳提醒，其他情況回傳 null。
 * 頁面只看第一筆 featured，這裡也一樣。沒有截止日的不會到期，不提醒。
 * days 是距截止日的天數：截止日當天是 0，頁面還算可以報名；已截止是負數。
 * @param {unknown} activities @param {number} todayUTC 台灣日曆日的 UTC 零點 @param {number} soonDays
 * @returns {{label: string, deadline: string, days: number}|null}
 */
export function featuredAlert(activities, todayUTC, soonDays) {
    const list = Array.isArray(activities) ? activities : [];
    const featured = list.find((a) => a !== null && typeof a === 'object' && a.featured);
    const deadline = featured ? dayUTC(featured.deadline) : null;
    if (deadline === null) return null;
    const days = (deadline - todayUTC) / DAY_MS;
    return days <= soonDays ? { label: labelOf(featured), deadline: featured.deadline, days } : null;
}

/**
 * selectRecheckDue 列出 recheckOn 已到的活動或競賽，當天就算到，預定日最早的排前面。recheckOn 是編輯者
 * 照官網寫的時間或上一屆的日期定下的回來查的日子，不是活動日期，所以不看截止日。
 * recheckOn 不是存在的日期時當成沒填，由 selectActivityRecheck 或 selectNeedsRecheck 照天數處理。
 * @param {unknown} activities @param {number} todayUTC 台灣日曆日的 UTC 零點
 * @returns {Array<{label: string, recheckOn: string, checked: string, note: string}>}
 */
export function selectRecheckDue(activities, todayUTC) {
    const out = [];
    for (const a of Array.isArray(activities) ? activities : []) {
        if (a === null || typeof a !== 'object') continue;
        const due = dayUTC(a.recheckOn);
        if (due === null || due > todayUTC) continue;
        out.push({
            label: labelOf(a),
            recheckOn: a.recheckOn,
            checked: dayUTC(a.sourceCheckedAt) === null ? '（無）' : a.sourceCheckedAt,
            note: typeof a.recheckNote === 'string' && a.recheckNote.trim() ? a.recheckNote : '（沒寫）',
        });
    }
    return out.sort((x, y) => x.recheckOn.localeCompare(y.recheckOn));
}

/**
 * selectActivityRecheck 列出截止日已過或沒有截止日、而且 sourceCheckedAt 距今至少 minDays 天的活動，
 * 最久沒查的排前面。截止日還沒到的，頁面顯示的是查證過的本屆截止日，不列。已截止的照 _readme 留著
 * 本屆的截止日，下一屆何時開放資料裡沒有，所以和沒有截止日的一樣，只看上次查證是幾天前，不推算日期。
 * 有 recheckOn 的照預定日提醒，不列。沒有查證日期的算從未查過，days 是 Infinity。
 * closedDays 是截止日已過幾天，沒有截止日時是 null。
 * @param {unknown} activities @param {number} todayUTC 台灣日曆日的 UTC 零點 @param {number} minDays
 * @returns {Array<{label: string, checked: string, days: number, deadline: unknown, rolling: boolean, closedDays: number|null}>}
 */
export function selectActivityRecheck(activities, todayUTC, minDays) {
    const out = [];
    for (const a of Array.isArray(activities) ? activities : []) {
        if (a === null || typeof a !== 'object') continue;
        if (dayUTC(a.recheckOn) !== null) continue;
        const deadline = dayUTC(a.deadline);
        if (deadline !== null && deadline >= todayUTC) continue;
        const checked = dayUTC(a.sourceCheckedAt);
        const days = checked === null ? Infinity : (todayUTC - checked) / DAY_MS;
        if (days < minDays) continue;
        out.push({
            label: labelOf(a),
            checked: checked === null ? '（無）' : a.sourceCheckedAt,
            days,
            deadline: a.deadline ?? null,
            rolling: a.rolling === true,
            closedDays: deadline === null ? null : (todayUTC - deadline) / DAY_MS,
        });
    }
    return out.sort((x, y) => y.days - x.days);
}
