/*
 * Bank-transfer payment screen (P2.9b).
 *
 * This is a static page, so the sign-in check here is the same UX redirect the
 * app uses: `requireSession('/payment')` bounces a visitor to
 * /login?next=%2Fpayment. It is not the boundary — the Worker refuses /api/payment
 * without a JWT, and RLS refuses payment_claims rows whose user_id is not
 * auth.uid(). A visitor who skips this redirect still reads nothing.
 *
 * The render functions are plain DOM rather than Preact on purpose: this page
 * ships before the app bundle and must work with JS but no framework state.
 */

import { requireSession } from './auth.js';

const $ = (id) => document.getElementById(id);

const money = (cents, currency) =>
  `${((Number(cents) || 0) / 100).toFixed(2)} ${currency || 'USD'}`;

/* Bank details arrive as an object of optional keys — render only what the
 * operator actually filled in rather than printing empty rows. */
const BANK_LABELS = [
  ['account_name', 'Account name'],
  ['account_number', 'Account number / IBAN'],
  ['bank', 'Bank'],
  ['branch', 'Branch'],
  ['swift', 'SWIFT / BIC'],
  ['currency', 'Currency'],
];

let info = null;
let selected = 'pro';

function esc(v) {
  return String(v == null ? '' : v).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

async function boot() {
  if (!(await requireSession('/payment'))) return;

  const res = await fetch('/api/payment');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $('bank-details').innerHTML = `<div class="empty">${esc(
      body.error || 'Could not load payment details.',
    )}</div>`;
    return;
  }

  info = await res.json();
  renderPlan();
  renderBank();
  renderTiers();
  renderClaims();
  wire();
}

function renderPlan() {
  const plan = info.plan || 'free';
  /* The user ID doubles as the transfer reference, so it is printed even on
   * the paid plans — you cannot pay for an upgrade without it. */
  const who = `${esc(info.email || '')} — user ID <b>${esc(info.userId)}</b>`;
  $('plan-now').innerHTML =
    plan === 'free'
      ? `You are on the <b>Free</b> plan. Signed in as ${who}.`
      : `You are on the <b>${esc(plan.toUpperCase())}</b> plan — ${who}.`;

  /* payment_notice is an object {title, body} in platform_settings, and the
   * bank row carries its own reference_note. Render both as text — stringifying
   * the object here would print "[object Object]" on the card. */
  const notice = info.notice || {};
  const note = [notice.body, info.bank && info.bank.reference_note]
    .filter(Boolean)
    .join(' ');
  $('bank-note').hidden = !note;
  if (note) $('bank-note').textContent = note;
}

function renderBank() {
  const el = $('bank-details');
  const bank = info.bank;
  if (!bank) {
    el.innerHTML = '<div class="empty">No bank details configured yet.</div>';
    return;
  }
  /* Every field in bank_details is optional and operator-filled, so an empty
   * row is a real state: the account exists but nobody has typed the number
   * in. Say that instead of rendering a label with nothing after it. */
  if (!bank.account_number) {
    el.innerHTML =
      '<div class="empty">Bank details have not been configured yet.</div>';
    return;
  }
  const rows = BANK_LABELS.filter(([k]) => bank[k])
    .map(
      ([k, label]) =>
        `<div class="bank-row"><dt>${label}</dt><dd>${esc(bank[k])}</dd></div>`,
    )
    .join('');
  el.innerHTML =
    rows +
    `<div class="bank-row"><dt>Transfer reference</dt><dd>${esc(
      info.userId || '',
    )}</dd></div>`;
}

function renderTiers() {
  const plans = info.plans || {};
  const order = ['pro', 'team'].filter((t) => plans[t]);
  if (!order.length) {
    $('tier-pick').innerHTML = '<div class="empty">No plans available.</div>';
    return;
  }
  if (!order.includes(selected)) selected = order[0];
  /* `period` is the key platform_settings actually uses ('month' | 'forever'),
   * not `interval` — reading the wrong one silently drops the suffix. */
  const suffixFor = (period) => {
    const p = String(period || 'month').toLowerCase();
    if (p === 'forever') return '';
    if (p === 'year' || p === 'yr') return '/yr';
    return '/mo';
  };
  $('tier-pick').innerHTML = order
    .map((t) => {
      const p = plans[t];
      const price = Number(p.price);
      const suffix = suffixFor(p.period);
      return `<label class="tier-opt">
        <input type="radio" name="tier" value="${esc(t)}"${
          t === selected ? ' checked' : ''
        }>
        <span>
          <b>${esc(p.name || t)}</b>
          <em>${esc((Number.isFinite(price) ? price.toFixed(2) : '0.00') + suffix)}</em>
        </span>
      </label>`;
    })
    .join('');
}

function renderClaims() {
  const list = info.claims || [];
  const el = $('claims-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">No claims yet.</div>';
    return;
  }
  el.innerHTML = list
    .map((c) => {
      const when = c.at
        ? new Date(c.at).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })
        : '';
      return `<div class="claim">
        <span class="who">${esc(String(c.tier || '').toUpperCase())}</span>
        <span class="amt">${esc(money(c.amountCents, c.currency))}</span>
        <span class="ref">${esc(c.reference || '')}</span>
        <span class="chip ${esc(c.status)}">${esc(c.status)}</span>
        <span class="when">${esc(when)}</span>
        ${c.note ? `<span class="note">${esc(c.note)}</span>` : ''}
      </div>`;
    })
    .join('');
}

function setMsg(text, ok) {
  const el = $('claim-msg');
  el.textContent = text;
  el.className = 'pay-msg ' + (text ? (ok ? 'ok' : 'err') : '');
}

async function submitClaim() {
  const btn = $('claim-send');
  const reference = $('claim-ref').value.trim();
  if (!reference) {
    setMsg('Paste the transfer reference so it can be matched.', false);
    $('claim-ref').focus();
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Filing…';
  setMsg('', true);

  try {
    const res = await fetch('/api/payment/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: selected, reference }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(body.error || 'Could not file the claim.', false);
      return;
    }
    $('claim-ref').value = '';
    setMsg('Claim filed. An administrator will review it.', true);
    /* Re-read rather than push the returned row locally: RLS is what proves
     * the claim landed under their own user_id, and the list should reflect
     * what the server will actually show them. */
    const reread = await fetch('/api/payment');
    if (reread.ok) {
      info = await reread.json();
      renderPlan();
      renderClaims();
    }
  } catch {
    setMsg('Network error — try again.', false);
  } finally {
    btn.disabled = false;
    btn.textContent = 'I have paid';
  }
}

function wire() {
  $('tier-pick').addEventListener('change', (e) => {
    if (e.target && e.target.name === 'tier') selected = e.target.value;
  });
  $('claim-send').addEventListener('click', submitClaim);
  $('claim-ref').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitClaim();
  });
}

boot();
