/*
 * Supabase client + the auth gate.
 *
 * The UMD bundle in /vendor/supabase.js is a classic script loaded before the
 * module graph, so it is available as `window.supabase` — the same pattern
 * marked.min.js already uses. It is vendored rather than pulled from a CDN so
 * there is still no runtime dependency we do not control, and no build step.
 *
 * SECURITY NOTE ON THE GATE: `requireSession()` is a *UX* redirect, not the
 * security boundary. The boundary is RLS — every table is row-filtered by
 * auth.uid() and a signed-out caller sees nothing, whatever the client does.
 * This is why the local-dev bypass below is safe: it cannot expose anyone's data.
 */

import { BASE, at, rel } from './base.js';

/* Project URL + publishable key. Both are public by design — the publishable
 * key is meant to ship in browser code and only carries anon-role privileges,
 * which RLS then narrows further. Never put the service_role key here. */
const SUPABASE_URL = 'https://agyxcfnfvggpbhzyhrsj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_woXb6y4EzUGKIcrn_rgm1Q_sf53LpBy';

/* 'auto' = gate on everywhere except localhost (the local demo must keep
 *          working while auth is still being configured).
 *   'on'  = gate everywhere — use once Google OAuth + Site URL are set.
 *   'off' = no gate anywhere — the escape hatch if we deploy before auth is
 *          ready, so the site never locks its own users out. */
export const GATE = 'on';

export const client =
  typeof window !== 'undefined' && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

/*
 * Attach the session token to our own /api/ requests.
 *
 * There are 25 `fetch('/api/...')` call sites and not one of them carried an
 * Authorization header — v1's Express server needed no credentials because it
 * had no users, it just read a file from disk. The Worker is different: it
 * forwards whatever Authorization it receives to PostgREST, and that is what
 * makes auth.uid() resolve so the RLS policies can do the scoping. Without it
 * every call answers 401 and the app silently falls back to its offline
 * defaults (which is how the provider list collapses to a single "Local
 * (Ollama)" entry — the real list never arrives).
 *
 * Wrapping fetch here rather than editing 25 call sites keeps the token in one
 * place and makes forgetting it impossible for the next call site.
 *
 * Scope is deliberately narrow: same origin AND path /api/. Anything else
 * keeps its original headers — sending our access token cross-origin would be
 * handing it to somebody else's server.
 *
 * getSession() rather than a raw localStorage read, because supabase-js
 * refreshes an expired token inside getSession(); a direct key read would
 * cheerfully send a token that is already dead.
 */
const ORIGIN = typeof location !== 'undefined' ? location.origin : '';

function isOursApi(url) {
  if (!ORIGIN || !url) return false;
  let u;
  try {
    u = new URL(url, ORIGIN);
  } catch {
    return false;
  }
  return u.origin === ORIGIN && u.pathname.startsWith('/api/');
}

function installApiAuth() {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function' || !client) return;
  const original = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const isReq = typeof Request !== 'undefined' && input instanceof Request;
    const url =
      typeof input === 'string' ? input : isReq ? input.url : (input && input.url) || '';
    if (!isOursApi(url)) return original(input, init);

    const headers = new Headers(
      (init && init.headers) || (isReq ? input.headers : undefined),
    );
    if (!headers.has('Authorization')) {
      try {
        const { data } = await client.auth.getSession();
        const token = data && data.session && data.session.access_token;
        if (token) headers.set('Authorization', `Bearer ${token}`);
      } catch {
        /* Signed out or refreshing: let it through unauthenticated. The Worker
           answers 401 and the gate is what decides where the user goes. */
      }
    }

    if (isReq) return original(new Request(input, { headers }));
    return original(input, { ...(init || {}), headers });
  };
}

installApiAuth();

function isLocalhost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

/* Where to send someone after they sign in. Parsed against our own origin so a
 * crafted `next` can never bounce a user off-site. */
export function safeNext(fallback = '/app') {
  const raw = new URLSearchParams(location.search).get('next');
  if (!raw) return fallback;
  try {
    const u = new URL(raw, location.origin);
    if (u.origin !== location.origin) return fallback;
    /* Keep the result app-relative. '/app' survives the site moving under
     * /<repo>/, whereas an absolute path would carry the deploy base twice
     * once at() re-applies it on the way to the redirect. */
    return rel(u.pathname + u.search + u.hash);
  } catch {
    return fallback;
  }
}

/**
 * Resolve true when the caller may continue; otherwise redirect to /login and
 * resolve false.
 */
export async function requireSession(next) {
  if (!client) return true;                          // bundle missing — fail open, RLS still holds
  if (GATE === 'off') return true;
  if (GATE === 'auto' && isLocalhost()) return true;

  const target = next || safeNext();
  try {
    // getSession() reads (and if needed refreshes) the stored session, and it
    // is also what picks up the tokens Supabase appends to the URL after an
    // OAuth redirect — so a fresh sign-in lands here as a real session.
    const { data } = await client.auth.getSession();
    if (data.session) return true;
  } catch {
    /* fall through: better to redirect than to boot a session-less app */
  }
  location.replace(at('login') + '?next=' + encodeURIComponent(target));
  return false;
}

/**
 * Is an OAuth provider switched on for this project?
 *
 * Returns true/false, or null when the check itself failed so callers can
 * tell "it is off" apart from "I don't know".
 *
 * This exists because signInWithOAuth NAVIGATES the browser to the authorize
 * endpoint. If the provider is disabled, that endpoint answers 400 and the raw
 * JSON becomes the page — there is no error object to catch, and no way back.
 * Asking first turns a dead end into a sentence the user can act on.
 * /auth/v1/settings is public: it is the same thing the OAuth button would
 * have asked for a moment later.
 */
export async function providerEnabled(name, timeoutMs = 4000) {
  try {
    const ctrl = new AbortController();
    // Bounded on purpose: the caller keeps the button disabled until this
    // resolves, so an unbounded hang would leave Google permanently unusable.
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, {
        headers: { apikey: SUPABASE_KEY },
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      const on = data.external && data.external[name];
      return typeof on === 'boolean' ? on : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/** For the sign-out control. */
export async function signOut() {
  if (!client) return;
  try { await client.auth.signOut(); } catch { /* already gone */ }
  location.href = BASE;
}
