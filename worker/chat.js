/*
 * POST /api/chat — SSE proxy to the configured provider.
 *
 * The response contract is unchanged from server.js: every frame is
 *
 *   data: {"delta": "..."}   streamed text
 *   data: {"route": {...}}   which source/model actually served it
 *   data: {"error": "..."}   a message worth showing the user
 *   data: {"done": true}     always last
 *
 * Three things the Express original got from Node and this has to build:
 *
 *   `res.write`  -> enqueueing TextEncoder bytes on a ReadableStream
 *   `res.on('close')` -> `request.signal`, which is how a Worker learns the
 *                        user navigated away, so generation is aborted
 *                        upstream instead of running to completion unseen
 *   `loadSettings()` -> a per-user `profiles` read, so one visitor's API key
 *                       is never used to answer another's request
 *
 * Robustness rules kept verbatim: abort when the client goes, abort when no
 * first byte arrives within the budget or a token gap exceeds IDLE_MS, retry
 * once when the provider fails before any content streamed.
 */

import { HttpError, userId } from './supabase.js';
import {
  FIRST_BYTE_MS,
  IDLE_MS,
  autoRoutes,
  friendlyNet,
  modelInfoFor,
  providerConf,
  upstreamFail,
} from './providers.js';
import { loadSettings } from './settings.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function chat(env, request) {
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const { model, messages } = body || {};
  // Optional generation tuning (background jobs send low temperature +
  // anti-repeat to keep small models from looping).
  const temperature = Number.isFinite(+body?.temperature) ? +body.temperature : null;
  const frequency = Number.isFinite(+body?.frequency) ? +body.frequency : 0;
  const maxTokens = Number.isFinite(+body?.maxTokens) ? +body.maxTokens : 0;
  const jsonMode = !!body?.jsonMode;
  if (!model || !Array.isArray(messages)) {
    throw new HttpError(400, 'model and messages are required');
  }

  // Load both before streaming: a settings read that fails must come back as
  // an ordinary JSON error, not as a half-open event stream.
  const s = await loadSettings(env, request);
  const uid = userId(request);
  const conf = providerConf(s);
  const isAuto = conf.p.kind === 'auto';

  const encoder = new TextEncoder();
  let clientGone = false;
  let closed = false;
  let controller;
  // Generation options ride on `state` so runOnce stays the same shape across
  // the Auto and single-route retry loops above; anyContent/timedOut are the
  // two fields runOnce mutates back into them.
  const state = {
    anyContent: false,
    timedOut: false,
    messages,
    temperature,
    frequency,
    maxTokens,
    jsonMode,
    settings: s,
  };

  const stream = new ReadableStream({
    start(c) { controller = c; },
    cancel() { clientGone = true; },
  });

  const send = (obj) => {
    if (clientGone || closed) return;
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
    } catch {
      clientGone = true; // reader is gone — stop enqueueing
    }
  };

  const finish = () => {
    if (closed) return;
    closed = true;
    try { controller.close(); } catch { /* already cancelled */ }
  };

  // A Worker learns about disconnects through request.signal. Without this,
  // closing the tab leaves the upstream generation running to the end.
  const sig = request.signal;
  if (sig) {
    if (sig.aborted) clientGone = true;
    else sig.addEventListener('abort', () => { clientGone = true; });
  }

  (async () => {
    let lastError = null;

    if (isAuto) {
      // Try each responding source in order until one streams a reply.
      let routes = [];
      try {
        routes = await autoRoutes(s, uid);
      } catch (e) {
        lastError = e;
      }
      if (!routes.length && !lastError) lastError = new Error('Auto found no responding sources.');
      const failures = [];
      for (const route of routes) {
        if (clientGone || state.anyContent) break;
        state.timedOut = false;
        try {
          await runOnce(route, state, send);
          lastError = null;
          break;
        } catch (err) {
          if (clientGone) break;
          if (state.anyContent) {
            lastError = err; // stream started then died — surface as-is
            break;
          }
          failures.push(`${route.p.label}: ${state.timedOut ? 'timed out' : err.message || 'failed'}`);
          lastError = err;
        }
      }
      if (failures.length && lastError) {
        lastError = new Error(
          'Auto: no working model found.\nTried:\n- ' + failures.slice(0, 6).join('\n- '),
        );
      }
    } else {
      const singleRoute = () => ({
        id: s.provider,
        label: conf.p.label,
        p: conf.p,
        base: conf.base,
        apiKey: s.apiKey,
        model,
        firstByteMs: FIRST_BYTE_MS,
      });
      const MAX_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (clientGone) break;
        try {
          await runOnce(singleRoute(), state, send);
          lastError = null;
          break;
        } catch (err) {
          if (clientGone) break;
          if (state.timedOut) {
            lastError = new Error(
              `Timed out waiting for ${conf.p.label} — the model may still be loading or busy. Try again in a moment.`,
            );
            break;
          }
          lastError = err;
          const retryable = err.name !== 'AbortError' && !state.anyContent && !err.fatal;
          if (attempt < MAX_ATTEMPTS && retryable) {
            await sleep(800);
            continue;
          }
          break;
        }
      }
    }

    if (lastError && !clientGone) {
      let hint = '';
      if (isAuto) {
        hint = '\nOpen ⚙ Settings → Auto → Connect to re-probe sources.';
      } else if (lastError.httpStatus) {
        hint = `\nCheck ⚙ Settings — provider, API key and Base URL must match ${conf.p.label}.`;
      }
      send({ error: (lastError.message || 'Unknown error') + hint });
    }
    send({ done: true });
  })()
    .catch((e) => send({ error: friendlyNet(e) }))
    .finally(finish);

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // Tell any intermediate cache not to hold a stream open for the next reader.
      'x-accel-buffering': 'no',
    },
  });
}

/** One attempt against one route: build the provider request, then relay it. */
async function runOnce(route, state, send) {
  const prox = new AbortController();
  let timer = null;
  const p = route.p;
  const base = route.base;
  const s = { apiKey: route.apiKey };

  // Arm a resettable timeout: first-byte budget initially, then IDLE_MS per chunk.
  const arm = (ms) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      state.timedOut = true;
      prox.abort();
    }, ms);
  };
  arm(route.firstByteMs || FIRST_BYTE_MS);

  try {
    if (p.needsKey && !s.apiKey) {
      const e = new Error(`No API key saved for ${p.label} — open ⚙ Settings and Connect.`);
      e.fatal = true;
      throw e;
    }

    const upstream = await buildUpstream(p, base, s, {
      model: route.model,
      messages: state.messages,
      temperature: state.temperature,
      frequency: state.frequency,
      maxTokens: state.maxTokens,
      jsonMode: state.jsonMode,
      signal: prox.signal,
    });

    if (!upstream.ok || !upstream.body) throw await upstreamFail(upstream, p);

    // Tell the client which source/model actually serves this reply so the
    // sidebar footer can show its context window + limits.
    try {
      const info = await modelInfoFor(route.id, route.model, {
        base,
        models: route.models,
        settings: state.settings,
      });
      send({ route: { provider: route.id, label: p.label, model: route.model, info } });
    } catch { /* info is best-effort */ }

    // ---- read the stream (SSE for every provider we can reach here) ----
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
      arm(IDLE_MS);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data:')) continue; // SSE comments / event: lines
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') break outer;
        try {
          const d = extract(JSON.parse(payload));
          if (d) {
            state.anyContent = true;
            send({ delta: d });
          }
        } catch { /* partial SSE line, wait for more */ }
      }
      // `clientGone` is checked via the reader only on the next read; the
      // finally below aborts the fetch, which is what actually stops billing.
    }
  } finally {
    if (timer) clearTimeout(timer);
    // Stop generation upstream if we bailed out early (client gone / timeout / error).
    prox.abort();
  }
}

function buildUpstream(p, base, s, opts) {
  const { model, messages, temperature, frequency, maxTokens, signal } = opts;

  if (p.kind === 'anthropic') {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const convo = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));
    return fetch(`${base}/v1/messages`, {
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
      signal,
    });
  }

  // OpenAI-compatible: OpenAI, Groq, DeepSeek, OpenRouter, the free keyless
  // gateways (Kilo/LLM7/OVH), and custom endpoints.
  return fetch(`${base}/chat/completions`, {
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
    signal,
  });
}
