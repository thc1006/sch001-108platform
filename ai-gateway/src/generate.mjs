/**
 * 自動續寫引擎：WinLab 單次輸出有長度上限（8192 tokens，含思考），xhigh 想得深的題目
 * 一輪可能寫不完。這裡把「被截斷（finish_reason = length）」接成下一輪，直到答案寫完、
 * 或用完 LLM_MAX_ROUNDS。
 *
 * 為什麼不用 vLLM 原生的 continue_final_message：WinLab 前面的閘道有欄位白名單，
 * continue_final_message、add_generation_prompt、extra_body 一律 400（2026-10-21
 * 實測）。所以只能在「對話層」接續：把已經產出的東西放回對話，再請模型接著做。
 *
 * 每一輪結束後，依「這一輪」產出了什麼決定下一輪怎麼接（不看累計的內容）：
 *
 *   1. 這輪寫出了正文
 *      - 文字任務：把已寫好的正文放回對話（assistant），請模型從斷點接著寫，用
 *        LLM_CONTINUATION_EFFORT：要做的只是把句子寫完，再開 xhigh 只會先花幾千 tokens
 *        想「該怎麼接」，反而更可能再被截斷。模型常把斷點前的幾個字再寫一次，接上前先
 *        去掉重疊（trimOverlap）。活體測試三輪拼接讀不出接縫。
 *      - JSON 任務：不拼接，整份重寫。活體測試拼接 JSON 會在字串中間接歪（上一輪停在
 *        "音樂結構分析，下一輪卻另開 "巴赫"），去重疊也救不了。改把未完成的草稿與思考筆記
 *        放回對話，用 LLM_CONTINUATION_EFFORT 加上原本的 response_format 重寫：不思考時
 *        額度全給正文，json_schema 的 guided decoding 又保證結構合法。也因此 JSON 模式不
 *        逐段送出正文，送出去的片段可能整份作廢。正文其實已經合格（之後只是一直吐空白到
 *        上限、或收完才斷線）就直接收下。寫完了卻不合格的同樣整份重寫，提示詞改說它不符合
 *        格式，不說被截斷。
 *
 *   2. 這輪只有思考（還沒開始寫答案）
 *      - 把思考當成「思考筆記」放回對話，請模型接著想再作答，強度維持設定值（預設 xhigh）。
 *        連續第二次又斷在思考，就請它不要再想、直接作答（強度 none），否則可能每一輪都
 *        從頭想、永遠寫不出答案。思考完已經開始輸出（只吐了幾個換行）才被截斷的，代表思考
 *        其實已經結束、只是額度用完，同樣直接作答。
 *      - 已經在接續正文或重寫 JSON（接續輪的強度被設成會思考時才會發生）：維持原本的
 *        接法、保留已寫的內容，下一輪強制 none。
 *
 *   3. 吐了一大串空白（guided decoding 與長輸出已知的退化）：連續 8 個以上的換行，或 256 字元
 *      以上的一串空白才算。程式碼的縮排、對齊用的空格都在門檻之下，照常保留。
 *      - 整輪只有空白：重做；JSON 任務改成不帶 response_format，最後由閘道自己解析與驗證，
 *        之後每一輪都附上格式要求（jsonFormatPrompt）。
 *      - 正文中間的一大串空白壓成最多兩個換行；寫到一半退化成空白直到被截斷的，空白丟掉、
 *        從最後的文字接著寫（JSON 同時拿掉 response_format）。空白不會送給使用者，也不會
 *        留在結果或帶回下一輪。
 *
 *   不論哪一種，下一輪的請求（不算提醒）若會跟這一輪一模一樣，例如整輪只有空白、只重複了已經
 *   寫過的內容、重寫出同一份草稿，這一輪就算「沒有淨進展」：下一輪加一句提醒（temperature 0
 *   時同樣的請求只會得到同樣的結果），連續兩輪沒有淨進展就提前結束，不把剩下的輪數燒完。
 *
 * 每一輪都要放得進模型的 context：WinLab 這個模型只有 32768 tokens，而且「輸入 + max_tokens」
 * 超過就直接 400，不會自動縮小（2026-10-21 實測）。估算器（estimateTokens）依字元類別估，
 * 對常見中文與英文高估不少、對罕用字與數字可能低估，所以只拿它做第一步：
 *   - 第一輪：估算的可用額度有上限的九成以上就直接送；更少時先用 max_tokens=1 探一次，從
 *     usage.prompt_tokens 拿到精確的輸入 token 數再決定（探測是一次完整的 prefill，WinLab
 *     排隊時還要多等一輪，只差一點點時不值得）。之後幾輪的題目都用這個精確值（或第一輪 usage
 *     的精確值）。
 *   - 接續輪：帶回去的正文、筆記、草稿依「哪一輪寫的」分段，每段用那一輪 usage 的精確 token 數
 *     （completion_tokens − reasoning_tokens 是正文、reasoning_tokens 是思考）換算自己的比例；
 *     拿不到的段落用估算值。整份內容的組成會隨輪次改變（散文接著數字表格），只用一個平均比例
 *     的話，下一輪新加的內容常被估低、白白多一次 400 與探測。每輪的 usage（減去題目）再回推
 *     一個整體的修正係數，同一種接法的下一輪沿用。放不下就裁掉（筆記與草稿留頭尾、正文留結尾），
 *     優先保住完整的輸出額度；連最少的輸出量都擠不出來就以 incomplete 結束，附上已寫好的部分。
 *   - 仍然被 vLLM 以 context 長度拒絕時，探出這組訊息的精確大小，校正後重新規劃再送（同一輪
 *     最多兩次，之後以 incomplete 結束）。錯誤訊息若直接寫出輸入大小（新版 vLLM 的「your request
 *     has N input tokens」）就照用、不必探測；「your prompt contains at least N input tokens」
 *     只是下界（上限 − 要求的輸出 + 1），不是實際大小（2026-10-21 活體測試：實際 26017、訊息
 *     寫 24577）。
 *   - 上游不給 usage（探測成功卻沒有 prompt_tokens）時，這個任務不再探測，也不憑悲觀的估算判定
 *     放不下：改用樂觀的比例規劃，被拒就把比例調高（至少到下界推得出的值）再試，之後幾輪沿用。
 *   - usage 的數字不可能是真的（例如「輸入 + 這次的 max_tokens」超過 context 卻成功了）就當作
 *     沒有 usage，不拿來規劃。
 *   探測帶著跟正式請求相同的參數（思考強度、response_format、temperature），用量照樣計入
 *   （WinLab 的 TPM 會算）。
 *
 * 帶回 prompt 的內容（正文、思考筆記、JSON 草稿，以及續寫指示裡引用的結尾）一律中和 chat
 * template 的控制符號（neutralizeControlTokens）：學生可以先要求模型把全形的 ＜|im_start|＞
 * 照抄成半形，第二輪就繞過了輸入端的中和。送給呼叫端的串流與最後的結果不動。
 *
 * 接續輪遇到可重試的上游錯誤（429 忙線、連線中斷、閒置逾時，探測時遇到的也一樣），在總時限內
 * 退避重試；有 Retry-After 就照它等，等不完總時限就提早放棄。第一輪失敗讓使用者自己重按就好，
 * 但接續輪失敗會把前面幾分鐘的成果全部丟掉。
 *
 * 文字任務串流給呼叫端的文字（onContent）與最後回傳的 content 保證逐字相同：每一輪開頭與
 * 正文中間的空白先暫存，確定不是退化才送；接續輪的開頭再緩衝到確定不會形成更長的重疊，
 * 才去掉重疊送出。async 的 hook 在回傳結果之前都會等它完成（受總時限與取消約束），呼叫端拿到
 * 結果時，所有正文都已經交給它的 hook 處理完。
 *
 * 接續的提示詞都再提醒一次台灣繁體中文：活體測試中，不思考（none）的接續輪寫長文時
 * 會零星冒出簡體字（「阶段」「数据收集」）。
 */
import { neutralizeControlTokens } from './control-tokens.mjs';
import { streamChat, UpstreamError } from './upstream.mjs';

export class GenerationError extends Error {
    /**
     * @param {string} code  incomplete（用完輪數或 context 放不下仍未寫完）| empty（沒有任何正文）|
     *                       format（JSON 任務最後一份正文寫完了卻不合格，之後用完輪數或提前結束）|
     *                       timeout（超過總時限）| stopped（非 stop／length 的結束原因）
     */
    constructor(code, message, { partial, rounds, finishReason, continuations, usage } = {}) {
        super(message);
        this.name = 'GenerationError';
        this.code = code;
        this.partial = partial;
        this.rounds = rounds;
        this.finishReason = finishReason;
        this.continuations = continuations;
        // 失敗之前已經用掉的 tokens（含探測），呼叫端記 log 用
        this.usage = usage;
    }
}

// 去重疊時往回比對的最大字數。模型偶爾會把整段重寫，窗口太小就比不到
export const OVERLAP_WINDOW = 2000;
// 重疊至少要包含幾個「字」（字母、數字、漢字）才算數。只算標點不算：前文以 **粗體** 結尾、
// 下一輪以 **另一個粗體** 開頭時，重疊的 ** 是巧合，去掉會弄壞 Markdown。門檻是兩個字：
// 單字也去的話，疊字被切在中間（「謝謝你」斷在兩個謝之間、下一輪從「謝你」開始）會被吃掉一個字
const MIN_OVERLAP_WORDS = 2;
// 下一輪先換行才開始重複時，重疊要長很多才算：前文最後是標題、下一輪換行寫同樣幾個字開頭的
// 段落是正常的新段落
const MIN_OVERLAP_WORDS_AFTER_SPACE = 8;
// 只有數字的重疊至少要幾位才算：「西元 20」接「20 年」的 20 是巧合，不是重複
const MIN_NUMERIC_OVERLAP = 4;
// 接續指示裡引用的「上一則結尾」長度（Unicode 字元）
const TAIL_HINT = 60;
// 一串空白有這麼多個換行、或這麼長，就當成退化。正常的寫作不會連續空 7 行以上，也不會有
// 256 字元的空白；程式碼的縮排（換行後幾十個空格）與對齊用的空格都在門檻之下
const DEGENERATE_NEWLINES = 8;
const DEGENERATE_WHITESPACE = 256;

// context 預算裡留給估算誤差的餘裕：固定一段，再加上帶回內容的一個比例（帶得越多，估算的絕對誤差越大）。
const SAFETY_TOKENS = 256;
const SAFETY_RATIO = 0.05;
// 每則訊息的 template 額外開銷（保守；Qwen 實際約 5）
const PER_MESSAGE_TOKENS = 16;
// 探過精確大小的訊息只留這麼一點餘裕（思考強度不同時 template 可能差幾個 token）
const EXACT_MARGIN_TOKENS = 16;
// 一輪至少要能寫這麼多才值得送（設定本身更小時以設定為準）
const MIN_ROUND_TOKENS = 1024;
// 帶回去的前文至少保留這麼多（實際沒這麼多就以實際為準），模型才接得上
const MIN_CARRY_TOKENS = 2048;
// 被 vLLM 以 context 長度拒絕時，同一輪最多探測、校正後重送幾次
const CONTEXT_RETRIES = 2;
// 上游不給精確值時，同一輪被拒後最多再試幾次（每次調高比例或減半）
const BLIND_CONTEXT_RETRIES = 3;
// 第一輪估算的可用輸出額度至少有上限的這個比例，就不探測、照估算送
const PROBE_THRESHOLD = 0.9;
// WinLab 的文字輸入上限是 256 KiB（2026-10-21 實測回 400）；token 預算內通常遠低於這個值，
// 這裡再擋一次
const MAX_INPUT_BYTES = 240 * 1024;
const MAX_BYTE_SHRINKS = 6;
// 校正比例（實際 token 數 ÷ 估算值）的合理範圍：估算器對任何文字都不會偏差到這之外，
// 超出代表量到的數字本身有問題（例如上游的 usage 不可信）
const MIN_RATIO = 0.2;
const MAX_RATIO = 8;
// 沒有任何精確值時規劃用的樂觀比例：估算器對常見中文、英文約高估 1.7～2 倍。被拒就調高到
// 「乘上 BLIND_RATIO_STEP」與「vLLM 下界推得出的值」較大的那個；步幅太大會調過頭，反而判定放不下
const OPTIMISTIC_RATIO = 0.5;
const BLIND_RATIO_STEP = 1.2;
// 一段正文的估計值至少要這麼大，才用它自己的 token 比例：太短時一兩個 token 的進位就讓比例失真
const MIN_SEGMENT_ESTIMATE = 64;

// 接續輪重試的次數與退避時間。測試可以從 config 覆寫這三個值，環境變數設定不了。
const CONTINUATION_RETRIES = 2;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

const LANGUAGE_REMINDER = '全程使用台灣繁體中文與台灣用語，不要出現任何簡體字。';
// 引用前文用的括號：一般文章幾乎不會出現，前文本身含「」時邊界也不會混淆
const QUOTE_OPEN = '⟦';
const QUOTE_CLOSE = '⟧';
// 裁切時插入的省略標記
const OMIT_HEAD = '……（前文省略）\n';
const OMIT_MIDDLE = '\n……（中間省略）……\n';

export const CONTINUE_THINKING_PROMPT = [
    '你上一輪的思考因為單次輸出的長度上限被截斷，還沒有寫出答案。',
    '上一則訊息是你目前的思考筆記（可能含英文或簡體字，只供參考）。請接著這些筆記往下想，不要從頭重來；',
    '想清楚後直接寫出完整的最終答案，答案的格式與要求完全照最一開始的指示。',
    LANGUAGE_REMINDER,
].join('');

export const FORCE_ANSWER_PROMPT = [
    '你的思考已經多次被單次輸出的長度上限截斷。請不要再繼續思考，',
    '直接根據上一則的思考筆記，寫出完整的最終答案；答案的格式與要求完全照最一開始的指示。',
    LANGUAGE_REMINDER,
].join('');

export const REWRITE_JSON_PROMPT = [
    '你上一則的 JSON 寫到一半，因為單次輸出的長度上限被截斷了。',
    '上一則訊息是你未完成的草稿（若有思考筆記也一併附上）。請不要接續草稿，而是重新輸出一份完整的 JSON',
    '（從 { 開始到 } 結束），內容可以沿用草稿；篇幅可能不夠的話，把每個欄位寫得更精簡，但一定要寫完整份。',
    LANGUAGE_REMINDER,
].join('');

// JSON 寫完了（以 stop 結束）卻不符合格式時用：沒有被截斷，不能沿用 REWRITE_JSON_PROMPT 的說法
export const REFORMAT_JSON_PROMPT = [
    '你上一則的回覆不是一份符合要求的 JSON：可能夾了說明文字、缺了欄位，或項目數量、長度超出規定。',
    '上一則訊息是你的回覆（若有思考筆記也一併附上）。請重新輸出一份完整的 JSON，內容可以沿用，',
    '只輸出 JSON 本身，前後不要加任何說明，也不要用 ``` 圍起來。',
    LANGUAGE_REMINDER,
].join('');

/**
 * jsonFormatPrompt 回傳拿掉 response_format 之後要附上的格式要求。任務指令不一定提到 JSON，格式原本
 * 由 guided decoding 保證；拿掉之後不說的話，模型可能照指令寫成條列文字。有 schema 就整份附上。
 * @param {object} responseFormat @returns {string}
 */
export function jsonFormatPrompt(responseFormat) {
    const schema = responseFormat?.json_schema?.schema;
    const shape = schema?.type === 'array' ? '一個 JSON 陣列（從 [ 開始到 ] 結束）' : '一個 JSON 物件（從 { 開始到 } 結束）';
    const rule = `只輸出${shape}，前後不要加任何說明，也不要用 \`\`\` 圍起來。`;
    return schema ? `${rule}它要符合這份 JSON Schema：${JSON.stringify(schema)}` : rule;
}

// 上一輪沒有淨進展、這一輪的請求原本會一模一樣時加上的提醒
export const DEGENERATE_NUDGE = '上一次的輸出沒有任何進展（只有一長串空白或換行，或只是重複已經寫過的內容）。請照指示直接輸出，不要輸出連續的空白或換行。';

/** 以 Unicode 字元（code point）取結尾，不會切出半個 emoji（孤立代理項會讓上游轉 UTF-8 失敗） */
function tailChars(text, n) {
    const chars = [...text];
    return chars.length <= n ? text : chars.slice(-n).join('');
}

export function continueWritingPrompt(previous) {
    // 引用到最後一個看得見的字：前文結尾的換行不放進引號，否則引號裡可能整段都是空白。
    // 引用的是模型寫的字，一樣要中和控制符號
    const tail = tailChars(neutralizeControlTokens(previous.trimEnd()), TAIL_HINT);
    return [
        '你上一則回覆寫到一半，因為單次輸出的長度上限被截斷了。請從截斷的地方直接接著寫：',
        `第一個字要緊接在上一則回覆的最後一個字之後（上一則的結尾是 ${QUOTE_OPEN}${tail}${QUOTE_CLOSE}）；`,
        '不要重複任何已經寫過的內容，不要加開場白、說明或道歉；格式與上一則完全一致。',
        LANGUAGE_REMINDER,
    ].join('');
}

const LINE_BREAKS = /\r\n|\r|\n/g;
const lineBreaks = (run) => (run.match(LINE_BREAKS) || []).length;

/** 這串空白是不是退化：換行太多，或整串太長 */
function isDegenerateRun(run) {
    return run.length >= DEGENERATE_WHITESPACE || lineBreaks(run) >= DEGENERATE_NEWLINES;
}

/** 一大串空白壓成最多兩個換行（沒有換行就壓成一個空格） */
function squeezeWhitespace(run) {
    const newlines = lineBreaks(run);
    return newlines >= 2 ? '\n\n' : newlines === 1 ? '\n' : ' ';
}

function squeezeLongWhitespace(text) {
    return text.replace(/\s+/g, (run) => (isDegenerateRun(run) ? squeezeWhitespace(run) : run));
}

function hasDegenerateWhitespace(text) {
    for (const [run] of text.matchAll(/\s+/g)) {
        if (isDegenerateRun(run)) return true;
    }
    return false;
}

const WORD = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
// 英文字母與阿拉伯數字：以空格分詞的文字，詞的中間不會斷開
const LATIN_WORD = /[A-Za-z0-9]/;

/** 重疊太弱、多半是巧合？字太少，或只有數字而且不到 MIN_NUMERIC_OVERLAP 位 */
function weakOverlap(overlap, minWords) {
    let words = 0;
    let digits = 0;
    for (const ch of overlap) {
        if (!WORD.test(ch)) continue;
        words++;
        if (DIGIT.test(ch)) digits++;
    }
    return words < minWords || (digits === words && digits < MIN_NUMERIC_OVERLAP);
}

// 以空白開頭的下一輪，重疊只是這麼短的一個英文詞時，多半是新詞的開頭（the → theory、in → into）
const SHORT_LATIN_WORD = 3;

/**
 * 重疊只是一個很短的英文詞（或數字），而且停在 next 的詞中間？next 以空白開頭代表模型要開始一個
 * 新詞：前文以「the」結尾、下一輪寫「 theory」時，「 the」不是重複，去掉會變成「theory」。
 * 長一點的詞（「Pyth」接「 Python」、「photosyn」接「 photosynthesis」）多半是模型把斷掉的詞連同
 * 前面的空白重寫一次，照樣是重複；不以空白開頭的「probl」接「problem」、重疊有好幾個詞（整句
 * 重寫、停在詞中間）也是。兩種情況分不出來的只剩「斷在 3 個字母以內」的詞，那時寧可留下重複
 */
function splitsLatinWord(candidate, k) {
    const overlap = candidate.slice(0, k);
    // 從換行開始的重疊是整行重寫（網址、雜湊、長數字這類沒有空白的行）：一律是重複
    if (/^[\r\n]/.test(overlap)) return false;
    if (!LATIN_WORD.test(candidate[k - 1]) || !LATIN_WORD.test(candidate[k] ?? '')) return false;
    const word = overlap.replace(/^\s+/, '');
    return !/\s/.test(word) && word.length <= SHORT_LATIN_WORD;
}

// 行首的標記：Markdown 的清單、引用、標題，以及各種編號（1. 1) 1、 1.1 一、 （一） (1)）
const NUMBERING = String.raw`[-*+>]|\d+(?:\.\d+)*[.)、]?|[一二三四五六七八九十百千]+[、.]|[（(](?:\d+|[一二三四五六七八九十百千]+)[)）]`;
const LINE_MARKER = new RegExp(String.raw`^\s*(?:#{1,6}(?:\s+(?:${NUMBERING}))?|${NUMBERING})\s*$`);
const HEADING_LINE = /^\s*#{1,6}\s/;

/**
 * previous 結尾的 k 個字，是不是接在 Markdown 標記或編號之後、或是標題的文字？是的話，
 * 下一輪換行後用同樣的字開頭多半是新段落，不是重複。重疊從行首開始（連標記一起重寫的
 * 整行）才是重複。
 */
function followsLineMarker(previous, k) {
    // 重疊本身就從換行開始：模型連同前面的換行把最後一行整行重寫，是重複。不能拿上一行
    // （可能剛好是標題）來判斷
    if (/[\r\n]/.test(previous[previous.length - k])) return false;
    const lineStart = previous.lastIndexOf('\n', previous.length - k - 1) + 1;
    const before = previous.slice(lineStart, previous.length - k);
    if (!before) return false;
    return HEADING_LINE.test(previous.slice(lineStart)) || LINE_MARKER.test(before);
}

/**
 * 去掉 next 開頭與 previous 結尾重疊的部分。
 * 例：previous 結尾「…程式思」、next「程式思維，能讓…」→「維，能讓…」。
 * next 若先多了空白才開始重複，重疊要夠長，不能只是「前文最後一行去掉 Markdown 標記或編號後的
 * 文字」，也不能停在 next 的英文詞中間。「## 學習歷程」之後換行寫「學習歷程是指…」是新段落，
 * 不是重複。
 */
export function trimOverlap(previous, next, { maxWindow = OVERLAP_WINDOW } = {}) {
    const attempt = (candidate, minWords, guardLine) => {
        const max = Math.min(maxWindow, previous.length, candidate.length);
        for (let k = max; k >= 1; k--) {
            const overlap = candidate.slice(0, k);
            if (!previous.endsWith(overlap)) continue;
            if (weakOverlap(overlap, minWords)) continue;
            if (guardLine && splitsLatinWord(candidate, k)) continue;
            if (guardLine && followsLineMarker(previous, k)) continue;
            return candidate.slice(k);
        }
        return null;
    };
    // 直接比對：next 帶著開頭的空白也比得到時（前文標記後面的空格剛好接上），一樣要過標記的檢查
    const direct = attempt(next, MIN_OVERLAP_WORDS, /^\s/.test(next));
    if (direct !== null) return direct;
    const stripped = next.replace(/^\s+/, '');
    if (stripped !== next) {
        const afterSpace = attempt(stripped, MIN_OVERLAP_WORDS_AFTER_SPACE, true);
        if (afterSpace !== null) return afterSpace;
    }
    return next;
}

/**
 * 緩衝中的開頭，去重疊的結果還可能隨後面的字改變嗎？
 *   - 更長的重疊：目前的開頭（或去掉空白的版本）必須出現在前文結尾窗口內、而且不是貼著最後一個字
 *   - 英文詞的判斷（splitsLatinWord）：開頭以空白（不是換行）開頭、去掉空白後是單一個很短的英文詞、
 *     整段剛好是前文的結尾時，要看下一個字才知道詞有沒有結束
 * 兩者都不可能時，不論後面再來什麼，trimOverlap 的結果都不會變，可以馬上送出，不必等滿
 * OVERLAP_WINDOW 字（46 tokens/s 下約 30～40 秒不動）。
 */
function overlapMayGrow(previous, pending) {
    const inner = previous.slice(-OVERLAP_WINDOW).slice(0, -1);
    const may = (s) => !s || inner.includes(s);
    const stripped = pending.replace(/^\s+/, '');
    if (may(pending) || may(stripped)) return true;
    return /^[^\S\r\n]/.test(pending) && LATIN_WORD.test(pending.at(-1)) && !/\s/.test(stripped)
        && stripped.length <= SHORT_LATIN_WORD && (previous.endsWith(pending) || previous.endsWith(stripped));
}

/** 一個字元的估計值，以 0.1 token 為單位（整數累加：浮點數一個漢字加 36 個空白是 12.000000000000007） */
function charTenths(cp) {
    if (cp < 0x80) {
        if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 5;
        if (cp === 0x20) return 3;
        return 10;
    }
    if (cp >= 0x10000) return 40;
    // 常用漢字與全形標點（擴展 A 區 U+3400 起是罕用字，常被拆成多個 token，歸到下面的上界）
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)) return 12;
    return 30;
}

function estimateTenths(text) {
    let tenths = 0;
    for (const ch of text) tenths += charTenths(ch.codePointAt(0));
    return tenths;
}

/**
 * 依字元類別估算 token 數。WinLab 端的 tokenizer 不在這裡，這只是第一步的估計：ASCII 字母
 * 與常用漢字取接近實際偏高的值（Qwen 對常見中文、英文其實更省），罕用字取 byte-level BPE 的
 * 上界，數字與符號一個字算一個。估錯的部分由 usage 的精確值校正、或探測補救（見檔頭）。
 */
export function estimateTokens(text) {
    return Math.ceil(estimateTenths(text) / 10);
}

/**
 * 帶回的文字依「哪一輪寫的」分段（marks：[{ end, ratio }]，end 是那一段結束的 UTF-16 位置），
 * 每段有自己的「實際 token ÷ 估算」比例；沒有比例的段落（拿不到精確值）算 1，交給整體的修正
 * 係數。回傳每個 code point 的累計成本（十分之一個 token），任何一段的成本都能直接相減算出。
 * 所有比例都是 1 時，成本就等於 estimateTokens
 */
function costModel(text, marks = []) {
    const chars = [...text];
    const prefix = new Float64Array(chars.length + 1);
    let offset = 0;
    let m = 0;
    for (let i = 0; i < chars.length; i++) {
        while (m < marks.length && marks[m].end <= offset) m++;
        const ratio = m < marks.length ? (marks[m].ratio ?? 1) : 1;
        prefix[i + 1] = prefix[i] + charTenths(chars[i].codePointAt(0)) * ratio;
        offset += chars[i].length;
    }
    return { chars, prefix };
}

/**
 * 留下 keep 個字時的成本（含省略標記）隨 keep 單調不減：二分搜尋預算內最多能留幾個字。用平均
 * 密度猜一次再固定比例縮的話，第一次猜沒算到省略標記、超出一點就整整縮掉一成，白白浪費預算
 */
function largestFitting(length, budget, tenthsOf) {
    let lo = 0;
    let hi = length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Math.ceil(tenthsOf(mid) / 10) <= budget) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/** 依預算裁切，只保留結尾（接續正文只需要最近的上下文）。回傳 { text, tenths } */
function clampTailModel({ chars, prefix }, budget) {
    const n = chars.length;
    const total = prefix[n];
    if (Math.ceil(total / 10) <= budget) return { text: chars.join(''), tenths: total };
    const marker = estimateTenths(OMIT_HEAD);
    const tenthsOf = (keep) => marker + total - prefix[n - keep];
    const keep = largestFitting(n, budget, tenthsOf);
    return keep === 0 ? { text: '', tenths: 0 } : { text: OMIT_HEAD + chars.slice(n - keep).join(''), tenths: tenthsOf(keep) };
}

/** 依預算裁切：保留開頭（題目理解、規劃、JSON 的結構）兩成與結尾（最新進度），中間省略 */
function clampHeadTailModel({ chars, prefix }, budget) {
    const n = chars.length;
    const total = prefix[n];
    if (Math.ceil(total / 10) <= budget) return { text: chars.join(''), tenths: total };
    const marker = estimateTenths(OMIT_MIDDLE);
    const tenthsOf = (keep) => {
        const head = Math.floor(keep * 0.2);
        return prefix[head] + marker + total - prefix[n - (keep - head)];
    };
    const keep = largestFitting(n, budget, tenthsOf);
    if (keep === 0) return { text: '', tenths: 0 };
    const head = Math.floor(keep * 0.2);
    return { text: `${chars.slice(0, head).join('')}${OMIT_MIDDLE}${chars.slice(n - (keep - head)).join('')}`, tenths: tenthsOf(keep) };
}

/** 依 token 預算（估計值）裁切：保留開頭與結尾、中間省略。一個字都留不下就回傳空字串 */
export function clampHeadTail(text, budget) {
    return clampHeadTailModel(costModel(text), budget).text;
}

/** 依 token 預算（估計值）裁切：只保留結尾。一個字都留不下就回傳空字串 */
export function clampTail(text, budget) {
    return clampTailModel(costModel(text), budget).text;
}

function utf8Bytes(value) {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * 是不是被 vLLM 以 context 長度拒絕？是的話回傳 { limit, atLeast, exact? }。atLeast 只是下界
 * （vLLM 算的是「上限 − 要求的輸出 + 1」），不是實際的輸入大小，不能拿來算 max_tokens；
 * 新版 vLLM 的「your request has N input tokens」與舊版的「(N in the messages, …)」是精確值，
 * 放在 exact。
 */
export function parseContextOverflow(err) {
    if (!(err instanceof UpstreamError) || err.status !== 400 || !err.detail) return null;
    const limit = err.detail.match(/maximum context length is (\d+)/i);
    if (!limit) return null;
    const atLeast = err.detail.match(/prompt contains at least (\d+) input tokens/i);
    const exact = err.detail.match(/request has (\d+) input tokens/i) || err.detail.match(/\((\d+) in the messages/i);
    return {
        limit: Number(limit[1]),
        atLeast: atLeast ? Number(atLeast[1]) : undefined,
        ...(exact ? { exact: Number(exact[1]) } : {}),
    };
}

/**
 * 拆掉整段外面的 Markdown 圍欄（```json … ```）。拿掉 response_format 之後輸出不再受約束，
 * Qwen 常照它的習慣包一層；裡面才是要驗證的 JSON
 */
function unwrapCodeFence(text) {
    const trimmed = text.trim();
    const fenced = /^```[\w-]*[^\S\r\n]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
    return fenced ? fenced[1].trim() : trimmed;
}

/**
 * isCompleteJson 判斷正文是不是一份完整的答案，呼叫端沒給 acceptJson 時用。只收以 } 或 ] 結尾、
 * 型別符合、不是空的值，而且 schema 頂層的必填欄位都在：'12345' 這種被切在數字中間的、頂層字串、
 * true、{} 都能解析，但不是要的答案。json_object 要物件；json_schema 依 schema 頂層的 type（沒寫就當物件）。
 */
function isCompleteJson(text, responseFormat) {
    const trimmed = text.trim();
    if (!/[}\]]$/.test(trimmed)) return false;
    let value;
    try {
        value = JSON.parse(trimmed);
    } catch {
        return false;
    }
    const schema = responseFormat?.json_schema?.schema;
    const wantArray = schema?.type === 'array';
    if (value === null || typeof value !== 'object' || Array.isArray(value) !== wantArray) return false;
    if (Object.keys(value).length === 0) return false;
    const required = !wantArray && Array.isArray(schema?.required) ? schema.required : [];
    return required.every((key) => Object.hasOwn(value, key));
}

/** 等 promise 完成，但 signal 中止時不再等（reject 一個哨兵值，由呼叫端翻成對應的錯誤） */
const ABORTED = Symbol('aborted');
function untilSettledOrAborted(promise, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(ABORTED);
            return;
        }
        const onAbort = () => reject(ABORTED);
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        });
    });
}

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason);
            return;
        }
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

function isJsonFormat(responseFormat) {
    return responseFormat?.type === 'json_object' || responseFormat?.type === 'json_schema';
}

function clampRatio(ratio) {
    if (Number.isNaN(ratio)) return 1;
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

// usage 裡的 token 數：上游給的不是正常的數字（缺欄位、字串、負數、小數）就當作沒給。
// 直接 += 的話，字串會讓加總變成字串串接，NaN 會讓之後的預算全部變成 NaN；小數拿去算
// max_tokens 會送出非整數，WinLab 必定 400
const tokenCount = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
const promptTokensOf = (u) => (Number.isInteger(u?.prompt_tokens) && u.prompt_tokens > 0 ? u.prompt_tokens : null);

function addUsage(total, u) {
    total.promptTokens += tokenCount(u.prompt_tokens);
    total.completionTokens += tokenCount(u.completion_tokens);
    total.reasoningTokens += tokenCount(u.completion_tokens_details?.reasoning_tokens);
}

/** 這一輪思考的精確 token 數；沒給就是 null */
function reasoningTokensOf(u) {
    const r = u?.completion_tokens_details?.reasoning_tokens;
    return Number.isInteger(r) && r > 0 ? r : null;
}

/**
 * 這一輪正文的精確 token 數：completion_tokens − reasoning_tokens。沒有 reasoning_tokens 時，
 * 只有沒思考的那一輪 completion_tokens 才全是正文（WinLab 2026-10-22 實測會給 reasoning_tokens）
 */
function contentTokensOf(u, reasoning) {
    const completion = u?.completion_tokens;
    if (!Number.isInteger(completion) || completion <= 0) return null;
    const r = u.completion_tokens_details?.reasoning_tokens;
    if (Number.isInteger(r) && r >= 0) return completion - r > 0 ? completion - r : null;
    return reasoning ? null : completion;
}

/** 一段文字的「實際 ÷ 估算」比例；太短或比例不合理就不用（回傳 null，交給整體的修正係數） */
function segmentRatio(tokens, text) {
    if (tokens === null || !text) return null;
    const estimate = estimateTokens(text);
    if (estimate < MIN_SEGMENT_ESTIMATE) return null;
    const ratio = tokens / estimate;
    return ratio >= MIN_RATIO && ratio <= MAX_RATIO ? ratio : null;
}

/**
 * 產生一個完整回答（必要時跨多輪）。
 *
 * @param {object} config   loadLlmConfig() 的結果（用到 contextTokens、maxTokens、maxRounds 等）
 * @param {object} request  { messages, temperature?, responseFormat?, acceptJson? }
 *                          responseFormat 是 json_object／json_schema 時視為 JSON 輸出。
 *                          acceptJson(content)：JSON 任務的正文可以交出時回傳 true，呼叫端交出前用同一套
 *                          驗證才不會收下不合格的、或重寫其實合格的。沒給就只看是不是完整的 JSON（可包在
 *                          ``` 圍欄裡）而且頂層必填欄位都在
 * @param {object} [hooks]  signal：呼叫端取消
 *                          onProgress({phase, round, thinkingTokens, writingTokens, reason?, attempt?, delayMs?})：
 *                            phase 為 thinking | writing | continuing | retrying；token 數是串流片段數，
 *                            只是給進度條用的近似值
 *                          onContent(text)：逐段送出最終答案的正文（只有文字任務會呼叫）
 *                          兩個 hook 可以是 async；丟出例外或 reject 都會中止任務並原樣丟回。
 *                            回傳結果前會等所有 async hook 完成（受總時限與取消約束）
 *                          streamChatImpl：測試用
 * @returns {Promise<{content: string, rounds: number, usage: object, continuations: string[]}>}
 *          continuations 依序記錄每次接續的原因：thinking | writing | rewrite | degenerate
 *          失敗時丟出的錯誤帶著 partial（已寫好的部分）、rounds、continuations、usage
 */
export async function generate(config, request, hooks = {}) {
    const { messages, temperature, responseFormat, acceptJson } = request;
    const { signal, streamChatImpl = streamChat } = hooks;
    const jsonMode = isJsonFormat(responseFormat);
    const acceptable = (text) => Boolean(text.trim()) && (acceptJson
        ? Boolean(acceptJson(text))
        : isCompleteJson(unwrapCodeFence(text), responseFormat));
    const deadlineAt = Date.now() + config.taskTimeoutMs;

    let content = '';      // 文字任務：已確定的正文（跨輪累積）；JSON 任務：這一輪的正文
    let notes = '';        // 被截斷的那幾輪的思考，接續時當成思考筆記帶回去
    let draft = '';        // JSON 任務被截斷時的未完成草稿
    // 上面三者的分段（[{ end, ratio }]）：各段是哪一輪寫的、那一輪的「實際 ÷ 估算」比例
    const contentMarks = [];
    const notesMarks = [];
    let draftMarks = [];
    let mode = 'fresh';    // fresh | thinking | writing | rewrite
    let thinkingTruncations = 0;
    let forceNoThinking = false;
    let dropFormat = false;
    let rejectedJson = false;   // 上一輪的 JSON 寫完了（stop）卻不合格：重寫時不能說它被截斷
    let nudge = false;          // 上一輪沒有淨進展、這一輪的請求原本會一模一樣：加一句提醒
    let degenerateStreak = 0;   // 連續幾輪沒有淨進展
    let thinkingTokens = 0;
    let writingTokens = 0;
    let baseTokens = null;      // 題目（原始 messages）的精確 token 數
    let calibration = null;     // { mode, ratio }：帶回內容的實際 token 數 ÷ 規劃時的成本，同一種接法沿用
    let exactUnavailable = false;      // 探測成功卻拿不到可用的 usage：這個任務不再探測
    let blindRatio = OPTIMISTIC_RATIO; // 沒有任何精確值時，規劃用的比例（被拒就調高，之後幾輪沿用）
    let contextLimit = config.contextTokens;
    let currentRound = 0;
    const continuations = [];
    const usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 };

    const partial = () => {
        if (!jsonMode) return content.trim() ? content : draft;
        // JSON：失敗那次已經寫出合格的 JSON 就給它，否則給上一份草稿
        let ok = false;
        try {
            ok = acceptable(content);
        } catch {
            // 這裡是在組錯誤：acceptJson 丟的例外當成不合格，不能蓋掉原本要丟的錯誤
        }
        return ok ? unwrapCodeFence(content) : (draft || content);
    };
    // 在錯誤上補已寫好的部分、輪數、接續紀錄與用量（呼叫端記 log、回報用）。用不可列舉的屬性：
    // 錯誤可能是呼叫端自己的物件（hook 丟出的），不該改變它被列舉或序列化的樣子；凍結的就不動
    const attach = (err, round) => {
        if (err === null || typeof err !== 'object' || !Object.isExtensible(err)) return err;
        const extra = { partial: partial(), rounds: round, continuations: [...continuations], usage: { ...usage } };
        for (const [key, value] of Object.entries(extra)) {
            try {
                if (err[key] === undefined) {
                    Object.defineProperty(err, key, { value, writable: true, configurable: true, enumerable: false });
                }
            } catch {
                // getter 丟例外、Proxy 拒絕：不補了，錯誤本身照樣丟出
            }
        }
        return err;
    };
    const fail = (code, message, extra = {}) => new GenerationError(code, message, {
        partial: partial(),
        continuations: [...continuations],
        usage: { ...usage },
        ...extra,
    });

    // 呼叫端的 hook 丟例外（或 async hook reject）時，不能被 streamChat 翻成「連不上 LLM 服務」，
    // 也不能變成沒人接的 rejection：記下來、中止這一輪，等串流收尾後原樣丟出。async hook 的
    // promise 都記著，回傳結果前等它們完成
    let hookFailed = false;
    let hookError;
    const hookAbort = new AbortController();
    const pendingHooks = new Set();
    const recordHookFailure = (err) => {
        if (hookFailed) return;
        hookFailed = true;
        hookError = err;
        hookAbort.abort();
    };
    const guard = (fn) => (fn ? (...args) => {
        if (hookFailed) return;
        try {
            const result = fn(...args);
            if (result && typeof result.then === 'function') {
                let settle;
                const tracked = new Promise((resolve) => {
                    settle = resolve;
                });
                result.then(() => settle(), (err) => {
                    recordHookFailure(err);
                    settle();
                });
                pendingHooks.add(tracked);
                tracked.then(() => pendingHooks.delete(tracked));
            }
        } catch (err) {
            recordHookFailure(err);
        }
    } : undefined);
    const onProgress = guard(hooks.onProgress) || (() => {});
    const onContent = jsonMode ? undefined : guard(hooks.onContent);
    const throwIfHookFailed = (round) => {
        if (hookFailed) throw attach(hookError, round);
    };

    // 總時限涵蓋所有輪與重試：防止模型無限重複、或一輪接一輪把名額卡住。自己的計時器，任務結束
    // 就清掉（AbortSignal.timeout 的計時器要到時限才會釋放）
    const deadlineCtl = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineCtl.abort(new DOMException(`超過總時限 ${config.taskTimeoutMs}ms`, 'TimeoutError')), config.taskTimeoutMs);
    const deadline = deadlineCtl.signal;
    const combined = AbortSignal.any([signal, deadline, hookAbort.signal].filter(Boolean));

    // combined 中止時該丟的錯誤：hook 失敗就丟 hook 的錯誤，總時限到了是 timeout，否則是呼叫端取消
    const abortError = (round) => {
        if (hookFailed) return attach(hookError, round);
        if (deadline.aborted && !signal?.aborted) return fail('timeout', `超過總時限 ${config.taskTimeoutMs}ms`, { rounds: round });
        return attach(new UpstreamError('aborted', '請求被取消', { cause: signal?.reason }), round);
    };
    // 回傳結果之前，等 async hook 都完成：呼叫端拿到結果時，所有正文都已經交給 hook 處理完
    const finish = async (value, round) => {
        while (pendingHooks.size > 0 && !hookFailed) {
            try {
                await untilSettledOrAborted(Promise.allSettled([...pendingHooks]), combined);
            } catch {
                throw abortError(round);
            }
        }
        throwIfHookFailed(round);
        return value;
    };

    const minOutput = Math.min(MIN_ROUND_TOKENS, config.maxTokens);
    const estimateMessages = (msgs) => estimateTokens(msgs.map((m) => m.content).join('')) + PER_MESSAGE_TOKENS * msgs.length;
    const baseEstimate = estimateMessages(messages);
    // usage 回報的輸入大小不能小到不合理：比估算值乘上最低比例還小（例如兩萬字的題目報 1）就不是真的
    const plausiblePrompt = (prompt, msgs) => prompt >= Math.floor(estimateMessages(msgs) * MIN_RATIO);
    // 探過精確大小的訊息怎麼認：原始 messages 之後多出來的部分（帶回的內容、接續指示、提醒）
    const messageKey = (roundMessages) => JSON.stringify(roundMessages.slice(messages.length));

    const addNotes = (text, ratio) => {
        if (!text) return;
        notes += text;
        notesMarks.push({ end: notes.length, ratio });
    };

    /**
     * 依目前狀態，這一輪要送的指示、帶回的內容、思考強度與 response_format（還沒裁切、不含提醒）
     */
    const roundShape = () => {
        let instruction = '';
        let parts = [];        // [{ label, text, marks, clamp }]，預算依序分配（草稿優先於筆記）
        let effort = config.reasoningEffort;
        let format = dropFormat ? undefined : responseFormat;
        if (mode === 'thinking') {
            const force = thinkingTruncations >= 2;
            instruction = force ? FORCE_ANSWER_PROMPT : CONTINUE_THINKING_PROMPT;
            parts = [{ label: '【思考筆記（尚未完成）】\n', text: notes, marks: notesMarks, clamp: clampHeadTailModel }];
            if (force) effort = 'none';
        } else if (mode === 'rewrite') {
            instruction = rejectedJson ? REFORMAT_JSON_PROMPT : REWRITE_JSON_PROMPT;
            const label = rejectedJson ? '【上一則的回覆】\n' : '【未完成的草稿】\n';
            parts = [{ label, text: draft, marks: draftMarks, clamp: clampHeadTailModel }];
            if (notes.trim()) parts.push({ label: '\n\n【思考筆記】\n', text: notes, marks: notesMarks, clamp: clampHeadTailModel });
            effort = config.continuationEffort;
        } else if (mode === 'writing') {
            instruction = continueWritingPrompt(content);
            parts = [{ label: '', text: content, marks: contentMarks, clamp: clampTailModel }];
            effort = config.continuationEffort;
            format = undefined;
        }
        if (jsonMode && !format && mode !== 'fresh') instruction += jsonFormatPrompt(responseFormat);
        if (forceNoThinking) effort = 'none';
        return { instruction, parts, effort, format };
    };
    // 「這一輪會送出什麼」的指紋，不含提醒。裁切與 max_tokens 也不算：那只是同一個請求的不同
    // 切法，temperature 0 時照樣得到同樣的開頭。跟上一輪一樣就代表上一輪沒有淨進展
    const shapeKey = (shape) => JSON.stringify([mode, shape.instruction, shape.parts.map((p) => p.text), shape.effort, shape.format ?? null]);

    /**
     * 依目前狀態組這一輪的訊息，並算出放得進 context 的 max_tokens（可能小於 minOutput，
     * 由 assertFits 判定）。token 數都是「實際」的單位：各段的成本（有精確比例的用它、沒有的
     * 用估算值）再乘上整體的修正係數。
     * caps.carry：沒有精確值可校正時，帶回內容的上限（修正前的成本：比例之後改變也不會讓減半失效）；
     * caps.maxTokens：輸出的上限；
     * caps.measured：探過精確大小的訊息 { key, tokens }
     */
    const planRound = (round, caps) => {
        const ctx = contextLimit;
        const shape = roundShape();
        const { parts, effort, format } = shape;
        const key = shapeKey(shape);
        const blind = exactUnavailable && baseTokens === null;
        const outputCap = Math.min(config.maxTokens, caps.maxTokens);

        if (mode === 'fresh') {
            // 重做的那一輪：題目原封不動，格式要求與提醒另外附在最後一則
            const note = [jsonMode && !format ? jsonFormatPrompt(responseFormat) : '', nudge ? DEGENERATE_NUDGE : ''].filter(Boolean).join('\n');
            const roundMessages = note ? [...messages, { role: 'user', content: note }] : messages;
            const extra = note ? estimateTokens(note) + PER_MESSAGE_TOKENS : 0;
            let room;
            if (caps.measured?.key === messageKey(roundMessages)) room = ctx - caps.measured.tokens - EXACT_MARGIN_TOKENS;
            else if (baseTokens !== null) room = ctx - baseTokens - extra - EXACT_MARGIN_TOKENS;
            else if (blind) room = ctx - SAFETY_TOKENS - Math.ceil((baseEstimate + extra) * blindRatio);
            else room = ctx - SAFETY_TOKENS - baseEstimate - extra;
            return { mode, roundMessages, maxTokens: Math.min(outputCap, room), effort, format, shapeKey: key, plannedPrompt: baseEstimate + extra };
        }
        const instruction = nudge ? shape.instruction + DEGENERATE_NUDGE : shape.instruction;

        const ratio = calibration?.mode === mode ? calibration.ratio : blind ? blindRatio : 1;
        const real = (cost) => Math.ceil(cost * ratio);
        const base = baseTokens ?? (blind ? Math.ceil(baseEstimate * blindRatio) : baseEstimate);
        const fixedCost = estimateTokens(instruction) + PER_MESSAGE_TOKENS * 2;
        const fixed = base + real(fixedCost);
        const models = parts.map((part) => costModel(part.text, part.marks));
        const wantedCost = parts.reduce((sum, part, i) => sum + estimateTokens(part.label) + Math.ceil(models[i].prefix[models[i].chars.length] / 10), 0);
        const wanted = real(wantedCost);
        const safety = (n) => SAFETY_TOKENS + Math.ceil(n * SAFETY_RATIO);
        // 帶回內容的預算：先保住完整的輸出額度；放不下時縮輸出，但前文至少保留
        // min(MIN_CARRY_TOKENS, 實際需要)，否則模型接不上
        let budget = ctx - fixed - outputCap - safety(wanted);
        const floor = Math.min(MIN_CARRY_TOKENS, wanted);
        if (budget < floor) budget = floor;
        // 依預算組出帶回的內容（裁切依修正前的成本，所以預算換回那個單位；caps.carry 一律優先）；
        // 超過 WinLab 的位元組上限就再縮
        let budgetCost = Math.min(caps.carry, Math.floor(budget / ratio));
        let roundMessages;
        let carriedCost = 0;
        for (let shrink = 1; ; shrink++) {
            let remaining = budgetCost;
            let carried = '';
            carriedCost = 0;
            for (const [i, part] of parts.entries()) {
                const labelCost = estimateTokens(part.label);
                const { text, tenths } = part.clamp(models[i], Math.max(0, remaining - labelCost));
                // 附帶的區塊（重寫時的思考筆記）裁到沒有內容就整塊不放，不留一個空標籤
                if (!text && i > 0) continue;
                // 送回 prompt 的那一份中和控制符號（全形符號估計值稍大，差額照算）
                const safe = neutralizeControlTokens(text);
                const cost = labelCost + Math.ceil(tenths / 10) + (safe === text ? 0 : Math.max(0, estimateTokens(safe) - estimateTokens(text)));
                carried += part.label + safe;
                carriedCost += cost;
                remaining -= cost;
            }
            roundMessages = [
                ...messages,
                { role: 'assistant', content: carried },
                { role: 'user', content: instruction },
            ];
            const bytes = utf8Bytes(roundMessages);
            if (bytes <= MAX_INPUT_BYTES) break;
            // 超出的部分全在帶回的內容上：依「上限扣掉其他部分後還剩多少位元組」等比例縮。拿整個
            // 請求的比例縮的話，題目很大時要縮很多次才收斂
            const carriedBytes = utf8Bytes(carried) - 2;
            const available = MAX_INPUT_BYTES - (bytes - carriedBytes);
            if (available <= 0) {
                throw fail('incomplete', `題目與續寫指示本身就超過 WinLab 的輸入上限（${MAX_INPUT_BYTES} bytes），放不進任何前文`, { rounds: round - 1 });
            }
            if (shrink >= MAX_BYTE_SHRINKS) {
                throw fail('incomplete', `帶回的內容縮減 ${MAX_BYTE_SHRINKS} 次後，請求仍超過 WinLab 的輸入上限（${MAX_INPUT_BYTES} bytes）`, { rounds: round - 1 });
            }
            budgetCost = Math.floor(carriedCost * (available / carriedBytes) * 0.95);
        }
        const carriedTokens = real(carriedCost);
        let maxTokens = Math.min(outputCap, ctx - fixed - carriedTokens - safety(carriedTokens));
        // 這組訊息剛剛探過精確大小：直接用精確值，不必再留估算的餘裕
        if (caps.measured?.key === messageKey(roundMessages)) {
            maxTokens = Math.min(outputCap, ctx - caps.measured.tokens - EXACT_MARGIN_TOKENS);
        }
        // 最樂觀的情況（估算偏高到校正比例的下限、前文只留最少）也放不下嗎？放得下才值得探測
        const optimistic = (baseTokens ?? Math.ceil(baseEstimate * MIN_RATIO)) + Math.ceil(fixedCost * MIN_RATIO)
            + Math.min(MIN_CARRY_TOKENS, Math.ceil(wantedCost * MIN_RATIO));
        const mayFit = ctx - optimistic - EXACT_MARGIN_TOKENS >= minOutput;
        return {
            mode, roundMessages, maxTokens, effort, format, carriedCost, nonBaseCost: fixedCost + carriedCost, mayFit,
            shapeKey: key, plannedPrompt: baseEstimate + fixedCost + carriedCost,
        };
    };

    const assertFits = (plan, round) => {
        if (plan.maxTokens >= minOutput) return;
        throw fail('incomplete', plan.mode === 'fresh'
            ? `輸入太長，模型的 context（${contextLimit} tokens）放不下`
            : `模型的 context（${contextLimit} tokens）已經放不下下一輪`, { rounds: round - 1 });
    };

    /**
     * 用 max_tokens=1 送一次同樣的請求（同樣的思考強度、response_format、temperature），取得
     * vLLM 算出的精確輸入 token 數。回傳數字；探測本身也被以 context 長度拒絕（輸入本身就超過）
     * 回傳 Infinity；探測成功但沒有可用的 usage 回傳 null，並記下這個上游不給精確值（之後不再探測）。
     * 其他錯誤（429、逾時、斷線、取消）原樣丟出，跟正式請求的錯誤一起處理（接續輪會退避重試）。
     * 探測的用量照樣計入（WinLab 的 TPM 會算）。
     */
    const measurePrompt = async (roundMessages, effort, format) => {
        let probe;
        try {
            probe = await streamChatImpl(config, {
                messages: roundMessages,
                maxTokens: 1,
                reasoningEffort: effort,
                temperature,
                responseFormat: format,
            }, { signal: combined });
        } catch (err) {
            if (parseContextOverflow(err)) return Infinity;
            throw err;
        }
        if (probe.usage) addUsage(usage, probe.usage);
        const prompt = promptTokensOf(probe.usage);
        // 探測成功代表「輸入 + 1」放得進 context：比這更大的數字不可能是真的
        if (prompt === null || prompt > contextLimit - 1 || !plausiblePrompt(prompt, roundMessages)) {
            exactUnavailable = true;
            return null;
        }
        return prompt;
    };

    const runRounds = async () => {
        for (let round = 1; round <= config.maxRounds; round++) {
            currentRound = round;
            if (round > 1) {
                onProgress({ phase: 'continuing', round, reason: continuations.at(-1), thinkingTokens, writingTokens });
                throwIfHookFailed(round);
            }

            let result;
            let plan;
            let tailDropped = false;  // 這一輪寫到最後退化成一大串空白（已丟掉）
            let squeezed = false;     // 這一輪的正文中間壓過退化的空白（正文的 token 比例因此不準）
            let attempt = 0;
            let contextRetries = 0;
            const caps = { carry: Infinity, maxTokens: Infinity, measured: null };
            let pending = null;       // 送出前要先探測：{ overflow, atLeast }
            let probedFresh = false;
            let probedFit = false;

            // 沒有精確值可用時被拒：還在用樂觀比例規劃（題目大小不明）就調高比例（至少到 vLLM
            // 下界推得出的值），之後幾輪沿用；比例已到上限、或題目大小已知（是帶回的內容估低了）
            // 就直接減半。接續輪先減前文、保住輸出額度，第二次起連輸出一起減；不帶前文的 fresh 輪
            // 直接減輸出。
            const shrinkWithoutExact = (failedPlan, atLeast) => {
                if (baseTokens === null && blindRatio < MAX_RATIO) {
                    const floorRatio = atLeast ? (atLeast / failedPlan.plannedPrompt) * 1.05 : 0;
                    blindRatio = Math.min(MAX_RATIO, Math.max(blindRatio * BLIND_RATIO_STEP, floorRatio));
                    if (blindRatio < MAX_RATIO) return;
                }
                if (failedPlan.mode === 'fresh') {
                    if (failedPlan.maxTokens <= minOutput) {
                        throw fail('incomplete', `輸入太長，模型的 context（${contextLimit} tokens）放不下`, { rounds: round - 1 });
                    }
                    caps.maxTokens = Math.max(minOutput, Math.floor(failedPlan.maxTokens / 2));
                    return;
                }
                caps.carry = Math.floor(failedPlan.carriedCost / 2);
                if (contextRetries > 1) caps.maxTokens = Math.max(minOutput, Math.floor(failedPlan.maxTokens / 2));
            };

            // 依探測結果調整這一輪的規劃
            const applyMeasurement = (exact, measuredPlan, { overflow, atLeast }) => {
                if (Number.isFinite(exact)) {
                    caps.measured = { key: messageKey(measuredPlan.roundMessages), tokens: exact };
                    if (measuredPlan.mode === 'fresh') {
                        // 放不放得下交給重新規劃後的 assertFits 判定
                        if (measuredPlan.roundMessages === messages) baseTokens = exact;
                        return;
                    }
                    if (baseTokens !== null && exact > baseTokens) {
                        // 用精確的總數校正帶回內容的成本，重新規劃（優先裁前文、保住輸出額度）
                        calibration = { mode: measuredPlan.mode, ratio: clampRatio((exact - baseTokens) / measuredPlan.nonBaseCost) };
                        caps.carry = Infinity;
                        return;
                    }
                    caps.carry = Math.floor(measuredPlan.carriedCost / 2);
                    return;
                }
                if (exact === Infinity) {
                    if (measuredPlan.mode === 'fresh') throw fail('incomplete', `輸入太長，模型的 context（${contextLimit} tokens）放不下`, { rounds: round - 1 });
                    // 接續輪連 1 個 token 都放不下：帶回的內容縮一半
                    caps.carry = Math.floor(measuredPlan.carriedCost / 2);
                    return;
                }
                // 探測成功但沒有可用的 usage：之後不再探測。真的被拒過才縮；只是估算偏大，重新規劃時
                // 題目大小不明就改用樂觀比例（不憑悲觀的估算判定放不下）
                if (overflow) shrinkWithoutExact(measuredPlan, atLeast);
                else if (measuredPlan.mode !== 'fresh' && baseTokens !== null) caps.carry = Math.floor(measuredPlan.carriedCost / 2);
            };

            for (;;) {
                if (jsonMode) content = '';
                plan = planRound(round, caps);
                if (!pending && !exactUnavailable && plan.mode === 'fresh' && baseTokens === null && !probedFresh
                    && plan.maxTokens < config.maxTokens * PROBE_THRESHOLD) {
                    // 估算說題目大到給不了（將近）完整的輸出額度：估算器對常見中文、英文高估不少，
                    // 先探出精確大小再決定，不憑估算就縮小輸出或判定放不下
                    pending = { overflow: false };
                } else if (!pending && !exactUnavailable && plan.mode !== 'fresh' && plan.maxTokens < minOutput && plan.mayFit && !probedFit) {
                    // 接續輪也一樣：估算說放不下時先探一次再判定（這一輪還沒有校正比例時最常見）
                    pending = { overflow: false };
                    probedFit = true;
                }
                if (!pending) assertFits(plan, round);
                const roundStart = content;
                // 文字任務的正文先經過空白的關卡：一串空白先暫存，後面出現非空白才送出（退化的那種
                // 壓成最多兩個換行）；輪末仍是退化的一大串空白就丟掉
                let started = false;
                let whitespace = '';
                tailDropped = false;
                squeezed = false;
                // 接續正文時，開頭先緩衝到確定重疊不會再變長才送出
                let headResolved = jsonMode || plan.mode !== 'writing';
                let head = '';
                const forward = (text) => {
                    if (!text) return;
                    content += text;
                    onContent?.(text);
                };
                const resolveHead = () => {
                    headResolved = true;
                    const buffered = head;
                    head = '';
                    forward(trimOverlap(content, buffered));
                };
                const accept = (text) => {
                    if (headResolved) {
                        forward(text);
                        return;
                    }
                    head += text;
                    // 窗口以去掉開頭空白後的長度計：trimOverlap 比對的就是那個版本。超過窗口一個字
                    // 才定案：窗口剛好用滿時，英文詞有沒有結束要看下一個字
                    if (head.replace(/^\s+/, '').length > OVERLAP_WINDOW || !overlapMayGrow(content, head)) resolveHead();
                };
                const feedText = (text) => {
                    for (const piece of text.split(/(\s+)/)) {
                        if (!piece) continue;
                        if (/^\s/.test(piece)) {
                            whitespace += piece;
                            continue;
                        }
                        if (whitespace) {
                            let run = whitespace;
                            if (isDegenerateRun(whitespace)) {
                                run = squeezeWhitespace(whitespace);
                                squeezed = true;
                            }
                            whitespace = '';
                            // 每一輪開頭的空白：新答案直接丟掉；接續正文時交給去重疊判斷
                            if (started || plan.mode === 'writing') accept(run);
                        }
                        started = true;
                        accept(piece);
                    }
                };
                // JSON 任務不逐段送出，也不動正文（交給閘道解析與驗證）；只去掉開頭的空白
                const feedJson = (text) => {
                    if (!started) {
                        whitespace += text;
                        if (!/\S/.test(whitespace)) return;
                        started = true;
                        text = whitespace.replace(/^\s+/, '');
                        whitespace = '';
                    }
                    content += text;
                };
                try {
                    if (pending) {
                        const exact = await measurePrompt(plan.roundMessages, plan.effort, plan.format);
                        if (plan.mode === 'fresh') {
                            probedFresh = true;
                        } else if (baseTokens === null && Number.isFinite(exact)) {
                            // 第一輪沒拿到 usage：題目的精確值另外探，才分得出帶回的內容實際多大
                            const b = await measurePrompt(messages, plan.effort, dropFormat ? undefined : responseFormat);
                            if (Number.isFinite(b)) baseTokens = b;
                        }
                        applyMeasurement(exact, plan, pending);
                        pending = null;
                        plan = planRound(round, caps);
                        assertFits(plan, round);
                    }
                    result = await streamChatImpl(config, {
                        messages: plan.roundMessages,
                        maxTokens: plan.maxTokens,
                        reasoningEffort: plan.effort,
                        temperature,
                        responseFormat: plan.format,
                    }, {
                        signal: combined,
                        onReasoning: () => {
                            thinkingTokens++;
                            onProgress({ phase: 'thinking', round, thinkingTokens, writingTokens });
                        },
                        onContent: (text) => {
                            writingTokens++;
                            onProgress({ phase: 'writing', round, thinkingTokens, writingTokens });
                            if (jsonMode) feedJson(text);
                            else feedText(text);
                        },
                    });
                    // 用量一收到就記：之後的收尾（例如送出緩衝時 hook 失敗）丟出的錯誤也要帶著這一輪的用量
                    if (result.usage) addUsage(usage, result.usage);
                } catch (err) {
                    throwIfHookFailed(round);
                    if (err instanceof GenerationError) throw err;
                    if (err instanceof UpstreamError && err.code === 'aborted' && deadline.aborted && !signal?.aborted) {
                        throw fail('timeout', `超過總時限 ${config.taskTimeoutMs}ms`, { rounds: round });
                    }
                    // 被 vLLM 以 context 長度拒絕：依精確的輸入大小校正後重送
                    const overflow = parseContextOverflow(err);
                    if (overflow) {
                        const blindRetry = exactUnavailable && overflow.exact === undefined;
                        const retryLimit = blindRetry ? BLIND_CONTEXT_RETRIES : CONTEXT_RETRIES;
                        if (contextRetries >= retryLimit) {
                            throw fail('incomplete', `修正 ${retryLimit} 次後模型的 context（${overflow.limit} tokens）仍放不下這一輪`, { rounds: round - 1 });
                        }
                        contextRetries++;
                        contextLimit = Math.min(contextLimit, overflow.limit);
                        if (!jsonMode) content = roundStart;
                        if (overflow.exact !== undefined) {
                            // 錯誤訊息直接給了這組訊息的精確輸入大小：等同探測過，不必再探
                            applyMeasurement(overflow.exact, plan, { overflow: true, atLeast: overflow.atLeast });
                        } else if (exactUnavailable) {
                            // 上游不給精確值（探測拿不到 usage）：不再探測，直接調整後重送
                            shrinkWithoutExact(plan, overflow.atLeast);
                        } else {
                            pending = { overflow: true, atLeast: overflow.atLeast };
                        }
                        continue;
                    }
                    // JSON 已經完整收到、只差結束原因就斷線：直接收下，不必重做一整輪
                    if (jsonMode && err instanceof UpstreamError && err.retryable && acceptable(content)) {
                        return finish({ content: unwrapCodeFence(content), rounds: round, usage, continuations }, round);
                    }
                    const retries = config.continuationRetries ?? CONTINUATION_RETRIES;
                    const retryable = round > 1 && err instanceof UpstreamError && err.retryable && attempt < retries;
                    if (!retryable) throw attach(err, round);
                    // 這次嘗試已經送出去的正文收不回來：當成又截斷了一次，下一次從那裡接著寫（這段沒有
                    // 用量可查，比例不明）；還在緩衝的開頭直接丟掉，重試會再寫一次
                    if (!jsonMode && content.length > roundStart.length) {
                        contentMarks.push({ end: content.length, ratio: null });
                        if (content.slice(roundStart.length).trim() && mode !== 'writing') {
                            mode = 'writing';
                            // 換了接法，帶回的內容整個不同：依舊內容做的修正不再適用；「上一次只有空白」
                            // 的提醒也不再成立
                            caps.carry = Infinity;
                            caps.maxTokens = Infinity;
                            caps.measured = null;
                            nudge = false;
                        }
                    }
                    const delayMs = err.retryAfter !== undefined
                        ? err.retryAfter * 1000
                        : Math.min(config.retryMaxMs ?? RETRY_MAX_MS, (config.retryBaseMs ?? RETRY_BASE_MS) * 2 ** attempt);
                    // 等不完總時限就不必等了
                    if (Date.now() + delayMs >= deadlineAt) {
                        throw fail('timeout', `重試要等 ${delayMs}ms，超過總時限 ${config.taskTimeoutMs}ms`, { rounds: round });
                    }
                    attempt++;
                    onProgress({ phase: 'retrying', round, attempt, delayMs, thinkingTokens, writingTokens });
                    throwIfHookFailed(round);
                    try {
                        await sleep(delayMs, combined);
                    } catch {
                        throw abortError(round);
                    }
                    continue;
                }
                // 收尾：輪末的空白不是退化就照常保留，退化的一大串就丟掉；還在緩衝的開頭照常去重疊後送出
                if (!jsonMode && whitespace) {
                    if (isDegenerateRun(whitespace)) tailDropped = started;
                    else if (started) accept(whitespace);
                    whitespace = '';
                }
                if (!headResolved && started) resolveHead();
                throwIfHookFailed(round);
                break;
            }

            const roundUsage = result.usage;
            const produced = result.content;
            // 這一輪各段的精確 token 數：正文是 completion − reasoning，思考是 reasoning。壓過或丟掉
            // 退化的空白時，那些空白的 token 也算在裡面，比例不準，不用
            const reasoningRatio = segmentRatio(reasoningTokensOf(roundUsage), result.reasoning);
            const contentRatio = squeezed || tailDropped ? null : segmentRatio(contentTokensOf(roundUsage, result.reasoning), produced);
            if (!jsonMode && content.length > (contentMarks.at(-1)?.end ?? 0)) contentMarks.push({ end: content.length, ratio: contentRatio });
            const prompt = promptTokensOf(roundUsage);
            // 成功的請求代表「輸入 + 這次的 max_tokens」放得進 context（WinLab 超過就 400、不會自動
            // 縮小）：不合的數字不可能是真的，當作沒有 usage
            if (prompt !== null && prompt + plan.maxTokens <= contextLimit) {
                if (plan.mode === 'fresh') {
                    // 題目的精確值只取原封不動送出原始 messages 的那一輪（之後幾輪含帶回的內容）。
                    // 接續輪的校正比例另有上下限，這裡沒有，所以小到不合理的數字直接不收
                    if (plan.roundMessages === messages && plausiblePrompt(prompt, messages)) baseTokens = prompt;
                } else if (baseTokens !== null && prompt > baseTokens) {
                    calibration = { mode: plan.mode, ratio: clampRatio((prompt - baseTokens) / plan.nonBaseCost) };
                }
            }

            if (result.finishReason === 'stop') {
                if (!content.trim()) {
                    throw fail('empty', '模型結束了，但沒有寫出任何正文', { rounds: round });
                }
                if (!jsonMode) return finish({ content, rounds: round, usage, continuations }, round);
                // JSON 任務：拿掉 response_format 之後（退化過一次）輸出不再受約束，可能包著圍欄、
                // 夾帶說明或根本不合法；guided decoding 也不檢查任務另外的規定。合格才收下，否則用
                // 剩下的輪數整份重寫（下面的分支）
                if (acceptable(content)) return finish({ content: unwrapCodeFence(content), rounds: round, usage, continuations }, round);
            } else if (result.finishReason !== 'length') {
                throw fail('stopped', `模型以 ${result.finishReason} 結束`, { rounds: round, finishReason: result.finishReason });
            }

            // 被截斷：依這一輪產出了什麼決定下一輪
            const streakBefore = degenerateStreak;
            if (produced.trim()) {
                let degenerated;
                if (jsonMode) {
                    // JSON 其實已經寫完了，之後只是一直吐空白直到上限：直接收下
                    if (result.finishReason === 'length' && acceptable(content)) {
                        return finish({ content: unwrapCodeFence(content), rounds: round, usage, continuations }, round);
                    }
                    // 結構中間吐了一大串空白（json_object 允許結構之間有任意空白）：草稿裡壓掉，
                    // 下一輪也不帶 response_format，免得同樣的退化再來一次
                    degenerated = hasDegenerateWhitespace(content);
                    if (degenerated) dropFormat = true;
                    draft = squeezeLongWhitespace(content).trimEnd();
                    draftMarks = [{ end: draft.length, ratio: degenerated ? null : contentRatio }];
                    content = '';
                    mode = 'rewrite';
                    rejectedJson = result.finishReason === 'stop';
                } else {
                    degenerated = tailDropped;
                    mode = 'writing';
                }
                continuations.push(degenerated ? 'degenerate' : mode);
                addNotes(result.reasoning, reasoningRatio);
                forceNoThinking = false;
                nudge = false;
                degenerateStreak = 0;
            } else if (isDegenerateRun(produced)) {
                // 退化：整輪只有一大串空白。空白沒有送出、也沒有留在 content
                const formatDropped = jsonMode && !dropFormat;
                if (jsonMode) dropFormat = true;
                if (result.reasoning.trim()) {
                    addNotes(result.reasoning, reasoningRatio);
                    if (mode === 'fresh' || mode === 'thinking') {
                        // 思考其實已經完成：帶著筆記直接作答，不必從頭再想
                        mode = 'thinking';
                        thinkingTruncations = Math.max(thinkingTruncations, 2);
                    } else {
                        // 接續正文或重寫 JSON：維持原本的接法，下一輪不再思考
                        forceNoThinking = true;
                    }
                }
                // 沒有新的筆記、也沒有剛拿掉 response_format：下一輪的請求會一模一樣，加一句提醒
                nudge = !result.reasoning.trim() && !formatDropped;
                degenerateStreak++;
                continuations.push('degenerate');
            } else if (result.reasoning.trim()) {
                addNotes(result.reasoning, reasoningRatio);
                if (mode === 'writing' || mode === 'rewrite') {
                    forceNoThinking = true;
                    continuations.push(mode);
                } else {
                    mode = 'thinking';
                    // 已經開始輸出（只吐了幾個換行）才被截斷：思考其實已經結束、只是額度用完，直接作答
                    thinkingTruncations = produced ? Math.max(thinkingTruncations + 1, 2) : thinkingTruncations + 1;
                    continuations.push('thinking');
                }
                nudge = false;
                degenerateStreak = 0;
            } else {
                // 什麼都沒寫（或只有幾個空白）就被截斷
                const formatDropped = jsonMode && !dropFormat;
                if (jsonMode) dropFormat = true;
                nudge = !formatDropped;
                degenerateStreak++;
                continuations.push('degenerate');
            }
            // 下一輪的請求（不算提醒）會跟這一輪一模一樣：寫了字卻只是重複已寫的內容、重寫出同一份
            // 草稿、或思考了但下一輪不會帶上筆記（強度本來就是 none）。這一輪沒有淨進展：算進連續
            // 退化，並加上提醒讓請求不同
            if (shapeKey(roundShape()) === plan.shapeKey) {
                degenerateStreak = Math.max(degenerateStreak, streakBefore + 1);
                nudge = true;
            }
            if (degenerateStreak >= 2) {
                const code = !partial().trim() ? 'empty' : rejectedJson ? 'format' : 'incomplete';
                throw fail(code, '模型連續兩輪沒有任何進展，提前結束', { rounds: round });
            }
        }

        if (rejectedJson) throw fail('format', `用完 ${config.maxRounds} 輪，JSON 仍不符合格式`, { rounds: config.maxRounds });
        throw fail('incomplete', `用完 ${config.maxRounds} 輪仍未寫完`, { rounds: config.maxRounds });
    };

    try {
        return await runRounds();
    } catch (err) {
        // async hook 的 reject 要等它的回呼跑過才記得下來；在那之前同步丟出的錯誤（例如接著判定
        // context 放不下）不能把它蓋掉
        if (!hookFailed) await new Promise((resolve) => setImmediate(resolve));
        if (hookFailed && err !== hookError) throw attach(hookError, currentRound);
        throw err;
    } finally {
        clearTimeout(deadlineTimer);
    }
}
