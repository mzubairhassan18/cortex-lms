/* explain-lifecycle.js — split from public/app.js (app.js line 1088-1360). */
import { persist } from './chat.js';
import { buildExplainSystem, childPane, clearPanelRegistry, panelEl, subtreeIds, truncateLabel, unregisterNode } from './explain-system.js';
import { activateExplain, hideExplainPanel, mountNode, renderAllChildTabs, renderChildTabs, renderExplainTabs, renderPanelMessages, showSidebar, updateCollapsedSoon, updateExplainToggle, updateRootVisibility, updateRowState, updateRowStates } from './explain-ui.js';
import { boxOf, highlightSources, refreshAllHighlights } from './highlight.js';
import { autoResize } from './interactions.js';
import { $, explainPanels, explainTabs, input, messagesEl, popup, state } from './state.js';
import { cleanHistory, makeStreamer, scrollDown, streamChat } from './stream.js';

/* ---------- streaming into a container ---------- */

export function explainApiMessages(node) {
  return [
    { role: 'system', content: node.system },
    { role: 'user', content: 'Explain the selected text above to me.' },
    ...cleanHistory(node.messages),
  ];
}

export function finishExplainStream(node, streamId, full) {
  if (streamId !== node.streamId) return;             // stale stream
  if (state.explains.nodes[node.id] !== node) return; // container was closed
  node.busy = false;
  node.controller = null;
  if (full && full.trim()) {
    node.messages.push({ role: 'assistant', content: full });
  }
  renderPanelMessages(node);
  updateRowState(node);
  if (state.explains.activeId === node.id) {
    const el = panelEl(node.id);
    const ta = el && el.querySelector('.ep-input');
    if (ta) ta.focus();
  }
  persist();
}

export function startExplainStream(node) {
  node.busy = true;
  const streamId = ++node.streamId;
  const controller = new AbortController();
  node.controller = controller;
  updateRowState(node);

  const el = panelEl(node.id);
  const box = el ? el.querySelector('.explain-messages') : null;
  if (!box) {
    // Panel not mounted — leave no stale controller or busy flag behind.
    node.busy = false;
    node.controller = null;
    updateRowState(node);
    return;
  }

  const streamer = makeStreamer(box, (full) => finishExplainStream(node, streamId, full));
  streamer.start();
  streamChat(explainApiMessages(node), streamer, controller.signal);
}

/* ---------- container lifecycle ---------- */

export function createExplainWindow(selection, parentId = null) {
  const parent = parentId ? state.explains.nodes[parentId] : null;
  const effectiveParent = parent ? parent.id : null;

  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const node = {
    id,
    parentId: effectiveParent,
    selection,
    system: buildExplainSystem(selection, effectiveParent),
    messages: [],
    busy: false,
    streamId: 0,
    controller: null,
    createdAt: Date.now(),
    w: 1.5,   // share inside the parent's split (children start bigger)
    cw: 1,    // the container's own content-pane share
  };

  state.explains.nodes[id] = node;
  if (effectiveParent === null) state.explains.roots.push(id);

  mountNode(node);
  // The new container's selection must light up where it was taken from.
  highlightSources(effectiveParent ? boxOf(effectiveParent) : messagesEl, effectiveParent);
  if (effectiveParent) {
    renderChildTabs(effectiveParent);
    updateRowState(state.explains.nodes[effectiveParent]);
  } else {
    renderExplainTabs();
  }

  showSidebar(); // never replaces existing containers
  activateExplain(id);
  updateCollapsedSoon();
  startExplainStream(node);
}

export function closeExplainWindow(id) {
  const node = state.explains.nodes[id];
  if (!node) return;

  const parentId = node.parentId;
  const doomed = subtreeIds(id);
  const activeDoomed = doomed.includes(state.explains.activeId);

  /* Snapshot the DOM before the registry is torn down. A container may be
   * parked inside a graph node rather than in its pane, so it has to be
   * removed by reference — clearing the mount below would miss it. */
  const doms = doomed.map((did) => ({ el: panelEl(did), pane: childPane(did) }));

  // Aborted streams end quietly (finishExplainStream sees the node is gone).
  for (const did of doomed) {
    const n = state.explains.nodes[did];
    if (n && n.controller) n.controller.abort();
    delete state.explains.nodes[did];
    unregisterNode(did); // drop its DOM registry entries too
  }

  for (const { el, pane } of doms) {
    if (el) el.remove(); // wherever it currently lives
    if (pane) {
      const vdiv = pane.previousElementSibling; // this pane's divider
      if (vdiv && vdiv.classList.contains('ex-vdiv')) vdiv.remove();
      pane.remove();
    }
  }
  if (!parentId) {
    state.explains.roots = state.explains.roots.filter((r) => r !== id);
  }

  if (state.explains.roots.length === 0) {
    state.explains.activeId = null;
    hideExplainPanel();
  } else if (activeDoomed) {
    const fallback =
      parentId && state.explains.nodes[parentId]
        ? parentId
        : state.explains.roots[state.explains.roots.length - 1];
    state.explains.activeId = null; // force activateExplain to run
    activateExplain(fallback);
  }

  if (parentId && state.explains.nodes[parentId]) {
    renderChildTabs(parentId);
    updateRowState(state.explains.nodes[parentId]);
  }
  renderExplainTabs();
  renderAllChildTabs();
  updateRootVisibility();
  updateExplainToggle();
  updateCollapsedSoon();
  refreshAllHighlights(); // closed windows lose their highlight
  persist();
}

/* ---------- delete confirmation ----------
 * Closing a container deletes it (and its nested ones) permanently, so each
 * ✕ first asks via a small styled prompt anchored right next to that button. */
export const confirmPopup = $('confirm-popup');
export const confirmMsg = confirmPopup.querySelector('.confirm-msg');
export let confirmTargetId = null;

export function hideConfirm() {
  confirmPopup.style.display = 'none';
  confirmTargetId = null;
}

export function confirmCloseExplain(anchor, id) {
  const node = state.explains.nodes[id];
  if (!node) return;
  if (confirmTargetId === id) { hideConfirm(); return; } // same ✕ toggles it off

  const kids = subtreeIds(id).length - 1;
  confirmTargetId = id;
  confirmMsg.textContent =
    kids > 0
      ? `Delete "${truncateLabel(node.selection, 30)}" and its ${kids} nested container${kids > 1 ? 's' : ''}? This cannot be undone.`
      : `Delete "${truncateLabel(node.selection, 30)}"? This explanation will be deleted permanently.`;
  confirmPopup.style.display = 'flex';

  // Pin the prompt next to the ✕, keeping it inside the viewport.
  const r = anchor.getBoundingClientRect();
  const w = confirmPopup.offsetWidth;
  const h = confirmPopup.offsetHeight;
  let left = r.right - w;
  if (left < 8) left = Math.min(r.left, window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8) top = r.top - h - 6;
  confirmPopup.style.left = `${Math.max(8, left)}px`;
  confirmPopup.style.top = `${Math.max(8, top)}px`;
}

confirmPopup.addEventListener('click', (e) => {
  if (e.target.closest('.confirm-cancel')) { hideConfirm(); return; }
  if (e.target.closest('.confirm-ok')) {
    const id = confirmTargetId;
    hideConfirm();
    if (id) closeExplainWindow(id);
  }
});

/* Outside click or Escape dismisses without deleting (the ✕ itself is
 * excluded so clicking it again toggles the prompt instead). */
document.addEventListener('mousedown', (e) => {
  if (confirmPopup.style.display === 'none') return;
  if (confirmPopup.contains(e.target)) return;
  if (e.target.closest('.ex-close, .tab-close')) return;
  hideConfirm();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && confirmPopup.style.display !== 'none') hideConfirm();
});

/* Full reset — used when switching/creating conversations (fresh panel). */
export function clearExplainWindows() {
  for (const n of Object.values(state.explains.nodes)) {
    if (n.controller) n.controller.abort();
  }
  /* Remove each container by reference before the table is dropped: a
   * container parked inside a graph node is not a descendant of the mount, so
   * clearing its innerHTML below would leak it. */
  for (const id of Object.keys(state.explains.nodes)) {
    const el = panelEl(id);
    if (el) el.remove();
  }
  state.explains.nodes = {};
  state.explains.roots = [];
  state.explains.activeId = null;
  explainPanels.innerHTML = '';
  explainTabs.innerHTML = '';
  clearPanelRegistry(); // the elements above are gone — forget their refs
  hideExplainPanel();
  updateExplainToggle();
  // The panel no longer holds any nodes, so the marks left in the main chat
  // have nothing to point at — unwrap them.
  refreshAllHighlights();
}

/* Rebuild containers from a conversation's saved snapshot (no streaming). */
export function restoreExplainWindows(snapshot) {
  if (!snapshot || !snapshot.nodes) return;

  const saved = Object.values(snapshot.nodes);
  if (!saved.length) return;

  for (const s of saved.sort((a, b) => a.createdAt - b.createdAt)) {
    // Orphans (parent lost or not mounted) are promoted to roots.
    const parentId =
      s.parentId && snapshot.nodes[s.parentId] && panelEl(s.parentId) ? s.parentId : null;
    const node = {
      id: s.id,
      parentId,
      selection: s.selection,
      system: s.system || buildExplainSystem(s.selection, parentId),
      messages: Array.isArray(s.messages) ? s.messages : [],
      busy: false,
      streamId: 0,
      controller: null,
      createdAt: s.createdAt || Date.now(),
      w: typeof s.w === 'number' ? s.w : 1.5,
      cw: typeof s.cw === 'number' ? s.cw : 1,
    };
    state.explains.nodes[node.id] = node;
    if (parentId === null) state.explains.roots.push(node.id);
    mountNode(node);
  }

  // Keep only roots that still exist, preserving saved order.
  const roots = (snapshot.roots || []).filter((r) => state.explains.nodes[r]);
  for (const r of state.explains.roots) if (!roots.includes(r)) roots.push(r);
  state.explains.roots = roots;

  if (roots.length === 0) return;

  const activeValid = snapshot.activeId && state.explains.nodes[snapshot.activeId];
  state.explains.activeId = activeValid ? snapshot.activeId : roots[0];

  showSidebar();
  renderExplainTabs();
  renderAllChildTabs();
  updateRootVisibility();
  updateExplainToggle();
  updateRowStates();
  updateCollapsedSoon();
  refreshAllHighlights();
  persist();
}

export function sendExplain(container) {
  const node = state.explains.nodes[container.dataset.id];
  const ta = container.querySelector('.ep-input');
  const text = ta.value.trim();
  if (!node || node.busy || !text) return;
  ta.value = '';
  autoResize(ta);

  node.messages.push({ role: 'user', content: text });
  renderPanelMessages(node);
  scrollDown(container.querySelector('.explain-messages'));
  startExplainStream(node);
}
