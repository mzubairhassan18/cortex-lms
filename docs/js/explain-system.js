/* explain-system.js — split from public/app.js (app.js line 704-812). */
import { $, explainPanels, state } from './state.js';

/* ================= Explainer containers (recursive vertical splits) ================= */
/*
 * Design (desktop):
 * - The main conversation | explainer split can be squeezed so the main chat
 *   becomes a few-pixel line (double-click the divider to toggle).
 * - Selecting text in the MAIN chat opens a ROOT container (root tabs on top).
 * - Selecting text INSIDE a container splits it with a vertical divider,
 *   mirroring the main-chat | explainer layout:
 *       [parent content] | [newest child] | [older children ...]
 *   (the newest child sits closest to the parent content).
 * - Recursive: children split the same way at unlimited depth.
 * - Every pane is draggable down to a few pixels; a collapsed pane becomes a
 *   line that expands on click. Each container shows tabs for its children.
 * - Widths (w/cw) are snapshotted per conversation and restored on return.
 */

export function formatCtx(msgs) {
  return msgs
    .slice(-10)
    .map((m) => {
      const who = m.role === 'user' ? 'Student' : 'Tutor';
      const content = m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
      return `${who}: ${content}`;
    })
    .join('\n');
}

export function buildExplainSystem(selection, parentId) {
  const parent = parentId ? state.explains.nodes[parentId] : null;
  const lessonCtx = formatCtx(state.messages);

  if (!parent) {
    return [
      'You are a learning assistant embedded in a study app.',
      'The student is reading a lesson and selected text they did not fully understand.',
      '',
      'SELECTED TEXT:',
      selection,
      '',
      'LESSON CONTEXT (recent conversation):',
      lessonCtx || '(no context yet)',
      '',
      'Explain the selected text in simple, clear terms. Define any difficult words, terms, or concepts.',
      'Use short examples when helpful. Keep the explanation focused on the selected text.',
      'Format answers with Markdown when helpful (## headings, **bold**, lists) — reply directly, never inside a code fence.',
      'The student may ask follow-up questions in this panel — answer them using the lesson context above.',
    ].join('\n');
  }

  return [
    'You are a learning assistant embedded in a study app.',
    'The student is reading an explanation you gave and selected text inside it they did not fully understand.',
    '',
    'TEXT SELECTED FROM THE EXPLANATION:',
    selection,
    '',
    'THE EXPLANATION BEING READ (earlier exchange in this window):',
    formatCtx(parent.messages) || '(not available)',
    '',
    'ORIGINAL LESSON CONTEXT (recent conversation):',
    lessonCtx || '(no context yet)',
    '',
    'Explain the selected text in simple, clear terms. Define any difficult words, terms, or concepts.',
    'Use short examples when helpful. Keep the explanation focused on the selected text.',
    'Format answers with Markdown when helpful (## headings, **bold**, lists) — reply directly, never inside a code fence.',
    'The student may ask follow-up questions in this panel — answer them using the context above.',
  ].join('\n');
}

/* ---------- tree helpers ---------- */

/*
 * Element registry. panelEl()/childPane() used to querySelector the entire
 * panel tree on EVERY call, so any loop asking for each node (tab strips,
 * badges, restores) was O(n²) with a full tree walk each time.
 * Entries self-heal: an element removed without unregistering reports null.
 */
const panelEls = new Map();
const paneEls = new Map();

export function registerPanel(id, el) {
  panelEls.set(id, el);
}
export function registerPane(id, pane) {
  paneEls.set(id, pane);
}
export function unregisterNode(id) {
  panelEls.delete(id);
  paneEls.delete(id);
}
export function clearPanelRegistry() {
  panelEls.clear();
  paneEls.clear();
}

export function panelEl(id) {
  const el = panelEls.get(id);
  return el && el.isConnected ? el : null;
}

export function childPane(id) {
  const pane = paneEls.get(id);
  return pane && pane.isConnected ? pane : null;
}

export function activeNode() {
  return state.explains.nodes[state.explains.activeId] || null;
}

export function childrenOf(id) {
  return Object.values(state.explains.nodes)
    .filter((n) => n.parentId === id)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/* parent id -> children, sorted by creation, built in ONE pass. Callers that
 * need every node's children use this instead of calling childrenOf() per node
 * (which would re-scan the whole node table each time). */
export function childrenIndex() {
  const idx = new Map();
  for (const n of Object.values(state.explains.nodes)) {
    if (!n.parentId) continue;
    let arr = idx.get(n.parentId);
    if (!arr) idx.set(n.parentId, (arr = []));
    arr.push(n);
  }
  for (const arr of idx.values()) arr.sort((a, b) => a.createdAt - b.createdAt);
  return idx;
}

export function subtreeIds(id) {
  const idx = childrenIndex();
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    const kids = idx.get(out[i]);
    if (kids) for (const n of kids) out.push(n.id);
  }
  return out;
}

export function rootAncestorOf(id) {
  let n = state.explains.nodes[id];
  while (n && n.parentId && state.explains.nodes[n.parentId]) {
    n = state.explains.nodes[n.parentId];
  }
  return n || null;
}

export function truncateLabel(s, max = 26) {
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}
