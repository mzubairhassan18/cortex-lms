-- ==========================================================================
-- P2 quota, admin activation, payment defaults — Cortex
--
-- Three gaps closed, all needed by P2.9b (bank transfer) and P2.10 (admin):
--
--   1. usage_daily was READ-only. It had a "read own or admin" policy with no
--      INSERT or UPDATE counterpart, so the table that records how much of
--      the Free tier's 50 requests/day are used could not be written by
--      anyone. Without a row there is nothing to count, and the pricing page
--      promises a limit it would never enforce.
--
--   2. consume_quota() does check-and-increment in one round trip. The
--      alternative was read plan -> read limit -> read today's count ->
--      write, four PostgREST calls on every message, and a race between the
--      read and the write. It is SECURITY INVOKER, so RLS still decides which
--      rows it may touch: the caller's own, exactly as before.
--
--   3. An admin must be able to activate a plan on somebody else's row.
--      `profiles: write own` only covered id = auth.uid(), so approving a
--      claim would have updated zero rows and reported success — the admin
--      would have seen the claim flip to "approved" while the user stayed on
--      Free. guard_profile_elevation already permits this for admins; RLS was
--      the missing half. with_check pins role and plan to the values the app
--      ever produces so a typo cannot poison a profile.
--
-- Also recorded here even though it was applied directly before this file
-- existed: payment_claims.user_id DEFAULT auth.uid() (it was NOT NULL with
-- no default, so the INSERT would have failed on the column before RLS ran).
--
-- Every statement is idempotent — drop policy if exists / create or replace /
-- set default — so re-running the migration is safe.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. usage_daily — let people write the row they own
-- --------------------------------------------------------------------------

grant select, insert, update on public.usage_daily to authenticated;

drop policy if exists "usage_daily: write own" on public.usage_daily;
create policy "usage_daily: write own" on public.usage_daily
  for insert
  with check (user_id = (select auth.uid()));

drop policy if exists "usage_daily: update own" on public.usage_daily;
create policy "usage_daily: update own" on public.usage_daily
  for update
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- --------------------------------------------------------------------------
-- 2. consume_quota(kind) — one call, one statement, exact limit
--
-- The increment is guarded inside ON CONFLICT ... DO UPDATE ... WHERE, so the
-- count can never pass the limit: when it is already there the UPDATE's WHERE
-- fails, no row comes back from RETURNING, and nothing was written. A separate
-- "read the count, then write" pair would leave a window between the two.
--
-- Limits are read from platform_settings.plans rather than hardcoded, because
-- that is the same row the pricing page reads — change the tier there and the
-- page and the enforcement move together.
-- --------------------------------------------------------------------------
create or replace function public.consume_quota(p_kind text default 'chat')
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid   uuid  := auth.uid();
  v_kind  text  := coalesce(nullif(trim(p_kind), ''), 'chat');
  v_plan  text  := 'free';
  v_limit integer := 0;
  v_used  integer;
  v_day   date  := (now() at time zone 'utc')::date;
begin
  if v_uid is null then
    raise exception 'Sign in first.';
  end if;

  select coalesce(p.plan, 'free') into v_plan
    from public.profiles p
   where p.id = v_uid;

  select coalesce(((value -> coalesce(v_plan, 'free')) ->> 'req_per_day')::integer, 50)
    into v_limit
    from public.platform_settings
   where key = 'plans';

  -- A limit of 0 (or an unreadable plans row) must deny, not grant: defaulting
  -- to "no limit" would turn a config mistake into unlimited usage.
  if coalesce(v_limit, 0) <= 0 then
    return jsonb_build_object('ok', false, 'used', 0, 'limit', coalesce(v_limit, 0), 'plan', v_plan);
  end if;

  insert into public.usage_daily (user_id, day, requests, by_kind)
  values (v_uid, v_day, 1, jsonb_build_object(v_kind, 1))
  on conflict (user_id, day) do update
     set requests   = usage_daily.requests + 1,
         by_kind    = usage_daily.by_kind || jsonb_build_object(
                        v_kind,
                        coalesce((usage_daily.by_kind ->> v_kind)::integer, 0) + 1),
         updated_at = now()
   where usage_daily.requests < v_limit
  returning requests into v_used;

  if v_used is null then
    -- The WHERE rejected the update: already at the limit, nothing written.
    select requests into v_used
      from public.usage_daily
     where user_id = v_uid and day = v_day;
    return jsonb_build_object('ok', false, 'used', coalesce(v_used, 0), 'limit', v_limit, 'plan', v_plan);
  end if;

  return jsonb_build_object('ok', true, 'used', v_used, 'limit', v_limit, 'plan', v_plan);
end;
$$;

-- --------------------------------------------------------------------------
-- 3. profiles — admin writes, including somebody else's row
-- --------------------------------------------------------------------------

drop policy if exists "profiles: admin write" on public.profiles;
create policy "profiles: admin write" on public.profiles
  for update
  using (private.is_admin())
  with check (
    private.is_admin()
    and role in ('admin', 'member')
    and plan in ('free', 'pro', 'team')
  );

-- --------------------------------------------------------------------------
-- 4. payment_claims — the caller's own id, by default
-- --------------------------------------------------------------------------

alter table public.payment_claims
  alter column user_id set default auth.uid();
