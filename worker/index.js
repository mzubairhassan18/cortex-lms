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
import { getModelInfo } from './model-info.js';
import { chat } from './chat.js';
import { createClaim, paymentInfo } from './payment.js';
import { adminOverview, reviewClaim } from './admin.js';
import { createFile, deleteFile, fileText, listFiles } from './files.js';

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
    if (sub === 'files') {
      // seg = ['api','conversations',':id','files'(,':fid'(,'text'))]
      if (seg.length === 4 && method === 'POST') {
        return createFile(env, request, id, await read(request));
      }
      const fid = seg[4];
      if (seg.length === 5 && method === 'DELETE') return deleteFile(env, request, id, fid);
      if (seg.length === 6 && seg[5] === 'text' && method === 'GET') {
        return fileText(env, request, id, fid);
      }
      throw new HttpError(405, 'Method not allowed');
    }
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
  if (path === '/api/model-info' && method === 'GET') return getModelInfo(env, request, url);

  // ---- the chat stream ----
  if (path === '/api/chat' && method === 'POST') return chat(env, request);

  // ---- bank transfer (P2.9b) ----
  if (path === '/api/payment' && method === 'GET') return paymentInfo(env, request);
  if (path === '/api/payment/claims' && method === 'POST') {
    return createClaim(env, request, await read(request));
  }

  // ---- admin dashboard (P2.10) ----
  if (root === 'admin') {
    if (path === '/api/admin' && method === 'GET') return adminOverview(env, request);
    if (seg.length === 4 && seg[2] === 'claims' && method === 'POST') {
      return reviewClaim(env, request, seg[3], await read(request));
    }
    throw new HttpError(405, 'Method not allowed');
  }

  // ---- the library ----
  if (path === '/api/files' && method === 'GET') return listFiles(env, request, url);

  throw new HttpError(404, 'Not found');
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
