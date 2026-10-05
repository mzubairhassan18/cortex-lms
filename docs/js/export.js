/* export.js — the Export button in the summary container's header.
 *
 * The byte-level writers live in export-format.js (no imports, testable
 * outside a browser). This file only collects the current conversation's
 * summary, names the file, hands it to a writer and wires the menu.
 *
 * The header button + its menu sit inside #summary-overlay, which is MOVED
 * wholesale into the graph's summary node — so the menu travels with it and
 * nothing here knows which layout is showing.
 */
import { $, state } from './state.js';
import { summaryCache, testsCache } from './summary.js';
import { isEmptyDoc, plain, renderBlocks, stamp, toDocx, toPdf, toTxt } from './export-format.js';

export function collectDoc() {
  const id = state.currentId;
  const entry = summaryCache[id];
  const conv = (state.conversations || []).find((c) => c.id === id);
  const notes = (state.notes || [])
    .map((n) => ({ text: plain(n.text), context: plain(n.context) }))
    .filter((n) => n.text);
  const tests = (testsCache[id] || []).map((r) => ({
    when: new Date(r.at || Date.now()),
    score: Number(r.score) || 0,
    total: Number(r.total) || 0,
    percent: Number(r.percent) || 0,
  }));
  return {
    title: plain((conv && conv.title) || 'New conversation') || 'Conversation',
    when: stamp(new Date()),
    headline: entry ? plain(entry.headline) : '',
    findings: (entry && entry.points ? entry.points : []).map(plain).filter(Boolean),
    topics: (entry && entry.topics ? entry.topics : []).map(plain).filter(Boolean),
    questions: (entry && entry.questions ? entry.questions : []).map(plain).filter(Boolean),
    notes,
    tests,
  };
}

function slugify(s) {
  return (
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'conversation'
  );
}

function download(name, mime, data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function flashStatus(msg) {
  const el = $('summary-status');
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = '';
  }, 2500);
}

const EXT = {
  pdf: ['application/pdf', 'pdf'],
  docx: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'docx',
  ],
  txt: ['text/plain;charset=utf-8', 'txt'],
};

export function exportSummary(fmt) {
  const spec = EXT[fmt];
  if (!spec) return false;
  const doc = collectDoc();
  if (isEmptyDoc(doc)) {
    flashStatus('nothing to export yet');
    return false;
  }
  const blocks = renderBlocks(doc);
  const name = `${slugify(doc.title)}-summary.${spec[1]}`;
  let payload;
  if (fmt === 'pdf') payload = toPdf(blocks);
  else if (fmt === 'docx') payload = toDocx(blocks);
  else payload = toTxt(blocks);
  download(name, spec[0], payload);
  return true;
}

export function initExport() {
  const wrap = $('sum-export');
  const btn = $('summary-export');
  const menu = $('export-menu');
  if (!wrap || !btn || !menu) return;

  const close = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  const open = () => {
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) open();
    else close();
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('button[data-fmt]');
    if (!item) return;
    e.stopPropagation();
    close();
    exportSummary(item.dataset.fmt);
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
}
