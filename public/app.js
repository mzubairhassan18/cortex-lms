'use strict';

/* ================= State ================= */

const state = {
  model: 'phi4-mini-fast:latest',
  conversations: [],
  currentId: null,
  messages: [],            // main chat messages
  streaming: false,
  sidebar: {
    open: false,
    width: 380,
    selection: '',
    system: '',
    messages: [],          // sidebar session messages (system excluded)
    busy: false,
    streamId: 0,           // guards against stale streams after abort
    controller: null,      // AbortController of the active sidebar stream
  },
  leftOpen: true,
};

/* ================= DOM refs ================= */

const $ = (id) => document.getElementById(id);
const leftSidebar = $('left-sidebar');
const leftToggle = $('left-toggle');
const convList = $('conversation-list');
const newChatBtn = $('new-chat-btn');
const currentTitle = $('current-title');
const modelSelect = $('model-select');
const messagesEl = $('messages');
const inputForm = $('input-form');
const input = $('input');
const sendBtn = $('send-btn');
const resizeHandle = $('resize-handle');
const rightSidebar = $('right-sidebar');
const sidebarSelection = $('sidebar-selection');
const sidebarMessages = $('sidebar-messages');
const sidebarInputForm = $('sidebar-input-form');
const sidebarInput = $('sidebar-input');
const sidebarSendBtn = $('sidebar-send-btn');
const sidebarClose = $('sidebar-close');
const sidebarReset = $('sidebar-reset');
const popup = $('selection-popup');

/* ================= Safe markdown rendering ================= */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

function renderMarkdown(src) {
  const text = escapeHtml(src);
  const blocks = text.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (t.startsWith('```')) {
        const code = t.replace(/^```\w*\n?/, '').replace(/```\s*$/, '').trimEnd();
        return `<pre><code>${code}</code></pre>`;
      }
      const h = t.match(/^(#{1,3}) (.*)$/);
      if (h) {
        const level = h[1].length;
        return `<h${level}>${renderInline(h[2])}</h${level}>`;
      }
      if (/^\s*[-*] /.test(t)) {
        const items = t.split('\n').map((l) => `<li>${renderInline(l.replace(/^\s*[-*] /, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      if (/^\s*\d+\. /.test(t)) {
        const items = t.split('\n').map((l) => `<li>${renderInline(l.replace(/^\s*\d+\. /, ''))}</li>`).join('');
        return `<ol>${items}</ol>`;
      }
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

function messageHtml(m) {
  const isUser = m.role === 'user';
  return `<div class="msg ${isUser ? 'user' : 'assistant'}"><div class="bubble">${renderMarkdown(m.content)}</div></div>`;
}

/* ================= Typewriter streamer ================= */
/* Reveals received text character-by-character into a pending bubble. */

function makeStreamer(container, onFinish) {
  let received = '';
  let revealed = 0;
  let timer = null;
  let finished = false;
  let bubble = null;

  function ensureBubble() {
    if (!bubble) {
      const wrap = document.createElement('div');
      wrap.className = 'msg assistant';
      const b = document.createElement('div');
      b.className = 'bubble thinking';
      wrap.appendChild(b);
      container.appendChild(wrap);
      bubble = b;
      scrollDown(container);
    }
    return bubble;
  }

  function pump() {
    if (revealed < received.length) {
      const step = Math.min(received.length - revealed, 3);
      revealed += step;
      const b = ensureBubble();
      b.classList.remove('thinking');
      b.innerHTML = renderMarkdown(received.slice(0, revealed));
      scrollDown(container);
      timer = setTimeout(pump, 16);
    } else if (finished) {
      timer = null;
    } else {
      timer = setTimeout(pump, 80);
    }
  }

  return {
    // Create the pending "thinking" bubble immediately so the user sees feedback
    // before the first token arrives.
    start() {
      ensureBubble();
    },
    push(text) {
      received += text;
      if (!timer && !finished) pump();
    },
    end() {
      if (timer) { clearTimeout(timer); timer = null; }
      finished = true;
      if (revealed < received.length) {
        revealed = received.length;
        if (bubble) {
          bubble.classList.remove('thinking');
          bubble.innerHTML = renderMarkdown(received);
        }
      }
      const full = received;
      bubble = null;
      onFinish(full);
    },
  };
}

/* ================= SSE streaming ================= */
/*
 * Streams from /api/chat. Retries once when nothing has been delivered yet,
 * never retries after an abort, and surfaces friendly error text.
 */
async function streamChat(messages, streamer, signal) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAX_ATTEMPTS = 2;
  let receivedAny = false;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) break;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: state.model, messages }),
        signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        const e = new Error(`Server error ${res.status}: ${errText.slice(0, 300)}`);
        e.httpStatus = res.status;
        throw e;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let serverError = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            if (json.error) serverError = json.error;
            else if (json.delta) {
              receivedAny = true;
              streamer.push(json.delta);
            }
          } catch { /* partial line */ }
        }
      }

      if (serverError) throw new Error(serverError);
      streamer.end();
      return;
    } catch (e) {
      // Aborted (user opened a new explain, closed sidebar, etc.) — end quietly.
      if (e.name === 'AbortError' || (signal && signal.aborted)) {
        streamer.end();
        return;
      }
      lastErr = e;
      if (attempt < MAX_ATTEMPTS && !receivedAny) {
        await sleep(1200);
        continue;
      }
      break;
    }
  }

  // Failed with nothing useful received — show a friendly, actionable message.
  let msg = lastErr ? lastErr.message || 'Unknown error' : 'Request was cancelled.';
  if (/Cannot reach|Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    msg = 'Cannot reach the app server. Is "npm start" still running?';
  } else if (/ECONNREFUSED|11434|Ollama|aborted/i.test(msg)) {
    msg += ' — is Ollama running? Start it with: ollama serve';
  }
  if (receivedAny) streamer.push('\n\n');
  streamer.push(`⚠️ ${msg}`);
  streamer.end();
}

/* Filter error notices out of history so they are never re-sent to the model. */
function cleanHistory(msgs) {
  return msgs.filter((m) => m.role === 'user' || !m.content.startsWith('⚠️'));
}

/* ================= Scrolling ================= */

function scrollDown(el) {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

/* ================= Main chat ================= */

function renderMessages() {
  messagesEl.innerHTML =
    state.messages.map(messageHtml).join('') ||
    '<div class="empty">👋 Start learning! Ask me anything.<br><br>Tip: select or double-click any text to get an explanation in a side panel.</div>';
  scrollDown(messagesEl);
}

function setMainInputEnabled(on) {
  input.disabled = !on;
  sendBtn.disabled = !on;
}

async function createConversation() {
  const res = await fetch('/api/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New conversation' }),
  });
  const conv = await res.json();
  state.conversations.unshift(conv);
  state.currentId = conv.id;
  state.messages = [];
  renderConversationList();
  renderMessages();
  updateTitle();
  return conv;
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text || state.streaming) return;
  input.value = '';
  autoResize(input);

  if (!state.currentId) await createConversation();

  state.messages.push({ role: 'user', content: text });
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
  streamChat(cleanHistory(state.messages), streamer);
}

async function persist() {
  if (!state.currentId) return;
  await fetch(`/api/conversations/${state.currentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: state.messages }),
  });
  loadConversations();
}

/* ================= Conversations list ================= */

async function loadConversations() {
  try {
    const res = await fetch('/api/conversations');
    state.conversations = await res.json();
  } catch {
    state.conversations = [];
  }
  renderConversationList();
}

function renderConversationList() {
  convList.innerHTML =
    state.conversations
      .map(
        (c) => `
      <div class="conv-item ${c.id === state.currentId ? 'active' : ''}" data-id="${c.id}">
        <span class="conv-title">${escapeHtml(c.title)}</span>
        <button class="conv-delete" data-id="${c.id}" title="Delete conversation">✕</button>
      </div>`
      )
      .join('') || '<div class="empty">No conversations yet</div>';
}

async function selectConversation(id) {
  if (state.streaming) return;
  state.currentId = id;
  state.messages = [];
  try {
    const res = await fetch(`/api/conversations/${id}`);
    if (res.ok) {
      const conv = await res.json();
      state.messages = conv.messages || [];
    }
  } catch { /* ignore */ }
  renderMessages();
  renderConversationList();
  updateTitle();
  input.focus();
}

async function deleteConversation(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.currentId === id) {
    state.currentId = null;
    state.messages = [];
    renderMessages();
    updateTitle();
  }
  renderConversationList();
}

function updateTitle() {
  const conv = state.conversations.find((c) => c.id === state.currentId);
  currentTitle.textContent = conv ? conv.title : 'New conversation';
}

/* ================= Explain sidebar ================= */

function buildSidebarSystem(selection, contextMessages) {
  const recent = contextMessages.slice(-10);
  const ctx = recent
    .map((m) => {
      const who = m.role === 'user' ? 'Student' : 'Tutor';
      const content = m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
      return `${who}: ${content}`;
    })
    .join('\n');

  return [
    'You are a learning assistant embedded in a study app.',
    'The student is reading a lesson and selected text they did not fully understand.',
    '',
    'SELECTED TEXT:',
    selection,
    '',
    'LESSON CONTEXT (recent conversation):',
    ctx || '(no context yet)',
    '',
    'Explain the selected text in simple, clear terms. Define any difficult words, terms, or concepts.',
    'Use short examples when helpful. Keep the explanation focused on the selected text.',
    'The student may ask follow-up questions in this panel — answer them using the lesson context above.',
  ].join('\n');
}

function showSidebar() {
  state.sidebar.open = true;
  rightSidebar.classList.add('open');
  rightSidebar.style.width = `${state.sidebar.width}px`;
}

function hideSidebar() {
  state.sidebar.open = false;
  rightSidebar.classList.remove('open');
  rightSidebar.style.width = '0px';
  // Free Ollama right away instead of finishing a hidden stream.
  if (state.sidebar.controller) {
    state.sidebar.controller.abort();
    state.sidebar.controller = null;
  }
  state.sidebar.busy = false;
  setSidebarInputEnabled(true);
}

function renderSidebar() {
  sidebarSelection.innerHTML = state.sidebar.selection
    ? `<div class="selection-quote">"${escapeHtml(state.sidebar.selection)}"</div>`
    : '';
  renderSidebarMessages();
}

function renderSidebarMessages() {
  sidebarMessages.innerHTML =
    state.sidebar.messages.map(messageHtml).join('') ||
    '<div class="empty">The explanation will appear here.</div>';
  scrollDown(sidebarMessages);
}

/* API payload for the explain session: system prompt + a real user turn
 * (models behave better when the first turn is from the user) + history. */
function sidebarApiMessages() {
  return [
    { role: 'system', content: state.sidebar.system },
    { role: 'user', content: 'Explain the selected text above to me.' },
    ...cleanHistory(state.sidebar.messages),
  ];
}

function openSidebar(selection) {
  // Abort any previous sidebar stream so stale responses never leak in.
  if (state.sidebar.controller) state.sidebar.controller.abort();
  const streamId = ++state.sidebar.streamId;
  const controller = new AbortController();
  state.sidebar.controller = controller;

  const system = buildSidebarSystem(selection, state.messages);
  state.sidebar.selection = selection;
  state.sidebar.system = system;
  state.sidebar.messages = [];
  state.sidebar.busy = true;

  renderSidebar();
  showSidebar();
  setSidebarInputEnabled(false);

  const streamer = makeStreamer(sidebarMessages, (full) => {
    if (streamId !== state.sidebar.streamId) return; // stale stream
    state.sidebar.busy = false;
    state.sidebar.controller = null;
    setSidebarInputEnabled(true);
    if (full && full.trim()) {
      state.sidebar.messages.push({ role: 'assistant', content: full });
    }
    renderSidebarMessages();
    sidebarInput.focus();
  });
  streamer.start();
  streamChat(sidebarApiMessages(), streamer, controller.signal);
}

function setSidebarInputEnabled(on) {
  sidebarInput.disabled = !on;
  sidebarSendBtn.disabled = !on;
}

function sendSidebar() {
  const text = sidebarInput.value.trim();
  if (!text || state.sidebar.busy || !state.sidebar.system) return;
  sidebarInput.value = '';
  autoResize(sidebarInput);

  state.sidebar.messages.push({ role: 'user', content: text });
  renderSidebarMessages();
  state.sidebar.busy = true;
  setSidebarInputEnabled(false);

  if (state.sidebar.controller) state.sidebar.controller.abort();
  const streamId = ++state.sidebar.streamId;
  const controller = new AbortController();
  state.sidebar.controller = controller;

  const streamer = makeStreamer(sidebarMessages, (full) => {
    if (streamId !== state.sidebar.streamId) return; // stale stream
    state.sidebar.busy = false;
    state.sidebar.controller = null;
    setSidebarInputEnabled(true);
    if (full && full.trim()) {
      state.sidebar.messages.push({ role: 'assistant', content: full });
    }
    renderSidebarMessages();
    sidebarInput.focus();
  });
  streamer.start();
  streamChat(sidebarApiMessages(), streamer, controller.signal);
}

/* ================= Text selection popup ================= */

function showPopup(rect, text) {
  popup.dataset.text = text;
  popup.style.display = 'block';
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 8}px`;
}

function hidePopup() {
  popup.style.display = 'none';
}

messagesEl.addEventListener('mouseup', () => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hidePopup(); return; }
    const text = sel.toString().trim();
    if (text.length < 2) { hidePopup(); return; }
    if (!messagesEl.contains(sel.anchorNode)) { hidePopup(); return; }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    showPopup(rect, text);
  }, 10);
});

messagesEl.addEventListener('dblclick', () => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    const text = sel.toString().trim();
    if (text.length >= 2 && messagesEl.contains(sel.anchorNode)) {
      hidePopup();
      openSidebar(text);
    }
  }
});

popup.addEventListener('click', () => {
  const text = popup.dataset.text;
  hidePopup();
  if (text) openSidebar(text);
});

document.addEventListener('mousedown', (e) => {
  if (!popup.contains(e.target)) hidePopup();
});

messagesEl.addEventListener('scroll', hidePopup);

/* ================= Resize handle ================= */

resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  resizeHandle.classList.add('dragging');
  const startX = e.clientX;
  const startW = state.sidebar.width;

  function onMove(ev) {
    const w = Math.min(650, Math.max(280, startW + (startX - ev.clientX)));
    state.sidebar.width = w;
    rightSidebar.style.width = `${w}px`;
  }
  function onUp() {
    resizeHandle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

/* ================= Left sidebar toggle ================= */

leftToggle.addEventListener('click', () => {
  state.leftOpen = !state.leftOpen;
  leftSidebar.classList.toggle('collapsed', !state.leftOpen);
});

/* ================= Models ================= */

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    const models = data.models || [];
    if (models.length === 0) throw new Error('no models');
    if (!models.some((m) => m.name === state.model)) {
      state.model = models[0].name;
    }
    modelSelect.innerHTML = models
      .map((m) => `<option value="${m.name}" ${m.name === state.model ? 'selected' : ''}>${m.name}</option>`)
      .join('');
  } catch {
    modelSelect.innerHTML = `<option value="${state.model}">${state.model}</option>`;
  }
}

modelSelect.addEventListener('change', () => {
  state.model = modelSelect.value;
});

/* ================= Input helpers ================= */

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

inputForm.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
input.addEventListener('input', () => autoResize(input));
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

sidebarInputForm.addEventListener('submit', (e) => { e.preventDefault(); sendSidebar(); });
sidebarInput.addEventListener('input', () => autoResize(sidebarInput));
sidebarInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSidebar(); }
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

sidebarClose.addEventListener('click', hideSidebar);

sidebarReset.addEventListener('click', () => {
  if (state.sidebar.busy) return;
  state.sidebar.messages = [];
  renderSidebarMessages();
  sidebarInput.focus();
});

/* ================= Init ================= */

async function init() {
  await loadModels();
  await loadConversations();
  if (state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id);
  } else {
    renderMessages();
  }
  input.focus();
}

init();
