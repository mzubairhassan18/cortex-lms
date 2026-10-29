/* lamp.js — a warm cursor lamp over chat reading text.
 *
 * As the pointer crosses an assistant reply, a soft light pool follows it.
 * Light weight by design: mousemove writes two CSS vars (--mx/--my, rAF
 * throttled); the wash itself lives in style.css on the bubble's ::after,
 * so this module owns no visuals. Clears on leave. Chat column only.
 */
const area = document.getElementById('chat-area');

/* presence marker for tooling/diagnosis (no runtime role) */
document.documentElement.dataset.lamp = area ? 'on' : 'off';

if (area) {
  let cur = null;
  let raf = 0;
  let ev = null;

  const paint = () => {
    raf = 0;
    if (!cur || !ev) return;
    const r = cur.getBoundingClientRect();
    cur.style.setProperty('--mx', `${Math.round(ev.clientX - r.left)}px`);
    cur.style.setProperty('--my', `${Math.round(ev.clientY - r.top)}px`);
  };

  area.addEventListener('mousemove', (e) => {
    const el = e.target && e.target.closest
      ? e.target.closest('.msg.assistant .bubble:not(.thinking)')
      : null;
    if (el !== cur) {
      if (cur) { cur.style.removeProperty('--mx'); cur.style.removeProperty('--my'); }
      cur = el;
    }
    if (!cur) return;
    ev = e;
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: true });

  area.addEventListener('mouseleave', () => {
    if (cur) { cur.style.removeProperty('--mx'); cur.style.removeProperty('--my'); cur = null; }
  });
}
