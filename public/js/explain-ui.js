/* explain-ui.js — split from public/app.js (app.js line 813-1087). */
import { persist } from './chat.js';
import { hideConfirm } from './explain-lifecycle.js';
import {
  childrenIndex,
  childPane,
  childrenOf,
  panelEl,
  registerPane,
  registerPanel,
  rootAncestorOf,
  truncateLabel,
} from './explain-system.js';
import { highlightSources } from './highlight.js';
import { closeLibrary } from './library.js';
import { decorateCopy, escapeHtml, messageVNode } from './markdown.js';
import { setSummaryOverlay } from './overlays.js';
import { $, chatArea, explainPanels, explainTabs, explainsCount, explainsToggle, input, rightSidebar, state } from './state.js';
import { scrollDown } from './stream.js';
import { Fragment, hostFor, html, render } from './views.js';

/* ---------- container DOM ---------- */

export function createPanelEl(node) {
  const el = document.createElement('div');
  el.className = 'ex-container';
  el.dataset.id = node.id;
  el.innerHTML = `
    <div class="ex-head" title="${escapeHtml(node.selection)}">
      <span class="ex-quote">💡 "${escapeHtml(node.selection)}"</span>
      <span class="ex-badge" hidden></span>
      <span class="ex-busy" hidden>●●●</span>
      <button class="ex-btn ex-close" title="Close this container and its nested ones">✕</button>
    </div>
    <div class="ex-ctabs" hidden></div>
    <div class="ex-split">
      <div class="ex-pane ex-content">
        <div class="explain-messages"></div>
        <form class="ep-input-form">
          <textarea class="ep-input" rows="1" placeholder="Ask a follow-up question..."></textarea>
          <button type="submit" class="ep-send" title="Send">➤</button>
        </form>
      </div>
    </div>`;
  const content = el.querySelector('.ex-content');
  content.style.flexGrow = String(typeof node.cw === 'number' ? node.cw : 1);
  return el;
}

/*
 * Mount a container: roots go straight into the mount; children get a flex
 * pane + vertical divider inserted right AFTER the parent's content pane, so
 * the newest child always sits next to the parent content:
 *     [parent content] | [newest] | [older ...]
 */
export function mountNode(node) {
  const el = createPanelEl(node);
  registerPanel(node.id, el);
  // Render content only once the element is findable in the DOM.
  const done = () => {
    renderPanelMessages(node);
    updateRowState(node);
    return el;
  };
  if (!node.parentId) {
    explainPanels.appendChild(el);
    return done();
  }
  const parentEl = panelEl(node.parentId);
  if (!parentEl) {          // parent missing -> mount as root instead
    explainPanels.appendChild(el);
    return done();
  }
  const split = parentEl.querySelector(':scope > .ex-split');
  const content = split.querySelector(':scope > .ex-content');
  const ref = content.nextElementSibling;
  const vdiv = document.createElement('div');
  vdiv.className = 'ex-vdiv';
  const pane = document.createElement('div');
  pane.className = 'ex-pane ex-child';
  pane.dataset.child = node.id;
  pane.style.flexGrow = String(typeof node.w === 'number' ? node.w : 1.5);
  pane.appendChild(el);
  split.insertBefore(vdiv, ref);
  split.insertBefore(pane, ref);
  registerPane(node.id, pane);
  return done();
}

export function renderPanelMessages(node) {
  const el = panelEl(node.id);
  if (!el) return;
  const box = el.querySelector('.explain-messages');
  // Preact renders into a host; the streaming bubble (makeStreamer) is appended
  // to `box` directly and stays a sibling Preact never touches.
  const host = hostFor(box);
  render(
    node.messages.length
      ? html`<${Fragment}>${node.messages.map((m, i) => messageVNode(m, i, node.id))}<//>`
      : html`<div class="empty">The explanation will appear here.</div>`,
    host
  );
  decorateCopy(host);
  highlightSources(host, node.id); // nested selections made in this container
  scrollDown(box);
}

/* ---------- chrome: tabs, badges, visibility, collapsed lines ---------- */

export function renderExplainTabs() {
  const activeRoot = state.explains.activeId ? rootAncestorOf(state.explains.activeId) : null;
  explainTabs.innerHTML = state.explains.roots
    .filter((id) => state.explains.nodes[id])
    .map((id) => {
      const n = state.explains.nodes[id];
      const kids = childrenOf(id).length;
      return `
        <button class="explain-tab ${activeRoot && id === activeRoot.id ? 'active' : ''}" data-id="${id}" title="${escapeHtml(n.selection)}">
          <span class="tab-label">💡 ${escapeHtml(truncateLabel(n.selection))}</span>
          ${kids ? `<span class="tab-count">${kids}</span>` : ''}
          <span class="tab-close" data-close="${id}" title="Close this container and its nested ones">✕</span>
        </button>`;
    })
    .join('');
}

/* Per-container tab strip listing that container's children.
 * `kids` is optional: pass a pre-built list when rendering every strip. */
export function renderChildTabs(parentId, kids) {
  const parentEl = panelEl(parentId);
  if (!parentEl) return;
  const box = parentEl.querySelector(':scope > .ex-ctabs');
  if (!box) return;
  const list = kids || childrenOf(parentId);
  if (!list.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = list
    .map(
      (c) => `
      <button class="ex-tab ${state.explains.activeId === c.id ? 'active' : ''}" data-id="${c.id}" title="${escapeHtml(c.selection)}">
        <span class="tab-label">💡 ${escapeHtml(truncateLabel(c.selection, 18))}</span>
        <span class="tab-close" data-close="${c.id}" title="Close this container">✕</span>
      </button>`
    )
    .join('');
}

export function renderAllChildTabs() {
  const idx = childrenIndex(); // one pass instead of childrenOf() per node
  for (const id of Object.keys(state.explains.nodes)) renderChildTabs(id, idx.get(id) || []);
}

/* `kidCount` is optional: pass it when the caller already counted children. */
export function updateRowState(node, kidCount) {
  const el = panelEl(node.id);
  if (!el) return;
  const kids = kidCount != null ? kidCount : childrenOf(node.id).length;
  const badge = el.querySelector('.ex-badge');
  badge.hidden = kids === 0;
  badge.textContent = kids ? `${kids} nested` : '';
  el.querySelector('.ex-busy').hidden = !node.busy;
  const ta = el.querySelector('.ep-input');
  const btn = el.querySelector('.ep-send');
  ta.disabled = !!node.busy;
  btn.disabled = !!node.busy;
}

export function updateRowStates() {
  const idx = childrenIndex(); // one pass instead of childrenOf() per node
  for (const n of Object.values(state.explains.nodes)) {
    updateRowState(n, (idx.get(n.id) || []).length);
  }
}

/* Header button: shows how many containers exist and reopens the panel. */
export function updateExplainToggle() {
  const count = Object.keys(state.explains.nodes).length;
  explainsCount.textContent = String(count);
  explainsToggle.classList.toggle('hidden', count === 0);
  explainsToggle.classList.toggle('on', state.sidebar.open);
}

export function activeRootId() {
  if (state.explains.activeId) {
    const r = rootAncestorOf(state.explains.activeId);
    if (r) return r.id;
  }
  return state.explains.roots[0] || null;
}

/* Only the active root's tree is displayed. */
export function updateRootVisibility() {
  const rootId = activeRootId();
  for (const el of explainPanels.children) {
    if (!el.classList || !el.classList.contains('ex-container')) continue;
    el.classList.toggle('active-root', el.dataset.id === rootId);
  }
}

/*
 * Collapsed = pane squeezed to a few pixels -> content hidden, thin line shown.
 * Measured from real widths (flex handles the distribution).
 */
export function updateCollapsed() {
  const open = state.sidebar.open;
  const panes = explainPanels.querySelectorAll('.ex-pane');
  // Measure EVERYTHING first, then apply the classes. Interleaving reads and
  // writes (as this did) forced a synchronous layout once per pane, and this
  // runs on every divider drag move.
  const valid = [];
  const collapsed = [];
  for (const pane of panes) {
    // Only judge panes whose split row is actually laid out — measuring
    // mid-transition would wrongly collapse a wide pane (hidden content).
    const split = pane.parentElement;
    valid.push(!!(open && split && split.clientWidth > 0));
    collapsed.push(pane.clientWidth <= 10);
  }
  const chatCollapsed = chatArea.clientWidth <= 10;
  for (let i = 0; i < panes.length; i++) {
    panes[i].classList.toggle('collapsed', valid[i] && collapsed[i]);
  }
  chatArea.classList.toggle('collapsed', chatCollapsed);
}

export let collapsedRaf = 0;
export let collapsedTimer = 0;
export function updateCollapsedSoon() {
  if (!collapsedRaf) {
    collapsedRaf = requestAnimationFrame(() => {
      collapsedRaf = 0;
      updateCollapsed();
    });
  }
  // The sidebar width animates (0.15s) — re-measure once it has settled so a
  // pane opened during the transition isn't stuck in the collapsed state.
  clearTimeout(collapsedTimer);
  collapsedTimer = setTimeout(updateCollapsed, 220);
}

// The transition ending is the definitive settle point: when the panel
// finishes opening/closing, re-measure so panes don't keep their collapsed
// line/mark over content that is already laid out at full width.
rightSidebar.addEventListener('transitionend', (e) => {
  if (e.target === rightSidebar && e.propertyName === 'width') updateCollapsed();
});

/* ---------- pane weights (flex-grow) ---------- */

export function paneGrow(pane) {
  const v = parseFloat(pane.style.flexGrow);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function setPaneGrow(pane, w) {
  pane.style.flexGrow = String(w);
  if (pane.classList.contains('ex-child')) {
    const n = state.explains.nodes[pane.dataset.child];
    if (n) n.w = w;
  } else {
    const c = pane.closest('.ex-container');
    const n = c && state.explains.nodes[c.dataset.id];
    if (n) n.cw = w;
  }
}

/* Expand a squeezed pane back to a usable share. */
export function expandPane(pane) {
  if (!pane) return;
  if (paneGrow(pane) < 0.5) setPaneGrow(pane, pane.classList.contains('ex-child') ? 1.5 : 1);
}

/* ---------- activate / show / hide ---------- */

/* Activating a container: root tree shown, its pane brought back if squeezed,
 * tabs refreshed, scrolled into view. */
export function activateExplain(id, persistIt = true) {
  const node = state.explains.nodes[id];
  if (!node) return;
  state.explains.activeId = id;
  expandPane(childPane(id));
  const el = panelEl(id);
  if (el) expandPane(el.querySelector(':scope > .ex-split > .ex-content'));
  renderExplainTabs();
  renderAllChildTabs();
  updateRootVisibility();
  updateExplainToggle();
  updateCollapsedSoon();
  if (el) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    scrollDown(el.querySelector('.explain-messages'));
  }
  if (persistIt) persist();
}

export function showSidebar() {
  state.sidebar.open = true;
  rightSidebar.classList.add('open');
  rightSidebar.style.width = `${state.sidebar.width}px`;
  updateExplainToggle();
  updateCollapsedSoon();
}

/* Hide the panel but KEEP every container — reopen via the header button. */
export function hideExplainPanel() {
  state.sidebar.open = false;
  rightSidebar.classList.remove('open');
  rightSidebar.style.width = '0px';
  // The panel is fully closed: no overlay may keep its active button
  // state (Summary/Library would otherwise stay "on" with no panel).
  setSummaryOverlay(false);
  closeLibrary(false);
  hideConfirm(); // never leave the delete prompt floating over a closed panel
  updateExplainToggle();
}
