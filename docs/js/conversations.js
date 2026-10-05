/* conversations.js — split from public/app.js (app.js line 590-703). */
import { cancelPersist, explainSnapshot, persistNow, renderMessages } from './chat.js';
import { clearExplainWindows, restoreExplainWindows } from './explain-lifecycle.js';
import { evictFileText, prefetchFileText, renderChips } from './files.js';
import { polishNote } from './selection.js';
import { $, convList, currentTitle, input, state } from './state.js';
import { Fragment, html, render } from './views.js';
import {
  abortBackgroundJobs,
  enqueueBg,
  quizCache,
  renderSummary,
  runBackgroundJobs,
  summaryCache,
  testsCache,
} from './summary.js';

/* ================= Conversations list ================= */

export async function loadConversations() {
  try {
    // Scoped to the open workspace — another workspace's chats never leak in.
    const ws = state.workspaceId ? `?workspace=${encodeURIComponent(state.workspaceId)}` : '';
    const res = await fetch(`/api/conversations${ws}`);
    const data = await res.json();
    /*
     * Only an actual list may land in state. A failed call answers
     * {"error": "..."}, and assigning that object is what leaves
     * `state.conversations.length` undefined (so the list renders empty with
     * no explanation) and makes `.unshift()` explode the next time a message
     * is sent. The UI's empty state is the honest response to "we don't have
     * the list", not a silently corrupted one.
     */
    state.conversations = res.ok && Array.isArray(data) ? data : [];
  } catch {
    state.conversations = [];
  }
  renderConversationList();
}

export function renderConversationList() {
  // Preact sets text content directly, so `title` is interpolated raw —
  // escaping here would show `&amp;` literally.
  render(
    state.conversations.length
      ? html`<${Fragment}>${state.conversations.map(
          (c) => html`<div
            class=${'conv-item' + (c.id === state.currentId ? ' active' : '')}
            data-id=${c.id}
          >
            <span class="conv-title">${c.title}</span>
            <button class="conv-delete" data-id=${c.id} title="Delete conversation">
              <svg class="ico" aria-hidden="true"><use href="#i-x"></use></svg>
            </button>
          </div>`
        )}<//>`
      : html`<div class="empty">No conversations yet</div>`,
    convList
  );
  if (state.onGraphChange) state.onGraphChange();
}

export async function selectConversation(id) {
  if (state.streaming) return;

  // Save the outgoing conversation (messages + explain snapshot) BEFORE switching.
  const prevId = state.currentId;
  const prevSnapshot = explainSnapshot();
  const prevMessages = state.messages;

  // Leaving a conversation -> refresh its summary + quiz in the background.
  if (prevId && prevId !== id) runBackgroundJobs(prevId, prevMessages, prevSnapshot, false);

  // Fresh panel for the incoming conversation — no windows leak across.
  clearExplainWindows();

  state.currentId = id;
  state.messages = [];

  if (prevId && prevId !== id) persistNow(prevId, prevMessages, prevSnapshot);

  let conv = null;
  try {
    const res = await fetch(`/api/conversations/${id}`);
    if (res.ok) conv = await res.json();
  } catch { /* ignore */ }
  state.messages = (conv && conv.messages) || [];
  state.notes = (conv && conv.notes) || [];
  state.files = (conv && conv.files) || [];
  renderChips();
  // Start pulling extracted text in the background so the next message
  // already has the documents in its system prompt.
  for (const f of state.files) {
    if (!f.link) prefetchFileText(id, f.id);
  }
  // Notes that never got their background AI polish (page closed mid-job)
  // are retried every time the conversation opens.
  for (const n of state.notes) {
    if (!n.polished) enqueueBg(() => polishNote(id, n.id));
  }

  renderMessages();
  renderConversationList();
  updateTitle();
  // Topics summary + quiz: show the cached version instantly, refresh in background.
  if (conv && conv.summary) summaryCache[conv.id] = conv.summary;
  else delete summaryCache[id];
  if (conv && conv.quiz && Array.isArray(conv.quiz.questions) && conv.quiz.questions.length) {
    quizCache[conv.id] = conv.quiz;
  } else {
    delete quizCache[id];
  }
  testsCache[id] = Array.isArray(conv && conv.tests) ? conv.tests : [];
  state.summaryMode = 'summary';
  state.quizView = null;
  state.summaryExpanded = false;
  renderSummary(summaryCache[id] || null, '');
  restoreExplainWindows(conv && conv.explains);
  runBackgroundJobs(id, state.messages, explainSnapshot(), false);
  input.focus();
}

export async function deleteConversation(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  cancelPersist(id); // a queued save would resurrect it on disk
  abortBackgroundJobs(id); // and a queued job would write it back
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' }).catch(() => {});
  state.conversations = state.conversations.filter((c) => c.id !== id);
  delete summaryCache[id];
  delete quizCache[id];
  delete testsCache[id];
  evictFileText(id); // extracted text is keyed per conversation — drop it
  if (state.currentId === id) resetActiveConversation();
  renderConversationList();
}

/*
 * "Nothing open" — clearing the main chat without touching the sidebar, the
 * list, or anything the next conversation will need. Reached when the open
 * conversation is deleted, and when the workspace you switch into is empty.
 */
export function resetActiveConversation() {
  state.currentId = null;
  state.messages = [];
  state.notes = []; // these are per-conversation — never leak across
  state.files = [];
  renderChips();
  clearExplainWindows();
  state.summaryMode = 'summary';
  state.quizView = null;
  state.summaryExpanded = false;
  renderSummary(null, '');
  renderMessages();
  updateTitle();
}

export function updateTitle() {
  const conv = state.conversations.find((c) => c.id === state.currentId);
  currentTitle.textContent = conv ? conv.title : 'New conversation';
}
