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
 * 只收「撞名」這一種理由，新增請附上實測（該 TLD 存在 ＋ 該副檔名常見）。
 */
export const SHADOWED_BY_FILE_EXT = new Set([
    'md',  // Markdown
    'so',  // shared object
    'ai',  // Adobe Illustrator
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
 * 右界靠字元類自然結束。中文標點不在字元類裡，所以「官網為 tcr.org。」會正確
 * 停在 org；換行同理，example.\norg 不會被接起來（已於測試中固定）。
 */
const CANDIDATE = /(?<![A-Za-z0-9._@/\\-])((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{0,62})/g;

/** 用等長空白遮蔽，讓後續比對的 index 仍然對得上原字串。 */
const maskWith = (text, re) => text.replace(re, (m) => ' '.repeat(m.length));

/** 單一 DNS label 是否合法。 */
function isValidLabel(label) {
    if (!label || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    return /^[A-Za-z0-9-]+$/.test(label);
}

/**
 * Stage 1：純字串的裸網域擷取。**不連網**，因此可以跑在擋 PR 的確定性檢查裡。
 *
 * 回傳的是「候選」而不是「網域」——是否為真正的網域要等 screenBareDomains()
 * 用 DNS 判斷 TLD 存不存在。命名刻意保留 candidate，避免呼叫端以為已經篩過。
 *
 * @param {string} text
 * @returns {{host: string, raw: string, index: number}[]} host 為小寫，順序即出現順序
 */
export function extractBareDomainCandidates(text) {
    if (typeof text !== 'string' || !text) return [];

    // 順序有意義：先遮網址（否則網址裡的路徑會被當成裸網域），再遮信箱。
    let masked = maskWith(text, URL_LIKE);
    masked = maskWith(masked, EMAIL_LIKE);

    const out = [];
    for (const m of masked.matchAll(CANDIDATE)) {
        // 結尾的連字號不屬於主機名（regex 的字元類允許它結尾）
        const raw = m[1].replace(/-+$/, '');
        const host = raw.toLowerCase();
        if (host.length > 253) continue;

        const labels = host.split('.');
        if (labels.length < 2) continue;
        if (!labels.every(isValidLabel)) continue;

        const tld = labels[labels.length - 1];
        // TLD 至少兩個字元，且不可含數字（真實 TLD 沒有含數字的；這一條讓
        // 版本號與代號在不連網的情況下就先被擋掉）
        if (tld.length < 2 || !/^[A-Za-z]+$/.test(tld)) continue;
        // 與副檔名撞名的 TLD：內文裡幾乎必然是檔名，見檔頭說明
        if (SHADOWED_BY_FILE_EXT.has(tld)) continue;

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
export function collectBareDomains(data, accept) {
    /** @type {Map<string, string[]>} */
    const found = new Map();
    const walk = (node, pointer) => {
        if (typeof node === 'string') {
            if (accept && !accept(pointer, node)) return;
            for (const { host } of extractBareDomainCandidates(node)) {
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
 * Stage 2：用 DNS 根區判斷「這個 TLD 存不存在」，藉此淘汰 Node.js／fuse.min.js／
 * e.g. 這類形態相符但根本不是網域的候選。
 *
 * 刻意查 NS 而不是 A：TLD 本身通常沒有 A 記錄，但一定有 NS（它就是靠 NS 被委派
 * 出去的）。查不到 NS ＝ 這個字串不是被委派的 TLD。
 *
 * 結果會快取——同一份資料裡 .org 會出現幾十次，不該查幾十次。
 *
 * @param {{resolveNs?: (name: string) => Promise<string[]>, cache?: Map<string, boolean>}} [deps]
 */
export function makeTldChecker(deps = {}) {
    const cache = deps.cache ?? new Map();
    const resolveNs = deps.resolveNs;
    if (typeof resolveNs !== 'function') throw new Error('makeTldChecker 需要 resolveNs（請注入，測試不得連外網）');

    return async function tldExists(tld) {
        const key = String(tld).toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let exists;
        try {
            const ns = await resolveNs(`${key}.`);
            exists = Array.isArray(ns) && ns.length > 0;
        } catch {
            // ENOTFOUND／NXDOMAIN＝沒有這個 TLD。其他錯誤（SERVFAIL、逾時）也一律
            // 視為「無法確認」而不採用——寧可漏掉一個候選，也不要拿一個沒把握的
            // 字串去當網域探測，那會直接變成報告噪音。
            exists = false;
        }
        cache.set(key, exists);
        return exists;
    };
}

/**
 * Stage 2 的批次版：把候選主機名分成「確定是網域」與「淘汰」兩堆。
 *
 * 注意這裡**不做**可解析性判斷。死掉的網域必須留在 accepted 裡走完整的探測與
 * 三態分類，否則檢查器會對自己唯一該抓的東西失明（見檔頭）。
 *
 * @param {string[]} hosts
 * @param {{resolveNs?: Function, cache?: Map<string, boolean>}} [deps]
 * @returns {Promise<{accepted: string[], rejected: {host: string, reason: string}[]}>}
 */
export async function screenBareDomains(hosts, deps = {}) {
    const tldExists = makeTldChecker(deps);
    const accepted = [];
    const rejected = [];
    for (const host of hosts) {
        const tld = String(host).toLowerCase().split('.').pop();
        if (await tldExists(tld)) accepted.push(host);
        else rejected.push({ host, reason: `.${tld} 不是 DNS 根區裡的 TLD（多半是檔名或縮寫，不是網域）` });
    }
    return { accepted, rejected };
}

/**
 * 裸網域要用哪個網址去探測。一律 https——2026 年沒有理由預設用 http 去試，而且
 * 探測結果會走既有的 SSRF 防護與手動轉址，跟 url 欄位完全同一條路徑。
 */
export const probeUrlFor = (host) => `https://${host}/`;
