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
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/static-server.mjs 的上一層＝repo 根目錄
const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8000);
const ROOT = process.argv[3] ? path.resolve(REPO, process.argv[3]) : REPO;

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

        // path traversal 防護：解析後必須仍在 ROOT 之內。
        // （symlink 不在防護範圍內——這支只服務 repo 內的測試資產，不對外。）
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
