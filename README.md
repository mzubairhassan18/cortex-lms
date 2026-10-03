# Cortex

An AI learning workspace: ask questions, explain any message in a panel beside
it, keep personal notes, generate a summary of the session, and test yourself
with a generated quiz. Attach Word/PDF/text files or links and they become part
of the conversation's context. A second, n8n-style **graph view** lays the whole
topic out as a tree of conversations and explanations.

- `/` — the public landing page
- `/app` — the application

## Quick start

```bash
npm install
npm start          # landing: http://localhost:3000  |  app: http://localhost:3000/app
```

Requires Node.js (no build step — see [Architecture](#architecture)).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `OLLAMA_ENABLED` | `1` | Set to `0`, `false`, `off`, `no`, or empty to **disable local Ollama**. |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint. Only probed while Ollama is enabled. |
| `AUTO_FIRST_BYTE_MS` | `35000` | Timeout per source while **Auto** probes providers. |
| `FIRST_BYTE_MS` | `120000` | Time-to-first-byte ceiling for a normal completion. |
| `IDLE_MS` | `45000` | Ceiling on a gap between streamed chunks. |

### `OLLAMA_ENABLED` — deploying to a server with no Ollama

A self-hosted box usually has nothing listening on `localhost:11434`. With the
default settings the app would still list **Local (Ollama)** in settings and
probe it during Auto mode, which just wastes time and produces a misleading
option. Set the flag to take it out entirely:

```bash
# Linux / macOS
OLLAMA_ENABLED=0 npm start

# Windows (PowerShell)
$env:OLLAMA_ENABLED = "0"; npm start

# systemd / Docker
Environment=OLLAMA_ENABLED=0
```

When disabled:

- **Local (Ollama)** is removed from the provider list (not greyed out — gone).
- Auto mode never probes it, so probing starts at the remote free sources.
- The default provider becomes **Auto** instead of **Ollama**.
- `OLLAMA_URL` is ignored (it is still honoured if you leave the flag unset and
  point it at a *remote* Ollama).

Leave the variable unset if you *do* run Ollama, locally or elsewhere.

## Providers

Set the provider and API key in the app's **⚙ Settings**; keys are stored in
`data/settings.json`, never sent to the browser.

- **Auto** — probes every reachable source and routes to the first working one.
- **Free, no key** — Kilo Code, LLM7.io, OVHcloud AI (base URL only).
- **Local** — Ollama (unless `OLLAMA_ENABLED=0`).
- **Free tier with a key** — Gemini, Mistral, NVIDIA NIM, Hugging Face, …
- **Mainstream** — OpenAI, Anthropic, Groq, DeepSeek, OpenRouter, …
- **Custom** — any OpenAI-compatible endpoint.

## Storage

Everything lives under `data/` (gitignored):

| File | Contents |
| --- | --- |
| `conversations.json` | All conversations: messages, notes, summaries, tests, explain panels. |
| `conversations.json.bak` | Snapshot of the previous state, written before every save. |
| `conversations.deleted.json` | Append-only archive of removed conversations. |
| `settings.json` | Provider, model, API keys. |
| `uploads/<convId>/` | Extracted text of that conversation's attachments. |

Deleting a conversation is permanent by design, but it is no longer silent: the
removal is written to the server log with its title and a count, and the whole
conversation is appended to `conversations.deleted.json`.

**To recover a deleted conversation:**

```bash
curl -X POST http://localhost:3000/api/deleted/<id>/restore
```

…or copy it back into `data/conversations.json` by hand. If `conversations.json`
is ever corrupted, `conversations.json.bak` holds the state from before the last
save.

## Deployment

This is a Node app (it proxies provider APIs and streams responses), so it needs
a Node host — any VPS, Fly.io, Railway, Render, a Docker container, etc. It is
**not** a static site and cannot be hosted on GitHub Pages:

1. Clone and `npm install`.
2. Set `PORT` (the host usually assigns one) and `OLLAMA_ENABLED=0` if there is
   no Ollama on the box.
3. `npm start`.
4. Persist `data/` — that is where every conversation lives.

`npm start` logs the resolved configuration on boot:

```
🧠 Cortex running at http://localhost:3000  (landing at /, app at /app)
   Provider: Auto (pick a working model) (auto) —
   OLLAMA_ENABLED=0 — local Ollama is not probed or offered.
```

## Architecture

**No build step.** The browser loads plain ES modules directly from `public/`,
so `npm start` is the whole pipeline and there is nothing to compile or bundle
on deploy.

```
public/
  index.html          entry: <script type="module" src="js/main.js">
  js/                 ~20 ES modules, split from the former public/app.js
    views.js          the Preact view layer (html`…` + render)
    state.js          shared state — must stay a dependency-free leaf
    chat.js           sending + streaming messages
    conversations.js  list, select, delete, sidebar rendering
    summary.js        session summary + test section
    quiz.js           quiz + results
    explain-*         the explain-in-sidebar panel
    selection.js      text-selection popup and personal notes
    files.js/library.js  attachments and the library overlay
    stream.js         incremental streaming into the DOM
  vendor/             preact.mjs + htm.mjs + marked.min.js (pinned in package.json)
server.js             Express: static hosting, CRUD, provider proxy, streaming
```

The view layer uses **Preact** with **htm** (`html` templates, no JSX compiler).
Messages, explain-panel content, the conversation list, the summary/notes cards,
quiz/results and the library are Preact-rendered; only the imperative streaming
bubble and small dynamic `<select>`s stay `innerHTML`, because Preact must not
own a container that imperative code also writes to.

Three conventions worth knowing before editing a view:

- **Views interpolate raw strings.** Preact escapes text, so `escapeHtml()` in a
  template would render `&amp;` literally.
- **HTML goes through `dangerouslySetInnerHTML`** — markdown output only, so the
  decoration and source-highlighting that run after render survive re-renders.
- **`hidden` must be a boolean** (`hidden=${!open}`). Preact ignores an empty
  string here, so the old `hidden`/`''` idiom silently does nothing.
