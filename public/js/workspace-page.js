/* workspace-page.js — the standalone workspace picker served at /workspaces.
 *
 * Deliberately self-contained: it talks to /api/workspaces directly rather than
 * going through state.js, because this screen runs before — and instead of —
 * the app shell. No sidebar, no chat, no graph: just search, a grid/list toggle
 * and the workspace names. main.js branches on the path and calls
 * initWorkspacePage() instead of init().
 */

const $ = (id) => document.getElementById(id);

const page      = $('ws-page');
const pageBody  = $('ws-page-body');
const pageEmpty = $('ws-page-empty');
const pageQuery = $('ws-page-q');
const pageGrid  = $('ws-page-grid');
const pageList  = $('ws-page-list');

const VIEW_KEY = 'lb.pickerview';

/** Every workspace, unfiltered — the search only narrows `rows`. */
let items = [];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function when(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function countText(n) {
  return `${n} conversation${n === 1 ? '' : 's'}`;
}

/* ---------------- data ---------------- */

async function load() {
  let list = [];
  try {
    const r = await fetch('/api/workspaces');
    if (r.ok) list = await r.json();
  } catch { /* offline — the empty state below carries the page */ }
  items = Array.isArray(list) ? list : [];
  render();
}

async function create(name) {
  const r = await fetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { alert(d.error || 'Could not create the workspace.'); return false; }
  await load();
  return true;
}

/* A workspace holding conversations must be deleted explicitly — same promise
 * the sidebar makes, so this screen never silently takes work with it. */
async function remove(w) {
  const n = w.conversationCount || 0;
  const msg = n
    ? `Delete "${w.name}" and its ${countText(n)}?\n\nThey are archived, not destroyed.`
    : `Delete workspace "${w.name}"?`;
  if (!confirm(msg)) return;
  const r = await fetch(`/api/workspaces/${w.id}${n ? '?force=1' : ''}`, { method: 'DELETE' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    alert(d.error || 'Could not delete the workspace.');
    return;
  }
  await load();
}

function open(id) {
  try { localStorage.setItem('lb.workspace', id); } catch { /* private mode */ }
  location.href = '/app';
}

/* ---------------- render ---------------- */

function render() {
  const q = pageQuery.value.trim().toLowerCase();
  const rows = q ? items.filter((w) => String(w.name).toLowerCase().includes(q)) : items;

  const cards = rows.map((w) => {
    const n = w.conversationCount || 0;
    const meta = [countText(n), when(w.updatedAt)].filter(Boolean).join(' · ');
    return `
      <article class="ws-card" data-id="${esc(w.id)}" tabindex="0" role="link"
               aria-label="Open workspace ${esc(w.name)}">
        <span class="ws-card-mark" aria-hidden="true"><svg class="ico"><use href="#i-graph"></use></svg></span>
        <h2 class="ws-card-name">${esc(w.name)}</h2>
        <p class="ws-card-meta">${esc(meta)}</p>
        <span class="ws-card-go" aria-hidden="true"><svg class="ico"><use href="#i-arrow-right"></use></svg></span>
        <button type="button" class="ws-card-del" title="Delete this workspace"
                aria-label="Delete workspace ${esc(w.name)}">
          <svg class="ico"><use href="#i-trash"></use></svg>
        </button>
      </article>`;
  }).join('');

  /* The create affordance sits in the grid itself, and disappears while the
   * user is searching — a new workspace would never match their query. */
  const add = q ? '' : `
    <article class="ws-card ws-card-new" data-new tabindex="0" role="button"
             aria-label="Create a new workspace">
      <span class="ws-card-mark" aria-hidden="true"><svg class="ico"><use href="#i-plus"></use></svg></span>
      <h2 class="ws-card-name">New workspace</h2>
      <p class="ws-card-meta">Start a separate space for another topic</p>
      <span class="ws-card-go" aria-hidden="true"><svg class="ico"><use href="#i-arrow-right"></use></svg></span>
    </article>`;

  pageBody.innerHTML = cards + add;
  pageEmpty.hidden = !(rows.length === 0 && !!q);
}

/* ---------------- create inline ---------------- */

function startCreate(card) {
  if (card.classList.contains('editing')) return;
  card.classList.add('editing');
  card.innerHTML = `
    <span class="ws-card-mark" aria-hidden="true"><svg class="ico"><use href="#i-plus"></use></svg></span>
    <input class="ws-card-input" type="text" maxlength="60" placeholder="Workspace name"
           aria-label="New workspace name" autocomplete="off" spellcheck="false">
    <p class="ws-card-meta">Enter to create · Esc to cancel</p>`;
  const input = card.querySelector('.ws-card-input');
  input.focus();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    const name = input.value.trim();
    if (commit && name) {
      done = true;
      const ok = await create(name);
      if (!ok) { done = false; render(); } // keep the page usable after a rejected name
      return;
    }
    done = true;
    render(); // back to the plain "New workspace" card
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(false));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/* ---------------- layout toggle ---------------- */

function setView(v) {
  pageBody.dataset.view = v;
  const grid = v === 'grid';
  pageGrid.classList.toggle('on', grid);
  pageList.classList.toggle('on', !grid);
  pageGrid.setAttribute('aria-pressed', String(grid));
  pageList.setAttribute('aria-pressed', String(!grid));
  try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
}

/* ---------------- wiring ---------------- */

export function initWorkspacePage() {
  page.hidden = false;
  document.body.classList.add('ws-page-mode');

  let view = 'grid';
  try { view = localStorage.getItem(VIEW_KEY) || 'grid'; } catch { /* private mode */ }
  setView(view === 'list' ? 'list' : 'grid');

  pageQuery.addEventListener('input', render);
  pageGrid.addEventListener('click', () => setView('grid'));
  pageList.addEventListener('click', () => setView('list'));

  pageBody.addEventListener('click', (e) => {
    const del = e.target.closest('.ws-card-del');
    if (del) {
      e.stopPropagation();
      const w = items.find((x) => x.id === del.closest('.ws-card').dataset.id);
      if (w) remove(w);
      return;
    }
    const card = e.target.closest('.ws-card');
    if (!card || card.classList.contains('editing')) return;
    if (card.hasAttribute('data-new')) { startCreate(card); return; }
    open(card.dataset.id);
  });

  pageBody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.tagName === 'INPUT') return;
    const card = e.target.closest('.ws-card');
    if (!card || card.classList.contains('editing')) return;
    e.preventDefault();
    if (card.hasAttribute('data-new')) startCreate(card);
    else open(card.dataset.id);
  });

  /* Returned so the caller can hold the boot overlay until the cards are in —
   * revealing an empty grid is only a slightly better flicker than no loader. */
  return load();
}
