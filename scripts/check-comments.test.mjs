// check-comments 的測試：每種語言容易誤判的寫法，以及 --code-unchanged 該過與該擋的情況。
// 誤判的案例盡量挑判錯時看得出來的輸入，例如 /[//]/ 被當成除號時，後半段會變成 // 註解。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COMMENT, ScanError, countLines, firstDifference, languageOf, scan } from './check-comments.lib.mjs';

const CLI = fileURLToPath(new URL('./check-comments.mjs', import.meta.url));
const comments = (src, lang) => scan(src, lang).filter((it) => it.kind === COMMENT).map((it) => src.slice(it.s, it.e));
const lines = (src, lang) => countLines(src, scan(src, lang));
const unchanged = (before, after, lang) => firstDifference(before, after, lang) === null;
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NBSP = String.fromCharCode(0xa0);
/** ACTIONS 讓測試的 YAML 像一個 job：run: | 只有在 GitHub Actions 的檔案裡才照 shell 掃。 */
const ACTIONS = 'runs-on: ubuntu-latest\n';

test('JS：字串裡的 // 與 /* 不是註解，字串用 \\ 接到下一行時 CRLF 算一個換行', () => {
    const src = `const a = '// no'; const b = "/* no */"; const c = 'it\\'s // no'; // yes\n`;
    assert.deepEqual(comments(src, 'js'), ['// yes']);
    assert.deepEqual(comments("x = 'a\\\r\nb'; // c\n", 'js'), ['// c']);
});

test('JS：樣板字串的文字不是註解，${} 裡面照程式掃，可以再包字串、樣板、物件和註解', () => {
    const src = 'const t = `// a ${ /* b */ x + `/* c ${ y // d\n} */` + \'${ /* e */ }\' } /* f */`;\n';
    assert.deepEqual(comments(src, 'js'), ['/* b */', '// d']);
    assert.deepEqual(comments('x = `${ {a: 1}.a // c\n}`;\n', 'js'), ['// c']);
    assert.deepEqual(comments('x = `a\\` // b`;\n', 'js'), []);
});

test('JS：正規表示式裡的 / 與 // 不是註解，字元類別裡的 / 不會結束正規表示式，flags 屬於同一個 token', () => {
    const src = 'const r = /\\/\\/+/g; const s = /[/]+/; const u = /a\\/*b/; // c\n';
    assert.deepEqual(comments(src, 'js'), ['// c']);
    assert.deepEqual(comments('ok = /https?:\\/\\//.test(u) && go();\n', 'js'), []);
    assert.ok(!unchanged('x = /a/g;\n', 'x = /a/ g;\n', 'js'));
});

test('JS：/ 是除號還是正規表示式，看前一個 token', () => {
    assert.deepEqual(comments('x = a / b // c / d\n', 'js'), ['// c / d']);
    assert.deepEqual(comments('y = (a) / 2 // c / d\n', 'js'), ['// c / d']);
    assert.deepEqual(comments('z = a[0] / 2 // c / d\n', 'js'), ['// c / d']);
    assert.deepEqual(comments('const of = 1; w = of / 2 // c / d\n', 'js'), ['// c / d']);
    assert.deepEqual(comments("x = mod.default / 2; s = '/' + 'q // w';\n", 'js'), []);
    assert.deepEqual(comments("x = this.#return / 2; s = '/' + 'a // b';\n", 'js'), []);
    assert.deepEqual(comments('function f(s) { return /[//]/.test(s); }\n', 'js'), []);
    assert.deepEqual(comments('if (x) /[//]/.test(y);\n', 'js'), []);
    assert.deepEqual(comments('for await (const x of xs) /[//]/.test(x) && n++;\n', 'js'), []);
    assert.deepEqual(comments('x = [a]\nof / 2 // c / d\n', 'js'), ['// c / d']);
});

test('JS：}、>、>>、>>>、yield、await 和 for (…) 裡的 of 後面接 / 時分不出除號和正規表示式，丟 ScanError', () => {
    for (const src of [
        "x = {} / 2; s = '/' + 'q // w'; ok();\n",
        '{}\n/[//]/.exec(s);\n',
        "const n = x as Array<number> / 2, u = '/' + 'https://example.com/a';\n",
        'n = x as A<B<number>> / 2;\n',
        'n = x as A<B<C<number>>> / 2;\n',
        'function* g() { yield /[//]/; }\n',
        'var await = 1; n = await / 2;\n',
        'for (const m of /[//]/.exec(s)) {}\n',
        'for (const {a} of /[//]/.exec(s)) {}\n',
    ]) assert.throws(() => scan(src, 'js'), /分不出 \/ 是除號還是正規表示式/, src);
    assert.deepEqual(comments('function f() {} // a\nb = {} /* c */;\n', 'js'), ['// a', '/* c */']);
    assert.deepEqual(comments("if (a) {} 'x' / 2; // c / d\n", 'js'), ['// c / d']);
    assert.deepEqual(comments('n = a.yield / b.await / 2; // c / d\n', 'js'), ['// c / d']);
    assert.deepEqual(comments('for (const x of f(of / 2)) {} // c / d\n', 'js'), ['// c / d']);
});

test('JS：程式裡的 <!-- 和 --> 丟 ScanError，classic script 會把它們當成註解', () => {
    for (const src of ['f();\n--> /* 舊的說明\nok();\n// */\n', 'x = a <!--b;\n', 'while (n-->0) go();\n']) {
        assert.throws(() => scan(src, 'js'), /分不出 <!-- 或 --> 是不是註解/, src);
    }
    assert.throws(() => scan('<script is:inline>\nf();\n--> /* c\nok();\n// */\n</script>\n', 'astro'), ScanError);
    assert.deepEqual(comments("s = '<!--' + `-->`; /* <!-- --> */ n = a-- > 0;\n", 'js'), ['/* <!-- --> */']);
});

test('JS：typeof、case、else、in、void、delete、default 和 while (…) 後面的 / 是正規表示式', () => {
    for (const src of [
        "t = typeof /[//]/; s = '/' + 'x // y';\n",
        "switch (x) { case /[//]/.source: s = '/' + 'a // b'; }\n",
        'if (a) x(); else /[//]/.test(s) && go();\n',
        "ok = 'source' in /[//]/; s = '/' + 'a // b';\n",
        'void /[//]/.test(s); delete /[//]/.x;\n',
        'export default /[//]/;\n',
        'while (x) /[//]/.test(y) && go();\n',
    ]) assert.deepEqual(comments(src, 'js'), [], src);
});

test('JS：++、-- 和 TS 的 ! 接在值後面、中間沒有換行時是後置運算子，後面的 / 是除號', () => {
    assert.deepEqual(comments("const half = width! / 2, url = '/' + 'https://example.com/a';\n", 'js'), []);
    assert.deepEqual(comments('a++ / b; c = d-- / e; // f / g\n', 'js'), ['// f / g']);
    assert.deepEqual(comments('++/[//]/.lastIndex; foo();\n', 'js'), []);
    assert.deepEqual(comments('a\n++/[//]/.lastIndex;\n', 'js'), []);
    assert.deepEqual(comments('a /* 換\n行 */ !/[//]/.test(s);\n', 'js'), ['/* 換\n行 */']);
});

test('JS：.5 和 a?.5:1 的數字是一個 token，中間插空白要擋', () => {
    assert.ok(!unchanged('x = .5;\n', 'x = . 5;\n', 'js'));
    assert.ok(!unchanged('x = a?.5:1;\n', 'x = a?. 5:1;\n', 'js'));
});

test('JS：U+2028、U+2029 也會結束 // 註解，#! 開頭的 shebang 算程式', () => {
    assert.deepEqual(comments(`// a${LS}b = 1;\n`, 'js'), ['// a']);
    assert.deepEqual(comments(`// a${PS}b = 1;\n`, 'js'), ['// a']);
    const src = '#!/usr/bin/env node\n// c\n';
    assert.deepEqual(comments(src, 'js'), ['// c']);
    assert.deepEqual(lines(src, 'js'), { comment: 1, code: 1 });
    assert.deepEqual(comments('#!/usr/bin/env -S node --x=//a\nrun();\n', 'js'), []);
});

test('行數：有程式的行算程式行，block 註解跨過的行算註解行，空白行不算', () => {
    const src = [
        '/**',
        ' * doc',
        ' *',
        ' */',
        'const a = 1; // 程式後面接註解',
        '',
        '/*',
        '   ',
        'x',
        '*/',
        'foo(); /* 開頭',
        '結尾 */ bar();',
        '',
    ].join('\n');
    assert.deepEqual(lines(src, 'js'), { comment: 7, code: 3 });
});

test('字串或註解沒有結束時丟 ScanError，不猜', () => {
    assert.throws(() => scan("const a = 'x\n';\n", 'js'), ScanError);
    assert.throws(() => scan('a /* b\n', 'js'), ScanError);
    assert.throws(() => scan('<p>x</p>\n<!-- y\n', 'astro'), ScanError);
    assert.throws(() => scan('echo "a\n', 'shell'), ScanError);
    assert.throws(() => scan('cat <<EOF', 'shell'), ScanError);
    assert.throws(() => scan('cat <<EOF\nbody\n', 'shell'), ScanError);
    assert.throws(() => scan('a: "x\n', 'yaml'), ScanError);
    assert.throws(() => scan('x: [a\n', 'yaml'), ScanError);
    assert.throws(() => scan('FROM x\nRUN <<EOF\nno end\n', 'dockerfile'), ScanError);
    assert.throws(() => scan('<script>/* a </script>\n<p>*/</p>\n', 'astro'), /註解沒有結束/);
    assert.throws(() => scan('<style>/* a </style>\n<p>*/</p>\n', 'astro'), /註解沒有結束/);
});

test('Astro：frontmatter 與 <script> 當 JS，<style> 當 CSS，<!-- --> 與 {/* */} 是註解', () => {
    const src = [
        '---',
        '// fm',
        'const s = `',
        '---',
        '`; /* fm2 */',
        'const f = <T,>(x: T) => x; // fm3',
        '---',
        '<!-- html -->',
        '<p class="a // b" title=\'/* c */\'>it\'s // text {/* jsx */}</p>',
        '{',
        '  // 換行寫法',
        '}',
        '<script>',
        "  const u = 'http://x'; // js",
        '</script>',
        '<style>',
        "  a::after { content: '/* no */'; } /* css */",
        '  b { background: url(//cdn.example/x.png); }',
        '</style>',
        '',
    ].join('\n');
    assert.deepEqual(comments(src, 'astro'), [
        '// fm', '/* fm2 */', '// fm3', '<!-- html -->', '{', '/* jsx */', '}', '{', '// 換行寫法', '}', '// js', '/* css */',
    ]);
    assert.deepEqual(comments('\n---\n// c\n---\n<p>x</p>\n', 'astro'), ['// c']);
});

test('Astro：frontmatter 的 <T extends U> 和 <const T,> 是泛型，其他標籤和型別位置的泛型函式型別丟 ScanError', () => {
    assert.deepEqual(comments("---\nconst f = <T extends object>(x: T) => x; // c\nconst s = '/' + 'x // y';\n---\n", 'astro'), ['// c']);
    assert.deepEqual(comments("---\nconst v = <const T,>(x: T) => x; // c\nconst s = '/' + 'x // y';\n---\n", 'astro'), ['// c']);
    for (const src of [
        '---\ntype F = <T>(x: T) => T;\n---\n',
        '---\ntype F = <T>(x: T) => T;\nconst a = 1;\n---\n</b>\n---\n<!-- c -->\n',
        '---\nconst el = <p>hi</p>;\n---\n<div>{el}</div>\n',
        '---\nconst s = `${ok && <p>a</p>}`;\n---\n',
    ]) assert.throws(() => scan(src, 'astro'), /分不出 frontmatter 裡的 < 是標籤還是 TS 的泛型/, src);
});

test('Astro：運算式裡的標籤照 JSX 的規則，結尾標籤的名稱對不上丟 ScanError，模板裡多出來的結尾標籤照 HTML 不管', () => {
    assert.throws(() => scan('<p>{ok && <b>x</i>}</p>\n', 'astro'), /<\/i> 和開頭的 <b> 對不上/);
    assert.throws(() => scan('<p>{ok && <br></br>}<!-- c --></p>\n', 'astro'), ScanError);
    assert.deepEqual(comments('<p>{ok && <><b>x</b></>}{/* c */}</p>\n', 'astro'), ['{', '/* c */', '}']);
    assert.deepEqual(comments('<p>a</b></p>\n<!-- c -->\n', 'astro'), ['<!-- c -->']);
});

test('Astro：運算式裡的標籤照模板處理，文字裡的 \' 與 // 不是 JS，空元素和自己結束的標籤不必關閉', () => {
    const src = '<ul>{items.map((x) => <li title="a // b">Don\'t https://a.b {x /* c */}</li>)}</ul>\n';
    assert.deepEqual(comments(src, 'astro'), ['/* c */']);
    assert.deepEqual(comments('<p>{ {a: 1}.a /* c */ }</p>\n', 'astro'), ['/* c */']);
    assert.deepEqual(comments('<p>{ok && <br>}{/* c */}</p>\n', 'astro'), ['{', '/* c */', '}']);
    assert.deepEqual(comments('<p>{ok && <Comp />}{/* c */}</p>\n', 'astro'), ['{', '/* c */', '}']);
});

test('Astro：{} 裡只有註解才整個算註解，空的 {} 是程式；標籤屬性之間可以寫 JS 註解', () => {
    assert.deepEqual(comments('<p>{}</p>\n', 'astro'), []);
    assert.deepEqual(comments('<div // c\n  class="a">x</div>\n', 'astro'), ['// c']);
});

test('Astro：type="module" 的 <script> 是 JS，其他 type 和 is:raw 的內容是文字，</scriptx> 不是結尾', () => {
    assert.deepEqual(comments('<script type="module">\n  // c\n</script>\n', 'astro'), ['// c']);
    assert.deepEqual(comments('<script type="text/plain">a // b</script>\n', 'astro'), []);
    assert.deepEqual(comments('<p is:raw>{/* x */}</p>\n', 'astro'), []);
    assert.deepEqual(comments("<script>const s = '</scriptx>'; // c\n</script>\n", 'astro'), ['// c']);
    const ld = (v) => `<script type="application/ld+json">{"a": "${v}"}</script>\n`;
    assert.ok(!unchanged(ld('b  c'), ld('b c'), 'astro'));
});

test('Astro：只有註解的 {/* */} 整行算註解行，模板文字算程式行', () => {
    const src = '<div>\n  {/* a */}\n  <!-- b -->\n</div>\n';
    assert.deepEqual(lines(src, 'astro'), { comment: 2, code: 2 });
});

test('Astro：屬性的等號兩側可以有空白，引號裡照原樣比，樣板字串的屬性值不拆', () => {
    assert.ok(!unchanged('<p title = "a  b">x</p>\n', '<p title = "a b">x</p>\n', 'astro'));
    assert.deepEqual(comments('<p title = "{/* keep */}">x</p>\n', 'astro'), []);
    assert.deepEqual(comments('<p title=`a // b`>x</p>\n', 'astro'), []);
});

test('Astro：<pre>、<textarea> 裡的空白連空行都照原樣比，<title>、<textarea> 裡的 <!-- --> 是文字', () => {
    assert.ok(!unchanged('<pre>\na\n\nb</pre>\n', '<pre>\na\nb</pre>\n', 'astro'));
    assert.ok(!unchanged('<pre is:raw>a\n\nb</pre>\n', '<pre is:raw>a\nb</pre>\n', 'astro'));
    assert.ok(!unchanged('<pre>\n  a\n  <!-- c -->\n  b</pre>\n', '<pre>\n  a\n  b</pre>\n', 'astro'));
    assert.ok(!unchanged('<pre>{x && <b>\na\n\nb</b>}</pre>\n', '<pre>{x && <b>\na\nb</b>}</pre>\n', 'astro'));
    assert.ok(unchanged('<pre>a</pre>\n<p>\n  b\n  <!-- c -->\n  d</p>\n', '<pre>a</pre>\n<p>\n  b\n  d</p>\n', 'astro'));
    const rc = '<title>a <!-- b --></title><textarea><!-- c --></textarea><pre><!-- d --></pre>\n';
    assert.deepEqual(comments(rc, 'astro'), ['<!-- d -->']);
    assert.deepEqual(comments('<title>{x && <b><!-- e --></b>}</title>\n', 'astro'), []);
});

test('Astro：模板同一行的空白照原樣比、換行後比縮排，刪掉註解時兩邊的空白要留下', () => {
    assert.ok(!unchanged('<p>a b</p>\n', '<p>a  b</p>\n', 'astro'));
    assert.ok(!unchanged('<p>\n  a\n  b</p>\n', '<p>\n  a\n    b</p>\n', 'astro'));
    assert.ok(unchanged('<p>\n  a\n  <!-- c -->\n  b</p>\n', '<p>\n  a\n  b</p>\n', 'astro'));
    assert.ok(unchanged('<p>a <!-- c --> b</p>\n', '<p>a {/* c */} b</p>\n', 'astro'));
    assert.ok(unchanged('<p>a <!-- c --> b</p>\n', '<p>a  b</p>\n', 'astro'));
    assert.ok(!unchanged('<p>a <!-- c --> b</p>\n', '<p>a b</p>\n', 'astro'));
});

test('CSS：字串、跳脫字元與沒有引號的 url() 裡的 /* 不是註解，沒有跳脫的換行會結束字串', () => {
    const src = 'a { content: "/* no */"; background: url(/*no*/x.png); } /* yes */\n';
    assert.deepEqual(comments(src, 'css'), ['/* yes */']);
    assert.deepEqual(comments('a { content: "x\n} /* c */\n', 'css'), ['/* c */']);
    assert.deepEqual(comments('a { content: "\\"/* x */"; }\n', 'css'), []);
    assert.deepEqual(comments('.a\\"b /* c */ {}\n', 'css'), ['/* c */']);
    assert.deepEqual(comments('a { b: url(")/* c */"); }\n', 'css'), []);
    assert.deepEqual(comments('a { b: my-url(/* c */); }\n', 'css'), ['/* c */']);
});

test('CSS：NBSP 是內容，不是空白', () => {
    assert.ok(!unchanged('a { b: c d; }\n', `a { b: c${NBSP}d; }\n`, 'css'));
});

test('shell：引號、$#、${x#y}、${x:- # y}、a#b 裡的 # 不是註解，空白、tab 和 ; ( 之後的是，shebang 算程式', () => {
    const src = [
        '#!/bin/sh',
        '# c1',
        'echo "a # b" \'c # d\' $# ${x#y} ${x:- # y} a#b # c2',
        'x="$(echo "e # f")" # c3',
        'a;# c4',
        '',
    ].join('\n');
    assert.deepEqual(comments(src, 'shell'), ['# c1', '# c2', '# c3', '# c4']);
    assert.deepEqual(lines(src, 'shell'), { comment: 1, code: 4 });
    assert.deepEqual(comments('echo a\t# c\n(#d\n echo e)\n', 'shell'), ['# c', '#d']);
});

test('shell：雙引號裡的 \\"、$\'…\' 裡的 \\\'、${ } 裡的單引號都不會提早結束引號', () => {
    assert.deepEqual(comments('echo "a \\" # b"\n', 'shell'), []);
    assert.deepEqual(comments("echo $'it\\'s # x'\n", 'shell'), []);
    assert.deepEqual(comments("echo ${x:-'}'} 'a # b'\n", 'shell'), []);
});

test('shell：$( ) 裡照指令判斷，巢狀的括號不會提早結束 $( )', () => {
    assert.deepEqual(comments('x="$(# c\necho a)"\n', 'shell'), ['# c']);
    assert.deepEqual(comments('x="$( (echo a) ; echo " #k" )"\n', 'shell'), []);
});

test('shell：here-document 的內容是程式，<<- 會去掉結尾行前面的 tab，<<< 和 $(( )) 裡的 << 不是 here-document', () => {
    assert.deepEqual(comments("cat <<'EOF'\n# 不是註解\nEOF\n# c\n", 'shell'), ['# c']);
    assert.deepEqual(comments('cat << EOF\n# 不是註解\nEOF\n', 'shell'), []);
    assert.deepEqual(comments('cat <<-EOF\n\t# 不是註解\n\tEOF\n# c\n', 'shell'), ['# c']);
    assert.deepEqual(comments('echo $(( (1) << 2 ))\n# c\n', 'shell'), ['# c']);
    assert.deepEqual(comments('(( a << 2 ))\n# c\n', 'shell'), ['# c']);
    assert.deepEqual(comments('read -r a b <<< "$line" # c\ncat <<<x\n', 'shell'), ['# c']);
});

test('shell：反引號裡的 # 一律當程式', () => {
    assert.deepEqual(comments('echo `echo a # b` # c\n', 'shell'), ['# c']);
});

test('shell：[[ =~ ]] 右邊的正規表示式和 extglob pattern 是一個詞，裡面 ( | 之後的 # 不是註解', () => {
    const loop = 'while read -r line; do [[ $line =~ ^(#|$) ]] && continue; echo "$line"; done\n';
    assert.deepEqual(comments(loop, 'shell'), []);
    assert.ok(!unchanged(loop, loop.replace('continue', 'break'), 'shell'));
    assert.deepEqual(comments('[[ $x =~ (a)#b ]] # c\n', 'shell'), ['# c']);
    assert.deepEqual(comments('[[ $x =~ a|#b ]] # c\n', 'shell'), ['# c']);
    assert.deepEqual(comments('[[ $x =~ (a #b) ]] # c\n', 'shell'), ['# c']);
    assert.deepEqual(comments('[[ $x =~ ((a) #b) ]] # c\n', 'shell'), ['# c']);
    assert.deepEqual(comments("[[ $x =~ (('(') ) ]] # c\n", 'shell'), ['# c']);
    assert.deepEqual(comments('[[ $x == @(a|#b) ]] # c\n', 'shell'), ['# c']);
    assert.deepEqual(comments("[[ $x == @(a|')') ]] # c\n", 'shell'), ['# c']);
    assert.deepEqual(comments('[[ $x =~ ^a ]] # c\n[[ $x =~\n# d\n', 'shell'), ['# c', '# d']);
});

test('shell：$( ) 裡的 case 丟 ScanError，當參數的 case 和最外層的 case 照常掃', () => {
    assert.throws(() => scan('y="$(case $x in a) echo " #k";; esac)"\n', 'shell'), ScanError);
    assert.throws(() => scan('y=$(if true; then case $x in a) :;; esac; fi)\n', 'shell'), ScanError);
    assert.throws(() => scan('y=$(echo a; case $x in a) :;; esac)\n', 'shell'), ScanError);
    assert.deepEqual(comments('x=$(grep -i case f) $(casefold) # c\n', 'shell'), ['# c']);
    assert.deepEqual(comments('case $x in a) echo " #k";; esac # c\n', 'shell'), ['# c']);
});

test('YAML：引號裡的 # 和 a#b 不是註解，引號只在 node 開頭才算，node 開頭可以先寫 &anchor、!tag', () => {
    const src = [
        '# c1',
        'a: "x # y" # c2',
        "b: 'it''s # z'",
        'c: d#e',
        'd: [g, "h # i"] # c3',
        "e: x == 'f' # c4",
        "f: it's # c5",
        "g: &base 'https://example.com/a # b'",
        'h: !!str "1 # 2"',
        "i: [&x 'v # w', *x]",
        "j: [!<tag:yaml.org,2002:str> 'k # l']",
        'k: "say \\" # m"',
        "? 'n # o'",
        ': p',
        '# c6',
        '',
    ].join('\n');
    assert.deepEqual(comments(src, 'yaml'), ['# c1', '# c2', '# c3', '# c4', '# c5', '# c6']);
});

test('YAML：flow 裡 JSON 風格的 key 後面可以緊接 : 和引號裡的 value', () => {
    assert.deepEqual(comments('x: {"a":"b # c"}\ny: |\n  # 不是註解\n', 'yaml'), []);
    assert.deepEqual(comments('x: {"a" :"} # c", "d":&v \'e # f\'}\n', 'yaml'), []);
    assert.deepEqual(comments('x: [{"a":"b"},{"c":"d # e"}, {[1]:"g # h"}]\n', 'yaml'), []);
    assert.deepEqual(comments('x: {"a":\n  "b # c"}\n', 'yaml'), []);
    assert.deepEqual(comments('x: {"a\n  b":"c # d", e: f\n  }\n', 'yaml'), []);
});

test('YAML：沒有引號的值裡的空白屬於值，同一行 token 之間的空白照原樣比', () => {
    assert.ok(!unchanged('name: CI Required\n', 'name: CI  Required\n', 'yaml'));
    assert.ok(!unchanged('args: [a b]\n', 'args: [a  b]\n', 'yaml'));
    assert.ok(unchanged('name: CI Required # c\n', 'name: CI Required\n', 'yaml'));
});

test('YAML：多行 plain scalar 續行前的空行會變成換行，續行開頭的引號是普通字元', () => {
    const multi = 'd: first line\n  second line\n  third\n';
    assert.ok(!unchanged(multi, 'd: first line\n  second line\n\n  third\n', 'yaml'));
    assert.ok(!unchanged('d: a\n  b\n\n\n  c\n', 'd: a\n  b\n\n  c\n', 'yaml'));
    assert.ok(!unchanged('d: [a\n  b, c]\n', 'd: [a\n\n  b, c]\n', 'yaml'));
    assert.ok(!unchanged('- a\n  - b\n', '- a\n\n  - b\n', 'yaml'));
    assert.ok(!unchanged('d:\n  a\n  b\n', 'd:\n  a\n\n  b\n', 'yaml'));
    assert.ok(unchanged('a: 1\n\n# c\nb:\n  - name: x\n\n    run: y\n', 'a: 1\nb:\n  - name: x\n    run: y\n', 'yaml'));
    assert.ok(unchanged('d: [a,\n\n  b]\ne: [a\n\n  ]\n', 'd: [a,\n  b]\ne: [a\n  ]\n', 'yaml'));
    assert.deepEqual(comments("d: Ken\n  's book # x\ny: |\n  say 'hi # 不是註解\n", 'yaml'), ['# x']);
    assert.deepEqual(comments("d: a\n  - 'b # c'\n", 'yaml'), ["# c'"]);
    assert.deepEqual(comments("a\n...\n--- 'b # c'\n", 'yaml'), []);
    assert.deepEqual(comments('d: [a\n  "b", "c # d"]\n', 'yaml'), []);
});

test('YAML：在多行 plain scalar 中間加註解不是合法的 YAML，要擋', () => {
    assert.ok(!unchanged('d: a\n  b\n', 'd: a # c\n  b\n', 'yaml'));
    assert.ok(!unchanged('d: a\n  b\n', 'd: a\n  # c\n  b\n', 'yaml'));
});

test('YAML：run: | 的內容照 shell 判斷，其他 block scalar 裡的 # 是字串內容', () => {
    const src = [
        'runs-on: ubuntu-latest',
        'steps:',
        '  - run: |',
        '      # shell 註解',
        '      echo "# not" # 行尾',
        '    env:',
        '      X: 1',
        '  - with:',
        '      body: |',
        '        # 標題，不是註解',
        '      script: &s !!str |',
        '        # 不是註解',
        '      prerun: |',
        '        # 不是 run',
        '? |',
        '  # 也不是註解',
        ': v',
        '',
    ].join('\n');
    assert.deepEqual(comments(src, 'yaml'), ['# shell 註解', '# 行尾']);
});

test('YAML：run: | 裡和 ${{ }} 重疊的 shell 註解是程式，Actions 會先代換運算式', () => {
    const run = (line) => `${ACTIONS}steps:\n  - run: |\n      ${line}\n      echo hi\n`;
    assert.ok(!unchanged(run('# 印出說明'), run('# 不要寫 ${{ github.event.head_commit.message }}'), 'yaml'));
    assert.ok(!unchanged(run('# 印出說明'), run('# 這裡不要寫 ${{ 運算式'), 'yaml'));
    assert.ok(!unchanged(run('# ${{ github.x }}'), run('# ${{ github.y }}'), 'yaml'));
    assert.deepEqual(comments(run("echo ${{ x }} # a ${{ format('}}') }} b"), 'yaml'), []);
    assert.deepEqual(comments(run('echo ${{ x }} # c'), 'yaml'), ['# c']);
});

test('YAML：跨行的 ${{ }} 和縮排變淺而離開 run: | 的行都要擋', () => {
    const run = (body) => `${ACTIONS}steps:\n  - run: |\n${body}      echo hi\n`;
    const expr = (s) => run(`      # \${{ format('}}\n      # ${s}') }}\n`);
    assert.ok(!unchanged(expr('x'), expr('y'), 'yaml'));
    assert.ok(!unchanged(run('      echo a\n      # c\n'), run('      echo a\n     # c\n'), 'yaml'));
});

test('YAML：run: | 只有交給 bash 或 sh 時照 shell 掃，其他 shell、Windows 和不是 Actions 的 YAML 整段比', () => {
    const step = (shell, runsOn = 'ubuntu-latest') => `runs-on: ${runsOn}\nsteps:\n  - ${shell}run: |\n      print('it\\'s # 1')\n`;
    assert.deepEqual(comments(step(''), 'yaml'), ["# 1')"]);
    assert.deepEqual(comments(step('shell: bash\n    '), 'yaml'), ["# 1')"]);
    assert.deepEqual(comments(step('shell: python\n    '), 'yaml'), []);
    assert.deepEqual(comments(step('"shell": python\n    '), 'yaml'), []);
    assert.deepEqual(comments(step('', 'windows-latest'), 'yaml'), []);
    assert.deepEqual(comments(step('', '${{ matrix.os }}'), 'yaml'), []);
    assert.deepEqual(comments('defaults: {run: {shell: pwsh}}\n' + step(''), 'yaml'), []);
    assert.deepEqual(comments('data:\n  run: |\n    print("x") # 1\n', 'yaml'), []);
});

test('YAML：有 &anchor 的 run: | 整段逐字比，別處可能用 *alias 拿去當一般字串', () => {
    assert.deepEqual(comments(`${ACTIONS}a:\n  run: &r |\n    # x\n    echo hi\nb:\n  env:\n    S: *r\n`, 'yaml'), []);
});

test('YAML：block scalar 的內容比 key 開始的那一欄深，key 可以有空白、node property，標頭也可以獨自一行', () => {
    for (const src of [
        'my key: |\n  a\n  # 不是註解\n',
        '"my key" : |\n  a\n  # 不是註解\n',
        '- my key: |\n    a\n    # 不是註解\n',
        '- &k my key: |\n    a\n    # 不是註解\n',
        '!!str key: |\n  a\n  # 不是註解\n',
        'my key:\n  |\n  a\n  # 不是註解\n',
        'my key: |2\n    a\n  # 不是註解\n',
        'a: |2\n    x\n  # 不是註解\n',
    ]) assert.deepEqual(comments(src, 'yaml'), [], src);
    for (const key of ['run :', '"run":', '&k run:']) assert.deepEqual(comments(`${ACTIONS}${key} |\n  # c\n  echo a\n`, 'yaml'), ['# c'], key);
    assert.deepEqual(comments(`${ACTIONS}run: &r\n  |\n  # x\n  echo hi\n`, 'yaml'), []);
});

test('YAML：獨自一行的 block scalar 標頭屬於上一行的 key，行首的 --- 之後也可以接 node', () => {
    assert.deepEqual(comments('key:\n  # c\n  |\n  # 不是註解\nnext: 1 # d\n', 'yaml'), ['# c', '# d']);
    assert.deepEqual(comments('key:\n  |\nnext: 1 # d\n', 'yaml'), ['# d']);
    assert.deepEqual(comments(`${ACTIONS}steps:\n- run:\n    |\n    # c\n    echo hi\n`, 'yaml'), ['# c']);
    assert.deepEqual(comments('--- |\n  # 不是註解\n', 'yaml'), []);
    assert.deepEqual(comments("--- 'a # b'\n", 'yaml'), []);
});

test('YAML：block scalar 的開頭空行、+ 保留的結尾空行、比縮排多的空白行和最後的換行都會改變值', () => {
    assert.ok(!unchanged('a: |\n\n  text\n', 'a: |\n  text\n', 'yaml'));
    assert.ok(!unchanged('a: |+\n  text\n\nb: 1\n', 'a: |+\n  text\nb: 1\n', 'yaml'));
    assert.ok(!unchanged('a: |+\n  text\n# c\n\nb: 1\n', 'a: |+\n  text\n\nb: 1\n', 'yaml'));
    assert.ok(!unchanged('a: |+\n\n\nb: 1\n', 'a: |+\n\nb: 1\n', 'yaml'));
    assert.ok(!unchanged('a: |\n  x\n    \n', 'a: |\n  x\n', 'yaml'));
    assert.ok(!unchanged('a: |\n  text\n', 'a: |\n  text', 'yaml'));
    assert.ok(unchanged('a: |\n  text\n\nb: 1\n', 'a: |\n  text\nb: 1\n', 'yaml'));
});

test('YAML：run: | 的縮排由第一行決定，刪掉決定縮排的註解行要擋', () => {
    const run = (body) => `${ACTIONS}run: |\n${body}`;
    assert.ok(!unchanged(run('  # c\n    echo a\\\n    b\n'), run('    echo a\\\n    b\n'), 'yaml'));
    assert.ok(unchanged(run('  # c\n  echo a\n'), run('  echo a\n'), 'yaml'));
});

test('YAML：run: | 裡 here-document 的結尾行比 block 的縮排深時不是結尾', () => {
    assert.deepEqual(comments(`${ACTIONS}run: |\n  cat <<EOF\n  body\n    EOF\n  # 還在內容裡\n  EOF\n`, 'yaml'), []);
});

test('Dockerfile：只有整行的 # 是註解，續行中間的也算，檔頭的 parser directive 不是', () => {
    const src = '# syntax=docker/dockerfile:1\n# c1\nFROM node:24 # 這是參數\n  # c2\nRUN echo a \\\n# c3\n    b\n';
    assert.deepEqual(comments(src, 'dockerfile'), ['# c1', '# c2', '# c3']);
    assert.deepEqual(lines(src, 'dockerfile'), { comment: 3, code: 4 });
    assert.deepEqual(comments('FROM x\n# escape=`\n', 'dockerfile'), ['# escape=`']);
});

test('Dockerfile：here-document 的內容是程式，續行上的 <<EOF、<< EOF 和 escape 改成 ` 的續行都算', () => {
    assert.deepEqual(comments('FROM x\nRUN <<EOF\n# keep\nEOF\n# c\n', 'dockerfile'), ['# c']);
    assert.deepEqual(comments('FROM x\nRUN set -e; \\\n    cat <<EOF > /etc/x.conf\n# keep\nEOF\n# c\n', 'dockerfile'), ['# c']);
    assert.deepEqual(comments('FROM x\nCOPY << EOF /x\n# keep\nEOF\n', 'dockerfile'), []);
    assert.deepEqual(comments('# escape=`\nFROM x\nRUN cat `\n  <<EOF\n# keep\nEOF\n', 'dockerfile'), []);
    assert.deepEqual(comments('FROM x\nONBUILD RUN <<EOF\n# keep\nEOF\n', 'dockerfile'), []);
    assert.deepEqual(comments('FROM x\nRUN <<-EOF\n\t# keep\n\tEOF\n# c\n', 'dockerfile'), ['# c']);
});

test('Dockerfile：續行保留前導空白，\\\\ 結尾不是續行，引號沒有結束的那一行不找 here-document', () => {
    assert.deepEqual(comments('FROM x\nRUN echo <\\\n <EOF\n# c\n', 'dockerfile'), ['# c']);
    assert.deepEqual(comments('FROM x\nENV A=b\\\\\nRUN <<EOF\n# keep\nEOF\n', 'dockerfile'), []);
    assert.deepEqual(comments('FROM x\nRUN cat <<EOF "x\n# c\n', 'dockerfile'), ['# c']);
});

test('Dockerfile：一行整個比對，舊式 ENV 的值和行中間跳脫的空白都算', () => {
    assert.ok(!unchanged('FROM x\nENV GREETING hello world\n', 'FROM x\nENV GREETING hello  world\n', 'dockerfile'));
    assert.ok(!unchanged('FROM x\nRUN cp a\\ b c\n', 'FROM x\nRUN cp a\\  b c\n', 'dockerfile'));
    assert.ok(!unchanged('FROM x\nRUN echo "a \\\n  b"\n', 'FROM x\nRUN echo "a \\\n    b"\n', 'dockerfile'));
    assert.ok(unchanged('FROM x\n# c\nRUN a \\\n  # d\n  b\n', 'FROM x\nRUN a \\\n  b\n', 'dockerfile'));
});

test('.npmrc、.gitignore、robots.txt：只有整行的註解', () => {
    assert.deepEqual(comments('# a\n  ; b\nkey=value # 這裡當程式\n', 'ini'), ['# a', '; b']);
    assert.deepEqual(comments('# a\n  # 前面有空白就是 pattern\nfoo\n', 'ignore'), ['# a']);
    assert.deepEqual(comments('  # a\nUser-agent: * # b\n', 'robots'), ['# a']);
    assert.deepEqual(lines('# a\n# b\nx=1\n', 'ini'), { comment: 2, code: 1 });
});

test('languageOf：依檔名選掃描器，其他檔案不檢查', () => {
    assert.equal(languageOf('scripts/a.mjs'), 'js');
    assert.equal(languageOf('scripts/a.cjs'), 'js');
    assert.equal(languageOf('src/data/clusters.ts'), 'js');
    assert.equal(languageOf('src/pages/index.astro'), 'astro');
    assert.equal(languageOf('.github/workflows/ci.yml'), 'yaml');
    assert.equal(languageOf('deploy/app.yaml'), 'yaml');
    assert.equal(languageOf('ai-gateway/deploy/k3s/Containerfile'), 'dockerfile');
    assert.equal(languageOf('Dockerfile.dev'), 'dockerfile');
    assert.equal(languageOf('deploy/app.dockerfile'), 'dockerfile');
    assert.equal(languageOf('verify.sh'), 'shell');
    assert.equal(languageOf('.npmrc'), 'ini');
    assert.equal(languageOf('.gitignore'), 'ignore');
    assert.equal(languageOf('.dockerignore'), 'ignore');
    assert.equal(languageOf('public/robots.txt'), 'robots');
    assert.equal(languageOf('README.md'), null);
    assert.equal(languageOf('tests/fixtures/puter-ai.html'), null);
    assert.equal(languageOf('public/advanced-resources/competitions.json'), null);
});

test('--code-unchanged 的比對：只改註解要過', () => {
    const before = '// 舊的說明\nconst a = 1; // 行尾\n/* 獨立一行 */\nfoo(a);\n';
    const after = '// 新的說明\n// 行尾的註解搬到上面\nconst a = 1;\nfoo(a); /* 搬到行尾 */\n';
    assert.ok(unchanged(before, after, 'js'));
});

test('--code-unchanged 的比對：改一個字元的程式要擋，並指出位置', () => {
    const diff = firstDifference('const a = 1;\nfoo(a);\n', 'const a = 2;\nfoo(a);\n', 'js');
    assert.equal(diff.before.text, '1');
    assert.equal(diff.after.text, '2');
});

test('--code-unchanged 的比對：刪掉含換行的註解讓兩行併成一行要擋', () => {
    assert.ok(!unchanged('return /* 說明\n */ value;\n', 'return value;\n', 'js'));
    assert.ok(!unchanged('const a = b // 說明\n(c);\n', 'const a = b (c);\n', 'js'));
    assert.ok(unchanged('const a = b // 說明\n(c);\n', 'const a = b\n(c);\n', 'js'));
});

test('--code-unchanged 的比對：前後的 token 不能因為去掉註解而黏在一起，字串裡的空白照原樣比', () => {
    assert.ok(!unchanged('x = a/**/b;\n', 'x = ab;\n', 'js'));
    assert.ok(!unchanged("a = 'x  y';\n", "a = 'x y';\n", 'js'));
    assert.ok(!unchanged('.a/* x */.b {}\n', '.a .b {}\n', 'css'));
    assert.ok(unchanged('.a /* x */ .b {}\n', '.a .b {}\n', 'css'));
});

test('--code-unchanged 的比對：Astro 的 <!-- --> 換成 {/* */} 不算改程式，模板文字改了要擋', () => {
    const before = '<div>\n  <!-- 說明 -->\n  <p>x</p>\n</div>\n';
    assert.ok(unchanged(before, '<div>\n  {/* 說明 */}\n  <p>x</p>\n</div>\n', 'astro'));
    assert.ok(unchanged(before, '<div>\n  <p>x</p>\n</div>\n', 'astro'));
    assert.ok(unchanged('<p>a<!-- c -->{x}</p>\n', '<p>a{x}</p>\n', 'astro'));
    assert.ok(!unchanged(before, '<div>\n  <!-- 說明 -->\n  <p>y</p>\n</div>\n', 'astro'));
});

test('--code-unchanged 的比對：標籤和後面的 JS 之間的空白不屬於任何 token，刪掉緊接著的註解要過', () => {
    const script = '<script is:inline>\n  // 說明\n  run();\n</script>\n';
    assert.ok(unchanged(script, '<script is:inline>\n  run();\n</script>\n', 'astro'));
    const nested = '{ok && <b>x</b>\n  /* 說明 */}\n';
    assert.ok(unchanged(nested, '{ok && <b>x</b>\n}\n', 'astro'));
});

test('--code-unchanged 的比對：YAML 刪掉註解行要過，縮排改了要擋', () => {
    const before = 'a:\n  b: 1 # c\n  # d\n  e: 2\n';
    assert.ok(unchanged(before, 'a:\n  b: 1\n  e: 2\n', 'yaml'));
    assert.ok(!unchanged(before, 'a:\n  b: 1\ne: 2\n', 'yaml'));
});

test('--code-unchanged 的比對：shell 刪掉行尾註解要過，改了引號裡的內容要擋', () => {
    assert.ok(unchanged('echo "a b" # c\n', 'echo "a b"\n', 'shell'));
    assert.ok(!unchanged('echo "a b" # c\n', 'echo "a  b"\n', 'shell'));
});

/** env 是給暫存 repo 用的環境變數：git hook 傳下來的 GIT_DIR 會讓指令落到真正的 repo，npm 的 INIT_CWD 會改變相對路徑的基準。 */
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_') && k !== 'INIT_CWD'));

function tempRepo(files) {
    const dir = mkdtempSync(path.join(tmpdir(), 'check-comments-'));
    const config = ['user.name=test', 'user.email=test@example.invalid', 'commit.gpgsign=false', 'core.hooksPath=/dev/null'];
    const git = (...args) => execFileSync('git', [...config.flatMap((c) => ['-c', c]), ...args], { cwd: dir, env, stdio: 'pipe' }).toString().trim();
    const write = (entries) => {
        for (const [name, text] of Object.entries(entries)) {
            mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
            writeFileSync(path.join(dir, name), text);
        }
    };
    git('init', '-q');
    write(files);
    git('add', '-A');
    git('commit', '-qm', 'init');
    const runEnv = (extra, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: 'utf8' });
    const run = (...args) => runEnv({}, ...args);
    return { dir, git, write, run, runEnv, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('CLI --code-unchanged：只改註解時 exit 0；改到程式、新增檔案時 exit 1 並列出檔名', () => {
    const repo = tempRepo({ 'a.mjs': '// a\nexport const a = 1;\n', 'b.astro': '<p>b</p>\n', 'c.css': 'p { color: red; }\n' });
    try {
        repo.write({ 'a.mjs': '// 改寫過的說明\nexport const a = 1;\n', 'b.astro': '<!-- 說明 -->\n<p>b</p>\n', 'c.css': '/* 說明 */\np { color: red; }\n' });
        let r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /3 個變動的檔案去掉註解之後程式都相同/);

        repo.write({ 'b.astro': '<p>c</p>\n' });
        repo.git('add', 'b.astro');
        r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /b\.astro/);
        assert.doesNotMatch(r.stderr, /a\.mjs/);

        repo.write({ 'b.astro': '<p>b</p>\n', 'c.js': 'x;\n' });
        repo.git('add', 'b.astro');
        r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /c\.js\n\s+新增的檔案/);

        r = repo.run('--code-unchanged', 'HEAD', 'a.mjs');
        assert.equal(r.status, 0, r.stderr);
    } finally {
        repo.done();
    }
});

test('CLI --code-unchanged：刪除檔案、改了分不出註解的檔案、新版掃不開，都要 exit 1', () => {
    const repo = tempRepo({ 'a.mjs': 'export const a = 1;\n', 'b.mjs': 'export const b = 1;\n', 'data.json': '{"a": 1}\n' });
    try {
        rmSync(path.join(repo.dir, 'a.mjs'));
        repo.write({ 'b.mjs': "export const b = 'x;\n", 'data.json': '{"a": 2}\n' });
        const r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /a\.mjs\n\s+檔案被刪除了/);
        assert.match(r.stderr, /b\.mjs\n\s+無法分析（第 1 行）：新版：字串沒有結束/);
        assert.match(r.stderr, /data\.json\n\s+這種檔案分不出註解，內容有變動/);
    } finally {
        repo.done();
    }
});

test('CLI --code-unchanged：內容沒變的改名和改權限也算變動', () => {
    const repo = tempRepo({ 'a.mjs': 'export const a = 1;\n', 'run.sh': 'echo hi\n' });
    try {
        repo.git('mv', 'a.mjs', 'b.mjs');
        let r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /a\.mjs → b\.mjs\n\s+檔案改名了/);

        repo.git('mv', 'b.mjs', 'a.mjs');
        chmodSync(path.join(repo.dir, 'run.sh'), 0o755);
        r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /run\.sh\n\s+檔案權限從 100644 變成 100755/);
        assert.doesNotMatch(r.stderr, /人工核對/);
    } finally {
        repo.done();
    }
});

test('CLI --code-unchanged：只略過內容改了的說明文件，src/、public/ 底下的 Markdown、改名和改權限都要比', () => {
    const repo = tempRepo({ 'README.md': '# a\n', 'public/x.md': '# a\n', 'scripts/a.mjs': 'export const a = 1;\n', 'src/content/x/a.md': '---\ntitle: A\n---\n' });
    try {
        repo.write({ 'README.md': '# b\n' });
        let r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /略過說明文件：README\.md/);

        chmodSync(path.join(repo.dir, 'README.md'), 0o755);
        r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /README\.md\n\s+檔案權限從 100644 變成 100755/);
        chmodSync(path.join(repo.dir, 'README.md'), 0o644);

        repo.write({ 'src/content/x/a.md': '---\ntitle: B\n---\n' });
        r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /src\/content\/x\/a\.md\n\s+這種檔案分不出註解/);

        repo.write({ 'src/content/x/a.md': '---\ntitle: A\n---\n', 'public/x.md': '# b\n' });
        r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stdout, /略過說明文件：README\.md\n/);
        assert.match(r.stderr, /public\/x\.md\n\s+這種檔案分不出註解/);

        repo.write({ 'public/x.md': '# a\n' });
        repo.git('mv', 'scripts/a.mjs', 'scripts/a.md');
        r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /scripts\/a\.mjs → scripts\/a\.md\n\s+檔案改名了/);
    } finally {
        repo.done();
    }
});

test('CLI --code-unchanged：git add 之後沒再改過的檔案照常比對，暫存區的版本和工作區不同時 exit 1', () => {
    const repo = tempRepo({ 'a.mjs': 'export const a = 1;\n' });
    try {
        repo.write({ 'a.mjs': '// 說明\nexport const a = 1;\n' });
        repo.git('add', 'a.mjs');
        let r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /1 個變動的檔案去掉註解之後程式都相同/);

        repo.write({ 'a.mjs': 'export const a = 2;\n' });
        repo.git('add', 'a.mjs');
        repo.write({ 'a.mjs': 'export const a = 1;\n' });
        r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /a\.mjs\n\s+暫存區的版本和工作區不同/);
    } finally {
        repo.done();
    }
});

test('CLI --code-unchanged：只比對 JS、CSS、Astro，其他認得的類型內容有變動就列出來請人工核對，exit 1', () => {
    const others = {
        'run.sh': '# a\necho hi\n',
        'ci.yml': '# a\nname: CI\n',
        Dockerfile: '# a\nFROM node:24\n',
        '.npmrc': '# a\nfund=false\n',
        '.gitignore': '# a\ndist/\n',
        'public/robots.txt': '# a\nUser-agent: *\n',
    };
    const repo = tempRepo({ ...others, 'a.mjs': '// a\nexport const a = 1;\n' });
    try {
        repo.write(Object.fromEntries(Object.entries(others).map(([name, text]) => [name, text.replace('# a', '# b')])));
        let r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /下列檔案有變動，不在比對範圍，請人工核對：\n/);
        for (const entry of ['run.sh（shell）', 'ci.yml（yaml）', 'Dockerfile（dockerfile）', '.npmrc（ini）', '.gitignore（ignore）', 'public/robots.txt（robots）']) {
            assert.ok(r.stderr.includes(`\n  ${entry}\n`), entry);
        }
        assert.doesNotMatch(r.stdout + r.stderr, /程式都相同|沒有變動的程式檔案/);

        repo.write({ 'a.mjs': '// b\nexport const a = 1;\n' });
        r = repo.run('--code-unchanged', 'HEAD', 'a.mjs', 'ci.yml');
        assert.equal(r.status, 1);
        assert.match(r.stdout, /1 個變動的檔案去掉註解之後程式都相同/);
        assert.match(r.stderr, /請人工核對：\n {2}ci\.yml（yaml）\n$/);

        const base = repo.git('rev-parse', 'HEAD');
        repo.git('commit', '-qam', 'comments');
        repo.write({ 'ci.yml': '# c\nname: CI\n' });
        r = repo.run('--code-unchanged', base, 'ci.yml');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /請人工核對：\n {2}ci\.yml（HEAD 裡的版本，yaml）\n {2}ci\.yml（yaml）\n$/);
    } finally {
        repo.done();
    }
});

test('CLI --code-unchanged：分不出來的 JS 寫法回報無法分析，exit 1', () => {
    const repo = tempRepo({ 'a.cjs': 'f();\n--> 舊的說明\nok();\n', 'b.ts': 'export const n = x as Array<number> / 2;\n' });
    try {
        repo.write({ 'a.cjs': 'f();\n--> 新的說明\nok();\n', 'b.ts': '// 說明\nexport const n = x as Array<number> / 2;\n' });
        const r = repo.run('--code-unchanged', 'HEAD');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /a\.cjs\n\s+無法分析（第 2 行）：舊版：分不出 <!-- 或 --> 是不是註解/);
        assert.match(r.stderr, /b\.ts\n\s+無法分析（第 1 行）：舊版：分不出 \/ 是除號還是正規表示式/);
    } finally {
        repo.done();
    }
});

test('CLI --code-unchanged：ref 不是 HEAD 時，HEAD 和工作區不同的檔案兩份都比', () => {
    const repo = tempRepo({ 'a.mjs': '// a\nexport const a = 1;\n' });
    try {
        const base = repo.git('rev-parse', 'HEAD');
        repo.write({ 'a.mjs': '// b\nexport const a = 1;\n' });
        repo.git('commit', '-qam', 'comment');
        repo.write({ 'a.mjs': '// c\nexport const a = 1;\n' });
        let r = repo.run('--code-unchanged', base);
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /1 個變動的檔案去掉註解之後程式都相同/);

        repo.write({ 'a.mjs': 'export const a = 2;\n' });
        repo.git('commit', '-qam', 'code');
        repo.write({ 'a.mjs': '// a\nexport const a = 1;\n' });
        r = repo.run('--code-unchanged', base);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /a\.mjs（HEAD 裡的版本）\n\s+舊版第 2 行/);

        repo.write({ 'a.mjs': 'export const a = 2;\n' });
        r = repo.run('--code-unchanged', base);
        assert.equal(r.status, 1);
        assert.match(r.stderr, /a\.mjs\n/);
        assert.doesNotMatch(r.stderr, /HEAD 裡的版本/);
    } finally {
        repo.done();
    }
});

test('CLI：路徑可以是 repo 根目錄，經 npm run 執行時相對路徑以 INIT_CWD 為準', () => {
    const repo = tempRepo({ 'a.mjs': 'export const a = 1;\n', 'sub/c.mjs': '// 1\n// 2\nexport {};\n' });
    try {
        repo.write({ 'a.mjs': '// 說明\nexport const a = 1;\n' });
        let r = repo.run('--code-unchanged', 'HEAD', '.');
        assert.equal(r.status, 0, r.stderr);
        r = repo.runEnv({ INIT_CWD: path.join(repo.dir, 'sub') }, 'c.mjs');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /sub\/c\.mjs {2}註解 2 行，程式 1 行/);
    } finally {
        repo.done();
    }
});

test('CLI 行數檢查：註解比程式多時 exit 1，--report 不因此失敗，排除清單裡的檔案不算', () => {
    const many = '// 1\n// 2\n// 3\nexport {};\n';
    const repo = tempRepo({ 'a.mjs': many, 'b.min.js': many, 'ok.mjs': '// 1\nexport {};\n', 'sub/c.mjs': many, 'notes.txt': 'x\n' });
    try {
        let r = repo.run();
        assert.equal(r.status, 1);
        assert.match(r.stderr, /a\.mjs {2}註解 3 行，程式 1 行/);
        assert.doesNotMatch(r.stderr, /b\.min\.js|ok\.mjs/);

        r = repo.run('--report');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /a\.mjs {2}← 註解比程式多/);
        assert.match(r.stdout, /略過 b\.min\.js/);
        assert.match(r.stdout, /沒有檢查的檔案：\.txt 1 個/);

        r = repo.run('ok.mjs');
        assert.equal(r.status, 0, r.stderr);

        r = repo.run('sub');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /^1 個檔案.*\n {2}sub\/c\.mjs {2}註解 3 行/);

        r = repo.run('notes.txt');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /沒有可以檢查的檔案/);
    } finally {
        repo.done();
    }
});

test('CLI 行數檢查：給目錄時連還沒 git add 的檔案一起檢查，掃不開的檔案 exit 1', () => {
    const repo = tempRepo({ 'sub/a.mjs': 'export {};\n' });
    try {
        repo.write({ 'sub/new.mjs': '// 1\n// 2\nexport {};\n' });
        let r = repo.run('sub');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /sub\/new\.mjs {2}註解 2 行，程式 1 行/);

        repo.write({ 'sub/new.mjs': "export const a = 'x;\n" });
        r = repo.run('sub');
        assert.equal(r.status, 1);
        assert.match(r.stderr, /無法分析 sub\/new\.mjs:1：字串沒有結束/);
    } finally {
        repo.done();
    }
});

test('CLI 行數檢查：工作區已刪掉或路徑變成檔案的 index 項目、symlink 迴圈、指向目錄的 symlink 和 FIFO 都略過', () => {
    const repo = tempRepo({ 'ok.mjs': 'export {};\n', 'gone.mjs': 'export {};\n', 'a/b.mjs': 'export {};\n', 'd/x.mjs': 'export {};\n' });
    try {
        symlinkSync('loop.mjs', path.join(repo.dir, 'loop.mjs'));
        symlinkSync('d', path.join(repo.dir, 'dir.mjs'));
        repo.git('add', '-A');
        repo.git('commit', '-qm', 'links');
        rmSync(path.join(repo.dir, 'gone.mjs'));
        rmSync(path.join(repo.dir, 'a'), { recursive: true });
        writeFileSync(path.join(repo.dir, 'a'), 'x\n');
        let r = repo.run('--report');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\n2 個檔案，/);
        assert.doesNotMatch(r.stdout, /gone|loop|dir\.mjs|a\/b/);

        if (spawnSync('mkfifo', [path.join(repo.dir, 'p.mjs')]).status === 0) {
            r = spawnSync(process.execPath, [CLI, 'p.mjs'], { cwd: repo.dir, env, encoding: 'utf8', timeout: 10_000 });
            assert.equal(r.error, undefined);
            assert.equal(r.status, 1);
            assert.match(r.stderr, /^沒有可以檢查的檔案。\n$/);
        }
    } finally {
        repo.done();
    }
});
