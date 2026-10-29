# Heptabase Research — curated findings (Oct 2026)

Source: heptabase.com (homepage + pricing live), heptabase.com/ai-tutor, Alan Chan's
"The Best Way to Use AI for Learning" (Medium, Sep 2025), live-inspected design tokens
(oh-my-design DESIGN.md archive, verified 2026-06), support/help-center pricing articles.
Purpose: Cortex is a direct competitor in the "learn a topic with AI" space. This doc
catalogues what they offer, how they look, and where Cortex lags or leads.

---

## 1. Positioning

- Slogan: **"Master anything you learn. Do your best research with AI."**
- One-line: *"an intelligent, visual knowledge base built for students, researchers, and
  lifelong learners."*
- Founder Alan Chan's thesis (from the learning article): AI should not make you consume
  *more lightweight content* faster; it should make **hard primary sources accessible**
  (a 710-page textbook in 20 spare hours). The whiteboard is a *"giant, borderless desk"* —
  its value is keeping the **entire learning context visible at a glance** (source text +
  translations + summaries + highlights + the full AI Q&A history), not diagrams.
- Their 5-step learning method, which their product embodies:
  1. **Parse** the source (PDF parser with OCR; "Parse" button; MAX mode for >30k words)
  2. **Create learning materials** with AI (translations, per-section summaries, key
     definitions with intuitive explanations + curiosity-sparking questions) laid out on
     the board
  3. **Read on the board & discuss with AI** — every question already has full card context;
     drag AI replies onto the board
  4. **Take notes in your own words** (Feynman-style rewrite beside the board)
  5. **Visualize & synthesize** — split long notes into cards, draw arrows/connections

> Cortex overlap check: Cortex's explain-tree on the graph view *is* step 3/5
> ("discussion kept beside the source, spatially"). Cortex's summary+quiz *is* a
> comprehension check (which they lack!). Cortex's gap is step 1/2: no in-app PDF reader
> with annotation, no "learning materials" generation onto the canvas.

---

## 2. Feature inventory (theirs vs Cortex)

Legend: ✅ both · 🆚 helps (they have, Cortex doesn't) · 💪 Cortex lead

| Area | Heptabase | Cortex |
|---|---|---|
| AI chat with source context | ✅ per-card chat; quote passages | ✅ per-conversation chat + attached files |
| Explanation *beside* the question | 🆚 separate chat windows/cards on the board | 💪 ✅ structured explain tree inside the conversation, recursive tabs |
| Notes from selections | 🆚 highlights + notes attached to source | ✅ selection→note with AI polish (simpler) |
| Summary of what you learned | 🆚 AI summaries you generate ad hoc | 💪 ✅ **Topics summary**: headline + bullets + open questions, cached per conversation, exportable |
| Comprehension proving (quiz) | ❌ none ("ask it to quiz me" is a manual prompt) | 💪 ✅ grounded MCQ with audit + results history + links back to the explanation that answers missed items |
| Visual canvas | ✅ infinite whiteboard (general purpose) | ✅ **topic-specific graph**: conversations → root explain nodes → child branches, cross-row edges, aligned/free layouts |
| Spatial AI thread | 🆚 drag chat cards anywhere | 💪 explain nodes auto-render where the conversation's context is |
| PDF handling | ✅ annotation + OCR parse + reference-editing | 🆚 upload + full text extraction, no reader UI |
| YouTube transcripts | ✅ | ❌ |
| Bidirectional links, block editor, journals | ✅ | ❌ (out of Cortex's focus for now) |
| Influencing thousands of notes | 🆚 integrations: Readwise, Zotero, Web Clipper | ❌ |
| Desktop apps / offline | ✅ native (Win/Mac/Linux/iOS/Android) | 🆚 web + local server (PWA-ready path exists) |
| Real-time collaboration | ✅ free collaborator invites | ❌ |
| Model freedom | 🆚 hosted: Gemini only on Pro; GPT/Claude on Premium (credit-metered) | 💪 ✅ BYOK (any OpenAI-compatible key, unmetered, stored server-side) + built-in free keyless models |
| Persistence | ✅ | ✅ sessions persist, graph layout persisted (server) |
| Search | ✅ <1s over 10k notes | ✅ server search + graph fly-to |
| Export | 🆚 (their data is in their app) | 💪 ✅ summary → PDF/DOCX/TXT |
| Onboarding friction | 🆚 7-day trial, no free tier | 💪 ✅ free tier, no card, BYOK |

**Net reading:** Heptabase is a *broad* knowledge OS; Cortex is a *focused learning loop*
(ask → understand → retain → prove). Cortex's differentiators to protect and lead with:
the explain-tree, the provable quiz, free tier + BYOK, zero credit metering.
Cortex's credibility gaps: visual/design polish, landing page feel, no source-reader
(PDF) integration with the explain feature, no AI-tutor-style guided progression.

---

## 3. Pricing structure (theirs)

No free plan. 7-day trial, then:

| Tier | Yearly | Monthly | AI credits | Notable inclusions |
|---|---|---|---|---|
| Pro | $8.99/mo | $11.99/mo | 100/mo | unlimited notes/whiteboards/images, PDF highlights & YouTube transcripts, **AI agent (Gemini only)** |
| Premium | $17.99/mo | $22 (est.) | 1,800/mo | + unlimited PDF uploads/OCR, unlimited Q&A basic models, **AI tutor**, agent (GPT/Claude/Gemini) |
| Premium+ | $53.99/mo | — | 8,100/mo | + 33% credit discount |

They fencerail AI by **credits** and put the tutor behind the mid tier. Early-bird
pricing is grandfathered for loyal users (support article). Collaboration is free in all
tiers — it's their top-of-funnel.

**Cortex pricing implication (direct competitor math):**
- Cortex's wedge: *no metered credits — your key, your price; free models built in; free
  tier.* Opposite of their $8.99 entry with 100 credits.
- If Cortex adds metered hosted-AI (the bank-transfer payment flow already exists), the
  natural ladder is: **Free (BYOK + free models) · Learner (hosted small models) ·
  Scholar (hosted frontier + tutor)** — sell *convenience*, not hours. Warning: never put
  the core learning loop (explain/summary/quiz) behind the paywall; Heptabase's free tier
  absence is Cortex's loudest landing-page line.

### 3.1 AI Tutor (their Premium flagship)

An agent that turns a goal ("I want to learn Western philosophy") into a **structured
course**: syllabus with numbered topics/subtopics, lesson pages created on the fly,
lesson progress bar (0/4 parts), in-lesson chat, adapts to pace, sources your own
materials. This is a curated-curriculum UX — Cortex could approximate it cheaply by
building a **guided review session** on top of the existing summary topics + quizzes:
sequence the open questions/missed quiz items into a daily plan inside the graph view.

---

## 4. The design system (live-inspected; this is the "premium not slop" DNA)

### 4.1 The five principles behind their look

1. **Understanding is spatial** — content is cards on a generous canvas; space and
   adjacency carry meaning, not nesting depth.
2. **Color is information, not decoration** — the chrome is near-monochrome; the two
   saturated colors carry *meaning* (blue = "this is an AI feature", green = "included").
3. **Calm over stimulation** — no shadows, no gradients, no urgency. A thinking tool
   shouldn't compete for attention.
4. **Type sets the thesis** — expressive display face states the idea; neutral text face
   serves reading. Weight 500; tight tracking. Never heavy 700 hero.
5. **Built to live with** — durable density over trend; nothing ages badly.

### 4.2 Tokens (verified values)

**Color — light ("paper")**
- Canvas `#f7f7f7` (warm off-white — never stark `#ffffff` as page bg)
- White card `#ffffff` + `1px solid rgba(0,0,0,0.14)` hairline
- Translucent card `rgba(252,252,252,0.5)` over canvas + `1px solid rgba(0,0,0,0.08)`
- Warm tile `#f0f0ea`, hairline `rgba(0,0,0,0.04)`
- Ink `#2e2e2e` (both text AND primary CTA fill — one ink, no pure black)
- Muted `#6a6972`, muted-warm `#777169`, hairline base `#e5e7eb`
- Accent blue `#207dff` — highlights AI-feature phrases only; **never buttons/borders**
- Accent green `#75c33a` — pricing checkmarks only

**Elevation: NONE.** `box-shadow: none` everywhere. Depth = translucent fills + hairlines.
(The "shadow philosophy": attention is never pulled by artificial elevation.)

**Typography**
- Display: **Instrument Sans, weight 500** — hero 48px/1.3, **letter-spacing −1.584px**;
  section 36px, −0.54px
- UI/body: **Inter 400–500** — body 16px/1.5; nav 16/400; card titles 24/600; buttons 16/500
- Two faces, two jobs; never swap. Display is *medium, not bold*; compression via
  tracking and size, not weight.

**Spacing** — 8px base; scale: 4, 8, 12, 16, 24, 32, 48, 64 (section 64).
CTAs: pill `8px 16px`, large `14px 24px` @48px height.

**Radius ladder** — 6 / 8 / 12 / pill. (Denser = smaller.)

**Motion** — 120ms (press/hover), 200ms (panel/card), 320ms (page); enter
`cubic-bezier(0.2, 0.6, 0.25, 1)`, exit `cubic-bezier(0.4, 0, 1, 1)`, standard
`cubic-bezier(0.25, 0.1, 0.25, 1)`. No bounce/springs. Reduced-motion → instant.

**Buttons**
- Primary pill: ink fill, white text, 36px, `8px 16px`, 16/500
- Large CTA: ink fill, 48px, `14px 24px`, 16/600, radius 10
- Ghost: `#fcfcfc` fill + `rgba(0,0,0,0.08)` border, 48px, 18/500
- Hover: no travel, no glow — opacity/press only

**States patterns** — skeleton = flat final-dimension blocks, quiet pulse, no shimmer;
success = brief inline text (no confetti); errors state *what to do next*.

### 4.3 Their do's & don'ts (verbatim-condensed)

Do: warm canvas; ink `#2e2e2e` for text + CTA; Instrument Sans 500 w/ tight tracking;
Inter 400–500 for everything else; shadow-free; blue only on AI phrases; green only on
checkmarks; gentle 6/8/12 radii.
Don't: pure black text; drop shadows as elevation; accents on chrome; 700-weight
headlines; Inter for display; stark white bg; loud gradients/glassmorphism.

---

## 5. Landing-page anatomy (structure → structure)

Their home: hero (headline + CTA + huge product still/video) → investor logos →
"Ask AI to explain any sources…" (+ tabbed source-type mockups: PDF/YouTube/Note/Journal)
→ whiteboard section → feature grid ("All the essentials, done right" — speed, offline,
collaboration, mobile) → "Designed with the best methods for learning" (article deep-links)
→ community gallery of real whiteboards → footer.
Their pricing: "Trusted by customers from the world's leading universities" + 3 equal
translucent cards, 25%-off yearly toggle.

**What makes it feel premium vs Cortex's current page:**
1. Large, tight-tracked medium-weight headline on a warm canvas — not glowing accents.
2. Real product screenshots almost immediately — they *show*, we *tell* (Cortex's
   landing is 100% prose cards, one emoji glyph, zero screenshots).
3. Restraint: buttons don't glow or lift; cards don't hover-jump; nothing blinks.
4. One blue = AI features, one green = included; Cortex currently uses 4+ accent roles
   (blue headings, green bullets, green check rings, pink-ish icons).
5. Basics badges (speed, offline, collab, mobile) as a quiet 4-tile grid.

### 5.1 Cortex landing grade (current `landing.html` + `landing.css`)

- Copy: strong, honest ("no invented social proof") — keep the copy spine, kill the noise.
- Visual: Catppuccin Mocha defaults translated to a landing (deep blue-grey `#1e1e2e`,
  blue `#89b4fa` everywhere); grain + dot-grid texture over the *whole page*; every card
  carries a shadow + hover translate + accent border; 750-weight hero; `🧠` emoji logotype
  (reads as hobbyist); system Segoe UI; body sizes 14.5px (too small); 4 radius values
  (16/10/999) inconsistent with the app's 7/12/14.
- Missing entirely: product screenshot, pricing (Heptabase links pricing in nav —
  Cortex has it but it's hidden off-nav from the app shell), any dark/light parity note,
  a "vs scrolling chat" visual proof.

---

## 6. In-app UI patterns worth stealing

1. **Paper cards on canvas** (graph nodes): translucent white fill + hairline, 8–12px
   radius, no shadow (or ≤ one 1-level shadow at most), radius-down for dense nodes.
2. **Edge/arrows**: thin hairline curves; accent color used only for the *active* thread;
   arrowheads minimal.
3. **Segmented pills** for sub-nav (Home / AI Tutor): 13/500, 999px, active = filled dark.
4. **Skeleton loading** at final dimensions (no spinner-first, no shimmer).
5. **Empty state = the invitation**: warm canvas + one quiet prompt line, no illustration.
6. **Text over color**: section headers colder, body larger (16px), captions muted —
   hierarchy via size/weight, never via accent color spam.
7. **Quiet success**: no toast spam; state changes are reflected on the surface.

---

## 7. Gap summary → what this research drives in the plan

1. **Typography system missing** (no webfonts, no scale, 11–13.5px UI text, Segoe UI) →
   adopt the two-voice system: display face (Instrument Sans or similar) + Inter for
   reading, with a type scale and 15–16px body minimum.
2. **Color roles abused** (accents on bullets, borders, glows, 750 weight, grain
   everywhere) → monochrome ink + two meaningful accents; texture only on the graph.
3. **Shadows/hover-lift everywhere** → flat translucent surfaces + hairlines.
4. **No screenshots/proof on landing** → capture real app frames, show the explain tree.
5. **Graph edge/z-order bug** (free mode explain chain) → algorithmic fix (see plan §B).
6. **No reading-surface integration** (their PDF annotation, Parse, MAX mode) → roadmap
   item: in-board source panel so explains anchor to source text visually.
7. **No guided progression** (their AI Tutor) → roadmap item: guided review mode over
   summary topics + missed quiz items.
8. **Pricing clarity** — Cortex's free+BYOK is the differentiator; the payment flow
   should become a proper hosted-credit tier while keeping the core loop free.
