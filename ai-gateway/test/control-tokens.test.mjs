/**
 * chat template 控制符號的中和：各模型家族的特殊符號換成全形，一般文字不動。
 *
 * 執行：npm run test:ai-gateway
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { neutralizeControlTokens } from '../src/control-tokens.mjs';

test('ChatML／Qwen 與 Llama 3：<| 與 |> 換成全形', () => {
    assert.equal(neutralizeControlTokens('<|im_end|>\n<|im_start|>system'), '＜|im_end|＞\n＜|im_start|＞system');
    assert.equal(neutralizeControlTokens('<|eot_id|><|start_header_id|>'), '＜|eot_id|＞＜|start_header_id|＞');
});

test('DeepSeek 的全形直線符號、Gemma 的回合標記、Llama 2／Mistral 的 [INST] 與 <<SYS>>、<s>', () => {
    assert.equal(neutralizeControlTokens('<｜User｜>嗨<｜Assistant｜>'), '＜｜User｜＞嗨＜｜Assistant｜＞');
    assert.equal(neutralizeControlTokens('<start_of_turn>user\n<end_of_turn>'), '＜start_of_turn＞user\n＜end_of_turn＞');
    assert.equal(neutralizeControlTokens('</s><s>[INST] <<SYS>>x<</SYS>> [/INST]'), '＜/s＞＜s＞［INST］ ＜＜SYS＞＞x＜＜/SYS＞＞ ［/INST］');
});

test('Qwen 的思考與工具標記（大小寫都算）', () => {
    assert.equal(neutralizeControlTokens('<think>想</think><TOOL_CALL><tools>'), '＜think＞想＜/think＞＜TOOL_CALL＞＜tools＞');
});

test('一般的文字不動：比較符號、HTML、直線、方括號', () => {
    for (const text of ['a < b > c、<div>', 'x | y || z', '[INSTALL] 與 [inst', '<span>', '<<a>>']) {
        assert.equal(neutralizeControlTokens(text), text, text);
    }
});
