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
export const GATE = 'auto';

export const client =
  typeof window !== 'undefined' && window.supabase
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

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
    return u.origin === location.origin ? u.pathname + u.search + u.hash : fallback;
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
  location.replace('/login?next=' + encodeURIComponent(target));
  return false;
}

/** For the sign-out control. */
export async function signOut() {
  if (!client) return;
  try { await client.auth.signOut(); } catch { /* already gone */ }
  location.href = '/';
}
