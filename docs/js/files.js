/* files.js — split from public/app.js (app.js line 1608-1761). */
import { createConversation } from './chat.js';
import { extractFileText } from './extract.js';
import { escapeHtml } from './markdown.js';
import { showToast } from './selection.js';
import { $, attachBtn, attachChips, fileInput, inputForm, linkBtn, state } from './state.js';

export const fileTextCache = {}; // convId -> { fid: text }

export function evictFileText(convId) {
  if (convId && fileTextCache[convId]) delete fileTextCache[convId];
}

export function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderChips() {
  const files = state.files || [];
  attachChips.hidden = !files.length;
  attachChips.innerHTML = files
    .map(
      (f) => `
    <span class="chip ${f.link ? 'chip-link' : ''}" title="${escapeHtml(f.link || f.name)}">
      <span class="chip-ico">${f.link ? '🔗' : '📎'}</span>
      <span class="chip-name">${escapeHtml(f.name)}</span>
      <span class="chip-meta">${f.link ? 'link' : fmtSize(f.size)}</span>
      <button type="button" class="chip-x" data-fid="${f.id}" title="Remove this attachment"><svg class="ico" aria-hidden="true"><use href="#i-x"></use></svg></button>
    </span>`
    )
    .join('');
}

attachChips.addEventListener('click', (e) => {
  const x = e.target.closest('.chip-x');
  if (x) removeFile(x.dataset.fid);
});

/** ArrayBuffer -> base64, the body the upload route expects.
 *  Chunked through String.fromCharCode so a 12 MB file never builds a single
 *  16 MB argument list — apply() is bounded by the engine's stack. */
export function toB64(buf) {
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (!state.currentId) await createConversation();
  for (const file of files) {
    try {
      // Read once: the extractor and the base64 body want the same bytes, and
      // a multi-MB file is not worth reading from disk twice.
      const buf = await file.arrayBuffer();
      showToast(`📎 Reading ${escapeHtml(file.name)}…`);
      const text = await extractFileText(buf, file.name);
      const res = await fetch(`/api/conversations/${state.currentId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          data: toB64(buf),
          text,
          mime: file.type || '',
        }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Upload failed');
      state.files = state.files || [];
      state.files.push(out.file);
      renderChips();
      if (!out.file.link) prefetchFileText(state.currentId, out.file.id);
      showToast(`📎 Attached ${escapeHtml(out.file.name)}`);
    } catch (e) {
      showToast(`⚠️ ${escapeHtml(e.message || 'Upload failed')}`);
    }
  }
}

export async function attachLink() {
  const url = (prompt('Link to attach with this conversation:') || '').trim();
  if (!url) return;
  if (!state.currentId) await createConversation();
  try {
    const res = await fetch(`/api/conversations/${state.currentId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ link: url }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || 'Could not attach link');
    state.files = state.files || [];
    state.files.push(out.file);
    renderChips();
    showToast(`🔗 Attached ${escapeHtml(out.file.name)}`);
  } catch (e) {
    showToast(`⚠️ ${escapeHtml(e.message || 'Could not attach link')}`);
  }
}

export async function removeFile(fid) {
  const convId = state.currentId;
  state.files = (state.files || []).filter((f) => f.id !== fid);
  renderChips();
  if (fileTextCache[convId]) delete fileTextCache[convId][fid];
  if (convId) {
    fetch(`/api/conversations/${convId}/files/${fid}`, { method: 'DELETE' }).catch(() => {});
  }
  showToast('📎 Attachment removed');
}

export function prefetchFileText(convId, fid) {
  const cache = fileTextCache[convId] || (fileTextCache[convId] = {});
  if (cache[fid] != null) return Promise.resolve(cache[fid]);
  return fetch(`/api/conversations/${convId}/files/${fid}/text`)
    .then((res) => (res.ok ? res.json() : { text: '' }))
    .then((out) => {
      cache[fid] = out.text || '';
      return cache[fid];
    })
    .catch(() => '');
}

/* The document block appended to the system prompt on send. */
export async function filesContext() {
  const files = state.files || [];
  if (!files.length) return '';
  const convId = state.currentId;
  const cache = fileTextCache[convId] || (fileTextCache[convId] = {});
  const parts = [];
  for (const f of files) {
    if (f.link) {
      parts.push(`=== ${f.name} ===\nLink the user shared: ${f.link}`);
      continue;
    }
    let txt = cache[f.id];
    if (txt == null) txt = await prefetchFileText(convId, f.id);
    if (txt) parts.push(`=== ${f.name} ===\n${txt.slice(0, 20000)}`);
  }
  if (!parts.length) return '';
  return (
    '\n\nAttached by the user to THIS conversation (use them when relevant):\n' +
    parts.join('\n\n')
  );
}

/* Buttons + drag & drop. */
attachBtn.addEventListener('click', () => fileInput.click());
linkBtn.addEventListener('click', attachLink);
fileInput.addEventListener('change', () => {
  if (fileInput.files && fileInput.files.length) uploadFiles(fileInput.files);
  fileInput.value = ''; // allow re-picking the same file later
});

['dragenter', 'dragover'].forEach((ev) =>
  inputForm.addEventListener(ev, (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    inputForm.classList.add('dropping');
  })
);
inputForm.addEventListener('dragleave', () => inputForm.classList.remove('dropping'));
inputForm.addEventListener('drop', (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
  e.preventDefault();
  inputForm.classList.remove('dropping');
  uploadFiles(e.dataTransfer.files);
});
