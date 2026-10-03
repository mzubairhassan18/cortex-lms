# PLAN — Learning Bot v2 (graph UI + auth + workspaces + themes + landing)

> **READ THIS FIRST, EVERY SESSION.** This is the source of truth for the big
> change. Keep `PROGRESS.txt` in sync. When context is lost, come back here.
>
> Baseline commit: `a1d501b converted to preact` — working tree is clean.
> Everything before this commit is stable and verified.

---

## 0. What exists today (do not re-litigate)

- Express + `public/` static, **no build step**. ~20 ES modules in `public/js/`,
  entry `js/main.js`. `state.js` and `views.js` are dependency-free leaves.
- **Preact 11 + htm** vendored in `public/vendor/` (pinned in package.json).
  Views: messages, explain panel, conversation list, summary + notes, quiz,
  results, library. HTML only via `dangerouslySetInnerHTML`.
- Persistence: `data/conversations.json` (+ `.bak`, `.deleted.json` archive,
  `settings.json`, `uploads/`). **Single-user, no auth.**
- Providers: `PROVIDERS` map in `server.js`; Auto probes free keyless sources.
  `OLLAMA_ENABLED=0` strips local Ollama for hosted boxes.
- Layout: header, left conversation sidebar, centre chat, right explain panel,
  summary/library/settings overlays.

**Three view-layer rules (from the Preact migration):**
1. Views interpolate **raw** strings — Preact escapes; `escapeHtml` renders `&amp;`.
2. HTML → `dangerouslySetInnerHTML` only (markdown), so decoration survives re-render.
3. **`hidden` must be a boolean** (`hidden=${!open}`) — Preact ignores `''`.

---

## 1. Goals

| # | Goal | Phase |
| - | ---- | ----- |
| G1 | **Graph (n8n-style) node view** — a second, toggleable UI | P1 |
| G2 | **Light + dark themes** | P1 |
| G3 | **Textured background** | P1 |
| G4 | **Landing page** with marketing copy | P1 |
| G5 | **Auth** (signup/login) | P2 |
| G6 | **Workspaces** — big cards → enters the app | P2 |
| G7 | **Per-user data** — everything scoped to the signed-in user | P2 |
| G8 | **BYOK** — each user supplies their own API key | P2 |
| G9 | **Hosting** — free, public, no money out of pocket | P3 |

Everything else (chat, explain, summary, quiz, notes, library, files) is
**unchanged behaviour** — G1 only re-hosts it in a different arrangement.

---

## 2. G1 — Graph view (the big UI change)

### 2.1 Interaction spec (from the brief)

- Header gets a **view toggle**: list view ⇄ graph view. Both are always
  reachable; state persists across reloads.
- Layout is a **horizontal tree** (root at left, growing right), **vertically
  scrollable**.
- **Conversation node** = root unit. It shows a compact card; **clicking it
  expands it in place** into the existing conversation container — chat box,
  send button, attach `+` button, message list. Reuse, don't rebuild.
- A conversation with explanations shows a **`+` affordance beside the node**.
  Clicking it draws a **straight arrow** to the right and reveals an
  **explanation node**.
- Explanations nest: an explanation node holding its own explanations grows
  **another node further right** → the tree. Same `+` → arrow → node rule at
  every level.
- **Summary** appears as a node too — a **larger box** that reproduces the
  summary panel's content verbatim. Reached from an icon/`+` on the **first**
  (conversation-start) node.
- **Library**: unchanged — opens the sidebar overlay.
- **New chat**: a **large `+`** placed above the first node / below the last.
  Clicking it opens an expanded node you can type into and chat in immediately.
- **Select text → Ask explain** draws the arrow line and spawns the new
  explanation node, same as in list view.
- **Scroll behaviour**: nodes scrolled out of view **collapse to a compact
  size** so the conversation nodes below stay reachable — lazy collapse, not
  virtualisation. (Also the perf answer: don't keep big panels laid out.)
- **Settings** stays reachable from the **bottom-left**.
- Header otherwise unchanged (plus the toggle).
- Background gets a **texture**.

### 2.2 Approach — **IMPLEMENTED 2026-10-03**

Two files, no new dependency, no build step:

- **`public/js/graph.js`** — model, layout, nodes, arrows, interactions.
- **`public/graph.css`** — node cards + mode switches only.

**Why not the three-file Preact plan in the original draft:** a graph node is
an empty box that **hosts live DOM**, and Preact must not own a subtree it did
not render. So the node layer is imperative and every node element is created
once and **reused** across renders. The one thing that *is* Preact (the
conversation list) drives the rebuild through a hook instead.

```
#chat-area              ->  current conversation's node .gn-host
.ex-container[data-id]  ->  that explanation's node   .gn-host
#summary-overlay        ->  the summary node          .gn-host
```

`moved` is a LIFO journal of where each element came from, so leaving the
graph view restores the app exactly. Node elements are keyed and reused, so a
re-render is position/class writes only — **no focus loss, no scroll jump,
no re-binding while streaming**.

**Layout** is a pure function of the model (fixed node heights → no measure
pass): column 0 is a plain vertical stack (summary, `+`, conversations, `+`);
explanations are a forest anchored to the current conversation, laid out
leaves-first so each parent sits centred on its children. Arrows are
`M x1 y1 H mid V y2 H x2` with an SVG marker arrowhead.

**Integration without a cycle:** nothing imports `graph.js`. The conversation
and explain modules call `state.onGraphChange()` after they change; graph.js
sets it while mounted and clears it on exit. Overlay visibility is mirrored by
a `MutationObserver` rather than by calling into `overlays.js`.

**Consequences for other files (all required, all small):**
- `interactions.js` — the 5 delegated explain handlers are now named functions
  behind `attachExplainHandlers(host)`, registered on `#explain-panels` *and*
  on the graph node layer. One body, two hosts.
- `selection.js` — `makeSelectionHandlers(graphNodes, …)` so text selected
  inside a parked container still spawns a child explanation.
- `explain-ui.js` — `showSidebar(force)`: overlays pass `force`, explanations
  do not (they are nodes here). `updateCollapsed()` no-ops in graph mode.
- `explain-lifecycle.js` — closing/clearing removes containers **by reference**
  instead of `explainPanels.innerHTML = ''`, which would leak parked ones.

- **Cost:** no React Flow pan/zoom/ports. If drag-to-move nodes and free-form
  edges become a requirement, that is the point where React + React Flow is
  justified. **(Q1 — answered: build it ourselves)**

### 2.3 Acceptance — **ALL VERIFIED in-browser 2026-10-03**

- [x] Toggle switches views and survives reload
- [x] Horizontal tree, vertical scroll, arrows as straight/elbow segments
- [x] `+` → arrow → node for explanations, nested at any depth (2 levels tested)
- [x] Conversation node expands into the *real* chat container (send works)
- [x] Summary node reproduces the panel content (↻/ ✕ work, returns to mount)
- [x] New-chat `+` gives a working, typable empty node
- [x] Ask-explain from selection draws the arrow and adds the node
- [x] Off-screen explanation nodes collapse on scroll (140px slack; never
      re-opens on its own, so it cannot fight the user)
- [x] Settings reachable bottom-left; library still the sidebar overlay
- [x] Round-trip list → graph → list restores containers in creation order
      with zero lost elements and zero console warnings
- [x] **Zoom** — `+`/`−`/`0` keys, rail buttons, Ctrl/Cmd+wheel anchored at the
      cursor; 30–250%, persisted to `lb.zoom`. Scroll extent always equals the
      painted size (verified: 1336px canvas × 1.373 = 1833.86px wrapper,
      scrollWidth 1906 = that + 72px padding)
- [x] **Pan** — left-drag on the empty board, middle-drag anywhere,
      Space+drag anywhere; a drag never clicks the node it ends over
- [x] Collapse-on-scroll measures in *unscaled* coordinates so the 140px slack
      stays 140 screen pixels at any zoom

### 2.4 Zoom, pan, themes and texture — **IMPLEMENTED 2026-10-03**

**Zoom** wraps the canvas instead of scaling it in place:

```
#graph-scroll  >  #graph-zoomer   (box = unscaled size × zoom → real scrollbars)
                     > #graph-canvas  (real size, transform: scale(zoom))
```

Because the wrapper carries the *layout* box and the canvas only carries the
*paint*, every `inset: 0` child (the SVG edge layer, the node layer) stays in
unscaled coordinates — so nothing else in the module has to know about zoom.
Anchoring is done by converting the scroll offset to content coordinates
before the scale changes and back afterwards. Range 0.3–2.5, persisted to
`lb.zoom`.

**Pan** writes `scrollLeft`/`scrollTop` rather than a transform offset, so it
composes with native wheel/trackpad scrolling for free. Started only from the
empty board (left button), the middle button, or Space+drag; a completed drag
swallows the click it would otherwise fire.

**Themes** are one token block in `style.css`: `:root` *is* the dark theme and
`[data-theme='light']` overrides it. Rule: **no literal colour may appear
outside those two blocks** — including every `rgba(...)` alpha variant, so
re-theming can never shift how an existing screen looks. An inline script in
`<html data-theme>` runs before the stylesheet paints (no flash), and
`js/theme.js` owns the switch: a manual choice persists to `lb.theme`,
otherwise the OS preference is followed live.

**Texture** — a 5%/7% SVG turbulence grain on the *backdrop* surfaces only
(body, top bar, chat area, graph view); panels stay clean so they read as
cards on a desk. The graph view adds a dotted grid over it (the n8n board).

**Bug fixed on the way:** `#view-toggle` (added with P1.1) had no rules at all
and rendered as a default OS button in both themes — it now shares the header
pill group.

---

## 3. G5–G8 — Auth, workspaces, per-user data, BYOK

### 3.1 Target flow

```
landing page → Sign up / Log in → workspace picker (big cards)
   → click card → app (list view or graph view) → all data scoped to me
```

- Multiple workspaces per user; a workspace owns conversations/notes/files.
- Every read/write is filtered by `user_id` (+ `workspace_id`).
- **BYOK**: each user stores their own provider + API key in their profile.
  No shared server key, no cost to the operator.

### 3.2 The BYOK constraint that drives architecture

Browsers cannot call OpenAI/Anthropic/etc. directly — **they don't send CORS
headers**. So an API key in the browser still needs a **proxy**. The proxy is
what forces a server, which is what forces the hosting decision (G9).

Options for that proxy:
- **A — keep `server.js`**, host it on a free PaaS that runs a long-lived
  Node process (best for long SSE streams).
- **B — serverless**: Supabase Edge Functions as the proxy + static frontend.

### 3.3 Data

- **Drizzle ORM: not required.** It is a type-safety/convenience layer over
  SQL; with a plain-JS, no-build codebase its main benefit disappears. Use
  `@supabase/supabase-js` (or raw SQL) first; add Drizzle only if we adopt
  TypeScript. **(→ confirmed with user?)**
- **State management: none needed.** `state.js` + explicit Preact renders is
  enough at this size. If it grows, `@preact/signals` (Preact's own, tiny).
- Existing local `data/conversations.json` → needs a **migration decision**.
  **(→ question Q6)**

---

## 4. G9 — Hosting (free, no money)

| Path | Stack | Free? | Fits streams? | Rewrite cost |
| ---- | ----- | ----- | ------------ | ------------ |
| **A** | Express on Render / Koyeb free tier + Supabase (auth+DB) | yes (with sleep/cold start) | **yes** | small — add auth + SQL |
| **B** | Static on Vercel + Supabase (auth, Postgres, Edge Function proxy) | yes | weaker (function time limits) | large — `server.js` → Edge Functions |

**Recommendation: A now, B later if needed.** Path A keeps the working server,
and the streaming watchdogs we already built are the reason. Path B is the
"correct" serverless end-state but costs a rewrite of the provider layer.

**Hosting is deferred to P3 so P1/P2 are not blocked by it.** Local development
is unaffected either way.

---

## 5. G4 — Landing page

Research done (see PROGRESS entry). Applied principles:

- **Fletch value-prop 6-tuple**: Persona · Alternative · Problem · Capability ·
  Feature · Benefit — write the hero from it.
- **Hero states in <10 s**: who it's for, what it does, the key benefit.
- **PAS** (Problem → Agitation → Solution) as the section spine.
- **Second person**, short sentences, one idea per line — scannable.
- **Benefits paired with concrete features** (never benefits alone).
- **Social proof** — but we have no users yet, so use *product-truth* proof
  (real capabilities, screenshots, "no credit card", "free forever") instead
  of fabricated testimonials. **Do not invent user counts or quotes.**
- Audience angle: research/learning students — *notes, no scrolling, no
  context lost, bring your own key, free*.

Route: `/` (public landing) → `/login` → `/workspaces` → `/app`.

---

## 6. Phases

**P1 — UI (no infra risk, no data migration, fully local)**
1. [x] View toggle + graph skeleton (layout + SVG arrows)
2. [x] Conversation node → real chat container
3. [x] Explanation `+` → arrow → node, nested
4. [x] Summary node; new-chat `+`; Ask-explain arrow
5. [x] Collapse-on-scroll
6. [x] Themes (light/dark) + textured background
7. [x] Graph canvas controls: zoom in/out + drag-to-pan *(added at user request)*
8. [ ] Landing page

**P2 — Identity**
8. Auth (signup/login)
9. Workspaces (cards → app)
10. User/workspace scoping on every route
11. BYOK (per-user provider + key, stored server-side)
12. Migrate existing local data *(pending Q6)*

**P3 — Ship**
13. Host it free *(pending Q4/Q5)*
14. Domain/URL, final smoke test

---

## 7. Open questions (BLOCKING)

| ID | Question | Status |
| -- | -------- | ------ |
| Q1 | Build the graph ourselves (Preact + SVG) or migrate to React for React Flow? | **resolved 2026-10-03 — build it ourselves** (see §2.2; shipped, no drag/ports needed yet) |
| Q2 | Hosting path A (Express + free PaaS) vs B (Supabase serverless)? | **open** (P3; recommendation A in §4) |
| Q3 | Phase order — P1 UI first, or auth/workspaces first? | **resolved 2026-10-03 — P1 first** (user: local full working demo, then Supabase creds) |
| Q4 | Auth provider: Supabase Auth vs self-rolled? | **open** (P2) |
| Q5 | Drizzle yes/no + state-lib yes/no | **resolved: both no** |
| Q6 | Migrate the existing 6 local conversations into a workspace? | **open** (P2) |
| Q7 | "encapsulate under user preferences, no sidebar route, just give a link" — what is this? | **open** |
| Q8 | Graph view: does it *replace* the list view or coexist forever? | **resolved 2026-10-03 — coexist behind the header toggle** (brief: "list view ⇄ graph view") |

---

## 8. Decisions log

| Date | Decision |
| ---- | -------- |
| 2026-10-03 | Commit everything as `a1d501b converted to preact` before starting. |
| 2026-10-03 | Keep Preact for now; revisit only if graph needs React Flow. |
| 2026-10-03 | Defer hosting (P3) so P1/P2 are never blocked. |
| 2026-10-03 | **Graph = two files (`js/graph.js` + `graph.css`), imperative node layer.** Preact must not own DOM it did not render, so nodes are empty boxes and live elements are *moved* into them, journaled in a LIFO `moved` list for exact restore. Details in §2.2. |
| 2026-10-03 | **No import cycle:** nothing imports `graph.js`. Other modules call `state.onGraphChange()`; overlays are mirrored by a `MutationObserver`. |
| 2026-10-03 | **Node elements are created once and reused**, so a graph re-render only writes positions/classes — no focus/scroll loss, safe during streaming. |
| 2026-10-03 | Layout is a **pure function** (fixed node heights ⇒ no measure pass). |
| 2026-10-03 | `interactions.js` delegated handlers extracted behind `attachExplainHandlers(host)` — one body, two hosts (`#explain-panels` and the node layer). |
| 2026-10-03 | `showSidebar(force)`: Library/Settings force it open in graph mode; explanation creation does not (explanations are nodes). |
| 2026-10-03 | Scroll-collapse **never re-opens on its own** (140px slack) so it cannot fight the user. |
| 2026-10-03 | **Zoom via a wrapper element** (`#graph-zoomer` sized `base × zoom`) + `transform: scale()` on the canvas, so scrollbars match the paint and no child coordinate system changes. |
| 2026-10-03 | **Pan by writing scroll offsets**, not a transform — composes with native scrolling. Left-drag only from the empty board, plus middle-drag and Space+drag. |
| 2026-10-03 | **All colour lives in one token block**; `:root` is dark, `[data-theme='light']` overrides. Zero raw colour declarations outside it (verified by scanning the CSSOM). |
| 2026-10-03 | Theme default = OS preference, manual choice wins and persists (`lb.theme`); applied inline in `<head>` to avoid a flash. |
| 2026-10-03 | Texture only on *backdrop* surfaces — panels stay flat so they read as cards on a desk. Graph canvas additionally gets a dot grid. |
| 2026-10-03 | `schedule()` arms a 120 ms timer beside rAF: a hidden tab never runs rAF, which would otherwise freeze graph state (and collapse-on-scroll) until the window is shown. |
