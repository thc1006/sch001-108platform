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

        // path traversal 防護第一層（詞法）：解析後必須仍在 ROOT 之內。
        //
        // 結尾一定要接 path.sep。少了它就是經典的前綴繞法：ROOT 是
        // …/ci-repair 時，…/ci-repair-evil 也會通過 startsWith(ROOT)。
        // 實測 13 種變體（含 win32 的反斜線 traversal 與各種百分比編碼）0 外洩。
        const resolved = path.resolve(ROOT, '.' + urlPath);
        if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
            res.writeHead(403).end('403');
            return;
        }

        let file = resolved;
        try {
            const info = await stat(file);
            if (info.isDirectory()) file = path.join(file, 'index.html');
        } catch {
            res.writeHead(404).end('404 ' + urlPath);
            return;
        }

        // 第二層（實際路徑）：詞法比對擋得住 ../，擋不住「ROOT 內有一個 symlink
        // 指向 ROOT 外」——path.resolve 只做字串正規化，根本不看檔案系統。
        //
        // 刻意放在 stat 之後：realpath 對不存在的路徑會丟例外，而那種路徑本來就
        // 該走上面的 404，不該在這裡變成 403。
        try {
            const real = await realpath(file);
            if (real !== REAL_ROOT && !real.startsWith(REAL_ROOT + path.sep)) {
                res.writeHead(403).end('403');
                return;
            }
        } catch {
            res.writeHead(404).end('404 ' + urlPath);
            return;
        }

        try {
            const body = await readFile(file);
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
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
