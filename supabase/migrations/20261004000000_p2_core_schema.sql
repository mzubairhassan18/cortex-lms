-- ==========================================================================
-- P2 core schema — Cortex
--
-- Replaces the local JSON store (data/*.json) with Postgres.
-- Design rules applied (from .agents/skills/supabase-postgres-best-practices):
--   * row-level security is enabled on EVERY table, from row one
--   * policies wrap auth.uid() in a scalar subselect so it is evaluated
--     once per statement, not once per row
--   * every column referenced by a policy is indexed
--   * lowercase snake_case identifiers, text/timestamptz/boolean types
--   * conservative data model: the big blobs (messages, explains, summary,
--     quiz, tests, notes) stay JSONB on `conversations` because the app
--     always loads a conversation whole — normalising them would buy
--     nothing and cost joins on every read.
--
-- Deliberate exception: `profiles` is NOT forced. FORCE would make the
-- table owner (`postgres`) subject to RLS, which breaks (a) the signup
-- bootstrap trigger — auth.uid() is not reliably set while GoTrue is
-- inserting auth.users — and (b) is_admin(), which is SECURITY DEFINER
-- and runs as the owner. `anon` and `authenticated` remain fully
-- restricted by RLS; only the owner is exempt, and the owner can already
-- `alter table` anything. Every other table is forced.
-- ==========================================================================

-- --------------------------------------------------------------------------
-- 1. profiles — one row per auth.users row
-- --------------------------------------------------------------------------
create table public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text,
  display_name    text,
  avatar_url      text,
  role            text   not null default 'member',
  plan            text   not null default 'free',
  plan_expires_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint profiles_role_check check (role in ('member', 'admin')),
  constraint profiles_plan_check check (plan in ('free', 'pro', 'team'))
);

-- --------------------------------------------------------------------------
-- 2. shared helpers
-- --------------------------------------------------------------------------

-- SECURITY DEFINER: lets policies on OTHER tables ask "is this caller an
-- admin?" without recursing through profiles' own policies.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- --------------------------------------------------------------------------
-- 3. automatic profile row on signup (Google OAuth and email alike)
-- --------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      nullif(split_part(coalesce(new.email, ''), '@', 1), '')
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do update
    set email       = excluded.email,
        display_name = coalesce(excluded.display_name, public.profiles.display_name),
        avatar_url   = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at   = now();
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------------------
-- 4. no self-elevation: a signed-in user may update their own row, but may
--    never change role/plan. The guard allows non-user contexts (the owner
--    running migration SQL, and service_role) because those are how admin
--    plan changes are applied.
-- --------------------------------------------------------------------------
create or replace function public.guard_profile_elevation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.role <> 'member' or new.plan <> 'free' then
      if (select auth.uid()) is not null and not public.is_admin() then
        raise exception 'New profiles must start as member/free';
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role
       or new.plan is distinct from old.plan
       or new.plan_expires_at is distinct from old.plan_expires_at then
      if (select auth.uid()) is not null and not public.is_admin() then
        raise exception 'Only an administrator can change plan or role';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_guard
  before insert or update on public.profiles
  for each row execute function public.guard_profile_elevation();

-- --------------------------------------------------------------------------
-- 5. workspaces
-- --------------------------------------------------------------------------
create table public.workspaces (
  id         text primary key,          -- app-generated 12-char id, kept so the
                                        -- local -> remote migration needs no remapping
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null check (length(name) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workspaces_user_idx on public.workspaces (user_id);

-- --------------------------------------------------------------------------
-- 6. conversations — header columns are queryable, the payload is JSONB
-- --------------------------------------------------------------------------
create table public.conversations (
  id           text primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  title        text not null default 'New chat',
  messages     jsonb not null default '[]'::jsonb,
  explains     jsonb not null default '{}'::jsonb,
  summary      jsonb,
  quiz         jsonb,
  tests        jsonb not null default '[]'::jsonb,
  notes        jsonb not null default '[]'::jsonb,
  archived     boolean not null default false,   -- replaces conversations.deleted.json
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index conversations_user_idx     on public.conversations (user_id);
create index conversations_ws_time_idx  on public.conversations (workspace_id, updated_at desc);
-- no GIN index on the JSONB payloads: they are never filtered on,
-- only read whole, and a GIN index over chat history would be pure bloat.

-- --------------------------------------------------------------------------
-- 7. files — library documents
--    text is the product (read constantly, stored in Postgres where API
--    reads are unmetered); the original bytes live in Storage and, on the
--    Free plan, are not kept at all (storage_path stays null).
-- --------------------------------------------------------------------------
create table public.files (
  id              text primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  conversation_id text references public.conversations (id) on delete cascade,
  name            text not null,
  ext             text,
  kind            text not null default 'upload',
  mime            text,
  chars           integer not null default 0,
  text            text not null default '',      -- extracted content
  link_url        text,                          -- kind = 'link'
  storage_path    text,                          -- null = text-only (Free plan)
  stored_bytes    bigint not null default 0,     -- bytes actually in Storage
  original_bytes  bigint not null default 0,     -- size of the user's file
  constraint files_kind_check check (kind in ('upload', 'link'))
);
create index files_user_idx  on public.files (user_id);
create index files_conv_idx  on public.files (conversation_id);

-- --------------------------------------------------------------------------
-- 8. payment_claims — bank transfer receipts awaiting admin approval
--    No Stripe: the user transfers money manually, then claims it here.
-- --------------------------------------------------------------------------
create table public.payment_claims (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  tier           text not null check (tier in ('pro', 'team')),
  amount_cents   integer not null check (amount_cents > 0),
  currency       text not null default 'USD',
  reference      text not null,                   -- transfer reference the user typed
  status         text not null default 'pending',
  admin_note     text,
  reviewed_by    uuid references auth.users (id) on delete set null,
  reviewed_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint payment_claims_status_check check (status in ('pending', 'approved', 'rejected')),
  constraint payment_claims_reviewed_check
    check ((status = 'pending') = (reviewed_at is null))
);
create index payment_claims_user_idx   on public.payment_claims (user_id);
create index payment_claims_status_idx on public.payment_claims (status);

-- --------------------------------------------------------------------------
-- 9. usage_daily — the meter behind the free-tier limits
--    A rollup, not an event log: one row per user per day. An event table
--    would be ~100x bigger for the same answers, and the 500 MB database
--    is our tightest resource.
-- --------------------------------------------------------------------------
create table public.usage_daily (
  user_id    uuid not null references auth.users (id) on delete cascade,
  day        date not null default ((now() at time zone 'utc')::date),
  requests   integer not null default 0,
  by_kind    jsonb not null default '{}'::jsonb,  -- {"chat": 12, "explain": 3}
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
create index usage_daily_day_idx on public.usage_daily (day);

-- --------------------------------------------------------------------------
-- 10. platform_settings — public config only. Never secrets: anything the
--     Edge Function needs stays in its environment variables.
-- --------------------------------------------------------------------------
create table public.platform_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Seed before RLS is forced so the owner can write it in this migration.
insert into public.platform_settings (key, value) values
('plans', '{
  "free": {"name":"Free","price":0,"period":"forever","req_per_day":50,"conversations":10,"workspaces":1,"storage_mb":50,"seats":1},
  "pro":  {"name":"Pro","price":9,"period":"month","req_per_day":500,"conversations":null,"workspaces":10,"storage_mb":1024,"seats":1},
  "team": {"name":"Team","price":29,"period":"month","req_per_day":2000,"conversations":null,"workspaces":null,"storage_mb":10240,"seats":10}
}'::jsonb),
('bank_details', '{
  "account_name":"","account_number":"","bank":"","branch":"",
  "swift":"","currency":"USD",
  "reference_note":"Use your Cortex user ID as the payment reference."
}'::jsonb),
('payment_notice', '{
  "title":"Pay by bank transfer",
  "body":"Online card payment is not set up yet. Transfer the amount to the account below, then click “I have paid” — an administrator approves it and your plan is activated, usually the same day."
}'::jsonb),
('supabase_limits', '{
  "database_mb":500,"storage_mb":1024,"egress_mb":5120,"egress_cached_mb":5120,
  "edge_invocations":500000,"auth_mau":50000,"max_file_mb":50,
  "max_projects":2,"pause_after_idle_days":7
}'::jsonb);

-- --------------------------------------------------------------------------
-- 11. row-level security
-- --------------------------------------------------------------------------
alter table public.profiles         enable row level security;
alter table public.workspaces       enable row level security;
alter table public.conversations    enable row level security;
alter table public.files            enable row level security;
alter table public.payment_claims   enable row level security;
alter table public.usage_daily      enable row level security;
alter table public.platform_settings enable row level security;

-- ...and force everywhere except profiles (see the note at the top).
alter table public.workspaces       force row level security;
alter table public.conversations    force row level security;
alter table public.files            force row level security;
alter table public.payment_claims   force row level security;
alter table public.usage_daily      force row level security;
alter table public.platform_settings force row level security;

-- profiles
create policy "profiles: read own or admin"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

create policy "profiles: write own"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy "profiles: bootstrap"
  on public.profiles for insert to public
  with check (
    role = 'member'
    and plan = 'free'
    and exists (select 1 from auth.users u where u.id = profiles.id)
  );

-- workspaces
create policy "workspaces: all own"
  on public.workspaces for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "workspaces: admin"
  on public.workspaces for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- conversations
create policy "conversations: all own"
  on public.conversations for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "conversations: admin"
  on public.conversations for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- files
create policy "files: all own"
  on public.files for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "files: admin"
  on public.files for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- payment_claims: users file and read their own, only admins adjudicate
create policy "payment_claims: read own or admin"
  on public.payment_claims for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

create policy "payment_claims: file own"
  on public.payment_claims for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and reviewed_at is null
  );

create policy "payment_claims: admin"
  on public.payment_claims for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- usage_daily: users see their own meter, admins see every meter
create policy "usage_daily: read own or admin"
  on public.usage_daily for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin());

-- Writes come from the Edge Function (service_role, bypasses RLS), so no
-- insert/update policy is granted to users — they cannot inflate their own
-- counter or defuse someone else's.

-- platform_settings: readable config for signed-in users, admin-writable
create policy "platform_settings: read"
  on public.platform_settings for select to authenticated
  using (true);

create policy "platform_settings: admin write"
  on public.platform_settings for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- --------------------------------------------------------------------------
-- 12. least privilege: the anon role never touches application tables.
--     Everything the app does happens behind a login.
-- --------------------------------------------------------------------------
revoke all on all tables   in schema public from anon;
revoke all on all sequences in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;

revoke execute on function public.is_admin() from anon;
revoke execute on function public.set_updated_at() from anon;
revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.guard_profile_elevation() from anon;

grant execute on function public.is_admin() to authenticated;

-- --------------------------------------------------------------------------
-- 13. storage — private `library` bucket for original files
--     path: <auth.uid()>/<conversation_id>/<file_id>
-- --------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('library', 'library', false, 52428800)   -- 50 MB, Supabase Free's own cap
on conflict (id) do nothing;

create policy "library: read own or admin"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'library'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin())
  );

create policy "library: write own"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "library: replace own"
  on storage.objects for update to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "library: delete own"
  on storage.objects for delete to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid())::text);
