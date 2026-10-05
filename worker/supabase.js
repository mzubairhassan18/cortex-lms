/*
 * PostgREST through the caller's own JWT.
 *
 * The one property that matters here: this never uses the service role key.
 * It forwards the Authorization header the request arrived with, so PostgREST
 * authenticates as that user, auth.uid() resolves, and the RLS policies from
 * the P2 migrations (`user_id = auth.uid()`) do the scoping. The Worker stays
 * a translator and not a trust boundary — if a handler forgets a WHERE clause
 * the database still refuses the row, which is the whole point of having
 * written the policies at all.
 *
 * An Edge Function doing the same job with the service role would have to
 * re-implement that check by hand in every handler. This way it is enforced
 * once, in the database, for every route.
 */

/** Same shape server.js produces: time in base 36 plus a short random tail. */
export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Thrown anywhere in the Worker; index.js turns it into the response. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * One PostgREST call.
 *
 * @param {string} path  e.g. `conversations?select=...`
 */
export async function rest(env, request, path, { method = 'GET', body, headers = {} } = {}) {
  const auth = request.headers.get('Authorization');
  if (!auth) throw new HttpError(401, 'Sign in first.');

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_PUBLISHABLE_KEY,
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    let message = text.slice(0, 300);
    let code = res.status;
    try {
      const j = JSON.parse(text);
      message = j.message || j.hint || message;
      // PostgREST reports SQLSTATE in .code; 23505 is the unique violation a
      // duplicate id produces, which clients expect as 409 rather than 500.
      if (j.code === '23505') code = 409;
    } catch { /* keep the raw body */ }
    throw new HttpError(code, message);
  }

  if (res.status === 204) return null;
  const out = await res.json();
  return out;
}

/** PostgREST write that returns the stored row (`Prefer: return=representation`). */
export function write(env, request, path, body, method) {
  return rest(env, request, path, {
    method,
    body,
    headers: { Prefer: 'return=representation' },
  });
}

/**
 * The caller's user id, read out of their own JWT.
 *
 * Only ever used to build an explicit `id=eq.<uid>` filter or an INSERT that
 * claims their own row — never to decide *whether* they may touch it. The
 * token is verified by PostgREST, not here, so a hand-edited `sub` buys
 * nothing: the query would still be rejected by RLS. Decoding is purely so a
 * PATCH can name its target instead of relying on "update everything the
 * policy lets me see".
 */
export function userId(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length < 2) throw new HttpError(401, 'Sign in first.');
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64));
    if (!payload.sub) throw new Error('missing sub');
    return payload.sub;
  } catch {
    throw new HttpError(401, 'Sign in first.');
  }
}

/** timestamptz -> the epoch milliseconds server.js always sent. */
export const ms = (v) => (v ? Date.parse(v) : 0);

/** `{}` is the column default for `explains`, but the client treats null as
 *  "no explainer tree yet" — the same thing server.js writes back on save. */
export const objOrNull = (v) =>
  v && typeof v === 'object' && Object.keys(v).length ? v : null;
