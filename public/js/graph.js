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
import { selectConversation } from './conversations.js';
import { showSidebar, updateCollapsed } from './explain-ui.js';
import { attachExplainHandlers } from './interactions.js';
import { $, explainPanels, state } from './state.js';
import { makeSelectionHandlers } from './selection.js';

/* ---------------- refs ---------------- */

const graphView = $('graph-view');
const graphScroll = $('graph-scroll');
const graphCanvas = $('graph-canvas');
const graphPaths = $('graph-paths');
const graphNodes = $('graph-nodes');
const graphEmpty = $('graph-empty');
const viewToggle = $('view-toggle');
const railSettings = $('rail-settings');
const railZoomIn = $('rail-zoom-in');
const railZoomOut = $('rail-zoom-out');
const railZoomLabel = $('rail-zoom-label');
const graphZoomer = $('graph-zoomer');

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
  if (!summaryOverlay.classList.contains('hidden')) col0.push({ key: 'summary', kind: 'summary' });
  col0.push({ key: 'add:top', kind: 'add' });
  for (const c of state.conversations) {
    col0.push({ key: 'c:' + c.id, kind: 'conv', id: c.id, data: c });
  }
  col0.push({ key: 'add:bottom', kind: 'add' });

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

/*
 * Column 0 is a plain vertical stack (summary, +, conversations, +).
 * Every explanation is a tree hanging off column 0, laid out so a parent sits
 * centred on its children: leaves are placed top-down, parents fill in
 * afterwards at the midpoint of the span their subtree occupies.
 */
function layout(model) {
  const pos = new Map();
  let y = 0;
  let col0w = 0;
  for (const n of model.col0) {
    const s = sizeOf(n);
    pos.set(n.key, { x: 0, y, w: s.w, h: s.h });
    y += s.h + (n.kind === 'add' ? 18 : GAP_Y);
    if (s.w > col0w) col0w = s.w;
  }

  if (!model.exps.length) return { pos, W: col0w, H: y };

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

  /* Anchor the forest to the current conversation's node so the arrows read as
   * "this conversation, then its explanations". Every root forest starts at
   * least that far down, and each one continues below the last. */
  const cur = pos.get('c:' + state.currentId);
  const minY = cur ? cur.y : 0;
  let cursor = minY;
  let forestBottom = minY;   // lowest edge any explanation reached

  const place = (id, depth) => {
    const key = 'e:' + id;
    const s = sizeOf({ kind: 'explain', id });
    const kids = model.idx.get(id) || [];
    if (!kids.length) {
      pos.set(key, { x: depthX.get(depth), y: cursor, w: s.w, h: s.h });
      return { top: cursor, bottom: cursor + s.h };
    }
    // Leave the parent's top half in the slot above its children.
    let next = cursor + Math.ceil(s.h / 2);
    let top = Infinity;
    let bottom = -Infinity;
    for (const k of kids) {
      const r = placeAt(k.id, depth + 1, next);
      next = r.bottom + GAP_Y;
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
    }
    const myTop = Math.max(cursor, (top + bottom) / 2 - s.h / 2);
    pos.set(key, { x: depthX.get(depth), y: myTop, w: s.w, h: s.h });
    return { top: Math.min(top, myTop), bottom: Math.max(bottom, myTop + s.h) };
  };

  const placeAt = (id, depth, at) => {
    const save = cursor;
    cursor = at;
    const r = place(id, depth);
    cursor = save;
    return r;
  };

  for (const r of model.roots) {
    cursor = Math.max(cursor, minY);
    const sub = place(r, 1);
    if (sub.bottom > forestBottom) forestBottom = sub.bottom;
    cursor = sub.bottom + GAP_Y * 1.4;
  }

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

  let W = col0w;
  let H = y;
  for (const p of pos.values()) {
    if (p.x + p.w > W) W = p.x + p.w;
    if (p.y + p.h > H) H = p.y + p.h;
  }
  return { pos, W, H };
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

/* ---------------- zoom & pan ---------------- */

const ZOOM_KEY = 'lb.zoom';
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;
const ZOOM_RATIO = 1.2;   // one press, one notch on the ladder

let zoom = 1;
let baseW = 0;            // unscaled canvas size, straight from layout()
let baseH = 0;

const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/*
 * #graph-zoomer's box is the SCALED size, so the scrollbars agree with what
 * is painted; #graph-canvas keeps its real size and is only painted larger.
 * That keeps every child that is sized `inset: 0` (the SVG edge layer, the
 * node layer) in unscaled coordinates — no coordinate maths anywhere else.
 */
function applyZoom() {
  graphZoomer.style.width = (baseW * zoom) + 'px';
  graphZoomer.style.height = (baseH * zoom) + 'px';
  graphCanvas.style.transform = zoom === 1 ? '' : 'scale(' + zoom + ')';
  if (railZoomLabel) railZoomLabel.textContent = Math.round(zoom * 100) + '%';
  /* Tell whoever cares (the workspace layer) that we crossed out of the
   * conversation level. Same indirection as state.onGraphChange: the zoom
   * owner never imports its observers, so there is no module cycle. */
  if (state.onZoomChange) state.onZoomChange(zoom);
}

/* Zoom around a point of the viewport so what you are looking at stays put.
 * cx/cy default to the centre of the viewport. */
function setZoom(next, cx, cy) {
  next = clampZoom(next);
  if (next === zoom) return;
  const el = graphScroll;
  const ax = cx == null ? el.clientWidth / 2 : cx;
  const ay = cy == null ? el.clientHeight / 2 : cy;
  const px = (el.scrollLeft + ax) / zoom;
  const py = (el.scrollTop + ay) / zoom;

  zoom = next;
  applyZoom();

  el.scrollLeft = px * zoom - ax;
  el.scrollTop = py * zoom - ay;
  try { localStorage.setItem(ZOOM_KEY, String(zoom)); } catch { /* private mode */ }
}

/* Ctrl/Cmd + wheel zooms; a plain wheel keeps scrolling natively. */
function onWheel(e) {
  if (state.view !== 'graph') return;
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const r = graphScroll.getBoundingClientRect();
  setZoom(zoom * Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
}

/* --- drag-to-pan (Figma style) --- */

let pan = null;             // { id, x, y, sl, st, moved } while a drag is live
let spaceDown = false;
let swallowUntil = 0;       // a drag must not also fire the underlying click

const isTyping = (t) => !!t && (
  t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
  t.tagName === 'SELECT' || t.isContentEditable
);

function canPanFrom(e) {
  if (e.pointerType && e.pointerType !== 'mouse') return false; // touch keeps native scroll
  if (state.view !== 'graph') return false;
  if (e.button === 1) return true;                 // middle button: anywhere
  if (e.button !== 0) return false;
  if (spaceDown) return true;                      // space held: anywhere
  return !e.target.closest('.gnode');              // left button: the board only
}

function onPointerDown(e) {
  if (!canPanFrom(e)) return;
  pan = { id: e.pointerId, x: e.clientX, y: e.clientY,
          sl: graphScroll.scrollLeft, st: graphScroll.scrollTop, moved: false };
}

function endPan(e) {
  if (!pan) return;
  if (e && e.pointerId != null && e.pointerId !== pan.id) return;
  const moved = pan.moved;
  pan = null;
  graphScroll.classList.remove('panning');
  if (e && e.pointerId != null) {
    try { graphScroll.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  }
  if (moved) swallowUntil = Date.now() + 250;
}

function onPointerMove(e) {
  if (!pan || e.pointerId !== pan.id) return;
  if (!e.buttons) { endPan(e); return; }           // released outside our reach
  const dx = e.clientX - pan.x;
  const dy = e.clientY - pan.y;
  if (!pan.moved) {
    if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    pan.moved = true;
    graphScroll.classList.add('panning');
    try { graphScroll.setPointerCapture(e.pointerId); } catch { /* fine */ }
  }
  graphScroll.scrollLeft = pan.sl - dx;            // grab the board and drag it
  graphScroll.scrollTop = pan.st - dy;
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
  const { pos, W, H } = layout(model);

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
  applyZoom();
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
 */
function onScroll() {
  if (state.view !== 'graph') return;
  /* Node geometry is in unscaled canvas coordinates; the scroll offsets are
   * in scaled ones. Divide so the 140px slack stays 140 SCREEN pixels. */
  const top = graphScroll.scrollTop / zoom;
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
  graphScroll.addEventListener('scroll', onScroll, { passive: true });
  graphScroll.addEventListener('wheel', onWheel, { passive: false });
  graphScroll.addEventListener('pointerdown', onPointerDown);
  graphScroll.addEventListener('pointermove', onPointerMove);
  graphScroll.addEventListener('pointerup', endPan);
  graphScroll.addEventListener('pointercancel', endPan);
  graphScroll.addEventListener('click', onClickCapture, true);
  window.addEventListener('pointerup', endPan);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { spaceDown = false; graphScroll.classList.remove('can-pan'); });
  railZoomIn && railZoomIn.addEventListener('click', () => setZoom(zoom * ZOOM_RATIO));
  railZoomOut && railZoomOut.addEventListener('click', () => setZoom(zoom / ZOOM_RATIO));
  railZoomLabel && railZoomLabel.addEventListener('click', () => setZoom(1));
  /* Published so the workspace layer can jump back to 100% after you pick a
   * workspace — it must not import this module (graph.js is a leaf). */
  state.zoomTo = (z) => setZoom(z);
  state.zoomLevel = () => zoom;
  try {
    const saved = parseFloat(localStorage.getItem(ZOOM_KEY));
    if (saved) zoom = clampZoom(saved);
  } catch { /* private mode */ }
  applyZoom();
  viewToggle.addEventListener('click', () => setView(state.view === 'graph' ? 'list' : 'graph'));
  railSettings.addEventListener('click', () => settingsBtn.click());
  applyLabel();
  if (state.view === 'graph') enterGraph();
}
