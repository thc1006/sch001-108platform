// 判斷文字裡有沒有看得見的字。輸入與輸出的驗證共用這個定義，兩邊才不會一邊收、一邊擋。
// 看得見的字是字母、數字、標點與符號，扣掉預設可忽略的字元（零寬空白、韓文填充字這類）。點字空白
// （U+2800）畫面上是空白、物件替代字元（U+FFFC）只是佔位，雖然屬於符號也不算。
const VISIBLE = /(?![\u2800\uFFFC\p{Default_Ignorable_Code_Point}])[\p{L}\p{N}\p{P}\p{S}]/u;

/** hasVisibleText 判斷 text 裡有沒有看得見的字。trim() 去不掉零寬空白，不能代替它。 @param {string} text @returns {boolean} */
export function hasVisibleText(text) {
    return VISIBLE.test(text);
}
