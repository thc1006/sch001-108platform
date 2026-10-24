// activity-watchdog.lib.mjs 的測試。今天固定成台灣時間 2027-02-15。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { featuredAlert, selectActivityRecheck } from './activity-watchdog.lib.mjs';

const TODAY = Date.UTC(2027, 1, 15);
const day = (n) => new Date(TODAY + n * 86_400_000).toISOString().slice(0, 10);
const featuredWith = (deadline) => featuredAlert([{ title: '精選', featured: true, deadline }], TODAY, 14);
const recheck = (list, minDays = 90) => selectActivityRecheck(list, TODAY, minDays);

test('精選：14 天內截止、截止日當天、已截止都要提醒，15 天以後不用', () => {
    assert.equal(featuredWith(day(15)), null);
    assert.deepEqual(featuredWith(day(14)), { label: '精選', deadline: day(14), days: 14 });
    assert.equal(featuredWith(day(0)).days, 0);
    assert.equal(featuredWith(day(-1)).days, -1);
    assert.equal(featuredWith(day(-400)).days, -400);
});

test('精選：只看第一筆 featured，其他活動快截止或已截止都不算', () => {
    const list = [
        { title: '不是精選', featured: false, deadline: day(-1) },
        { title: '精選', featured: true, deadline: day(60) },
        { title: '第二筆精選', featured: true, deadline: day(-1) },
    ];
    assert.equal(featuredAlert(list, TODAY, 14), null);
});

test('精選：沒有截止日、沒有精選、輸入壞掉、日期不存在都不提醒', () => {
    assert.equal(featuredAlert([{ title: '全年', featured: true, deadline: null, rolling: true }], TODAY, 14), null);
    assert.equal(featuredWith(null), null);
    assert.equal(featuredAlert([{ title: '不是精選', featured: false, deadline: day(1) }], TODAY, 14), null);
    assert.equal(featuredAlert(null, TODAY, 14), null);
    assert.equal(featuredAlert([null, 42, 'x'], TODAY, 14), null);
    // 2027 年沒有 2/29。當成 3/1 的話剛好剩 14 天，會被算成快截止。
    assert.equal(featuredWith('2027-02-29'), null);
});

test('重查：截止日已過、沒有截止日、全年招募的都列，截止日還沒到的不列', () => {
    const old = day(-200);
    const out = recheck([
        { title: '已截止', deadline: day(-30), sourceCheckedAt: old },
        { title: '依官網公告', deadline: null, sourceCheckedAt: old },
        { title: '全年招募', deadline: null, rolling: true, sourceCheckedAt: old },
        { title: '報名中', deadline: day(30), sourceCheckedAt: old },
    ]);
    assert.deepEqual(out.map((r) => r.label).sort(), ['依官網公告', '全年招募', '已截止'].sort());
});

test('重查：截止日當天還能報名，不列；隔天才列', () => {
    const old = day(-200);
    assert.deepEqual(recheck([{ title: '今天截止', deadline: day(0), sourceCheckedAt: old }]), []);
    assert.equal(recheck([{ title: '昨天截止', deadline: day(-1), sourceCheckedAt: old }]).length, 1);
});

test('重查：門檻是大於等於，剛好 90 天的那天就要列出', () => {
    assert.equal(recheck([{ title: '90 天', deadline: null, sourceCheckedAt: day(-90) }]).length, 1);
    assert.deepEqual(recheck([{ title: '89 天', deadline: null, sourceCheckedAt: day(-89) }]), []);
});

test('重查：沒有或壞掉的查證日期算從未查過，排最前面', () => {
    const out = recheck([
        { title: '查過但很久', deadline: null, sourceCheckedAt: day(-300) },
        { title: '從來沒查過', deadline: null },
        { title: '格式壞掉', deadline: null, sourceCheckedAt: '2026/10/24' },
    ]);
    assert.deepEqual(out.map((r) => [r.label, r.checked, r.days]).slice(2), [['查過但很久', day(-300), 300]]);
    assert.deepEqual(out.slice(0, 2).map((r) => [r.checked, r.days]), [['（無）', Infinity], ['（無）', Infinity]]);
});

test('重查：依陳舊度由大到小排序', () => {
    const list = [100, 300, 200].map((n) => ({ title: `${n}`, deadline: null, sourceCheckedAt: day(-n) }));
    assert.deepEqual(recheck(list).map((r) => r.days), [300, 200, 100]);
});

test('重查：報告要用的截止日、是否全年招募與截止已過幾天', () => {
    const [closed, rolling] = recheck([
        { title: '已截止', deadline: day(-30), sourceCheckedAt: day(-200) },
        { title: '全年招募', deadline: null, rolling: true, sourceCheckedAt: day(-100) },
    ]);
    assert.deepEqual(closed, { label: '已截止', checked: day(-200), days: 200, deadline: day(-30), rolling: false, closedDays: 30 });
    assert.deepEqual(rolling, { label: '全年招募', checked: day(-100), days: 100, deadline: null, rolling: true, closedDays: null });
});

test('重查：壞掉的輸入不讓看門狗出錯', () => {
    assert.deepEqual(recheck(null), []);
    assert.deepEqual(recheck([null, undefined, 42, 'x']), []);
    assert.equal(recheck([{ deadline: null }])[0].label, '（未命名）');
});

// 欄位名稱和真實資料對不上時，上面用自造資料的測試照樣會過。
test('重查：真實資料的每一筆都讀得到截止日與查證日期', () => {
    const { activities } = JSON.parse(
        readFileSync(new URL('../public/learning-portfolio/activity-database.json', import.meta.url), 'utf8'),
    );
    const out = selectActivityRecheck(activities, Date.UTC(9999, 11, 31), 0);
    assert.equal(out.length, activities.length);
    assert.deepEqual(out.filter((r) => r.days === Infinity).map((r) => r.label), []);
    assert.equal(out.filter((r) => r.closedDays !== null).length, activities.filter((a) => a.deadline !== null).length);
});
