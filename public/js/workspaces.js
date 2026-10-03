/* workspaces.js — the zoomed-out view of the app.
 *
 * A workspace is a named bucket of conversations. Zoom the graph below
 * ZOOM_WS and the conversation nodes hand over to the workspaces holding
 * them; picking one puts you back at 100%, inside it.
 *
 * Dependency direction: this module imports conversations.js (list loading)
 * but NEVER graph.js — the graph publishes `state.zoomTo` / `state.onZoomChange`
 * so the arrow points the other way. Same rule as state.onGraphChange.
 */
import { explainSnapshot, persistNow } from './chat.js';
import {
  loadConversations,
  resetActiveConversation,
  selectConversation,
} from './conversations.js';
import { clearExplainWindows } from './explain-lifecycle.js';
import { renderChips } from './files.js';
import { renderSummary } from './summary.js';
import { $, state } from './state.js';
import { Fragment, html, render } from './views.js';

export const ZOOM_WS = 0.5; // at or below this, the workspace cards take over

let layer = null;
let visible = false;
let editing = null; // workspace id being renamed, or 'new' for the create card

/* ================= data ================= */

export async function loadWorkspaces() {
  try {
    const r = await fetch('/api/workspaces');
    state.workspaces = r.ok ? await r.json() : [];
  } catch {
    state.workspaces = [];
  }

  // The workspace remembered across reloads may have been deleted.
  if (!state.workspaces.some((w) => w.id === state.workspaceId)) {
    state.workspaceId = state.workspaces.length ? state.workspaces[0].id : '';
    try {
      localStorage.setItem('lb.workspace', state.workspaceId);
    } catch { /* private mode */ }
  }
  return state.workspaces;
}

export async function switchWorkspace(id) {
  if (!id || id === state.workspaceId) {
    if (state.zoomTo) state.zoomTo(1); // already here — just dive back in
    return;
  }

  const prevId = state.currentId;
  const prevMessages = state.messages;
  const prevSnapshot = explainSnapshot();

  state.workspaceId = id;
  editing = null;
  try {
    localStorage.setItem('lb.workspace', id);
  } catch { /* private mode */ }

  await loadConversations(); // scoped to the new workspace
  await loadWorkspaces(); // counts changed sides

  if (state.conversations.length) {
    // selectConversation() persists the outgoing conversation first, and the
    // old id is still in state.currentId at this point, so the save lands.
    await selectConversation(state.conversations[0].id);
  } else {
    persistNow(prevId, prevMessages, prevSnapshot); // an empty workspace still saves
    resetActiveConversation();
    clearExplainWindows();
    if (state.onGraphChange) state.onGraphChange();
  }

  if (state.zoomTo) state.zoomTo(1);
  setVisible(false);
}

export async function createWorkspace(name) {
  const r = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(data.error || 'Could not create the workspace.');
    return null;
  }
  await loadWorkspaces();
  await switchWorkspace(data.id); // creating one means you want to be in it
  return data;
}

export async function renameWorkspace(id, name) {
  const r = await fetch(`/api/workspaces/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(d.error || 'Could not rename the workspace.');
  }
  await loadWorkspaces();
}

export async function deleteWorkspace(id) {
  const w = state.workspaces.find((x) => x.id === id);
  if (!w) return;
  const n = w.conversationCount || 0;
  const msg = n
    ? `Delete "${w.name}" and its ${n} conversation${n === 1 ? '' : 's'}?\n\n` +
      'They are archived, not destroyed.'
    : `Delete workspace "${w.name}"?`;
  if (!confirm(msg)) return;

  // Deleting a workspace that holds conversations has to be explicit.
  const url = `/api/workspaces/${id}${n ? '?force=1' : ''}`;
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(d.error || 'Could not delete the workspace.');
    return;
  }
  const wasOpen = state.workspaceId === id;
  await loadWorkspaces();
  if (wasOpen) {
    state.workspaceId = ''; // loadWorkspaces() will pick a survivor
    await loadWorkspaces();
    await switchWorkspace(state.workspaces[0] && state.workspaces[0].id);
  }
  renderLayer();
}

/* ================= layer ================= */

function setVisible(on) {
  if (on === visible || !layer) return;
  visible = on;
  layer.classList.toggle('hidden', !on);
  if (on) {
    editing = null;
    renderLayer();
  }
}

function renderLayer() {
  if (!layer) return;
  render(
    html`<${Fragment}>
      <div class="ws-head">
        <span class="ws-eyebrow">Zoomed out</span>
        <h2 class="ws-title">Workspaces</h2>
        <p class="ws-sub">
          Every conversation lives in a workspace. Pick one to dive back in — or start a new
          workspace.
        </p>
      </div>
      <div class="ws-grid">
        ${state.workspaces.map(
          (w) => html`<div
            class=${'ws-card' + (w.id === state.workspaceId ? ' current' : '')}
            data-ws=${w.id}
          >
            ${editing === w.id
              ? html`<input
                  class="ws-rename"
                  data-ws-input=${w.id}
                  value=${w.name}
                  placeholder="Workspace name"
                  spellcheck="false"
                />`
              : html`<button class="ws-open" data-open=${w.id} type="button">
                  <span class="ws-name">${w.name}</span>
                  <span class="ws-count"
                    >${w.conversationCount || 0}
                    conversation${(w.conversationCount || 0) === 1 ? '' : 's'}</span
                  >
                </button>`}
            <div class="ws-tools">
              <button class="ws-tool" data-rename=${w.id} type="button" title="Rename workspace"
                ><svg class="ico" aria-hidden="true"><use href="#i-pencil"></use></svg></button
              >
              <button class="ws-tool" data-del=${w.id} type="button" title="Delete workspace"
                ><svg class="ico" aria-hidden="true"><use href="#i-x"></use></svg></button
              >
            </div>
            ${w.id === state.workspaceId ? html`<span class="ws-badge">Open</span>` : null}
          </div>`
        )}
        <div class="ws-card ws-create">
          ${editing === 'new'
            ? html`<input
                class="ws-rename"
                data-ws-input="new"
                placeholder="Workspace name"
                spellcheck="false"
              />`
            : html`<button class="ws-open ws-new" data-new type="button">
                <span class="ws-name"
                  ><svg class="ico" aria-hidden="true"><use href="#i-plus"></use></svg> New
                  workspace</span
                >
                <span class="ws-count">a blank one</span>
              </button>`}
        </div>
      </div>
    <//>`,
    layer
  );
}

function focusInput() {
  const el = layer && layer.querySelector('[data-ws-input]');
  if (el) {
    el.focus();
    el.select && el.select();
  }
}

async function commitName(key, value) {
  const name = String(value || '').trim().slice(0, 60);
  editing = null;
  if (!name) {
    renderLayer();
    return;
  }
  if (key === 'new') await createWorkspace(name);
  else await renameWorkspace(key, name);
  renderLayer();
}

function onClick(e) {
  const open = e.target.closest('[data-open]');
  if (open) {
    switchWorkspace(open.dataset.open);
    return;
  }
  const ren = e.target.closest('[data-rename]');
  if (ren) {
    editing = ren.dataset.rename;
    renderLayer();
    focusInput();
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    deleteWorkspace(del.dataset.del);
    return;
  }
  if (e.target.closest('[data-new]')) {
    editing = 'new';
    renderLayer();
    focusInput();
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    editing = null;
    renderLayer();
    return;
  }
  if (e.key !== 'Enter') return;
  const inp = e.target.closest('[data-ws-input]');
  if (inp) commitName(inp.dataset.wsInput, inp.value);
}

/* ================= wiring ================= */

export async function initWorkspaces() {
  layer = $('ws-layer');
  // Always reconcile, even if the layer element is missing — every conversation
  // list load reads state.workspaceId.
  await loadWorkspaces();
  if (layer) {
    layer.addEventListener('click', onClick);
    layer.addEventListener('keydown', onKeydown);
    renderLayer();
  }
  // graph.js pushes zoom out through this instead of us importing it.
  state.onZoomChange = (z) => setVisible(state.view === 'graph' && z <= ZOOM_WS);
  // If the graph applied its saved zoom before we registered, ask it now.
  if (state.zoomLevel) state.onZoomChange(state.zoomLevel());
}
