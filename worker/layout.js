/*
 * /api/layout — the graph view's ALIGNED / FREE layout.
 *
 * The graph has always placed its own nodes: conversations stacked in a column,
 * explanations hung off to the right by depth, recomputed on every render. FREE
 * keeps that computed layout as the FALLBACK and lets a saved coordinate win,
 * so a conversation can be dragged clear of the others and stay there.
 *
 * It lives on the caller's `profiles` row beside the other per-user settings,
 * for the same reason /api/settings does: RLS already answers "whose is this",
 * so there is no second policy, no second ownership rule and nothing here that
 * has to be trusted. The Worker sanitises and forwards; it never decides access.
 *
 * The `profiles_guard` trigger does not object — it only raises when role, plan
 * or plan_expires_at change — so an owner writing this row is the expected case.
 */

import { rest, userId, write } from './supabase.js';

const MODES = new Set(['aligned', 'free']);
const MAX_POSITIONS = 400;   // ~50 conversations + their explanations
const MAX_KEY = 128;         // 'c:' / 'e:' + an id, generously
const MAX_COORD = 1e6;       // world units — a value past this is a bug, not a canvas
const MAX_BODY = 512 * 1024; // the whole layout is a few KB; anything bigger is not one

/**
 * Keep exactly what graph.js can use and nothing else: a known mode, and a
 * flat map of string key -> rounded finite {x, y}.
 *
 * Negative coordinates pass on purpose. #graph-canvas has no overflow rule and
 * #graph-edges sets overflow:visible, so the world left of the origin paints —
 * that is what lets the board be dragged in any direction. Normalising here
 * would fight the client, which saves exactly what it displays.
 */
function sanitize(raw) {
  const mode = raw && typeof raw === 'object' && MODES.has(raw.mode) ? raw.mode : 'aligned';
  const src = raw && typeof raw === 'object' && raw.positions && typeof raw.positions === 'object'
    ? raw.positions
    : {};

  const positions = {};
  let n = 0;
  for (const [k, v] of Object.entries(src)) {
    if (n >= MAX_POSITIONS) break;
    if (typeof k !== 'string' || !k || k.length > MAX_KEY) continue;
    if (!v || typeof v !== 'object') continue;
    // typeof checks rather than Number(): Number(null) is 0 and Number('') is 0,
    // which would silently turn a malformed entry into the origin.
    if (typeof v.x !== 'number' || typeof v.y !== 'number') continue;
    if (!Number.isFinite(v.x) || !Number.isFinite(v.y)) continue;
    if (Math.abs(v.x) > MAX_COORD || Math.abs(v.y) > MAX_COORD) continue;
    positions[k] = { x: Math.round(v.x), y: Math.round(v.y) };
    n++;
  }
  return { mode, positions };
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}

/** GET /api/layout -> { mode, positions } (always present, never null). */
export async function getLayout(env, request) {
  const uid = userId(request);
  const rows = await rest(env, request, `profiles?select=graph_layout&id=eq.${uid}&limit=1`);
  const raw = rows && rows[0] ? rows[0].graph_layout : null;
  return json(sanitize(raw));
}

/** PUT /api/layout <- { mode, positions }; returns what was actually stored. */
export async function putLayout(env, request, body) {
  const uid = userId(request);
  const size = Number(request.headers.get('content-length') || 0);
  if (size && size > MAX_BODY) {
    return new Response(JSON.stringify({ error: 'Layout too large.' }), {
      status: 413,
      headers: { 'content-type': 'application/json' },
    });
  }
  const next = sanitize(body);
  await write(env, request, `profiles?id=eq.${uid}`, { graph_layout: next }, 'PATCH');
  // Echo the sanitised form: if the client sent 900 entries and 400 survived,
  // it should replace its local copy rather than believe all of them did.
  return json(next);
}
