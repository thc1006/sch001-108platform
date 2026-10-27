// 線上課程頁的平台選單寫死在 online-courses.astro，課程的 platform 寫在 online-courses.json。
// 課程的 platform 沒有對應選項，那筆用選單篩不出來；選項沒有任何課程，選了只會看到空白。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const DATA = JSON.parse(read('../public/advanced-resources/online-courses.json'));
const PAGE = read('../src/pages/advanced-resources/online-courses.astro');
const SYNC = '改了選單的 HTML 格式要同步改這個測試';

function options(id) {
    const select = PAGE.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(select, `online-courses.astro 找不到 #${id}，${SYNC}`);
    return [...select[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
}

test('平台選單的選項與課程的 platform 一一對應', () => {
    const [all, ...rest] = options('platform-filter');
    assert.deepEqual(all, ['all', '所有平台'], `第一個選項應是「所有平台」，${SYNC}`);
    for (const [value, label] of rest) assert.equal(label, value, `選項 ${value} 的標籤和值不同`);
    const fromOptions = rest.map(([value]) => value).sort();
    const fromData = [...new Set(DATA.courses.map((c) => c.platform))].sort();
    assert.deepEqual(fromOptions, fromData, '平台選項和課程的 platform 不一致');
});
