// 卡片詳情對話框的共用行為。對話框是 <dialog>，用 showModal() 開啟，瀏覽器會把焦點移進去、
// 讓背景無法操作、按 Esc 關閉。這支補上其餘的事：點對話框外面關閉、開著時鎖住頁面捲動、
// 關閉後焦點回到開啟它的按鈕、分頁標籤用方向鍵切換。
//
// 使用：
//   const detail = DetailDialog.setup(document.getElementById('xxxModal'));
//   detail.open(button);
(function () {
    'use strict';

    function outside(dialog, e) {
        var r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    }

    // 鎖住頁面捲動。捲軸佔版面的瀏覽器上，捲軸消失會讓整頁往右移，所以把位置留著。
    function lockScroll(locked) {
        var root = document.documentElement;
        root.style.scrollbarGutter = locked && window.innerWidth > root.clientWidth ? 'stable' : '';
        document.body.style.overflow = locked ? 'hidden' : '';
    }

    // 左右鍵、Home、End 在 role="tab" 之間移動，焦點到哪一頁就切到哪一頁。
    // 帶修飾鍵的不處理，Alt+← 仍是上一頁。
    function onTabKey(e) {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        var tab = e.target.closest('[role="tab"]');
        if (!tab) return;
        var tabs = Array.prototype.slice.call(tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]'));
        var i = tabs.indexOf(tab);
        var to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (to === undefined) return;
        e.preventDefault();
        var next = tabs[(to + tabs.length) % tabs.length];
        next.focus();
        next.click();
    }

    /**
     * setup 讓 dialog 點外面會關閉、開著時鎖住頁面捲動、關閉後焦點回到開啟它的按鈕。
     * 每個 dialog 呼叫一次。
     * @param {HTMLDialogElement} dialog
     * @returns {{open: function(?HTMLElement=): void, close: function(): void}}
     *   open 的參數是關閉後要拿回焦點的元素，沒有就交給瀏覽器。
     */
    function setup(dialog) {
        var opener = null;
        dialog.tabIndex = -1;
        // 點在 ::backdrop 上時 target 是 dialog 本身。從對話框裡拖曳到外面放開也會在 dialog 觸發 click，
        // 所以按下的位置也要在外面。
        var pressedOutside = false;
        dialog.addEventListener('pointerdown', function (e) {
            pressedOutside = e.target === dialog && outside(dialog, e);
        });
        dialog.addEventListener('click', function (e) {
            if (pressedOutside && e.target === dialog && outside(dialog, e)) dialog.close();
        });
        // 瀏覽器會把焦點還給開啟前有焦點的元素，用滑鼠點卡片時那是 <body>。
        dialog.addEventListener('close', function () {
            lockScroll(false);
            if (opener && opener.isConnected) opener.focus();
            opener = null;
        });
        dialog.addEventListener('keydown', onTabKey);
        return {
            open: function (from) {
                opener = from || null;
                lockScroll(true);
                if (!dialog.open) dialog.showModal();
                // 畫面太矮時捲動的是對話框本身，換一筆內容要回到頂端。
                dialog.scrollTop = 0;
                // 焦點放在對話框本身，螢幕閱讀器從標題讀起。showModal() 會放在第一個按鈕「關閉」上，
                // 用滑鼠開啟也會出現焦點框。
                dialog.focus();
            },
            close: function () {
                dialog.close();
            },
        };
    }

    window.DetailDialog = { setup: setup };
})();
