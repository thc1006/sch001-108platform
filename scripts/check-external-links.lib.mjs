// 全站外部連結健檢的判定與報告：每一筆探測結果歸到報告的哪一段、什麼情況要通知、報告與主控台寫什麼。
// 這裡只放不碰網路與檔案的純函式；讀檔、探測與寫檔在 check-external-links.mjs。測試直接餵探測結果，
// 檢查分組、通知條件與報告內容（link-health.test.mjs、hijack-signals.test.mjs）。

import { classifyLink, describeResult, isBlockedResult, unverifiedBucket } from './link-health.lib.mjs';
import { matchPolicy, matchHijacked, expiringWithin } from './link-policy.lib.mjs';
import { detectHijackSignals, inertText } from './hijack-signals.lib.mjs';
import { probeUrlFor } from './bare-domains.lib.mjs';
import { EXTERNAL_LINKS_MARKER } from './watchdog-issue.lib.mjs';

/** 這個資料檔另有專屬看門狗；重疊是刻意的縱深防禦，但報告要講清楚免得重複處理。競賽看門狗只探測 url 欄位。 */
const ALSO_COVERED_BY = [
    {
        file: 'advanced-resources/competitions.json',
        location: /^\/competitions\/\d+\/url$/,
        scope: 'url 欄位',
        by: 'competitions-check.yml（另含截止日與欄位的語意檢查）',
    },
];

/** EXPIRY_NOTICE_DAYS 是政策項目到期前幾天開始每週通知。到期當天起 check-link-policy 會讓所有 PR 失敗。 */
export const EXPIRY_NOTICE_DAYS = 30;

/**
 * judgeUrl 決定盤點的一個網址在報告裡歸到哪一段，回傳 { bin, item, signal }。bin 是 blocked、hijacked、
 * dead、suppressed、unverified 或 healthy；signal 是自動偵測的訊號，沒有就是 null。
 * @param {{url: string, occurrences?: object[]}} target 盤點的一筆 @param {object} r probe 的結果
 * @param {{hijacked: object[], entries: object[]}} policy validatePolicy 回傳的兩份名單
 */
export function judgeUrl(target, r, { hijacked, entries }) {
    const item = { url: target.url, occurrences: target.occurrences ?? [], reason: describeResult(r) };
    if (isBlockedResult(r)) return { bin: 'blocked', item: { ...item, reason: r.reason }, signal: null };
    // 接管的判定必須在三態分類之前：被接管的網域回的就是 200，
    // 走到 classifyLink 就會被算進 healthy，等於用檢查器替博弈站背書。
    const hijack = matchHijacked(hijacked, target.url);
    if (hijack) return { bin: 'hijacked', item: { ...item, policy: hijack, source: 'url' }, signal: null };
    // 自動訊號跑在分類之外：它只是多一段報告，不動 dead/unverified/healthy。
    const sig = detectHijackSignals(target.url, r);
    const signal = sig ? { ...sig, source: 'url', occurrences: item.occurrences } : null;
    const verdict = classifyLink(r);
    // 例外政策不會在這裡出現。404/410 與網域解析不到一律照實回報，因為
    // allowlist 只降低 unverified 的噪音，把確定壞掉的連結壓下去等於廢掉整個檢查。
    if (verdict === 'dead') return { bin: 'dead', item, signal };
    if (verdict === 'healthy') return { bin: 'healthy', item, signal };
    const policy = matchPolicy(entries, target.url);
    if (policy) return { bin: 'suppressed', item: { ...item, policy }, signal };
    // item 沒有 status 與 code，報告的分組要在這裡從探測結果算好。
    return { bin: 'unverified', item: { ...item, bucket: unverifiedBucket(r) }, signal };
}

/**
 * judgeBare 是 judgeUrl 的裸網域版：只寫在說明文字裡的主機，用 probeUrlFor 的網址探測。
 * 裸網域沒有例外政策，無法判定也不分組，報告裡整段收合。
 * @param {{host: string, url: string, occurrences?: object[]}} target @param {object} r probe 的結果
 * @param {{hijacked: object[]}} policy validatePolicy 回傳的 hijacked
 */
export function judgeBare(target, r, { hijacked }) {
    const item = { url: target.url, host: target.host, occurrences: target.occurrences ?? [], reason: describeResult(r) };
    if (isBlockedResult(r)) return { bin: 'blocked', item: { ...item, reason: r.reason }, signal: null };
    const hijack = matchHijacked(hijacked, item.url);
    if (hijack) return { bin: 'hijacked', item: { ...item, policy: hijack, source: 'bare' }, signal: null };
    const sig = detectHijackSignals(item.url, r);
    const signal = sig ? { ...sig, source: 'bare', host: item.host, occurrences: item.occurrences } : null;
    const verdict = classifyLink(r);
    return { bin: verdict === 'dead' || verdict === 'unverified' ? verdict : 'healthy', item, signal };
}

/**
 * expiringPolicyItems 列出 EXPIRY_NOTICE_DAYS 天以內到期的政策項目，每筆加上 list，標明是例外還是接管警示。
 * @param {object[]} entries @param {object[]} hijacked validatePolicy 回傳的兩份名單
 * @param {string} todayISO 今天（YYYY-MM-DD，UTC） @returns {object[]}
 */
export function expiringPolicyItems(entries, hijacked, todayISO) {
    return [
        ...expiringWithin(entries, todayISO, EXPIRY_NOTICE_DAYS).map((e) => ({ ...e, list: '例外' })),
        ...expiringWithin(hijacked, todayISO, EXPIRY_NOTICE_DAYS).map((e) => ({ ...e, list: '接管警示' })),
    ];
}

// 三個訊號的精確度差很多，混在一起會讓高精確度的那兩個被雜訊淹掉。
// 實測（全站 508 個目標，2026-08-28）：
//   訊號 A 跨站轉址   11 個命中、全部是誤判
//     4 個是兄弟子網域（www.google.com → workspace.google.com、
//       premium.parenting.com.tw → www.parenting.com.tw ×2、
//       sciexplore.colife.org.tw → sciexplore2026.colife.org.tw）
//     7 個是機構改名／搬遷／短網址（anthropic→claude、comap.com→comap.org、
//       notion.so→notion.com、xmind.app→xmind.com、youtu.be→youtube.com、
//       roboticseducation.org→recf.org、zindi.africa→zindi.world）
//   訊號 B 內容標記    0 個（名單已先攔下 ieso-info.org）
//   訊號 C HTTP 盲區   1 個、真陽性（apho.org 已成 GoDaddy 待售停放頁）
//
// 那 4 個兄弟子網域要靠 PSL 才分得掉（www.google.com／workspace.google.com 的
// 共同後綴是兩段，a.edu.tw／b.edu.tw 也是兩段），另外 7 個任何規則都解不掉，
// 合法網站確實會轉去另一個註冊網域。所以訊號 A 的精確度上限就是這樣，
// 它適合放進報告給人瀏覽，不適合每週開一次 issue。
//
// needsAttention 因此只算需處理的那一級。

/**
 * splitSignals 把自動偵測的訊號分成需處理（actionable）與僅供瀏覽（browseOnly）兩級。
 * @param {{confidence: string}[]} autoSignals @returns {{actionable: object[], browseOnly: object[]}}
 */
export function splitSignals(autoSignals) {
    return {
        actionable: autoSignals.filter((a) => a.confidence === 'actionable'),
        browseOnly: autoSignals.filter((a) => a.confidence !== 'actionable'),
    };
}

/**
 * needsAttention 判斷這一輪要不要開 issue 或留言，參數是 buildReport 整理好的結果。
 * 接管命中只算盤點網址的：說明文字點名接管主機是在警告讀者，名單期限內每週通知只是重複一件已知的事，
 * 到期前 30 天起改由 expiringSoon 通知。直接連到接管主機的網址，workflow 先跑的 check-link-policy
 * 就會擋下，單獨執行 check-external-links.mjs 時才會走到這裡。需處理的自動訊號也要算，偵測到了卻
 * 不開 issue 的話，報告會躺在 job summary 裡沒人看，等於沒偵測。快到期的政策項目也要算，
 * 否則要等到期當天所有 PR 變紅才會發現。
 * @param {{dead: object[], blocked: object[], bareDead: object[], hijackedHits: object[], expiringSoon: object[], autoSignals: object[], coverageComplete: boolean}} s
 * @returns {boolean}
 */
export function needsAttention({ dead, blocked, bareDead, hijackedHits, expiringSoon, autoSignals, coverageComplete }) {
    return (
        dead.length > 0 ||
        blocked.length > 0 ||
        bareDead.length > 0 ||
        hijackedHits.some((h) => h.source === 'url') ||
        expiringSoon.length > 0 ||
        splitSignals(autoSignals).actionable.length > 0 ||
        !coverageComplete
    );
}

// 資料 JSON 的出處帶上 JSON pointer，才知道是哪一筆；頁面的出處只列檔名
const sourcesOf = (item) => [...new Set(item.occurrences.map((o) => (o.file.endsWith('.json') ? `${o.file} ${o.location}` : o.file)))].sort();
// 出處全列會炸掉報告：同一個網址可能出現在 90 幾個頁面（例如共用的頁尾連結），
// 一筆失效就吃掉整個 issue 的可讀性。列前幾個、其餘只給數字。
const MAX_SOURCES_SHOWN = 5;
const sourceLines = (item) => {
    const all = sourcesOf(item);
    const out = all.slice(0, MAX_SOURCES_SHOWN).map((s) => `  - 出處：\`${s}\``);
    if (all.length > MAX_SOURCES_SHOWN) out.push(`  - …另有 ${all.length - MAX_SOURCES_SHOWN} 處引用（共 ${all.length} 處）`);
    return out;
};
const coveredElsewhere = (item) =>
    ALSO_COVERED_BY.filter((c) => item.occurrences.some((o) => o.file === c.file && c.location.test(o.location)));

/**
 * renderReport 產生週報的 markdown，第一行是 issue 的機器標記。m 是 buildReport 整理好的結果：
 * 各段的項目、數量、盤點與預算資訊，以及算好的通知條件 attention。
 * @param {object} m @returns {string}
 */
export function renderReport(m) {
    const {
        todayISO, inventoryTotal, targetsCount, healthy, dead, blocked, urlBlockedCount, unverified, suppressed, hijackedHits,
        autoSignals, bareInfo, bareRejected, bareUnresolved, bareHostsCount, bareHealthy, bareDead, bareOther, skipped, bareSkipped,
        budgetMs, bareBudgetMs, expiringSoon, attention,
    } = m;
    const { actionable: actionableSignals, browseOnly: browseOnlySignals } = splitSignals(autoSignals);

    const lines = [EXTERNAL_LINKS_MARKER, '', '## 全站外部連結檢查報告', ''];
    lines.push(`- 檢查日期：${todayISO}（UTC）`);
    lines.push(`- 盤點：${inventoryTotal} 個去重外部網址，來自 check-built-site.mjs 的建置產物掃描`);
    lines.push(`- 本次檢查 ${targetsCount} 筆：健康 ${healthy}、失效 ${dead.length}、位址封鎖 ${urlBlockedCount}、無法判定 ${unverified.length}、已列例外 ${suppressed.length}`);
    lines.push(
        `- 內文裸網域：盤點候選 ${bareInfo.total}（${bareInfo.alreadyCoveredByUrls} 個已由盤點的網址涵蓋）、DNS 篩掉 ${bareRejected.length}、DNS 未答 ${bareUnresolved.length}、實際探測 ${bareHostsCount}（健康 ${bareHealthy}、失效 ${bareDead.length}、無法判定 ${bareOther.length}）`,
    );
    // 無條件寫，即使是 0。理由與主控台那一行相同，而且這裡更重要：主控台只在
    // job step 的 log 裡，這份報告才是貼進 issue／job summary、真的有人讀的東西。
    // 下面那一段只在有命中時才出現，所以少了這個數字的話，「這次沒偵測到」與
    // 「偵測根本沒接上線」在讀者眼裡長得一模一樣。
    lines.push(
        `- 自動偵測：需處理 ${actionableSignals.length}（內容標記／HTTP 層盲區）、` +
            `僅供瀏覽 ${browseOnlySignals.length}（跨站轉址；誤判率高，不觸發通知）` +
            '　兩者都不改變上面的三態分類',
    );
    lines.push('');

    if (expiringSoon.length) {
        lines.push(`### ⏰ 連結政策有 ${expiringSoon.length} 筆在 ${EXPIRY_NOTICE_DAYS} 天內到期`, '');
        lines.push(
            '到期當天起 check-link-policy 會讓所有 PR 失敗，排程健檢也會停在 Validate the exception policy 那一步，不再留言。',
            '請逐筆重新查證，仍然成立的延長期限並寫下這次查到的結果，不再成立的刪掉。',
            '',
        );
        for (const e of expiringSoon) lines.push(`- ${e.list} \`${e.match.host ?? e.match.url}\`　到期日：${e.expires}　負責人：${e.owner}`);
        lines.push('');
    }

    if (hijackedHits.length) {
        lines.push('### 🚨 已知不可信任的主機（狀態碼健康，內容不可信）', '');
        lines.push(
            '這些主機列在 `scripts/link-policy.json` 的 `hijacked`。它們多半回 HTTP 200，三態分類看不出異常，所以靠這份名單標出來，',
            '名單上的主機不算進健康。盤點的網址直接連到它們的，check-link-policy 會在 PR 擋下；這裡列到的話會觸發通知。',
            '說明文字點名它們是在警告讀者，這種命中本身不觸發通知；名單到期前 30 天起由到期提醒通知，到期當天起確定性 CI 會紅，',
            '要重新查證它是否仍被接管。',
            '',
        );
        for (const h of hijackedHits) {
            const kindLabel = h.policy.kind === 'terminus' ? '接管鏈的終點（本來就不是教育網域）' : '這台主機本身已被接管';
            lines.push(`- **${h.policy.match.host}** — ${kindLabel}（本次探測：${h.reason}）`);
            lines.push(`  - 來源：${h.source === 'bare' ? '說明文字裡的裸網域（本身不觸發通知）' : '盤點的網址（會觸發通知，請換成現行網址）'}　\`${h.url}\``);
            lines.push(`  - 情況：${h.policy.reason}`);
            lines.push(`  - 證據：${h.policy.evidence}`);
            lines.push(`  - 負責人：${h.policy.owner}　重新查證期限：${h.policy.expires}`);
            lines.push(...sourceLines(h));
        }
        lines.push('');
    }

    // 自動偵測到的訊號（#117）。與上面那份名單並列而不是混在一起：名單是「已經
    // 查證過、確定不可信」，這一段是「機器覺得可疑、還沒有人看過」。兩者的可信度
    // 不同，措辭也要不同，否則讀者會把未經查證的推測當成結論。
    if (actionableSignals.length) {
        lines.push('### 🕵️ 自動偵測到的可疑訊號（需要人工查證）', '');
        lines.push(
            '這一段不在任何名單裡，是這次探測當場算出來的。**它不改變上面的三態分類**，',
            '也不代表這些連結一定壞了——需要有人看一眼再決定。',
            '',
            '- **內容標記**：標題或描述命中蹲域名的變現詞組（博弈／成人／藥品／停放待售）。',
            '  只比對 <title> 與 meta description，一律用多字詞組並要求詞界，且**至少要兩個',
            '  相異詞組**才算命中——單一詞組會把「線上博弈防治研習」「機率論競賽：百家樂的',
            '  期望值分析」這類正當教育內容掃進來。',
            '- **HTTP 層看不到內容**：回應是一個很小、內容只有轉址構造的殼。這一條**不指控接管**，',
            '  它陳述的是檢查器的盲區——「healthy」在這裡只代表伺服器答了，不代表使用者看得到',
            '  正常內容。對一個競賽官網來說，那本身就值得看一眼。',
            '',
            '確認為接管 → 加進 `scripts/link-policy.json` 的 `hijacked`（要有 reason／owner／expires），',
            '並修掉指向它的資料。確認為誤判 → 回報，這代表偵測規則需要調整。',
            '',
        );
        for (const a of actionableSignals) {
            const where = a.source === 'bare' ? `說明文字裡的裸網域 \`${a.host}\`` : `盤點的網址 \`${a.url}\``;
            lines.push(`- **${where}**`);
            if (a.cross) {
                lines.push(`  - 🔀 轉址終點跨站：\`${a.cross.fromHost}\` → \`${a.cross.toHost}\``);
                for (const h of a.cross.hops) lines.push(`    - ${inertText(h)}`);
            }
            // shell.title 與 content.text 是被偵測的那台主機自己寫的字串，而這份報告會
            // 被 gh issue create --body-file 原樣送進 issue。不包成行內程式碼的話，一個
            // 被接管的網域就能讓看門狗的 issue 去 @ 人、cross-reference 別的 issue、
            // 或貼出可點的釣魚連結。命中的定義就是「那台主機不可信」，所以這裡沒有
            // 「應該還好吧」的空間。
            if (a.shell) {
                lines.push(`  - 🫥 HTTP 層看不到內容：回應只有 ${a.shell.bytes} bytes 且內容是轉址構造` +
                    (a.shell.title ? `（<title> 是 ${inertText(a.shell.title)}）` : '') + '，需要執行 JavaScript 才看得到真正的頁面。');
            }
            for (const c of a.content) {
                lines.push(`  - 🎰 內容標記：\`${c.phrase}\`（在 ${c.where}）`);
                lines.push(`    - 原文：${inertText(c.text)}`);
            }
            lines.push(...sourceLines(a));
        }
        lines.push('');
    }

    // 跨站轉址單獨一段，而且不觸發通知。實測（全站 508 個目標）它命中 11 筆、
    // 全部是誤判：4 筆兄弟子網域（沒有 PSL 分不出 www.google.com／workspace.google.com
    // 與 a.edu.tw／b.edu.tw 的差別）、7 筆機構改名或短網址（任何規則都解不掉，
    // 合法網站確實會轉去另一個註冊網域）。
    //
    // 保留它是因為真的接管確實會呈現這個形狀（www.sasmo.sg → arcade.now）；
    // 但用它每週開一次 issue，維護者會在第三週學會忽略整個看門狗。
    if (browseOnlySignals.length) {
        lines.push('### 🔀 轉址終點跨站（僅供瀏覽，不觸發通知）', '');
        lines.push(
            '使用者最後到達的主機不在起點的網域底下。**這一段的誤判率很高**——合法的機構',
            '改名、併購、短網址服務、以及同一個註冊網域下的兄弟子網域都會命中，而要分辨',
            '「兄弟子網域」與「同一個二段後綴下的不同機構」（a.edu.tw／b.edu.tw）需要公開',
            '後綴清單，本檢查刻意不引入那份資料。',
            '',
            '所以它只列在這裡供瀏覽，不計入待辦。真的接管會呈現這個形狀（www.sasmo.sg →',
            'arcade.now 就是），但它同時也是網路上很常見的正常行為。',
            '',
        );
        for (const a of browseOnlySignals) {
            const where = a.source === 'bare' ? `說明文字裡的裸網域 \`${a.host}\`` : `盤點的網址 \`${a.url}\``;
            lines.push(`- ${where}`);
            if (a.cross) {
                lines.push(`  - \`${a.cross.fromHost}\` → \`${a.cross.toHost}\``);
                for (const h of a.cross.hops) lines.push(`    - ${inertText(h)}`);
            }
        }
        lines.push('');
    }

    if (blocked.length) {
        lines.push('### 🛑 網址被位址政策擋下（請立刻檢查資料是否被竄改）', '');
        lines.push('這些網址指向 loopback／私有網段／link-local／雲端 metadata，健檢拒絕連線。', '');
        lines.push('（含只寫在說明文字裡的裸網域——不論從哪條路徑進來，指向內網都是同一件事。）', '');
        lines.push('正常的教育資源不會長這樣；出現在這裡代表資料檔被寫錯或被動過手腳。', '');
        for (const b of blocked) {
            lines.push(`- **${b.reason}**`);
            lines.push(`  - 網址：\`${b.url}\``);
            lines.push(...sourceLines(b));
        }
        lines.push('');
    }

    if (dead.length) {
        lines.push('### 🔗 連結失效（網域解析不到或頁面不存在，請更新）', '');
        for (const d of dead) {
            lines.push(`- **${d.reason}**：${d.url}`);
            lines.push(...sourceLines(d));
            for (const c of coveredElsewhere(d)) lines.push(`  - 註：此檔另由 ${c.by} 檢查，可能會在兩處看到同一筆`);
        }
        lines.push('');
    }

    if (bareDead.length) {
        lines.push('### 🔤 說明文字裡的網域失效（請改寫內文或補上現行網址）', '');
        lines.push(
            '這些網域只出現在說明文字裡、沒有做成連結，所以讀者不會點到——但它們仍然值得每週看一次。',
            '',
            '有兩種情況，處理方式不同：',
            '',
            '1. **內文把它當成現行網址在介紹** → 資料錯了，請改寫敘述或補上正確的現行網址。',
            '2. **內文本來就說它已經停用**（例如「原 X 已轉址至 Y」）→ 資料是對的，不必改。',
            '   這一筆會一直出現在這裡，那是刻意的：我們的內文點名了一個沒有主人的網域，',
            '   而沒有主人的網域隨時可能被別人註冊走。ieso-info.org 與 www.sasmo.sg 就是這樣',
            '   變成博弈站與廣告漏斗的。持續盯著它，改天它從「解析不到」變成「HTTP 200」，',
            '   就是該把它加進 link-policy.json 的 hijacked 名單的時候。',
            '',
        );
        for (const d of bareDead) {
            lines.push(`- **${d.reason}**：${d.host}`);
            lines.push(...sourceLines(d));
        }
        lines.push('');
    }

    if (bareOther.length) {
        lines.push(
            `<details><summary>🔤 說明文字裡的網域無法判定 ${bareOther.length} 筆</summary>`,
            '',
        );
        for (const u of bareOther) lines.push(`- ${u.reason}：${u.host}`);
        lines.push('', '</details>', '');
    }

    if (bareUnresolved.length) {
        lines.push('### ⚠️ 裸網域的 TLD 這次查不到答案（本次未檢查）', '');
        lines.push(
            '判斷「這串字到底是不是網域」要查該 TLD 在 DNS 根區的 NS 記錄。下列候選這次沒有問到答案',
            '（SERVFAIL、逾時、連不到 resolver 等），因此**沒有被探測**。',
            '',
            '這一段與下面「被 DNS 篩掉」是兩件完全不同的事：那些是根區明確回答「沒有這個 TLD」，',
            '這些是我們根本沒問到。若整批候選都落在這裡，代表 runner 的 DNS 有問題，本次裸網域',
            '檢查等於沒有跑，**不可以視為正常**。',
            '',
        );
        for (const u of bareUnresolved) lines.push(`- ${u.host} — ${u.reason}`);
        lines.push('');
    }

    if (bareRejected.length) {
        lines.push(
            `<details><summary>🧪 被 DNS 篩掉的裸網域候選 ${bareRejected.length} 筆（根區確定沒有這個 TLD，不是網域）</summary>`,
            '',
            '擷取規則是純字串比對，會擷到檔名與縮寫。這裡用「該 TLD 在 DNS 根區存不存在」把它們篩掉，',
            '列出來是為了讓擷取規則退化時看得出來——這一區應該只有檔名，出現真的網域就是規則出問題了。',
            '',
        );
        for (const r of bareRejected) lines.push(`- ${r.host} — ${r.reason}`);
        lines.push('', '</details>', '');
    }

    if (skipped || bareSkipped) {
        lines.push('### ⏱️ 檢查未完成（覆蓋不完整）', '');
        lines.push(
            `本次有 ${skipped + bareSkipped} 筆未檢查（逾 ${budgetMs / 60_000} + ${bareBudgetMs / 60_000} 分鐘預算）。**未檢查不等於正常**，這批網址本次沒有被驗證過。`,
            '',
            '起點每週輪替，長期覆蓋率會均勻；但若連續數週出現，代表預算或併發數需要調整。',
            '',
        );
    }

    if (unverified.length) {
        // 「無法判定」底下是幾種原因不同的東西，處理方式也不同，所以分組、每組的標題各自寫明。
        // 三態裡只有 dead（ENOTFOUND 與 404/410）會觸發通知，無法判定刻意不觸發，但報告必須讓人看得出差別。
        // 2026-10-25 在台灣本地抽查：10-19 週報裡逾時的 apcs.csie.ntnu.edu.tw、law.moj.gov.tw 等 5 台
        // 都連得上，runner 在境外資料中心才連不上；sdl.ntl.edu.tw 與 12basic.edu.tw 在本地也逾時。
        // 5xx 有真的壞掉的，也有 CDN 擋自動程式的：sch001.g0v.tw 的 dash 頁在 Chromium 裡一樣是 502，
        // sasmo.simcc.org 對檢查器回 520，Chromium 開到的是 Cloudflare 的驗證頁。
        const unreachable = unverified.filter((u) => u.bucket === 'unreachable');
        const serverErrors = unverified.filter((u) => u.bucket === 'server-error');
        const rejected = unverified.filter((u) => u.bucket === 'rejected');
        const other = unverified.filter((u) => u.bucket === 'other');

        if (unreachable.length) {
            lines.push(
                `<details open><summary>⚠️ 連不上或沒有回應的連結 ${unreachable.length} 筆（逾時、連線被拒或被重設，值得人工確認是否已停站）</summary>`,
                '',
                'runner 位於境外資料中心，台灣的政府／學校站台常整段封鎖這類 IP，所以不自動判定為失效。',
                '但若你在本地瀏覽器也開不起來，那就是真的停站了，請更新或移除連結。',
                '',
            );
            for (const u of unreachable) lines.push(`- ${u.reason}：${u.url}`);
            lines.push('', '</details>', '');
        }
        if (serverErrors.length) {
            lines.push(
                `<details open><summary>⚠️ 站台回報伺服器錯誤的連結 ${serverErrors.length} 筆（HTTP 5xx）</summary>`,
                '',
                '可能是站台故障，也可能是站台前面的 CDN 擋下了自動程式。用瀏覽器也打不開的話，請更新或移除連結。',
                '',
            );
            for (const u of serverErrors) lines.push(`- ${u.reason}：${u.url}`);
            lines.push('', '</details>', '');
        }
        if (rejected.length) {
            lines.push(
                `<details><summary>ℹ️ 被站台拒絕的連結 ${rejected.length} 筆（HTTP 403、429 等，常見原因是擋自動程式，瀏覽器多半打得開）</summary>`,
                '',
                '也有頁面在瀏覽器裡一樣被拒絕，那就是真的不公開或已經刪掉了。',
                '',
            );
            for (const u of rejected) lines.push(`- ${u.reason}：${u.url}`);
            lines.push('', '</details>', '');
        }
        if (other.length) {
            lines.push(
                `<details open><summary>⚠️ 其他無法判定的連結 ${other.length} 筆（憑證、轉址迴圈、DNS 暫時失敗等，要逐筆看原因）</summary>`,
                '',
                '憑證過期（CERT_HAS_EXPIRED）的站，瀏覽器一樣打不開。憑證鏈接不到 Node 內建的根憑證時',
                '（UNABLE_TO_GET_ISSUER_CERT_LOCALLY、UNABLE_TO_VERIFY_LEAF_SIGNATURE），瀏覽器多半會自己補齊而打得開。',
                '轉址迴圈有時只是因為這支檢查器不帶 cookie。',
                '',
            );
            for (const u of other) lines.push(`- ${u.reason}：${u.url}`);
            lines.push('', '</details>', '');
        }
    }

    if (suppressed.length) {
        lines.push(
            `<details><summary>📋 已列入例外政策的連結 ${suppressed.length} 筆（scripts/link-policy.json）</summary>`,
            '',
            '例外只降低 `unverified` 的噪音；若其中任何一筆變成 404/410 或網域解析不到，仍然會出現在上面的「連結失效」。',
            '',
        );
        for (const s of suppressed) {
            lines.push(`- ${s.reason}：${s.url}`);
            lines.push(`  - 理由：${s.policy.reason}`);
            lines.push(`  - 負責人：${s.policy.owner}　到期日：${s.policy.expires}`);
        }
        lines.push('', '</details>', '');
    }

    if (ALSO_COVERED_BY.length) {
        lines.push('<details><summary>📁 另有專屬看門狗的資料檔</summary>', '');
        for (const c of ALSO_COVERED_BY) lines.push(`- \`${c.file}\`（${c.scope}）→ ${c.by}`);
        lines.push('', '這裡仍然會一起檢查（縱深防禦），只是同一筆失效可能在兩份報告都看得到。', '', '</details>', '');
    }

    // 有列出接管主機時不寫這句，免得和上面的警示互相矛盾。
    if (!attention && !unverified.length && !bareOther.length && !hijackedHits.length) lines.push('✅ 全部外部連結正常。', '');

    return lines.join('\n');
}

/** consoleLines 產生主控台要印的行：summary 在寫報告之前印，tail 在寫完 GITHUB_OUTPUT 之後印。 */
function consoleLines(m) {
    const {
        inventoryPath, inventoryTotal, targetsCount, healthy, dead, blocked, urlBlockedCount, unverified, suppressed, hijackedHits,
        autoSignals, bareInfo, bareRejected, bareUnresolved, bareHostsCount, bareHealthy, bareDead, bareOther, skipped, bareSkipped,
        coverageComplete, expiringSoon, attention, limit,
    } = m;
    const { actionable: actionableSignals, browseOnly: browseOnlySignals } = splitSignals(autoSignals);
    const summary = [];
    summary.push('全站外部連結檢查');
    summary.push(`  盤點來源：${inventoryPath}（${inventoryTotal} 個去重網址）`);
    summary.push(`  本次檢查：${targetsCount}`);
    summary.push(`  健康　　：${healthy}`);
    summary.push(`  失效　　：${dead.length}`);
    summary.push(`  位址封鎖：${urlBlockedCount}`);
    summary.push(`  無法判定：${unverified.length}`);
    summary.push(`  已列例外：${suppressed.length}`);
    if (skipped) summary.push(`  未檢查　：${skipped}（逾時間預算）`);
    summary.push('內文裸網域（只寫在說明文字裡的網域）');
    summary.push(`  盤點候選：${bareInfo.total}（其中 ${bareInfo.alreadyCoveredByUrls} 個已由盤點的網址涵蓋，不重複檢查）`);
    summary.push(`  DNS 篩掉：${bareRejected.length}（TLD 確定不存在＝檔名或縮寫，不是網域）`);
    if (bareUnresolved.length) summary.push(`  DNS 未答：${bareUnresolved.length}（查不到答案，本次未檢查——不等於它們不是網域）`);
    summary.push(`  實際探測：${bareHostsCount}`);
    summary.push(`  健康　　：${bareHealthy}`);
    summary.push(`  失效　　：${bareDead.length}`);
    summary.push(`  位址封鎖：${blocked.length - urlBlockedCount}`);
    summary.push(`  無法判定：${bareOther.length}`);
    if (bareSkipped) summary.push(`  未檢查　：${bareSkipped}（逾時間預算）`);
    if (expiringSoon.length) summary.push(`⏰ ${EXPIRY_NOTICE_DAYS} 天內到期的政策項目：${expiringSoon.length}`);
    if (hijackedHits.length) summary.push(`🚨 已知不可信任的主機：${hijackedHits.length}（盤點的網址 ${hijackedHits.filter((h) => h.source === 'url').length}）`);
    // 無條件印，即使是 0。只在有命中時才印的話，「這次沒偵測到」與「偵測根本沒跑」
    // 在 CI log 上長得一模一樣。
    summary.push(
        `🕵️ 自動偵測：需處理 ${actionableSignals.length}（內容標記／HTTP 盲區）、` +
            `僅供瀏覽 ${browseOnlySignals.length}（跨站轉址，誤判率高）`,
    );
    const tail = [];
    if (limit > 0) tail.push(`→ 使用了 --limit ${limit}：只驗了一部分，coverage_complete 一律為 false。`);
    if (!coverageComplete) tail.push(`→ 覆蓋不完整：${skipped + bareSkipped} 筆未檢查、${bareUnresolved.length} 筆未篩選，不可視為健康。`);
    tail.push(attention ? '→ 有項目需要處理，已寫入報告。' : '→ 無待辦項目。');
    return { consoleSummary: summary, consoleTail: tail };
}

/**
 * buildReport 把一輪探測的原始結果整理成週報、通知條件與主控台輸出。check-external-links.mjs 讀檔、
 * 探測之後把資料原樣交進來；通知條件只算一次，報告、GITHUB_OUTPUT 與主控台都用同一份。
 * @param {object} input 盤點與探測結果（targets、results、skipped）、裸網域的候選、篩選與探測結果
 *   （bareInfo、bareCandidates、screen、bareResults、bareSkipped）、policy（entries 與 hijacked）、
 *   todayISO、limit、inventoryPath、inventoryTotal、budgetMs、bareBudgetMs
 * @returns {{report: string, attention: boolean, coverageComplete: boolean, githubOutput: string, consoleSummary: string[], consoleTail: string[]}}
 */
export function buildReport(input) {
    const { todayISO, limit, targets, results, skipped, bareCandidates, screen, bareResults, bareSkipped, policy } = input;
    const dead = [];
    const blocked = [];
    const unverified = [];
    const suppressed = [];
    // 命中 hijacked 名單的主機，不論狀態碼都單獨列出、不算進健康。哪些要通知見 needsAttention。
    const hijackedHits = [];
    // 自動偵測到的可疑訊號（#117）。與上面那份名單的差別是它不需要有人先發現：
    // 訊號 A 看轉址終點有沒有離開起點的網域，訊號 B 看標題／描述有沒有蹲域名的
    // 變現詞組，訊號 C 看回應是不是沒有可見文字、只能靠 JavaScript 轉址前進的空殼。
    // 這些訊號都不改變三態分類，因為誤判的代價不對稱：把正常網站判成 dead 會讓人
    // 去修沒壞的東西，多報一筆可疑只是多看一眼。
    const autoSignals = [];
    let healthy = 0;
    const urlBins = { blocked, hijacked: hijackedHits, dead, suppressed, unverified };
    for (let i = 0; i < targets.length; i++) {
        const r = results[i];
        if (!r) continue; // 預算用盡，未檢查
        const { bin, item, signal } = judgeUrl(targets[i], r, { hijacked: policy.hijacked, entries: policy.entries });
        if (signal) autoSignals.push(signal);
        if (bin === 'healthy') healthy++;
        else urlBins[bin].push(item);
    }

    // url 路徑先前有幾筆被擋。裸網域被擋下的會併進同一個 blocked 桶（見下方註解），
    // 這裡先記住分界，好讓主控台的兩段數字仍然分得開。
    const urlBlockedCount = blocked.length;
    const occurrencesOfHost = new Map(bareCandidates.map((h) => [h.host, h.occurrences ?? []]));
    const bareDead = [];
    const bareOther = [];
    let bareHealthy = 0;
    // 被位址政策擋下＝這筆資料指向 loopback／私網／雲端 metadata。那是資料被
    // 竄改或寫錯的訊號，不是「網域失效、請改寫內文」，所以不放進下面「說明文字
    // 裡的網域失效」那一段稀釋掉，而是與 url 路徑共用同一個 blocked 桶子，不論
    // 從哪條路徑進來，報告都用同樣大聲的措辭。
    const bareBins = { blocked, hijacked: hijackedHits, dead: bareDead, unverified: bareOther };
    for (let i = 0; i < screen.accepted.length; i++) {
        const r = bareResults[i];
        if (!r) continue;
        const host = screen.accepted[i];
        const target = { host, url: probeUrlFor(host), occurrences: occurrencesOfHost.get(host) ?? [] };
        const { bin, item, signal } = judgeBare(target, r, { hijacked: policy.hijacked });
        if (signal) autoSignals.push(signal);
        if (bin === 'healthy') bareHealthy++;
        else bareBins[bin].push(item);
    }

    // 問不到 TLD 答案的候選並沒有被探測過，等同「未檢查」，不可以算進完整覆蓋。
    // --limit 同理：它是本機除錯用的旗標，只驗前 N 筆，其餘完全沒看過；算成完整覆蓋的話，
    // 一次只驗 3 筆的執行也會宣稱「全站都查過了」。
    const coverageComplete = limit <= 0 && skipped === 0 && bareSkipped === 0 && screen.unresolved.length === 0;
    const expiringSoon = expiringPolicyItems(policy.entries, policy.hijacked, todayISO);
    const model = {
        todayISO,
        inventoryTotal: input.inventoryTotal,
        targetsCount: targets.length,
        healthy,
        dead,
        blocked,
        urlBlockedCount,
        unverified,
        suppressed,
        hijackedHits,
        autoSignals,
        bareInfo: input.bareInfo,
        bareRejected: screen.rejected,
        bareUnresolved: screen.unresolved,
        bareHostsCount: screen.accepted.length,
        bareHealthy,
        bareDead,
        bareOther,
        skipped,
        bareSkipped,
        budgetMs: input.budgetMs,
        bareBudgetMs: input.bareBudgetMs,
        coverageComplete,
        expiringSoon,
    };
    const attention = needsAttention(model);
    return {
        report: renderReport({ ...model, attention }),
        attention,
        coverageComplete,
        githubOutput: `needs_attention=${attention}\ncoverage_complete=${coverageComplete}\n`,
        ...consoleLines({ ...model, attention, limit, inventoryPath: input.inventoryPath }),
    };
}
