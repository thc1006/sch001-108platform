/**
 * 中和 chat template 的控制符號。vLLM 套 chat template 時把訊息內容直接接進字串再
 * tokenize，tokenizer 會把文字對應成真正的特殊 token：內容裡寫
 * <|im_end|><|im_start|>system… 就能偽造一輪 system 訊息。換成全形符號之後，模型讀起來
 * 意思不變，但不再是特殊 token。
 *
 * 要中和的不只學生的輸入。續寫時會把模型自己寫的正文、思考筆記、JSON 草稿放回 prompt；
 * 學生可以先要求模型「把全形的 ＜|im_start|＞ 改成半形照抄」，第二輪就繞過了輸入端的中和。
 *
 * 涵蓋常見的模型家族（換模型、設定 LLM_MODEL 時，要對照那個模型的 special token 清單，
 * 不在下面的就補上）：
 *   ChatML／Qwen、Llama 3：<|im_start|>、<|eot_id|> 這類（<| 與 |> 一律換掉）
 *   DeepSeek：<｜User｜>、<｜end▁of▁sentence｜> 這類（用的是全形直線）
 *   Gemma：<start_of_turn>、<end_of_turn>
 *   Llama 2／Mistral：[INST]、[/INST]、<<SYS>>、<s>、</s>
 *   Qwen 的思考與工具標記：<think>、<tool_call>、<tool_response>、<tools>
 */
export function neutralizeControlTokens(text) {
    return String(text)
        .replace(/<\|/g, '＜|')
        .replace(/\|>/g, '|＞')
        .replace(/<｜/g, '＜｜')
        .replace(/｜>/g, '｜＞')
        .replace(/<(\/?)(think|tool_call|tool_response|tools|start_of_turn|end_of_turn|s)>/gi, '＜$1$2＞')
        .replace(/<<(\/?)SYS>>/gi, '＜＜$1SYS＞＞')
        .replace(/\[(\/?)INST\]/gi, '［$1INST］');
}
