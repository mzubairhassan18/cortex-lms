/* site.js — the shared page chrome for the standalone marketing pages.
 *
 * ONE source of the brand mark and the footer: pages mount them from here
 * instead of each carrying its own copy (the copy-paste drift that stranded
 * the pricing footer came from exactly that). A page keeps zero chrome
 * markup — only its own mount line:
 *
 *   <a class="brand" href="./" data-brand aria-label="Cortex home">Cortex</a>
 *   <div data-foot hidden></div>
 *   <script type="module">
 *     import { mountBrand, mountFoot } from './js/site.js';
 *     mountBrand();
 *     mountFoot();               // default note + default links
 *   </script>
 *
 * Keep-in-sync: this mark is the same glyph as the sprite symbol #i-cortex
 * (public/index.html) and the favicon public/icon.svg — same open question
 * node joined to the ember answer node. If the geometry ever changes, change
 * all three, and say so in all three.
 */

/* The Cortex mark. Ember node is --intent so it lifts with the theme.
 * Presentation attributes can't read CSS vars — the fill goes through the
 * class that landing.css styles. Fixed 18px everywhere; one size. */
export const MARK_SVG =
  '<svg class="mark" viewBox="0 0 64 64" width="18" height="18" aria-hidden="true">'
  + '<path class="mark-node" d="M24.5 39.5 L39.5 24.5" fill="none"/>'
  + '<circle class="mark-node" cx="21" cy="43" r="8.5" fill="none"/>'
  + '<circle class="mark-ember" cx="44" cy="20" r="9.5"/>'
  + '</svg>';

/* The brand line: mark + wordmark inside the nav anchor. Pages write the bare
 * anchor (text-only, so a no-JS visit still reads "Cortex"); this fills in
 * the mark. */
export function mountBrand() {
  for (const a of document.querySelectorAll('[data-brand]')) {
    a.innerHTML = MARK_SVG + ' Cortex';
  }
}

const DEFAULT_NOTE = 'Free tier, no card required · Bring your own model key';
const DEFAULT_LINKS = [
  ['Features', './#features'],
  ['Pricing', './pricing'],
  ['Sign up', './signup'],
];

/* The footer. links is [label, href] pairs joined with the interpunct. */
export function mountFoot(links = DEFAULT_LINKS, note = DEFAULT_NOTE) {
  const slot = document.querySelector('[data-foot]');
  if (!slot) return;
  const linkHtml = links
    .map(([label, href], i) =>
      (i ? '<span class="dot" aria-hidden="true">·</span>' : '')
      + `<a href="${href}">${label}</a>`)
    .join('');
  slot.outerHTML =
    `<footer class="foot"><div class="foot-in">`
    + `<p class="foot-brand">${MARK_SVG}\n      Cortex</p>`
    + `<p class="foot-note">${note}</p>`
    + `<p class="foot-links">${linkHtml}</p>`
    + `</div></footer>`;
}
