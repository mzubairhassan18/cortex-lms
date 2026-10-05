#!/usr/bin/env node
/*
 * assemble.mjs — turn public/ into out/, the folder a static host can publish.
 *
 * This is NOT a build step. Nothing is transpiled, bundled, minified or
 * tree-shaken; `node server.js` never runs it; there is no watch mode. It does
 * two mechanical things GitHub Pages cannot do for itself and stops.
 *
 *   1. Route folders. server.js maps /app -> index.html with three lines of
 *      Express. A static host has no route table, so each clean route needs a
 *      real folder holding a copy of its document.
 *
 *   2. One level of depth, handled explicitly. Those copies live at /<route>/,
 *      so their './'-relative URLs would resolve there instead of at the site
 *      root. Rewriting './' -> '../' inside the copies is the whole fix; the
 *      originals in public/ are never touched, so localhost keeps working.
 *
 * Deliberately NOT a <base href="../"> tag: <base> re-resolves fragment-only
 * references too, and index.html is full of <use href="#i-plus"> sprite refs
 * that would then point at the site root instead of this document — every icon
 * on the page would go blank. An explicit prefix touches only real URLs.
 *
 * Usage:
 *   node scripts/assemble.mjs              write out/ at base /cortex-lms/
 *   node scripts/assemble.mjs --base /     write out/ at the root (Cloudflare
 *                                          Pages, Netlify — no sub-path)
 *   node scripts/assemble.mjs --serve      write out/, then serve it at the
 *                                          configured base so the base-path
 *                                          assumptions can be checked before
 *                                          anything is pushed
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public');
const OUT = join(ROOT, 'out');

/* The deploy base belongs to the host, not to the code: GitHub Pages serves a
 * project site under /<repo>/, while Cloudflare Pages and Netlify serve at the
 * root. Making it a flag rather than a constant means one tree publishes
 * anywhere without editing this file, and the stamped output keeps no
 * repository name in it — the site survives a rename of the repo.
 *
 *   node scripts/assemble.mjs --base /cortex-lms/   default, GitHub Pages
 *   node scripts/assemble.mjs --base /              root deploy */
const BASE_PATH = (() => {
  const i = process.argv.indexOf('--base');
  const raw = i === -1 || !process.argv[i + 1] ? '/cortex-lms/' : process.argv[i + 1];
  const p = raw.startsWith('/') ? raw : `/${raw}`;
  return p.endsWith('/') ? p : `${p}/`;
})();
const PORT = 4173;

/* [source document, route directory] — the route directory is what server.js
 * maps in its Express route table, kept side by side so the two cannot drift.
 * '' is the site root, which a static host serves as index.html. */
const ROUTES = [
  ['landing.html', ''],           // /            -> landing page
  ['index.html',   'app'],        // /app         -> the application
  ['index.html',   'workspaces'], // /workspaces  -> the picker
  ['auth.html',    'login'],      // /login       \  one document,
  ['auth.html',    'signup'],     // /signup      /  two routes
  ['pricing.html', 'pricing'],    // /pricing
  ['payment.html', 'payment'],    // /payment — bank transfer + claim filing
  ['admin.html',   'admin'],      // /admin   — gated on profiles.role=admin
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.png':  'image/png',
  '.woff2':'font/woff2',
};

function assemble() {
  rmSync(OUT, { recursive: true, force: true });
  cpSync(SRC, OUT, { recursive: true });

  const report = [];
  for (const [doc, dir] of ROUTES) {
    const html = readFileSync(join(SRC, doc), 'utf8');
    /* './' resolves against the document's directory, and '/<repo>/app' has
     * no trailing slash — its directory is the parent, so './js/main.js'
     * would resolve to /js/main.js and 404 on a real host. ('../' is just as
     * fragile: it is only correct when the trailing slash survives.) A
     * configured absolute base does not care how the host normalises the
     * slash, so every document gets the same treatment, root ones included. */
    const n = html.match(/(["'])\.\//g)?.length ?? 0;
    const out = html.replace(/(["'])\.\//g, `$1${BASE_PATH}`);
    const target = join(OUT, dir, 'index.html');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, out);
    report.push(`  ${('/' + dir).padEnd(14)} <- ${doc.padEnd(14)} ${n} urls -> ${BASE_PATH}`);
  }

  // Without this Pages runs Jekyll over the output and silently drops files.
  writeFileSync(join(OUT, '.nojekyll'), '');
  report.push(`  ${'/.nojekyll'.padEnd(14)} written`);

  console.log(`out/ assembled from public/:\n${report.join('\n')}`);
}

/* --- preview ------------------------------------------------------------
 * Serves out/ under BASE_PATH so the sub-path assumption is actually
 * exercised: '/cortex-lms/app' resolving its assets correctly is the whole
 * question this script exists to answer. /api/* is proxied to the dev server
 * on :3000, otherwise the preview renders an empty shell and every failure
 * would look like a base-path bug when it is only the data layer (P2.4).
 */
function serve() {
  const base = BASE_PATH.replace(/\/$/, '');

  const proxy = async (req, res, url) => {
    try {
      const headers = {};
      for (const h of ['content-type', 'accept', 'accept-language']) if (req.headers[h]) headers[h] = req.headers[h];
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const up = await fetch(`http://localhost:3000${url.pathname}${url.search}`, {
        method: req.method,
        headers,
        body: hasBody ? req : undefined,
        duplex: hasBody ? 'half' : undefined,
      });
      res.writeHead(up.status, Object.fromEntries(up.headers));
      if (up.body) {
        const { Readable } = await import('node:stream');
        Readable.fromWeb(up.body).pipe(res);
      } else res.end();
    } catch (e) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`preview proxy: ${e.message}\n(is server.js running on :3000?)`);
    }
  };

  createServer(async (req, res) => {
    const url = new URL(req.url, 'http://preview');
    if (url.pathname.startsWith('/api/')) return proxy(req, res, url);

    /* Be exactly as strict as a real static host. The first cut of this
     * preview also served out/ from the root, which masked a genuine bug:
     * '/<repo>/app' resolved '../js/main.js' to '/js/main.js' and loaded it
     * anyway, so the base path silently came out as '/' and every redirect
     * pointed off-site. A preview more permissive than production is worse
     * than no preview. */
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end(`404 ${url.pathname}\n(outside ${BASE_PATH} — a static host would answer the same)`);
    }
    const rel = decodeURIComponent(url.pathname.slice(base.length)).replace(/^\/+/, '');

    const target = join(OUT, rel);
    if (target !== OUT && !target.startsWith(OUT + sep)) { res.writeHead(403); return res.end(); }
    const file = existsSync(target) && statSync(target).isDirectory()
      ? join(target, 'index.html')
      : target;
    if (!existsSync(file)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end(`404 ${url.pathname}`); }

    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(readFileSync(file));
  }).listen(PORT, () => {
    console.log(`preview: http://localhost:${PORT}${BASE_PATH}   (sub-path = GitHub Pages shape)`);
  });
}

assemble();
if (process.argv.includes('--serve')) serve();
