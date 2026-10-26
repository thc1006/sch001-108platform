/**
 * JSON 任務的輸出規格：schema 本身的啟動檢查、輸出驗證、從正文取出 JSON。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertSupportedSchema, validate, extractJson, toResponseFormat, anchorPattern, SchemaMismatch, schemaPath } from '../src/schema.mjs';

const listSchema = {
    type: 'object',
    properties: {
        title: { type: 'string', minLength: 1, maxLength: 5 },
        items: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 2, maxItems: 3 },
    },
    required: ['title', 'items'],
    additionalProperties: false,
};

test('assertSupportedSchema：寫對的 schema 通過（含巢狀、enum、錨定的 pattern）', () => {
    assert.doesNotThrow(() => assertSupportedSchema(listSchema));
    assert.doesNotThrow(() => assertSupportedSchema({
        type: 'object',
        description: '巢狀',
        properties: {
            level: { type: 'string', enum: ['低', '中', '高'], maxLength: 1 },
            code: { type: 'string', pattern: '^[A-Z]{2}$' },
            score: { type: 'integer', enum: [1, 2, 3] },
            ratio: { type: 'number' },
            ok: { type: 'boolean' },
            inner: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
        },
        required: ['level', 'code', 'score', 'ratio', 'ok', 'inner'],
        additionalProperties: false,
    }));
});

test('assertSupportedSchema：type 缺少或拼錯、關鍵字不支援或用錯 type，啟動時就失敗', () => {
    const cases = [
        [null, /必須是物件/],
        [[], /必須是物件/],
        [{}, /type 必須是/],
        [{ type: 'strng' }, /type 必須是/],
        [{ type: 'string', format: 'email' }, /不支援的 schema 關鍵字 format/],
        [{ type: 'number', minLength: 1 }, /minLength 不能用在 type number/],
        [{ type: 'object', items: { type: 'string' }, properties: {}, required: [], additionalProperties: false }, /items 不能用在 type object/],
        [{ type: 'string', description: 3 }, /description 必須是字串/],
    ];
    for (const [schema, pattern] of cases) assert.throws(() => assertSupportedSchema(schema), pattern, JSON.stringify(schema));
});

test('assertSupportedSchema：object 的 additionalProperties、properties、required 必須完全對得上', () => {
    const prop = { a: { type: 'string' } };
    const cases = [
        [{ type: 'object', properties: prop, required: ['a'] }, /additionalProperties/],
        [{ type: 'object', required: [], additionalProperties: false }, /必須有 properties/],
        [{ type: 'object', properties: [], required: [], additionalProperties: false }, /必須有 properties/],
        [{ type: 'object', properties: prop, required: 'a', additionalProperties: false }, /required 必須是字串陣列/],
        [{ type: 'object', properties: prop, required: [1], additionalProperties: false }, /required 必須是字串陣列/],
        [{ type: 'object', properties: prop, required: [], additionalProperties: false }, /\$\.a：strict 模式下每個屬性都要列在 required/],
        [{ type: 'object', properties: prop, required: ['a', 'b'], additionalProperties: false }, /required 的 b 不在 properties 裡/],
        // 錯誤出在巢狀的地方時，訊息要指出路徑
        [{ type: 'object', properties: { a: { type: 'array', items: { type: 'nope' } } }, required: ['a'], additionalProperties: false }, /\$\.a\[\]：type 必須是/],
        [{ type: 'array' }, /\$\[\]：schema 必須是物件/],
    ];
    for (const [schema, pattern] of cases) assert.throws(() => assertSupportedSchema(schema), pattern, JSON.stringify(schema));
});

test('assertSupportedSchema：上下限必須是非負整數且下限不大於上限', () => {
    const cases = [
        { type: 'string', minLength: -1 },
        { type: 'string', maxLength: 2.5 },
        { type: 'string', minLength: 3, maxLength: 2 },
        { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 3 },
        { type: 'array', items: { type: 'string' }, maxItems: '3' },
    ];
    for (const schema of cases) assert.throws(() => assertSupportedSchema(schema), /minLength|minItems/, JSON.stringify(schema));
    assert.doesNotThrow(() => assertSupportedSchema({ type: 'string', minLength: 2, maxLength: 2 }));
});

test('assertSupportedSchema：pattern 必須是字串、包成整串比對後編譯得過（u 模式）', () => {
    assert.throws(() => assertSupportedSchema({ type: 'string', pattern: 5 }), /pattern 必須是字串/);
    assert.throws(() => assertSupportedSchema({ type: 'string', pattern: '^([A-Z]$' }), /不是合法的正規表示式/);
    // 'u' 模式下才不合法的寫法也要擋（驗證時用的就是 'u'）
    assert.throws(() => assertSupportedSchema({ type: 'string', pattern: '^\\-$' }), /不是合法的正規表示式/);
    // 不必自己寫 ^ 與 $：一律整串比對
    assert.doesNotThrow(() => assertSupportedSchema({ type: 'string', pattern: '[A-Z]+' }));
});

// guided decoding 是整串比對，JS 的 test() 是找子字串；^a|b$ 看起來錨定了，其實只錨定了兩個分支的各一端
test('pattern 一律整串比對：沒錨定、只錨定一端、分支各錨一端、結尾是跳脫的 $，都照整串比對', () => {
    const cases = [
        ['[A-Z]{2}', 'AB', 'ABC'],
        ['^[A-Z]{2}', 'AB', 'AB 後面接任何內容'],
        ['^[A-Z]{2}|[0-9]{3}$', '123', 'AB 然後是任何內容<script>'],
        ['^ok\\$', 'ok$', 'ok$ 後面接任何內容'],
    ];
    for (const [pattern, good, bad] of cases) {
        const schema = { type: 'string', pattern };
        assert.doesNotThrow(() => assertSupportedSchema(schema), pattern);
        assert.equal(validate(schema, good), null, `${pattern} 應該接受 ${good}`);
        assert.match(validate(schema, bad), /格式不符/, `${pattern} 不該接受 ${bad}`);
    }
    // 作者寫的最外層 ^ 與沒有跳脫的 $ 拿掉再包，送出去的不會有巢狀的錨點；跳脫過的 $ 是字面的 $
    assert.equal(anchorPattern('^[A-Z]{2}$'), '^(?:[A-Z]{2})$');
    assert.equal(anchorPattern('a|b'), '^(?:a|b)$');
    assert.equal(anchorPattern('^ok\\$'), '^(?:ok\\$)$');
    assert.equal(anchorPattern('^x\\\\$'), '^(?:x\\\\)$');
});

test('toResponseFormat：送給 WinLab 的每個 pattern（含巢狀）都換成整串比對的寫法，任務定義本身不變', () => {
    const schema = {
        type: 'object',
        properties: {
            code: { type: 'string', pattern: '[A-Z]{2}' },
            tags: { type: 'array', items: { type: 'string', pattern: '^#\\w+$' } },
            plain: { type: 'string' },
        },
        required: ['code', 'tags', 'plain'],
        additionalProperties: false,
    };
    const sent = toResponseFormat('x', schema).json_schema.schema;
    assert.equal(sent.properties.code.pattern, '^(?:[A-Z]{2})$');
    assert.equal(sent.properties.tags.items.pattern, '^(?:#\\w+)$');
    assert.equal(sent.properties.plain.pattern, undefined);
    assert.equal(schema.properties.code.pattern, '[A-Z]{2}', '原本的定義沒有被改掉');
});

test('assertSupportedSchema：enum 必須是非空陣列，而且每個值都符合自己的規格', () => {
    const cases = [
        [{ type: 'string', enum: [] }, /enum 必須是非空陣列/],
        [{ type: 'string', enum: 'a' }, /enum 必須是非空陣列/],
        [{ type: 'string', enum: ['a', 1] }, /enum 的值不符合自己的規格/],
        [{ type: 'integer', enum: [1, 2.5] }, /enum 的值不符合自己的規格/],
        [{ type: 'string', maxLength: 2, enum: ['ab', 'abc'] }, /enum 的值不符合自己的規格/],
        [{ type: 'string', pattern: '^[a-z]+$', enum: ['ok', 'NO'] }, /enum 的值不符合自己的規格/],
        // includes 比對物件與陣列比的是參考，模型寫出來的永遠不會相等
        [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false, enum: [{ a: 'x' }] }, /enum 只能用在/],
        [{ type: 'array', items: { type: 'string' }, enum: [['a']] }, /enum 只能用在/],
    ];
    for (const [schema, pattern] of cases) assert.throws(() => assertSupportedSchema(schema), pattern, JSON.stringify(schema));
});

test('validate：型別、缺少與多出的屬性，並指出路徑', () => {
    assert.equal(validate(listSchema, { title: 't', items: ['a', 'b'] }), null);
    assert.match(validate(listSchema, { title: 1, items: ['a', 'b'] }), /\$\.title 應為 string，實際是 integer/);
    assert.match(validate(listSchema, { title: 't' }), /\$\.items 缺少/);
    assert.match(validate(listSchema, ['not', 'object']), /\$ 應為 object，實際是 array/);
    assert.match(validate(listSchema, null), /\$ 應為 object，實際是 null/);
    assert.equal(validate({ type: 'number' }, 3), null, 'integer 也是 number');
    assert.match(validate({ type: 'integer' }, 3.5), /應為 integer/);
    assert.match(validate({ type: 'boolean' }, 'true'), /應為 boolean/);
});

// 多出來的屬性名稱是模型寫的，可能複述學生的輸入；驗證錯誤會進 log，所以不寫名稱
test('validate：多出的屬性只說「有規格外的屬性」，不把屬性名稱寫進錯誤', () => {
    const problem = validate(listSchema, { title: 't', items: ['a', 'b'], 學生王小明身分證A123456789: 1 });
    assert.equal(problem, '$ 有規格外的屬性');
});

test('validate：required 用自己的屬性判斷，不吃原型鏈上的同名屬性', () => {
    const schema = { type: 'object', properties: { toString: { type: 'string' } }, required: ['toString'], additionalProperties: false };
    assert.match(validate(schema, {}), /\$\.toString 缺少/);
});

test('validate：巢狀物件的屬性也會逐層檢查', () => {
    const schema = {
        type: 'object',
        properties: { inner: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false } },
        required: ['inner'],
        additionalProperties: false,
    };
    assert.equal(validate(schema, { inner: { n: 1 } }), null);
    assert.match(validate(schema, { inner: { n: 'x' } }), /\$\.inner\.n 應為 integer/);
});

test('validate：字數與項目數的上下限都含邊界（剛好等於上限是合法的）', () => {
    assert.equal(validate({ type: 'string', maxLength: 2 }, '😀😀'), null);
    assert.match(validate({ type: 'string', maxLength: 2 }, '😀😀😀'), /太長（3 > 2）/);
    assert.equal(validate({ type: 'string', minLength: 2 }, '甲乙'), null);
    assert.match(validate({ type: 'string', minLength: 2 }, '甲'), /太短（1 < 2）/);
    assert.equal(validate(listSchema.properties.items, ['a', 'b', 'c']), null);
    assert.match(validate(listSchema.properties.items, ['a', 'b', 'c', 'd']), /項目太多（4 > 3）/);
    assert.match(validate(listSchema.properties.items, ['a']), /項目太少（1 < 2）/);
    assert.match(validate(listSchema.properties.items, ['a', '']), /\$\[1\] 太短/);
    assert.match(validate({ type: 'string', minLength: 1 }, '  '), /只有空白/);
});

// trim() 不去掉零寬空白（U+200B）、WORD JOINER（U+2060）這類格式字元。哪些字看得見由 visible-text.mjs
// 判斷，逐字的情況在它自己的測試；這裡確認 validate 用的是它
test('validate：必填字串只有空白或看不見的字元都不收；夾著格式字元的字、表情符號組合照收', () => {
    const required = { type: 'string', minLength: 1 };
    const blanks = ['\u200B', '\u200B\uFEFF \n', '\u2060', '\u00AD\u3164\u0085', '\u2800\uFFFC\u3000', '\u0301', '\uE000'];
    for (const blank of blanks) assert.match(validate(required, blank), /\$ 只有空白或看不見的字元/, JSON.stringify(blank));
    for (const text of ['a\u200Bb', '👩\u200D💻', '❤\uFE0F', '\u200B答\u200B']) assert.equal(validate(required, text), null, JSON.stringify(text));
    // 沒有下限、或下限是 0 的字串不檢查
    assert.equal(validate({ type: 'string' }, '\u200B'), null);
    assert.equal(validate({ type: 'string', minLength: 0 }, '\u200B'), null);
});

test('validate：enum（字串與數字都檢查）、pattern 以 u 模式比對', () => {
    assert.match(validate({ type: 'string', enum: ['S', 'T'] }, 'X'), /不在允許的值/);
    assert.match(validate({ type: 'integer', enum: [1, 2] }, 3), /不在允許的值/);
    assert.equal(validate({ type: 'integer', enum: [1, 2] }, 2), null);
    assert.match(validate({ type: 'string', pattern: '^[A-Z]$' }, 'ab'), /格式不符/);
    // \p{L} 只有在 u 模式下才是「任何字母」
    assert.equal(validate({ type: 'string', pattern: '^\\p{L}+$' }, '學習abc'), null);
});

test('validate：Infinity（JSON 的 1e400）與超出安全範圍的整數都不收', () => {
    assert.match(validate({ type: 'number' }, JSON.parse('1e400')), /不是有限的數字/);
    assert.match(validate({ type: 'number' }, -Infinity), /不是有限的數字/);
    assert.match(validate({ type: 'integer' }, JSON.parse('12345678901234567890')), /超出安全整數範圍/);
    assert.equal(validate({ type: 'integer' }, Number.MAX_SAFE_INTEGER), null);
});

test('extractJson：純 JSON、包在 ``` 裡、前後夾說明文字都取得出來', () => {
    assert.deepEqual(extractJson(' {"a":1} '), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('以下是結果：{"a":{"b":2}} 希望有幫助'), { a: { b: 2 } });
    assert.deepEqual(extractJson('```json\n[1, 2]\n```'), [1, 2]);
});

test('extractJson：後面的說明含有 }、字串裡有括號、第一個括號不是 JSON，都仍然取得出來', () => {
    assert.deepEqual(extractJson('{"a":1} 備註：用 } 結尾'), { a: 1 });
    assert.deepEqual(extractJson('結果 {"a":"}{\\"]"} 完'), { a: '}{"]' });
    assert.deepEqual(extractJson('[說明] 結果：{"a":1}'), { a: 1 });
});

test('extractJson：傳入 schema 時，外層壞掉也不會撿裡面不符規格的片段當答案（丟出外層的 SyntaxError）', () => {
    assert.throws(() => extractJson('{"title": 我的病史, "items": []}', listSchema), SyntaxError);
    // 前面的雜訊沒配對起來（只有開頭），後面完整的那一段仍然取得到
    assert.deepEqual(extractJson('a { b {"a":1}'), { a: 1 });
});

test('extractJson：前面說明文字裡的 [ 配上引號吞不掉後面真正的答案（由 schema 把關，不是由位置）', () => {
    const answer = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    assert.deepEqual(extractJson('前言 [見 "附錄] {"answer":"好"} 後記 "]', answer), { answer: '好' });
    // 先出現、也解析得了，但不符合規格的候選會被跳過
    assert.deepEqual(extractJson('草稿 {"answer": 1} 定稿 {"answer":"好"}', answer), { answer: '好' });
});

test('extractJson：都不符合時丟出最前面那個候選的錯誤；不符規格是 SchemaMismatch（只有路徑與規格）', () => {
    assert.throws(() => extractJson('{"title":"t","items":["a"]}', listSchema), (err) => {
        assert.ok(err instanceof SchemaMismatch);
        assert.match(err.problem, /\$\.items 項目太少/);
        return true;
    });
    assert.throws(() => extractJson('以下是結果：{"title":"t","items":["a"]}', listSchema), (err) => err instanceof SchemaMismatch);
    assert.throws(() => extractJson('null', listSchema), (err) => err instanceof SchemaMismatch && /實際是 null/.test(err.problem));
    assert.throws(() => extractJson('完全沒有 JSON', listSchema), SyntaxError);
});

test('extractJson：check 在 schema 通過後才呼叫；它不通過的候選跳過，都不通過時丟出它的描述', () => {
    const answer = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    const seen = [];
    const check = (value) => {
        seen.push(value.answer);
        return value.answer === '好' ? null : '$.answer 應為 好';
    };
    assert.deepEqual(extractJson('草稿 {"answer": 1} {"answer":"壞"} 定稿 {"answer":"好"}', answer, { check }), { answer: '好' });
    assert.deepEqual(seen, ['壞', '好'], '不符 schema 的候選不交給 check');
    assert.throws(() => extractJson('{"answer":"壞"}', answer, { check }), (err) => {
        assert.ok(err instanceof SchemaMismatch);
        assert.equal(err.problem, '$.answer 應為 好');
        return true;
    });
    // 只有 null 算通過：check 寫錯、回傳空字串或忘了回傳時不會默默放行（整段與候選兩條路都是）
    for (const text of ['{"answer":"好"}', '前言 {"answer":"好"}']) {
        for (const result of ['', undefined]) {
            assert.throws(() => extractJson(text, answer, { check: () => result }), SchemaMismatch, `${text}：${result}`);
        }
    }
});

test('SchemaMismatch：來源（schema 或 check）、規則的代號與路徑，路徑只有規格裡的名稱與索引', () => {
    const schema = {
        type: 'object',
        properties: {
            title: { type: 'string', minLength: 1, maxLength: 5, pattern: '[^x]*' },
            kind: { type: 'string', enum: ['a', 'b'] },
            n: { type: 'number' },
            k: { type: 'integer' },
            items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
        },
        required: ['title', 'kind', 'n', 'k', 'items'],
        additionalProperties: false,
    };
    const ok = { title: 't', kind: 'a', n: 1, k: 1, items: ['a', 'b'] };
    const cases = [
        [{ ...ok, title: 1 }, '$.title', 'type'],
        [{ ...ok, title: '' }, '$.title', 'min_length'],
        [{ ...ok, title: '一二三四五六' }, '$.title', 'max_length'],
        [{ ...ok, title: 'x' }, '$.title', 'pattern'],
        [{ ...ok, title: ' ' }, '$.title', 'blank'],
        [{ ...ok, kind: 'c' }, '$.kind', 'enum'],
        [{ ...ok, k: 2 ** 60 }, '$.k', 'safe_integer'],
        [{ ...ok, items: ['a'] }, '$.items', 'min_items'],
        [{ ...ok, items: ['a', 'b', 'c', 'd'] }, '$.items', 'max_items'],
        [{ ...ok, items: ['a', 2] }, '$.items[1]', 'type'],
        [{ title: 't', kind: 'a', n: 1, k: 1 }, '$.items', 'required'],
        [{ ...ok, 學生王小明: 1 }, '$', 'additional'],
    ];
    for (const [value, path, rule] of cases) {
        assert.throws(() => extractJson(JSON.stringify(value), schema), (err) => {
            assert.ok(err instanceof SchemaMismatch);
            assert.deepEqual([err.source, err.path, err.rule], ['schema', path, rule], err.problem);
            return true;
        }, rule);
    }
    assert.throws(() => extractJson('{"title":"t","kind":"a","n":1e400,"k":1,"items":["a","b"]}', schema), { source: 'schema', path: '$.n', rule: 'finite' });
    // check 的描述開頭若是規格裡的路徑就記下路徑，其他一律不收；描述本身照舊放在 problem
    for (const [problem, path] of [
        ['$.items[1] 不能跟前一項相同', '$.items[1]'],
        ['$.title 應為 好，實際是 模型寫的內容', '$.title'],
        ['$.學生王小明 不對', undefined],
        ['$.titlex 不對', undefined],
        ['$.title.length 不對', undefined],
        ['模型寫的內容 $.title', undefined],
    ]) {
        assert.throws(() => extractJson(JSON.stringify(ok), schema, { check: () => problem }), (err) => {
            assert.deepEqual([err.source, err.path, err.rule, err.problem], ['check', path, 'check', problem]);
            return true;
        }, problem);
    }
});

test('schemaPath：路徑的每一段都要是規格裡的屬性名稱或陣列索引，否則回傳 undefined', () => {
    const schema = {
        type: 'object',
        properties: {
            '數據': { type: 'string' },
            'a.b': { type: 'string' },
            plan: { type: 'array', maxItems: 4, items: { type: 'object', properties: { week: { type: 'string' } }, required: ['week'], additionalProperties: false } },
        },
        required: ['數據', 'a.b', 'plan'],
        additionalProperties: false,
    };
    for (const path of ['$', '$.數據', '$.a.b', '$.plan', '$.plan[3]', '$.plan[0].week']) assert.equal(schemaPath(schema, path), path);
    for (const path of [undefined, '', '$.', '$.a', '$.plan[4]', '$.plan[-1]', '$.plan[01]', '$.plan.week', '$.plan[0].week.x', '$.數據[0]', '$.plan[0]week', 'x$.plan', '$.plan[0] ']) {
        assert.equal(schemaPath(schema, path), undefined, String(path));
    }
});

// 整段的值丟出例外時，若當成解析不了，會改挑後面通過的片段，例外就被吞掉了
test('extractJson：check 丟出的例外照樣往外丟，不算解析不了，也不改挑別的候選', () => {
    const schema = {
        type: 'object',
        properties: { answer: { type: 'string' }, inner: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
        required: ['answer'],
        additionalProperties: false,
    };
    const check = (value) => {
        if (value.answer === '壞') throw new TypeError('check 壞了');
        return null;
    };
    for (const text of ['{"answer":"壞","inner":{"answer":"好"}}', '前言 {"answer":"壞","inner":{"answer":"好"}}']) {
        assert.throws(() => extractJson(text, schema, { check }), TypeError, text);
    }
});

test('extractJson：reviver 交給 JSON.parse，每個候選都先經過它，schema 與 check 驗的是它處理過的值', () => {
    const answer = { type: 'object', properties: { answer: { type: 'string', enum: ['好'] } }, required: ['answer'], additionalProperties: false };
    const reviver = (key, value) => (value === 'ok' ? '好' : value);
    const check = (value) => (value.answer === '好' ? null : '$.answer 沒有經過 reviver');
    assert.deepEqual(extractJson('{"answer":"ok"}', answer, { reviver, check }), { answer: '好' });
    assert.deepEqual(extractJson('前言 [1] {"answer":"ok"} 後記', answer, { reviver, check }), { answer: '好' });
});

test('extractJson：最多試 32 個起點', () => {
    const answer = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    const noise = (n) => '[1] '.repeat(n);
    assert.deepEqual(extractJson(`${noise(31)}{"answer":"好"}`, answer), { answer: '好' });
    assert.throws(() => extractJson(`${noise(32)}{"answer":"好"}`, answer), (err) => err instanceof SchemaMismatch);
});

test('extractJson：沒有 JSON 或 JSON 不完整就丟 SyntaxError', () => {
    assert.throws(() => extractJson('沒有 JSON'), SyntaxError);
    assert.throws(() => extractJson('{"a":'), SyntaxError);
    assert.throws(() => extractJson('{"a":1]'), SyntaxError);
});

test('toResponseFormat：WinLab 實測接受的 json_schema 形狀', () => {
    assert.deepEqual(toResponseFormat('x', { type: 'object' }), {
        type: 'json_schema',
        json_schema: { name: 'x', strict: true, schema: { type: 'object' } },
    });
});
