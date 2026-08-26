/**
 * 108 課綱核心素養與 SDGs 的共用驗證（ESM 側）
 * --------------------------------------------------------------
 * 代碼與中文標籤的唯一來源是 scripts/taxonomy.json；本檔只負責「怎麼驗」。
 * build-search-index.js 是 CommonJS，沒辦法 import 這支，因此它自己讀同一份
 * JSON——共用的是資料而不是程式碼，這是 CJS／ESM 並存下唯一不會漂移的作法。
 *
 * 驗證政策（沿用 #82 validateSchedule 立下的先例）：
 *   選填，但填了就必須合法且自洽。非法值一律在 CI 擋下，不做「靜默略過」——
 *   一個被靜默丟掉的 SDG 標籤，症狀是「搜尋找不到東西」而不是「建置失敗」，
 *   而那種症狀沒有人會回報。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TAXONOMY_PATH = fileURLToPath(new URL('./taxonomy.json', import.meta.url));

/** @type {{competencies: Record<string,{label:string,domain:string}>, sdgs: Record<string,string>}} */
export const TAXONOMY = JSON.parse(readFileSync(TAXONOMY_PATH, 'utf8'));

export const COMPETENCY_CODES = new Set(Object.keys(TAXONOMY.competencies));
export const SDG_NUMBERS = new Set(Object.keys(TAXONOMY.sdgs).map(Number));

/** 搜尋索引裡的 SDG 一律寫成 "SDG11" 這種字串形式（見 issue #14 的 schema 提案）。 */
export const SDG_TAG_RE = /^SDG(\d{1,2})$/;

export const competencyLabel = (code) => {
    const entry = TAXONOMY.competencies[code];
    return entry ? `${code} ${entry.label}` : null;
};
export const competencyDomain = (code) => TAXONOMY.competencies[code]?.domain ?? null;
/** 與 civic-tech-map 頁面上的標籤同字串（"SDG 11 永續城鄉"，SDG 與數字之間有空白）。 */
export const sdgLabel = (n) => (TAXONOMY.sdgs[String(n)] ? `SDG ${n} ${TAXONOMY.sdgs[String(n)]}` : null);

/**
 * 驗證來源資料上的 competencies / sdgs / tags 三個分類欄位。
 *
 * @param {Record<string, unknown>} item      待驗證的項目
 * @param {string} label                      出錯訊息裡用來指認項目的名稱
 * @param {string[]} errors                   錯誤累加陣列（就地 push）
 * @param {{requireCompetencies?: boolean, requireSdgs?: boolean}} [opts]
 *        某些資料集（如公民科技專案）把素養視為必填，其餘資料集則為選填。
 */
export function validateTaxonomyFields(item, label, errors, opts = {}) {
    const { requireCompetencies = false, requireSdgs = false } = opts;

    // ── competencies：字串陣列，每項須為 A1-A3 / B1-B3 / C1-C3，且不得重複 ──
    if (item.competencies === undefined) {
        if (requireCompetencies) errors.push(`「${label}」缺少欄位：competencies`);
    } else if (!Array.isArray(item.competencies)) {
        errors.push(`「${label}」的 competencies 必須是陣列`);
    } else {
        if (requireCompetencies && item.competencies.length === 0) {
            errors.push(`「${label}」的 competencies 至少需要一個核心素養代碼`);
        }
        const seen = new Set();
        for (const c of item.competencies) {
            if (typeof c !== 'string' || !COMPETENCY_CODES.has(c)) {
                errors.push(
                    `「${label}」的 competencies「${c}」不是合法的核心素養代碼（須為 ${[...COMPETENCY_CODES].join('、')}）`,
                );
                continue;
            }
            if (seen.has(c)) errors.push(`「${label}」的 competencies「${c}」重複出現`);
            seen.add(c);
        }
    }

    // ── sdgs：整數陣列，每項須為 1-17，且不得重複（允許空陣列＝無對應 SDG）──
    if (item.sdgs === undefined) {
        if (requireSdgs) errors.push(`「${label}」缺少欄位：sdgs`);
    } else if (!Array.isArray(item.sdgs)) {
        errors.push(`「${label}」的 sdgs 必須是陣列`);
    } else {
        const seen = new Set();
        for (const n of item.sdgs) {
            if (typeof n !== 'number' || !Number.isInteger(n) || !SDG_NUMBERS.has(n)) {
                errors.push(`「${label}」的 sdgs「${n}」不是合法的 SDG 編號（須為 1-17 的整數）`);
                continue;
            }
            if (seen.has(n)) errors.push(`「${label}」的 sdgs「${n}」重複出現`);
            seen.add(n);
        }
    }

    // ── tags：議題關鍵字（如「環保」「假訊息」）。選填，但填了就必須是非空字串陣列。
    //    這是使用者實際會打進搜尋框的字，空字串或非字串進到索引只會變成一顆空白標籤。
    if (item.tags !== undefined) {
        if (!Array.isArray(item.tags)) {
            errors.push(`「${label}」的 tags 必須是陣列`);
        } else {
            const seen = new Set();
            for (const t of item.tags) {
                if (typeof t !== 'string' || t.trim() === '') {
                    errors.push(`「${label}」的 tags「${t}」必須是非空字串`);
                    continue;
                }
                if (t !== t.trim()) errors.push(`「${label}」的 tags「${t}」前後有多餘空白`);
                if (seen.has(t)) errors.push(`「${label}」的 tags「${t}」重複出現`);
                seen.add(t);
            }
        }
    }
}

/**
 * 驗證「建置產物」search-index.json 裡的分類欄位。
 * 與來源資料的差別：SDG 在索引裡已展開成 "SDG11" 字串，素養仍是代碼。
 */
export function validateIndexedTaxonomy(item, label, errors) {
    for (const field of ['competencies', 'sdgs', 'taxonomy']) {
        if (item[field] !== undefined && !Array.isArray(item[field])) {
            errors.push(`${label} 的 ${field} 必須是陣列`);
        }
    }
    if (Array.isArray(item.competencies)) {
        for (const c of item.competencies) {
            if (typeof c !== 'string' || !COMPETENCY_CODES.has(c)) {
                errors.push(`${label} 的 competencies「${c}」不是合法的核心素養代碼`);
            }
        }
    }
    if (Array.isArray(item.sdgs)) {
        for (const s of item.sdgs) {
            const m = typeof s === 'string' ? SDG_TAG_RE.exec(s) : null;
            if (!m || !SDG_NUMBERS.has(Number(m[1]))) {
                errors.push(`${label} 的 sdgs「${s}」不是合法的 SDG 標籤（須為 SDG1 到 SDG17）`);
            }
        }
    }
    if (Array.isArray(item.taxonomy)) {
        for (const t of item.taxonomy) {
            if (typeof t !== 'string' || t.trim() === '') {
                errors.push(`${label} 的 taxonomy「${t}」必須是非空字串`);
            }
        }
    }

    // 代碼有、中文標籤卻沒有＝使用者打「系統思考」「永續城鄉」會搜不到。這是本次
    // 改動要提供的能力本身，所以它必須是建置產物上「可被檢查的契約」，而不是
    // 「相信 build-search-index.js 有做」。少了標籤時建置產物照樣長得很正常，
    // 沒有這一條就完全看不出來。
    const taxonomy = Array.isArray(item.taxonomy) ? item.taxonomy : [];
    if (Array.isArray(item.competencies)) {
        for (const c of item.competencies) {
            const expected = competencyLabel(c);
            if (expected && !taxonomy.includes(expected)) {
                errors.push(`${label} 有素養代碼「${c}」，taxonomy 卻缺少對應的中文標籤「${expected}」`);
            }
        }
    }
    if (Array.isArray(item.sdgs)) {
        for (const s of item.sdgs) {
            const m = typeof s === 'string' ? SDG_TAG_RE.exec(s) : null;
            const expected = m ? sdgLabel(Number(m[1])) : null;
            if (expected && !taxonomy.includes(expected)) {
                errors.push(`${label} 有 SDG 標籤「${s}」，taxonomy 卻缺少對應的中文標籤「${expected}」`);
            }
        }
    }
}
