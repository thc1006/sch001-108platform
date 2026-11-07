// 篩選面板測試共用的等待。
// 檔名不是 *.spec.js，Playwright 不會把它當成測試執行。
const { expect } = require('@playwright/test');

/**
 * settleFilters 等篩選面板的狀態定下來：捲動位置連續 3 個 frame 不變，面板也沒有進行中的動畫。
 * 前提是 sticky-filters.js 在捲動後的下一個 frame 就改 transform，目前是在 rAF 裡改；反應晚了
 * 幾個 frame 的話，例如用 setTimeout 延後 100ms，這裡可能在面板開始動之前就回傳。
 * 面板動畫設定的時間連同 delay 超過 300ms 也算失敗。比的是設定值，不受 CPU 忙碌影響。
 * @param {import('@playwright/test').Page} page
 */
async function settleFilters(page) {
    await page.evaluate(() => {
        window.__settle = { y: NaN, still: 0, running: 0, longest: 0 };
    });
    const settled = await page
        .waitForFunction(
            () => {
                const s = window.__settle;
                const panels = [...document.querySelectorAll('[data-autohide-filters]')];
                const anims = panels.flatMap((el) => el.getAnimations());
                for (const a of anims) s.longest = Math.max(s.longest, a.effect.getComputedTiming().endTime);
                s.running = anims.length;
                s.still = window.scrollY === s.y && !anims.length ? s.still + 1 : 0;
                s.y = window.scrollY;
                return s.still >= 3 && s;
            },
            null,
            { polling: 'raf', timeout: 5000 },
        )
        .catch(async (e) => {
            const s = await page.evaluate(() => window.__settle).catch(() => '讀不到');
            throw new Error(`${e.message}\n面板沒有定下來：${JSON.stringify(s)}`);
        });
    const { longest } = await settled.jsonValue();
    expect(longest, '面板的位移動畫連同 delay 要在 300ms 內跑完').toBeLessThanOrEqual(300);
}

module.exports = { settleFilters };
