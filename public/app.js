'use strict';

/* ================= State ================= */

const state = {
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
const summaryCardSlot = $('summary-card-slot');
const testSection = $('test-section');
const summaryStatus = $('summary-status');
const summaryClose = $('summary-close');
const summaryRefresh = $('summary-refresh');
const testBadges = $('test-badges');
const settingsBtn = $('settings-btn');
const settingsOverlay = $('settings-overlay');
const settingsClose = $('settings-close');
const settingsStatus = $('settings-status');
const setProvider = $('set-provider');
const setKey = $('set-key');
const setBase = $('set-base');
const setConnect = $('set-connect');
const setMessage = $('set-message');
const footerModel = $('footer-model');
const footerInfo = $('footer-info');
const popup = $('selection-popup');

/* ================= Safe markdown rendering ================= */

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    // ">" is deliberately NOT escaped: a lone > cannot open an HTML tag,
    // and escaping it would break markdown blockquotes ("> quote").
    .replace(/"/g, '&quot;');
}

/* Inline markdown — runs on ALREADY-ESCAPED text (safe by construction:
 * only whitelisted tags are produced, links limited to http/https/mailto). */
function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/* Auto-detect markdown syntax in the raw text. Plain chat (including things
 * like "2 * 3") keeps the simple paragraph rendering below. */
function looksLikeMarkdown(s) {
  return (
    /(^|\n)[ \t]*(#{1,6}[ \t]|[-*+][ \t]|\d+\.[ \t]|>[ \t]?|```)/.test(s) ||
    /(^|\n)[ \t]*([-*_][ \t]*){3,}\n/.test(s) ||
    /(^|\n)[ \t]*\|.+\|/.test(s) ||
    /\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|~~[^~\n]+~~/.test(s)
  );
}

/* The source is escaped BEFORE parsing, so raw HTML in the model output can
 * never reach the DOM. This finishes the job for URLs a markdown link could
 * smuggle in (javascript:, data:, …) and adds safe link attributes. */
function sanitizeRendered(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  });
  tpl.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!/^https?:\/\//i.test(src)) img.remove();
  });
  return tpl.innerHTML;
}

/* Fallback block renderer (pre-marked): correct for simple content, used
 * only if the library fails to load. Receives already-escaped text. */
function legacyMarkdown(text) {
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

function renderMarkdown(src) {
  const raw = String(src == null ? '' : src);
  const text = escapeHtml(raw);
  if (!looksLikeMarkdown(raw)) return `<p>${text.replace(/\n/g, '<br>')}</p>`;
  if (window.marked) {
    try {
      return sanitizeRendered(marked.parse(text, { breaks: true }));
    } catch {
      /* fall through to the built-in renderer */
    }
  }
  return legacyMarkdown(text);
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
async function streamChat(messages, streamer, signal, opts) {
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
        body: JSON.stringify({
          model: state.model,
          messages,
          ...(opts && opts.temperature != null ? { temperature: opts.temperature } : {}),
          ...(opts && opts.frequency ? { frequency: opts.frequency } : {}),
          ...(opts && opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
          ...(opts && opts.jsonMode ? { jsonMode: true } : {}),
        }),
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
            if (json.route) {
              // Server picked the source (Auto routing) — refresh the footer.
              state.autoRoute = json.route;
              // Auto keeps the combined pool info in the info line; single
              // providers show the serving model's context/limits.
              if (json.route.info && appSettings.provider !== 'auto') {
                state.modelInfo = json.route.info;
              }
              updateFooterModel();
            } else if (json.error) serverError = json.error;
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

/* Sent with every chat request (not stored in the conversation): guides the
 * model to answer with formatted markdown instead of wrapping everything in
 * a code fence, which the renderer would then show as raw source. */
const CHAT_SYS =
  'You are a friendly learning tutor in a chat app. ' +
  'Format your reply with Markdown when it helps — ## headings, **bold**, ' +
  '- bullet lists, `inline code`. Reply directly with the formatted text; ' +
  'never wrap the whole answer in a code fence.';

function renderMessages() {
  messagesEl.innerHTML =
    state.messages.map(messageHtml).join('') ||
    '<div class="empty">👋 Start learning! Ask me anything.<br><br>Tip: select or double-click any text to get an explanation in a side panel.</div>';
  highlightSources(messagesEl, null); // highlight text that has explanations
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
  delete quizCache[conv.id];
  testsCache[conv.id] = [];
  summaryMode = 'summary';
  quizView = null;
  summaryExpanded = false;
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
  streamChat([{ role: 'system', content: CHAT_SYS }, ...cleanHistory(state.messages)], streamer);
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

  // Leaving a conversation -> refresh its summary + quiz in the background.
  if (prevId && prevId !== id) runBackgroundJobs(prevId, prevMessages, prevSnapshot, false);

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
  // Topics summary + quiz: show the cached version instantly, refresh in background.
  if (conv && conv.summary) summaryCache[conv.id] = conv.summary;
  else delete summaryCache[id];
  if (conv && conv.quiz && Array.isArray(conv.quiz.questions) && conv.quiz.questions.length) {
    quizCache[conv.id] = conv.quiz;
  } else {
    delete quizCache[id];
  }
  testsCache[id] = Array.isArray(conv && conv.tests) ? conv.tests : [];
  summaryMode = 'summary';
  quizView = null;
  summaryExpanded = false;
  renderSummary(summaryCache[id] || null, '');
  restoreExplainWindows(conv && conv.explains);
  runBackgroundJobs(id, state.messages, explainSnapshot(), false);
  input.focus();
}

async function deleteConversation(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this conversation?')) return;
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  state.conversations = state.conversations.filter((c) => c.id !== id);
  delete summaryCache[id];
  delete quizCache[id];
  delete testsCache[id];
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
      'Format answers with Markdown when helpful (## headings, **bold**, lists) — reply directly, never inside a code fence.',
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
    'Format answers with Markdown when helpful (## headings, **bold**, lists) — reply directly, never inside a code fence.',
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
  highlightSources(box, node.id); // nested selections made in this container
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
  // The new container's selection must light up where it was taken from.
  highlightSources(effectiveParent ? boxOf(effectiveParent) : messagesEl, effectiveParent);
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
  refreshAllHighlights(); // closed windows lose their highlight
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
  refreshAllHighlights();
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

/* ================= Models & provider settings ================= */

let appSettings = { provider: 'ollama', baseUrl: '', apiKeySet: false, providers: [] };

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    if (r.ok) appSettings = await r.json();
  } catch { /* keep defaults */ }
  if (!Array.isArray(appSettings.providers) || !appSettings.providers.length) {
    appSettings.providers = [
      { id: 'ollama', label: 'Local (Ollama)', needsKey: false, defaultBaseUrl: '' },
    ];
  }
}

function providerMeta(id) {
  return (
    appSettings.providers.find((p) => p.id === id) || {
      id,
      label: id,
      needsKey: true,
      defaultBaseUrl: '',
    }
  );
}

function renderSettingsForm() {
  setProvider.innerHTML = appSettings.providers
    .map(
      (p) =>
        `<option value="${p.id}" ${p.id === appSettings.provider ? 'selected' : ''}>${escapeHtml(
          p.label
        )}</option>`
    )
    .join('');
  const activeMeta = providerMeta(appSettings.provider);
  setBase.value = appSettings.baseUrl || activeMeta.defaultBaseUrl || '';
  delete setBase.dataset.touched;
  syncProviderFields();
}

function syncProviderFields() {
  const meta = providerMeta(setProvider.value);
  const needsKey = meta.needsKey !== false;
  const isAuto = meta.kind === 'auto';
  $('set-key-row').style.display = needsKey ? '' : 'none';
  const baseRow = $('set-base-row');
  if (baseRow) baseRow.style.display = isAuto ? 'none' : '';
  setKey.value = '';
  const sameProvider = setProvider.value === appSettings.provider;
  setKey.placeholder = !needsKey
    ? 'No key needed'
    : sameProvider && appSettings.apiKeySet
      ? '•••••• saved — type to replace'
      : 'sk-…';
  if (isAuto) {
    setBase.value = '';
    delete setBase.dataset.touched;
  } else if (setBase.dataset.touched !== '1') {
    // Pick the provider's base URL automatically (editable if overridden).
    setBase.value = sameProvider
      ? appSettings.baseUrl || meta.defaultBaseUrl || ''
      : meta.defaultBaseUrl || '';
    setBase.placeholder = meta.defaultBaseUrl || 'https://…';
  }
  setMessage.textContent = '';
  setMessage.className = 'set-message';
  settingsStatus.textContent = '';
}

setProvider.addEventListener('change', () => {
  delete setBase.dataset.touched;
  syncProviderFields();
});
setBase.addEventListener('input', () => {
  setBase.dataset.touched = '1';
});

/* Save settings, then verify by listing the provider's models. */
async function connectProvider() {
  const provider = setProvider.value;
  setConnect.disabled = true;
  setMessage.className = 'set-message working';
  setMessage.textContent = 'Connecting…';
  try {
    const body = { provider, baseUrl: setBase.value.trim() };
    const key = setKey.value.trim();
    if (key) body.apiKey = key;
    const r = await fetch('/api/settings/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Connection failed');

    appSettings = { ...d };
    delete appSettings.models; // settingsView only — models go to the dropdown
    delete setBase.dataset.touched;
    state.autoRoute = null; // re-routing from scratch after a settings change

    applyModels(d.models || []);
    setMessage.className = 'set-message ok';
    if (d.autoSources && d.autoSources.length) {
      const names = d.autoSources.map((x) => x.label.replace(/\s*\(.*\)\s*/, '')).join(', ');
      setMessage.textContent = `✓ Auto ready — ${d.autoSources.length} source(s): ${names}`;
    } else {
      setMessage.textContent = `✓ Connected — ${(d.models || []).length} model(s) available`;
    }
    settingsStatus.textContent = '✓';
    updateFooterModel();
  } catch (e) {
    setMessage.className = 'set-message err';
    setMessage.textContent = '✗ ' + (e.message || 'Connection failed');
    settingsStatus.textContent = '✗';
  } finally {
    setConnect.disabled = false;
  }
}
setConnect.addEventListener('click', connectProvider);

/* Left-sidebar footer: which provider + model is active. */
function updateFooterModel() {
  if (footerModel) {
    const meta = providerMeta(appSettings.provider);
    const label = meta.label;
    if (meta.kind === 'auto') {
      const r = state.autoRoute;
      footerModel.textContent = r
        ? `Auto · ${r.label} · ${r.model}`
        : 'Auto · picks a working model per message';
      footerModel.title = r
        ? `Auto routing\nServing now: ${r.label}\nModel: ${r.model}` +
            (r.info && r.info.context ? `\nContext: ${r.info.context}` : '')
        : `${label}\nSend a message — the server probes for a source that answers.`;
    } else {
      footerModel.textContent = `${label} · ${state.model}`;
      footerModel.title = `Provider: ${label}\nModel: ${state.model}`;
    }
  }
  updateFooterInfo();
}

/* Info line above ⚙ Settings: the active model's context window and usage
 * limits — combined across sources when Auto is selected. */
function updateFooterInfo() {
  if (!footerInfo) return;
  const info = state.modelInfo;
  if (!info || !info.text) {
    footerInfo.hidden = true;
    footerInfo.textContent = '';
    footerInfo.removeAttribute('title');
    return;
  }
  footerInfo.hidden = false;
  footerInfo.textContent = info.text;
  footerInfo.title = info.title || info.text;
}

async function loadModelInfo() {
  try {
    const r = await fetch(
      `/api/model-info?provider=${encodeURIComponent(appSettings.provider)}` +
        `&model=${encodeURIComponent(state.model)}`
    );
    if (r.ok) state.modelInfo = await r.json();
  } catch { /* keep the previous info */ }
  updateFooterInfo();
}

function applyModels(models) {
  if (!models.length) throw new Error('the provider returned no models');
  const autoMode =
    appSettings.provider === 'auto' || (models.length === 1 && models[0].name === 'auto');
  if (autoMode) {
    // Auto: the server picks the source/model per message.
    state.model = 'auto';
    modelSelect.innerHTML = '<option value="auto">Auto — server picks a model</option>';
    modelSelect.disabled = true;
    updateModelWrapTitle();
    updateFooterModel();
    loadModelInfo();
    return;
  }
  modelSelect.disabled = false;
  if (!models.some((m) => m.name === state.model)) state.model = models[0].name;
  modelSelect.innerHTML = models
    .map(
      (m) =>
        `<option value="${escapeHtml(m.name)}" ${
          m.name === state.model ? 'selected' : ''
        }>${escapeHtml(m.name)}</option>`
    )
    .join('');
  updateModelWrapTitle();
  updateFooterModel();
  loadModelInfo();
}

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'model list failed');
    applyModels(data.models || []);
  } catch {
    modelSelect.disabled = false;
    modelSelect.innerHTML = `<option value="${escapeHtml(state.model)}">${escapeHtml(
      state.model
    )}</option>`;
    loadModelInfo();
  }
  updateModelWrapTitle();
  updateFooterModel();
}

modelSelect.addEventListener('change', () => {
  state.model = modelSelect.value;
  updateModelWrapTitle();
  updateFooterModel();
  loadModelInfo();
});

/* Tooltip showing the current model (useful when the select is icon-only). */
function updateModelWrapTitle() {
  const wrap = $('model-wrap');
  if (wrap) wrap.title = `Model: ${state.model}`;
}

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
  // Highlighted source text (nested selections made inside this container)
  const mark = e.target.closest('mark.explain-src');
  if (mark && mark.dataset.id) {
    focusExplainFromMark(mark.dataset.id);
    return;
  }
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

/* Clicking highlighted source text focuses its explainer container. */
messagesEl.addEventListener('click', (e) => {
  const mark = e.target.closest('mark.explain-src');
  if (mark && mark.dataset.id) focusExplainFromMark(mark.dataset.id);
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
    settingsOverlay.classList.add('hidden'); // only one overlay at a time
    summaryOverlay.classList.remove('hidden');
    if (panelHidden) showSidebar(); // overlay lives over the containers
    showCachedSummary();
    runBackgroundJobs(state.currentId, state.messages, explainSnapshot(), false);
  } else {
    summaryOverlay.classList.add('hidden'); // close -> containers visible again
  }
});
summaryClose.addEventListener('click', () => summaryOverlay.classList.add('hidden'));
summaryRefresh.addEventListener('click', () => {
  renderSummary(summaryCache[state.currentId], 'summarizing…');
  runBackgroundJobs(state.currentId, state.messages, explainSnapshot(), true);
});

/* ---------- Settings overlay (provider + API key) ---------- */

settingsBtn.addEventListener('click', () => {
  summaryOverlay.classList.add('hidden'); // only one overlay at a time
  const panelHidden = !state.sidebar.open;
  settingsOverlay.classList.remove('hidden');
  if (panelHidden) showSidebar();
  renderSettingsForm();
  setProvider.focus();
});
settingsClose.addEventListener('click', () => settingsOverlay.classList.add('hidden'));

/* Toolbar collapses to icons when the window itself gets narrow. */
function updateToolbarDensity() {
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
    closeExplainWindow(close.dataset.close);
    return;
  }
  const tab = e.target.closest('.explain-tab');
  if (tab) activateExplain(tab.dataset.id);
});

/* ================= Source-text highlighting ================= */
/*
 * Text that has an explanation gets highlighted in its origin — the main
 * chat for root containers, the parent container for nested ones.
 * Clicking a highlight instantly focuses (and widens) that container.
 */

function boxOf(id) {
  const el = panelEl(id);
  return el ? el.querySelector('.explain-messages') : null;
}

/* Rebuild every highlight for the nodes whose selection origin is originId.
 * originId === null -> main chat. */
function highlightSources(box, originId) {
  if (!box) return;
  // Unwrap previous marks — rebuild from scratch (simple and safe).
  box.querySelectorAll('mark.explain-src').forEach((m) => {
    const parent = m.parentNode;
    if (!parent) return;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize(); // merge split text nodes back together
  });
  const targets = Object.values(state.explains.nodes)
    .filter((n) => (n.parentId || null) === (originId || null))
    .filter((n) => n.selection && n.selection.trim())
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const t of targets) wrapFirstOccurrence(box, t.selection.trim(), t.id);
}

function wrapFirstOccurrence(box, text, id) {
  const gather = () => {
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const starts = [];
    let full = '';
    let n;
    while ((n = walker.nextNode())) {
      starts.push([n, full.length]);
      full += n.nodeValue;
    }
    return { full, starts };
  };

  let from = 0;
  for (;;) {
    const { full, starts } = gather();
    const idx = full.indexOf(text, from);
    if (idx === -1) return; // not found (markdown transformed it) — skip silently
    const loc = locateOffset(starts, idx);
    // Skip occurrences already inside another highlight (shared wording).
    if (
      loc &&
      loc.node.parentElement &&
      loc.node.parentElement.closest('mark.explain-src')
    ) {
      from = idx + 1;
      continue;
    }
    if (wrapRange(starts, idx, idx + text.length, id)) return;
    from = idx + 1; // odd layout — try the next occurrence
  }
}

function locateOffset(starts, pos) {
  for (const [node, off] of starts) {
    if (pos >= off && pos < off + node.nodeValue.length) return { node, off };
  }
  return null;
}

function wrapRange(starts, s, e, id) {
  let startNode = null;
  let startOff = 0;
  let endNode = null;
  let endOff = 0;
  for (const [node, off] of starts) {
    const len = node.nodeValue.length;
    if (!startNode && s >= off && s < off + len) {
      startNode = node;
      startOff = s - off;
    }
    if (e > off && e <= off + len) {
      endNode = node;
      endOff = e - off;
      break;
    }
  }
  if (!startNode || !endNode) return false;
  try {
    const range = document.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    const mark = document.createElement('mark');
    mark.className = 'explain-src';
    mark.dataset.id = id;
    mark.title = 'Explanation ready — click to open it';
    mark.appendChild(range.extractContents());
    range.insertNode(mark);
    return true;
  } catch {
    return false;
  }
}

function refreshAllHighlights() {
  highlightSources(messagesEl, null);
  for (const id of Object.keys(state.explains.nodes)) {
    highlightSources(boxOf(id), id);
  }
}

/* Clicking a highlighted passage: bring its container up, widen it at once. */
function focusExplainFromMark(id) {
  const node = state.explains.nodes[id];
  if (!node) return;
  if (!state.sidebar.open) showSidebar();
  activateExplain(id); // root tab switch, scroll into view, tab highlight
  const pane = childPane(id);
  if (pane) {
    // Give it a dominant share instantly (but never shrink what user sized up).
    setPaneGrow(pane, Math.max(paneGrow(pane), 3));
    updateCollapsedSoon();
    persist();
  }
}

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
const quizCache = {};   // convId -> { fingerprint, questions: [{q,options,answer,why}], at }
const testsCache = {};  // convId -> [report, ...] (newest last)
const quizState = { inflight: null, queue: null, controller: null };

// UI state for the summary overlay: collapsible card, active test, results.
let summaryMode = 'summary'; // 'summary' | 'quiz' | 'results'
let quizView = null;         // { i, answers, done, saved, report }
let summaryExpanded = false; // points are collapsed until the user expands
let lastSummaryStatus = '';

/* Background jobs (summary, quiz) are serialized so the model gets one
 * generation at a time — order: whatever was requested first. */
let bgChain = Promise.resolve();
function enqueueBg(job) {
  const run = bgChain.then(job, job);
  bgChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

function runBackgroundJobs(convId, messages, explains, force = false) {
  runSummary(convId, messages, explains, force);
  runQuiz(convId, messages, explains, force);
}

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

/* Map-reduce summarization — small models (phi4-mini: 3.8B / 4K context)
 * degenerate into repetition loops when handed the whole session at once.
 * So instead:  1) MAP — split the session into small chunks (one Q&A /
 * explainer topic each, ~1.1K chars) and extract a few notes per chunk;
 * 2) MERGE — only if the combined notes are still large, condense them in
 * halves; 3) REDUCE — condense everything into headline + 3-10 bullets.
 * Low temperature + frequency/repeat penalties + validation (drop repeated/
 * duplicate/junk lines) is the standard reliable recipe for summarizing
 * long content with small models. */

const SUMMARY_SYS_MAP = [
  'You extract study notes from ONE short excerpt of a learning conversation.',
  'Output ONLY bullet points, one per line, each starting with "- ".',
  'Each point: one short plain sentence (max 20 words) naming what was asked and what was learned (question -> key fact/answer).',
  '2 to 5 points. No preamble, no numbering, no headings, no repeated words, no closing remarks.',
].join('\n');

const SUMMARY_SYS_MERGE = [
  'You merge overlapping study notes into fewer notes.',
  'Output ONLY bullet points, one per line, each starting with "- ".',
  'Combine duplicates, keep every distinct topic, short plain sentences, at most 15 points, no commentary.',
].join('\n');

const SUMMARY_SYS_REDUCE = [
  'You condense study notes into a short learning-session summary.',
  'Output EXACTLY this format and nothing else:',
  'Line 1: one single sentence (max 25 words) summarizing what the student is learning and has achieved.',
  'Then 3 to 10 bullet points, one per line, each starting with "- ", naming concrete topics learned (question -> what was learned).',
  'Merge duplicate points, plain short lines, never repeat words, no preamble, no closing remarks.',
].join('\n');

/* One awaited request inside a background job (resolves with the full text).
 * Summary + quiz generation both go through here → the same /api/chat as
 * chat, so Auto routing/failover picks their model too — they are never
 * pinned to Ollama/phi4 or any other single model. */
function bgRequest(messages, signal, opts) {
  return new Promise((resolve) => {
    let buf = '';
    streamChat(
      messages,
      {
        start() {},
        push(t) {
          buf += t;
        },
        end() {
          resolve(buf);
        },
      },
      signal,
      opts
    );
  });
}

/* --- output validation: drop degenerate / repetitive / junk lines --- */

function hasRepetition(s, minWords = 4) {
  const words = String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
  if (words.length < minWords) return true; // too short to be a real point
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) return true; // "captured captured …"
  }
  const counts = {};
  for (const w of words) {
    if (w.length > 3) counts[w] = (counts[w] || 0) + 1;
  }
  return Object.values(counts).some((c) => c >= 4); // looping sentence
}

function sanitizePoints(lines) {
  const out = [];
  const keys = [];
  for (let line of lines || []) {
    line = String(line)
      .replace(/\s+/g, ' ')
      .replace(/^([-*•]\s+|\d+[.)]\s+)+/, '')
      .replace(/\*\*/g, '')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim();
    if (line.length < 12 || line.length > 240) continue;
    if (hasRepetition(line)) continue;
    if (/[:;]$/.test(line)) continue; // heading leftovers
    if (/^(here|sure|below|following|note|notes|summary|overview|certainly)\b/i.test(line)) {
      continue; // model preamble
    }
    const key = line
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const head = key.slice(0, 56);
    if (keys.some((h) => h === key || h.startsWith(head) || head.startsWith(h.slice(0, 56)))) {
      continue; // exact or near duplicate
    }
    keys.push(key);
    out.push(line);
    if (out.length >= 12) break;
  }
  return out;
}

function parseBulletLines(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines.filter((l) => /^[-*•]\s+/.test(l));
  return bullets.length ? bullets : lines; // model ignored the "-" prefix
}

function sanitizeHeadline(s, fallback) {
  const h = String(s || '')
    .replace(/^[-*•]\s+/, '')
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!h || h.length > 220 || hasRepetition(h, 3)) return fallback;
  return h;
}

/* --- MAP: split the session into small chunks (one topic per unit) --- */

function buildSummaryChunks(messages, explains) {
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const units = [];

  const main = cleanHistory(messages || []);
  let i = 0;
  while (i < main.length) {
    const m = main[i];
    if (m.role === 'user') {
      const a = main[i + 1] && main[i + 1].role === 'assistant' ? main[i + 1] : null;
      units.push(`Student: ${clip(m.content, 450)}${a ? `\nTutor: ${clip(a.content, 750)}` : ''}`);
      i += a ? 2 : 1;
    } else {
      units.push(`${m.role === 'assistant' ? 'Tutor' : 'Note'}: ${clip(m.content, 500)}`);
      i += 1;
    }
  }

  const nodes = (explains && explains.nodes) || {};
  const roots = (explains && explains.roots) || [];
  const seen = new Set();
  const emit = (id, depth) => {
    if (seen.has(id) || !nodes[id]) return;
    seen.add(id);
    const nd = nodes[id];
    if (nd.selection) {
      units.push(`Explainer topic${depth ? ' (nested)' : ''}: "${clip(nd.selection, 350)}"`);
    }
    const msgs = cleanHistory(nd.messages || []);
    let j = 0;
    while (j < msgs.length) {
      const m = msgs[j];
      if (m.role === 'user') {
        const a = msgs[j + 1] && msgs[j + 1].role === 'assistant' ? msgs[j + 1] : null;
        units.push(
          `Student: ${clip(m.content, 300)}${a ? `\nTutor: ${clip(a.content, 500)}` : ''}`
        );
        j += a ? 2 : 1;
      } else {
        j += 1;
      }
    }
    for (const c of Object.values(nodes)
      .filter((x) => x.parentId === id)
      .sort((a, b) => a.createdAt - b.createdAt)) {
      emit(c.id, depth + 1);
    }
  };
  for (const r of roots) emit(r, 0);
  for (const id of Object.keys(nodes)) if (!seen.has(id)) emit(id, 0);

  /* Pack units into chunks of ~1100 chars — small enough for a 4K-context
   * model together with the prompt. A Q&A pair is never split across chunks. */
  const chunks = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > 1100) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + u;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

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

function renderTestBadges() {
  const list = testsCache[state.currentId] || [];
  testBadges.innerHTML = list.length
    ? `<span class="badges-label">Tests:</span>` +
      list
        .map(
          (r, i) =>
            `<button type="button" class="test-badge" data-i="${i}" title="${new Date(
              r.at || Date.now()
            ).toLocaleString()} — ${r.score}/${r.total} correct">${r.percent}%</button>`
        )
        .reverse()
        .join('')
    : '';
}

function renderSummary(entry, status) {
  lastSummaryStatus = status || '';
  summaryStatus.textContent = lastSummaryStatus;
  renderTestBadges();

  // The learning-session card (headline + collapsible points).
  if (!entry || (!entry.headline && !(entry.points || []).length)) {
    summaryCardSlot.innerHTML = `<div class="summary-empty">No summary yet.${
      state.messages.length || Object.keys(state.explains.nodes).length
        ? ' Press ↻ to generate one.'
        : ' Chat or explain something first.'
    }</div>`;
  } else {
    summaryCardSlot.innerHTML = `
    <div class="summary-card">
      <button type="button" class="summary-collapse" id="sum-collapse"
              aria-expanded="${summaryExpanded}">
        <span class="caret">${summaryExpanded ? '▾' : '▸'}</span>
        <span class="summary-headline">${renderInline(escapeHtml(String(entry.headline || '')))}</span>
      </button>
      <div class="summary-details"${summaryExpanded ? '' : ' hidden'}>
        <ul class="summary-points">${(entry.points || [])
          .map((p) => `<li>${renderInline(escapeHtml(String(p)))}</li>`)
          .join('')}</ul>
      </div>
    </div>`;
  }

  renderTestSection();
}

/* The "Take a test" section lives in its own card directly BELOW the
 * learning session — and becomes the quiz / results view while a test runs. */
function renderTestSection() {
  if (summaryMode === 'quiz') {
    renderQuiz();
    return;
  }
  if (summaryMode === 'results') {
    renderResults();
    return;
  }
  const quiz = quizCache[state.currentId];
  const ready = quiz && Array.isArray(quiz.questions) && quiz.questions.length;
  const preparing = quizState.inflight === state.currentId;
  const hasContent =
    state.messages.length > 0 || Object.keys(state.explains.nodes).length > 0;
  const body = ready
    ? `<button type="button" id="take-test-btn">📝 Take a test (${quiz.questions.length} question${quiz.questions.length === 1 ? '' : 's'})</button>`
    : preparing
      ? `<span class="test-wait">⏳ Preparing your test…</span>`
      : hasContent
        ? `<span class="test-wait">No test yet — press ↻ to generate one.</span>`
        : `<span class="test-wait">Chat or explain something to unlock a test.</span>`;
  testSection.innerHTML = `
    <div class="test-card">
      <div class="test-card-head">📝 Test your knowledge</div>
      <div class="test-cta">${body}</div>
    </div>`;
}

function showCachedSummary() {
  const busy = summaryState.inflight === state.currentId;
  renderSummary(summaryCache[state.currentId], busy ? 'updating…' : '');
}

/* Single-flight: a request arriving while one runs is queued (latest wins).
 * The job itself is a map-reduce pipeline of several small requests. */
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
  const signal = summaryState.controller.signal;
  const isCurrent = () => convId === state.currentId;
  const setStatus = (t) => {
    if (isCurrent()) {
      lastSummaryStatus = t;
      summaryStatus.textContent = t;
    }
  };
  setStatus('summarizing…');

  // Low temperature + anti-repeat + a hard output cap keeps small models out
  // of runaway repetition loops (bounded work per background request).
  const SAMPLING = { temperature: 0.2, frequency: 0.8, maxTokens: 500 };

  enqueueBg(async () => {
    try {
      const chunks = buildSummaryChunks(messages, explains);
      if (!chunks.length) throw new Error('empty session');

      // ---- MAP: a few notes from each small chunk ----
      let notes = [];
      for (let i = 0; i < chunks.length; i++) {
        if (signal.aborted) return;
        setStatus(
          chunks.length > 1 ? `summarizing ${i + 1}/${chunks.length}…` : 'summarizing…'
        );
        const txt = await bgRequest(
          [
            { role: 'system', content: SUMMARY_SYS_MAP },
            { role: 'user', content: chunks[i] },
          ],
          signal,
          SAMPLING
        );
        if (/^\s*⚠️/.test(String(txt))) continue; // this chunk failed — keep going
        notes.push(...parseBulletLines(txt));
      }
      notes = sanitizePoints(notes);
      if (!notes.length) throw new Error('no notes extracted');

      // ---- MERGE: hierarchical reduction if notes exceed one reduce pass ----
      let guard = 0;
      while (notes.join('\n').length > 6000 && notes.length > 12 && guard < 4) {
        if (signal.aborted) return;
        guard++;
        setStatus('summarizing…');
        const before = notes.length;
        const half = Math.ceil(before / 2);
        const batches = [notes.slice(0, half), notes.slice(half)];
        const merged = [];
        for (const b of batches) {
          const txt = await bgRequest(
            [
              { role: 'system', content: SUMMARY_SYS_MERGE },
              { role: 'user', content: b.map((p) => `- ${p}`).join('\n') },
            ],
            signal,
            SAMPLING
          );
          if (!/^\s*⚠️/.test(String(txt))) merged.push(...parseBulletLines(txt));
        }
        const next = sanitizePoints(merged);
        if (!next.length || next.length >= before) break; // no progress — stop
        notes = next;
      }

      // ---- REDUCE: final headline + 3-10 bullets ----
      let headline = '';
      let points = [];
      if (!signal.aborted) {
        setStatus('summarizing…');
        const txt = await bgRequest(
          [
            { role: 'system', content: SUMMARY_SYS_REDUCE },
            {
              role: 'user',
              content: `Session notes:\n${notes.map((p) => `- ${p}`).join('\n')}`,
            },
          ],
          signal,
          SAMPLING
        );
        if (!/^\s*⚠️/.test(String(txt))) {
          const parsed = parseSummary(txt);
          headline = sanitizeHeadline(parsed.headline, '');
          points = sanitizePoints(parsed.points);
        }
      }
      if (signal.aborted) return;

      // Fall back to the validated map notes if the reduce pass failed.
      if (!points.length) points = notes.slice(0, 10);
      if (!headline) {
        const p0 = points[0] || '';
        const sentence = p0.match(/^[^.!?]*[.!?]/);
        headline = sanitizeHeadline(
          (sentence ? sentence[0] : p0).slice(0, 160),
          'Learning session'
        );
      }
      // Drop a first bullet that just repeats the headline sentence.
      if (points.length > 3 && headline) {
        const norm = (s) =>
          String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        const nh = norm(headline);
        const n0 = norm(points[0]);
        if (n0 && nh && (n0 === nh || n0.startsWith(nh) || nh.startsWith(n0))) {
          points = points.slice(1);
        }
      }

      const entry = {
        headline,
        points: points.slice(0, 10),
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
    } catch (e) {
      if (isCurrent()) {
        renderSummary(summaryCache[convId], signal.aborted ? '' : 'failed — press ↻ to retry');
      }
    } finally {
      if (summaryState.inflight === convId) {
        summaryState.inflight = null;
        summaryState.controller = null;
      }
      const queue = summaryState.queue;
      summaryState.queue = null;
      if (queue) runSummary(queue.convId, queue.messages, queue.explains, queue.force);
    }
  });
}

/* ================= Quiz (background job) ================= */
/*
 * A multiple-choice test generated from the same session content as the
 * summary: 5-20 questions (longer conversation -> longer test), each with
 * exactly 4 options and one correct answer. Cached per conversation,
 * refreshed on open / on leaving / via ↻, persisted with PUT {quiz}.
 */

const QUIZ_SYS = [
  'You write multiple-choice quiz questions for a learning session.',
  'Output ONLY a JSON array — no markdown fences, no commentary, no extra text.',
  'Each element: {"q":"question","options":["choice one","choice two","choice three","choice four"],"answer":0,"why":"one short sentence explaining the correct answer"}',
  'Rules:',
  '- exactly 4 options per question; exactly one correct answer ("answer" is its 0-based index).',
  '- Every option must be a real, plausible full answer phrase — NEVER the letters A/B/C/D or placeholder text.',
  '- Test understanding (definitions, cause and effect, examples, application), not trivia or wording memory.',
  '- Every question must be answerable ONLY from the session content provided.',
  '- Vary difficulty; cover different parts of the session; never test the same fact twice.',
  '- Plain short English sentences.',
].join('\n');

/* Rotating focus per batch — forces variety: small models at low temperature
 * otherwise regenerate the same "obvious" question every batch. */
const QUIZ_FOCUS = [
  'core definitions and what the key terms mean',
  'causes, effects, and why things happen',
  'practical applications, uses, and real-world examples',
  'which of the following statements is correct (comparisons and choices)',
  'sequences and processes — what happens step by step',
  'advantages, limitations, and trade-offs',
];

/* Question count scales with the conversation: base 5, +1 per 5 messages,
 * +1 per summary point, clamped to 4..20. */
function quizCount(convId, messages, explains) {
  const nodes = (explains && explains.nodes) || {};
  let msgs = messages.length;
  for (const nd of Object.values(nodes)) msgs += (nd.messages || []).length;
  const pts = ((summaryCache[convId] || {}).points || []).length;
  return Math.max(4, Math.min(20, 5 + Math.floor(msgs / 5) + pts));
}

function parseQuiz(text) {
  const t = String(text || '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // --- 1. direct shapes: bare array, wrapper object, single question ---
  let arr = null;
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const a = tryParse(t.slice(start, end + 1));
    // Only accept if it actually contains question objects — otherwise a
    // single-question output's inner options array ["A","B",...] would win.
    if (
      Array.isArray(a) &&
      a.some((x) => x && typeof x === 'object' && !Array.isArray(x))
    ) {
      arr = a;
    }
  }
  if (!arr || !arr.length) {
    const o = tryParse(t);
    if (Array.isArray(o)) arr = o;
    else if (o && typeof o === 'object') {
      if (Array.isArray(o.questions)) arr = o.questions;
      else if (typeof o.q === 'string') arr = [o]; // model returned one object
      else arr = Object.values(o).find((v) => Array.isArray(v)) || [];
    }
  }

  // --- 2. salvage: small models truncate (token cap) or degrade mid-array.
  // Walk the text tracking braces/brackets/strings, keep every complete
  // {...} object, and repair a truncated tail by closing what's open. ---
  if (!arr || !arr.length) {
    const stack = []; // ['{' | '[', position]
    let inStr = false;
    let esc = false;
    const objs = [];
    const tryPush = (span) => {
      const parsed = tryParse(span);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objs.push(parsed);
      return Array.isArray(parsed) ? parsed : null;
    };
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push([c, i]);
      else if (c === '}' || c === ']') {
        const top = stack.pop();
        if (top && top[0] === '{' && c === '}') tryPush(t.slice(top[1], i + 1));
      }
    }
    // Truncated tail: close the open string and every open bracket, reparse.
    if (stack.length) {
      let full = t;
      if (inStr) full += '"';
      for (let j = stack.length - 1; j >= 0; j--) full += stack[j][0] === '{' ? '}' : ']';
      const o = tryParse(full);
      if (Array.isArray(o)) arr = o;
      else if (o && typeof o === 'object') {
        if (Array.isArray(o.questions)) arr = o.questions;
        else if (typeof o.q === 'string') arr = [o];
      }
    }
    if ((!arr || !arr.length) && objs.length) arr = objs;
  }

  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw.q !== 'string' || !raw.q.trim()) continue;
    const opts = Array.isArray(raw.options)
      ? raw.options.filter((o) => typeof o === 'string' && o.trim())
      : [];
    const ans = Number(raw.answer);
    if (opts.length < 2 || opts.length > 6) continue;
    if (!Number.isInteger(ans) || ans < 0 || ans >= opts.length) continue;
    out.push({
      q: raw.q.trim(),
      options: opts.map((o) => o.trim()),
      answer: ans,
      why: typeof raw.why === 'string' ? raw.why.trim() : '',
    });
  }
  return out;
}

/* Reject degenerate / repetitive questions and options produced by small
 * models that fall into loops (same validation idea as sanitizePoints). */
function sanitizeQuiz(questions) {
  return (questions || []).filter((q) => {
    if (!q || typeof q.q !== 'string') return false;
    const t = q.q.trim();
    if (t.length < 8 || t.length > 300 || hasRepetition(t, 3)) return false;
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) return false;
    if (q.options.every((o) => String(o).trim().length <= 2)) return false; // ["A","B","C","D"] placeholders
    for (const o of q.options) {
      if (typeof o !== 'string' || !o.trim() || o.length > 160) return false;
      if (hasRepetition(o, 1)) return false;
    }
    return Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length;
  });
}

function runQuiz(convId, messages, explains, force = false) {
  if (!convId) return;
  const fp = fingerprintOf(messages, explains);
  const cached = quizCache[convId];
  if (!force && cached && cached.fingerprint === fp && (cached.questions || []).length) return;
  if (
    messages.length === 0 &&
    Object.keys((explains && explains.nodes) || {}).length === 0
  ) {
    return;
  }
  if (quizState.inflight) {
    quizState.queue = { convId, messages, explains, force };
    return;
  }

  quizState.inflight = convId;
  quizState.controller = new AbortController();
  const signal = quizState.controller.signal;
  const isCurrent = () => convId === state.currentId;
  if (isCurrent()) renderTestSection(); // shows the "preparing" state

  const SAMPLING = {
    // Higher temp is safe here: format:json grammar-locks the structure, and
    // low temps make small models mode-collapse onto the same question.
    temperature: 0.8,
    // no frequency/repeat penalty: with grammar-locked JSON it pushes
    // small models into rambling inside string values until the token cap.
    maxTokens: 900, // capped batch output
    jsonMode: true, // grammar-locked JSON on Ollama — no broken arrays
  };
  const BATCH = 3; // questions per request — short outputs parse reliably

  // Serialize behind the summary job — one generation at a time.
  enqueueBg(async () => {
    try {
      const n = quizCount(convId, messages, explains);
      const content = summaryPromptInput(messages, explains);
      const all = [];
      const seenQ = new Set();
      let batch = 0;
      let emptyStreak = 0;

      // Generate in small batches until we have enough questions.
      while (all.length < n && batch < 14 && emptyStreak < 4) {
        if (signal.aborted) return;
        const want = Math.min(BATCH, n - all.length);
        batch++;
        const covered = all.map((q) => q.q.slice(0, 90));
        const focus = QUIZ_FOCUS[(batch - 1) % QUIZ_FOCUS.length];
        const txt = await bgRequest(
          [
            { role: 'system', content: QUIZ_SYS },
            {
              role: 'user',
              content:
                `${content}\n\nCreate exactly ${want} multiple-choice questions` +
                (batch > 1 ? ` (batch ${batch})` : ' for this learning session.') +
                (covered.length
                  ? `.\nDo NOT repeat or rephrase questions already created:\n- ${covered.join('\n- ')}`
                  : '') +
                `.\nThis batch's focus: ${focus}.` +
                ' Ask about a DIFFERENT fact than any question so far, ' +
                `and output a JSON array with all ${want} questions.`,
            },
          ],
          signal,
          SAMPLING
        );
        if (/^\s*⚠️/.test(String(txt))) {
          emptyStreak++;
          continue;
        }
        const qs = sanitizeQuiz(parseQuiz(txt));
        let added = 0;
        for (const q of qs) {
          if (all.length >= n) break;
          const key = q.q.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').slice(0, 80);
          if (!key || seenQ.has(key)) continue; // duplicate question across batches
          seenQ.add(key);
          all.push(q);
          added++;
        }
        emptyStreak = added ? 0 : emptyStreak + 1;
      }

      const status = summaryState.inflight === convId ? 'summarizing…' : '';
      if (all.length) {
        const entry = { fingerprint: fp, questions: all, at: Date.now() };
        quizCache[convId] = entry;
        fetch(`/api/conversations/${convId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quiz: entry }),
        }).catch(() => {});
        if (isCurrent()) renderSummary(summaryCache[convId], status);
      } else if (isCurrent()) {
        renderSummary(
          summaryCache[convId],
          signal.aborted ? status : 'test generation failed — press ↻'
        );
      }
    } catch (e) {
      if (isCurrent()) {
        renderSummary(
          summaryCache[convId],
          signal.aborted ? '' : 'test generation failed — press ↻'
        );
      }
    } finally {
      if (quizState.inflight === convId) {
        quizState.inflight = null;
        quizState.controller = null;
      }
      const queue = quizState.queue;
      quizState.queue = null;
      if (queue) runQuiz(queue.convId, queue.messages, queue.explains, queue.force);
      if (isCurrent()) renderTestSection(); // ready / not-ready CTA
    }
  });
}

/* ---------- Take a test: one question at a time, auto-advance ---------- */

function currentQuestions() {
  if (quizView && Array.isArray(quizView.questions)) return quizView.questions;
  const q = quizCache[state.currentId];
  return (q && q.questions) || [];
}

function startTest() {
  const q = quizCache[state.currentId];
  const qs = (q && q.questions) || [];
  if (!qs.length) return;
  quizView = {
    questions: qs, // snapshot — later background refreshes don't disturb the test
    i: 0,
    answers: new Array(qs.length).fill(null),
    done: false,
    saved: false,
    report: null,
  };
  summaryMode = 'quiz';
  renderQuiz();
}

function backToSummary() {
  summaryMode = 'summary';
  quizView = null;
  renderSummary(summaryCache[state.currentId], lastSummaryStatus);
}

function renderQuiz() {
  const qs = currentQuestions();
  if (!quizView || !qs.length) {
    backToSummary();
    return;
  }
  const i = Math.min(quizView.i, qs.length - 1);
  quizView.i = i;
  const q = qs[i];
  const picked = quizView.answers[i];
  testSection.innerHTML = `
    <div class="quiz-card">
      <div class="quiz-top">
        <span class="quiz-progress">Question ${i + 1} / ${qs.length}</span>
        <div class="quiz-bar"><div class="quiz-bar-fill" style="width:${Math.round(
          (100 * (i + 1)) / qs.length
        )}%"></div></div>
      </div>
      <div class="quiz-q">${renderInline(escapeHtml(q.q))}</div>
      <div class="quiz-options">
        ${q.options
          .map(
            (o, oi) => `
          <button type="button" class="quiz-opt${picked === oi ? ' picked' : ''}" data-opt="${oi}">
            <span class="opt-letter">${String.fromCharCode(65 + oi)}</span>
            <span class="opt-text">${renderInline(escapeHtml(String(o)))}</span>
          </button>`
          )
          .join('')}
      </div>
      <div class="quiz-nav">
        <button type="button" id="quiz-prev"${i === 0 ? ' disabled' : ''}>‹ Previous</button>
        <span class="quiz-hint">${
          picked === null ? 'Pick an answer — the test moves on by itself.' : ''
        }</span>
      </div>
    </div>`;
}

function persistTests() {
  fetch(`/api/conversations/${state.currentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tests: testsCache[state.currentId] || [] }),
  }).catch(() => {});
}

function finishTest() {
  const qs = currentQuestions();
  if (!quizView || !qs.length) {
    backToSummary();
    return;
  }
  const items = qs.map((q, idx) => ({
    q: q.q,
    options: q.options,
    answer: q.answer,
    why: q.why || '',
    picked: quizView.answers[idx],
  }));
  const score = items.filter((it) => it.picked === it.answer).length;
  const percent = items.length ? Math.round((100 * score) / items.length) : 0;
  const report = { score, total: items.length, percent, at: Date.now(), items };
  quizView.report = report;
  quizView.done = true;
  if (!quizView.saved) {
    quizView.saved = true;
    const list = testsCache[state.currentId] || (testsCache[state.currentId] = []);
    list.push(report);
    if (list.length > 10) list.splice(0, list.length - 10);
    persistTests();
  }
  summaryMode = 'results';
  renderResults();
}

function viewReport(idx) {
  const r = (testsCache[state.currentId] || [])[idx];
  if (!r) return;
  quizView = { questions: [], i: 0, answers: [], done: true, saved: true, report: r };
  summaryMode = 'results';
  renderResults();
}

function renderResults() {
  const r = quizView && quizView.report;
  if (!r) {
    backToSummary();
    return;
  }
  renderTestBadges();
  const grade =
    r.percent >= 90
      ? '🏆 Excellent!'
      : r.percent >= 70
        ? '👏 Good job!'
        : r.percent >= 50
          ? '📘 Decent — review the points, then try again.'
          : '🌱 Have another look at the summary, then try again.';
  testSection.innerHTML = `
    <div class="results-card">
      <div class="results-score">${r.score}/${r.total} <span class="results-pct">${r.percent}%</span></div>
      <div class="results-grade">${grade}</div>
      <ul class="results-list">
        ${(r.items || [])
          .map((it, idx) => {
            const ok = it.picked === it.answer;
            const opts = it.options || [];
            const pickedTxt =
              it.picked == null ? '—' : String(opts[it.picked] != null ? opts[it.picked] : '—');
            const correctTxt = String(opts[it.answer] != null ? opts[it.answer] : '—');
            const line = ok
              ? 'Your answer: ' + renderInline(escapeHtml(pickedTxt))
              : 'Your answer: <s>' +
                renderInline(escapeHtml(pickedTxt)) +
                '</s> · Correct: <b>' +
                renderInline(escapeHtml(correctTxt)) +
                '</b>';
            return `<li class="${ok ? 'ok' : 'bad'}">
              <div class="res-q"><span class="res-mark">${ok ? '✓' : '✗'}</span>${idx + 1}. ${renderInline(
                escapeHtml(String(it.q || ''))
              )}</div>
              <div class="res-line">${line}</div>
              ${it.why ? `<div class="res-why">${renderInline(escapeHtml(String(it.why)))}</div>` : ''}
            </li>`;
          })
          .join('')}
      </ul>
      <div class="quiz-nav">
        <button type="button" id="quiz-retake">↻ Retake</button>
        <button type="button" id="quiz-back">‹ Back to summary</button>
      </div>
    </div>`;
}

/* ---------- Delegated clicks inside the summary overlay ---------- */

summaryBody.addEventListener('click', (e) => {
  // Collapsible header: show/hide the points (and the test button).
  if (e.target.closest('#sum-collapse')) {
    summaryExpanded = !summaryExpanded;
    renderSummary(summaryCache[state.currentId], lastSummaryStatus);
    return;
  }
  if (e.target.closest('#take-test-btn')) {
    startTest();
    return;
  }

  // Pick an answer -> the test advances automatically (no Next button).
  const opt = e.target.closest('.quiz-opt');
  if (opt && summaryMode === 'quiz' && quizView) {
    const at = quizView.i;
    quizView.answers[at] = Number(opt.dataset.opt);
    renderQuiz(); // show the pick immediately
    setTimeout(() => {
      if (!quizView || summaryMode !== 'quiz' || quizView.i !== at) return;
      const qs = currentQuestions();
      if (quizView.i < qs.length - 1) {
        quizView.i += 1;
        renderQuiz();
      } else {
        finishTest();
      }
    }, 450);
    return;
  }

  if (e.target.closest('#quiz-prev')) {
    if (quizView && quizView.i > 0) {
      quizView.i -= 1;
      renderQuiz();
    }
    return;
  }
  if (e.target.closest('#quiz-retake')) {
    startTest();
    return;
  }
  if (e.target.closest('#quiz-back')) {
    backToSummary();
    return;
  }
});

/* Header badges: past test reports, newest first. */
testBadges.addEventListener('click', (e) => {
  const b = e.target.closest('.test-badge');
  if (b) viewReport(Number(b.dataset.i));
});

/* ================= Init ================= */

async function init() {
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
