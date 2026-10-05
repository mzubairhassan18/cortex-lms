-- Graph view layout: ALIGNED (the computed layout) vs FREE (user-placed).
--
-- The graph view has always placed nodes itself — conversations stacked in a
-- column, explanations hung off as a tree by depth — and recomputed it on every
-- render, so nothing could be moved. Free mode keeps that computed layout as a
-- FALLBACK and lets a saved coordinate win, which is what lets a user pull one
-- conversation tree away from the others and have it stay there, Figma-style.
--
-- One jsonb column rather than a graph_positions table: positions are one
-- person's view preference, written as a whole on drag-end, and there is no
-- query in the product that needs to look inside them. A table would mean a
-- second RLS policy and a second route for no gain.
--
-- NEGATIVE COORDINATES ARE ALLOWED ON PURPOSE. #graph-canvas has no overflow
-- rule (visible) and #graph-edges sets overflow:visible, so world coordinates
-- left of or above the origin paint fine — that was the entire point of moving
-- off the scroll box and onto a camera. Normalising to a non-negative origin
-- would make dragging up or left shift the WHOLE board on screen, so the saved
-- value is the displayed value and there is no drift to correct.
--
-- The profiles_guard trigger does not interfere: it only raises when role, plan
-- or plan_expires_at change, and ordinary owners are expected to write this.

begin;

alter table public.profiles
  add column if not exists graph_layout jsonb
  not null
  default '{"mode":"aligned","positions":{}}'::jsonb;

comment on column public.profiles.graph_layout is
  'Graph view layout: {"mode":"aligned"|"free","positions":{"c:<convId>":{"x":n,"y":n},"e:<explainId>":{...},"summary":{...}}}. '
  'Keys match graph.js node keys; x/y are world coordinates and may be negative. '
  'Missing keys fall back to the computed Aligned layout. Written by the owner via the Worker.';

commit;
