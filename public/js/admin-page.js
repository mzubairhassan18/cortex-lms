/*
 * Admin dashboard (P2.10).
 *
 * Same three-layer gate as everywhere else: requireSession() is the UX
 * redirect, /api/admin reads profiles.role from the database, and the rows
 * themselves only exist in the response because private.is_admin() lets RLS
 * return them. Nothing here decides what the caller may see — it only renders
 * what the Worker was allowed to read.
 *
 * Plain DOM rather than Preact: this page ships alongside pricing and payment,
 * before the app bundle, and has no state worth hydrating.
 */

import { requireSession } from './auth.js';

const $ = (id) => document.getElementById(id);

const money = (cents, currency) =>
  `${((Number(cents) || 0) / 100).toFixed(2)} ${currency || 'USD'}`;

const esc = (v) =>
  String(v == null ? '' : v).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const PLAN_ORDER = ['free', 'pro', 'team'];

let data = null;

async function boot() {
  if (!(await requireSession('/admin'))) return;
  await load();
}

async function load() {
  const res = await fetch('/api/admin');
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    if (res.status === 403) {
      $('kpis').innerHTML =
        `<div class="denied" style="grid-column:1/-1"><b>Administrator access only.</b><br>` +
        `${esc(body.error || 'This account is not an admin.')}</div>`;
      $('gauges').innerHTML = '';
      $('claims').innerHTML = '';
      return;
    }
    $('kpis').innerHTML =
      `<div class="denied" style="grid-column:1/-1">${esc(
        body.error || 'Could not load the dashboard.',
      )}</div>`;
    return;
  }

  data = body;
  renderKpis();
  renderGauges();
  renderClaims();
}

function renderKpis() {
  const u = data.users || {};
  const r = data.requests || {};
  const pending = (data.claims || []).filter((c) => c.status === 'pending').length;

  const cards = [
    ['Users', u.total ?? 0, `${u.admins || 0} admin`],
    ['Requests today', r.today ?? 0, 'since midnight UTC'],
    ['Requests processed', r.window ?? 0, `last 365 days`],
    ['Claims pending', pending, `${(data.claims || []).length} total`],
  ];

  $('kpis').innerHTML = cards
    .map(
      ([label, value, hint]) => `<div class="kpi">
        <div class="k-label">${esc(label)}</div>
        <div class="k-value">${esc(value)}</div>
        <div class="k-hint">${esc(hint)}</div>
      </div>`,
    )
    .join('');
}

/*
 * The gauge is plan-usage against the pooled daily allowance.
 *
 * free and pro are single-seat plans, so the allowance is simply
 * req_per_day x users. Team advertises 2,000 requests/day shared by 10 seats,
 * so the pool repeats per complete team rather than per head — 1 user on Team
 * has 2,000, 11 users have 4,000. Reading req_per_day as per-head would show a
 * two-person team with 4000 available when the pricing page says 2000.
 */
function allowanceFor(plan, users) {
  const perDay = Number(plan.req_per_day) || 0;
  const seats = Math.max(1, Number(plan.seats) || 1);
  if (!users) return 0;
  const teams = Math.max(1, Math.ceil(users / seats));
  return perDay * teams;
}

function renderGauges() {
  const plans = data.plans || {};
  const byPlan = data.users.byPlan || {};
  const todayByPlan = data.requests.todayByPlan || {};

  const rows = PLAN_ORDER.filter((t) => plans[t]);
  if (!rows.length) {
    $('gauges').innerHTML = '<div class="empty">No plans configured.</div>';
    return;
  }

  $('gauges').innerHTML = rows
    .map((t) => {
      const plan = plans[t];
      const users = Number(byPlan[t]) || 0;
      const used = Number(todayByPlan[t]) || 0;
      const limit = allowanceFor(plan, users);
      const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

      // 70 / 85 / 95 — the three points where a plan stops being comfortably
      // inside its limit and starts being worth a word from the admin.
      const level = pct >= 95 ? 'crit' : pct >= 85 ? 'high' : pct >= 70 ? 'warn' : '';
      const noteCls = pct >= 95 ? 'crit' : pct >= 70 ? 'alert' : '';
      const note = !users
        ? 'No users on this plan yet.'
        : pct >= 95
          ? `At the limit — ${used} of ${limit} used today.`
          : pct >= 70
            ? `Running close — ${used} of ${limit} used today.`
            : `${used} of ${limit} requests used today.`;

      return `<div class="gauge">
        <div class="gauge-head">
          <b>${esc(plan.name || t)}</b>
          <span class="g-users">${users} ${users === 1 ? 'user' : 'users'} · ${esc(
            plan.req_per_day,
          )}/day${Number(plan.seats) > 1 ? ` x ${esc(plan.seats)} seats` : ''}</span>
          <span class="g-pct">${pct}%</span>
        </div>
        <div class="gauge-bar"><div class="gauge-fill ${level}" style="width:${pct}%"></div></div>
        <div class="gauge-note ${noteCls}">${esc(note)}</div>
      </div>`;
    })
    .join('');
}

function renderClaims() {
  const claims = data.claims || [];
  const el = $('claims');
  if (!claims.length) {
    el.innerHTML = '<div class="empty">No claims filed yet.</div>';
    return;
  }

  el.innerHTML = claims
    .map((c) => {
      const when = c.at
        ? new Date(c.at).toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : '';
      const body =
        c.status === 'pending'
          ? `<div class="claim-actions">
               <input type="text" maxlength="300" placeholder="Note (optional) — e.g. matched to transfer 1234"
                      data-note-for="${esc(c.id)}">
               <button class="btn-approve" data-approve="${esc(c.id)}">Approve</button>
               <button class="btn-reject" data-reject="${esc(c.id)}">Reject</button>
             </div>`
          : c.note
            ? `<div class="note">${esc(c.note)}</div>`
            : '';

      return `<div class="claim" data-claim="${esc(c.id)}">
        <div class="claim-row">
          <span class="who">${esc(c.tier ? String(c.tier).toUpperCase() : '')}
            <small>${esc(c.email || 'unknown account')}</small></span>
          <span class="amt">${esc(money(c.amountCents, c.currency))}</span>
          <span class="ref">ref ${esc(c.reference || '—')}</span>
          <span class="chip ${esc(c.status)}">${esc(c.status)}</span>
          <span class="when">${esc(when)}</span>
        </div>
        <div class="uid">${esc(c.userId)} · currently ${esc(c.userPlan)}</div>
        ${body}
      </div>`;
    })
    .join('');
}

function setMsg(text, ok) {
  const el = $('adm-msg');
  el.textContent = text || '';
  el.className = 'adm-msg ' + (text ? (ok ? 'ok' : 'err') : '');
}

async function review(id, action) {
  const row = document.querySelector(`[data-claim="${id}"]`);
  if (!row) return;
  const noteInput = row.querySelector(`[data-note-for="${id}"]`);
  const note = noteInput ? noteInput.value.trim() : '';
  const buttons = row.querySelectorAll('button');
  buttons.forEach((b) => (b.disabled = true));
  setMsg('', true);

  try {
    const res = await fetch(`/api/admin/claims/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, note }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMsg(body.error || 'That did not go through.', false);
      buttons.forEach((b) => (b.disabled = false));
      return;
    }
    setMsg(
      body.activated
        ? `${String(body.activated).toUpperCase()} activated for that account.`
        : 'Claim rejected.',
      true,
    );
    /* Re-read rather than patching the row locally: the dashboard should show
     * what the server will still say after a reload, which is also what proves
     * the plan actually changed. */
    await load();
  } catch {
    setMsg('Network error — try again.', false);
    buttons.forEach((b) => (b.disabled = false));
  }
}

document.addEventListener('click', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement)) return;
  if (t.dataset.approve) review(t.dataset.approve, 'approve');
  else if (t.dataset.reject) review(t.dataset.reject, 'reject');
});

boot();
