// 檢查 activity-database.json 是否照 _readme 填寫，並用固定的時間跑頁面的 getActivityStatus。
// 函式從 .astro 抽出來跑，做法和 competitions-data.test.mjs 相同。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sourceCheckedProblem } from './check-competitions.lib.mjs';

const DATA = JSON.parse(
    readFileSync(new URL('../public/learning-portfolio/activity-database.json', import.meta.url), 'utf8'),
);
const FIELDS = [
    'title', 'organizer', 'category', 'form', 'description', 'deadline', 'rolling', 'featured',
    'sourceCheckedAt', 'recheckOn', 'recheckNote', 'url',
];
// #184 在這天逐筆開過官網，查證日期不能早於這天。
const CHECKED_NOT_BEFORE = '2026-10-24';
/** isDate 判斷 v 是不是存在的 YYYY-MM-DD 日期。 */
const isDate = (v) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

/**
 * loadStatus 從頁面抽出 getActivityStatus，回傳一個以 at 為現在時間的版本。
 * @param {string} at @returns {(activity: object) => {text: string}}
 */
function loadStatus(at) {
    const src = readFileSync(
        new URL('../src/pages/learning-portfolio/activity-database.astro', import.meta.url),
        'utf8',
    );
    const fn = src.match(/^( *)function getActivityStatus\([^)]*\) \{[\s\S]*?\n\1\}/m);
    assert.ok(fn, '在 activity-database.astro 抽不到 getActivityStatus，改了名請同步更新這裡');
    const fixed = new Date(at).getTime();
    class FixedDate extends Date {
        constructor(...a) {
            super(...(a.length ? a : [fixed]));
        }
        static now() {
            return fixed;
        }
    }
    return new Function('Date', `${fn[0]}; return getActivityStatus;`)(FixedDate);
}

test('欄位：照 _readme 的規定填', () => {
    for (const a of DATA.activities) {
        const unknown = Object.keys(a).filter((k) => !FIELDS.includes(k));
        assert.deepEqual(unknown, [], `「${a.title}」有不認得的欄位`);
        for (const key of ['title', 'organizer', 'category', 'description', 'url']) {
            const v = a[key];
            assert.ok(typeof v === 'string' && v && v.trim() === v, `「${a.title}」的 ${key} 是空的或前後有空白`);
        }
        assert.ok(['個人', '團體', '個人／團體'].includes(a.form), `「${a.title}」的 form 是 ${a.form}`);
        // 頁面只看真假，字串 "false" 也會被當成精選。
        assert.equal(typeof a.featured, 'boolean', `「${a.title}」的 featured 不是 true 或 false`);
        // url 直接放進 href，javascript: 這類網址點了會執行。
        assert.match(a.url, /^https:\/\//, `「${a.title}」的 url 不是 https`);
        if (a.deadline !== null) {
            // 頁面把解析不了的日期算成「報名中」。
            assert.ok(isDate(a.deadline), `「${a.title}」的 deadline 不是 YYYY-MM-DD 格式的日期：${a.deadline}`);
        }
        if ('rolling' in a) {
            assert.equal(a.rolling, true, `「${a.title}」的 rolling 只能是 true`);
            assert.equal(a.deadline, null, `「${a.title}」有截止日，不能標 rolling`);
        }
        const why = sourceCheckedProblem(a.sourceCheckedAt, CHECKED_NOT_BEFORE);
        assert.equal(why, null, `「${a.title}」的 sourceCheckedAt ${why}`);
    }
    const featured = DATA.activities.filter((a) => a.featured);
    assert.ok(featured.length <= 1, `featured 有 ${featured.length} 筆，頁面只顯示第一筆`);
});

test('預定重查日：附上依據，晚於上次查證', () => {
    for (const a of DATA.activities) {
        if (!('recheckOn' in a) && !('recheckNote' in a)) continue;
        // 沒有依據的日子就是猜的，兩個欄位要一起填。
        assert.ok('recheckOn' in a && 'recheckNote' in a, `「${a.title}」的 recheckOn 和 recheckNote 要一起填`);
        const note = a.recheckNote;
        assert.ok(typeof note === 'string' && note && note.trim() === note, `「${a.title}」的 recheckNote 是空的或前後有空白`);
        assert.ok(isDate(a.recheckOn), `「${a.title}」的 recheckOn 不是 YYYY-MM-DD 格式的日期：${a.recheckOn}`);
        // recheckOn 停在查證當天或更早，代表重查後忘了設下一個。
        assert.ok(a.recheckOn > a.sourceCheckedAt, `「${a.title}」的 recheckOn 沒有晚於 sourceCheckedAt，重查後要設下一個或拿掉`);
    }
});

test('狀態：沒有截止日的看 rolling，有截止日的看還剩幾天', () => {
    const status = loadStatus('2026-10-24T12:00:00+08:00');
    const text = (a) => status(a).text;
    assert.equal(text({ deadline: null, rolling: true }), '全年招募');
    assert.equal(text({ deadline: null }), '依官網公告');
    assert.equal(text({ deadline: '2026-09-30' }), '已截止');
    assert.equal(text({ deadline: '2026-11-01' }), '即將截止');
    assert.equal(text({ deadline: '2027-01-15' }), '報名中');
});

test('狀態：截止日照台灣時間的日曆日算，當天結束才算已截止', () => {
    const late = loadStatus('2026-10-24T23:59:00+08:00');
    assert.equal(late({ deadline: '2026-10-24' }).text, '即將截止');
    const early = loadStatus('2026-10-25T00:30:00+08:00');
    assert.equal(early({ deadline: '2026-10-24' }).text, '已截止');
    assert.equal(early({ deadline: '2026-11-08' }).text, '即將截止');
    assert.equal(early({ deadline: '2026-11-09' }).text, '報名中');
});
