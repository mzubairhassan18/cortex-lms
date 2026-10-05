/*
 * GET/POST/PUT/DELETE on /api/conversations, backed by the `conversations`
 * table.
 *
 * Two translations happen here and nowhere else:
 *
 *   names       workspaceId -> workspace_id
 *   time        epoch ms    -> timestamptz, and back
 *
 * The client does `b.updatedAt - a.updatedAt`, so a number has to come back;
 * an ISO string would compare as NaN and the list would keep its insertion
 * order instead of most-recent-first. Everything else is passed through.
 */

import { HttpError, ms, objOrNull, rest, write, newId } from './supabase.js';

const LIST_COLS = 'id,title,updated_at,workspace_id';
const FULL_COLS =
  'id,title,workspace_id,messages,explains,summary,quiz,tests,notes,created_at,updated_at';

const row = (r) => ({
  id: r.id,
  title: r.title,
  updatedAt: ms(r.updated_at),
  workspaceId: r.workspace_id,
});

const full = (r) => ({
  ...row(r),
  messages: r.messages || [],
  explains: objOrNull(r.explains),
  summary: r.summary ?? null,
  quiz: r.quiz ?? null,
  tests: r.tests || [],
  notes: r.notes || [],
  createdAt: ms(r.created_at),
});

/** Every workspace the caller owns, as ids — used to reject unknown ones. */
async function workspaceIds(env, request) {
  const rows = await rest(env, request, 'workspaces?select=id');
  return new Set((rows || []).map((w) => w.id));
}

async function assertWorkspace(env, request, id) {
  const known = await workspaceIds(env, request);
  if (!known.has(id)) throw new HttpError(400, 'Unknown workspace');
}

export async function listConversations(env, request, url) {
  const ws = String(url.searchParams.get('workspace') || '').trim();
  const filter = ws ? `&workspace_id=eq.${encodeURIComponent(ws)}` : '';
  const rows = await rest(
    env,
    request,
    // Archived rows are hidden, not gone: server.js moved them to a separate
    // file where the list simply stopped seeing them, and the `archived` flag
    // reproduces that exactly while keeping the row (and its messages) around
    // for /api/deleted/:id/restore.
    `conversations?select=${LIST_COLS}&archived=eq.false&order=updated_at.desc${filter}`,
  );
  return json(rows.map(row));
}

export async function getConversation(env, request, id) {
  const rows = await rest(
    env,
    request,
    `conversations?select=${FULL_COLS}&id=eq.${encodeURIComponent(id)}&archived=eq.false&limit=1`,
  );
  if (!rows.length) throw new HttpError(404, 'Not found');
  return json(full(rows[0]));
}

export async function createConversation(env, request, body) {
  // Every conversation belongs to exactly one workspace, and never to one the
  // caller does not own: RLS would refuse the insert anyway, but catching it
  // here returns server.js's message instead of a PostgREST error.
  let wsId = body.workspaceId ? String(body.workspaceId) : null;
  if (wsId) await assertWorkspace(env, request, wsId);
  if (!wsId) {
    const rows = await rest(env, request, 'workspaces?select=id&order=created_at.asc&limit=1');
    wsId = rows.length ? rows[0].id : null;
    if (!wsId) throw new HttpError(400, 'Create a workspace first.');
  }

  const [created] = await write(
    env,
    request,
    'conversations',
    {
      id: newId(),
      workspace_id: wsId,
      title: String(body.title || 'New conversation'),
      messages: [],
    },
    'POST',
  );
  return json(full(created));
}

export async function updateConversation(env, request, id, body) {
  // Partial update: only the keys the client sent are written, exactly as
  // server.js does — a PUT carrying only `notes` must not clear `messages`.
  const patch = {};

  if ('workspaceId' in body && body.workspaceId) {
    const wsId = String(body.workspaceId);
    await assertWorkspace(env, request, wsId);
    patch.workspace_id = wsId;
  }
  if ('messages' in body) patch.messages = Array.isArray(body.messages) ? body.messages : [];
  if ('explains' in body) patch.explains = body.explains || null;
  if ('summary' in body) patch.summary = body.summary || null;
  if ('quiz' in body) patch.quiz = body.quiz || null;
  if ('tests' in body) patch.tests = Array.isArray(body.tests) ? body.tests : [];
  if ('notes' in body) patch.notes = Array.isArray(body.notes) ? body.notes : [];

  if ('messages' in patch || 'explains' in patch) patch.updated_at = new Date().toISOString();

  if (patch.messages) {
    // Title from the first user turn, the way server.js derives it — but only
    // while the conversation is still untitled, so a rename is never undone.
    const firstUser = patch.messages.find((m) => m && m.role === 'user');
    if (firstUser && typeof firstUser.content === 'string') {
      const rows = await rest(
        env,
        request,
        `conversations?select=title&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      if (rows.length && (!rows[0].title || rows[0].title === 'New conversation')) {
        patch.title = firstUser.content.slice(0, 40);
      }
    }
  }

  if (!Object.keys(patch).length) return json({ ok: true });

  const rows = await write(
    env,
    request,
    `conversations?id=eq.${encodeURIComponent(id)}&archived=eq.false`,
    patch,
    'PATCH',
  );
  if (!rows || !rows.length) throw new HttpError(404, 'Not found');
  return json({ ok: true });
}

export async function deleteConversation(env, request, id) {
  /* Remove is permanent by design, but never silent. server.js archived the
   * whole conversation to an append-only file so a delete left a trace and
   * stayed restorable; the `archived` flag is that file. Nothing is destroyed,
   * and the RLS policy still limits the update to the caller's own row. */
  const rows = await write(
    env,
    request,
    `conversations?id=eq.${encodeURIComponent(id)}&archived=eq.false`,
    { archived: true, archived_at: new Date().toISOString() },
    'PATCH',
  );
  if (!rows || !rows.length) throw new HttpError(404, 'Not found');
  return json({ ok: true });
}

/** Put an archived conversation back. */
export async function restoreConversation(env, request, id) {
  const rows = await rest(
    env,
    request,
    `conversations?select=id,workspace_id&id=eq.${encodeURIComponent(id)}&archived=eq.true&limit=1`,
  );
  if (!rows.length) throw new HttpError(404, 'Not archived.');

  // A restore after its workspace was force-deleted would put the row back
  // behind a filter it can never match, so re-home it first.
  const patch = { archived: false, archived_at: null };
  const known = await workspaceIds(env, request);
  if (!known.has(rows[0].workspace_id)) {
    const home = await rest(
      env,
      request,
      'workspaces?select=id&order=created_at.asc&limit=1',
    );
    if (!home.length) throw new HttpError(400, 'Create a workspace first.');
    patch.workspace_id = home[0].id;
  }

  const [restored] = await write(
    env,
    request,
    `conversations?id=eq.${encodeURIComponent(id)}&archived=eq.true`,
    patch,
    'PATCH',
  );
  return json({ ok: true, conv: full(restored) });
}

function json(v) {
  return new Response(JSON.stringify(v), {
    headers: { 'content-type': 'application/json' },
  });
}
