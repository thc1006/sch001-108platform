#!/usr/bin/env node
/**
 * 看門狗連結健檢的狀態機測試
 * --------------------------------------------------------------
 * 全部打本機 http server，不依賴外網——外網測試會因防爬與站台狀態而飄。
 *
 * 執行：  node --test scripts/
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { probe, isDeadResult, classifyLink, validateUrl, validateCycle, nextOccurrenceUTC, ALLOWED_FORMS } from './check-competitions.lib.mjs';
import { ALLOWED_COMPETITION_FIELDS, TEXT_FIELDS } from './check-competitions.lib.mjs';
import { selectCanonicalIssue, WATCHDOG_MARKER, ACTIONS_APP_LOGIN } from './watchdog-issue.lib.mjs';

let base;
let server;
let goneHits = 0;
let flakyHits = 0;

before(async () => {
    server = createServer((req, res) => {
        const url = req.url;
        // HEAD 回 200、GET 回 404：只靠 HEAD 判斷會誤判為健康
        if (url === '/head-ok-get-gone') {
            if (req.method === 'HEAD') { res.writeHead(200); return res.end(); }
            goneHits++;
            res.writeHead(404); return res.end('gone');
        }
        // HEAD 回 404、GET 回 200：只靠 HEAD 判斷會誤判為失效（Kaggle / tpmso.org 的真實情況）
        if (url === '/head-gone-get-ok') {
            if (req.method === 'HEAD') { res.writeHead(404); return res.end(); }
            res.writeHead(200); return res.end('<html>ok</html>');
        }
        if (url === '/ok') { res.writeHead(200); return res.end('<html>ok</html>'); }
        if (url === '/404') { res.writeHead(404); return res.end('nope'); }
        if (url === '/410') { res.writeHead(410); return res.end('gone'); }
        if (url === '/403') { res.writeHead(403); return res.end('forbidden'); }
        if (url === '/429') { res.writeHead(429); return res.end('slow down'); }
        if (url === '/500') { res.writeHead(500); return res.end('boom'); }
        // 第一次 404、之後 200：重試機制應把它救回來
        if (url === '/flaky') {
            flakyHits++;
            if (flakyHits === 1) { res.writeHead(404); return res.end(); }
            res.writeHead(200); return res.end('<html>ok</html>');
        }
        if (url === '/slow') { return; } // 不回應，用來測逾時
        if (url === '/redirect') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
        res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// ── probe 的方法選擇 ──

test('HEAD 200 但 GET 404 → 必須判定為失效（不可只信 HEAD）', async () => {
    const r = await probe(`${base}/head-ok-get-gone`);
    assert.equal(r.status, 404);
    assert.equal(isDeadResult(r), true);
    assert.ok(goneHits > 0, '必須真的送出 GET');
});

test('HEAD 404 但 GET 200 → 必須判定為健康（不可只信 HEAD）', async () => {
    const r = await probe(`${base}/head-gone-get-ok`);
    assert.equal(r.status, 200);
    assert.equal(isDeadResult(r), false);
});

// ── 狀態碼分類 ──

test('404 / 410 → dead', async () => {
    for (const p of ['/404', '/410']) {
        const r = await probe(`${base}${p}`);
        assert.equal(classifyLink(r), 'dead', `${p} 應為 dead`);
    }
});

test('403 / 429 / 500 → unverified（防爬與暫時性故障不可開 issue）', async () => {
    for (const p of ['/403', '/429', '/500']) {
        const r = await probe(`${base}${p}`);
        assert.equal(classifyLink(r), 'unverified', `${p} 應為 unverified`);
    }
});

test('200 與轉址後 200 → healthy', async () => {
    assert.equal(classifyLink(await probe(`${base}/ok`)), 'healthy');
    assert.equal(classifyLink(await probe(`${base}/redirect`)), 'healthy');
});

test('網域無法解析 (ENOTFOUND) → dead', async () => {
    const r = await probe('https://this-domain-must-not-exist-4b81f2a9.invalid/');
    assert.equal(r.status, 0);
    assert.equal(r.code, 'ENOTFOUND');
    assert.equal(classifyLink(r), 'dead');
});

test('逾時 → unverified，不可當成失效', async () => {
    const r = await probe(`${base}/slow`, AbortSignal.timeout(300));
    assert.equal(r.status, 0);
    assert.equal(classifyLink(r), 'unverified');
});

test('第一次 404、重試 200 → 最終視為健康', async () => {
    let r = await probe(`${base}/flaky`);
    assert.equal(classifyLink(r), 'dead', '第一次應為 dead 才會觸發重試');
    if (isDeadResult(r)) r = await probe(`${base}/flaky`);
    assert.equal(classifyLink(r), 'healthy');
});

test('GET 的 response body 一定要被釋放（不可依賴 GC）', async () => {
    // probe 內部在 finally cancel；若漏掉，重複呼叫會逐漸卡住連線池。
    // 這裡以「連續多次仍能在合理時間內完成」作為回歸偵測。
    const started = Date.now();
    for (let i = 0; i < 30; i++) {
        const r = await probe(`${base}/ok`);
        assert.equal(r.status, 200);
    }
    assert.ok(Date.now() - started < 10_000, '連續 30 次 GET 不應變慢或卡住');
});

// ── schema 驗證 ──

test('拼錯協定 / 非 https / 內嵌帳密的 url 必須被 schema 攔下', () => {
    for (const bad of ['htps://example.com', ' https://example.com', 'https://', 'javascript:alert(1)', 'http://example.com', 'https://u:p@example.com']) {
        const errs = [];
        validateUrl(bad, '測試', errs);
        assert.ok(errs.length > 0, `「${bad}」應產生 schema 錯誤`);
    }
});

test('合法 https url 不應產生錯誤', () => {
    const errs = [];
    validateUrl('https://example.com/path?q=1', '測試', errs);
    assert.equal(errs.length, 0);
});

test('form 只接受三種值', () => {
    assert.deepEqual(ALLOWED_FORMS, ['個人', '團體', '個人/團體']);
    assert.ok(!ALLOWED_FORMS.includes('個人與團隊'));
});

// ── 年度週期（cycle）──

test('cycle：只知月份時取該月最後一天（保守，不會誤判成已截止）', () => {
    const today = Date.UTC(2026, 7, 2); // 2026-08-02
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    assert.equal(iso(nextOccurrenceUTC('03', today)), '2027-03-31');
    assert.equal(iso(nextOccurrenceUTC('12', today)), '2026-12-31');
});

test('cycle：今年已過就推到明年，未到則用今年', () => {
    const today = Date.UTC(2026, 7, 2);
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    assert.equal(iso(nextOccurrenceUTC('07-31', today)), '2027-07-31');
    assert.equal(iso(nextOccurrenceUTC('09-15', today)), '2026-09-15');
});

test('cycle：當天算「還沒過」', () => {
    const today = Date.UTC(2026, 7, 2);
    assert.equal(new Date(nextOccurrenceUTC('08-02', today)).toISOString().slice(0, 10), '2026-08-02');
});

test('cycle：格式錯誤回 null，不可靜默當成有效', () => {
    const today = Date.UTC(2026, 7, 2);
    for (const bad of ['13', '00', '07-32', '7-1', '2026-07-31', '', null, undefined]) {
        assert.equal(nextOccurrenceUTC(bad, today), null, `${bad} 應為 null`);
    }
});

test('cycle：schema 驗證攔下非法值', () => {
    const cases = [
        [{ closes: '13-01' }, '月份超界'],
        [{ opens: '7' }, '未補零'],
        [{ foo: 1 }, '未知欄位'],
        [{}, '全空'],
        ['not-object', '非物件'],
        [{ note: '  ' }, 'note 空白'],
    ];
    for (const [val, why] of cases) {
        const errs = [];
        validateCycle(val, '測試', errs);
        assert.ok(errs.length > 0, `${why} 應被攔下`);
    }
});

test('cycle：合法值與未提供都不報錯', () => {
    for (const ok of [undefined, { closes: '07-31' }, { opens: '01', closes: '07-31' }, { note: '不定期' }]) {
        const errs = [];
        validateCycle(ok, '測試', errs);
        assert.equal(errs.length, 0, `${JSON.stringify(ok)} 不應報錯`);
    }
});

test('cycle：不存在的日期必須被攔下（02-30、04-31…）', () => {
    for (const bad of ['02-30', '02-31', '04-31', '06-31', '09-31', '11-31']) {
        const errs = [];
        validateCycle({ closes: bad }, '測試', errs);
        assert.ok(errs.length > 0, `${bad} 不是實際存在的日期，應被攔下`);
    }
    // 02-29 僅閏年存在，仍屬合法設定
    const errs = [];
    validateCycle({ closes: '02-29' }, '測試', errs);
    assert.equal(errs.length, 0, '02-29 應視為合法');
});

test('cycle：02-29 在平年退回 2/28，不可靜默跨月到 3/1', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    assert.equal(iso(nextOccurrenceUTC('02-29', Date.UTC(2027, 0, 1))), '2027-02-28');
    assert.equal(iso(nextOccurrenceUTC('02-29', Date.UTC(2028, 0, 1))), '2028-02-29');
});



// ── 競賽物件的欄位白名單 ──
// cycle 內部本來就有同類的白名單，但物件本身先前沒有。"cyle"（少一個 c）這種錯字
// 只要必填欄位都在就會通過驗證，前端則靜默忽略它——該筆競賽的週期資訊等於憑空
// 消失且沒有任何訊號。
test('schema：實際資料不得出現白名單以外的欄位', async () => {
    const { readFileSync } = await import('node:fs');
    const data = JSON.parse(
        readFileSync(new URL('../public/advanced-resources/competitions.json', import.meta.url), 'utf8'),
    );
    const seen = new Set();
    for (const c of data.competitions) for (const k of Object.keys(c)) seen.add(k);
    const unknown = [...seen].filter((k) => !ALLOWED_COMPETITION_FIELDS.has(k));
    assert.deepEqual(
        unknown,
        [],
        `competitions.json 出現白名單以外的欄位：${unknown.join('、')}。` +
            '若是刻意新增的欄位，請同步更新 ALLOWED_COMPETITION_FIELDS；若是錯字，請修正資料。',
    );
    // 反向：白名單裡的必填欄位每一筆都要有，否則白名單形同虛設
    for (const f of TEXT_FIELDS) {
        assert.ok(seen.has(f), `白名單列了 ${f}，但實際資料一筆都沒有——白名單與資料已漂移`);
    }
});

test('schema：常見錯字不在白名單內', () => {
    // 這幾個都是實際容易打錯的形狀，全部必須被視為未知欄位而攔下
    for (const typo of ['cyle', 'cycles', 'Cycle', 'deadLine', 'dead_line', 'URL']) {
        assert.ok(!ALLOWED_COMPETITION_FIELDS.has(typo), `${typo} 不該在白名單內`);
    }
});

// ── 看門狗的 issue 認領 ──
// 這五個情境先前只用人工假造的 gh 驗過一次，沒有留下回歸測試——而認領邏輯正是
// 出過事的那一段：#70（人工開立）用了同一個標籤，連續四週的週報全貼到那裡。
// 判斷邏輯移到 watchdog-issue.lib.mjs 之後，這裡把五個情境固定下來。
const bot = (number, body) => ({ number, author: { login: ACTIONS_APP_LOGIN }, body });
const human = (number, body) => ({ number, author: { login: 'thc1006' }, body });

test('watchdog：人工開立的 issue 即使貼了同一個標籤也不接管', () => {
    // 實際發生過的情況：#70 是人工開的，標籤相同。標籤是共用屬性，不能單獨決定歸屬。
    const r = selectCanonicalIssue([human(70, `追蹤：資料稽核\n${WATCHDOG_MARKER}`)]);
    assert.deepEqual(r, { action: 'create' }, '人工 issue 就算 body 有標記也不得接管');
});

test('watchdog：Actions 開的但沒有機器標記時不接管', () => {
    // repo 內其他自動化同樣以 Actions App 身分開 issue，只看作者會誤認。
    assert.deepEqual(selectCanonicalIssue([bot(80, '別的 workflow 開的 issue')]), { action: 'create' });
});

test('watchdog：作者與標記都符合時接管既有 issue', () => {
    assert.deepEqual(selectCanonicalIssue([bot(81, `${WATCHDOG_MARKER}\n\n上週報告`)]), {
        action: 'comment',
        number: 81,
    });
});

test('watchdog：完全沒有候選時新開 issue', () => {
    assert.deepEqual(selectCanonicalIssue([]), { action: 'create' });
});

test('watchdog：出現多個 canonical issue 時必須大聲失敗，不可安靜取第一個', () => {
    // 取第一個會讓另一個永遠收不到報告，而且沒有任何訊號——正是本 issue 在修的失效模式。
    const r = selectCanonicalIssue([bot(91, WATCHDOG_MARKER), bot(90, WATCHDOG_MARKER)]);
    assert.equal(r.action, 'fail');
    assert.deepEqual(r.numbers, [90, 91], '應列出全部重複的 issue 供人工處理');
});

test('watchdog：畸形輸入不得被當成可接管', () => {
    const bad = [null, undefined, 'x', 42, {}, { number: 1 }, { author: { login: ACTIONS_APP_LOGIN } }];
    assert.deepEqual(selectCanonicalIssue(bad), { action: 'create' });
    assert.deepEqual(selectCanonicalIssue(null), { action: 'create' });
    // number 不是整數時不可接管——後續會被當成 issue 編號傳給 gh
    assert.deepEqual(
        selectCanonicalIssue([{ number: '81', author: { login: ACTIONS_APP_LOGIN }, body: WATCHDOG_MARKER }]),
        { action: 'create' },
    );
});

// workflow 實際呼叫的是 CLI，不是函式本身。只測函式會漏掉 stdin 解析、輸出格式與
// 退出碼這層接線——而 workflow 正是靠退出碼決定要不要中止。
test('watchdog：CLI 的輸出格式與退出碼', async () => {
    const { execFileSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    // 用 fileURLToPath 而非手刻 pathname 轉換：pathname 是 percent-encoded，
    // 路徑含空白或非 ASCII（本 repo 就在 .claude/worktrees 下）時會解析錯誤。
    const cli = fileURLToPath(new URL('./find-watchdog-issue.mjs', import.meta.url));
    const run = (payload) =>
        execFileSync(process.execPath, [cli], { input: JSON.stringify(payload), encoding: 'utf8' }).trim();

    assert.equal(run([]), 'create');
    assert.equal(run([bot(81, WATCHDOG_MARKER)]), 'comment 81');
    assert.equal(run([human(70, WATCHDOG_MARKER)]), 'create');

    let code = 0;
    let stderr = '';
    try {
        execFileSync(process.execPath, [cli], {
            input: JSON.stringify([bot(90, WATCHDOG_MARKER), bot(91, WATCHDOG_MARKER)]),
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    } catch (err) {
        code = err.status;
        stderr = String(err.stderr);
    }
    assert.equal(code, 2, '多個 canonical issue 必須以非零退出碼中止 workflow');
    assert.match(stderr, /#90/, '錯誤訊息要指名重複的 issue');
    assert.match(stderr, /#91/);
});

// ── 前後端邏輯防漂移 ──
// nextOccurrenceUTC 在 lib（Node）與 competitions.astro（瀏覽器 is:inline）各有
// 一份實作——後者無法 import Node 模組。兩份若漂移，頁面與看門狗就會對同一筆
// 競賽給出不同的「下次截止日」。這個測試把 .astro 裡那份抽出來實際比對。
test('cycle：頁面與看門狗的推算結果必須完全一致', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/pages/advanced-resources/competitions.astro', import.meta.url), 'utf8');
    const m = src.match(/function nextOccurrenceUTC\((?:[^)]*)\) \{[\s\S]*?\n      \}/);
    assert.ok(m, '在 competitions.astro 找不到 nextOccurrenceUTC——若已改名請同步更新本測試');

    const browserFn = new Function(`${m[0]}; return nextOccurrenceUTC;`)();

    const days = ['01-01', '01', '02-28', '02-29', '03', '06-30', '07-31', '08', '12', '12-31', '13-01', '02-30', '', 'x'];
    const bases = [Date.UTC(2026, 7, 2), Date.UTC(2027, 0, 1), Date.UTC(2028, 1, 29), Date.UTC(2026, 11, 31)];
    // 第三維：lastEditionUTC（null＝未知本屆；其餘為已過的本屆截止日）
    const lasts = [null, Date.UTC(2026, 7, 21), Date.UTC(2024, 0, 15), Date.UTC(2026, 6, 31), Date.UTC(2025, 11, 20), Date.UTC(2026, 0, 15)];
    for (const c of days) {
        for (const t of bases) {
            for (const le of lasts) {
                assert.equal(
                    browserFn(c, t, le),
                    nextOccurrenceUTC(c, t, le),
                    `closes=${c} today=${new Date(t).toISOString().slice(0, 10)} last=${le} 兩份實作結果不一致`,
                );
            }
        }
    }
});

test('cycle：已知本屆截止日時，下屆須在隔年——不可算成同月月底', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    // OPhO 實例：本屆 2026-08-21 辦完，週期僅精確到月（08），今天 2026-08-27。
    // 未傳 lastEdition 會得到同月的 08-31（誤報「下屆剩 4 天」）。
    const today = Date.UTC(2026, 7, 27);
    assert.equal(iso(nextOccurrenceUTC('08', today)), '2026-08-31', '未傳 lastEdition 時維持原行為');
    assert.equal(iso(nextOccurrenceUTC('08', today, Date.UTC(2026, 7, 21))), '2027-08-31');
    // MM-DD 精度同理
    assert.equal(iso(nextOccurrenceUTC('07-31', today, Date.UTC(2026, 6, 31))), '2027-07-31');
});

// 「本屆年份 + 1」在跨年季會整整漏掉一輪：截止日 2026-01-15、週期記 12 月時，
// 那個截止日屬於 2025-12 那一輪，下一輪是 2026-12 而非 2027-12。實際發生時，頁面
// 會把還能報名的一整年說成「下次約 2027」。現在改為先把本屆對應回最近的週期實例。
test('cycle：跨年季不可漏掉一整輪', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);

    // 月份精度：1 月的截止日屬於前一年 12 月那一輪
    assert.equal(iso(nextOccurrenceUTC('12', today, Date.UTC(2026, 0, 15))), '2026-12-31');
    // 日精度同理
    assert.equal(iso(nextOccurrenceUTC('12-20', today, Date.UTC(2026, 0, 5))), '2026-12-20');
    // 反向：12 月的截止日配 1 月的週期，屬於「隔年 1 月」那一輪，下一輪是再隔年
    assert.equal(iso(nextOccurrenceUTC('01', today, Date.UTC(2025, 11, 20))), '2027-01-31');
});

test('cycle：截止月與週期月相符時，錨定結果與原本一致', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);
    // 同月（OPhO）
    assert.equal(iso(nextOccurrenceUTC('08', today, Date.UTC(2026, 7, 21))), '2027-08-31');
    // 同月同日
    assert.equal(iso(nextOccurrenceUTC('10-30', today, Date.UTC(2025, 9, 30))), '2026-10-30');
});

test('cycle：週期在兩屆之間被改動時，取離本屆最近的實例當錨點', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);
    // 本屆確切截止 2026-03-10，但 cycle 已被更新成 10 月（主辦單位改期）。
    // 2026-10 仍在未來，不應該跳過它而報 2027-10。
    assert.equal(iso(nextOccurrenceUTC('10', today, Date.UTC(2026, 2, 10))), '2026-10-31');
});

test('cycle：跨年季且資料久未更新時，仍推到未來而非停在過去', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);
    // 本屆停在 2023-01-15、週期記 12 月：錨點是 2022-12，往後推須一路到 2026-12
    assert.equal(iso(nextOccurrenceUTC('12', today, Date.UTC(2023, 0, 15))), '2026-12-31');
});

test('cycle：lastEdition 已過一年以上時，持續往後推到未來', () => {
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const today = Date.UTC(2026, 7, 27);
    // 本屆停留在 2023 的資料：2024/2025/2026 的週期都已過，應推到 2027
    assert.equal(iso(nextOccurrenceUTC('03', today, Date.UTC(2023, 2, 1))), '2027-03-31');
});
