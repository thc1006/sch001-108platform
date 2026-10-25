/**
 * competitions.json 逐筆查證結果的測試。
 * check-competitions.probe.test.mjs 測的是規則（schema、探測、狀態機）。
 * 這一支測的是事實：每一筆逐項開過官網查證的競賽，其報名時程與賽事日期
 * 不得被改回錯的值。
 *
 * 為什麼需要它：#63 → #66 → #68 是同一批過期資料反覆觸發的三個 PR，而 #70
 * 記載「大量條目只做過 HTTP status check，沒有逐頁驗證」。schema 綠燈證明不了
 * 值是對的。2026-08-27 這一輪逐筆查證發現的錯誤，全部都是「格式完全合法、
 * 內容卻是錯的」：
 *
 *   - My First CTF 的 cycle.closes 是「05」，但 5 月是比賽日期，
 *     報名其實 4/19 就截止了（官網：報名「自 115 年 4 月 1 日上午 10 點至
 *     115 年 4 月 19 日下午 5 點止」、競賽「115 年 5 月 16 日(六)」）。
 *   - iBridge 的 cycle.closes 是「12」，同樣是比賽月份；報名 11/28 就截止。
 *   - APMO／APIO 是國家隊選拔、根本沒有公開報名，cycle.closes 卻讓卡片寫出
 *     「每年約 3 月截止」「每年約 5 月截止」這種不存在的報名截止。
 *   - Conrad Challenge 的官網網域已停放（HTTPS 交握失敗、HTTP 導向 /lander），
 *     但看門狗的連結分類會把交握失敗歸為「無法判定」而不是「失效」。
 *   - 世界歷史學家論文獎的「每年 5 月 1 日截止」只存在於已下線的 archive 站；
 *     2026-10-23 官網逐字寫「The deadline for 2027 will be announced by early November.」
 *
 * 每一項下面都附了官網逐字原文。要改這裡的值，請先開官網確認並更新引文。
 */
import test from 'node:test';
import { sourceCheckedProblem } from './check-competitions.lib.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DATA = JSON.parse(
    readFileSync(new URL('../public/advanced-resources/competitions.json', import.meta.url), 'utf8'),
);

const find = (needle) => {
    const hits = DATA.competitions.filter((c) => c.title.includes(needle));
    assert.equal(hits.length, 1, `「${needle}」應恰好比對到 1 筆，實際 ${hits.length} 筆`);
    return hits[0];
};

/** 2026-08-27 這一輪逐筆查證涵蓋的競賽。 */
const VERIFIED_2026_08_27 = [
    '台灣國際科學展覽會',
    '外交小尖兵',
    '台灣國際學生創意設計大賽',
    '亞太數學奧林匹亞',
    '亞太資訊奧林匹亞',
    'My First CTF',
    '哈佛克里姆森商業個案分析賽',
    'Diamond Challenge',
    'Conrad Challenge',
    '世界歷史學家論文獎',
    'Foyle',
    'ESU 國際公眾演說',
    '國際化學競賽',
    '生活科技學藝競賽',
    '總統教育獎',
    'iBridge',
    'Taiwan Brain Bee',
    '育秀盃',
];

/**
 * sourceCheckedAt 的不變式是「這一筆真的有人開過官網」，不是「查證發生在某一天」。
 * 所以只要求它是存在的 YYYY-MM-DD 日期，而且落在基準日和以 UTC 計的明天之間：
 * 清掉、亂填、早於基準日或晚於明天都會紅，重新查證後填當天的日期可以。
 * 寫死成某一天的話，再次查證之後就無法記錄新的日期。
 */
function assertVerified(needle) {
    const why = sourceCheckedProblem(find(needle).sourceCheckedAt);
    assert.equal(why, null, `${needle} 的 sourceCheckedAt ${why}`);
}

test('data：這一輪逐筆查證的 18 筆都必須留下查證日期（可更新，不可清掉或倒退）', () => {
    // 沒有這一行的話，把 VERIFIED_2026_08_27 清成 [] 之後，這一支以及底下另外兩支
    // 也在跑同一份清單的測試會一起印綠字，而其實一筆都沒比。底下的
    // VERIFIED_ROUND2／REMOVED_ROUND2 也一樣釘了長度。
    assert.equal(VERIFIED_2026_08_27.length, 18, '清單長度變動代表有人動了查證範圍，請一併更新測試名稱與 PR 說明');
    for (const needle of VERIFIED_2026_08_27) assertVerified(needle);
});

// 這是本輪查證抓到最多次的錯誤類型，也是 #82 修 OPhO 時處理過的同一個錯誤。
test('data：比賽日期不得再被寫成報名截止（My First CTF／iBridge／育秀盃）', () => {
    // 官網：報名「自 115 年 4 月 1 日上午 10 點至 115 年 4 月 19 日下午 5 點止」
    //       競賽「115 年 5 月 16 日(六)上午 9 時 30 分至下午 5 時 30 分」
    // 2021 至 2025 年的報名截止是 5/6、4/26、4/26、5/15、5/12，4、5 月都有，官網只寫比賽「每年5月舉辦」。
    const ctf = find('My First CTF');
    assert.equal(ctf.deadline, '');
    assert.equal(ctf.deadlineAt, undefined);
    assert.equal(ctf.opensAt, undefined);
    assert.equal(ctf.eventStartsAt, '2026-05-16');
    assert.equal(ctf.cycle, undefined, '報名截止 4、5 月都有，不得拿比賽月份當週期');
    assert.ok(ctf.registrationNote?.includes('2027'));

    // 官網 2025 屆：報名「即日起至 11 月 28 日（五）17:00 截止」、競賽「2025 年 12 月 13 日（六）」
    // 官網只有兩屆紀錄（2023-06、2025-12），辦理時間不固定 → 不得填 cycle 推算下一屆
    const ibridge = find('iBridge');
    assert.equal(ibridge.eventStartsAt, '2025-12-13');
    assert.equal(ibridge.cycle, undefined, 'iBridge 只辦過兩屆且間隔不固定，不得宣稱年度週期');
    assert.ok(ibridge.registrationNote, '沒有固定週期時應以 registrationNote 說明，而不是留白');

    // 第 23 屆官網競賽時程：「報名及初賽截止日 2025 / 12 / 30」「決賽評選暨頒獎典禮 2026 / 4 / 24」
    // 第 24 屆高中職組：「報名及初賽截止日 2026 / 12 / 31」，決賽「2027 / 4月辦理」還沒有日期
    const ysed = find('育秀盃');
    assert.equal(ysed.deadline, '2026-12-31');
    assert.equal(ysed.deadlineAt, '2026-12-31T23:59:00+08:00');
    assert.equal(ysed.eventStartsAt, '2026-04-24', '4/24 是第 23 屆的決賽暨頒獎，不是報名截止');
    assert.equal(ysed.cycle.opens, '10-01');
    assert.equal(ysed.cycle.closes, '12', '兩屆分別是 12/30 與 12/31');
});

// 沒有公開報名的競賽不得顯示「每年約 X 月截止」。
test('data：國家隊選拔類競賽不得憑賽事月份捏造報名截止', () => {
    // APMO 官網 Regulations：「The APMO is held in the afternoon of the second Monday of March
    // for participating countries in the North and South Americas, and in the morning of the
    // second Tuesday of March for participating countries on the Western Pacific and in Asia.」
    // 「Country representatives organize the competition locally.」沒有任何公開報名截止日。
    const apmo = find('亞太數學奧林匹亞');
    assert.equal(apmo.deadline, '');
    assert.ok(!apmo.cycle?.closes, 'APMO 的 3 月是比賽月份，不得放進 cycle.closes');
    assert.ok(apmo.registrationNote?.includes('無公開報名'));

    // APIO：台灣不開放個人報名，由 TOI 選訓隊代表；官網選訓時程「2026年5月9日 APIO 2026」
    const apio = find('亞太資訊奧林匹亞');
    assert.equal(apio.deadline, '');
    assert.ok(!apio.cycle?.closes, 'APIO 的 5 月是比賽月份，不得放進 cycle.closes');
    assert.equal(apio.eventStartsAt, '2026-05-09');
    assert.ok(apio.registrationNote?.includes('無公開報名'));
});

// 官網網址必須指向「有內容」的現行站台。
test('data：本輪查證修掉的失效／停放網址不得被改回去', () => {
    // https://tpmso.org/toi/ 現在只回一個 meta refresh 轉址頁：
    //   <meta http-equiv="refresh" content="0;url=https://tpmso.k12ea.gov.tw/toi/" />
    //   <title>Welcome to Taiwan Olympiad Portal</title>
    // HTTP 200、body 沒有任何內容，連結健檢完全看不出問題。
    assert.equal(find('亞太資訊奧林匹亞').url, 'https://tpmso.k12ea.gov.tw/toi/');

    // www.conradchallenge.org 的 HTTPS 交握失敗（TLS unrecognized_name），
    // HTTP 只回 114 bytes 的停放頁：window.location.href="/lander"。
    // 現行官網由休士頓太空中心營運。
    assert.equal(find('Conrad Challenge').url, 'https://conrad.spacecenter.org/');

    // www.thewha.org 首頁沒有任何論文獎內容；獎項頁才有，且逐字寫著截止日尚未公布。
    assert.equal(find('世界歷史學家論文獎').url, 'https://www.thewha.org/prizes-awarded-by-the-wha');

    for (const needle of VERIFIED_2026_08_27) {
        const { url } = find(needle);
        assert.match(url, /^https:\/\//, `${needle} 的 url 必須是 https`);
        const host = new URL(url).hostname;
        assert.ok(host !== 'conradchallenge.org' && host !== 'www.conradchallenge.org', 'conradchallenge.org 已是停放網域');
        assert.notEqual(host, 'tpmso.org', 'tpmso.org 已轉址到 tpmso.k12ea.gov.tw');
    }
});

test('data：查到確切時刻的競賽必須保留時區位移', () => {
    // TISDC 官網時程：「Submission deadline: July 6, 2026, 11:59 PM Taipei Time」
    //                「Extended deadline: July 15, 2026, 11:59 PM Taipei Time」
    assert.equal(find('台灣國際學生創意設計大賽').deadlineAt, '2026-07-15T23:59:00+08:00');

    // HCGCC 官網 Terms：「The registration form closes automatically on October 14 (GMT+0), 23:59.」
    assert.equal(find('哈佛克里姆森商業個案分析賽').deadlineAt, '2026-10-14T23:59:00Z');

    // Diamond Challenge 官網：「January 14 | Submission Deadline (5PM EST)」
    //                        「September 16 | Submission Window Opens」
    const diamond = find('Diamond Challenge');
    assert.equal(diamond.deadline, '2027-01-14');
    assert.equal(diamond.deadlineAt, '2027-01-14T17:00:00-05:00');
    assert.equal(diamond.opensAt, '2026-09-16T00:00:00-04:00');
    assert.equal(diamond.eventStartsAt, '2027-04-29');
    assert.equal(diamond.eventEndsAt, '2027-04-30');

    // 生活科技學藝競賽官方實施計畫：「文件送繳時程：於115 年 3 月30 日(一) 下午5 點前」
    //                              「決賽日期：115 年5 月19 日(二)」
    const lt = find('生活科技學藝競賽');
    assert.equal(lt.deadlineAt, '2026-03-30T17:00:00+08:00');
    assert.equal(lt.eventStartsAt, '2026-05-19');

    // 每個時刻欄位都必須帶時區位移，沒有時區的時刻在不同時區的人眼中是不同的時刻。
    for (const needle of VERIFIED_2026_08_27) {
        const c = find(needle);
        for (const f of ['deadlineAt', 'opensAt']) {
            if (c[f] === undefined) continue;
            assert.match(c[f], /(Z|[+-]\d{2}:\d{2})$/, `${needle} 的 ${f} 缺少時區位移`);
        }
    }
});

test('data：官網未公布截止日的競賽不得被補上一個猜出來的日期', () => {
    // 官網獎項頁逐字（2026-10-23 重查）：「Deadline for submissions: The deadline for 2027 will be
    // announced by early November.」舊資料的「每年 5 月 1 日截止」只存在於已下線的 archive.thewha.org 與第三方轉述。
    const wha = find('世界歷史學家論文獎');
    assert.equal(wha.deadline, '');
    assert.equal(wha.cycle, undefined, '官網已不再公布固定的 5/1 截止日');
    assert.ok(wha.registrationNote?.includes('11 月'), '應說明截止日何時公布，而不是留一個舊日期');

    // 「總統教育獎辦理要點」只訂獎金與名額，未訂推薦截止日；各年度期程也不一致
    //（2026 屆 2025-11-27 至 2025-12-30、2025 屆至 2 月 3 日止）。
    const pea = find('總統教育獎');
    assert.equal(pea.deadline, '');
    assert.equal(pea.cycle, undefined, '推薦期程逐年不同，不得宣稱固定在 12 月');
    assert.ok(pea.registrationNote);

    // 外交小尖兵：113 年為「選拔活動」（9/1–9/30 報名）、114 年改辦「培訓營」（報名截止 4/29），
    // 115 年度的「世界領航營」3/16 至 4/30 報名。每年形式與時程都不同 → 不得宣稱「每年 9 月開放」。
    const mofa = find('外交小尖兵');
    assert.equal(mofa.deadline, '');
    assert.equal(mofa.cycle, undefined);
    assert.ok(mofa.registrationNote);

    // IChC about 頁：「The competition was organized in 2025 for the first time.」2025 屆的截止日查不到，
    // 只有 2026 屆資格賽的「Sunday, 29 March 2026, 23:59 UTC+0」，一屆的日期推不出年度週期。
    const ichc = find('國際化學競賽');
    assert.equal(ichc.deadline, '');
    assert.equal(ichc.deadlineAt, undefined);
    assert.equal(ichc.cycle, undefined, '只查得到 2026 一屆的截止日');
    assert.ok(ichc.registrationNote?.includes('2027'));

    // Foyle 官網 Rules：「Deadline: Midnight 31st July 2026 (BST)」。
    // midnight 究竟指 00:00 或 23:59 官網未界定 → 不得自行補一個 deadlineAt。
    const foyle = find('Foyle');
    assert.equal(foyle.deadline, '2026-07-31');
    assert.equal(foyle.deadlineAt, undefined, '官網的 midnight 有歧義，不得猜一個時刻');
    assert.equal(foyle.cycle.opens, undefined, '官網未公布開放投稿的月份');
    assert.equal(foyle.cycle.closes, '07-31');
});

test('data：本輪查證到的賽事日期與週期', () => {
    // 科教館官網日程表：「2027 年臺灣國際科學展覽會日程表(暫定) 1/25 (一) ~1/30 (六)」
    // 實施要點：送件「每年十至十一月間臺灣國際科展送件期限內」
    const tisf = find('台灣國際科學展覽會');
    assert.equal(tisf.eventStartsAt, '2027-01-25');
    assert.equal(tisf.eventEndsAt, '2027-01-30');
    assert.equal(tisf.cycle.closes, '11');

    // Conrad 官網 Activation Stage：「Start: August 27, 2026」「End: October 29, 2026」
    // 2026-2027 Student Guide：「October 29, 2026 by 11:59PM CT」，10/29 是 CDT（UTC−5）
    // Innovation Stage：「The submission deadline for all Innovation Stage content is January 7, 2027.」
    // Innovation Summit：April 21-24, 2027
    const conrad = find('Conrad Challenge');
    assert.equal(conrad.deadline, '2026-10-29', 'Activation 階段結束於 10/29，不是 10/30');
    assert.equal(conrad.deadlineAt, '2026-10-29T23:59:00-05:00');
    assert.equal(conrad.eventStartsAt, '2027-04-21');
    assert.equal(conrad.eventEndsAt, '2027-04-24');
    assert.equal(conrad.cycle.closes, '10', '2025-26 季 10/30、2026-27 季 10/29，只寫月份');

    // ESU 官網：「IPSC Week will take place Monday 5 – Friday 9 July 2027」
    //           「Registrations forms are to be filled out by national organisers only」
    // 11/30 是各國主辦單位登記國內選拔賽的期限。官網名單沒有台灣的主辦單位，學生沒有可報名的截止日，不放進 cycle.closes
    const esu = find('ESU 國際公眾演說');
    assert.equal(esu.eventStartsAt, '2027-07-05');
    assert.equal(esu.eventEndsAt, '2027-07-09');
    assert.equal(esu.cycle, undefined);
    assert.ok(esu.registrationNote?.includes('無公開報名'));

    // Brain Bee 主辦單位報名頁：「報名：2026 年 5 月 9 日截止」
    //   第一階段 2026-05-23 筆試、第二階段 2026-06-27 口試
    // 2025 屆官網活動頁的票券販售在 2025-03-20 結束。兩屆截止月份不同，2027 屆公布前不留已過的日期。
    const bee = find('Taiwan Brain Bee');
    assert.equal(bee.deadline, '');
    assert.equal(bee.eventStartsAt, '2026-05-23');
    assert.equal(bee.eventEndsAt, '2026-06-27');
    assert.equal(bee.cycle, undefined, '2025 屆 3/20、2026 屆 5/9 截止，沒有固定月份');
    assert.ok(bee.registrationNote?.includes('2027'));
});

// 資料對了不等於畫面對了。#82 修掉的正是「資料是賽事日期、卡片寫成報名截止」，
// 那個錯誤只在顯示層看得見。這裡把真正的前端函式從 .astro 抽出來跑，
// 把 2026-08-27 當天的卡片文字釘住。
test('display：查證過的競賽在卡片上顯示正確的狀態與日期欄', () => {
    const src = readFileSync(
        new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url),
        'utf8',
    );
    const grab = (name) => {
        const m = src.match(new RegExp(`function ${name}\\((?:[^)]*)\\) \\{[\\s\\S]*?\\n      \\}`));
        assert.ok(m, `在 competitions.astro 抽不到 ${name}——若已改名請同步更新本測試`);
        return m[0];
    };
    const bundle = [
        'todayTaipeiUTC', 'taipeiDayUTC', 'nextOccurrenceUTC', 'fmtUTC',
        'getStatus', 'statusText', 'eventLabel', 'deadlineField', 'deadlineLabel',
    ].map(grab).join('\n');

    // 台北時間 2026-08-27 12:00
    const fixed = new Date('2026-08-27T04:00:00Z').getTime();
    class FixedDate extends Date {
        constructor(...a) {
            super(...(a.length ? a : [fixed]));
        }
        static now() {
            return fixed;
        }
    }
    const f = new Function(
        'Date',
        `${bundle}; return { getStatus, statusText, deadlineField, deadlineLabel };`,
    )(FixedDate);

    const card = (needle) => {
        const c = find(needle);
        const s = f.getStatus(c);
        const d = f.deadlineField(c, s);
        return { status: f.statusText(s), field: d.label, label: d.value };
    };

    // 2026 屆報名已截止、2027 屆未公布：狀態列講報名，日期欄只講上屆的比賽日，不推下一屆。
    assert.deepEqual(card('My First CTF'), {
        status: '2026 屆已截止 · 2027 屆未公布',
        field: '賽事日期',
        label: '上屆 2026-05-16 已結束',
    });

    // 沒有公開報名：狀態列必須說清楚，日期欄顯示賽事日期而不是假的截止日
    assert.deepEqual(card('亞太數學奧林匹亞'), {
        status: '每年 3 月舉行 · 無公開報名',
        field: '賽事日期',
        label: '2027-03-09 舉行',
    });
    assert.deepEqual(card('亞太資訊奧林匹亞'), {
        status: '每年 5 月舉行 · 無公開報名',
        field: '賽事日期',
        label: '上屆 2026-05-09 已結束',
    });

    // 官網未公布下屆截止日：不得出現任何具體日期
    const wha = card('世界歷史學家論文獎');
    assert.equal(wha.status, '2027 年截止日 11 月初公布');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(wha.label), '不得憑空生出一個截止日期');

    // 只辦過兩屆、間隔不固定：顯示賽事日期，不推算下一屆
    const ibridge = card('iBridge');
    assert.equal(ibridge.status, '辦理時間不固定 · 依官網公告');
    assert.equal(ibridge.label, '上屆 2025-12-13 已結束');
    assert.ok(!/下次約/.test(ibridge.status));

    // 報名 9/16 才開放，今天（8/27）不得顯示「報名中」
    assert.equal(card('Diamond Challenge').status, '尚未開放 · 預計 2026-09-16 開放');

    // 報名中的兩筆：剩餘天數以帶時區的精確時刻換算成台北日曆日
    assert.equal(card('哈佛克里姆森商業個案分析賽').status, '報名中 · 剩 49 天');
    assert.equal(card('Conrad Challenge').status, '報名中 · 剩 64 天');

    // 本屆已截止但知道週期
    assert.equal(card('台灣國際學生創意設計大賽').status, '本屆已截止 · 下次約 2027-07-31');

    // 第 24 屆 10/1 才開放報名，日期欄同時講報名期間與上一屆的決賽
    assert.equal(card('育秀盃').label, '預計 2026-10-01 開放報名 · 2026-12-31 截止 · 上屆 2026-04-24 已結束');

    // 2027 屆 10/12 才開放報名，8/27 這天顯示開放日與截止日
    assert.equal(card('台灣國際科學展覽會').label, '預計 2026-10-12 開放報名 · 2026-11-06 截止 · 2027 賽事 1/25–1/30');

    // 沒有 deadline、只有 cycle 與賽事日期的條目：就地建一筆，不靠資料裡剛好有這種條目
    const cycleOnly = { deadline: '', cycle: { closes: '11' }, eventStartsAt: '2027-01-25', eventEndsAt: '2027-01-30' };
    const cs = f.getStatus(cycleOnly);
    assert.deepEqual(
        { status: f.statusText(cs), ...f.deadlineField(cycleOnly, cs) },
        { status: '每年固定辦理 · 下次約 2026-11-30', label: '報名截止', value: '每年約 11 月截止 · 2027 賽事 1/25–1/30' },
    );

    // 沒有任何日期主張的兩筆：狀態列講規則，不得出現數字日期
    for (const needle of ['外交小尖兵', '總統教育獎']) {
        const c = card(needle);
        assert.ok(!/\d{4}-\d{2}-\d{2}/.test(c.status + c.label), `${needle} 不得顯示未經查證的日期`);
    }
});

// 上面那個測試釘的是「這 18 筆現在長什麼樣」，逐筆列舉；這一個釘的是「任何一筆
// 都不可以出現的形狀」，涵蓋日後新增的資料。
//
// 兩種形狀：
//   1. 已辦完的賽事寫成「2025-12-13 舉行」，讀起來像即將舉行，比不顯示還糟。
//   2. 欄位標題與內容各說各話：沒有 deadline、只有 cycle 與賽事日期的條目，標題若只看
//      c.eventStartsAt 就會寫「賽事日期」，內容卻是「每年約 11 月截止 · …」。
//      所以標題與內容都由 deadlineField() 決定。
test('display：已辦完的賽事必須標示為已結束，且欄位標題與內容一致', () => {
    // readFileSync 已在檔案頂端 import（本檔是 ESM，不能用 require）
    const src = readFileSync(
        new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url),
        'utf8',
    );
    const grab = (name) => {
        const m = src.match(new RegExp(`function ${name}\\((?:[^)]*)\\) \\{[\\s\\S]*?\\n      \\}`));
        assert.ok(m, `抽不到 ${name}`);
        return m[0];
    };
    const bundle = [
        'todayTaipeiUTC', 'taipeiDayUTC', 'nextOccurrenceUTC', 'fmtUTC',
        'getStatus', 'statusText', 'eventLabel', 'deadlineField', 'deadlineLabel',
    ].map(grab).join('\n');

    const fixed = new Date('2026-08-27T04:00:00Z').getTime();
    class FixedDate extends Date {
        constructor(...a) { super(...(a.length ? a : [fixed])); }
        static now() { return fixed; }
    }
    const f = new Function('Date', `${bundle}; return { getStatus, deadlineField };`)(FixedDate);

    const data = JSON.parse(
        readFileSync(new URL('../public/advanced-resources/competitions.json', import.meta.url), 'utf8'),
    );
    const TODAY = '2026-08-27';
    const offenders = [];

    for (const c of data.competitions) {
        const s = f.getStatus(c);
        const { label, value } = f.deadlineField(c, s);

        const last = c.eventEndsAt || c.eventStartsAt;
        if (typeof last === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(last) && last < TODAY && !/已結束|上屆/.test(value)) {
            offenders.push(`${c.title}：賽事已於 ${last} 結束，卻顯示「${value}」`);
        }
        if (label === '賽事日期' && /截止|報名/.test(value)) {
            offenders.push(`${c.title}：標題「賽事日期」但內容在講報名——「${value}」`);
        }
    }
    assert.deepEqual(offenders, [], '卡片顯示與事實不符：\n  ' + offenders.join('\n  '));
});

// 2026-08-27 第二輪把剩下的 110 筆「只做過連結存活檢查」的資料逐筆查完。
//
// 上面那一批釘的是第一輪 18 筆。#70 記載當時仍有大量條目從未有人開過官網確認
// 主辦單位、參賽資格與是否仍在辦理。這一輪把它們查完，發現的錯誤同樣全部是
// 「HTTP 200、schema 綠燈、內容卻是錯的」：
//
//   - apho.org 回 114 bytes 的 GoDaddy 待售停放殼，和 conradchallenge.org
//     一模一樣的手法。
//   - www.ijso-official.org 的網域註冊已過期，HTTP 回 Namecheap 停放頁
//     「Domain registration has expired.」，HTTPS 直接交握失敗。
//   - www.sasmo.sg 已失守，301/302 一路轉到 arcade.now 的聯盟廣告頁。
//   - hmun.org 302 轉到 ww1.hmun.org（連線被拒），eucys.eu 回 403。
//   - picoctf.org 只剩 1,685 bytes 的搬遷公告，沒有任何競賽內容。
//   - tmo.com.tw（袋鼠數學的台灣承辦網站）HTTP 200 但 body 只有 9 bytes。
//   - Advent of Code 已改制，2025 年只到 12/12、全球排行榜取消。
//   - AIME 的 AIME I／AIME II 已取消。
//   - 8 筆競賽台灣學生依官網明文條款結構性無法參加、6 筆根本不存在或已停辦。
//
// 每一項下面都附了官網逐字原文。要改這裡的值，請先開官網確認並更新引文。

/** 第二輪逐筆查證涵蓋的競賽（不含第一輪已釘住的那批）。 */
const VERIFIED_ROUND2 = [
    // 台灣全國賽
    '全國中小學科學展覽會', '旺宏科學獎', 'TRML 台灣區高中數學競賽', '全國學生美術比賽',
    'AIS3 新型態資安暑期課程', 'APCS 大學程式設計先修檢測', '全國語文競賽',
    '全國高級中等學校小論文寫作比賽', '全國高中職閱讀心得寫作比賽',
    '全國中小學科學探究競賽—這樣教我就懂', '臺灣青年學生物理辯論競賽 (TYPT)',
    '全國師生本土語及新住民語歌謠比賽', '全國學生音樂比賽', '全國學生舞蹈比賽',
    '普通型高級中等學校數理及資訊學科能力競賽', '臺灣數學奧林匹亞競賽 (TMO)',
    '全國資訊奧林匹亞—台灣選拔賽 (TOI)', '國際科學奧林匹亞—臺灣代表隊選訓',
    'IOAI 臺灣代表隊選拔 (TOAI)',
    // 國際科學奧林匹亞（各科）
    '國際數學奧林匹亞 (IMO)', '國際資訊奧林匹亞 (IOI)', '國際物理奧林匹亞 (IPhO)',
    '國際化學奧林匹亞 (IChO)', '國際生物奧林匹亞 (IBO)',
    '國際天文與天文物理奧林匹亞 (IOAA)', '國際初級天文奧林匹亞 (IOAA-jr)',
    '國際地球科學奧林匹亞 (IESO)',
    // 國際奧林匹亞與國家隊選拔
    'Regeneron ISEF 國際科技展覽會', '國際語言學奧林匹亞 (IOL)', '國際哲學奧林匹亞 (IPO)',
    '國際地理奧林匹亞 (iGeo)', '國際國中科學奧林匹亞 (IJSO)', '亞洲物理奧林匹亞 (APhO)',
    '歐洲女子數學奧林匹亞 (EGMO)', '歐洲女子資訊奧林匹亞 (EGOI)',
    '倫敦國際青年科學論壇 (LIYSF)', '國際數學建模挑戰賽 (IMMC)',
    '國際青年物理學家辯論賽 (IYPT)', '國際經濟學奧林匹亞 (IEO)',
    '世界中學生辯論錦標賽 (WSDC)', '國際人工智慧奧林匹亞 (IOAI)',
    // 程式與資安
    'Codeforces 程式競賽', 'AtCoder 程式競賽', 'CodeChef 程式競賽',
    'LeetCode Weekly Contest', 'USACO 美國資訊奧林匹亞競賽', '加拿大計算機競賽 (CCC)',
    'Project Euler', 'Advent of Code', 'picoCTF', 'HITCON CTF',
    // 資料科學與機器人
    'Kaggle Competitions', 'DrivenData 社會公益資料競賽', 'Zindi 資料科學競賽',
    'AIcrowd 機器學習挑戰賽', 'Technovation', 'FIRST 機器人競賽 (FRC)',
    'VEX 機器人世界錦標賽', 'WRO 世界機器人奧林匹亞', 'iGEM 國際基因工程機器競賽',
    // 數學競賽
    'Purple Comet! Math Meet', '袋鼠數學競賽 (Math Kangaroo)',
    '新加坡與亞洲數學奧林匹亞 (SASMO)', '東南亞數學奧林匹亞 (SEAMO)',
    '國際青少年數學奧林匹亞 (IJMO)', '美國數學競賽 (AMC 10/12)',
    '美國高中生數學邀請賽 (AIME)', '滑鐵盧數學競賽 (Waterloo Math Contests)',
    '美國電腦科學聯盟程式競賽 (ACSL)', '國際數學競賽—澳洲數學競賽 (AMC, Australia)',
    '國際青年數學挑戰賽 (IYMC)', '國際天文與天文物理競賽 (IAAC)',
    // 論文與人文
    'John Locke 論文競賽', 'Cambridge Re:Think 論文競賽', '紐約時報學生寫作競賽',
    'The Concord Review', '哈佛克里姆森全球論文競賽 (HCGEC)', 'Ayn Rand Institute 論文競賽',
    '永續生活信託論文與辯論競賽', 'Bow Seat 海洋意識競賽', 'The Earth Prize 永續創新競賽',
    // 商業、模聯與綜合
    '華頓全球高中投資競賽', 'THIMUN 新加坡模擬聯合國會議', '哈佛模擬聯合國 (HMUN)',
    '哈佛模擬聯合國—中國會議 (HMUN China)', "World Scholar's Cup 世界學者盃",
    '國際歷史競賽—亞洲盃 (IHBB Asia)', 'Blue Ocean 學生創業競賽',
    'USAII 全球 AI 黑客松', 'Major League Hacking (MLH)',
    // 藝術與科學推廣
    'Sony 世界攝影獎—青年組', '全美高中生影展 (AAHSFF)', 'Embracing Our Differences',
    'GENIUS Olympiad 環境主題競賽', '丘成桐中學科學獎', 'Earth Science Week',
];

test('data：第二輪逐筆查證的 96 筆都必須留下查證日期（可更新，不可清掉或倒退）', () => {
    assert.equal(VERIFIED_ROUND2.length, 96, '清單長度變動代表有人動了查證範圍，請一併更新註解與 PR 說明');
    for (const needle of VERIFIED_ROUND2) assertVerified(needle);
});

// 兩輪查完之後，整份資料的每一筆都有人開過官網。只要有人新增條目卻沒查證，
// 這個測試就會紅燈，不必等到學生按著錯的資訊去報名才發現。
test('data：每一筆競賽的 sourceCheckedAt 都必須是可信的查證日期', () => {
    // 驗的是值，不只是欄位在不在。上面兩份清單合計 18 + 96 = 114 筆，資料有
    // 119 筆，只檢查「有沒有填」的話，差額那幾筆填 2099-01-01 或隨手抄一個日期都會過。
    // 共用驗證器套到全體，不留一個只對子集生效的規則。
    const bad = DATA.competitions
        .map((c) => [c.title, sourceCheckedProblem(c.sourceCheckedAt)])
        .filter(([, why]) => why !== null)
        .map(([title, why]) => `${title}：${why}`);
    assert.deepEqual(
        bad,
        [],
        '新增競賽時請先逐項開官網查證（主辦單位、參賽資格、是否仍在辦理、報名截止日），'
        + '並填上查證當天的日期：\n  ' + bad.join('\n  '),
    );
});

// 移除的條目不得被加回來。移除的理由分兩類：
// (a) 台灣學生依官網明文條款結構性無法參加，和 iF Design（只收大學生）是同一類錯誤；
// (b) 競賽根本不存在、已停辦，或官方入口已無法使用。
// 每一筆都附官網逐字原文，要加回來請先推翻下面的引文。
const REMOVED_ROUND2 = [
    // (a) 台灣學生不符資格
    ['Regeneron 科學人才獎',
        'FAQ 逐字：「Students attending American schools abroad, but who are not US citizens, are not eligible.」'
        + '且須「living in and attending their last year of secondary school in the US and its territories」'],
    ['歐洲環境永續奧林匹亞',
        '逐字：「Their country has to be one of the member countries of EOES association」，會員國頁列 25 國全為歐盟'],
    ['歐盟青年科學家競賽',
        'eucys.eu 回 403（239 bytes Apache 錯誤頁）；官方合格國家四類名單皆無 Taiwan／Chinese Taipei，'
        + '且逐字「Direct registrations of individuals or non affiliated organisations are not authorised.」'],
    ['美國學術寫作與藝術獎',
        '逐字：「Teens attending school and residing outside of the United States, U.S. territories or military bases, '
        + 'or Canada, are not eligible」，並明文含「U.S. Department of State Overseas Schools」'],
    ['Genes in Space',
        'FAQ 逐字：「Unfortunately no, the current Genes in Space contest is only open to students in 7-12th grade '
        + 'who live on United States soil (US States and territories).」'],
    ['DECA',
        '官方 chartered associations 共 51 個，非美加者只有 Germany，無 Taiwan；'
        + '加入方式逐字「Contact the DECA advisor at your high school」'],
    ['JA 社會創新挑戰賽',
        '主辦為 Junior Achievement USA，逐字「Only JA Area staff may nominate student teams」且須先修 JA 課程；'
        + 'JA Asia Pacific 會員名單 14 個地區中無台灣'],
    ['美國國家經濟學挑戰賽',
        '美國各州選拔制，逐字「Each state ... will identify a state champion team ... which will represent the state」，'
        + '報名走各州 state competition，官網無任何國際參賽管道'],
    // (b) 競賽不存在、已停辦，或官方入口已無法使用
    ['全球青年創業挑戰賽',
        'gyec.org 是 Global Youth Empowerment Challenge（做諮詢與實習的 NGO），站上沒有任何競賽、報名或截止日'],
    ['華頓全球高中議題寫作競賽',
        'Wharton Global Youth 競賽頁現只列 Investment Competition 與 Data Science Competition；'
        + 'Comment & Win 頁只剩電子報訂閱框，得獎存檔停在 2024'],
    ['ASDAN 全球商業實戰挑戰賽',
        'seedasdan.com 是北京世纪思德国际教育科技（阿思丹／ASEEDER），站上沒有 BPA 也沒有「全球商業實戰挑戰賽」；'
        + 'BPA 中國賽由另一家 SKT 教育營運。此條目是三個不相干實體的拼接'],
    ['Meta Hacker Cup',
        '唯一官方網址 facebook.com/codingcompetitions/hacker-cup 對未登入者無內容（帶瀏覽器 UA 回 HTTP 400），'
        + '2026 賽季無公告，資格條文無法從任何官方來源取得'],
    ['國際天文奧林匹亞 (IAO)',
        'https://issp.ac.ru/iao/ 連線逾時；純 HTTP 版是 frameset 空殼，「Coming events」仍列 2025 年 11 月的活動、'
        + '屆數清單只到 2024，且查無台灣參賽。台灣實際參加的是 IOAA'],
    ['全國高中職創新創業競賽',
        '青年發展署「創新創業」分類下 6 項計畫查無此競賽，也查無「青年圓夢計畫」；U-start 明文限大專。'
        + '該署唯一面向高中職的是「智慧鐵人創意競賽」'],
];

test('data：本輪移除的 14 筆不得被加回來', () => {
    // 這個數字是承重的：清單被清空的話，底下的迴圈一圈都不會跑，這支測試就會
    // 「通過」而且什麼都沒檢查。改動筆數時要連同下面的理由一起改，不是把數字調大。
    assert.equal(
        REMOVED_ROUND2.length,
        14,
        `REMOVED_ROUND2 現在是 ${REMOVED_ROUND2.length} 筆。這份清單是本輪查證的結果，`
            + '不是可以隨手增減的常數——每一筆都對應一次實際的官網查核。',
    );
    for (const [needle, reason] of REMOVED_ROUND2) {
        const hits = DATA.competitions.filter((c) => c.title.includes(needle));
        assert.deepEqual(
            hits.map((c) => c.title),
            [],
            `「${needle}」已於 2026-08-27 查證後移除，不得再出現。理由：${reason}`,
        );
    }
});

test('data：第二輪修掉的停放與空殼網址不得被改回去', () => {
    // tpmso.org 底下全部是 233–235 bytes 的 meta refresh 空殼：
    //   <meta http-equiv="refresh" content="0;url=https://tpmso.k12ea.gov.tw/tmo/" />
    // 帶瀏覽器 UA 才拿得到 tpmso.k12ea.gov.tw 的真實內容（無 UA 會被 302 到 errors.html）。
    assert.equal(find('臺灣數學奧林匹亞競賽').url, 'https://tpmso.k12ea.gov.tw/tmo/');
    assert.equal(find('全國資訊奧林匹亞—台灣選拔賽').url, 'https://tpmso.k12ea.gov.tw/toi/');
    assert.equal(find('國際科學奧林匹亞—臺灣代表隊選訓').url, 'https://tpmso.k12ea.gov.tw/ipho/');

    // apho.org 回 114 bytes：<script>window.onload=function(){window.location.href="/lander"}</script>
    // 與 conradchallenge.org 同一個停放手法。APhO 無常設官網，所以指向臺灣選訓辦公室。
    assert.equal(find('亞洲物理奧林匹亞').url, 'https://tpmso.k12ea.gov.tw/ipho/');

    // www.ijso-official.org：HTTPS 交握失敗；HTTP 回 Namecheap 停放頁「Domain registration has expired.」
    assert.equal(find('國際國中科學奧林匹亞').url, 'https://ijsoweb.org/');

    // www.sasmo.sg → 301 → sasmo.sg → 302 → arcade.now/lp1/play?subid=sasmo.sg（聯盟廣告頁）
    assert.equal(find('新加坡與亞洲數學奧林匹亞').url, 'https://sasmo.simcc.org/');

    // hmun.org 302 → ww1.hmun.org（connection refused）
    assert.equal(find('哈佛模擬聯合國 (HMUN)').url, 'https://www.harvardmun.org/');

    // picoctf.org 只剩搬遷公告：「picoCTF.org is now CyLab Security Academy」「Coming Soon: picoCTF.com」
    assert.ok(!/picoctf\.org/.test(find('picoCTF').url), 'picoctf.org 已無競賽內容');

    // yau-awards.com 是中國內地賽區；官方規則逐字劃分「海外賽區（亞洲賽區）報名範圍：
    // 除中國內地外，中國港澳台地區及亞洲其他國家的中學生」，台灣學生必須走亞洲賽區。
    assert.equal(find('丘成桐').url, 'https://yauaward-asia.hk');

    // 小論文與閱讀心得的承辦學校與截止日都不同，不能共用 shs.edu.tw 首頁，必須各指子頁。
    assert.notEqual(
        find('小論文寫作比賽').url,
        find('閱讀心得寫作比賽').url,
        '兩者截止日與承辦學校都不同，不可共用同一個 URL',
    );

    // 鄉土歌謠比賽 115 學年度起更名，專網是 /country/，不是藝教館首頁。
    assert.equal(find('本土語及新住民語歌謠比賽').url, 'https://web.arte.gov.tw/country/');

    // 本輪最嚴重的一筆：ieso-info.org 已被轉作澳洲線上博弈網站，
    // 頁面標題逐字「Best Online Pokies in Australia 2026 - Play For Real Money」，
    // 內文推銷 Royal Reels、The Pokies 等賭場並附「$500 + $10 NO DEPOSIT」入金優惠。
    // 連結健檢只看狀態碼會回報 200 健康，等於把高中生導去線上賭場。
    assert.ok(
        !/ieso-info\.org/.test(find('國際地球科學奧林匹亞').url),
        'ieso-info.org 已成線上博弈網站，絕不可再指向該網域',
    );
    assert.equal(find('國際地球科學奧林匹亞').url, 'https://tpmso.k12ea.gov.tw/ieso/');

    // ipho2026.com 是單屆網站；臺灣物奧選訓辦公室連結的常設官網是 ipho-new.org
    assert.equal(find('國際物理奧林匹亞').url, 'https://www.ipho-new.org/');

    // 全域護欄：這些網域整份資料都不該再出現
    const DEAD_HOSTS = [
        /^https?:\/\/(www\.)?tpmso\.org/, /^https?:\/\/(www\.)?apho\.org/,
        /^https?:\/\/(www\.)?ijso-official\.org/, /^https?:\/\/(www\.)?sasmo\.sg/,
        /^https?:\/\/(www\.)?hmun\.org/, /^https?:\/\/(www\.)?eucys\.eu/,
        /^https?:\/\/(www\.)?conradchallenge\.org/, /^https?:\/\/(www\.)?yau-awards\.com/,
        /^https?:\/\/(www\.)?roboticseducation\.org/, /^https?:\/\/competitions\.igem\.org/,
        /^https?:\/\/(www\.)?ieso-info\.org/, /^https?:\/\/(www\.)?ipho2026\.com/,
        /^https?:\/\/(www\.)?issp\.ac\.ru/,
    ];
    const offenders = DATA.competitions
        .filter((c) => DEAD_HOSTS.some((re) => re.test(c.url)))
        .map((c) => `${c.title} → ${c.url}`);
    assert.deepEqual(offenders, [], '這些網域已確認為停放、過期、空殼或不存在：\n  ' + offenders.join('\n  '));
});

// 這是本專案重複踩過的錯誤（OPhO、My First CTF、iBridge、育秀盃）。
test('data：賽事日期不得被寫成報名截止（第二輪）', () => {
    // CEMC 官網把兩者分列：「Thursday, February 11, 2027」是學校訂購截止，
    // 「Thursday, February 18, 2027」是北美與南美以外地區（台灣適用）的競賽日。
    const ccc = find('加拿大計算機競賽');
    assert.equal(ccc.deadline, '2027-02-11');
    assert.equal(ccc.eventStartsAt, '2027-02-18', '2/18 是比賽日，不是報名截止日');

    // MAA amcreg：「Regular Registration Deadline: October 15, 2026」是報名截止；
    // 「AMC 10/12 A Competition Date: November 5, 2026」「B: November 13, 2026」是考試日。
    const amc = find('美國數學競賽 (AMC 10/12)');
    assert.equal(amc.deadline, '2026-10-15');
    assert.equal(amc.eventStartsAt, '2026-11-05');
    assert.equal(amc.eventEndsAt, '2026-11-13');

    // APCS：2027-01-10 檢測場的報名期是「2026年11月23日-12月11日」，「每日9:00至18:00開放報名」。
    const apcs = find('APCS');
    assert.equal(apcs.deadline, '2026-12-11');
    assert.equal(apcs.deadlineAt, '2026-12-11T18:00:00+08:00');
    assert.equal(apcs.opensAt, '2026-11-23T09:00:00+08:00');
    assert.equal(apcs.eventStartsAt, '2027-01-10', '1/10 是檢測日，不是報名截止日');

    // 旺宏科學獎第 25 屆（2026）：報名 5/20 15:00 截止、8/21 繳成果報告書、9/5–9/6 才是決賽。
    const mx = find('旺宏科學獎');
    assert.equal(mx.eventStartsAt, '2026-09-05');
    assert.equal(mx.eventEndsAt, '2026-09-06');
    assert.equal(mx.deadline, '', '第 25 屆報名已於 2026-05-20 截止、下屆時程未公告，不得填舊日期');

    // FRC：官方 2026-06-17 貼文逐字「The season registration due date is November 17, 2026.」
    // FIRST Championship 2027-04-28 至 05-01 是賽事日期。
    const frc = find('FIRST 機器人競賽');
    assert.equal(frc.deadline, '2026-11-17');
    assert.equal(frc.eventStartsAt, '2027-04-28');
    assert.equal(frc.eventEndsAt, '2027-05-01');

    // 全國科展：報名 6/1–6/10、全國賽 7/13–7/19，三級選拔、不受理個人報名。
    const twsf = find('全國中小學科學展覽會');
    assert.equal(twsf.deadline, '');
    assert.equal(twsf.eventStartsAt, '2026-07-13');
    assert.ok(twsf.registrationNote?.includes('個人'), '應說明不受理個人報名，而不是留白');
});

test('data：官網明講「尚未公布」的競賽不得被補上猜測日期', () => {
    // 官網競賽區塊顯示「Unable to load contest information. Please check back later.」與「NEXT DEADLINE / TBD」
    const ari = find('Ayn Rand');
    assert.equal(ari.deadline, '');
    assert.ok(ari.registrationNote?.includes('TBD'));

    // 官網時程寫報名到 2027-03-11 23:59 UTC，但報名平台逐字「Registration is currently closed」、
    // Get Involved 頁逐字「Student registration is closed」。填了截止日卡片就會顯示「報名中」，
    // 所以截止日留空，用 registrationNote 說明。
    const techno = find('Technovation');
    assert.equal(techno.deadline, '');
    assert.equal(techno.deadlineAt, undefined);
    assert.ok(techno.registrationNote?.includes('2027-03-11'));

    // Purple Comet 全站查無報名截止日，只有 2027-04-06 至 04-15 的競賽視窗
    const purple = find('Purple Comet');
    assert.equal(purple.deadline, '');
    assert.equal(purple.eventStartsAt, '2027-04-06');
    assert.equal(purple.eventEndsAt, '2027-04-15');

    // SEAMO 官網的 Exam Period Starts／Registration Start Date／Registration Deadline／Region 全部是 N/A
    const seamo = find('東南亞數學奧林匹亞');
    assert.equal(seamo.deadline, '');
    assert.ok(seamo.registrationNote?.includes('N/A'));

    // Embracing Our Differences 的官方投稿平台逐字顯示「There are presently no open calls for submissions.」
    for (const needle of ['Embracing Our Differences', 'John Locke']) {
        const c = find(needle);
        assert.equal(c.deadline, '', `${needle} 的下一屆截止日官網尚未公布，不得猜`);
        assert.ok(c.registrationNote, `${needle} 應以 registrationNote 說明狀態，而不是留白`);
    }
});

// Sony WPA 青年組逐字「5 January 2027 at 16:00 (GMT)」，正好是台灣 1/6 00:00。卡片用截止時刻的台北日曆日
// 倒數，補上 deadlineAt 的話 1/5 當天會顯示「即將截止 · 剩 1 天」，所以只填日期。卡片狀態用頁面自己的函式算。
test('data：Sony 青年組的截止時刻落在台北午夜，只填日期，1/5 當天卡片顯示今日截止', () => {
    const sony = find('Sony 世界攝影獎');
    assert.equal(sony.deadline, '2027-01-05');
    assert.equal(sony.deadlineAt, undefined);
    // 總覽頁逐字「1 June 0:00 BST」
    assert.equal(sony.opensAt, '2026-06-01T00:00:00+01:00');

    const src = readFileSync(new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url), 'utf8');
    const grab = (name) => {
        const m = src.match(new RegExp(`function ${name}\\((?:[^)]*)\\) \\{[\\s\\S]*?\\n      \\}`));
        assert.ok(m, `在 competitions.astro 抽不到 ${name}`);
        return m[0];
    };
    const bundle = ['todayTaipeiUTC', 'taipeiDayUTC', 'nextOccurrenceUTC', 'fmtUTC', 'getStatus', 'statusText']
        .map(grab).join('\n');
    const statusAt = (c, iso) => {
        const fixed = Date.parse(iso);
        class FixedDate extends Date {
            constructor(...a) { super(...(a.length ? a : [fixed])); }
            static now() { return fixed; }
        }
        const f = new Function('Date', `${bundle}; return { getStatus, statusText };`)(FixedDate);
        return f.statusText(f.getStatus(c));
    };
    assert.equal(statusAt(sony, '2027-01-05T09:00:00+08:00'), '今日截止');
    assert.equal(statusAt(sony, '2027-01-05T23:59:59+08:00'), '今日截止');
    assert.equal(statusAt(sony, '2027-01-06T00:00:01+08:00'), '已截止');
    assert.equal(
        statusAt({ ...sony, deadlineAt: '2027-01-05T16:00:00Z' }, '2027-01-05T09:00:00+08:00'),
        '即將截止 · 剩 1 天',
        '補上 deadlineAt 時同一刻會多算一天，這是只填日期的理由',
    );
});

// 2026-10-23 重查時，這幾筆的官網已經公布下一屆時程，日期照官網填，官網寫明時刻的也一併填上。
test('data：重查時官網已公布下一屆時程的競賽，日期照官網填', () => {
    // 逐字「CONTEST DEADLINE: JUNE 7, 2027, 11:59 PM EDT」；2027 屆起改稱 Blue Planet Awareness Contest
    const bowSeat = find('Bow Seat');
    assert.equal(bowSeat.deadline, '2027-06-07');
    assert.equal(bowSeat.deadlineAt, '2027-06-07T23:59:00-04:00');
    assert.equal(bowSeat.cycle, undefined, '不得用單一屆的日期推一個年度週期');

    // 逐字「Registration for The Earth Prize 2027 is open until 10th of January 2027.」
    const earthPrize = find('The Earth Prize');
    assert.equal(earthPrize.deadline, '2027-01-10');
    assert.equal(earthPrize.cycle, undefined);

    // 逐字「Submissions Open: Monday, November 2nd, 2026」「Final Deadline: Friday, July 2nd, 2027」。
    // 開放前卡片不得顯示「報名中」，所以要有 opensAt；官網沒寫時刻，取主辦地紐約當天 00:00。
    const aahsff = find('全美高中生影展');
    assert.equal(aahsff.deadline, '2027-07-02');
    assert.equal(aahsff.opensAt, '2026-11-02T00:00:00-05:00');

    // FAQ 逐字「Registration: Open Oct 1, 2026 – Feb 10, 2027」，截止時刻是 GMT+0 的 23:59
    const hcgec = find('哈佛克里姆森全球論文競賽');
    assert.equal(hcgec.deadline, '2027-02-10');
    assert.equal(hcgec.deadlineAt, '2027-02-10T23:59:00Z');

    // TYPT 第 19 屆逐字「報名期間：115. 10. 15 （中午開始報名）~ 116. 01. 28 (中午12:00截止)」
    // 「競賽日期：116. 03. 05 ~ 116. 03. 08」。報名系統頁寫到 23:59:59，和公告不一致；報名規則頁逐字
    // 「官方公告之報名截止日後（詳見首頁）系統將關閉」，所以以首頁公告的中午為準。
    const typt = find('臺灣青年學生物理辯論競賽');
    assert.equal(typt.deadline, '2027-01-28');
    assert.equal(typt.deadlineAt, '2027-01-28T12:00:00+08:00');
    assert.equal(typt.eventStartsAt, '2027-03-05');
    assert.equal(typt.eventEndsAt, '2027-03-08');
    assert.match(typt.description, /116\. 03\. 05 ~ 116\. 03\. 08/, '請保留官網逐字原文');

    // 有截止日時卡片不顯示 registrationNote，這幾筆不留著它
    for (const c of [bowSeat, earthPrize, aahsff, hcgec, typt]) assert.equal(c.registrationNote, undefined, c.title);
});

test('data：第二輪查到確切時刻的競賽必須保留時區位移', () => {
    // 小論文：「第二學期自116年2月1日（星期一）起至3月15日（星期一）中午12時止」
    const essay = find('小論文寫作比賽');
    assert.equal(essay.deadline, '2027-03-15');
    assert.equal(essay.deadlineAt, '2027-03-15T12:00:00+08:00');

    // 閱讀心得：「第二學期：116年2月1日（星期一）至3月10日（星期三）中午12時止」
    const reading = find('閱讀心得寫作比賽');
    assert.equal(reading.deadline, '2027-03-10');
    assert.equal(reading.deadlineAt, '2027-03-10T12:00:00+08:00');
    assert.notEqual(reading.deadline, essay.deadline, '兩者截止日不同，不可互相污染');

    // Wharton：「August 10, 2026 through September 11, 2026」「Registration closes ... (5:00 p.m. ET)」
    const wharton = find('華頓全球高中投資競賽');
    assert.equal(wharton.deadlineAt, '2026-09-11T17:00:00-04:00');
    assert.equal(wharton.eventStartsAt, '2027-04-29');

    // AGI：「All eligible submissions must be received electronically by 8:00 PM ET, Friday, October 16, 2026.」
    assert.equal(find('Earth Science Week').deadlineAt, '2026-10-16T20:00:00-04:00');

    // GENIUS 官方（TENTATIVE）日程：「March 1, 11.59 PM EST Application DEADLINE」
    const genius = find('GENIUS Olympiad');
    assert.equal(genius.deadline, '2027-03-01');
    assert.equal(genius.deadlineAt, '2027-03-01T23:59:00-05:00');
    assert.equal(genius.eventStartsAt, '2027-06-07');

    // IYMC 2026 屆：「The deadline for the Qualification Round is: Sunday, 27 September 2026, 23:59 UTC+0」，已過。
    // 2025 屆題目卷：「Submit your solution by Sunday, 30 November 2025, 23:59 UTC+0 online!」
    // 兩屆月份不同，不能用 cycle 推下一屆；2027 屆公布前比照旺宏，不留已過的日期。
    const iymc = find('國際青年數學挑戰賽');
    assert.equal(iymc.deadline, '');
    assert.equal(iymc.cycle, undefined, '2025 屆 11/30、2026 屆 9/27，沒有固定月份');
    assert.ok(iymc.registrationNote?.includes('2027'));

    // 全體護欄
    for (const needle of VERIFIED_ROUND2) {
        const c = find(needle);
        for (const f of ['deadlineAt', 'opensAt']) {
            if (c[f] === undefined) continue;
            assert.match(c[f], /(Z|[+-]\d{2}:\d{2})$/, `${needle} 的 ${f} 缺少時區位移`);
        }
    }
});

test('data：#138 補上的週期與新截止日', () => {
    // HMUN Application Process：「Late Registration Deadline: November 1, 2026」。
    // 往年 Late 截止 2022-11-15、2023-11-01、2024-11-01、2025-12-01；2024 年起都是 6/1 開放報名
    const hmun = find('哈佛模擬聯合國 (HMUN)');
    assert.equal(hmun.deadline, '2026-11-01');
    assert.equal(hmun.cycle.closes, '11');
    assert.equal(hmun.cycle.opens, '06', '2022、2023 年是 5 月開放，只寫月份');

    // TISF 2027 報名作業注意事項：「報名期間：115年10月12日(一)至115年11月6日(五)下午5時止」
    const tisf = find('台灣國際科學展覽會');
    assert.equal(tisf.deadline, '2026-11-06');
    assert.equal(tisf.deadlineAt, '2026-11-06T17:00:00+08:00');
    assert.equal(tisf.opensAt, '2026-10-12T00:00:00+08:00');

    // 往年截止日：Wharton 2024-09-13、2025-09-12、2026-09-11；
    // AMC 10/12 一般報名 2024-10-22、2025-10-15、2026-10-15；ACSL 2023-24 起四季都是 December 31；
    // FRC 官網「The season team registration fee due date is in mid-November」；
    // Earth Science Week 2023-10-13、2024-10-18、2025-10-17、2026-10-16
    assert.equal(find('華頓全球高中投資競賽').cycle.closes, '09');
    assert.equal(find('美國數學競賽 (AMC 10/12)').cycle.closes, '10', '2024 年是 10/22，只能寫月份');
    assert.equal(find('ACSL').cycle.closes, '12-31');
    assert.equal(find('FIRST 機器人競賽').cycle.closes, '11');
    assert.equal(find('Earth Science Week').cycle.closes, '10');
});

test('data：本輪更正的名稱與制度變動不得被改回舊值', () => {
    // 官網頁尾逐字：「Cambridge Centre for International Research, Ltd is not affiliated to
    // the University of Cambridge or its constituent colleges.」標題不得再暗示是劍橋大學主辦。
    const rethink = find('Cambridge Re:Think');
    assert.match(rethink.title, /非劍橋大學主辦/);
    assert.match(rethink.organizer, /Cambridge Centre for International Research/);

    // 官方實施要點首行逐字：「115 學年度全國師生本土語及新住民語歌謠比賽實施要點」
    assert.match(find('本土語及新住民語歌謠比賽').title, /原鄉土歌謠比賽/);

    // 國教署業務頁標題逐字：「普通型高級中等學校數理及資訊學科能力競賽」
    assert.match(find('普通型高級中等學校數理及資訊').title, /^普通型高級中等學校/);

    // 官網逐字「Taiwan Regions Mathematics League」，且第 28 屆 2026-08-15~16 剛辦完，並未停辦
    const trml = find('TRML');
    assert.match(trml.title, /台灣區高中數學競賽/);
    assert.equal(trml.eventStartsAt, '2026-08-15');
    assert.equal(trml.eventEndsAt, '2026-08-16');

    // Advent of Code 官網逐字：「puzzles come out every day (ending mid-December)」，
    // 且「Advent of Code 2025 doesn't have a global leaderboard.」
    const aoc = find('Advent of Code');
    assert.match(aoc.description, /12 題|12\/12/);
    assert.match(aoc.description, /排行榜/);

    // AIME 官網 FAQ 逐字：「Are there still two AIME exams, AIME I and AIME II? No」
    const aime = find('美國高中生數學邀請賽');
    assert.ok(!/AIME I\b|AIME II/.test(aime.description) || /已取消/.test(aime.description),
        'AIME I／AIME II 已取消，描述不得再把它們當成現行制度');
    assert.equal(aime.eventStartsAt, '2027-02-05');
    assert.equal(aime.eventEndsAt, '2027-02-06');
    assert.match(aime.url, /maa-invitational-competitions/);

    // IJSO 官網逐字：「for students who are fifteen years or younger on 31st December of the
    // competition year」，且 2026 屆在保加利亞索菲亞（舊資料寫德國是錯的）
    const ijso = find('國際國中科學奧林匹亞');
    assert.match(ijso.description, /fifteen years or younger on 31st December/);
    assert.match(ijso.registrationNote, /15 歲以下/, '年齡上限必須出現在狀態列，不能只藏在描述裡');
    assert.match(ijso.description, /保加利亞/);
    assert.ok(!/德國/.test(ijso.description), '2026 屆在索菲亞，德國是錯的');

    // LIYSF 官網逐字「Participation is open to students of science aged between 16 and 21 years old」，
    // 且「The participation fee/charge is £3,450.00 GBP per student.」，是公開申請不是邀請制。
    const liysf = find('倫敦國際青年科學論壇');
    assert.equal(liysf.eligibility, '公開報名');
    assert.match(liysf.description, /3,450/);

    // EGMO／EGOI 的台灣參賽為真：官網國家頁列有 Taiwan (TWN)／Taiwan
    assert.match(find('歐洲女子數學奧林匹亞').description, /Taiwan/);
    assert.match(find('歐洲女子資訊奧林匹亞').description, /Taiwan|台灣/);

    // 官網 How to participate 的參加國名單中沒有台灣，要據實寫出，不得暗示台灣有選拔管道。
    assert.match(find('國際哲學奧林匹亞').description, /未見台灣|查無台灣/);

    // 年齡門檻警語：留在清單裡但必須標明，否則就是下一個 iF Design
    assert.match(find('DrivenData').description, /18/);
    assert.match(find('Zindi').description, /18/);
    assert.match(find('Kaggle').description, /家長|監護/);

    // Earth Science Week 四項競賽中只有攝影與影片對國際開放
    assert.match(find('Earth Science Week').description, /美國居民|residents of the United States/);

    // www.ichosc.org 是 IChO 國際指導委員會的官網，不是台灣的委員會；
    // 官網時程逐字：「2026 July 10-19, Uzbekistan」「2027 July 19-28, Chinese Taipei」
    const icho = find('國際化學奧林匹亞');
    assert.match(icho.organizer, /International Chemistry Olympiad Steering Committee/);
    assert.equal(icho.eventStartsAt, '2026-07-10');
    assert.equal(icho.eventEndsAt, '2026-07-19');
    assert.match(icho.description, /2027 July 19-28, Chinese Taipei/, '2027 由我國主辦，是對台灣學生最重要的資訊');

    // IOAA 官網逐字：「19th IOAA 2026 25.9. - 5.10. Hanoi, Vietnam」；
    // Junior IOAA 官網逐字：「an annual competition for junior high school students under the age of 16」，
    // 第 5 屆「between the 1st and 8th November 2026 in Ubon Ratchathani, Thailand」
    const ioaa = find('國際天文與天文物理奧林匹亞');
    assert.equal(ioaa.eventStartsAt, '2026-09-25');
    assert.equal(ioaa.eventEndsAt, '2026-10-05');
    const ioaaJr = find('國際初級天文奧林匹亞');
    assert.equal(ioaaJr.eventStartsAt, '2026-11-01');
    assert.equal(ioaaJr.eventEndsAt, '2026-11-08');
    assert.match(ioaaJr.description, /under the age of 16/);
    assert.notEqual(ioaaJr.url, ioaa.url, 'IOAA-jr 是獨立賽事，應指向 Junior IOAA 專頁');

    // IMO 官網：2026「Shanghai, People's Republic of China - July 10-21, 2026」、
    // 2027「The 68th IMO ... Budapest, Hungary (July 16-26, 2027)」
    const imo = find('國際數學奧林匹亞');
    assert.equal(imo.eventStartsAt, '2026-07-10');
    assert.equal(imo.eventEndsAt, '2026-07-21');
    assert.match(imo.description, /布達佩斯|Budapest/);

    // IOI 官網：2026 Uzbekistan「from August 9th to 16th」、「Germany was selected to host IOI 2027」
    const ioi = find('國際資訊奧林匹亞');
    assert.equal(ioi.eventStartsAt, '2026-08-09');
    assert.equal(ioi.eventEndsAt, '2026-08-16');

    // IBO 官網 Future IBOs：第 38 屆 2027 年 7 月 18-25 日於波蘭華沙
    const ibo = find('國際生物奧林匹亞');
    assert.equal(ibo.eventStartsAt, '2027-07-18');
    assert.equal(ibo.eventEndsAt, '2027-07-25');

    // 臺灣地科選訓官網「主辦國家」表：第 19 屆／2026／Torino 杜林／義大利；國際賽 8/20–8/27
    const ieso = find('國際地球科學奧林匹亞');
    assert.equal(ieso.eventStartsAt, '2026-08-20');
    assert.equal(ieso.eventEndsAt, '2026-08-27');
    assert.match(ieso.description, /博弈|Pokies/, '必須留下「原網域已成博弈站」的警告，否則下次又會被改回去');
});

// #70 在 2026-10-25 更正的描述。每一句的官網原文寫在更正它的 commit 訊息裡。
test('data：#70 在 2026-10-25 更正的描述不得被改回舊說法', () => {
    // 完整結果 PDF 的 Country/Region Represented 欄逐字「Taiwan, China」，每個國家／地區至多 2 隊
    const immc = find('國際數學建模挑戰賽').description;
    assert.match(immc, /「Taiwan, China」/);
    assert.ok(!/未見 Chinese Taipei|沒有獨立賽區/.test(immc), 'IMMC 的 2026 年結果有 2 隊來自台灣的學校');

    // 賽事規則、Code of Conduct、服務條款都有參賽與年齡條文
    assert.ok(!/未刊登年齡或國籍限制/.test(find('CodeChef').description));

    // 條款 1.3 在 2026 年 9 月到 10 月之間從 13:00 改成 16:00 (GMT)
    const sony = find('Sony 世界攝影獎').description;
    assert.match(sony, /5 January 2027 at 16:00 \(GMT\)/);
    assert.ok(!/13:00/.test(sony), 'Sony 青年組現在只寫 16:00 (GMT)');

    assert.ok(!/沒有加註任何免責聲明/.test(find('哈佛克里姆森全球論文競賽').description), '要寫明查了哪些頁');
    assert.ok(!/帶一般瀏覽器 User-Agent/.test(find('LeetCode').description), '單日實測不寫進描述');
    // APhO 的常設網站還在（只有 http，2018 年之後沒更新）
    assert.ok(!/沒有常設官網/.test(find('亞洲物理奧林匹亞').description));

    // 卡片用 escapeHtml 顯示描述，Markdown 記號會原樣出現在畫面上
    const marked = DATA.competitions.filter((c) => /\*\*|`/.test(c.description)).map((c) => c.title);
    assert.deepEqual(marked, [], '描述不得含 ** 或反引號');
});

test('display：第二輪查證的競賽在卡片上顯示正確的狀態與日期欄', () => {
    const src = readFileSync(
        new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url),
        'utf8',
    );
    const grab = (name) => {
        const m = src.match(new RegExp(`function ${name}\\((?:[^)]*)\\) \\{[\\s\\S]*?\\n      \\}`));
        assert.ok(m, `在 competitions.astro 抽不到 ${name}`);
        return m[0];
    };
    const bundle = [
        'todayTaipeiUTC', 'taipeiDayUTC', 'nextOccurrenceUTC', 'fmtUTC',
        'getStatus', 'statusText', 'eventLabel', 'deadlineField', 'deadlineLabel',
    ].map(grab).join('\n');

    const fixed = new Date('2026-08-27T04:00:00Z').getTime();
    class FixedDate extends Date {
        constructor(...a) { super(...(a.length ? a : [fixed])); }
        static now() { return fixed; }
    }
    const f = new Function(
        'Date',
        `${bundle}; return { getStatus, statusText, deadlineField };`,
    )(FixedDate);

    const card = (needle) => {
        const c = find(needle);
        const s = f.getStatus(c);
        const d = f.deadlineField(c, s);
        return { status: f.statusText(s), field: d.label, label: d.value };
    };

    // 報名截止與考試日並陳，且欄位標題是「報名截止」而不是「賽事日期」
    assert.deepEqual(card('APCS'), {
        status: '尚未開放 · 預計 2026-11-23 開放',
        field: '報名截止',
        label: '預計 2026-11-23 開放報名 · 2026-12-11 截止 · 2027-01-10 舉行',
    });
    assert.deepEqual(card('加拿大計算機競賽'), {
        status: '報名中 · 剩 168 天',
        field: '報名截止',
        label: '2027-02-11 · 2027-02-18 舉行',
    });

    // 小論文與閱讀心得必須顯示各自的截止日，不能同一天
    assert.equal(card('小論文寫作比賽').label, '預計 2027-02-01 開放報名 · 2027-03-15 截止');
    assert.equal(card('閱讀心得寫作比賽').label, '預計 2027-02-01 開放報名 · 2027-03-10 截止');

    // 報名已結束、但決賽還沒到：狀態講報名、日期欄講賽事，且不得顯示成「已結束」
    assert.deepEqual(card('旺宏科學獎'), {
        status: '第 25 屆已截止 · 下屆依官網公告',
        field: '賽事日期',
        label: '2026 賽事 9/5–9/6',
    });

    // 沒有公開報名的：狀態列必須說清楚，日期欄顯示賽事而不是假的截止日
    assert.deepEqual(card('亞洲物理奧林匹亞'), {
        status: '每年 5 月舉行 · 無公開報名',
        field: '賽事日期',
        label: '2027 賽事 5/16–5/24',
    });
    assert.equal(card('臺灣數學奧林匹亞競賽').status, '須由就讀學校報名 · 不接受個人報名');
    assert.equal(card('普通型高級中等學校數理及資訊').status, '經校內初賽選拔 · 無個人報名');

    // 官網未公布下屆時程的，不得出現任何具體日期
    for (const needle of ['Ayn Rand', '東南亞數學奧林匹亞']) {
        const c = card(needle);
        assert.ok(
            !/\d{4}-\d{2}-\d{2}/.test(c.status + c.label),
            `${needle} 不得顯示未經查證的日期，實際顯示「${c.status}／${c.label}」`,
        );
    }

    // 報名中的：剩餘天數以帶時區的精確時刻換算成台北日曆日
    assert.equal(card('華頓全球高中投資競賽').status, '即將截止 · 剩 16 天');
    assert.equal(card('Earth Science Week').status, '報名中 · 剩 51 天');
    assert.equal(card('FIRST 機器人競賽').status, '報名中 · 剩 82 天');

    // 尚未開放報名的不得顯示「報名中」
    assert.equal(card('GENIUS Olympiad').status, '尚未開放 · 預計 2026-12-15 開放');
    assert.equal(card('美國數學競賽 (AMC 10/12)').status, '尚未開放 · 預計 2026-09-02 開放');
});
