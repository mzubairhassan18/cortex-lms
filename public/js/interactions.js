/* interactions.js — split from public/app.js (app.js line 2151-2274). */
import { persist, sendMessage } from './chat.js';
import { confirmCloseExplain, sendExplain } from './explain-lifecycle.js';
import { activateExplain, hideExplainPanel, paneGrow, setPaneGrow, showSidebar, updateCollapsed, updateCollapsedSoon } from './explain-ui.js';
import { focusExplainFromMark } from './highlight.js';
import { explainPanels, explainsToggle, input, inputForm, dragWith, messagesEl, state } from './state.js';

/* ================= Input helpers ================= */

export function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

inputForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
input.addEventListener('input', () => autoResize(input));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

/* ---------- Explainer container interactions (delegated) ----------
 *
 * These are registered below on #explain-panels (list view). The graph view
 * relocates the very same containers into its nodes, where they are no longer
 * descendants of #explain-panels — so it calls attachExplainHandlers() with
 * its node layer instead. One handler body, two hosts, nothing can diverge. */

/* Per-container input: submit / Enter. */
function onExplainSubmit(e) {
  const form = e.target.closest('.ep-input-form');
  if (!form) return;
  e.preventDefault();
  sendExplain(form.closest('.ex-container'));
}

function onExplainKeydown(e) {
  if (!e.target.classList || !e.target.classList.contains('ep-input')) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendExplain(e.target.closest('.ex-container'));
  }
}

function onExplainInput(e) {
  if (e.target.classList && e.target.classList.contains('ep-input')) autoResize(e.target);
}

/* Child tabs (activate / close), header ✕ (close), collapsed pane (expand),
 * header click (activate). */
function onExplainClick(e) {
  // Highlighted source text (nested selections made inside this container)
  const mark = e.target.closest('mark.explain-src');
  if (mark && mark.dataset.id) {
    focusExplainFromMark(mark.dataset.id);
    return;
  }
  const tabClose = e.target.closest('.ex-tab .tab-close');
  if (tabClose) {
    e.stopPropagation();
    confirmCloseExplain(tabClose, tabClose.dataset.close);
    return;
  }
  const tab = e.target.closest('.ex-tab');
  if (tab) {
    activateExplain(tab.dataset.id);
    return;
  }
  const close = e.target.closest('.ex-close');
  if (close) {
    e.stopPropagation();
    confirmCloseExplain(close, close.closest('.ex-container').dataset.id);
    return;
  }
  const pane = e.target.closest('.ex-pane.collapsed');
  if (pane) {
    if (pane.classList.contains('ex-child')) activateExplain(pane.dataset.child);
    else {
      const c = pane.closest('.ex-container');
      if (c) activateExplain(c.dataset.id);
    }
    return;
  }
  const head = e.target.closest('.ex-head');
  if (head) {
    const c = head.closest('.ex-container');
    if (c) activateExplain(c.dataset.id);
  }
}

/* Drag a vertical divider: the two adjacent panes resize (min = few pixels). */
function onExplainPointerdown(e) {
  if (e.button !== 0) return;
  const vd = e.target.closest('.ex-vdiv');
  if (!vd) return;
  e.preventDefault();
  const a = vd.previousElementSibling;
  const b = vd.nextElementSibling;
  if (!a || !b || !a.classList.contains('ex-pane') || !b.classList.contains('ex-pane')) return;
  vd.classList.add('dragging');

  const a0 = a.clientWidth;
  const b0 = b.clientWidth;
  const total = a0 + b0;
  const aW0 = paneGrow(a);
  const bW0 = paneGrow(b);
  const startX = e.clientX;

  const onMove = (ev) => {
    const dx = ev.clientX - startX;
    const a1 = Math.max(4, Math.min(total - 4, a0 + dx));
    const b1 = total - a1;
    const sumW = aW0 + bW0;
    setPaneGrow(a, (a1 / total) * sumW);
    setPaneGrow(b, (b1 / total) * sumW);
    updateCollapsedSoon();
  };
  // Ends on pointerup, pointercancel or window blur — never left attached.
  dragWith(vd, e, onMove, () => {
    vd.classList.remove('dragging');
    updateCollapsed();
    persist();
  });
}

/* Register the whole set of delegated explain handlers on one host element. */
export function attachExplainHandlers(host) {
  host.addEventListener('submit', onExplainSubmit);
  host.addEventListener('keydown', onExplainKeydown);
  host.addEventListener('input', onExplainInput);
  host.addEventListener('click', onExplainClick);
  host.addEventListener('pointerdown', onExplainPointerdown);
}

attachExplainHandlers(explainPanels);

/* Clicking highlighted source text focuses its explainer container. */
messagesEl.addEventListener('click', (e) => {
  const mark = e.target.closest('mark.explain-src');
  if (mark && mark.dataset.id) focusExplainFromMark(mark.dataset.id);
});

/* Header button: show/hide the explain panel without touching the containers. */
explainsToggle.addEventListener('click', () => {
  if (state.sidebar.open) hideExplainPanel();
  else showSidebar();
});
