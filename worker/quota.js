/*
 * Daily request quota (P2.10).
 *
 * One RPC, one round trip: consume_quota() reads the plan's req_per_day and
 * increments today's usage row in the SAME statement — ON CONFLICT ... DO
 * UPDATE ... WHERE requests < limit — so there is no read-then-write window
 * and no four-call latency tax on every message. It lives in the database
 * rather than here because that is also where the limit and the counter are.
 *
 * Called from exactly one place: POST /api/chat. Reading, searching,
 * exporting, graphing and everything else offline cost nothing, which is what
 * the pricing page promises, and nothing else ever authenticates as a user
 * just to burn quota — no heartbeat, no health probe, no background job.
 *
 * Failure is loud on purpose. A quota check that fails open would silently
 * grant unlimited usage while the pricing page advertised 50 a day; a check
 * that fails closed blocks the message with a real sentence. Supabase is
 * already required to serve the settings this request needs, so a quota
 * outage is not a new way for chat to fail.
 */

import { HttpError, rest } from './supabase.js';

/**
 * Consume one request against the caller's daily limit.
 *
 * @returns {{ok:true, used:number, limit:number, plan:string}}
 * @throws  HttpError 429 when the limit is already spent
 */
export async function consumeQuota(env, request, kind) {
  let r;
  try {
    r = await rest(env, request, 'rpc/consume_quota', {
      method: 'POST',
      body: { p_kind: kind || 'chat' },
    });
  } catch (e) {
    // PostgREST reports a plpgsql `raise exception` as 400/P0001 carrying our
    // own message, so "Sign in first." reaches the caller as itself. Anything
    // else (function missing, network, RLS refusal) is an infrastructure
    // failure and must not be mistaken for "you have used your quota".
    if (e instanceof HttpError) throw e;
    throw new HttpError(503, 'Could not check your daily limit. Try again in a moment.');
  }

  if (r && r.ok) return r;
  throw new HttpError(429, overLimit(r));
}

/* ok:false comes back as a normal 200 with a body, because being at the limit
 * is an expected outcome and not a server fault. */
function overLimit(r) {
  const used = r && Number.isFinite(+r.used) ? +r.used : null;
  const limit = r && Number.isFinite(+r.limit) ? +r.limit : null;
  if (used != null && limit != null) {
    return `Daily limit reached — ${used} of ${limit} requests used today. It resets at midnight UTC.`;
  }
  return 'Daily limit reached. It resets at midnight UTC.';
}
