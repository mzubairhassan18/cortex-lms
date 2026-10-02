/* markdown.js — split from public/app.js (app.js line 86-284). */
import { $, state } from './state.js';
import { html } from './views.js';

/* ================= Safe markdown rendering ================= */

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    // ">" is deliberately NOT escaped: a lone > cannot open an HTML tag,
    // and escaping it would break markdown blockquotes ("> quote").
    .replace(/"/g, '&quot;');
}

/* Inline markdown — runs on ALREADY-ESCAPED text (safe by construction:
 * only whitelisted tags are produced, links limited to http/https/mailto). */
export function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

/* Auto-detect markdown syntax in the raw text. Plain chat (including things
 * like "2 * 3") keeps the simple paragraph rendering below. */
export function looksLikeMarkdown(s) {
  return (
    /(^|\n)[ \t]*(#{1,6}[ \t]|[-*+][ \t]|\d+\.[ \t]|>[ \t]?|```)/.test(s) ||
    /(^|\n)[ \t]*([-*_][ \t]*){3,}\n/.test(s) ||
    /(^|\n)[ \t]*\|.+\|/.test(s) ||
    /\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|~~[^~\n]+~~/.test(s)
  );
}

/* The source is escaped BEFORE parsing, so raw HTML in the model output can
 * never reach the DOM. This finishes the job for URLs a markdown link could
 * smuggle in (javascript:, data:, …) and adds safe link attributes. */
export function sanitizeRendered(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href') || '';
    if (/^(https?:\/\/|mailto:)/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('href');
    }
  });
  tpl.content.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src') || '';
    if (!/^https?:\/\//i.test(src)) img.remove();
  });
  return tpl.innerHTML;
}

/* Fallback block renderer (pre-marked): correct for simple content, used
 * only if the library fails to load. Receives already-escaped text. */
export function legacyMarkdown(text) {
  const blocks = text.split(/\n{2,}/);
  return blocks
    .map((block) => {
      const t = block.trim();
      if (!t) return '';
      if (t.startsWith('```')) {
        const code = t.replace(/^```\w*\n?/, '').replace(/```\s*$/, '').trimEnd();
        return `<pre><code>${code}</code></pre>`;
      }
      const h = t.match(/^(#{1,3}) (.*)$/);
      if (h) {
        const level = h[1].length;
        return `<h${level}>${renderInline(h[2])}</h${level}>`;
      }
      if (/^\s*[-*] /.test(t)) {
        const items = t.split('\n').map((l) => `<li>${renderInline(l.replace(/^\s*[-*] /, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
      }
      if (/^\s*\d+\. /.test(t)) {
        const items = t.split('\n').map((l) => `<li>${renderInline(l.replace(/^\s*\d+\. /, ''))}</li>`).join('');
        return `<ol>${items}</ol>`;
      }
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
}

/* Rendering is the single most expensive thing this app does: full rebuilds and
 * the streaming typewriter both ask for the same content repeatedly. Cache the
 * produced HTML keyed by its source (LRU, bounded) so a rebuild costs a lookup
 * instead of a re-parse of the whole conversation. */
const mdCache = new Map();
const MD_CACHE_MAX = 400;
const MD_CACHE_SRC_MAX = 20000; // beyond this it is not worth keeping

function computeMarkdown(raw) {
  const text = escapeHtml(raw);
  if (!looksLikeMarkdown(raw)) return `<p>${text.replace(/\n/g, '<br>')}</p>`;
  if (window.marked) {
    try {
      return sanitizeRendered(marked.parse(text, { breaks: true }));
    } catch {
      /* fall through to the built-in renderer */
    }
  }
  return legacyMarkdown(text);
}

export function renderMarkdown(src) {
  const raw = String(src == null ? '' : src);
  const hit = mdCache.get(raw);
  if (hit !== undefined) {
    mdCache.delete(raw); // LRU — move to the most-recent slot
    mdCache.set(raw, hit);
    return hit;
  }
  const out = computeMarkdown(raw);
  if (raw.length <= MD_CACHE_SRC_MAX) {
    mdCache.set(raw, out);
    if (mdCache.size > MD_CACHE_MAX) mdCache.delete(mdCache.keys().next().value);
  }
  return out;
}

/* Learning Bot badge shown at the top-left edge of assistant responses. */
/* The exact mark from the app header ("🎓 Learning Bot") — shown above
 * each response as-is, no badge background. */
export const AVATAR_MARK = '🎓';

/* One message as a Preact vnode. Text/markdown is inserted the same way as
 * before — the body goes through renderMarkdown() (which escapes the source)
 * and lands in the DOM via dangerouslySetInnerHTML; everything else is plain
 * text that Preact escapes for us, so no manual escaping here. */
export function messageVNode(m, i, scope) {
  const isUser = m.role === 'user';
  const bubble = html`<div
    class="bubble"
    dangerouslySetInnerHTML=${{ __html: renderMarkdown(m.content) }}
  ></div>`;
  if (isUser) return html`<div class="msg user">${bubble}</div>`;
  return html`<div class="msg assistant">
    <span class="msg-avatar" title="Learning Bot">${AVATAR_MARK}</span>
    <div class="msg-body">
      ${bubble}
      <button
        type="button"
        class="msg-copy"
        data-i=${String(i)}
        data-scope=${scope || null}
        title="Copy the whole response"
      >
        ⧉ Copy
      </button>
    </div>
  </div>`;
}

/* ================= Copy helpers ================= */

export async function copyText(text, btn) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      try {
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand('copy');
      } finally {
        ta.remove(); // never leave the fallback textarea in the document
      }
    } catch {
      ok = false;
    }
  }
  if (btn) {
    const old = btn.innerHTML;
    btn.textContent = ok ? '✓ Copied' : '✗ Failed';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.innerHTML = old;
      btn.classList.remove('copied');
    }, 1500);
  }
  return ok;
}

/* Wrap each <pre> in a header strip carrying its language + a copy button. */
export function decorateCopy(root) {
  if (!root) return;
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.closest('.code-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.parentNode.insertBefore(wrap, pre);
    const head = document.createElement('div');
    head.className = 'code-lang';
    const codeEl = pre.querySelector('code');
    const m = codeEl && (codeEl.className.match(/language-([\w+#.-]+)/) || [])[1];
    head.textContent = m || 'code';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'code-copy';
    btn.title = 'Copy code to clipboard';
    btn.textContent = '⧉ Copy';
    const bar = document.createElement('div');
    bar.className = 'code-head';
    bar.appendChild(head);
    bar.appendChild(btn);
    wrap.appendChild(bar);
    wrap.appendChild(pre);
  });
}

/* One delegated listener: copy buttons anywhere (chat, explainers, quiz…). */
document.addEventListener('click', (e) => {
  const codeBtn = e.target.closest('.code-copy');
  if (codeBtn) {
    const pre = codeBtn.closest('.code-wrap');
    if (pre) copyText(pre.querySelector('pre').innerText.replace(/\n+$/, ''), codeBtn);
    return;
  }
  const respBtn = e.target.closest('.msg-copy');
  if (respBtn) {
    const scope = respBtn.dataset.scope;
    const arr = scope
      ? (state.explains.nodes[scope] || {}).messages
      : state.messages;
    const m = arr && arr[+respBtn.dataset.i];
    if (m) copyText(m.content, respBtn);
  }
});
