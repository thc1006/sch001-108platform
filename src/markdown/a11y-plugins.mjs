// Markdown 轉成 HTML 時套用的 Sätteri hast 外掛，補上 Markdown 寫不出來的無障礙標記。
// 由 astro.config.mjs 的整合加進 markdown.processor，站上所有 Markdown 都會經過；目前只有
// src/content/clusters 的學群文章。

/**
 * tableScroll 把每個表格包進可以橫向捲動的 <div class="table-scroll">，表格本身維持 display: table。
 * 表格設成 display: block 才能捲動的話，部分瀏覽器會拿掉表格的語意，報讀器就不能按欄列讀。
 * data-label 是表格前面最近的標題；頁面的 script 在表格放不下、真的要捲時，才把外框標成
 * 有這個名稱的 role="region"、加 tabindex="0"，放得下的表格不多一個 Tab 停點和地標。
 * 每份文件各自記最近的標題，所以匯出的是產生外掛的函式。
 * @returns {import('satteri').HastPluginDefinition}
 */
export function tableScroll() {
    let heading = '';
    return {
        name: 'table-scroll',
        element: {
            filter: ['h2', 'h3', 'h4', 'table'],
            visit(node, ctx) {
                if (node.tagName !== 'table') {
                    heading = ctx.textContent(node).trim();
                    return;
                }
                ctx.wrapNode(node, {
                    type: 'element',
                    tagName: 'div',
                    properties: {
                        className: ['table-scroll'],
                        dataLabel: heading ? `表格：${heading}` : '表格',
                    },
                    children: [],
                });
            },
        },
    };
}

/**
 * pdfLabel 在網址以 .pdf 結尾的連結文字後面加上「（PDF）」，點之前就知道會打開 PDF 檔。
 * 標示和前面的一個英文字或一個字放進同一個不換行的 span，換行時不會只剩標示掉到下一行。
 * @type {import('satteri').HastPluginDefinition}
 */
export const pdfLabel = {
    name: 'pdf-label',
    element: {
        filter: ['a'],
        visit(node, ctx) {
            const href = node.properties?.href;
            if (typeof href !== 'string' || !/\.pdf(?:[?#]|$)/i.test(href)) return;
            const last = node.children?.at(-1);
            const tail = last?.type === 'text' ? /(?:[\w.-]+|\S)$/u.exec(last.value) : null;
            const label = (text) => ({
                type: 'element',
                tagName: 'span',
                properties: { className: ['whitespace-nowrap'] },
                children: [{ type: 'text', value: `${text}（PDF）` }],
            });
            if (!tail) {
                ctx.appendChild(node, label(''));
                return;
            }
            const head = last.value.slice(0, tail.index);
            ctx.replaceNode(last, head ? [{ type: 'text', value: head }, label(tail[0])] : [label(tail[0])]);
        },
    },
};
