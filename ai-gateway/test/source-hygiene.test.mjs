/**
 * 閘道原始碼的衛生檢查：
 *   1. 不能有看不見的字元（零寬字元、雙向控制字元、各種特殊空白、C0／C1 控制字元等）
 *   2. package.json 的 test:ai-gateway 明列的測試檔要剛好等於 ai-gateway/test/ 底下的測試檔
 *   3. test:ai-gateway 不能加 --test-force-exit
 *
 * 為什麼要專門測第 1 點：這類字元寫在正規表示式或字串裡時畫面上完全看不出來，被編輯器
 * 或工具正規化掉也不會有人發現。這個 repo 吃過一次虧（audit-quote-freshness 的 norm()
 * 字元類被正規化成涵蓋全部 ASCII，97 條引文全部印「命中」），所以一律寫成 \uXXXX 跳脫序列。
 *
 * 第 2 點：新增測試檔時可能忘了加進清單，CI 照樣綠燈而新測試從沒跑過。這裡把兩邊對起來。
 * node --test 會略過清單裡找不到的檔案，這支檔案被移出清單時，這道比對也跟著消失，所以
 * .github/workflows/ci.yml 的 gateway job 另外不經清單直接執行它；檔案被刪或改名時
 * node --test 找不到它，以 1 結束。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO = path.resolve(ROOT, '..');

// 看不見或會擾亂顯示的字元：控制字元（Cc，保留 \t \n \r）、格式字元（Cf：零寬、雙向控制、BOM、
// tag 字元…）、預設可忽略的字元（異體字選擇符、韓文填充字、軟連字號、蒙古文母音分隔符…）、
// 特殊空白（Zs，例如 NBSP 與各種寬度的空白；一般空白與全形空白除外）、行段分隔符（Zl、Zp）。
// 用 Unicode 屬性與跳脫序列寫：這一行全是 ASCII，不可能被寫進看不見的字元；Unicode 版本更新時
// 新增的格式字元也一併涵蓋
const INVISIBLE = /(?![\t\n\r \u3000])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zs}\p{Zl}\p{Zp}]/u;
const firstInvisible = (text) => INVISIBLE.exec(text)?.[0];

function sourceFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.(?:[cm]?[jt]s|json|ya?ml|sh|md)$/.test(entry.name) || entry.name === 'Containerfile' ? [full] : [];
    });
}

test('ai-gateway 底下的原始碼沒有看不見的字元', () => {
    const files = sourceFiles(ROOT);
    assert.ok(files.length >= 5, `只找到 ${files.length} 個檔案，路徑可能錯了`);
    const offenders = [];
    for (const file of files) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            const found = firstInvisible(line);
            if (found) {
                const code = found.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
                offenders.push(`${path.relative(ROOT, file)}:${i + 1} 含 U+${code}`);
            }
        });
    }
    assert.deepEqual(offenders, [], '請改寫成 \\uXXXX 跳脫序列');
});

test('偵測本身有效：每一類字元都會被抓到；一般的文字不會', () => {
    const codePoints = [
        0x00, 0x07, 0x0b, 0x7f, 0x85, 0xa0, 0xad, 0x034f, 0x0600, 0x061c, 0x06dd, 0x070f, 0x115f, 0x1680, 0x17b4,
        0x180b, 0x180e, 0x2002, 0x200a, 0x200b, 0x200d, 0x2028, 0x2029, 0x202e, 0x2060, 0x2066, 0x3164, 0xfe0f,
        0xfeff, 0xffa0, 0xfff0, 0x110bd, 0x13430, 0x1bca0, 0x1d173, 0xe0041, 0xe0100, 0xe0fff,
    ];
    for (const cp of codePoints) {
        assert.ok(firstInvisible(`a${String.fromCodePoint(cp)}b`), `U+${cp.toString(16)} 沒被抓到`);
    }
    for (const ok of ['\t', '\n', '\r', ' ', '\u3000', '中文', '「」', '😀', '\u00E9', 'e\u0301']) {
        assert.equal(firstInvisible(ok), undefined, `${JSON.stringify(ok)} 不該被抓`);
    }
});

// test/ 底下不是測試、由測試 import 的輔助檔
const HELPERS = new Set(['fake-upstream.mjs']);

function scriptFiles(dir, prefix = '') {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return scriptFiles(path.join(dir, entry.name), rel);
        // Node 24 的 node --test 也會執行 TypeScript（.ts、.mts、.cts）
        return /\.[cm]?[jt]s$/.test(entry.name) ? [rel] : [];
    });
}

// 應該被執行的測試檔：測試目錄底下所有的 JS／TS 檔（含子目錄、任何命名），扣掉輔助檔
function expectedTestFiles(dir) {
    return scriptFiles(dir).filter((rel) => !HELPERS.has(rel)).map((rel) => `ai-gateway/test/${rel}`).sort();
}

test('test:ai-gateway 明列的測試檔，剛好等於 ai-gateway/test 底下扣掉輔助檔的所有 JS／TS 檔', () => {
    const script = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts['test:ai-gateway'];
    const listed = script.split(/\s+/).filter((arg) => arg.startsWith('ai-gateway/test/')).sort();
    const actual = expectedTestFiles(path.join(ROOT, 'test'));
    assert.ok(actual.length >= 3, `只找到 ${actual.length} 個測試檔`);
    assert.deepEqual(listed, actual, '新增或刪除測試檔時要同步更新 package.json 的 test:ai-gateway');
});

// --test-force-exit 讓每個測試檔的子程序跑完就 process.exit()。POSIX 上寫進 pipe 是非同步的，還沒送到
// 主程序的結果會被丟掉：負載高時少回報幾個測試，結束碼卻是 0（2026-10-22 以 Node 24.21.0 實測）
test('test:ai-gateway 不加 --test-force-exit，少回報的測試不會變成綠燈', () => {
    const script = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts['test:ai-gateway'];
    assert.doesNotMatch(script, /--test-force-exit\b/);
});

test('守衛本身有效：放在子目錄、副檔名 .test.js 或 .ts／.mts、命名 .spec.mjs 的檔案都算進應該執行的測試', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-gateway-guard-'));
    try {
        mkdirSync(path.join(dir, 'sse'));
        for (const file of ['a.test.mjs', 'sse/b.test.mjs', 'c.test.js', 'd.spec.mjs', 'e.test.ts', 'f.test.mts', 'fake-upstream.mjs', 'notes.md']) {
            writeFileSync(path.join(dir, file), '');
        }
        assert.deepEqual(expectedTestFiles(dir), [
            'ai-gateway/test/a.test.mjs',
            'ai-gateway/test/c.test.js',
            'ai-gateway/test/d.spec.mjs',
            'ai-gateway/test/e.test.ts',
            'ai-gateway/test/f.test.mts',
            'ai-gateway/test/sse/b.test.mjs',
        ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
