/* word-hover.js — the word under the pointer lifts as you read.
 *
 * A small ink shift (tokens: --ink-hover, a ~10% blend of the base ink toward
 * black in paper theme / white in graphite) applied to the exact word beneath
 * the cursor — and only that word — while the pointer rides across reply text.
 * No background pool, no overlay layer, no DOM rewrite: the highlight is a
 * CSS Custom Highlight API range ("word-hover"), so streaming text, selection,
 * links and code need zero cooperation from stream.js. Skips plain-colored
 * children (links, code) so ember/accent glyphs keep their identity.
 * Chat column (#chat-area) only — explain panels reuse .bubble markup.
 * Graceful no-op on browsers without the Highlight API.
 */
const area = document.getElementById('chat-area');

if (area && window.Highlight && CSS.highlights) {
  const hl = new Highlight();
  CSS.highlights.set('word-hover', hl);

  /* explicitly-colored inline children keep their own colors while hovered */
  const SKIP = 'a, code, kbd, pre, mark, .msg-copy';

  const rangeAt = (x, y) => {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    }
    if (!node || node.nodeType !== 3 || !node.parentElement) return null;
    const host = node.parentElement.closest(
      '#chat-area .msg.assistant .bubble:not(.thinking)');
    if (!host || node.parentElement.closest(SKIP)) return null;
    const text = node.textContent;
    if (!text.trim()) return null;
    const isChar = (c) => !/\s/.test(c);
    let s = Math.min(offset, text.length);
    let e = s;
    while (s > 0 && isChar(text[s - 1])) s--;
    while (e < text.length && isChar(text[e])) e++;
    /* trailing sentence punctuation reads cleaner left in its own color */
    while (e > s && /[,.;:!?]/.test(text[e - 1])) e--;
    if (s === e) return null;
    const out = document.createRange();
    out.setStart(node, s);
    out.setEnd(node, e);
    return out;
  };

  let raf = 0;
  let ev = null;

  const paint = () => {
    raf = 0;
    hl.clear();
    if (!ev) return;
    const r = rangeAt(ev.clientX, ev.clientY);
    if (r) hl.add(r);
  };

  area.addEventListener('mousemove', (e) => {
    ev = e;
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: true });

  area.addEventListener('mouseleave', () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    ev = null;
    hl.clear();
  });
}
