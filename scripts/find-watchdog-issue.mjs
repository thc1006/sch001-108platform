#!/usr/bin/env node
/**
 * 讀 stdin 的 `gh issue list --json number,author,body` 輸出，決定要接管哪個 issue。
 *
 * 輸出（stdout，供 workflow 取用）：
 *   create          沒有可接管的 issue，應新開
 *   comment <n>     接管 #n
 *
 * 找到多於一個 canonical issue 時以 exit 2 失敗並列出全部——安靜地挑第一個會讓
 * 另一個 issue 永遠收不到報告。
 */
import { selectCanonicalIssue } from './watchdog-issue.lib.mjs';

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString('utf8').trim();

let issues;
try {
    issues = JSON.parse(raw || '[]');
} catch (err) {
    console.error(`無法解析 gh issue list 的輸出：${err.message}`);
    process.exit(1);
}

const decision = selectCanonicalIssue(issues);
if (decision.action === 'fail') {
    console.error(
        `找到 ${decision.numbers.length} 個看門狗 issue：${decision.numbers.map((n) => `#${n}`).join('、')}\n` +
            '同時存在多個代表先前發生過競態，或有人把機器標記複製到別的 issue。\n' +
            '請把多餘的關掉、只留一個，再重跑本 workflow。',
    );
    process.exit(2);
}
console.log(decision.action === 'comment' ? `comment ${decision.number}` : 'create');
