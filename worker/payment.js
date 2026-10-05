/*
 * Bank-transfer payment (P2.9b): show the account to pay, file a claim.
 *
 * There is no Stripe and no card form — money moves bank to bank and an
 * administrator confirms it. The whole flow is therefore two reads and one
 * insert, and every interesting constraint is already enforced by RLS:
 *
 *   platform_settings  readable by any signed-in user (the account details
 *                      have to be visible before anyone can pay)
 *   payment_claims     INSERT only with user_id = auth.uid() AND status =
 *                      'pending' AND reviewed_at IS NULL — a user literally
 *                      cannot file a claim that is already approved, or one
 *                      that claims to belong to someone else
 *   payment_claims     UPDATE only by private.is_admin()
 *   profiles.plan      changed only by admins, and only by a trigger-guarded
 *                      column set (role / plan / plan_expires_at)
 *
 * The amount is read from platform_settings.plans rather than taken from the
 * request body. Letting the client choose would mean a $1 claim filed against
 * the Team plan, and an admin matching a reference instead of a number.
 */

import { HttpError, rest, userId, write } from './supabase.js';

const CLAIM_COLS =
  'id,tier,amount_cents,currency,reference,status,admin_note,created_at,reviewed_at';

const shape = (r) => ({
  id: r.id,
  tier: r.tier,
  amountCents: r.amount_cents,
  currency: r.currency,
  reference: r.reference,
  status: r.status,
  note: r.admin_note || '',
  at: Date.parse(r.created_at) || 0,
  reviewedAt: r.reviewed_at ? Date.parse(r.reviewed_at) : 0,
});

async function settingsMap(env, request) {
  const rows = await rest(env, request, 'platform_settings?select=key,value');
  const map = new Map();
  for (const r of rows || []) map.set(r.key, r.value);
  return map;
}

/** Everything the payment screen needs, in one round trip. */
export async function paymentInfo(env, request) {
  const uid = userId(request);
  const map = await settingsMap(env, request);
  const profile = await rest(
    env,
    request,
    `profiles?select=plan,display_name,email&id=eq.${uid}&limit=1`,
  );
  // RLS already narrows this to their own claims (or all of them, if they are
  // an admin) — the Worker does not re-filter, it just shapes what it gets.
  const claims = await rest(
    env,
    request,
    `payment_claims?select=${CLAIM_COLS}&order=created_at.desc&limit=20`,
  );

  return json({
    notice: map.get('payment_notice') || null,
    bank: map.get('bank_details') || null,
    plans: map.get('plans') || {},
    plan: (profile[0] && profile[0].plan) || 'free',
    userId: uid,
    email: (profile[0] && profile[0].email) || '',
    claims: (claims || []).map(shape),
  });
}

export async function createClaim(env, request, body) {
  const uid = userId(request);
  const tier = String((body && body.tier) || '').toLowerCase();
  if (tier !== 'pro' && tier !== 'team') {
    throw new HttpError(400, 'Choose Pro or Team to pay for.');
  }
  const reference = String((body && body.reference) || '').trim().slice(0, 120);
  if (!reference) {
    throw new HttpError(400, 'Paste the transfer reference so it can be matched.');
  }

  const map = await settingsMap(env, request);
  const plan = (map.get('plans') || {})[tier];
  if (!plan || !Number.isFinite(+plan.price)) {
    throw new HttpError(400, 'That plan is not available right now.');
  }
  const amount_cents = Math.round(+plan.price * 100);
  const bank = map.get('bank_details') || {};
  const currency = String(bank.currency || 'USD').toUpperCase().slice(0, 3);

  // One claim in flight at a time per tier: filing twice does not get reviewed
  // faster, it just gives the admin two rows to reconcile for one transfer.
  const pending = await rest(
    env,
    request,
    `payment_claims?select=id&user_id=eq.${uid}&tier=eq.${tier}&status=eq.pending&limit=1`,
  );
  if (pending.length) {
    throw new HttpError(
      409,
      `You already have a pending ${plan.name || tier} claim — an administrator is reviewing it.`,
    );
  }

  const [row] = await write(
    env,
    request,
    'payment_claims',
    { tier, amount_cents, currency, reference },
    'POST',
  );
  return json({ claim: shape(row) });
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}
