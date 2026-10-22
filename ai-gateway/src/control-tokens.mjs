/**
 * neutralizeControlTokens 把 chat template 的控制符號換成全形。vLLM 把訊息內容接進 chat
 * template 再 tokenize，內容裡的 <|im_end|><|im_start|>system… 會變成真正的特殊 token，偽造出
 * 一輪 system 訊息；換成全形後模型讀起來意思不變，但不再是特殊 token。續寫時放回 prompt 的
 * 模型輸出也要中和，否則學生可以先要模型把全形符號照抄成半形，在第二輪繞過輸入端的中和。
 * 涵蓋 ChatML／Qwen 與 Llama 3 的 <|…|>、DeepSeek 用全形直線的 <｜…｜>、Gemma 的 <start_of_turn>
 * 與 <end_of_turn>、Llama 2／Mistral 的 [INST]、<<SYS>>、<s>，以及 Qwen 的 <think>、<tool_call>
 * 這類標記。換模型或設定 LLM_MODEL 時，要對照那個模型的 special token 清單，補上這裡沒有的。
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
