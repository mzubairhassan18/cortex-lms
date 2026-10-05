/*
 * /api/settings, /api/settings/connect and /api/models — over the caller's
 * `profiles` row.
 *
 * server.js kept a single settings.json on disk: one provider config shared
 * by everyone using the laptop, which is fine locally and wrong the moment the
 * app sits on the internet. The same four fields already exist per user:
 *
 *   provider -> provider      apiKey -> api_key
 *   baseUrl  -> base_url      keys   -> provider_keys
 *
 * and the profiles policies (read own / write own) decide who may change
 * them, so this file only has to translate names, not police access.
 */

import { HttpError, rest, userId, write } from './supabase.js';
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  applySettingsPatch,
  friendlyNet,
  listModels,
  providerConf,
  settingsView,
  autoRoutes,
  pickAutoModel,
} from './providers.js';

/* role / email / display_name ride along with the provider fields: this is
 * the one call the app makes at boot, so the settings panel can tell whose
 * account it is — and whether to show the Admin link — without a second
 * request. They are read-only here; toProfile() writes an explicit list and
 * never sends them back to the table. */
const COLS = 'provider,api_key,base_url,provider_keys,role,email,display_name';

const fromProfile = (p) => ({
  provider: p.provider || DEFAULT_SETTINGS.provider,
  apiKey: p.api_key || '',
  baseUrl: p.base_url || '',
  keys: p.provider_keys || {},
  role: p.role || '',
  email: p.email || '',
  name: p.display_name || '',
});

const toProfile = (s) => ({
  provider: s.provider,
  api_key: s.apiKey || '',
  base_url: s.baseUrl || '',
  provider_keys: s.keys || {},
});

/** The signed-in user's settings, or the defaults if the row is not there yet. */
export async function loadSettings(env, request) {
  const rows = await rest(env, request, `profiles?select=${COLS}&id=eq.${userId(request)}&limit=1`);
  if (!rows.length) return { ...DEFAULT_SETTINGS, keys: {} };
  return fromProfile(rows[0]);
}

/**
 * Write settings back. A PATCH with no matching row means the profile row has
 * not been created yet (sign-up race, or a user whose row was never
 * bootstrapped), so fall back to an INSERT that claims their own id — the
 * bootstrap policy allows exactly that and nothing more.
 */
export async function saveSettings(env, request, s) {
  const uid = userId(request);
  const body = toProfile(s);
  const rows = await write(env, request, `profiles?id=eq.${uid}`, body, 'PATCH');
  if (!rows || !rows.length) {
    await write(env, request, 'profiles', { id: uid, ...body }, 'POST');
  }
  return s;
}

export async function getSettings(env, request) {
  return json(settingsView(await loadSettings(env, request)));
}

export async function putSettings(env, request, body) {
  const s = applySettingsPatch(await loadSettings(env, request), body || {});
  await saveSettings(env, request, s);
  return json(settingsView(s));
}

/**
 * Connect = validate first (list the provider's models), save only on success
 * — a bad key or URL can never replace working settings.
 */
export async function connect(env, request, body) {
  const s = applySettingsPatch(await loadSettings(env, request), body || {});
  const { p, base } = providerConf(s);
  if (p.needsKey && !s.apiKey) throw new HttpError(400, `Enter the ${p.label} API key.`);

  let models;
  let autoSources;
  if (p.kind === 'auto') {
    // Connect = fresh probe of every reachable source, bypassing the 5-minute
    // cache: the user is explicitly asking "does it work *now*?".
    const routes = await autoRoutes(s, userId(request), true);
    if (!routes.length) {
      throw new HttpError(
        502,
        'Auto found no responding sources — check the network, or add an API key in ⚙ Settings.',
      );
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

  await saveSettings(env, request, s);
  return json({ ...settingsView(s), models, ...(autoSources ? { autoSources } : {}) });
}

export async function getModels(env, request) {
  try {
    const s = await loadSettings(env, request);
    const { p, base } = providerConf(s);
    if (p.kind === 'auto') return json({ models: [{ name: 'auto' }], provider: 'auto' });
    if (p.needsKey && !s.apiKey) {
      throw new HttpError(400, `No API key saved for ${p.label} — open ⚙ Settings and Connect.`);
    }
    return json({ models: await listModels(s, p, base), provider: s.provider });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, friendlyNet(e));
  }
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}
