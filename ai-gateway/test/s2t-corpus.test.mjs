/**
 * 簡轉繁不能改動正確的繁體文字：repo 追蹤的每個文字檔整份跑過 toTraditional，結果要和原文逐字相同。
 * 站上的文章、資料 JSON、頁面、閘道的提示詞都在裡面，內容新增或修改時也由這裡把關。同一份文字的
 * 每一句再夾進簡體字（模型混寫的樣子），寫對的繁體字也不能被改動。
 *
 * 刻意寫成簡體或日文的地方不比：簡轉繁自己的表、說明與閘道的測試（SKIP），以及少數引用原文的
 * 片段（QUOTED）。QUOTED 的每一段都要還在檔案裡，原文改掉了就把條目拿掉。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toTraditional } from '../src/s2t.mjs';
import { S2T_PAIRS } from '../src/s2t-table.mjs';

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const SKIP = [/^ai-gateway\/src\/s2t[^/]*\.mjs$/, /^ai-gateway\/scripts\/build-s2t-[^/]*\.mjs$/, /^ai-gateway\/test\//];
const QUOTED = {
    'ai-gateway/src/generate.mjs': ['「阶段」「数据收集」'],
    'ai-gateway/src/tasks.mjs': ['据 前面'],
    'public/advanced-resources/competitions.json': ['奖项介绍', '由清华大学主办，清华大学丘成桐数学科学中心承办', '华南区', '日本国内に在住している'],
    'scripts/competitions-data.test.mjs': ['北京世纪思德国际教育科技', '第20回 国際地学オリンピック2027 日本島根大会'],
};

/** repo 追蹤的文字檔（拿掉 SKIP 與 QUOTED），[檔名, 內容] 的陣列 */
function repoTexts() {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
    const texts = [];
    for (const file of files) {
        if (SKIP.some((re) => re.test(file))) continue;
        let text;
        try {
            text = readFileSync(path.join(REPO, file), 'utf8');
        } catch {
            continue; // 工作區裡刪掉了
        }
        // 圖片這類二進位檔解出來會有 U+FFFD
        if (text.includes('�') || !/\p{Script=Han}/u.test(text)) continue;
        for (const quote of QUOTED[file] ?? []) {
            assert.ok(text.includes(quote), `${file} 已經沒有「${quote}」，把它從 QUOTED 拿掉`);
            // 換成換行：兩邊的字不會因為拿掉中間這段而接成一個詞
            text = text.replaceAll(quote, '\n');
        }
        texts.push([file, text]);
    }
    return texts;
}

const TEXTS = repoTexts();
// 不重複的句子（句尾和 s2t-core.mjs 相同）
const SENTENCES = [...new Set(TEXTS.flatMap(([, text]) => text.split(/[。！？!?\n]/)))].filter((s) => /\p{Script=Han}/u.test(s));
const around = (chars, at) => chars.slice(Math.max(0, at - 8), at + 8).join('');

test('repo 裡的繁體文字跑過簡轉繁，一個字都不變', () => {
    let han = 0;
    const changed = [];
    for (const [file, text] of TEXTS) {
        han += text.match(/\p{Script=Han}/gu).length;
        const out = [...toTraditional(text)];
        const chars = [...text];
        const at = chars.findIndex((ch, i) => ch !== out[i]);
        if (at >= 0) changed.push(`${file}：「${around(chars, at)}」→「${around(out, at)}」`);
    }
    assert.ok(TEXTS.length >= 150 && han >= 400000, `只檢查了 ${TEXTS.length} 個檔案、${han} 個漢字，路徑可能錯了`);
    assert.deepEqual(changed, []);
});

// 模型常在繁體的句子裡夾一個簡體字。這時詞組與 CURATED 會被觸發，寫對的繁體字也不能被改動
test('每句結尾加一個簡體字：只有那個字被轉，句子原本的字不變', () => {
    const changed = [];
    for (const sentence of SENTENCES) {
        const out = toTraditional(`${sentence}这`);
        if (out !== `${sentence}這`) {
            const chars = [...sentence];
            const o = [...out];
            const at = chars.findIndex((ch, i) => ch !== o[i]);
            changed.push(`「${around(chars, at)}」→「${around(o, at)}」`);
        }
    }
    assert.ok(SENTENCES.length >= 10000, `只有 ${SENTENCES.length} 句`);
    assert.deepEqual(changed, []);
});

test('每句輪流把一個繁體字換回簡體：轉完等於原句', () => {
    const simplified = new Map();
    const pairs = [...S2T_PAIRS];
    for (let i = 0; i < pairs.length; i += 2) if (!simplified.has(pairs[i + 1])) simplified.set(pairs[i + 1], pairs[i]);
    const changed = [];
    for (const sentence of SENTENCES) {
        const chars = [...sentence];
        chars.forEach((ch, i) => {
            // 拮据 是正確的繁體，據 換成 据 以後本來就不轉回來
            if (!simplified.has(ch) || (ch === '據' && chars[i - 1] === '拮')) return;
            const mixed = chars.slice();
            mixed[i] = simplified.get(ch);
            const out = [...toTraditional(mixed.join(''))];
            const at = chars.findIndex((c, j) => c !== out[j]);
            if (at >= 0) changed.push(`${ch} 寫成 ${mixed[i]}：「${around(chars, at)}」→「${around(out, at)}」`);
        });
    }
    assert.deepEqual(changed, []);
});
