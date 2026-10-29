# AGENTS.md — operating rules for this repo (load every session)

**Read first, in order, when working on anything visual/UX:**
1. `docs/DESIGN.md` — the design language (tokens, type, motion, a11y gates). Source of truth.
2. `docs/ui-redesign-plan.md` — the phase plan & work order.
3. `docs/research-heptabase.md` — competitor context (features, pricing, why our identity differs).

The app: **Cortex** — an AI learning workspace (chat, explain-in-panel, notes, summaries,
quizzes, graph canvas), local-first + Cloudflare Worker deploy, frameworkless frontend
(Preact+htm views + vanilla DOM, no bundler). worker/ = prod API; server.js = dev.

## Hard rules (break nothing below)

**Identity & tokens**
1. `docs/DESIGN.md` is law. New UI uses only tokens from `public/tokens.css` — zero
   literal colors, zero rogue px sizes/spacing/radii anywhere in CSS. Icons ride the
   fixed 3-step scale (`--ico-1` 14 / `--ico-2` 15 / `--ico-3` 18; `.ico` = `--ico-2`)
   — never hardcoded icon sizes.
2. Fonts: **Fraunces (display) + Geist (UI)**, self-hosted in `public/vendor/fonts/`.
   Never add a font CDN (app is local/offline-first). Never swap the two faces' jobs.
3. Accent (`--accent`, ember) = **AI features + user intent (focus/active) only**.
   Green = success. Red = destructive. Never on decoration, bullets, headings, borders
   of non-active items.
4. NO: grain/noise texture, card drop shadows (shadow-pop is for menus/dialogs/toasts
   only), translateY hover travel, emoji in product UI or wordmark, gradient chrome.
5. Graph canvas dot-grid is the only textured surface allowed.

**A11y & behavior** (every UI commit)
6. WCAG 2.2 AA: verify contrast of any new color pair (compute; ≥4.5 text, ≥3 non-text
   UI). Both themes.
7. `:focus-visible` always visible (2px ember ring); full keyboard flow; ESC closes
   overlays; popovers restore focus; `aria-modal` on dialogs; aria-label on icon buttons.
8. `prefers-reduced-motion` collapses all animation. No spinners as layout replacement —
   skeletons at final dimensions.
9. Touch targets ≥24px (44 in auth/pricing), 8px spacing between targets.
10. Reading streams (chat/explains/summary) ≥15.5px/1.65; UI floor 13px; absolute floor 12px.

**Code**
11. Keep the no-bundler ESM architecture (`base.js` relative paths; import map for
    preact/htm). New modules follow the split-module style + `state.js` slots pattern.
12. Never break: relative-path deploy safety (GitHub Pages `/cortex-lms/` +
    workers.dev root both must work), Supabase RLS scoping, BYOK never leaving server.
13. Before deploying: `node scripts/assemble.mjs --base / && wrangler deploy`.
    Prod URL: https://cortex.mzubairhassan18.workers.dev
14. Data/regression guards: graph Aligned mode, explain tree recursion, quiz grounding
    audit, and the graph Free-mode layout (`/api/layout`) have history — check they still
    pass after touching `graph.js`, `explain-*.js`, `layout` code.
15. Shared page chrome = `public/js/site.js` (`mountBrand`/`mountFoot`). Pages keep
    text-only `[data-brand]` anchors + hidden `[data-foot]` slots; never copy brand/foot
    markup into a page. Keep `MARK_SVG` in sync with the `#i-cortex` sprite + `icon.svg`.

## Definition of done for UI phases
- Lighthouse/perf: landing no layout shift from fonts, images/weight within budget.
- Both themes visually verified (dark graphite #131316 / light paper #FAFAFA).
- Screens audited against DESIGN.md §8 (obvious actions walkthrough).
- Zero `console.error` in normal flows; streams retry; optimistic actions reconcile.

## When unsure
Default to LESS: fewer colors, fewer weights, fewer borders, fewer words in UI copy.
If an element is decorative, delete it. If two elements do the same job, merge them.
Every pixel must earn its place — this is how we keep the desk quiet and the thinking loud.
