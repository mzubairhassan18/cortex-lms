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
import { at } from './base.js';
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

export const ZOOM_WS = 0.4; // at or below this, the workspace cards take over

let layer = null;
let visible = false;
let editing = null; // workspace id being renamed, or 'new' for the create card
let layerQuery = ''; // the search box in the zoomed-out layer
let layerView = 'grid'; // grid | list — same storage key as the /workspaces picker,
                        // so the two screens have never disagreed about layout
const VIEW_KEY = 'lb.pickerview';

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
  renderSwitcher();
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
  renderSwitcher();
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
  /* The body class is what takes the window over (see graph.css): with the
   * toolbar and rails hidden the cards own the screen. Removed on the way
   * back in, so nothing is left hidden once you dive back down. */
  document.body.classList.toggle('ws-zoomed', on);
  if (on) {
    editing = null;
    renderLayer();
  }
}

/* Every workspace that survives the search box — the create card is dropped
 * while filtering, because a new workspace would never match a query. */
function filtered() {
  const q = layerQuery.trim().toLowerCase();
  if (!q) return state.workspaces;
  return state.workspaces.filter((w) => String(w.name || '').toLowerCase().includes(q));
}

function gridRows() {
  const rows = filtered().map(
    (w) => html`<div class=${'ws-card' + (w.id === state.workspaceId ? ' current' : '')} data-ws=${w.id}>
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
  );

  if (!layerQuery.trim()) {
    rows.push(html`<div class="ws-card ws-create">
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
    </div>`);
  }
  return rows;
}

const isEmpty = () => filtered().length === 0 && !!layerQuery.trim();

/*
 * The grid ONLY. Typing in the search box has to refresh the cards without
 * rebuilding the toolbar — re-rendering the input on every keystroke would
 * discard its focus and caret, which is exactly why the /workspaces picker
 * keeps its search field outside the element it re-renders.
 */
function renderCards() {
  if (!layer) return;
  const grid = layer.querySelector('[data-ws-grid]');
  // Never fall back to renderLayer() from in here: renderLayer() calls THIS,
  // and a missing grid would bounce between the two until the stack ran out.
  if (!grid) return;
  render(html`<${Fragment}>${gridRows()}</${Fragment}>`, grid);
  const none = layer.querySelector('.ws-none');
  if (none) none.hidden = !isEmpty();
}

function renderLayer() {
  if (!layer) return;
  const view = layerView;
  render(
    html`<${Fragment}>
      <div class="ws-head">
        <span class="ws-eyebrow">Zoomed out</span>
        <h2 class="ws-title">Workspaces</h2>
        <!--
          How to get back. The old prose told you what a workspace is; the real
          question when the board has vanished is which gesture brings it back,
          and that gesture needs Ctrl (plain wheel still pans) — so say it.
        -->
        <p class="ws-sub ws-hint">
          <kbd class="ws-kbd">CTRL</kbd>
          <span class="ws-hint-op">+</span>
          <kbd class="ws-kbd">MOUSE WHEEL</kbd>
          <span class="ws-hint-tail">to zoom back in</span>
        </p>
      </div>

      <div class="ws-bar">
        <label class="ws-search">
          <svg class="ico" aria-hidden="true"><use href="#i-search"></use></svg>
          <input
            type="search"
            data-ws-q
            value=${layerQuery}
            placeholder="Search workspaces…"
            autocomplete="off"
            spellcheck="false"
            aria-label="Search workspaces"
          />
        </label>
        <div class="ws-views" role="group" aria-label="Layout">
          <button
            type="button"
            data-ws-view="grid"
            class=${view === 'grid' ? 'on' : ''}
            aria-pressed=${view === 'grid' ? 'true' : 'false'}
            title="Grid view"
          >
            <svg class="ico" aria-hidden="true"><use href="#i-grid"></use></svg> Grid
          </button>
          <button
            type="button"
            data-ws-view="list"
            class=${view === 'list' ? 'on' : ''}
            aria-pressed=${view === 'list' ? 'true' : 'false'}
            title="List view"
          >
            <svg class="ico" aria-hidden="true"><use href="#i-list"></use></svg> List
          </button>
        </div>
      </div>

      <div class=${'ws-grid' + (view === 'list' ? ' is-list' : '')} data-ws-grid></div>
      <p class="ws-none">No workspace matches that search.</p>
    <//>`,
    layer
  );
  /* Fill the grid and set the empty-state flag from here rather than from the
   * template: `.hidden` is a DOM property, and driving a boolean attribute
   * through the template is exactly the kind of thing that works until it
   * doesn't. */
  renderCards();
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
    renderSwitcher();
    return;
  }
  if (key === 'new') await createWorkspace(name);
  else await renameWorkspace(key, name);
  renderLayer();
  renderSwitcher();
}

function onClick(e) {
  const view = e.target.closest('[data-ws-view]');
  if (view) {
    layerView = view.dataset.wsView === 'list' ? 'list' : 'grid';
    try { localStorage.setItem(VIEW_KEY, layerView); } catch { /* private mode */ }
    renderLayer();
    return;
  }
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

/* Search re-renders the grid only — see renderCards(). */
function onInput(e) {
  if (!e.target.closest('[data-ws-q]')) return;
  layerQuery = e.target.value;
  renderCards();
}

/* ================= list-view switcher =================
 *
 * The zoomed-out canvas is only reachable from graph view, which would leave
 * list view with no way into a workspace at all. This chip is that way in —
 * same data, same switchWorkspace(), one click from the sidebar.
 */

let switcher = null; // #ws-switch
let menu = null;     // #ws-menu

function renderSwitcher() {
  const label = document.getElementById('ws-switch-name');
  if (label) {
    const cur = state.workspaces.find((w) => w.id === state.workspaceId);
    label.textContent = cur ? cur.name : 'Workspaces';
  }
  // Keep an open menu honest about counts and which entry is current.
  if (menu && !menu.classList.contains('hidden')) renderSwitchMenu();
}

function renderSwitchMenu() {
  if (!menu) return;
  render(
    html`<${Fragment}>
      ${state.workspaces.map(
        (w) => html`<button
          type="button"
          role="menuitem"
          class=${'ws-menu-item' + (w.id === state.workspaceId ? ' active' : '')}
          data-ws-open=${w.id}
        >
          <span class="ws-menu-name">${w.name}</span>
          <span class="ws-menu-count">${w.conversationCount || 0}</span>
        </button>`
      )}
      <div class="ws-menu-sep" role="separator"></div>
      <a class="ws-menu-item all" href="${at('workspaces')}" role="menuitem">
        <svg class="ico" aria-hidden="true"><use href="#i-grid"></use></svg>
        <span class="ws-menu-name">All workspaces</span>
      </a>
      ${editing === 'new'
        ? html`<input
            class="ws-menu-input"
            data-ws-input="new"
            placeholder="Workspace name"
            spellcheck="false"
          />`
        : html`<button type="button" role="menuitem" class="ws-menu-item create" data-ws-create>
            <svg class="ico" aria-hidden="true"><use href="#i-plus"></use></svg>
            <span class="ws-menu-name">New workspace</span>
          </button>`}
    <//>`,
    menu
  );
}

function setMenuOpen(on) {
  if (!menu || !switcher) return;
  menu.classList.toggle('hidden', !on);
  switcher.setAttribute('aria-expanded', on ? 'true' : 'false');
  if (on) {
    editing = null;
    renderSwitchMenu();
  }
}

function initSwitcher() {
  switcher = document.getElementById('ws-switch');
  menu = document.getElementById('ws-menu');
  if (!switcher || !menu) return;

  switcher.addEventListener('click', (e) => {
    e.stopPropagation(); // a click on the chip must not immediately close it
    setMenuOpen(menu.classList.contains('hidden'));
  });

  menu.addEventListener('click', (e) => {
    const open = e.target.closest('[data-ws-open]');
    if (open) {
      const id = open.dataset.wsOpen;
      setMenuOpen(false);
      switchWorkspace(id);
      return;
    }
    if (e.target.closest('[data-ws-create]')) {
      editing = 'new';
      renderSwitchMenu();
      const inp = menu.querySelector('[data-ws-input]');
      if (inp) inp.focus();
    }
  });

  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      editing = null;
      setMenuOpen(false);
      switcher.focus();
      return;
    }
    if (e.key !== 'Enter') return;
    const inp = e.target.closest('[data-ws-input]');
    if (!inp) return;
    const value = inp.value;
    editing = null;
    setMenuOpen(false);
    commitName('new', value);
  });

  document.addEventListener('click', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (e.target.closest('#ws-switch-wrap')) return;
    setMenuOpen(false);
  });
}

/* ================= wiring ================= */

export async function initWorkspaces() {
  layer = $('ws-layer');
  initSwitcher();
  // Always reconcile, even if the layer element is missing — every conversation
  // list load reads state.workspaceId.
  await loadWorkspaces();
  if (layer) {
    layer.addEventListener('click', onClick);
    layer.addEventListener('keydown', onKeydown);
    layer.addEventListener('input', onInput);
    try { layerView = localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid'; }
    catch { /* private mode */ }
    renderLayer();
  }
  /*
   * graph.js pushes zoom out through this instead of us importing it.
   *
   * Zooming back IN past the threshold is the "dive back in" gesture: land in
   * the workspace you had open, at full size, rather than leaving a 41%-sized
   * board behind. It only fires on a real crossing — this same callback runs at
   * boot with whatever zoom was saved, and snapping THAT to 100% would undo the
   * user's zoom on every load.
   */
  state.onZoomChange = (z) => {
    const show = state.view === 'graph' && z <= ZOOM_WS;
    const wasVisible = visible;
    setVisible(show);
    if (wasVisible && !show && state.zoomTo && state.zoomLevel && state.zoomLevel() < 1) {
      state.zoomTo(1);
    }
  };
  // If the graph applied its saved zoom before we registered, ask it now.
  if (state.zoomLevel) state.onZoomChange(state.zoomLevel());
}
