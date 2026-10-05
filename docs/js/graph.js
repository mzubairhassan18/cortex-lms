/* graph.js — the v2 horizontal node view (n8n-style canvas).
 *
 * DESIGN NOTE — why this module moves DOM instead of re-rendering it:
 * the spec is that clicking a conversation node opens the REAL conversation
 * container (chat box, attach +, send) and that explanations become nodes.
 * Rebuilding those in Preact would duplicate every handler, break streaming
 * and lose input focus. So a node is an empty box, and the live element is
 * parked inside it:
 *
 *     #chat-area            -> the current conversation's node
 *     .ex-container[data-id]-> that explanation's node
 *     #summary-overlay      -> the summary node
 *
 * Every node element is created once and REUSED across renders (nodeEls), so
 * moving is a no-op on the 2nd+ render: no focus loss, no scroll jump, no
 * re-binding. `moved` remembers where each element came from so leaving the
 * graph view puts the app back exactly as it was.
 *
 * Nothing outside this module imports it: the conversation and explain
 * modules notify it through state.onGraphChange instead, which keeps the
 * import graph acyclic.
 */
import { childrenIndex, panelEl } from './explain-system.js';
import { confirmCloseExplain } from './explain-lifecycle.js';
import { deleteConversation, selectConversation } from './conversations.js';
import { showSidebar, updateCollapsed } from './explain-ui.js';
import { attachExplainHandlers } from './interactions.js';
import { $, explainPanels, state } from './state.js';
import { makeSelectionHandlers } from './selection.js';
import { hideMenu, showMenu } from './graph-menu.js';
/* The wheel and pinch recognisers for the canvas. Kept deliberately small: this
 * module still owns the camera (the actual pan/zoom maths) and the drag-to-pan
 * rules, @use-gesture just decodes the input devices. Resolved by the import
 * map in index.html — there is no build step. */
import { PinchGesture, WheelGesture } from '@use-gesture/vanilla';

/* ---------------- refs ---------------- */

const graphView = $('graph-view');
const graphScroll = $('graph-scroll');
const graphCanvas = $('graph-canvas');
const graphPaths = $('graph-paths');
const graphNodes = $('graph-nodes');
const graphEmpty = $('graph-empty');
const viewToggle = $('view-toggle');
const railSettings = $('rail-settings');
const railLayout = $('rail-layout');
const railZoomIn = $('rail-zoom-in');
const railZoomOut = $('rail-zoom-out');
const railZoomLabel = $('rail-zoom-label');

const mainRow = $('main-row');
const resizeHandle = $('resize-handle');
const chatArea = $('chat-area');
const rightSidebar = $('right-sidebar');
const summaryOverlay = $('summary-overlay');
const settingsOverlay = $('settings-overlay');
const libraryOverlay = $('library-overlay');
const settingsBtn = $('settings-btn');
const newChatBtn = $('new-chat-btn');
const summaryBtn = $('summary-btn');

/* ---------------- geometry ---------------- */

const GAP_X = 96;   // room for the arrow between two columns
const GAP_Y = 26;   // gap between sibling nodes
const EDGE_SLACK = 6; // stop the line short so the arrowhead has air

/* Fixed heights keep the layout a pure function of the model: no measure pass,
 * no reflow while streaming, and a node's box never depends on its content. */
const DIM = {
  summary: { w: 680, h: 560 },
  add: { w: 46, h: 46 },
  conv: { w: 300, h: 112, we: 780, he: 660 },
  explain: { w: 344, h: 104, we: 460, he: 500 },
};

/* ---------------- view-local state ---------------- */

const nodeEls = new Map();          // key -> element (kept alive across renders)
const moved = [];                   // LIFO journal of { el, parent, next }
const openExplains = new Set();     // explanation nodes the user has open
const userCollapsed = new Set();    // ...and the ones they deliberately closed
const collapsedConvs = new Set();   // current conversation folded by the user
let lastActive = null;
let sidebarWasOpen = false;
let raf = 0;
let rafFallback = 0;

const hostOf = (el) => el.querySelector(':scope > .gn-host');
const isConvOpen = (id) => id === state.currentId && !collapsedConvs.has(id);
const isExpOpen = (id) => openExplains.has(id) && !userCollapsed.has(id);

/*
 * rAF is the right scheduler — it coalesces and lands just before paint. But
 * a hidden tab never runs rAF, which would leave a requested render pending
 * forever and freeze this module's state (collapse-on-scroll included) until
 * someone shows the window. Arm a timer alongside it so a render always lands;
 * whichever fires first cancels the other.
 */
function schedule() {
  if (state.view !== 'graph' || raf) return;
  const run = () => {
    if (raf) cancelAnimationFrame(raf);
    if (rafFallback) clearTimeout(rafFallback);
    raf = 0;
    rafFallback = 0;
    render();
  };
  raf = requestAnimationFrame(run);
  rafFallback = setTimeout(run, 120);
}

/* ---------------- moving live DOM in and out ---------------- */

function putIn(el, host) {
  if (!el || !host || el.parentElement === host) return;
  if (!moved.some((r) => r.el === el)) {
    moved.push({ el, parent: el.parentElement, next: el.nextSibling });
  }
  host.appendChild(el);
}

function putBack(el) {
  const i = moved.findIndex((r) => r.el === el);
  if (i < 0) return;
  const { parent, next } = moved[i];
  moved.splice(i, 1);
  /* The app may have destroyed the element itself (closing a container,
   * clearing the panel). Re-inserting it would resurrect deleted UI. */
  if (!el.isConnected || !parent || el.parentElement === parent) return;
  if (next && next.parentElement === parent) parent.insertBefore(el, next);
  else parent.appendChild(el);
}

function restoreAll() {
  /* Reverse order: a record's `next` may itself be a parked element that has
   * to land back first for insertBefore to find it in the parent. */
  for (const rec of [...moved].reverse()) putBack(rec.el);
  moved.length = 0;
  /* Root containers must sit in #explain-panels in creation order. Appending
   * them in roots order makes the final sequence deterministic no matter what
   * order they were restored in. */
  for (const id of state.explains.roots) {
    const el = panelEl(id);
    if (el && el.parentElement === explainPanels) explainPanels.appendChild(el);
  }
}

/* ---------------- model ---------------- */

function build() {
  const col0 = [];
  const hasConv = state.conversations.length > 0;
  if (!summaryOverlay.classList.contains('hidden')) col0.push({ key: 'summary', kind: 'summary' });
  /* With no conversation there is nothing to add around: the empty state
   * carries its own single + button, and two stray boxes at the top-left of
   * an otherwise blank board just read as duplicates. */
  if (hasConv) col0.push({ key: 'add:top', kind: 'add' });
  for (const c of state.conversations) {
    col0.push({ key: 'c:' + c.id, kind: 'conv', id: c.id, data: c });
  }
  if (hasConv) col0.push({ key: 'add:bottom', kind: 'add' });

  const idx = childrenIndex();
  const exps = [];
  const roots = state.explains.roots.filter((r) => state.explains.nodes[r]);
  const walk = (id, depth) => {
    exps.push({ key: 'e:' + id, kind: 'explain', id, depth });
    for (const k of idx.get(id) || []) walk(k.id, depth + 1);
  };
  for (const r of roots) walk(r, 1);
  return { col0, exps, roots, idx };
}

function sizeOf(n) {
  const d = DIM[n.kind];
  if (n.kind === 'conv') {
    const open = isConvOpen(n.id);
    return { w: open ? d.we : d.w, h: open ? d.he : d.h };
  }
  if (n.kind === 'explain') {
    const open = isExpOpen(n.id);
    return { w: open ? d.we : d.w, h: open ? d.he : d.h };
  }
  return { w: d.w, h: d.h };
}

/* ================= Aligned / Free ================= */

/*
 * ALIGNED is what this view has always done: layout() computes every position
 * from the model alone, on every render, so nothing can be moved and nothing
 * has to be remembered.
 *
 * FREE keeps that computation and lets a SAVED coordinate win. Nodes nobody has
 * touched still follow the computed layout — deliberately: the computed column
 * shifts when conversations are added or removed, and a position you never
 * chose should not be frozen in place by accident.
 *
 * Coordinates are world coordinates and MAY BE NEGATIVE. #graph-canvas has no
 * overflow rule and #graph-edges sets overflow:visible, so left of the origin
 * paints fine. Normalising to a non-negative origin would shift the whole board
 * on screen in the middle of a drag, which is why placeCamera() tracks
 * baseX/baseY instead of assuming the content starts at 0.
 */

let layoutMode = 'aligned';   // 'aligned' | 'free'
let layoutPositions = {};     // node key -> { x, y }, world coords
let layoutLoaded = false;
let layoutTimer = 0;

const isFree = () => layoutMode === 'free';

function applyModeChrome() {
  if (railLayout) {
    railLayout.textContent = isFree() ? 'Free' : 'Aligned';
    railLayout.classList.toggle('free', isFree());
    railLayout.title = isFree()
      ? 'Layout — Free: drag a conversation anywhere. Right-click the board for options.'
      : 'Layout — Aligned: the board is placed for you. Click to switch to Free.';
  }
  graphCanvas.classList.toggle('free', isFree());
}

async function loadLayout() {
  if (layoutLoaded) return;
  layoutLoaded = true;
  try {
    const r = await fetch('/api/layout');
    if (r.ok) {
      const d = await r.json();
      if (d && d.mode === 'free') layoutMode = 'free';
      /*
       * Merge, never replace. The fetch is in flight while the board is already
       * live, so a drag can land first — spreading the server copy UNDER the
       * local one keeps that drag and still restores everything else that was
       * saved on another machine.
       */
      if (d && d.positions && typeof d.positions === 'object') {
        layoutPositions = { ...d.positions, ...layoutPositions };
      }
    }
  } catch { /* stay Aligned — the board still lays itself out */ }
  applyModeChrome();
  /* The board may already have painted as Aligned; repaint it as the user left
   * it. No schedule() when nothing was saved, so an Aligned user never pays
   * for a render they did not need. */
  if (isFree() && Object.keys(layoutPositions).length) schedule();
}

function saveLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(async () => {
    try {
      await fetch('/api/layout', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: layoutMode, positions: layoutPositions }),
      });
    } catch { /* keep the local copy — the next change sends it again */ }
  }, 400);
}

/*
 * The one place a Free coordinate is applied.
 *
 * Everything else — node sizes, edges, the canvas box — still comes from the
 * aligned computation, so a saved position only ever replaces x/y. A node with
 * no saved entry falls through to the computed one, which is why the board
 * stays sensible for trees nobody has dragged.
 */
function layout(model) {
  const out = layoutAligned(model);
  if (!isFree() || !Object.keys(layoutPositions).length) return out;

  for (const [key, p] of out.pos) {
    const saved = layoutPositions[key];
    if (!saved) continue;
    p.x = saved.x;
    p.y = saved.y;
  }

  /* W/H/minX/minY describe the PRE-overlay positions, so recompute them: the
   * canvas must be as large as the arrangement now is, and the camera needs to
   * know how far left and up the board reaches before it can frame it. */
  let W = 0;
  let H = 0;
  let minX = 0;
  let minY = 0;
  for (const p of out.pos.values()) {
    if (p.x + p.w > W) W = p.x + p.w;
    if (p.y + p.h > H) H = p.y + p.h;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
  }
  out.W = W;
  out.H = H;
  out.minX = minX;
  out.minY = minY;
  return out;
}

/*
 * Column 0 is a plain vertical stack (+, conversations, +) with the summary
 * hanging off its LEFT side. The explanations hang off it as a tree, and the
 * rule is simple: a parent is centred on its children, so a branch grows
 * UPWARD as well as downward — the middle of three siblings lands level with
 * its parent instead of the whole stack being pushed below it. The rule applies
 * at every level, so the hierarchy stays smooth all the way down.
 *
 * Centring is only safe if each sibling reserves the upward half of the next
 * one BEFORE it is placed, otherwise a centred branch walks straight through
 * the branch above it. That is what `extent()` answers — from the tree alone,
 * and before any position exists.
 */
function layoutAligned(model) {
  const pos = new Map();

  /*
   * The summary sits LEFT of the conversation it describes, arrow pointing in,
   * rather than stacking on top of column 0. Column 0 slides right by its
   * width to make room — so opening the summary moves the board SIDEWAYS, and
   * every conversation still starts at y=0 instead of being pushed half a
   * screen down by a panel nobody asked to see.
   */
  const sumNode = model.col0.find((n) => n.key === 'summary');
  const off = sumNode ? sizeOf(sumNode).w + GAP_X : 0;

  let y = 0;
  let col0w = off;
  for (const n of model.col0) {
    if (n === sumNode) continue;
    const s = sizeOf(n);
    pos.set(n.key, { x: off, y, w: s.w, h: s.h });
    y += s.h + (n.kind === 'add' ? 18 : GAP_Y);
    if (off + s.w > col0w) col0w = off + s.w;
  }

  /*
   * Centred on the active conversation. A short conversation paired with a
   * tall summary starts above y=0, and the canvas has a fixed box — a negative
   * y is simply not reachable. Slide the WHOLE board down instead: everything
   * is positioned relative to everything else, so this is a pure translation.
   */
  if (sumNode) {
    const s = sizeOf(sumNode);
    const cur = pos.get('c:' + state.currentId);
    pos.set(sumNode.key, {
      x: 0,
      y: cur ? Math.round(cur.y + cur.h / 2 - s.h / 2) : 0,
      w: s.w,
      h: s.h,
    });
  }

  /*
   * lift is min(0, smallest y), so it is 0 when the board is already clear of
   * the top edge and NEGATIVE when something overhangs it. The guard used to be
   * `lift <= 0`, which returned early in exactly that second case — making this
   * a no-op since the day it was written, and the reason an opened explanation
   * could end up above the viewport with no way to drag it back down.
   */
  const liftBoard = () => {
    let lift = 0;
    for (const p of pos.values()) if (p.y < lift) lift = p.y;
    if (lift >= 0) return 0;      // nothing overhangs the top edge
    for (const p of pos.values()) p.y -= lift;
    y -= lift;
    return lift;
  };

  const box = () => {
    let W = col0w;
    let H = y;
    /* minX/minY are the NEGATIVE reach of the board. In Aligned they are
     * always 0 (liftBoard() guarantees y >= 0 and nothing starts left of 0),
     * so placeCamera()'s arithmetic reduces to exactly what it was. */
    let minX = 0;
    let minY = 0;
    for (const p of pos.values()) {
      if (p.x + p.w > W) W = p.x + p.w;
      if (p.y + p.h > H) H = p.y + p.h;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
    }
    return { pos, W, H, minX, minY };
  };

  if (!model.exps.length) {
    liftBoard();
    return box();
  }

  const colW = new Map();
  for (const n of model.exps) {
    const s = sizeOf(n);
    if (!colW.has(n.depth) || colW.get(n.depth) < s.w) colW.set(n.depth, s.w);
  }
  const depthX = new Map();
  let x = col0w + GAP_X;
  for (let d = 1; d <= Math.max(...colW.keys()); d++) {
    depthX.set(d, x);
    x += (colW.get(d) || DIM.explain.w) + GAP_X;
  }

  /*
   * Vertical reach of a branch relative to the TOP EDGE OF ITS OWN ROOT:
   * `hi` climbs (0 or negative), `lo` falls. Only the tree and the fixed DIM
   * sizes feed it, so it is memoised per layout and asked before placement.
   */
  const extMemo = new Map();
  const extent = (id) => {
    const hit = extMemo.get(id);
    if (hit) return hit;
    const s = sizeOf({ kind: 'explain', id });
    const kids = model.idx.get(id) || [];
    if (!kids.length) {
      const leaf = { hi: 0, lo: s.h };
      extMemo.set(id, leaf);
      return leaf;
    }
    let next = 0;
    let gBot = s.h;              // the node itself is part of its own branch
    for (const k of kids) {
      const e = extent(k.id);
      const at = next - e.hi;    // leave the upward half its room
      if (at + e.lo > gBot) gBot = at + e.lo;
      next = at + e.lo + GAP_Y;
    }
    const mid = Math.round(s.h / 2 - gBot / 2);
    const e = { hi: Math.min(0, mid), lo: Math.max(s.h, gBot + mid) };
    extMemo.set(id, e);
    return e;
  };

  /*
   * `at` is where this node's top edge goes. Its children stack from that
   * same edge, then the whole stack slides until it is centred on the parent —
   * `keys` comes back so the slide can reach every descendant at once.
   */
  const place = (id, depth, at) => {
    const key = 'e:' + id;
    const s = sizeOf({ kind: 'explain', id });
    const kids = model.idx.get(id) || [];
    pos.set(key, { x: depthX.get(depth), y: at, w: s.w, h: s.h });
    const keys = [key];
    if (!kids.length) return { top: at, bottom: at + s.h, keys };

    let next = at;
    let kidTop = Infinity;
    let kidBot = -Infinity;
    for (const k of kids) {
      const e = extent(k.id);
      const r = place(k.id, depth + 1, next - e.hi);
      keys.push(...r.keys);
      if (r.top < kidTop) kidTop = r.top;
      if (r.bottom > kidBot) kidBot = r.bottom;
      next = r.bottom + GAP_Y;
    }
    const delta = Math.round(s.h / 2 - (kidBot - at) / 2);
    if (delta) {
      for (let i = 1; i < keys.length; i++) pos.get(keys[i]).y += delta;
      kidTop += delta;
      kidBot += delta;
    }
    return {
      top: Math.min(at, kidTop),
      bottom: Math.max(at + s.h, kidBot),
      keys,
    };
  };

  /* Anchor the forest to the current conversation so the arrows read as
   * "this conversation, then its explanations". Each root reserves the upward
   * half of its branch, so one forest never climbs into the one above. */
  const cur = pos.get('c:' + state.currentId);
  const minY = cur ? cur.y : 0;
  let cursor = minY;
  let forestTop = Infinity;
  let forestBottom = -Infinity;

  for (const r of model.roots) {
    const e = extent(r);
    const sub = place(r, 1, cursor - e.hi);
    if (sub.top < forestTop) forestTop = sub.top;
    if (sub.bottom > forestBottom) forestBottom = sub.bottom;
    cursor = sub.bottom + GAP_Y * 1.4;
  }

  /*
   * The stack was laid out from the conversation's top edge, which puts the
   * WHOLE forest below it. Centre it instead: the middle sibling lands level
   * with the conversation, the first above it, the last below. Explains live
   * in columns to the right of column 0, so reaching upward costs nothing —
   * no conversation, summary or + box is anywhere near those columns.
   */
  if (cur && forestBottom > forestTop) {
    const delta = Math.round(cur.y + cur.h / 2 - (forestTop + forestBottom) / 2);
    if (delta) {
      for (const n of model.exps) pos.get(n.key).y += delta;
      forestTop += delta;
      forestBottom += delta;
    }
  }

  /*
   * Centring a tall branch on a short conversation walks it off the top of
   * the canvas — see liftBoard(). The reserve below needs the forest's real
   * bottom AFTER that slide, so it gets the lift back.
   */
  forestBottom -= liftBoard();

  /*
   * Reserve the space the explanations just claimed.
   *
   * Column 0 stacks conversations one under the other, while the forest above
   * is drawn in columns to the RIGHT — so without this, expanding an
   * explanation runs down the page straight through every conversation
   * listed after the current one. Each conversation therefore owns a
   * vertical band: everything below the current one starts where the current
   * one plus its explanations ends.
   */
  const iCur = model.col0.findIndex((n) => n.key === 'c:' + state.currentId);
  if (iCur >= 0 && iCur < model.col0.length - 1) {
    const here = pos.get(model.col0[iCur].key);
    const floor = Math.max(here.y + here.h, forestBottom) + GAP_Y;
    const natural = pos.get(model.col0[iCur + 1].key).y;
    const shift = Math.max(0, floor - natural);
    if (shift > 0) {
      for (let i = iCur + 1; i < model.col0.length; i++) {
        pos.get(model.col0[i].key).y += shift;
      }
    }
  }

  return box();
}

/* ---------------- node elements ---------------- */

function mk(cls, tag = 'div') {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  return el;
}

/* A control icon from the sprite in index.html. Only ever called with names
 * we hard-code — user text is set through textContent elsewhere. */
const ico = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

function gnHead(icon, title, acts) {
  const head = mk('gn-head');
  const ic = mk('gn-icon');
  ic.innerHTML = ico(icon);
  const t = mk('gn-title');
  t.textContent = title;
  const a = mk('gn-acts');
  for (const [act, glyph, label] of acts) {
    const b = mk('gn-act', 'button');
    b.type = 'button';
    b.dataset.act = act;
    b.innerHTML = ico(glyph);
    b.title = label;
    a.appendChild(b);
  }
  head.append(ic, t, a);
  return head;
}

function buildEl(kind) {
  const el = mk('gnode');
  el.dataset.kind = kind;

  if (kind === 'add') {
    el.classList.add('add-node');
    el.innerHTML = ico('plus');
    el.title = 'New chat';
    return el;
  }

  if (kind === 'conv') {
    el.classList.add('conv-node');
    el.append(
      gnHead('message', '', [
        ['explains', 'plus', 'Reveal this conversation’s explanations'],
        ['summary', 'clipboard', 'Topics summary of this conversation'],
        ['toggle', 'chev-down', 'Collapse this conversation'],
      ]),
      mk('gn-preview'),
      mk('gn-meta'),
      mk('gn-host')
    );
    return el;
  }

  if (kind === 'explain') {
    el.classList.add('explain-node', 'collapsed');
    el.append(
      gnHead('bulb', '', [
        ['toggle', 'chev-down', 'Expand this explanation'],
        ['close', 'x', 'Close this explanation'],
      ]),
      mk('gn-preview'),
      mk('gn-meta'),
      mk('gn-host')
    );
    return el;
  }

  // summary — its own .summary-head (↻ / ✕) is the header, exactly as in list view
  el.classList.add('summary-node', 'expanded');
  el.append(mk('gn-host'));
  return el;
}

function nodeFor(n) {
  let el = nodeEls.get(n.key);
  if (el && el.dataset.kind === n.kind) {
    el.dataset.id = n.id || '';
    return el;
  }
  if (el) { el.remove(); nodeEls.delete(n.key); }
  el = buildEl(n.kind);
  el.dataset.id = n.id || '';
  nodeEls.set(n.key, el);
  graphNodes.appendChild(el);
  return el;
}

/* ---------------- per-node refresh ---------------- */

function place(el, p) {
  el.style.left = p.x + 'px';
  el.style.top = p.y + 'px';
  el.style.width = p.w + 'px';
  el.style.height = p.h + 'px';
}

function applyConv(el, n) {
  const open = isConvOpen(n.id);
  const current = n.id === state.currentId;
  el.classList.toggle('is-current', current);
  el.classList.toggle('expanded', open);
  el.querySelector('.gn-title').textContent = n.data.title || 'New conversation';
  el.querySelector('.gn-preview').textContent = current
    ? 'Active conversation — click to fold'
    : 'Click to open';
  el.querySelector('.gn-meta').textContent = when(n.data.updatedAt);
  el.querySelector('.gn-head .gn-icon').innerHTML = ico(open ? 'folder' : 'message');
  const [bExplains, bSummary, bToggle] = el.querySelectorAll('.gn-act');
  bExplains.hidden = !(current && state.explains.roots.length > 0);
  bSummary.hidden = false;
  bToggle.innerHTML = ico(open ? 'chev-up' : 'chev-down');
  bToggle.title = open ? 'Collapse this conversation' : 'Expand this conversation';
}

function applyExplain(el, n, idx) {
  const node = state.explains.nodes[n.id];
  const open = isExpOpen(n.id);
  el.classList.toggle('expanded', open);
  el.classList.toggle('collapsed', !open);
  el.querySelector('.gn-head .gn-title').textContent = truncate(node ? node.selection : '');
  const kids = (idx.get(n.id) || []).length;
  if (node && node.busy) {
    el.querySelector('.gn-preview').textContent = 'Thinking…';
    el.querySelector('.gn-meta').textContent = '●●●';
  } else {
    const first = (node ? node.messages : []).find((m) => m.role === 'assistant');
    el.querySelector('.gn-preview').textContent = first
      ? truncate(first.content.replace(/[#*`>\[\]!]/g, ''), 150)
      : 'No answer yet.';
    el.querySelector('.gn-meta').textContent = kids
      ? `${kids} nested explanation${kids > 1 ? 's' : ''}`
      : 'Explanation';
  }
  const [bToggle, bClose] = el.querySelectorAll('.gn-act');
  bToggle.innerHTML = ico(open ? 'chev-up' : 'chev-down');
  bToggle.title = open ? 'Collapse this explanation' : 'Expand this explanation';
  bClose.hidden = false;

  /*
   * The container carries its own minimise control, because the chevron above
   * is display:none exactly when you can see that header (while expanded).
   * Keep its glyph in step so the two read as one switch.
   */
  const panel = panelEl(n.id);
  const glyph = panel && panel.querySelector('.ex-collapse use');
  if (glyph) {
    glyph.setAttribute('href', open ? '#i-chev-up' : '#i-chev-down');
    const ctl = glyph.closest('.ex-collapse');
    if (ctl) ctl.title = open ? 'Minimise this container' : 'Expand this container';
  }
}

/* ---------------- edges ---------------- */

function addPath(a, b, on) {
  if (!a || !b) return;
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x - EDGE_SLACK;
  const y2 = b.y + b.h / 2;
  const mid = x1 + Math.max(14, (x2 - x1) / 2);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`);
  p.setAttribute('marker-end', on ? 'url(#garrow-on)' : 'url(#garrow)');
  p.setAttribute('class', on ? 'gpath gpath-on' : 'gpath');
  graphPaths.appendChild(p);
}

function drawEdges(model, pos) {
  while (graphPaths.firstChild) graphPaths.removeChild(graphPaths.firstChild);
  const conv = pos.get('c:' + state.currentId);
  const convOn = isConvOpen(state.currentId);
  /* The summary hangs to the LEFT of the conversation and points into it —
   * same elbow as every other edge, just the one that reads right-to-left. */
  if (pos.has('summary')) addPath(pos.get('summary'), conv, true);
  for (const r of model.roots) addPath(conv, pos.get('e:' + r), convOn);
  for (const n of model.exps) {
    const node = state.explains.nodes[n.id];
    if (node && node.parentId) addPath(pos.get('e:' + node.parentId), pos.get(n.key), isExpOpen(n.id));
  }
}

/* ---------------- hosts ---------------- */

function syncHosts(model) {
  const want = new Map();

  const convNode = nodeEls.get('c:' + state.currentId);
  if (convNode) want.set(chatArea, hostOf(convNode));

  for (const n of model.exps) {
    const el = panelEl(n.id);
    const node = nodeEls.get(n.key);
    if (el && node) want.set(el, hostOf(node));
  }

  const sumNode = nodeEls.get('summary');
  if (sumNode && !summaryOverlay.classList.contains('hidden')) {
    want.set(summaryOverlay, hostOf(sumNode));
  }

  for (const [el, host] of want) putIn(el, host);
  for (const rec of [...moved].reverse()) if (!want.has(rec.el)) putBack(rec.el);

  /* Parked roots must end up in the mount in creation order. */
  for (const id of state.explains.roots) {
    const el = panelEl(id);
    if (el && el.parentElement === explainPanels) explainPanels.appendChild(el);
  }
}

/* ---------------- camera (the infinite canvas) ---------------- */

/*
 * There is no scroll box any more. #graph-canvas carries a camera and is drawn
 * at  world * zoom + (camX, camY),  so the board has no edges: it can be dragged
 * past every side and brought back, which is the point of a Figma-style canvas.
 * The old implementation scrolled a content box, and a content box has a top —
 * anything the layout placed above the world origin was simply unreachable,
 * wedged behind the header with no way to pull it down.
 *
 * #graph-canvas keeps its real (unscaled) size and only its transform changes,
 * so every child sized `inset: 0` — the SVG edge layer, the node layer — stays in
 * unscaled world coordinates and no other code has to do coordinate maths.
 */
const ZOOM_KEY = 'lb.zoom';
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;
const ZOOM_RATIO = 1.2;   // one press, one notch on the ladder
const CAM_PAD = 56;       // a bare board never starts flush against the header

let zoom = 1;
let camX = 0;
let camY = 0;
let baseW = 0;            // unscaled canvas size, straight from layout()
let baseH = 0;
let baseX = 0;            // how far left/up the board reaches (0 unless Free)
let baseY = 0;
let camTouched = false;   // once the user moves it, stop re-centring for them
let lastZoomNotified = -1;

const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/*
 * A board nobody has touched yet is centred in the viewport, and never comes
 * closer than CAM_PAD to the top or left. So: when it fits, it is centred with
 * space on all four sides; when it does not, it starts one pad below the header
 * and the rest is one drag away — never off the top edge with nowhere to go.
 *
 * baseX/baseY carry the board's LEFT/TOP reach. In Aligned they are 0 and the
 * two expressions below reduce exactly to `max(CAM_PAD, centred)` — the
 * arithmetic this always did. In Free they can be negative (the arrangement may
 * sit above or left of the origin), so centring has to be measured from
 * baseX/baseY rather than from 0, and the pad has to be applied to the edge
 * that is actually nearest the header.
 */
function placeCamera() {
  if (camTouched) return;
  const cw = graphScroll.clientWidth;
  const ch = graphScroll.clientHeight;
  camX = Math.round(Math.max(
    CAM_PAD - baseX * zoom,
    (cw - (baseW - baseX) * zoom) / 2 - baseX * zoom,
  ));
  camY = Math.round(Math.max(
    CAM_PAD - baseY * zoom,
    (ch - (baseH - baseY) * zoom) / 2 - baseY * zoom,
  ));
}

function applyCamera() {
  graphCanvas.style.transform =
    camX === 0 && camY === 0 && zoom === 1
      ? ''
      : 'translate(' + camX + 'px, ' + camY + 'px) scale(' + zoom + ')';
  if (zoom !== lastZoomNotified) {
    lastZoomNotified = zoom;
    if (railZoomLabel) railZoomLabel.textContent = Math.round(zoom * 100) + '%';
    /* Tell whoever cares (the workspace layer) that we crossed out of the
     * conversation level. Same indirection as state.onGraphChange: the zoom
     * owner never imports its observers, so there is no module cycle. Only on a
     * real zoom change — panning rewrites this transform every frame. */
    if (state.onZoomChange) state.onZoomChange(zoom);
  }
  foldOutOfView();
}

/* Zoom around a point of the viewport so what you are looking at stays put.
 * cx/cy default to the centre of the viewport. */
function setZoom(next, cx, cy) {
  next = clampZoom(next);
  if (next === zoom) return;
  const ax = cx == null ? graphScroll.clientWidth / 2 : cx;
  const ay = cy == null ? graphScroll.clientHeight / 2 : cy;
  /* Hold the world point sitting under (ax, ay) where it is by moving the
   * camera to cancel out the scale change. */
  const wx = (ax - camX) / zoom;
  const wy = (ay - camY) / zoom;
  zoom = next;
  camX = ax - wx * zoom;
  camY = ay - wy * zoom;
  applyCamera();
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* private mode */ }
}

/* True when the wheel landed on something that scrolls itself — the message
 * list, a panel — in which case the wheel belongs to that element, not to us. */
function overScroller(target) {
  let el = target && target.nodeType === 1 ? target : null;
  while (el && el !== graphCanvas && el !== graphScroll) {
    if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) return true;
    el = el.parentElement;
  }
  return false;
}

/*
 * Figma's wheel rules, with the device decoding done by @use-gesture: a plain
 * wheel drags the board along either axis, Ctrl/Cmd+wheel zooms under the
 * pointer. A trackpad pinch arrives as ctrl+wheel, so it lands here too.
 */
function onWheel(st) {
  if (state.view !== 'graph') return;
  const e = st.event;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const r = graphScroll.getBoundingClientRect();
    camTouched = true;
    setZoom(zoom * Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
    return;
  }
  if (overScroller(e.target)) return;   // the message list is scrolling itself
  e.preventDefault();
  camX -= e.deltaX;
  camY -= e.deltaY;
  camTouched = true;
  applyCamera();
}

let pinchBase = 1;

/* Two fingers scale the board around their centroid, same as ctrl+wheel.
 * @use-gesture does the two-touch bookkeeping, so the centroid is not ours to
 * get wrong. */
function onPinch(st) {
  if (state.view !== 'graph') return;
  if (st.first) pinchBase = zoom;
  const r = graphScroll.getBoundingClientRect();
  const o = st.origin;
  camTouched = true;
  setZoom(pinchBase * (st.offset ? st.offset[0] : 1),
    o ? o[0] - r.left : r.width / 2,
    o ? o[1] - r.top : r.height / 2);
}

/* --- drag-to-pan (Figma style) --- */

let pan = null;             // { id, x, y, cx, cy, camX, camY, moved } during a drag
let panFrame = 0;           // rAF token: one camera write per frame, not one per event
let panTimer = 0;           // ...with a timer fallback for hidden tabs (see applyPan)
let spaceDown = false;
let swallowUntil = 0;       // a drag must not also fire the underlying click

const isTyping = (t) => !!t && (
  t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
  t.tagName === 'SELECT' || t.isContentEditable
);

function canPanFrom(e) {
  if (state.view !== 'graph') return false;
  if (e.button === 1) return true;                 // middle button: anywhere
  if (e.button !== 0) return false;                // primary button only
  if (spaceDown) return true;                      // space held: anywhere
  return !e.target.closest('.gnode');              // primary: the board only
}

function onPointerDown(e) {
  if (!canPanFrom(e)) return;
  /*
   * Touch used to ride on the board's native scroll, and #graph-scroll is
   * `overflow: clip` now — there is nothing left to scroll. Claim the gesture
   * instead so the browser starts a pan rather than a text selection. Mouse is
   * left alone: it has never needed it, and cancelling pointerdown there would
   * swallow the clicks the node layer depends on.
   */
  if (e.pointerType && e.pointerType !== 'mouse' && e.cancelable) e.preventDefault();
  pan = { id: e.pointerId, x: e.clientX, y: e.clientY,
          cx: e.clientX, cy: e.clientY,
          camX: camX, camY: camY, moved: false };
}

/*
 * The board is dragged by rewriting the camera, and every rewrite repaints the
 * canvas, the SVG edge layer and all the scaled nodes. A modern mouse reports
 * pointermove at 1000Hz, so doing the write inline spends a dozen repaints on a
 * single frame's worth of movement and the drag stutters or stalls outright.
 * Keep only the newest position and spend one repaint per frame on it.
 *
 * rAF is the scheduler that lands just before paint, but a hidden tab never
 * runs rAF — arm a timer alongside it so the drag still lands, exactly as
 * schedule() does. Whichever fires first cancels the other.
 */
function applyPan() {
  if (panFrame || panTimer) return;
  const run = () => {
    if (panFrame) cancelAnimationFrame(panFrame);
    if (panTimer) clearTimeout(panTimer);
    panFrame = 0;
    panTimer = 0;
    if (!pan) return;
    /* NOTE the sign. A scroll offset and a camera offset push the content in
     * opposite directions: more scrollTop slides the board up, more camY slides
     * it down. So the old `st - (c - x)` becomes `camX + (c - x)` here — get
     * that backwards and dragging pulls the board AWAY from you. */
    camX = pan.camX + (pan.cx - pan.x);
    camY = pan.camY + (pan.cy - pan.y);
    applyCamera();
  };
  panFrame = requestAnimationFrame(run);
  panTimer = setTimeout(run, 16);
}

function endPan(e) {
  if (!pan) return;
  if (e && e.pointerId != null && e.pointerId !== pan.id) return;
  const moved = pan.moved;
  if (panFrame) { cancelAnimationFrame(panFrame); panFrame = 0; }
  if (panTimer) { clearTimeout(panTimer); panTimer = 0; }
  /* Land the final position inline: a frame still pending when the button
   * comes up would otherwise be cancelled, leaving the board a few pixels
   * behind where the pointer actually let go. */
  if (moved) {
    camX = pan.camX + (pan.cx - pan.x);
    camY = pan.camY + (pan.cy - pan.y);
    applyCamera();
  }
  pan = null;
  graphScroll.classList.remove('panning');
  if (e && e.pointerId != null) {
    try { graphScroll.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  }
  if (moved) swallowUntil = Date.now() + 250;
}

function onPointerMove(e) {
  if (!pan || e.pointerId !== pan.id) return;
  pan.cx = e.clientX;
  pan.cy = e.clientY;
  if (!e.buttons) { endPan(e); return; }           // released outside our reach
  if (!pan.moved) {
    if (Math.abs(pan.cx - pan.x) < 4 && Math.abs(pan.cy - pan.y) < 4) return;
    pan.moved = true;
    /* From here the user owns the framing: a render must not re-centre the
     * board out from under a drag that is in progress. */
    camTouched = true;
    graphScroll.classList.add('panning');
    try { graphScroll.setPointerCapture(e.pointerId); } catch { /* fine */ }
  }
  applyPan();                                       // grab the board and drag it
}

/* A drag should not also activate whatever node it ended over. */
function onClickCapture(e) {
  if (Date.now() > swallowUntil) return;
  swallowUntil = 0;
  e.stopPropagation();
  e.preventDefault();
}

/* --- keyboard: space to pan, +/- to zoom, 0 to reset --- */

function onKeyDown(e) {
  if (state.view !== 'graph') return;
  const t = e.target;

  if (e.code === 'Space') {
    if (isTyping(t) || (t && (t.tagName === 'BUTTON' || t.tagName === 'A'))) return;
    spaceDown = true;
    graphScroll.classList.add('can-pan');
    e.preventDefault();
    return;
  }

  if (isTyping(t)) return;
  if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoom(zoom * ZOOM_RATIO); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); setZoom(zoom / ZOOM_RATIO); }
  else if (e.key === '0') { e.preventDefault(); setZoom(1); }
}

function onKeyUp(e) {
  if (e.code !== 'Space') return;
  spaceDown = false;
  graphScroll.classList.remove('can-pan');
}

/* ---------------- render ---------------- */

/* ---------------- Free mode: dragging a conversation ---------------- */

let drag = null;

/*
 * The nodes that travel with a conversation.
 *
 * Explanations live ON the conversation row and only the ACTIVE conversation's
 * are built into nodes, so the tree that can be dragged together is exactly
 * what is on the board for the current conversation: it, the summary hanging to
 * its left, and every explanation. A conversation that is not active has no
 * children rendered, so it moves alone — which is still enough to pull one tree
 * clear of another, since that is what the user is separating.
 */
function treeKeys(convKey) {
  const keys = [convKey];
  if (convKey !== 'c:' + state.currentId) return keys;
  if (nodeEls.has('summary')) keys.push('summary');
  for (const k of nodeEls.keys()) if (k.startsWith('e:')) keys.push(k);
  return keys;
}

function startNodeDrag(e) {
  if (!isFree() || e.button !== 0) return;
  const gnode = e.target.closest('.gnode');
  if (!gnode || gnode.dataset.kind !== 'conv') return;
  /* Grab by the header. The body of the active conversation IS the live chat,
   * and a pointerdown there is somebody about to select text — taking that
   * gesture would fight the user for every click in the conversation. */
  if (!e.target.closest('.gn-head')) return;
  if (e.target.closest('button, a, input, textarea, select, [contenteditable]')) return;

  const key = 'c:' + gnode.dataset.id;
  const from = {};
  for (const k of treeKeys(key)) {
    const el = nodeEls.get(k);
    if (!el) continue;
    /* Read the PLACED position off the element rather than out of
     * layoutPositions: a node nobody has moved has no entry there yet, and it
     * has to start from where the board actually put it. */
    from[k] = {
      x: parseFloat(el.style.left) || 0,
      y: parseFloat(el.style.top) || 0,
    };
  }
  if (!Object.keys(from).length) return;

  drag = { sx: e.clientX, sy: e.clientY, from, moved: false };
  gnode.classList.add('dragging');
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', endNodeDrag);
  window.addEventListener('pointercancel', endNodeDrag);
}

function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  if (!drag.moved) {
    /* A 3px threshold keeps a mouse that jitters while clicking from being read
     * as a drag — and therefore from being swallowed instead of opening the
     * node the user meant to open. */
    if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
    drag.moved = true;
    /*
     * Claim the framing. A drag changes the canvas box, so if placeCamera()
     * kept re-centring on every frame it would slide the board sideways in
     * proportion to how far the node had moved — the node would appear to lag
     * the cursor, or barely move at all. Panning and zooming claim it for the
     * same reason; a first-time drag has to as well.
     */
    camTouched = true;
  }
  const wx = dx / zoom;
  const wy = dy / zoom;
  for (const [k, p] of Object.entries(drag.from)) {
    layoutPositions[k] = { x: Math.round(p.x + wx), y: Math.round(p.y + wy) };
  }
  schedule();
}

function endNodeDrag() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', endNodeDrag);
  window.removeEventListener('pointercancel', endNodeDrag);
  for (const el of document.querySelectorAll('.gnode.dragging')) el.classList.remove('dragging');
  const moved = !!(drag && drag.moved);
  drag = null;
  if (!moved) return;
  swallowUntil = Date.now() + 250; // the drag must not also open the node
  saveLayout();
}

/* ---------------- right-click ---------------- */

function canvasMenu(e) {
  const items = [{ label: 'Create conversation', onSelect: () => newChatBtn.click() }];
  if (!isFree()) {
    items.push({ sep: true });
    items.push({ label: 'Switch to Free', onSelect: () => setLayoutMode('free') });
  } else if (Object.keys(layoutPositions).length) {
    items.push({ sep: true });
    items.push({
      label: 'Reset positions',
      onSelect: () => {
        layoutPositions = {};
        saveLayout();
        schedule();
      },
    });
  }
  showMenu(e.clientX, e.clientY, items);
}

function convMenu(e, gnode) {
  const id = gnode.dataset.id;
  const isCurrent = id === state.currentId;
  const items = [];

  /* The active conversation is already open — offering "Open" for it would be
   * a row that does nothing. */
  if (!isCurrent) items.push({ label: 'Open', onSelect: () => selectConversation(id) });

  if (isCurrent) {
    if (state.explains.roots.length) {
      items.push({
        label: 'Show all explanations',
        onSelect: () => {
          for (const rid of state.explains.roots) {
            openExplains.add(rid);
            userCollapsed.delete(rid);
          }
          schedule();
        },
      });
    }
    items.push({ label: 'Show summary', onSelect: () => openSummary(id) });
  }

  items.push({ sep: true });
  items.push({
    label: 'Delete',
    danger: true,
    onSelect: () => {
      deleteConversation(id, e);
      delete layoutPositions['c:' + id];
      saveLayout();
    },
  });
  showMenu(e.clientX, e.clientY, items);
}

function explainMenu(e, gnode) {
  const id = gnode.dataset.id;
  const open = isExpOpen(id);
  showMenu(e.clientX, e.clientY, [
    { label: open ? 'Collapse' : 'Expand', onSelect: () => toggleExplain(id) },
    { sep: true },
    { label: 'Close explanation', danger: true, onSelect: () => confirmCloseExplain(gnode, id) },
  ]);
}

function onContextMenu(e) {
  if (state.view !== 'graph') return;
  const t = e.target;
  /* Leave the browser's menu alone over anything that is really a control — a
   * link still deserves "Open in new tab", a field still deserves "Paste". */
  if (t.closest && t.closest('a, input, textarea, select, [contenteditable]')) return;
  const sel = window.getSelection && window.getSelection();
  if (sel && String(sel).length) return; // right-clicking a selection copies it

  e.preventDefault();
  const gnode = t.closest && t.closest('.gnode');
  if (!gnode) return canvasMenu(e);
  /*
   * Inside the PARKED content — the live chat, an open explanation, the
   * summary — the browser's menu is the right one: that is where copy, paste
   * and "search with" live, and stealing it there would be a regression, not
   * an enhancement. The node's own chrome (header, preview, meta) is where the
   * object's menu belongs.
   */
  if (t.closest('.gn-host')) return;
  if (gnode.dataset.kind === 'conv') return convMenu(e, gnode);
  if (gnode.dataset.kind === 'explain') return explainMenu(e, gnode);
  return canvasMenu(e);
}

function setLayoutMode(mode) {
  const next = mode === 'free' ? 'free' : 'aligned';
  if (next === layoutMode) return;
  layoutMode = next;
  applyModeChrome();
  saveLayout();
  schedule();
}

function render() {
  if (state.view !== 'graph') return;

  /*
   * A newly created — or deliberately re-focused — explanation should show
   * itself. A transition of activeId is exactly those two events; once the
   * user folds a node the id stops changing, so the fold sticks.
   */
  const active = state.explains.activeId;
  if (active && active !== lastActive) {
    openExplains.add(active);
    userCollapsed.delete(active);
  }
  lastActive = active;

  const model = build();
  const { pos, W, H, minX, minY } = layout(model);

  const seen = new Set();
  for (const n of model.col0) {
    seen.add(n.key);
    const el = nodeFor(n);
    place(el, pos.get(n.key));
    if (n.kind === 'conv') applyConv(el, n);
  }
  for (const n of model.exps) {
    seen.add(n.key);
    const el = nodeFor(n);
    place(el, pos.get(n.key));
    applyExplain(el, n, model.idx);
  }

  for (const [key, el] of [...nodeEls]) {
    if (seen.has(key)) continue;
    putBack(hostedElement(el));
    el.remove();
    nodeEls.delete(key);
  }

  graphCanvas.style.width = W + 'px';
  graphCanvas.style.height = H + 'px';
  baseW = W;
  baseH = H;
  baseX = minX || 0;           // 0 in Aligned, wherever Free put the board
  baseY = minY || 0;
  placeCamera();               // only until the user claims the framing
  applyCamera();
  drawEdges(model, pos);
  syncHosts(model);

  graphEmpty.classList.toggle('hidden', state.conversations.length !== 0);
}

/* The one live element a removed node could still be holding. */
function hostedElement(el) {
  const kind = el.dataset.kind;
  if (kind === 'conv') return chatArea;
  if (kind === 'summary') return summaryOverlay;
  if (kind === 'explain' && el.dataset.id) return panelEl(el.dataset.id);
  return null;
}

/* ---------------- enter / exit ---------------- */

function closeSidebarQuietly() {
  state.sidebar.open = false;
  rightSidebar.classList.remove('open');
  rightSidebar.style.width = '0px';
}

function applyLabel() {
  const graph = state.view === 'graph';
  viewToggle.innerHTML = graph
    ? ico('clipboard') + '<span class="btn-label"> List</span>'
    : ico('map') + '<span class="btn-label"> Graph</span>';
  viewToggle.title = graph ? 'Back to the list layout' : 'Switch to the node graph';
  viewToggle.classList.toggle('on', graph);
}

function enterGraph() {
  state.view = 'graph';
  state.onGraphChange = schedule;
  try { localStorage.setItem('lb.view', 'graph'); } catch { /* private mode */ }
  document.body.classList.add('graph-mode');
  graphView.classList.remove('hidden');
  sidebarWasOpen = state.sidebar.open;
  closeSidebarQuietly();      // explanations are nodes here, not a panel
  for (const el of [summaryOverlay, settingsOverlay, libraryOverlay]) {
    overlayObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
  }
  applyLabel();
  render();
}

function exitGraph() {
  state.view = 'list';
  state.onGraphChange = null;
  hideMenu();
  if (drag) endNodeDrag();   // drop the window listeners with us
  try { localStorage.setItem('lb.view', 'list'); } catch { /* private mode */ }
  document.body.classList.remove('graph-mode');
  graphView.classList.add('hidden');
  overlayObserver.disconnect();

  restoreAll();
  for (const el of nodeEls.values()) el.remove();
  nodeEls.clear();
  openExplains.clear();
  userCollapsed.clear();
  collapsedConvs.clear();
  lastActive = null;
  while (graphPaths.firstChild) graphPaths.removeChild(graphPaths.firstChild);

  /*
   * An overlay left open in graph mode still needs the sidebar it lives in,
   * and so does an explain panel that was open when the user left list view.
   */
  const overlayOpen =
    !summaryOverlay.classList.contains('hidden') ||
    !settingsOverlay.classList.contains('hidden') ||
    !libraryOverlay.classList.contains('hidden');
  const explainsExist = Object.keys(state.explains.nodes).length > 0;
  if (!state.sidebar.open && (overlayOpen || (sidebarWasOpen && explainsExist))) {
    showSidebar(true);
  }
  sidebarWasOpen = false;
  updateCollapsed();
  applyLabel();
}

export function setView(view) {
  const want = view === 'graph' ? 'graph' : 'list';
  if (want === state.view) return;
  if (want === 'graph') enterGraph();
  else exitGraph();
}

/* ---------------- interactions ---------------- */

function reveal(id) {
  if (!state.explains.nodes[id]) return;
  openExplains.add(id);
  userCollapsed.delete(id);
  schedule();
}

function toggleExplain(id) {
  if (isExpOpen(id)) {
    openExplains.delete(id);
    userCollapsed.add(id);
  } else {
    openExplains.add(id);
    userCollapsed.delete(id);
  }
  schedule();
}

function toggleConv(id) {
  if (state.currentId !== id) {
    // Selecting always opens: the point of the node is to become the chat.
    collapsedConvs.delete(id);
    selectConversation(id);
    return;
  }
  if (collapsedConvs.has(id)) collapsedConvs.delete(id);
  else collapsedConvs.add(id);
  schedule();
}

async function openSummary(convId) {
  if (state.currentId !== convId) await selectConversation(convId);
  summaryBtn.click();
}

function doAct(btn) {
  const gnode = btn.closest('.gnode');
  if (!gnode) return;
  const kind = gnode.dataset.kind;
  const act = btn.dataset.act;
  if (act === 'toggle') {
    if (kind === 'conv') toggleConv(gnode.dataset.id);
    else if (kind === 'explain') toggleExplain(gnode.dataset.id);
    return;
  }
  if (act === 'close') { confirmCloseExplain(btn, gnode.dataset.id); return; }
  if (act === 'explains') {
    for (const id of state.explains.roots) {
      openExplains.add(id);
      userCollapsed.delete(id);
    }
    schedule();
    return;
  }
  if (act === 'summary') { openSummary(gnode.dataset.id); return; }
  if (act === 'refresh') { $('summary-refresh').click(); return; }
  if (act === 'close-summary') { $('summary-close').click(); return; }
}

function onGraphClick(e) {
  if (state.view !== 'graph') return;

  // A highlighted passage opens the node that explains it.
  const mark = e.target.closest && e.target.closest('mark.explain-src');
  if (mark && mark.dataset.id) { reveal(mark.dataset.id); return; }

  const act = e.target.closest('.gn-act');
  if (act) { doAct(act); return; }

  /*
   * Minimise, from the container's own header. The node's chevron is hidden
   * while an explanation is expanded — which is the only time this header is
   * visible — so without this button there is no way to fold one from where
   * you are reading it. stopImmediatePropagation holds off the .ex-head branch
   * below AND the activate handler attachExplainHandlers() binds here: letting
   * it fire would change activeId, and a changed activeId un-collapses the
   * node again on the next render.
   */
  const min = e.target.closest('.ex-collapse');
  if (min) {
    e.stopImmediatePropagation();
    const c = min.closest('.ex-container');
    if (c && c.dataset.id) toggleExplain(c.dataset.id);
    return;
  }

  if (e.target.closest('.add-node')) { newChatBtn.click(); return; }

  /*
   * Expanded explanation nodes show the container's own header (quote, badge,
   * busy dot, ✕) as their title bar. There, a bare click folds the node — the
   * controls inside it keep their normal meaning.
   */
  const exHead = e.target.closest('.ex-head');
  if (exHead && !e.target.closest('.ex-close, .ex-tab, button, a, input, textarea, mark')) {
    const c = exHead.closest('.ex-container');
    if (c && c.dataset.id) {
      toggleExplain(c.dataset.id);
      e.stopImmediatePropagation(); // suppress the activate handler
      return;
    }
  }

  // Clicks inside the parked chat/explain body act on their own content.
  if (e.target.closest('.gn-host')) return;

  const exNode = e.target.closest('.explain-node');
  if (exNode) { toggleExplain(exNode.dataset.id); return; }

  const convNode = e.target.closest('.conv-node');
  if (convNode) { toggleConv(convNode.dataset.id); return; }
}

/*
 * Explanations parked far outside the viewport fold back to their chip, which
 * is what keeps a long session scannable. Only ever collapses (never
 * re-opens), so it cannot fight the user; a render already pending wins.
 *
 * There is no scroll event to hang this off any more — the camera is a
 * transform — so it runs straight after every camera write instead.
 */
function foldOutOfView() {
  if (state.view !== 'graph') return;
  /* Node geometry is in unscaled world coordinates; the camera puts world y at
   * screen y = world * zoom + camY. Invert that so the slack stays 140 SCREEN
   * pixels rather than 140 world ones. */
  const top = -camY / zoom;
  const bot = top + graphScroll.clientHeight / zoom;
  const slack = 140 / zoom;
  let dirty = false;
  for (const [key, el] of nodeEls) {
    if (el.dataset.kind !== 'explain' || !el.classList.contains('expanded')) continue;
    const y = parseFloat(el.style.top) || 0;
    const h = parseFloat(el.style.height) || 0;
    if (y + h < top - slack || y > bot + slack) {
      openExplains.delete(el.dataset.id);
      userCollapsed.add(el.dataset.id);
      dirty = true;
    }
  }
  if (dirty) schedule();
}

/*
 * In graph mode the sidebar exists only to hold the Library and Settings
 * overlays — the explanation panels live on the canvas as nodes. So whatever
 * setSummaryOverlay()/settings/library just decided, this mirrors it onto the
 * panel: the summary node appears or disappears, and the sidebar opens only
 * while an overlay that actually lives inside it is showing.
 */
const overlayObserver = new MutationObserver(() => {
  if (state.view !== 'graph') return;
  const inPanel =
    !settingsOverlay.classList.contains('hidden') ||
    !libraryOverlay.classList.contains('hidden');
  if (inPanel) {
    if (!state.sidebar.open) showSidebar(true);
  } else {
    closeSidebarQuietly();
  }
  schedule(); // the summary node follows #summary-overlay.hidden
});

/* ---------------- helpers ---------------- */

function truncate(s, n = 80) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function when(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

/* ---------------- wiring ---------------- */

export function initGraph() {
  graphNodes.addEventListener('click', onGraphClick);
  attachExplainHandlers(graphNodes); // containers parked in nodes keep working
  /*
   * The list view binds "select text -> explain" to #explain-panels so a
   * selection inside a container becomes a child of it. In the graph view those
   * containers live under #graph-nodes instead, so the node layer needs the
   * same binding — resolving the containing .ex-container from wherever the
   * selection actually landed (a container, or the chat it is showing).
   */
  makeSelectionHandlers(graphNodes, (anchor) => {
    const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    const panel = el && el.closest('.ex-container');
    return panel ? panel.dataset.id : '';
  });
  /*
   * @use-gesture attaches the recognisers itself; `{ passive: false }` is what
   * lets the handler preventDefault a wheel it actually acts on, instead of
   * handing it to the browser. There is no 'scroll' listener any more — the
   * scroll box is gone with it.
   *
   * `pinchOnWheel: false` matters: pinchOnWheel defaults to TRUE, which would
   * put the pinch recogniser on the wheel too and let ctrl+wheel zoom twice —
   * once here and once in onPinch. Wheel is ours, pinch is for touchscreens.
   */
  new WheelGesture(graphScroll, onWheel, { eventOptions: { passive: false } });
  new PinchGesture(graphScroll, onPinch,
    { eventOptions: { passive: false }, pinchOnWheel: false });
  graphScroll.addEventListener('pointerdown', onPointerDown);
  graphScroll.addEventListener('pointermove', onPointerMove);
  graphScroll.addEventListener('pointerup', endPan);
  graphScroll.addEventListener('pointercancel', endPan);
  graphScroll.addEventListener('click', onClickCapture, true);
  window.addEventListener('pointerup', endPan);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { spaceDown = false; graphScroll.classList.remove('can-pan'); });
  /* The framing follows the viewport until the user claims it: a resize re-runs
   * render(), which re-centres (placeCamera) and re-folds what fell outside. */
  window.addEventListener('resize', schedule);
  railZoomIn && railZoomIn.addEventListener('click', () => setZoom(zoom * ZOOM_RATIO));
  railZoomOut && railZoomOut.addEventListener('click', () => setZoom(zoom / ZOOM_RATIO));
  railZoomLabel && railZoomLabel.addEventListener('click', () => setZoom(1));
  /* Empty workspace: there is no input row to type into (no conversation to
   * send to), so the whole job of starting one falls to this single button.
   * It goes through the same handler as the + node so both paths behave
   * identically — create, select, and the canvas repaints itself. */
  $('graph-empty-add').addEventListener('click', () => newChatBtn.click());
  /* Published so the workspace layer can jump back to 100% after you pick a
   * workspace — it must not import this module (graph.js is a leaf). */
  state.zoomTo = (z) => setZoom(z);
  state.zoomLevel = () => zoom;
  try {
    const saved = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (saved) zoom = clampZoom(saved);
  } catch { /* private mode */ }
  applyCamera();
  viewToggle.addEventListener('click', () => setView(state.view === 'graph' ? 'list' : 'graph'));
  railSettings.addEventListener('click', () => settingsBtn.click());
  /* Right-click and drag-to-place. Both are no-ops in Aligned — the menu still
   * offers "Create conversation" because that is useful either way, but only a
   * Free board can be rearranged. */
  graphScroll.addEventListener('contextmenu', onContextMenu);
  graphNodes.addEventListener('pointerdown', startNodeDrag);
  railLayout && railLayout.addEventListener('click', () => setLayoutMode(isFree() ? 'aligned' : 'free'));
  applyModeChrome();
  loadLayout();
  applyLabel();
  if (state.view === 'graph') enterGraph();
}
