/**
 * 外部連結健檢的共用核心（含 SSRF 防護）
 * --------------------------------------------------------------
 * 本專案有兩處需要判斷「這個外部網址還活著嗎」：競賽資料看門狗
 * （check-competitions.mjs）與全站外部連結健檢（check-external-links.mjs）。
 * 兩者的語意必須一致，否則同一個網址在不同報告裡會得到不同結論；更重要的是
 * 兩者都會在 GitHub runner 上、帶著 issues:write 的 token 去連我們 repo 資料
 * 裡寫的任意網址——那是一條 SSRF 路徑，防護只寫在其中一邊等於沒寫。
 *
 * 由 link-health.test.mjs 以本機 http server 做確定性測試（不依賴外網——
 * 外網測試會因防爬與站台狀態而飄）。
 *
 * ── 為什麼不用 fetch() ──
 * fetch（undici）沒有辦法把「我驗過的那個 IP」交給連線層：只能先自己
 * dns.lookup 驗一次，再讓 fetch 自己重查一次 DNS。兩次查詢之間的窗口正是
 * DNS rebinding 的攻擊面——第一次回公網 IP 通過檢查，第二次回 169.254.169.254。
 * node:http / node:https 的 request options 支援自訂 `lookup`，可以把驗證過的
 * 位址「原封不動」交給 net.connect，連的就是驗過的那個 IP，窗口不存在。
 * （已實測：Node 24 會以 { hints: 0, all: true } 呼叫 lookup，並接受回傳陣列。）
 *
 * 另外 fetch 的 redirect: 'follow' 是黑箱——中途每一跳的目的地都不會經過我們
 * 手上。這裡一律 redirect 手動處理，每一跳都重新跑完整的位址檢查。
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

// ── 分類門檻 ──
// 只有「網域解析不到」與 404/410 才算失效。競賽與教育網站大量使用 Cloudflare 等
// 防爬機制，403/429/5xx/逾時在瀏覽器多半仍開得起來，一律歸入「無法判定」只做
// 記錄，避免每週誤報把維護者訓練成忽略通知。
export const DEAD_STATUSES = new Set([404, 410]);
export const LINK_TIMEOUT_MS = 20_000;
export const MAX_REDIRECTS = 5;

// 目的是「重現使用者用瀏覽器點下去的結果」。不少站台對非瀏覽器 UA 會回 403/404，
// 用一般爬蟲 UA 會產生大量誤判，故沿用瀏覽器 UA。
export const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// keepAlive: false——這是一次上百站的批次工作，連線池留著沒有好處，而且
// 每次都重新建立連線可確保「每一次連線都走過我們驗過的位址」，不會沿用池中
// 的舊 socket。
const AGENTS = {
    'http:': new http.Agent({ keepAlive: false, maxSockets: 64 }),
    'https:': new https.Agent({ keepAlive: false, maxSockets: 64 }),
};

// ──────────────────────────────────────────────────────────────
// SSRF 防護：位址政策
// ──────────────────────────────────────────────────────────────

/** 只允許這兩種 scheme。file:、gopher:、ftp: 等一律拒絕。 */
export const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * IPv4 封鎖網段。用 CIDR 表達而不是逐個 IP 比對——169.254.169.254 只是
 * link-local 網段裡最有名的那一個，AWS / GCP / Azure / Alibaba 的 metadata
 * 端點全都落在 169.254.0.0/16，逐個列舉一定會漏。
 */
const BLOCKED_IPV4 = [
    ['0.0.0.0/8', '本網路（0.0.0.0 在多數系統上等同 localhost）'],
    ['10.0.0.0/8', '私有網段'],
    ['100.64.0.0/10', 'CGNAT 共用位址'],
    ['127.0.0.0/8', 'loopback'],
    ['169.254.0.0/16', 'link-local（含 169.254.169.254 雲端 metadata）'],
    ['172.16.0.0/12', '私有網段'],
    ['192.0.0.0/24', 'IETF 協定保留'],
    ['192.0.2.0/24', '文件用 TEST-NET-1'],
    ['192.88.99.0/24', '6to4 relay anycast'],
    ['192.168.0.0/16', '私有網段'],
    ['198.18.0.0/15', 'benchmark 保留'],
    ['198.51.100.0/24', '文件用 TEST-NET-2'],
    ['203.0.113.0/24', '文件用 TEST-NET-3'],
    ['224.0.0.0/4', 'multicast'],
    ['240.0.0.0/4', '保留（含 255.255.255.255 廣播）'],
];

/** 只有 loopback 這一段可以被 allowLoopback 放行——其餘一律不可放行。 */
const LOOPBACK_V4 = '127.0.0.0/8';

const cidrToRange = (cidr) => {
    const [addr, bitsRaw] = cidr.split('/');
    const bits = Number(bitsRaw);
    const base = ipv4ToInt(addr);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { base: (base & mask) >>> 0, mask };
};

function ipv4ToInt(addr) {
    const parts = addr.split('.').map(Number);
    return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

const BLOCKED_IPV4_RANGES = BLOCKED_IPV4.map(([cidr, why]) => ({ cidr, why, ...cidrToRange(cidr) }));

/** 把合法的 IPv6 字串轉成 16 bytes。輸入須先過 net.isIPv6()。 */
export function ipv6ToBytes(text) {
    if (!net.isIPv6(text)) return null;
    let s = text;
    // 尾端內嵌 IPv4（::ffff:127.0.0.1、64:ff9b::8.8.8.8）先折成兩組 16 bit
    const lastColon = s.lastIndexOf(':');
    const tail = s.slice(lastColon + 1);
    if (tail.includes('.')) {
        if (!net.isIPv4(tail)) return null;
        const v = tail.split('.').map(Number);
        s = `${s.slice(0, lastColon + 1)}${((v[0] << 8) | v[1]).toString(16)}:${((v[2] << 8) | v[3]).toString(16)}`;
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const back = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
    let groups;
    if (back === null) {
        if (head.length !== 8) return null;
        groups = head;
    } else {
        const fill = 8 - head.length - back.length;
        if (fill < 0) return null;
        groups = [...head, ...Array(fill).fill('0'), ...back];
    }
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
        const v = Number.parseInt(groups[i], 16);
        if (!Number.isInteger(v) || v < 0 || v > 0xffff) return null;
        bytes[i * 2] = v >> 8;
        bytes[i * 2 + 1] = v & 0xff;
    }
    return bytes;
}

const allZero = (bytes, from, to) => {
    for (let i = from; i < to; i++) if (bytes[i] !== 0) return false;
    return true;
};

/**
 * 這個位址可不可以連？回傳 null 代表允許，否則回傳封鎖理由。
 *
 * IPv6 不是「順便支援」：runner 上 `localhost` 解析出來的第一個位址就是 ::1
 * （已實測），只擋 IPv4 等於門開著。IPv4-mapped（::ffff:127.0.0.1）、6to4
 * （2002::/16）、NAT64（64:ff9b::/96）都會把 IPv4 位址包進 IPv6 裡，必須
 * 先拆出來再套 IPv4 規則，否則等於繞過整份 IPv4 清單。
 *
 * @param {string} ip
 * @param {{allowLoopback?: boolean}} [opts]
 * @returns {string|null}
 */
export function blockedAddressReason(ip, opts = {}) {
    const allowLoopback = opts.allowLoopback === true;

    if (net.isIPv4(ip)) {
        const n = ipv4ToInt(ip);
        for (const r of BLOCKED_IPV4_RANGES) {
            if (((n & r.mask) >>> 0) === r.base) {
                if (allowLoopback && r.cidr === LOOPBACK_V4) return null;
                return `${ip} 落在 ${r.cidr} — ${r.why}`;
            }
        }
        return null;
    }

    if (!net.isIPv6(ip)) return `無法辨識的位址：${ip}`;
    const b = ipv6ToBytes(ip);
    if (!b) return `無法解析的 IPv6 位址：${ip}`;

    // ::（未指定）與 ::1（loopback）
    if (allZero(b, 0, 16)) return `${ip} 是 IPv6 未指定位址 ::`;
    if (allZero(b, 0, 15) && b[15] === 1) {
        return allowLoopback ? null : `${ip} 是 IPv6 loopback ::1`;
    }
    // IPv4-mapped ::ffff:0:0/96 與已廢止的 IPv4-compatible ::a.b.c.d
    if (allZero(b, 0, 10) && ((b[10] === 0xff && b[11] === 0xff) || (b[10] === 0 && b[11] === 0))) {
        const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
        const why = blockedAddressReason(v4, opts);
        return why ? `${ip} 內含 IPv4 ${why}` : null;
    }
    // NAT64 64:ff9b::/96
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) {
        const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
        const why = blockedAddressReason(v4, opts);
        return why ? `${ip}（NAT64）內含 IPv4 ${why}` : null;
    }
    // 6to4 2002::/16——內嵌的 IPv4 在 bytes 2..5
    if (b[0] === 0x20 && b[1] === 0x02) {
        const v4 = `${b[2]}.${b[3]}.${b[4]}.${b[5]}`;
        const why = blockedAddressReason(v4, opts);
        return why ? `${ip}（6to4）內含 IPv4 ${why}` : `${ip} 是 6to4 位址（2002::/16）`;
    }
    // Teredo 2001:0000::/32——同樣把 IPv4 隧道包在裡面
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return `${ip} 是 Teredo 隧道位址（2001::/32）`;
    // 2001:db8::/32 文件用
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return `${ip} 是文件用位址（2001:db8::/32）`;
    // 100::/64 discard-only
    if (b[0] === 0x01 && b[1] === 0x00 && allZero(b, 2, 8)) return `${ip} 是 discard-only 位址（100::/64）`;
    // fc00::/7 unique local
    if ((b[0] & 0xfe) === 0xfc) return `${ip} 落在 fc00::/7（unique local）`;
    // fe80::/10 link-local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return `${ip} 落在 fe80::/10（link-local）`;
    // ff00::/8 multicast
    if (b[0] === 0xff) return `${ip} 落在 ff00::/8（multicast）`;

    return null;
}

/**
 * 一律封鎖的主機名。位址檢查其實已經涵蓋 169.254.169.254，這裡是第二層：
 * 雲端 metadata 的名稱在不同環境可能解析到不同位址，而且名稱本身出現在我們的
 * 資料檔裡就已經是一個必須有人看到的訊號，不該只是「解析後剛好被擋掉」。
 */
const BLOCKED_HOST_EXACT = new Set([
    'localhost',
    'metadata',
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
    'instance-data.ec2.internal',
]);

/** 這些是保留／內網專用的名稱空間，不可能是我們要驗的公開教育資源。 */
const BLOCKED_HOST_SUFFIX = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.intranet', '.corp', '.lan', '.private'];

/** 去掉 IPv6 的中括號與結尾的點，取得可比對的主機名。 */
export function canonicalHost(hostname) {
    let h = String(hostname || '').toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    while (h.endsWith('.')) h = h.slice(0, -1);
    return h;
}

/**
 * 不需要 DNS 的靜態網址政策。之所以要能單獨執行：這一層可以在 PR 階段確定性地
 * 跑（見 check-link-policy.mjs），把「有人在資料檔裡寫 http://169.254.169.254/」
 * 擋在合併之前，而不是等到每週排程跑到才發現。DNS 那一層無法確定性重現，
 * 只能在實際探測時做。
 *
 * @param {string} raw
 * @param {{allowLoopback?: boolean}} [opts]
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
export function staticUrlPolicy(raw, opts = {}) {
    let url;
    try {
        url = new URL(String(raw));
    } catch {
        return { ok: false, reason: `不是合法的網址：${String(raw).slice(0, 120)}` };
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
        return { ok: false, reason: `只允許 http/https，實際為 ${url.protocol}` };
    }
    if (url.username || url.password) {
        // 不要把帳密回顯到報告或 issue 裡
        return { ok: false, reason: '網址內嵌帳號密碼（credential），一律拒絕' };
    }
    const host = canonicalHost(url.hostname);
    if (!host) return { ok: false, reason: '網址沒有主機名' };
    if (BLOCKED_HOST_EXACT.has(host)) {
        if (!(opts.allowLoopback === true && host === 'localhost')) {
            return { ok: false, reason: `主機名 ${host} 在封鎖清單內（loopback／雲端 metadata）` };
        }
    }
    for (const suffix of BLOCKED_HOST_SUFFIX) {
        if (host.endsWith(suffix)) {
            if (opts.allowLoopback === true && suffix === '.localhost') break;
            return { ok: false, reason: `主機名 ${host} 使用保留名稱空間 ${suffix}` };
        }
    }
    // 主機名本身就是 IP 字面值時，這裡就能判定，不必等 DNS。
    // new URL() 會把 http://2130706433/、http://0177.0.0.1/ 正規化成 127.0.0.1，
    // 所以十進位／八進位／十六進位的混淆寫法在這一關就會現形（已實測）。
    const literal = net.isIP(host) ? host : null;
    if (literal) {
        const why = blockedAddressReason(literal, opts);
        if (why) return { ok: false, reason: why };
    }
    return { ok: true, url };
}

/**
 * 解析主機名並驗證「每一個」解析結果。
 *
 * 為什麼是「每一個」而不是「挑一個能用的」：一個主機名同時解析出公網與私網位址
 * 本身就是可疑訊號，而 Node 24 的 Happy Eyeballs 會依序嘗試清單裡的位址——
 * 只要放行一個私網位址，連線就可能真的連到它。全部通過才放行。
 *
 * 回傳的 addresses 會原封不動交給 net.connect 的 lookup，所以「驗過的位址」與
 * 「實際連線的位址」是同一份，中間沒有第二次 DNS 查詢的窗口。
 *
 * @returns {Promise<{ok: true, addresses: {address:string,family:number}[]} | {ok: false, reason: string, code?: string}>}
 */
export async function resolveAndVerify(host, opts = {}) {
    let addresses;
    try {
        addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    } catch (err) {
        // Windows 的 getaddrinfo 對「查無此名」有時回 ENOENT 而非 ENOTFOUND（已實測：
        // 同一台機器上 .invalid 回 ENOTFOUND、某些 NODATA 情況回 ENOENT）。兩者語意
        // 相同，正規化成 ENOTFOUND，讓本機與 Linux runner 的分類結果一致。
        // EAI_AGAIN 是「暫時失敗」，刻意不正規化——那屬於 unverified，不是 dead。
        const code = err?.code === 'ENOENT' ? 'ENOTFOUND' : err?.code || 'EDNS';
        return { ok: false, code, reason: `無法解析主機名 ${host}（${code}）` };
    }
    if (!addresses.length) return { ok: false, code: 'ENOTFOUND', reason: `主機名 ${host} 沒有解析出任何位址` };
    for (const a of addresses) {
        const why = blockedAddressReason(a.address, opts);
        if (why) return { ok: false, reason: `${host} 解析到被封鎖的位址：${why}` };
    }
    return { ok: true, addresses };
}

/** probe 回傳被封鎖時的形狀，讓呼叫端不必比對字串。 */
export const isBlockedResult = (r) => Boolean(r && r.blocked === true);

const blockedResult = (reason, url) => ({ status: 0, code: 'EBLOCKED', blocked: true, reason, url });

// ──────────────────────────────────────────────────────────────
// 探測
// ──────────────────────────────────────────────────────────────

/** 會被視為轉址的狀態碼。308/307 保留方法，301/302/303 一律降為 GET——這裡本來就只送 GET。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 送出單一次請求（不跟隨轉址），連線位址已由呼叫端驗證並釘死。
 * 只讀 status 與 location，body 立刻丟棄：Node 不像瀏覽器會積極回收未消耗的
 * response body，在這種一次上百站的批次工作下會占住連線甚至卡死。
 */
function requestOnce(url, addresses, signal) {
    return new Promise((resolve) => {
        const mod = url.protocol === 'https:' ? https : http;
        let settled = false;
        const done = (v) => {
            if (settled) return;
            settled = true;
            resolve(v);
        };
        let req;
        try {
            req = mod.request(
                {
                    protocol: url.protocol,
                    hostname: canonicalHost(url.hostname),
                    port: url.port || (url.protocol === 'https:' ? 443 : 80),
                    path: `${url.pathname}${url.search}`,
                    method: 'GET',
                    agent: AGENTS[url.protocol],
                    signal,
                    // 這一行就是 DNS 釘選：把已驗證的位址原封不動交給 net.connect，
                    // 不再查一次 DNS，因此不存在「驗完到連線之間被換掉」的窗口。
                    lookup: (_hostname, lookupOpts, cb) => {
                        if (lookupOpts && lookupOpts.all) return cb(null, addresses);
                        cb(null, addresses[0].address, addresses[0].family);
                    },
                    headers: {
                        Host: url.host,
                        'User-Agent': UA,
                        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        Connection: 'close',
                    },
                },
                (res) => {
                    const status = res.statusCode;
                    const location = res.headers?.location;
                    // 先取值再丟棄；destroy 之後才 resolve，避免殘留的 socket 事件
                    res.destroy();
                    done({ status, location });
                },
            );
        } catch (err) {
            return done({ status: 0, code: err?.code || 'EREQUEST', message: String(err?.message || err).slice(0, 160) });
        }
        req.on('error', (err) => {
            const code = err?.code || err?.cause?.code || (err?.name === 'AbortError' ? 'ABORT_ERR' : '');
            done({ status: 0, code, message: String(err?.message || err).slice(0, 160) });
        });
        req.end();
    });
}

/**
 * 探測一個網址，手動跟隨轉址，且**每一跳都重新跑完整的位址檢查**。
 *
 * 為什麼不用 redirect: 'follow'：轉址是最典型的 SSRF 繞道——起點是一個無害的
 * 公開網域，302 到 http://169.254.169.254/latest/meta-data/。只驗第一跳等於沒驗。
 *
 * 一律用 GET：目的是重現「使用者用瀏覽器點下去」的結果，而 HEAD 不是瀏覽器實際
 * 送的請求。曾用 HEAD 省流量，但站台對 HEAD 的回應並不可靠——有的不支援而回
 * 404/500（Kaggle、tpmso.org），更糟的是有的 HEAD 回 200 但 GET 其實 404，
 * 會被誤判為健康。
 *
 * @param {string} rawUrl
 * @param {AbortSignal} [signal]
 * @param {{allowLoopback?: boolean, maxRedirects?: number}} [opts]
 * @returns {Promise<object>} 一定 resolve，不會 throw
 */
export async function probe(rawUrl, signal, opts = {}) {
    const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
    const abort = signal ?? AbortSignal.timeout(LINK_TIMEOUT_MS);
    const chain = [];

    let current = String(rawUrl);
    for (let hop = 0; hop <= maxRedirects; hop++) {
        // ① 靜態政策：scheme、credential、字面 IP、保留主機名
        const statik = staticUrlPolicy(current, opts);
        if (!statik.ok) {
            return { ...blockedResult(statik.reason, current), redirects: chain, hop };
        }
        const url = statik.url;

        // ② DNS：解析出來的每一個位址都要過關，並把該份位址釘給連線層
        const resolved = await resolveAndVerify(canonicalHost(url.hostname), opts);
        if (!resolved.ok) {
            if (resolved.code) {
                // 解析不到不是封鎖，是「這個網域不存在」——分類上屬於 dead
                return { status: 0, code: resolved.code, message: resolved.reason, finalUrl: url.href, redirects: chain };
            }
            return { ...blockedResult(resolved.reason, url.href), redirects: chain, hop };
        }

        const r = await requestOnce(url, resolved.addresses, abort);
        if (r.status === 0) {
            return { ...r, finalUrl: url.href, redirects: chain, addresses: resolved.addresses.map((a) => a.address) };
        }
        if (!REDIRECT_STATUSES.has(r.status) || !r.location) {
            return {
                status: r.status,
                finalUrl: url.href,
                redirects: chain,
                addresses: resolved.addresses.map((a) => a.address),
            };
        }
        if (hop === maxRedirects) {
            return { status: 0, code: 'ETOOMANYREDIRECTS', message: `轉址超過 ${maxRedirects} 次`, finalUrl: url.href, redirects: chain };
        }
        let next;
        try {
            next = new URL(r.location, url).href;
        } catch {
            return { status: r.status, finalUrl: url.href, redirects: chain, message: `無法解析的 Location：${String(r.location).slice(0, 120)}` };
        }
        chain.push({ from: url.href, status: r.status, to: next });
        current = next;
    }
    /* c8 ignore next */
    return { status: 0, code: 'ETOOMANYREDIRECTS', message: '轉址超過上限', redirects: chain };
}

/** 網域解析不到＝連結確定失效；其餘連線層錯誤（TLS、逾時等）歸為無法判定。 */
export const isDeadResult = (r) => !isBlockedResult(r) && (r.code === 'ENOTFOUND' || DEAD_STATUSES.has(r.status));

/**
 * healthy / dead / unverified 三態。三態是刻意的：把「驗不到」與「確定壞了」分開。
 *
 * 被 SSRF 政策擋下的網址歸入 unverified——我們確實沒驗到它，說它 dead 是編造。
 * 但呼叫端必須另外用 isBlockedResult() 把它挑出來單獨大聲報告，不可混在
 * 「多為防爬、不需處理」那一堆裡（見 check-external-links.mjs）。
 */
export function classifyLink(r) {
    if (isDeadResult(r)) return 'dead';
    if (isBlockedResult(r)) return 'unverified';
    if (r.status === 0 || r.status >= 400) return 'unverified';
    return 'healthy';
}

/** 人類可讀的原因描述，報告與 summary 共用。 */
export function describeResult(r) {
    if (isBlockedResult(r)) return `位址政策封鎖：${r.reason}`;
    if (r.code === 'ENOTFOUND') return '網域無法解析';
    if (r.code === 'ETOOMANYREDIRECTS') return '轉址次數超過上限';
    if (r.code === 'ABORT_ERR' || r.code === 'ETIMEDOUT' || r.code === 'ERR_SOCKET_CONNECTION_TIMEOUT') return '連線逾時';
    if (r.status) return `HTTP ${r.status}`;
    return r.code || '連線失敗';
}

/**
 * 批次探測。併發、全域時間預算、判定失效前的重試、起點輪替都在這裡，供所有
 * 檢查器共用，避免各自複製一份而漸漸長出不同語意。
 *
 * 回傳 { results, skipped }：results[i] 對應 urls[i]（未檢查者為 null），
 * skipped 為因預算用盡而未檢查的筆數——呼叫端必須據此避免宣稱「全部正常」。
 *
 * @param {string[]} urls
 * @param {{concurrency?:number, budgetMs?:number, timeoutMs?:number, rotateSeed?:number, probeFn?:Function, allowLoopback?:boolean}} [opts]
 */
export async function runProbes(urls, opts = {}) {
    const concurrency = opts.concurrency ?? 4; // 部分站台（如 tpmso.org）併發過高會回 5xx
    const budgetMs = opts.budgetMs ?? 8 * 60_000;
    const timeoutMs = opts.timeoutMs ?? LINK_TIMEOUT_MS;
    const probeFn = opts.probeFn ?? probe;
    const probeOpts = { allowLoopback: opts.allowLoopback === true };

    const results = new Array(urls.length).fill(null);
    if (urls.length === 0) return { results, skipped: 0 };

    const budgetEnd = Date.now() + budgetMs;
    const remaining = () => budgetEnd - Date.now();
    const outOfBudget = () => remaining() <= 0;

    // 硬截止：單筆逾時取「剩餘預算」與 timeoutMs 的較小值，並疊上全域 abort，避免
    // 最後一筆在預算末端才起跑、又獨自跑滿逾時而超出預算。
    const globalAbort = new AbortController();
    const budgetTimer = setTimeout(() => globalAbort.abort(), budgetMs);
    const probeWithin = (url) =>
        probeFn(
            url,
            AbortSignal.any([globalAbort.signal, AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, remaining())))]),
            probeOpts,
        );

    // 每次從不同位置起跑。若 runner 網路變差而經常用完預算，固定從 0 開始會讓清單
    // 尾端永遠檢查不到；輪替起點可讓覆蓋率長期均勻。
    const seed = opts.rotateSeed ?? 0;
    const startAt = ((seed % urls.length) + urls.length) % urls.length;
    const order = urls.map((_, i) => (startAt + i) % urls.length);

    let cursor = 0;
    try {
        await Promise.all(
            Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
                while (cursor < order.length && !outOfBudget()) {
                    const slot = order[cursor++];
                    results[slot] = await probeWithin(urls[slot]);
                }
            }),
        );

        // 判定失效前再單獨重試一次，濾掉併發造成的暫時性錯誤。
        // 被政策擋下的不重試——重試一百次也一樣會被擋，只是白白多送一次 DNS。
        for (let i = 0; i < results.length; i++) {
            if (results[i] && isDeadResult(results[i]) && !outOfBudget()) {
                results[i] = await probeWithin(urls[i]);
            }
        }
    } finally {
        clearTimeout(budgetTimer);
    }

    return { results, skipped: results.filter((r) => r === null).length };
}
