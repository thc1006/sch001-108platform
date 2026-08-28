#!/usr/bin/env node
/**
 * 版面幾何比對。用法：node perf/layout-diff.mjs <before.json> <after.json> [--tol 0.5] [--top 15]
 *
 * 元素以 DOM 順序對位（字型變更不會改 DOM 結構；元素數不同就直接報出來，
 * 代表發生的不只是字型變化，不能用位移數字去解釋）。
 */
import { readFileSync } from 'node:fs';

const [A, B] = process.argv.slice(2).filter((x) => !x.startsWith('--'));
const arg = (n, d) => {
    const i = process.argv.indexOf('--' + n);
    return i === -1 ? d : Number(process.argv[i + 1]);
};
const TOL = arg('tol', 0.5); // px，低於此值視為相同
const TOP = arg('top', 15);

const a = JSON.parse(readFileSync(A, 'utf8'));
const b = JSON.parse(readFileSync(B, 'utf8'));

const pagesA = Object.keys(a.pages);
const pagesB = Object.keys(b.pages);
const onlyA = pagesA.filter((p) => !b.pages[p]);
const onlyB = pagesB.filter((p) => !a.pages[p]);

let totalEls = 0;
let movedEls = 0;
const perPage = [];
const countMismatch = [];
const worst = [];

for (const p of pagesA) {
    if (!b.pages[p]) continue;
    const ea = a.pages[p].els,
        eb = b.pages[p].els;
    if (ea.length !== eb.length) {
        countMismatch.push(`${p}  ${ea.length} → ${eb.length}`);
        continue;
    }
    let moved = 0,
        maxDx = 0,
        maxDy = 0,
        maxDw = 0,
        maxDh = 0;
    for (let i = 0; i < ea.length; i++) {
        const [ta, ca, x1, y1, w1, h1] = ea[i];
        const [, cb, x2, y2, w2, h2] = eb[i];
        const dx = Math.abs(x2 - x1),
            dy = Math.abs(y2 - y1),
            dw = Math.abs(w2 - w1),
            dh = Math.abs(h2 - h1);
        const d = Math.max(dx, dy, dw, dh);
        if (d > TOL) {
            moved++;
            worst.push({ page: p, el: `${ta}.${ca || '-'}`, dx: +dx.toFixed(1), dy: +dy.toFixed(1), dw: +dw.toFixed(1), dh: +dh.toFixed(1), d: +d.toFixed(1) });
        }
        maxDx = Math.max(maxDx, dx);
        maxDy = Math.max(maxDy, dy);
        maxDw = Math.max(maxDw, dw);
        maxDh = Math.max(maxDh, dh);
    }
    totalEls += ea.length;
    movedEls += moved;
    perPage.push({
        page: p,
        els: ea.length,
        moved,
        pct: +((moved / ea.length) * 100).toFixed(1),
        maxDx: +maxDx.toFixed(1),
        maxDy: +maxDy.toFixed(1),
        maxDw: +maxDw.toFixed(1),
        maxDh: +maxDh.toFixed(1),
        docH: [a.pages[p].docH, b.pages[p].docH],
    });
}

perPage.sort((x, y) => y.moved - x.moved);
worst.sort((x, y) => y.d - x.d);

console.log(`比對 ${A}  →  ${B}   （容差 ${TOL}px）`);
if (onlyA.length || onlyB.length) console.log(`  ⚠ 只在其中一邊的頁面：A only ${onlyA.length}，B only ${onlyB.length}`);
if (countMismatch.length) {
    console.log(`  ⚠ 元素數量不同的頁面 ${countMismatch.length} 頁（無法逐元素對位）：`);
    for (const m of countMismatch.slice(0, 10)) console.log('     ' + m);
}
const pagesChanged = perPage.filter((p) => p.moved > 0).length;
console.log(
    `  總計：${perPage.length} 頁 / ${totalEls} 個元素，其中 ${movedEls} 個位移超過 ${TOL}px（${((movedEls / totalEls) * 100).toFixed(2)}%），涉及 ${pagesChanged} 頁`,
);
const docHDiff = perPage.filter((p) => p.docH[0] !== p.docH[1]);
console.log(`  頁面總高度有變的頁數：${docHDiff.length}`);
if (docHDiff.length) {
    const deltas = docHDiff.map((p) => p.docH[1] - p.docH[0]).sort((x, y) => Math.abs(y) - Math.abs(x));
    console.log(`    最大高度變化：${deltas.slice(0, 6).join(', ')} px`);
}
console.log(`  位移最多的頁面（前 ${TOP}）：`);
for (const p of perPage.slice(0, TOP)) {
    if (p.moved === 0) break;
    console.log(
        `    ${p.page.padEnd(50)} ${String(p.moved).padStart(5)}/${String(p.els).padEnd(5)} (${String(p.pct).padStart(5)}%)  maxΔx=${p.maxDx} Δy=${p.maxDy} Δw=${p.maxDw} Δh=${p.maxDh}  docH ${p.docH[0]}→${p.docH[1]}`,
    );
}
console.log(`  單一元素位移最大的（前 ${TOP}）：`);
for (const w of worst.slice(0, TOP)) {
    console.log(`    ${w.page.padEnd(46)} ${w.el.padEnd(28)} Δx=${w.dx} Δy=${w.dy} Δw=${w.dw} Δh=${w.dh}`);
}

// 位移量分佈
const buckets = [0.5, 1, 2, 4, 8, 16, 32, 64, 1e9];
const hist = new Array(buckets.length).fill(0);
for (const w of worst) {
    for (let i = 0; i < buckets.length; i++)
        if (w.d <= buckets[i]) {
            hist[i]++;
            break;
        }
}
console.log('  位移量分佈：');
let lo = TOL;
for (let i = 0; i < buckets.length; i++) {
    if (!hist[i]) {
        lo = buckets[i];
        continue;
    }
    console.log(`    ${String(lo).padStart(5)}–${String(buckets[i] === 1e9 ? '∞' : buckets[i]).padEnd(5)}px : ${hist[i]}`);
    lo = buckets[i];
}
