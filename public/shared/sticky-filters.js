/**
 * 手機上讓 sticky 篩選面板在向下捲動時讓開畫面
 * ================================================================
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
 * 還原。這是行動裝置上熟悉的模式，且保留「稍微往上滑就能改條件」的即時性——
 * 直接取消 sticky 會逼使用者一路捲回頂端才能改篩選，在 133 筆的清單上很痛。
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

    var panels = [];

    function setup(el) {
        var cs = window.getComputedStyle(el);
        // 讀出它釘在哪個高度，位移量才算得準（各頁 top 不同：68px / 76px）
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

        return p;
    }

    function reveal(p) {
        if (!p.hidden) return;
        p.hidden = false;
        p.el.style.transform = '';
    }

    function conceal(p) {
        if (p.hidden) return;
        // 面板本身高度 ＋ 它與視窗頂端的距離，才能完全離開畫面
        var h = p.el.getBoundingClientRect().height;
        p.hidden = true;
        p.el.style.transform = 'translateY(-' + Math.ceil(h + p.topPx + 2) + 'px)';
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
                if (now - p.lastInteract < INTERACT_GRACE_MS) { reveal(p); continue; }
                // 面板內有焦點時不可移走（可能是開著的下拉或正在輸入的搜尋框）
                if (p.el.contains(document.activeElement)) { reveal(p); continue; }
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
        if (mq.addEventListener) mq.addEventListener('change', sync);
        else if (mq.addListener) mq.addListener(sync);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
