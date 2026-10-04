# PLAN — Cortex v2 (graph UI + auth + workspaces + themes + landing)

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

### 2.5 Workspaces, conversation bands, one icon system — **IMPLEMENTED 2026-10-03**

Three requests from the same review, shipped together because they all touch
the graph shell.

**a) Workspaces (the local half of P2 item 10, before auth exists)**

- `data/workspaces.json` — `{id, name, createdAt, updatedAt}` next to the
  conversations, same no-dependency JSON rule.
- Boot migration (`migrateWorkspaces()`): there is always at least one
  workspace, and every conversation carries a `workspaceId`. Data written
  before workspaces existed is adopted by the first workspace, so an upgrade
  can never orphan or lose anything. Verified: **1 workspace, 7 conversations
  adopted**.
- Routes: `GET/POST/PUT/DELETE /api/workspaces`. `DELETE` is a **409** while
  the workspace still holds conversations unless `?force=1` — and even then the
  conversations are appended to `conversations.deleted.json`, never vanished.
- `GET /api/conversations?workspace=<id>` and `GET /api/files?workspace=<id>`
  scope the lists; `POST`/`PUT /api/conversations` accept `workspaceId`.
- Client: `state.workspaces` + `state.workspaceId` (persisted to
  `lb.workspace`), reconciled against the server before the first list load, so
  a remembered-but-deleted workspace can never leave you with an empty app.
- **The zoomed-out canvas** — `public/js/workspaces.js` renders `#ws-layer`
  (a sheet floating over the board: `--texture` scrim at 93% so the dot grid
  still reads through). Past `ZOOM_WS = 0.5` the conversation nodes hand over
  to the workspace cards; clicking one switches and dives back to 100%.
  Create / rename / delete live on the cards themselves.

*Dependency direction:* `workspaces.js` imports `conversations.js` but never
`graph.js`. The graph publishes `state.zoomTo` / `state.zoomLevel` /
`state.onZoomChange` instead — the same rule that already governs
`state.onGraphChange`, so there is no module cycle.

**b) Conversations respect the space their explanations occupy**

Column 0 stacked conversations while the explain forest grew in the columns to
the right, so expanding an explanation ran down the page straight through every
conversation listed after it. `layout()` now records how far the forest
actually reached and shifts everything below the current conversation so the
next one starts **where the current one plus its explanations end**.
Verified: forest `top 564 → bottom 2137`, next conversation at `2163`
(= `2137 + GAP_Y`), zero overlaps.

**c) One icon system**

Buttons mixed `☰ 🗺 🌙 💡 📋 📚 🤖 ⚙ ✕ ⌃ ⌄ ↻ ＋` from half a dozen fonts.
There is now a single sprite (`#ico-sprite`, 26 symbols, 24×24, `currentColor`
stroke) and one `.ico` rule sized `1em`, so every control shares one weight and
tracks the font-size of whatever it sits in. Converted: header, rail, overlay
heads, node headers, the collapse/expand chevron, explain tabs, input row,
workspace cards, notes card and the copy buttons. Content emoji (👋 🏆 📎 ⚠️)
are deliberately left alone — they are messages, not controls.

The theme switch now shows a **sun on dark / moon on light** instead of always
a moon, and the chat avatar matches the header's node-graph mark.

### 2.6 Navigation, centering and the empty workspace — **IMPLEMENTED 2026-10-04**

Four review requests: getting to a workspace from anywhere, making the explain
tree use the space above it, and what the graph does when a workspace is empty.

**a) List view can reach workspaces**

The zoomed-out canvas only exists in graph view, so from the list there was no
way in at all — you had to switch views, zoom out, then come back. A switcher
chip now sits at the top of `#left-sidebar`, above the conversation list:
current workspace name + chevron. Clicking it opens a dropdown of every
workspace with its conversation count, the current one marked, plus **New
workspace** — which swaps itself for the same inline name input the cards use.
One `switchWorkspace()` / `createWorkspace()`, no second code path.

**b) Explanations use the space ABOVE them**

`layout()` used to stack children downwards and only then pull the parent down
to the midpoint, so a whole branch hung below its parent no matter what. The
rule is now **a parent is centred on its children, at every level**: the middle
of three siblings lands level with its parent, the first sits above it, the last
below. Two things make that safe:

- `extent(id)` answers *"how far above and below its own top edge does this
  branch reach?"* from the tree and the fixed `DIM` sizes alone — memoised per
  layout, asked **before** anything is placed. A sibling reserves the upward
  half of the next branch before it is placed, so a centred branch can never
  walk through the one above it. Without that reservation centring is simply
  not possible; the old downward stack was the symptom, not the design.
- the forest is then centred on the current conversation, and if that takes
  anything above `y = 0` the **whole board slides down** instead of clipping —
  everything is positioned relative to everything else, so it is a pure
  translation.

Verified: conversation centre **394**, forest centre **394**, `minY = 0`,
band-reserve exact (next conversation `810` = forest bottom `784` + 26). The
nesting rule holds too: a 500px explain centred on its 104px child sitting at
`202..306` inside `4..504`.

**c) An empty workspace is one button**

`#chat-area` has nowhere to move when there are no conversations, so it stayed
a flex child of `#main-row` and ate half the screen — which is exactly why
zooming out crammed the workspace cards into the right-hand half of the window.
`body.graph-mode #main-row > #chat-area` now hides it whenever it is still
unhosted, so the canvas takes the window. The `+` nodes are suppressed too:
with no conversation there is nothing to add around, and two of them at the
top-left of a blank board read as duplicates.

The state gets its own control. `#graph-empty` moved **out** of
`#graph-canvas` — inside it the zoom scaled it down to 30% — and now renders
one large plus button and a line of guidance, centred over the board. It stands
in for the composer, which is deliberately absent: there is nothing to attach to
and nothing to send to. Clicking it runs `createConversation()` through the same
handler as the `+` node, so both paths create, select and repaint identically.

Verified end to end: empty workspace → full-width canvas, one button, no
composer; click → conversation created, node appears, `chat-area` moves into
`.gn-host`, empty state hides.

**d) Zooming out takes the window over**

Past `ZOOM_WS` a `ws-zoomed` class lands on `<body>` and hides the top toolbar,
both sidebars, the splitter and any unhosted chat area, so the workspace cards
own the screen. The zoom rail stays (`z-index: 40`) because it is the way back
in. Removed on the way down, so nothing is left hidden once you dive back.

**e) No sidebar toggle in graph view**

`body.graph-mode #left-toggle` joins `#left-sidebar` in `display: none`. That
button only ever opened the list-view conversation list — precisely the layout
graph view replaced.

### 2.7 Summary placement, explain minimise, standalone workspaces — **IMPLEMENTED 2026-10-04**

Three review requests: where the summary sits on the board, folding a single
explanation while you read the rest, and a full-screen workspace page.

**a) The summary hangs off the LEFT of the conversation**

It used to occupy the top of column 0, which pushed every conversation half a
screen down and had nothing to do with what it summarises — a panel above the
board that read as "one more node in the stack". It now sits **to the left of
the current conversation, vertically centred on it, with an arrow pointing
right into it**. The container itself is unchanged.

Consequences that fall out of that one move:

- column 0 slides right by `DIM.summary.w + GAP_X` (776px), so opening the
  summary moves the board **sideways**, not down. Conversations still start at
  `y = 0`.
- because the summary is centred on the conversation, a short conversation plus
  a 560px panel can start above `y = 0`. The **lift** that used to run only for
  over-tall explain branches is now `liftBoard()`, applied unconditionally at
  the end of `layout()` — a pure translation of every node, never a clip.
- `box()` computes `W`/`H` from the whole `pos` map rather than the column
  accumulator, so a summary that overhangs the bottom of column 0 still fits.
- `drawEdges()` gains one path: summary right edge → conversation left edge,
  same elbow as every other arrow (`M 680 394 H 725 V 394 H 770`).

Verified: summary `(0, 114, 680×560)`, conversations at `x = 776`,
**summary centre 394 === conversation centre 394**, `minY = 0`, **0 node
overlaps**, closing restores `x = 0` and drops the arrow.

**b) Minimising an explanation from where you are reading it**

The node's own chevron is `display: none` while a node is expanded — which is
exactly when its container header is on screen — so an expanded explanation had
no visible way to fold except clicking bare header space (no affordance) or
switching conversations. `.ex-head` now carries an **`.ex-collapse` button**
immediately left of the ✕.

- graph view: `onGraphClick` handles it and calls `stopImmediatePropagation()`,
  which suppresses both the bare-header fold below it and the `activateExplain`
  from `attachExplainHandlers()` on the same element. That second one matters:
  a changed `activeId` un-collapses the node on the next render, so the fold
  would be undone immediately.
- list view: `onExplainClick` handles it instead, toggling `.ex-min`, which
  folds the container to just its header (`flex: none`, split and tab strip
  hidden). Those rules are scoped to `#explain-panels`, where containers live
  in list view only — on the board they sit under `#graph-nodes`, so the two
  paths never touch the same element.
- `applyExplain()` keeps the glyph and title in step with the node's state.

Verified graph: `460×500` + `gn-head: none` → button 34×23 visible →
`344×104` + `gn-head: flex` → **stays collapsed** → node chevron re-opens it to
`460×500` → **stays expanded**, with `activeId` unchanged throughout. Verified
list: `781px` → `.ex-min`, `h = 30`, split/ctabs `none`, back to `781px`.

**c) A standalone page for workspaces**

`/workspaces` is a full-screen picker with **no top bar and no sidebar** —
search, a grid/list toggle, the workspace names, create and delete. It is the
same document as `/app` (`main.js` branches on `location.pathname` and boots
`workspace-page.js` instead of the app), so the icon sprite, theme tokens and
theme switch are shared rather than duplicated. Reaching it: the landing page's
three CTAs now point here instead of straight at `/app`, and the sidebar's
workspace dropdown gains an **All workspaces** row (an `<a>`, so it can be
opened in a new tab). `/app` still opens directly with the remembered
workspace — the existing UI is untouched.

### 2.8 Export from the summary container — **IMPLEMENTED 2026-10-04**

One more request on the summary: *"give there a button to export … export in
PDF or export in Word … or export in TXT."* The header of `#summary-overlay`
(now `title ↻ ⬇ ✕`) gains an **Export** button that opens a three-item menu —
PDF document `.pdf`, Word document `.docx`, Plain text `.txt`.

**One block list, three writers.** `renderBlocks(doc)` turns the current
conversation's summary (title, headline, key findings, topics, questions you
asked, your own notes with their source quote, tests taken) into a flat list of
`{k, t}` blocks — `title | sub | lead | h2 | bullet | src | text | gap | rule`.
Every target renders *that* list, so the three files can never disagree:

| | file |
| - | ---- |
| `public/js/export-format.js` | the writers. **No imports at all**, deliberately: it takes plain objects and returns bytes, so it runs under `node --experimental-default-type=module` and can never pull the DOM layer into an import cycle. |
| `public/js/export.js` | collects the live document (`summaryCache` + `testsCache` + `state.notes`), names the file, owns the menu. |

- **TXT** — UTF-8, markdown stripped.
- **PDF** — a hand-written PDF 1.4: Catalog/Pages, two base-14 Helvetica
  fonts, one content stream per page, hand-computed xref. No library, no build
  step, no network. Line wrapping measures against a canvas in the browser
  (an estimate outside one). Because a base-14 font only draws WinAnsi, every
  string goes through `toLatin1()` — which **transliterates rather than drops**
  what a physics session actually contains: Greek letters to their names,
  `√ → sqrt`, `≈ → ~=`, `≤ >= ≠`, arrows, `Ω → ohm`, super/subscript digits.
- **DOCX** — a real Office Open XML package: `[Content_Types].xml`,
  `_rels/.rels`, `word/document.xml`, zipped with **STORED** entries (no
  deflate) and a locally computed CRC32.

**The menu travels with the container.** It lives inside `#summary-overlay`,
which the graph view moves wholesale into the summary node, so nothing here
knows which layout is showing; `.gn-host`'s early return in `onGraphClick`
already puts header clicks out of reach of the node handlers.

**Verified**

- *Container-level harness* (1-page and forced 8-page documents): header/EOF,
  `startxref` lands on `xref`, every xref offset opens the right `N 0 obj`,
  object numbering contiguous, every stream's `/Length` lands exactly on
  `endstream`, every `/Contents n 0 R` resolves to a stream object, no text
  painted outside `MediaBox`, CRC32 recomputed per zip entry, `.docx` entry
  names exact, `toLatin1` never leaks a byte above `0xFF`.
- *Real readers* on the harness output *and* on the files the browser actually
  downloaded: **pdf-parse (pdf.js)** opens both PDFs (1 and 8 pages, full text),
  **mammoth** opens both `.docx` with **0 messages**.
- *In browser*: all three download with the right name
  (`what-is-machine-learning-summary.pdf|docx|txt`) and MIME; menu opens on the
  button, closes on selection / outside click / Escape / second press, `aria-expanded`
  tracks it; works in list view **and** inside the graph summary node (menu
  `186×109`, no ancestor clips it); dark ↔ light round trip repaints the menu
  from tokens; **0 console errors**.

---

### 2.9 Infinite canvas — **IMPLEMENTED 2026-10-04**

> User report: *"if I open the explain containers — two containers, for
> example — it is going upward and I can't even with a hand tool make it in
> center … it is basically upward in the header hiding and I cannot even pull
> it down or resize the whole window … it should be a canvas type of thing,
> like a Figma kind of thing"* and *"make it just like figma canvas, where
> there is space anywhere."*

Two separate faults, one of which hid the other.

**1. `liftBoard()` had never worked.** The guard read `if (lift <= 0) return 0`
while `lift` is `min(0, smallest y)` — so it is *always* ≤ 0, and the function
returned before it ever shifted anything. It has been a no-op since the day it
was written (`d37659e`). Layout therefore happily placed opened explanations at
**negative y** (`top: -270px`, `-129.6px` measured on a live 13-node board).
A scroll box has a top, so `scrollTop` can never reach them: the container sat
under the header, unscrollable and unresizable — exactly the reported symptom.
The guard is now `if (lift >= 0) return 0`, which shifts the board down by
`|lift|` whenever something overhangs.

**2. The viewport was a scroll box, which by construction has edges.** Fixed
`lift` still leaves you one drag away from hitting the top. So the scroll model
is gone:

| | before | after |
| - | ------ | ----- |
| `#graph-scroll` | `overflow: auto; padding: 28px 36px 40px` | `overflow: clip` |
| `#graph-zoomer` | box = `base × zoom`, matched the scrollbars | **removed** |
| `#graph-canvas` | `transform: scale(zoom)`, scrolled by its parent | `transform: translate(camX, camY) scale(zoom)` |

The board is drawn at `world × zoom + (camX, camY)`. Because the camera is a
**transform** and not a scroll offset, there is nothing to scroll and no content
box to reach the edge of — space exists in every direction, which is the Figma
behaviour asked for. `overflow: clip` rather than `hidden` on purpose: `hidden`
still makes an element a *scroll container*, and a transformed canvas shows up
as scrollable overflow there, so a touch or an auto-scroll could move the
content on top of the camera. `clip` means there is nothing to scroll at all.

- **First framing.** A board nobody has touched is centred, and never closer
  than `CAM_PAD = 56px` to the top/left: fits → centred with space on all four
  sides; does not fit → one pad below the header and the rest is one drag away.
  `camTouched` latches on the first user pan/zoom so a later render never
  re-centres a board the user has deliberately moved.
- **Wheel = Figma's rules.** Plain wheel pans `deltaX/deltaY`; Ctrl/Cmd+wheel
  zooms under the pointer (a trackpad pinch arrives as ctrl+wheel, so it takes
  the same path). A wheel over an element that scrolls *itself* — the message
  list, a panel — is left alone rather than having its scroll stolen.
- **Zoom is anchored**, not scaled about the origin: the world point under the
  pointer is held in place by moving the camera to compensate.
- **Panning kept its own sign.** A scroll offset and a camera offset push the
  content in *opposite* directions, so the old `sl - (c - x)` becomes
  `camX + (c - x)`. Written the other way round, dragging down pulls the board
  away from you — caught by test, documented next to the formula.
- **`foldOutOfView()` hangs off the camera now**, not a `scroll` event (there
  isn't one). It inverts the camera (`top = -camY / zoom`) so the slack stays
  140 *screen* pixels, and it runs after every camera write, which still
  converges: a folded explain loses `.expanded`, so the next pass has nothing
  to collapse.

**The library: `@use-gesture/vanilla` 10.3.1** (MIT, poimandres/pmndrs — the
zustand/react-spring team; 4.3 KB + 11 KB core, one transitive dep, ESM only).
It supplies **wheel and pinch only**; this module still owns the camera and the
drag-to-pan rules, because those are app policy, not device decoding.

- Vendored into `public/vendor/use-gesture/` (7 `.esm.js` files, 62 KB) and
  resolved by an **import map** in `index.html` — so the no-build-step rule
  holds. All five bare specifiers verified to resolve to real files; the
  package's own imports are relative, which is why the tree copies cleanly.
  It was originally served straight from `node_modules` by a
  `GET /lib/use-gesture` route in `server.js`; that route was removed
  2026-10-05 (commit `5c77310`) when the site became publishable as a plain
  folder of static files — a static host has no route table, and two sources
  of truth for one import map is one too many.
- Its ESM is unbundled, so the bundler guards are still in there — every dev
  warning reads `process.env.NODE_ENV`. A bundler would have inlined
  `'production'`; instead `<head>` defines that object before the module graph
  is fetched (checked: nothing else on any page reads `process`).
- **`pinchOnWheel: false` is mandatory.** It defaults to `true`, which puts the
  pinch recogniser on the wheel as well — one Ctrl+wheel notch then zoomed
  *twice*, 100 % → 232 % instead of 116 %. Wheel is ours; pinch is touch.
- **Why not a canvas renderer?** Konva / Fabric / PixiJS / litegraph all draw
  pixels, and graph nodes host **live DOM** — the real chat area and the explain
  panels are *moved* into them. react-flow/tldraw/Rete are React- or
  rewrite-shaped. `anvaka/panzoom` owns the transform (fights the camera) and
  `d3-zoom` drags five d3 packages behind it. `@use-gesture` is the one piece
  that is genuinely hard to hand-roll (trackpad + multi-touch recognition) and
  nothing else.

**Verified in-browser (0 console errors on `/`, `/app`, `/workspaces`)**

- Two explain containers open → `expanded: 2`, **nothing above the viewport
  top**, `minTop: 0`, camera `translate(56px, 56px) scale(1)` — the reported
  bug, gone.
- Drag down 300 px → camera `+300`, board follows the hand, `.panning`
  cleared, `scrollTop/scrollLeft` stay `0`.
- Plain wheel `(-25, 120)` → camera `(25, -120)`, exact. One Ctrl+wheel notch →
  `100 % → 116 %` = `1.0015^100`, exact. Zoom-out ladder → `30 %` still hands
  the window to `#ws-layer`; rail label click returns to `100 %`.
- Wheel over a real inner scroller (`1138×541` message list): default **not**
  prevented, board unchanged. Wheel on the bare board: prevented, board moves.
- Mouse drag, **touch drag**, Space+drag and middle-drag all pan; node and
  conversation clicks still fire (pointerdown is only cancelled for non-mouse).

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

### 3.3 Data — **SCHEMA SHIPPED 2026-10-05 (P2.1)**

Migrations live in `supabase/migrations/`, applied via the Supabase MCP.

| Table | Holds | RLS |
| ----- | ----- | --- |
| `profiles` | email, name, avatar, `role`, `plan` — auto-row on signup | enabled, **not forced** (see below) |
| `workspaces` | `id text`, `user_id`, `name` | forced |
| `conversations` | header columns + `messages`/`explains`/`summary`/`quiz`/`tests`/`notes` as **JSONB** + `archived` | forced |
| `files` | extracted `text`, metadata, optional `storage_path` | forced |
| `payment_claims` | bank-transfer receipts awaiting admin approval | forced |
| `usage_daily` | **rollup** `(user_id, day, requests, by_kind)` — the meter | forced |
| `platform_settings` | `plans`, `bank_details`, `payment_notice`, `supabase_limits` | forced |

- **Drizzle ORM: not required.** It is a type-safety/convenience layer over
  SQL; with a plain-JS, no-build codebase its main benefit disappears. Use
  `@supabase/supabase-js` (or raw SQL) first; add Drizzle only if we adopt
  TypeScript. **(resolved: no)**
- **State management: none needed.** `state.js` + explicit Preact renders is
  enough at this size. If it grows, `@preact/signals` (Preact's own, tiny). **(no)**
- **Blobs stay JSONB on `conversations`** rather than being normalised into
  child tables: the app always loads a conversation whole, so normalisation
  would buy no query power and cost a join on every read. No GIN index either
  — the payloads are never filtered on, only read whole.
- **IDs stay `text`** (the app's 12-char ids) so the local → remote migration
  needs no remapping.
- **`usage_daily` is a rollup, not an event log** — one row per user per day.
  An event table would be ~100× bigger for the same answers, and the 500 MB
  database is our tightest resource.
- **Storage plan (decided 2026-10-04):** extracted text in Postgres (API reads
  are unmetered; Storage egress is 5 GB), originals in the private `library`
  bucket at `<uid>/<conv_id>/<file_id>`. **Free plan stores text only**
  (`storage_path` stays null) — a 5 MB PDF becomes ~100 KB of text, which is
  ~50× less storage and lifts the free-tier ceiling from ~20 users to hundreds.
  Text extraction moves to the **browser** (`mammoth` + `pdf.js` browser
  builds, served via the existing import map) so the Edge Function stays a
  thin LLM proxy and never touches multi-MB uploads.
- Existing local `data/conversations.json` → **still pending (Q6)**, needs a
  signed-in account first because every row has an FK to `auth.users`.

**The one RLS exception:** `profiles` is *enabled* but **not forced**. Forcing
would make the table owner subject to RLS, which breaks (a) the signup
bootstrap trigger — `auth.uid()` is not reliably set while GoTrue is inserting
`auth.users` — and (b) `is_admin()`, which is SECURITY DEFINER and therefore
runs as the owner. `anon` and `authenticated` remain fully restricted; only the
owner is exempt, and the owner can already `alter table` anything.

---

## 4. G9 — Hosting — **DECIDED 2026-10-04: GitHub Pages + Supabase Edge Function**

User chose option A below (2026-10-04), tiers and storage as proposed.

| Option | Cost | Code changes | Streaming proxy | Verdict |
| ------ | ---- | ------------ | --------------- | ------- |
| **A — GitHub Pages (static) + Supabase Edge Function (proxy)** | **$0** | port `server.js`'s proxy to 1 Edge Function; base-path + clean-route fixes | ✅ native | **CHOSEN** — the only $0 option with no VPS and no cold-start problem |
| B — VPS (Oracle *Always Free* ARM, or ~$5/mo) | $0–$5 | **none** — `server.js` runs as-is | ✅ perfect | escape hatch if Edge Functions ever get in the way |
| C — Vercel | $0 tier, **non-commercial only** | entrypoint + move all `data/` to Supabase | ⚠️ function duration vs our 120 s first-byte / 45 s idle gaps | rejected — we intend to charge users |
| D — Render / Railway / Fly | ~$7+/mo or 30–60 s cold starts | low | ⚠️ | rejected |
| E — Cloudflare Pages + Workers | $0 | port proxy to a Worker | ✅ | deferred with R2 (user: "skip it, for now") |

**GitHub Pages alone is not enough** — the app is not static. Three blockers:

1. **The BYOK proxy must run somewhere.** Browsers cannot call OpenAI/Anthropic
   directly (no CORS headers), so `server.js`'s streaming proxy has to move
   into a **Supabase Edge Function** (Deno). This is §3.2's constraint B.
   *Still open — P2.11.*
2. ~~**Sub-path URLs.**~~ **Resolved 2026-10-05 (commit `5c77310`).** Asset URLs
   are `./`-relative in the HTML, and `js/base.js` derives the deploy base from
   its own module URL — unlike `location.pathname`, a module URL has an
   unambiguous directory — with `route()` / `at()` as the only way the app reads
   or builds a path. `scripts/assemble.mjs` then stamps the configured base into
   `out/`, because a *relative* URL is still ambiguous for a document served
   without a trailing slash: `/cortex-lms/app`'s directory is `/cortex-lms/`, so
   `../js/main.js` resolves to `/js/main.js`.
3. ~~**Clean routes.**~~ **Resolved 2026-10-05.** The same script writes
   `app/`, `workspaces/`, `login/`, `signup/`, `pricing/` folders and a
   `.nojekyll`.

**The publish flow is `node scripts/assemble.mjs` → deploy `out/`** (gitignored).
It is deliberately *not* a build step: nothing is transpiled or bundled, and
`node server.js` never runs it. `--serve` replays `out/` at `/cortex-lms/` on
:4173 and **404s outside the base exactly as Pages would** — an earlier version
of that preview was more permissive than production and hid a real bug.

**Trap that must be handled on deploy:** Supabase Free projects **pause after
1 week of inactivity** — DB, Auth *and* Storage all sleep. A GitHub Actions
cron pinging the project every 5 days is therefore not optional.

**Hosting's remaining work is blocker 1 (the Edge Function), the Actions
heartbeat above, and an Actions workflow that runs the assemble step.** Local
development is unaffected either way.

---

## 5. G4 — Landing page — **IMPLEMENTED 2026-10-03**

Shipped as `public/landing.html` + `public/landing.css`, served at `/`.

**Naming (decided with the user, 2026-10-03): the product is *Cortex*** —
the brain's outer layer where memory and learning live. Short, and it names
the "one brain that keeps growing" idea directly. Applied everywhere: landing,
app header (`🧠 Cortex`), tab titles, assistant avatar, server log, README,
`package.json`, and the favicon (redrawn as a two-hemisphere brain glyph).

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

### 5.1 Routing — **split done now, auth gate comes in P2**

`server.js` serves static files with `index: false` so `/` is free for the
landing page:

```
/     -> public/landing.html   (public)
/app  -> public/index.html     (the application; /app/ redirects here)
```

**Consequence:** every asset URL inside `index.html` had to become absolute
(`/style.css`, `/graph.css`, `/icon.svg`, `/vendor/...`, `/js/main.js`) —
from `/` they worked as relative paths, from `/app` they only work absolute.
Verified: `/app` loads with **0 failed requests**.

The landing page is deliberately **standalone** — its own token block, no app
CSS — so it renders before and without the app shell. It reads the same
`lb.theme` key as the app, so clicking through never flashes a different
scheme (verified: light-visit → `/app` → still light).

### 5.2 Acceptance — **all met**

- [x] Hero answers the Fletch 6-tuple in <10 s of reading
- [x] PAS spine: Problem ("a scroll of forgetting") → Agitation → Solution
- [x] Every feature card pairs a benefit with the concrete feature
- [x] Proof is *product-truth* only — six checkable claims, plus an explicit
      line saying there are no testimonials or user counts because it's new
- [x] No invented user numbers, quotes, logos or "free forever" we can't back
- [x] Second person, short lines, one idea per line
- [x] CTAs all point at `/app`; nav anchors scroll to real sections
- [x] Works in both themes, no flash on load, 0 console warnings

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
8. [x] Landing page

**P2 — Identity**
9. [x] Schema + RLS from row one *(P2.1, 2026-10-05 — 7 tables, 19 policies, 0 advisor findings)*
10. [x] Auth screens + gate *(P2.8, 2026-10-05)* — `/login` and `/signup` are one
    document behind two routes, Google primary with email magic link as the free
    fallback. `GATE='auto'` in `js/auth.js` holds the gate off on localhost so
    the local demo keeps working; flip it to `'on'` once the provider is live.
    **Still needs the user to create a Google OAuth client and enable the
    provider** (3 dashboard steps, listed in PROGRESS P2.8). The gate is UX only
    — RLS is the boundary, and P2.1 proved it denies everything.
11. [ ] Workspaces (cards → app) — *local half done in §2.5; auth + user scoping remain*
12. [ ] User/workspace scoping on every route
13. [ ] BYOK (per-user provider + key, stored server-side)
14. [~] Pricing page + bank-transfer payment claims (no Stripe)
    — `/pricing` shipped *(P2.9, 2026-10-05)*: three tiers matching
    `platform_settings.plans`, deliberately **static** because `anon` has every
    table privilege revoked and GitHub Pages has no server to read the row.
    Remaining: the claim-filing form and the admin approval side *(P2.9b)*.
15. [ ] Admin dashboard (users, requests, Supabase-limit gauges, claim queue)
16. [ ] Port `server.js`'s streaming proxy → Supabase Edge Function
17. [ ] Migrate existing local data *(pending Q6)*

**P3 — Ship**
18. Host it free — **decided: GitHub Pages + Supabase Edge Function (§4)**
19. Base-path + clean-route fixes for GitHub Pages; Actions heartbeat
20. Domain/URL, final smoke test

---

## 7. Open questions (BLOCKING)

| ID | Question | Status |
| -- | -------- | ------ |
| Q1 | Build the graph ourselves (Preact + SVG) or migrate to React for React Flow? | **resolved 2026-10-03 — build it ourselves** (see §2.2; shipped, no drag/ports needed yet) |
| Q2 | Hosting path A (Express + free PaaS) vs B (Supabase serverless)? | **resolved 2026-10-04 — user chose GitHub Pages + Supabase Edge Function** (a variant of B; see §4 for the three blockers and why "just enable the setting" is not enough) |
| Q3 | Phase order — P1 UI first, or auth/workspaces first? | **resolved 2026-10-03 — P1 first** (user: local full working demo, then Supabase creds) |
| Q4 | Auth provider: Supabase Auth vs self-rolled? | **resolved 2026-10-04 — Supabase Auth.** Google OAuth is the primary sign-in (user: "essential"), email magic link as the free fallback. Needs a Google Cloud OAuth client + the provider enabled in the Supabase dashboard (user action). |
| Q5 | Drizzle yes/no + state-lib yes/no | **resolved: both no** |
| Q6 | Migrate the existing 6 local conversations into a workspace? | **open** (P2) |
| Q7 | "encapsulate under user preferences, no sidebar route, just give a link" — what is this? | **open** |
| Q8 | Graph view: does it *replace* the list view or coexist forever? | **resolved 2026-10-03 — coexist behind the header toggle** (brief: "list view ⇄ graph view") |
| Q9 | Summary/quiz accuracy rework — start where? | **resolved 2026-10-04 — Phases 1+2 (+3) implemented and live-verified, §9.3**; only P4 (pin a model / BYOK) still open, blocked on P2 |

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
| 2026-10-03 | **Zoom via a wrapper element** (`#graph-zoomer` sized `base × zoom`) + `transform: scale()` on the canvas, so scrollbars match the paint and no child coordinate system changes. → **Superseded 2026-10-04 by the camera decision below** (no scrollbars left to match). |
| 2026-10-03 | **Pan by writing scroll offsets**, not a transform — composes with native scrolling. Left-drag only from the empty board, plus middle-drag and Space+drag. → **Superseded 2026-10-04**; a scroll box has a top, and content above it could never be reached. |
| 2026-10-03 | **All colour lives in one token block**; `:root` is dark, `[data-theme='light']` overrides. Zero raw colour declarations outside it (verified by scanning the CSSOM). |
| 2026-10-03 | Theme default = OS preference, manual choice wins and persists (`lb.theme`); applied inline in `<head>` to avoid a flash. |
| 2026-10-03 | Texture only on *backdrop* surfaces — panels stay flat so they read as cards on a desk. Graph canvas additionally gets a dot grid. |
| 2026-10-03 | `schedule()` arms a 120 ms timer beside rAF: a hidden tab never runs rAF, which would otherwise freeze graph state (and collapse-on-scroll) until the window is shown. |
| 2026-10-04 | **Summary export = one block list, three writers** (`export-format.js` has *no imports*, so it is testable outside a browser and can never create a cycle). PDF is hand-written base-14 Helvetica and DOCX is a STORED zip — no library, no build step, no network, nothing to install. |
| 2026-10-04 | **Boot = one loader, never the list view.** `data-boot` lives in the markup so the very first paint is already the loader; `endBoot()` runs in `init()`'s `finally`. `#app` is `visibility:hidden` (still laid out) so the reveal costs no reflow, and an 8 s `<head>` watchdog means a thrown error can never strand the user on the loader. |
| 2026-10-04 | **Pan never writes scroll synchronously** — one rAF frame plus a 16 ms timer (`applyPan`/`endPan`), landing the final position inline on `pointerup`. Same rAF-fallback shape `schedule()` already needed for a hidden tab. |
| 2026-10-04 | **Accuracy = a pure grounding layer + an audit pass.** `grounding.js` has zero imports (the `export-format.js` pattern) so `npm run check:grounding` can assert on it from node; every answer index goes through a temperature-0 read of the source that must quote a sentence. No unverified key reaches the user. |
| 2026-10-04 | **Shuffle the options before the audit.** A live run came back 7/7 with the key in slot 0 — a model writing `correct` as a verbatim copy emits that option first, so the test was guessable and looked broken even where every key was right. |
| 2026-10-04 | **Quiz cache carries `v: QUIZ_VERSION`.** A fingerprint only moves when the *conversation* changes, so a pipeline fix would otherwise leave every pre-existing test with its inaccurate keys forever. Version-bump the quiz (one regeneration each, once); do **not** version-bump summaries, which would silently burn quota on every open. |
| 2026-10-04 | **The graph viewport is a camera, not a scroll box** (§2.9). `#graph-scroll` is `overflow: clip` — *clip*, because `hidden` still makes it a scroll container and a transformed canvas lands in its scrollable overflow — and `#graph-canvas` carries `translate(camX, camY) scale(zoom)`. No content box ⇒ no edges ⇒ space in every direction. Supersedes both the `#graph-zoomer` wrapper and scroll-offset panning. |
| 2026-10-04 | **A board nobody has touched is framed for them**: centred, and never closer than 56 px to the top/left, then `camTouched` latches on the first user pan/zoom so a later render can never re-centre a board they deliberately moved. |
| 2026-10-04 | **`liftBoard()`'s guard was inverted** (`lift <= 0` where `lift = min(0, min y)` is always ≤ 0) — a no-op since `d37659e`, and the actual cause of explanations sitting under the header. Now `lift >= 0`. Fix this independently of the canvas work: it is the bug, the camera is the experience. |
| 2026-10-04 | **One library, deliberately narrow: `@use-gesture` for wheel + pinch only.** Device decoding (trackpad, multi-touch) is the hard part and worth buying; the camera maths and the pan rules (Space / middle button / empty board, click suppression) are app policy and stay here. A canvas renderer — Konva/Pixi/litegraph/react-flow — would have to *redraw the live DOM* the nodes host, and `panzoom`/`d3-zoom` own the transform we just took over. Served from `node_modules` by a new `/lib/use-gesture` route + an import map, so there is still no build step. **`pinchOnWheel: false` or Ctrl+wheel zooms twice** (100 % → 232 %). |
| 2026-10-04 | **Hosting = GitHub Pages (static) + Supabase Edge Function (proxy).** $0, no VPS, no cold start. GitHub Pages *alone* cannot work: the BYOK proxy needs a server (no CORS from providers), project sites serve under a sub-path while our asset URLs are absolute, and `/app`+`/workspaces` are not files. Vercel rejected because the Hobby plan is non-commercial and its duration limits fight our 120 s first-byte / 45 s idle gaps. Supabase Free **pauses after 1 week idle**, so a GitHub Actions heartbeat is mandatory. §4. |
| 2026-10-04 | **Storage: text in Postgres, originals in Supabase Storage, and Free stores text only.** Storage egress is metered (5 GB) while Postgres API reads are unmetered, and the extracted text is what the app actually reads. Keeping originals for paid plans only turns a 5 MB PDF into ~100 KB of text — ~50× less storage, lifting the free ceiling from ~20 users to hundreds. Extraction moves to the browser (`mammoth`/`pdf.js` browser builds) so the Edge Function never handles multi-MB uploads. R2 deferred by the user ("skip it, for now"). §3.3. |
| 2026-10-04 | **Pricing tiers meter our Supabase resources, not tokens** — BYOK means the user pays for their own LLM usage, so the scarce things are Edge Function invocations (500 K/mo) and database size (500 MB, the real ceiling). Free 50 req/day · Pro $9/mo · Team $29/mo. **Payment is bank transfer, no Stripe**: user files a `payment_claims` row, an admin approves it and the plan flips. |
| 2026-10-05 | **Blobs stay JSONB on `conversations`; `usage_daily` is a rollup, not an event log.** The app loads a conversation whole, so normalising `messages`/`explains`/`summary`/`quiz` buys no query power and costs a join per read — and no GIN index, because those payloads are never filtered on. An event table would be ~100× bigger than one row per user per day for the same answers, and the 500 MB database is our tightest resource. |
| 2026-10-05 | **`profiles` is the one table with RLS enabled but not forced.** FORCE would make the owner subject to RLS, breaking both the signup bootstrap trigger (GoTrue has no `auth.uid()` yet) and `is_admin()`, which is SECURITY DEFINER and so runs as the owner. `anon`/`authenticated` stay fully restricted; only the owner is exempt, and the owner can already `alter table` anything. Everything else is forced. |
| 2026-10-05 | **SECURITY DEFINER helpers live in a `private` schema, never `public`.** PostgREST only serves `public`, so `public.is_admin()` was RPC-callable by anyone holding the anon key — and revoking from `anon` alone does nothing, because **PostgreSQL grants EXECUTE to `PUBLIC` by default** and `anon` inherits it. Moving all three to `private` cleared both advisor lints (now 0 findings). Verified with a probe that PostgreSQL checks EXECUTE at trigger *creation*, not fire time, so revoking cannot break sign-up. |
| 2026-10-05 | **`updated_at` is set by a database trigger, not trusted from the client** — `conversations_ws_time_idx` orders the conversation list by it, so an un-stamped row would strand a chat at the bottom forever. |

---

## 9. Summary & quiz accuracy — **IMPLEMENTED + VERIFIED 2026-10-04 (P1.32)**

> User report: *"the questions are not very accurate and the answers are not
> very accurate … I cross-checked with some other resources, the question I
> selected was correct but the system shows that that is incorrect."*

A correct user marked wrong. Diagnosis from the code, worst cause first.

### 9.1 Root causes (`summary.js` / `quiz.js` / `server.js`)

1. **The quiz is written from a digest, not from the conversation.**
   `runQuiz()` feeds the model `summaryPromptInput()`, which keeps
   `main.slice(-30)` clipped to **400 chars** each plus explainer excerpts
   clipped to **300**. A fact older than 30 messages, or past 400 chars into a
   real answer, is not in front of the model — so it invents a key.
2. **The summary feed truncates the answer, not the question.**
   `buildSummaryChunks()` pairs `clip(student, 300)` with `clip(tutor, 500)`.
   The *conclusion* of a long derivation falls outside 500 chars, so MAP
   extracts notes from a partial answer and REDUCE faithfully condenses the
   wrong half. A single unit longer than the ~1100-char budget also becomes
   its own oversized chunk.
3. **Nothing ever checks an answer key.** `finishTest()` grades with
   `picked === answer` — index equality against whatever the generator wrote.
   If the model marks B when the truth is C, or two options are both true, a
   correct user is marked wrong. No verification pass, no ambiguity check, no
   source snippet stored on the question.
4. **`temperature: 0.8`** in `runQuiz` (the summary uses `0.2`). Variety is
   already supplied by the `QUIZ_FOCUS` rotation; at 0.8 it also raises the
   odds of a wrong or mismatched `answer` index.
5. **The model changes between requests.** `data/settings.json` is
   `{"provider":"auto","apiKey":""}` → `AUTO_ORDER` starts `kilo, llm7, ovh`
   (free, no key, small) and **auto re-picks per request**, so batch 1 and
   batch 4 of one test can come from different models. The live UI already
   shows `Kilo Code … refused the request (HTTP 401)` — the first choice
   isn't even reachable.
6. **Valid short facts are dropped.** `sanitizePoints()` rejects any line
   under 12 chars and `hasRepetition()` treats fewer than 4 words as "not a
   real point", so `F = 9.8 m/s²` can vanish from Key findings.

### 9.2 Plan, in order of impact

**Phase 1 — ground it (make the model see the real text)**
- Generate questions **per chunk** from the same `buildSummaryChunks()` Q&A
  units the summary already uses, then merge — not from `summaryPromptInput()`'s
  last-30 digest. Summary and quiz then read one source and cannot disagree
  about what happened.
- Clip head+tail instead of head-only (380 + last 220 rather than 500), so the
  result of a long derivation survives.

**Phase 2 — verify every key (the fix for the actual complaint)**
- Split *writing* from *keying*: the model returns `{"q","options","correct"}`
  where `correct` is the right option **as prose**. Code matches it against
  `options` to set `answer`; no clean match → **drop the question** rather than
  guess an index.
- Fact-check pass per batch: question + its source excerpt back to the model —
  *"which option does this text support? quote the sentence."* Mismatch →
  repair or drop; no supporting quote → drop.
- Ambiguity check: *"can more than one option be true?"* → yes → drop.
- Store the supporting snippet on the question and show it in the results, so a
  disputed answer is auditable on the spot.

**Phase 3 — hygiene**
- Quiz `temperature` → ~0.3; keep the variety from `QUIZ_FOCUS`.
- Relax `sanitizePoints`' 12-char floor (keep the repetition guard).
- Cache per source chunk so a mid-test provider swap cannot happen.

**Phase 4 — model**
- Pin background jobs to one model (a "summary & test model" setting) instead of
  per-request Auto, or let the user BYOK — Gemini/Groq free keys are far
  stronger than the no-key gateways.

**Guardrail:** numbers, not vibes — a script that feeds the pure layer
deliberately bad model output and reports what is kept, repaired and dropped.

### 9.3 Status — **Phases 1 + 2 + 3 implemented, live-verified 2026-10-04 (P1.32)**

| Piece | Where | Status |
|---|---|---|
| **P1** per-chunk generation + head/tail clip | `quiz.js`, `summary.js`, `grounding.js#clipHeadTail` | done |
| **P1** dead `summaryPromptInput()` (root cause #1) | deleted | done |
| **P2** prose `correct` → index, no match → drop | `grounding.js#keyQuiz`, `resolveAnswer` | done |
| **P2** audit pass: which option does the source support, with a quote | `quiz.js#QUIZ_VERIFY_SYS`, `auditBatch`, `grounding.js#applyVerdicts` | done |
| **P2** ambiguity check + snippet stored & shown | `grounding.js#parseVerdicts`, `renderResults` `.res-src` | done |
| **3.1** quiz temperature 0.8 → 0.4 | `quiz.js#GEN_SAMPLING` | done |
| **3.2** `sanitizePoints` 12 → 8 chars, `hasRepetition(x,3)` | `summary.js` | done |
| **3.3** per-source cache | falls out of P1 (chunks are the unit) | done |
| **position bias** — see below | `grounding.js#shuffleQuestion` | done |
| **P4** pin one model / BYOK | — | blocked on P2 (Supabase) + a key |
| live guardrail (regenerate N real conversations) | — | run by hand instead, see numbers below |

**A root cause the diagnosis missed — position bias.** The first live run came
back with `answer = 0` on **7 of 7** questions: a model writing `correct` as a
verbatim copy of an option tends to emit that option *first*, so the test was
guessable and looked broken even where every key was right.
`shuffleQuestion()` randomises the options (carrying the key with them)
**before** the audit, so the auditor has to read the source instead of noticing
a pattern.

**Guardrail — `npm run check:grounding`** → `scripts/grounding-check.mjs`,
34 checks, zero imports, no network. Pure `grounding.js` fed wrong keys,
ambiguous options, missing quotes, malformed verdicts and un-shuffled slots,
then the case the whole phase exists for: *the user who picked the option the
SOURCE supports now grades correct*. **34 passed, 0 failed.**

**Live verification 2026-10-04** (free routed provider `kilo-auto/free`, no key)
on a throwaway 12-message conversation, then removed:

- summary → **10 points**; test → `target=7 kept=7 batches=11 dropped=0
  repaired=0 quoted=7 ambiguous=0`.
- all **7/7 questions carried a quote found in the source**; answer indexes
  after the shuffle `1,3,1,0,2,2,2` (before: `0,0,0,0,0,0,0`).
- driven through the real UI: correct picks → **7/7 100%**, each result showing
  `Source: "…"`; one deliberately wrong pick → **6/7 86%** with `✗`, the
  struck-out wrong option and the right one beside it. **0 console errors.**
- cost: **~15 requests / ~165 s** before the ceiling below, **~9 / ~80 s** after;
  model latency varies 2–21 s per call. Background job, never blocking.

**`quizCount()` now caps by source material** — `min(asked, max(4, chars/350))`.
It asked for `5 + msgs/5 + summaryPoints` = **17 questions from a 2 714-char
session** (~160 chars of source per key), so the generator could only re-cover
facts it had already used and burned 11 batches to fill 7 slots. Every key has
to point at a sentence really in the text, so the count is capped at what
~350 chars can honestly support.

**Cache invalidation:** quiz entries now carry `v: QUIZ_VERSION` (2). The
fingerprint only moves when the *conversation* changes, so without a version
bump every pre-existing test would keep its inaccurate keys forever. Old
entries regenerate once on open, then cache normally. Summaries are **not**
version-bumped — they are accurate under the new clip only from a ↻, so they
regenerate when the conversation changes rather than silently burning quota.

