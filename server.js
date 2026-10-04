const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
/*
 * OLLAMA_ENABLED — set to 0/false/off/no when this deployment has no local
 * Ollama (i.e. it is running on a remote host). Then:
 *   • Auto never probes localhost:11434 (nothing is listening there, so every
 *     probe would just burn a connection timeout),
 *   • "Local (Ollama)" disappears from the provider list, and
 *   • the default provider becomes Auto instead of the local endpoint, so a
 *     fresh install never points at a dead URL.
 * Unset — or any value other than 0/false/off/no/empty — keeps today's
 * behaviour: local Ollama is used first when present. OLLAMA_URL still applies
 * if you want to probe a *remote* Ollama; leave OLLAMA_ENABLED unset for that.
 */
const OLLAMA_ENABLED = !['0', 'false', 'off', 'no', ''].includes(
  String(process.env.OLLAMA_ENABLED == null ? '1' : process.env.OLLAMA_ENABLED).trim().toLowerCase()
);
const DATA_DIR = path.join(__dirname, 'data');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
const CONV_BAK = `${CONV_FILE}.bak`;
// Append-only record of removed conversations (see the DELETE route).
const CONV_DELETED = path.join(DATA_DIR, 'conversations.deleted.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const WS_FILE = path.join(DATA_DIR, 'workspaces.json'); // grouping for conversations
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads'); // per-conversation attachments
const TEXT_CAP = 200000; // chars of extracted text kept per file (system prompt)

// ---------- Provider settings (local Ollama or a cloud API) ----------
// Providers — mainstream APIs plus the free tiers from
// https://github.com/mnfst/awesome-free-llm-apis (no credit card anywhere).
// FREE + NO KEY (base URL only) come first, then local, then free-with-key,
// then mainstream paid APIs, then custom.
const PROVIDERS = {
  // ---- Auto: probe every reachable source and route to a working one ----
  auto:         { label: 'Auto (pick a working model)',       kind: 'auto',      needsKey: false, baseUrl: '' },
  // ---- Free, no API key at all (just the base URL) ----
  kilo:         { label: 'Kilo Code (free · no key)',         kind: 'openai',    needsKey: false, baseUrl: 'https://api.kilo.ai/api/gateway' },
  llm7:         { label: 'LLM7.io (free · no key)',           kind: 'openai',    needsKey: false, baseUrl: 'https://api.llm7.io/v1' },
  ovh:          { label: 'OVHcloud AI (free · anonymous)',    kind: 'openai',    needsKey: false, baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1' },
  // ---- Local ----
  ollama:       { label: 'Local (Ollama)',                    kind: 'ollama',    needsKey: false, baseUrl: OLLAMA_URL },
  // ---- Free tier with a free API key (no credit card) ----
  gemini:       { label: 'Google Gemini (free tier)',   kind: 'openai', needsKey: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  mistral:      { label: 'Mistral AI (free mode)',      kind: 'openai', needsKey: true, baseUrl: 'https://api.mistral.ai/v1' },
  zai:          { label: 'Z AI / GLM (free models)',    kind: 'openai', needsKey: true, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  nvidia:       { label: 'NVIDIA NIM (free)',           kind: 'openai', needsKey: true, baseUrl: 'https://integrate.api.nvidia.com/v1' },
  aionlabs:     { label: 'Aion Labs (free)',            kind: 'openai', needsKey: true, baseUrl: 'https://api.aionlabs.ai/v1' },
  hf:           { label: 'Hugging Face (router)',       kind: 'openai', needsKey: true, baseUrl: 'https://router.huggingface.co/v1' },
  ollamac:      { label: 'Ollama Cloud (free tier)',    kind: 'openai', needsKey: true, baseUrl: 'https://ollama.com/v1' },
  siliconflow:  { label: 'SiliconFlow (free models)',   kind: 'openai', needsKey: true, baseUrl: 'https://api.siliconflow.cn/v1' },
  modelscope:   { label: 'ModelScope (free)',           kind: 'openai', needsKey: true, baseUrl: 'https://api-inference.modelscope.cn/v1' },
  // Mainstream
  openai:       { label: 'OpenAI (ChatGPT)',           kind: 'openai',    needsKey: true,  baseUrl: 'https://api.openai.com/v1' },
  groq:         { label: 'Groq',                       kind: 'openai',    needsKey: true,  baseUrl: 'https://api.groq.com/openai/v1' },
  anthropic:    { label: 'Anthropic (Claude)',         kind: 'anthropic', needsKey: true,  baseUrl: 'https://api.anthropic.com' },
  deepseek:     { label: 'DeepSeek',                   kind: 'openai',    needsKey: true,  baseUrl: 'https://api.deepseek.com/v1' },
  openrouter:   { label: 'OpenRouter',                 kind: 'openai',    needsKey: true,  baseUrl: 'https://openrouter.ai/api/v1' },
  custom:       { label: 'Custom (OpenAI-compatible)', kind: 'openai',    needsKey: true,  baseUrl: '' },
};
const DEFAULT_SETTINGS = { provider: OLLAMA_ENABLED ? 'ollama' : 'auto', apiKey: '', baseUrl: '' };
// No Ollama on this host -> never offer it (and never probe it below).
if (!OLLAMA_ENABLED) delete PROVIDERS.ollama;
// Which provider an unusable/missing saved setting falls back to.
const FALLBACK_PROVIDER = OLLAMA_ENABLED ? 'ollama' : 'auto';

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...(s && typeof s === 'object' ? s : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2));
}

function providerConf() {
  const s = loadSettings();
  const p = PROVIDERS[s.provider] || PROVIDERS[FALLBACK_PROVIDER];
  const base = (String(s.baseUrl || '').trim() || p.baseUrl).replace(/\/$/, '');
  return { s, p, base };
}

function settingsView() {
  const s = loadSettings();
  return {
    provider: PROVIDERS[s.provider] ? s.provider : FALLBACK_PROVIDER,
    baseUrl: s.baseUrl || '',
    apiKeySet: !!s.apiKey,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      kind: p.kind,
      needsKey: p.needsKey,
      defaultBaseUrl: p.baseUrl,
    })),
  };
}

function friendlyUpstream(status, text, p) {
  const t = (text || '').slice(0, 300);
  if (status === 401 || status === 403) {
    if (p.needsKey === false) {
      return `${p.label} refused the request (HTTP ${status}) — free endpoints only serve their free models; pick one of the free models in ⚙ Settings.`;
    }
    return `${p.label} rejected the API key (HTTP ${status}) — check the key in ⚙ Settings.`;
  }
  if (status === 404) {
    return `${p.label}: endpoint not found (404) — check the Base URL in ⚙ Settings.${t ? ` ${t}` : ''}`;
  }
  if (status === 429) return `${p.label} rate limited the request (429) — wait a moment and retry.`;
  if (status === 400) return `${p.label} rejected the request (400): ${t || 'bad request'}`;
  return `${p.label} returned HTTP ${status}${t ? `: ${t}` : ''}`;
}

async function upstreamFail(r, p) {
  const text = await r.text().catch(() => '');
  const e = new Error(friendlyUpstream(r.status, text, p));
  e.httpStatus = r.status;
  // Client errors won't succeed on retry (except rate limits).
  if (r.status >= 400 && r.status < 500 && r.status !== 429) e.fatal = true;
  return e;
}

function friendlyNet(e) {
  const m = e && e.message ? e.message : String(e);
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return 'Timed out reaching the provider.';
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|NetworkError|certificate|ETIMEDOUT/i.test(m)) {
    return `Cannot reach the provider: ${m}`;
  }
  return m;
}

// Timeouts (ms): first byte allows the 2.5 GB model to load; idle = max gap between tokens.
const FIRST_BYTE_MS = Number(process.env.FIRST_BYTE_MS) || 120000;
const IDLE_MS = Number(process.env.IDLE_MS) || 45000;

app.use(express.json({ limit: '16mb' })); // room for uploaded files (base64)
// index:false so "/" can be the marketing landing page instead of the app.
/*
 * Dev-only cache policy. `max-age=0` + ETag is spec-correct, but a module
 * script the browser reuses from cache pins stale bytes for the lifetime of
 * the document — we spent a debugging round proving a gate was "broken" when
 * the code was right and the module map was old. The browser cannot tell the
 * difference, so don't let it cache: this server is local dev, and production
 * is static hosting (GitHub Pages), which sets its own headers.
 */
app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders(res, filePath) {
    if (/\.(m?js|css|html?)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store');
  },
}));
/*
 * The canvas gesture layer (@use-gesture) is imported by js/graph.js as a bare
 * specifier. There is no bundler, so index.html's import map points at these
 * URLs and this route resolves them straight out of node_modules — nothing is
 * vendored or checked in, `npm install` is enough.
 */
app.use('/lib/use-gesture',
  express.static(path.join(__dirname, 'node_modules', '@use-gesture'), { index: false }));

/* Route map (auth gates arrive in P2 and wrap /app):
 *   /      -> public landing page
 *   /app   -> the application itself
 * Every asset URL inside index.html is absolute, so serving it from /app
 * resolves exactly as it did from /.
 */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/app/', (req, res) => res.redirect(302, '/app'));
/*
 * The standalone workspace picker. Same document as /app — main.js branches on
 * the path and boots the picker instead of the app — so the icon sprite, theme
 * tokens and theme switch are shared rather than duplicated.
 */
app.get('/workspaces', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/workspaces/', (req, res) => res.redirect(302, '/workspaces'));

/* Login / signup: one document, two routes — the page reads location.pathname
 * to decide which copy to show, so they can never drift apart. */
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'auth.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONV_FILE)) fs.writeFileSync(CONV_FILE, '[]');
migrateWorkspaces(); // runs before the first request: nothing lands outside a workspace

function loadConversations() {
  try {
    return JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveConversations(list) {
  /* Snapshot the outgoing state first. conversations.json is the ONLY copy of
   * every conversation, so a bad write would otherwise be unrecoverable.
   * Best-effort: a failed backup must never block a save. */
  try {
    if (fs.existsSync(CONV_FILE)) fs.copyFileSync(CONV_FILE, CONV_BAK);
  } catch { /* backup is best-effort */ }
  fs.writeFileSync(CONV_FILE, JSON.stringify(list, null, 2));
}

// ---------- Workspaces ----------
// A workspace is a named bucket of conversations — the unit the graph view
// zooms out to. Plain JSON next to the conversations, same no-dependency rule.

function loadWorkspaces() {
  try {
    const list = JSON.parse(fs.readFileSync(WS_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveWorkspaces(list) {
  fs.writeFileSync(WS_FILE, JSON.stringify(list, null, 2));
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* Boot migration: every conversation belongs to exactly one workspace and
 * there is always at least one workspace to belong to. Data written before
 * workspaces existed is adopted by the first workspace, created here if the
 * file is new — so nothing is ever orphaned or lost on upgrade. */
function migrateWorkspaces() {
  let ws = loadWorkspaces();
  const convs = loadConversations();
  let touchedFile = false;

  if (!ws.length) {
    ws = [{ id: newId(), name: 'My workspace', createdAt: Date.now(), updatedAt: Date.now() }];
    touchedFile = true;
  }

  const known = new Set(ws.map((w) => w.id));
  const home = ws[0].id;
  let adopted = 0;
  for (const c of convs) {
    if (!c.workspaceId || !known.has(c.workspaceId)) {
      c.workspaceId = home;
      adopted++;
    }
  }
  if (adopted) saveConversations(convs);
  if (touchedFile) saveWorkspaces(ws);
  if (adopted || touchedFile) {
    console.log(`🗂  Workspaces ready — ${ws.length} workspace(s), ${adopted} conversation(s) adopted.`);
  }
  return ws;
}

/* Workspace a new/moved conversation lands in when the client doesn't say. */
function defaultWorkspaceId() {
  const ws = loadWorkspaces();
  return ws.length ? ws[0].id : null;
}

/* Returns null when the id is fine, or an Error to send as a 400. */
function badWorkspace(id) {
  if (loadWorkspaces().some((w) => w.id === id)) return null;
  const e = new Error('Unknown workspace');
  e.status = 400;
  return e;
}

// ---------- Conversation CRUD ----------

app.get('/api/conversations', (req, res) => {
  const wsId = String(req.query.workspace || '').trim();
  const list = loadConversations()
    .filter((c) => !wsId || c.workspaceId === wsId)
    .map(({ id, title, updatedAt, workspaceId }) => ({ id, title, updatedAt, workspaceId }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(list);
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = loadConversations().find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(conv);
});

app.post('/api/conversations', (req, res) => {
  const list = loadConversations();
  let wsId = defaultWorkspaceId();
  if (req.body.workspaceId) {
    const bad = badWorkspace(String(req.body.workspaceId));
    if (bad) return res.status(bad.status || 400).json({ error: bad.message });
    wsId = req.body.workspaceId;
  }
  const conv = {
    id: newId(),
    title: req.body.title || 'New conversation',
    workspaceId: wsId,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.push(conv);
  saveConversations(list);
  res.json(conv);
});

app.put('/api/conversations/:id', (req, res) => {
  const list = loadConversations();
  const conv = list.find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  // Move between workspaces (the zoomed-out canvas can do this too).
  if ('workspaceId' in req.body && req.body.workspaceId) {
    const bad = badWorkspace(String(req.body.workspaceId));
    if (bad) return res.status(bad.status || 400).json({ error: bad.message });
    conv.workspaceId = req.body.workspaceId;
  }
  // Partial updates: only overwrite the fields the client sends.
  if ('messages' in req.body) {
    conv.messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  }
  // Snapshot of explainer containers (tree of split panes).
  if ('explains' in req.body) conv.explains = req.body.explains || null;
  // Topics summary (generated in the background).
  if ('summary' in req.body) conv.summary = req.body.summary || null;
  // Quiz (background-generated MCQs) and finished test reports.
  if ('quiz' in req.body) conv.quiz = req.body.quiz || null;
  if ('tests' in req.body) conv.tests = Array.isArray(req.body.tests) ? req.body.tests : [];
  // Personal notes — kept OUTSIDE summary/quiz so AI regeneration never
  // overwrites what the user saved.
  if ('notes' in req.body) conv.notes = Array.isArray(req.body.notes) ? req.body.notes : [];
  if ('messages' in req.body || 'explains' in req.body) conv.updatedAt = Date.now();
  const firstUser = conv.messages.find((m) => m.role === 'user');
  if (firstUser && (!conv.title || conv.title === 'New conversation')) {
    conv.title = firstUser.content.slice(0, 40);
  }
  saveConversations(list);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  const list = loadConversations();
  const gone = list.find((c) => c.id === req.params.id);
  saveConversations(list.filter((c) => c.id !== req.params.id));

  /* Remove = permanent by design, but never silent. Archive the whole
   * conversation (append-only) and log it, so a removal is both visible in the
   * server log and restorable later via POST /api/deleted/:id/restore.
   * Without this a delete left no trace anywhere — the file was simply
   * rewritten smaller. */
  if (gone) {
    try {
      const prior = JSON.parse(fs.readFileSync(CONV_DELETED, 'utf8'));
      fs.writeFileSync(
        CONV_DELETED,
        JSON.stringify([...prior, { ...gone, deletedAt: Date.now() }], null, 2)
      );
    } catch {
      fs.writeFileSync(CONV_DELETED, JSON.stringify([{ ...gone, deletedAt: Date.now() }], null, 2));
    }
    console.log(
      `🗑  Deleted conversation ${gone.id} "${gone.title}" ` +
        `(${list.length} -> ${list.length - 1}) — archived in ${path.basename(CONV_DELETED)}`
    );
  }

  // Drop the conversation's uploaded files as well.
  try {
    fs.rmSync(path.join(UPLOAD_DIR, req.params.id), { recursive: true, force: true });
  } catch { /* nothing stored */ }
  res.json({ ok: true });
});

/* Put an archived conversation back. */
app.post('/api/deleted/:id/restore', (req, res) => {
  let archived;
  try {
    archived = JSON.parse(fs.readFileSync(CONV_DELETED, 'utf8'));
  } catch {
    return res.status(404).json({ error: 'No archived conversations.' });
  }
  const i = archived.findIndex((c) => c.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not archived.' });
  const conv = archived[i];
  const list = loadConversations();
  if (!list.some((c) => c.id === conv.id)) list.push(conv);
  saveConversations(list);
  archived.splice(i, 1);
  fs.writeFileSync(CONV_DELETED, JSON.stringify(archived, null, 2));
  const { deletedAt, ...restored } = conv; // eslint-disable-line no-unused-vars
  console.log(`♻️  Restored conversation ${restored.id} "${restored.title}"`);
  res.json({ ok: true, conv: restored });
});

/* ================= File uploads: extraction + storage ================= */

const TEXT_EXTS = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.html', '.htm', '.log', '.xml', '.yml', '.yaml'];

/* Returns extracted plain text (string or Promise). Word/PDF need the
 * installed parsers; plain formats are just decoded. */
function extractText(buf, name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (TEXT_EXTS.includes(ext)) {
    return buf.toString('utf8').replace(/^\uFEFF/, '');
  }
  if (ext === '.pdf') {
    // pdf-parse v2 API: class-based (v1's pdf(buffer) no longer exists)
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buf });
    return parser.getText().then((r) => String((r && r.text) || ''));
  }
  if (ext === '.docx') {
    return require('mammoth')
      .extractRawText({ buffer: buf })
      .then((r) => String((r && r.value) || ''));
  }
  if (ext === '.doc') {
    throw new Error('Old .doc files are not supported — open it and “Save as” .docx or PDF.');
  }
  throw new Error('Unsupported type — use Word (.docx), PDF, or a text file.');
}

function newFileId() {
  return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/* Upload: base64 file (JSON) or a plain link. Stores the original under
 * data/uploads/<convId>/ plus the extracted text next to it. */
app.post('/api/conversations/:id/files', async (req, res) => {
  const list = loadConversations();
  const conv = list.find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  try {
    let entry;
    if (body.link) {
      const url = String(body.link).trim();
      if (!/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'Links must start with http:// or https://' });
      }
      entry = {
        id: newFileId(),
        name: url.replace(/^https?:\/\//i, '').slice(0, 120),
        link: url,
        type: 'link',
        size: 0,
        chars: 0,
        at: Date.now(),
      };
    } else if (body.data && body.name) {
      const raw = Buffer.from(String(body.data), 'base64');
      if (!raw.length) return res.status(400).json({ error: 'Empty file' });
      if (raw.length > 12 * 1024 * 1024) {
        return res.status(400).json({ error: 'File too large (max 12 MB)' });
      }
      const text = String(await Promise.resolve(extractText(raw, body.name)))
        .replace(/\u0000/g, '')
        .slice(0, TEXT_CAP);
      const id = newFileId();
      const safe = path.basename(String(body.name)).slice(0, 80) || 'file';
      const fname = `${id}-${safe}`;
      const dir = path.join(UPLOAD_DIR, conv.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fname), raw);
      fs.writeFileSync(`${path.join(dir, fname)}.txt`, text, 'utf8');
      entry = {
        id,
        name: safe,
        file: fname, // on-disk original (text sits at <file>.txt)
        type: path.extname(safe).toLowerCase().replace('.', '') || 'file',
        size: raw.length,
        chars: text.length,
        at: Date.now(),
      };
    } else {
      return res.status(400).json({ error: 'Nothing uploaded' });
    }
    conv.files = Array.isArray(conv.files) ? conv.files : [];
    conv.files.push(entry);
    conv.updatedAt = Date.now();
    saveConversations(list);
    res.json({ file: entry });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Upload failed' });
  }
});

/* Extracted text — fetched by the client and injected into this
 * conversation's system prompt when chatting. */
app.get('/api/conversations/:id/files/:fid/text', (req, res) => {
  const conv = loadConversations().find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const f = (conv.files || []).find((x) => x.id === req.params.fid);
  if (!f) return res.status(404).json({ error: 'Not found' });
  if (f.link) return res.json({ text: `Link reference: ${f.link}` });
  try {
    const txt = fs.readFileSync(`${path.join(UPLOAD_DIR, conv.id, f.file)}.txt`, 'utf8');
    res.json({ text: txt });
  } catch {
    res.json({ text: '' });
  }
});

/* Remove a chip: metadata + both files on disk. */
app.delete('/api/conversations/:id/files/:fid', (req, res) => {
  const list = loadConversations();
  const conv = list.find((c) => c.id === req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  const f = (conv.files || []).find((x) => x.id === req.params.fid);
  if (!f) return res.status(404).json({ error: 'Not found' });
  conv.files = conv.files.filter((x) => x.id !== f.id);
  conv.updatedAt = Date.now();
  saveConversations(list);
  if (f.file) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, conv.id, f.file)); } catch { /* already gone */ }
    try { fs.unlinkSync(`${path.join(UPLOAD_DIR, conv.id, f.file)}.txt`); } catch { /* already gone */ }
  }
  res.json({ ok: true });
});

/* Library: every file across every conversation (newest first). */
app.get('/api/files', (req, res) => {
  const wsId = String(req.query.workspace || '').trim();
  const out = [];
  for (const c of loadConversations()) {
    if (wsId && c.workspaceId !== wsId) continue;
    for (const f of c.files || []) {
      out.push({ ...f, convId: c.id, convTitle: c.title });
    }
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  res.json(out);
});

// ---------- Workspace CRUD ----------

app.get('/api/workspaces', (req, res) => {
  const counts = new Map();
  for (const c of loadConversations()) {
    counts.set(c.workspaceId, (counts.get(c.workspaceId) || 0) + 1);
  }
  res.json(
    loadWorkspaces().map((w) => ({
      ...w,
      conversationCount: counts.get(w.id) || 0, // drives the zoomed-out cards
    }))
  );
});

app.post('/api/workspaces', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: 'A workspace needs a name.' });
  const list = loadWorkspaces();
  const ws = { id: newId(), name, createdAt: Date.now(), updatedAt: Date.now() };
  list.push(ws);
  saveWorkspaces(list);
  res.json({ ...ws, conversationCount: 0 });
});

app.put('/api/workspaces/:id', (req, res) => {
  const list = loadWorkspaces();
  const ws = list.find((w) => w.id === req.params.id);
  if (!ws) return res.status(404).json({ error: 'Not found' });
  if (typeof req.body.name === 'string') {
    const name = req.body.name.trim().slice(0, 60);
    if (name) {
      ws.name = name;
      ws.updatedAt = Date.now();
    }
  }
  saveWorkspaces(list);
  const count = loadConversations().filter((c) => c.workspaceId === ws.id).length;
  res.json({ ...ws, conversationCount: count });
});

/* Deleting a workspace that still holds conversations would silently take the
 * work with it, so that case is a 409 unless ?force=1 — and even then the
 * conversations are archived to conversations.deleted.json, never vanished. */
app.delete('/api/workspaces/:id', (req, res) => {
  const list = loadWorkspaces();
  const i = list.findIndex((w) => w.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  if (list.length === 1) return res.status(409).json({ error: 'The last workspace cannot be deleted.' });

  const convs = loadConversations();
  const inside = convs.filter((c) => c.workspaceId === req.params.id);
  const force = String(req.query.force || '') === '1';
  if (inside.length && !force) {
    return res.status(409).json({
      error: `This workspace still holds ${inside.length} conversation${inside.length === 1 ? '' : 's'}.`,
      count: inside.length,
    });
  }

  if (inside.length) {
    const stamped = inside.map((c) => ({ ...c, deletedAt: Date.now() }));
    try {
      const prior = JSON.parse(fs.readFileSync(CONV_DELETED, 'utf8'));
      fs.writeFileSync(CONV_DELETED, JSON.stringify([...prior, ...stamped], null, 2));
    } catch {
      fs.writeFileSync(CONV_DELETED, JSON.stringify(stamped, null, 2));
    }
    for (const c of inside) {
      try {
        fs.rmSync(path.join(UPLOAD_DIR, c.id), { recursive: true, force: true });
      } catch { /* nothing stored */ }
    }
    saveConversations(convs.filter((c) => c.workspaceId !== req.params.id));
    console.log(`🗂  Deleted workspace "${list[i].name}" with ${inside.length} conversation(s) (archived).`);
  }

  list.splice(i, 1);
  saveWorkspaces(list);
  res.json({ ok: true });
});

// ---------- Settings (provider + API key) ----------

app.get('/api/settings', (req, res) => {
  res.json(settingsView());
});

/* Merge a settings patch onto the stored settings (does not save). */
function applySettingsPatch(b) {
  const s = loadSettings();
  if (b.provider !== undefined) {
    if (!PROVIDERS[b.provider]) {
      const e = new Error(`Unknown provider: ${String(b.provider).slice(0, 50)}`);
      e.status = 400;
      throw e;
    }
    if (b.provider !== s.provider) s.baseUrl = ''; // don't leak the old base URL
    s.provider = b.provider;
  }
  if (typeof b.baseUrl === 'string') s.baseUrl = b.baseUrl.trim().slice(0, 300);
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) s.apiKey = b.apiKey.trim().slice(0, 500);
  if (b.clearKey) s.apiKey = '';
  // Remember keys per provider so Auto routing can reuse any saved keys.
  const cur = PROVIDERS[s.provider];
  if (s.apiKey && cur && cur.needsKey) s.keys = { ...(s.keys || {}), [s.provider]: s.apiKey };
  return s;
}

app.put('/api/settings', (req, res) => {
  try {
    saveSettings(applySettingsPatch(req.body || {}));
    res.json(settingsView());
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* Connect = validate first (list the provider's models), save only on
 * success — a bad key/URL can never replace working settings. */
app.post('/api/settings/connect', async (req, res) => {
  try {
    const s = applySettingsPatch(req.body || {});
    const p = PROVIDERS[s.provider] || PROVIDERS[FALLBACK_PROVIDER];
    const base = (String(s.baseUrl || '').trim() || p.baseUrl).replace(/\/$/, '');
    if (p.needsKey && !s.apiKey) {
      return res.status(400).json({ error: `Enter the ${p.label} API key.` });
    }
    let models;
    let autoSources;
    if (p.kind === 'auto') {
      // Connect = fresh probe of every reachable source.
      const routes = await buildAutoRoutes();
      autoProbe = { at: Date.now(), routes };
      if (!routes.length) {
        return res.status(502).json({
          error: OLLAMA_ENABLED
            ? 'Auto found no responding sources — is Ollama running and the network up?'
            : 'Auto found no responding sources — check the network, or add an API key in ⚙ Settings.',
        });
      }
      models = [{ name: 'auto' }];
      autoSources = routes.map((r) => ({
        id: r.id,
        label: r.p.label,
        models: r.models.length,
        model: pickAutoModel(r),
      }));
    } else {
      models = await listModels(s, p, base);
    }
    saveSettings(s);
    res.json({ ...settingsView(), models, ...(autoSources ? { autoSources } : {}) });
  } catch (e) {
    res.status(e.status || 502).json({ error: friendlyNet(e) });
  }
});

// ---------- Model list (routes to the configured provider) ----------
// listModelsFull keeps provider metadata (context_length / isFree / …) so
// Auto routing and the footer's context info can use live numbers.

async function listModelsFull(s, p, base, timeoutMs) {
  const to = AbortSignal.timeout(timeoutMs || 20000);
  if (p.kind === 'auto') return [];
  if (p.kind === 'ollama') {
    const r = await fetch(`${base}/api/tags`, { signal: to });
    if (!r.ok) throw await upstreamFail(r, p);
    const d = await r.json();
    return (d.models || []).map((m) => ({ id: m.name, name: m.name }));
  }
  if (p.kind === 'anthropic') {
    const r = await fetch(`${base}/v1/models`, {
      headers: { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' },
      signal: to,
    });
    if (!r.ok) throw await upstreamFail(r, p);
    const d = await r.json();
    return (d.data || []).map((m) => ({ id: m.id, name: m.id }));
  }
  const r = await fetch(`${base}/models`, {
    headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
    signal: to,
  });
  if (!r.ok) throw await upstreamFail(r, p);
  const d = await r.json();
  return d.data || [];
}

async function listModels(s, p, base) {
  const full = await listModelsFull(s, p, base);
  return full.map((m) => ({ name: m.id || m.name || String(m) }));
}

app.get('/api/models', async (req, res) => {
  try {
    const { s, p, base } = providerConf();
    if (p.kind === 'auto') {
      return res.json({ models: [{ name: 'auto' }], provider: 'auto' });
    }
    if (p.needsKey && !s.apiKey) {
      return res
        .status(400)
        .json({ error: `No API key saved for ${p.label} — open ⚙ Settings and Connect.` });
    }
    res.json({ models: await listModels(s, p, base), provider: s.provider });
  } catch (e) {
    res.status(e.status || 502).json({ error: friendlyNet(e) });
  }
});

// ---------- Auto mode + model context/limits info -------------------------
//
// Auto is a pseudo-provider: chat probes (cached) which known sources are
// reachable and tries them in order until one streams a reply — local
// Ollama first, then the free no-key gateways, then any provider whose
// saved key we have.

const AUTO_ORDER = [
  // No Ollama on this host -> skip it entirely: buildAutoRoutes would only
  // burn a connection timeout probing localhost:11434 on every Auto call.
  ...(OLLAMA_ENABLED ? ['ollama'] : []),
  'kilo', 'llm7', 'ovh',
  'gemini', 'mistral', 'zai', 'nvidia', 'aionlabs', 'hf', 'ollamac', 'siliconflow', 'modelscope',
  'openai', 'groq', 'anthropic', 'deepseek', 'openrouter',
];

// Preferred model per source (first match wins; then a free-looking one;
// then the first non-embedding/audio entry).
const AUTO_MODEL_PREF = {
  ollama:       [/^phi4-mini-fast/i, /^phi4-mini/i],
  kilo:         [/^kilo-auto\/free$/i, /^kilo-auto\//i],
  llm7:         [/^mistral-Nemo-Instruct-2407$/i, /^Mistral/i],
  ovh:          [/^Mistral-Small-3\.2/i, /^Meta-Llama-3_3-70B/i, /^gpt-oss-120b$/i],
  gemini:       [/^gemini-2\.0-flash/i, /flash/i],
  mistral:      [/^mistral-small/i, /mistral/i],
  zai:          [/^glm-4\.?flash/i, /glm/i],
  nvidia:       [/llama/i],
  hf:           [/llama/i],
  ollamac:      [/llama/i],
  siliconflow:  [/qwen/i],
  modelscope:   [/qwen/i],
  openai:       [/^gpt-4o-mini/i, /^gpt-4o/i],
  groq:         [/^llama-3\.3-70b/i, /^llama-3\.1-8b/i],
  anthropic:    [/^claude-3-5-haiku/i, /claude/i],
  deepseek:     [/^deepseek-chat/i, /deepseek/i],
  openrouter:   [/free/i, /llama/i],
};

const AUTO_FIRST_BYTE_MS = Number(process.env.AUTO_FIRST_BYTE_MS) || 35000;

// Usage-limit notes for the sidebar footer (informational; live context
// windows from provider /models and Ollama /api/show win over the table).
const PROVIDER_LIMITS = {
  kilo: 'free · no key · fair-use limits',
  llm7: 'free · no key · rate-limited',
  ovh: 'free · anonymous · fair-use limits',
  ollama: 'local · no rate limits',
  gemini: 'free tier · rate-limited',
  mistral: 'free mode · rate-limited',
  zai: 'free models · rate-limited',
  nvidia: 'free tier · rate-limited',
  aionlabs: 'free · rate-limited',
  hf: 'free router tier · rate-limited',
  ollamac: 'free tier · rate-limited',
  siliconflow: 'free models · rate-limited',
  modelscope: 'free inference · rate-limited',
  openai: 'paid · usage billed',
  groq: 'free tier · rate-limited',
  anthropic: 'paid · usage billed',
  deepseek: 'paid · usage billed',
  openrouter: 'paid · credits',
  custom: '',
};

// Static fallback context windows (used only when the provider publishes none).
const MODEL_CTX = [
  [/phi4|phi-?4/i, '128K'],
  [/claude/i, '200K'],
  [/gemini/i, '1M'],
  [/^gpt-4\.1/i, '1M'],
  [/(gpt-4o|o[0-9]-mini)/i, '128K'],
  [/deepseek/i, '128K'],
  [/llama-3/i, '128K'],
  [/mistral-nemo/i, '128K'],
  [/mistral/i, '32K'],
  [/qwen/i, '32K–256K'],
];

function ctxFmt(n) {
  if (!n) return '';
  // 131072/65536 are binary "128K/64K"; 256000/1000000 are decimal.
  const k = n % 1000 === 0 ? n / 1000 : n % 1024 === 0 ? n / 1024 : Math.round(n / 1000);
  if (k >= 1000) return `${Math.round(k / 100) / 10}M`;
  return `${k}K`;
}

// Context window from provider /models metadata (Kilo/OVH: context_length,
// LLM7: context_window.tokens, gateways: top_provider.context_length).
function ctxFromMeta(m) {
  if (!m || typeof m !== 'object') return 0;
  const n =
    +m.context_length ||
    +(m.top_provider && m.top_provider.context_length) ||
    +(m.context_window && m.context_window.tokens) ||
    0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Ollama /api/show -> model_info key like "phi3.context_length".
const ollamaCtxCache = new Map(); // model -> {n, at}
async function ollamaContext(model, base) {
  if (!OLLAMA_ENABLED) return 0; // no local Ollama on this host
  if (!model) return 0;
  const hit = ollamaCtxCache.get(model);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.n;
  let n = 0;
  try {
    const r = await fetch(`${base || OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (r.ok) {
      const d = await r.json();
      const info = d.model_info || {};
      const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
      if (key) n = +info[key] || 0;
    }
  } catch { /* offline — fall back to the static table */ }
  ollamaCtxCache.set(model, { n, at: Date.now() });
  return n;
}

// Free gateways publish full model metadata (context windows included).
const LIVE_CTX_PROVIDERS = new Set(['kilo', 'llm7', 'ovh']);
const providerModelsCache = new Map(); // id -> {at, models}
async function liveProviderModels(id) {
  const hit = providerModelsCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.models;
  const s = loadSettings();
  const p = PROVIDERS[id];
  const apiKey = (s.keys && s.keys[id]) || (s.provider === id ? s.apiKey : '');
  let models = [];
  try {
    models = await listModelsFull({ ...s, apiKey }, p, p.baseUrl, 8000);
  } catch { /* offline — static table */ }
  providerModelsCache.set(id, { at: Date.now(), models });
  return models;
}

// Footer info for one provider+model: live context where available,
// static table otherwise, plus the provider's limits note.
async function modelInfoFor(providerId, model, opts = {}) {
  const p = PROVIDERS[providerId] || PROVIDERS[FALLBACK_PROVIDER];
  const base = opts.base || p.baseUrl || OLLAMA_URL;
  const limits = PROVIDER_LIMITS[providerId] || '';
  let context = '';
  let live = false;

  if (opts.models && model) {
    const n = ctxFromMeta(opts.models.find((m) => (m.id || m.name) === model));
    if (n) { context = ctxFmt(n); live = true; }
  }
  if (!context && providerId === 'ollama' && model) {
    const n = await ollamaContext(model, base);
    if (n) { context = ctxFmt(n); live = true; }
  }
  if (!context && LIVE_CTX_PROVIDERS.has(providerId) && model) {
    const models = await liveProviderModels(providerId);
    const n = ctxFromMeta(models.find((m) => m.id === model));
    if (n) { context = ctxFmt(n); live = true; }
  }
  if (!context) {
    for (const [re, val] of MODEL_CTX) {
      if (re.test(model || '')) { context = val; break; }
    }
  }
  if (!context) context = 'varies';

  const text = `Context ${context}${limits ? ` · ${limits}` : ''}`;
  const title =
    `Model: ${model || '—'}\nContext window: ${context}${live ? ' (live from provider)' : ''}` +
    (limits ? `\nLimits: ${limits}` : '');
  return { context, limits, text, title };
}

// ---- probing & routing ----

let autoProbe = null; // {at, routes}
let autoWinner = null; // {id, model, at} — last source that streamed a reply

async function buildAutoRoutes() {
  const s = loadSettings();
  const routes = await Promise.all(
    AUTO_ORDER.map(async (id) => {
      const p = PROVIDERS[id];
      if (!p || p.kind === 'auto' || !p.baseUrl) return null;
      const apiKey = (s.keys && s.keys[id]) || (s.provider === id ? s.apiKey : '');
      if (p.needsKey && !apiKey) return null; // only sources we could actually call
      try {
        const models = await listModelsFull({ ...s, apiKey }, p, p.baseUrl, 8000);
        if (!models.length) return null;
        const route = {
          id,
          p,
          base: p.baseUrl,
          apiKey,
          models,
          // Local cold-loads can be slow; cloud sources get a shorter budget.
          firstByteMs: id === 'ollama' ? FIRST_BYTE_MS : AUTO_FIRST_BYTE_MS,
        };
        route.model = pickAutoModel(route);
        return route;
      } catch {
        return null; // unreachable / refused — skip this source
      }
    })
  );
  return routes.filter(Boolean);
}

function orderRoutes(routes) {
  if (!autoWinner || Date.now() - autoWinner.at > 30 * 60 * 1000) return routes;
  const i = routes.findIndex((r) => r.id === autoWinner.id);
  if (i > 0) {
    const [w] = routes.splice(i, 1);
    routes.unshift(w);
  }
  return routes;
}

function pickAutoModel(route) {
  for (const re of AUTO_MODEL_PREF[route.id] || []) {
    const m = route.models.find((x) => re.test(x.id || x.name || ''));
    if (m) return m.id || m.name;
  }
  const free = route.models.find((m) => m.isFree === true || /(^|\/|:)free$/i.test(m.id || ''));
  if (free) return free.id || free.name;
  const chat = route.models.find(
    (m) => !/embed|whisper|-tts-|sdxl|stable-diffusion|guard|rerank/i.test(m.id || m.name || '')
  );
  const pick = chat || route.models[0];
  return pick.id || pick.name;
}

async function autoRoutes() {
  if (autoProbe && Date.now() - autoProbe.at < 5 * 60 * 1000) {
    return orderRoutes(autoProbe.routes.slice());
  }
  const routes = await buildAutoRoutes();
  autoProbe = { at: Date.now(), routes };
  return orderRoutes(routes.slice());
}

// Combined context/limits across everything Auto can reach.
async function autoInfo() {
  let routes = [];
  try { routes = await autoRoutes(); } catch { /* offline */ }
  const per = [];
  const ctxs = [];
  for (const r of routes) {
    const model = pickAutoModel(r);
    let n = 0;
    const m = r.models.find((x) => (x.id || x.name) === model);
    if (m) n = ctxFromMeta(m);
    if (!n && r.id === 'ollama') n = await ollamaContext(model, r.base).catch(() => 0);
    if (n) ctxs.push(n);
    per.push({
      label: r.p.label,
      model,
      context: n ? ctxFmt(n) : 'varies',
      limits: PROVIDER_LIMITS[r.id] || '',
    });
  }
  const range = ctxs.length ? `${ctxFmt(Math.min(...ctxs))}–${ctxFmt(Math.max(...ctxs))}` : 'varies';
  const hasLocal = routes.some((r) => r.id === 'ollama');
  const limits = hasLocal
    ? 'local: no limits · free tiers: rate-limited'
    : 'free tiers: rate-limited';
  const text = routes.length
    ? `Auto: ${routes.length} source${routes.length === 1 ? '' : 's'} · ctx ${range} · ${limits}`
    : 'Auto: press Connect in ⚙ Settings to probe sources';
  const title = routes.length
    ? 'Auto tries these sources in order:\n' +
      per
        .map((x) => `• ${x.label} — ${x.model} · ctx ${x.context}${x.limits ? ` · ${x.limits}` : ''}`)
        .join('\n')
    : 'No sources probed yet.';
  return { context: range, limits, text, title, sources: per };
}

// Sidebar footer asks for the current context window + limits.
app.get('/api/model-info', async (req, res) => {
  try {
    const provider = String(req.query.provider || '').trim() || loadSettings().provider;
    const model = String(req.query.model || '').trim();
    if (!PROVIDERS[provider]) return res.status(400).json({ error: 'Unknown provider' });
    if (provider === 'auto') return res.json(await autoInfo());
    const conf = providerConf();
    const base = conf.s.provider === provider ? conf.base : PROVIDERS[provider].baseUrl;
    res.json(await modelInfoFor(provider, model, { base }));
  } catch (e) {
    res.status(500).json({ error: friendlyNet(e) });
  }
});

// ---------- Chat stream (SSE proxy to the configured provider) ----------
//
// Robustness rules:
// 1. Client disconnects -> immediately abort the upstream fetch, so no
//    zombie generations pile up and wedge the model.
// 2. No first byte within FIRST_BYTE_MS, or a token gap longer than IDLE_MS
//    -> abort and report a clear timeout error.
// 3. The provider fails before any content was streamed -> retry once.
// The response contract stays `data: {delta|"error"|"done"}` for the client.

app.post('/api/chat', async (req, res) => {
  const { model, messages } = req.body || {};
  // Optional generation tuning (background jobs send low temperature +
  // anti-repeat to keep small models from looping).
  const temperature =
    req.body && Number.isFinite(+req.body.temperature) ? +req.body.temperature : null;
  const frequency = req.body && Number.isFinite(+req.body.frequency) ? +req.body.frequency : 0;
  const maxTokens = req.body && Number.isFinite(+req.body.maxTokens) ? +req.body.maxTokens : 0;
  const jsonMode = !!(req.body && req.body.jsonMode); // grammar-locked JSON (Ollama)
  if (!model || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'model and messages are required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  const send = (obj) => {
    if (!clientGone && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    }
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let anyContent = false;
  let timedOut = false;

  async function runOnce(route) {
    const ctl = new AbortController();
    let timer = null;
    const p = route.p;
    const base = route.base;
    const s = { apiKey: route.apiKey };

    // Arm a resettable timeout: first-byte budget initially, then IDLE_MS per chunk.
    const arm = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, ms);
    };
    arm(route.firstByteMs || FIRST_BYTE_MS);

    const onClose = () => ctl.abort();
    res.on('close', onClose);

    try {
      if (p.needsKey && !route.apiKey) {
        const e = new Error(`No API key saved for ${p.label} — open ⚙ Settings and Connect.`);
        e.fatal = true;
        throw e;
      }

      // ---- build the provider request ----
      let upstream;
      if (p.kind === 'ollama') {
        const options = {};
        if (temperature !== null) options.temperature = temperature;
        if (frequency > 0) options.repeat_penalty = Math.min(1.3, 1 + frequency * 0.5);
        if (maxTokens > 0) options.num_predict = maxTokens; // bound runaway loops
        upstream = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: route.model,
            messages,
            stream: true,
            // Grammar-locked JSON output — small models otherwise emit
            // syntactically broken JSON that can't be parsed.
            ...(jsonMode ? { format: 'json' } : {}),
            ...(Object.keys(options).length ? { options } : {}),
          }),
          signal: ctl.signal,
        });
      } else if (p.kind === 'anthropic') {
        const system = messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n\n');
        const convo = messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content }));
        upstream = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': s.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: route.model,
            max_tokens: maxTokens > 0 ? Math.min(maxTokens, 4096) : 4096,
            ...(temperature !== null ? { temperature } : {}),
            ...(system ? { system } : {}),
            messages: convo,
            stream: true,
          }),
          signal: ctl.signal,
        });
      } else {
        // OpenAI-compatible: OpenAI, Groq, DeepSeek, OpenRouter, the free
        // keyless gateways (Kilo/LLM7/OVH), and custom endpoints.
        upstream = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: route.model,
            messages,
            stream: true,
            ...(temperature !== null ? { temperature } : {}),
            ...(frequency > 0 ? { frequency_penalty: frequency } : {}),
            ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
          }),
          signal: ctl.signal,
        });
      }

      if (!upstream.ok || !upstream.body) throw await upstreamFail(upstream, p);

      // Tell the client which source/model actually serves this reply so the
      // sidebar footer can show its context window + limits.
      try {
        const info = await modelInfoFor(route.id, route.model, {
          base,
          models: route.models,
        });
        send({ route: { provider: route.id, label: p.label, model: route.model, info } });
      } catch { /* info is best-effort */ }

      // ---- read the stream (JSONL for Ollama, SSE for the rest) ----
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const extract =
        p.kind === 'anthropic'
          ? (j) => (j && j.delta && j.delta.text) || ''
          : (j) =>
              (j && j.choices && j.choices[0] && j.choices[0].delta &&
                j.choices[0].delta.content) ||
              '';

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (clientGone) break;
        arm(IDLE_MS);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          if (p.kind === 'ollama') {
            try {
              const json = JSON.parse(t);
              if (json.message && json.message.content) {
                anyContent = true;
                send({ delta: json.message.content });
              }
            } catch {
              /* partial JSON line, wait for more */
            }
          } else {
            if (!t.startsWith('data:')) continue; // SSE comments / event: lines
            const payload = t.slice(5).trim();
            if (payload === '[DONE]') break outer;
            try {
              const d = extract(JSON.parse(payload));
              if (d) {
                anyContent = true;
                send({ delta: d });
              }
            } catch {
              /* partial SSE line, wait for more */
            }
          }
        }
      }
    } finally {
      if (timer) clearTimeout(timer);
      res.off('close', onClose);
      // Stop generation upstream if we bailed out early (client gone / timeout / error).
      ctl.abort();
    }
  }

  let lastError = null;
  const activeId = loadSettings().provider;
  const isAuto = (PROVIDERS[activeId] || {}).kind === 'auto';

  const singleRoute = () => {
    const { s, p, base } = providerConf();
    return {
      id: s.provider,
      label: p.label,
      p,
      base,
      apiKey: s.apiKey,
      model,
      firstByteMs: FIRST_BYTE_MS,
    };
  };

  if (isAuto) {
    // Try each responding source in order until one streams a reply.
    let routes = [];
    try {
      routes = await autoRoutes();
    } catch (e) {
      lastError = e;
    }
    if (!routes.length && !lastError) lastError = new Error('Auto found no responding sources.');
    const failures = [];
    for (const route of routes) {
      if (clientGone || anyContent) break;
      timedOut = false;
      try {
        await runOnce(route);
        autoWinner = { id: route.id, model: route.model, at: Date.now() };
        lastError = null;
        break;
      } catch (err) {
        if (clientGone) break;
        if (anyContent) {
          lastError = err; // stream started then died — surface as-is
          break;
        }
        failures.push(`${route.p.label}: ${timedOut ? 'timed out' : err.message || 'failed'}`);
        lastError = err;
      }
    }
    if (failures.length && lastError) {
      lastError = new Error(
        'Auto: no working model found.\nTried:\n- ' + failures.slice(0, 6).join('\n- ')
      );
    }
  } else {
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (clientGone) break;
      try {
        await runOnce(singleRoute());
        lastError = null;
        break;
      } catch (err) {
        if (clientGone) break;
        if (timedOut) {
          lastError = new Error(
            `Timed out waiting for ${providerConf().p.label} — the model may still be loading or busy. Try again in a moment.`
          );
          break;
        }
        lastError = err;
        const retryable = err.name !== 'AbortError' && !anyContent && !err.fatal;
        if (attempt < MAX_ATTEMPTS && retryable) {
          await sleep(800);
          continue;
        }
        break;
      }
    }
  }

  if (lastError && !clientGone) {
    const msg = lastError.message || 'Unknown error';
    const { p } = providerConf();
    let hint = '';
    if (isAuto) {
      hint = OLLAMA_ENABLED
        ? '\nOpen ⚙ Settings → Auto → Connect to re-probe sources, or start Ollama for local fallback.'
        : '\nOpen ⚙ Settings → Auto → Connect to re-probe sources.';
    } else if (lastError.httpStatus) {
      hint = `\nCheck ⚙ Settings — provider, API key and Base URL must match ${p.label}.`;
    } else if (p.kind === 'ollama') {
      hint = '\nIs Ollama running and healthy? Restart it with: ollama serve';
    }
    send({ error: msg + hint });
  }
  send({ done: true });
  if (!clientGone) res.end();
});

app.listen(PORT, () => {
  const { s, p, base } = providerConf();
  console.log(`🧠 Cortex running at http://localhost:${PORT}  (landing at /, app at /app)`);
  console.log(`   Provider: ${p.label} (${s.provider}) — ${base}`);
  if (!OLLAMA_ENABLED) console.log('   OLLAMA_ENABLED=0 — local Ollama is not probed or offered.');
});
