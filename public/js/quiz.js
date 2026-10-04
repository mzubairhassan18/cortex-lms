/* quiz.js — split from public/app.js (app.js line 3148-3658). */
import { escapeHtml, renderInline } from './markdown.js';
import { persistNotes } from './selection.js';
import { $, state, summaryBody, testBadges, testSection } from './state.js';
import {
  applyVerdicts,
  keyQuiz,
  parseVerdicts,
  shuffleQuestion,
} from './grounding.js';
import { bgRequest, buildSummaryChunks, enqueueBg, fingerprintOf, hasRepetition, quizCache, quizState, renderSummary, renderTestBadges, renderTestSection, summaryCache, summaryState, testsCache } from './summary.js';
import { html, render } from './views.js';

/* ================= Quiz (background job) ================= */
/*
 * A multiple-choice test generated from the SAME session content as the
 * summary: 5-20 questions (longer conversation -> longer test), each with
 * exactly 4 options and one correct answer. Cached per conversation,
 * refreshed on open / on leaving / via ↻, persisted with PUT {quiz}.
 *
 * Two rules make the keys trustworthy (PLAN §9, Phases 1+2):
 *   1. Grounded — questions are written per CHUNK of buildSummaryChunks(),
 *      the same units the summary reads, so the two cannot disagree about
 *      what happened in the session.
 *   2. Audited — the model names the correct option as PROSE, code turns that
 *      into an index, and a second pass re-reads the source and says which
 *      option it actually supports. Disagree with no quote → the question is
 *      dropped rather than graded against a guess.
 */

export const QUIZ_SYS = [
  'You write multiple-choice quiz questions for a learning session.',
  'Output ONLY a JSON array — no markdown fences, no commentary, no extra text.',
  'Each element: {"q":"question","options":["choice one","choice two","choice three","choice four"],"correct":"<verbatim copy of the one correct option>","why":"one short sentence explaining the correct answer"}',
  'Rules:',
  '- exactly 4 options per question; exactly one correct answer.',
  '- "correct" MUST be copied WORD FOR WORD from one of the entries in "options" — same words, same order, same punctuation. Never a letter, never an index, never a paraphrase.',
  '- Every option must be a real, plausible full answer phrase — NEVER the letters A/B/C/D or placeholder text.',
  '- Test understanding (definitions, cause and effect, examples, application), not trivia or wording memory.',
  '- Every question must be answerable ONLY from the SOURCE provided, and the correct option must be supported by a sentence in it.',
  '- Vary difficulty; cover different parts of the source; never test the same fact twice.',
  '- Plain short English sentences.',
].join('\n');

/* Bump when the pipeline in runQuiz() changes so tests written by an older,
 * less accurate pipeline regenerate instead of staying wrong forever — the
 * fingerprint only moves when the CONVERSATION changes, not when we improve
 * how we read it. Costs one regeneration per conversation, once. */
export const QUIZ_VERSION = 2;

/* The audit pass: a second, independent read of the same text, asked which
 * option that text actually supports. Temperature 0 — this is a measurement,
 * not a creative step. */
export const QUIZ_VERIFY_SYS = [
  'You audit multiple-choice answer keys against the source text they were written from.',
  'For EVERY question, decide which single option the source text supports.',
  'Output ONLY a JSON array with one element per question, in the same order:',
  '{"i":0,"supported":<0-based index of the supported option>,"quote":"<short sentence copied word-for-word from the source that supports it>","ambiguous":<true if more than one option could be true>}',
  'Rules:',
  '- "supported" is -1 when the source supports NONE of the options.',
  '- "ambiguous" is true whenever two or more options are defensible from the source.',
  '- "quote" is copied verbatim from the source; use "" if no sentence supports any option.',
  '- Judge only by the source text, never by your own knowledge.',
  '- No commentary, no markdown, no extra keys.',
].join('\n');

/* Rotating focus per batch — forces variety: small models at low temperature
 * otherwise regenerate the same "obvious" question every batch. */
export const QUIZ_FOCUS = [
  'core definitions and what the key terms mean',
  'causes, effects, and why things happen',
  'practical applications, uses, and real-world examples',
  'which of the following statements is correct (comparisons and choices)',
  'sequences and processes — what happens step by step',
  'advantages, limitations, and trade-offs',
];

/* Question count scales with the conversation: base 5, +1 per 5 messages,
 * +1 per summary point, clamped to 4..20. */
export function quizCount(convId, messages, explains) {
  const nodes = (explains && explains.nodes) || {};
  const add = (arr) => {
    for (const m of arr || []) chars += String(m.content == null ? '' : m.content).length;
  };
  let msgs = messages.length;
  let chars = 0;
  add(messages);
  for (const nd of Object.values(nodes)) {
    msgs += (nd.messages || []).length;
    add(nd.messages);
  }
  const pts = ((summaryCache[convId] || {}).points || []).length;
  const asked = 5 + Math.floor(msgs / 5) + pts;

  /*
   * Asking for one question per ~350 characters is roughly what a session can
   * actually support: every key has to point at a sentence that is really in
   * the text (PLAN §9.2 audits it, it cannot invent material). Above that the
   * generator just re-covers facts it has already used — and the old code
   * accepted those repeats as fresh questions, which is a large part of why
   * the tests read as inaccurate. Same target, honest ceiling.
   */
  const supportable = Math.max(4, Math.floor(chars / 350));
  return Math.max(4, Math.min(20, Math.min(asked, supportable)));
}

export function parseQuiz(text) {
  const t = String(text || '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const tryParse = (s) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // --- 1. direct shapes: bare array, wrapper object, single question ---
  let arr = null;
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const a = tryParse(t.slice(start, end + 1));
    // Only accept if it actually contains question objects — otherwise a
    // single-question output's inner options array ["A","B",...] would win.
    if (
      Array.isArray(a) &&
      a.some((x) => x && typeof x === 'object' && !Array.isArray(x))
    ) {
      arr = a;
    }
  }
  if (!arr || !arr.length) {
    const o = tryParse(t);
    if (Array.isArray(o)) arr = o;
    else if (o && typeof o === 'object') {
      if (Array.isArray(o.questions)) arr = o.questions;
      else if (typeof o.q === 'string') arr = [o]; // model returned one object
      else arr = Object.values(o).find((v) => Array.isArray(v)) || [];
    }
  }

  // --- 2. salvage: small models truncate (token cap) or degrade mid-array.
  // Walk the text tracking braces/brackets/strings, keep every complete
  // {...} object, and repair a truncated tail by closing what's open. ---
  if (!arr || !arr.length) {
    const stack = []; // ['{' | '[', position]
    let inStr = false;
    let esc = false;
    const objs = [];
    const tryPush = (span) => {
      const parsed = tryParse(span);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objs.push(parsed);
      return Array.isArray(parsed) ? parsed : null;
    };
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{' || c === '[') stack.push([c, i]);
      else if (c === '}' || c === ']') {
        const top = stack.pop();
        if (top && top[0] === '{' && c === '}') tryPush(t.slice(top[1], i + 1));
      }
    }
    // Truncated tail: close the open string and every open bracket, reparse.
    if (stack.length) {
      let full = t;
      if (inStr) full += '"';
      for (let j = stack.length - 1; j >= 0; j--) full += stack[j][0] === '{' ? '}' : ']';
      const o = tryParse(full);
      if (Array.isArray(o)) arr = o;
      else if (o && typeof o === 'object') {
        if (Array.isArray(o.questions)) arr = o.questions;
        else if (typeof o.q === 'string') arr = [o];
      }
    }
    if ((!arr || !arr.length) && objs.length) arr = objs;
  }

  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const raw of arr) {
    if (!raw || typeof raw.q !== 'string' || !raw.q.trim()) continue;
    const opts = Array.isArray(raw.options)
      ? raw.options.filter((o) => typeof o === 'string' && o.trim())
      : [];
    if (opts.length < 2 || opts.length > 6) continue;
    /* The key arrives as PROSE ("correct"), not as an index — see QUIZ_SYS.
     * An index is still tolerated as a fallback for models that ignore the
     * instruction, but keyQuiz() marks it unverified, so the audit pass has to
     * confirm it before it can grade anybody. */
    const correct = typeof raw.correct === 'string' ? raw.correct.trim() : '';
    const ans = Number(raw.answer);
    const hasIdx = Number.isInteger(ans) && ans >= 0 && ans < opts.length;
    if (!correct && !hasIdx) continue;
    out.push({
      q: raw.q.trim(),
      options: opts.map((o) => o.trim()),
      correct,
      answer: hasIdx ? ans : -1,
      why: typeof raw.why === 'string' ? raw.why.trim() : '',
    });
  }
  return out;
}

/* Reject degenerate / repetitive questions and options produced by small
 * models that fall into loops (same validation idea as sanitizePoints). */
export function sanitizeQuiz(questions) {
  return (questions || []).filter((q) => {
    if (!q || typeof q.q !== 'string') return false;
    const t = q.q.trim();
    if (t.length < 8 || t.length > 300 || hasRepetition(t, 3)) return false;
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) return false;
    if (q.options.every((o) => String(o).trim().length <= 2)) return false; // ["A","B","C","D"] placeholders
    for (const o of q.options) {
      if (typeof o !== 'string' || !o.trim() || o.length > 160) return false;
      if (hasRepetition(o, 1)) return false;
    }
    const keyed =
      (typeof q.correct === 'string' && q.correct.trim()) ||
      (Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
    return !!keyed;
  });
}

export function runQuiz(convId, messages, explains, force = false) {
  if (!convId) return;
  const fp = fingerprintOf(messages, explains);
  const cached = quizCache[convId];
  if (
    !force &&
    cached &&
    cached.v === QUIZ_VERSION &&
    cached.fingerprint === fp &&
    (cached.questions || []).length
  ) {
    return;
  }
  if (
    messages.length === 0 &&
    Object.keys((explains && explains.nodes) || {}).length === 0
  ) {
    return;
  }
  if (quizState.inflight) {
    quizState.queue = { convId, messages, explains, force };
    return;
  }

  quizState.inflight = convId;
  quizState.controller = new AbortController();
  const signal = quizState.controller.signal;
  const isCurrent = () => convId === state.currentId;
  if (isCurrent()) renderTestSection(); // shows the "preparing" state

  /*
   * Two sampling profiles. Variety now comes from the QUIZ_FOCUS rotation and
   * from writing each batch against a different chunk of the session, so the
   * temperature no longer has to supply it — at 0.8 it was also free to hand
   * back a wrong or mismatched key (root cause 4 in PLAN §9.1). Verification
   * is a measurement, not a creative step: temperature 0.
   * No frequency/repeat penalty with grammar-locked JSON: it pushes small
   * models into rambling inside string values until the token cap.
   */
  const GEN_SAMPLING = { temperature: 0.4, maxTokens: 900, jsonMode: true };
  const VERIFY_SAMPLING = { temperature: 0, maxTokens: 700, jsonMode: true };
  const BATCH = 3; // questions per request — short outputs parse reliably

  /* One audit request per generated batch: the batch's own source is right
   * there, so no key is ever checked against text it did not come from.
   * Returns null when the audit could not run — applyVerdicts() then keeps
   * only the keys that were resolved from the model's own prose. */
  const auditBatch = async (questions, source) => {
    if (!questions.length) return null;
    let txt;
    try {
      txt = await bgRequest(
        [
          { role: 'system', content: QUIZ_VERIFY_SYS },
          {
            role: 'user',
            content:
              `SOURCE:\n${source}\n\nQUESTIONS:\n` +
              JSON.stringify(
                questions.map((q, i) => ({
                  i,
                  q: q.q,
                  options: q.options,
                  claimed: q.answer,
                }))
              ),
          },
        ],
        signal,
        VERIFY_SAMPLING
      );
    } catch {
      return null;
    }
    if (/^\s*⚠️/.test(String(txt))) return null;
    return parseVerdicts(txt, questions.length);
  };

  // Serialize behind the summary job — one generation at a time.
  enqueueBg(async () => {
    try {
      const n = quizCount(convId, messages, explains);
      /* Phase 1: the SAME chunks the summary reads, instead of
       * summaryPromptInput()'s last-30-messages digest clipped to 400 chars —
       * anything older, or past 400 characters into a real answer, simply was
       * not in front of the model, so it invented a key. */
      const chunks = buildSummaryChunks(messages, explains);
      if (!chunks.length) throw new Error('empty session');

      const all = [];
      const seenQ = new Set();
      const audit = { dropped: 0, repaired: 0, quoted: 0, ambiguous: 0 };
      let batch = 0;
      let emptyStreak = 0;
      let ci = 0;
      let round = 0;
      // Bounds, not hopes: 12 batches covers a 20-question test with room for
      // duplicates, and 4 passes over the same chunk is plenty of variety for
      // a session too short to have produced more chunks.

      // Round-robin the chunks until we have enough questions: every part of
      // the session gets covered, and a second round goes back for facts the
      // first round did not use.
      while (all.length < n && batch < 12 && emptyStreak < 4) {
        if (signal.aborted) return;
        if (ci >= chunks.length) {
          ci = 0;
          round++;
          if (round >= 4) break;
        }
        const src = chunks[ci++];
        const want = Math.min(BATCH, n - all.length);
        batch++;
        const covered = all.map((q) => q.q.slice(0, 90));
        const focus = QUIZ_FOCUS[(batch - 1) % QUIZ_FOCUS.length];
        const txt = await bgRequest(
          [
            { role: 'system', content: QUIZ_SYS },
            {
              role: 'user',
              content:
                `SOURCE (one part of this learning session):\n${src}\n\n` +
                `Create exactly ${want} multiple-choice questions drawn ONLY from this source` +
                (covered.length
                  ? `.\nDo NOT repeat or rephrase questions already created:\n- ${covered.join('\n- ')}`
                  : '') +
                `.\nThis batch's focus: ${focus}.` +
                ' Ask about a DIFFERENT fact than any question so far, ' +
                `and output a JSON array with all ${want} questions.`,
            },
          ],
          signal,
          GEN_SAMPLING
        );
        if (/^\s*⚠️/.test(String(txt))) {
          emptyStreak++;
          continue;
        }

        /* Phase 2: key from the prose, then have the source audited — but only
         * what we would actually keep. Auditing a question that is already in
         * the test spends a request on an answer we would throw away anyway. */
        const keyed = keyQuiz(sanitizeQuiz(parseQuiz(txt))).map(shuffleQuestion);
        const fresh = [];
        for (const q of keyed) {
          if (all.length + fresh.length >= n) break;
          const key = q.q.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').slice(0, 80);
          if (!key || seenQ.has(key)) continue; // duplicate of an earlier batch
          seenQ.add(key);
          fresh.push(q);
        }
        if (!fresh.length) {
          emptyStreak++; // model has run out of new facts (or of JSON)
          continue;
        }
        const verdicts = await auditBatch(fresh, src);
        const res = applyVerdicts(fresh, verdicts, src);
        audit.dropped += res.stats.dropped;
        audit.repaired += res.stats.repaired;
        audit.quoted += res.stats.quoted;
        audit.ambiguous += res.stats.ambiguous;

        let added = 0;
        for (const q of res.kept) {
          if (all.length >= n) break;
          all.push(q);
          added++;
        }
        emptyStreak = added ? 0 : emptyStreak + 1;
      }

      // Kept / dropped / repaired, for the guardrail in PLAN §9.2. Pre-built as
      // a string: console format specifiers survive as text through CDP.
      console.debug(
        `[quiz] target=${n} kept=${all.length} batches=${batch} ` +
          `dropped=${audit.dropped} repaired=${audit.repaired} ` +
          `quoted=${audit.quoted} ambiguous=${audit.ambiguous}`
      );

      const status = summaryState.inflight === convId ? 'summarizing…' : '';
      if (all.length) {
        const entry = { fingerprint: fp, questions: all, at: Date.now(), v: QUIZ_VERSION };
        quizCache[convId] = entry;
        fetch(`/api/conversations/${convId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quiz: entry }),
        }).catch(() => {});
        if (isCurrent()) renderSummary(summaryCache[convId], status);
      } else if (isCurrent()) {
        renderSummary(
          summaryCache[convId],
          signal.aborted ? status : 'test generation failed — press ↻'
        );
      }
    } catch (e) {
      if (isCurrent()) {
        renderSummary(
          summaryCache[convId],
          signal.aborted ? '' : 'test generation failed — press ↻'
        );
      }
    } finally {
      if (quizState.inflight === convId) {
        quizState.inflight = null;
        quizState.controller = null;
      }
      const queue = quizState.queue;
      quizState.queue = null;
      if (queue) runQuiz(queue.convId, queue.messages, queue.explains, queue.force);
      if (isCurrent()) renderTestSection(); // ready / not-ready CTA
    }
  });
}

/* ---------- Take a test: one question at a time, auto-advance ---------- */

export function currentQuestions() {
  if (state.quizView && Array.isArray(state.quizView.questions)) return state.quizView.questions;
  const q = quizCache[state.currentId];
  return (q && q.questions) || [];
}

export function startTest() {
  const q = quizCache[state.currentId];
  const qs = (q && q.questions) || [];
  if (!qs.length) return;
  state.quizView = {
    questions: qs, // snapshot — later background refreshes don't disturb the test
    i: 0,
    answers: new Array(qs.length).fill(null),
    done: false,
    saved: false,
    report: null,
  };
  state.summaryMode = 'quiz';
  renderQuiz();
}

export function backToSummary() {
  state.summaryMode = 'summary';
  state.quizView = null;
  renderSummary(summaryCache[state.currentId], state.lastSummaryStatus);
}

export function renderQuiz() {
  const qs = currentQuestions();
  if (!state.quizView || !qs.length) {
    backToSummary();
    return;
  }
  const i = Math.min(state.quizView.i, qs.length - 1);
  state.quizView.i = i;
  const q = qs[i];
  const picked = state.quizView.answers[i];
  render(
    html`<div class="quiz-card">
      <div class="quiz-top">
        <span class="quiz-progress">${`Question ${i + 1} / ${qs.length}`}</span>
        <div class="quiz-bar">
          <div
            class="quiz-bar-fill"
            style=${`width:${Math.round((100 * (i + 1)) / qs.length)}%`}
          />
        </div>
      </div>
      <div class="quiz-q" dangerouslySetInnerHTML=${{ __html: renderInline(escapeHtml(q.q)) }} />
      <div class="quiz-options">
        ${q.options.map(
          (o, oi) => html`<button
            type="button"
            class=${`quiz-opt${picked === oi ? ' picked' : ''}`}
            data-opt=${oi}
          >
            <span class="opt-letter">${String.fromCharCode(65 + oi)}</span>
            <span
              class="opt-text"
              dangerouslySetInnerHTML=${{ __html: renderInline(escapeHtml(String(o))) }}
            />
          </button>`
        )}
      </div>
      <div class="quiz-nav">
        <button type="button" id="quiz-prev" disabled=${i === 0}>‹ Previous</button>
        <span class="quiz-hint">${picked === null ? 'Pick an answer — the test moves on by itself.' : ''}</span>
      </div>
    </div>`,
    testSection
  );
}

export function persistTests() {
  fetch(`/api/conversations/${state.currentId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tests: testsCache[state.currentId] || [] }),
  }).catch(() => {});
}

export function finishTest() {
  const qs = currentQuestions();
  if (!state.quizView || !qs.length) {
    backToSummary();
    return;
  }
  const items = qs.map((q, idx) => ({
    q: q.q,
    options: q.options,
    answer: q.answer,
    why: q.why || '',
    snippet: q.snippet || '', // the source sentence the audit pass quoted
    picked: state.quizView.answers[idx],
  }));
  const score = items.filter((it) => it.picked === it.answer).length;
  const percent = items.length ? Math.round((100 * score) / items.length) : 0;
  const report = { score, total: items.length, percent, at: Date.now(), items };
  state.quizView.report = report;
  state.quizView.done = true;
  if (!state.quizView.saved) {
    state.quizView.saved = true;
    const list = testsCache[state.currentId] || (testsCache[state.currentId] = []);
    list.push(report);
    if (list.length > 10) list.splice(0, list.length - 10);
    persistTests();
  }
  state.summaryMode = 'results';
  renderResults();
}

export function viewReport(idx) {
  const r = (testsCache[state.currentId] || [])[idx];
  if (!r) return;
  state.quizView = { questions: [], i: 0, answers: [], done: true, saved: true, report: r };
  state.summaryMode = 'results';
  renderResults();
}

export function renderResults() {
  const r = state.quizView && state.quizView.report;
  if (!r) {
    backToSummary();
    return;
  }
  renderTestBadges();
  const grade =
    r.percent >= 90
      ? '🏆 Excellent!'
      : r.percent >= 70
        ? '👏 Good job!'
        : r.percent >= 50
          ? '📘 Decent — review the points, then try again.'
          : '🌱 Have another look at the summary, then try again.';
  render(
    html`<div class="results-card">
      <div class="results-score">
        ${`${r.score}/${r.total} `}<span class="results-pct">${`${r.percent}%`}</span>
      </div>
      <div class="results-grade">${grade}</div>
      <ul class="results-list">
        ${(r.items || []).map((it, idx) => {
          const ok = it.picked === it.answer;
          const opts = it.options || [];
          const pickedTxt =
            it.picked == null ? '—' : String(opts[it.picked] != null ? opts[it.picked] : '—');
          const correctTxt = String(opts[it.answer] != null ? opts[it.answer] : '—');
          const line = ok
            ? 'Your answer: ' + renderInline(escapeHtml(pickedTxt))
            : 'Your answer: <s>' +
              renderInline(escapeHtml(pickedTxt)) +
              '</s> · Correct: <b>' +
              renderInline(escapeHtml(correctTxt)) +
              '</b>';
          // res-q mixes a marker span with inline markdown, so the whole line
          // is HTML the same way it was before — Preact owns the <li> itself.
          return html`<li class=${ok ? 'ok' : 'bad'}>
            <div
              class="res-q"
              dangerouslySetInnerHTML=${{
                __html: `<span class="res-mark">${ok ? '✓' : '✗'}</span>${idx + 1}. ${renderInline(
                  escapeHtml(String(it.q || ''))
                )}`,
              }}
            />
            <div class="res-line" dangerouslySetInnerHTML=${{ __html: line }} />
            ${it.why
              ? html`<div
                  class="res-why"
                  dangerouslySetInnerHTML=${{ __html: renderInline(escapeHtml(String(it.why))) }}
                />`
              : null}
            ${it.snippet
              ? html`<div class="res-src">Source: “${String(it.snippet)}”</div>`
              : null}
          </li>`;
        })}
      </ul>
      <div class="quiz-nav">
        <button type="button" id="quiz-retake">↻ Retake</button>
        <button type="button" id="quiz-back">‹ Back to summary</button>
      </div>
    </div>`,
    testSection
  );
}

/* ---------- Delegated clicks inside the summary overlay ---------- */

summaryBody.addEventListener('click', (e) => {
  // Delete a personal note (does not touch the AI summary).
  const del = e.target.closest('.note-del');
  if (del) {
    const id = del.dataset.note;
    state.notes = (state.notes || []).filter((n) => n.id !== id);
    persistNotes();
    renderSummary(summaryCache[state.currentId] || null, state.lastSummaryStatus);
    return;
  }
  // Collapsible header: show/hide the points (and the test button).
  if (e.target.closest('#sum-collapse')) {
    state.summaryExpanded = !state.summaryExpanded;
    renderSummary(summaryCache[state.currentId], state.lastSummaryStatus);
    return;
  }
  if (e.target.closest('#take-test-btn')) {
    startTest();
    return;
  }

  // Pick an answer -> the test advances automatically (no Next button).
  const opt = e.target.closest('.quiz-opt');
  if (opt && state.summaryMode === 'quiz' && state.quizView) {
    const at = state.quizView.i;
    state.quizView.answers[at] = Number(opt.dataset.opt);
    renderQuiz(); // show the pick immediately
    setTimeout(() => {
      if (!state.quizView || state.summaryMode !== 'quiz' || state.quizView.i !== at) return;
      const qs = currentQuestions();
      if (state.quizView.i < qs.length - 1) {
        state.quizView.i += 1;
        renderQuiz();
      } else {
        finishTest();
      }
    }, 450);
    return;
  }

  if (e.target.closest('#quiz-prev')) {
    if (state.quizView && state.quizView.i > 0) {
      state.quizView.i -= 1;
      renderQuiz();
    }
    return;
  }
  if (e.target.closest('#quiz-retake')) {
    startTest();
    return;
  }
  if (e.target.closest('#quiz-back')) {
    backToSummary();
    return;
  }
});

/* Header badges: past test reports, newest first. */
testBadges.addEventListener('click', (e) => {
  const b = e.target.closest('.test-badge');
  if (b) viewReport(Number(b.dataset.i));
});
