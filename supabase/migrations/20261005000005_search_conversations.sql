-- --------------------------------------------------------------------------
-- search_conversations(q, workspace) — the graph view's "find this text"
--
-- WHY A FUNCTION AT ALL:
--   `messages` and `explains` are jsonb, and PostgREST has no substring
--   operator for jsonb. `cs`/`cd` test containment of a whole value, which
--   cannot answer "which of my conversations mentions this phrase". ILIKE over
--   extracted text can — and only SQL can run it. Without this the graph search
--   would have to pull every conversation's full history down to the browser
--   and filter there, on every keystroke.
--
-- WHY THE COLUMNS ARE NOT MATCHED AS `::text` (the obvious version, and it is
--   wrong): casting a jsonb to text also exposes every KEY and every
--   structural value. `[{"role":"user","content":"..."}]` contains "role",
--   "content" and "user" in every single row, so searching any of those words
--   would return every conversation in the account — and because this returns
--   ids only (see below), the user would have no way to see that the hit was
--   hollow. So the search reaches in with jsonpath and pulls the FIELDS that
--   carry meaning:
--
--     messages[].content   what was actually said
--     explains.selection   the text an explanation was created FROM
--     explains.messages[].content   what the explanation concluded
--
--   `role`, `system`, `parentId`, `createdAt`, `w`, `cw` are deliberately left
--   out: they are schema and prompt boilerplate, and matching them is a
--   guaranteed false positive. Scope is title + conversation + explanation,
--   which is exactly what the UI offers to centre on (the summary and notes
--   are not nodes the search claims to find).
--
-- SECURITY INVOKER (same call as consume_quota, stated so it is never
--   "optimised" away): the function runs AS the caller, so the RLS policies on
--   `conversations` decide which rows come back. worker/search.js forwards the
--   caller's own JWT and therefore sees exactly what that user could already
--   fetch row by row — this filters, it does not authorize. No service-role
--   key anywhere on this path.
--
-- NO INDEX, deliberately:
--   `... like '%x%'` cannot use a B-tree or a GIN index anyway (leading
--   wildcard), so an index would be pure cost. A stored tsvector column would
--   be recomputed on EVERY message write — every chat persist rewrites
--   `messages` — which costs more than the scan it saves at this size:
--   conversations are bounded by plan (10 on Free) and are scanned only when
--   someone actually searches. Revisit if a single workspace ever holds tens
--   of thousands of conversations.
--
-- RETURNS: conversation ids only, best match first (title hits, then most
--   recently updated). The client is what knows where it wants to LOOK: it
--   switches to the conversation, finds the explain that holds the phrase in
--   its own already-loaded state, and flies the camera there. Shipping message
--   bodies back just to throw them away would defeat the point.
-- --------------------------------------------------------------------------
create or replace function public.search_conversations(
  p_q text,
  p_workspace text default null
)
returns setof text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with needle as (
    -- Escape LIKE's own wildcards first: a literal "%" or "_" the user typed
    -- must match itself, not become a pattern.
    select '%' ||
           replace(replace(replace(lower(p_q), '\', '\\'), '%', '\%'), '_', '\_') ||
           '%' as pat
  )
  select c.id
  from public.conversations c
  cross join needle n
  where c.archived = false
    and (p_workspace is null or c.workspace_id = p_workspace)
    and (
         c.title ilike n.pat
      or exists (
        select 1
        from jsonb_path_query(c.messages, '$.**.content ? (@.type() == "string")') v
        where lower(v #>> '{}') like n.pat
      )
      or exists (
        select 1
        from jsonb_path_query(c.explains, '$.**.selection ? (@.type() == "string")') v
        where lower(v #>> '{}') like n.pat
      )
      or exists (
        select 1
        from jsonb_path_query(c.explains, '$.**.content ? (@.type() == "string")') v
        where lower(v #>> '{}') like n.pat
      )
    )
  order by (c.title ilike n.pat) desc, c.updated_at desc
  limit 60;
$$;

-- Supabase's default privileges would hand EXECUTE to `anon` — compare the
-- ACL on consume_quota, which carries an explicit `anon=X`. Take both away:
-- `anon` never reaches this (worker/supabase.js 401s without an Authorization
-- header), and with no PUBLIC grant a future route that forgets to
-- authenticate cannot hand it to anonymous callers either. `authenticated`
-- keeps its own explicit grant, so the app is unaffected.
revoke execute on function public.search_conversations(text, text) from public, anon;
