/**
 * 內文裸網域擷取規則的精確度測試
 * --------------------------------------------------------------
 * 「跑起來看起來對」不算證明。這支用正例／反例語料把規則釘死：哪些字串必須被
 * 擷出、哪些絕對不可以。反例是重點——裸網域擷取天生會誤判檔名、版本號、縮寫，
 * 而每一個誤判都會變成一筆假的「連結失效」，最後把維護者訓練成忽略報告。
 *
 * 全部離線。TLD 是否存在由注入的假 resolver 決定，測試不得依賴外網——外網會飄，
 * 而「規則對不對」必須是確定性的。真實 DNS 只在排程健檢裡用。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    extractBareDomainCandidates,
    collectBareDomains,
    screenBareDomains,
    makeTldChecker,
    probeUrlFor,
    SHADOWED_BY_FILE_EXT,
    makeSkipFieldFilter,
} from './bare-domains.lib.mjs';
import { staticUrlPolicy } from './link-health.lib.mjs';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));

/** 擷取出來的主機名清單（stage 1，純字串）。 */
const hostsOf = (text) => extractBareDomainCandidates(text).map((c) => c.host);

/**
 * 假的根區。刻意只放測試會用到的 TLD——真實根區有一千多個，而且會變；
 * 測試要驗的是「規則怎麼用這個答案」，不是「根區今天長怎樣」。
 */
const FAKE_ROOT = new Set([
    'org', 'com', 'net', 'tw', 'au', 'de', 'hk', 'sg', 'africa', 'world', 'now',
    'edu', 'gov', 'uk', 'jp', 'io', 'info', 'app', 'dev', 'so', 'ai', 'md', 'sh', 'py', 'rs', 'zip',
]);
let nsCalls = [];
const fakeResolveNs = async (name) => {
    nsCalls.push(name);
    const label = String(name).replace(/\.$/, '').toLowerCase();
    if (FAKE_ROOT.has(label)) return ['a.root-servers.example'];
    const err = new Error(`queryNs ENOTFOUND ${name}`);
    err.code = 'ENOTFOUND';
    throw err;
};
const screen = (hosts) => {
    nsCalls = [];
    return screenBareDomains(hosts, { resolveNs: fakeResolveNs });
};

// ──────────────────────────────────────────────────────────────
// A. 正例：真實資料裡實際出現的寫法都必須被擷出
// ──────────────────────────────────────────────────────────────

test('正例：中文句子裡的裸網域（句號、逗號、頓號為界）', () => {
    assert.deepEqual(hostsOf('現行官網為 harvardmun.org。'), ['harvardmun.org']);
    assert.deepEqual(hostsOf('原 tpmso.org 已轉址至 tpmso.k12ea.gov.tw）。'), ['tpmso.org', 'tpmso.k12ea.gov.tw']);
    assert.deepEqual(hostsOf('舊網域 zindi.africa 會轉址到現行的 zindi.world。'), ['zindi.africa', 'zindi.world']);
    assert.deepEqual(hostsOf('註：正確網域是單數的 competition.igem.org。'), ['competition.igem.org']);
});

test('正例：全形括號與引號內的裸網域', () => {
    assert.deepEqual(hostsOf('（www.ioaastrophysics.org 會 301 轉址）'), ['www.ioaastrophysics.org']);
    assert.deepEqual(hostsOf('逐字「picoCTF.org is now CyLab」'), ['picoctf.org']);
    assert.deepEqual(hostsOf('賽區（yauaward-asia.hk，由香港科學院營運）'), ['yauaward-asia.hk']);
});

test('正例：多層網域完整保留，不做任何截短', () => {
    assert.deepEqual(hostsOf('官網 sciexplore.colife.org.tw 會自動轉址'), ['sciexplore.colife.org.tw']);
    assert.deepEqual(hostsOf('現行官網為 sasmo.simcc.org。'), ['sasmo.simcc.org']);
    assert.deepEqual(hostsOf('資奧辦公室 tpmso.k12ea.gov.tw'), ['tpmso.k12ea.gov.tw']);
});

test('正例：含數字與連字號的 label', () => {
    assert.deepEqual(hostsOf('附屬的 EOF CTF 見 ais3.org'), ['ais3.org']);
    assert.deepEqual(hostsOf('原先登記的 ipho2026.com 只是單屆網站'), ['ipho2026.com']);
    assert.deepEqual(hostsOf('「selected to host IOI 2027」（ioi2027.de）'), ['ioi2027.de']);
    assert.deepEqual(hostsOf('常設官網為 ipho-new.org。'), ['ipho-new.org']);
    assert.deepEqual(hostsOf('302 轉至無法連線的 ww1.hmun.org），'), ['ww1.hmun.org']);
});

test('正例：後面接路徑時只取主機名', () => {
    assert.deepEqual(hostsOf('賽事頁為 amt.edu.au/amc。'), ['amt.edu.au']);
    assert.deepEqual(hostsOf('（ais3.org/eof/，2026 屆初賽）'), ['ais3.org']);
    assert.deepEqual(hostsOf('國際官方頁面為 www.igeoscied.org/activities/ieso-2/。'), ['www.igeoscied.org']);
});

// ──────────────────────────────────────────────────────────────
// B. 反例：這些一個都不可以被當成網域
// ──────────────────────────────────────────────────────────────

test('反例：版本號與數字序列（TLD 必須是純字母）', () => {
    for (const s of ['v1.63', '版本 1.2.3 起支援', 'Chrome/126.0.0.0 Safari/537.36', '第 66 屆 3.14 分']) {
        assert.deepEqual(hostsOf(s), [], `不該擷出任何東西：${s}`);
    }
});

test('反例：句中縮寫 e.g. / i.e.（TLD 長度不足 2）', () => {
    assert.deepEqual(hostsOf('例如 e.g. 這種寫法'), []);
    assert.deepEqual(hostsOf('亦即 i.e. 的用法'), []);
    assert.deepEqual(hostsOf('U.S. 代表隊'), []);
});

test('反例：與副檔名撞名的 TLD 一律不從內文擷取（確定性，不靠 DNS）', () => {
    // 實測：readme.md、test.sh、cargo.rs 都被蹲域名的人註冊、解析得到，所以
    // 「可不可解析」對這一組毫無鑑別力，只能靠形態直接排除。
    for (const s of ['README.md', 'libc.so', 'main.py', 'test.sh', 'Cargo.rs', 'archive.zip',
                     'Utils.pm', 'main.tf', 'parser.ml', 'driver.cab', 'poster.pub', 'bundle.js.map', 'Xcode.app']) {
        assert.deepEqual(hostsOf(`請見 ${s} 檔案`), [], `不該擷出：${s}`);
    }
    for (const tld of ['md', 'so', 'sh', 'py', 'rs', 'zip', 'pm', 'tf', 'ml', 'cab', 'pub', 'map', 'app']) {
        assert.ok(SHADOWED_BY_FILE_EXT.has(tld), `${tld} 應在撞名清單內`);
    }
});

test('.ai 刻意不遮蔽——遮了會漏掉本站內文推薦的真實網站', () => {
    // 原始清單把 .ai 當成 Adobe Illustrator 遮掉，並宣稱「代價為 0」。canary 測試
    // 一跑就推翻了：online-courses.json 的課程提供者是「DeepLearning.AI」、
    // methodology.json 推薦「Otter.ai (AI語音轉文字)」，兩個都是真實網站，卻永遠
    // 不會被檢查。.ai 現在是 AI 產品的主流網域，內文裡出現真網域的機率遠高於
    // 出現 Illustrator 檔名，因此不遮——代價是 logo.ai 這種檔名會被探測，
    // 拿到的結果只是一筆無害的噪音，遠比永久漏檢兩個真網站好。
    assert.ok(!SHADOWED_BY_FILE_EXT.has('ai'), '.ai 不可以在遮蔽清單裡');
    assert.deepEqual(hostsOf('課程由 DeepLearning.AI 提供'), ['deeplearning.ai']);
    assert.deepEqual(hostsOf('可使用 Otter.ai (AI語音轉文字) 協助整理逐字稿'), ['otter.ai']);
});

test('反例：電子郵件的右半邊是郵件主機，不是網站', () => {
    assert.deepEqual(hostsOf('請洽 info@immchallenge.org 確認'), []);
    assert.deepEqual(hostsOf('IGL 為 Peter Shiue（shiue@unlv.nevada.edu）'), []);
    assert.deepEqual(hostsOf('可洽 AMCinternational@maa.org。'), []);
    assert.deepEqual(hostsOf('mailto:hctsai@linux.com'), []);
});

test('反例：信箱的「左」半邊帶點時也不可被當成網域', () => {
    // 這一條是故障注入抓出來的漏洞。右半邊靠左界的 lookbehind（@ 擋掉）就夠了，
    // 但左半邊沒有任何東西擋：把遮蔽信箱那一步拿掉之後，first.last@maa.org 會
    // 擷出 first.last、hctsai.linux@example.com 會擷出 hctsai.linux，而原本的
    // 測試全部照樣是綠的。
    assert.deepEqual(hostsOf('寄到 first.last@maa.org'), []);
    assert.deepEqual(hostsOf('寄到 hctsai.linux@example.com'), []);
});

test('反例：網址的 query／fragment 裡帶網域也不可被擷出', () => {
    // 同樣是故障注入抓出來的。左界的 lookbehind 擋得掉路徑（前面是 /），卻擋不掉
    // 「?ref=」「&subid=」「#」後面的網域——= 與 # 都不在 lookbehind 的字元類裡。
    // 這不是假設的情況：本站資料實際記錄的轉址鏈就長這樣。
    assert.deepEqual(hostsOf('轉址到 https://arcade.now/lp1/play?subid=sasmo.sg&subid2=TW 的廣告頁'), []);
    assert.deepEqual(hostsOf('見 https://a.com/x?ref=foo.org 一文'), []);
    assert.deepEqual(hostsOf('見 https://a.com/x#frag.org 一節'), []);

    // 上面三條全都帶 scheme，所以是被 URL_LIKE 整段遮掉才通過的——它們並沒有測到
    // 註解裡點名的真正成因（= 與 # 不在 lookbehind 裡）。內文若把轉址鏈寫成沒有
    // scheme 的形式，URL_LIKE 就遮不到，參數值會被當成主機名擷出去探測。
    // 這正是本站 competitions.json 記錄 sasmo.sg 轉址鏈時可能出現的寫法。
    assert.deepEqual(hostsOf('會被導向 arcade.now/lp1/play?subid=sasmo.sg&subid2=TW'), ['arcade.now']);
    assert.deepEqual(hostsOf('追蹤網址 tracker.com/x?ref=partner.org'), ['tracker.com']);
    assert.deepEqual(hostsOf('參見 example.org/docs#section.org 的說明'), ['example.org']);
    assert.deepEqual(hostsOf('見 a.com/x?a=1&b=evil.org 一文'), ['a.com']);
});

test('反例：整串主機名超過 253 字元（label 數量不設限，regex 管不到）', () => {
    const tooLong = `${Array.from({ length: 60 }, (_, i) => `l${i}abc`).join('.')}.org`;
    assert.ok(tooLong.length > 253, `語料本身要夠長（實際 ${tooLong.length}）`);
    assert.deepEqual(hostsOf(`見 ${tooLong} 說明`), []);
    // 剛好在上限內的仍然要擷得出來，證明不是整條規則被關掉
    assert.deepEqual(hostsOf('見 sub.example.org 說明'), ['sub.example.org']);
});

test('反例：完整網址已由既有擷取涵蓋，不可重複擷出，路徑也不可被誤判', () => {
    assert.deepEqual(hostsOf('官網 https://twsf.ntsec.gov.tw/ 報名'), []);
    // 網址路徑裡的 .org 結尾片段最容易被誤擷
    assert.deepEqual(hostsOf('見 https://example.com/files/report.org 一文'), []);
    assert.deepEqual(hostsOf('見 http://a.tw/b.com/c.net 頁'), []);

    // 路徑的分隔字元不是只有 /。逗號、分號、加號、百分比編碼後面的片段，左界的
    // lookbehind 一概擋不掉，只有「先把整條網址遮掉」才擋得住。少了下面這幾條，
    // 把 URL_LIKE 遮蔽拿掉之後整組測試仍然全綠（故障注入實測），等於那道遮蔽沒人守。
    assert.deepEqual(hostsOf('見 https://a.com/path,report.org 一文'), []);
    assert.deepEqual(hostsOf('見 https://a.com/path;report.org 一文'), []);
    assert.deepEqual(hostsOf('見 https://a.com/path+report.org 一文'), []);
    assert.deepEqual(hostsOf('見 https://a.com/path%20report.org 一文'), []);
});

test('反例：路徑片段（左界不可接在斜線或英數之後）', () => {
    assert.deepEqual(hostsOf('/files/report.org'), []);
    assert.deepEqual(hostsOf('C:\\tmp\\notes.org'), []);
    // a.b.c 只能整串比對一次，不可以再從中間擷出 b.c
    assert.deepEqual(hostsOf('見 sub.example.org 說明'), ['sub.example.org']);
});

test('反例：換行不可把兩段接成一個網域', () => {
    assert.deepEqual(hostsOf('example.\norg'), []);
    assert.deepEqual(hostsOf('結尾 example.\n下一行 org'), []);
});

test('反例：全形句點不是網域分隔符（已知限制，刻意不正規化）', () => {
    // U+FF0E 正規化成 "." 會讓「官網。org」這類中文句讀被誤接。實測本站資料
    // 一個 U+FF0E 都沒有（U+3002 有 413 個），所以刻意不處理。
    assert.deepEqual(hostsOf('ais3．org'), []);
});

test('反例：不合法的 DNS label', () => {
    assert.deepEqual(hostsOf('見 -bad.org 說明'), []);
    assert.deepEqual(hostsOf('見 bad-.org 說明'), []);
    assert.deepEqual(hostsOf(`見 ${'a'.repeat(64)}.org 說明`), []);
});

// ──────────────────────────────────────────────────────────────
// C. 去重與主機名語意
// ──────────────────────────────────────────────────────────────

test('去重：同一網域重複出現只算一次，且大小寫視為同一台', () => {
    const found = collectBareDomains({
        a: '原 picoctf.org 已搬遷',
        b: '逐字「picoCTF.org is now CyLab」',
        c: 'picoCTF.org 再提一次',
    });
    assert.deepEqual([...found.keys()], ['picoctf.org']);
    assert.deepEqual(found.get('picoctf.org'), ['/a', '/b', '/c'], '每一處出處都要留下');
});

test('主機名不做正規化：www. 與子網域都是不同的主機', () => {
    const found = collectBareDomains({
        a: '原 www.amt.edu.au 首頁查不到日期，賽事頁為 amt.edu.au/amc',
        b: '官方入口 ctf.hitcon.org 與 hitcon.org 是不同主機',
    });
    const hosts = [...found.keys()].sort();
    assert.deepEqual(hosts, ['amt.edu.au', 'ctf.hitcon.org', 'hitcon.org', 'www.amt.edu.au']);
});

test('collectBareDomains 可只掃指定欄位', () => {
    const data = { keep: '見 a.org', skip: '見 b.org' };
    const found = collectBareDomains(data, (pointer) => pointer !== '/skip');
    assert.deepEqual([...found.keys()], ['a.org']);
});

// ──────────────────────────────────────────────────────────────
// D. Stage 2：TLD 是否存在（用 DNS 根區，不是可解析性）
// ──────────────────────────────────────────────────────────────

test('stage2：TLD 不在根區的候選被淘汰（Node.js／檔名／自創詞）', async () => {
    const { accepted, rejected } = await screen(['node.js', 'fuse.min.js', 'edu.harbour', 'competitions.html', 'check-competitions.mjs']);
    assert.deepEqual(accepted, []);
    assert.equal(rejected.length, 5);
    assert.match(rejected[0].reason, /不是 DNS 根區裡的 TLD/);
});

test('stage2：TLD 在根區的候選被保留', async () => {
    const { accepted, rejected } = await screen(['harvardmun.org', 'zindi.africa', 'ioi2027.de', 'tpmso.k12ea.gov.tw']);
    assert.deepEqual(accepted, ['harvardmun.org', 'zindi.africa', 'ioi2027.de', 'tpmso.k12ea.gov.tw']);
    assert.deepEqual(rejected, []);
});

test('stage2：已經停用的網域必須留在 accepted——這正是要抓的東西', async () => {
    // 這一條是整份設計的樞紐。如果拿「查不查得到 A 記錄」當「是不是網域」的判準，
    // concordreview.org 這種已經停用的網域會被當成「不是網域」丟掉，檢查器對它
    // 唯一該偵測的目標永久失明。screenBareDomains 只看 TLD，絕不查該網域本身。
    const lookupCalls = [];
    const { accepted } = await screenBareDomains(['concordreview.org'], {
        resolveNs: fakeResolveNs,
        // 若日後有人偷偷加上可解析性判斷，這個 spy 會被呼叫而讓測試紅
        lookup: async (h) => {
            lookupCalls.push(h);
            throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        },
    });
    assert.deepEqual(accepted, ['concordreview.org']);
    assert.deepEqual(lookupCalls, [], 'screenBareDomains 不可以去查網域本身的 A/AAAA 記錄');
});

test('stage2：同一個 TLD 只查一次（快取）', async () => {
    await screen(['a.org', 'b.org', 'c.org', 'd.tw', 'e.tw']);
    assert.deepEqual(nsCalls, ['org.', 'tw.'], `實際查詢：${nsCalls.join('、')}`);
});

test('stage2：DNS 沒回答的候選不採用，但必須進 unresolved 而不是 rejected', async () => {
    // 「根區說沒有這個 TLD」與「這次沒問到答案」是兩件事，先前都被壓成 rejected。
    // 壓在一起的代價實測過：把 resolver 指到 192.0.2.1（無人回應），30 個候選全數
    // 變成 rejected，報告寫「.org 不是 DNS 根區裡的 TLD」，而 needs_attention=false、
    // coverage_complete=true——一個裸網域都沒檢查，CI 全綠。那正是靜默漏檢。
    for (const code of ['SERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ECANCELLED']) {
        const { accepted, rejected, unresolved } = await screenBareDomains(['x.org'], {
            resolveNs: async () => {
                throw Object.assign(new Error(code), { code });
            },
        });
        assert.deepEqual(accepted, [], `${code}：沒把握就不可以拿去探測`);
        assert.deepEqual(rejected, [], `${code}：沒問到答案不可以被斷言成「不是網域」`);
        assert.equal(unresolved.length, 1, `${code}：必須單獨回報，否則就是靜默漏檢`);
        assert.match(unresolved[0].reason, /查不到答案/);
    }
});

test('stage2：根區明確說沒有這個 TLD 才可以進 rejected', async () => {
    for (const code of ['ENOTFOUND', 'NOTFOUND', 'ENODATA', 'NODATA', 'NXDOMAIN']) {
        const { accepted, rejected, unresolved } = await screenBareDomains(['node.js'], {
            resolveNs: async () => {
                throw Object.assign(new Error(code), { code });
            },
        });
        assert.deepEqual(accepted, []);
        assert.equal(rejected.length, 1, `${code}：這是明確的「沒有這個名字」`);
        assert.deepEqual(unresolved, []);
    }
});

test('stage2：三桶的總數必須等於輸入數（不可以有候選人間蒸發）', async () => {
    const hosts = ['a.org', 'node.js', 'b.tw', 'x.unknowntld'];
    const { accepted, rejected, unresolved } = await screen(hosts);
    assert.equal(accepted.length + rejected.length + unresolved.length, hosts.length);
});

test('stage2：沒有注入 resolver 就必須拋錯（測試不得連外網）', () => {
    assert.throws(() => makeTldChecker({}), /resolveNs/);
});

test('反例：非 CJK 字母緊貼網域時不可截斷成另一台主機（張冠李戴）', () => {
    // 這比誤判更糟：內文點名 A 網域，檢查器去驗 B 網域並回報 B 的健康狀態，
    // 產生的是**錯誤的保證**。西里爾 е 與全形 Ａ 都不在 ASCII 左界字元類裡，
    // 少了第二道 lookbehind 就會擷出 vil.org／bc.org 這兩台真實存在的主機。
    assert.deepEqual(hostsOf('假冒網站 еvil.org 請勿點擊'), []);
    assert.deepEqual(hostsOf('請見 Ａbc.org 的說明'), []);
    assert.deepEqual(hostsOf('見 αlpha.org 說明'), []);
});

test('正例：CJK 緊貼網域必須照樣擷得出來（本站語料的實際形態）', () => {
    // 上一條的左界不可以連中文一起擋掉——「官網為tpmso.org」沒有空白，
    // 而那正是 competitions.json 描述文字裡最常見的寫法。
    assert.deepEqual(hostsOf('官網為tpmso.org，請注意'), ['tpmso.org']);
    assert.deepEqual(hostsOf('サイトはtcr.orgです'), ['tcr.org']);
    assert.deepEqual(hostsOf('現行官網為 harvardmun.org。'), ['harvardmun.org']);
});

test('makeSkipFieldFilter：pointer 的任何一段命中就跳過（不是只看最後一段）', () => {
    const accept = makeSkipFieldFilter(['thumbnail_url', 'image', '_readme']);
    assert.equal(accept('/competitions/0/description'), true);
    assert.equal(accept('/_readme'), false);
    assert.equal(accept('/competitions/0/image'), false);
    // 這四條是重點：欄位一旦變成陣列或物件，最後一段就會變成索引或子鍵。
    // 舊的「只比最後一段」寫法在這裡會靜默失效，把檔名與圖片路徑放進候選。
    assert.equal(accept('/_readme/0'), false);
    assert.equal(accept('/_readme/notes/3'), false);
    assert.equal(accept('/gallery/0/image/src'), false);
    assert.equal(accept('/items/2/thumbnail_url'), false);
});

test('遮蔽的代價必須是 0：本站語料不得有網域落在被遮蔽的 TLD 上', async () => {
    // SHADOWED_BY_FILE_EXT 是啟發式清單（副檔名撞名），代價是「用這些 TLD 的真實
    // 網域永遠不會被內文擷取」。那個代價現在是 0，但它必須**持續**是 0：哪天有競賽
    // 官網是 foo.app、或說明文字提到 something.map，這條測試會紅，逼人當場決定要
    // 不要把該 TLD 從遮蔽清單拿掉，而不是靜靜地永久漏檢。
    const dataPages = JSON.parse(await readFile(path.join(ROOT, 'scripts/data-pages.json'), 'utf8'));
    const accept = makeSkipFieldFilter([...dataPages.localAssetFields, '_readme']);
    const lost = new Map();
    for (const cfg of Object.values(dataPages.pages)) {
        const data = JSON.parse(await readFile(path.join(ROOT, 'public', cfg.json), 'utf8'));
        const withShadow = new Set(collectBareDomains(data, accept).keys());
        for (const [host, at] of collectBareDomains(data, accept, { keepShadowedTlds: true })) {
            if (!withShadow.has(host)) lost.set(host, `${cfg.json} ${at[0]}`);
        }
    }
    assert.deepEqual(
        [...lost.entries()],
        [],
        `有候選被 SHADOWED_BY_FILE_EXT 遮掉了。若它們其實是真網域，請把該 TLD 從清單移除；` +
            `若確實是檔名，請改寫內文或把它寫成完整網址。目前遮掉：${[...lost.keys()].join('、')}`,
    );
});

test('stage2：篩選有時間預算，用盡的候選歸 unresolved 而不是 rejected', async () => {
    // 篩選跑在 runProbes 的 12＋3 分鐘預算之外，先前完全沒有上限——實測 resolver
    // 掛掉時光是篩 30 個候選就多花 208 秒，全部白白疊在 job 上。
    let clock = 0;
    const { accepted, rejected, unresolved } = await screenBareDomains(['a.org', 'b.tw', 'c.de'], {
        resolveNs: fakeResolveNs,
        budgetMs: 100,
        now: () => (clock += 60), // 第 2 筆之後就超出預算
    });
    assert.deepEqual(accepted, ['a.org'], '預算內的那一筆要正常處理');
    assert.deepEqual(rejected, [], '沒問到的不可以被斷言成「不是網域」');
    assert.deepEqual(unresolved.map((u) => u.host), ['b.tw', 'c.de']);
    assert.match(unresolved[0].reason, /時間預算/);
});

// ──────────────────────────────────────────────────────────────
// E. 探測入口仍然走既有的 SSRF 防護
// ──────────────────────────────────────────────────────────────

test('裸網域一律用 https 探測，且仍受靜態位址政策管轄', () => {
    assert.equal(probeUrlFor('harvardmun.org'), 'https://harvardmun.org/');
    assert.ok(staticUrlPolicy(probeUrlFor('harvardmun.org')).ok);
    // 內網／保留名稱空間的裸網域不可以因為換了一條路徑就繞過防護
    for (const bad of ['evil.internal', 'foo.local', 'admin.corp', 'localhost']) {
        const verdict = staticUrlPolicy(probeUrlFor(bad));
        assert.equal(verdict.ok, false, `${bad} 必須被位址政策擋下`);
    }
});

// ──────────────────────────────────────────────────────────────
// F. 真實語料的精確度（把實測數字釘住）
// ──────────────────────────────────────────────────────────────

test('真實語料：competitions.json 的擷取結果與實測一致', async () => {
    const data = JSON.parse(await readFile(path.join(ROOT, 'public/advanced-resources/competitions.json'), 'utf8'));
    const candidates = [...collectBareDomains(data).keys()].sort();

    // stage 1 會擷到的三個非網域，全部必須在 stage 2 被淘汰。
    // 這三筆是實測結果，不是猜的——它們來自 _readme 欄位裡的檔名與一個團隊名。
    const knownFalsePositives = ['check-competitions.mjs', 'competitions.html', 'edu.harbour'];
    for (const fp of knownFalsePositives) {
        assert.ok(candidates.includes(fp), `語料應仍包含已知誤判 ${fp}（資料改了就更新這份清單）`);
    }

    // 用真實語料裡出現過的 TLD 當離線根區（測試仍不連網）
    const realRoot = new Set(['org', 'com', 'tw', 'au', 'de', 'hk', 'sg', 'africa', 'world', 'now']);
    const { accepted, rejected } = await screenBareDomains(candidates, {
        resolveNs: async (n) => {
            const l = String(n).replace(/\.$/, '');
            if (realRoot.has(l)) return ['ns.example'];
            throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
        },
    });

    assert.deepEqual(
        rejected.map((r) => r.host).sort(),
        knownFalsePositives.sort(),
        'stage 2 淘汰的必須「恰好」是那三個已知誤判，不多不少',
    );
    assert.equal(accepted.length, candidates.length - knownFalsePositives.length);

    // 通過的每一個都必須是語法上合法的主機名
    for (const host of accepted) {
        assert.ok(staticUrlPolicy(probeUrlFor(host)).ok, `${host} 應可通過位址政策`);
        assert.match(host, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, `${host} 不是合法主機名`);
    }

    // 實測基準：44 個候選、41 個真網域。資料變動時這個數字會變，屆時請一併
    // 重新查證新增的網域，而不是直接把數字改掉。
    assert.equal(candidates.length, 44, `stage 1 候選數變了（實際 ${candidates.length}）——請重新查證後再更新此基準`);
    assert.equal(accepted.length, 41, `stage 2 通過數變了（實際 ${accepted.length}）——請重新查證後再更新此基準`);
});
