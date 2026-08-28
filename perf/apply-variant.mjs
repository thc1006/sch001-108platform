#!/usr/bin/env node
/**
 * 把某個字型候選方案套用到 src/（就地修改）。量測完用 `git checkout -- src/` 還原。
 *
 * 所有取代都「宣告預期命中次數」，不符就丟例外。這個 repo 的檔案是 CRLF，
 * 用 LF 模板做字串取代會靜默失敗過四次——所以這裡一律用容忍 \r 的 regex，
 * 而且一定驗次數。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const VARIANT = process.argv[2];
if (!VARIANT) throw new Error('用法：node perf/apply-variant.mjs <baseline|A|B|C>');

/** 遞迴列出 src/ 下的檔案 */
function walk(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

/** 取代並驗證命中次數；不符就爆炸（避免 CRLF 之類的靜默失敗）。 */
function sub(file, re, to, expect) {
    const p = path.join(REPO, file);
    const before = readFileSync(p, 'utf8');
    const hits = before.match(re);
    const n = hits ? hits.length : 0;
    if (n !== expect) throw new Error(`${file}: 預期命中 ${expect} 次，實際 ${n} 次 —— ${re}`);
    writeFileSync(p, before.replace(re, to));
    return n;
}

/**
 * 對 src/ 下所有檔案做全域取代。
 * 先全部算完、驗證次數，通過才寫入 —— 否則命中數不符時會留下改到一半的工作樹。
 */
function subAll(re, to, expect) {
    let total = 0;
    const pending = [];
    for (const f of walk(path.join(REPO, 'src'))) {
        const s = readFileSync(f, 'utf8');
        const m = s.match(re);
        if (!m) continue;
        total += m.length;
        pending.push([f, s.replace(re, to)]);
    }
    if (total !== expect) throw new Error(`全域取代預期 ${expect} 次，實際 ${total} 次 —— ${re}`);
    for (const [f, s] of pending) writeFileSync(f, s);
    return total;
}

// ── 字型堆疊定義 ────────────────────────────────────────────────
// 系統字型堆疊：先放拉丁系統字（它們沒有漢字，會自然落到下一個），再放繁中字型。
// 前半段沿用 Tailwind v4 的 --font-sans 預設（本 repo 本來就吃這組），後面接繁中字型。
// 順序理由：拉丁系統字沒有漢字，漢字會逐字往後落到第一個有該字的字型。
// PingFang TC＝macOS/iOS；Microsoft JhengHei UI／JhengHei＝Windows；
// Noto Sans TC／Noto Sans CJK TC／Source Han Sans TC＝Android 與 Linux。
// JhengHei 放在 Noto 之前是刻意的：Windows 內建的 Noto Sans TC 是可變字型，
// 其 PostScript 名為 NotoSansTC-Thin，而且垂直度量與 Google 供應的版本不同
// （hhea 1.000/0.200 vs 1.160/0.288），命中它反而比命中 JhengHei 更難預測。
const SYSTEM_STACK =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, " +
    "'PingFang TC', 'Microsoft JhengHei UI', 'Microsoft JhengHei', " +
    "'Noto Sans TC', 'Noto Sans CJK TC', 'Source Han Sans TC', sans-serif";
const SYSTEM_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

// B 方案：自架子集，後面仍接完整系統堆疊當備援
const SELFHOST_STACK = "'Inter', 'Noto Sans TC Subset', " + SYSTEM_STACK;
const SELFHOST_MONO = "'Space Mono', " + SYSTEM_MONO;

// 被取代的原字串（CRLF 無關，這幾個都在同一行）
const RE_SANS = /'Inter', 'Noto Sans TC', sans-serif/g;
const RE_MONO = /'Space Mono', ui-monospace, monospace/g;
// BaseLayout 的整個字體區塊（跨行，容忍 CRLF）
const RE_BASELAYOUT_FONTS = /[ \t]*<!-- 字體 -->\r?\n[\s\S]*?rel="stylesheet"\r?\n[ \t]*\/>\r?\n/;
// competitions 的 Space Mono <Fragment slot="head">
const RE_COMP_HEAD = /[ \t]*<Fragment slot="head">\r?\n[\s\S]*?<\/Fragment>\r?\n\r?\n/;

const BL = 'src/layouts/BaseLayout.astro';
const COMP = 'src/pages/advanced-resources/competitions.astro';

const NL = '\r\n'; // 這個 repo 是 CRLF
const L = (...lines) => lines.join(NL) + NL;

function gfontsLink(query) {
    return L(
        '    <!-- 字體 -->',
        '    <link rel="preconnect" href="https://fonts.googleapis.com" />',
        '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
        '    <link',
        `      href="${query}"`,
        '      rel="stylesheet"',
        '    />',
    );
}

/** B 與 B2 共用：把 @font-face 寫進 global.css，並把 woff2 複製到 public/fonts/。 */
function installSelfHostedFaces() {
    const g = path.join(REPO, 'src/styles/global.css');
    const css = readFileSync(g, 'utf8');
    const faces = L(
        '',
        '/* 自架字型子集（量測用變體 B / B2） */',
        '@font-face {',
        "  font-family: 'Inter';",
        '  font-style: normal;',
        '  font-weight: 400 900;',
        '  font-display: swap;',
        "  src: url('/sch001-108platform/fonts/Inter-subset.woff2') format('woff2');",
        '}',
        '@font-face {',
        "  font-family: 'Noto Sans TC Subset';",
        '  font-style: normal;',
        '  font-weight: 400 900;',
        '  font-display: swap;',
        "  src: url('/sch001-108platform/fonts/NotoSansTC-subset.woff2') format('woff2');",
        '}',
        '@font-face {',
        "  font-family: 'Space Mono';",
        '  font-style: normal;',
        '  font-weight: 400;',
        '  font-display: swap;',
        "  src: url('/sch001-108platform/fonts/SpaceMono-400.woff2') format('woff2');",
        '}',
        '@font-face {',
        "  font-family: 'Space Mono';",
        '  font-style: normal;',
        '  font-weight: 700;',
        '  font-display: swap;',
        "  src: url('/sch001-108platform/fonts/SpaceMono-700.woff2') format('woff2');",
        '}',
    );
    const anchor = '@source inline(';
    const ai = css.indexOf(anchor);
    if (ai < 0) throw new Error('global.css 找不到 @source inline 錨點');
    const eol = css.indexOf(String.fromCharCode(10), ai);
    if (eol < 0) throw new Error('global.css 的 @source inline 沒有行尾');
    writeFileSync(g, css.slice(0, eol + 1) + faces + css.slice(eol + 1));
    const dst = path.join(REPO, 'public/fonts');
    mkdirSync(dst, { recursive: true });
    for (const [src, out] of Object.entries({
        'NotoSansTC-subset-vf49.woff2': 'NotoSansTC-subset.woff2',
        'Inter-subset-vf.woff2': 'Inter-subset.woff2',
        'SpaceMono-400.woff2': 'SpaceMono-400.woff2',
        'SpaceMono-700.woff2': 'SpaceMono-700.woff2',
    })) {
        copyFileSync(path.join(REPO, 'perf/fontout', src), path.join(dst, out));
    }
}

if (VARIANT === 'baseline') {
    console.log('baseline：不做任何修改');
} else if (VARIANT === 'A') {
    // ── A：純系統字型堆疊，完全不載入任何 webfont ──
    sub(BL, RE_BASELAYOUT_FONTS, L('    <!-- 字體：純系統字型堆疊，不載入 webfont -->'), 1);
    sub(COMP, RE_COMP_HEAD, '', 1);
    subAll(RE_SANS, SYSTEM_STACK, 21);
    subAll(RE_MONO, SYSTEM_MONO, 5);
} else if (VARIANT === 'B') {
    // ── B：自架 + 子集化（Noto Sans TC 可變字重 400..900 單檔）＋ preload ──
    sub(
        BL,
        RE_BASELAYOUT_FONTS,
        L(
            '    <!-- 字體：自架子集 -->',
            '    <link',
            '      rel="preload"',
            '      as="font"',
            '      type="font/woff2"',
            '      crossorigin',
            '      href={`${base}/fonts/NotoSansTC-subset.woff2`}',
            '    />',
        ),
        1,
    );
    sub(COMP, RE_COMP_HEAD, '', 1);
    subAll(RE_SANS, SELFHOST_STACK, 21);
    subAll(RE_MONO, SELFHOST_MONO, 5);
    installSelfHostedFaces();
    console.log('已套用自架字型（含 preload）');
} else if (VARIANT === 'B2') {
    // ── B2：與 B 完全相同，只拿掉 724KB 字型的 rel=preload ──
    // B 的 FCP 明顯比 baseline 還差，懷疑是 preload 把頻寬從 render-blocking CSS
    // 手上搶走。拿掉 preload 單獨量一次，把「是不是 preload 害的」變成量測而不是推論。
    sub(BL, RE_BASELAYOUT_FONTS, L('    <!-- 字體：自架子集，不 preload（對照組 B2） -->'), 1);
    sub(COMP, RE_COMP_HEAD, '', 1);
    subAll(RE_SANS, SELFHOST_STACK, 21);
    subAll(RE_MONO, SELFHOST_MONO, 5);
    installSelfHostedFaces();
    console.log('已套用自架字型（無 preload）');
} else if (VARIANT === 'D') {
    // ── D：拉丁自架子集（Inter）＋ 漢字走系統字型 ──
    // 量到的字型位元組裡幾乎全部是漢字；拉丁那一份只有幾十 KB。
    // 這個組合保留站台既有的拉丁／數字外觀，只讓漢字改用使用者裝置上的字型。
    sub(
        BL,
        RE_BASELAYOUT_FONTS,
        L(
            '    <!-- 字體：拉丁自架子集，漢字用系統字型 -->',
            '    <link',
            '      rel="preload"',
            '      as="font"',
            '      type="font/woff2"',
            '      crossorigin',
            '      href={`${base}/fonts/Inter-subset.woff2`}',
            '    />',
        ),
        1,
    );
    sub(COMP, RE_COMP_HEAD, '', 1);
    subAll(RE_SANS, "'Inter', " + SYSTEM_STACK, 21);
    subAll(RE_MONO, "'Space Mono', " + SYSTEM_MONO, 5);

    const g = path.join(REPO, 'src/styles/global.css');
    const css = readFileSync(g, 'utf8');
    const faces = L(
        '',
        '/* 自架拉丁子集（量測用變體 D） */',
        '@font-face {',
        "  font-family: 'Inter';",
        '  font-style: normal;',
        '  font-weight: 400 900;',
        '  font-display: swap;',
        "  src: url('/sch001-108platform/fonts/Inter-subset.woff2') format('woff2');",
        '}',
    );
    const marker = /(@source inline\([^)]*\);\r?\n)/;
    if (!marker.test(css)) throw new Error('global.css 找不到 @source inline 錨點');
    writeFileSync(g, css.replace(marker, '$1' + faces));

    // Space Mono 的 @font-face 放進 competitions 頁自己的 <style>，
    // 這樣它只會進到該頁的 CSS bundle，其他 92 頁完全不會碰到。
    const cp = path.join(REPO, COMP);
    const comp = readFileSync(cp, 'utf8');
    const smFaces = L(
        '    @font-face {',
        "      font-family: 'Space Mono';",
        '      font-style: normal; font-weight: 400; font-display: swap;',
        "      src: url('/sch001-108platform/fonts/SpaceMono-400.woff2') format('woff2');",
        '    }',
        '    @font-face {',
        "      font-family: 'Space Mono';",
        '      font-style: normal; font-weight: 700; font-display: swap;',
        "      src: url('/sch001-108platform/fonts/SpaceMono-700.woff2') format('woff2');",
        '    }',
    );
    const styleOpen = /(<style is:global>\r?\n)/;
    if (!styleOpen.test(comp)) throw new Error('competitions.astro 找不到 <style> 錨點');
    writeFileSync(cp, comp.replace(styleOpen, '$1' + smFaces));

    const dst = path.join(REPO, 'public/fonts');
    mkdirSync(dst, { recursive: true });
    for (const [src, out] of Object.entries({
        'Inter-subset-vf.woff2': 'Inter-subset.woff2',
        'SpaceMono-400.woff2': 'SpaceMono-400.woff2',
        'SpaceMono-700.woff2': 'SpaceMono-700.woff2',
    })) {
        copyFileSync(path.join(REPO, 'perf/fontout', src), path.join(dst, out));
    }
    console.log('已複製 3 個 woff2 到 public/fonts/');
} else if (VARIANT === 'D2') {
    // ── D2：與 D 相同，但不 preload，且 Inter 子集涵蓋整個 latin unicode-range ──
    // 量到的字型位元組裡幾乎全部是漢字；拉丁那一份只有幾十 KB。
    // 這個組合保留站台既有的拉丁／數字外觀，只讓漢字改用使用者裝置上的字型。
    sub(
        BL,
        RE_BASELAYOUT_FONTS,
        L(
            '    <!-- 字體：拉丁自架子集，漢字用系統字型（不 preload） -->',
        ),
        1,
    );
    sub(COMP, RE_COMP_HEAD, '', 1);
    subAll(RE_SANS, "'Inter', " + SYSTEM_STACK, 21);
    subAll(RE_MONO, "'Space Mono', " + SYSTEM_MONO, 5);

    const g = path.join(REPO, 'src/styles/global.css');
    const css = readFileSync(g, 'utf8');
    const faces = L(
        '',
        '/* 自架拉丁子集（量測用變體 D2） */',
        '@font-face {',
        "  font-family: 'Inter';",
        '  font-style: normal;',
        '  font-weight: 400 900;',
        '  font-display: swap;',
        "  src: url('/sch001-108platform/fonts/Inter-subset.woff2') format('woff2');",
        '}',
    );
    const marker = /(@source inline\([^)]*\);\r?\n)/;
    if (!marker.test(css)) throw new Error('global.css 找不到 @source inline 錨點');
    writeFileSync(g, css.replace(marker, '$1' + faces));

    // Space Mono 的 @font-face 放進 competitions 頁自己的 <style>，
    // 這樣它只會進到該頁的 CSS bundle，其他 92 頁完全不會碰到。
    const cp = path.join(REPO, COMP);
    const comp = readFileSync(cp, 'utf8');
    const smFaces = L(
        '    @font-face {',
        "      font-family: 'Space Mono';",
        '      font-style: normal; font-weight: 400; font-display: swap;',
        "      src: url('/sch001-108platform/fonts/SpaceMono-400.woff2') format('woff2');",
        '    }',
        '    @font-face {',
        "      font-family: 'Space Mono';",
        '      font-style: normal; font-weight: 700; font-display: swap;',
        "      src: url('/sch001-108platform/fonts/SpaceMono-700.woff2') format('woff2');",
        '    }',
    );
    const styleOpen = /(<style is:global>\r?\n)/;
    if (!styleOpen.test(comp)) throw new Error('competitions.astro 找不到 <style> 錨點');
    writeFileSync(cp, comp.replace(styleOpen, '$1' + smFaces));

    const dst = path.join(REPO, 'public/fonts');
    mkdirSync(dst, { recursive: true });
    for (const [src, out] of Object.entries({
        'Inter-latin-vf.woff2': 'Inter-subset.woff2',
        'SpaceMono-400.woff2': 'SpaceMono-400.woff2',
        'SpaceMono-700.woff2': 'SpaceMono-700.woff2',
    })) {
        copyFileSync(path.join(REPO, 'perf/fontout', src), path.join(dst, out));
    }
    console.log('已複製 3 個 woff2 到 public/fonts/');
} else if (VARIANT === 'C') {
    // ── C：仍用 Google Fonts，但改成可變字重區間語法 ──
    sub(
        BL,
        RE_BASELAYOUT_FONTS,
        gfontsLink(
            'https://fonts.googleapis.com/css2?family=Inter:wght@400..900&family=Noto+Sans+TC:wght@400..900&display=swap',
        ),
        1,
    );
    // Space Mono 與 font-family 都不動 —— 只換字重語法，把變因隔離出來
} else {
    throw new Error('未知變體：' + VARIANT);
}

console.log('已套用變體 ' + VARIANT);
