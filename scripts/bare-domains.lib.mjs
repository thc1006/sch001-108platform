/**
 * 內文裸網域的擷取與篩選
 * --------------------------------------------------------------
 * 連結健檢一直只看得到「寫成 href／url 欄位的網址」。但 competitions.json 的
 * description 是大段中文說明，裡面充滿只用文字寫出來的網域——「原 tpmso.org 已
 * 轉址至 tpmso.k12ea.gov.tw」「現行官網為 harvardmun.org」。實測 119 筆競賽的
 * description 裡有 41 個裸主機名，其中 27 個在任何 url 欄位都不出現，等於完全
 * 沒有任何東西在看它們。
 *
 * 這件事不是理論風險：ieso-info.org（IESO 舊網域）已被接管成澳洲線上博弈站，
 * 而且回 HTTP 200。它只活在說明文字裡，所以既有的健檢一眼都沒看過它。
 *
 * ── 為什麼分成「確定性」與「需要網路」兩段 ──
 * 擷取（stage 1）必須是純字串運算，才能跑在 check-built-site.mjs 這個擋 PR 的
 * 確定性檢查裡；篩選掉「長得像網域但其實是檔名」則需要 DNS，只能在排程健檢
 * （check-external-links.mjs）裡做。兩段刻意分開，界線就是「要不要連網」。
 *
 * ── 為什麼不用 TLD 白名單 ──
 * 第一版想用「已知 TLD 清單」當主要判準，放棄了：那份清單會隨著 gTLD 一直長，
 * 而且對 sasmo.simcc.org、sciexplore.colife.org.tw、tpmso.k12ea.gov.tw 這種多層
 * 網域完全沒有幫助（判準在最後一個 label，多層與否無關）。改成「這個 TLD 在 DNS
 * 根區裡存不存在」——用 NS 查詢實測，自我維護、不會過期。實測結果：
 *     .js .min .g .harbour .css .html .json .ts .tsx .go .php .exe .pdf .png → ENOTFOUND
 *     .md .so .ai .sh .py .rs .zip .mov .now .africa .de .tw .org .com       → 存在
 * 所以 Node.js、vue.js、fuse.min.js、e.g.、i.e.、v1.2.3 全部自動被淘汰，不必維護清單。
 *
 * ── 為什麼「能不能解析」不能當作判準 ──
 * 直覺上「查得到 A 記錄才算網域」很吸引人，反正本來就要連過去。實測證明這條路
 * 兩頭都錯：
 *   ① 會漏掉真正該報的：concordreview.org 正是已經停用、查不到 A 記錄的網域，
 *      而那恰好就是我們要抓出來的東西。用可解析性當判準，等於一看到死網域就把
 *      它當成「不是網域」丟掉——檢查器對它唯一該偵測的目標永久失明。
 *   ② 擋不住誤判：readme.md、logo.ai、test.sh、cargo.rs 全都被蹲域名的人註冊了，
 *      實測都解析得到（分別是 46.36.217.39、216.198.79.1、113.29.216.100、
 *      144.76.117.26）。可解析性對這類檔名根本沒有鑑別力。
 * 所以：TLD 是否存在 → 用 DNS 實測（自我維護）；網域是否還活著 → 交給探測分類，
 * 絕不拿來反過來決定「它算不算網域」。
 *
 * ── 與檔名撞名的 TLD ──
 * 上面那組實測留下唯一沒被解決的誤判類型：TLD 本身就是常見副檔名，而且真的存在
 * 於根區（.md .so .ai .sh .py .rs .pl .ps .zip .mov .im .cat .bar）。對這一組，
 * 「純文字裡出現 xxx.md」是檔名的機率遠高於網域，且可解析性已證明無鑑別力，
 * 因此一律不從內文擷取。這是一份**封閉且有明確理由**的清單（副檔名撞名），不會
 * 隨 gTLD 增長，與被否決的「TLD 白名單」是兩回事。代價實測為 0：本站資料的內文
 * 裸網域沒有任何一個落在這組 TLD。真的需要檢查這種網域時，寫成完整網址即可。
 */

/**
 * TLD 與極常見副檔名撞名，且該 TLD 確實存在於 DNS 根區。
 *
 * ── 這是一份「需要維護」的啟發式清單，不是封閉清單 ──
 * 早期版本宣稱它「封閉且不隨 gTLD 增長」。那是錯的，而且已被實測推翻：拿 122 個
 * 常見副檔名去查根區，有 14 個是真 TLD，其中 .app .build .dev .tools 正是近年才
 * 新增的 gTLD。只要 ICANN 繼續開放新 gTLD，撞名就會繼續發生，這份清單就得繼續補。
 *
 * 收錄門檻仍然只有一條：**該字串同時是常見副檔名、且該 TLD 真的存在於根區**。
 * 據此收錄 pm（Perl 模組）、tf（Terraform）、ml（OCaml）、cab（Windows 封裝檔）、
 * pub（SSH 公鑰／Publisher）、map（source map，前端專案滿地都是）、app（macOS bundle）。
 *
 * 刻意**不**收 net／id／to／name／build／dev／tools：它們是真 TLD，但根本不是副檔名，
 * 遮蔽它們換不到任何誤判減少，只會平白少檢查真實網域——.net 尤其不能遮。
 *
 * ── .ai 已經移除，因為它的代價不是 0 ──
 * 原始清單收了 .ai（Adobe Illustrator）。新增的 canary 測試一跑就抓到：本站語料裡
 * online-courses.json 的 /courses/3/provider 是「DeepLearning.AI」、methodology.json
 * 的 /methods/2/content_html 推薦「Otter.ai (AI語音轉文字)」——兩個都是真實網站，
 * 卻因為遮蔽而永遠不會被檢查。這正好示範了「代價為 0」不是可以用眼睛宣稱的東西。
 * .ai 現已成為 AI 產品的主流網域，在教育資源的內文裡出現真網域的機率遠高於出現
 * Illustrator 檔名，因此不遮。
 *
 * 遮蔽的代價是「用這些 TLD 的真實網域永遠不會被內文擷取」。那個代價必須是看得見的：
 * bare-domains.test.mjs 有一條測試守住「本站語料經過遮蔽後不得少掉任何候選」，
 * 哪天真的有競賽官網是 foo.app，那條測試會紅，逼人當場決定，而不是靜靜漏檢。
 */
export const SHADOWED_BY_FILE_EXT = new Set([
    'md',  // Markdown
    'so',  // shared object
    'sh',  // shell script
    'py',  // Python
    'rs',  // Rust
    'pl',  // Perl
    'ps',  // PostScript
    'zip', // 壓縮檔
    'mov', // QuickTime
    'im',  // 常見於 .im 副檔名與即時通訊縮寫
    'cat', // Windows 目錄簽章檔
    'bar', // 泛用佔位字（foo.bar）
    // ↓ 敵意複查實測補上：這 7 個同樣是「常見副檔名 ＋ 真 TLD」，先前漏收
    'pm',  // Perl 模組
    'tf',  // Terraform
    'ml',  // OCaml／ML
    'cab', // Windows 封裝檔
    'pub', // SSH 公鑰、MS Publisher
    'map', // source map（bundle.js.map，前端專案滿地都是）
    'app', // macOS 應用程式 bundle（.app 是 2015 年開放的 gTLD）
]);

/**
 * 帶 scheme 的網址。這些已經由既有的 url 擷取涵蓋，必須先遮掉，否則
 * https://a.org/b.com 會被拆出 b.com 這種根本不存在的主機名。
 * 終止字元含中文標點：中文內文裡網址後面接的是「。」「，」「）」「」」而不是空白。
 */
const URL_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`，。、；：（）「」『』《》【】]+/g;

/**
 * 電子郵件位址。右半邊是郵件主機，不等於網站主機——實測 unlv.nevada.edu、
 * olpcs.com 都只出現在信箱裡，把它們當網站去探測只會製造誤報。整串遮掉。
 */
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

/**
 * 裸主機名的形態。
 *
 * 左界的 lookbehind 是關鍵：不可以接在英數、點、@、斜線、反斜線、底線、連字號
 * 後面。少了它，沒遮乾淨的路徑 /files/report.org 會被擷出 report.org，而且
 * a.b.c 這種會從中間再擷一次 b.c。
 *
 * = # ? & 也在字元類裡，擋的是「網址的 query／fragment 參數值」。URL_LIKE 只遮得掉
 * 帶 scheme 的網址，內文寫成 arcade.now/lp1/play?subid=sasmo.sg（沒有 https://）時
 * 遮不到，而 = 不在左界就會把參數值 sasmo.sg 擷成一台主機去探測——那是內文根本沒有
 * 在推薦的網域。實測本站資料加上這四個字元後候選數不變（45／15／30），代價為 0。
 *
 * 第二道 lookbehind 擋的是「非 CJK 的 Unicode 字母緊貼在網域前面」。少了它，西里爾
 * 的 еvil.org 會被截成 vil.org、全形的 Ａbc.org 會被截成 bc.org——內文點名 A 網域，
 * 檢查器卻去驗 B 網域並回報 B 的健康狀態。那不是誤判，是張冠李戴：它產生的是**錯誤的
 * 保證**，比漏檢更糟。漢字／假名／諺文刻意留在允許集合裡，因為「官網為tpmso.org」這種
 * 中文緊貼的寫法正是本站語料的實際形態，必須繼續擷得出來（已於測試中固定）。
 *
 * 右界靠字元類自然結束。中文標點不在字元類裡，所以「官網為 tcr.org。」會正確
 * 停在 org；換行同理，example.\norg 不會被接起來（已於測試中固定）。
 */
const CANDIDATE =
    /(?<![A-Za-z0-9._@/\\=#?&-])(?<=^|[^\p{L}]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62})/gu;

/** 用等長空白遮蔽，讓後續比對的 index 仍然對得上原字串。 */
const maskWith = (text, re) => text.replace(re, (m) => ' '.repeat(m.length));

/**
 * Stage 1：純字串的裸網域擷取。**不連網**，因此可以跑在擋 PR 的確定性檢查裡。
 *
 * 回傳的是「候選」而不是「網域」——是否為真正的網域要等 screenBareDomains()
 * 用 DNS 判斷 TLD 存不存在。命名刻意保留 candidate，避免呼叫端以為已經篩過。
 *
 * @param {string} text
 * @param {{keepShadowedTlds?: boolean}} [opts] keepShadowedTlds 保留與副檔名撞名的 TLD，
 *        只給「量測遮蔽代價」的測試用：正式路徑一律過濾。
 * @returns {{host: string, raw: string, index: number}[]} host 為小寫，順序即出現順序
 */
export function extractBareDomainCandidates(text, opts = {}) {
    if (typeof text !== 'string' || !text) return [];

    // 順序有意義：先遮網址（否則網址裡的路徑會被當成裸網域），再遮信箱。
    let masked = maskWith(text, URL_LIKE);
    masked = maskWith(masked, EMAIL_LIKE);

    const out = [];
    for (const m of masked.matchAll(CANDIDATE)) {
        // 結尾的連字號不屬於主機名（regex 的字元類允許它結尾）
        const raw = m[1].replace(/-+$/, '');
        const host = raw.toLowerCase();
        // 單一 label 的形狀（開頭結尾必須是英數、不得超過 63 字、至少兩段）已經
        // 完全由 CANDIDATE 的字元類與量詞決定，再檢查一次是抓不到東西的死碼——
        // 故障注入實測把那段拿掉，測試依然全綠，所以刪掉而不是留著當裝飾。
        // 整串主機名的長度上限是 regex 管不到的（label 數量不設限），必須留著。
        if (host.length > 253) continue;

        const labels = host.split('.');
        const tld = labels[labels.length - 1];
        // TLD 至少兩個字元，且不可含數字（真實 TLD 沒有含數字的；這一條讓
        // 版本號與代號在不連網的情況下就先被擋掉）
        if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) continue;
        // 與副檔名撞名的 TLD：內文裡幾乎必然是檔名，見檔頭說明
        if (!opts.keepShadowedTlds && SHADOWED_BY_FILE_EXT.has(tld)) continue;

        out.push({ host, raw, index: m.index });
    }
    return out;
}

/**
 * 從一份已 parse 的資料物件裡，把所有字串欄位的裸網域候選收集起來。
 *
 * @param {unknown} data
 * @param {(pointer: string, value: string) => boolean} [accept] 決定某個欄位要不要掃
 * @returns {Map<string, string[]>} host → JSON pointer 陣列
 */
export function collectBareDomains(data, accept, opts = {}) {
    /** @type {Map<string, string[]>} */
    const found = new Map();
    const walk = (node, pointer) => {
        if (typeof node === 'string') {
            if (accept && !accept(pointer, node)) return;
            for (const { host } of extractBareDomainCandidates(node, opts)) {
                if (!found.has(host)) found.set(host, []);
                const at = found.get(host);
                if (!at.includes(pointer)) at.push(pointer);
            }
            return;
        }
        if (Array.isArray(node)) {
            node.forEach((v, i) => walk(v, `${pointer}/${i}`));
            return;
        }
        if (node && typeof node === 'object') {
            for (const [k, v] of Object.entries(node)) walk(v, `${pointer}/${k}`);
        }
    };
    walk(data, '');
    return found;
}

/**
 * 只有這些錯誤碼代表 DNS 明確回答「沒有這個名字」。其餘（SERVFAIL、逾時、連不到
 * resolver、EAI_AGAIN…）都只代表「這一次沒問到」，不可以拿來斷言該 TLD 不存在。
 */
const DEFINITIVE_ABSENT = new Set(['ENOTFOUND', 'NOTFOUND', 'ENODATA', 'NODATA', 'NXDOMAIN']);

/**
 * 篩選階段的時間預算。這一段先前完全沒有上限，而它跑在 runProbes 的 12＋3 分鐘
 * 預算**之外**——實測把 resolver 指到無人回應的位址，光是篩 30 個候選就花了 208 秒，
 * 全部是白白疊在 job 上的額外開銷。
 *
 * 60 秒的由來：正常情形實測 247ms〜1.1 秒（30 個候選、8 個去重 TLD，且有快取），
 * 60 秒已是正常值的 50 倍以上；同時它只占 workflow 30 分鐘上限的 3%，不會侵蝕
 * 探測本身的 12＋3 分鐘。逾時不算失敗，一律歸入 unresolved——那條路徑已經會讓
 * coverage_complete=false、needs_attention=true，會大聲說話。
 */
export const SCREEN_BUDGET_MS = 60_000;
/** 單筆根區 NS 查詢的上限。正常是數十毫秒，5 秒已經是離群值。 */
export const SCREEN_QUERY_TIMEOUT_MS = 5_000;

/** 給 promise 加上硬逾時，並確實清掉 timer（否則會拖住 event loop）。 */
function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error('TLD 查詢逾時'), { code: 'ETIMEOUT' })), ms);
        promise.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

/**
 * 「這個欄位要不要掃裸網域」的過濾器。
 *
 * 先前的寫法只比對 JSON pointer 的**最後一段**（`pointer.split('/').pop()`）。
 * 目前所有資料檔的 _readme 與圖片欄位剛好都是頂層字串，所以看起來是對的；但只要
 * 哪天 _readme 變成陣列、或 image 變成一份清單，pointer 就會變成 /_readme/0、
 * /gallery/0/image，最後一段是 "0"，跳過邏輯**當場失效而且不會有任何訊號**——
 * 檔名與圖片路徑會整批變成裸網域候選。改成「任何一段命中就跳過」。
 *
 * @param {Iterable<string>} skipFields
 * @returns {(pointer: string) => boolean} true ＝ 這個欄位要掃
 */
export function makeSkipFieldFilter(skipFields) {
    const skip = new Set(skipFields);
    return (pointer) => !String(pointer).split('/').some((seg) => skip.has(seg));
}

/**
 * Stage 2：用 DNS 根區判斷「這個 TLD 存不存在」，藉此淘汰 Node.js／fuse.min.js／
 * e.g. 這類形態相符但根本不是網域的候選。
 *
 * 刻意查 NS 而不是 A：TLD 本身通常沒有 A 記錄，但一定有 NS（它就是靠 NS 被委派
 * 出去的）。查不到 NS ＝ 這個字串不是被委派的 TLD。
 *
 * 結果會快取——同一份資料裡 .org 會出現幾十次，不該查幾十次。
 *
 * 回傳 'yes'（根區裡有）／'no'（根區明確說沒有）／'unknown'（這次問不到答案）。
 * @param {{resolveNs?: (name: string) => Promise<string[]>, cache?: Map<string, 'yes'|'no'|'unknown'>}} [deps]
 */
export function makeTldChecker(deps = {}) {
    const cache = deps.cache ?? new Map();
    const resolveNs = deps.resolveNs;
    if (typeof resolveNs !== 'function') throw new Error('makeTldChecker 需要 resolveNs（請注入，測試不得連外網）');
    const queryTimeoutMs = deps.queryTimeoutMs ?? SCREEN_QUERY_TIMEOUT_MS;

    return async function tldExists(tld) {
        const key = String(tld).toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let verdict;
        try {
            const ns = await withTimeout(Promise.resolve(resolveNs(`${key}.`)), queryTimeoutMs);
            verdict = Array.isArray(ns) && ns.length > 0 ? 'yes' : 'no';
        } catch (err) {
            // 「DNS 說沒有這個名字」與「DNS 根本沒回答」是兩件事，先前都被壓成
            // false。壓成同一件事的代價實測過：把 resolver 指到無人回應的位址，
            // 30 個候選全部被歸成「不是網域」，報告白紙黑字寫「.org 不是 DNS 根區
            // 裡的 TLD」，而 needs_attention=false、coverage_complete=true——
            // 一個裸網域都沒檢查，CI 全綠。這正是本 repo 一路在修的靜默漏檢。
            const code = String(err?.code || err?.errno || '');
            verdict = DEFINITIVE_ABSENT.has(code) ? 'no' : 'unknown';
        }
        // 三種答案都快取：同一批候選裡 .org 會出現幾十次，resolver 掛掉時若不快取
        // 會把一次逾時放大成幾十次逾時（實測 8 個 TLD 就花了 208 秒）。
        cache.set(key, verdict);
        return verdict;
    };
}

/**
 * Stage 2 的批次版：把候選主機名分成三堆——accepted（TLD 確實存在）、rejected
 * （根區明確說沒有這個 TLD）、unresolved（這次問不到答案）。第三堆刻意不併進
 * rejected：兩者都不會被探測，但只有前者可以宣稱「它不是網域」。
 *
 * 注意這裡**不做**可解析性判斷。死掉的網域必須留在 accepted 裡走完整的探測與
 * 三態分類，否則檢查器會對自己唯一該抓的東西失明（見檔頭）。
 *
 * @param {string[]} hosts
 * @param {{resolveNs?: Function, cache?: Map<string, 'yes'|'no'|'unknown'>, budgetMs?: number,
 *          queryTimeoutMs?: number, now?: () => number}} [deps]
 * @returns {Promise<{accepted: string[], rejected: {host: string, reason: string}[], unresolved: {host: string, reason: string}[]}>}
 */
export async function screenBareDomains(hosts, deps = {}) {
    const tldExists = makeTldChecker(deps);
    const now = deps.now ?? (() => Date.now());
    const deadline = now() + (deps.budgetMs ?? SCREEN_BUDGET_MS);
    const accepted = [];
    const rejected = [];
    const unresolved = [];
    for (const host of hosts) {
        const tld = String(host).toLowerCase().split('.').pop();
        if (now() >= deadline) {
            // 預算用盡：剩下的一律歸 unresolved，不是 rejected——我們沒問，
            // 不代表它不是網域。單筆查詢另有上限，所以最多只會超出一筆的時間。
            unresolved.push({ host, reason: `.${tld} 未查詢（篩選階段已用盡時間預算）` });
            continue;
        }
        const verdict = await tldExists(tld);
        if (verdict === 'yes') accepted.push(host);
        else if (verdict === 'no') rejected.push({ host, reason: `.${tld} 不是 DNS 根區裡的 TLD（多半是檔名或縮寫，不是網域）` });
        // 問不到答案的不會被探測（維持「沒把握就不送出去」），但**必須**單獨回報：
        // 它與「確定不是網域」在報告上長得一模一樣，混在一起就是靜默漏檢。
        else unresolved.push({ host, reason: `.${tld} 這次查不到答案（DNS 沒有回應；這不代表該 TLD 不存在）` });
    }
    return { accepted, rejected, unresolved };
}

/**
 * 裸網域要用哪個網址去探測。一律 https——2026 年沒有理由預設用 http 去試，而且
 * 探測結果會走既有的 SSRF 防護與手動轉址，跟 url 欄位完全同一條路徑。
 */
export const probeUrlFor = (host) => `https://${host}/`;
