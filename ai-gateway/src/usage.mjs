/**
 * 每小時一行的 USAGE log 要的計數，只在記憶體裡，換版或重啟就歸零。
 *
 * 計到達 /v1/tasks/<id> 的請求：各任務的請求數、開始串流的數目、依代號與原因的拒絕數、不同來源的個數。
 * 來源以 TASK 的 client 雜湊區分，最多記 maxSources 個，再多就寫成「10000+」。
 *
 * 另外依網段（IPv4 /24、IPv6 /48，limits.mjs 的 sourcePrefix）計通過限流、開始的任務數，退回次數的不算。
 * log 只列任務數超過 threshold 的網段：threshold 是一個來源在一段時間內最多能開始的任務數，所以列出來的
 * 網段一定有不只一個來源開了任務（學校的 NAT，或同一個人、同一群人用了同一段裡的多個位址）。
 *
 * 網段的表最多 capacity 個，滿了照 Space-Saving：換掉次數最少的那一個，新來的從它的次數加一算起，記下
 * 多算的部分（error）。列出與比較都用 count - error，這是確定的下限，換來換去也不會讓網段被多算。
 * 次數最少的那一個用最小堆找，每次 O(log capacity)。
 */

export class Usage {
    constructor({ capacity = 2_000, maxSources = 10_000, threshold = Infinity, now = Date.now } = {}) {
        Object.assign(this, { capacity, maxSources, threshold, now });
        this.reset();
    }

    reset() {
        this.since = this.now();
        this.records = 0;          // 這段時間記過幾筆，0 就是沒有東西可記
        this.requests = 0;
        this.accepted = 0;
        this.tasks = new Map();    // 任務 id → 請求數
        this.rejected = new Map(); // 代號或「代號/原因」→ 次數
        this.sources = new Set();  // client 雜湊
        this.moreSources = false;
        this.prefixes = new Map(); // 網段 → heap 裡的 { prefix, count, error, i }
        this.heap = [];            // 依 count 的最小堆
    }

    /** task 不在任務清單裡的一律傳 'unknown'：網址上的 id 是用戶端填的。tag 是 client 雜湊 */
    request(task, tag) {
        this.records++;
        this.requests++;
        add(this.tasks, task);
        if (this.sources.size < this.maxSources) this.sources.add(tag);
        else if (!this.sources.has(tag)) this.moreSources = true;
    }

    /** 通過限流、開始了一個任務 */
    start(prefix) {
        this.records++;
        let entry = this.prefixes.get(prefix);
        if (entry) {
            entry.count++;
            this.#down(entry.i);
        } else if (this.heap.length < this.capacity) {
            entry = { prefix, count: 1, error: 0, i: this.heap.length };
            this.heap.push(entry);
            this.prefixes.set(prefix, entry);
            this.#up(entry.i);
        } else {
            entry = this.heap[0];
            this.prefixes.delete(entry.prefix);
            Object.assign(entry, { prefix, error: entry.count, count: entry.count + 1 });
            this.prefixes.set(prefix, entry);
            this.#down(0);
        }
    }

    /** 限流退回了次數（沒用到 GPU）。表裡沒有這個網段就不管：少算只會讓它更不會被列出來 */
    unstart(prefix) {
        const entry = this.prefixes.get(prefix);
        if (!entry || entry.count <= entry.error) return;
        entry.count--;
        this.#up(entry.i);
    }

    accept() {
        this.records++;
        this.accepted++;
    }

    /** 不屬於任何任務的拒絕（標頭太大的 431）也記在這裡，不算進 requests */
    reject(code, reason) {
        this.records++;
        add(this.rejected, reason ? `${code}/${reason}` : code);
    }

    /** 交出這段時間的 log 欄位並歸零 */
    take() {
        const top = this.heap.map(({ prefix, count, error }) => [prefix, count - error])
            .filter(([, sure]) => sure > this.threshold)
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
            .slice(0, 5)
            .map(([prefix, sure]) => `${prefix}:${sure}`);
        const fields = {
            from: new Date(this.since).toISOString(),
            requests: this.requests,
            accepted: this.accepted,
            rejected: list(this.rejected),
            tasks: list(this.tasks),
            sources: this.moreSources ? `${this.maxSources}+` : this.sources.size,
            top: top.join(','),
        };
        this.reset();
        return fields;
    }

    #up(i) {
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.heap[parent].count <= this.heap[i].count) return;
            this.#swap(i, parent);
            i = parent;
        }
    }

    #down(i) {
        for (;;) {
            let least = i;
            for (const child of [2 * i + 1, 2 * i + 2]) {
                if (child < this.heap.length && this.heap[child].count < this.heap[least].count) least = child;
            }
            if (least === i) return;
            this.#swap(i, least);
            i = least;
        }
    }

    #swap(a, b) {
        [this.heap[a], this.heap[b]] = [this.heap[b], this.heap[a]];
        this.heap[a].i = a;
        this.heap[b].i = b;
    }
}

function add(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
}

// 「名稱:次數」以逗號分隔，依名稱排序
function list(map) {
    return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, count]) => `${key}:${count}`).join(',');
}
