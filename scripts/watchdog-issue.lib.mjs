// 看門狗排程認領 issue 用的機器標記與判斷，workflow 透過 find-watchdog-issue.mjs 呼叫。
// 判斷寫在 workflow YAML 裡就沒辦法測試，所以放在這裡，由 check-competitions.probe.test.mjs
// 和 link-health.test.mjs 測試。

/** 競賽看門狗寫進 issue body 的機器標記，下一輪靠它認出自己開的 issue。 */
export const WATCHDOG_MARKER = '<!-- competitions-watchdog:v1 -->';

/** 全站外部連結健檢的機器標記。和競賽看門狗用不同的標記，兩支排程才不會接管對方的 issue。 */
export const EXTERNAL_LINKS_MARKER = '<!-- external-links-watchdog:v1 -->';

/** issue 層級的 bot 作者格式。留言層級是 "github-actions"，兩者不可混用。 */
export const ACTIONS_APP_LOGIN = 'app/github-actions';

/**
 * selectCanonicalIssue 從候選 issue 裡挑出呼叫的 workflow 自己開的那一個：作者是 GitHub Actions App，
 * 而且 body 含有 marker。標籤誰都能貼，只看標籤會接管人工開的 issue（#70）。
 * 這兩個條件擋得住意外撞號，但不能證明來源：同 repo 用 GITHUB_TOKEN 的 workflow 作者都是
 * Actions App，有寫入權限的人也能在 issue 裡貼上或刪掉標記。
 * 符合的不只一個時回傳 'fail' 而不挑第一個：挑了，另一個就永遠收不到報告。
 * 每支排程都要傳自己的 marker，省略時用競賽看門狗的標記。
 * @param {Array<{number:number, author?:{login?:string}, body?:string}>} issues
 * @param {string} [marker] 該 workflow 自己的機器標記
 * @returns {{action:'create'}|{action:'comment', number:number}|{action:'fail', numbers:number[]}}
 */
export function selectCanonicalIssue(issues, marker = WATCHDOG_MARKER) {
    const list = Array.isArray(issues) ? issues : [];
    // marker 是空字串時 includes() 對每一則 issue 都成立，認領就只剩作者一個條件。
    // 非字串和只有空白的值一起擋下，寧可拋錯也不放寬。
    if (typeof marker !== 'string' || marker.trim() === '') {
        throw new TypeError('selectCanonicalIssue：marker 必須是非空字串');
    }
    const mine = list.filter(
        (i) =>
            i !== null &&
            typeof i === 'object' &&
            i.author?.login === ACTIONS_APP_LOGIN &&
            typeof i.body === 'string' &&
            i.body.includes(marker) &&
            Number.isInteger(i.number),
    );
    if (mine.length === 0) return { action: 'create' };
    if (mine.length === 1) return { action: 'comment', number: mine[0].number };
    return { action: 'fail', numbers: mine.map((i) => i.number).sort((a, b) => a - b) };
}
