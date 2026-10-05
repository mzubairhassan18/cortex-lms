/*
 * GET /api/search?q=…&workspace=… — "which of my conversations holds this?"
 *
 * The matching is one call to public.search_conversations, an INVOKER
 * function, so RLS still picks the rows and this file never becomes the trust
 * boundary — same rule as everything else in worker/supabase.js. What it adds
 * is the one translation PostgREST cannot do on its own: jsonb has no
 * substring operator, so the ILIKE has to run in SQL.
 *
 * ONLY IDS COME BACK, and that is deliberate. The caller is a camera looking
 * for somewhere to point: it switches to the conversation, finds the explain
 * that holds the phrase in its own already-loaded state, and flies there.
 * Message bodies would be shipped across the wire only to be thrown away —
 * and the DB never has to hand over content it does not need to hand over.
 */

import { HttpError, rest } from './supabase.js';

// A search term is a phrase someone typed into a box, not a document. Past
// this it is either a paste accident or an attempt to make the database do
// work nobody asked for.
const MAX_Q = 200;

export async function search(env, request, url) {
  const q = String(url.searchParams.get('q') || '').trim();
  if (!q) throw new HttpError(400, 'Type something to search for.');
  if (q.length > MAX_Q) throw new HttpError(400, 'That is too long to search for.');

  // PostgREST takes text for the workspace column (conversations.workspace_id
  // is text), and null — not "" — has to mean "no filter", which is what the
  // function's `p_workspace is null` branch expects.
  const ws = String(url.searchParams.get('workspace') || '').trim() || null;

  const ids = await rest(env, request, 'rpc/search_conversations', {
    method: 'POST',
    body: { p_q: q, p_workspace: ws },
  });

  return json({ q, ids: Array.isArray(ids) ? ids.filter((s) => typeof s === 'string') : [] });
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}
