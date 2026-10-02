/* selection.js — split from public/app.js (app.js line 1361-1607). */
import { createConversation } from './chat.js';
import { createExplainWindow } from './explain-lifecycle.js';
import { escapeHtml, renderInline } from './markdown.js';
import { $, explainPanels, messagesEl, popup, state } from './state.js';
import { bgRequest, enqueueBg, renderSummary, summaryCache } from './summary.js';
import { html } from './views.js';

/* ================= Text selection popup ================= */

/* Text of a bubble WITHOUT the copy-button chrome: strip code headers and
 * add our own block separators (textContent has none, innerText would drag
 * the button/lang labels along). */
export function bubbleText(bubble) {
  if (!bubble) return '';
  const clone = bubble.cloneNode(true);
  clone.querySelectorAll('.code-head').forEach((el) => el.remove());
  clone.querySelectorAll('pre').forEach((el) => el.insertAdjacentText('beforebegin', '\n\n'));
  clone
    .querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote')
    .forEach((el) => el.insertAdjacentText('beforeend', '\n'));
  return clone.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

/* The message around the selection — kept so saved notes stay understandable
 * later (role + the text of that bubble). */
export function noteSourceFrom(anchor) {
  const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
  const msg = el && el.closest('.msg');
  if (!msg) return '';
  const role = msg.classList.contains('user') ? 'user' : 'assistant';
  const txt = bubbleText(msg.querySelector('.bubble')).slice(0, 4000);
  return JSON.stringify({ role, text: txt });
}

export function showPopup(rect, text, originId, src) {
  popup.dataset.text = text;
  popup.dataset.origin = originId || ''; // '' = main chat (root window)
  popup.dataset.src = src || '';
  popup.style.display = 'flex';
  popup.style.left = `${rect.left}px`;
  popup.style.top = `${rect.bottom + 8}px`;
}

export function hidePopup() {
  popup.style.display = 'none';
  // The selected text can be large — never leave it parked on the element,
  // where it stays for the lifetime of the page.
  delete popup.dataset.text;
  delete popup.dataset.src;
  delete popup.dataset.origin;
}

export function selectionWithin(container) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (text.length < 2) return null;
  if (!container.contains(sel.anchorNode)) return null;
  return { sel, text, rect: sel.getRangeAt(0).getBoundingClientRect() };
}

export function makeSelectionHandlers(container, originOf) {
  container.addEventListener('mouseup', () => {
    setTimeout(() => {
      const found = selectionWithin(container);
      if (!found) { hidePopup(); return; }
      showPopup(found.rect, found.text, originOf(found.sel.anchorNode), noteSourceFrom(found.sel.anchorNode));
    }, 10);
  });

  container.addEventListener('dblclick', () => {
    const found = selectionWithin(container);
    if (found) {
      hidePopup();
      createExplainWindow(found.text, originOf(found.sel.anchorNode) || null);
    }
  });

  container.addEventListener('scroll', hidePopup);
}

/* Main chat selections create ROOT windows. */
makeSelectionHandlers(messagesEl, () => '');

/* Selections inside an explain window create a CHILD of that window. */
makeSelectionHandlers(explainPanels, (anchor) => {
  const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  const panel = el && el.closest('.ex-container');
  return panel ? panel.dataset.id : '';
});

popup.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const text = popup.dataset.text;
  const origin = popup.dataset.origin || '';
  const src = popup.dataset.src || '';
  hidePopup();
  if (btn.dataset.act === 'note') {
    saveNote(text, src);
  } else if (text) {
    createExplainWindow(text, origin || null);
  }
});

document.addEventListener('mousedown', (e) => {
  if (!popup.contains(e.target)) hidePopup();
});

/* ================= Personal notes =================
 * Notes are stored per conversation (server-side) OUTSIDE the AI summary,
 * so regenerating the summary never overwrites what the user saved.
 * Capture: instant + verbatim (never blocked, never fails), then an
 * optional background LLM pass polishes the fragment into a one-line
 * study note (✨). If the model is slow/down, the verbatim note stands. */

export let toastTimer = null;
export function showToast(html) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

export function persistNotes() {
  if (!state.currentId) return;
  fetch(`/api/conversations/${state.currentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: state.notes || [] }),
  }).catch(() => {});
}

/* The sentence containing the selection — so a mid-sentence highlight
 * ("stores a value in") still reads with its surroundings later. */
export function sentenceAround(full, sel) {
  if (!full || !sel) return '';
  const i = full.indexOf(sel);
  if (i < 0) return full.slice(0, 240).trim(); // selection spans odd boundaries
  const end = i + sel.length;
  let s = full.lastIndexOf('. ', i);
  s = s < 0 ? 0 : s + 2;
  let e = full.indexOf('. ', end);
  if (e < 0) e = Math.min(full.length, end + 120);
  else e += 1;
  const out = full.slice(s, e).trim();
  return out.length > 400 ? `${out.slice(0, 397)}…` : out;
}

export async function saveNote(text, src) {
  if (!text) return;
  if (!state.currentId) await createConversation();
  let srcObj = null;
  try {
    srcObj = src ? JSON.parse(src) : null;
  } catch { /* no context available */ }
  const note = {
    id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text,               // what is shown (verbatim until polished)
    raw: text,          // the original highlight (kept for re-polish/reference)
    context: sentenceAround((srcObj && srcObj.text) || '', text),
    role: (srcObj && srcObj.role) || 'assistant',
    polished: false,
    at: Date.now(),
  };
  state.notes = state.notes || [];
  state.notes.push(note);
  persistNotes();
  renderSummary(summaryCache[state.currentId] || null, state.lastSummaryStatus || '');
  showToast('📌 Saved to notes');
  // Non-blocking polish: any model the Auto route picks; failure = verbatim.
  enqueueBg(() => polishNote(state.currentId, note.id));
}

/* Background AI polish — turns the fragment into a standalone one-liner. */
export async function polishNote(convId, noteId) {
  if (convId !== state.currentId) return; // note already saved verbatim
  const note = (state.notes || []).find((n) => n.id === noteId);
  if (!note || note.polished) return;
  try {
    const txt = await bgRequest(
      [
        {
          role: 'system',
          content: [
            'Rewrite a highlighted fragment from a study conversation into ONE standalone study note.',
            'Rules: at most 25 words, plain statement, keep the original meaning,',
            'supply the missing subject from the source sentence when the fragment needs one.',
            'Output ONLY the note — no quotes, no labels, no bullet, no explanation.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `Fragment: ${note.raw}${note.context ? `\nSource sentence: ${note.context}` : ''}`,
        },
      ],
      null,
      { temperature: 0.3, maxTokens: 120 }
    );
    const clean = (txt || '')
      .replace(/^[-*•]\s+/, '')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim();
    if (clean && clean.length <= 240 && !/^\s*⚠|error/i.test(clean)) {
      note.text = clean;
      note.polished = true;
      persistNotes();
      if (state.currentId === convId) {
        renderSummary(summaryCache[convId] || null, state.lastSummaryStatus || '');
      }
    }
  } catch { /* keep the verbatim note */ }
}

/* "📌 Your notes" card — rendered under the AI summary, always present.
 * Returns a vnode, not an HTML string: Preact escapes every text child, so
 * only the AI-polished inline markdown (already escaped, then run through
 * renderInline) goes through dangerouslySetInnerHTML — same rule as bubbles. */
export function notesSectionVNode() {
  const notes = state.notes || [];
  if (!notes.length) {
    return html`<div class="notes-card notes-empty-card">
      <div class="notes-head">📌 Your notes</div>
      <div class="notes-hint">Select any text in the chat and press 📌 Note — your notes live here and survive summary regeneration.</div>
    </div>`;
  }
  return html`<div class="notes-card">
    <div class="notes-head">
      📌 Your notes <span class="notes-count">${notes.length}</span>
    </div>
    <ul class="notes-list">
      ${notes.map((n) => {
        const ctx = String(n.context || '');
        const shown = ctx.length > 160 ? `${ctx.slice(0, 157)}…` : ctx;
        return html`<li class="note-item" data-note=${n.id}>
          <div
            class="note-text"
            dangerouslySetInnerHTML=${{
              __html:
                renderInline(escapeHtml(String(n.text || ''))) +
                (n.polished
                  ? ' <span class="note-ai" title="AI-polished from your highlight">✨</span>'
                  : ''),
            }}
          />
          ${shown ? html`<div class="note-src">from: “${shown}”</div>` : null}
          <button type="button" class="note-del" data-note=${n.id} title="Delete this note">
            ✕
          </button>
        </li>`;
      })}
    </ul>
  </div>`;
}

/* ================= Files: chips, upload, Library =================
 * Attachments live per conversation (data/uploads/<convId>/). Extracted
 * text is fetched once and injected into this conversation's system prompt
 * on send; the UI only ever shows a small chip. */
