-- P2.12 — file storage: give `files` the timestamp its own UI already reads.
--
-- The table shipped without one. The library has always rendered an upload's
-- time as `at` and sorted newest-first, so this is not cosmetic: without a
-- real column PostgREST has nothing stable to order on and falls back to
-- ctid, which moves whenever a row is updated — the list would reshuffle
-- itself after an unrelated write.
--
-- `default now()` also back-fills the rows that already exist (Postgres
-- evaluates a stable default once, at ALTER time), so they carry the time of
-- this migration rather than the epoch. There are none today, which makes
-- this the cheap moment to add it.
--
-- The index swap replaces (user_id) with (user_id, created_at desc): the
-- library's query is exactly "mine, newest first", and the narrower index
-- cannot serve the ORDER BY without a sort step.

alter table public.files
  add column if not exists created_at timestamptz not null default now();

drop index if exists public.files_user_idx;
create index files_user_created_idx on public.files (user_id, created_at desc);
