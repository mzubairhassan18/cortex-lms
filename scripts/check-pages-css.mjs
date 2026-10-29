/* check-pages-css.mjs — guards the shared-CSS pages against dangling classes.
 *
 * The marketing pages (pricing/payment/auth/admin) each carry a page <style>
 * block but draw shared classes (nav, btn, foot, mark) from landing.css and
 * tokens.css. When landing.css gets rewritten, classes the pages still use
 * can silently vanish — this script catches that before it ships.
 *
 * Run: node scripts/check-pages-css.mjs   (exit 1 on any dangling class)
 */
import { readFileSync } from 'node:fs';

const pages = ['landing.html', 'pricing.html', 'payment.html', 'auth.html', 'admin.html'];
let bad = 0;
for (const page of pages) {
  const html = readFileSync('public/' + page, 'utf8');
  const pageCss = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  const sharedCss =
    readFileSync('public/landing.css', 'utf8') + '\n' + readFileSync('public/tokens.css', 'utf8');
  const defined = new Set(
    [...(sharedCss + '\n' + pageCss + '\n' + html).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1])
  );
  const used = new Set();
  for (const m of html.matchAll(/class="([^"]+)"/g)) m[1].split(/\s+/).forEach((c) => c && used.add(c));
  const missing = [...used].filter((c) => !defined.has(c));
  if (missing.length) {
    bad++;
    console.log(page + ' -> DANGLING: ' + missing.join(', '));
  } else {
    console.log(page + ' -> ok');
  }
}
process.exit(bad ? 1 : 0);
