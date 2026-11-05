// 藝廊的真實作品與對照例子在建置時讀進 portfolio-gallery.astro。少了欄位，卡片會缺一段；
// id 也是 HTML 的 id，重複的話 aria-labelledby 會指錯卡片。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DATA = JSON.parse(readFileSync(new URL('../public/learning-portfolio/portfolio-works.json', import.meta.url), 'utf8'));
const REQUIRED = {
    works: ['id', 'title', 'group', 'kind', 'did', 'learn', 'url', 'linkLabel'],
    contrasts: ['id', 'title', 'problem', 'better', 'url', 'linkLabel'],
};
const filled = (v) => typeof v === 'string' && v.trim() !== '';

for (const [key, fields] of Object.entries(REQUIRED)) {
    test(`${key}：必填欄位都有字`, () => {
        assert.ok(Array.isArray(DATA[key]) && DATA[key].length > 0, `${key} 應是非空陣列`);
        for (const item of DATA[key]) {
            for (const f of fields) assert.ok(filled(item[f]), `${item.id ?? item.title}：缺 ${f}`);
        }
    });
}

test('quote 有的話，by 和 text 都要有字', () => {
    for (const w of DATA.works.filter((w) => 'quote' in w)) {
        assert.ok(filled(w.quote?.by) && filled(w.quote?.text), `${w.id}：quote 缺 by 或 text`);
    }
});

test('id 在兩區之間不重複', () => {
    const ids = [...DATA.works, ...DATA.contrasts].map((x) => x.id);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});

test('連結是 https', () => {
    for (const x of [...DATA.works, ...DATA.contrasts]) {
        assert.equal(new URL(x.url).protocol, 'https:', `${x.id}：${x.url}`);
    }
});
