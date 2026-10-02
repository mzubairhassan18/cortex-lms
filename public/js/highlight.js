/* highlight.js — split from public/app.js (app.js line 2374-2500). */
import { persist } from './chat.js';
import { childPane, panelEl } from './explain-system.js';
import { activateExplain, paneGrow, setPaneGrow, showSidebar, updateCollapsedSoon } from './explain-ui.js';
import { messagesEl, state } from './state.js';

/* ================= Source-text highlighting ================= */
/*
 * Text that has an explanation gets highlighted in its origin — the main
 * chat for root containers, the parent container for nested ones.
 * Clicking a highlight instantly focuses (and widens) that container.
 */

export function boxOf(id) {
  const el = panelEl(id);
  return el ? el.querySelector('.explain-messages') : null;
}

/* Rebuild every highlight for the nodes whose selection origin is originId.
 * originId === null -> main chat.
 *
 * `force` unwraps even when nothing targets this box. That is needed after a
 * node was deleted: its marks still exist but its target no longer does, so
 * the "no targets -> skip" shortcut below would leave them stranded. */
export function highlightSources(box, originId, force) {
  if (!box) return;
  const targets = Object.values(state.explains.nodes)
    .filter((n) => (n.parentId || null) === (originId || null))
    .filter((n) => n.selection && n.selection.trim())
    .sort((a, b) => a.createdAt - b.createdAt);
  // Nothing to mark and nothing to unmark -> skip the whole pass. This is the
  // common case (no explainers open), and it used to walk and rewrite the box
  // on every single message render.
  if (!targets.length && !force) return;
  unwrapMarks(box); // rebuild from scratch (simple and safe)
  for (const t of targets) wrapFirstOccurrence(box, t.selection.trim(), t.id);
}

/* Unwrap previous marks — rebuild from scratch (simple and safe). */
function unwrapMarks(box) {
  box.querySelectorAll('mark.explain-src').forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize(); // merge split text nodes back together
  });
}

/* Build the text-node map for a box once (offset of every text node). */
function gatherText(box) {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const starts = [];
  let full = '';
  let n;
  while ((n = walker.nextNode())) {
    starts.push([n, full.length]);
    full += n.nodeValue;
  }
  return { full, starts };
}

export function wrapFirstOccurrence(box, text, id) {
  // Gather ONCE per call. wrapRange only mutates the DOM when it succeeds (and
  // then we return immediately), and the "already wrapped" branch never
  // mutates — so re-walking the whole box on every attempt was pure waste.
  const { full, starts } = gatherText(box);

  let from = 0;
  for (;;) {
    const idx = full.indexOf(text, from);
    if (idx === -1) return; // not found (markdown transformed it) — skip silently
    const loc = locateOffset(starts, idx);
    // Skip occurrences already inside another highlight (shared wording).
    if (
      loc &&
      loc.node.parentElement &&
      loc.node.parentElement.closest('mark.explain-src')
    ) {
      from = idx + 1;
      continue;
    }
    if (wrapRange(starts, idx, idx + text.length, id)) return;
    from = idx + 1; // odd layout — try the next occurrence
  }
}

export function locateOffset(starts, pos) {
  for (const [node, off] of starts) {
    if (pos >= off && pos < off + node.nodeValue.length) return { node, off };
  }
  return null;
}

export function wrapRange(starts, s, e, id) {
  let startNode = null;
  let startOff = 0;
  let endNode = null;
  let endOff = 0;
  for (const [node, off] of starts) {
    const len = node.nodeValue.length;
    if (!startNode && s >= off && s < off + len) {
      startNode = node;
      startOff = s - off;
    }
    if (e > off && e <= off + len) {
      endNode = node;
      endOff = e - off;
      break;
    }
  }
  if (!startNode || !endNode) return false;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const mark = document.createElement('mark');
    mark.className = 'explain-src';
    mark.dataset.id = id;
    mark.title = 'Explanation ready — click to open it';
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    return true;
  } catch {
    return false;
  }
}

export function refreshAllHighlights() {
  // force: after a delete there are marks but no targets left to explain them.
  highlightSources(messagesEl, null, true);
  for (const id of Object.keys(state.explains.nodes)) {
    highlightSources(boxOf(id), id, true);
  }
}

/* Clicking a highlighted passage: bring its container up, widen it at once. */
export function focusExplainFromMark(id) {
  const node = state.explains.nodes[id];
  if (!node) return;
  if (!state.sidebar.open) showSidebar();
  activateExplain(id); // root tab switch, scroll into view, tab highlight
  const pane = childPane(id);
  if (pane) {
    // Give it a dominant share instantly (but never shrink what user sized up).
    setPaneGrow(pane, Math.max(paneGrow(pane), 3));
    updateCollapsedSoon();
    persist();
  }
}
