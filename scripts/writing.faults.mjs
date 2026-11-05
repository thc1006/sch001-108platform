#!/usr/bin/env node
// check:writing 的故障注入，一次改一處，確認該紅的會紅：
//   A. 串接：在 dist 副本注入命中、改壞放行清單與基準，check-writing.mjs 必須以 1 結束；乾淨的副本、下修基準、
//      ref 存在的 --verify 與 --annotate 要以 0 結束。有些案例另外檢查報表、下修後的基準或輸出。
//   B. 判斷：改壞 writing.lib.mjs，writing.test.mjs 必須失敗
//   C. 串接程式：改壞 check-writing.mjs，A 段至少一項不符
// A、C 段各自在 .writing-faultcheck/w<N>/ 的 dist、基準、放行清單與報表副本上跑，四個一起跑；版控裡的檔案不會
// 被改到。需要先建置。
//
// 執行：  npm run test:writing-faults
import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const WORK = path.join(ROOT, '.writing-faultcheck');
const WORKERS = 4;
const original = readFileSync(path.join(ROOT, 'scripts/writing.lib.mjs'), 'utf8');

// [說明, 原文, 改成]。原文必須在 writing.lib.mjs 裡恰好出現一次。
const mutations = [
    ['kind 多收一種', "new Set(['quote', 'name', 'counterexample'])", "new Set(['quote', 'name', 'counterexample', 'other'])"],
    ['quote、name 不必有 source', "if ((e.kind === 'quote' || e.kind === 'name') &&", 'if (false &&'],
    ['source 不必有網域', '/^https?:\\/\\/[^\\s/.]+(\\.[^\\s/.]+)+(\\/\\S*)?$/', '/^https?:\\/\\//'],
    ['reason 門檻降低', 'charCount(e.reason) < 10', 'charCount(e.reason) < 2'],
    ['reason 的標點與零寬字元也算字數', '/[\\s\\p{P}\\p{S}\\u200B-\\u200D\\u2060\\uFEFF]/gu', '/\\s/gu'],
    ['rule 不必存在', 'if (!ruleIds.has(e.rule))', 'if (false)'],
    ['file 和 page 不檢查', "if (target.length !== 1 || typeof target[0] !== 'string')", 'if (false)'],
    ['file 是數字也收', " || typeof target[0] !== 'string')", ')'],
    ['text 只有空白也收', "!e.text.trim()) errors.push('缺 text')", "!e.text) errors.push('缺 text')"],
    ['重複的條目不報', "if (seen.has(key)) errors.push('和前面的條目重複')", "if (false) errors.push('和前面的條目重複')"],
    ['text 不必有', "if (typeof e.text !== 'string' || !e.text.trim())", 'if (false)'],
    ['recheckAfter 不驗日期', 'if (!d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3])', 'if (!d)'],
    ['recheckAfter 過期不警告', 'else if (today > e.recheckAfter)', 'else if (false)'],
    ['片段出現幾次都算一次', 'b.text.split(entry.text).length - 1', 'Math.min(1, b.text.split(entry.text).length - 1)'],
    ['片段外的命中也放行', 'at + len <= p + entry.text.length', 'true'],
    ['談詞語的前導詞放寬成單字「如」', '(把|像是|例如|比如|諸如|', '(如|把|像是|例如|比如|諸如|'],
    ['談詞語的前導詞少了別寫、叫', '|說法|別寫|不要寫|避免|名為|叫)', '|說法)'],
    ['談詞語的前導詞少了「用」', "|| (/用\\s*$/u.test(pre) &&", '|| (false &&'],
    ['「用「——」」也算談詞語', ' && /\\p{Script=Han}/u.test(text.slice(index, index + len)))', ')'],
    ['談詞語的後接詞少了句型', '|之類|的句型|句型|的寫法|這個寫法)', '|之類)'],
    ['引號裡有其他字也算在談詞語', 'if (/\\p{Script=Han}/u.test(text.slice(open + 1, index) + text.slice(index + len, close))) return false;', ''],
    ['不往前找相連的引號', 'text.slice(0, a).match(/「[^「」]{1,12}」[、\\s]?$/)', 'text.slice(0, a).match(/^\\uFFFF$/)'],
    ['不往後找相連的引號', 'text.slice(b).match(/^[、\\s]?「[^「」]{1,12}」/)', 'text.slice(b).match(/^\\uFFFF$/)'],
    ['原文後面不接受冒號', '/(逐字|原文)\\s*[：:]?\\s*$/u', '/(逐字|原文)\\s*$/u'],
    ['連續引號不算引文', '|| chained;', ';'],
    ['外文引文照查', "else if (isForeignQuote(text.slice(open + 1, i))) mark(open, i + 1, 'f');", ''],
    ['外文引文對每條規則都略過', "mark(open, i + 1, 'f');", "mark(open, i + 1, 'q');"],
    ['P01 不略過外文引文', "{ id: 'P01-double-dash', severity: 'block', skip: 'afqu',", "{ id: 'P01-double-dash', severity: 'block', skip: 'aqu',"],
    ['P02 不略過外文引文', "id: 'P02-single-dash', severity: 'block', skip: 'afqu',", "id: 'P02-single-dash', severity: 'block', skip: 'aqu',"],
    ['P11 不略過外文引文', "id: 'P11-ellipsis', severity: 'warn', skip: 'fqu',", "id: 'P11-ellipsis', severity: 'warn', skip: 'qu',"],
    ['有中文的引文也當外文', " && !/[\\u3001-\\u9fff\\uff00-\\uffef]/u.test(q)", ''],
    ['沒有英文字母的引文也當外文', "/[A-Za-z]/.test(q) && ", ''],
    ['外文引文帶起連續引號', 'if (attributed) lastQuoted = i + 1;', 'lastQuoted = i + 1;'],
    ['書名不算引文', '/《[^《》]*》|〈[^〈〉]*〉/gu', '/《\\uFFFF》/gu'],
    ['站外連結文字照查', "ext ? 'a' : quote ? 'q'", "ext ? ' ' : quote ? 'q'"],
    ['blockquote 一律當引文', "(name === 'blockquote' && (", "(name === 'blockquote' || ("],
    ['佔位符元素照查', "if (/^\\s*[—–\\-…]\\s*$/.test(el.text())", "if (false && /^\\s*[—–\\-…]\\s*$/.test(el.text())"],
    ['和內文重複的屬性照算', ' || mainText.includes(key)) return;', ') return;'],
    ['_ 開頭的鍵照看', "!k.startsWith('_')", 'true'],
    ['tips 的 title 當成專有名稱', "!(key === 'title' && ptr.includes('/tips/'))", 'true'],
    ['引號層次不輪流', "stack.length % 2 === 0 ? '「' : '『'", "'「'"],
    ['開合不同種不報', "if ((open === '「') !== (c === '」'))", 'if (false)'],
    ['模板的 ${…} 不留佔位符', 'text += PH;', "text += '';"],
    ['巢狀模板不取出', 'onNested?.(r.text, j);', ';'],
    ['屬性抽取連 data-* 也收', '(?<![\\w-])(?:alt|title|aria-label|placeholder)', '(?:alt|title|aria-label|placeholder)'],
    ['不收沒加引號的屬性', "|'([^']*)'|([^\\s\"'>=`]+))/g", "|'([^']*)')/g"],
    ['不認正規式字面值', "if (c === '/' && /(^|[=(:[!&|?{};,+\\-*%<>~^]|\\breturn|\\btypeof)\\s*$/", "if (false && /(^|[=(:[!&|?{};,+\\-*%<>~^]|\\breturn|\\btypeof)\\s*$/"],
    ['console 的引數照收', 'if (skipRanges.some(([a, b]) => start >= a && start <= b)) return;', ''],
    ['傳給 RegExp 的字串照收', '(new RegExp|', '(new RegExpX|'],
    ['模板兩側的 em dash 當英文', '!b.includes(PH) && !a.includes(PH)', 'true'],
    ['步驟鏈兩段就算', 'parts.length >= 3 &&', ''],
    ['彎引號不看佔位符', '(?=${HAN}|${PH})', '(?=${HAN})'],
    ['長句連引號裡的字也算', 'quoted.has(m.index + k) || ', ''],
    ['W01「很多餘」也算', '(?!(?:[餘變產汁疑嘴情]|才多藝|愁善感|[采彩]多姿)(?:的|[^\\p{Script=Han}]|$))', ''],
    ['W01「很多愁善感」「很多采多姿」也算', '|愁善感|[采彩]多姿)', ')'],
    ['W01「很多疑問」也放行', '(?:的|[^\\p{Script=Han}]|$))/gu', ')/gu'],
    ['W04 少了總結類的填充詞', '|總的來說|整體而言|整體來說|總體而言|綜合而言|總結來說(?!明)|總結而言|一言以蔽之|毋庸置疑|無庸置疑|換言之|不言可喻/gu', '/gu'],
    ['W04「說到底線」也算', '說到底(?!線)', '說到底'],
    ['W04「加總之後」也算', '(?<![加彙匯])總之', '總之'],
    ['W04「總結來說明」也算', '總結來說(?!明)', '總結來說'],
    ['W04 少了「無庸置疑」', '|毋庸置疑|無庸置疑|', '|毋庸置疑|'],
    ['W04 少了「換言之」', '|換言之|不言可喻/gu', '|不言可喻/gu'],
    ['W05 少了「由此可見」這類', '|顯而易見|由此可見|不難看出|不難發現|不可否認|無可否認|綜合來看/gu', '/gu'],
    ['W06 少了行銷詞', '|(?<![第再頭這那每上下前同])一次(?:搞懂|看懂)|全攻略|大揭密|小撇步|超實用/gu', '/gu'],
    ['W06「真心話大冒險」也算', '真心話(?!大冒險)', '真心話'],
    ['W06「第一次看懂」也算', '(?<![第再頭這那每上下前同])一次(?:搞懂|看懂)', '一次(?:搞懂|看懂)'],
    ['W06「這一次看懂」「每一次看懂」也算', '(?<![第再頭這那每上下前同])一次', '(?<![第再頭])一次'],
    ['W06「不是一次看懂」也算', "{0,6}$/.test(before(m, 8)) ? '否定'", "{0,6}$/.test(before(m, 8)) ? null"],
    ['W06 否定詞後面隔多遠都算', '[^，。！？、；：]{0,6}$/.test(before(m, 8))', '.*$/.test(before(m, 8))'],
    ['W07 少了行銷詞', '|革命性(?!質)|顛覆(?:性|你)|量身(?:打造|訂做|定做|訂製|定製)|一次掌握|事半功倍|如虎添翼|一臂之力|接住(?:你|您|情緒)/gu', '/gu'],
    ['W07 少了字面上常用的行銷詞', '|無縫|助力|解碼|潛規則|的藝術|神器|乾貨|精髓|不可或缺|秘訣|祕訣|', '|'],
    ['W07「革命性質」也算', '革命性(?!質)', '革命性'],
    ['拿掉 W13', "id: 'W13-era-opener', severity: 'warn', skip: 'aqu', re: ERA_OPENER,", "id: 'W13-era-opener', severity: 'warn', skip: 'aqu', re: ERA_OPENER, custom: () => [],"],
    ['W13 改回 block', "id: 'W13-era-opener', severity: 'warn',", "id: 'W13-era-opener', severity: 'block',"],
    ['W13 同一句有數字也算', "/\\d/.test(m.input.slice(0, m.index).match(/[^。！？；]*$/)[0]", "/\\uFFFF/.test(m.input.slice(0, m.index).match(/[^。！？；]*$/)[0]"],
    ['W13「網路時代來臨之前」也算', '|的|來臨|以前|之前|成長|長大))', '|的))'],
    ['W13「科技業」也算主題', '${ERA_TOPIC}(?![業系部界])', '${ERA_TOPIC}'],
    ['W13「隨著經濟發展」也算', '(?:時代|社會|${ERA_TOPIC})\\\\s*(?:技術', '(?:時代|社會|經濟|${ERA_TOPIC})\\\\s*(?:技術'],
    ['W13 歷史敘述也擋', "(?:這個)?\\\\s*(?:${ERA_TOPIC}(?![業系部界])[^。，！？的\\\\s]{0,6}|${ERA_CHANGE})", "(?:這個)?\\\\s*(?:[^。，！？]{0,6}|${ERA_CHANGE})"],
    ['W13 刊名與「時代下的」也擋', "(?!\\\\s*(?:雜誌|劇|背景|下的|中的|的|來臨|以前|之前|成長|長大))", "(?!\\\\s*(?:來臨|以前|之前|成長|長大))"],
    ['W13「刊在」也算', '(?<![刊登載紹於])在', '在'],
    ['W13 少了「身處」', '(?:身處|處在|處於|生活在|', '(?:處在|處於|生活在|'],
    ['W13 少了「在當今 X 的社會」', "'在(?:當今|現今|如今)(?:這個)?[^。，！？]{0,8}的(?:社會|世界)(?![學史各觀地組福])',", ''],
    ['W13「社會組」也算', '(?:社會|世界)(?![學史各觀地組福])', '(?:社會|世界)'],
    ['W13 少了「二十一世紀的今天」', "'在\\\\s*(?:二十一|21)\\\\s*世紀的今天',", ''],
    ['W13「伴隨著」也算', '`(?<!伴)隨著', '`隨著'],
    ['W13「隨著」後面不必緊接主題', '(?:時代|社會|${ERA_TOPIC})\\\\s*(?:技術|科技|應用)?\\\\s*的?', '[^。，！？]{0,12}(?:時代|社會|${ERA_TOPIC})\\\\s*(?:技術|科技|應用)?\\\\s*的?'],
    ['W13 少了「X 等」', '(?:[^。，！？]{1,12}等\\\\s*)?', ''],
    ['W13「發展出」也算', '(?![出率])', ''],
    ['W13 少了「當今時代」', "'(?:當今|現今)(?:社會|時代)(?![學史各觀地組福問議])',", ''],
    ['W13「當今社會問題」也算', '(?![學史各觀地組福問議])', ''],
    ['W13 少了「日新月異」', "'日新月異|瞬息萬變',", "'瞬息萬變',"],
    ['拿掉 W14', "{ id: 'W14-significance', severity: 'block',", "{ id: 'W14-significance', severity: 'block', custom: () => [],"],
    ['W14「奠定基礎」不必有形容詞', '(?:奠定|打下)(?:了)?(?:堅實|良好|穩固|紮實|扎實)(?:的)?基礎', '(?:奠定|打下)(?:了)?(?:堅實|良好|穩固|紮實|扎實)?(?:的)?基礎'],
    ['W14 少了「相當重要的意義」', '(?:非常|十分|極為|極其|相當)?(?:重要', '(?:非常|十分|極為)?(?:重要'],
    ['W14 少了「意義非凡」', '意義(?:重大|深遠|非凡)', '意義(?:重大|深遠)'],
    ['W14 少了「前景可期」', '|未來可期|前景可期|', '|未來可期|'],
    ['W14「新的一頁」也擋', '(?:的)?篇章|未來可期', '(?:的)?(?:篇章|一頁)|未來可期'],
    ['拿掉 W17', "{ id: 'W17-weighty-phrase', severity: 'warn',", "{ id: 'W17-weighty-phrase', severity: 'warn', custom: () => [],"],
    ['W17「標誌著色」也算', '標誌著(?!色)', '標誌著'],
    ['W04 少了「毋庸置疑」', '|毋庸置疑|無庸置疑|', '|無庸置疑|'],
    ['W07 少了「接住你」', '|接住(?:你|您|情緒)/gu', '/gu'],
    ['W15 少了「世界級」', '|世界級|', '|'],
    ['S04 少了「更好地」', '|更(?:好|有效|深入|全面)地/gu', '/gu'],
    ['S04 少了「扎實地」', '|完整|扎實|紮實)地', '|完整)地'],
    ['S06 少了「試想」', '|試想(?!題)|', '|'],
    ['W03 少了「極具」', '|極具(?!體)|', '|'],
    ['W07 少了「大有助益」', '|大有助益|體現(?![況代象])|', '|體現(?![況代象])|'],
    ['W07 少了「體現」', '|大有助益|體現(?![況代象])|', '|大有助益|'],
    ['W07「具體現象」也算', '體現(?![況代象])', '體現(?![況代])'],
    ['K01「希望對備審有幫助」也算', '對(?:你|您|大家|各位)有', '(?:對(?:你|您|大家|各位))?有'],
    ['K01「研究團隊希望這篇論文」也算', '(?<![\\p{Script=Han}A-Za-z0-9])希望', '希望'],
    ['K01「老師讓我們一起討論」也算', '(?<![\\p{Script=Han}A-Za-z0-9])讓我們', '讓我們'],
    ['K01「如果你有疑問，歡迎寄信」也算', '(?:問題|疑問)[^。！？]{0,4}歡迎(?:隨時)?(?:提問|詢問|留言)', '(?:問題|疑問)'],
    ['K01「當然，下面這張表」也算', '[，！,!]\\s?以下是', '[，！,!]'],
    ['K01「作為 AI 助理，查詢」也算', '\\s?[，,]?\\s?我|截至我的', '|截至我的'],
    ['K01 少了「好的！以下是」', '|^(?:好的|當然(?:可以)?)[，！,!]\\s?以下是', ''],
    ['K04「讓我們的」也算', '讓我們(?=陪|為|一起|來|帶)', '讓我們(?=陪|為|一起|來|帶|的)'],
    ['P05 數學式也擋', " ? '數學式' : null)", ' ? null : null)'],
    ['P05 括號裡沒有運算符號也算數學式', "\n            && (/[+−×÷*=^,<>≤≥]/.test(m[0]) || (/[A-Za-z]/.test(m[0]) && /[-/]/.test(m[0])))", ''],
    ['P05「(1/15)」「(10-12)」也算數學式', '(/[A-Za-z]/.test(m[0]) && /[-/]/.test(m[0]))', '/[-/]/.test(m[0])'],
    ['P05 英文縮寫也算數學式', "!/[A-Za-z]{2}|_/.test(m[0])", 'true'],
    ['拿掉 K02', "id: 'K02-placeholder', severity: 'block',", "id: 'K02-placeholder', severity: 'block', custom: () => [],"],
    ['K02 引號裡的 XX 也算', "/^(?:XX+|xx+|ＸＸ|○○|〇〇)$/.test(m[0]) && inQuote(m) ? '引號裡代替名稱的 XX'", "false ? ''"],
    ['K02 引號裡的 TBD 也放行', "/^(?:XX+|xx+|ＸＸ|○○|〇〇)$/.test(m[0]) && inQuote(m)", 'inQuote(m)'],
    ['K02 內文的 TODO 也算', ": /^(?:TODO|FIXME)$/.test(m[0]) && b.kind !== 'json' ?", ': false ?'],
    ['K02 數字後面的 xx 也算', '(?<![A-Za-z0-9])(?:XX+|xx+)', '(?<![A-Za-z])(?:XX+|xx+)'],
    ['K02 XX 後面不必接系、月這類字', '(?=\\s?(?:學系|系|大學|高中|國中|國小|公司|老師|同學|月|日|號))', '(?![A-Za-z0-9])'],
    ['K02 少了「20XX 年」', '|20(?:XX|xx)\\s?年', ''],
    ['K02 少了「202X」', '|202X(?![A-Za-z])', ''],
    ['K02 少了 TBA', '|\\bTBA\\b', ''],
    ['K02 轉述官網的 TBA 也算', ": /^TB[AD]$/.test(m[0]) &&", ': false &&'],
    ['K02 不略過引文', "id: 'K02-placeholder', severity: 'block', skip: 'fqu',", "id: 'K02-placeholder', severity: 'block', skip: 'u',"],
    ['K02 中文數字的〇〇也算', '(?<![一二三四五六七八九十〇零兩])〇〇(?![一二三四五六七八九十〇零兩])', '〇〇'],
    ['K02 Lorem 大寫抓不到', '[Ll]orem ipsum', 'lorem ipsum'],
    ['拿掉 K03', "id: 'K03-markdown-residue', severity: 'block', skip: '',", "id: 'K03-markdown-residue', severity: 'block', skip: '', custom: () => [],"],
    ['K03 網址裡的 ** 也算', "b.skip[m.index] === 'u' && !m[0].startsWith('utm_source') ? '網址裡的符號'", "false ? ''"],
    ['K03 談 Markdown 寫法也算', ": /(?:例如|像是|寫成)\\s*$/.test(before(m, 6)) || /^\\s*(?:這類|這種|的寫法)/.test(after(m, 6)) ?", ': false ?'],
    ['K03「2**3」也算', '(?<![\\w*])\\*\\*', '\\*\\*'],
    ['K03 粗體不必包住中文', '\\*\\*(?=[^*\\n]*\\p{Script=Han})', '\\*\\*'],
    ['K03 少了 __粗體__', '|(?<![\\w_])__(?=[^_\\n]*\\p{Script=Han})(?=\\S)[^_\\n]{1,40}?(?<=\\S)__(?![\\w_])', ''],
    ['K03 標題不必在開頭', '|^#{1,6}\\s+\\S', '|(?:^|\\s)#{1,6}\\s+\\S'],
    ['K03 少了「######」', '^#{1,6}', '^#{1,4}'],
    ['K03 網址裡的 utm_source 也放行', " && !m[0].startsWith('utm_source')", ''],
    ['K03 少了 perplexity', '|copilot|perplexity)/gu', '|copilot)/gu'],
    ['K03 略過網址', "id: 'K03-markdown-residue', severity: 'block', skip: '',", "id: 'K03-markdown-residue', severity: 'block', skip: 'u',"],
    ['拿掉 W15', "{ id: 'W15-grand-promise', severity: 'warn',", "{ id: 'W15-grand-promise', severity: 'warn', custom: () => [],"],
    ['拿掉 W16', "id: 'W16-card-verdict', severity: 'warn',", "id: 'W16-card-verdict', severity: 'warn', custom: () => [],"],
    ['W16 有出處也算', "normal: (m) => (/(號稱|自稱|官網|(?<!數)據|(?<![名簡])稱|(?<!撰)寫(?!給)|(?<![解小])說(?!明|故事)|指出|表示)[^。]{0,12}$/.test(before(m, 16)) ? '已標明是誰說的' : null),", ''],
    ['W16「小說」「解說」也算出處', '(?<![解小])說(?!明|故事)', '說(?!明|故事)'],
    ['W16「說明」「說故事」也算出處', '(?<![解小])說(?!明|故事)', '(?<![解小])說'],
    ['W16「名稱」「簡稱」也算出處', '(?<![名簡])稱', '稱'],
    ['W16「撰寫」也算出處', '(?<!撰)寫(?!給)', '寫(?!給)'],
    ['W16「寫給」也算出處', '(?<!撰)寫(?!給)', '(?<!撰)寫'],
    ['W16「數據」也算出處', '(?<!數)據|(?<![名簡])稱', '據|(?<![名簡])稱'],
    ['W16「官方頻道」也算出處', '(號稱|自稱|官網|(?<!數)據', '(號稱|自稱|官網|官方|(?<!數)據'],
    ['W16 少了「指出」', '|指出|表示)[^。]{0,12}$', '|表示)[^。]{0,12}$'],
    ['W16 少了「表示」', '|指出|表示)[^。]{0,12}$', '|指出)[^。]{0,12}$'],
    ['W16 少了「有趣、易懂」', '有趣[、和]?易懂', '有趣易懂'],
    ['W16 少了「絕佳」', '|備受(?:好評|推崇|肯定)|絕佳/gu', '|備受(?:好評|推崇|肯定)/gu'],
    ['拿掉 S03', "{ id: 'S03-not-x-is-y', severity: 'warn',", "{ id: 'S03-not-x-is-y', severity: 'warn', custom: () => [],"],
    ['S03 把「是否」也算', '(?:是|就是)(?!否)', '(?:是|就是)'],
    ['拿掉 S04', "{ id: 'S04-adverb-de', severity: 'warn',", "{ id: 'S04-adverb-de', severity: 'warn', custom: () => [],"],
    ['拿掉 S06', "{ id: 'S06-rhetorical', severity: 'warn',", "{ id: 'S06-rhetorical', severity: 'warn', custom: () => [],"],
    ['拿掉 U01', "id: 'U01-ui-message', severity: 'warn',", "id: 'U01-ui-message', severity: 'warn', custom: () => [],"],
    ['U01 內文也算', "normal: (m, b) => (b.tag === 'script' || b.tag.startsWith('attr') ? null : '不在腳本或屬性裡'),", ''],
    ['U01 不看屬性', "b.tag === 'script' || b.tag.startsWith('attr') ? null", "b.tag === 'script' ? null"],
    ['P11 少了 ⋯', '(?<!…)…(?!…)|⋯+/gu', '(?<!…)…(?!…)/gu'],
    ['P11 數列的 ⋯ 也算', "m[0] === '⋯' && /[,，]\\s*$/.test(before(m, 2))", 'false && /[,，]\\s*$/.test(before(m, 2))'],
    ['S04「完整地址」也算', '(?=\\p{Script=Han})(?![址底區方點圖球])', '(?=\\p{Script=Han})'],
    ['S06「是否有填寫」也算', '(?:曾|常|有過|覺得|想過)', '(?:曾|常|有|覺得|想過)'],
    ['S06「試想題」也算', '|試想(?!題)|', '|試想|'],
    ['U01「給網站管理員」也算', '(?<!給)網站管理員', '網站管理員'],
    ['U01「系統錯誤代碼」也算', '系統錯誤(?!代?碼)', '系統錯誤'],
    ['U01「糟糕的姿勢」也算', '糟糕(?=[，,！!])', '糟糕'],
    ['W07「立體現代」也算', '體現(?![況代象])', '體現(?![況象])'],
    ['W07「整體現況」也算', '體現(?![況代象])', '體現(?![代象])'],
    ['模板的粗體不記', 'if (/\\p{Script=Han}/u.test(t) || curly) out.push({ text: t, bold });', 'if (/\\p{Script=Han}/u.test(t) || curly) out.push({ text: t, bold: [] });'],
    ['模板粗體後面的冒號不算', ' || /^[：:]/.test(raw.slice(m.index + m[0].length))', ''],
    ['頁面腳本的粗體不交給 F01', "blocks.push(plain(page, 'html', 'script', text, { bold }));", "blocks.push(plain(page, 'html', 'script', text));"],
    ['「數據統計」也算據統計', '|(?<![數依根])據統計|', '|(?<![依根])據統計|'],
    ['「依據統計處」也算據統計', '|(?<![數依根])據統計|', '|(?<![數])據統計|'],
    ['W03「極具體」也算', '極具(?!體)', '極具'],
    ['略過的範圍照算', 'if (f.len > 0 && r.skip &&', 'if (false &&'],
    ['談詞語的引號照算', 'if (f.len > 0 && isMention(b.text, f.index, f.len))', 'if (false)'],
    ['回推時短片段也找', 'if (snip.length < 4) continue;', 'if (snip.length < 2) continue;'],
    ['參考式連結留著方括號', '(refs?.has(refLabel(id || text)) ? text : m)', 'm'],
    ['沒有定義的方括號也去掉', 'refs?.has(refLabel(id || text)) ? text', 'true ? text'],
    ['.md 以外的檔案也認定義', 'const refs = md ? refLabels(content) : null;', 'const refs = refLabels(content);'],
    ['\\[x] 也當參考式連結', '.replace(/(?<!\\\\)\\[([^\\]]*)\\]', '.replace(/\\[([^\\]]*)\\]'],
    ['屬性只比對去掉標籤的文字', "const kinds = block.tag.startsWith('attr') || block.tag === 'script' ? ['raw', 'text'] : ['text', 'raw'];", "const kinds = ['text'];"],
    ['行號一律回第 1 行', 'return { file, line: lineAt(starts, pos), dup };', 'return { file, line: 1, dup };'],
    ['超過基準一筆不報', 'if (n > (baseline[key] ?? 0)) over.push', 'if (n > (baseline[key] ?? 0) + 1) over.push'],
    ['少於基準不報', 'if ((now[key] ?? 0) < n) under.push', 'if (false) under.push'],
    ['新規則不看現在多出的鍵', 'new Set([...Object.keys(baseline), ...Object.keys(now)])', 'new Set(Object.keys(baseline))'],
    ['新規則的基準不比現值', 'if ((baseline[key] ?? 0) !== (now[key] ?? 0))', 'if (false)'],
    ['已有的規則也比現值', 'if (id in before.rules) continue;', ''],
    ['沒列在 policy 的 block 規則不檢查', "for (const rule of rules.filter((r) => r.severity === 'block').map((r) => r.id)) {", 'for (const rule of Object.keys(policy.rules)) {'],
    ['下修變成照現值', 'Math.min(counts[rule]?.[key] ?? 0, n)', '(counts[rule]?.[key] ?? n)'],
    ['降到 0 的鍵留著', 'if (v > 0) next[key] = v;', 'next[key] = v;'],
    ['基準變大不擋', 'else if (old && n > old[key])', 'else if (false)'],
    ['新鍵不擋', 'else if (old && !(key in old))', 'else if (false)'],
    ['已有的規則也當成新加的', 'const old = id in before.rules ? before.rules[id].baseline ?? {} : null;', 'const old = null;'],
    ['新加的規則不能帶基準', 'const old = id in before.rules ? before.rules[id].baseline ?? {} : null;', 'const old = before.rules[id]?.baseline ?? {};'],
    ['刪規則不擋', "if (!(id in after.rules)) problems.push(`${id}：目標分支", "if (false) problems.push(`${id}：目標分支"],
    ['非整數基準不擋', 'if (!isCount(n))', 'if (false)'],
    ['policy 少了 block 規則不擋', "if (!(id in after.rules)) problems.push(`${id}：RULES", "if (false) problems.push(`${id}：RULES"],
    ['policy 多了非 block 規則不擋', 'if (!block.has(id)) problems.push', 'if (false) problems.push'],
    ['規則 id 不檢查格式', 'if (!/^[A-Z]\\d{2}-[a-z0-9-]+$/.test(id))', 'if (false)'],
    ['後接詞少了這兩個字', '|這兩個字|這幾個字|', '|'],
    ['英文 em dash 不看拉丁字母', "if (/[A-Za-z]/.test(b.slice(-1)) && /[A-Za-z]/.test(a[0] ?? '')) return '英文裡的 em dash';", "if (true) return '英文裡的 em dash';"],
    ['改到的行少算一行', 'k < Number(m[2] ?? 1)', 'k < Number(m[2] ?? 1) - 1'],
    ['annotation 不限數量', 'if (sent[level]++ >= limit) rest++;', 'if (false) rest++;'],
    ['annotation 一律是 warning', "overKeys.has(`${h.rule}|${h.key}`) ? 'error' : 'warning'", "'warning'"],
    ['沒改到的行也標', 'hits.filter((x) => x.line && changed.has(`${x.key}:${x.line}`))', 'hits.filter((x) => x.line)'],
];

const CLI = path.join(ROOT, 'scripts/check-writing.mjs');
const cliSource = readFileSync(CLI, 'utf8');
// [說明, 原文, 改成, 最可能擋下它的 A 段案例]。原文必須在 check-writing.mjs 裡恰好出現一次。
const cliMutations = [
    ['結束碼一律是 0', 'process.exit(over.length || under.length || allowErrors.length ? 1 : 0);', 'process.exit(0);', '內文加「很多」'],
    ['放行清單的錯誤不擋', 'process.exit(over.length || under.length || allowErrors.length ? 1 : 0);', 'process.exit(over.length || under.length ? 1 : 0);', '放行條目的 kind 寫錯'],
    ['比基準少不擋', 'process.exit(over.length || under.length || allowErrors.length ? 1 : 0);', 'process.exit(over.length || allowErrors.length ? 1 : 0);', '基準多一筆也擋'],
    ['--verify 不讀新規則的現值', 'if (problems.length || Object.keys(after.rules).every((id) => id in before.rules)) {', 'if (true) {', '--verify 新規則基準灌水'],
    ['--verify 新規則的現值不同也通過', 'process.exit(fresh.length ? 1 : 0);', 'process.exit(0);', '--verify 新規則基準灌水'],
    ['不讀資料 JSON', 'for (const f of dataFiles) {', 'for (const f of []) {', '資料 JSON 加「很多」'],
    ['shared 的 js 不記粗體', "tag: 'script', text, skip: ' '.repeat(text.length), bold });", "tag: 'script', text, skip: ' '.repeat(text.length), bold: [] });", 'shared 的 js 加粗體標籤'],
    ['報表照印 PH', "const readable = (s) => String(s).replaceAll(PH, '${…}');", 'const readable = (s) => String(s);', 'shared 的 js 的粗體標籤裡有 ${…}'],
    ['不掃 shared 的 js', " || /^shared\\/[^/]+\\.js$/.test(f)", '', 'shared 的 js 加「——」'],
    ['不讀頁面', 'htmlPages.forEach((page, i) =>', 'htmlPages.slice(0, 0).forEach((page, i) =>', '乾淨的副本'],
    ['不掃 header 與 footer', 'withChrome: i === 0', 'withChrome: false', 'header 加「很多」'],
    ['頁面不完整也照查', 'if (htmlPages.length === 0 || pagesWithText < htmlPages.length) {', 'if (htmlPages.length === 0) {', '清空每頁的 <main>'],
    ['頁數門檻容許一頁', 'pagesWithText < htmlPages.length)', 'pagesWithText < htmlPages.length - 1)', '清空一頁的 <main>'],
    ['放行只看命中的開頭', 'allowCovers(e, h.block, h.index, h.len)', 'allowCovers(e, h.block, h.index, 1)', '命中從放行片段裡延伸到片段外'],
    ['annotation 不看 public', "git('diff', '-U0', annotateRef, '--', 'src', 'public')", "git('diff', '-U0', annotateRef, '--', 'src')", '--annotate 標到 public 的資料檔'],
    ['有錯的放行條目照用', 'return errors.length === 0;', 'return true;', '有錯的放行條目不放行'],
    ['放行不看規則', 'usable.some((e) => e.rule === h.rule &&', 'usable.some((e) => true &&', '放行條目換成別的規則'],
    ['放行不看檔案', '(e.page ? e.page === h.block.page : e.file === w.key) &&', 'true &&', '放行改指到另一頁'],
    ['內文也去重', "if (w.line && h.block.tag.startsWith('attr') && seen.has(dupKey)) continue;", 'if (w.line && seen.has(dupKey)) continue;', '內文重複一次'],
    ['資料 JSON 找不到行也記成檔案', 'if (i >= 0) return { key: b.page, line: i + 1 };', 'return { key: b.page, line: i + 1 };', '資料 JSON 多一個原始檔沒有的欄位'],
    ['annotation 一律 warning', 'new Set(over.map((o) => `${o.rule}|${o.key}`))', 'new Set()', '--annotate 超過基準的檔案是 error'],
    ['--update-baseline 不寫檔', 'writeFileSync(POLICY, `${JSON.stringify(lowerBaseline(policy, counts), null, 1)}\\n`);', '', '--update-baseline 下修'],
    ['--update-baseline 超過基準也是 0', 'process.exit(over.length ? 1 : 0);\n}', 'process.exit(0);\n}', '--update-baseline 遇到超過基準'],
    ['--verify 一律通過', 'process.exit(problems.length ? 1 : 0);', 'process.exit(0);', '--verify 基準調高'],
    ['--verify 找不到 ref 也通過', "console.error(`找不到 ${ref}，無法比對基準。`);\n        process.exit(1);", "console.error(`找不到 ${ref}，無法比對基準。`);\n        process.exit(0);", '--verify ref 不存在'],
    ['--verify 讀不出基準也通過', "console.error(`${ref} 的 writing-policy.json 讀不出來：${err.message}`);\n        process.exit(1);", "console.error(`${ref} 的 writing-policy.json 讀不出來：${err.message}`);\n        process.exit(0);", '--verify 目標分支的基準壞掉'],
];

if (!existsSync(path.join(ROOT, 'dist'))) {
    console.error('找不到 dist/，請先執行 npm run build:deployable。');
    process.exit(1);
}
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const policyText = readFileSync(path.join(ROOT, 'scripts/writing-policy.json'), 'utf8');
const allowText = readFileSync(path.join(ROOT, 'scripts/writing-allow.json'), 'utf8');

// --verify 要比對的目標分支：用 git 的低階指令做只含 scripts/writing-policy.json 的 commit 物件，不動索引和分支。
// CI 上沒有設定 git 的使用者，commit-tree 需要的作者資料在這裡給。
const who = { GIT_AUTHOR_NAME: 'writing-faults', GIT_AUTHOR_EMAIL: 'writing-faults@example.invalid', GIT_COMMITTER_NAME: 'writing-faults', GIT_COMMITTER_EMAIL: 'writing-faults@example.invalid' };
const gitIn = (args, input) => execFileSync('git', args, { cwd: ROOT, input, encoding: 'utf8', env: { ...process.env, ...who } }).trim();
function baseWith(policy) {
    const blob = gitIn(['hash-object', '-w', '--stdin'], policy);
    const scripts = gitIn(['mktree'], `100644 blob ${blob}\twriting-policy.json\n`);
    return gitIn(['commit-tree', gitIn(['mktree'], `040000 tree ${scripts}\tscripts\n`), '-m', 'writing faults base']);
}
const BASE = baseWith(policyText);
// 目標分支少了一條有基準的規則，等於這次才加這條規則。
const baseRules = JSON.parse(policyText).rules;
const NEW_RULE = Object.keys(baseRules).find((id) => Object.keys(baseRules[id].baseline).length);
const BASE_WITHOUT_RULE = baseWith(JSON.stringify({ rules: Object.fromEntries(Object.entries(baseRules).filter(([id]) => id !== NEW_RULE)) }));
const BROKEN = baseWith('{ 壞掉的 JSON');

/** sandbox 建一份給一個 worker 用的副本，回傳路徑與還原用的函式。 */
function sandbox(n) {
    const dir = path.join(WORK, `w${n}`);
    const dist = path.join(dir, 'dist');
    cpSync(path.join(ROOT, 'dist'), dist, { recursive: true });
    const html = readdirSync(dist, { recursive: true }).map(String).filter((f) => f.endsWith('.html')).sort();
    const touched = new Map();
    const box = {
        dir, dist, html, policy: path.join(dir, 'policy.json'), allow: path.join(dir, 'allow.json'), report: path.join(dir, 'report.json'),
        cli: path.join(ROOT, `scripts/.check-writing.faultcheck-${n}.mjs`),
        file: (rel) => path.join(dist, rel),
        edit(rel, fn) {
            const p = path.join(dist, rel);
            if (!touched.has(p)) touched.set(p, readFileSync(p, 'utf8'));
            writeFileSync(p, fn(touched.get(p)));
        },
        reset() {
            for (const [p, text] of touched) writeFileSync(p, text);
            touched.clear();
            writeFileSync(box.policy, policyText);
            writeFileSync(box.allow, allowText);
            rmSync(box.report, { force: true });
        },
    };
    return box;
}

const editPolicy = (fn) => (b) => { const p = JSON.parse(policyText); fn(p.rules); writeFileSync(b.policy, JSON.stringify(p)); };
const editAllow = (fn) => (b) => { const a = JSON.parse(allowText); fn(a.entries); writeFileSync(b.allow, JSON.stringify(a)); };
const firstKey = (rules, id) => Object.keys(rules[id].baseline)[0];
const inPage = (html) => (b) => b.edit('about.html', (t) => t.replace('</main>', `${html}</main>`));
const W01_ENTRY = '「我當時很多問題都沒回答很好，但最後還是有錄取」';
const clearMains = (count) => (b) => { for (const f of b.html.slice(0, count)) b.edit(f, (t) => t.replace(/(<main[^>]*>)[\s\S]*<\/main>/, '$1</main>')); };
const hitWith = (r, text) => r?.hits.find((h) => h.context.includes(text));
const FINANCE_APPLICATION = 'src/content/clusters/finance/application.md';

// [說明, 改動, 參數, 預期結束碼, 另外的檢查 (報表, 跑完的基準, 輸出) => boolean]
const cases = [
    ['乾淨的副本', () => {}, [], 0],
    ['內文加「很多」', inPage('<p>這裡有很多事。</p>'), [], 1],
    ['內文加「——」', inPage('<p>一段——說明</p>'), [], 1],
    ['alt 加「很多」', inPage('<img alt="很多照片">'), [], 1],
    ['header 加「很多」', (b) => b.edit(b.html[0], (t) => t.replace(/(<header[^>]*>)/, '$1<p>頁首很多字</p>')), [], 1],
    ['shared 的 js 加粗體標籤', (b) => b.edit('shared/platform-ai.js', (t) => `${t}\nwindow.__writingFault = \`<b>注入標籤：</b>說明\`;\n`), [], 0,
        (r) => !!r?.hits.some((h) => h.rule === 'F01-bold-label' && h.match === '注入標籤：')],
    ['shared 的 js 的粗體標籤裡有 ${…}', (b) => b.edit('shared/platform-ai.js', (t) => `${t}\nwindow.__writingFault = \`<b>\${k}：</b>注入說明\`;\n`), [], 0,
        (r) => !!r?.hits.some((h) => h.rule === 'F01-bold-label' && h.match === '${…}：' && h.context.includes('${…}： 注入說明'))],
    ['shared 的 js 加「——」', (b) => b.edit('shared/platform-ai.js', (t) => `${t}\nwindow.__writingFault = '一段——說明';\n`), [], 1],
    ['資料 JSON 加「很多」', (b) => b.edit('career-exploration/senior-interviews.json', (t) => t.replace('"content_html": "', '"content_html": "<p>注入的很多</p>')), [], 1],
    // 原始檔沒有這個欄位，pointer 找不到行，命中只能記成頁面路徑。
    ['資料 JSON 多一個原始檔沒有的欄位', (b) => b.edit('career-exploration/senior-interviews.json', (t) => { const d = JSON.parse(t); d.interviews[0].faultNote = '注入的欄位很多'; return JSON.stringify(d); }), [], 1,
        (r) => hitWith(r, '注入的欄位很多')?.file === 'page:public/career-exploration/senior-interviews.json'],
    // 同一行原始碼、同樣前後文的內文命中各算一筆，只有屬性跨頁才合併。結束碼也會因放行片段出現兩次而是 1，
    // 所以另外確認有一筆內文命中變成兩筆。
    ['內文重複一次', (b) => b.edit('career-exploration/clusters/finance/application.html', (t) => t.replace(/(<main[^>]*>)([\s\S]*)<\/main>/, '$1$2$2</main>')), [], 1,
        (r) => !!r?.hits.some((h) => h.file === FINANCE_APPLICATION && r.hits.filter((x) => x.file === h.file && x.rule === h.rule && x.line === h.line && x.match === h.match && x.context === h.context).length === 2)],
    ['清空每頁的 <main>', clearMains(Infinity), [], 1, (r) => r === null],
    ['清空一頁的 <main>', clearMains(1), [], 1, (r) => r === null],
    ['放行條目的 kind 寫錯', editAllow((e) => { e[0].kind = 'other'; }), [], 1],
    ['有錯的放行條目不放行', editAllow((e) => { e[0].kind = 'other'; }), [], 1, (r) => r?.over.some((o) => o.rule === JSON.parse(allowText).entries[0].rule)],
    ['放行片段不唯一', editAllow((e) => { e.push({ ...e[0], text: '學', reason: '故障注入：只有一個字的片段不唯一。' }); }), [], 1],
    // 片段結尾的「—」和片段外的「—」連成一筆「——」，命中只有開頭在片段裡，不能放行。
    ['命中從放行片段裡延伸到片段外', (b) => {
        inPage('<p>前文說明——後文</p>')(b);
        editAllow((e) => e.push({ page: 'about.html', text: '前文說明—', rule: 'P01-double-dash', kind: 'counterexample', reason: '故障注入：片段只包住命中的前半。' }))(b);
    }, [], 1],
    ['放行條目換成別的規則', editAllow((e) => { e.find((x) => x.text === W01_ENTRY).rule = 'W06-puffery'; }), [], 1],
    ['放行改指到另一頁', (b) => {
        inPage(`<p>${W01_ENTRY}</p>`)(b);
        editAllow((e) => { const x = e.find((y) => y.text === W01_ENTRY); delete x.file; x.page = 'about.html'; })(b);
    }, [], 1],
    ['基準少一筆', editPolicy((r) => { r['W01-hen-duo'].baseline[firstKey(r, 'W01-hen-duo')] -= 1; }), [], 1],
    ['規則鍵不見', editPolicy((r) => { delete r['P01-double-dash']; }), [], 1],
    ['基準多一筆也擋', editPolicy((r) => { r['W01-hen-duo'].baseline[firstKey(r, 'W01-hen-duo')] += 1; }), [], 1],
    ['CLI 新規則基準比現值多', editPolicy((r) => { r['K02-placeholder'].baseline['public/advanced-resources/competitions.json'] = 48; }), [], 1],
    ['CLI 基準掛在沒有命中的檔案', editPolicy((r) => { r['W04-filler-signpost'].baseline['src/pages/about.astro'] = 999; }), [], 1],
    ['--update-baseline 下修', editPolicy((r) => { r['W01-hen-duo'].baseline[firstKey(r, 'W01-hen-duo')] += 1; }), ['--update-baseline'], 0,
        (r, p) => p === JSON.stringify(JSON.parse(policyText), null, 1) + '\n'],
    ['--update-baseline 遇到超過基準', inPage('<p>這裡有很多事。</p>'), ['--update-baseline'], 1],
    ['--verify 沒有放寬', () => {}, ['--verify', BASE], 0],
    ['--verify 基準調高', editPolicy((r) => { r['W01-hen-duo'].baseline[firstKey(r, 'W01-hen-duo')] += 1; }), ['--verify', BASE], 1],
    ['--verify 刪規則鍵', editPolicy((r) => { delete r['W04-filler-signpost']; }), ['--verify', BASE], 1],
    ['--verify 多出新鍵', editPolicy((r) => { r['W04-filler-signpost'].baseline['src/none.md'] = 1; }), ['--verify', BASE], 1],
    ['--verify 新加的規則帶著基準', () => {}, ['--verify', BASE_WITHOUT_RULE], 0],
    ['--verify 新規則基準灌水', editPolicy((r) => { r[NEW_RULE].baseline[firstKey(r, NEW_RULE)] += 1; }), ['--verify', BASE_WITHOUT_RULE], 1],
    ['--verify 新規則基準掛在沒有命中的檔案', editPolicy((r) => { r[NEW_RULE].baseline['src/pages/about.astro'] = 999; }), ['--verify', BASE_WITHOUT_RULE], 1],
    ['--verify ref 不存在', () => {}, ['--verify', 'no-such-ref-for-writing-faults'], 1],
    ['--verify 目標分支的基準壞掉', () => {}, ['--verify', BROKEN], 1],
    ['--annotate 乾淨的副本', () => {}, ['--annotate', 'HEAD'], 0],
    // BASE 裡只有基準檔，src 的每一行都算改到；重複的內文讓那個檔超過基準，annotation 要是 error。
    ['--annotate 超過基準的檔案是 error', (b) => b.edit('career-exploration/clusters/finance/application.html', (t) => t.replace(/(<main[^>]*>)([\s\S]*)<\/main>/, '$1$2$2</main>')), ['--annotate', BASE], 1,
        (r, p, out) => /^::error file=src\/content\/clusters\/finance\/application\.md,/m.test(out)],
    // 只改 public/ 的資料檔時也要標到那一行。
    ['--annotate 標到 public 的資料檔', (b) => b.edit('career-exploration/senior-interviews.json', (t) => t.replace('"content_html": "', '"content_html": "<p>注入的很多</p>')), ['--annotate', BASE], 1,
        (r, p, out) => /^::error file=public\/career-exploration\/senior-interviews\.json,line=\d+/m.test(out)],
];

/** runCase 在 box 裡用 cli 跑一個案例，回傳不符的原因，符合時回傳 null。 */
function runCase(box, cli, [, change, args, want, check]) {
    return new Promise((resolve) => {
        box.reset();
        change(box);
        const env = { ...process.env, SITE_DIST: box.dist, WRITING_POLICY: box.policy, WRITING_ALLOW: box.allow, WRITING_REPORT: box.report, GITHUB_STEP_SUMMARY: '' };
        execFile(process.execPath, [cli, ...args], { cwd: ROOT, env, maxBuffer: 1 << 26 }, (err, stdout) => {
            const code = err ? err.code ?? 1 : 0;
            if (code !== want) return resolve(`結束碼 ${code}，預期 ${want}`);
            const report = existsSync(box.report) ? JSON.parse(readFileSync(box.report, 'utf8')) : null;
            resolve(check && !check(report, readFileSync(box.policy, 'utf8'), stdout) ? '報表、基準或輸出不符' : null);
        });
    });
}

/** pool 用 WORKERS 個副本跑 tasks，每個 task 是 (box) => Promise。 */
async function pool(tasks) {
    const results = new Array(tasks.length);
    let next = 0;
    await Promise.all(boxes.map(async (box) => {
        for (let k = next++; k < tasks.length; k = next++) results[k] = await tasks[k](box);
    }));
    return results;
}

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log(`  ✅ ${name}`); };
const bad = (name, why) => { fail++; console.log(`  ❌ ${name}：${why}`); };
const boxes = Array.from({ length: WORKERS }, (_, n) => sandbox(n));

console.log('A. 串接：');
const a = await pool(cases.map((c) => (box) => runCase(box, CLI, c)));
cases.forEach(([name], k) => (a[k] ? bad(name, a[k]) : ok(name)));

console.log('\nB. 改壞判斷（writing.test.mjs 必須失敗）：');
const testsPass = (dir) => new Promise((resolve) => execFile(process.execPath, ['--test', path.join(dir, 'writing.test.mjs')], { cwd: ROOT }, (err) => resolve(!err)));
const libDir = (k) => {
    const d = path.join(WORK, `m${k}`);
    mkdirSync(d, { recursive: true });
    for (const f of ['writing.test.mjs', 'markdown-refs.lib.mjs']) cpSync(path.join(ROOT, 'scripts', f), path.join(d, f));
    return d;
};
const clean = libDir('clean');
writeFileSync(path.join(clean, 'writing.lib.mjs'), original);
if (!(await testsPass(clean))) bad('沒有改動', 'writing.test.mjs 已經失敗，突變結果沒有意義');
const b = await pool(mutations.map(([, from, to], k) => async () => {
    const n = original.split(from).length - 1;
    if (n !== 1) return `原文在 writing.lib.mjs 出現 ${n} 次`;
    const d = libDir(k);
    writeFileSync(path.join(d, 'writing.lib.mjs'), original.replace(from, () => to));
    return (await testsPass(d)) ? '改壞之後測試還是通過' : null;
}));
mutations.forEach(([name], k) => (b[k] ? bad(name, b[k]) : ok(name)));

console.log('\nC. 改壞串接程式（A 段至少一項不符）：');
const c = await pool(cliMutations.map(([, from, to, hint]) => async (box) => {
    const n = cliSource.split(from).length - 1;
    if (n !== 1) return `原文在 check-writing.mjs 出現 ${n} 次`;
    writeFileSync(box.cli, cliSource.replace(from, () => to));
    // 先跑最可能擋下它的案例，擋下就不必跑完全部。
    const order = [...cases].sort((x, y) => (y[0] === hint) - (x[0] === hint));
    for (const kase of order) if (await runCase(box, box.cli, kase)) return null;
    return 'A 段全部照樣符合';
}));
cliMutations.forEach(([name], k) => (c[k] ? bad(name, c[k]) : ok(name)));

for (const box of boxes) rmSync(box.cli, { force: true });
const after = (await runCase(boxes[0], CLI, cases[0])) === null;
rmSync(WORK, { recursive: true, force: true });
const total = cases.length + mutations.length + cliMutations.length;
console.log(`\n${after ? '還原後仍是綠燈。' : '還原後不是綠燈。'}故障注入：${pass} 項符合，${fail} 項不符（共 ${total} 項）。`);
process.exit(fail === 0 && after ? 0 : 1);
