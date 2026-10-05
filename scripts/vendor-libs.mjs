#!/usr/bin/env node
/*
 * vendor-libs.mjs — copy the browser halves of two existing dependencies into
 * public/vendor/.
 *
 * This is how a no-build-step project acquires third-party code: it does not
 * bundle anything, it moves a pre-built file the package already ships. Run it
 * after `npm install`, or after upgrading pdf-parse / mammoth, then commit the
 * result — the copies are the artefact and this script is their provenance.
 *
 *   node scripts/vendor-libs.mjs
 *
 * Two adjustments are made to what npm ships, both deliberate:
 *
 *   - the `//# sourceMappingURL` trailer is stripped. The matching .map files
 *     total ~6.8 MB and would be published to a mirror nobody debugs from;
 *     leaving the trailer in would put a 404 in devtools on every load.
 *   - files are written as UTF-8 with no BOM, because both copies are parsed
 *     as strict ES modules (the Worker bundles them, the browser imports them)
 *     and a leading BOM would make the first token unparseable.
 *
 * pdf-parse is taken from dist/pdf-parse/web/ — the same PDFParse class the
 * Node build exposes, built against browser APIs and doing its parsing on a
 * real Web Worker. The paired pdf.worker.mjs comes from the same package and
 * version for a reason: pdf.js refuses a worker whose protocol it does not
 * recognise, so main thread and worker must travel together. V1's extraction
 * was proven against this wrapper (PLAN §3.3: both test PDFs, full text).
 *
 * Nothing here is minified, because nothing here is built: what npm shipped is
 * what ships.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'public', 'vendor');

/** [path inside the repo, destination under public/vendor/] */
const FILES = [
  ['node_modules/pdf-parse/dist/pdf-parse/web/pdf-parse.es.js', 'pdf-parse/pdf-parse.es.js'],
  ['node_modules/pdf-parse/dist/pdf-parse/web/pdf.worker.mjs', 'pdf-parse/pdf.worker.mjs'],
  ['node_modules/mammoth/mammoth.browser.min.js', 'mammoth.browser.min.js'],
];

const stripMap = (src) => `${src.replace(/^\/\/# sourceMappingURL=.*$/gm, '').trimEnd()}\n`;

for (const [from, to] of FILES) {
  const dst = join(VENDOR, to);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, stripMap(readFileSync(join(ROOT, from), 'utf8')), 'utf8');
  const kb = Math.round(readFileSync(dst).length / 1024);
  console.log(`  ${to.padEnd(30)} ${String(kb).padStart(5)} KB  <- ${from}`);
}
console.log(`\nvendored ${FILES.length} file(s) into public/vendor/ — commit them.`);
