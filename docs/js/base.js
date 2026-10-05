/*
 * The site root, derived rather than configured.
 *
 * GitHub Pages serves a project site under /<repo>/, which makes every
 * root-absolute path ('/app', '/style.css') wrong there and right on
 * localhost. Rather than an environment file a developer has to remember to
 * flip, the base is read off this module's own URL: the module graph always
 * lives at <base>/js/*, so the parent of this directory is the site root.
 *
 *   localhost -> /js/base.js            -> /
 *   Pages     -> /cortex-lms/js/base.js -> /cortex-lms/
 *
 * No build step, nothing to keep in sync, and if the layout ever changes the
 * only thing that breaks is deep-linking, not the module graph.
 */

/** Absolute path of the site root on this origin. Always ends in '/'. */
export const BASE = new URL('../', import.meta.url).pathname;

/** App-relative route -> absolute path: '/app' -> '/<base>/app'. */
export function at(path) {
  return BASE + String(path).replace(/^\/+/, '');
}

/** Absolute path -> app-relative route: '/<base>/workspaces' -> '/workspaces'. */
export function rel(path) {
  const p = String(path);
  return p.startsWith(BASE) ? '/' + p.slice(BASE.length).replace(/^\/+/, '') : p;
}

/**
 * The route this document is serving, stripped of the deploy base and of any
 * trailing slash: '/<base>/workspaces/' -> '/workspaces', '/' -> '/'.
 *
 * Every pathname comparison must go through this. Comparing location.pathname
 * directly passes on localhost and silently fails on a sub-path deploy, and
 * the auth page picks its mode (login vs signup) from exactly this value.
 */
export function route() {
  return '/' + rel(location.pathname).replace(/^\/+|\/+$/g, '');
}
