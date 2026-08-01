#!/usr/bin/env node
/**
 * 競賽資料內部一致性稽核（人工分診輔助工具，非 CI 關卡）
 * --------------------------------------------------------------
 * 交叉比對 description 的敘述與 category/form/eligibility/mode 等結構化欄位。
 * 這類矛盾——例如描述寫「須具 APCS 三級分」但 eligibility 標「公開報名」——
 * 不需連外網就能抓出來，是縮小人工查證範圍最有效率的第一關。
 *
 * 重要：本工具刻意採寬鬆比對，會有相當比例的誤判（否定句、日期字串、
 * 縣市初賽的「選拔」等），需人工判讀，**不可**當成 CI 的通過條件。
 *
 * 執行：  npm run audit:consistency
 */
import { readFileSync } from 'node:fs';

const d = JSON.parse(readFileSync(new URL('../public/advanced-resources/competitions.json', import.meta.url), 'utf8'));
const findings = [];
const flag = (c, rule, detail) => findings.push({ title: c.title, rule, detail });

const TEAM_WORDS = /每隊|組隊|人一隊|團隊|隊伍|需.{0,4}人|至.{0,3}人一組/;
const SOLO_WORDS = /以個人為單位|個人報名|限個人|單人/;
const GATED_WORDS = /選拔|代表隊|國手|須由.{0,8}(學校|主管機關|單位).{0,6}報名|不接受個人報名|須具|門檻|受邀|邀請|晉級|取得.{0,6}獎.{0,4}才/;
const INVITE_WORDS = /受邀|邀請制|獲邀/;
const ONLINE_WORDS = /全程線上|線上舉行|線上投稿|線上投件|線上競賽/;
const ONSITE_WORDS = /實體(舉行|競賽|賽)|現場(簡報|競賽|比賽)|於.{2,12}(舉行|舉辦)|考場|須攜帶|自備電腦/;
const UNI_WORDS = /大專|大學(在學|生)|university|大學階段/i;

for (const c of d.competitions) {
    const desc = c.description || '';

    // form vs 敘述
    if (c.form === '個人' && TEAM_WORDS.test(desc) && !SOLO_WORDS.test(desc)) {
        flag(c, 'form=個人 但描述提到組隊', desc.match(TEAM_WORDS)[0]);
    }
    if (c.form === '團體' && SOLO_WORDS.test(desc)) {
        flag(c, 'form=團體 但描述提到個人報名', desc.match(SOLO_WORDS)[0]);
    }

    // eligibility vs 敘述
    if (c.eligibility === '公開報名' && GATED_WORDS.test(desc)) {
        flag(c, 'eligibility=公開報名 但描述提到門檻/選拔', desc.match(GATED_WORDS)[0]);
    }
    if (c.eligibility !== '邀請制' && INVITE_WORDS.test(desc)) {
        flag(c, `eligibility=${c.eligibility} 但描述提到受邀`, desc.match(INVITE_WORDS)[0]);
    }

    // mode vs 敘述
    if (c.mode === '實體' && ONLINE_WORDS.test(desc)) {
        flag(c, 'mode=實體 但描述提到全程線上', desc.match(ONLINE_WORDS)[0]);
    }
    if (c.mode === '線上' && ONSITE_WORDS.test(desc)) {
        flag(c, 'mode=線上 但描述提到實體/現場', desc.match(ONSITE_WORDS)[0]);
    }

    // 受眾：本站是高中生平台
    if (UNI_WORDS.test(desc) && !/高中|中學|中等學校|13|14|15|16|17|18/.test(desc)) {
        flag(c, '描述以大專/大學為對象，未提及高中生', desc.match(UNI_WORDS)[0]);
    }

    // 時效：描述裡寫死的年份已過
    const years = [...desc.matchAll(/20(2[0-9])\s*(?:年|–|-|屆)?/g)].map((m) => Number('20' + m[1]));
    const stale = years.filter((y) => y < 2026);
    if (stale.length) flag(c, '描述含 2026 之前的年份（可能過時）', stale.join(','));

    // 描述寫了具體月份截止但 deadline 空白（可能可以補上確切日期）
    if (!c.deadline && /截止|收件|報名.{0,4}至/.test(desc) && /\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}-\d{1,2}\b/.test(desc)) {
        flag(c, 'deadline 空白但描述含具體日期', (desc.match(/\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}-\d{1,2}\b/) || [''])[0]);
    }
}

const byRule = {};
for (const f of findings) (byRule[f.rule] ||= []).push(f);
console.log(`總筆數 ${d.competitions.length}，命中 ${findings.length} 項\n`);
for (const [rule, items] of Object.entries(byRule).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`── ${rule}（${items.length}）`);
    for (const i of items) console.log(`   ${i.title}　【${i.detail}】`);
    console.log();
}
