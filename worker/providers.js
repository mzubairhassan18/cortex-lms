/*
 * Provider table + the model-listing/auto-routing helpers server.js kept at
 * module scope.
 *
 * Two deliberate differences from the Express original:
 *
 *   OLLAMA_ENABLED is false here, always. On a laptop Ollama is a local
 *   process; on a Worker `localhost` is the Worker itself, so probing it would
 *   burn a connection timeout on every Auto call and offer a "Local" provider
 *   that can never answer. The table is therefore built without `ollama` and
 *   FALLBACK is `auto`.
 *
 *   settings are no longer read from disk — every function takes the caller's
 *   settings object as an argument, because on a Worker there is no disk and
 *   two users must never see each other's provider config.
 *
 * Everything else — the Auto order, the per-source model preferences, the
 * timeout budgets and the friendly error wording — is ported as-is: those
 * messages are the product, and rephrasing them would be a silent UX change.
 */

export const OLLAMA_ENABLED = false;

export const PROVIDERS = {
  // ---- Auto: probe every reachable source and route to a working one ----
  auto:  { label: 'Auto (pick a working model)', kind: 'auto', needsKey: false, baseUrl: '' },
  // ---- Free, no API key at all (just the base URL) ----
  kilo:  { label: 'Kilo Code (free · no key)', kind: 'openai', needsKey: false, baseUrl: 'https://api.kilo.ai/api/gateway' },
  llm7:  { label: 'LLM7.io (free · no key)', kind: 'openai', needsKey: false, baseUrl: 'https://api.llm7.io/v1' },
  ovh:   { label: 'OVHcloud AI (free · anonymous)', kind: 'openai', needsKey: false, baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1' },
  // ---- Free tier with a free API key (no credit card) ----
  gemini:       { label: 'Google Gemini (free tier)', kind: 'openai', needsKey: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  mistral:      { label: 'Mistral AI (free mode)', kind: 'openai', needsKey: true, baseUrl: 'https://api.mistral.ai/v1' },
  zai:          { label: 'Z AI / GLM (free models)', kind: 'openai', needsKey: true, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  nvidia:       { label: 'NVIDIA NIM (free)', kind: 'openai', needsKey: true, baseUrl: 'https://integrate.api.nvidia.com/v1' },
  aionlabs:     { label: 'Aion Labs (free)', kind: 'openai', needsKey: true, baseUrl: 'https://api.aionlabs.ai/v1' },
  hf:           { label: 'Hugging Face (router)', kind: 'openai', needsKey: true, baseUrl: 'https://router.huggingface.co/v1' },
  ollamac:      { label: 'Ollama Cloud (free tier)', kind: 'openai', needsKey: true, baseUrl: 'https://ollama.com/v1' },
  siliconflow:  { label: 'SiliconFlow (free models)', kind: 'openai', needsKey: true, baseUrl: 'https://api.siliconflow.cn/v1' },
  modelscope:   { label: 'ModelScope (free)', kind: 'openai', needsKey: true, baseUrl: 'https://api-inference.modelscope.cn/v1' },
  // Mainstream
  openai:     { label: 'OpenAI (ChatGPT)', kind: 'openai', needsKey: true, baseUrl: 'https://api.openai.com/v1' },
  groq:       { label: 'Groq', kind: 'openai', needsKey: true, baseUrl: 'https://api.groq.com/openai/v1' },
  anthropic:  { label: 'Anthropic (Claude)', kind: 'anthropic', needsKey: true, baseUrl: 'https://api.anthropic.com' },
  deepseek:   { label: 'DeepSeek', kind: 'openai', needsKey: true, baseUrl: 'https://api.deepseek.com/v1' },
  openrouter: { label: 'OpenRouter', kind: 'openai', needsKey: true, baseUrl: 'https://openrouter.ai/api/v1' },
  custom:     { label: 'Custom (OpenAI-compatible)', kind: 'openai', needsKey: true, baseUrl: '' },
};

export const DEFAULT_SETTINGS = { provider: 'auto', apiKey: '', baseUrl: '', keys: {} };

// Which provider an unusable/missing saved setting falls back to.
export const FALLBACK_PROVIDER = 'auto';

/**
 * The settings row as /api/settings describes it.
 *
 * Every caller builds `s` through loadSettings(), so the account fields below
 * are present on the boot response AND on the connect/PUT responses — which
 * matters, because the client replaces its whole settings object from those
 * and would otherwise forget who is signed in the moment a provider connects.
 */
export function settingsView(s) {
  return {
    provider: PROVIDERS[s.provider] ? s.provider : FALLBACK_PROVIDER,
    baseUrl: s.baseUrl || '',
    apiKeySet: !!s.apiKey,
    /* Identity for the settings panel's account menu. Reading your own role
     * is allowed by the profiles read policy and grants nothing: the Admin
     * link is UI, and /api/admin re-reads role from the database anyway. */
    role: s.role || '',
    email: s.email || '',
    name: s.name || '',
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      kind: p.kind,
      needsKey: p.needsKey,
      defaultBaseUrl: p.baseUrl,
    })),
  };
}

/** Merge a settings patch onto the stored settings (does not save). */
export function applySettingsPatch(s, b) {
  const out = { ...s, keys: { ...(s.keys || {}) } };
  if (b.provider !== undefined) {
    if (!PROVIDERS[b.provider]) {
      const e = new Error(`Unknown provider: ${String(b.provider).slice(0, 50)}`);
      e.status = 400;
      throw e;
    }
    if (b.provider !== out.provider) out.baseUrl = ''; // don't leak the old base URL
    out.provider = b.provider;
  }
  if (typeof b.baseUrl === 'string') out.baseUrl = b.baseUrl.trim().slice(0, 300);
  if (typeof b.apiKey === 'string' && b.apiKey.trim()) out.apiKey = b.apiKey.trim().slice(0, 500);
  if (b.clearKey) out.apiKey = '';
  // Remember keys per provider so Auto routing can reuse any saved keys.
  const cur = PROVIDERS[out.provider];
  if (out.apiKey && cur && cur.needsKey) out.keys = { ...out.keys, [out.provider]: out.apiKey };
  return out;
}

export function providerConf(s) {
  const p = PROVIDERS[s.provider] || PROVIDERS[FALLBACK_PROVIDER];
  const base = (String(s.baseUrl || '').trim() || p.baseUrl).replace(/\/$/, '');
  return { s, p, base };
}

// ---------- friendly errors ----------

export function friendlyUpstream(status, text, p) {
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

export async function upstreamFail(r, p) {
  const text = await r.text().catch(() => '');
  const e = new Error(friendlyUpstream(r.status, text, p));
  e.httpStatus = r.status;
  // Client errors won't succeed on retry (except rate limits).
  if (r.status >= 400 && r.status < 500 && r.status !== 429) e.fatal = true;
  return e;
}

export function friendlyNet(e) {
  const m = e && e.message ? e.message : String(e);
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    return 'Timed out reaching the provider.';
  }
  if (/ENOTFOUND|ECONNREFUSED|EAI_AGAIN|fetch failed|NetworkError|certificate|ETIMEDOUT/i.test(m)) {
    return `Cannot reach the provider: ${m}`;
  }
  return m;
}

// Timeouts (ms): first byte allows a cold model to load; idle = max token gap.
// Shorter than the laptop defaults because a Worker sits closer to the
// providers than a home connection does.
export const FIRST_BYTE_MS = 60000;
export const IDLE_MS = 45000;
export const AUTO_FIRST_BYTE_MS = 35000;

// ---------- model listing ----------

export async function listModelsFull(s, p, base, timeoutMs) {
  const to = AbortSignal.timeout(timeoutMs || 20000);
  if (p.kind === 'auto') return [];
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

export async function listModels(s, p, base) {
  const full = await listModelsFull(s, p, base);
  return full.map((m) => ({ name: m.id || m.name || String(m) }));
}

// ---------- Auto: probe reachable sources and route to a working one ----------

const AUTO_ORDER = [
  'kilo', 'llm7', 'ovh',
  'gemini', 'mistral', 'zai', 'nvidia', 'aionlabs', 'hf', 'ollamac', 'siliconflow', 'modelscope',
  'openai', 'groq', 'anthropic', 'deepseek', 'openrouter',
];
// Every id here must exist as a PROVIDERS key: an unknown id resolves to
// null inside buildAutoRoutes and is dropped without any error, so a typo
// would quietly remove a provider from Auto with nothing to show for it.

const AUTO_MODEL_PREF = {
  kilo:         [/^kilo-auto\/free$/i, /^kilo-auto\//i],
  llm7:         [/^mistral-Nemo-Instruct-2407$/i, /^Mistral/i],
  ovh:          [/^Mistral-Small-3\.2/i, /^Meta-Llama-3_3-70B/i, /^gpt-oss-120b$/i],
  gemini:       [/^gemini-2\.0-flash/i, /flash/i],
  mistral:      [/^mistral-small/i, /mistral/i],
  zai:          [/^glm-4\.?flash/i, /^glm/i],
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

export function pickAutoModel(route) {
  for (const re of AUTO_MODEL_PREF[route.id] || []) {
    const m = route.models.find((x) => re.test(x.id || x.name || ''));
    if (m) return m.id || m.name;
  }
  const free = route.models.find((m) => m.isFree === true || /(^|\/|:)free$/i.test(m.id || ''));
  if (free) return free.id || free.name;
  const chat = route.models.find(
    (m) => !/embed|whisper|-tts-|sdxl|stable-diffusion|guard|rerank/i.test(m.id || m.name || ''),
  );
  const pick = chat || route.models[0];
  return pick.id || pick.name;
}

export async function buildAutoRoutes(s) {
  const routes = await Promise.all(
    AUTO_ORDER.map(async (id) => {
      const p = PROVIDERS[id];
      if (!p || p.kind === 'auto' || !p.baseUrl) return null;
      const apiKey = (s.keys && s.keys[id]) || (s.provider === id ? s.apiKey : '');
      if (p.needsKey && !apiKey) return null; // only sources we could actually call
      try {
        const models = await listModelsFull({ ...s, apiKey }, p, p.baseUrl, 8000);
        if (!models.length) return null;
        const route = { id, p, base: p.baseUrl, apiKey, models, firstByteMs: AUTO_FIRST_BYTE_MS };
        route.model = pickAutoModel(route);
        return route;
      } catch {
        return null; // unreachable / refused — skip this source
      }
    }),
  );
  return routes.filter(Boolean);
}

/*
 * Probe results are cached, but not in a module variable: a Worker isolate is
 * shared by every request it happens to hold, so a module-level `autoProbe`
 * would let one user's probe (with their keys) serve another user's Auto call.
 * The cache is keyed by user id and lives in a short-lived map instead.
 */
const PROBE_TTL_MS = 5 * 60 * 1000;
const probes = new Map(); // userId -> {at, routes}

export async function autoRoutes(s, userId, force) {
  const hit = force ? null : probes.get(userId);
  if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.routes.slice();
  const routes = await buildAutoRoutes(s);
  probes.set(userId, { at: Date.now(), routes });
  if (probes.size > 64) probes.delete(probes.keys().next().value); // bound the map
  return routes.slice();
}

// ---------- footer context/limits info ----------

export const PROVIDER_LIMITS = {
  kilo: 'free · no key · fair-use limits',
  llm7: 'free · no key · rate-limited',
  ovh: 'free · anonymous · fair-use limits',
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

export function ctxFmt(n) {
  if (!n) return '';
  const k = n % 1000 === 0 ? n / 1000 : n % 1024 === 0 ? n / 1024 : Math.round(n / 1000);
  if (k >= 1000) return `${Math.round(k / 100) / 10}M`;
  return `${k}K`;
}

/** Context window from provider /models metadata (Kilo/OVH: context_length,
 *  LLM7: context_window.tokens, gateways: top_provider.context_length). */
export function ctxFromMeta(m) {
  if (!m || typeof m !== 'object') return 0;
  const n =
    +m.context_length ||
    +(m.top_provider && m.top_provider.context_length) ||
    +(m.context_window && m.context_window.tokens) ||
    0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const LIVE_CTX_PROVIDERS = new Set(['kilo', 'llm7', 'ovh']);
const ctxCache = new Map(); // `${id}` -> {at, models}

async function liveProviderModels(id, s) {
  const hit = ctxCache.get(id);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.models;
  const p = PROVIDERS[id];
  const apiKey = (s.keys && s.keys[id]) || (s.provider === id ? s.apiKey : '');
  let models = [];
  try {
    models = await listModelsFull({ ...s, apiKey }, p, p.baseUrl, 8000);
  } catch { /* offline — static table */ }
  ctxCache.set(id, { at: Date.now(), models });
  return models;
}

/** Footer info for one provider+model: live context where available. */
export async function modelInfoFor(providerId, model, opts = {}) {
  const p = PROVIDERS[providerId] || PROVIDERS[FALLBACK_PROVIDER];
  const base = opts.base || p.baseUrl;
  const limits = PROVIDER_LIMITS[providerId] || '';
  let context = '';
  let live = false;

  if (opts.models && model) {
    const n = ctxFromMeta(opts.models.find((m) => (m.id || m.name) === model));
    if (n) { context = ctxFmt(n); live = true; }
  }
  if (!context && LIVE_CTX_PROVIDERS.has(providerId) && model) {
    const models = await liveProviderModels(providerId, opts.settings || DEFAULT_SETTINGS);
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

/** Combined context/limits across everything Auto can reach. */
export async function autoInfo(s, userId) {
  let routes = [];
  try { routes = await autoRoutes(s, userId); } catch { /* offline */ }
  const per = [];
  const ctxs = [];
  for (const r of routes) {
    const model = pickAutoModel(r);
    const m = r.models.find((x) => (x.id || x.name) === model);
    const n = m ? ctxFromMeta(m) : 0;
    if (n) ctxs.push(n);
    per.push({ label: r.p.label, model, context: n ? ctxFmt(n) : 'varies', limits: PROVIDER_LIMITS[r.id] || '' });
  }
  const range = ctxs.length ? `${ctxFmt(Math.min(...ctxs))}–${ctxFmt(Math.max(...ctxs))}` : 'varies';
  const limits = 'free tiers: rate-limited';
  const text = routes.length
    ? `Auto: ${routes.length} source${routes.length === 1 ? '' : 's'} · ctx ${range} · ${limits}`
    : 'Auto: press Connect in ⚙ Settings to probe sources';
  const title = routes.length
    ? 'Auto tries these sources in order:\n' +
      per.map((x) => `• ${x.label} — ${x.model} · ctx ${x.context}${x.limits ? ` · ${x.limits}` : ''}`).join('\n')
    : 'No sources probed yet.';
  return { context: range, limits, text, title, sources: per };
}
