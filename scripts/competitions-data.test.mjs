/**
 * competitions.json 的「逐筆查證結果」回歸測試
 * --------------------------------------------------------------
 * check-competitions.probe.test.mjs 測的是**規則**（schema、探測、狀態機）。
 * 這一支測的是**事實**：每一筆逐項開過官網查證的競賽，其報名時程與賽事日期
 * 不得被改回錯的值。
 *
 * 為什麼需要它：#63 → #66 → #68 是同一批過期資料反覆觸發的三個 PR，而 #70
 * 記載「大量條目只做過 HTTP status check，沒有逐頁驗證」。schema 綠燈證明不了
 * 值是對的——2026-08-27 這一輪逐筆查證發現的錯誤，全部都是「格式完全合法、
 * 內容卻是錯的」：
 *
 *   - My First CTF 的 cycle.closes 是「05」，但 5 月是**比賽日期**，
 *     報名其實 4/19 就截止了（官網：報名「自 115 年 4 月 1 日上午 10 點至
 *     115 年 4 月 19 日下午 5 點止」、競賽「115 年 5 月 16 日(六)」）。
 *   - iBridge 的 cycle.closes 是「12」，同樣是比賽月份；報名 11/28 就截止。
 *   - APMO／APIO 是國家隊選拔、根本沒有公開報名，cycle.closes 卻讓卡片寫出
 *     「每年約 3 月截止」「每年約 5 月截止」這種不存在的報名截止。
 *   - Conrad Challenge 的官網網域已停放（HTTPS 交握失敗、HTTP 導向 /lander），
 *     但看門狗的連結分類會把交握失敗歸為「無法判定」而不是「失效」。
 *   - 世界歷史學家論文獎的「每年 5 月 1 日截止」只存在於已下線的 archive 站；
 *     現行官網逐字寫「The deadline for 2027 will be announced in September.」
 *
 * 每一項下面都附了官網逐字原文。要改這裡的值，請先開官網確認並更新引文。
 */
import test from 'node:test';
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

test('data：這一輪逐筆查證的 18 筆都必須留下查證日期', () => {
    for (const needle of VERIFIED_2026_08_27) {
        assert.equal(
            find(needle).sourceCheckedAt,
            '2026-08-27',
            `${needle} 的 sourceCheckedAt 不得被清掉——它是「這一筆真的開過官網」的唯一憑證`,
        );
    }
});

// ── 賽事日期不得被當成報名截止 ──
// 這是本輪查證抓到最多次的錯誤類型，也是 #82 修 OPhO 時處理過的同一個錯誤。
test('data：比賽日期不得再被寫成報名截止（My First CTF／iBridge／育秀盃）', () => {
    // 官網：報名「自 115 年 4 月 1 日上午 10 點至 115 年 4 月 19 日下午 5 點止」
    //       競賽「115 年 5 月 16 日(六)上午 9 時 30 分至下午 5 時 30 分」
    const ctf = find('My First CTF');
    assert.equal(ctf.deadline, '2026-04-19');
    assert.equal(ctf.deadlineAt, '2026-04-19T17:00:00+08:00');
    assert.equal(ctf.opensAt, '2026-04-01T10:00:00+08:00');
    assert.equal(ctf.eventStartsAt, '2026-05-16');
    assert.equal(ctf.cycle.closes, '04-19', '5 月是比賽月份，不是報名截止月份');
    assert.notEqual(ctf.cycle.closes, '05');

    // 官網 2025 屆：報名「即日起至 11 月 28 日（五）17:00 截止」、競賽「2025 年 12 月 13 日（六）」
    // 官網只有兩屆紀錄（2023-06、2025-12），辦理時間不固定 → 不得填 cycle 推算下一屆
    const ibridge = find('iBridge');
    assert.equal(ibridge.eventStartsAt, '2025-12-13');
    assert.equal(ibridge.cycle, undefined, 'iBridge 只辦過兩屆且間隔不固定，不得宣稱年度週期');
    assert.ok(ibridge.registrationNote, '沒有固定週期時應以 registrationNote 說明，而不是留白');

    // 官網競賽時程：「報名及初賽截止日 2025 / 12 / 30」「決賽評選暨頒獎典禮 2026 / 4 / 24」
    const ysed = find('育秀盃');
    assert.equal(ysed.deadline, '2025-12-30');
    assert.equal(ysed.eventStartsAt, '2026-04-24', '4/24 是決賽暨頒獎，不是報名截止');
    assert.equal(ysed.cycle.opens, '10-01');
    assert.equal(ysed.cycle.closes, '12-30');
});

// ── 沒有公開報名的競賽不得顯示「每年約 X 月截止」 ──
test('data：國家隊選拔類競賽不得憑賽事月份捏造報名截止', () => {
    // APMO 官網 Regulations：「The APMO is held in the afternoon of the second Monday of March
    // for participating countries in the North and South Americas, and in the morning of the
    // second Tuesday of March for participating countries on the Western Pacific and in Asia.」
    // 「Country representatives organize the competition locally.」——沒有任何公開報名截止日。
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

// ── 官網網址必須指向「有內容」的現行站台 ──
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
        assert.ok(!/^https:\/\/(www\.)?conradchallenge\.org/.test(url), 'conradchallenge.org 已是停放網域');
        assert.ok(!/^https:\/\/tpmso\.org/.test(url), 'tpmso.org 已轉址到 tpmso.k12ea.gov.tw');
    }
});

// ── 帶時區的精確截止時刻 ──
test('data：查到確切時刻的競賽必須保留時區位移', () => {
    // TISDC 官網時程：「Submission deadline: July 6, 2026, 11:59 PM Taipei Time」
    //                「Extended deadline: July 15, 2026, 11:59 PM Taipei Time」
    assert.equal(find('台灣國際學生創意設計大賽').deadlineAt, '2026-07-15T23:59:00+08:00');

    // HCC 官網 Terms：「The registration form closes automatically on October 14 (GMT+0), 23:59.」
    assert.equal(find('哈佛克里姆森商業個案分析賽').deadlineAt, '2026-10-14T23:59:00Z');

    // Diamond Challenge 官網：「January 14 | Submission Deadline (5PM EST)」
    //                        「September 16 | Submission Window Opens」
    const diamond = find('Diamond Challenge');
    assert.equal(diamond.deadline, '2027-01-14');
    assert.equal(diamond.deadlineAt, '2027-01-14T17:00:00-05:00');
    assert.equal(diamond.opensAt, '2026-09-16T00:00:00-04:00');
    assert.equal(diamond.eventStartsAt, '2027-04-29');
    assert.equal(diamond.eventEndsAt, '2027-04-30');

    // IChC 官網：Qualification Round「Sunday, 29 March 2026, 23:59 UTC+0」
    assert.equal(find('國際化學競賽').deadlineAt, '2026-03-29T23:59:00Z');

    // 生活科技學藝競賽官方實施計畫：「文件送繳時程：於115 年 3 月30 日(一) 下午5 點前」
    //                              「決賽日期：115 年5 月19 日(二)」
    const lt = find('生活科技學藝競賽');
    assert.equal(lt.deadlineAt, '2026-03-30T17:00:00+08:00');
    assert.equal(lt.eventStartsAt, '2026-05-19');

    // 每個時刻欄位都必須帶時區位移——沒有時區的時刻在不同時區的人眼中是不同的時刻
    for (const needle of VERIFIED_2026_08_27) {
        const c = find(needle);
        for (const f of ['deadlineAt', 'opensAt']) {
            if (c[f] === undefined) continue;
            assert.match(c[f], /(Z|[+-]\d{2}:\d{2})$/, `${needle} 的 ${f} 缺少時區位移`);
        }
    }
});

// ── 查不到就不要猜 ──
test('data：官網未公布截止日的競賽不得被補上一個猜出來的日期', () => {
    // 官網獎項頁逐字：「Deadline for submissions: The deadline for 2027 will be announced in September.」
    // 舊資料的「每年 5 月 1 日截止」只存在於已下線的 archive.thewha.org 與第三方轉述。
    const wha = find('世界歷史學家論文獎');
    assert.equal(wha.deadline, '');
    assert.equal(wha.cycle, undefined, '官網已不再公布固定的 5/1 截止日');
    assert.ok(wha.registrationNote?.includes('9 月'), '應說明截止日何時公布，而不是留一個舊日期');

    // 「總統教育獎辦理要點」只訂獎金與名額，未訂推薦截止日；各年度期程也不一致
    //（2026 屆 2025-11-27 至 2025-12-30、2025 屆至 2 月 3 日止）。
    const pea = find('總統教育獎');
    assert.equal(pea.deadline, '');
    assert.equal(pea.cycle, undefined, '推薦期程逐年不同，不得宣稱固定在 12 月');
    assert.ok(pea.registrationNote);

    // 外交小尖兵：113 年為「選拔活動」（9/1–9/30 報名）、114 年改辦「培訓營」（報名截止 4/29），
    // 官網查無 115 年公告 → 不得再宣稱「每年 9 月開放」。
    const mofa = find('外交小尖兵');
    assert.equal(mofa.deadline, '');
    assert.equal(mofa.cycle, undefined);
    assert.ok(mofa.registrationNote);

    // Foyle 官網 Rules：「Deadline: Midnight 31st July 2026 (BST)」。
    // midnight 究竟指 00:00 或 23:59 官網未界定 → 不得自行補一個 deadlineAt。
    const foyle = find('Foyle');
    assert.equal(foyle.deadline, '2026-07-31');
    assert.equal(foyle.deadlineAt, undefined, '官網的 midnight 有歧義，不得猜一個時刻');
    assert.equal(foyle.cycle.opens, undefined, '官網未公布開放投稿的月份');
    assert.equal(foyle.cycle.closes, '07-31');
});

// ── 其餘已查證欄位 ──
test('data：本輪查證到的賽事日期與週期', () => {
    // 科教館官網日程表：「2027 年臺灣國際科學展覽會日程表(暫定) 1/25 (一) ~1/30 (六)」
    // 實施要點：送件「每年十至十一月間臺灣國際科展送件期限內」
    const tisf = find('台灣國際科學展覽會');
    assert.equal(tisf.eventStartsAt, '2027-01-25');
    assert.equal(tisf.eventEndsAt, '2027-01-30');
    assert.equal(tisf.cycle.closes, '11');

    // Conrad 官網 Activation Stage：「Start: August 27, 2026」「End: October 29, 2026」
    // Innovation Stage：「The submission deadline for all Innovation Stage content is January 7, 2027.」
    // Innovation Summit：April 21-24, 2027
    const conrad = find('Conrad Challenge');
    assert.equal(conrad.deadline, '2026-10-29', 'Activation 階段結束於 10/29，不是 10/30');
    assert.equal(conrad.eventStartsAt, '2027-04-21');
    assert.equal(conrad.eventEndsAt, '2027-04-24');
    assert.equal(conrad.cycle.closes, '10-29');

    // ESU 官網：「The IPSC programme will run from Monday, 13 July to Saturday, 18 July 2026.」
    //           「The deadline for submitting the preliminary registration form is Friday, 24 November 2025」
    const esu = find('ESU 國際公眾演說');
    assert.equal(esu.eventStartsAt, '2026-07-13');
    assert.equal(esu.eventEndsAt, '2026-07-18');
    assert.equal(esu.cycle.closes, '11');

    // Brain Bee 主辦單位報名頁：「報名：2026 年 5 月 9 日截止」
    //   第一階段 2026-05-23 筆試、第二階段 2026-06-27 口試
    const bee = find('Taiwan Brain Bee');
    assert.equal(bee.deadline, '2026-05-09');
    assert.equal(bee.eventStartsAt, '2026-05-23');
    assert.equal(bee.eventEndsAt, '2026-06-27');
    assert.equal(bee.cycle.closes, '05-09');
});

// ── 顯示層：查證過的值在卡片上要長成正確的樣子 ──
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
        'getStatus', 'statusText', 'eventLabel', 'deadlineFieldLabel', 'deadlineLabel',
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
        `${bundle}; return { getStatus, statusText, deadlineFieldLabel, deadlineLabel };`,
    )(FixedDate);

    const card = (needle) => {
        const c = find(needle);
        const s = f.getStatus(c);
        return { status: f.statusText(s), field: f.deadlineFieldLabel(c), label: f.deadlineLabel(c, s) };
    };

    // 報名 4/19 截止、5/16 比賽——狀態列講報名，日期欄兩者都講清楚
    assert.deepEqual(card('My First CTF'), {
        status: '本屆已截止 · 下次約 2027-04-19',
        field: '報名截止',
        label: '本屆 2026-04-19 已截止 · 每年約 4/19 · 2026-05-16 舉行',
    });

    // 沒有公開報名：狀態列必須說清楚，日期欄顯示賽事日期而不是假的截止日
    assert.deepEqual(card('亞太數學奧林匹亞'), {
        status: '每年 3 月舉行 · 無公開報名',
        field: '報名截止',
        label: '每年 3 月舉行 · 無公開報名',
    });
    assert.deepEqual(card('亞太資訊奧林匹亞'), {
        status: '每年 5 月舉行 · 無公開報名',
        field: '賽事日期',
        label: '2026-05-09 舉行',
    });

    // 官網未公布下屆截止日：不得出現任何具體日期
    const wha = card('世界歷史學家論文獎');
    assert.equal(wha.status, '2027 年截止日 9 月公布');
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(wha.label), '不得憑空生出一個截止日期');

    // 只辦過兩屆、間隔不固定：顯示賽事日期，不推算下一屆
    const ibridge = card('iBridge');
    assert.equal(ibridge.status, '辦理時間不固定 · 依官網公告');
    assert.equal(ibridge.label, '2025-12-13 舉行');
    assert.ok(!/下次約/.test(ibridge.status));

    // 報名 9/16 才開放，今天（8/27）不得顯示「報名中」
    assert.equal(card('Diamond Challenge').status, '尚未開放 · 預計 2026-09-16 開放');

    // 報名中的兩筆：剩餘天數以帶時區的精確時刻換算成台北日曆日
    assert.equal(card('哈佛克里姆森商業個案分析賽').status, '報名中 · 剩 49 天');
    assert.equal(card('Conrad Challenge').status, '報名中 · 剩 63 天');

    // 本屆已截止但知道週期
    assert.equal(card('台灣國際學生創意設計大賽').status, '本屆已截止 · 下次約 2027-07-31');
    assert.equal(card('育秀盃').label, '本屆 2025-12-30 已截止 · 每年約 12/30 · 2026-04-24 舉行');

    // 沒有確切截止日但有週期與賽事日期
    assert.equal(card('台灣國際科學展覽會').label, '每年約 11 月截止 · 2027 賽事 1/25–1/30');

    // 沒有任何日期主張的兩筆：狀態列講規則，不得出現數字日期
    for (const needle of ['外交小尖兵', '總統教育獎']) {
        const c = card(needle);
        assert.ok(!/\d{4}-\d{2}-\d{2}/.test(c.status + c.label), `${needle} 不得顯示未經查證的日期`);
    }
});
