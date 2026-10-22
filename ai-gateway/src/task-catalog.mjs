/**
 * 正式上線的任務清單。每個網站 AI 功能遷移過來時，在同一個 commit 裡把 prompt 從
 * 頁面搬到這裡——diff 上看得到「從頁面刪掉、在這裡加上」，確認是搬移而不是改寫。
 *
 * 格式見 tasks.mjs 的 defineTask。
 */
export const TASK_DEFINITIONS = [];
