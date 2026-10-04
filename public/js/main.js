/* main.js — split from public/app.js (app.js line 3659-3675). */
import './markdown.js';
import './stream.js';
import './chat.js';
import './conversations.js';
import './explain-system.js';
import './explain-ui.js';
import './explain-lifecycle.js';
import './selection.js';
import './files.js';
import './library.js';
import './resize.js';
import './settings.js';
import './interactions.js';
import './overlays.js';
import './highlight.js';
import './summary.js';
import './quiz.js';
import { renderMessages } from './chat.js';
import { loadConversations, selectConversation } from './conversations.js';
import { updateCollapsed } from './explain-ui.js';
import { initGraph } from './graph.js';
import { initExport } from './export.js';
import { initWorkspaces } from './workspaces.js';
import { updateToolbarDensity } from './overlays.js';
import { initTheme } from './theme.js';
import { loadModels, loadSettings } from './settings.js';
import { input, state } from './state.js';
import { initWorkspacePage } from './workspace-page.js';

/* ================= Boot overlay ================= */

/*
 * #boot (index.html) is the only thing on screen until init() has finished.
 * It matters most when the remembered view is the GRAPH: without the overlay
 * the list layout paints first and the graph takes over afterwards, which
 * reads as a flicker on every reload. Driven by the data-boot attribute the
 * inline <head> script sets before first paint — keep the name in sync with
 * that script and with the three states documented in style.css.
 *
 * Two steps so the reveal is a cross-fade rather than a cut: the app becomes
 * visible underneath while the splash is still opaque, then the attribute is
 * dropped a beat later (at which point #boot goes display:none).
 */
function endBoot() {
  const root = document.documentElement;
  // The <head> watchdog may have already revealed the app (or be mid-fade);
  // hiding it again would be a second flicker, which is the thing we're fixing.
  const boot = root.getAttribute('data-boot');
  if (boot === null || boot === 'out') return;
  root.setAttribute('data-boot', 'out');
  setTimeout(() => root.removeAttribute('data-boot'), 260);
}

/* ================= Init ================= */

export async function init() {
  try {
    initTheme();   // theme first: no point painting a toolbar in the wrong scheme

    /*
     * /workspaces is the standalone picker: same document as /app, different
     * shell. Branch before anything else is wired up — that screen has no
     * sidebar, chat or graph, so booting them would race against an empty page.
     */
    if (location.pathname.replace(/\/+$/, '') === '/workspaces') {
      await initWorkspacePage();
      return;
    }
    // Before the loads below: if the graph view is remembered, its rebuild hook
    // has to be in place while conversations and explanations arrive.
    initGraph();
    // Workspaces must be reconciled first — loadConversations() scopes the list
    // to state.workspaceId, and a remembered id may no longer exist.
    await initWorkspaces();
    await loadSettings();
    await loadModels();
    await loadConversations();
    if (state.conversations.length > 0) {
      await selectConversation(state.conversations[0].id);
    } else {
      renderMessages();
    }
    updateToolbarDensity();
    updateCollapsed();
    initExport(); // summary header: the PDF / Word / TXT export menu
  } finally {
    // Always reveal: an early return, a thrown fetch, a slow provider — the
    // overlay must never be what a broken boot leaves on the screen. The
    // 8s watchdog in <head> is the second net under this one.
    endBoot();
  }
  /* After the reveal: an input inside a visibility:hidden box cannot take
   * focus, so focusing it any earlier would silently do nothing. */
  input.focus();
}

init();
