/**
 * 手機上讓 sticky 篩選面板在向下捲動時讓開畫面。
 * 問題（實測，非主觀感受）：站台 header 是 sticky 64px，多個頁面的篩選面板又
 * sticky 釘在它下面。捲動時兩者疊加，手機上固定佔用的畫面比例是：
 *
 *   competitions      360px 視窗 76%   390px 視窗 58%
 *   online-courses    360px 視窗 70%   390px 視窗 53%
 *   senior-interviews 360px 視窗 45%
 *   reading-list      360px 視窗 44%
 *   competency-map    360px 視窗 28%
 *
 * 在 360px（iPhone SE、多數舊 Android）競賽頁只剩 24% 的畫面在顯示內容。
 *
 * 作法：向下捲動時把面板整個移出畫面，向上捲動、回到頂端、或焦點進入面板時立刻
 * 還原。這是行動裝置上熟悉的模式，且保留「稍微往上滑就能改條件」的即時性；
 * 直接取消 sticky 會逼使用者一路捲回頂端才能改篩選，在上百筆的清單上很麻煩。
 *
 * 面板釘住之後才移走。位移量是照它釘在 header 下方的位置算的，面板還在文件流的原位時
 * 套上去，會往上蓋住前面的內容，原位留下一塊空白。
 *
 * 用 transform 而不是改 height／display：sticky 元素被 transform 位移時，它在
 * 文件流中佔的位置不變，所以下方內容不會跳動。（已實測確認位移 < 2px。）
 *
 * 用法：在要套用的元素上加 data-autohide-filters。
 */
(function () {
    'use strict';

    var MOBILE = '(max-width: 860px)';
    // 捲動超過這個距離才開始隱藏，避免頁面頂端附近就閃動
    var ARM_AFTER = 160;
    // 方向判定的最小位移，低於此值視為抖動不改變狀態
    var HYSTERESIS = 8;
    // 使用者剛操作過篩選（打字、換選項）後的保護時間，期間不隱藏
    var INTERACT_GRACE_MS = 1200;
    // 面板加上 header 最多佔視窗高度的這個比例，超過就不釘住，至少留四分之一給內容。3/4 讓 360x640 的
    // 手機上每一頁的面板都還釘得住（線上課程的面板最高，載入 Noto Sans TC 後加上 header 約 450px）。
    var FIT_RATIO = 3 / 4;

    var panels = [];
    // 同一個寬度下看過的最大視窗高度。螢幕鍵盤彈出時視窗變矮，焦點在輸入框裡時用它判斷，面板才不會跟著
    // 取消釘住、搜尋框跳走。
    var tallest = 0;
    var lastWidth = 0;

    function setup(el) {
        var cs = window.getComputedStyle(el);
        // 讀出它釘在哪個高度，位移量才算得準。
        var topPx = parseFloat(cs.top);
        if (!isFinite(topPx)) topPx = 0;

        var p = {
            el: el,
            topPx: topPx,
            hidden: false,
            lastInteract: 0,
        };

        el.style.willChange = 'transform';

        el.addEventListener('focusin', function () {
            // 鍵盤使用者 tab 進來時必須立刻現身，否則焦點會在畫面外
            reveal(p);
            p.lastInteract = Date.now();
        });
        el.addEventListener('input', function () { p.lastInteract = Date.now(); });
        el.addEventListener('change', function () { p.lastInteract = Date.now(); });
        el.addEventListener('click', function () { p.lastInteract = Date.now(); });
        el.addEventListener('focusout', function (e) {
            if (!el.contains(e.relatedTarget)) fitAll();
        });

        return p;
    }

    /** typing 回傳焦點是否在可以打字的元素上，這時螢幕鍵盤可能開著。 @returns {boolean} */
    function typing() {
        var el = document.activeElement;
        return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    }

    /**
     * fitAll 在面板加上 header 超過視窗高度的 FIT_RATIO 時取消釘住（data-unpinned，見 global.css）。
     * 釘住的面板會蓋掉大半個畫面，比視窗高時下半部還捲不到：320x256（1280x1024 放大 400%）時競賽頁的
     * 面板高 374px，740x360 時資源地圖的面板加上 header 正好 360px。寬度沒變而焦點在面板裡時不改，螢幕
     * 鍵盤彈出時搜尋框才不會跳走；焦點離開面板時再算一次。
     */
    function fitAll() {
        var widthChanged = window.innerWidth !== lastWidth;
        if (widthChanged) {
            lastWidth = window.innerWidth;
            tallest = 0;
        }
        tallest = Math.max(tallest, window.innerHeight);
        var height = typing() ? tallest : window.innerHeight;
        for (var i = 0; i < panels.length; i++) {
            var p = panels[i];
            if (!widthChanged && p.el.contains(document.activeElement)) continue;
            p.el.removeAttribute('data-unpinned');
            if (window.getComputedStyle(p.el).position !== 'sticky') continue;
            var zoom = p.el.currentCSSZoom || 1;
            if (p.el.getBoundingClientRect().height + p.topPx * zoom <= height * FIT_RATIO) continue;
            p.el.setAttribute('data-unpinned', '');
            reveal(p);
        }
    }

    function reveal(p) {
        if (!p.hidden) return;
        p.hidden = false;
        p.el.style.transform = '';
    }

    function conceal(p) {
        if (p.hidden) return;
        unpad();
        // 面板本身高度 ＋ 它與視窗頂端的距離，才能完全離開畫面
        var h = p.el.getBoundingClientRect().height;
        p.hidden = true;
        p.el.style.transform = 'translateY(-' + Math.ceil(h + p.topPx + 2) + 'px)';
    }

    /**
     * pinned 判斷面板是否已釘在 header 下方。rect 含 transform，扣掉才是排版的位置，兩個值同時讀，
     * 位移動畫進行中也對得上。CSS zoom 會放大 rect，computed top 不會，門檻要乘上 zoom。
     * @param {{el: Element, topPx: number}} p @returns {boolean}
     */
    function pinned(p) {
        if (window.getComputedStyle(p.el).position !== 'sticky') return false;
        var zoom = p.el.currentCSSZoom || 1;
        return p.el.getBoundingClientRect().top - shift(p) <= p.topPx * zoom + 0.5;
    }

    /** shift 回傳面板目前的垂直位移，含進行中的轉場。 @param {{el: Element}} p @returns {number} */
    function shift(p) {
        return new DOMMatrixReadOnly(window.getComputedStyle(p.el).transform).m42;
    }

    /**
     * covers 回傳面板釘在 header 下方時的下緣，面板沒釘住或讓開時回傳 0。看狀態不看目前的位移：
     * 面板正在滑回來時位移還是負的，但很快就會蓋住焦點。
     * @param {{el: Element, topPx: number, hidden: boolean}} p @returns {number}
     */
    function covers(p) {
        if (!pinned(p) || p.hidden) return 0;
        return p.topPx * (p.el.currentCSSZoom || 1) + p.el.getBoundingClientRect().height;
    }

    /**
     * coversColumn 回傳 data-sticky-cover 元素釘住時的下緣，它沒釘住、和 target 不在同一欄、或包含 target
     * 時回傳 0。能力地圖每一欄的標題釘在篩選面板下方，只蓋住自己那一欄。
     * @param {Element} el @param {Element} target @returns {number}
     */
    function coversColumn(el, target) {
        var cs = window.getComputedStyle(el);
        if (cs.position !== 'sticky' || el.contains(target)) return 0;
        var r = el.getBoundingClientRect();
        var t = target.getBoundingClientRect();
        if (Math.abs(r.top - parseFloat(cs.top) * (el.currentCSSZoom || 1)) > 1) return 0;
        if (t.right <= r.left || t.left >= r.right) return 0;
        return r.bottom;
    }

    /**
     * pad 讓瀏覽器把焦點捲到釘住的面板下方。<html> 的 scroll-pt-20 只讓開 header，焦點移到面板
     * 後面的元素時，瀏覽器會把它捲到面板底下，或因為它在視窗內而不捲。焦點移進 header 或面板時不設，
     * 這兩個本來就釘在畫面上。
     * @param {Element} target 焦點要移去的元素
     */
    function pad(target) {
        if (target.closest('body > header')) return unpad();
        var bottom = 0;
        for (var i = 0; i < panels.length; i++) {
            if (panels[i].el.contains(target)) return unpad();
            bottom = Math.max(bottom, covers(panels[i]));
        }
        var columns = document.querySelectorAll('[data-sticky-cover]');
        for (var j = 0; j < columns.length; j++) bottom = Math.max(bottom, coversColumn(columns[j], target));
        if (!bottom) return unpad();
        var root = document.documentElement;
        root.style.scrollPaddingTop = bottom / (root.currentCSSZoom || 1) + 16 + 'px';
    }

    function unpad() {
        document.documentElement.style.scrollPaddingTop = '';
    }

    /**
     * hides 回傳釘在 header 下方的面板會不會蓋住鍵盤焦點。焦點從面板 Tab 到後面的卡片時，瀏覽器把卡片
     * 捲到畫面中間，可能正好在面板底下；用 Shift+Tab 往回走時，往上捲的位移又會讓面板滑回來。
     * @param {{el: Element, topPx: number}} p @param {Element | null} el @returns {boolean}
     */
    function hides(p, el) {
        if (!el || el === document.body || p.el.contains(el) || !el.matches(':focus-visible')) return false;
        var r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < p.topPx * (p.el.currentCSSZoom || 1) + p.el.getBoundingClientRect().height;
    }

    function init() {
        var nodes = document.querySelectorAll('[data-autohide-filters]');
        if (!nodes.length) return;

        var mq = window.matchMedia(MOBILE);
        var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

        for (var i = 0; i < nodes.length; i++) panels.push(setup(nodes[i]));

        function applyTransition() {
            // 尊重使用者的減少動態偏好：仍然讓開空間，只是不做動畫
            var t = reduce.matches ? 'none' : 'transform .22s cubic-bezier(.4,0,.2,1)';
            for (var i = 0; i < panels.length; i++) panels[i].el.style.transition = t;
        }
        applyTransition();
        if (reduce.addEventListener) reduce.addEventListener('change', applyTransition);

        // 焦點移進讓開或正在滑回來的面板時，瀏覽器照它在畫面外的位置把元素捲到畫面中間，
        // 360x740 時整頁往上跳約 400px（#202）。在瀏覽器捲動之前，先不帶動畫把面板放回去。
        function revealNow(p) {
            p.el.style.transition = 'none';
            reveal(p);
            // 讀一次樣式，位移立刻生效，接著放回轉場也不會再動畫。
            window.getComputedStyle(p.el).transform;
            applyTransition();
        }
        // 容器快捲完時面板被往上推，桌機寬度也一樣。元素被 header 蓋住時瀏覽器不捲，在畫面上方時捲到
        // 畫面中段。要自己捲到 header 下方，多留 8px 給焦點框。
        function uncover(p, target) {
            var dy = target.getBoundingClientRect().top - p.topPx * (p.el.currentCSSZoom || 1);
            if (dy < 8) window.scrollBy({ top: dy - 8, behavior: 'instant' });
        }
        // 用滑鼠或觸控點面板時，焦點在 mousedown 移動。這時放回面板，click 會落到別的元素上。
        var pressing = false;
        document.addEventListener('mousedown', function () {
            pressing = true;
            window.setTimeout(function () { pressing = false; }, 0);
        }, true);
        // 先前有焦點的話，focusout 時焦點還沒移動。
        document.addEventListener('focusout', function (e) {
            if (!e.relatedTarget) unpad();
            if (pressing) return;
            if (e.relatedTarget) pad(e.relatedTarget);
            for (var i = 0; i < panels.length; i++) {
                var p = panels[i];
                if (!p.el.contains(e.relatedTarget)) continue;
                if (shift(p) < 0) revealNow(p);
                uncover(p, e.relatedTarget);
            }
        }, true);
        // 沒有元素有焦點時按 Tab 不會有 focusout，focusin 的 relatedTarget 是 null。這時 Firefox 已經捲完，
        // Chromium 也排好了平滑捲動，要捲回按鍵當下的位置。
        var tabY = null;
        document.addEventListener('keydown', function (e) {
            // 點擊後馬上按鍵時，mousedown 排的 timer 可能還沒跑。
            pressing = false;
            if (e.key !== 'Tab') return;
            tabY = window.scrollY;
            window.setTimeout(function () { tabY = null; }, 0);
        }, true);
        document.addEventListener('focusin', function (e) {
            if (tabY === null || e.relatedTarget) return;
            // 瀏覽器已經照原來的 scroll-padding 排好捲動，要自己重捲一次。
            if (!panels.some(function (p) { return p.el.contains(e.target); })) {
                pad(e.target);
                window.scrollTo({ top: tabY, behavior: 'instant' });
                e.target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
                return;
            }
            for (var i = 0; i < panels.length; i++) {
                var p = panels[i];
                if (!p.el.contains(e.target)) continue;
                if (shift(p) < 0) {
                    revealNow(p);
                    window.scrollTo({ top: tabY, behavior: 'instant' });
                }
                uncover(p, e.target);
            }
        }, true);

        var lastY = window.scrollY || 0;
        var ticking = false;

        function onFrame() {
            ticking = false;
            var y = window.scrollY || 0;
            var dy = y - lastY;
            if (Math.abs(dy) < HYSTERESIS) return;
            lastY = y;

            var now = Date.now();
            for (var i = 0; i < panels.length; i++) {
                var p = panels[i];
                if (y < ARM_AFTER) { reveal(p); continue; }
                // 面板內有焦點時不可移走（可能是開著的下拉或正在輸入的搜尋框）
                if (p.el.contains(document.activeElement)) { reveal(p); continue; }
                if (!pinned(p)) { reveal(p); continue; }
                // 剛操作過篩選也一樣，面板不能蓋住鍵盤焦點。
                if (hides(p, document.activeElement)) { conceal(p); continue; }
                if (now - p.lastInteract < INTERACT_GRACE_MS) { reveal(p); continue; }
                if (dy > 0) conceal(p); else reveal(p);
            }
        }

        function onScroll() {
            if (ticking) return;
            ticking = true;
            window.requestAnimationFrame(onFrame);
        }

        function enable() {
            window.addEventListener('scroll', onScroll, { passive: true });
        }
        function disable() {
            window.removeEventListener('scroll', onScroll);
            for (var i = 0; i < panels.length; i++) reveal(panels[i]);
        }

        function sync() {
            if (mq.matches) enable(); else disable();
        }
        sync();
        fitAll();
        window.addEventListener('resize', fitAll);
        // 網頁字型載完後面板的高度會變。
        if (document.fonts) document.fonts.ready.then(fitAll);
        // 面板不再蓋住畫面上方時拿掉 pad() 設的 scroll-padding，不然錨點與 Page Down 也跟著讓開。
        var padCheck = false;
        window.addEventListener('scroll', function () {
            if (padCheck || !document.documentElement.style.scrollPaddingTop) return;
            padCheck = true;
            window.requestAnimationFrame(function () {
                padCheck = false;
                for (var i = 0; i < panels.length; i++) if (covers(panels[i])) return;
                unpad();
            });
        }, { passive: true });
        if (mq.addEventListener) mq.addEventListener('change', sync);
        else if (mq.addListener) mq.addListener(sync);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
