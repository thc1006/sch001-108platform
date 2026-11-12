// 生涯探索頁科系羅盤的科系（majorData 的 majors）取自 ColleGo! 各學群頁的主要學類，
// 全部學類抄在 collego-majors.json。majorData 是 JS 物件字面值，交給 vm 求值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const { clusters, aliases } = JSON.parse(read('./collego-majors.json'));
const PAGE = read('../src/pages/career-exploration/index.astro');
const CLUSTERS_TS = read('../src/data/clusters.ts');

const literal = PAGE.match(/const majorData = (\[[\s\S]*?\n\s*\]);/)?.[1];
const majorData = literal ? vm.runInThisContext(literal) : [];
// 本站學群名稱對 ColleGo! 的學群名稱與 current_college_id
const META = new Map([...CLUSTERS_TS.matchAll(/\bname: '([^']+)'.*\bcollegoId: (\d+), collegoName: '([^']+)'/g)]
    .map((m) => [m[1], { id: Number(m[2]), collegoName: m[3] }]));

test('對照資料的學群和 src/data/clusters.ts 的 10 個學群相同，collegoId 也相同', () => {
    assert.ok(literal, 'index.astro 找不到 const majorData = [...];');
    assert.equal(META.size, 10, 'clusters.ts 讀到的學群數不是 10');
    assert.deepEqual(Object.keys(clusters).sort(), [...META.values()].map((m) => m.collegoName).sort());
    for (const { id, collegoName } of META.values()) assert.equal(clusters[collegoName].collegoId, id, collegoName);
});

test('科系羅盤每個學群的連結指到 clusters.ts 的 collegoId', () => {
    assert.equal(majorData.length, META.size);
    for (const c of majorData) {
        assert.ok(META.has(c.name), `${c.name} 不在 clusters.ts`);
        assert.equal(c.url, `https://collego.edu.tw/Highschool/CollegeIntro?current_college_id=${META.get(c.name).id}`, c.name);
    }
});

test('科系羅盤的科系都是 ColleGo! 那個學群的主要學類，改寫的名稱要列在 aliases', () => {
    for (const c of majorData) {
        assert.ok(c.majors.length > 0, `${c.name}：沒有科系`);
        const collego = clusters[META.get(c.name).collegoName].majors;
        const mapped = c.majors.map((m) => aliases[m]?.major ?? m);
        for (const [i, m] of mapped.entries()) assert.ok(collego.includes(m), `${c.name}：${c.majors[i]} 不在 ColleGo! 的主要學類`);
        assert.equal(new Set(mapped).size, mapped.length, `${c.name}：有重複的科系`);
    }
});

test('aliases 的每一筆都有頁面在用，也寫了理由', () => {
    const used = new Set(majorData.flatMap((c) => c.majors));
    for (const [page, { major, reason }] of Object.entries(aliases)) {
        assert.ok(used.has(page), `aliases 的「${page}」頁面已經沒有用`);
        assert.notEqual(page, major, page);
        assert.ok(typeof reason === 'string' && reason.trim() !== '', `aliases 的「${page}」沒有寫 reason`);
    }
});
