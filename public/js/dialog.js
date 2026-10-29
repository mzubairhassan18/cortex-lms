/*
 * dialog.js — the app's small dialog layer. Replaces window.alert/confirm.
 *
 * Why not a big central modal: the action the user started is a small thing
 * happening in a known place ("Delete" in a menu, a failed send in the
 * composer), so the question appears BESIDE the initiator — anchored, small,
 * quick to read, quick to dismiss. When there is no anchor (or the anchor has
 * no size, e.g. a menu item that is already closing) the dialog falls back to
 * the center with a soft scrim, so it is never lost.
 *
 * Behaviour contract (docs/DESIGN.md §6):
 *   - tokens only; shadow-pop is the one allowed shadow
 *   - ESC / click-away = cancel; focus is trapped inside and restored to the
 *     initiator element afterwards
 *   - motion: enter rise 6px + fade (--t-med), exit fade (--t-fast);
 *     prefers-reduced-motion collapses both (tokens.css base layer)
 *   - buttons name actions ("Delete", "Keep"), never OK/Cancel
 *
 * API
 *   await confirmPop(anchor, { title, message, confirmLabel, cancelLabel, danger })
 *     → true if the confirm action was chosen
 *   await alertPop(anchor, { title, message, okLabel })
 *     → true once acknowledged
 *   await promptPop(anchor, { title, message, placeholder, initial })
 *     → the entered string, or null when dismissed
 * `anchor` is an Element or a DOMRect-ish {left, top, width, height}.
 */

let host = null;   // the live dialog bubble
let scrim = null;  // only shown by the centered fallback
let resolveLive = null; // resolves the live dialog's promise

function ensureHost() {
  let root = document.getElementById('dialog-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'dialog-root';
    root.style.cssText = 'position:fixed;z-index:900;inset:0;pointer-events:none;';
    document.body.appendChild(root);
  }
  return root;
}

/* Anchored placement: prefer below the anchor, then above, then sides; clamp
 * into the viewport with an 8px margin. Centered fallback keeps the dialog
 * reachable when nothing is anchored. `bubble` is the positioned .dlg child;
 * #dialog-root itself is the fullscreen pass-through layer. */
function position(bubble, anchorRect, w, h) {
  const M = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (anchorRect && anchorRect.width > 0 && anchorRect.height > 0) {
    const ar = { x: anchorRect.left, y: anchorRect.top, w: anchorRect.width, h: anchorRect.height };
    const spots = [
      { x: ar.x, y: ar.y + ar.h + 8 },            // below, left-aligned
      { x: ar.x + ar.w - w, y: ar.y + ar.h + 8 }, // below, right-aligned
      { x: ar.x, y: ar.y - h - 8 },               // above
      { x: ar.x + ar.w + 8, y: ar.y },            // right
      { x: ar.x - w - 8, y: ar.y },               // left
    ];
    for (const s of spots) {
      const c = {
        x: Math.min(Math.max(s.x, M), Math.max(M, vw - w - M)),
        y: Math.min(Math.max(s.y, M), Math.max(M, vh - h - M)),
      };
      if (c.x >= M && c.y >= M && c.x + w <= vw - M && c.y + h <= vh - M) {
        bubble.style.left = c.x + 'px';
        bubble.style.top = c.y + 'px';
        return;
      }
    }
  }

  bubble.style.left = Math.round(Math.max(M, (vw - w) / 2)) + 'px';
  bubble.style.top = Math.round(Math.max(M, Math.min(vh - h - M, Math.round((vh - h) / 2)))) + 'px';
  if (!scrim) {
    scrim = document.createElement('div');
    scrim.className = 'dlg-scrim';
    bubble.before(scrim);
  }
}

/* Focus trap: Tab cycles inside the dialog; Escape always cancels. Focus
 * lands on the first (safe) action — or the field for prompts — so a stray
 * Enter never deletes anything. */
function trap() {
  const focusables = [...host.querySelectorAll('button')];
  const first = focusables[0] || host.querySelector('.dlg-input') || host;
  const fld = host.querySelector('.dlg-input');
  if (fld) { fld.focus(); fld.select(); } else first.focus();
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); finishSafe(); return; }
    if (e.key !== 'Tab') return;
    const i = focusables.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) {
      e.preventDefault();
      focusables[focusables.length - 1].focus();
    } else if (!e.shiftKey && i === focusables.length - 1) {
      e.preventDefault();
      first.focus();
    }
  });
  function finishSafe() {
    const done = resolveLive;
    resolveLive = null;
    closeDialog();
    if (done) done(null);
  }
  first.focus();
}

export function closeDialog() {
  if (!host) return;
  const dying = host;
  const done = resolveLive;
  host = null;
  resolveLive = null;
  dying.classList.remove('dlg-in');
  dying.classList.add('dlg-out');
  /* reduced-motion zeroes the duration, but animationend still fires */
  let ended = false;
  const rm = () => {
    if (ended) return;
    ended = true;
    dying.remove();
    if (scrim) { scrim.remove(); scrim = null; }
  };
  dying.addEventListener('animationend', rm, { once: true });
  setTimeout(rm, 300); // belt and braces

  if (done) done(null);
  /* Restore focus synchronously — if a newer dialog is already open, the
   * newer openDialog() has by now captured the restored element as ITS
   * return target, and focus custody chains correctly. Restoring from a
   * delayed animation callback would steal focus out of the live dialog. */
  const rf = dying.__restore;
  if (rf && document.contains(rf)) {
    try { rf.focus({ focusVisible: false }); } catch { try { rf.focus(); } catch { /* detached */ } }
  }
}

function openDialog(anchor, opts, buttons) {
  if (host) closeDialog(); // one live dialog at a time (old one resolves null)

  const root = ensureHost();

  /* Focus return custody — stored on the host so each dialog restores only
   * what was focused before IT opened. */
  host = document.createElement('div');
  host.className = 'dlg dlg-in';
  host.__restore = document.activeElement && document.contains(document.activeElement)
    ? document.activeElement : null;
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', 'dlg-t');
  host.setAttribute('aria-describedby', 'dlg-m');
  host.innerHTML = opts.input
    ? '<div class="dlg-title" id="dlg-t"></div>' +
      '<div class="dlg-msg" id="dlg-m"></div>' +
      '<input class="dlg-input" id="dlg-i" type="text" autocomplete="off" spellcheck="false">' +
      '<div class="dlg-row"></div>'
    : '<div class="dlg-title" id="dlg-t"></div>' +
      '<div class="dlg-msg" id="dlg-m"></div>' +
      '<div class="dlg-row"></div>';
  /* textContent only — server error strings never become markup */
  host.querySelector('#dlg-t').textContent = opts.title || '';
  host.querySelector('#dlg-m').textContent = opts.message || '';

  if (opts.input) {
    const fld = host.querySelector('#dlg-i');
    fld.placeholder = opts.placeholder || '';
    fld.value = opts.initial || '';
    fld.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); const done = resolveLive; resolveLive = null; closeDialog(); if (done) done(fld.value.trim()); }
    });
  }

  let first;
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'dlg-act ' + (b.danger ? 'dlg-danger' : b.ghost ? 'dlg-ghost' : 'dlg-ink');
    el.textContent = b.label;
    el.addEventListener('click', () => {
      const done = resolveLive;
      resolveLive = null;
      closeDialog();
      if (done) done(b.value);
    });
    host.querySelector('.dlg-row').appendChild(el);
    if (!first) first = el;
  }

  root.appendChild(host);
  position(host, anchor || null, host.offsetWidth, host.offsetHeight);
  trap();

  return new Promise((resolve) => (resolveLive = resolve));
}

export function confirmPop(anchor, o) {
  return openDialog(
    rectOrPoint(anchor),
    { title: o.title, message: o.message },
    [
      { label: o.cancelLabel || 'Keep', value: false, ghost: true },
      { label: o.confirmLabel || 'Delete', value: true, danger: o.danger !== false },
    ]
  ).then((v) => v === true);
}

export function alertPop(anchor, o) {
  return openDialog(
    rectOrPoint(anchor),
    { title: o.title, message: o.message },
    [{ label: o.okLabel || 'Got it', value: true }]
  ).then((v) => v === true);
}

export function promptPop(anchor, o) {
  return openDialog(
    rectOrPoint(anchor),
    { title: o.title, message: o.message, input: true, placeholder: o.placeholder, initial: o.initial },
    [
      { label: o.cancelLabel || 'Cancel', value: false, ghost: true },
      { label: o.okLabel || 'Add', value: true },
    ]
  ).then((v) => (typeof v === 'string' ? v : null));
}

/* Accept an Element, a rect, or nothing. A zero-size anchor (a hover-revealed
 * delete button, a menu item that already closed) climbs to the nearest
 * ancestor that actually has a box, so the dialog still appears beside the
 * row/menu instead of centering far away. */
function rectOrPoint(a) {
  if (!a) return null;
  if (!a.nodeType) return a; // plain rect-ish object
  let el = a;
  for (let i = 0; i < 4 && el; i++) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) return r;
    el = el.parentElement;
  }
  return a.getBoundingClientRect ? a.getBoundingClientRect() : null;
}

if (typeof document !== 'undefined') {
  if (document.readyState !== 'loading') ensureHost();
  else document.addEventListener('DOMContentLoaded', ensureHost, { once: true });
}
