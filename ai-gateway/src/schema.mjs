/**
 * JSON 任務的輸出規格：同一份 schema 既送給 WinLab 當 response_format（guided decoding
 * 從源頭保證結構），也在這裡再驗一次。只實作任務用得到的子集，不引入相依套件。
 *
 * 為什麼送了 json_schema 還要自己驗：
 *   - 輸出退化（例如吐了一大串空白）之後，generate.mjs 接下來的輪次都不帶 response_format，
 *     沒有 guided decoding 的保證；
 *   - 前端拿到的是可以直接 render 的物件，型別錯一個就是一個白畫面，閘道是最後一道關。
 *
 * 支援的關鍵字（2026-10-21 實測 WinLab 的 strict 模式全部接受，並確實限制輸出）：
 *   type（object／array／string／integer／number／boolean）、properties、required、
 *   additionalProperties: false、items、minItems、maxItems、minLength、maxLength、enum、pattern
 *
 * pattern 一律比對整個字串：guided decoding 本來就是整串比對，JS 的 test() 卻是找子字串。
 * 送給 WinLab 的與這裡驗證用的都包成 ^(?:原本的 pattern)$，兩邊一致；任務定義不必、
 * 也不該靠自己寫 ^ 與 $（^a|b$ 這種寫法看起來錨定了，其實只錨定了兩個分支的各一端）。
 */

const TYPES = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean']);
// 每個關鍵字只能用在哪一種 type 上（type、enum、description 哪裡都能用）
const KEYWORD_TYPES = {
    properties: 'object', required: 'object', additionalProperties: 'object',
    items: 'array', minItems: 'array', maxItems: 'array',
    minLength: 'string', maxLength: 'string', pattern: 'string',
};
const ANYWHERE = new Set(['type', 'enum', 'description']);
// enum 用 includes 比對：物件與陣列比的是參考，模型寫出來的永遠不會相等，每個回應都會被判錯
const ENUM_TYPES = new Set(['string', 'integer', 'number', 'boolean']);
// extractJson 最多試幾個 { 或 [ 起點
const MAX_CANDIDATES = 32;

const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * 包成整串比對的 pattern。作者自己寫的最外層 ^ 與（沒有跳脫的）$ 先拿掉再包，送出去的
 * 規格裡不會出現 ^(?:^…$)$ 這種巢狀的錨點，guided decoding 的 regex 引擎不一定接受。
 */
export function anchorPattern(pattern) {
    let inner = pattern.startsWith('^') ? pattern.slice(1) : pattern;
    // 結尾的 $ 前面有偶數個反斜線才是錨點；奇數個是跳脫過的字面 $
    const trailing = /(\\*)\$$/.exec(inner);
    if (trailing && trailing[1].length % 2 === 0) inner = inner.slice(0, -1);
    return `^(?:${inner})$`;
}

// 同一個 pattern 每次驗證都重新編譯沒有必要；pattern 只來自任務定義，數量有限
const compiled = new Map();
function patternRegExp(pattern) {
    let re = compiled.get(pattern);
    if (!re) {
        re = new RegExp(anchorPattern(pattern), 'u');
        compiled.set(pattern, re);
    }
    return re;
}

/**
 * 檢查 schema 本身寫得對、只用了支援的關鍵字。任務定義寫錯時在啟動（import）時就失敗，
 * 而不是等學生按下按鈕、每個請求都失敗才發現。
 */
export function assertSupportedSchema(schema, path = '$') {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${path}：schema 必須是物件`);
    if (!TYPES.has(schema.type)) throw new Error(`${path}：type 必須是 ${[...TYPES].join('／')} 之一`);
    for (const key of Object.keys(schema)) {
        if (ANYWHERE.has(key)) continue;
        if (!Object.hasOwn(KEYWORD_TYPES, key)) throw new Error(`${path}：不支援的 schema 關鍵字 ${key}`);
        if (KEYWORD_TYPES[key] !== schema.type) throw new Error(`${path}：${key} 不能用在 type ${schema.type}`);
    }
    if (schema.description !== undefined && typeof schema.description !== 'string') throw new Error(`${path}：description 必須是字串`);

    if (schema.type === 'object') {
        if (schema.additionalProperties !== false) {
            throw new Error(`${path}：object 必須寫 additionalProperties: false（strict 模式的要求）`);
        }
        const properties = schema.properties;
        if (!properties || typeof properties !== 'object' || Array.isArray(properties)) throw new Error(`${path}：object 必須有 properties`);
        if (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === 'string')) {
            throw new Error(`${path}：required 必須是字串陣列`);
        }
        const props = Object.keys(properties);
        // strict 模式要求每個屬性都列在 required；少列的欄位模型可以不寫，前端就會拿到 undefined。
        // 反過來，required 列了不存在的屬性，每個回應都會被判成缺欄位
        for (const p of props) {
            if (!schema.required.includes(p)) throw new Error(`${path}.${p}：strict 模式下每個屬性都要列在 required`);
        }
        for (const key of schema.required) {
            if (!Object.hasOwn(properties, key)) throw new Error(`${path}：required 的 ${key} 不在 properties 裡`);
        }
        for (const p of props) assertSupportedSchema(properties[p], `${path}.${p}`);
    }
    if (schema.type === 'array') {
        assertSupportedSchema(schema.items, `${path}[]`);
        assertRange(schema.minItems, schema.maxItems, `${path}：minItems／maxItems`);
    }
    if (schema.type === 'string') {
        assertRange(schema.minLength, schema.maxLength, `${path}：minLength／maxLength`);
        if (schema.pattern !== undefined) {
            if (typeof schema.pattern !== 'string') throw new Error(`${path}：pattern 必須是字串`);
            try {
                patternRegExp(schema.pattern);
            } catch (err) {
                throw new Error(`${path}：pattern 不是合法的正規表示式（${err.message}）`);
            }
        }
    }
    if (schema.enum !== undefined) {
        if (!ENUM_TYPES.has(schema.type)) throw new Error(`${path}：enum 只能用在 ${[...ENUM_TYPES].join('／')}`);
        if (!Array.isArray(schema.enum) || schema.enum.length === 0) throw new Error(`${path}：enum 必須是非空陣列`);
        for (const value of schema.enum) {
            const problem = validate({ ...schema, enum: undefined }, value, `${path}.enum`);
            if (problem) throw new Error(`${path}：enum 的值不符合自己的規格（${problem}）`);
        }
    }
}

function assertRange(min, max, label) {
    if (min !== undefined && !isCount(min)) throw new Error(`${label} 必須是非負整數`);
    if (max !== undefined && !isCount(max)) throw new Error(`${label} 必須是非負整數`);
    if (min !== undefined && max !== undefined && min > max) throw new Error(`${label} 下限大於上限`);
}

function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (Number.isInteger(value)) return 'integer';
    return typeof value;
}

/**
 * 驗證 value 是否符合 schema。回傳第一個錯誤的描述，符合就回傳 null。
 * 字串長度以 code point 計（JSON Schema 的定義，也是 guided decoding 的算法）。
 * 錯誤描述會進 log：只寫路徑與規格，不寫值；多出來的屬性名稱是模型寫的，也不寫。
 */
export function validate(schema, value, path = '$') {
    const actual = typeOf(value);
    const expected = schema.type;
    const typeOk = expected === 'number' ? (actual === 'integer' || actual === 'number') : actual === expected;
    if (!typeOk) return `${path} 應為 ${expected}，實際是 ${actual}`;
    // JSON.parse('1e400') 是 Infinity，傳到瀏覽器變成 null；超過安全範圍的整數會無聲地失去精度
    if (expected === 'number' && !Number.isFinite(value)) return `${path} 不是有限的數字`;
    if (expected === 'integer' && !Number.isSafeInteger(value)) return `${path} 超出安全整數範圍`;

    if (schema.enum && !schema.enum.includes(value)) return `${path} 不在允許的值之中`;

    if (expected === 'string') {
        const length = [...value].length;
        if (schema.minLength !== undefined && length < schema.minLength) return `${path} 太短（${length} < ${schema.minLength}）`;
        if (schema.maxLength !== undefined && length > schema.maxLength) return `${path} 太長（${length} > ${schema.maxLength}）`;
        if (schema.pattern !== undefined && !patternRegExp(schema.pattern).test(value)) return `${path} 格式不符`;
        // 只有空白的字串對學生來說跟沒有一樣
        if (schema.minLength >= 1 && !value.trim()) return `${path} 只有空白`;
    }

    if (expected === 'array') {
        if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} 項目太少（${value.length} < ${schema.minItems}）`;
        if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} 項目太多（${value.length} > ${schema.maxItems}）`;
        for (let i = 0; i < value.length; i++) {
            const err = validate(schema.items, value[i], `${path}[${i}]`);
            if (err) return err;
        }
    }

    if (expected === 'object') {
        const props = schema.properties || {};
        for (const key of schema.required || []) {
            if (!Object.hasOwn(value, key)) return `${path}.${key} 缺少`;
        }
        for (const key of Object.keys(value)) {
            if (!Object.hasOwn(props, key)) return `${path} 有規格外的屬性`;
            const err = validate(props[key], value[key], `${path}.${key}`);
            if (err) return err;
        }
    }
    return null;
}

// 送出去的 schema 裡每個 pattern 都換成整串比對的寫法（不改動任務定義本身）
function withAnchoredPatterns(schema) {
    const copy = { ...schema };
    if (typeof copy.pattern === 'string') copy.pattern = anchorPattern(copy.pattern);
    if (copy.properties) {
        copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([key, sub]) => [key, withAnchoredPatterns(sub)]));
    }
    if (copy.items) copy.items = withAnchoredPatterns(copy.items);
    return copy;
}

/** 組成送給 WinLab 的 response_format */
export function toResponseFormat(name, schema) {
    return { type: 'json_schema', json_schema: { name, strict: true, schema: withAnchoredPatterns(schema) } };
}

/** 解析得了、卻不符合 schema 或 check。problem 只有路徑與規格（見 validate），可以進 log */
export class SchemaMismatch extends Error {
    constructor(problem) {
        super(problem);
        this.name = 'SchemaMismatch';
        this.problem = problem;
    }
}

// 從 start（必須是 { 或 [）往後找出配對的結尾，略過字串裡的括號與跳脫字元；找不到回傳 -1
function matchingEnd(text, start) {
    const stack = [];
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') i++;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{' || ch === '[') {
            stack.push(ch === '{' ? '}' : ']');
        } else if (ch === '}' || ch === ']') {
            if (stack.pop() !== ch) return -1;
            if (stack.length === 0) return i;
        }
    }
    return -1;
}

/**
 * 從模型的正文取出 JSON。guided decoding 下正文就是純 JSON；保險起見仍容忍前後的
 * ``` 標記或說明文字：先試整段，再從每個 { 或 [ 起點（最多 MAX_CANDIDATES 個）找配對的
 * 結尾，回傳第一個「解析得了、而且符合 schema」的候選。
 *
 * 由 schema 把關，而不是由位置：前面說明文字裡的一個 [ 配上引號，可能把後面真正的答案
 * 整段吞進一個壞掉的候選；反過來，壞掉的物件裡的片段（例如其中一個陣列）也不會被當成
 * 答案，因為它不符合 schema。沒給 schema 時回傳第一個解析得了的候選（只給測試與除錯用）。
 * check(value) 檢查 schema 表達不了的規則，有 schema 時在 schema 通過之後才呼叫。它回傳 null
 * 才算通過，其他回傳值都是問題描述；不通過的候選同樣跳過。
 *
 * 都不行時，丟出「最前面那個候選」的錯誤，它最可能就是模型想寫的答案。解析不了是
 * SyntaxError（訊息可能含有正文片段，呼叫端只能拿它的種類去記 log），解析得了卻不符合
 * schema 或 check 是 SchemaMismatch。check 丟出的例外是程式錯誤，照樣往外丟。
 */
export function extractJson(text, schema, { check } = {}) {
    const trimmed = String(text).trim();
    const problemOf = (value) => (schema ? validate(schema, value) : null) ?? (check ? check(value) : null);
    let parseError;
    let firstError;
    let whole;
    let parsed = false;
    // try 只包住 JSON.parse，check 丟出的例外才不會被當成解析不了
    try {
        whole = JSON.parse(trimmed);
        parsed = true;
    } catch (err) {
        parseError = err;
    }
    if (parsed) {
        const problem = problemOf(whole);
        if (problem === null) return whole;
        firstError = new SchemaMismatch(problem);
    }
    const starts = /[{[]/g;
    for (let tries = 0; tries < MAX_CANDIDATES; tries++) {
        const match = starts.exec(trimmed);
        if (!match) break;
        const at = match.index;
        const end = matchingEnd(trimmed, at);
        // 配對不起來（只有開頭）：不是候選
        if (end === -1) continue;
        // 跟整段相同：上面試過了。整段解析不了的話，這個最前面的候選的錯誤就是那個 SyntaxError
        if (at === 0 && end === trimmed.length - 1) {
            firstError ??= parseError;
            continue;
        }
        let value;
        try {
            value = JSON.parse(trimmed.slice(at, end + 1));
        } catch (err) {
            firstError ??= err;
            continue;
        }
        const problem = problemOf(value);
        if (problem === null) return value;
        firstError ??= new SchemaMismatch(problem);
    }
    throw firstError ?? parseError;
}
