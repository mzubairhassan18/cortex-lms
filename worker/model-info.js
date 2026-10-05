/*
 * GET /api/model-info — the sidebar footer's context-window/limits read.
 *
 * The client asks for whatever provider it currently *believes* it is using,
 * so a stale value (an app booted before its settings arrived, say) arrives
 * here as `provider=ollama`. Answering with a guess would be worse than
 * refusing: an unknown provider is a 400, and the footer simply keeps the
 * info it already had — `loadModelInfo()` swallows errors by design.
 *
 * `auto` is special-cased exactly as server.js did: it does not describe one
 * model but the whole set of sources Auto can reach, so it answers with the
 * combined range plus a per-source breakdown.
 */

import { HttpError, userId } from './supabase.js';
import {
  PROVIDERS,
  autoInfo,
  friendlyNet,
  modelInfoFor,
  providerConf,
} from './providers.js';
import { loadSettings } from './settings.js';

export async function getModelInfo(env, request, url) {
  try {
    const s = await loadSettings(env, request);
    const uid = userId(request);

    const provider = String(url.searchParams.get('provider') || '').trim() || s.provider;
    const model = String(url.searchParams.get('model') || '').trim();

    if (!PROVIDERS[provider]) throw new HttpError(400, 'Unknown provider');
    if (provider === 'auto') return json(await autoInfo(s, uid));

    /*
     * Reuse the caller's configured base URL only when they are actually
     * configured *for this provider*; otherwise fall back to the published
     * default. Without that condition a stale custom base set for provider A
     * would silently be used to describe provider B.
     */
    const conf = providerConf(s);
    const base = conf.s.provider === provider ? conf.base : PROVIDERS[provider].baseUrl;

    return json(await modelInfoFor(provider, model, { base, settings: s }));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(500, friendlyNet(e));
  }
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}
