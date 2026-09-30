const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const DATA_DIR = path.join(__dirname, 'data');
const CONV_FILE = path.join(DATA_DIR, 'conversations.json');

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
  conv.messages = Array.isArray(req.body.messages) ? req.body.messages : [];
  // Snapshot of explain windows (tree of sessions) for this conversation.
  if ('explains' in req.body) conv.explains = req.body.explains || null;
  conv.updatedAt = Date.now();
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

// ---------- Model list proxy ----------

app.get('/api/models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Cannot reach Ollama. Is it running? (ollama serve)' });
  }
});

// ---------- Chat stream (SSE proxy to Ollama) ----------
//
// Robustness rules:
// 1. Client disconnects -> immediately abort the upstream Ollama fetch, so no
//    zombie generations pile up and wedge the model.
// 2. No first byte within FIRST_BYTE_MS, or a token gap longer than IDLE_MS
//    -> abort and report a clear timeout error.
// 3. If Ollama fails before any content was streamed, retry once automatically.

app.post('/api/chat', async (req, res) => {
  const { model, messages } = req.body || {};
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
      const ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: ctl.signal,
      });

      if (!ollamaRes.ok || !ollamaRes.body) {
        const errText = await ollamaRes.text().catch(() => '');
        const e = new Error(
          `Ollama returned ${ollamaRes.status}${errText ? `: ${errText.slice(0, 400)}` : ''}`
        );
        e.httpStatus = ollamaRes.status;
        throw e;
      }

      const reader = ollamaRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
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
          try {
            const json = JSON.parse(t);
            if (json.message && json.message.content) {
              anyContent = true;
              send({ delta: json.message.content });
            }
          } catch {
            /* partial JSON line, wait for more */
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
          'Timed out waiting for Ollama — the model may still be loading or busy. Try again in a moment.'
        );
        break;
      }
      lastError = err;
      const retryable = err.name !== 'AbortError' && !anyContent;
      if (attempt < MAX_ATTEMPTS && retryable) {
        await sleep(800);
        continue;
      }
      break;
    }
  }

  if (lastError && !clientGone) {
    const base = lastError.message || 'Unknown error';
    const hint = lastError.httpStatus
      ? '\nIs Ollama running and healthy? Restart it with: ollama serve'
      : '';
    send({ error: base + hint });
  }
  send({ done: true });
  if (!clientGone) res.end();
});

app.listen(PORT, () => {
  console.log(`🎓 Learning Bot running at http://localhost:${PORT}`);
  console.log(`   Ollama: ${OLLAMA_URL}`);
});
