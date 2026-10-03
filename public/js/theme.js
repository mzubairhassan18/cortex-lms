/* theme.js — dark/light switch.
 *
 * The FIRST line of defence against a flash of wrong colours lives inline in
 * index.html <head>: it reads localStorage and sets <html data-theme> before
 * the stylesheet paints. This module only owns the switch itself.
 *
 * Rules:
 *   - a manual choice always wins and is persisted to `lb.theme`
 *   - until the user picks one, we follow the OS preference live
 */

const KEY = 'lb.theme';

const root = document.documentElement;
const btn = document.getElementById('theme-toggle');

function systemTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light' : 'dark';
}

/* Does the user have an explicit choice stored? */
function stored() {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch { return null; } // private mode
}

function paint(t) {
  root.setAttribute('data-theme', t);
  if (!btn) return;
  btn.textContent = t === 'dark' ? '🌙' : '☀️';
  btn.title = t === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
  btn.setAttribute('aria-pressed', t === 'light' ? 'true' : 'false');
}

export function setTheme(t) {
  paint(t);
  try { localStorage.setItem(KEY, t); } catch { /* private mode */ }
}

export function initTheme() {
  paint(stored() || systemTheme());

  btn && btn.addEventListener('click', () => {
    setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  /* Follow the OS only while the user hasn't chosen for themselves. */
  const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
  const onSystem = () => { if (!stored()) paint(systemTheme()); };
  if (mq) {
    if (mq.addEventListener) mq.addEventListener('change', onSystem);
    else if (mq.addListener) mq.addListener(onSystem);
  }
}
