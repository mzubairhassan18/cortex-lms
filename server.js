const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const DATA_DIR = path.join(__dirname, 'data');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// ---------- Provider settings (local Ollama or a cloud API) ----------
// Providers — mainstream APIs plus the free tiers from
// https://github.com/mnfst/awesome-free-llm-apis (no credit card anywhere).
// FREE + NO KEY (base URL only) come first, then local, then free-with-key,
// then mainstream paid APIs, then custom.
const PROVIDERS = {
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
const DEFAULT_SETTINGS = { provider: 'ollama', apiKey: '', baseUrl: '' };

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
  const p = PROVIDERS[s.provider] || PROVIDERS.ollama;
  const base = (String(s.baseUrl || '').trim() || p.baseUrl).replace(/\/$/, '');
  return { s, p, base };
}

function settingsView() {
  const s = loadSettings();
  return {
    provider: PROVIDERS[s.provider] ? s.provider : 'ollama',
    baseUrl: s.baseUrl || '',
    apiKeySet: !!s.apiKey,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
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

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CONV_FILE)) fs.writeFileSync(CONV_FILE, '[]');

function loadConversations() {
  try {
    return JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveConversations(list) {
  fs.writeFileSync(CONV_FILE, JSON.stringify(list, null, 2));
}

// ---------- Conversation CRUD ----------

app.get('/api/conversations', (req, res) => {
  const list = loadConversations()
    .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
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
  const conv = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    title: req.body.title || 'New conversation',
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
  if ('messages' in req.body || 'explains' in req.body) conv.updatedAt = Date.now();
  const firstUser = conv.messages.find((m) => m.role === 'user');
  if (firstUser && (!conv.title || conv.title === 'New conversation')) {
    conv.title = firstUser.content.slice(0, 40);
  }
  saveConversations(list);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  saveConversations(loadConversations().filter((c) => c.id !== req.params.id));
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
    const p = PROVIDERS[s.provider] || PROVIDERS.ollama;
    const base = (String(s.baseUrl || '').trim() || p.baseUrl).replace(/\/$/, '');
    if (p.needsKey && !s.apiKey) {
      return res.status(400).json({ error: `Enter the ${p.label} API key.` });
    }
    const models = await listModels(s, p, base);
    saveSettings(s);
    res.json({ ...settingsView(), models });
  } catch (e) {
    res.status(e.status || 502).json({ error: friendlyNet(e) });
  }
});

// ---------- Model list (routes to the configured provider) ----------

async function listModels(s, p, base) {
  if (p.kind === 'ollama') {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw await upstreamFail(r, p);
    const d = await r.json();
    return (d.models || []).map((m) => ({ name: m.name }));
  }
  if (p.kind === 'anthropic') {
    const r = await fetch(`${base}/v1/models`, {
      headers: { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw await upstreamFail(r, p);
    const d = await r.json();
    return (d.data || []).map((m) => ({ name: m.id }));
  }
  const r = await fetch(`${base}/models`, {
    headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw await upstreamFail(r, p);
  const d = await r.json();
  return (d.data || []).map((m) => ({ name: m.id }));
}

app.get('/api/models', async (req, res) => {
  try {
    const { s, p, base } = providerConf();
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

  async function runOnce() {
    const ctl = new AbortController();
    let timer = null;

    // Arm a resettable timeout: FIRST_BYTE_MS initially, then IDLE_MS per chunk.
    const arm = (ms) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, ms);
    };
    arm(FIRST_BYTE_MS);

    const onClose = () => ctl.abort();
    res.on('close', onClose);

    try {
      const { s, p, base } = providerConf();
      if (p.needsKey && !s.apiKey) {
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
            model,
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
            model,
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
            model,
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
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (clientGone) break;
    try {
      await runOnce();
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

  if (lastError && !clientGone) {
    const msg = lastError.message || 'Unknown error';
    const { p } = providerConf();
    let hint = '';
    if (lastError.httpStatus) {
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
  console.log(`🎓 Learning Bot running at http://localhost:${PORT}`);
  console.log(`   Provider: ${p.label} (${s.provider}) — ${base}`);
});
