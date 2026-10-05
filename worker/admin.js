/*
 * Admin dashboard API (P2.10).
 *
 * Three endpoints' worth of behaviour behind one gate: requireAdmin() reads the
 * caller's OWN profiles row (RLS allows id = auth.uid() unconditionally) and
 * refuses unless role = 'admin'. The role is read from the database, never
 * from a claim the client controls, and every query below is still subject to
 * RLS — admin policies (`private.is_admin()`) are what make the cross-user
 * reads return rows at all, so a forged gate could not widen anything.
 *
 * The two interesting operations are both about money:
 *
 *   overview  users, requests processed, and per-plan usage against the
 *             limits platform_settings.plans advertises, so a plan running
 *             out of room is visible before it does
 *   review    approve a bank-transfer claim. The PLAN is activated FIRST and
 *             the claim flipped SECOND — the reverse order is how an admin
 *             ends up with a claim marked approved and a user still on Free,
 *             which is exactly the bug the `profiles: admin write` policy was
 *             added to close.
 */

import { HttpError, rest, userId, ms } from './supabase.js';

const CLAIM_COLS =
  'id,user_id,tier,amount_cents,currency,reference,status,admin_note,created_at,reviewed_at';

async function requireAdmin(env, request) {
  const uid = userId(request);
  const rows = await rest(env, request, `profiles?select=id,role&id=eq.${uid}&limit=1`);
  if (!rows[0] || rows[0].role !== 'admin') {
    throw new HttpError(403, 'Administrator access only.');
  }
  return uid;
}

/** The dashboard. One round trip per table, aggregated here. */
export async function adminOverview(env, request) {
  const adminId = await requireAdmin(env, request);

  const [profiles, usage, claims, settings] = await Promise.all([
    rest(env, request, 'profiles?select=id,role,plan,created_at'),
    // Bound to a year rather than "everything": one row per user per day
    // grows without limit, and the dashboard headline is "processed", which a
    // window answers honestly. Requests today is a separate, exact number.
    rest(env, request, 'usage_daily?select=user_id,day,requests&day=gte.' + oneYearAgo()),
    rest(env, request, `payment_claims?select=${CLAIM_COLS}&order=created_at.desc&limit=50`),
    rest(env, request, 'platform_settings?select=key,value'),
  ]);

  const byKey = new Map((settings || []).map((r) => [r.key, r.value]));
  const plans = byKey.get('plans') || {};
  const today = utcDay();

  const byPlan = {};
  let admins = 0;
  for (const p of profiles || []) {
    const tier = p.plan || 'free';
    byPlan[tier] = (byPlan[tier] || 0) + 1;
    if (p.role === 'admin') admins += 1;
  }

  const todayByPlan = {};
  let requestsToday = 0;
  let requestsWindow = 0;
  const perUser = new Map((profiles || []).map((p) => [p.id, p.plan || 'free']));
  for (const u of usage || []) {
    const n = Number(u.requests) || 0;
    requestsWindow += n;
    if (u.day === today) {
      requestsToday += n;
      const tier = perUser.get(u.user_id) || 'free';
      todayByPlan[tier] = (todayByPlan[tier] || 0) + n;
    }
  }

  // Claimants are matched by id so the queue shows who filed it, not a bare
  // uuid the admin would have to look up elsewhere.
  const claimantIds = [...new Set((claims || []).map((c) => c.user_id).filter(Boolean))];
  const claimants = claimantIds.length
    ? await rest(env, request, `profiles?select=id,email,plan&id=in.(${claimantIds.join(',')})`)
    : [];
  const byId = new Map((claimants || []).map((p) => [p.id, p]));

  return json({
    you: adminId,
    users: {
      total: (profiles || []).length,
      admins,
      byPlan,
    },
    requests: {
      today: requestsToday,
      window: requestsWindow,
      todayByPlan,
      since: oneYearAgo(),
    },
    plans,
    claims: (claims || []).map((c) => ({
      id: c.id,
      userId: c.user_id,
      email: (byId.get(c.user_id) || {}).email || '',
      userPlan: (byId.get(c.user_id) || {}).plan || 'free',
      tier: c.tier,
      amountCents: c.amount_cents,
      currency: c.currency,
      reference: c.reference,
      status: c.status,
      note: c.admin_note || '',
      at: ms(c.created_at),
      reviewedAt: ms(c.reviewed_at),
    })),
  });
}

/**
 * Approve or reject one claim.
 *
 * The amount and tier come from the stored claim, never from the request body
 * — the admin is confirming that money arrived, not choosing what it bought.
 */
export async function reviewClaim(env, request, id, body) {
  const adminId = await requireAdmin(env, request);

  const action = String((body && body.action) || '').toLowerCase();
  if (action !== 'approve' && action !== 'reject') {
    throw new HttpError(400, 'Choose approve or reject.');
  }
  const note = String((body && body.note) || '').trim().slice(0, 300);

  if (!/^[0-9a-f-]{36}$/i.test(String(id))) {
    throw new HttpError(400, 'That is not a claim id.');
  }

  const found = await rest(env, request, `payment_claims?select=${CLAIM_COLS}&id=eq.${id}&limit=1`);
  const claim = found[0];
  if (!claim) throw new HttpError(404, 'No such claim.');
  if (claim.status !== 'pending') {
    throw new HttpError(409, `That claim was already ${claim.status}.`);
  }

  if (action === 'approve') {
    /* Plan first. If this throws, nothing was changed and the queue still
     * shows a pending claim the admin can retry. The other order would leave
     * a claim reading "approved" while the user stayed on Free. */
    await rest(env, request, `profiles?id=eq.${claim.user_id}`, {
      method: 'PATCH',
      body: { plan: claim.tier },
    });
  }

  const updated = await rest(env, request, `payment_claims?id=eq.${id}`, {
    method: 'PATCH',
    body: {
      status: action === 'approve' ? 'approved' : 'rejected',
      admin_note: note,
      reviewed_by: adminId,
      reviewed_at: new Date().toISOString(),
    },
    headers: { Prefer: 'return=representation' },
  });

  const row = (updated || [])[0] || claim;
  return json({
    claim: {
      id: row.id,
      userId: row.user_id,
      tier: row.tier,
      amountCents: row.amount_cents,
      currency: row.currency,
      reference: row.reference,
      status: row.status,
      note: row.admin_note || '',
      at: ms(row.created_at),
      reviewedAt: ms(row.reviewed_at),
    },
    activated: action === 'approve' ? claim.tier : null,
  });
}

const utcDay = () => new Date().toISOString().slice(0, 10);
const oneYearAgo = () => new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}
