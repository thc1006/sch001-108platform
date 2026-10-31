/**
 * 設定解析：每個變數的合法值要確實被採用、打錯的值退回預設並警告；key 與上游網址
 * 錯了一律當成「沒有設定」（不退回正式站），而且警告不印出 key 或帳密。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadLlmConfig, configProblems, EFFORTS, DEFAULT_MAX_TOKENS, MAX_TOKENS_LIMIT, MAX_IDLE_TIMEOUT_MS } from '../src/config.mjs';
import { streamChat } from '../src/upstream.mjs';
import { startFakeUpstream } from './fake-upstream.mjs';

function load(env) {
    const warnings = [];
    const config = loadLlmConfig(env, { warn: (m) => warnings.push(m) });
    return { config, warnings };
}

function withKeyFile(contents, fn) {
    const dir = mkdtempSync(path.join(tmpdir(), 'ai-gateway-config-'));
    try {
        const file = path.join(dir, 'LLM_API_KEY');
        writeFileSync(file, contents);
        return fn(file);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

test('預設值：xhigh、8192、65536 context、3 輪、15 分鐘', () => {
    const { config, warnings } = load({});
    assert.deepEqual(warnings, []);
    assert.deepEqual(config, {
        upstream: 'https://llm.winlab.tw',
        apiKey: '',
        model: 'qwen3.8-27b-fp8',
        reasoningEffort: 'xhigh',
        continuationEffort: 'none',
        maxTokens: 8192,
        contextTokens: 65536,
        maxRounds: 3,
        taskTimeoutMs: 900_000,
        idleTimeoutMs: 180_000,
    });
    assert.equal(DEFAULT_MAX_TOKENS, 8192);
    assert.equal(MAX_TOKENS_LIMIT, 16384);
    assert.equal(MAX_IDLE_TIMEOUT_MS, 300_000);
});

test('每個變數的合法值都確實被採用', () => {
    const { config, warnings } = load({
        LLM_UPSTREAM: 'https://llm.example.edu',
        LLM_API_KEY: 'sk-from-env',
        LLM_MODEL: ' my-model ',
        LLM_REASONING_EFFORT: 'low',
        LLM_CONTINUATION_EFFORT: 'medium',
        LLM_MAX_TOKENS: '4096',
        LLM_CONTEXT_TOKENS: '65536',
        LLM_MAX_ROUNDS: '5',
        LLM_TASK_TIMEOUT_MS: '1200000',
        LLM_IDLE_TIMEOUT_MS: '60000',
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(config, {
        upstream: 'https://llm.example.edu',
        apiKey: 'sk-from-env',
        model: 'my-model',
        reasoningEffort: 'low',
        continuationEffort: 'medium',
        maxTokens: 4096,
        contextTokens: 65536,
        maxRounds: 5,
        taskTimeoutMs: 1_200_000,
        idleTimeoutMs: 60_000,
    });
});

test('空字串視同沒設，不警告', () => {
    const { config, warnings } = load({ LLM_MAX_ROUNDS: '', LLM_REASONING_EFFORT: '', LLM_UPSTREAM: '', LLM_MODEL: '  ' });
    assert.deepEqual(warnings, []);
    assert.equal(config.maxRounds, 3);
    assert.equal(config.reasoningEffort, 'xhigh');
    assert.equal(config.upstream, 'https://llm.winlab.tw');
    assert.equal(config.model, 'qwen3.8-27b-fp8');
});

test('WinLab 只收 none／low／medium／xhigh；不分大小寫；其他值退回預設並警告', () => {
    assert.deepEqual(EFFORTS, ['none', 'low', 'medium', 'xhigh']);
    const { config, warnings } = load({ LLM_REASONING_EFFORT: 'high', LLM_CONTINUATION_EFFORT: 'max' });
    assert.equal(config.reasoningEffort, 'xhigh');
    assert.equal(config.continuationEffort, 'none');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /LLM_REASONING_EFFORT="high"/);
    assert.equal(load({ LLM_REASONING_EFFORT: ' Medium ' }).config.reasoningEffort, 'medium');
});

test('整數的上下界：剛好在界上接受，超出一格就退回預設', () => {
    const cases = [
        ['LLM_MAX_TOKENS', 'maxTokens', 1, 16_384, 8192],
        ['LLM_MAX_ROUNDS', 'maxRounds', 1, 8, 3],
        ['LLM_CONTEXT_TOKENS', 'contextTokens', 4096, 1_048_576, 65536],
        ['LLM_TASK_TIMEOUT_MS', 'taskTimeoutMs', 10_000, 2_147_483_647, 900_000],
        ['LLM_IDLE_TIMEOUT_MS', 'idleTimeoutMs', 1_000, 300_000, 180_000],
    ];
    for (const [name, key, min, max, fallback] of cases) {
        assert.equal(load({ [name]: String(min) }).config[key], min, `${name}=${min}`);
        assert.equal(load({ [name]: String(max) }).config[key], max, `${name}=${max}`);
        for (const bad of [String(min - 1), String(max + 1)]) {
            const { config, warnings } = load({ [name]: bad });
            assert.equal(config[key], fallback, `${name}=${bad}`);
            assert.equal(warnings.length, 1, `${name}=${bad} 應該警告`);
        }
    }
});

test('整數只收十進位：8k、6e5、-1、1.5、全形數字都退回預設', () => {
    for (const raw of ['8k', '6e5', '-1', '1.5', 'abc', '３']) {
        const { config, warnings } = load({ LLM_MAX_ROUNDS: raw });
        assert.equal(config.maxRounds, 3, `LLM_MAX_ROUNDS=${raw}`);
        assert.equal(warnings.length, 1, `LLM_MAX_ROUNDS=${raw} 應該警告`);
    }
    assert.equal(load({ LLM_MAX_ROUNDS: ' 6 ' }).config.maxRounds, 6);
});

test('閒置逾時超過 300 秒沒有意義（undici 預設 300 秒會先截斷），當成不合法', () => {
    const { config, warnings } = load({ LLM_IDLE_TIMEOUT_MS: '400000' });
    assert.equal(config.idleTimeoutMs, 180_000);
    assert.equal(warnings.length, 1);
});

test('警告裡只顯示短而且明顯不是 key 的設定值；其他只說有幾個字元', () => {
    assert.match(load({ LLM_MAX_ROUNDS: '8k' }).warnings[0], /LLM_MAX_ROUNDS="8k"/);
    assert.match(load({ LLM_MAX_TOKENS: ' 6e5 ' }).warnings[0], /LLM_MAX_TOKENS="6e5"/);
    // LiteLLM 的 key 是 sk- 加 22 字元：貼錯變數時，整把 key 都不能出現在 log
    const key = 'sk-AbCdEfGhIjKlMnOpQrStUv';
    for (const [name, value] of [
        ['LLM_MAX_TOKENS', key],
        ['LLM_REASONING_EFFORT', key],
        ['LLM_IDLE_TIMEOUT_MS', `Bearer ${key}`],
        ['LLM_MAX_ROUNDS', 'AbCdEfGhIjKlMnOpQrStUvWx'],
        ['LLM_CONTEXT_TOKENS', 'sk-short'],
    ]) {
        const { warnings } = load({ [name]: value });
        assert.equal(warnings.length, 1, name);
        assert.doesNotMatch(warnings[0], /AbCdEf|short/, name);
        assert.match(warnings[0], new RegExp(`${name}=（${[...value].length} 個字元，內容不顯示）`), name);
    }
});

test('警告顯示設定值的界線：12 字可以、13 字不行；SK- 開頭不分大小寫都不顯示', () => {
    assert.match(load({ LLM_MAX_ROUNDS: 'abcdefghijkl' }).warnings[0], /LLM_MAX_ROUNDS="abcdefghijkl"/);
    assert.match(load({ LLM_MAX_ROUNDS: 'abcdefghijklm' }).warnings[0], /LLM_MAX_ROUNDS=（13 個字元，內容不顯示）/);
    assert.match(load({ LLM_MAX_ROUNDS: 'SK-abc' }).warnings[0], /LLM_MAX_ROUNDS=（6 個字元，內容不顯示）/);
});

test('警告不能被設定值裡的換行拆成好幾行（偽造 log）', () => {
    const { warnings } = load({ LLM_MAX_ROUNDS: '3\n2026-10-21T00:00:00Z error FAKE' });
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /\n|FAKE/);
});

test('只有空白的數值與思考強度設定跟空字串一樣：視同沒設，不警告', () => {
    const { config, warnings } = load({ LLM_MAX_ROUNDS: '   ', LLM_REASONING_EFFORT: '\t' });
    assert.deepEqual(warnings, []);
    assert.equal(config.maxRounds, 3);
    assert.equal(config.reasoningEffort, 'xhigh');
});

test('key 從檔案讀優先，並清掉換行、BOM 與零寬字元（在哪個位置都清）', () => {
    withKeyFile('\uFEFFsk-a\u200Cbc\u200B12\u200D3\u2060\n', (file) => {
        const { config, warnings } = load({ LLM_API_KEY_FILE: file, LLM_API_KEY: 'sk-from-env' });
        assert.equal(config.apiKey, 'sk-abc123');
        assert.deepEqual(warnings, []);
    });
});

test('key 檔中間還有空白或換行（多行、.env 格式）：猜不出哪段是 key，視為沒有設定並警告（不印內容）', () => {
    for (const contents of ['sk-first\nsk-second\n', 'LLM_API_KEY=sk-abc123\nOTHER=1\n', 'sk-abc 123']) {
        withKeyFile(contents, (file) => {
            const { config, warnings } = load({ LLM_API_KEY_FILE: file });
            assert.equal(config.apiKey, '', JSON.stringify(contents));
            assert.equal(warnings.length, 1);
            assert.match(warnings[0], /LLM_API_KEY_FILE 的內容中間有空白或換行/);
            assert.doesNotMatch(warnings[0], /abc|first|second/);
        });
    }
});

test('key 是「名稱=值」或「名稱:值」的一行（.env、YAML 格式，名稱不分大小寫）：視為沒有設定並警告', () => {
    for (const raw of ['LLM_API_KEY=sk-abc123', 'llm_api_key=sk-abc123', 'api_key:sk-abc123']) {
        const { config, warnings } = load({ LLM_API_KEY: raw });
        assert.equal(config.apiKey, '', raw);
        assert.match(warnings[0], /LLM_API_KEY 看起來是「名稱=值」的格式/, raw);
        assert.doesNotMatch(warnings[0], /abc123/, raw);
    }
    // key 本身可以含 =（base64 的補位）：純英數的 base64 key 也不能被誤判成「名稱=值」
    assert.equal(load({ LLM_API_KEY: 'sk-abc123==' }).config.apiKey, 'sk-abc123==');
    assert.equal(load({ LLM_API_KEY: 'dGhpc2lzYXNlY3JldGtleQ==' }).config.apiKey, 'dGhpc2lzYXNlY3JldGtleQ==');
});

test('key 整個包在引號裡（從 .env 或 shell 複製過來）：視為沒有設定並警告（不印內容）', () => {
    for (const raw of ['"sk-abc123"', "'sk-abc123'", '`sk-abc123`']) {
        const { config, warnings } = load({ LLM_API_KEY: raw });
        assert.equal(config.apiKey, '', raw);
        assert.match(warnings[0], /包在引號裡/, raw);
        assert.doesNotMatch(warnings[0], /abc123/, raw);
    }
});

test('key 的警告指向實際讀取的來源（檔案或環境變數）', () => {
    withKeyFile('金鑰sk-abc', (file) => {
        assert.match(load({ LLM_API_KEY_FILE: file, LLM_API_KEY: 'sk-ignored' }).warnings[0], /^LLM_API_KEY_FILE 含有/);
    });
    assert.match(load({ LLM_API_KEY: '金鑰sk-abc' }).warnings[0], /^LLM_API_KEY 含有/);
});

test('key 裡的連字號不會被當成雜訊清掉', () => {
    assert.equal(load({ LLM_API_KEY: 'sk-abc-123' }).config.apiKey, 'sk-abc-123');
});

test('key 檔案讀不到或是空的：key 為空並警告，不退回 LLM_API_KEY', () => {
    const missing = load({ LLM_API_KEY_FILE: '/nonexistent/key', LLM_API_KEY: 'sk-ignored' });
    assert.equal(missing.config.apiKey, '');
    assert.match(missing.warnings[0], /ENOENT/);
    withKeyFile(' \n', (file) => {
        const empty = load({ LLM_API_KEY_FILE: file, LLM_API_KEY: 'sk-ignored' });
        assert.equal(empty.config.apiKey, '');
        assert.match(empty.warnings[0], /是空的/);
    });
});

test('key 清掉空白與看不見的字元後什麼都不剩：警告並視為沒有設定', () => {
    withKeyFile('\u200B\n', (file) => {
        const { config, warnings } = load({ LLM_API_KEY_FILE: file });
        assert.equal(config.apiKey, '');
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /只有空白或看不見的字元/);
    });
    const { config, warnings } = load({ LLM_API_KEY: '   ' });
    assert.equal(config.apiKey, '');
    assert.equal(warnings.length, 1);
});

test('key 含不可見或非 ASCII 字元（例如存成 UTF-16）：視為沒有設定，警告不印出 key', () => {
    const utf16 = Buffer.from('sk-secretvalue', 'utf16le');
    withKeyFile(utf16, (file) => {
        const { config, warnings } = load({ LLM_API_KEY_FILE: file });
        assert.equal(config.apiKey, '');
        assert.equal(warnings.length, 1);
        assert.doesNotMatch(warnings[0], /secret/);
    });
    for (const bad of ['金鑰：sk-abc', 'sk-abc\u0000']) {
        const { config, warnings } = load({ LLM_API_KEY: bad });
        assert.equal(config.apiKey, '', JSON.stringify(bad));
        assert.doesNotMatch(warnings[0], /abc/);
    }
});

test('LLM_UPSTREAM 只取 origin；路徑、參數或 # 片段會被忽略並警告', () => {
    for (const raw of ['https://llm.example.edu/v1?x=1', 'https://llm.example.edu/?model=x', 'https://llm.example.edu/#frag', 'https://llm.example.edu/v1']) {
        const { config, warnings } = load({ LLM_UPSTREAM: raw });
        assert.equal(config.upstream, 'https://llm.example.edu', raw);
        assert.equal(warnings.length, 1, raw);
        assert.match(warnings[0], /只取 origin/, raw);
    }
    const plain = load({ LLM_UPSTREAM: 'https://llm.example.edu:8443/' });
    assert.equal(plain.config.upstream, 'https://llm.example.edu:8443');
    assert.deepEqual(plain.warnings, []);
});

test('LLM_UPSTREAM 只有空白跟沒設一樣（用預設、不警告）；前後的空白不影響解析', () => {
    const cases = [
        ['   ', 'https://llm.winlab.tw'],
        [' https://llm.example.edu ', 'https://llm.example.edu'],
        // 從文件複製過來常夾帶的全形空白、NBSP、BOM
        ['\uFEFFhttps://llm.example.edu\u3000', 'https://llm.example.edu'],
        ['https://llm.example.edu\u00A0', 'https://llm.example.edu'],
    ];
    for (const [raw, expected] of cases) {
        const { config, warnings } = load({ LLM_UPSTREAM: raw });
        assert.equal(config.upstream, expected, JSON.stringify(raw));
        assert.deepEqual(warnings, [], JSON.stringify(raw));
    }
});

test('LLM_UPSTREAM 不合法時不退回正式站（上游設成 null，閘道會回報未就緒）', () => {
    for (const raw of ['not a url', 'ftp://llm.example.edu', 'http://llm.example.edu']) {
        const { config, warnings } = load({ LLM_UPSTREAM: raw });
        assert.equal(config.upstream, null, raw);
        assert.equal(warnings.length, 1, raw);
    }
});

test('LLM_UPSTREAM 的 http 只允許本機（key 不能走明文）', () => {
    for (const ok of ['http://127.0.0.1:8080', 'http://localhost:3000', 'http://[::1]:9000']) {
        const { config, warnings } = load({ LLM_UPSTREAM: ok });
        assert.equal(config.upstream, new URL(ok).origin, ok);
        assert.deepEqual(warnings, [], ok);
    }
});

test('LLM_UPSTREAM 含帳密（或只有帳號）：拒絕，警告不印出帳密', () => {
    const { config, warnings } = load({ LLM_UPSTREAM: 'https://admin:s3cret@llm.example.edu/v1' });
    assert.equal(config.upstream, null);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /s3cret|admin/);
    const userOnly = load({ LLM_UPSTREAM: 'https://admin@llm.example.edu' });
    assert.equal(userOnly.config.upstream, null);
    assert.doesNotMatch(userOnly.warnings[0], /admin/);
});

test('LLM_UPSTREAM 的「本機」要完全比對：127 開頭的公開網域不算本機，key 不能明文送過去', () => {
    for (const raw of ['http://127.0.0.1.nip.io:8080', 'http://127.foo.bar.com', 'http://localhost.example.com', 'http://127.0.0.1x', 'http://127.../v1']) {
        assert.equal(load({ LLM_UPSTREAM: raw }).config.upstream, null, raw);
    }
});

test('configProblems：缺 key、上游網址不合法都要列出；設定齊全時是空的', () => {
    assert.deepEqual(configProblems(load({ LLM_API_KEY: 'sk-x' }).config), []);
    assert.deepEqual(configProblems(load({}).config), ['missing-api-key']);
    assert.deepEqual(configProblems(load({ LLM_API_KEY: 'sk-x', LLM_UPSTREAM: 'not a url' }).config), ['invalid-upstream']);
    assert.deepEqual(configProblems(load({ LLM_UPSTREAM: 'http://llm.example.edu' }).config), ['missing-api-key', 'invalid-upstream']);
});

test('解析出來的設定真的被用在請求上：origin、Bearer key、model 都對', async () => {
    const up = await startFakeUpstream([{ content: ['ok'] }]);
    try {
        const { config } = load({ LLM_UPSTREAM: up.origin, LLM_API_KEY: 'sk-integration', LLM_MODEL: 'custom-model' });
        await streamChat(config, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 16, reasoningEffort: 'none' });
        assert.equal(up.requests.length, 1);
        assert.equal(up.requests[0].headers.authorization, 'Bearer sk-integration');
        assert.equal(up.requests[0].body.model, 'custom-model');
    } finally {
        await up.close();
    }
});

test('上游設定不合法時，請求在送出前就以 misconfigured 失敗', async () => {
    const { config } = load({ LLM_UPSTREAM: 'http://llm.example.edu', LLM_API_KEY: 'sk-x' });
    await assert.rejects(
        streamChat(config, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 16, reasoningEffort: 'none' }),
        { code: 'misconfigured' },
    );
});
