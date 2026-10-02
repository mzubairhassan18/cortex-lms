/* resize.js — split from public/app.js (app.js line 1854-1920). */
import { updateCollapsed, updateCollapsedSoon } from './explain-ui.js';
import { $, chatArea, dragWith, leftSidebar, leftToggle, resizeHandle, rightSidebar, state } from './state.js';

/* ================= Main chat | explainer resize ================= */
/*
 * The explainer can grow until the main conversation is only a few pixels
 * wide (a line). Double-click the divider — or click the collapsed chat line —
 * to snap between full width and the remembered normal width.
 */

export const RESIZE_MIN = 240; // the explainer's own minimum width

export function explainerMaxWidth() {
  return Math.max(RESIZE_MIN + 40, window.innerWidth - 12); // leaves ~7px for the chat line
}

export function setExplainerWidth(w) {
  state.sidebar.width = w;
  rightSidebar.style.width = `${w}px`;
  updateCollapsedSoon();
}

export function toggleMainChat() {
  const isCollapsed = state.sidebar.width >= explainerMaxWidth() - 2;
  if (isCollapsed) {
    setExplainerWidth(state.sidebar.prevWidth || 380);
  } else {
    state.sidebar.prevWidth = state.sidebar.width;
    setExplainerWidth(explainerMaxWidth());
  }
}

resizeHandle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  resizeHandle.classList.add('dragging');
  const startX = e.clientX;
  const startW = state.sidebar.width;
  // Remember a normal width so the collapsed chat line can be restored later.
  if (startW < explainerMaxWidth() - 120) state.sidebar.prevWidth = startW;

  const onMove = (ev) => {
    const w = Math.min(explainerMaxWidth(), Math.max(RESIZE_MIN, startW + (startX - ev.clientX)));
    state.sidebar.width = w;
    rightSidebar.style.width = `${w}px`;
    updateCollapsedSoon();
  };
  // Ends on pointerup, pointercancel or window blur — never left attached.
  dragWith(resizeHandle, e, onMove, () => {
    resizeHandle.classList.remove('dragging');
    updateCollapsed();
  });
});

resizeHandle.addEventListener('dblclick', toggleMainChat);

/* Click the collapsed main-chat line to bring it back. */
chatArea.addEventListener('click', () => {
  if (chatArea.classList.contains('collapsed')) toggleMainChat();
});

/* ================= Left sidebar toggle ================= */

leftToggle.addEventListener('click', () => {
  state.leftOpen = !state.leftOpen;
  leftSidebar.classList.toggle('collapsed', !state.leftOpen);
});
