/**
 * 看門狗要接管哪一個 issue？
 * --------------------------------------------------------------
 * 這段邏輯原本是內嵌在 workflow YAML 裡的一行 jq。抽出來的理由是它曾經真的出過
 * 事：先前只用標籤辨認，而標籤是任何人都能貼的共用屬性——#70（人工開立的追蹤
 * issue）用了同一個標籤，連續四週的週報全被貼到那裡，且完全沒有錯誤訊號。
 *
 * 內嵌在 YAML 裡的判斷沒辦法寫測試，只能靠人工假造 gh 驗一次；日後改 jq 或改
 * author 格式時，CI 不會攔下回歸。所以移到這裡，由 check-competitions.probe.test.mjs
 * 覆蓋。
 */

/** 寫進 issue body 的機器標記，證明這則 issue 是本 workflow 產生的。 */
export const WATCHDOG_MARKER = '<!-- competitions-watchdog:v1 -->';

/**
 * 全站外部連結健檢的機器標記。刻意與競賽看門狗**不同**：兩支排程若共用同一個
 * 標記，就會互相接管對方的 issue——先接管到的那一支把對方的報告蓋掉，而且雙方
 * 都不會有任何錯誤訊號。這正是 #70 那種「安靜貼錯地方」的失效模式。
 */
export const EXTERNAL_LINKS_MARKER = '<!-- external-links-watchdog:v1 -->';

/** issue 層級的 bot 作者格式。留言層級是 "github-actions"，兩者不可混用。 */
export const ACTIONS_APP_LOGIN = 'app/github-actions';

/**
 * 從候選 issue 中挑出唯一一個「本 workflow 自己開的」。
 *
 * 認領條件有兩個，其一不符就不接管：
 *   1. 作者是 GitHub Actions App
 *   2. body 內含機器標記
 *
 * 這組條件擋得住「意外撞號」——也就是實際發生過的 #70 那種情況：人工 issue 貼了
 * 同一個標籤。但它**不是** workflow 層級的來源證明：
 *   - 同 repo 內任何使用 GITHUB_TOKEN 的 workflow，作者同樣是 Actions App；
 *   - 有寫入權限的人可以把標記貼進自己的 issue，也可以從既有 issue 刪掉它。
 * 所以不要把它讀成「無法偽造」。它的作用是讓共用屬性（標籤）不再單獨決定歸屬。
 *
 * 找到多於一個時回傳 'fail' 而不是取第一個：兩個 canonical issue 同時存在，代表
 * 先前發生過競態或有人手動複製了標記，安靜地挑一個會讓另一個永遠收不到報告。
 *
 * marker 參數讓同一套認領邏輯服務多支看門狗（競賽、全站外部連結）。預設值是
 * 競賽的標記，既有呼叫端不必改動；但每一支排程都必須傳自己的標記，否則兩支會
 * 搶同一個 issue。
 *
 * @param {Array<{number:number, author?:{login?:string}, body?:string}>} issues
 * @param {string} [marker] 該 workflow 自己的機器標記
 * @returns {{action:'create'}|{action:'comment', number:number}|{action:'fail', numbers:number[]}}
 */
export function selectCanonicalIssue(issues, marker = WATCHDOG_MARKER) {
    const list = Array.isArray(issues) ? issues : [];
    // 空字串／非字串的 marker 會讓 includes() 對每一則 issue 都成立，等於「只看
    // 作者」——正是先前出過事的那種認領方式。寧可拋錯也不要安靜地放寬條件。
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
