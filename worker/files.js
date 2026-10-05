/*
 * File storage: the four `.../files` routes plus the library list.
 *
 * The split is the whole design:
 *
 *   Postgres  the `files` row — extracted text plus metadata, scoped to its
 *             owner by the `files: all own` policy from the P2 schema. API
 *             reads are unmetered, and the text is what every turn of a
 *             conversation actually reads.
 *   R2        the original bytes at `<uid>/<conv_id>/<file_id>`, reached by
 *             binding rather than over the network, so there is no CORS to
 *             configure and no public URL for somebody to guess.
 *
 * A 5 MB PDF is ~100 KB of text. Keeping each where it is cheap — and against
 * the free tier of each, 500 MB of Postgres and 10 GB of R2 with no egress
 * charge — is what makes the split worth a second write.
 *
 * Extraction happens in the browser (public/js/extract.js): pdf.js and
 * mammoth are multi-MB DOM-bearing libraries and a Worker request has a CPU
 * budget in milliseconds. This module validates, sizes and stores; the text
 * arrives already read.
 *
 * Nothing here decides who may touch a row. `rest()` forwards the caller's own
 * Authorization header, auth.uid() resolves, and RLS does the scoping — so a
 * missing WHERE clause narrows nothing but also exposes nothing.
 */

import { HttpError, ms, newId, rest, userId, write } from './supabase.js';

const MAX_BYTES = 12 * 1024 * 1024;
const TEXT_CAP = 200000;

/* Extension recognition for two jobs: deciding whether a client that sent no
 * text could plausibly have had it decoded for free, and picking a MIME type
 * when the browser supplied none. Kept identical to v1's list. */
const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json',
  '.html', '.htm', '.log', '.xml', '.yml', '.yaml',
]);

const GUESS_MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  html: 'text/html; charset=utf-8',
  xml: 'application/xml',
};

/* Deliberately not `*`: the list endpoint would otherwise pull every stored
 * document's full text — up to 200 KB a row — to render filenames. */
const FILE_COLS =
  'id,conversation_id,name,ext,kind,mime,chars,link_url,storage_path,' +
  'stored_bytes,original_bytes,created_at';

/** PostgREST filters are built by concatenation, so the values are encoded. */
const q = (v) => encodeURIComponent(String(v));

const extOf = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** Directory components and control characters are not part of a filename. */
const safeName = (raw) =>
  (String(raw).split(/[\\/]/).pop() || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) ||
  'file';

function b64bytes(b64) {
  const bin = atob(b64); // throws on anything that is not valid base64
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * The conversation, read through RLS so a foreign id is a 404 rather than a
 * file quietly pinned to somebody else's thread. The FK would have accepted
 * it — it only checks existence, not ownership.
 */
async function loadConv(env, request, convId) {
  const rows = await rest(
    env,
    request,
    `conversations?select=id,title&id=eq.${q(convId)}&limit=1`,
  );
  if (!rows || !rows.length) throw new HttpError(404, 'Not found.');
  return rows[0];
}

/** Exactly the shape server.js always sent — library.js and the chips read it. */
const shape = (r, conv) => ({
  id: r.id,
  name: r.name,
  ...(r.kind === 'link'
    ? { link: r.link_url, type: 'link', size: 0 }
    : { type: r.ext || 'file', size: r.original_bytes }),
  chars: r.chars || 0,
  at: ms(r.created_at),
  convId: conv.id,
  convTitle: conv.title,
});

/* ---------------------------------------------------------------- POST ---- */

export async function createFile(env, request, convId, body) {
  const uid = userId(request);
  const conv = await loadConv(env, request, convId);
  body = body && typeof body === 'object' ? body : {};

  if (body.link) return createLink(env, request, uid, conv, body);
  if (body.data && body.name) return createUpload(env, request, uid, conv, body);
  throw new HttpError(400, 'Nothing uploaded.');
}

async function createLink(env, request, uid, conv, body) {
  const url = String(body.link).trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new HttpError(400, 'Links must start with http:// or https://');
  }
  const [saved] = await write(
    env,
    request,
    'files',
    {
      id: 'f' + newId(),
      user_id: uid,
      conversation_id: conv.id,
      // v1 showed the host, not the scheme, and capped it so a data URL
      // cannot become a library row nobody wants to read.
      name: url.replace(/^https?:\/\//i, '').slice(0, 120),
      kind: 'link',
      link_url: url,
      chars: 0,
      text: '',
    },
    'POST',
  );
  return json({ file: shape(saved, conv) });
}

async function createUpload(env, request, uid, conv, body) {
  const name = safeName(body.name);
  const ext = extOf(name);

  let bytes;
  try {
    bytes = b64bytes(String(body.data));
  } catch {
    throw new HttpError(400, 'That upload could not be read.');
  }
  if (!bytes.length) throw new HttpError(400, 'Empty file.');
  if (bytes.length > MAX_BYTES) throw new HttpError(400, 'File too large (max 12 MB).');

  const text = readText(body, bytes, ext);
  const mime =
    String(body.mime || '').slice(0, 120) || GUESS_MIME[ext] || 'application/octet-stream';

  await allowMoreStorage(env, request, uid, bytes.length);

  if (!env.BUCKET) throw new HttpError(503, 'File storage is not available right now.');

  const id = 'f' + newId();
  const key = `${uid}/${conv.id}/${id}`;
  await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: mime } });

  try {
    const [saved] = await write(
      env,
      request,
      'files',
      {
        id,
        user_id: uid,
        conversation_id: conv.id,
        name,
        ext: ext || null,
        kind: 'upload',
        mime,
        chars: text.length,
        text,
        storage_path: key,
        stored_bytes: bytes.length,
        original_bytes: bytes.length,
      },
      'POST',
    );
    return json({ file: shape(saved, conv) });
  } catch (e) {
    // The row is what says a file exists. An orphaned blob costs a few bytes
    // in a bucket nobody lists; a row whose storage_path points at nothing
    // would be a lie the next reader believes.
    try {
      await env.BUCKET.delete(key);
    } catch { /* the row is going regardless */ }
    throw e;
  }
}

/**
 * The text the browser extracted, or, for a client that sent none, a decode
 * that costs one TextDecoder call. Anything heavier had to be read at upload
 * time — a PDF arriving without text means extraction failed upstream, and
 * storing it as empty would make a successful-looking chip that injects
 * nothing into the prompt.
 */
function readText(body, bytes, ext) {
  let text = body.text;
  if (typeof text !== 'string') {
    if (!TEXT_EXTS.has('.' + ext)) {
      throw new HttpError(400, 'This file could not be read — try attaching it again.');
    }
    text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  }
  return text.replace(/\u0000/g, '').slice(0, TEXT_CAP);
}

/**
 * The storage half of the pricing table (Free 50 MB, Pro 1 GB, Team 10 GB).
 *
 * Fail-open by design. This is a product rule about a 10 GB bucket shared by
 * every user, not a security boundary, and refusing an upload because a
 * settings row could not be read would cost more than one extra object — the
 * row insert below still goes through RLS, so nothing is being trusted here.
 */
async function allowMoreStorage(env, request, uid, addBytes) {
  let over = null;
  try {
    const [profile] = await rest(env, request, `profiles?select=plan&id=eq.${q(uid)}&limit=1`);
    const [row] = await rest(
      env,
      request,
      'platform_settings?select=value&key=eq.plans&limit=1',
    );
    const plan = profile && row && row.value && row.value[profile.plan];
    // No plan, or no storage figure for it: do not invent a limit.
    if (!plan || !Number.isFinite(+plan.storage_mb)) return;

    const owned = await rest(env, request, `files?select=stored_bytes&user_id=eq.${q(uid)}`);
    const used = (owned || []).reduce((n, r) => n + (+r.stored_bytes || 0), 0);
    if (used + addBytes > +plan.storage_mb * 1024 * 1024) {
      over = `That would pass your ${+plan.storage_mb} MB storage limit — delete a file or upgrade.`;
    }
  } catch {
    return; // the plan could not be read — allow, per the note above
  }
  if (over) throw new HttpError(413, over);
}

/* ---------------------------------------------------------------- GET ---- */

/** Extracted text for the prompt. Links have none by definition, and the same
 *  sentence v1 showed is returned instead of an empty string. */
export async function fileText(env, request, convId, fid) {
  userId(request); // 401 before any query, not after one
  const rows = await rest(
    env,
    request,
    `files?select=kind,text,link_url&id=eq.${q(fid)}&conversation_id=eq.${q(convId)}&limit=1`,
  );
  if (!rows || !rows.length) throw new HttpError(404, 'Not found.');
  const r = rows[0];
  return json({ text: r.kind === 'link' ? `Link reference: ${r.link_url}` : r.text || '' });
}

/* ------------------------------------------------------------- DELETE ---- */

export async function deleteFile(env, request, convId, fid) {
  userId(request);
  const rows = await rest(
    env,
    request,
    `files?select=storage_path&id=eq.${q(fid)}&conversation_id=eq.${q(convId)}&limit=1`,
  );
  if (!rows || !rows.length) throw new HttpError(404, 'Not found.');

  const key = rows[0].storage_path;
  if (key && env.BUCKET) {
    try {
      await env.BUCKET.delete(key);
    } catch { /* the row is going regardless */ }
  }
  await rest(env, request, `files?id=eq.${q(fid)}`, { method: 'DELETE' });
  return json({ ok: true });
}

/* -------------------------------------------------------------- library -- */

/** Every file across every conversation, newest first — a bare array, because
 *  library.js does `files.map(...)` directly on the response. */
export async function listFiles(env, request, url) {
  userId(request);
  const ws = String(url.searchParams.get('workspace') || '').trim();

  const [files, convs] = await Promise.all([
    rest(env, request, `files?select=${FILE_COLS}&order=created_at.desc&limit=1000`),
    rest(env, request, 'conversations?select=id,title,workspace_id,archived'),
  ]);

  const byId = new Map((convs || []).map((c) => [c.id, c]));
  const out = [];
  for (const f of files || []) {
    const conv = byId.get(f.conversation_id);
    /* A conversation is soft-deleted into `archived`, and its files go quiet
     * with it: the row's "Open" button would target a conversation the sidebar
     * does not have, and a restore brings them back. */
    if (!conv || conv.archived) continue;
    if (ws && conv.workspace_id !== ws) continue;
    out.push(shape(f, conv));
  }
  return json(out);
}

function json(v, status) {
  return new Response(JSON.stringify(v), {
    status: status || 200,
    headers: { 'content-type': 'application/json' },
  });
}
