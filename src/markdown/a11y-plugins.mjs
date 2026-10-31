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
