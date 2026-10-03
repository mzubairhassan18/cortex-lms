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
import { updateToolbarDensity } from './overlays.js';
import { loadModels, loadSettings } from './settings.js';
import { input, state } from './state.js';

/* ================= Init ================= */

export async function init() {
  // Before the loads below: if the graph view is remembered, its rebuild hook
  // has to be in place while conversations and explanations arrive.
  initGraph();
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
  input.focus();
}

init();
