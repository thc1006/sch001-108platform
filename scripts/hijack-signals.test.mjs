/**
 * 自動偵測「狀態碼健康、內容已經換人」的單元與端對端測試（#117）
 * ================================================================
 * 這兩個訊號的價值完全取決於**誤判率**：報得太兇就會被當成雜訊關掉，而關掉之後
 * 就回到「只能堵已知主機」的狀態。所以反例（正常網站不得被標記）和正例一樣多。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { probe } from './link-health.lib.mjs';
import {
    sameSite,
    opaqueShell,
    crossSiteRedirect,
    extractHeadText,
    contentSquatSignals,
    detectHijackSignals,
    inertText,
    SQUAT_PHRASES,
} from './hijack-signals.lib.mjs';

const LOOPBACK = { allowLoopback: true };

// ── 訊號 A：同站判定 ────────────────────────────────────────────
test('sameSite：www 轉址、子網域都算同站', () => {
    assert.equal(sameSite('ieso-info.org', 'www.ieso-info.org'), true);
    assert.equal(sameSite('www.cac.edu.tw', 'cac.edu.tw'), true);
    assert.equal(sameSite('a.b.example.com', 'example.com'), true);
    assert.equal(sameSite('example.com', 'example.com'), true);
});

test('sameSite：.edu.tw／.gov.tw 的不同機構必須算跨站（issue #117 原本的卡點）', () => {
    // 這正是「取最後兩段當 eTLD+1」會答錯的地方：ntnu 與 ntu 是兩個完全不同的
    // 大學，而它們的最後兩段都是 edu.tw。用後綴關係判斷就不會有這個問題。
    assert.equal(sameSite('www.ntnu.edu.tw', 'www.ntu.edu.tw'), false);
    assert.equal(sameSite('moe.gov.tw', 'k12ea.gov.tw'), false);
    assert.equal(sameSite('a.edu.tw', 'b.edu.tw'), false);
});

test('sameSite：點邊界不可少，否則 foo.com 會被當成 evil-foo.com 的後綴', () => {
    assert.equal(sameSite('foo.com', 'evil-foo.com'), false);
    assert.equal(sameSite('sasmo.sg', 'notsasmo.sg'), false);
    // 反向也一樣
    assert.equal(sameSite('evilfoo.com', 'foo.com'), false);
});

test('crossSiteRedirect：三個真實案例的判定與實測一致', () => {
    // 實測過的接管：終點是完全不同的網域
    assert.ok(crossSiteRedirect('https://www.sasmo.sg/', 'https://arcade.now/lp1/play'));
    assert.ok(crossSiteRedirect('https://hmun.org/', 'https://t.tenlets.com/x'));
    // ieso-info.org 是 301 → www.ieso-info.org，**同站**，所以訊號 A 看不到它。
    // 這不是缺陷，是分工：它由訊號 B（內容標記）負責。
    assert.equal(crossSiteRedirect('https://ieso-info.org/', 'https://www.ieso-info.org/'), null);
});

test('crossSiteRedirect：沒有轉址時回 null', () => {
    assert.equal(crossSiteRedirect('https://example.org/a', 'https://example.org/a'), null);
});

// ── 訊號 B：內容標記 ───────────────────────────────────────────
test('extractHeadText：取得 title 與 meta description', () => {
    const html = `<!doctype html><html><head><title>  Best Online Pokies in Australia 2026  </title>
        <meta name="description" content="Enjoy the best real money pokies at trusted casinos.">
        </head><body>x</body></html>`;
    const r = extractHeadText(html);
    assert.equal(r.title, 'Best Online Pokies in Australia 2026');
    assert.match(r.description, /real money pokies/);
});

test('extractHeadText：取不到就回空字串，不猜', () => {
    assert.deepEqual(extractHeadText(''), { title: '', description: '' });
    assert.deepEqual(extractHeadText(null), { title: '', description: '' });
    assert.equal(extractHeadText('<html><body>沒有 head</body></html>').title, '');
});

test('extractHeadText：description 裡的撇號不得把內容截斷（現成的規避法）', () => {
    // 用 [^"'] 這種「兩種引號都排除」的字元類別時，取到的只有 "Australia"，
    // 撇號之後的整段——包含變現詞組——全部看不到。實測全站 93 個含英文
    // description 的目標中有 3 個被這樣截斷（iymc.info／pmc.ncbi.nlm.nih.gov／
    // drivendata.org），對接管的頁面則等於一個一個字元就能規避的偵測。
    const html = `<meta name="description" content="Australia's best online casino bonus and free spins.">`;
    assert.match(extractHeadText(html).description, /free spins/);
    assert.ok(contentSquatSignals(html).some((h) => h.phrase === 'online casino'));
    // 單引號包起來的 content 裡出現雙引號時同理
    const single = `<meta name='description' content='The "best" online pokies in Australia'>`;
    assert.match(extractHeadText(single).description, /online pokies/);
});

test('extractHeadText：過長的 title／description 要截斷，不是整條丟掉', () => {
    // 量詞寫成 {0,300}? 時，超過上限不是截斷而是**整條比對失敗**回空字串——
    // 「太長」與「根本沒有 title」在下游長得一模一樣，而蹲域名的頁面標題常常很長。
    const longTitle = `<title>${'ab '.repeat(150)}Best Online Pokies</title>`;
    const t = extractHeadText(longTitle).title;
    assert.ok(t.length > 0, 'title 超過上限時被整條丟掉了');
    assert.equal(t.length, 300, 'title 應該截斷到上限');
    const longDesc = `<meta name="description" content="${'cd '.repeat(200)}real money casino">`;
    const d = extractHeadText(longDesc).description;
    assert.ok(d.length > 0, 'description 超過上限時被整條丟掉了');
    assert.equal(d.length, 400, 'description 應該截斷到上限');
});

test('inertText：遠端可控的文字進不了 issue 的渲染層', () => {
    // 報告會被 gh issue create --body-file 原樣送進 issue body，而這段文字是
    // 被偵測的那台主機自己寫的——命中的定義就是「那台主機不可信」。
    const evil = 'Online Casino @thc1006 see #72 and [Click](https://evil.example/phish)';
    const out = inertText(evil);
    assert.ok(out.startsWith('`') && out.endsWith('`'), '必須包成行內程式碼');
    // 內容自己帶反引號時不可以讓它把 code span 關掉
    assert.equal(inertText('a`b`c'), "`a'b'c`");
    assert.equal((inertText('x').match(/`/g) || []).length, 2);
});

test('報告樣板：遠端可控的欄位一定要經過 inertText', () => {
    // 這一條守的是**接線**，不是函式本身：inertText 寫得再對，報告那邊忘了呼叫
    // 就一點用都沒有，而那個漏接不會有任何其他訊號。
    const src = readFileSync(new URL('./check-external-links.mjs', import.meta.url), 'utf8');
    for (const expr of ['inertText(c.text)', 'inertText(a.shell.title)', 'inertText(h)']) {
        assert.ok(src.includes(expr), `check-external-links.mjs 的報告樣板少了 ${expr}`);
    }
    assert.ok(!/原文：\$\{c\.text\}/.test(src), '報告仍在原樣輸出遠端可控的 c.text');
});

test('報告：訊號數要無條件寫進報告，不只寫在主控台', () => {
    // 「這次沒偵測到」與「偵測根本沒接上線」必須在**人真的會讀的那份東西**上
    // 分得出來。主控台只在 job step 的 log 裡；貼進 issue 的是這份 markdown。
    const src = readFileSync(new URL('./check-external-links.mjs', import.meta.url), 'utf8');
    // 兩個等級都要有數字。只報 actionable 的話，「跨站轉址那一段今天是 0」與
    // 「跨站轉址整段被我不小心刪掉了」在報告上長得一模一樣。
    for (const bucket of ['actionableSignals', 'browseOnlySignals']) {
        const re = new RegExp(`\\$\\{${bucket}\\.length\\}`);
        const summary = src.slice(src.indexOf('const lines = '));
        assert.ok(re.test(summary), `報告的摘要沒有列出 ${bucket} 的數量`);
    }
    // 摘要那一段不可以被包在「有命中才寫」的條件裡——包起來就等於沒寫。
    //
    // 這裡比對的是**源碼形狀**，不是行為：check-external-links.mjs 的報告產生器是
    // 第 324–610 行的一整段頂層語句，要真的跑起來得先連 508 個目標，沒辦法做成
    // 單元測試。所以改用一個在這個檔案裡成立、而且繞不過去的不變量——
    // **那個 lines.push( 必須是第 0 欄的頂層語句**。
    //
    // 之所以不比對「有沒有被包在 if 裡」：第一版是找 `if (x) {`，結果無大括號的
    // `if (x) lines.push(` 直接繞過去，故障注入當場證實了（突變沒被抓到）。
    // 縮排這條線兩種寫法都擋得住，因為任何一種包裹都會讓它離開第 0 欄。
    const srcLines = src.split(/\r?\n/);
    const at = srcLines.findIndex((l) => l.includes('- 自動偵測：需處理'));
    assert.ok(at > 0, '報告的摘要裡找不到訊號數那一行');
    let open = -1;
    for (let i = at; i >= 0; i -= 1) {
        if (srcLines[i].includes('lines.push(')) { open = i; break; }
    }
    assert.ok(open >= 0, '訊號數那一行前面找不到 lines.push(');
    assert.match(
        srcLines[open],
        /^lines\.push\($/,
        `訊號數那一行的 lines.push 不是頂層語句（實際是 ${JSON.stringify(srcLines[open])}）——` +
            '被縮排或被前綴，代表它被包進了某個條件裡，沒命中時就不會出現在報告上',
    );
});

test('報告：跨站轉址不進 needsAttention，內容標記與 HTTP 盲區才進', () => {
    // 這是這份檢查最重要的一條線。實測全站 508 個目標，跨站轉址命中 11 筆、
    // **全部誤判**（4 筆兄弟子網域、7 筆機構改名或短網址）。把它接上通知，
    // 維護者會在第三週學會忽略整個看門狗。
    const src = readFileSync(new URL('./check-external-links.mjs', import.meta.url), 'utf8');
    const cond = src.match(/const needsAttention =[\s\S]*?;/);
    assert.ok(cond, '找不到 needsAttention 的定義');
    assert.ok(
        cond[0].includes('actionableSignals.length > 0'),
        'needsAttention 沒有把 actionable 訊號算進去',
    );
    assert.ok(
        !/\bautoSignals\.length\b/.test(cond[0]) && !/\bbrowseOnlySignals\b/.test(cond[0]),
        'needsAttention 仍然把誤判率極高的跨站轉址算進去了',
    );
});

test('contentSquatSignals：ieso-info.org 實測到的 head 會被抓到', () => {
    // 2026-08-28 實測的原文。**必須連 description 一起餵**——門檻是「至少兩個
    // 相異詞組」，只有標題的話 online pokies 一個詞組不夠，那是刻意的。
    const hits = contentSquatSignals(
        '<title>Best Online Pokies in Australia 2026 - Play For Real Money</title>' +
            '<meta name="description" content="Enjoy the best real money pokies in Australia at ' +
            'trusted casinos. Claim free spins, grab exclusive bonuses">',
    );
    const distinct = new Set(hits.map((h) => h.phrase));
    assert.ok(distinct.size >= 2, `只命中 ${distinct.size} 個相異詞組：${[...distinct]}`);
    assert.ok(hits.some((h) => h.where === 'title'));
});

test('contentSquatSignals：停放待售的網域會被抓到（過期學術網域最常見的下場）', () => {
    // 真實的停放頁不會只提一次。單一詞組的版本刻意**不**命中——那正是
    // 「至少兩個相異詞組」要擋掉的形態（教育內容常常只會提到一次）。
    assert.ok(
        contentSquatSignals(
            '<title>This domain may be for sale</title>' +
                '<meta name="description" content="Buy this domain today. Domain parking by our registrar.">',
        ).length > 0,
    );
    assert.deepEqual(
        contentSquatSignals('<title>This domain may be for sale</title>'),
        [],
        '只有一個詞組不該命中——那是門檻的重點',
    );
});

test('contentSquatSignals：門檻是「相異」詞組，同一個詞出現兩次不算兩個', () => {
    // 同一個詞在 title 與 description 各出現一次會產生 2 筆 hit，但只有 1 個相異詞組。
    const hits = contentSquatSignals(
        '<title>Online Casino</title><meta name="description" content="The best online casino.">',
    );
    assert.deepEqual(hits, [], '同一個詞組重複出現不該通過門檻');
});

// 反例——這一組比正例更重要。誤判會讓維護者把整個偵測關掉。
test('contentSquatSignals：詞界在「至少兩個相異詞組」的門檻下仍然承重', () => {
    // 這一格是被 CI 逼出來的。原本驗詞界的反例都只放**一個**近似命中，門檻拉到
    // 兩個相異詞組之後，那些反例不論詞界對不對都回空——故障注入把詞界比對整條
    // 換成純子字串，測試竟然還是綠的（56 擋下 / 2 漏掉）。
    //
    // 所以反例要放**兩個**近似命中在同一份文件裡：詞界正確時仍然是 0 個相異詞組，
    // 退化成純子字串時就會湊到 2 個而突破門檻。
    const html =
        '<title>Sign up for the free spins-off workshop</title>'
        + '<meta name="description" content="Our online casino-style probability lab for students">';
    assert.deepEqual(
        contentSquatSignals(html),
        [],
        '連字號複合詞穿過了詞界比對——free spins-off 與 online casino-style 都不是變現詞組',
    );
    // 同一組字，把連字號換成空白就該命中，證明上面回空不是因為根本沒在比。
    const real = contentSquatSignals(
        '<title>Sign up for the free spins today</title>'
        + '<meta name="description" content="Our online casino for real players">',
    );
    assert.ok(
        new Set(real.map((h) => h.phrase)).size >= 2,
        `把連字號換成空白之後應該要命中兩個相異詞組，實際命中 ${JSON.stringify(real.map((h) => h.phrase))}`,
    );
});

test('contentSquatSignals：正當的競賽／教育頁面一個都不得命中', () => {
    const legit = [
        '<title>國際數學奧林匹亞 IMO 2026</title>',
        '<title>National Science Fair — Registration</title>',
        // 單字陷阱：這些含有 poker/slot/porn 的子字串或單字，但不是變現詞組
        '<title>Game Theory Workshop: Poker as a Model of Imperfect Information</title>',
        '<title>Time Slot Allocation Contest</title>',
        '<title>媒體識讀：網路色情與青少年 pornography 研究論文競賽</title>',
        '<title>Casino Royale 影評寫作比賽</title>',
        '<meta name="description" content="Sign up for the free spins-off workshop series.">',
        '<title>臺灣國際科學展覽會</title>',
        '<title>Loan Analysis Case Competition for High School Students</title>',
        '<title>DOMAIN: 資訊安全競賽</title>',
    ];
    for (const html of legit) {
        assert.deepEqual(
            contentSquatSignals(html),
            [],
            `誤判：${html.slice(0, 70)} 不該被標記為蹲域名`,
        );
    }
});

test('SQUAT_PHRASES：一律是多字詞組，不得有單字', () => {
    // 單字在教育網站的連結集合裡誤判率太高（poker／slot／porn 都有正當用法）。
    // 這條把那個設計約束釘住，避免日後有人「順手」加一個單字進來。
    const singles = SQUAT_PHRASES.filter((p) => /^[a-z]+$/.test(p));
    assert.deepEqual(singles, [], `以下是單字，會製造誤判：${singles.join('、')}`);
});

// ── 端對端：body 讀取的管線真的通嗎 ─────────────────────────────
let server;
let base;
let localhostBase;

test.before(async () => {
    server = createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/casino') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(
                '<html><head><title>Best Online Pokies in Australia 2026</title>' +
                    '<meta name="description" content="Real money pokies and free spins at trusted casinos.">' +
                    '</head><body>x</body></html>',
            );
        } else if (url.pathname === '/legit') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<html><head><title>國際地球科學奧林匹亞 IESO</title></head><body>x</body></html>');
        } else if (url.pathname === '/cross') {
            // 127.0.0.1 與 localhost 是不同的主機名 → 依後綴規則屬跨站
            res.writeHead(302, { location: `http://localhost:${server.address().port}/legit` });
            res.end('<title>Best Online Pokies</title>'); // 轉址回應的 body 不該被讀
        } else if (url.pathname === '/huge') {
            res.writeHead(200, { 'content-type': 'text/html' });
            res.write('<title>x</title>');
            res.write('A'.repeat(500_000)); // 遠大於上限，證明會被截斷而不是讀完
            // 刻意不 end：讀滿上限就 destroy 才是對的行為
        } else if (url.pathname === '/gzip') {
            // 宣稱壓縮但送的是明文——模擬伺服器無視 identity 的情況
            res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
            res.end('<title>Best Online Pokies in Australia</title>');
        } else {
            res.writeHead(404).end('nope');
        }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    localhostBase = `http://localhost:${server.address().port}`;
});

test.after(() => server && server.close());

test('端對端：不開 readBodyBytes 時完全維持原本行為（不讀 body）', async () => {
    const r = await probe(`${base}/casino`, undefined, LOOPBACK);
    assert.equal(r.status, 200);
    assert.equal(r.bodyHead, undefined);
    assert.equal(detectHijackSignals(`${base}/casino`, r), null);
});

test('端對端：開了 readBodyBytes 才讀得到 title，並命中內容標記', async () => {
    const r = await probe(`${base}/casino`, undefined, { ...LOOPBACK, readBodyBytes: 16384 });
    assert.equal(r.status, 200);
    assert.match(r.bodyHead, /Pokies/);
    const sig = detectHijackSignals(`${base}/casino`, r);
    assert.ok(sig, '應該偵測到內容標記');
    assert.ok(new Set(sig.content.map((c) => c.phrase)).size >= 2);
    assert.equal(sig.confidence, 'actionable', '內容標記屬於會觸發 issue 的等級');
});

test('端對端：正常的競賽頁不得被標記', async () => {
    const r = await probe(`${base}/legit`, undefined, { ...LOOPBACK, readBodyBytes: 16384 });
    assert.equal(r.status, 200);
    assert.equal(detectHijackSignals(`${base}/legit`, r), null);
});

test('端對端：跨主機名轉址會被訊號 A 抓到，且不讀轉址回應的 body', async () => {
    const r = await probe(`${base}/cross`, undefined, { ...LOOPBACK, readBodyBytes: 16384 });
    assert.equal(r.status, 200);
    // 終點是 /legit，body 是那一頁的；轉址回應裡那個 Pokies 標題不該混進來
    assert.doesNotMatch(r.bodyHead || '', /Pokies/, '轉址回應的 body 被讀進來了');
    const sig = detectHijackSignals(`${base}/cross`, r);
    assert.ok(sig && sig.cross, '跨主機名轉址應該被偵測到');
    assert.equal(sig.cross.fromHost, '127.0.0.1');
    assert.equal(sig.cross.toHost, 'localhost');
    assert.equal(sig.content.length, 0, '終點是正常頁面，不該有內容標記');
});

test('端對端：body 讀取有上限，不會把超大頁面讀完', async () => {
    const CAP = 4096;
    const t0 = Date.now();
    const r = await probe(`${localhostBase}/huge`, undefined, { ...LOOPBACK, readBodyBytes: CAP });
    assert.equal(r.status, 200);
    assert.ok(
        Buffer.byteLength(r.bodyHead, 'utf8') <= CAP + 65536,
        `讀了 ${Buffer.byteLength(r.bodyHead, 'utf8')} bytes，遠超過上限 ${CAP}`,
    );
    // 那個 handler 刻意不 end；沒有上限的話這裡會卡到 timeout
    assert.ok(Date.now() - t0 < 10_000, '讀滿上限之後沒有立刻結束，可能沒有 destroy');
});

test('端對端：伺服器無視 identity 仍回壓縮時，放棄解析而不是拿亂碼比對', async () => {
    const r = await probe(`${base}/gzip`, undefined, { ...LOOPBACK, readBodyBytes: 16384 });
    assert.equal(r.status, 200);
    assert.equal(r.bodyHead, undefined, '不該保留無法解析的位元組');
    assert.match(r.bodySkipped || '', /content-encoding/);
    // 那一頁的標題其實含 'online pokies'，但因為解不開，**不得**產生訊號——
    // 拿解不開的位元組去比對是假訊號，比不檢查更糟。
    assert.equal(detectHijackSignals(`${base}/gzip`, r), null);
});

test('detectHijackSignals：dead／blocked 的結果不重複標記', () => {
    assert.equal(detectHijackSignals('https://x.test/', { blocked: true, reason: 'x' }), null);
    assert.equal(detectHijackSignals('https://x.test/', { status: 404, finalUrl: 'https://y.test/' }), null);
    assert.equal(detectHijackSignals('https://x.test/', { status: 0, code: 'ENOTFOUND' }), null);
});

// ── 訊號 C：HTTP 層看不到內容 ──────────────────────────────────
test('opaqueShell：hmun.org 實測到的 JS 挑戰殼會被標出來', () => {
    // 2026-08-28 實測的原文（470 bytes）。轉址目標是**同一台主機**帶 JWT，
    // 所以訊號 A 看不到；沒有任何變現詞彙，所以訊號 B 也看不到。
    const real =
        "<html><head><title>Loading...</title></head><body><script type='text/javascript'>" +
        "window.location.replace('https://hmun.org/?ch=1&js=eyJhbGciOiJIUzI1NiJ9.abc&sid=4eade933');" +
        "</script></body></html>";
    const r = opaqueShell(real);
    assert.ok(r, '470 bytes 的純 JS 轉址殼應該被標出來');
    assert.equal(r.title, 'Loading...');
    assert.ok(r.bytes < 2048);
});

test('opaqueShell：有 meta refresh 的小殼**不算**盲區（不需要 JS 就走得下去）', () => {
    // 這兩份是對照組實測到的原文。第一版的判準（小 body ＋ 任何轉址構造）把它們
    // 都標成可疑——2/6 的誤判率，會讓整個偵測被當成雜訊關掉。
    const cac =
        '<html>\n<head>\n<meta http-equiv="refresh" content="0;url=https://www.cac.edu.tw/cacportal/index.php">\n' +
        '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n<title>大學甄選入學委員會</title>\n</head>\n<body></body>\n</html>';
    const tpmso =
        '<html>\n<head>\n<meta http-equiv="refresh" content="0;url=https://tpmso.k12ea.gov.tw/home/" />\n' +
        '<title>Welcome to Taiwan Olympiad Portal</title>\n</head>\n' +
        '<body onload="parent.location=\' https://tpmso.k12ea.gov.tw/home/\' ">\n</body>\n</html>';
    assert.equal(opaqueShell(cac), null, '大學甄選入學委員會的舊式轉址頁不是盲區');
    // tpmso 同時有 meta refresh 與 parent.location——meta refresh 存在就走得下去
    assert.equal(opaqueShell(tpmso), null, '有 meta refresh 就不算盲區，即使同時有 JS');
});

test('opaqueShell：正常頁面不得被標記', () => {
    // 小但沒有轉址構造——正常的極簡頁面
    assert.equal(opaqueShell('<html><head><title>IMO 2026</title></head><body><h1>報名</h1></body></html>'), null);
    // 有 location 指派但頁面很大——正常的 JS 網站
    const big = '<html><head><title>臺灣國際科學展覽會</title></head><body>' + '內容'.repeat(900) +
        '<script>document.querySelector("a").onclick=()=>{location.href="/apply"}</script></body></html>';
    assert.ok(Buffer.byteLength(big, 'utf8') > 2048);
    assert.equal(opaqueShell(big), null, '大頁面裡的正常 JS 導覽不該被當成殼');
    // 空的／非字串
    assert.equal(opaqueShell(''), null);
    assert.equal(opaqueShell(null), null);
});

test('opaqueShell：整份真實語料不得有誤判', () => {
    // 從實際跑過的全站探測取樣的正常頁面形態
    const legit = [
        '<html><head><title>大學甄選入學委員會</title></head><body><div id="app"></div></body></html>',
        '<!doctype html><title>ColleGo!</title><body><noscript>請開啟 JavaScript</noscript>',
    ];
    for (const h of legit) assert.equal(opaqueShell(h), null, `誤判：${h.slice(0, 60)}`);
});
