/* chat.js — split from public/app.js (app.js line 473-589). */
import { renderConversationList, updateTitle } from './conversations.js';
import { clearExplainWindows } from './explain-lifecycle.js';
import { filesContext, renderChips } from './files.js';
import { highlightSources } from './highlight.js';
import { autoResize } from './interactions.js';
import { decorateCopy, messageVNode } from './markdown.js';
import { $, input, messagesEl, sendBtn, state } from './state.js';
import { cleanHistory, makeStreamer, scrollDown, streamChat } from './stream.js';
import { quizCache, renderSummary, summaryCache, testsCache } from './summary.js';
import { Fragment, html, hostFor, render } from './views.js';

/* ================= Main chat ================= */

/* Sent with every chat request (not stored in the conversation): guides the
 * model to answer with formatted markdown instead of wrapping everything in
 * a code fence, which the renderer would then show as raw source. */
export const CHAT_SYS =
  'You are a friendly learning tutor in a chat app. ' +
  'Format your reply with Markdown when it helps — ## headings, **bold**, ' +
  '- bullet lists, `inline code`. Reply directly with the formatted text; ' +
  'never wrap the whole answer in a code fence.';

/* Messages are a Preact view over `state.messages`.
 *
 * The live typewriter bubble is appended imperatively to #messages itself, so
 * Preact renders into a `display: contents` host (see views.js) and the two
 * never compete for the same children. Since renderMarkdown() is memoized,
 * re-rendering a long conversation only diffs — it never re-parses content
 * that has not changed (this used to be the single biggest cause of the
 * browser locking up: full innerHTML rebuild + markdown re-parse on every send). */
export function renderMessages() {
  const msgs = state.messages;

  // The live typewriter bubble is about to be replaced by the real message.
  const streaming = messagesEl.querySelector('.msg-streaming');
  if (streaming) streaming.remove();

  const host = hostFor(messagesEl);
  render(
    msgs.length
      ? html`<${Fragment}>${msgs.map((m, i) => messageVNode(m, i))}<//>`
      : html`<div class="empty">👋 Start learning! Ask me anything.<br /><br />Tip: select or double-click any text to get an explanation in a side panel.</div>`,
    host
  );
  decorateCopy(host); // header strip + copy button on every code block
  highlightSources(host, null); // highlight text that has explanations
  scrollDown(messagesEl);
}

/* Input stays ENABLED during generation (you can keep typing ahead);
 * only the send button disables and shows the chasing-dots animation. */
export function setMainInputEnabled(on) {
  sendBtn.disabled = !on;
  sendBtn.classList.toggle('busy', !on);
}

export async function createConversation() {
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New conversation' }),
  });
  const conv = await res.json();
  state.conversations.unshift(conv);
  state.currentId = conv.id;
  state.messages = [];
  state.notes = []; // personal notes are per-conversation too
  state.files = []; // attachments are per-conversation too
  renderChips();
  clearExplainWindows(); // fresh explain panel for a new conversation
  delete summaryCache[conv.id];
  delete quizCache[conv.id];
  testsCache[conv.id] = [];
  state.summaryMode = 'summary';
  state.quizView = null;
  state.summaryExpanded = false;
  renderSummary(null, '');
  renderConversationList();
  renderMessages();
  updateTitle();
  return conv;
}

export async function sendMessage() {
  const text = input.value.trim();
  if (!text || state.streaming) return;
  input.value = '';
  autoResize(input);

  if (!state.currentId) await createConversation();

  state.messages.push({ role: 'user', content: text });
  // Mirror the server's title rule locally — persist() no longer reloads the
  // whole conversation list after every message.
  const conv = state.conversations.find((c) => c.id === state.currentId);
  if (conv && conv.title === 'New conversation') {
    conv.title = text.slice(0, 40);
    updateTitle();
    renderConversationList();
  }
  renderMessages();
  persist();

  state.streaming = true;
  setMainInputEnabled(false);

  const streamer = makeStreamer(messagesEl, (full) => {
    if (full && full.trim()) {
      state.messages.push({ role: 'assistant', content: full });
    }
    state.streaming = false;
    setMainInputEnabled(true);
    renderMessages();
    persist();
    input.focus();
  });
  streamer.start();
  // Attached documents ride along in the system prompt (prefetched text).
  // A failed attachment fetch must never leave the input locked.
  let sys = CHAT_SYS;
  try {
    sys += await filesContext();
  } catch {
    /* attachments unavailable — send without them */
  }
  streamChat([{ role: 'system', content: sys }, ...cleanHistory(state.messages)], streamer);
}

/* Serializable snapshot of all explain windows (no runtime fields). */
export function explainSnapshot() {
  const nodes = {};
  for (const [id, n] of Object.entries(state.explains.nodes)) {
    nodes[id] = {
      id,
      parentId: n.parentId,
      selection: n.selection,
      system: n.system,
      messages: n.messages,
      createdAt: n.createdAt,
      w: n.w,   // flex share inside the parent's split (children)
      cw: n.cw, // own content-pane share
    };
  }
  return {
    roots: [...state.explains.roots],
    activeId: state.explains.activeId,
    nodes,
  };
}

/* Saves are debounced and serialized. Every interaction used to fire a PUT
 * (plus a full conversation-list reload), which is what made the UI stutter. */
let persistTimer = 0;
let pendingId = null;
let pendingPayload = null;
let putChain = Promise.resolve();

function putConversation(id, payload) {
  putChain = putChain
    .then(() =>
      fetch(`/api/conversations/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
    )
    .then((res) => {
      /* Mirror the server's rule (it bumps `updatedAt` whenever messages or
       * explains are saved) and re-sort locally. Every save used to re-fetch
       * the whole conversation list purely to pick up that new timestamp —
       * one round trip per save, for an order change. Same result, no request.
       * putConversation only ever sends {messages, explains}, which is exactly
       * the condition the server bumps on. */
      if (res && res.ok) {
        const conv = state.conversations.find((c) => c.id === id);
        if (conv) {
          conv.updatedAt = Date.now();
          state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
          renderConversationList();
        }
      }
      return res;
    })
    .catch(() => {}); // a failed save must not wedge the chain
  return putChain;
}

function clearPending(id) {
  if (!persistTimer) return false;
  if (id && pendingId !== id) return false;
  clearTimeout(persistTimer);
  persistTimer = 0;
  pendingId = null;
  pendingPayload = null;
  return true;
}

/* Queue a save of the current conversation (coalesces with the next call). */
export function persist() {
  if (!state.currentId) return Promise.resolve();
  if (persistTimer) clearTimeout(persistTimer);
  pendingId = state.currentId;
  pendingPayload = JSON.stringify({ messages: state.messages, explains: explainSnapshot() });
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    const id = pendingId;
    const payload = pendingPayload;
    pendingId = null;
    pendingPayload = null;
    putConversation(id, payload);
  }, 400);
  return putChain;
}

/* Save a specific snapshot immediately (used when leaving a conversation, so
 * it cannot be racing a debounced save of the same id). */
export function persistNow(id, messages, explains) {
  if (!id) return Promise.resolve();
  clearPending(id);
  return putConversation(id, JSON.stringify({ messages, explains }));
}

/* Drop a queued save — the conversation is being deleted. */
export function cancelPersist(id) {
  clearPending(id);
}
