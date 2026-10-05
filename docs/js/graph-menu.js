/*
 * graph-menu.js — the right-click menus on the graph board.
 *
 * Why a bespoke menu instead of the native one: the board is an infinite
 * canvas, so "Create conversation" has to mean *here*, at the point you
 * clicked, and the browser's menu offers nothing the board can act on.
 *
 * The menu lives on <body> with position:fixed and viewport coordinates, NOT
 * inside #graph-canvas. Everything in the canvas is scaled and translated by
 * the camera, so a menu mounted there would come out at the wrong size at 30%
 * zoom and at the wrong place after a pan. Viewport coords also let it clamp
 * against the window, which a world-space menu could not do.
 *
 * Only ONE menu exists at a time; opening a second closes the first, and any
 * pointerdown, Escape, resize or blur outside it dismisses it — the behaviour
 * a context menu has everywhere else.
 */

let box = null;

function detach() {
  document.removeEventListener('pointerdown', onAway, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', close);
  window.removeEventListener('resize', close);
}

function close() {
  if (!box) return;
  detach();
  box.remove();
  box = null;
}

/* Capture phase, so it fires before the board's own click handlers. */
function onAway(e) {
  if (box && !box.contains(e.target)) close();
}

function onKey(e) {
  if (e.key === 'Escape') close();
}

/** Dismiss without opening anything (leaving graph view, for instance). */
export function hideMenu() {
  close();
}

/**
 * Show a menu at viewport (x, y).
 *
 * items: Array of
 *   { label, onSelect, danger?, disabled? }   — a row
 *   { sep: true }                             — a divider
 *
 * onSelect runs after the menu is gone, so an action may open a dialog of its
 * own (rename, confirm) without fighting this one for focus.
 */
export function showMenu(x, y, items) {
  close();

  box = document.createElement('div');
  box.className = 'gctx';
  box.setAttribute('role', 'menu');

  for (const it of items) {
    if (!it) continue;
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'gctx-sep';
      box.appendChild(sep);
      continue;
    }
    if (!it.label) continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'gctx-item' + (it.danger ? ' danger' : '');
    row.setAttribute('role', 'menuitem');
    row.textContent = it.label;
    if (it.disabled) {
      row.disabled = true;
    } else {
      row.addEventListener('click', () => {
        close();
        if (typeof it.onSelect === 'function') it.onSelect();
      });
    }
    box.appendChild(row);
  }

  if (!box.childNodes.length) return; // nothing worth showing

  document.body.appendChild(box);

  /* Clamp into the window: a menu opened at the bottom-right corner would
   * otherwise hang off the screen with half its rows unreachable. */
  const r = box.getBoundingClientRect();
  const left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
  box.style.left = Math.round(left) + 'px';
  box.style.top = Math.round(top) + 'px';

  /*
   * Arm the dismissers on the next tick. The contextmenu event that opened us
   * is preceded by a pointerdown — if we listened immediately, that same
   * right-press (which already happened, but whose sibling events may still be
   * in flight) or the very next press would close the menu we just built.
   */
  setTimeout(() => {
    if (!box) return;
    document.addEventListener('pointerdown', onAway, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
  }, 0);
}
