/**
 * 閘道的兩道限制。
 *
 * SlotGate——全站同時進行的任務數與排隊上限。WinLab 的 key 同時只收 8 個請求，
 * 超過回 429；預設只放 4 個（LLM_CONCURRENCY），另一半留給同一把 key 的其他服務
 * （ahp-match 也預設 4），兩邊合計剛好不超過。排隊滿了直接拒絕，不讓請求無限堆積——
 * xhigh 一個任務可能要好幾十秒，排得太長前端只會等到逾時。
 * （換版時新舊兩個 pod 會短暫重疊，合計可能超過 8，那幾分鐘內上游偶爾回 429，
 * 由續寫引擎的退避與前端的「稍後再試」吸收。）
 *
 * ClientLimiter——每個用戶端（IP）的速率與佔用量。同一間教室的學生通常共用學校的
 * 對外 IP，所以「同時進行數」只在名額已滿、新請求必須排隊時才檢查：GPU 有空就讓
 * 大家用，忙的時候才不讓一個來源把隊伍佔滿。真正保護 GPU 的是 SlotGate。
 *
 * 刻意接受的取捨：兩個來源就能佔滿全部名額與隊伍（預設 4 + 8，每個來源最多 6），
 * 第三個來源只會拿到 503。沒有身分驗證的公開服務，依來源的限制本來就擋不住握有多個 IP
 * 的人，把 CLIENT_MAX_INFLIGHT 壓得更低只會先傷到共用 NAT 的整班學生。
 *
 * 名額空出來時先給進行中任務最少的來源，一樣多的才照到達順序。只照到達順序的話，佔滿名額的
 * 來源只要隨時排著幾個請求，每個名額空出來都由它自己接手，別人排到逾時。這只決定排隊的人誰
 * 先輪到：名額沒滿時請求直接開始，閘道閒著時一個來源就能拿走全部名額，每個佔到任務結束。
 * 它佔住的名額最晚在任務的時限（tasks.mjs 的 timeoutMs，沒設就是 LLM_TASK_TIMEOUT_MS）內
 * 空出來，時限比 QUEUE_TIMEOUT_MS 長的任務，排隊的人會先逾時。次數上限（RATE_LIMIT_MAX）只計
 * 開始的任務，任務一長就擋不住這種佔法。
 */
import { isIP } from 'node:net';

export class LimitError extends Error {
    /**
     * @param {string} code  busy（排隊已滿或等太久）| rate_limited | too_many_inflight | aborted
     * @param {number} [retryAfter] 建議幾秒後再試
     */
    constructor(code, message, retryAfter) {
        super(message);
        this.name = 'LimitError';
        this.code = code;
        this.retryAfter = retryAfter;
    }
}

export class SlotGate {
    /**
     * @param {{concurrency: number, maxQueue: number, queueTimeoutMs: number}} options
     */
    constructor({ concurrency, maxQueue, queueTimeoutMs }) {
        this.concurrency = concurrency;
        this.maxQueue = maxQueue;
        this.queueTimeoutMs = queueTimeoutMs;
        this.inflight = 0;
        this.waiters = []; // 依到達順序：{ key, position, grant, onPosition, cleanup }
        this.running = new Map(); // 來源 → 進行中的任務數
    }

    get stats() {
        return { inflight: this.inflight, queued: this.waiters.length };
    }

    /** 名額全滿：新請求要嘛排隊、要嘛（隊伍也滿）被拒 */
    get saturated() {
        return this.inflight >= this.concurrency;
    }

    /**
     * 申請一個名額。排隊已滿時「同步」回傳 null，呼叫端才能在開始串流之前直接回 503；
     * 否則回傳 { queued, position, ready }：ready 兌現成 release()，用完一定要呼叫（重複呼叫無害）。
     * 排隊中的人離開（signal 中止）或等超過 queueTimeoutMs，ready 會以 LimitError 拒絕並讓出位置。
     *
     * 初始名次放在回傳值的 position（1 = 下一個就輪到），而不是同步呼叫 onPosition：
     * 呼叫端這時通常還沒開始串流，同步通知會被丟掉。onPosition 只通知之後的名次變動，
     * 而且它丟的例外會被吞掉——通知失敗不能讓 release() 跟著失敗、把名額卡死。
     * key 是來源（限流用的鍵），決定名額空出來時先給誰（見 #order）。名次依當下的順序算，
     * 進行中任務比較少的來源後來排進隊伍時，會排到前面，其他人的名次跟著往後。
     *
     * @param {{signal?: AbortSignal, onPosition?: (position: number) => void, key?: string}} [options]
     * @returns {{queued: boolean, position: number, ready: Promise<() => void>} | null}
     */
    tryEnter({ signal, onPosition, key = '' } = {}) {
        if (signal?.aborted) return { queued: false, position: 0, ready: handled(Promise.reject(new LimitError('aborted', '請求已取消'))) };
        if (this.inflight < this.concurrency) {
            this.inflight++;
            return { queued: false, position: 0, ready: Promise.resolve(this.#releaser(key)) };
        }
        if (this.waiters.length >= this.maxQueue) return null;
        const waiter = { key, position: 0, onPosition };
        const ready = new Promise((resolve, reject) => {
            const leave = (err) => {
                const i = this.waiters.indexOf(waiter);
                if (i === -1) return; // 已經輪到或已經離開
                this.waiters.splice(i, 1);
                waiter.cleanup();
                reject(err);
                this.#announcePositions();
            };
            const timer = setTimeout(
                () => leave(new LimitError('busy', `排隊超過 ${this.queueTimeoutMs}ms`, 30)),
                this.queueTimeoutMs,
            );
            // 排隊的計時器不該讓程序撐著不結束：正在服務的連線本來就會讓程序活著
            timer.unref();
            const onAbort = () => leave(new LimitError('aborted', '排隊中取消'));
            signal?.addEventListener('abort', onAbort, { once: true });
            waiter.cleanup = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            };
            waiter.grant = () => {
                waiter.cleanup();
                resolve(this.#releaser(key));
            };
            this.waiters.push(waiter);
        });
        this.#announcePositions(waiter);
        return { queued: true, position: waiter.position, ready: handled(ready) };
    }

    #releaser(key) {
        this.running.set(key, (this.running.get(key) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const left = this.running.get(key) - 1;
            if (left > 0) this.running.set(key, left);
            else this.running.delete(key);
            const next = this.#order()[0];
            if (next) {
                // 名額直接轉給下一位，inflight 不變
                this.waiters.splice(this.waiters.indexOf(next), 1);
                next.grant();
                this.#announcePositions();
            } else {
                this.inflight--;
            }
        };
    }

    // 輪到的順序：進行中任務最少的來源優先，一樣多的照到達順序（sort 是穩定的）
    #order() {
        const running = (waiter) => this.running.get(waiter.key) ?? 0;
        return [...this.waiters].sort((a, b) => running(a) - running(b));
    }

    // 名次改變的人才通知；fresh 是剛排進來的，名次放在 tryEnter 的回傳值
    #announcePositions(fresh) {
        this.#order().forEach((waiter, i) => {
            if (waiter.position === i + 1) return;
            waiter.position = i + 1;
            if (waiter === fresh) return;
            try {
                waiter.onPosition?.(waiter.position);
            } catch {
                // 見 tryEnter 的說明
            }
        });
    }
}

// 呼叫端晚一點才 await 也不會變成 unhandledRejection（Node 預設會讓程序結束）；
// 回傳的仍是原本那個 promise，await 照樣收到拒絕
function handled(promise) {
    promise.catch(() => {});
    return promise;
}

// 'a.b.c.d' → 32 位元無號整數；不是 IPv4 就回傳 null
function ipv4ToInt(address) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    if (parts.some((p) => p > 255)) return null;
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// 合法的 IPv6 位址（isIP 已驗過）展開成 8 個 16 位元整數；結尾可以是內嵌的 IPv4
function expandIPv6(address) {
    let text = address;
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (v4) {
        const n = ipv4ToInt(v4[1]);
        text = `${text.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const [head, tail] = text.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    const zeros = tail === undefined ? [] : Array(8 - headParts.length - tailParts.length).fill('0');
    return [...headParts, ...zeros, ...tailParts].map((part) => parseInt(part, 16));
}

/**
 * 把用戶端位址正規化成限流用的鍵。
 *   - IPv4 原樣；任何寫法的 IPv4 對應位址（::ffff:a.b.c.d、::ffff:cb00:7105、0:0:0:0:0:ffff:…）還原成 IPv4
 *   - IPv6 取 /64：一個用戶通常握有整段 /64，只看完整位址的話換個位址就繞過限制。
 *     握有 /56、/48 的用戶仍可輪流換用不同的 /64；改取更大的前綴，又會把同一家 ISP
 *     的不同用戶併成一個桶。維持 /64，真正擋住 GPU 被吃光的是 SlotGate
 *   - 帶埠、方括號、zone id 的寫法先剝掉；剝完仍不是 IP 就一律歸到 'invalid'
 *     （鍵的長度因此有上限，偽造的怪值也不會各自成為一個桶）
 */
export function clientKey(address) {
    let raw = String(address || '').trim().slice(0, 100);
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(raw);
    if (bracketed) raw = bracketed[1];
    else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(raw)) raw = raw.slice(0, raw.lastIndexOf(':'));
    raw = raw.replace(/%[\w.-]*$/, '');
    const version = isIP(raw);
    if (version === 4) return raw;
    if (version !== 6) return 'invalid';
    const groups = expandIPv6(raw);
    if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
        return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
    }
    return `${groups.slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/**
 * 「這個連線來源是不是我們信任的代理」的判斷，例如 createProxyMatcher(['10.42.0.1/32'])。
 * 只支援 IPv4（k3s 的 pod 網段與本機都是），IPv4 對應的 IPv6 位址（::ffff:a.b.c.d）先還原。
 * CIDR 寫錯時丟例外：設定錯了應該在啟動時就知道，而不是默默變成「誰都不信任」。
 */
export function createProxyMatcher(cidrs) {
    const ranges = cidrs.map((cidr) => {
        const [ip, bitsText = '32', extra] = String(cidr).trim().split('/');
        const base = ipv4ToInt(ip);
        const bits = /^\d{1,2}$/.test(bitsText) ? Number(bitsText) : NaN;
        if (base === null || extra !== undefined || !(bits >= 0 && bits <= 32)) throw new Error(`不合法的 IPv4 CIDR：${cidr}`);
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return { base: (base & mask) >>> 0, mask };
    });
    return (address) => {
        const value = ipv4ToInt(String(address || '').replace(/^::ffff:/i, ''));
        return value !== null && ranges.some((r) => ((value & r.mask) >>> 0) === r.base);
    };
}

export class ClientLimiter {
    /**
     * @param {{windowMs: number, max: number, maxInflight: number, maxClients?: number, now?: () => number}} options
     * now 預設用單調時鐘：系統校時（時鐘回撥）不會讓窗口錯亂、紀錄卡在「未來」清不掉
     */
    constructor({ windowMs, max, maxInflight, maxClients = 50_000, now = () => performance.now() }) {
        this.windowMs = windowMs;
        this.max = max;
        this.maxInflight = maxInflight;
        this.maxClients = maxClients;
        this.now = now;
        this.clients = new Map(); // key → { hits: number[], inflight: number }
    }

    /**
     * 只查不記：這個來源在窗口內的次數已經用完就丟 rate_limited，否則什麼都不做（不建立紀錄、
     * 不調整清除順序）。讀 body 之前先擋，已經被限流的來源就不必再替它收 body、解析、驗證。
     */
    check(key) {
        const entry = this.clients.get(key);
        if (!entry) return;
        const t = this.now();
        this.#expire(entry, t);
        if (entry.hits.length >= this.max) throw this.#rateLimited(entry, t);
    }

    /**
     * 檢查並登記一次請求。不通過丟 LimitError；被拒絕的請求不計入次數，免得被擋的人越試越久。
     * wouldQueue：名額已滿、這個請求得排隊。只有這時才檢查同一來源的佔用量。
     * 通過就回傳 { done, refund }（都可以重複呼叫）：
     *   done()    任務結束時呼叫，歸還佔用量
     *   refund()  這次請求最後沒用到 GPU（排隊已滿、排到逾時、排隊中離開或關機，或上游在第一個 token
     *             之前就回忙線、連不上或逾時）時呼叫，把次數退回去
     */
    admit(key, { wouldQueue = true } = {}) {
        const t = this.now();
        let entry = this.clients.get(key);
        if (entry) {
            // 重新插入，Map 的順序就是最近使用的順序，超量時從最舊的開始清
            this.clients.delete(key);
        } else {
            entry = { hits: [], inflight: 0 };
        }
        this.clients.set(key, entry);
        this.#expire(entry, t);

        if (wouldQueue && entry.inflight >= this.maxInflight) {
            this.#evict();
            throw new LimitError('too_many_inflight', `名額已滿時同一來源最多佔用 ${this.maxInflight} 個`, 10);
        }
        if (entry.hits.length >= this.max) {
            this.#evict();
            throw this.#rateLimited(entry, t);
        }
        entry.hits.push(t);
        entry.inflight++;
        this.#evict();
        let finished = false;
        let refunded = false;
        return {
            done: () => {
                if (finished) return;
                finished = true;
                entry.inflight--;
            },
            refund: () => {
                if (refunded) return;
                refunded = true;
                // hits 依時間排序；從後面找，通常就是最後一筆
                const i = entry.hits.lastIndexOf(t);
                if (i !== -1) entry.hits.splice(i, 1);
            },
        };
    }

    // 窗口外的紀錄移掉（hits 依時間排序）
    #expire(entry, t) {
        while (entry.hits.length && entry.hits[0] <= t - this.windowMs) entry.hits.shift();
    }

    #rateLimited(entry, t) {
        // 過期的紀錄已經移掉，這裡算出來至少 1 秒
        const retryAfter = Math.ceil((entry.hits[0] + this.windowMs - t) / 1000);
        return new LimitError('rate_limited', `每 ${this.windowMs}ms 最多 ${this.max} 次`, retryAfter);
    }

    // 記錄的用戶端太多（例如大量偽造來源）時，從最久沒出現的開始清掉沒有進行中任務的
    #evict() {
        if (this.clients.size <= this.maxClients) return;
        for (const [key, entry] of this.clients) {
            if (this.clients.size <= this.maxClients) break;
            if (entry.inflight === 0) this.clients.delete(key);
        }
    }

    // 定期清掉窗口內已經沒有紀錄、也沒有進行中任務的用戶端
    sweep() {
        const t = this.now();
        for (const [key, entry] of this.clients) {
            this.#expire(entry, t);
            if (entry.hits.length === 0 && entry.inflight === 0) this.clients.delete(key);
        }
    }
}
