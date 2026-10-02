/* library.js — split from public/app.js (app.js line 1762-1853). */
import { selectConversation } from './conversations.js';
import { hideExplainPanel, showSidebar } from './explain-ui.js';
import { fileTextCache, fmtSize, renderChips } from './files.js';
import { setSummaryOverlay } from './overlays.js';
import { $, input, libraryBody, libraryBtn, libraryClose, libraryOverlay, settingsOverlay, state } from './state.js';
import { html, render } from './views.js';

/* ---------- Library overlay ---------- */

/* The library lives inside the explainer panel. Clicking the toolbar
 * button must OPEN the panel first when it is closed (same as Summary),
 * and on exit the panel is restored to its previous state when it was
 * opened only for the library. Toggle: clicking the button again closes. */
export let libraryOpenedPanel = false;

libraryBtn.addEventListener('click', () => {
  if (!libraryOverlay.classList.contains('hidden')) {
    closeLibrary();
    return;
  }
  setSummaryOverlay(false);
  settingsOverlay.classList.add('hidden');
  const panelHidden = !state.sidebar.open;
  if (panelHidden) showSidebar(); // the overlay lives over the containers
  libraryOpenedPanel = panelHidden;
  libraryOverlay.classList.remove('hidden');
  libraryBtn.classList.add('on');
  document.body.classList.add('library-open');
  renderLibrary();
});

export function closeLibrary(restorePanel = true) {
  libraryOverlay.classList.add('hidden');
  libraryBtn.classList.remove('on');
  document.body.classList.remove('library-open');
  if (libraryOpenedPanel) {
    libraryOpenedPanel = false;
    // The panel was opened just for the library and there is nothing else
    // to show in it -> put things back the way they were.
    if (restorePanel && !state.explains.roots.length) hideExplainPanel();
  }
}
libraryClose.addEventListener('click', () => closeLibrary());

export async function renderLibrary() {
  render(html`<div class="lib-empty">Loading…</div>`, libraryBody);
  try {
    const res = await fetch('/api/files');
    const files = await res.json();
    if (!Array.isArray(files) || !files.length) {
      render(
        html`<div class="lib-empty">No files yet — press ＋ next to the input (or drag & drop) to attach Word, PDF or text files and links.</div>`,
        libraryBody
      );
      return;
    }
    render(
      html`<div class="lib-list">
        ${files.map(
          (f) => html`<div class="lib-row">
            <span class="lib-ico">${f.link ? '🔗' : '📎'}</span>
            <div class="lib-main">
              <div class="lib-name" title=${f.link || f.name}>${f.name}</div>
              <div class="lib-meta">
                ${f.convTitle || 'Conversation'} · ${f.link ? 'link' : fmtSize(f.size)} · ${new Date(
                  f.at || Date.now()
                ).toLocaleString()}
              </div>
            </div>
            <button type="button" class="lib-open" data-conv=${f.convId}>Open</button>
            <button
              type="button"
              class="lib-del"
              data-conv=${f.convId}
              data-fid=${f.id}
              title="Delete file"
            >
              ✕
            </button>
          </div>`
        )}
      </div>`,
      libraryBody
    );
  } catch {
    render(html`<div class="lib-empty">Could not load the library.</div>`, libraryBody);
  }
}

libraryBody.addEventListener('click', async (e) => {
  const open = e.target.closest('.lib-open');
  if (open) {
    closeLibrary(); // restore the panel if the library opened it
    await selectConversation(open.dataset.conv);
    return;
  }
  const del = e.target.closest('.lib-del');
  if (del) {
    const { conv, fid } = del.dataset;
    if (!confirm('Delete this file from the library?')) return;
    await fetch(`/api/conversations/${conv}/files/${fid}`, { method: 'DELETE' }).catch(() => {});
    if (conv === state.currentId) {
      state.files = (state.files || []).filter((f) => f.id !== fid);
      if (fileTextCache[conv]) delete fileTextCache[conv][fid];
      renderChips();
    }
    renderLibrary();
  }
});
