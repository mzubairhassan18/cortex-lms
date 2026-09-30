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
    prevWidth: 380, // width to restore when the main chat was collapsed
  },
  // Explainer containers: a tree of split panes. Roots are created from the
  // main chat, children from selections made inside an explainer container.
  explains: {
    nodes: {},   // id -> { id, parentId, selection, system, messages, busy, streamId, controller, createdAt, w, cw }
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
const explainPanels = $('explain-panels');
const chatArea = $('chat-area');
const explainsToggle = $('explains-toggle');
const explainsCount = $('explains-count');
const sidebarClose = $('sidebar-close');
const sidebarReset = $('sidebar-reset');
const summaryBtn = $('summary-btn');
const summaryOverlay = $('summary-overlay');
const summaryBody = $('summary-body');
const summaryStatus = $('summary-status');
const summaryClose = $('summary-close');
const summaryRefresh = $('summary-refresh');
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
  delete summaryCache[conv.id];
  renderSummary(null, '');
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

  // Leaving a conversation -> refresh its Topics summary in the background.
  if (prevId && prevId !== id) runSummary(prevId, prevMessages, prevSnapshot, false);

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
  // Topics summary: show the cached version instantly, refresh in background.
  if (conv && conv.summary) summaryCache[conv.id] = conv.summary;
  else delete summaryCache[id];
  renderSummary(summaryCache[id] || null, '');
  restoreExplainWindows(conv && conv.explains);
  runSummary(id, state.messages, explainSnapshot(), false);
  input.focus();
}

async function deleteConversation(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  state.conversations = state.conversations.filter((c) => c.id !== id);
  delete summaryCache[id];
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

/* ================= Explainer containers (recursive vertical splits) ================= */
/*
 * Design (desktop):
 * - The main conversation | explainer split can be squeezed so the main chat
 *   becomes a few-pixel line (double-click the divider to toggle).
 * - Selecting text in the MAIN chat opens a ROOT container (root tabs on top).
 * - Selecting text INSIDE a container splits it with a vertical divider,
 *   mirroring the main-chat | explainer layout:
 *       [parent content] | [newest child] | [older children ...]
 *   (the newest child sits closest to the parent content).
 * - Recursive: children split the same way at unlimited depth.
 * - Every pane is draggable down to a few pixels; a collapsed pane becomes a
 *   line that expands on click. Each container shows tabs for its children.
 * - Widths (w/cw) are snapshotted per conversation and restored on return.
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

/* ---------- tree helpers ---------- */

function panelEl(id) {
  return explainPanels.querySelector(`.ex-container[data-id="${id}"]`);
}

function childPane(id) {
  return explainPanels.querySelector(`.ex-pane[data-child="${id}"]`);
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

/* ---------- container DOM ---------- */

function createPanelEl(node) {
  const el = document.createElement('div');
  el.className = 'ex-container';
  el.dataset.id = node.id;
  el.innerHTML = `
    <div class="ex-head" title="${escapeHtml(node.selection)}">
      <span class="ex-quote">💡 "${escapeHtml(node.selection)}"</span>
      <span class="ex-badge" hidden></span>
      <span class="ex-busy" hidden>●●●</span>
      <button class="ex-btn ex-close" title="Close this container and its nested ones">✕</button>
    </div>
    <div class="ex-ctabs" hidden></div>
    <div class="ex-split">
      <div class="ex-pane ex-content">
        <div class="explain-messages"></div>
        <form class="ep-input-form">
          <textarea class="ep-input" rows="1" placeholder="Ask a follow-up question..."></textarea>
          <button type="submit" class="ep-send" title="Send">➤</button>
        </form>
      </div>
    </div>`;
  const content = el.querySelector('.ex-content');
  content.style.flexGrow = String(typeof node.cw === 'number' ? node.cw : 1);
  return el;
}

/*
 * Mount a container: roots go straight into the mount; children get a flex
 * pane + vertical divider inserted right AFTER the parent's content pane, so
 * the newest child always sits next to the parent content:
 *     [parent content] | [newest] | [older ...]
 */
function mountNode(node) {
  const el = createPanelEl(node);
  // Render content only once the element is findable in the DOM.
  const done = () => {
    renderPanelMessages(node);
    updateRowState(node);
    return el;
  };
  if (!node.parentId) {
    explainPanels.appendChild(el);
    return done();
  }
  const parentEl = panelEl(node.parentId);
  if (!parentEl) {          // parent missing -> mount as root instead
    explainPanels.appendChild(el);
    return done();
  }
  const split = parentEl.querySelector(':scope > .ex-split');
  const content = split.querySelector(':scope > .ex-content');
  const ref = content.nextElementSibling;
  const vdiv = document.createElement('div');
  vdiv.className = 'ex-vdiv';
  const pane = document.createElement('div');
  pane.className = 'ex-pane ex-child';
  pane.dataset.child = node.id;
  pane.style.flexGrow = String(typeof node.w === 'number' ? node.w : 1.5);
  pane.appendChild(el);
  split.insertBefore(vdiv, ref);
  split.insertBefore(pane, ref);
  return done();
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

/* ---------- chrome: tabs, badges, visibility, collapsed lines ---------- */

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
          <span class="tab-close" data-close="${id}" title="Close this container and its nested ones">✕</span>
        </button>`;
    })
    .join('');
}

/* Per-container tab strip listing that container's children. */
function renderChildTabs(parentId) {
  const parentEl = panelEl(parentId);
  if (!parentEl) return;
  const box = parentEl.querySelector(':scope > .ex-ctabs');
  if (!box) return;
  const kids = childrenOf(parentId);
  if (!kids.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = kids
    .map(
      (c) => `
      <button class="ex-tab ${state.explains.activeId === c.id ? 'active' : ''}" data-id="${c.id}" title="${escapeHtml(c.selection)}">
        <span class="tab-label">💡 ${escapeHtml(truncateLabel(c.selection, 18))}</span>
        <span class="tab-close" data-close="${c.id}" title="Close this container">✕</span>
      </button>`
    )
    .join('');
}

function renderAllChildTabs() {
  for (const id of Object.keys(state.explains.nodes)) renderChildTabs(id);
}

function updateRowState(node) {
  const el = panelEl(node.id);
  if (!el) return;
  const kids = childrenOf(node.id).length;
  const badge = el.querySelector('.ex-badge');
  badge.hidden = kids === 0;
  badge.textContent = kids ? `${kids} nested` : '';
  el.querySelector('.ex-busy').hidden = !node.busy;
  const ta = el.querySelector('.ep-input');
  const btn = el.querySelector('.ep-send');
  ta.disabled = !!node.busy;
  btn.disabled = !!node.busy;
}

function updateRowStates() {
  for (const n of Object.values(state.explains.nodes)) updateRowState(n);
}

/* Header button: shows how many containers exist and reopens the panel. */
function updateExplainToggle() {
  const count = Object.keys(state.explains.nodes).length;
  explainsCount.textContent = String(count);
  explainsToggle.classList.toggle('hidden', count === 0);
  explainsToggle.classList.toggle('on', state.sidebar.open);
}

function activeRootId() {
  if (state.explains.activeId) {
    const r = rootAncestorOf(state.explains.activeId);
    if (r) return r.id;
  }
  return state.explains.roots[0] || null;
}

/* Only the active root's tree is displayed. */
function updateRootVisibility() {
  const rootId = activeRootId();
  for (const el of explainPanels.children) {
    if (!el.classList || !el.classList.contains('ex-container')) continue;
    el.classList.toggle('active-root', el.dataset.id === rootId);
  }
}

/*
 * Collapsed = pane squeezed to a few pixels -> content hidden, thin line shown.
 * Measured from real widths (flex handles the distribution).
 */
function updateCollapsed() {
  const open = state.sidebar.open;
  for (const pane of explainPanels.querySelectorAll('.ex-pane')) {
    // Only judge panes whose split row is actually laid out — measuring
    // mid-transition would wrongly collapse a wide pane (hidden content).
    const split = pane.parentElement;
    const valid = open && split && split.clientWidth > 0;
    pane.classList.toggle('collapsed', valid && pane.clientWidth <= 10);
  }
  chatArea.classList.toggle('collapsed', chatArea.clientWidth <= 10);
}

let collapsedRaf = 0;
let collapsedTimer = 0;
function updateCollapsedSoon() {
  if (!collapsedRaf) {
    collapsedRaf = requestAnimationFrame(() => {
      collapsedRaf = 0;
      updateCollapsed();
    });
  }
  // The sidebar width animates (0.15s) — re-measure once it has settled so a
  // pane opened during the transition isn't stuck in the collapsed state.
  clearTimeout(collapsedTimer);
  collapsedTimer = setTimeout(updateCollapsed, 220);
}

/* ---------- pane weights (flex-grow) ---------- */

function paneGrow(pane) {
  const v = parseFloat(pane.style.flexGrow);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function setPaneGrow(pane, w) {
  pane.style.flexGrow = String(w);
  if (pane.classList.contains('ex-child')) {
    const n = state.explains.nodes[pane.dataset.child];
    if (n) n.w = w;
  } else {
    const c = pane.closest('.ex-container');
    const n = c && state.explains.nodes[c.dataset.id];
    if (n) n.cw = w;
  }
}

/* Expand a squeezed pane back to a usable share. */
function expandPane(pane) {
  if (!pane) return;
  if (paneGrow(pane) < 0.5) setPaneGrow(pane, pane.classList.contains('ex-child') ? 1.5 : 1);
}

/* ---------- activate / show / hide ---------- */

/* Activating a container: root tree shown, its pane brought back if squeezed,
 * tabs refreshed, scrolled into view. */
function activateExplain(id, persistIt = true) {
  const node = state.explains.nodes[id];
  if (!node) return;
  state.explains.activeId = id;
  expandPane(childPane(id));
  const el = panelEl(id);
  if (el) expandPane(el.querySelector(':scope > .ex-split > .ex-content'));
  renderExplainTabs();
  renderAllChildTabs();
  updateRootVisibility();
  updateExplainToggle();
  updateCollapsedSoon();
  if (el) {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    scrollDown(el.querySelector('.explain-messages'));
  }
  if (persistIt) persist();
}

function showSidebar() {
  state.sidebar.open = true;
  rightSidebar.classList.add('open');
  rightSidebar.style.width = `${state.sidebar.width}px`;
  updateExplainToggle();
  updateCollapsedSoon();
}

/* Hide the panel but KEEP every container — reopen via the header button. */
function hideExplainPanel() {
  state.sidebar.open = false;
  rightSidebar.classList.remove('open');
  rightSidebar.style.width = '0px';
  updateExplainToggle();
}

/* ---------- streaming into a container ---------- */

function explainApiMessages(node) {
  return [
    { role: 'system', content: node.system },
    { role: 'user', content: 'Explain the selected text above to me.' },
    ...cleanHistory(node.messages),
  ];
}

function finishExplainStream(node, streamId, full) {
  if (streamId !== node.streamId) return;             // stale stream
  if (state.explains.nodes[node.id] !== node) return; // container was closed
  node.busy = false;
  node.controller = null;
  if (full && full.trim()) {
    node.messages.push({ role: 'assistant', content: full });
  }
  renderPanelMessages(node);
  updateRowState(node);
  if (state.explains.activeId === node.id) {
    const el = panelEl(node.id);
    const ta = el && el.querySelector('.ep-input');
    if (ta) ta.focus();
  }
  persist();
}

function startExplainStream(node) {
  node.busy = true;
  const streamId = ++node.streamId;
  const controller = new AbortController();
  node.controller = controller;
  updateRowState(node);

  const el = panelEl(node.id);
  const box = el ? el.querySelector('.explain-messages') : null;
  if (!box) { node.busy = false; return; }

  const streamer = makeStreamer(box, (full) => finishExplainStream(node, streamId, full));
  streamer.start();
  streamChat(explainApiMessages(node), streamer, controller.signal);
}

/* ---------- container lifecycle ---------- */

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
    w: 1.5,   // share inside the parent's split (children start bigger)
    cw: 1,    // the container's own content-pane share
  };

  state.explains.nodes[id] = node;
  if (effectiveParent === null) state.explains.roots.push(id);

  mountNode(node);
  if (effectiveParent) {
    renderChildTabs(effectiveParent);
    updateRowState(state.explains.nodes[effectiveParent]);
  } else {
    renderExplainTabs();
  }

  showSidebar(); // never replaces existing containers
  activateExplain(id);
  updateCollapsedSoon();
  startExplainStream(node);
}

function closeExplainWindow(id) {
  const node = state.explains.nodes[id];
  if (!node) return;

  const parentId = node.parentId;
  const doomed = subtreeIds(id);
  const activeDoomed = doomed.includes(state.explains.activeId);

  // Aborted streams end quietly (finishExplainStream sees the node is gone).
  for (const did of doomed) {
    const n = state.explains.nodes[did];
    if (n && n.controller) n.controller.abort();
    delete state.explains.nodes[did];
  }

  if (!parentId) {
    const rootEl = panelEl(id);
    if (rootEl) rootEl.remove();
    state.explains.roots = state.explains.roots.filter((r) => r !== id);
  } else {
    const pane = childPane(id);
    if (pane) {
      const vdiv = pane.previousElementSibling; // this pane's divider
      if (vdiv && vdiv.classList.contains('ex-vdiv')) vdiv.remove();
      pane.remove();
    }
  }

  if (state.explains.roots.length === 0) {
    state.explains.activeId = null;
    hideExplainPanel();
  } else if (activeDoomed) {
    const fallback =
      parentId && state.explains.nodes[parentId]
        ? parentId
        : state.explains.roots[state.explains.roots.length - 1];
    state.explains.activeId = null; // force activateExplain to run
    activateExplain(fallback);
  }

  if (parentId && state.explains.nodes[parentId]) {
    renderChildTabs(parentId);
    updateRowState(state.explains.nodes[parentId]);
  }
  renderExplainTabs();
  renderAllChildTabs();
  updateRootVisibility();
  updateExplainToggle();
  updateCollapsedSoon();
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
  hideExplainPanel();
  updateExplainToggle();
}

/* Rebuild containers from a conversation's saved snapshot (no streaming). */
function restoreExplainWindows(snapshot) {
  if (!snapshot || !snapshot.nodes) return;

  const saved = Object.values(snapshot.nodes);
  if (!saved.length) return;

  for (const s of saved.sort((a, b) => a.createdAt - b.createdAt)) {
    // Orphans (parent lost or not mounted) are promoted to roots.
    const parentId =
      s.parentId && snapshot.nodes[s.parentId] && panelEl(s.parentId) ? s.parentId : null;
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
      w: typeof s.w === 'number' ? s.w : 1.5,
      cw: typeof s.cw === 'number' ? s.cw : 1,
    };
    state.explains.nodes[node.id] = node;
    if (parentId === null) state.explains.roots.push(node.id);
    mountNode(node);
  }

  // Keep only roots that still exist, preserving saved order.
  const roots = (snapshot.roots || []).filter((r) => state.explains.nodes[r]);
  for (const r of state.explains.roots) if (!roots.includes(r)) roots.push(r);
  state.explains.roots = roots;

  if (roots.length === 0) return;

  const activeValid = snapshot.activeId && state.explains.nodes[snapshot.activeId];
  state.explains.activeId = activeValid ? snapshot.activeId : roots[0];

  showSidebar();
  renderExplainTabs();
  renderAllChildTabs();
  updateRootVisibility();
  updateExplainToggle();
  updateRowStates();
  updateCollapsedSoon();
  persist();
}

function sendExplain(container) {
  const node = state.explains.nodes[container.dataset.id];
  const ta = container.querySelector('.ep-input');
  const text = ta.value.trim();
  if (!node || node.busy || !text) return;
  ta.value = '';
  autoResize(ta);

  node.messages.push({ role: 'user', content: text });
  renderPanelMessages(node);
  scrollDown(container.querySelector('.explain-messages'));
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
  const panel = el && el.closest('.ex-container');
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

/* ================= Main chat | explainer resize ================= */
/*
 * The explainer can grow until the main conversation is only a few pixels
 * wide (a line). Double-click the divider — or click the collapsed chat line —
 * to snap between full width and the remembered normal width.
 */

const RESIZE_MIN = 240; // the explainer's own minimum width

function explainerMaxWidth() {
  return Math.max(RESIZE_MIN + 40, window.innerWidth - 12); // leaves ~7px for the chat line
}

function setExplainerWidth(w) {
  state.sidebar.width = w;
  rightSidebar.style.width = `${w}px`;
  updateCollapsedSoon();
}

function toggleMainChat() {
  const isCollapsed = state.sidebar.width >= explainerMaxWidth() - 2;
  if (isCollapsed) {
    setExplainerWidth(state.sidebar.prevWidth || 380);
  } else {
    state.sidebar.prevWidth = state.sidebar.width;
    setExplainerWidth(explainerMaxWidth());
  }
}

resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  resizeHandle.classList.add('dragging');
  const startX = e.clientX;
  const startW = state.sidebar.width;
  // Remember a normal width so the collapsed chat line can be restored later.
  if (startW < explainerMaxWidth() - 120) state.sidebar.prevWidth = startW;

  function onMove(ev) {
    const w = Math.min(explainerMaxWidth(), Math.max(RESIZE_MIN, startW + (startX - ev.clientX)));
    state.sidebar.width = w;
    rightSidebar.style.width = `${w}px`;
    updateCollapsedSoon();
  }
  function onUp() {
    resizeHandle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    updateCollapsed();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
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

/* ---------- Explainer container interactions (delegated) ---------- */

/* Per-container input: submit / Enter. */
explainPanels.addEventListener('submit', (e) => {
  const form = e.target.closest('.ep-input-form');
  if (!form) return;
  e.preventDefault();
  sendExplain(form.closest('.ex-container'));
});
explainPanels.addEventListener('keydown', (e) => {
  if (!e.target.classList || !e.target.classList.contains('ep-input')) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendExplain(e.target.closest('.ex-container'));
  }
});
explainPanels.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('ep-input')) autoResize(e.target);
});

/* Child tabs (activate / close), header ✕ (close), collapsed pane (expand),
 * header click (activate). */
explainPanels.addEventListener('click', (e) => {
  const tabClose = e.target.closest('.ex-tab .tab-close');
  if (tabClose) {
    e.stopPropagation();
    closeExplainWindow(tabClose.dataset.close);
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
    closeExplainWindow(close.closest('.ex-container').dataset.id);
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
});

/* Drag a vertical divider: the two adjacent panes resize (min = few pixels). */
explainPanels.addEventListener('mousedown', (e) => {
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
  const onUp = () => {
    vd.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    updateCollapsed();
    persist();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});

/* Header button: show/hide the explain panel without touching the containers. */
explainsToggle.addEventListener('click', () => {
  if (state.sidebar.open) hideExplainPanel();
  else showSidebar();
});

/* ---------- Topics summary overlay ---------- */

summaryBtn.addEventListener('click', () => {
  const panelHidden = !state.sidebar.open;
  const overlayHidden = summaryOverlay.classList.contains('hidden');
  if (panelHidden || overlayHidden) {
    summaryOverlay.classList.remove('hidden');
    if (panelHidden) showSidebar(); // overlay lives over the containers
    showCachedSummary();
    runSummary(state.currentId, state.messages, explainSnapshot(), false);
  } else {
    summaryOverlay.classList.add('hidden'); // close -> containers visible again
  }
});
summaryClose.addEventListener('click', () => summaryOverlay.classList.add('hidden'));
summaryRefresh.addEventListener('click', () => {
  renderSummary(summaryCache[state.currentId], 'summarizing…');
  runSummary(state.currentId, state.messages, explainSnapshot(), true);
});

window.addEventListener('resize', () => {
  const max = explainerMaxWidth();
  if (state.sidebar.open && state.sidebar.width > max) {
    state.sidebar.width = max;
    rightSidebar.style.width = `${max}px`;
  }
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
    closeExplainWindow(close.dataset.close);
    return;
  }
  const tab = e.target.closest('.explain-tab');
  if (tab) activateExplain(tab.dataset.id);
});

/* ================= Topics summary (background job) ================= */
/*
 * A one-liner + bullet points of the whole session (main chat + every
 * explainer container): what was asked and what was learned/achieved.
 * - Cached per conversation; opening a conversation shows the cache instantly
 *   and refreshes it in the background.
 * - Also refreshed when leaving a conversation, or manually via ↻.
 * - Shown as an overlay over the explainer containers; ✕ closes it.
 */

const summaryCache = {}; // convId -> { headline, points, fingerprint, at }
const summaryState = { inflight: null, queue: null, controller: null };

function fingerprintOf(messages, explains) {
  const nodes = (explains && explains.nodes) || {};
  let n = messages.length;
  let chars = 0;
  for (const m of messages) chars += (m.content || '').length;
  for (const nd of Object.values(nodes)) {
    n += 1 + (nd.messages || []).length;
    chars += (nd.selection || '').length;
    for (const m of nd.messages || []) chars += (m.content || '').length;
  }
  return `${n}:${chars}`;
}

const SUMMARY_SYS = [
  'You summarize a learning session for the student to glance at later.',
  'Output EXACTLY this format and nothing else:',
  'Line 1: one single sentence summarizing what the student is learning and has achieved so far.',
  'Then 3 to 10 bullet points, one per line, each starting with "- ", naming concrete topics that were asked about and learned (question -> what was learned).',
  'Plain short lines. No preamble, no closing remarks, no markdown headings.',
].join('\n');

function summaryPromptInput(messages, explains) {
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const out = [];
  const main = cleanHistory(messages || []);
  if (main.length) {
    out.push('MAIN CONVERSATION:');
    for (const m of main.slice(-30)) {
      out.push(`${m.role === 'user' ? 'Student' : 'Tutor'}: ${clip(m.content, 400)}`);
    }
    out.push('');
  }
  const nodes = (explains && explains.nodes) || {};
  const roots = (explains && explains.roots) || [];
  const seen = new Set();
  const emit = (id, depth) => {
    if (seen.has(id) || !nodes[id]) return;
    seen.add(id);
    const nd = nodes[id];
    out.push(`${depth ? 'NESTED EXPLAINER' : 'EXPLAINER'} — selected: "${clip(nd.selection || '', 200)}"`);
    for (const m of cleanHistory(nd.messages || []).slice(-12)) {
      out.push(`  ${m.role === 'user' ? 'Student' : 'Tutor'}: ${clip(m.content, 300)}`);
    }
    out.push('');
    for (const c of Object.values(nodes)
      .filter((x) => x.parentId === id)
      .sort((a, b) => a.createdAt - b.createdAt)) {
      emit(c.id, depth + 1);
    }
  };
  for (const r of roots) emit(r, 0);
  for (const id of Object.keys(nodes)) if (!seen.has(id)) emit(id, 0);
  return out.join('\n');
}

function parseSummary(text) {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let headline = '';
  const points = [];
  for (const l of lines) {
    if (/^[-*•]\s+/.test(l)) {
      points.push(l.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim());
    } else if (!headline) {
      headline = l
        .replace(/^#+\s*/, '')
        .replace(/\*\*/g, '')
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .trim();
    } else {
      points.push(l.replace(/\*\*/g, '').trim());
    }
  }
  return { headline: headline || 'Learning session', points };
}

function renderSummary(entry, status) {
  summaryStatus.textContent = status || '';
  if (!entry || (!entry.headline && !(entry.points || []).length)) {
    summaryBody.innerHTML = `<div class="summary-empty">No summary yet.${
      state.messages.length || Object.keys(state.explains.nodes).length
        ? ' Press ↻ to generate one.'
        : ' Chat or explain something first.'
    }</div>`;
    return;
  }
  summaryBody.innerHTML = `
    <div class="summary-headline">${escapeHtml(entry.headline)}</div>
    <ul class="summary-points">${(entry.points || [])
      .map((p) => `<li>${escapeHtml(p)}</li>`)
      .join('')}</ul>`;
}

function showCachedSummary() {
  const busy = summaryState.inflight === state.currentId;
  renderSummary(summaryCache[state.currentId], busy ? 'updating…' : '');
}

/* Single-flight: a request arriving while one runs is queued (latest wins). */
function runSummary(convId, messages, explains, force = false) {
  if (!convId) return;
  const fp = fingerprintOf(messages, explains);
  const cached = summaryCache[convId];
  if (!force && cached && cached.fingerprint === fp) return; // already fresh
  if (
    messages.length === 0 &&
    Object.keys((explains && explains.nodes) || {}).length === 0
  ) {
    return; // nothing to summarize
  }
  if (summaryState.inflight) {
    summaryState.queue = { convId, messages, explains, force };
    return;
  }

  summaryState.inflight = convId;
  summaryState.controller = new AbortController();
  const isCurrent = () => convId === state.currentId;
  if (isCurrent()) renderSummary(summaryCache[convId], 'summarizing…');

  let buf = '';
  let finished = false;
  const collector = {
    start() {},
    push(t) {
      buf += t;
    },
    end() {
      finish(buf);
    },
  };

  function finish(text) {
    if (finished) return;
    finished = true;
    summaryState.inflight = null;
    summaryState.controller = null;
    const queue = summaryState.queue;
    summaryState.queue = null;

    if (text && text.trim() && !text.trim().startsWith('⚠️')) {
      const parsed = parseSummary(text);
      const entry = {
        headline: parsed.headline,
        points: parsed.points,
        fingerprint: fp,
        at: Date.now(),
      };
      summaryCache[convId] = entry;
      fetch(`/api/conversations/${convId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: entry }),
      }).catch(() => {});
      if (isCurrent()) renderSummary(entry, '');
    } else if (isCurrent()) {
      renderSummary(summaryCache[convId], text ? 'failed — press ↻ to retry' : '');
    }

    if (queue) runSummary(queue.convId, queue.messages, queue.explains, queue.force);
  }

  streamChat(
    [
      { role: 'system', content: SUMMARY_SYS },
      { role: 'user', content: summaryPromptInput(messages, explains) },
    ],
    collector,
    summaryState.controller.signal
  );
}

/* ================= Init ================= */

async function init() {
  await loadModels();
  await loadConversations();
  if (state.conversations.length > 0) {
    await selectConversation(state.conversations[0].id);
  } else {
    renderMessages();
  }
  updateCollapsed();
  input.focus();
}

init();
