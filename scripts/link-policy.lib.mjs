/**
 * 外部連結的例外政策（allowlist）
 * --------------------------------------------------------------
 * 有些網址在 GitHub runner 上就是驗不過，但在真實瀏覽器裡開得起來。#72 實測到的
 * 三個就是這種：憑證鏈不完整、連線被拒、PTT 擋資料中心 IP。每週把它們列進報告
 * 只會訓練維護者忽略通知——但直接刪掉檢查又會失去把關。所以需要一份 allowlist。
 *
 * allowlist 是安全機制裡最容易腐爛的東西，因此這裡的規則刻意寫死、不可繞過：
 *
 *   1. 只能降低 `unverified` 的通知噪音。**不會**把 404/410 或網域解析不到變成
 *      健康——連結真的壞了就是要被看到，這是 allowlist 存在的前提而不是代價。
 *   2. 只接受「精確網址」或「精確主機名」。不支援萬用字元、不做子字串比對——
 *      `ptt.cc` 的字串比對會連 `evil-ptt.cc.example.com` 一起放行。
 *   3. 每一筆都必須有 reason（為什麼）、owner（誰負責）、expires（何時重審）。
 *   4. expires 過期會讓**確定性 CI 失敗**（見 check-link-policy.mjs），強迫重新
 *      審查而不是無限延續。同時限制最長有效期，堵住「expires: 2099-12-31」。
 *   5. allowlist 的目標本身必須通過靜態位址政策——不能用它把
 *      http://169.254.169.254/ 放進來。
 *
 * ── hijacked：方向相反的另一份清單 ──
 * entries（allowlist）壓低訊號，hijacked 放大訊號。會需要它，是因為三態分類
 * 有一個結構性的盲點：網域被接管之後照樣回 HTTP 200，狀態碼完全健康，內容卻
 * 已經換人。ieso-info.org（IESO 舊網域）正是如此——現在是澳洲線上博弈站，回
 * 200，而健檢會很有信心地把它算進「健康」。
 *
 * hijacked 的每一筆都會讓對應主機**不論狀態碼**被單獨大聲列出，且永遠不計入
 * 健康。規則沿用 allowlist 的同一套紀律（精確主機名、reason／owner／expires、
 * 到期讓確定性 CI 紅），另外多要求一個 evidence：到期時要重新查證的是「它是否
 * 仍被接管」，沒有當初看到什麼的紀錄就無從比對。
 * 同一台主機不可以同時出現在 entries 與 hijacked——那是自相矛盾的宣告。
 */

import { staticUrlPolicy, canonicalHost } from './link-health.lib.mjs';

/** 一筆例外最長可以活多久。超過就等於「無期限」，那正是要禁止的東西。 */
export const MAX_HORIZON_DAYS = 180;

/** reason 至少要有這麼多字。留白或「x」不算理由。 */
const MIN_REASON_CHARS = 10;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOP_LEVEL_KEYS = new Set(['_readme', 'version', 'entries', 'hijacked']);
const ENTRY_KEYS = new Set(['match', 'reason', 'owner', 'expires']);
/** hijacked 多一個 evidence：沒有原始觀察就無法在到期時比對「是否仍被接管」。 */
const HIJACKED_KEYS = new Set(['match', 'reason', 'owner', 'expires', 'evidence']);

/** 日期是否真實存在（往返比對可抓出 2026-02-30 這種被 Date 靜默正規化的值）。 */
function isRealDate(text) {
    if (!DATE_RE.test(text)) return false;
    const [y, m, d] = text.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

const dayMs = 86_400_000;
const toUTCDay = (text) => {
    const [y, m, d] = text.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
};

/**
 * expires 的共用檢查。entries 與 hijacked 都用這一份——兩邊各寫一次，遲早會有
 * 一邊被放寬而沒人發現，而「例外悄悄變成無期限」正是整套規則要防的東西。
 */
function checkExpires(value, at, todayISO, todayMs, push) {
    if (typeof value !== 'string' || !isRealDate(value)) {
        push(`${at}.expires 必須是實際存在的 YYYY-MM-DD 日期`);
        return;
    }
    const ms = toUTCDay(value);
    if (ms <= todayMs) {
        push(`${at}.expires（${value}）已於今天（${todayISO}）或之前到期，必須重新查證後才可延長——這是刻意讓 CI 紅的`);
    } else if (ms - todayMs > MAX_HORIZON_DAYS * dayMs) {
        push(`${at}.expires（${value}）距今超過 ${MAX_HORIZON_DAYS} 天，等同無期限例外，不予接受`);
    }
}

/**
 * 精確主機名的共用檢查（不接受萬用字元／路徑／大小寫變體，且本身要過位址政策）。
 * 回傳正規化後的主機名，或 null（已經 push 過錯誤）。
 */
function checkExactHost(raw, at, push) {
    if (typeof raw !== 'string' || !raw.trim()) {
        push(`${at}.match.host 必須是非空字串`);
        return null;
    }
    if (raw.includes('*')) {
        push(`${at}.match.host 不得使用萬用字元——只接受精確主機名`);
        return null;
    }
    if (/[/:\s]/.test(raw)) {
        push(`${at}.match.host 只能是主機名，不得含路徑、埠號或空白`);
        return null;
    }
    if (raw !== canonicalHost(raw)) {
        push(`${at}.match.host 必須是小寫、無結尾點的形式：${canonicalHost(raw)}`);
        return null;
    }
    const verdict = staticUrlPolicy(`https://${raw}/`);
    if (!verdict.ok) {
        push(`${at}.match.host 本身就違反位址政策：${verdict.reason}`);
        return null;
    }
    return raw;
}

/**
 * 把網址正規化成與 .reports/url-inventory.json 相同的形式。
 * inventory 存的是 WHATWG URL 的 href 去掉 fragment；兩邊必須用同一套正規化，
 * 否則 allowlist 會因為一個結尾斜線而永遠比不中，而且完全沒有訊號。
 */
export function normalizeUrl(raw) {
    try {
        return new URL(String(raw)).href.split('#')[0];
    } catch {
        return String(raw);
    }
}

/**
 * 驗證整份政策檔。回傳 { errors, entries }；errors 非空時呼叫端必須讓 CI 失敗。
 *
 * @param {unknown} policy 已 parse 的 JSON
 * @param {string} todayISO 今天（YYYY-MM-DD，UTC）
 */
export function validatePolicy(policy, todayISO) {
    const errors = [];
    const entries = [];
    const push = (m) => errors.push(m);

    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
        return { errors: ['政策檔最外層必須是物件'], entries };
    }
    for (const k of Object.keys(policy)) {
        if (!TOP_LEVEL_KEYS.has(k)) push(`最外層含未知欄位「${k}」`);
    }
    if (policy.version !== 1) push(`version 必須是 1（目前為 ${JSON.stringify(policy.version)}）`);
    if (!Array.isArray(policy.entries)) {
        push('entries 必須是陣列');
        return { errors, entries };
    }
    if (!isRealDate(todayISO)) {
        push(`today「${todayISO}」不是合法日期`);
        return { errors, entries };
    }
    const todayMs = toUTCDay(todayISO);

    const seen = new Set();
    policy.entries.forEach((e, i) => {
        const at = `entries[${i}]`;
        // 這一筆有沒有出過錯，決定它能不能進 entries。過期或寫壞的例外絕不可被
        // 回傳出去——呼叫端一旦拿它去 matchPolicy()，就等於「過期的例外還在生效」，
        // 而那正是這整套規則要防的東西。
        const errorsBefore = errors.length;
        if (!e || typeof e !== 'object' || Array.isArray(e)) return push(`${at} 必須是物件`);
        for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) push(`${at} 含未知欄位「${k}」`);

        // ── match ──
        const m = e.match;
        let key = null;
        if (!m || typeof m !== 'object' || Array.isArray(m)) {
            push(`${at}.match 必須是物件，且恰好含 url 或 host 其中一個`);
        } else {
            const keys = Object.keys(m);
            if (keys.length !== 1 || !['url', 'host'].includes(keys[0])) {
                push(`${at}.match 只能有 url 或 host 其中一個欄位（目前：${keys.join('、') || '無'}）`);
            } else if (keys[0] === 'url') {
                const raw = m.url;
                if (typeof raw !== 'string' || !raw.trim()) push(`${at}.match.url 必須是非空字串`);
                else if (raw.includes('*')) push(`${at}.match.url 不得使用萬用字元——只接受精確網址`);
                else if (raw.includes('#')) push(`${at}.match.url 不得帶 fragment`);
                else {
                    const verdict = staticUrlPolicy(raw);
                    if (!verdict.ok) push(`${at}.match.url 本身就違反位址政策：${verdict.reason}`);
                    else if (normalizeUrl(raw) !== raw) {
                        // 要求寫進檔案的就是正規化後的字串，避免「看起來一樣但比不中」
                        push(`${at}.match.url 請改寫成正規化後的形式：${normalizeUrl(raw)}`);
                    } else key = `url:${raw}`;
                }
            } else {
                const host = checkExactHost(m.host, at, push);
                if (host) key = `host:${host}`;
            }
        }
        if (key) {
            if (seen.has(key)) push(`${at} 與前面的項目重複（${key}）`);
            seen.add(key);
        }

        // ── reason / owner ──
        if (typeof e.reason !== 'string' || [...e.reason.trim()].length < MIN_REASON_CHARS) {
            push(`${at}.reason 必須說明「為什麼驗不過」，至少 ${MIN_REASON_CHARS} 字`);
        }
        if (typeof e.owner !== 'string' || !e.owner.trim()) push(`${at}.owner 必須指名負責重審的人`);

        // ── expires ──
        checkExpires(e.expires, at, todayISO, todayMs, push);

        if (key && errors.length === errorsBefore) entries.push({ ...e, _key: key });
    });

    // ── hijacked：被接管的網域 ──
    const hijacked = [];
    if (policy.hijacked !== undefined) {
        if (!Array.isArray(policy.hijacked)) {
            push('hijacked 必須是陣列');
        } else {
            const seenHijacked = new Set();
            policy.hijacked.forEach((e, i) => {
                const at = `hijacked[${i}]`;
                const errorsBefore = errors.length;
                if (!e || typeof e !== 'object' || Array.isArray(e)) return push(`${at} 必須是物件`);
                for (const k of Object.keys(e)) if (!HIJACKED_KEYS.has(k)) push(`${at} 含未知欄位「${k}」`);

                let host = null;
                const m = e.match;
                if (!m || typeof m !== 'object' || Array.isArray(m)) {
                    push(`${at}.match 必須是物件，且只含 host`);
                } else {
                    const keys = Object.keys(m);
                    if (keys.length !== 1 || keys[0] !== 'host') {
                        push(`${at}.match 只能有 host 一個欄位——被接管是整台主機的性質，不是單一頁面（目前：${keys.join('、') || '無'}）`);
                    } else {
                        host = checkExactHost(m.host, at, push);
                    }
                }
                if (host) {
                    if (seenHijacked.has(host)) push(`${at} 與前面的項目重複（${host}）`);
                    seenHijacked.add(host);
                    // 同一台主機既要壓低噪音又要標成被接管，是互相矛盾的宣告
                    if (seen.has(`host:${host}`)) {
                        push(`${at} 的主機 ${host} 同時出現在 entries 例外裡——不可以既壓低噪音又標為被接管`);
                    }
                }

                if (typeof e.reason !== 'string' || [...e.reason.trim()].length < MIN_REASON_CHARS) {
                    push(`${at}.reason 必須說明接管的情況，至少 ${MIN_REASON_CHARS} 字`);
                }
                if (typeof e.owner !== 'string' || !e.owner.trim()) push(`${at}.owner 必須指名負責重審的人`);
                if (typeof e.evidence !== 'string' || [...e.evidence.trim()].length < MIN_REASON_CHARS) {
                    push(`${at}.evidence 必須留下實際觀察到的證據（何時看到什麼），至少 ${MIN_REASON_CHARS} 字——到期時要比對的就是它`);
                }
                checkExpires(e.expires, at, todayISO, todayMs, push);

                if (host && errors.length === errorsBefore) hijacked.push({ ...e, _key: `hijacked:${host}` });
            });
        }
    }

    return { errors, entries, hijacked };
}

/**
 * 這個網址有沒有對應的有效例外？回傳該筆 entry 或 null。
 * 比對一律是「完全相等」——精確網址或精確主機名，不做前綴／子字串／萬用字元。
 */
export function matchPolicy(entries, url) {
    const normalized = normalizeUrl(url);
    let host = null;
    try {
        host = canonicalHost(new URL(url).hostname);
    } catch {
        host = null;
    }
    for (const e of entries) {
        if (e.match?.url !== undefined && normalizeUrl(e.match.url) === normalized) return e;
        if (e.match?.host !== undefined && host !== null && canonicalHost(e.match.host) === host) return e;
    }
    return null;
}

/**
 * 這個網址的主機有沒有被列為「已知被接管」？回傳該筆或 null。
 * 與 matchPolicy 一樣是完全相等比對——ieso-info.org 不會順帶涵蓋
 * evil.ieso-info.org，也不會涵蓋 ieso-info.org.tw。
 */
export function matchHijacked(hijacked, url) {
    let host = null;
    try {
        host = canonicalHost(new URL(url).hostname);
    } catch {
        return null;
    }
    for (const e of hijacked ?? []) {
        if (e.match?.host !== undefined && canonicalHost(e.match.host) === host) return e;
    }
    return null;
}
