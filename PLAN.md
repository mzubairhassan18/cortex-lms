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

### 2.2 Approach

- **Custom SVG + Preact** (default). Layered tree layout is ~150 lines:
  x = depth × column, y = leaves packed in order, arrows as straight
  horizontal segments with a small elbow when y differs.
  - `graph/layout.js` — pure function: `{nodes, edges}` + sizes → coordinates
  - `graph/graph.js` — Preact view + SVG arrow layer
  - `graph/node.js` — node card; expanded state reuses the existing container
- Reasons: no build step stays, no framework migration, no new dependency,
  full control over the collapse-on-scroll rule.
- **Cost:** we don't get React Flow's pan/zoom/ports for free. If drag-to-move
  nodes and free-form edges become a requirement, that is the point where
  switching to React + React Flow is justified. **(→ question Q1)**

### 2.3 Acceptance

- [ ] Toggle switches views and survives reload
- [ ] Horizontal tree, vertical scroll, no layout thrash at 50+ nodes
- [ ] `+` → arrow → node for explanations, nested at any depth
- [ ] Conversation node expands into the *real* chat container (send works)
- [ ] Summary node reproduces the panel content
- [ ] New-chat `+` gives a working, typable empty node
- [ ] Ask-explain from selection draws the arrow and adds the node
- [ ] Off-screen explanation nodes collapse; conversation nodes stay reachable
- [ ] Settings reachable bottom-left; library still the sidebar overlay

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
1. View toggle + graph skeleton (layout + SVG arrows)
2. Conversation node → real chat container
3. Explanation `+` → arrow → node, nested
4. Summary node; new-chat `+`; Ask-explain arrow
5. Collapse-on-scroll
6. Themes (light/dark) + textured background
7. Landing page

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
| Q1 | Build the graph ourselves (Preact + SVG) or migrate to React for React Flow? | **open** |
| Q2 | Hosting path A (Express + free PaaS) vs B (Supabase serverless)? | **open** |
| Q3 | Phase order — P1 UI first, or auth/workspaces first? | **open** |
| Q4 | Auth provider: Supabase Auth vs self-rolled? | **open** |
| Q5 | Drizzle yes/no + state-lib yes/no | **recommend: both no** |
| Q6 | Migrate the existing 6 local conversations into a workspace? | **open** |
| Q7 | "encapsulate under user preferences, no sidebar route, just give a link" — what is this? | **open** |
| Q8 | Graph view: does it *replace* the list view or coexist forever? | **open (brief says toggle)** |

---

## 8. Decisions log

| Date | Decision |
| ---- | -------- |
| 2026-10-03 | Commit everything as `a1d501b converted to preact` before starting. |
| 2026-10-03 | Keep Preact for now; revisit only if graph needs React Flow. |
| 2026-10-03 | Defer hosting (P3) so P1/P2 are never blocked. |
