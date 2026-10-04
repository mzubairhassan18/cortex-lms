/* Guardrail for PLAN §9 — summary & quiz accuracy.
 *
 *     node scripts/grounding-check.mjs
 *
 * Runs the pure grounding layer against deliberately bad model output: wrong
 * answer keys, ambiguous options, missing quotes, malformed verdicts. Prints
 * what is kept, repaired and dropped, and — the case the whole phase exists
 * for — whether a user who picked the option the SOURCE supports now grades
 * as correct.
 *
 * It does not call a model — the live half (regenerating real conversations
 * end to end) is a manual run against a routed provider, logged in PROGRESS
 * as part of P1.32. What this exercises is the part that used to fail silently: a key
 * nobody ever checked, and a key that always landed in slot 0.
 */

import {
  applyVerdicts,
  clipHeadTail,
  keyQuiz,
  parseVerdicts,
  quoteInSource,
  resolveAnswer,
  shuffleQuestion,
} from '../public/js/grounding.js';

let pass = 0;
let fail = 0;

const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(
    `${ok ? '  ok  ' : 'FAIL  '}${name}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  );
};

/* ------------------------------------------------------------------ *
 * 1. clipping — the end of a long answer must survive
 * ------------------------------------------------------------------ */

console.log('\nclipHeadTail');

check('short text is untouched', clipHeadTail('F = 9.8 m/s2', 500), 'F = 9.8 m/s2');

const longSrc = 'A'.repeat(1000) + 'THE CONCLUSION IS 9.8';
const clipped = clipHeadTail(longSrc, 750);
check('stays inside the budget', clipped.length <= 750, true);
check('keeps the head', clipped.startsWith('A'.repeat(100)), true);
check('keeps the conclusion at the tail', clipped.includes('THE CONCLUSION IS 9.8'), true);
check('marks the cut', clipped.includes('…'), true);

/* ------------------------------------------------------------------ *
 * 2. prose answer -> index
 * ------------------------------------------------------------------ */

console.log('\nresolveAnswer');

const opts = [
  'It stops caring about the input',
  'It weights the input by relevance',
  'It averages every value equally',
  'It throws away the shortest values',
];

check('verbatim copy', resolveAnswer('It weights the input by relevance', opts).answer, 1);
check(
  'punctuation / unicode variant',
  resolveAnswer('Weights the input by relevance.', opts).answer,
  1
);
check('no confident match drops the question', resolveAnswer('it is the third one', opts).answer, -1);
check('empty answer drops the question', resolveAnswer('', opts).answer, -1);

const units = ['It falls at 9.8 metres per second squared', 'It falls at 1.6 metres per second squared'];
check(
  'unambiguous nesting resolves',
  resolveAnswer('It falls at 9.8 metres per second squared (downwards)', units).answer,
  0
);
check(
  'two candidates nest -> ambiguous -> drop',
  resolveAnswer('9.8 metres per second squared', ['falls at 9.8 metres per second squared', 'about 9.8 metres per second squared']).answer,
  -1
);

/* ------------------------------------------------------------------ *
 * 3. keying — prose is trusted, a bare index is not
 * ------------------------------------------------------------------ */

console.log('\nkeyQuiz');

const keyed = keyQuiz([
  { q: 'Q1?', options: ['a one', 'a two', 'a three', 'a four'], correct: 'a three', answer: 0 },
  { q: 'Q2?', options: ['b one', 'b two'], correct: '', answer: 1 },
  { q: 'Q3?', options: ['c one', 'c two'], correct: '', answer: 9 },
]);
check('prose key wins over a wrong index', [keyed[0].answer, keyed[0].keyed], [2, true]);
check('legacy index is kept but unverified', [keyed[1].answer, keyed[1].keyed], [1, false]);
check('out-of-range index with no prose is dropped', keyed.length, 2);

/* ------------------------------------------------------------------ *
 * 4. verdict parsing
 * ------------------------------------------------------------------ */

console.log('\nparseVerdicts');

const verdicts = parseVerdicts(
  '```json\n[{"i":0,"supported":2,"quote":"the source says 2","ambiguous":false},' +
    '{"i":1,"supported":-1,"quote":"","ambiguous":true}]\n```',
  3
);
check('parses a fenced array', [verdicts[0].supported, verdicts[1].ambiguous], [2, true]);
check('missing slots stay undefined', verdicts[2] === undefined, true);
check('unparseable output -> null', parseVerdicts('nope', 2), null);

/* ------------------------------------------------------------------ *
 * 5. the audit — the complaint, replayed
 * ------------------------------------------------------------------ */

console.log('\napplyVerdicts');

const SOURCE =
  'Student: which value is g?\n' +
  'Tutor: near Earth the acceleration due to gravity is 9.8 metres per second squared, ' +
  'so a falling object gains 9.8 m/s of speed every second.';

const GEN = [
  {
    q: 'What is the acceleration due to gravity near Earth?',
    options: ['9.8 metres per second squared', '6.67 times 10 to the minus 11', '3 times 10 to the power of 8', '1.6 metres per second squared'],
    correct: '9.8 metres per second squared',
    answer: -1,
    keyed: true,
    snippet: '',
  },
  // Generator insisted on an index, and insisted on the wrong one.
  {
    q: 'What does a falling object gain each second?',
    options: ['9.8 m/s of speed', '9.8 metres of height', 'nothing at all', '9.8 newtons of mass'],
    correct: '',
    answer: 1,
    keyed: false,
    snippet: '',
  },
  // Two options are both true statements.
  {
    q: 'Which of these is a unit of speed?',
    options: ['metres per second', 'newtons per metre', 'joules per second', 'coulombs per second'],
    correct: 'metres per second',
    answer: 0,
    keyed: true,
    snippet: '',
  },
];

const VERDICT_TEXT = JSON.stringify([
  { i: 0, supported: 0, quote: 'the acceleration due to gravity is 9.8 metres per second squared', ambiguous: false },
  { i: 1, supported: 0, quote: 'a falling object gains 9.8 m/s of speed every second', ambiguous: false },
  { i: 2, supported: -1, quote: '', ambiguous: true },
]);

const parsed = parseVerdicts(VERDICT_TEXT, GEN.length);
const { kept, stats } = applyVerdicts(GEN.map((g) => ({ ...g })), parsed, SOURCE);

check('two questions survive', kept.length, 2);
check('the index-only key was repaired', [kept[1].answer, kept[1].keyed], [0, true]);
check('ambiguous question dropped', stats.ambiguous, 1);
check('both survivors carry a source quote', kept.every((q) => q.snippet.length > 0), true);

/* The complaint itself: the user picked what the source supports. */
const userPick = 0; // "9.8 m/s of speed" — the true answer
const gradedBefore = GEN[1].answer === userPick; // what the old index-only key said
const gradedAfter = kept.find((q) => q.q === GEN[1].q).answer === userPick;
check('old key would have marked the correct pick wrong', gradedBefore, false);
check('repaired key marks the correct pick right', gradedAfter, true);

/* Disagreement with nothing to audit is not a key. */
const disagree = applyVerdicts(
  [{ ...GEN[1], answer: 3 }],
  parseVerdicts(JSON.stringify([{ i: 0, supported: 0, quote: 'not in the source at all', ambiguous: false }]), 1),
  SOURCE
);
check('disagreement without a usable quote -> dropped', disagree.kept.length, 0);

/* Audit silent: trust the prose key, never the bare index. */
const silent = applyVerdicts([{ ...GEN[0] }], null, SOURCE);
check('silent audit keeps a prose-resolved key', silent.kept.length, 1);
const silentIndex = applyVerdicts([{ ...GEN[1] }], null, SOURCE);
check('silent audit drops an index-only key', silentIndex.kept.length, 0);

check(
  'quotes are matched tolerantly',
  quoteInSource('gravity is 9.8 metres per second squared', SOURCE),
  true
);
check('a quote that is not in the source is refused', quoteInSource('gravity is 42 metres per second squared', SOURCE), false);

/* ------------------------------------------------------------------ *
 * 6. position bias — one live run came back 7/7 with the key in slot 0
 * ------------------------------------------------------------------ */

console.log('\nshuffleQuestion');

const FLAT = {
  q: 'Which statement is supported by the source?',
  options: ['alpha answer', 'beta answer', 'gamma answer', 'delta answer'],
  answer: 1,
  keyed: true,
  why: 'because',
  snippet: '',
};

const positions = [0, 0, 0, 0];
let travels = true;
let intact = true;
for (let k = 0; k < 400; k++) {
  const s = shuffleQuestion(FLAT);
  if (s.options[s.answer] !== 'beta answer') travels = false;
  if (s.options.length !== 4 || new Set(s.options).size !== 4) intact = false;
  if (s.q !== FLAT.q || s.keyed !== true || s.why !== 'because') intact = false;
  positions[s.answer]++;
}
check('the key always travels with its option', travels, true);
check('every option survives exactly once', intact, true);
check('the input question is never mutated', FLAT.answer, 1);
check('the answer spreads across all four slots (400 draws)', positions.every((p) => p > 30), true);
check('one option has nothing to shuffle', shuffleQuestion({ ...FLAT, options: ['only'], answer: 0 }).answer, 0);
check('malformed input passes through unchanged', shuffleQuestion(null), null);

/* ------------------------------------------------------------------ */

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
