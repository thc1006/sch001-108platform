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
 * @param {Array<{number:number, author?:{login?:string}, body?:string}>} issues
 * @returns {{action:'create'}|{action:'comment', number:number}|{action:'fail', numbers:number[]}}
 */
export function selectCanonicalIssue(issues) {
    const list = Array.isArray(issues) ? issues : [];
    const mine = list.filter(
        (i) =>
            i !== null &&
            typeof i === 'object' &&
            i.author?.login === ACTIONS_APP_LOGIN &&
            typeof i.body === 'string' &&
            i.body.includes(WATCHDOG_MARKER) &&
            Number.isInteger(i.number),
    );
    if (mine.length === 0) return { action: 'create' };
    if (mine.length === 1) return { action: 'comment', number: mine[0].number };
    return { action: 'fail', numbers: mine.map((i) => i.number).sort((a, b) => a - b) };
}
