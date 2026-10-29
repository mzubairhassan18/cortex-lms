# Cortex UX/UI Overhaul — Plan (Oct 2026)

Goal: make Cortex look and feel like a premium, calm, Heptabase-class learning tool
("premium not slop"), fix the free-mode graph bug, and lay the groundwork for the
competitor features we lack. Companion research notes: `docs/research-heptabase.md`.

Everything here is allowed to be rewritten — no sacred cows. Reference: the app is
frameworkless (Preact+htm views, vanilla DOM, no bundler); that architecture is *fine*
and stays for these phases; it's the visual/interaction system that's replaced.

---

## A. Design token system v2 (the foundation everything else consumes)

**File touched:** `public/style.css` tokens block + a new `public/tokens.css` imported
first by every page (landing, auth, pricing, app) so landing/app can never drift again.

> SUPERSEDED by `docs/DESIGN.md` ("Graphite & Ember"): cool zinc neutrals, ember accent,
> **Fraunces (display) + Geist (UI)**, self-hosted woff2 in `public/vendor/fonts/`
> (app promises "runs on your machine" → no font CDN; both OFL). The CSS below is the
> sketch — DESIGN.md carries the verified final values.

```css
:root {
  /* ---- color (light is the new primary. warm paper, never stark white) ---- */
  --canvas: #f7f7f5;            /* page */
  --surface: #ffffff;           /* raised card */
  --surface-tint: rgba(255,255,255,.55); /* cards on canvas */
  --surface-warm: #f0f0ec;      /* wells, tiles, graph node fills */
  --ink: #26262a;               /* text AND primary CTA fill */
  --ink-strong: #000000;        /* reserved: active pill, wordmark only */
  --muted: #6a6972;
  --faint: #8a8990;
  --hairline: rgba(20,20,25,.08);
  --hairline-strong: rgba(20,20,25,.14);
  --accent: #207dff;            /* ONLY: AI features + interactive emphasis */
  --ok: #59a639;                /* ONLY: checkmarks / success ticks */

  /* ---- dark theme: warm graphite, not blue Mocha ---- */
  /* canvas #191917  surface #202020  ink #e8e6e1  muted #a3a19c
     accent same #207dff (works on both), ok #7fce4e, hairline rgba(255,255,255,.09) */

  /* ---- type scale (rem, 1rem=16): 12 13 14 15 16 18 21 26 34 48 ---- */
  --font-ui: 'Inter', system-ui, -apple-system, sans-serif;
  --font-display: 'Instrument Sans', 'Inter', system-ui, sans-serif;
  --font-mono: 'Inter', ui-monospace, 'Cascadia Mono', monospace;
  /* weights: 400 body · 500 interactive/display · 600 card titles · 750 never */

  /* ---- spacing (8-point): --s1 4 · --s2 8 · --s3 12 · --s4 16 · --s5 24
     --s6 32 · --s7 48 · --s8 64 ---- */

  /* ---- radius: --r-sm 6 · --r-md 8 · --r-lg 12 · --r-xl 20 · --r-pill 999 ---- */

  /* ---- motion ---- */
  --t-fast: 120ms cubic-bezier(.25,.1,.25,1);
  --t-med: 200ms cubic-bezier(.2,.6,.25,1);
  --t-slow: 320ms cubic-bezier(.2,.6,.25,1);
  /* NO springs, no translateY hover travel */

  /* ---- elevation: hairlines and fills only ---- */
  /* one exception allowed: --shadow-pop for menus/popovers: 0 8px 24px rgba(0,0,0,.14) */

  /* ---- type roles (semantic) ---- */
  --fs-display: clamp(34px, 5.6vw, 48px);  /* hero: 500, tracking -0.033em */
  --fs-h2: clamp(26px, 3.2vw, 36px);       /* 500, -0.015em */
  --fs-h3: 18px; --fs-body: 15.5px; --fs-body-lg: 17px; --fs-ui: 13.5px;
  --lh-body: 1.65; /* chat + reading text; UI text 1.45 */
}
```

Rules to encode in a comment at the top of the tokens file:
1. No literal color anywhere else in any CSS file (grep-enforceable).
2. `--accent` never on bullets, borders, headings — only AI/interactive emphasis.
3. Minimum rendered size: 13px in-app (bodies 15.5+); kills today's 11–12.5px strata.
4. Headlines: weight 500 max, tracking negative, `text-wrap: balance`.
5. Grain texture **deleted** app-wide; dot-grid survives ONLY on the graph canvas.

Acceptance: both themes ship identical structure; a `prefers-contrast`/reduced-motion
pass; landing + auth + pricing + admin consume tokens.css.

---

## B. Graph-mode bug fix (correctness — do this first)

**Bug:** graph mode, free layout → create a conversation at a click (`placeAtClick`,
`graph.js:1379-1387`) → select text → Explain. The new explain node renders at its
*aligned-column* position (top-left), far away/"behind", and the edge
source(right)→target(left) degenerates into a long right-to-left arrow.

**Root cause chain (exact):**
1. `placeAtClick` saves only `c:<id>`; nothing ever seeds `e:*` positions at explain
   creation.
2. `layout()` applies saved overrides *after* `layoutAligned()` computed anchors, so the
   explain forest anchored to the **aligned** conversation position (`graph.js:480-508`,
   `cur = pos.get('c:'+state.currentId)`), not the free one.
3. `addPath()` (`graph.js:701-713`) assumes `b` is right of `a`
   (`mid = x1 + Math.max(14, (x2-x1)/2)`; when `x2 < x1` the final `H ${x2}` runs
   backwards ~1000s of px → the notorious long backward arrow).

**Fix (4 changes, all in `graph.js` + tiny):**
1. In `layout()`: compute the *effective* conv position — override `c:*`/`s:*` keys from
   `layoutPositions` **inside** (or immediately after) `layoutAligned`, and thread the
   effective conv coordinate into the forest anchor + `depthX` derivation so children
   chain from where the conversation actually is.
2. On explain creation (`explain-lifecycle.js`) in free mode, seed the new explain's
   default position next to its parent: `x = parent.x + parent.w + GAP_X`,
   `y = parent.y (+ siblings)`; write `e:<id>` to `layoutPositions` + `saveLayout()`.
   Aligned mode stays untouched (positions are ignored there).
3. In `place()`/`render()`, a newly created explain must be positioned *before* its DOM
   element paints (place → then show) so it never flashes at 0,0/behind.
4. `addPath()` mirrored route when `x2 < x1`: route
   `M x1 y1 H mid → V y2 → H x2` with `mid = min(x2 - 14, ...)` style symmetric clamp —
   i.e., compute the trunk `mid` inside the gap between the two nodes regardless of
   direction; also switch to a rounded-corner path (see §D curves).

Acceptance: free-mode explain chains read left→right edge, arrowhead at the child,
node appears beside its parent, no long backward edge; aligned mode regression-tested
(multi-branch, deep nesting, drag tree, reset positions).

---

## C. Landing page redesign

Keep: the honest copy spine (problem → features → how → fine-print), the `lb.theme`
no-flash script, static/standalone CSS. Replace everything visual.

1. **Nav**: quiet 13.5px Geist; wordmark "Cortex" in Fraunces + custom SVG glyph mark
   (19px) instead of `🧠`; right side = `See how it works` link + dark **ink pill** CTA.
2. **Hero**: paper canvas (light primary, graphite dark); display headline in Fraunces
   500 @48–66px, tracking −0.02em, two lines max, sentence case. Sub copy 17px
   muted, 64ch max. Primary CTA = ink pill (white text); secondary = text link with arrow.
   Remove: grain, dot grid, glowing shadows, green bullet dots.
3. **THE CHANGE — show the product**: within the hero (or immediately below), a real
   screenshot of a Cortex conversation with an explain panel open, plus a second frame of
   the graph view. Cards = white `#fff` + `rgba(0,0,0,.14)` hairline, radius 12, NO
   shadow, slight (`1px`) inset lift. Captions 13px muted (`"The explanation that
   didn't land sits beside it — permanently."`).
4. **Problem band**: 3 cards but flat — `surface-tint` fill + hairline, no hover lift,
   glyphs become 12px hairline icons (from the app's own sprite), NOT colored chips.
5. **Features band**: replace 6 equal prose cards with 2 big illustrated features
   (explain tree, graph) + small quiet tiles row for the rest (notes, quizzes, files/BYOK,
   persistence) — mirroring Heptabase's "essentials, done right" mosaic rhythm.
6. **How-it-works**: keep 3 steps but as numbered list rows (hairline separators), not
   boxed cards; step numerals in Instrument Sans.
7. **Fine print**: checkmarks in `--ok` green (`#59a3..`), circles dropped, plain rows.
8. **Footer**: minimal, ink wordmark, 3 links.
9. Type/spacing: tokens only; section padding `--s8 64–96px`; body 15.5–17px.

Acceptance: zero shadows; exactly one blue role + one green role on the page; headline
weight 500; two real screenshots present; both themes correct.

---

## D. App-shell redesign (in-app)

1. **Top bar**: 44px, canvas-colored, hairline bottom. Buttons: 30px ghost icon buttons,
   muted→ink on hover; active tool = ink fill pill (13/500). Model selector as quiet
   pill. Search command opens (⌘K). Nothing glows.
2. **Sidebar (conversations)**: 264px; list rows 36px, 13.5px text, radius 6 hover tint,
   active = `surface-warm` + left 2px ink tick; section label "Topic" 11px uppercase
   muted. New chat = ink pill (full width, 36px).
3. **Chat**: bubbles removed → **thread layout** (Heptabase-style): user turn = subtle
   tinted row w/ radiused inset, assistant turn = plain on canvas (max-width 72ch, 15.5px
   /1.65); timestamps/footers muted 12px; code blocks `surface-warm` + hairline, 13px mono,
   radius 8. Streaming cursor: 2px accent caret block (only place accent pulses).
4. **Explain panel** (right + in-graph): paper card — `surface` + hairline, radius 12,
   NO shadow; header 13/600; tabs as segmented pill (13/500: active ink-on-warm); source
   highlight = soft wash `color-mix(accent 12%, canvas)` + hairline underline, click →
   focus container without jump.
5. **Summary/quiz cards**: hairline cards; quiz options = 8px radius rows, selected = ink
   outline (not accent fill); correct/verdict states: green tick only. Badges quiet.
6. **Selection popup / menus**: ink pill for primary action, ghost for secondary; radius
   8; shadow-pop (the allowed one).
7. **Overlays (settings, library)**: 24px surface radius 16 hairline + shadow-pop;
   inputs 36px hairline 8px; labels 13/500.
8. **Workspaces layer**: cards on the zoomed-out canvas keep paper style + dot grid.
9. **Empty states**: single muted line + one quiet action — per Heptabase,
   "the empty canvas is the invitation" (replace any illustration).

Acceptance: grep finds zero literal colors outside tokens; no `translateY` hover lifts;
no `box-shadow` except `--shadow-pop` on popovers/overlays; min text size 12px (fine
print) / 13.5px (UI).

---

## E. Graph visual polish (after the bug fix)

1. **Nodes = paper cards**: collapsed chips surface-tint + hairline radius 8; expanded
   hosts radius 12 + hairline; title 13/600; meta 12 muted; host container gets a
   1px-inset border on focus. Remove node shadows/glows entirely.
2. **Edges**: replace staircase `M-H-V-H` with rounded orthogonal corners (fallback:
   cubic bezier sag); 1px `--hairline-strong`; active thread 1.5px semantic accent;
   arrowhead 6px minimal triangle. Direction-agnostic routing (§B.4).
3. **Selected/source-anchored node**: hairline-strong + soft wash, not glow.
4. **Canvas**: keep dot grid (it's *spatial context*, the one texture allowed), tune dots
   to hairline strength; DROP the noise grain layer here too.
5. **Mini-toolbar** (Aligned/Free, zoom, search) = one quiet pill group, 28px controls.
6. **Micro-interactions**: node expand/collapse on `--t-med`; drag = full opacity, live
   edge re-route; drop = settle (no bounce); fold-out-of-view retains current behavior.
7. **Camera**: keep; add `zoomTo` smoothing via rAF lerp (already exists per-flyTo) and
   respect reduced-motion.

---

## F. Interaction state upgrades (optimistic UI, loading, errors)

1. **Optimistic conversation create**: local conversation + instant selection +
   composer focus; server reconciliation on response (already the data shape works).
2. **Optimistic message send**: user bubble renders synchronously; assistant stream
   starts with skeleton dots — abortable, retry inline on error (error = one quiet red
   text row + retry link).
3. **Skeletons everywhere at final dimensions**: conversation list, summary card,
   quiz card, explain first-token, library grid. Kill spinners app-wide (spinner only
   inside graph's summary node generation).
4. **Toast discipline**: single toast hosts errors + destructive undo ONLY; successes
   stay inline-quiet.
5. **⌘K command palette** (new): jump conversations, toggle view, run summary/quiz,
   create explain from selection context. Cheap to add; marks the app "pro tools".
6. **Keyboard**: consistent shortcuts documented + settings page list.
7. **Retry/resume for lost streams** (worker restart mid-stream): banner + retry.

---

## G. Feature roadmap (competitor gaps → ordered by learning-loop value)

1. **Guided review mode** (answers their "AI Tutor" without building a course system):
   sequences open questions from the topics summary + missed quiz items into a daily
   3-step plan surfaced as graph/header chip. CHEAP — reuses summary.js + quiz.js data.
2. **Source panel on the graph** (answers their PDF annotation): open an uploaded file's
   extracted text as a board node; select → explain creates an edge from the *source
   node* not just chat — makes explains visually anchored to the source, completing the
   "materials on the desk" loop. MEDIUM — reuse files text endpoint + selection module.
3. **Cross-conversation links** (answers their bidirectional links): explain/summary
   nodes can reference another conversation's node; renders as cross-tree edge (the
   edge-routing fix makes this visually safe).
4. **Pricing rework** (answers their metered credits): proper hosted tier page — Free /
   Learner / Scholar with the bank-transfer flow restyled; core loop permanently free.
5. Later: YouTube transcript ingestion, read-later links, real client-side PWA offline.

---

## H. Work order (dependency-aware)

| # | Phase | Files | Why first/next |
|---|---|---|---|
| 1 | **A. tokens.css + fonts vendored** | tokens.css, /vendor/fonts, imports in 6 html | everything consumes it |
| 2 | **B. graph bug fix** | graph.js (+explain-lifecycle 1 call) | correctness; independent of visuals |
| 3 | C. landing rewrite | landing.html/css | fastest visible win |
| 4 | D. app shell tokens vb2 sweep | style.css, index.html, js views | the main polish pass |
| 5 | E. graph visual polish | graph.css, graph.js chrome | after 2+4 so nodes restyle on new tokens |
| 6 | F. interaction upgrades | state.js, chat.js, overlays, new cmdk.js | incremental |
| 7 | G1–G2 features | summary.js, files.js, graph.js | roadmap |

Estimated order of magnitude (per phase, focused sessions): 1≈1 session, 2≈1, 3≈1–2,
4≈2–3, 5≈1, 6≈2, 7≈2–3 each. Deploy after each phase: `node scripts/assemble.mjs
--base /` → `wrangler deploy` → visual check at cortex.mzubairhassan18.workers.dev.

**Definition of done (whole program):** a new user landing on `/` sees a calm paper
interface with a real screenshot, clicks through and finds readable 15.5px thread chat,
paper explain panels; on the graph, a free-placed conversation spawns its explain beside
itself with a clean directional edge; zero shadows, one accent role, no grain; both
themes indistinguishable in quality; 60fps pan/zoom.
