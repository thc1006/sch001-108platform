#!/usr/bin/env node
/**
 * 測試用的最小靜態檔案伺服器。
 *
 * 存在的理由：Playwright 的 webServer 需要一個能自動啟動的伺服器，而原本的
 * `npm run serve` 用的是 `python -m http.server`——CI runner 不保證有 python，
 * 而且它需要人工另開一個 terminal。這支沒有任何相依套件。
 *
 * 用法：node scripts/static-server.mjs [port] [root]
 *
 * root 預設是 repo 根目錄（給 tests/fixtures 用）。site smoke test 則指向
 * .link-root，那裡把 dist/ 放在 /sch001-108platform/ 之下，重現 GitHub Pages
 * 的路徑命名空間——站台的連結都是根相對路徑，路徑對不上就測不出真實行為。
 */
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/static-server.mjs 的上一層＝repo 根目錄
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8000);
const ROOT = process.argv[3] ? path.resolve(REPO, process.argv[3]) : REPO;
// ROOT 的真實路徑，給底下的 symlink 防護比對用。啟動時 ROOT 可能還不存在
// （.link-root 要 build 完才有），解析不了就退回詞法值——那種情況下本來也沒有
// 東西可以服務，第一個請求會 404。
let REAL_ROOT = ROOT;
try {
    REAL_ROOT = realpathSync(ROOT);
} catch {
    /* ROOT 尚未存在 */
}
// 兩個前綴都自帶結尾分隔符。這不只是方便：少了分隔符就是經典的前綴繞法——ROOT 是
// …/ci-repair 時，…/ci-repair-evil 也會通過 startsWith(ROOT)。實測對照過，naive 版
// 會外洩、帶分隔符的不會。
//
// 自帶分隔符還有第二個作用：守衛可以寫成**單一條件**的 !x.startsWith(前綴)，不必再
// 補一個 x !== ROOT 的特例。那個特例正是 CodeQL 認不出這是 sanitizer 的原因——
// js/path-injection 認的是「path.resolve／realpath 正規化之後，對同一個變數做一次
// startsWith(根目錄) 檢查」這個形狀（見該查詢的官方說明），複合條件會讓它失配。
const ROOT_PREFIX = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
const REAL_ROOT_PREFIX = REAL_ROOT.endsWith(path.sep) ? REAL_ROOT : REAL_ROOT + path.sep;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.xml': 'application/xml; charset=utf-8',
};

const server = createServer(async (req, res) => {
    // 整個 handler 包起來。這支只在測試環境跑，但只要有一個未捕捉的例外，整個
    // 伺服器行程就會死掉——接下來每個測試都會以「連不上」失敗，真正的原因被蓋掉。
    // 實際踩過：decodeURIComponent('/%ZZ') 會拋 URIError 並帶走整個 server。
    try {
        const rawPath = (req.url || '/').split('?')[0];
        let urlPath;
        try {
            urlPath = decodeURIComponent(rawPath);
        } catch {
            res.writeHead(400).end('400 malformed URI');
            return;
        }
        if (urlPath.includes('\0')) {
            res.writeHead(400).end('400 NUL in path');
            return;
        }

        // 要根目錄本身時直接指向 index.html。這一行的目的不只是省一次 stat：
        // 它保證底下每一條路徑都**嚴格位於** ROOT 之下，於是兩道守衛都可以寫成
        // 單一條件的 startsWith，不必再補 x !== ROOT 的特例（見上方常數的說明）。
        let filePath = path.resolve(ROOT, '.' + urlPath);
        if (filePath === ROOT) filePath = path.join(ROOT, 'index.html');

        // 第一層（詞法）：path.resolve 把 ../ 收乾淨之後，必須落在 ROOT 之下。
        // 實測 13 種變體（含 win32 的反斜線 traversal 與各種百分比編碼）0 外洩。
        if (!filePath.startsWith(ROOT_PREFIX)) {
            res.writeHead(403).end('403');
            return;
        }

        try {
            const info = await stat(filePath);
            // 目錄 → index.html。ROOT 之下的目錄再接一段檔名仍在 ROOT 之下。
            if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
        } catch {
            res.writeHead(404).end('404 ' + urlPath);
            return;
        }

        // 第二層（實際路徑）：詞法比對擋得住 ../，擋不住「ROOT 內有一個 symlink
        // 指向 ROOT 外」——path.resolve 只做字串正規化，根本不看檔案系統。實測用
        // 一個指向 ROOT 外的 directory junction：補這一層之前是 200，之後是 403。
        //
        // 刻意放在 stat 之後：realpath 對不存在的路徑會丟例外，而那種路徑本來就該
        // 走上面的 404，不該在這裡變成 403。
        //
        // 解析結果覆寫回同一個變數，讓底下 readFile 讀的就是剛剛驗過的那條路徑：
        // 讀原本那個變數的話，驗的是 A、送的是 B，中間多一次路徑解析的空窗。
        try {
            filePath = await realpath(filePath);
        } catch {
            res.writeHead(404).end('404 ' + urlPath);
            return;
        }
        if (!filePath.startsWith(REAL_ROOT_PREFIX)) {
            res.writeHead(403).end('403');
            return;
        }

        // 仍然不是原子操作——realpath 與 readFile 是兩次獨立的系統呼叫，之間還有
        // TOCTOU 視窗（CodeQL 的 js/file-system-race 指的就是這件事）。要真的關掉
        // 得改用 file handle：open 一次之後只對 handle 做 stat/read。這支只綁
        // localhost、只服務 repo 內的測試資產、不進建置產物，所以停在「讀已驗過的
        // 路徑」這一層；真的要收，那是另一次改動的範圍。
        try {
            const body = await readFile(filePath);
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
            res.end(body);
        } catch {
            res.writeHead(404).end('404 ' + urlPath);
        }
    } catch (err) {
        // 走到這裡代表上面有沒想到的例外。回 500 而不是讓 server 死掉。
        console.error('handler 例外：' + (err && err.message));
        if (!res.headersSent) res.writeHead(500);
        res.end('500');
    }
});

server.listen(PORT, () => {
    console.log(`靜態伺服器：http://localhost:${PORT}  （根目錄 ${ROOT}）`);
});
