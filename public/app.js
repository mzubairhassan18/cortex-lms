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
  },
  // Explain windows: a tree of sessions. Roots are created from the main chat,
  // children from selections made inside an explain window.
  explains: {
    nodes: {},   // id -> { id, parentId, selection, system, messages, busy, streamId, controller, createdAt }
    roots: [],   // root ids in creation order (these become the tabs)
    activeId: null,
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
const explainTabs = $('explain-tabs');
const explainTreeRow = $('explain-tree-row');
const explainPanels = $('explain-panels');
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
  clearExplainWindows(); // fresh explain panel for a new conversation
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

/* Serializable snapshot of all explain windows (no runtime fields). */
function explainSnapshot() {
  const nodes = {};
  for (const [id, n] of Object.entries(state.explains.nodes)) {
    nodes[id] = {
      id,
      parentId: n.parentId,
      selection: n.selection,
      system: n.system,
      messages: n.messages,
      createdAt: n.createdAt,
    };
  }
  return {
    roots: [...state.explains.roots],
    activeId: state.explains.activeId,
    nodes,
  };
}

async function persist() {
  if (!state.currentId) return;
  await fetch(`/api/conversations/${state.currentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: state.messages, explains: explainSnapshot() }),
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

  // Save the outgoing conversation (messages + explain snapshot) BEFORE switching.
  const prevId = state.currentId;
  const prevSnapshot = explainSnapshot();
  const prevMessages = state.messages;

  // Fresh panel for the incoming conversation — no windows leak across.
  clearExplainWindows();

  state.currentId = id;
  state.messages = [];

  if (prevId && prevId !== id) {
    fetch(`/api/conversations/${prevId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: prevMessages, explains: prevSnapshot }),
    }).catch(() => {});
  }

  let conv = null;
  try {
    const res = await fetch(`/api/conversations/${id}`);
    if (res.ok) conv = await res.json();
  } catch { /* ignore */ }
  state.messages = (conv && conv.messages) || [];

  renderMessages();
  renderConversationList();
  updateTitle();
  restoreExplainWindows(conv && conv.explains);
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
    clearExplainWindows();
    renderMessages();
    updateTitle();
  }
  renderConversationList();
}

function updateTitle() {
  const conv = state.conversations.find((c) => c.id === state.currentId);
  currentTitle.textContent = conv ? conv.title : 'New conversation';
}

/* ================= Explain windows (tree of sessions) ================= */
/*
 * Each selection creates a NEW window — windows are never overridden.
 * - Selection in the main chat  -> root window (shows up in the tab strip)
 * - Selection inside a window   -> child window (linked above via tree row)
 * Snapshots are saved per conversation and restored when you come back.
 */

function formatCtx(msgs) {
  return msgs
    .slice(-10)
    .map((m) => {
      const who = m.role === 'user' ? 'Student' : 'Tutor';
      const content = m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content;
      return `${who}: ${content}`;
    })
    .join('\n');
}

function buildExplainSystem(selection, parentId) {
  const parent = parentId ? state.explains.nodes[parentId] : null;
  const lessonCtx = formatCtx(state.messages);

  if (!parent) {
    return [
      'You are a learning assistant embedded in a study app.',
      'The student is reading a lesson and selected text they did not fully understand.',
      '',
      'SELECTED TEXT:',
      selection,
      '',
      'LESSON CONTEXT (recent conversation):',
      lessonCtx || '(no context yet)',
      '',
      'Explain the selected text in simple, clear terms. Define any difficult words, terms, or concepts.',
      'Use short examples when helpful. Keep the explanation focused on the selected text.',
      'The student may ask follow-up questions in this panel — answer them using the lesson context above.',
    ].join('\n');
  }

  return [
    'You are a learning assistant embedded in a study app.',
    'The student is reading an explanation you gave and selected text inside it they did not fully understand.',
    '',
    'TEXT SELECTED FROM THE EXPLANATION:',
    selection,
    '',
    'THE EXPLANATION BEING READ (earlier exchange in this window):',
    formatCtx(parent.messages) || '(not available)',
    '',
    'ORIGINAL LESSON CONTEXT (recent conversation):',
    lessonCtx || '(no context yet)',
    '',
    'Explain the selected text in simple, clear terms. Define any difficult words, terms, or concepts.',
    'Use short examples when helpful. Keep the explanation focused on the selected text.',
    'The student may ask follow-up questions in this panel — answer them using the context above.',
  ].join('\n');
}

/* ---------- panel (window) DOM ---------- */

function panelEl(id) {
  return explainPanels.querySelector(`.explain-panel[data-id="${id}"]`);
}

function createPanelEl(node) {
  const el = document.createElement('div');
  el.className = 'explain-panel';
  el.dataset.id = node.id;
  el.innerHTML = `
    <div class="selection-quote">"${escapeHtml(node.selection)}"</div>
    <div class="explain-messages"></div>`;
  explainPanels.appendChild(el);
  renderPanelMessages(node);
  return el;
}

function renderPanelMessages(node) {
  const el = panelEl(node.id);
  if (!el) return;
  const box = el.querySelector('.explain-messages');
  box.innerHTML =
    node.messages.map(messageHtml).join('') ||
    '<div class="empty">The explanation will appear here.</div>';
  scrollDown(box);
}

function activeNode() {
  return state.explains.nodes[state.explains.activeId] || null;
}

function childrenOf(id) {
  return Object.values(state.explains.nodes)
    .filter((n) => n.parentId === id)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function subtreeIds(id) {
  const out = [id];
  for (let i = 0; i < out.length; i++) {
    for (const n of childrenOf(out[i])) out.push(n.id);
  }
  return out;
}

function rootAncestorOf(id) {
  let n = state.explains.nodes[id];
  while (n && n.parentId && state.explains.nodes[n.parentId]) {
    n = state.explains.nodes[n.parentId];
  }
  return n || null;
}

function truncateLabel(s, max = 26) {
  return s.length > max ? s.slice(0, max).trimEnd() + '…' : s;
}

/* ---------- rendering: tabs, tree row, input state ---------- */

function renderExplainTabs() {
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
          <span class="tab-close" data-close="${id}" title="Close this window and its nested ones">✕</span>
        </button>`;
    })
    .join('');
}

function renderTreeRow() {
  const node = activeNode();
  const parts = [];

  if (node && node.parentId && state.explains.nodes[node.parentId]) {
    const p = state.explains.nodes[node.parentId];
    parts.push(
      `<span class="tree-label">In:</span>` +
        `<button class="tree-chip parent" data-nav="${p.id}" title="${escapeHtml(p.selection)}">↩ <span class="chip-label">${escapeHtml(truncateLabel(p.selection, 22))}</span></button>`
    );
  }

  if (node) {
    const kids = childrenOf(node.id);
    if (kids.length) {
      parts.push(
        `<span class="tree-label">Nested:</span>` +
          kids
            .map(
              (c) =>
                `<button class="tree-chip child" data-nav="${c.id}" title="${escapeHtml(c.selection)}">💡 <span class="chip-label">${escapeHtml(truncateLabel(c.selection, 22))}</span></button>`
            )
            .join('')
      );
    }
  }

  explainTreeRow.innerHTML = parts.join('');
  explainTreeRow.classList.toggle('hidden', parts.length === 0);
}

function updateInputState() {
  const node = activeNode();
  const disabled = !node || node.busy;
  sidebarInput.disabled = disabled;
  sidebarSendBtn.disabled = disabled;
  sidebarInput.placeholder = node
    ? 'Ask a follow-up question in this window...'
    : 'Select text (in chat or in an explain window) to explain...';
}

function activateExplain(id) {
  if (!state.explains.nodes[id]) return;
  state.explains.activeId = id;
  for (const panel of explainPanels.children) {
    panel.classList.toggle('active', panel.dataset.id === id);
  }
  renderExplainTabs();
  renderTreeRow();
  updateInputState();
  const el = panelEl(id);
  if (el) scrollDown(el.querySelector('.explain-messages'));
  persist();
}

function showSidebar() {
  state.sidebar.open = true;
  rightSidebar.classList.add('open');
  rightSidebar.style.width = `${state.sidebar.width}px`;
}

/* Hide the panel but KEEP every window — tabs come back on the next Explain. */
function hideExplainPanel() {
  state.sidebar.open = false;
  rightSidebar.classList.remove('open');
  rightSidebar.style.width = '0px';
}

/* ---------- streaming into a window ---------- */

function explainApiMessages(node) {
  return [
    { role: 'system', content: node.system },
    { role: 'user', content: 'Explain the selected text above to me.' },
    ...cleanHistory(node.messages),
  ];
}

function finishExplainStream(node, streamId, full) {
  if (streamId !== node.streamId) return;             // stale stream
  if (state.explains.nodes[node.id] !== node) return; // window was closed
  node.busy = false;
  node.controller = null;
  if (full && full.trim()) {
    node.messages.push({ role: 'assistant', content: full });
  }
  renderPanelMessages(node);
  if (state.explains.activeId === node.id) {
    updateInputState();
    sidebarInput.focus();
  }
  persist();
}

function startExplainStream(node) {
  node.busy = true;
  const streamId = ++node.streamId;
  const controller = new AbortController();
  node.controller = controller;
  updateInputState();

  const el = panelEl(node.id);
  const box = el ? el.querySelector('.explain-messages') : null;
  if (!box) { node.busy = false; return; }

  const streamer = makeStreamer(box, (full) => finishExplainStream(node, streamId, full));
  streamer.start();
  streamChat(explainApiMessages(node), streamer, controller.signal);
}

/* ---------- window lifecycle ---------- */

function createExplainWindow(selection, parentId = null) {
  const parent = parentId ? state.explains.nodes[parentId] : null;
  const effectiveParent = parent ? parent.id : null;

  const id = 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const node = {
    id,
    parentId: effectiveParent,
    selection,
    system: buildExplainSystem(selection, effectiveParent),
    messages: [],
    busy: false,
    streamId: 0,
    controller: null,
    createdAt: Date.now(),
  };

  state.explains.nodes[id] = node;
  if (effectiveParent === null) state.explains.roots.push(id);

  createPanelEl(node);
  showSidebar(); // never replaces existing windows
  activateExplain(id);
  startExplainStream(node);
}

function closeExplainWindow(id) {
  const node = state.explains.nodes[id];
  if (!node) return;

  const doomed = subtreeIds(id);
  const activeDoomed = doomed.includes(state.explains.activeId);

  // Aborted streams end quietly (finishExplainStream sees the node is gone).
  for (const did of doomed) {
    const n = state.explains.nodes[did];
    if (n && n.controller) n.controller.abort();
    delete state.explains.nodes[did];
    const el = panelEl(did);
    if (el) el.remove();
  }
  state.explains.roots = state.explains.roots.filter((r) => !doomed.includes(r));

  if (state.explains.roots.length === 0) {
    state.explains.activeId = null;
    hideExplainPanel();
  } else if (activeDoomed) {
    const fallback =
      node.parentId && state.explains.nodes[node.parentId]
        ? node.parentId
        : state.explains.roots[state.explains.roots.length - 1];
    state.explains.activeId = null; // force activateExplain to run
    activateExplain(fallback);
  }

  renderExplainTabs();
  renderTreeRow();
  updateInputState();
  persist();
}

/* Full reset — used when switching/creating conversations (fresh panel). */
function clearExplainWindows() {
  for (const n of Object.values(state.explains.nodes)) {
    if (n.controller) n.controller.abort();
  }
  state.explains.nodes = {};
  state.explains.roots = [];
  state.explains.activeId = null;
  explainPanels.innerHTML = '';
  explainTabs.innerHTML = '';
  explainTreeRow.innerHTML = '';
  explainTreeRow.classList.add('hidden');
  hideExplainPanel();
  updateInputState();
}

/* Rebuild windows from a conversation's saved snapshot (no streaming). */
function restoreExplainWindows(snapshot) {
  if (!snapshot || !snapshot.nodes) return;

  const saved = Object.values(snapshot.nodes);
  if (!saved.length) return;

  for (const s of saved.sort((a, b) => a.createdAt - b.createdAt)) {
    // Orphans (parent lost) are promoted to roots.
    const parentId = s.parentId && snapshot.nodes[s.parentId] ? s.parentId : null;
    const node = {
      id: s.id,
      parentId,
      selection: s.selection,
      system: s.system || buildExplainSystem(s.selection, parentId),
      messages: Array.isArray(s.messages) ? s.messages : [],
      busy: false,
      streamId: 0,
      controller: null,
      createdAt: s.createdAt || Date.now(),
    };
    state.explains.nodes[node.id] = node;
    if (parentId === null) state.explains.roots.push(node.id);
    createPanelEl(node);
  }

  // Keep only roots that still exist, preserving saved order.
  const roots = (snapshot.roots || []).filter((r) => state.explains.nodes[r]);
  for (const r of state.explains.roots) if (!roots.includes(r)) roots.push(r);
  state.explains.roots = roots;

  if (roots.length === 0) return;

  const activeValid = snapshot.activeId && state.explains.nodes[snapshot.activeId];
  showSidebar();
  activateExplain(activeValid ? snapshot.activeId : roots[0]);
}

function sendExplain() {
  const node = activeNode();
  const text = sidebarInput.value.trim();
  if (!node || node.busy || !text) return;
  sidebarInput.value = '';
  autoResize(sidebarInput);

  node.messages.push({ role: 'user', content: text });
  renderPanelMessages(node);
  startExplainStream(node);
}

/* ================= Text selection popup ================= */

function showPopup(rect, text, originId) {
  popup.dataset.text = text;
  popup.dataset.origin = originId || ''; // '' = main chat (root window)
  popup.style.display = 'block';
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 8}px`;
}

function hidePopup() {
  popup.style.display = 'none';
}

function selectionWithin(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (text.length < 2) return null;
  if (!container.contains(sel.anchorNode)) return null;
  return { sel, text, rect: sel.getRangeAt(0).getBoundingClientRect() };
}

function makeSelectionHandlers(container, originOf) {
  container.addEventListener('mouseup', () => {
    setTimeout(() => {
      const found = selectionWithin(container);
      if (!found) { hidePopup(); return; }
      showPopup(found.rect, found.text, originOf(found.sel.anchorNode));
    }, 10);
  });

  container.addEventListener('dblclick', () => {
    const found = selectionWithin(container);
    if (found) {
      hidePopup();
      createExplainWindow(found.text, originOf(found.sel.anchorNode) || null);
    }
  });

  container.addEventListener('scroll', hidePopup);
}

/* Main chat selections create ROOT windows. */
makeSelectionHandlers(messagesEl, () => '');

/* Selections inside an explain window create a CHILD of that window. */
makeSelectionHandlers(explainPanels, (anchor) => {
  const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  const panel = el && el.closest('.explain-panel');
  return panel ? panel.dataset.id : '';
});

popup.addEventListener('click', () => {
  const text = popup.dataset.text;
  const origin = popup.dataset.origin || '';
  hidePopup();
  if (text) createExplainWindow(text, origin || null);
});

document.addEventListener('mousedown', (e) => {
  if (!popup.contains(e.target)) hidePopup();
});

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

sidebarInputForm.addEventListener('submit', (e) => { e.preventDefault(); sendExplain(); });
sidebarInput.addEventListener('input', () => autoResize(sidebarInput));
sidebarInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendExplain(); }
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
  sidebarInput.focus();
});

/* Tab strip: switch between root windows, or close one (with its children). */
explainTabs.addEventListener('click', (e) => {
  const close = e.target.closest('[data-close]');
  if (close) {
    e.stopPropagation();
    closeExplainWindow(close.dataset.close);
    return;
  }
  const tab = e.target.closest('.explain-tab');
  if (tab) activateExplain(tab.dataset.id);
});

/* Tree row: navigate to parent / nested child windows. */
explainTreeRow.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-nav]');
  if (chip) activateExplain(chip.dataset.nav);
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
