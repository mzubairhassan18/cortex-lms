/*
 * Workspace CRUD, backed by the `workspaces` table.
 *
 * The one shape difference from the storage layer: every response carries a
 * `conversationCount`, because the zoomed-out workspace cards render it. On a
 * laptop that was one pass over a JSON file; here it is one extra query whose
 * ids are tallied in JS — cheap at personal scale, and it avoids a database
 * function that would need its own migration.
 *
 * Deleting a workspace that still holds conversations is a 409 unless
 * `?force=1`, and even then the conversations are *archived*, never dropped —
 * same promise the original made when it moved them to
 * conversations.deleted.json. server.js also guarded "the last workspace
 * cannot be deleted"; the client relies on there always being one to land in.
 */

import { HttpError, ms, newId, rest, write } from './supabase.js';

const COLS = 'id,name,created_at,updated_at';

const row = (r, conversationCount) => ({
  id: r.id,
  name: r.name,
  createdAt: ms(r.created_at),
  updatedAt: ms(r.updated_at),
  conversationCount: conversationCount || 0,
});

/** Live (non-archived) conversation counts, keyed by workspace id. */
async function counts(env, request) {
  const rows = await rest(
    env,
    request,
    'conversations?select=workspace_id&archived=eq.false',
  );
  const map = new Map();
  for (const c of rows || []) map.set(c.workspace_id, (map.get(c.workspace_id) || 0) + 1);
  return map;
}

export async function listWorkspaces(env, request) {
  let rows = await rest(env, request, `workspaces?select=${COLS}&order=created_at.asc`);

  /* server.js ran migrateWorkspaces() at startup and guaranteed there was
   * always exactly one workspace to land in, because every conversation must
   * belong to one. A Worker has no startup — it is stateless and may be
   * running someone else's request a millisecond ago — so the same guarantee
   * is made on first read instead, once per user. Without it a fresh sign-in
   * renders an empty app whose first message is refused with "Create a
   * workspace first.", with nothing on screen explaining why. */
  if (!rows.length) {
    try {
      const [created] = await write(
        env,
        request,
        'workspaces',
        { id: newId(), name: 'My workspace' },
        'POST',
      );
      rows = [created];
    } catch {
      // If the insert is refused (expired token mid-flight, policy change),
      // answer with the empty list rather than failing the read: the UI has
      // an empty state for exactly this, and a 500 here would break app boot.
      rows = [];
    }
  }

  const by = await counts(env, request);
  return json(rows.map((r) => row(r, by.get(r.id))));
}

export async function createWorkspace(env, request, body) {
  const name = String((body && body.name) || '').trim().slice(0, 60);
  if (!name) throw new HttpError(400, 'A workspace needs a name.');
  const [created] = await write(
    env,
    request,
    'workspaces',
    { id: newId(), name },
    'POST',
  );
  return json(row(created, 0));
}

export async function updateWorkspace(env, request, id, body) {
  const patch = {};
  if (body && typeof body.name === 'string') {
    const name = body.name.trim().slice(0, 60);
    if (name) patch.name = name;
  }
  if (!Object.keys(patch).length) {
    // Nothing to change — still answer with the current row, as the original
    // did, so a no-op rename does not read as a failure.
    const rows = await rest(env, request, `workspaces?select=${COLS}&id=eq.${encodeURIComponent(id)}&limit=1`);
    if (!rows.length) throw new HttpError(404, 'Not found');
    const by = await counts(env, request);
    return json(row(rows[0], by.get(id)));
  }
  patch.updated_at = new Date().toISOString();
  const rows = await write(
    env,
    request,
    `workspaces?id=eq.${encodeURIComponent(id)}`,
    patch,
    'PATCH',
  );
  if (!rows.length) throw new HttpError(404, 'Not found');
  const by = await counts(env, request);
  return json(row(rows[0], by.get(id)));
}

export async function deleteWorkspace(env, request, id, url) {
  const owned = await rest(env, request, `workspaces?select=${COLS}&id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!owned.length) throw new HttpError(404, 'Not found');

  const all = await rest(env, request, `workspaces?select=${COLS}&order=created_at.asc`);
  if (all.length === 1) throw new HttpError(409, 'The last workspace cannot be deleted.');

  const inside = await rest(
    env,
    request,
    `conversations?select=id&workspace_id=eq.${encodeURIComponent(id)}&archived=eq.false`,
  );
  const force = url.searchParams.get('force') === '1';

  if (inside.length && !force) {
    throw new HttpError(
      409,
      `This workspace still holds ${inside.length} conversation${inside.length === 1 ? '' : 's'}.`,
    );
  }

  if (inside.length) {
    // Archive them in one statement rather than N — PostgREST takes a
    // comma-free filter on the id column, so send the ids explicitly.
    const ids = inside.map((c) => `'${c.id.replace(/'/g, "''")}'`).join(',');
    await rest(
      env,
      request,
      `conversations?id=in.(${ids})`,
      {
        method: 'PATCH',
        body: { archived: true, archived_at: new Date().toISOString() },
        headers: { Prefer: 'return=minimal' },
      },
    );
  }

  await rest(env, request, `workspaces?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
  return json({ ok: true });
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}
