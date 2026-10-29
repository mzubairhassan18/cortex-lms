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
 *
 * Notes reuse the same machinery: a note leaves a soft highlight (mark.note-hl)
 * with a small pin icon, persisted via state.notes. No panel, no AI — just a
 * durable mark on the text the user saved.
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

/* Rebuild every note highlight for the notes whose origin is originId. */
export function highlightNotes(box, originId) {
  if (!box) return;
  const targets = (state.notes || [])
    .filter((n) => (n.origin || null) === (originId || null))
    .filter((n) => (n.raw || n.text) && (n.raw || n.text).trim())
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  if (!targets.length) {
    if (box.querySelector('mark.note-hl')) unwrapNoteMarks(box);
    return;
  }
  unwrapNoteMarks(box);
  for (const t of targets) wrapFirstOccurrence(box, (t.raw || t.text).trim(), t.id, 'note');
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

/* Unwrap note marks — rebuild from scratch (simple and safe). */
export function unwrapNoteMarks(box) {
  if (!box) return;
  box.querySelectorAll('mark.note-hl').forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    Array.from(m.childNodes).forEach((c) => {
      const isPin =
        c.nodeType === 1 &&
        (c.classList?.contains('note-pin') ||
          (c.getAttribute && (c.getAttribute('class') || '').includes('note-pin')));
      if (isPin) return; // discard the pin with the mark
      parent.insertBefore(c, m);
    });
    parent.removeChild(m);
    parent.normalize();
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

export function wrapFirstOccurrence(box, text, id, kind = 'explain') {
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
      (loc.node.parentElement.closest('mark.explain-src') ||
        loc.node.parentElement.closest('mark.note-hl'))
    ) {
      from = idx + 1;
      continue;
    }
    if (wrapRange(starts, idx, idx + text.length, id, kind)) return;
    from = idx + 1; // odd layout — try the next occurrence
  }
}

export function locateOffset(starts, pos) {
  for (const [node, off] of starts) {
    if (pos >= off && pos < off + node.nodeValue.length) return { node, off };
  }
  return null;
}

export function wrapRange(starts, s, e, id, kind = 'explain') {
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
    if (kind === 'note') {
      mark.className = 'note-hl';
      mark.title = 'Note';
      const pin = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      pin.setAttribute('class', 'ico note-pin');
      pin.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-pin');
      pin.appendChild(use);
      mark.appendChild(pin);
    } else {
      mark.className = 'explain-src';
      mark.title = 'Explanation ready — click to open it';
    }
    mark.dataset.id = id;
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
  highlightNotes(messagesEl, null);
  for (const id of Object.keys(state.explains.nodes)) {
    highlightSources(boxOf(id), id, true);
    highlightNotes(boxOf(id), id);
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
