/*
 * Worker entry point.
 *
 * Two jobs, in this order:
 *
 *   1. Anything under /api/  -> the handler table below.
 *   2. Everything else       -> env.ASSETS.fetch(request), i.e. the published
 *                               site itself.
 *
 * wrangler.jsonc sets `run_worker_first: ["/api/*"]`, so the static lookup
 * happens first for normal pages (a page is served without waking this code
 * at all) and only API paths are guaranteed to reach it. That ordering is the
 * reason a stray file named `chat` could never shadow /api/chat.
 *
 * Errors funnel through one catch: anything a handler throws becomes
 * {"error": "..."} with the status it carried, which is the exact shape
 * every client call site already branches on (`if (!r.ok)` then read `.error`).
 */

import { HttpError } from './supabase.js';
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  restoreConversation,
  updateConversation,
} from './conversations.js';
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaces,
  updateWorkspace,
} from './workspaces.js';
import { connect, getModels, getSettings, putSettings } from './settings.js';
import { chat } from './chat.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await route(request, env, url);
    } catch (e) {
      return json(
        { error: (e && e.message) || 'Something went wrong.' },
        (e && e.status) || 500,
      );
    }
  },
};

async function route(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const seg = path.split('/').filter(Boolean); // ['api', 'resource', ...]
  const [, root, id, sub] = seg;

  // ---- conversations ----
  if (root === 'conversations') {
    if (sub === 'files') return filesNotReady(id, seg, method, request);
    if (!id) {
      if (method === 'GET') return listConversations(env, request, url);
      if (method === 'POST') return createConversation(env, request, await read(request));
    } else if (!sub) {
      if (method === 'GET') return getConversation(env, request, id);
      if (method === 'PUT') return updateConversation(env, request, id, await read(request));
      if (method === 'DELETE') return deleteConversation(env, request, id);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // ---- soft-deleted conversations ----
  if (root === 'deleted' && sub === 'restore' && method === 'POST') {
    return restoreConversation(env, request, id);
  }

  // ---- workspaces ----
  if (root === 'workspaces') {
    if (!id) {
      if (method === 'GET') return listWorkspaces(env, request);
      if (method === 'POST') return createWorkspace(env, request, await read(request));
    } else if (!sub) {
      if (method === 'PUT') return updateWorkspace(env, request, id, await read(request));
      if (method === 'DELETE') return deleteWorkspace(env, request, id, url);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // ---- settings / models ----
  if (path === '/api/settings') {
    if (method === 'GET') return getSettings(env, request);
    if (method === 'PUT') return putSettings(env, request, await read(request));
    throw new HttpError(405, 'Method not allowed');
  }
  if (path === '/api/settings/connect' && method === 'POST') {
    return connect(env, request, await read(request));
  }
  if (path === '/api/models' && method === 'GET') return getModels(env, request);

  // ---- the chat stream ----
  if (path === '/api/chat' && method === 'POST') return chat(env, request);

  // ---- the library ----
  // v1 kept uploads on the laptop's disk, so nothing has ever been stored
  // server-side: an empty list is the truth today, not a placeholder. The
  // upload routes themselves are honest about not existing yet.
  if (path === '/api/files' && method === 'GET') return json([]);

  throw new HttpError(404, 'Not found');
}

/** Upload/download routes: not ported yet — say so rather than 404. */
function filesNotReady(convId, seg, method, request) {
  // seg = ['api','conversations',':id','files'(,':fid'(,'text'))]
  if (seg.length === 4) {
    // v1 kept uploads on the laptop's disk, so nothing has ever been stored
    // server-side: an empty list is the truth today, not a placeholder.
    if (method === 'GET') return json([]);
    if (method === 'POST') {
      return json({ error: 'File storage is not available on this host yet.' }, 501);
    }
  }
  // Removing something that was never stored is a no-op, not a failure.
  if (seg.length === 5 && method === 'DELETE') return json({ ok: true });
  return json({ error: 'File storage is not available on this host yet.' }, 501);
}

async function read(request) {
  try {
    const b = await request.json();
    return b && typeof b === 'object' ? b : {};
  } catch {
    return {};
  }
}

function json(v, status) {
  return new Response(JSON.stringify(v), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  });
}
