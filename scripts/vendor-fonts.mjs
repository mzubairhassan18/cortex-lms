/* vendor-fonts.mjs — download OFL webfonts for self-hosting (Phase A of the redesign).
 *
 * The app promises "runs on your machine", so fonts must not live on a CDN. Both faces
 * are open-licensed (OFL): Geist & Geist Mono (Vercel/basement), Fraunces (Undercase).
 * This script asks Google Fonts' css2 endpoint *as a modern browser* so it returns
 * variable woff2 URLs, parses only the latin subset, downloads each file once, and
 * rewrites @font-face block ready to paste into tokens.css. Idempotent: re-running
 * skips files that already exist (delete to refresh).
 *
 *   node scripts/vendor-fonts.mjs
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(new URL('../public/vendor/fonts/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const FAMILIES = [
  { file: 'Geist-VF.woff2',          css: 'https://fonts.googleapis.com/css2?family=Geist:wght@400..600&display=swap' },
  { file: 'GeistMono-VF.woff2',      css: 'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400..600&display=swap' },
  { file: 'Fraunces-VF.woff2',       css: 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..700&display=swap' },
];

mkdirSync(OUT, { recursive: true });
let fetched = 0;

for (const fam of FAMILIES) {
  const dest = join(OUT, fam.file);
  if (existsSync(dest)) {
    console.log('exists, skipping:', fam.file);
    continue;
  }
  console.log('fetching css2 for', fam.file);
  const css = await (await fetch(fam.css, { headers: { 'user-agent': UA } })).text();
  /* css2 lists subsets with a "/* latin *\/" comment before each block; keep the url in the latin block */
  const blocks = css.split('/*').filter((b) => b.startsWith(' latin */'));
  const url = (blocks[0] || css).match(/https:\/\/[^)]+\.woff2/)?.[0];
  if (!url) { console.error('NO woff2 url found for', fam.css); process.exitCode = 1; continue; }
  const buf = Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer());
  writeFileSync(dest, buf);
  console.log('saved', fam.file, buf.length, 'bytes from', url);
  fetched++;
}
console.log(fetched ? '' : 'all fonts present');
