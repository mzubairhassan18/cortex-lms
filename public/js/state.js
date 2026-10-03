/* state.js — split from public/app.js (app.js line 1-85). */

'use strict';

/* ================= State ================= */

export const state = {
  model: 'phi4-mini-fast:latest',
  autoRoute: null,           // {provider,label,model,info} — server-chosen source (Auto)
  modelInfo: null,           // {context,limits,text,title} — footer info line
  conversations: [],
  currentId: null,
  messages: [],            // main chat messages
  streaming: false,
  sidebar: {
    open: false,
    width: 380,
    prevWidth: 380, // width to restore when the main chat was collapsed
  },
  // Explainer containers: a tree of split panes. Roots are created from the
  // main chat, children from selections made inside an explainer container.
  explains: {
    nodes: {},   // id -> { id, parentId, selection, system, messages, busy, streamId, controller, createdAt, w, cw }
    roots: [],   // root ids in creation order (these become the tabs)
    activeId: null,
  },
  // View mode: the classic list layout, or the horizontal node graph.
  // Persisted so the choice survives a reload.
  view: localStorage.getItem('lb.view') === 'graph' ? 'graph' : 'list',
  /* Set by graph.js while the node view is live, cleared when it unmounts.
   * The conversation and explain modules call it after they change so the
   * graph can rebuild — they never import graph.js, which would be a cycle. */
  onGraphChange: null,
  leftOpen: true,

  // UI state for the summary overlay: collapsible card, active test, results.
  summaryMode: 'summary', // 'summary' | 'quiz' | 'results'
  quizView: null,         // { i, answers, done, saved, report }
  summaryExpanded: false, // points are collapsed until the user expands
  lastSummaryStatus: '',
};

/* ================= DOM refs ================= */

export const $ = (id) => document.getElementById(id);
export const leftSidebar = $('left-sidebar');
export const leftToggle = $('left-toggle');
export const convList = $('conversation-list');
export const newChatBtn = $('new-chat-btn');
export const currentTitle = $('current-title');
export const modelSelect = $('model-select');
export const messagesEl = $('messages');
export const inputForm = $('input-form');
export const input = $('input');
export const sendBtn = $('send-btn');
export const resizeHandle = $('resize-handle');
export const rightSidebar = $('right-sidebar');
export const explainTabs = $('explain-tabs');
export const explainPanels = $('explain-panels');
export const chatArea = $('chat-area');
export const explainsToggle = $('explains-toggle');
export const explainsCount = $('explains-count');
export const sidebarClose = $('sidebar-close');
export const sidebarReset = $('sidebar-reset');
export const summaryBtn = $('summary-btn');
export const summaryOverlay = $('summary-overlay');
export const summaryBody = $('summary-body');
export const summaryCardSlot = $('summary-card-slot');
export const testSection = $('test-section');
export const summaryStatus = $('summary-status');
export const summaryClose = $('summary-close');
export const summaryRefresh = $('summary-refresh');
export const testBadges = $('test-badges');
export const settingsBtn = $('settings-btn');
export const settingsOverlay = $('settings-overlay');
export const settingsClose = $('settings-close');
export const settingsStatus = $('settings-status');
export const setProvider = $('set-provider');
export const setKey = $('set-key');
export const setBase = $('set-base');
export const setConnect = $('set-connect');
export const setMessage = $('set-message');
export const footerModel = $('footer-model');
export const footerInfo = $('footer-info');
export const popup = $('selection-popup');
export const libraryBtn = $('library-btn');
export const libraryOverlay = $('library-overlay');
export const libraryClose = $('library-close');
export const libraryBody = $('library-body');
export const attachChips = $('attach-chips');
export const attachBtn = $('attach-btn');
export const linkBtn = $('link-btn');
export const fileInput = $('file-input');

/*
 * Drag that is guaranteed to end.
 *
 * Both dividers used to attach document-level mouseup listeners from a
 * mousedown handler. If the button was released OUTSIDE the window no mouseup
 * ever reached the document, so the listeners — and everything they closed
 * over (panes, sidebar, drag state) — stayed attached forever.
 *
 * Pointer capture routes pointerup/pointercancel to the handle wherever the
 * release happens, the document-level listeners keep move tracking working,
 * and a window blur is the last-resort cleanup for a release that delivers no
 * event at all. `finish` is idempotent.
 *
 * Returns `finish`, so a caller can bail out early if it wants to.
 */
export function dragWith(el, ev, onMove, onEnd) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    window.removeEventListener('blur', finish);
    try {
      if (el.hasPointerCapture && el.hasPointerCapture(ev.pointerId)) {
        el.releasePointerCapture(ev.pointerId);
      }
    } catch {
      /* capture already released */
    }
    onEnd();
  };
  try {
    el.setPointerCapture(ev.pointerId);
  } catch {
    /* best effort — the document listeners below still work in-window */
  }
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
  window.addEventListener('blur', finish);
  return finish;
}
