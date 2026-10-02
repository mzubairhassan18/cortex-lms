/* views.js — the Preact view layer (split from public/app.js's rendering). */
import { Fragment, h, render } from '../vendor/preact.mjs';
import htm from '../vendor/htm.mjs';

/*
 * The list views used to be template-literal strings assigned to innerHTML:
 * every update re-parsed the whole subtree, threw away whatever element state
 * lived inside it, and paid for markup that had not actually changed. They are
 * now plain functions of state -> vnodes, and Preact diffs them — touching
 * only what changed.
 *
 * Two consequences the call sites rely on:
 *   • Preact sets text children via textContent, so views must interpolate RAW
 *     strings — never escapeHtml() (that would render `&amp;` literally).
 *   • Preact only rewrites dangerouslySetInnerHTML when the __html value
 *     differs, and renderMarkdown() is memoized — so DOM that decoration and
 *     highlighting add INSIDE a bubble survives every re-render.
 *
 * No build step: preact and htm are vendored as plain ESM under public/vendor/,
 * so `html` is htm bound to Preact's `h`.
 */
export const html = htm.bind(h);
export { Fragment, h, render };

/*
 * Containers that ALSO receive imperative children — the streaming bubble that
 * makeStreamer appends — must not be handed straight to Preact: it owns the
 * children of the container it renders into, and a foreign node in there
 * breaks its reconciliation.
 *
 * Instead Preact owns exactly one child of its own: this host, styled
 * `display: contents` in style.css so it generates no box at all and the
 * container's flex/gap rules apply to Preact's children as if it were absent.
 * The streaming bubble stays a sibling Preact never looks at.
 *
 * Containers only Preact writes to (the conversation list, summary card, …)
 * render directly into themselves — no host, no layout change, and their
 * `:empty` CSS keeps working.
 */
const hosts = new WeakMap();

export function hostFor(container) {
  let host = hosts.get(container);
  if (!host || !host.isConnected) {
    host = document.createElement('div');
    host.className = 'pv-host';
    container.insertBefore(host, container.firstChild);
    hosts.set(container, host);
  }
  return host;
}
