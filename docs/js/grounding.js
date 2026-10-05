/* grounding.js — the rules that keep the summary and the quiz tied to the
 * text they claim to describe.
 *
 * Zero imports on purpose, exactly like export-format.js: nothing here touches
 * the DOM, the network or module state. That buys two things — it can be run
 * straight from node (`node scripts/grounding-check.mjs`) as a guardrail, and
 * it cannot create an import cycle between summary.js and quiz.js, which both
 * need these rules.
 *
 * Four jobs:
 *   1. clipHeadTail  — cut long messages without throwing away their END, so a
 *                      derivation's conclusion survives into the chunk that
 *                      both the summary and the quiz read.
 *   2. resolve/key   — turn the model's PROSE answer ("the option that says …")
 *                      into an index. No confident match means no question:
 *                      guessing an index is how a correct user gets marked wrong.
 *   3. shuffle       — stop every key landing in slot 0.
 *   4. verdicts      — apply the audit pass: which option does the source
 *                      actually support, with a quote, and is more than one
 *                      option defensible?
 */

/* ---------------- 1. clipping ---------------- */

/*
 * Head-only clipping hid the second half of every long answer: MAP extracted
 * notes from the middle of a derivation and REDUCE faithfully condensed the
 * wrong half, so the summary read as if the question had never been resolved.
 * Keep ~62% of the budget up front and the rest at the back, with a marker in
 * between so the model can tell the two halves are not contiguous.
 */
export function clipHeadTail(s, n) {
  const str = String(s == null ? '' : s);
  if (str.length <= n) return str;
  const head = Math.max(24, Math.round(n * 0.62));
  const tail = Math.max(24, n - head - 1);
  return str.slice(0, head) + '…' + str.slice(str.length - tail);
}

/* ---------------- 2. answer keys ---------------- */

/* Comparison key: case- and punctuation-insensitive, whitespace collapsed.
 * Options are prose, so "9.8 m/s²" and "9.8 m/s^2" are the same answer. */
export function normKey(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/*
 * Resolve the generated "correct" (prose) against the option list.
 * Returns { answer, exact }; answer is -1 when nothing is confident, and the
 * caller drops the question rather than inventing an index.
 *
 * Containment only counts when both sides are long enough to be a real
 * phrase — otherwise a one-character option would match everything.
 */
export function resolveAnswer(correct, options) {
  const want = normKey(correct);
  const opts = Array.isArray(options) ? options : [];
  if (!want || !opts.length) return { answer: -1, exact: false };

  const keys = opts.map(normKey);
  const hit = keys.indexOf(want);
  if (hit >= 0) return { answer: hit, exact: true };

  const MIN_PHRASE = 8;
  const hits = [];
  keys.forEach((k, i) => {
    if (!k) return;
    const len = Math.min(k.length, want.length);
    if (len < MIN_PHRASE) return;
    if (want.includes(k) || k.includes(want)) hits.push(i);
  });
  if (hits.length === 1) return { answer: hits[0], exact: false };
  return { answer: -1, exact: false }; // no match, or more than one nests → drop
}

/* ---------------- 3. position bias ---------------- */

/*
 * Models that write "correct" as a verbatim copy of an option tend to emit
 * that option FIRST — one run here came back 7/7 with the answer in slot 0,
 * which makes the test guessable and looks broken even when every key is
 * right. Randomise the order (moving the key with it) BEFORE the audit, so
 * the auditor has to read the source too instead of noticing a pattern.
 * Fisher-Yates; returns a new question and never mutates the input.
 */
export function shuffleQuestion(q) {
  if (!q || !Array.isArray(q.options) || q.options.length < 2) return q;
  const cells = q.options.map((text, i) => ({ text, key: i === q.answer }));
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = cells[i];
    cells[i] = cells[j];
    cells[j] = tmp;
  }
  const answer = cells.findIndex((c) => c.key);
  if (answer < 0) return q; // no key to carry over — leave it alone
  return { ...q, options: cells.map((c) => c.text), answer };
}

/* ---------------- 4. verification ---------------- */

/* Was the quote actually taken from the source? Normalised substring match so
 * the model's light re-typing (spacing, punctuation, smart quotes) still
 * counts, with a head/tail fallback for quotes it trimmed on the way out. */
export function quoteInSource(quote, source) {
  const q = normKey(quote);
  if (q.length < 6) return false;
  const src = normKey(source);
  if (!src) return false;
  if (src.includes(q)) return true;
  return src.includes(q.slice(0, 40)) || src.includes(q.slice(-40));
}

/*
 * Attach a resolved key to every generated question. A question survives only
 * if its key came from the model's own prose, or from an index that the audit
 * pass can still confirm — never from an index nobody checked.
 */
export function keyQuiz(list) {
  const out = [];
  for (const raw of list || []) {
    if (!raw || typeof raw.q !== 'string' || !Array.isArray(raw.options)) continue;
    const resolved = resolveAnswer(raw.correct, raw.options);
    let answer;
    let keyed = false;
    if (resolved.answer >= 0) {
      answer = resolved.answer;
      keyed = true;
    } else if (
      Number.isInteger(raw.answer) &&
      raw.answer >= 0 &&
      raw.answer < raw.options.length
    ) {
      answer = raw.answer; // legacy shape — the audit pass must confirm it
    } else {
      continue;
    }
    out.push({
      q: raw.q,
      options: raw.options,
      answer,
      keyed,
      why: raw.why || '',
      snippet: '',
    });
  }
  return out;
}

/* Pull the audit verdicts back out of the model's JSON array, indexed by
 * question position. Malformed entries stay undefined so applyVerdicts can
 * treat "said nothing" differently from "said it is wrong". */
export function parseVerdicts(text, n) {
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
  let arr = null;
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start !== -1 && end > start) arr = tryParse(t.slice(start, end + 1));
  if (!Array.isArray(arr)) arr = tryParse(t);
  if (!Array.isArray(arr)) return null;

  const out = new Array(Math.max(0, n));
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const i = Number(raw.i);
    if (!Number.isInteger(i) || i < 0 || i >= n) continue;
    const sup = Number(raw.supported);
    out[i] = {
      supported: Number.isInteger(sup) ? sup : -1,
      quote: typeof raw.quote === 'string' ? raw.quote : '',
      ambiguous: raw.ambiguous === true || raw.ambiguous === 'true',
    };
  }
  return out;
}

/*
 * The actual fix for "my correct answer was marked wrong": the key is only
 * kept when an independent read of the same source agrees, and it is repaired
 * (never silently trusted) when the two disagree and the disagreement comes
 * back with a quote that is really in the text.
 *
 * Drop rules:
 *   - more than one option is defensible            → ambiguous, no key exists
 *   - the source supports no option                 → unanswerable
 *   - disagreement with no usable quote             → cannot audit either side
 *   - index-only key the verifier never spoke about → unverified guess
 */
export function applyVerdicts(questions, verdicts, source) {
  const kept = [];
  const stats = { dropped: 0, repaired: 0, quoted: 0, ambiguous: 0 };

  (questions || []).forEach((q, i) => {
    const v = verdicts && verdicts[i];
    if (!v) {
      if (q.keyed) kept.push(q); // prose key, audit silent → acceptable
      else stats.dropped++;
      return;
    }
    if (v.ambiguous) {
      stats.ambiguous++;
      stats.dropped++;
      return;
    }
    const sup = v.supported;
    if (!Number.isInteger(sup) || sup < 0 || sup >= q.options.length) {
      stats.dropped++;
      return;
    }
    const usable = quoteInSource(v.quote, source);
    if (sup !== q.answer) {
      if (!usable) {
        stats.dropped++;
        return;
      }
      q.answer = sup;
      q.keyed = true;
      stats.repaired++;
    }
    if (usable) {
      q.snippet = String(v.quote).replace(/\s+/g, ' ').trim().slice(0, 240);
      stats.quoted++;
    } else if (!q.keyed) {
      stats.dropped++;
      return;
    }
    kept.push(q);
  });

  return { kept, stats };
}
