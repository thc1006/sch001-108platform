import { readFileSync } from 'node:fs';
const INLINE = new Set(['a','span','strong','em','b','i','code','small','sup','sub','br','abbr','time','label','svg','path','img','use','g','circle','rect','line','text','tspan','ion-icon','mark','u','s']);
const [A,B] = process.argv.slice(2);
const a = JSON.parse(readFileSync(A,'utf8')), b = JSON.parse(readFileSync(B,'utf8'));
let blk=0, blkMoved=0, inl=0, inlMoved=0, blkX=0, blkW=0, blkY=0, blkH=0;
const docs=[]; const widened=[];
for (const p of Object.keys(a.pages)) {
  const ea=a.pages[p].els, eb=b.pages[p].els;
  if (!eb || ea.length!==eb.length) continue;
  docs.push([p, a.pages[p].docH, b.pages[p].docH]);
  for (let i=0;i<ea.length;i++){
    const [t,,x1,y1,w1,h1]=ea[i], [,,x2,y2,w2,h2]=eb[i];
    const dx=Math.abs(x2-x1), dy=Math.abs(y2-y1), dw=Math.abs(w2-w1), dh=Math.abs(h2-h1);
    const moved = Math.max(dx,dy,dw,dh) > 0.5;
    if (INLINE.has(t)) { inl++; if (moved) inlMoved++; }
    else {
      blk++; if (moved) blkMoved++;
      if (dx>0.5) blkX++; if (dw>0.5) blkW++; if (dy>0.5) blkY++; if (dh>0.5) blkH++;
      if (w2 > 1280.5) widened.push(`${p} ${t} w=${w2}`);
    }
  }
}
const dh = docs.filter(d=>d[1]!==d[2]);
const deltas = dh.map(d=>d[2]-d[1]);
const pct = dh.map(d=>((d[2]-d[1])/d[1]*100));
console.log(`${A.split('geom-')[1]} → ${B.split('geom-')[1]}`);
console.log(`  區塊元素 ${blk}：位移 ${blkMoved} (${(blkMoved/blk*100).toFixed(1)}%)  其中 Δx>0.5:${blkX}  Δw>0.5:${blkW}  Δy>0.5:${blkY}  Δh>0.5:${blkH}`);
console.log(`  行內元素 ${inl}：位移 ${inlMoved} (${(inlMoved/inl*100).toFixed(1)}%)  ← 換字型後文字重排，行內元素移動是預期的`);
console.log(`  頁面高度有變：${dh.length}/${docs.length} 頁；Δ 範圍 ${Math.min(...deltas,0)}~${Math.max(...deltas,0)}px；相對變化 ${Math.min(...pct,0).toFixed(2)}%~${Math.max(...pct,0).toFixed(2)}%`);
console.log(`  超出 1280px 視窗寬的區塊元素：${widened.length}${widened.length?' → '+widened.slice(0,3).join(' | '):''}`);
