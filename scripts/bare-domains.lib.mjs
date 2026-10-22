// 內文裸網域的擷取與篩選。competitions.json 的 description 常把網域寫成純文字，例如「原 tpmso.org 已
// 轉址至 tpmso.k12ea.gov.tw」，只看 href／url 欄位的連結健檢看不到它們。#114 實測 119 筆競賽的
// description 有 41 個裸主機名，其中 27 個不在任何 url 欄位；被接管成博弈站、仍回 HTTP 200 的
// ieso-info.org 就只出現在說明文字裡。
//
// 擷取（stage 1）是純字串運算，才能跑在 check-built-site.mjs 這個擋 PR 的確定性檢查裡；篩選
// （stage 2）要查 DNS，只在排程健檢 check-external-links.mjs 裡做。
//
// 篩選只問 TLD 在不在 DNS 根區（查 NS），不必維護 TLD 清單，Node.js、fuse.min.js 這類候選自然被淘汰。
// 不拿「網域解析得到」當判準，因為兩頭都錯：已經停用、查不到 A 記錄的 concordreview.org 正是要抓的網域，
// readme.md、logo.ai、test.sh 卻都被蹲域名的人註冊了，解析得到。網域還活著與否交給探測分類決定。
// 與副檔名撞名的 TLD 不從內文擷取，見 SHADOWED_BY_FILE_EXT。

/**
 * SHADOWED_BY_FILE_EXT 列出和常見副檔名撞名、又確實存在於 DNS 根區的 TLD。內文裡的 README.md、main.py
 * 幾乎都是檔名，而查 DNS 也分不出來，所以一律不擷取。收錄的前提是該字串是常見副檔名，且該 TLD
 * 真的在根區裡。只要 ICANN 繼續開放新 gTLD，撞名就會繼續發生，這份清單就得繼續補。
 * net、id、to、name、build、dev、tools 是真 TLD 卻不是副檔名，遮掉只會少檢查真網域，所以不收。
 * 符合前提的還要看本站語料有沒有用這個 TLD 的真網域，.ai 就是因此不收：語料裡的 DeepLearning.AI、
 * Otter.ai 都是真網站，AI 產品也多用 .ai 網域。
 * 遮掉的代價是這些 TLD 上的真網域永遠不會被擷取。bare-domains.test.mjs 檢查本站語料遮蔽前後的候選
 * 相同，哪天有競賽官網是 foo.app，那條測試會紅，逼人當場決定，而不是靜靜漏檢。
 */
export const SHADOWED_BY_FILE_EXT = new Set([
    'md',  // Markdown
    'so',  // 共享函式庫
    'sh',  // shell 腳本
    'py',  // Python
    'rs',  // Rust
    'pl',  // Perl
    'ps',  // PostScript
    'zip', // 壓縮檔
    'mov', // QuickTime
    'im',  // 常見於 .im 副檔名與即時通訊縮寫
    'cat', // Windows 目錄簽章檔
    'bar', // 泛用佔位字（foo.bar）
    'pm',  // Perl 模組
    'tf',  // Terraform
    'ml',  // OCaml／ML
    'cab', // Windows 封裝檔
    'pub', // SSH 公鑰、MS Publisher
    'map', // source map（bundle.js.map，前端專案滿地都是）
    'app', // macOS 應用程式 bundle（.app 是 2015 年開放的 gTLD）
]);

/** URL_LIKE 是帶 scheme 的網址。中文內文的網址後面常緊接「。」「，」「）」而不是空白，所以中文標點也算結尾。 */
const URL_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`，。、；：（）「」『』《》【】]+/g;

/** EMAIL_LIKE 是電子郵件位址，整串遮掉：右半邊是郵件主機，不等於網站主機，拿去探測只會製造誤報。 */
const EMAIL_LIKE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+/g;

/** CANDIDATE 是裸主機名的形態。左界的兩道 lookbehind 決定哪些片段不擷取，見 extractBareDomainCandidates。 */
const CANDIDATE =
    /(?<![A-Za-z0-9._@/\\=#?&-])(?<=^|[^\p{L}]|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62})/gu;

/** 用等長空白遮蔽，讓後續比對的 index 仍然對得上原字串。 */
const maskWith = (text, re) => text.replace(re, (m) => ' '.repeat(m.length));

/**
 * extractBareDomainCandidates 是 stage 1：純字串的裸網域擷取，不連網，因此可以跑在擋 PR 的確定性檢查裡。
 * 回傳的是「候選」而不是「網域」，是否為真正的網域要等 screenBareDomains() 用 DNS 判斷 TLD 存不存在；
 * 命名刻意保留 candidate，避免呼叫端以為已經篩過。
 * 接在英數、點、@、斜線、反斜線、底線、連字號或 = # ? & 後面的不擷取，沒遮乾淨的路徑 /files/report.org
 * 和沒有 scheme 的 arcade.now/x?subid=sasmo.sg 裡的參數值才不會被擷成主機。緊貼在非 CJK 字母後面的也不擷取，
 * 否則 еvil.org 會被截成 vil.org，內文點名一台主機，檢查器卻回報另一台的健康狀態。
 * 漢字、假名、諺文後面照樣擷取，「官網為tpmso.org」這種寫法正是本站語料的實際形態。
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
        // 每個 label 的形狀由 CANDIDATE 決定，但 label 數量不設限，整串主機名的長度上限只能在這裡檢查。
        if (host.length > 253) continue;

        const labels = host.split('.');
        const tld = labels[labels.length - 1];
        // TLD 只收兩個字元以上的純字母，版本號與代號不必連網就先擋掉；xn-- 開頭的 IDN TLD 也會被擋掉。
        if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) continue;
        // 與副檔名撞名的 TLD：內文裡幾乎必然是檔名，見 SHADOWED_BY_FILE_EXT。
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

/** DEFINITIVE_ABSENT 是 DNS 明確回答「沒有這個名字」的錯誤碼。SERVFAIL、逾時、EAI_AGAIN 只代表這次沒問到。 */
const DEFINITIVE_ABSENT = new Set(['ENOTFOUND', 'NOTFOUND', 'ENODATA', 'NODATA', 'NXDOMAIN']);

/** SCREEN_BUDGET_MS 是篩選階段的時間預算，正常耗時實測 247ms 到 1.1 秒。 */
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
 * makeSkipFieldFilter 回傳過濾器，pointer 任何一段命中 skipFields 就跳過，所以 /_readme/0 也會跳過。
 * @param {Iterable<string>} skipFields @returns {(pointer: string) => boolean} true ＝ 這個欄位要掃
 */
export function makeSkipFieldFilter(skipFields) {
    const skip = new Set(skipFields);
    return (pointer) => !String(pointer).split('/').some((seg) => skip.has(seg));
}

/**
 * makeTldChecker 回傳 stage 2 用的 tldExists：用 DNS 根區判斷 TLD 存不存在，答案是 'yes'（根區裡有）、
 * 'no'（根區明確說沒有）或 'unknown'（這次問不到答案），藉此淘汰 Node.js、fuse.min.js 這類候選。
 * 刻意查 NS 而不是 A：TLD 本身通常沒有 A 記錄，但一定有 NS，它就是靠 NS 被委派出去的。
 * 結果會快取，同一份資料裡 .org 會出現幾十次，不該查幾十次。
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
            // 「DNS 說沒有這個名字」與「DNS 根本沒回答」要分開：都算 'no' 的話，resolver 沒有回應時
            // 每個候選都被歸成「不是網域」，而 coverage_complete=true，一個裸網域都沒檢查，CI 全綠。
            const code = String(err?.code || err?.errno || '');
            verdict = DEFINITIVE_ABSENT.has(code) ? 'no' : 'unknown';
        }
        // 'unknown' 也快取：resolver 掛掉時，同一個 TLD 只等一次逾時，不會放大成幾十次。
        cache.set(key, verdict);
        return verdict;
    };
}

/**
 * screenBareDomains 是 stage 2 的批次版，把候選主機名分成三堆：accepted（TLD 確實存在）、rejected
 * （根區明確說沒有這個 TLD）、unresolved（這次問不到答案）。第三堆刻意不併進 rejected：兩者都不會
 * 被探測，但只有 rejected 可以宣稱「它不是網域」。
 * 這裡不做可解析性判斷。死掉的網域必須留在 accepted 裡，照樣去探測、走三態分類，見檔頭。
 * 篩選跑在 runProbes 的 12＋3 分鐘預算之外，所以另有 budgetMs（預設 SCREEN_BUDGET_MS）。沒有上限的話，
 * 實測 resolver 沒有回應時光是篩 30 個候選就花了 208 秒。預設的 60 秒是正常耗時的 50 倍以上，
 * 只占 job 30 分鐘上限的 3%。用盡時剩下的候選歸入 unresolved，
 * 報告會因此寫 coverage_complete=false、needs_attention=true。
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
            // 預算用盡：剩下的一律歸 unresolved，不是 rejected。我們沒問，
            // 不代表它不是網域。單筆查詢另有上限，所以最多只會超出一筆的時間。
            unresolved.push({ host, reason: `.${tld} 未查詢（篩選階段已用盡時間預算）` });
            continue;
        }
        const verdict = await tldExists(tld);
        if (verdict === 'yes') accepted.push(host);
        else if (verdict === 'no') rejected.push({ host, reason: `.${tld} 不是 DNS 根區裡的 TLD（多半是檔名或縮寫，不是網域）` });
        // 問不到答案的不探測，但要單獨回報，和「確定不是網域」混在一起就是靜默漏檢。
        else unresolved.push({ host, reason: `.${tld} 這次查不到答案（DNS 沒有回應；這不代表該 TLD 不存在）` });
    }
    return { accepted, rejected, unresolved };
}

/** probeUrlFor 回傳裸網域的探測網址，一律用 https；探測和 url 欄位走同一條路徑，一樣有 SSRF 防護與手動轉址。 */
export const probeUrlFor = (host) => `https://${host}/`;
