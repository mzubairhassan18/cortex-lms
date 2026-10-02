/* summary.js — split from public/app.js (app.js line 2501-3147). */
import { escapeHtml, renderInline } from './markdown.js';
import { renderQuiz, renderResults, runQuiz } from './quiz.js';
import { notesSectionVNode } from './selection.js';
import { $, state, summaryCardSlot, summaryStatus, testBadges, testSection } from './state.js';
import { cleanHistory, streamChat } from './stream.js';
import { html, render } from './views.js';

/* ================= Topics summary (background job) ================= */
/*
 * A one-liner + bullet points of the whole session (main chat + every
 * explainer container): what was asked and what was learned/achieved.
 * - Cached per conversation; opening a conversation shows the cache instantly
 *   and refreshes it in the background.
 * - Also refreshed when leaving a conversation, or manually via ↻.
 * - Shown as an overlay over the explainer containers; ✕ closes it.
 */

export const summaryCache = {}; // convId -> { headline, points, fingerprint, at }
export const summaryState = { inflight: null, queue: null, controller: null };
export const quizCache = {};   // convId -> { fingerprint, questions: [{q,options,answer,why}], at }
export const testsCache = {};  // convId -> [report, ...] (newest last)
export const quizState = { inflight: null, queue: null, controller: null };


/* Background jobs (summary, quiz) are serialized so the model gets one
 * generation at a time — order: whatever was requested first. */
export let bgChain = Promise.resolve();
export function enqueueBg(job) {
  // .catch here so a failing job can never produce an unhandled rejection or
  // wedge the chain (a rejection would otherwise poison every later job).
  const run = bgChain.then(job, job).catch(() => {});
  bgChain = run;
  return run;
}

/* Stop background generations for one conversation (a convId) or all of them
 * (no argument). Used on delete so a queued/in-flight job cannot write a
 * deleted conversation back to disk. Jobs are bounded to one running plus one
 * queued, so switching conversations does not need this. */
export function abortBackgroundJobs(convId) {
  const hit = (running) => convId == null || running === convId;
  if (summaryState.queue && hit(summaryState.queue.convId)) summaryState.queue = null;
  if (quizState.queue && hit(quizState.queue.convId)) quizState.queue = null;
  if (summaryState.controller && hit(summaryState.inflight)) summaryState.controller.abort();
  if (quizState.controller && hit(quizState.inflight)) quizState.controller.abort();
}

export function runBackgroundJobs(convId, messages, explains, force = false) {
  runSummary(convId, messages, explains, force);
  runQuiz(convId, messages, explains, force);
}

export function fingerprintOf(messages, explains) {
  const nodes = (explains && explains.nodes) || {};
  let n = messages.length;
  let chars = 0;
  for (const m of messages) chars += (m.content || '').length;
  for (const nd of Object.values(nodes)) {
    n += 1 + (nd.messages || []).length;
    chars += (nd.selection || '').length;
    for (const m of nd.messages || []) chars += (m.content || '').length;
  }
  return `${n}:${chars}`;
}

/* Map-reduce summarization — small models (phi4-mini: 3.8B / 4K context)
 * degenerate into repetition loops when handed the whole session at once.
 * So instead:  1) MAP — split the session into small chunks (one Q&A /
 * explainer topic each, ~1.1K chars) and extract a few notes per chunk;
 * 2) MERGE — only if the combined notes are still large, condense them in
 * halves; 3) REDUCE — condense everything into headline + 3-10 bullets.
 * Low temperature + frequency/repeat penalties + validation (drop repeated/
 * duplicate/junk lines) is the standard reliable recipe for summarizing
 * long content with small models. */

export const SUMMARY_SYS_MAP = [
  'You extract study notes from ONE short excerpt of a learning conversation.',
  'Output ONLY bullet points, one per line, each starting with "- ".',
  'Each point: one short plain sentence (max 20 words) naming what was asked and what was learned (question -> key fact/answer).',
  '2 to 5 points. No preamble, no numbering, no headings, no repeated words, no closing remarks.',
].join('\n');

export const SUMMARY_SYS_MERGE = [
  'You merge overlapping study notes into fewer notes.',
  'Output ONLY bullet points, one per line, each starting with "- ".',
  'Combine duplicates, keep every distinct topic, short plain sentences, at most 15 points, no commentary.',
].join('\n');

export const SUMMARY_SYS_REDUCE = [
  'You condense study notes into a short learning-object summary for a student.',
  'Output EXACTLY this structure and nothing else:',
  'Line 1: one single sentence (max 25 words) summarizing what the student is learning and has achieved.',
  'Then the line "## Key findings" followed by 3 to 8 bullet points, one per line starting with "- ", naming the most important things learned (question -> what was learned).',
  'Then the line "## Topics" followed by ONE line of 3 to 8 short topic tags separated by commas (no dashes, no sentence).',
  'Then the line "## Questions you asked" followed by 1 to 6 bullet points, one per line starting with "- ", naming the questions the student actually asked in the session.',
  'Merge duplicate points, plain short lines, never repeat words, no preamble, no closing remarks.',
].join('\n');

/* One awaited request inside a background job (resolves with the full text).
 * Summary + quiz generation both go through here → the same /api/chat as
 * chat, so Auto routing/failover picks their model too — they are never
 * pinned to Ollama/phi4 or any other single model. */
export function bgRequest(messages, signal, opts) {
  return new Promise((resolve) => {
    let buf = '';
    streamChat(
      messages,
      {
        start() {},
        push(t) {
          buf += t;
        },
        end() {
          resolve(buf);
        },
      },
      signal,
      opts
    );
  });
}

/* --- output validation: drop degenerate / repetitive / junk lines --- */

export function hasRepetition(s, minWords = 4) {
  const words = String(s).toLowerCase().match(/[a-z0-9]+/g) || [];
  if (words.length < minWords) return true; // too short to be a real point
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) return true; // "captured captured …"
  }
  const counts = {};
  for (const w of words) {
    if (w.length > 3) counts[w] = (counts[w] || 0) + 1;
  }
  return Object.values(counts).some((c) => c >= 4); // looping sentence
}

export function sanitizePoints(lines) {
  const out = [];
  const keys = [];
  for (let line of lines || []) {
    line = String(line)
      .replace(/\s+/g, ' ')
      .replace(/^([-*•]\s+|\d+[.)]\s+)+/, '')
      .replace(/\*\*/g, '')
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .trim();
    if (line.length < 12 || line.length > 240) continue;
    if (hasRepetition(line)) continue;
    if (/[:;]$/.test(line)) continue; // heading leftovers
    if (/^(here|sure|below|following|note|notes|summary|overview|certainly)\b/i.test(line)) {
      continue; // model preamble
    }
    const key = line
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const head = key.slice(0, 56);
    if (keys.some((h) => h === key || h.startsWith(head) || head.startsWith(h.slice(0, 56)))) {
      continue; // exact or near duplicate
    }
    keys.push(key);
    out.push(line);
    if (out.length >= 12) break;
  }
  return out;
}

/* Topic tags are short by design — sanitizePoints would drop them (<12 chars). */
export function sanitizeTags(list) {
  const out = [];
  const keys = [];
  for (let t of list || []) {
    t = String(t)
      .replace(/\s+/g, ' ')
      .replace(/^([-*•]\s+|\d+[.)]\s+)+/, '')
      .replace(/\*\*/g, '')
      .replace(/^["'“”,.]+|["'“”,.]+$/g, '')
      .trim()
      .slice(0, 40);
    if (t.length < 2) continue;
    const key = t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || keys.includes(key)) continue;
    keys.push(key);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

export function parseBulletLines(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const bullets = lines.filter((l) => /^[-*•]\s+/.test(l));
  return bullets.length ? bullets : lines; // model ignored the "-" prefix
}

export function sanitizeHeadline(s, fallback) {
  const h = String(s || '')
    .replace(/^[-*•]\s+/, '')
    .replace(/^#+\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!h || h.length > 220 || hasRepetition(h, 3)) return fallback;
  return h;
}

/* --- MAP: split the session into small chunks (one topic per unit) --- */

export function buildSummaryChunks(messages, explains) {
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const units = [];

  const main = cleanHistory(messages || []);
  let i = 0;
  while (i < main.length) {
    const m = main[i];
    if (m.role === 'user') {
      const a = main[i + 1] && main[i + 1].role === 'assistant' ? main[i + 1] : null;
      units.push(`Student: ${clip(m.content, 450)}${a ? `\nTutor: ${clip(a.content, 750)}` : ''}`);
      i += a ? 2 : 1;
    } else {
      units.push(`${m.role === 'assistant' ? 'Tutor' : 'Note'}: ${clip(m.content, 500)}`);
      i += 1;
    }
  }

  const nodes = (explains && explains.nodes) || {};
  const roots = (explains && explains.roots) || [];
  const seen = new Set();
  const emit = (id, depth) => {
    if (seen.has(id) || !nodes[id]) return;
    seen.add(id);
    const nd = nodes[id];
    if (nd.selection) {
      units.push(`Explainer topic${depth ? ' (nested)' : ''}: "${clip(nd.selection, 350)}"`);
    }
    const msgs = cleanHistory(nd.messages || []);
    let j = 0;
    while (j < msgs.length) {
      const m = msgs[j];
      if (m.role === 'user') {
        const a = msgs[j + 1] && msgs[j + 1].role === 'assistant' ? msgs[j + 1] : null;
        units.push(
          `Student: ${clip(m.content, 300)}${a ? `\nTutor: ${clip(a.content, 500)}` : ''}`
        );
        j += a ? 2 : 1;
      } else {
        j += 1;
      }
    }
    for (const c of Object.values(nodes)
      .filter((x) => x.parentId === id)
      .sort((a, b) => a.createdAt - b.createdAt)) {
      emit(c.id, depth + 1);
    }
  };
  for (const r of roots) emit(r, 0);
  for (const id of Object.keys(nodes)) if (!seen.has(id)) emit(id, 0);

  /* Pack units into chunks of ~1100 chars — small enough for a 4K-context
   * model together with the prompt. A Q&A pair is never split across chunks. */
  const chunks = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 2 > 1100) {
      chunks.push(cur);
      cur = '';
    }
    cur += (cur ? '\n\n' : '') + u;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function summaryPromptInput(messages, explains) {
  const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
  const out = [];
  const main = cleanHistory(messages || []);
  if (main.length) {
    out.push('MAIN CONVERSATION:');
    for (const m of main.slice(-30)) {
      out.push(`${m.role === 'user' ? 'Student' : 'Tutor'}: ${clip(m.content, 400)}`);
    }
    out.push('');
  }
  const nodes = (explains && explains.nodes) || {};
  const roots = (explains && explains.roots) || [];
  const seen = new Set();
  const emit = (id, depth) => {
    if (seen.has(id) || !nodes[id]) return;
    seen.add(id);
    const nd = nodes[id];
    out.push(`${depth ? 'NESTED EXPLAINER' : 'EXPLAINER'} — selected: "${clip(nd.selection || '', 200)}"`);
    for (const m of cleanHistory(nd.messages || []).slice(-12)) {
      out.push(`  ${m.role === 'user' ? 'Student' : 'Tutor'}: ${clip(m.content, 300)}`);
    }
    out.push('');
    for (const c of Object.values(nodes)
      .filter((x) => x.parentId === id)
      .sort((a, b) => a.createdAt - b.createdAt)) {
      emit(c.id, depth + 1);
    }
  };
  for (const r of roots) emit(r, 0);
  for (const id of Object.keys(nodes)) if (!seen.has(id)) emit(id, 0);
  return out.join('\n');
}

export function parseSummary(text) {
  const lines = (text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let headline = '';
  const points = [];
  const topics = [];
  const questions = [];
  let section = 'findings';
  for (const l of lines) {
    // Section headers: "## Topics", "Topics:", "Questions you asked"…
    const bare = l.replace(/^#+\s*/, '').replace(/[:：]\s*$/, '').trim();
    if (/^key\s+findings?$/i.test(bare)) { section = 'findings'; continue; }
    if (/^topics?$/i.test(bare)) { section = 'topics'; continue; }
    if (/^questions?(\s+you\s+asked)?$/i.test(bare)) { section = 'questions'; continue; }

    const isBullet = /^[-*•]\s+/.test(l);
    const body = (isBullet ? l.replace(/^[-*•]\s+/, '') : l)
      .replace(/\*\*/g, '')
      .trim();

    // Small models sometimes emit the list itself as a line instead of a
    // header: "Topics: a, b, c" or "- Questions you asked: …".
    const topicLine = body.match(/^(?:topics?|tags?)\s*[:：]\s*(.+)$/i);
    if (topicLine && section !== 'questions') {
      for (const t of topicLine[1].split(/[,;·/]+/)) {
        const tt = t.trim();
        if (tt) topics.push(tt);
      }
      continue;
    }
    const questionLine = body.match(
      /^(?:questions?(?:\s+you\s+asked)?|your\s+questions)\s*[:：]\s*(.+)$/i
    );
    if (questionLine) {
      questions.push(questionLine[1].replace(/^["'“”]+|["'“”]+$/g, '').trim());
      continue;
    }

    if (section === 'topics') {
      // Topics arrive as bullets or as one comma-separated line.
      for (const t of body.split(/[,;·/]+/)) {
        const tt = t.replace(/^[-*•]\s+/, '').trim();
        if (tt) topics.push(tt);
      }
      continue;
    }
    if (section === 'questions') {
      if (body) questions.push(body.replace(/^["'“”]+|["'“”]+$/g, ''));
      continue;
    }
    if (isBullet) {
      if (body) points.push(body);
    } else if (!headline && !points.length) {
      headline = body.replace(/^["'“”]+|["'“”]+$/g, '');
    } else if (body) {
      points.push(body); // legacy format: plain lines after the headline
    }
  }
  return {
    headline: headline || 'Learning session',
    points,
    topics,
    questions,
  };
}

export function renderTestBadges() {
  const list = testsCache[state.currentId] || [];
  // #test-badges:empty { display: none } needs the element genuinely childless
  // when there is nothing to show — render(null, el) clears it completely.
  if (!list.length) {
    render(null, testBadges);
    return;
  }
  render(
    html`<span class="badges-label">Tests:</span>${list
      .map(
        (r, i) =>
          html`<button
            type="button"
            class="test-badge"
            data-i=${i}
            title=${`${new Date(r.at || Date.now()).toLocaleString()} — ${r.score}/${r.total} correct`}
          >${r.percent}%</button>`
      )
      .reverse()}`,
    testBadges
  );
}

export function renderSummary(entry, status) {
  state.lastSummaryStatus = status || '';
  summaryStatus.textContent = state.lastSummaryStatus;
  renderTestBadges();

  const hasEntry =
    entry &&
    (entry.headline ||
      (entry.points || []).length ||
      (entry.topics || []).length ||
      (entry.questions || []).length);

  const hasContent =
    state.messages.length > 0 || Object.keys(state.explains.nodes).length > 0;

  const points = (hasEntry && entry.points) || [];
  const topics = (hasEntry && entry.topics) || [];
  const questions = (hasEntry && entry.questions) || [];

  // Learning object: AI summary card (headline + key findings + topics +
  // questions asked), then the user's own notes card below it.
  const summaryCard = hasEntry
    ? html`<div class="summary-card">
        <button
          type="button"
          class="summary-collapse"
          id="sum-collapse"
          aria-expanded=${String(state.summaryExpanded)}
        >
          <span class="caret">${state.summaryExpanded ? '▾' : '▸'}</span>
          <span
            class="summary-headline"
            dangerouslySetInnerHTML=${{ __html: renderInline(escapeHtml(String(entry.headline || ''))) }}
          />
        </button>
        <div class="summary-details" hidden=${!state.summaryExpanded}>
          ${points.length
            ? html`<div class="sum-group-label">🔎 Key findings</div>
                <ul class="summary-points">${points.map(
                  (p) =>
                    html`<li dangerouslySetInnerHTML=${{ __html: renderInline(escapeHtml(String(p))) }} />`
                )}</ul>`
            : null}
          ${topics.length
            ? html`<div class="sum-group-label">🏷️ Topics</div>
                <div class="sum-topics">${topics.map(
                  (t) => html`<span class="topic-tag">${String(t)}</span>`
                )}</div>`
            : null}
          ${questions.length
            ? html`<div class="sum-group-label">❓ Questions you asked</div>
                <ul class="summary-questions">${questions.map(
                  (q) =>
                    html`<li dangerouslySetInnerHTML=${{ __html: renderInline(escapeHtml(String(q))) }} />`
                )}</ul>`
            : null}
        </div>
      </div>`
    : html`<div class="summary-empty">${`No summary yet.${
        hasContent ? ' Press ↻ to generate one.' : ' Chat or explain something first.'
      }`}</div>`;

  render(html`${summaryCard}${notesSectionVNode()}`, summaryCardSlot);

  renderTestSection();
}

/* The "Take a test" section lives in its own card directly BELOW the
 * learning session — and becomes the quiz / results view while a test runs. */
export function renderTestSection() {
  if (state.summaryMode === 'quiz') {
    renderQuiz();
    return;
  }
  if (state.summaryMode === 'results') {
    renderResults();
    return;
  }
  const quiz = quizCache[state.currentId];
  const ready = quiz && Array.isArray(quiz.questions) && quiz.questions.length;
  const preparing = quizState.inflight === state.currentId;
  const hasContent =
    state.messages.length > 0 || Object.keys(state.explains.nodes).length > 0;
  const body = ready
    ? html`<button type="button" id="take-test-btn">${`📝 Take a test (${
        quiz.questions.length
      } question${quiz.questions.length === 1 ? '' : 's'})`}</button>`
    : preparing
      ? html`<span class="test-wait">⏳ Preparing your test…</span>`
      : hasContent
        ? html`<span class="test-wait">No test yet — press ↻ to generate one.</span>`
        : html`<span class="test-wait">Chat or explain something to unlock a test.</span>`;
  render(
    html`<div class="test-card">
      <div class="test-card-head">📝 Test your knowledge</div>
      <div class="test-cta">${body}</div>
    </div>`,
    testSection
  );
}

export function showCachedSummary() {
  const busy = summaryState.inflight === state.currentId;
  renderSummary(summaryCache[state.currentId], busy ? 'updating…' : '');
}

/* Single-flight: a request arriving while one runs is queued (latest wins).
 * The job itself is a map-reduce pipeline of several small requests. */
export function runSummary(convId, messages, explains, force = false) {
  if (!convId) return;
  const fp = fingerprintOf(messages, explains);
  const cached = summaryCache[convId];
  if (!force && cached && cached.fingerprint === fp) return; // already fresh
  if (
    messages.length === 0 &&
    Object.keys((explains && explains.nodes) || {}).length === 0
  ) {
    return; // nothing to summarize
  }
  if (summaryState.inflight) {
    summaryState.queue = { convId, messages, explains, force };
    return;
  }

  summaryState.inflight = convId;
  summaryState.controller = new AbortController();
  const signal = summaryState.controller.signal;
  const isCurrent = () => convId === state.currentId;
  const setStatus = (t) => {
    if (isCurrent()) {
      state.lastSummaryStatus = t;
      summaryStatus.textContent = t;
    }
  };
  setStatus('summarizing…');

  // Low temperature + anti-repeat + a hard output cap keeps small models out
  // of runaway repetition loops (bounded work per background request).
  const SAMPLING = { temperature: 0.2, frequency: 0.8, maxTokens: 500 };

  enqueueBg(async () => {
    try {
      const chunks = buildSummaryChunks(messages, explains);
      if (!chunks.length) throw new Error('empty session');

      // ---- MAP: a few notes from each small chunk ----
      let notes = [];
      for (let i = 0; i < chunks.length; i++) {
        if (signal.aborted) return;
        setStatus(
          chunks.length > 1 ? `summarizing ${i + 1}/${chunks.length}…` : 'summarizing…'
        );
        const txt = await bgRequest(
          [
            { role: 'system', content: SUMMARY_SYS_MAP },
            { role: 'user', content: chunks[i] },
          ],
          signal,
          SAMPLING
        );
        if (/^\s*⚠️/.test(String(txt))) continue; // this chunk failed — keep going
        notes.push(...parseBulletLines(txt));
      }
      notes = sanitizePoints(notes);
      if (!notes.length) throw new Error('no notes extracted');

      // ---- MERGE: hierarchical reduction if notes exceed one reduce pass ----
      let guard = 0;
      while (notes.join('\n').length > 6000 && notes.length > 12 && guard < 4) {
        if (signal.aborted) return;
        guard++;
        setStatus('summarizing…');
        const before = notes.length;
        const half = Math.ceil(before / 2);
        const batches = [notes.slice(0, half), notes.slice(half)];
        const merged = [];
        for (const b of batches) {
          const txt = await bgRequest(
            [
              { role: 'system', content: SUMMARY_SYS_MERGE },
              { role: 'user', content: b.map((p) => `- ${p}`).join('\n') },
            ],
            signal,
            SAMPLING
          );
          if (!/^\s*⚠️/.test(String(txt))) merged.push(...parseBulletLines(txt));
        }
        const next = sanitizePoints(merged);
        if (!next.length || next.length >= before) break; // no progress — stop
        notes = next;
      }

      // ---- REDUCE: headline + key findings + topics + questions asked ----
      let headline = '';
      let points = [];
      let topics = [];
      let questions = [];
      if (!signal.aborted) {
        setStatus('summarizing…');
        const txt = await bgRequest(
          [
            { role: 'system', content: SUMMARY_SYS_REDUCE },
            {
              role: 'user',
              content: `Session notes:\n${notes.map((p) => `- ${p}`).join('\n')}`,
            },
          ],
          signal,
          SAMPLING
        );
        if (!/^\s*⚠️/.test(String(txt))) {
          const parsed = parseSummary(txt);
          headline = sanitizeHeadline(parsed.headline, '');
          points = sanitizePoints(parsed.points);
          topics = sanitizeTags(parsed.topics);
          questions = sanitizePoints(parsed.questions).slice(0, 6);
        }
      }
      if (signal.aborted) return;

      // Fall back to the validated map notes if the reduce pass failed.
      if (!points.length) points = notes.slice(0, 10);
      if (!headline) {
        const p0 = points[0] || '';
        const sentence = p0.match(/^[^.!?]*[.!?]/);
        headline = sanitizeHeadline(
          (sentence ? sentence[0] : p0).slice(0, 160),
          'Learning session'
        );
      }
      // Drop a first bullet that just repeats the headline sentence.
      if (points.length > 3 && headline) {
        const norm = (s) =>
          String(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
        const nh = norm(headline);
        const n0 = norm(points[0]);
        if (n0 && nh && (n0 === nh || n0.startsWith(nh) || nh.startsWith(n0))) {
          points = points.slice(1);
        }
      }

      const entry = {
        headline,
        points: points.slice(0, 10),
        topics,
        questions,
        fingerprint: fp,
        at: Date.now(),
      };
      summaryCache[convId] = entry;
      fetch(`/api/conversations/${convId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: entry }),
      }).catch(() => {});
      if (isCurrent()) renderSummary(entry, '');
    } catch (e) {
      if (isCurrent()) {
        renderSummary(summaryCache[convId], signal.aborted ? '' : 'failed — press ↻ to retry');
      }
    } finally {
      if (summaryState.inflight === convId) {
        summaryState.inflight = null;
        summaryState.controller = null;
      }
      const queue = summaryState.queue;
      summaryState.queue = null;
      if (queue) runSummary(queue.convId, queue.messages, queue.explains, queue.force);
    }
  });
}
