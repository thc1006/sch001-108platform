/**
 * 簡轉繁不能改動正確的繁體文字：repo 追蹤的每個文字檔整份跑過 toTraditional，結果要和原文逐字相同。
 * 站上的文章、資料 JSON、頁面、閘道的提示詞都在裡面，內容新增或修改時也由這裡把關。
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

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

const SKIP = [/^ai-gateway\/src\/s2t[^/]*\.mjs$/, /^ai-gateway\/scripts\/build-s2t-[^/]*\.mjs$/, /^ai-gateway\/test\//];
const QUOTED = {
    'ai-gateway/src/generate.mjs': ['「阶段」「数据收集」'],
    'ai-gateway/src/tasks.mjs': ['据 前面'],
    'public/advanced-resources/competitions.json': ['奖项介绍', '由清华大学主办，清华大学丘成桐数学科学中心承办', '华南区', '日本国内に在住している'],
    'scripts/competitions-data.test.mjs': ['北京世纪思德国际教育科技', '第20回 国際地学オリンピック2027 日本島根大会'],
};

test('repo 裡的繁體文字跑過簡轉繁，一個字都不變', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
    let checked = 0;
    let han = 0;
    const changed = [];
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
        checked++;
        han += text.match(/\p{Script=Han}/gu).length;
        const out = [...toTraditional(text)];
        const chars = [...text];
        const at = chars.findIndex((ch, i) => ch !== out[i]);
        if (at >= 0) changed.push(`${file}：「${chars.slice(Math.max(0, at - 8), at + 8).join('')}」→「${out.slice(Math.max(0, at - 8), at + 8).join('')}」`);
    }
    assert.ok(checked >= 150 && han >= 400000, `只檢查了 ${checked} 個檔案、${han} 個漢字，路徑可能錯了`);
    assert.deepEqual(changed, []);
});
