# CORTEX DESIGN LANGUAGE — source of truth

Every visual decision in this repo follows this file. If you add UI and it isn't
covered here, extend this file in the same commit. Version: 2.0 (2026-10).
Verified: every fg/bg pair below was computed against WCAG 2.2 relative luminance
(contrast log in git history, 2026-10-29). Ratios are stated inline.

---

## 1. Identity — "Graphite & Ember"

A **cool, Swiss-disciplined learning tool with an editorial serif for identity
moments**. Distinct from the category: Heptabase is warm-creampaper-blue,
Linear is violet-on-graphite, Notion is white-system. Cortex is cool graphite
(zinc neutrals) + a single **ember** accent + Fraunces/Geist type pairing.

One sentence to test every design decision against:
> *The interface is a well-lit desk; the content is the only thing with color, and the
> accent only ever marks where the AI or the user's intent acts.*

### Non-negotiable principles (in priority order)
1. **Clarity before decoration.** If an element has no function, it doesn't exist.
   No grain, no gradients, no glows, no hover travel, no confetti. Emoji never appear
   in product UI or wordmarks. (One sanctioned exception: the chat word lift — §2
   `--ink-hover`, a ~10% perceptual lightness shift on the glyph under the pointer,
   functional not chrome.)
2. **Field before chrome.** Structure is visible without color: every interactive
   element has ≥1 non-color affordance (border, fill, icon, or position).
3. **Calm surfaces.** Light theme is the *primary* identity (paper-desk); dark is a
   first-class equivalent (graphite night), not an afterthought.
4. **Readable always.** Body text 15.5px/1.65 minimum for reading streams (chat,
   explain, summary). UI text 13–14px/1.45. Nothing renders below 12px, ever.
5. **Color means something.** Ember = AI action or user intent (focus, active thread).
   Green = success/checked. Red = destructive. Nothing else gets saturated color.
6. **Motion informs, never performs.** 120/200/320ms, `cubic-bezier(.2,.6,.25,1)` enter;
   no bounce, no spring, no shimmer. `prefers-reduced-motion` → all transitions ~0ms.

---

## 2. Color tokens (verified AA)

### Light (primary)
| Token | Value | Contrast proof | Allowed use |
|---|---|---|---|
| `--canvas` | `#FAFAFA` | — (surface) | page background everywhere |
| `--surface` | `#FFFFFF` | — | raised cards |
| `--well` | `#F4F4F5` | — | wells, code blocks, inset panels, active list rows |
| `--ink` | `#18181B` | 16.97 on canvas | text, primary button fill, strong icons |
| `--muted` | `#66666E` | 5.45 canvas · 5.18 well | secondary text (all sizes) |
| `--faint` | `#6E6E76` | 4.84 canvas | tertiary text, meta, fine print |
| `--accent` | `#C2410C` | 4.96 canvas · 5.18 white | AI emphasis text, focus ring, active marks |
| `--accent-soft` | `#C2410C` at 10% | — | tint fills only (NEVER text on tint unless ink) |
| `--ok` | `#15803D` | 4.81 canvas | success/checked only |
| `--danger` | `#B91C1C` | 6.20 canvas | destructive text only |
| `--warn` | `#92400E` | (small text) | warnings |
| `--edge` | `rgba(24,24,27,.08)` | decorative | dividers, decorative hairlines |
| `--edge-strong` | `#87878F` | 3.41 canvas (1.4.11 ✓) | borders that CARRY meaning: selected card, control boundary, graph edges |
| `--selection` | `#FACC15` at 35% | ink-on-wash ≈ 16.1 ✓ | text selection (marker-yellow highlighter) |
| `--ink-hover` | `#18181B` 10% darker | your spec (ΔL* ≈ 1) | word under the pointer in chat replies (CSS Highlight API) |
| `--shadow-pop` | `0 8px 24px rgba(24,24,27,.14)` | — | menus/popovers/dialogs ONLY |

### Dark (equivalent)
| Token | Value | Contrast proof | Note |
|---|---|---|---|
| `--canvas` | `#131316` | — | graphite, never pure black |
| `--surface` | `#1C1C20` | ink 13.39 ✓ | raised cards |
| `--well` | `#26262B` | — | wells/insets |
| `--ink` | `#E4E4E7` | 14.61 canvas | text; primary button fill stays LIGHT inverted |
| `--muted` | `#A1A1AA` | 6.63–7.24 ✓ | |
| `--faint` | `#8D8D96` | 5.64 ✓ | |
| `--accent` | `#FB923C` | 8.19 canvas · ring 8.19 ≥3 | ember lifts in the dark |
| `--ok` | `#4ADE80` | 10.64 ✓ | |
| `--danger` | `#F87171` | 6.70 ✓ | |
| `--warn` | `#FBBF24` | — | |
| `--edge` | `rgba(228,228,231,.09)` | decorative | |
| `--edge-strong` | `#9A9AA3` | 6.65 ✓ | meaningful boundaries |
| `--selection` | `#FACC15` at 22% | text-on-wash ≈ 8.6 ✓ | lifts the yellow, keeps text legible |
| `--ink-hover` | `#E4E4E7` 10% lighter | your spec | word under the pointer in graphite |

**Hard rules**
- No literal color outside `tokens.css`. Off-token need = add token (both themes) first.
- `--accent` is never: bullets, feature card headings, borders on non-active items,
  marketing glow. It marks AI actions + user intent + focus, that's the whole list.
- Text on `--accent` fills: only `#FFFFFF` (light) / `#131316` handled by not existing —
  ember is never a fill under white text in light; ember-as-fill is avoided entirely.
- Status color never travels alone: icon + text always (imports: 8.4.10.1 exemplary).

---

## 3. Typography

Self-hosted woff2 in `public/vendor/fonts/` (the app promises local/offline-first —
never a font CDN). Both fonts are OFL licensed. Subset to latin (+latin-ext optional).

| Role | Face | Spec |
|---|---|---|
| **Display** — wordmark, landing hero/section heads, big numbers, empty-state texts | **Fraunces** | weight 500, `opsz 72`; tracking −0.02em; 34–66px; line-height 1.15; never 700 |
| **UI / text / everything functional** — nav, body, chat, labels, buttons | **Geist** (variable 400–600) | body 15.5px/1.65; ui 13.5px/1.45; buttons 13.5/500; card titles 600 |
| Mono (code, counters) | Geist Mono or `ui-monospace` fallback | 13px/1.6 |

Scale (rem, 1rem=16): `11.5 12 13 13.5 15.5 17 21 26 34 48 66`. Each step has exactly
one assigned role (below). **If a new size is needed, the scale is wrong — fix the scale
in this file, don't add a rogue px value.**

- 66/48 landing display (Fraunces) · 34 section/landing (Fraunces) · 26 in-app page titles (Geist 500)
- 21 overlay titles · 17 lede/community · 15.5 body/reading · 13.5 UI/buttons/labels · 13 code/kbd
- 12 fine print/badges/meta (floor) · 11.5 only uppercase eyebrows w +0.08em tracking

In-app headers use **Geist 500** (tool feel). **Fraunces appears in-product only as**:
wordmark, the empty-canvas invitation line, workspace page title, auth page headline.
That's the list. Fraunces is identity, Geist is function; they never swap mid-page.

---

## 4. Layout system

- **Spacing** 8-point: `4 8 12 16 24 32 48 64 96` — `--sx` tokens. Never 7/9/26.
- Gaps between content and its container: inner 16, outer 24. Section padding 64–96.
- **Radius ladder**: `--r-xs 4` (chips, ticks) · `--r-sm 6` (rows, list items, buttons in dense areas) ·
  `--r-md 8` (buttons, inputs, code) · `--r-lg 12` (cards, panels, explain containers) ·
  `--r-xl 20` (overlays) · `--r-pill 999` (pills, model selector, LOADING badgets no — badges square).
  Denser surface ⇒ smaller radius.
- **Elevation**: flat by default. `--shadow-pop` ONLY on: dropdown menus, popovers,
  toasts, modal dialogs, command palette. Cards, panels, graph nodes: NO shadow, ever.
- Depth language = fill change (`canvas→surface→well`) + `--edge` hairlines. 
- **Touch targets** ≥ 32px desktop dense UI; 44px in auth/pricing/payment; 24px absolute
  floor (WCAG 2.5.8) with 8px center spacing.
- **Icon scale** — fixed 3-step role ladder, never hardcoded and never rogue sizes:
  `--ico-3` 18px → standalone icon buttons + circle marks + brand-mark instances;
  `--ico-2` 15px → default (buttons, toolbar, inputs, menus);
  `--ico-1` 14px → dense rows, chips, meta rows, message-copy actions.
  `.ico` in `style.css` ships at `var(--ico-2)`; jump to 1 or 3 only for those roles.
  The boot-mark keeps its one-off 44px hero size. Drawings live on the 24-grid, stroke 2.

---

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `--t-fast` | 120ms `cubic-bezier(.25,.1,.25,1)` | hover fill changes, presses |
| `--t-med` | 200ms `cubic-bezier(.2,.6,.25,1)` | panel open/close, node expand, popup |
| `--t-slow` | 320ms same curve | view switch, overlay, page transition |

- Enter = fade + 4px translate (max). Exit = fade only.
- Only three "life" signals loop: streaming caret (ember, 2px, pulsing), the chat
  thinking node (`.bubble.thinking` — one breathing ember dot, `ember-breathe` 1.4s,
  halo via `--intent-soft`, transform+opacity only), and skeletons (opacity pulse on
  flat blocks). Nothing else loops.
- The chat word lift is text-only by charter: the word under the pointer (CSS Custom
  Highlight API range "word-hover") shifts ~10% in perceptual lightness — darker in
  paper, brighter in graphite — and snaps back instantly on exit. NO background, NO
  overlay, NO DOM rewrite, NO cursor tracking, so it works on streaming text and
  leaves chips/links/code alone (skip list in `public/js/word-hover.js`). Explain
  panels reuse `.bubble` markup — keep the scope to `#chat-area`.
- `@media (prefers-reduced-motion: reduce)` → `* { transition-duration: 0.01ms !important;
  animation-duration: 0.01ms !important }` — verify every phase ships this.

---

## 6. Component standards

**Buttons** — radius `--r-md` (8) everywhere except pills. Weights 500. Heights:
32 (dense/graph) · 36 (standard) · 40 (forms) · 48 (landing CTA).
- Primary: `--ink` fill, white text (dark: `--ink`/`#131316` text). Hover: 92% opacity;
  press: 88%. Focus-visible ring below.
- Secondary: transparent, `--edge-strong` border, ink text. Hover: `--well` fill.
- Ghost/icon: 30–36px square, muted icon → ink on hover, `--well` fill at hover.
- Destructive: red *text/icon* on transparent; confirm popover required.
- NO: translateY hover, glow, gradient, letter-spaced ALL CAPS in primary CTAs.

**Inputs** — 36px (40 in forms), `--well` fill (not hollow), label 12.5/500 above,
placeholder `--faint`, focus: `--edge-strong`+ 1px accent underline no wait — focus =
`1px` `--accent` border + no shadow ring inside wells; error text 12px `--danger` below.

**Selection popup (Explain/Note)** — pill pair: amber no—primary = ink pill "Explain",
ghost "Note"; radius 8; `--shadow-pop`; 13/500. Opened by: text selection OR Cmd+E.
Anchored above selection, never covering it.

**Command palette (⌘K)** — 640px, `--surface`, radius `--r-xl`, `--shadow-pop` +
1px `--edge`, input row 48px, results = rows with kbd hints, `--t-med` in/out.

**Toasts** — error/undo only. Bottom-center, `--ink` fill (text white), radius `--r-sm`,
auto-hide 6s, `--t-med`. Success states are inline quiet text instead.

**Empty states** — one Fraunces line (identity moment) + one quiet action button.
Example graph: *"An open desk. Right-click anywhere to place your first conversation."*
No illustrations, no emoji.

**Tables/lists** — row height 36; selected row = `--well` fill + 2px `--ink` left tick;
hover = `--canvas`→`--well` dice; delete = icon button, hover turns `--danger`.

**Graph nodes** — paper: `--surface` (expanded) / `--well` (collapsed chip) +
`--edge` hairline + `--r-lg`/`--r-md`; NO shadow; active node = `--edge-strong` +
2% accent wash max; labels: title 13/600 ink, meta 12 muted.
**Graph edges** — 1.5px `--edge-strong` (inactive: `rgba(--ink,12%)`), rounded orthogonal
corners, 6px minimal arrowhead, direction-agnostic routing; active thread = 1.5px ember.
Dot grid = the canvas texture (allowed, unique): ink at 4–5% light / white 6% dark.
**No grain/noise texture anywhere. Ever.** (Deleted from app + landing in Phase D.)

**Focus & keyboard** — every interactive element: `:focus-visible` ring = 2px `--accent`,
offset 2px, radius follows element; NEVER `outline:none` without replacement.
Tab order = visual order; ESC closes all overlays; focus returns to invoker;
dialogs: `role="dialog" aria-modal`, focus trap; icon-only buttons: `aria-label` +
tooltip (or `title`); overlays: focus trap; live region (`aria-live="polite"`) announces:
stream-complete, quiz result, saved confirmations.

**Copy in UI** — sentence case everywhere; buttons ≤3 words ("Explain", "Save note");
avoid OK/Cancel in popovers — name the action ("Delete", "Keep"); every icon +
label pair avoids duplication (no "New chat – start a new conversation" verbosity).

---

## 7. Accessibility gates (check before ANY visual commit)

- [ ] All text ≥4.5:1 (computable pairs verified in this file; new pairs must be run)
- [ ] Non-text UI indicators ≥3:1 (1.4.11) — active edges, selected card border, focus
- [ ] Touch targets ≥24px, spacing 8px+ (2.5.8); primary flows ≥44px mobile
- [ ] `prefers-reduced-motion` honored (9.2.x / 2.3.3)
- [ ] No color-only meaning (1.4.1) + `currentColor` icons inherit text contrast
- [ ] Visible focus on 100% of interactive elements (2.4.7)
- [ ] Keyboard оператор full flow: composer, selection popup, graph (arrow/Enter/Z F R),
      tabs, popups, dialogs (2.1.1/2.1.2)
- [ ] Landmarks + skip link on app/landing (1.3.1/2.4.1); `lang`, `dir` correct
- [ ] Form fields labeled, `autocomplete` set, errors in text + `aria-describedby` (3.3.x)
- [ ] AA also checked in BOTH themes; hit dark specifically for `--muted` on `--well`

---

## 8. The "obvious actions" walkthrough (navigation clarity audit)

For every screen, a new user must answer without reading docs:
1. *What can I do here?* (visible affordances, not hidden menus for main actions)
2. *What will happen if I press this?* (buttons name outcomes, icons have labels or
   learned-tooltip; destructive = red + confirm)
3. *Where am I?* (conversation title visible; active nav = filled pill; graph tool
   state = pressed chip)
4. *How do I go back?* (every overlay has ESC + visible close; graph↔list toggle is a
   two-state segmented control, not a mystery icon)
5. *What's loading?* (skeleton at final dimensions, never a spinner replacing layout)
6. *Is it stuck?* (streams show a retry link after 15s of silence; offline = top
   banner once)

Any audit failure = UI bug equal in severity to the graph bug. File it, fix it
in the same commit whenever possible.

---

## 9. Implementation notes (Cortex specifics)

- Keep the no-bundler architecture: token file `public/tokens.css` imported FIRST by all
  six HTML pages; `style.css`, `graph.css`, `landing.css` consume tokens only.
- Fonts vendored: `public/vendor/fonts/geist-var.woff2`, `geist-mono.woff2`,
  `fraunces-var.woff2` + `@font-face` in tokens.css (`font-display: swap`).
- No-flash theme script stays (inline, pre-paint, `lb.theme`), default = `system`.
- Landing + auth + pricing use tokens; NO copy of app-only chrome onto marketing pages.
- Shared page chrome lives in `public/js/site.js` (`MARK_SVG`, `mountBrand()`,
  `mountFoot()`): pages keep bare text-only `[data-brand]` anchors and hidden
  `[data-foot]` slots, so no-JS still reads "Cortex". Per-page foot links stay per
  page (content, not chrome). Keep `MARK_SVG` in sync with the `#i-cortex` sprite
  symbol (`public/index.html`) and `public/icon.svg`.
- Chat word lift lives in `public/js/word-hover.js` (caret hit-test + CSS Custom
  Highlight API) + `::highlight(word-hover)` in `style.css`. Tokens `--ink-hover`
  carry the per-theme shift. Graceful no-op where the API is unavailable.
- Perf budget (premium feel = fast feel): landing LCP text + fonts < 90KB; no image
  > 220KB on landing (screenshots WebP ≤ 160KB); 0 blocking font CSS besides tokens.
