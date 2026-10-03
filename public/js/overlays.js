/* overlays.js — split from public/app.js (app.js line 2275-2373). */
import { createConversation, explainSnapshot, persist } from './chat.js';
import { deleteConversation, selectConversation } from './conversations.js';
import { confirmCloseExplain } from './explain-lifecycle.js';
import { activeNode, panelEl } from './explain-system.js';
import { activateExplain, hideExplainPanel, renderPanelMessages, showSidebar, updateCollapsedSoon } from './explain-ui.js';
import { closeLibrary } from './library.js';
import { explainerMaxWidth } from './resize.js';
import { renderSettingsForm } from './settings.js';
import { $, convList, explainTabs, input, newChatBtn, rightSidebar, setProvider, settingsBtn, settingsClose, settingsOverlay, sidebarClose, sidebarReset, state, summaryBtn, summaryClose, summaryOverlay, summaryRefresh } from './state.js';
import { renderSummary, runBackgroundJobs, showCachedSummary, summaryCache } from './summary.js';

/* ---------- Topics summary overlay ---------- */

/* Opening/closing the Summary overlay also flips the toolbar button to its
 * active (filled) state and hides the explainer tabs above the overlay.
 * Only one overlay may be open at a time. */
export function setSummaryOverlay(open) {
  summaryOverlay.classList.toggle('hidden', !open);
  document.body.classList.toggle('summary-open', open);
  summaryBtn.classList.toggle('on', open);
  if (open) closeLibrary(false); // only one overlay at a time
}

summaryBtn.addEventListener('click', () => {
  const panelHidden = !state.sidebar.open;
  const overlayHidden = summaryOverlay.classList.contains('hidden');
  if (panelHidden || overlayHidden) {
    settingsOverlay.classList.add('hidden'); // only one overlay at a time
    setSummaryOverlay(true);
    /* No `force`: in graph mode the summary relocates into a node of its own,
     * so there is nothing to reveal in the sidebar. */
    if (panelHidden) showSidebar(); // overlay lives over the containers
    showCachedSummary();
    runBackgroundJobs(state.currentId, state.messages, explainSnapshot(), false);
  } else {
    setSummaryOverlay(false); // close -> containers visible again
  }
});
summaryClose.addEventListener('click', () => setSummaryOverlay(false));
summaryRefresh.addEventListener('click', () => {
  renderSummary(summaryCache[state.currentId], 'summarizing…');
  runBackgroundJobs(state.currentId, state.messages, explainSnapshot(), true);
});

/* ---------- Settings overlay (provider + API key) ---------- */

settingsBtn.addEventListener('click', () => {
  setSummaryOverlay(false); // only one overlay at a time
  closeLibrary(false);
  const panelHidden = !state.sidebar.open;
  settingsOverlay.classList.remove('hidden');
  if (panelHidden) showSidebar(true);
  renderSettingsForm();
  setProvider.focus();
});
settingsClose.addEventListener('click', () => settingsOverlay.classList.add('hidden'));

/* Toolbar collapses to icons when the window itself gets narrow. */
export function updateToolbarDensity() {
  document.body.classList.toggle('compact-header', window.innerWidth < 640);
}

window.addEventListener('resize', () => {
  const max = explainerMaxWidth();
  if (state.sidebar.open && state.sidebar.width > max) {
    state.sidebar.width = max;
    rightSidebar.style.width = `${max}px`;
  }
  updateToolbarDensity();
  updateCollapsedSoon();
});

newChatBtn.addEventListener('click', async () => {
  if (state.streaming) return;
  await createConversation();
  input.focus();
});

convList.addEventListener('click', (e) => {
  const del = e.target.closest('.conv-delete');
  if (del) { deleteConversation(del.dataset.id, e); return; }
  const item = e.target.closest('.conv-item');
  if (item) selectConversation(item.dataset.id);
});

/* Hide panel — windows are preserved and reappear on the next Explain. */
sidebarClose.addEventListener('click', hideExplainPanel);

/* Clear only the active window's conversation (keeps selection + tree). */
sidebarReset.addEventListener('click', () => {
  const node = activeNode();
  if (!node || node.busy) return;
  node.messages = [];
  renderPanelMessages(node);
  persist();
  const el = panelEl(node.id);
  const ta = el && el.querySelector('.ep-input');
  if (ta) ta.focus();
});

/* Tab strip: switch between root windows, or close one (with its children). */
explainTabs.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) {
    e.stopPropagation();
    confirmCloseExplain(close, close.dataset.close);
    return;
  }
  const tab = e.target.closest('.explain-tab');
  if (tab) activateExplain(tab.dataset.id);
});
