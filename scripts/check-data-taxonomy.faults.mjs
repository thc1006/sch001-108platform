#!/usr/bin/env node
/**
 * 分類欄位（素養／SDGs／議題標籤）的故障注入矩陣
 * --------------------------------------------------------------
 * check-built-site.faults.mjs 證明的是「建置產物裡的分類欄位壞掉會被擋下」。
 * 但那道關卡在流程的最後——在它之前還有兩道，而那兩道在正常狀態下同樣看不出
 * 有沒有在把關：
 *
 *   1. scripts/check-civic-tech.mjs  來源 JSON 的 schema（代碼合法性、重複、型別）
 *   2. build-search-index.js         建置期的 fail closed：非法代碼、以及
 *                                    「逐項錨點不存在於頁面」時直接讓建置失敗
 *
 * 這兩者出錯的症狀都是「搜尋找不到某個標籤」或「點了搜尋結果停在頁首」——頁面
 * 看起來一切正常，CI 全綠，沒有人會回報。所以「弄壞它會不會紅」必須是常駐測試，
 * 而不是實作當下手動確認一次。
 *
 * 一律在副本上注入，版控裡的 public/ 與要部署的 dist/ 都不會被更動。
 *
 * 執行：  npm run test:taxonomy-faults    （需先 npm run build:deployable）
 */
import { readFileSync, writeFileSync, existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const SOURCE_JSON = path.join(ROOT, 'public', 'civic-tech-map', 'projects.json');
const SOURCE_DIST = path.join(ROOT, process.env.SITE_DIST_SOURCE || 'dist');
const WORK = path.join(ROOT, '.taxonomy-faultcheck');

if (!existsSync(SOURCE_DIST)) {
    console.error(`找不到建置產物 ${SOURCE_DIST}/，請先執行 npm run build:deployable`);
    process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const WORK_JSON = path.join(WORK, 'projects.json');
const WORK_DIST = path.join(WORK, 'dist');
const WORK_REPORT = path.join(WORK, 'civic-tech-report.md');
cpSync(SOURCE_JSON, WORK_JSON);
cpSync(SOURCE_DIST, WORK_DIST, { recursive: true });
// 建置產物裡的那一份與 public/ 同源，注入錨點故障時要改的是它
const WORK_DIST_JSON = path.join(WORK_DIST, 'civic-tech-map', 'projects.json');
console.log(`故障注入在副本 ${path.relative(ROOT, WORK)}/ 上進行，public/ 與 ${path.relative(ROOT, SOURCE_DIST)}/ 不會被更動。\n`);

/** 跑一支腳本，回傳 exit code 與合併後的輸出。 */
function run(script, extraEnv) {
    const env = { ...process.env, ...extraEnv };
    // 子行程若寫 $GITHUB_OUTPUT，會把故障注入時的 needs_attention 混進真正的
    // step output。這裡是刻意製造的錯誤，不該讓 CI 誤以為資料真的有問題。
    delete env.GITHUB_OUTPUT;
    try {
        execFileSync(process.execPath, [script], { stdio: 'pipe', cwd: ROOT, env });
        return { code: 0, out: '' };
    } catch (e) {
        return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') };
    }
}

/**
 * 來源 schema 看門狗：讀副本 JSON、報告也寫到副本目錄。
 *
 * 逐項錯誤訊息只寫在報告檔裡（主控台只印摘要，因為 workflow 是拿報告去開 issue），
 * 所以比對訊息時必須把報告一起讀進來——只看 stdout 會變成「只驗得到有沒有紅，
 * 驗不到紅的理由對不對」，而錯誤訊息本身就是這支看門狗的產出。
 */
function runWatchdog() {
    const r = run('scripts/check-civic-tech.mjs', { CIVIC_TECH_DATA: WORK_JSON, CIVIC_TECH_REPORT: WORK_REPORT });
    const report = existsSync(WORK_REPORT) ? readFileSync(WORK_REPORT, 'utf8') : '';
    return { code: r.code, out: `${r.out}\n${report}` };
}

/** 搜尋索引建置：整份建置產物都用副本。 */
const runIndexer = () => run('build-search-index.js', { SEARCH_INDEX_DIST: WORK_DIST });

const cases = [
    // ── 來源 JSON 的 schema（check-civic-tech.mjs）──
    {
        name: '來源資料出現非法的核心素養代碼',
        target: WORK_JSON,
        run: runWatchdog,
        expect: /不是合法的核心素養代碼/,
        mutate: (t) => t.replace('"competencies": ["A2", "C1"]', '"competencies": ["A2", "Z9"]'),
    },
    {
        name: '來源資料的核心素養代碼重複',
        target: WORK_JSON,
        run: runWatchdog,
        expect: /competencies「A2」重複出現/,
        mutate: (t) => t.replace('"competencies": ["A2", "C1"]', '"competencies": ["A2", "A2"]'),
    },
    {
        name: '來源資料出現不存在的 SDG 編號',
        target: WORK_JSON,
        run: runWatchdog,
        expect: /不是合法的 SDG 編號/,
        mutate: (t) => t.replace('"sdgs": [11, 15]', '"sdgs": [11, 99]'),
    },
    {
        name: '來源資料的議題標籤含空字串',
        target: WORK_JSON,
        run: runWatchdog,
        expect: /tags「」必須是非空字串/,
        mutate: (t) => t.replace('"tags": ["環保", "開放資料"', '"tags": ["", "開放資料"'),
    },
    {
        name: '來源資料的議題標籤不是陣列',
        target: WORK_JSON,
        run: runWatchdog,
        expect: /tags 必須是陣列/,
        mutate: (t) => t.replace('"tags": ["假訊息"', '"tags": "假訊息", "_x": ["假訊息"'),
    },
    // ── 建置期的 fail closed（build-search-index.js）──
    {
        // 這一項是 #78 的核心教訓：錨點不存在卻照樣寫進索引，點了只會停在頁首，
        // 而且全程沒有任何訊號。現在它會讓建置直接失敗。
        name: '專案 id 與頁面錨點對不上時，建置必須失敗',
        target: WORK_DIST_JSON,
        run: runIndexer,
        expect: /沒有 id="disfactory-typo"/,
        mutate: (t) => t.replace('"id": "disfactory"', '"id": "disfactory-typo"'),
    },
    {
        name: '非法 SDG 編號必須在建索引時就擋下，而不是靜默略過',
        target: WORK_DIST_JSON,
        run: runIndexer,
        expect: /不是合法的 SDG 編號/,
        mutate: (t) => t.replace('"sdgs": [11, 15]', '"sdgs": [11, 99]'),
    },
    {
        name: '非法素養代碼必須在建索引時就擋下，而不是靜默略過',
        target: WORK_DIST_JSON,
        run: runIndexer,
        expect: /不是合法的核心素養代碼/,
        mutate: (t) => t.replace('"competencies": ["A2", "C1"]', '"competencies": ["A2", "Z9"]'),
    },
    {
        // 頁面內嵌資料（career-exploration 的學群卡片）走的是另一條索引路徑，
        // 那條路徑原本把整個項目迴圈包在 try/catch 裡——一個素養值打錯，整頁
        // 9 筆項目會靜默消失、只留一行 warning 而建置照樣成功。實際踩過。
        name: '頁面內嵌資料的素養值打錯時，建置必須失敗而不是只印警告',
        target: path.join(WORK_DIST, 'career-exploration', 'index.html'),
        run: runIndexer,
        expect: /不是合法的核心素養代碼/,
        mutate: (t) => t.replace("competencies: ['系統思考與解決問題'", "competencies: ['系統思考與解決問題打錯了'"),
    },
];

console.log('先確認基準狀態為綠：');
for (const [label, r] of [['來源 schema 看門狗', runWatchdog()], ['搜尋索引建置', runIndexer()]]) {
    if (r.code !== 0) {
        console.error(`  ❌ ${label} 基準已經是紅的，無法進行故障注入\n${r.out.slice(0, 800)}`);
        rmSync(WORK, { recursive: true, force: true });
        process.exit(1);
    }
    console.log(`  ✅ ${label} 基準綠燈`);
}
console.log('');

let pass = 0;
let fail = 0;
for (const c of cases) {
    const original = readFileSync(c.target, 'utf8');
    try {
        const mutated = c.mutate(original);
        // 注入沒改到東西＝這個 case 什麼也沒證明。必須當成失敗，不能當成通過。
        if (mutated === original) throw new Error('注入未生效（mutate 沒有改到任何東西）');
        writeFileSync(c.target, mutated, 'utf8');
        const r = c.run();
        if (r.code !== 0 && c.expect.test(r.out)) {
            pass++;
            console.log(`  ✅ ${c.name}`);
        } else {
            fail++;
            console.log(`  ❌ ${c.name}  → exit=${r.code}${r.code === 0 ? '（沒擋下來！）' : '（擋了但訊息不符預期）'}`);
            if (r.out) console.log('       實際輸出片段：' + r.out.replace(/\s+/g, ' ').slice(0, 200));
        }
    } catch (e) {
        fail++;
        console.log(`  ❌ ${c.name}  → 注入失敗：${e.message}`);
    } finally {
        writeFileSync(c.target, original, 'utf8');
    }
}

console.log(`\n故障注入：${pass} 擋下 / ${fail} 漏掉（共 ${cases.length} 項）`);
const after = runWatchdog().code === 0 && runIndexer().code === 0;
console.log(after ? '還原後仍為綠燈 ✅' : '⚠ 還原後仍是紅的，副本沒復原乾淨');

rmSync(WORK, { recursive: true, force: true });
process.exit(fail === 0 && after ? 0 : 1);
