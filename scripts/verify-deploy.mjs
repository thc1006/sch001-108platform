#!/usr/bin/env node
/**
 * 部署之後，去線上把站台抓下來，確認它真的在服務這一個 commit。
 * ================================================================
 * `actions/deploy-pages` 成功只代表 Pages API 回報部署完成，不代表 CDN 已經在服務新內容。
 * #89 合併後實際發生過：CI 五個 job 有四個成功、GitHub 的 deployments API 有該
 * commit 的紀錄，但線上服務的仍是舊版本（vendor/fuse.min.js 回 404），而且完全
 * 沒有訊號——因為 deploy 只在 push 到 main 時跑，不可能列入 PR 的 required check。
 *
 * 這支把「部署成功」變成可驗證的事實：輪詢線上的 build-info.json，直到它服務的
 * commit 是這次要部署的那個、或是它的**後代**為止；逾時就以非零退出讓 run 變紅。
 *
 * 為什麼是「或它的後代」而不是「精確相等」：main 連續合併時，較新的那次部署可能在
 * 本 run 還在輪詢時就先上線了。那時線上是我們的後代，站台其實完全正常——但精確相等
 * 的判定會把它誤報成「本 commit 沒有部署」。兩次合併只要間隔夠近，兩個 run 就會
 * 重疊，這個誤報真的會發生。
 *
 * 反過來，線上如果是我們的**祖先**，那才是真正的問題：部署順序被倒過來了（Actions
 * 的 concurrency 佇列是依「開始等待的時間」FIFO，不是依 commit 順序，而各 run 的 CI
 * 耗時本來就有落差），站台正在服務比 main 更舊的東西。舊版的精確相等判定會一直等到
 * 逾時才紅，訊息還說錯原因；現在會明講是順序倒置。
 *
 * 用法：
 *   node scripts/verify-deploy.mjs                 # 用 GITHUB_SHA 或 git HEAD
 *   node scripts/verify-deploy.mjs <commit-sha>
 *
 * commit 相同時還要比 run 編號與閘道網址：只改了 repository variable（AI_GATEWAY_URL）就重新部署時，
 * commit 不變、產物卻不同，線上那份舊的不能算數。build-info.json 的 runNumber 比本 run 小或沒有
 * 這個欄位，就是較早的部署；比本 run 大是較新的部署，跟後代一樣算落地，不管它用的是哪個網址。
 * run 編號相同是同一個 run 按了 Re-run，這時再比 aiGatewayUrl 是不是這次建置用的
 * PUBLIC_AI_GATEWAY_URL。不比 run_attempt：Re-run failed jobs 不重跑成功過的建置，部署的是先前
 * attempt 建好的產物。GITHUB_RUN_NUMBER 與 PUBLIC_AI_GATEWAY_URL 都沒有時（例如本機執行）只比 commit。
 *
 * 環境變數：
 *   SITE_URL           站台根網址（預設正式站）
 *   VERIFY_TIMEOUT     輪詢逾時秒數（預設 660，必須大於線上的 max-age=600，見 TIMEOUT_MS 的說明）
 *   VERIFY_RECHECK     命中後再確認一次的間隔秒數（預設 45；設 0 停用）
 *   GITHUB_REPOSITORY  owner/repo，用來查祖先／後代關係；沒有就退回精確相等
 *   GITHUB_API_URL     GitHub REST API 的根網址（Actions 會自動提供，沒有就用 https://api.github.com）
 *   GITHUB_TOKEN       查詢用（公開 repo 不給也能查，只是配額低很多）
 *   GITHUB_RUN_NUMBER  本 run 的編號（Actions 會自動提供），commit 相同時用來分辨新舊部署
 *   PUBLIC_AI_GATEWAY_URL  這次建置用的閘道網址（CI 從 vars.AI_GATEWAY_URL 帶入，沒設時是空字串）
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SITE = (process.env.SITE_URL || 'https://thc1006.github.io/sch001-108platform').replace(/\/+$/, '');
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

/**
 * 從環境變數讀秒數。空白、空字串與非數字一律退回預設值，而且每一種都會印出來。
 *
 * 不寫成 Number(env ?? 預設)：?? 只擋 undefined，空字串會變成 0——而
 * `env: VERIFY_RECHECK: ${{ vars.X }}` 在 X 沒設定時給的正好是空字串。那會讓底下的
 * 再確認被靜默停用，保護等於不存在。
 *
 * 也必須先 trim：一個空白既不是 undefined 也不是 ''，而 Number(' ') 是 0——finite
 * 又非負，會被當成合法值直接生效，跟空字串是一模一樣的洞。YAML 很容易產生尾隨空白
 * （"${{ vars.X }} "、block scalar），所以這不是理論問題。
 */
function secondsFromEnv(name, fallback) {
    const raw = process.env[name];
    const trimmed = raw === undefined ? undefined : raw.trim();
    if (trimmed === undefined || trimmed === '') {
        if (raw !== undefined) {
            console.log(`  ${name}=${JSON.stringify(raw)} 是空值，改用預設值 ${fallback}`);
        }
        return fallback;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) {
        console.log(`  ${name}=${JSON.stringify(raw)} 不是合法的秒數，改用預設值 ${fallback}`);
        return fallback;
    }
    return n;
}

// 2026-10-22 以 curl -sI 查得 build-info.json 是 max-age=600。預算比它短，CDN 還沒過期就可能誤報沒有落地。
const TIMEOUT_MS = secondsFromEnv('VERIFY_TIMEOUT', 660) * 1000;
const POLL_MS = 10_000;
const RUN_NUMBER = /^\d+$/.test(process.env.GITHUB_RUN_NUMBER || '') ? Number(process.env.GITHUB_RUN_NUMBER) : null;
const GATEWAY = process.env.PUBLIC_AI_GATEWAY_URL === undefined ? null : process.env.PUBLIC_AI_GATEWAY_URL.trim();
// 同一個 commit、但是較早的 run 建的，沒有 runNumber 的也算。
const olderRun = (info) => RUN_NUMBER !== null && !(Number(info.runNumber) >= RUN_NUMBER);
const newerRun = (info) => RUN_NUMBER !== null && Number(info.runNumber) > RUN_NUMBER;
// 同一個 commit、但不是這次 run 建的那一份：較早的 run，或同一個 run 建的、閘道網址卻不是這次建置用的。
const notThisBuild = (info) => olderRun(info) || (!newerRun(info) && GATEWAY !== null && info.aiGatewayUrl !== GATEWAY);

function expectedCommit() {
    const fromArg = process.argv[2];
    if (fromArg) return fromArg.trim();
    if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.trim();
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

const want = expectedCommit();
if (!want || want === 'unknown') {
    console.error('拿不到要驗證的 commit（GITHUB_SHA／git HEAD 都取不到）。');
    console.error('寧可讓這一關失敗，也不要在不知道要比對什麼的情況下宣告部署成功。');
    process.exit(1);
}

const url = `${SITE}/build-info.json`;
const deadline = Date.now() + TIMEOUT_MS;
let attempt = 0;
let last = '（尚未取得）';
let landed = false;
// 同一個線上 commit 只查一次祖先關係，免得每 10 秒打一次 GitHub API。
// 只有「查得出結果」的那次才記進來——理由見迴圈裡 rel === null 的說明。
let probed = '';
let behindNote = '';
let apiFailures = 0;
let recheckApiFailures = 0;
let recheckFailures = 0;
let discounted = 0;
let exhausted = false;
// 最後看到的是本 commit，但不是這次 run 建的那一份。失敗訊息不能說線上沒有服務本 commit。
let staleBuild = false;
// 命中之後再看一次的間隔（見檔案末端的再確認）。設 0 停用。
const RECHECK_S = secondsFromEnv('VERIFY_RECHECK', 45);
const RECHECK_MS = RECHECK_S * 1000;
// 再確認時，多舊的快取副本就不採信。真的退版會清掉邊緣快取，所以退版之後那份物件的
// Age 會很小；Age 很大的那份是在我們部署**之前**就從來源取回的，不構成退版的證據。
//
// 上限夾在 120 秒：這個界線該跟著 CDN 的 max-age 走，不是跟著輪詢節奏走。沒有夾的話，
// VERIFY_RECHECK 一旦設到 570 以上，門檻就會超過線上的 max-age=600，於是每一份陳舊
// 副本都會被當成退版採信——R3-1 修掉的誤報會無聲地回來。
const FRESH_MAX_AGE_S = Math.min(RECHECK_S + 30, 120);

/** SHA 就縮短；其他（像「格式不合法」那種說明文字）原樣印出，不要攔腰切斷。 */
const short = (s) => (/^[0-9a-f]{40}$/.test(s) ? s.slice(0, 12) : s);
// 線上是本 commit、卻不是這次 run 建的那一份時，說明是哪一種。
const staleLabel = (info) => (olderRun(info)
    ? `${short(want)} 的較早部署（run #${info.runNumber || '?'}，本 run 是 #${RUN_NUMBER}）`
    : `${short(want)} 的另一份部署（AI 閘道網址不是這次建置用的）`);

/**
 * parseAge 照 RFC 9111 第 5.1 節讀 Age：清單只取第一個值，不合法就當成 0，不讓 NaN 把退版當成舊快取放過。
 * @param {string|null} raw @returns {number}
 */
function parseAge(raw) {
    const first = String(raw ?? '').split(',')[0].trim();
    return /^\d+$/.test(first) ? Number(first) : 0;
}

console.log(`驗證線上站台是否已服務 ${want.slice(0, 12)}`);
console.log(`  ${url}`);

/**
 * 逾時用明確的 AbortController ＋ clearTimeout，而不是 AbortSignal.timeout()。
 *
 * AbortSignal.timeout() 會留下一個到期前無法取消的 timer handle。搭配結尾的
 * process.exit() 時，Node 在 Windows 上會直接崩在 libuv 的斷言
 * （`!(handle->flags & UV_HANDLE_CLOSING)`，src/win/async.c:76），退出碼變成 127
 * ——訊息印對了，退出碼卻誤導成「找不到指令」。實測踩到：只跑成功路徑不會發現。
 */
async function fetchInfo() {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
        // 刻意不加 cache-buster query string：實測 GitHub Pages 的 Fastly 邊緣**不把
        // query string 放進 cache key**。對照實驗（線上站台，5 個從未用過的 nonce）：
        //
        //   無 query（第一次）   X-Cache=MISS
        //   無 query（第二次）   X-Cache=HIT
        //   ?t=…（三個不同值）   X-Cache=HIT   ← 全部命中同一份物件
        //   不存在的路徑         X-Cache=MISS  ← 對照組，確認 X-Cache 判讀正確
        //
        // 請求標頭的 Cache-Control: no-cache / Pragma 同樣不會強制回源。
        // 唯一可用的新鮮度資訊是回應的 Age 標頭。
        const res = await fetch(url, { signal: ac.signal });
        const age = parseAge(res.headers.get('age'));
        if (res.status !== 200) return { commit: '', label: `HTTP ${res.status}`, age };
        const info = await res.json();
        const commit = String(info.commit || '');
        // 這個字串來自「被驗證的對象自己」，不可以直接塞進 compare API 的網址。
        // WHATWG 的 URL 正規化會先把 ../ 收掉，所以一個精心構造的 commit 值可以把
        // compare 請求導向**另一組**比較、讓它回 ahead——正好偽造出一個綠燈，而這支
        // 腳本存在的理由本來就是「不要相信部署出來的東西」。
        if (commit && !/^[0-9a-f]{40}$/.test(commit)) {
            return { commit: '', label: '(commit 欄位不是 40 位十六進位，已拒絕)', age };
        }
        const runNumber = /^\d+$/.test(String(info.runNumber ?? '')) ? String(info.runNumber) : '';
        const aiGatewayUrl = typeof info.aiGatewayUrl === 'string' ? info.aiGatewayUrl.trim() : '';
        return { commit, runNumber, aiGatewayUrl, label: commit || '(無 commit 欄位)', age };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * compareWithLive 查線上服務的 commit 與這次要驗的 commit 是什麼關係。
 *
 * 回傳 GitHub compare API 的 status：'identical'／'ahead'（線上較新）／
 * 'behind'（線上較舊）／'diverged'，判不出來時回 null。
 *
 * 主迴圈判不出來就當成還沒落地，繼續等：寧可逾時失敗，也不在關係不明時宣告部署成功。
 * 命中之後的再確認是例外，判不出來時維持成功並記一筆，見檔案末端。
 */
async function compareWithLive(live) {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) return null;
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'verify-deploy' };
    if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15_000);
    try {
        const res = await fetch(`${API}/repos/${repo}/compare/${want}...${live}`, {
            headers,
            signal: ac.signal,
        });
        if (!res.ok) return null;
        const j = await res.json();
        // REST 文件只列這四種 status。其他值若放行，再確認會走到最後的 else，印成沒有退版。
        return ['identical', 'ahead', 'behind', 'diverged'].includes(j.status) ? j.status : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

while (Date.now() < deadline) {
    attempt++;
    try {
        const r = await fetchInfo();
        last = r.label;
        staleBuild = false;
        if (r.commit && r.commit === want && !notThisBuild(r)) {
            console.log(newerRun(r)
                ? `✅ 第 ${attempt} 次嘗試：線上是 ${want.slice(0, 12)} 較新的部署（run #${r.runNumber}，本 run 是 #${RUN_NUMBER}），站台服務的內容不會比本 run 舊。`
                : `✅ 第 ${attempt} 次嘗試：線上已是 ${want.slice(0, 12)}（Age=${r.age}s）`);
            landed = true;
            break;
        }
        if (r.commit === want) {
            last = staleLabel(r);
            staleBuild = true;
        } else if (r.commit && r.commit !== probed) {
            // 線上不是我們，但可能是「更新的那一版已經先上線」。
            const rel = await compareWithLive(r.commit);
            if (rel === null) {
                // 判不出來就**不要**記進 probed。記下去的話，一次暫時性的 API 失誤
                // （403 配額、502、逾時、JSON 壞掉——全都回 null）會讓這個 commit 的
                // 祖先判定永遠不再重試：之後每一輪都直接跳過，白等到逾時再誤報部署
                // 失敗。實測過：第一次 502 之後，接下來四輪一次 compare 都沒有再打。
                // 而 main 忙碌、run 互相重疊的時候，正好也是 API 最容易抖的時候——
                // 也就是這個判定最需要派上用場的時候。
                apiFailures++;
                console.log(`  第 ${attempt} 次：compare API 沒有回應，稍後再判定祖先關係`);
            } else {
                probed = r.commit;
                if (rel === 'ahead') {
                    console.log(
                        `✅ 第 ${attempt} 次嘗試：線上是 ${r.commit.slice(0, 12)}，為 ${want.slice(0, 12)} 的` +
                            '後代——站台服務的內容不會比本 commit 舊。',
                    );
                    landed = true;
                    break;
                }
                if (rel === 'behind') {
                    behindNote = `線上的 ${r.commit.slice(0, 12)} 是 ${want.slice(0, 12)} 的祖先，站台在服務更舊的版本`;
                } else if (rel === 'diverged') {
                    behindNote = `線上的 ${r.commit.slice(0, 12)} 與 ${want.slice(0, 12)} 分岔，不在同一條歷史上`;
                }
            }
        }
        // Age 說明這份回應是幾秒前回源取得的。Age 很大時，這個「不符」只代表
        // 我們拿到一份陳舊的快取副本，不代表部署失敗——所以只是繼續等，
        // 而總預算（預設 660 秒）本來就設得比 max-age=600 長。
        console.log(
            `  第 ${attempt} 次：線上仍是 ${short(last)}（Age=${r.age}s${r.age > 0 ? '，快取副本' : ''}），繼續等`,
        );
    } catch (err) {
        last = String(err?.cause?.code || err?.message || err).slice(0, 60);
        staleBuild = false;
        console.log(`  第 ${attempt} 次：${last}，繼續等`);
    }
    if (Date.now() + POLL_MS >= deadline) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
}

exhausted = !landed;

// 命中之後的再確認。
//
// 第一次看到自己就收工的話，會漏掉「更舊的部署在我們剛確認完之後才落地」：concurrency
// 佇列是依開始等待的時間 FIFO，不是依 commit 順序，各 run 的 CI 耗時又有落差，所以
// 較舊的 commit 完全可能排在後面。那種情形下站台真的退版了，而每個 run 各自都只看到
// 自己、全部是綠的。
//
// **不論是精確命中還是後代命中都要再確認。** 一度只在精確命中後做，理由寫的是「命中
// 後代時線上本來就比我們新」——那是把「現在比較新」當成「之後也會比較新」。看到 ahead
// 恰恰代表別人的部署已經超車、pages 佇列正在排空，也就是順序倒置最可能發生的時刻；
// 那條路徑反而最需要再確認。
//
// 成本是每次 main 部署多等 RECHECK_MS。
if (landed && RECHECK_MS > 0) {
    console.log(`  ${RECHECK_S} 秒後再確認一次，看有沒有更舊的部署後來居上……`);
    await new Promise((r) => setTimeout(r, RECHECK_MS));
    try {
        const again = await fetchInfo();
        last = again.label;
        if (!again.commit) {
            recheckFailures++;
            console.log(`  再確認：未取得有效的線上 commit，最後看到：${again.label}。維持原本的成功結論。`);
        } else if (again.commit !== want) {
            const rel = await compareWithLive(again.commit);
            if (rel === null) {
                recheckApiFailures++;
                console.log(`  再確認：線上是 ${short(again.commit)}，但 compare API 沒有回應，關係查不出來，保留原本的成功結論。`);
            } else if (rel === 'behind' || rel === 'diverged') {
                // Age 是這裡唯一能用的新鮮度資訊。真的退版會清掉邊緣快取，所以退版後
                // 那份物件的 Age 會很小；Age 很大的那份，是在我們部署之前就從來源取回
                // 的舊副本，拿它當退版證據會把健康的部署判成紅燈。主迴圈對「不符」本來
                // 就是這樣看待的（見上面「Age 很大時只是陳舊快取」那段），再確認沒有
                // 理由用相反的標準。
                if (again.age <= FRESH_MAX_AGE_S) {
                    behindNote =
                        rel === 'behind'
                            ? `線上已變成 ${short(again.commit)}，那是 ${short(want)} 的祖先`
                            : `線上已變成 ${short(again.commit)}，與 ${short(want)} 分岔`;
                    landed = false;
                } else {
                    // 再確認刻意不推翻初次成功的情況有四種：compare 查不出關係、取不到線上資料、
                    // 線上資料無效，以及快取副本太舊。每一種都記一筆，綠燈才不會和毫無疑問
                    // 的通過長得一樣。這裡若改成失敗，命中後拿到舊快取的每一次部署都會誤報，而那
                    // 是精確命中的常態路徑。
                    discounted++;
                    console.log(
                        `  再確認：拿到 Age=${again.age}s 的快取副本（超過 ${FRESH_MAX_AGE_S}s），` +
                            '那是我們部署之前就取回的舊副本，不採信，維持成功結論。',
                    );
                }
            } else {
                console.log(`  再確認：線上是 ${short(again.commit)}（${rel}），沒有退版。`);
            }
        } else if (notThisBuild(again)) {
            // 同一個 commit、卻不是這次 run 建的那一份，也照 Age 判斷：太舊的副本不採信，同樣記一筆。
            if (again.age <= FRESH_MAX_AGE_S) {
                last = staleLabel(again);
                staleBuild = true;
                behindNote = `線上已變成 ${last}`;
                landed = false;
            } else {
                discounted++;
                console.log(
                    `  再確認：拿到 Age=${again.age}s 的快取副本（超過 ${FRESH_MAX_AGE_S}s），內容是 ${staleLabel(again)}，` +
                        '那是我們部署之前就取回的舊副本，不採信，維持成功結論。',
                );
            }
        } else {
            console.log('  再確認：線上仍是本 commit。');
        }
    } catch {
        // 一次網路抖動不該把已經成立的結論變成紅燈。compareWithLive 自己會 catch 並回 null，
        // 走到這裡的只有 build-info.json 的取用失敗，所以記在 recheckFailures。
        recheckFailures++;
        console.log('  再確認時取不到線上資料，維持原本的成功結論。');
    }
}

// 主迴圈只在精確命中或 compare 查到後代時成功，先前 compare 沒有回應過幾次都不影響這個結論，
// 所以這裡只看再確認的計數，apiFailures 只寫進失敗訊息。
if (landed && (recheckApiFailures || recheckFailures || discounted)) {
    const why = [
        recheckApiFailures ? `再確認時 compare API 有 ${recheckApiFailures} 次沒有回應` : '',
        recheckFailures ? `再確認有 ${recheckFailures} 次未取得有效線上資料` : '',
        discounted ? `有 ${discounted} 次因為快取副本太舊而未採信` : '',
    ].filter(Boolean).join('；');
    console.log(`  ⚠ ${why}。線上驗證的資訊不完整，這次的綠燈信心較低。`);
    // 這時 job 仍是 success，只看日誌才會發現。在 Actions 上另發 warning annotation，
    // run 的摘要頁就看得到。跳脫照 @actions/core 的 escapeData。
    if (process.env.GITHUB_ACTIONS === 'true') {
        const data = why.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
        console.log(`::warning title=部署驗證信心較低::${data}`);
    }
}

if (!landed) {
    console.error(
        (staleBuild
            ? `\n❌ 線上站台是 ${short(want)}，但不是這次 run 建的那一份（最後看到：${last}）。\n`
            : `\n❌ 線上站台沒有服務 ${short(want)}，也不是它的後代（最後看到：${last}）。\n`) +
            (behindNote ? `  ${behindNote}——部署順序被倒過來了。\n` : '') +
            (apiFailures
                ? `  注意：compare API 有 ${apiFailures} 次沒有回應，祖先判定可能因此不完整。\n`
                : '') +
            (exhausted ? `  已等滿 ${Math.round(TIMEOUT_MS / 1000)} 秒的輪詢預算。\n` : '  失敗發生在命中後的再確認。\n') +
            '  常見原因：deploy job 被取消、GitHub Pages 服務異常、Pages 的來源設定不是\n' +
            '  GitHub Actions，或部署順序被倒過來了。請到 Actions 頁確認該次 run 的 Deploy job。',
    );
}
// 設 exitCode 而不是 process.exit()：讓 Node 把未完成的 handle 收乾淨再結束。
process.exitCode = landed ? 0 : 1;
