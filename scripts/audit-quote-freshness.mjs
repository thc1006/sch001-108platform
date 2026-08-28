#!/usr/bin/env node
/**
 * 逐字引文稽核：把 competitions.json 裡的「官網逐字原文」拿回官方來源比對。
 *
 * ── 這支工具刻意不接 CI ──
 *
 * 它要連幾百個外站、要跑幾分鐘，而且**它的「未命中」不是一個可以直接行動的結論**。
 * 接進 CI 只會製造每週都紅、每週都得人工判讀的噪音，最後被關掉。
 * 定位是「定期抽樣複查時人工執行的稽核工具」，跟 check-vendor-size.mjs --update 同一類。
 *
 *   node scripts/audit-quote-freshness.mjs            # 全部
 *   node scripts/audit-quote-freshness.mjs --only=AIME  # 只查標題含該字串的
 *   node scripts/audit-quote-freshness.mjs --json      # 輸出 JSON 給後續處理
 *
 * ── 它為什麼長這樣：五輪實測逼出來的 ──
 *
 * 2026-08-29 第一次跑全庫（155 條引文／70 個條目），每一輪都是因為「找不到」
 * 的原因被查清楚才改的：
 *
 *   一 只抓 url 欄位那一頁            命中 49／155
 *     → 引文大量來自子頁。Purple Comet 的引文在 /information，url 欄位是首頁。
 *   二 加一層同站子頁                 再命中 36
 *     → 還是不夠。/rules 掛在 /information 底下，不在首頁。
 *   三 改兩層 BFS ＋ 找齊就停          再命中 9
 *     → 有些站 Node 根本連不上。
 *   四 改用 curl                      再命中 11
 *     → leetcode.com 對 Node 回 403、對 curl 回 200：UA、路徑、HTTP 版本全部
 *        排除之後，剩下的差異是 TLS 指紋，Cloudflare 認得出 Node 的 ClientHello。
 *        換 header 修不掉，只能換抓取器。
 *   五 加入 PDF ＋ 修爬取順序          再命中 2
 *     → 我差一點發布一個假指控：GENIUS Olympiad 的資格引文在該站 9 個 HTML 頁面
 *        出現 0 次，disciplines.html 寫的是「age between 13-18」。實際上那句逐字
 *        在官方 GENIUS_Rules.pdf 的 ELIGIBILITY 段落裡，而 13-18 是**陪同人規則**
 *        的門檻，兩者不衝突。競賽規則常常就住在 PDF 裡。
 *
 * 最終 107／155（69%）逐字找到，48 條未命中，而那 48 條逐一查證後**沒有一條是
 * 資料錯誤**：16 條的站台是前端渲染（工具看不到內容）、1 條擋機器人、
 * 31 條是站台可讀但引文在爬取範圍外（子頁更深、或引文本來就來自別的來源，
 * 例如條目在記錄「被接管的舊網域回了什麼」或「http:// port 80 回了什麼」）。
 *
 * ── 所以它的輸出要怎麼讀 ──
 *
 * **`absent` 不等於「引文是錯的」。** 它等於「這支工具在它走過的範圍內沒找到」。
 * 要據以修改資料，必須人工再查一次，而且要先問「這句話原本是從哪裡抄來的」。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'public/advanced-resources/competitions.json');
const TMP = path.join(ROOT, '.quote-audit-tmp');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const MAX_PAGES = 30;
const MAX_PDFS = 12;
const CONCURRENCY = 6;
const BUDGET_MS = 200_000;

// ── 正規化 ────────────────────────────────────────────────
//
// 字元類一律用 \uXXXX。**絕對不要在這裡放肉眼看不出來的字面字元**：
// 這支工具第一版就是這樣瞎掉的——空白字元類寫成字面的 U+00A0／U+2000／U+202F，
// 寫檔過程中被正規化成普通空白，於是類變成 [U+0020-U+200B]，涵蓋全部 ASCII。
// norm() 把英文引文壓成空字串，而 "x".includes("") 恆為真，
// 於是 97 條引文全部被判「精確命中」，實際上在比對空字串。
const ENTITIES = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    '&nbsp;': ' ', '&#039;': "'", '&#39;': "'", '&#8217;': "'", '&#8216;': "'",
    '&#8220;': '"', '&#8221;': '"', '&#8211;': '-', '&#8212;': '-', '&#160;': ' ',
    '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"', '&ndash;': '-', '&mdash;': '-',
};
export function norm(s) {
    let t = String(s);
    for (const [k, v] of Object.entries(ENTITIES)) t = t.split(k).join(v);
    return t
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/[\u2018\u2019\u201B\u02BC]/g, "'")
        .replace(/[\u201C\u201D\u201F]/g, '"')
        .replace(/[\u2010-\u2015\u2212\uFF0D]/g, '-')
        .replace(/[\u00A0\u2000-\u200B\u202F\u3000]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
export const skeleton = (s) => norm(s).toLowerCase().replace(/[^a-z0-9\u4E00-\u9FFF]/g, '');

// ── 自我檢查：這支工具已經瞎過一次，不能再瞎第二次 ──
export function selfTest() {
    const en = 'International Group Leaders for 2025-26';
    if (norm(en) !== en) throw new Error(`norm() 破壞了 ASCII → ${JSON.stringify(norm(en))}`);
    if (skeleton(en).length < 20) throw new Error(`skeleton() 吃掉了英文 → ${JSON.stringify(skeleton(en))}`);
    const zh = '\u4E2D\u83EF\u6578\u5B78\u5354\u6703';
    if (skeleton(zh).length !== 6) throw new Error(`skeleton() 吃掉了中文 → ${JSON.stringify(skeleton(zh))}`);
    if (norm('a\u00A0b') !== 'a b') throw new Error('norm() 沒有把不斷行空白正規化');
    // 空引文必須被擋掉：includes('') 恆真，那是上次全綠的直接原因
    if (skeleton('...').length !== 0) throw new Error('skeleton() 對純標點應回空字串');
}

const visible = (html) => norm(String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, ' '));

// ── 抓取 ──────────────────────────────────────────────────
const run = (cmd, args, opts = {}) => new Promise((res) =>
    execFile(cmd, args, { timeout: 60_000, maxBuffer: 24 * 1024 * 1024, ...opts },
        (e, out) => res({ err: e ? String(e.message).slice(0, 60) : null, out })));

async function fetchHtml(url) {
    const { out } = await run('curl', ['-sS', '-L', '--max-redirs', '5', '-m', '25', '--compressed',
        '-w', '\n@@@%{http_code}@@@%{url_effective}@@@%{content_type}', '-H', `User-Agent: ${UA}`,
        '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        '-H', 'Accept-Language: zh-TW,zh;q=0.9,en;q=0.8', url], { encoding: 'buffer' });
    if (!out || !out.length) return {};
    const buf = Buffer.from(out);
    const i = buf.lastIndexOf(Buffer.from('\n@@@'));
    if (i < 0) return {};
    const meta = buf.subarray(i + 4).toString('utf8').split('@@@');
    const ct = meta[2] || '';
    if (!/text\/html|application\/xhtml/.test(ct)) return { status: Number(meta[0]), url: meta[1] };
    const body = buf.subarray(0, i);
    // 台灣的老站台大量使用 Big5（tmo.com.tw 就是），一律 utf8 會得到亂碼，
    // 然後「引文找不到」——那會被誤讀成資料錯誤。
    const head = body.subarray(0, 2048).toString('latin1');
    const enc = ((/charset=["']?([\w-]+)/i.exec(ct) || [])[1]
        || (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1] || 'utf-8').toLowerCase();
    let text;
    try { text = new TextDecoder(enc).decode(body); } catch { text = body.toString('utf8'); }
    return { status: Number(meta[0]), url: meta[1], html: text };
}

async function fetchPdf(url) {
    const id = createHash('sha1').update(url).digest('hex').slice(0, 16);
    const pdf = path.join(TMP, `${id}.pdf`);
    const txt = path.join(TMP, `${id}.txt`);
    if ((await run('curl', ['-sS', '-L', '-m', '40', '-o', pdf, url])).err) return null;
    if ((await run('pdftotext', ['-layout', pdf, txt])).err) return null;
    try { return norm(await readFile(txt, 'utf8')); } catch { return null; }
}

const RELEVANT = /rule|info|faq|eligib|about|guide|guideline|handbook|date|competition|contest|apply|regist|how|particip|award|prize|countr|region|format|structure|detail|overview|student|school|entry|entries|submit|deadline|schedule|instruction|policy|policies|要點|時程|規則|辦法|簡章|報名|資格|說明|辦理|競賽|活動|須知/i;
const host = (u) => new URL(u).hostname.replace(/^www\./, '');
const sameSite = (a, b) => {
    try { const x = host(a); const y = host(b); return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`); } catch { return false; }
};

function harvest(base, html) {
    const pages = []; const pdfs = []; const seen = new Set();
    // href 與標籤分開抓。
    //
    // 第一版把兩者綁在同一個正則裡（`<a ...>(內容){0,90}</a>`），結果**內容超過 90
    // 字元的連結整個配對不到**——geniusolympiad.org 首頁的 Guides 就是這樣消失的，
    // 而官方規則 PDF 的唯一入口就在那一頁。連結抽取絕對不能被內容長度綁死。
    for (const m of String(html).matchAll(/<a\b[^>]*?href=(["'])([^"']+)\1/gi)) {
        let abs;
        try { abs = new URL(m[2], base).href.split('#')[0]; } catch { continue; }
        if (!/^https?:/.test(abs) || seen.has(abs)) continue;
        seen.add(abs);
        // 標籤只用來加分；抓不到就算了，不影響連結本身被收進來
        const near = String(html).slice(m.index, m.index + 400);
        const lm = /<a\b[^>]*>([\s\S]{0,120}?)<\/a>/i.exec(near);
        const label = lm ? lm[1].replace(/<[^>]*>/g, ' ') : '';
        const score = (RELEVANT.test(abs) ? 2 : 0) + (RELEVANT.test(label) ? 2 : 0);
        // PDF 不限同站：規則常放在 S3／雲端硬碟
        if (/\.pdf(\?|$)/i.test(abs)) { pdfs.push({ url: abs, score: score + 3 }); continue; }
        if (!sameSite(base, abs)) continue;
        if (/\.(jpe?g|png|gif|svg|zip|docx?|xlsx?|pptx?|mp4|ico|css|js|xml|rss)(\?|$)/i.test(abs)) continue;
        pages.push({ url: abs, score });
    }
    return { pages, pdfs };
}

async function pool(items, fn, n) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
        // 先取號再 await：寫成 `await fn(items[i]), i += 1` 的話，
        // 兩個 worker 會在同一個 await 期間讀到同一個 i，做重複工作又漏掉別的。
        while (i < items.length) {
            const k = i;
            i += 1;
            await fn(items[k]);
        }
    }));
}

// ── 抽引文 ────────────────────────────────────────────────
const QUOTE_RE = /[「『]([^」』]{8,400})[」』]/g;
const FIELDS = ['description', 'eligibility', 'registrationNote', 'organizer'];

export function extractQuotes(entry) {
    const out = [];
    for (const f of FIELDS) {
        for (const m of String(entry[f] ?? '').matchAll(QUOTE_RE)) {
            const q = m[1].trim();
            // 只留看起來像「外文原文」的：純中文的引號多半是我們自己的敘述
            //（最常見的是「更正：先前記載『…』」，被引的是舊的錯誤說法）
            const latin = (q.match(/[A-Za-z]/g) || []).length;
            // 年份判斷要容許「2026 年」這種中文常見排版（數字與「年」之間有空白）
            if (latin >= 6 || /\d{4}\s?[-/年]/.test(q)) out.push(q);
        }
    }
    return out;
}

function match(text, want) {
    const sk = skeleton(text);
    for (const w of want) {
        if (w.hit) continue;
        // 省略號是我們自己加的，整段不可能命中——拆片段，要求同一份文件裡每段都在。
        // 門檻 >= 3 而不是 >= 6：John Locke 的「Entry ... is open to students from
        // any country」第一段 skeleton 只有 "entry"（5 字元），>= 6 會把它濾掉、
        // 讓 parts 掉回 1 段而不觸發省略號分支——那一條其實逐字在頁面上。
        const parts = w.nq.split(/\s*(?:…+|\.\.\.)\s*/).map(skeleton).filter((z) => z.length >= 3);
        const elidable = parts.length > 1 && parts.some((z) => z.length >= 12);
        if (text.includes(w.nq)) w.hit = { verdict: 'exact', where: w.where };
        else if (elidable && parts.every((z) => sk.includes(z))) w.hit = { verdict: 'exact-elided', where: w.where };
        else if (sk.includes(w.sq)) w.hit = { verdict: 'loose', where: w.where };
    }
}

async function auditEntry(entry) {
    const quotes = extractQuotes(entry);
    if (!quotes.length || !entry.url) return [];
    const t0 = Date.now();
    const want = quotes.map((q) => ({ q, nq: norm(q), sq: skeleton(q), hit: null, where: '' }));
    const queue = [{ url: entry.url, d: 0, score: 9 }];
    const pdfQueue = []; const done = new Set();
    let nPages = 0; let nPdf = 0; let rootStatus = null; let bestText = 0;

    // 第一階段：HTML。深度優先於分數——站台的頂層導覽是最有價值的一組，
    // 只按分數排會讓第二層的高分頁把第一層擠掉（geniusolympiad.org 的
    // guides.html 分數 0 卻是規則 PDF 的唯一入口）。
    while (queue.length && nPages < MAX_PAGES && Date.now() - t0 < BUDGET_MS) {
        if (want.every((w) => w.hit)) break;
        queue.sort((a, b) => (a.d - b.d) || (b.score - a.score));
        const cur = queue.shift();
        if (done.has(cur.url)) continue;
        done.add(cur.url); nPages += 1;
        const r = await fetchHtml(cur.url);
        if (rootStatus === null) rootStatus = r.status ?? 'err';
        if (!r.html) continue;
        const text = visible(r.html);
        bestText = Math.max(bestText, text.length);
        for (const w of want) w.where = r.url;
        match(text, want);
        const { pages, pdfs } = harvest(r.url, r.html);
        for (const p of pdfs) if (!done.has(p.url)) pdfQueue.push(p);
        if (cur.d < 2) for (const p of pages) if (!done.has(p.url)) queue.push({ ...p, d: cur.d + 1, score: p.score });
    }

    // 第二階段：PDF，全部收集完再依相關性挑。先發現先抓等於隨機挑。
    if (!want.every((w) => w.hit)) {
        const rank = (u) => (/rule|regulation|eligib|guide|handbook|簡章|辦法|要點/i.test(u) ? 5 : 0);
        pdfQueue.sort((a, b) => (rank(b.url) + b.score) - (rank(a.url) + a.score));
        for (const p of pdfQueue) {
            if (want.every((w) => w.hit) || nPdf >= MAX_PDFS || Date.now() - t0 > BUDGET_MS) break;
            if (done.has(p.url)) continue;
            done.add(p.url); nPdf += 1;
            const txt = await fetchPdf(p.url);
            if (!txt) continue;
            for (const w of want) w.where = `${p.url} (PDF)`;
            match(txt, want);
        }
    }

    return want.map((w) => ({
        title: entry.title,
        url: entry.url,
        quote: w.q,
        ...(w.hit ?? { verdict: 'absent', where: '' }),
        nPages,
        nPdf,
        rootStatus,
        // 首頁可見文字量：用來分辨「前端渲染看不到」與「站台可讀但沒找到」
        maxTextSeen: bestText,
    }));
}

// ── CLI ───────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`
    || process.argv[1]?.endsWith('audit-quote-freshness.mjs')) {
    selfTest();
    const only = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
    const asJson = process.argv.includes('--json');

    const data = JSON.parse(await readFile(DATA, 'utf8'));
    const entries = data.competitions.filter((c) => (!only || c.title.includes(only)) && extractQuotes(c).length);
    await mkdir(TMP, { recursive: true });

    process.stderr.write(`稽核 ${entries.length} 個條目、${entries.reduce((a, c) => a + extractQuotes(c).length, 0)} 條引文…\n`);
    const all = [];
    await pool(entries, async (e) => {
        all.push(...await auditEntry(e));
        process.stderr.write('.');
    }, CONCURRENCY);
    process.stderr.write('\n');
    await rm(TMP, { recursive: true, force: true });

    const tally = {};
    for (const x of all) tally[x.verdict] = (tally[x.verdict] || 0) + 1;
    const found = all.length - (tally.absent || 0);

    if (asJson) {
        process.stdout.write(`${JSON.stringify(all, null, 1)}\n`);
    } else {
        const lines = [
            `逐字引文稽核：${all.length} 條，命中 ${found}（${(found / all.length * 100).toFixed(0)}%）`,
            ...Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k.padEnd(14)}${v}`),
            '',
            '未命中的（**這不等於引文是錯的**，只代表這支工具沒找到）：',
        ];
        for (const x of all.filter((y) => y.verdict === 'absent')) {
            const why = x.rootStatus === 403 || x.rootStatus === 429 ? '站台擋機器人'
                : x.maxTextSeen < 2500 ? '前端渲染，工具看不到內容'
                    : '站台可讀，爬取範圍內沒找到';
            lines.push(`  ${x.title}`);
            lines.push(`    ${x.quote.length > 110 ? `${x.quote.slice(0, 110)}…` : x.quote}`);
            lines.push(`    ${why}（HTML ${x.nPages} 頁、PDF ${x.nPdf} 份、最大可見文字 ${x.maxTextSeen} 字）`);
        }
        process.stdout.write(`${lines.join('\n')}\n`);
    }
    // 稽核工具不決定成敗：它的輸出要人讀。
    process.exit(0);
}
