/* stream.js — split from public/app.js (app.js line 285-472). */
import { AVATAR_MARK, renderMarkdown } from './markdown.js';
import { appSettings, updateFooterModel } from './settings.js';
import { state } from './state.js';

/* ================= Typewriter streamer ================= */
/*
 * Reveals received text character-by-character into a pending bubble.
 *
 * The previous version re-parsed and re-serialized the ENTIRE accumulated
 * reply on every 16ms tick and forced a synchronous reflow of the whole
 * conversation after each write. That is O(n²) in reply length, and it is what
 * made long answers freeze the tab. Now:
 *   • a completed block (ended by a blank line, or by a closing code fence) is
 *     rendered ONCE and appended as a static node;
 *   • only the trailing, still-incomplete block is re-rendered per tick;
 *   • scrolling is coalesced to one rAF per frame instead of a forced layout
 *     per tick;
 *   • the reveal step grows with the backlog, so a fast model never falls
 *     seconds behind while short replies keep the typewriter feel.
 */

/* One queued scroll per element per frame — reads/writes stay batched. */
const scrollQueued = new WeakSet();

function scrollSoon(el) {
  if (!el || scrollQueued.has(el)) return;
  scrollQueued.add(el);
  requestAnimationFrame(() => {
    scrollQueued.delete(el);
    if (el.isConnected) scrollDown(el);
  });
}

export function makeStreamer(container, onFinish) {
  let received = '';
  let revealed = 0;
  let timer = null;
  let finished = false;
  let wrap = null;    // .msg.assistant wrapper (marked .msg-streaming while live)
  let bubble = null;  // .bubble
  let tail = null;    // wrapper for the not-yet-committed trailing block
  let committedLen = 0; // chars of the revealed prefix already rendered statically
  let linePos = 0;      // line-scan cursor (carried across ticks)
  let inFence = false;  // inside a ``` block? (never split one)

  function ensureBubble() {
    if (!wrap) {
      const el = document.createElement('div');
      el.className = 'msg assistant msg-streaming';
      const av = document.createElement('span');
      av.className = 'msg-avatar';
      av.title = 'Cortex';
      av.innerHTML = AVATAR_MARK;
      el.appendChild(av);
      const body = document.createElement('div');
      body.className = 'msg-body';
      const b = document.createElement('div');
      b.className = 'bubble thinking';
      const t = document.createElement('div');
      t.className = 'stream-tail';
      b.appendChild(t);
      body.appendChild(b);
      el.appendChild(body);
      container.appendChild(el);
      wrap = el;
      bubble = b;
      tail = t;
      scrollSoon(container);
    }
    return bubble;
  }

  /* Render shown[..end] as static DOM nodes placed immediately before the tail. */
  function commit(end, shown) {
    if (!bubble || end <= committedLen) return;
    const chunk = shown.slice(committedLen, end);
    committedLen = end;
    if (!chunk.trim()) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = renderMarkdown(chunk);
    while (tmp.firstChild) bubble.insertBefore(tmp.firstChild, tail);
  }

  /* Walk complete lines, committing blocks at blank lines and at closing code
   * fences. Fence state is carried across ticks, so blank lines inside a code
   * block never split it. */
  function scan(shown, final) {
    while (linePos < shown.length) {
      let nl = shown.indexOf('\n', linePos);
      if (nl === -1) {
        if (!final) return; // the line is still arriving
        nl = shown.length;
      }
      const lineEnd = nl < shown.length ? nl + 1 : shown.length;
      const line = shown.slice(linePos, nl);
      if (/^[ \t]*```/.test(line)) {
        const wasOpen = inFence;
        inFence = !inFence;
        linePos = lineEnd;
        if (wasOpen) commit(lineEnd, shown); // fence closed -> block complete
        continue;
      }
      if (!inFence && line.trim() === '') {
        commit(linePos, shown); // everything before the blank run
        // Absorb the blank run so it is never rendered as its own block.
        while (linePos < shown.length) {
          const n2 = shown.indexOf('\n', linePos);
          if (n2 === -1) {
            linePos = shown.length;
            break;
          }
          if (shown.slice(linePos, n2).trim() !== '') break;
          linePos = n2 + 1;
        }
        if (linePos > committedLen) committedLen = linePos;
        continue;
      }
      linePos = lineEnd;
    }
    if (final) commit(shown.length, shown);
  }

  function pump() {
    timer = null;
    if (finished) return;
    if (wrap && !wrap.isConnected) {
      // The container was wiped (conversation switched, panel cleared).
      // Stop animating; end() still reports the text when the stream closes.
      return;
    }
    if (revealed >= received.length) {
      timer = setTimeout(pump, 80); // wait for the next chunk
      return;
    }
    const backlog = received.length - revealed;
    revealed = Math.min(received.length, revealed + Math.max(3, Math.ceil(backlog / 12)));
    const b = ensureBubble();
    b.classList.remove('thinking');
    const shown = received.slice(0, revealed);
    scan(shown, false);
    if (committedLen < shown.length) {
      tail.innerHTML = renderMarkdown(shown.slice(committedLen));
    }
    scrollSoon(container);
    timer = setTimeout(pump, 16);
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
      if (finished) return; // a watchdog + an error path can both end a stream
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      finished = true;
      const full = received;
      if (bubble && wrap && wrap.isConnected) {
        revealed = full.length;
        bubble.classList.remove('thinking');
        if (tail) tail.innerHTML = ''; // clear the partial, then commit it all
        scan(full, true);
      }
      const el = wrap;
      wrap = null;
      bubble = null;
      tail = null;
      /* The streamer owns this bubble, so the streamer removes it — before the
       * real message is rendered, in the same synchronous block (no flicker).
       * It used to disappear as a side effect of the container's innerHTML
       * being rewritten, which the Preact views no longer do. */
      if (el) el.remove();
      onFinish(full);
    },
  };
}

/* ================= SSE streaming ================= */
/*
 * Streams from /api/chat. Retries once when nothing has been delivered yet,
 * never retries after an abort, and surfaces friendly error text.
 *
 * A watchdog aborts the request when the server goes quiet (first byte, then
 * between chunks) so `state.streaming` can never stay true forever — previously
 * a dead connection left the UI permanently "generating".
 */
const FIRST_BYTE_MS = Number(window.FIRST_BYTE_MS) || 45000;
const IDLE_MS = Number(window.IDLE_MS) || 60000;

export async function streamChat(messages, streamer, signal, opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MAX_ATTEMPTS = 2;
  let receivedAny = false;
  let lastErr = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal && signal.aborted) break;
    const ctl = new AbortController(); // our watchdog, plus the caller's signal
    let timedOut = false;
    let watch = 0;
    const arm = (ms) => {
      clearTimeout(watch);
      watch = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, ms);
    };
    const relay = () => ctl.abort();
    if (signal) signal.addEventListener('abort', relay, { once: true });
    let reader = null;
    try {
      arm(FIRST_BYTE_MS);
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
        signal: ctl.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        // Our own API answers {"error":"..."} — show that sentence rather than
        // the JSON wrapper, so a quota refusal reads as prose instead of
        // `Server error 429: {"error":"Daily limit ...}`.
        let msg = errText.slice(0, 300);
        try {
          const parsed = JSON.parse(errText);
          if (parsed && parsed.error) msg = parsed.error;
        } catch { /* not our shape — keep the raw body */ }
        const e = new Error(`Server error ${res.status}: ${msg}`);
        e.httpStatus = res.status;
        throw e;
      }

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let serverError = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(IDLE_MS); // data is moving — switch from first-byte to idle watchdog
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
      // The caller cancelled (new explain, closed sidebar, switched away).
      if (signal && signal.aborted) {
        streamer.end();
        return;
      }
      if (e.name === 'AbortError' && timedOut) {
        e = new Error(
          receivedAny
            ? 'The model stopped sending — the connection went quiet. Try again.'
            : `No reply after ${Math.round(FIRST_BYTE_MS / 1000)}s — the model may still be loading. Try again.`
        );
      } else if (e.name === 'AbortError') {
        streamer.end();
        return;
      }
      lastErr = e;
      // A 4xx is an answer, not a hiccup: retrying a quota refusal (or a bad
      // request) only waits and fails again, and each attempt would re-run
      // the quota check. 5xx and timeouts are still worth one quiet retry.
      if (e.httpStatus >= 400 && e.httpStatus < 500) break;
      // Only a quiet retry can help, and only before anything was delivered.
      if (attempt < MAX_ATTEMPTS && !receivedAny && !timedOut) {
        await sleep(1200);
        continue;
      }
      break;
    } finally {
      clearTimeout(watch);
      if (signal) signal.removeEventListener('abort', relay);
      // Release the stream reader so the connection is not held open.
      if (reader) {
        try {
          reader.cancel();
        } catch { /* already closed */ }
      }
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
export function cleanHistory(msgs) {
  return msgs.filter((m) => m.role === 'user' || !m.content.startsWith('⚠️'));
}

/* ================= Scrolling ================= */

export function scrollDown(el) {
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  if (nearBottom) el.scrollTop = el.scrollHeight;
}
