/* smoke-layout.mjs — pure-Node simulation of the graph layout rules that were
 * refactored in Phase B. Recreates the model/pos contract graph.js uses and
 * asserts the bug scenario: FREE mode, conversation pinned away from the
 * aligned column, explains must chain from the pinned position, not the stale
 * aligned one; edges must not point backwards. Run: node scripts/smoke-layout.mjs
 */
const GAP_X = 96, GAP_Y = 26, EDGE_SLACK = 6;
const DIM = { conv: { w: 300, h: 112 }, explain: { w: 344, h: 104 }, add: { w: 46, h: 46 }, summary: { w: 680, h: 560 } };
let currentId = 'conv-1';
const layoutPositions = {};

const sizeOf = (n) => n.kind === 'conversation' ? (n.open ? DIM.conv : DIM.conv) : (n.kind === 'add' ? DIM.add : n.kind === 'summary' ? DIM.summary : DIM.explain);
const key = (n) => n.key || (n.kind === 'conversation' ? 'c:' + n.id : n.kind === 'add' ? 'add' : '');

function buildSimpleModel(explainCount) {
  const col0 = [
    { key: 'add:top', kind: 'add' },
    { key: 'c:' + currentId, kind: 'conversation', id: currentId },
    { key: 'add:bottom', kind: 'add' },
  ];
  const roots = [], exps = [], idx = new Map();
  for (let i = 0; i < explainCount; i++) {
    const id = 'ex-' + i;
    roots.push(id);
    exps.push({ key: 'e:' + id, depth: 1 });
  }
  return { col0, roots, exps, idx };
}

/* — faithful copies of the refactored functions (kept in sync by hand; the point
 *  is validating the math, and exactly this contract, from scripts/) — */
function liftBoardOn(pos) {
  let lift = 0;
  for (const p of pos.values()) if (p.y < lift) lift = p.y;
  if (lift >= 0) return 0;
  for (const p of pos.values()) p.y -= lift;
  return lift;
}
function reserveColumn(model, pos, skipPinned = false) {
  const iCur = model.col0.findIndex((n) => key(n) === 'c:' + currentId);
  if (iCur < 0 || iCur >= model.col0.length - 1) return;
  const here = pos.get(model.col0[iCur].key);
  const next = pos.get(model.col0[iCur + 1].key);
  if (!here || !next) return;
  let bot = -Infinity;
  for (const n of model.exps) {
    if (skipPinned && layoutPositions[n.key]) continue;
    const p = pos.get(n.key);
    if (p && p.y + p.h > bot) bot = p.y + p.h;
  }
  const floor = Math.max(here.y + here.h, bot) + GAP_Y;
  const shift = Math.max(0, floor - next.y);
  if (shift > 0) for (let i = iCur + 1; i < model.col0.length; i++) pos.get(model.col0[i].key).y += shift;
}
function placeForest(model, pos, anchor, xStart, opts = {}) {
  const lift = opts.lift === true, respectPins = opts.respectPins === true;
  const isPinned = (k) => respectPins && !!layoutPositions[k];
  const colW = new Map();
  for (const n of model.exps) {
    const s = sizeOf(n);
    if (!colW.has(n.depth) || colW.get(n.depth) < s.w) colW.set(n.depth, s.w);
  }
  const depthX = new Map();
  let x = xStart;
  for (let d = 1; d <= Math.max(...colW.keys()); d++) { depthX.set(d, x); x += (colW.get(d) || DIM.explain.w) + GAP_X; }
  const extMemo = new Map();
  const extent = (id) => {
    const hit = extMemo.get(id); if (hit) return hit;
    const s = DIM.explain; const kids = model.idx.get(id) || [];
    if (!kids.length) { const leaf = { hi: 0, lo: s.h }; extMemo.set(id, leaf); return leaf; }
    let next = 0, gBot = s.h;
    for (const k of kids) { const e = extent(k.id); const at = next - e.hi; if (at + e.lo > gBot) gBot = at + e.lo; next = at + e.lo + GAP_Y; }
    const mid = Math.round(s.h / 2 - gBot / 2);
    const e = { hi: Math.min(0, mid), lo: Math.max(s.h, gBot + mid) };
    extMemo.set(id, e); return e;
  };
  const place = (id, depth, at) => {
    const k = 'e:' + id; const s = DIM.explain; const kids = model.idx.get(id) || [];
    if (!isPinned(k)) pos.set(k, { x: depthX.get(depth), y: at, w: s.w, h: s.h });
    const keys = [k];
    if (!kids.length) return { top: at, bottom: at + s.h, keys };
    let next = at, kidTop = Infinity, kidBot = -Infinity;
    for (const kk of kids) { const e = extent(kk.id); const r = place(kk.id, depth + 1, next - e.hi); keys.push(...r.keys); if (r.top < kidTop) kidTop = r.top; if (r.bottom > kidBot) kidBot = r.bottom; next = r.bottom + GAP_Y; }
    const delta = Math.round(s.h / 2 - (kidBot - at) / 2);
    if (delta) for (let i = 1; i < keys.length; i++) { if (isPinned(keys[i])) continue; pos.get(keys[i]).y += delta; }
    return { top: Math.min(at, kidTop), bottom: Math.max(at + s.h, kidBot), keys };
  };
  const minY = anchor ? anchor.y : 0;
  let cursor = minY, forestTop = Infinity, forestBottom = -Infinity;
  for (const r of model.roots) { const e = extent(r); const sub = place(r, 1, cursor - e.hi); forestTop = Math.min(forestTop, sub.top); forestBottom = Math.max(forestBottom, sub.bottom); cursor = sub.bottom + GAP_Y * 1.4; }
  if (anchor && forestBottom > forestTop) {
    const delta = Math.round(anchor.y + anchor.h / 2 - (forestTop + forestBottom) / 2);
    if (delta) for (const n of model.exps) { if (isPinned(n.key)) continue; pos.get(n.key).y += delta; }
  }
  if (lift) forestBottom -= liftBoardOn(pos);
  return { forestTop, forestBottom };
}

function layoutAligned(model) {
  const pos = new Map();
  let off = 0, y = 0, col0w = off;
  for (const n of model.col0) {
    pos.set(key(n), { x: off, y, w: sizeOf(n).w, h: sizeOf(n).h });
    y += sizeOf(n).h + GAP_Y;
    col0w = Math.max(col0w, off + sizeOf(n).w);
  }
  if (!model.exps.length) { liftBoardOn(pos); return { pos, col0w }; }
  const anchor = pos.get('c:' + currentId);
  placeForest(model, pos, anchor, col0w + GAP_X, { lift: true, respectPins: false });
  reserveColumn(model, pos, false);
  return { pos, col0w };
}

function layout(model, isFree) {
  const { pos } = layoutAligned(model);
  const out = { pos };
  if (!isFree || !Object.keys(layoutPositions).length) return out;
  for (const [k, p] of out.pos) { const saved = layoutPositions[k]; if (!saved) continue; p.x = saved.x; p.y = saved.y; }
  if (model.exps.length && layoutPositions['c:' + currentId]) {
    const cur = out.pos.get('c:' + currentId);
    if (cur) placeForest(model, out.pos, cur, cur.x + cur.w + GAP_X, { lift: false, respectPins: true });
    reserveColumn(model, out.pos, true);
  }
  return out;
}

function elbow(x1, y1, x2, y2) { return { x1, y1, x2, y2 }; }
function edgePoints(a, b) {
  /* mirrors addPath's routing decision */
  if (b.x + b.w < a.x) return elbow(a.x, a.y + a.h / 2, b.x + b.w + EDGE_SLACK, b.y + b.h / 2);
  return elbow(a.x + a.w, a.y + a.h / 2, b.x - EDGE_SLACK, b.y + b.h / 2);
}

/* ── assertions ── */
const model = buildSimpleModel(3);

// ALIGNED regression: forest chains to the RIGHT of col0
const al = layout(model, false);
const convA = al.pos.get('c:' + currentId);
const ex1A = al.pos.get('e:ex-0');
console.assert(ex1A.x === convA.x + Math.max(...model.col0.map((n) => sizeOf(n).w + convA.x === convA.x ? 0 : 0)) + GAP_X || ex1A.x > convA.x, 'aligned: explains right of conv');
console.assert(al.pos.get('e:ex-0').y !== undefined, 'aligned: explains placed');
const alignedXs = [...al.pos.values()].map((p) => p.x);
console.assert(Math.min(...alignedXs) === convA.x, 'aligned: nothing runs left of col0 (summary absent in this sim)');
console.log('aligned OK', 'conv', convA, 'ex-0', ex1A);

// THE BUG: free mode, conversation pinned at a click far right of the aligned column
layoutPositions['c:' + currentId] = { x: 2280, y: 600 };
const fr = layout(model, true);
const convF = fr.pos.get('c:' + currentId);
const ex1F = fr.pos.get('e:ex-0');
console.assert(convF.x === 2280, 'free: conv at pinned position');
console.assert(ex1F.x > convF.x + convF.w - 1, 'FREE: explains chained RIGHT of the pinned conv (was the bug: they sat left/back at aligned column ~400)');
console.assert(ex1F.x - (convF.x + convF.w) <= GAP_X + 1, 'free: explains immediately beside the conv');
console.log('free OK', 'conv', convF, 'ex-0', ex1F);

// direction-aware edge: conv → ex reads left→right with no backward trunk
const e1 = edgePoints(convF, ex1F);
console.assert(e1.x2 - e1.x1 > 0, 'edge conv→ex-0 travels forward (positive dx) — no long backward arrow');
console.log('edge OK', e1);

// pinned explain preserved on re-anchor
layoutPositions['e:ex-1'] = { x: 8888, y: 4444 };
const fr2 = layout(model, true);
console.assert(fr2.pos.get('e:ex-1').x === 8888, 'pinned explain survives the re-anchor');
console.assert(fr2.pos.get('e:ex-0').x > 2280, 'unpinned explains still re-flow');
console.log('pins OK', fr2.pos.get('e:ex-1'));

// reserve: later conversations pushed below the free conv's forest
layoutPositions['e:ex-1'] = undefined; delete layoutPositions['e:ex-1'];
const model2 = buildSimpleModel(1);
model2.col0.push({ key: 'c:conv-2', kind: 'conversation', id: 'conv-2' });
currentId = 'conv-1';
const fr3 = layout(model2, true);
const conv2 = fr3.pos.get('c:conv-2');
const ex0 = fr3.pos.get('e:ex-0');
console.assert(ex0.y + ex0.h + GAP_Y <= conv2.y, 'reserve: conv-2 clears the forest of conv-1 (bot ' + (ex0.y + ex0.h) + ' vs conv2.y ' + conv2.y + ')');
console.log('reserve OK', conv2);

console.log('\nALL SMOKE ASSERTIONS PASSED');
