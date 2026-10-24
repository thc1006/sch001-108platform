#!/usr/bin/env node
// 多元表現資料庫那幾項檢查的故障注入，一次弄壞一處，確認該通知的會通知、該紅的會紅：
//   A. 資料：精選的截止日和查證日期放到門檻兩側，看門狗的 needs_attention 與報告要跟著變
//   B. 判斷：改壞 activity-watchdog.lib.mjs，activity-watchdog.test.mjs 必須失敗
//   C. 串接：改壞 check-competitions.mjs 算今天的方式和接上判斷的地方，A 段至少要有一項失敗
//   D. 查證日期：sourceCheckedAt 缺漏或不可信時，activity-database.test.mjs 必須失敗
// 子行程一律用固定的時鐘，見 NOW。scripts/ 和資料複製到 .activity-faultcheck/ 再動手，
// 版控裡的檔案不會被改到。
//
// 執行：  npm run test:activity-faults
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const WORK = path.join(ROOT, '.activity-faultcheck');
const SCRIPTS = path.join(WORK, 'scripts');
const ACTIVITY_JSON = path.join(WORK, 'public/learning-portfolio/activity-database.json');
const REPORT = path.join(WORK, 'competition-report.md');
const OUTPUT = path.join(WORK, 'github-output');

// 子行程的現在一律是這個時刻。台灣 00:30 時 UTC 還是前一天，日期照 UTC 算就會差一天而被抓到；
// 用真的時鐘的話，只有台灣 00:00–08:00 跑才測得出這件事，跨過午夜時父子行程的今天也會不同。
const NOW = '2027-01-11T00:30:00+08:00';
const TODAY = NOW.slice(0, 10);
const day = (n) => new Date(Date.parse(TODAY) + n * 86_400_000).toISOString().slice(0, 10);

const entry = (title, fields) => ({
    title,
    organizer: '主辦單位',
    category: '競賽',
    form: '個人',
    description: '說明',
    deadline: null,
    featured: false,
    sourceCheckedAt: day(0),
    url: 'https://example.com/',
    ...fields,
});
// 每種狀態各一筆。不用真實資料：哪天真實資料裡沒有已截止或全年招募的活動，這裡照樣測得到。
const baseline = () => ({
    lastUpdated: day(0),
    activities: [
        entry('精選', { deadline: day(30), featured: true }),
        entry('本屆已截止', { deadline: day(-30) }),
        entry('沒有截止日', {}),
        entry('隨時可以報名', { rolling: true }),
    ],
});
/** set 回傳一個函式，把 title 那一筆的 field 改成 value，value 是 undefined 時刪掉這個欄位。 */
const set = (title, field, value) => (d) => {
    const a = d.activities.find((x) => x.title === title);
    if (value === undefined) delete a[field];
    else a[field] = value;
};

rmSync(WORK, { recursive: true, force: true });
cpSync(path.join(ROOT, 'scripts'), SCRIPTS, { recursive: true });
for (const dir of ['public/learning-portfolio', 'public/advanced-resources', 'src/pages/learning-portfolio']) {
    mkdirSync(path.join(WORK, dir), { recursive: true });
}
// 競賽清單是空的，needs_attention 就只看多元表現資料庫。
writeFileSync(path.join(WORK, 'public/advanced-resources/competitions.json'), '{"competitions": []}');
// activity-database.test.mjs 要從頁面抽 getActivityStatus。
const PAGE = 'src/pages/learning-portfolio/activity-database.astro';
cpSync(path.join(ROOT, PAGE), path.join(WORK, PAGE));
// 子行程用 --import 先載入這支，Date.now() 和不帶參數的 new Date() 都回 NOW。
const CLOCK = path.join(WORK, 'fixed-clock.mjs');
writeFileSync(CLOCK, [
    `const now = ${Date.parse(NOW)};`,
    'const RealDate = Date;',
    'globalThis.Date = class extends RealDate {',
    '    constructor(...a) { super(...(a.length ? a : [now])); }',
    '    static now() { return now; }',
    '};',
].join('\n'));
const withClock = ['--import', pathToFileURL(CLOCK).href];
const writeData = (data) => writeFileSync(ACTIVITY_JSON, typeof data === 'string' ? data : JSON.stringify(data, null, 2));

/** watchdog 跑沙盒裡的看門狗，回傳結束碼、有沒有 needs_attention 和報告。 */
function watchdog() {
    rmSync(OUTPUT, { force: true });
    rmSync(REPORT, { force: true });
    let code = 0;
    try {
        // GITHUB_OUTPUT 換成沙盒裡的檔案，CI 上不會把故障注入的結果寫進真正的 step output。
        execFileSync(process.execPath, [...withClock, path.join(SCRIPTS, 'check-competitions.mjs'), '--no-link-check'], {
            cwd: WORK,
            stdio: 'pipe',
            env: { ...process.env, GITHUB_OUTPUT: OUTPUT },
        });
    } catch (e) {
        code = e.status ?? 1;
    }
    const output = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    const report = existsSync(REPORT) ? readFileSync(REPORT, 'utf8') : '';
    return { code, attention: /^needs_attention=true$/m.test(output), report };
}

/** passes 在沙盒裡跑一支單元測試，回傳是否通過。 */
function passes(file) {
    try {
        execFileSync(process.execPath, [...withClock, '--test', path.join(SCRIPTS, file)], { cwd: WORK, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

const dataCases = [
    { name: '精選剩 14 天截止：通知', attention: true, report: /精選活動剩 14 天截止/, mutate: set('精選', 'deadline', day(14)) },
    { name: '精選剩 15 天截止：還不通知', attention: false, absent: /精選活動/, mutate: set('精選', 'deadline', day(15)) },
    { name: '精選今天截止：通知', attention: true, report: /精選活動今天截止/, mutate: set('精選', 'deadline', day(0)) },
    { name: '精選昨天截止：通知', attention: true, report: /精選活動已截止\n\n.*已過 1 天/, mutate: set('精選', 'deadline', day(-1)) },
    {
        name: '本屆已截止的活動 180 天沒查：通知',
        attention: true,
        report: /\| 本屆已截止 \| \S+ \| 180 天 \| \S+（已過 30 天） \|/,
        mutate: set('本屆已截止', 'sourceCheckedAt', day(-180)),
    },
    {
        name: '本屆已截止的活動 179 天沒查：列進報告，不通知',
        attention: false,
        report: /\| 本屆已截止 \| \S+ \| 179 天 \|/,
        mutate: set('本屆已截止', 'sourceCheckedAt', day(-179)),
    },
    {
        name: '沒有截止日的活動 90 天沒查：列進報告，不通知',
        attention: false,
        report: /\| 沒有截止日 \| \S+ \| 90 天 \| 依官網公告 \|/,
        mutate: set('沒有截止日', 'sourceCheckedAt', day(-90)),
    },
    {
        name: '沒有截止日的活動 89 天沒查：不列',
        attention: false,
        absent: /多元表現資料庫逾/,
        mutate: set('沒有截止日', 'sourceCheckedAt', day(-89)),
    },
    {
        name: '全年招募的活動 180 天沒查：通知',
        attention: true,
        report: /\| 隨時可以報名 \| \S+ \| 180 天 \| 全年招募 \|/,
        mutate: set('隨時可以報名', 'sourceCheckedAt', day(-180)),
    },
    {
        name: '截止日還沒到的活動 400 天沒查：不列',
        attention: false,
        absent: /多元表現資料庫逾/,
        mutate: set('精選', 'sourceCheckedAt', day(-400)),
    },
    {
        name: '一筆沒有 sourceCheckedAt：當成從未查過，通知',
        attention: true,
        report: /\| 本屆已截止 \| （無） \| 從未 \|/,
        mutate: set('本屆已截止', 'sourceCheckedAt', undefined),
    },
    { name: '資料不是合法的 JSON：通知', attention: true, report: /多元表現資料庫無法檢查/, data: '{' },
    { name: '沒有 activities 陣列：通知', attention: true, report: /需包含 activities 陣列/, data: '{}' },
];

/** dataProblem 跑一個 A 段的案例，結果符合預期時回傳 null，否則回傳哪裡不對。 */
function dataProblem(c) {
    const data = baseline();
    c.mutate?.(data);
    writeData(c.data ?? data);
    const r = watchdog();
    if (r.code !== 0) return `看門狗以 ${r.code} 結束`;
    if (r.attention !== c.attention) return c.attention ? '沒有通知' : '不該通知卻通知了';
    if (c.report && !c.report.test(r.report)) return `報告裡沒有 ${c.report}`;
    if (c.absent?.test(r.report)) return `報告裡不該有 ${c.absent}`;
    return null;
}

const libMutations = [
    ['精選的門檻少一天，剩 14 天時漏掉', 'return days <= soonDays ?', 'return days < soonDays ?'],
    ['精選已截止就不提醒', 'return days <= soonDays ?', 'return days >= 0 && days <= soonDays ?'],
    ['精選不看 featured，拿第一筆活動', "typeof a === 'object' && a.featured);", "typeof a === 'object');"],
    ['不存在的日期照樣當成日期（2027-02-29 變成 3/1）', ' === value ? ms : null;', ' ? ms : null;'],
    ['重查跳過已截止的活動，照搬競賽的規則', 'if (deadline !== null && deadline >= todayUTC) continue;', 'if (deadline !== null) continue;'],
    ['截止日當天就算已截止', 'deadline >= todayUTC) continue;', 'deadline > todayUTC) continue;'],
    ['重查的門檻改成嚴格大於', 'if (days < minDays) continue;', 'if (days <= minDays) continue;'],
    ['沒有查證日期的不列', 'checked === null ? Infinity :', 'checked === null ? -Infinity :'],
    ['重查不排序', 'return out.sort((x, y) => y.days - x.days);', 'return out;'],
    ['全年招募的標記丟掉，報告會寫成依官網公告', "rolling: a.rolling === true,", 'rolling: false,'],
    ['截止已過幾天沒算', 'closedDays: deadline === null ? null :', 'closedDays: true ? null :'],
];
const scriptMutations = [
    ['台灣的今天照 UTC 算', "timeZone: 'Asia/Taipei',", "timeZone: 'UTC',"],
    ['精選提醒沒有接上通知', '    featured !== null ||\n', ''],
    ['逾 180 天的活動沒有接上通知', '    activityRecheckUrgent.length > 0 ||\n', ''],
    ['讀不到資料時沒有通知', '    activityError !== null ||\n', ''],
    ['活動逾 90 天就通知', 'activityRecheck.filter((r) => r.days >= RECHECK_URGENT_DAYS)', 'activityRecheck.filter((r) => r.days >= RECHECK_DAYS)'],
    ['精選的門檻用了競賽的 30 天', 'featuredAlert(activities, todayUTC, FEATURED_SOON_DAYS)', 'featuredAlert(activities, todayUTC, SOON_DAYS)'],
    ['報告少了精選那一段', 'if (featured) {', 'if (false) {'],
    ['報告少了重查那一段', 'if (activityRecheck.length) {', 'if (false) {'],
];
const checkedCases = [
    ['一筆沒有 sourceCheckedAt', set('本屆已截止', 'sourceCheckedAt', undefined)],
    ['sourceCheckedAt 早於 #184 查證的那天', set('本屆已截止', 'sourceCheckedAt', '2026-10-23')],
    ['sourceCheckedAt 是三天後', set('本屆已截止', 'sourceCheckedAt', day(3))],
    ['sourceCheckedAt 不是 YYYY-MM-DD', set('本屆已截止', 'sourceCheckedAt', '2026/10/24')],
    ['欄位名打成 sourceCheckedOn', (d) => { set('本屆已截止', 'sourceCheckedOn', day(0))(d); set('本屆已截止', 'sourceCheckedAt', undefined)(d); }],
];

let pass = 0;
let fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, why) => { fail++; console.log(`  ❌ ${name} → ${why}`); };

/** baselineOk 確認沒有注入時看門狗不通知、兩支測試都通過。 */
function baselineOk() {
    writeData(baseline());
    const r = watchdog();
    const quiet = r.code === 0 && !r.attention && !/多元表現資料庫(的精選|逾|無法)/.test(r.report);
    return quiet && passes('activity-watchdog.test.mjs') && passes('activity-database.test.mjs');
}

/**
 * mutate 把沙盒裡的 file 換成改壞的版本跑 check，跑完換回原檔。
 * 換行先統一成 LF：Windows 上的 checkout 是 CRLF，用 LF 寫的比對字串會靜靜地對不上。
 */
function mutate(file, [name, from, to], check, why) {
    const target = path.join(SCRIPTS, file);
    const original = readFileSync(target, 'utf8').split(/\r?\n/).join('\n');
    if (original.split(from).length !== 2) return bad(name, '注入未生效：原文找不到或不只一處，請更新這一條');
    writeFileSync(target, original.replace(from, to));
    try {
        if (check()) bad(name, why);
        else ok(name);
    } finally {
        writeFileSync(target, original);
    }
}

console.log('先確認基準狀態為綠：');
if (!baselineOk()) {
    console.error('  ❌ 基準已經是紅的，無法進行故障注入');
    rmSync(WORK, { recursive: true, force: true });
    process.exit(1);
}
console.log('  ✅ 基準綠燈（看門狗不通知，兩支單元測試通過）\n');

console.log('A. 資料放到門檻兩側（看門狗的通知與報告）：');
for (const c of dataCases) {
    const why = dataProblem(c);
    if (why) bad(c.name, why);
    else ok(c.name);
}

console.log('\nB. 改壞判斷（activity-watchdog.test.mjs 必須紅）：');
writeData(baseline());
for (const m of libMutations) {
    mutate('activity-watchdog.lib.mjs', m, () => passes('activity-watchdog.test.mjs'), '改壞之後測試還是綠的');
}

console.log('\nC. 改壞串接（A 段至少一項必須失敗）：');
for (const m of scriptMutations) {
    mutate('check-competitions.mjs', m, () => dataCases.every((c) => dataProblem(c) === null), 'A 段全部照樣通過');
}

console.log('\nD. 查證日期不可信（activity-database.test.mjs 必須紅）：');
for (const [name, change] of checkedCases) {
    const data = baseline();
    change(data);
    writeData(data);
    if (passes('activity-database.test.mjs')) bad(name, '測試還是綠的');
    else ok(name);
}

const after = baselineOk();
console.log(after ? '\n還原後仍為綠燈 ✅' : '\n❌ 還原後仍是紅的，沙盒沒有復原乾淨');
rmSync(WORK, { recursive: true, force: true });
const total = dataCases.length + libMutations.length + scriptMutations.length + checkedCases.length;
console.log(`故障注入：${pass} 擋下 / ${fail} 漏掉（共 ${total} 項）`);
process.exit(fail === 0 && after ? 0 : 1);
