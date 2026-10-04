-- ==========================================================================
-- P2 hardening - move SECURITY DEFINER helpers out of the exposed schema
--
-- Why: /rest/v1/rpc/<fn> only serves functions in schemas PostgREST
-- exposes (public). Leaving SECURITY DEFINER helpers there made all three
-- callable by anyone holding the anon key, which is what the security
-- advisor flagged. Revoking from `anon` alone is not enough - PostgreSQL
-- grants EXECUTE to PUBLIC by default and anon inherits that, so the
-- revoke has to target PUBLIC as well.
--
-- Consequences:
--   * public.is_admin() moves to private.is_admin(); the 9 policies that
--     call it are recreated against the new name.
--   * the two trigger functions move to private too (triggers store the
--     function OID, so the triggers are dropped and recreated).
--   * EXECUTE on private.* is granted to authenticated/service_role/postgres
--     and revoked from PUBLIC and anon.
-- ==========================================================================

create schema if not exists private;

grant usage on schema private to authenticated, service_role, postgres;

-- --------------------------------------------------------------------------
-- 1. relocated is_admin()
-- --------------------------------------------------------------------------
create or replace function private.is_admin()
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

-- --------------------------------------------------------------------------
-- 2. relocate the two trigger functions
--    (dropped and recreated below, together with their triggers)
-- --------------------------------------------------------------------------
create or replace function private.handle_new_user()
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
    set email        = excluded.email,
        display_name = coalesce(excluded.display_name, public.profiles.display_name),
        avatar_url   = coalesce(excluded.avatar_url, public.profiles.avatar_url),
        updated_at   = now();
  return new;
end;
$$;

create or replace function private.guard_profile_elevation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.role <> 'member' or new.plan <> 'free' then
      if (select auth.uid()) is not null and not private.is_admin() then
        raise exception 'New profiles must start as member/free';
      end if;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role
       or new.plan is distinct from old.plan
       or new.plan_expires_at is distinct from old.plan_expires_at then
      if (select auth.uid()) is not null and not private.is_admin() then
        raise exception 'Only an administrator can change plan or role';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- --------------------------------------------------------------------------
-- 3. drop the 9 policies that reference the old function name
-- --------------------------------------------------------------------------
drop policy "profiles: read own or admin"       on public.profiles;
drop policy "workspaces: admin"                 on public.workspaces;
drop policy "conversations: admin"              on public.conversations;
drop policy "files: admin"                      on public.files;
drop policy "payment_claims: read own or admin" on public.payment_claims;
drop policy "payment_claims: admin"             on public.payment_claims;
drop policy "usage_daily: read own or admin"    on public.usage_daily;
drop policy "platform_settings: admin write"    on public.platform_settings;
drop policy "library: read own or admin"        on storage.objects;

drop function public.is_admin();

-- --------------------------------------------------------------------------
-- 4. recreate them against private.is_admin()
-- --------------------------------------------------------------------------
create policy "profiles: read own or admin"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_admin());

create policy "workspaces: admin"
  on public.workspaces for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

create policy "conversations: admin"
  on public.conversations for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

create policy "files: admin"
  on public.files for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

create policy "payment_claims: read own or admin"
  on public.payment_claims for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

create policy "payment_claims: admin"
  on public.payment_claims for update to authenticated
  using (private.is_admin()) with check (private.is_admin());

create policy "usage_daily: read own or admin"
  on public.usage_daily for select to authenticated
  using (user_id = (select auth.uid()) or private.is_admin());

create policy "platform_settings: admin write"
  on public.platform_settings for all to authenticated
  using (private.is_admin()) with check (private.is_admin());

create policy "library: read own or admin"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'library'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or private.is_admin())
  );

-- --------------------------------------------------------------------------
-- 5. swap the triggers over to the relocated functions
-- --------------------------------------------------------------------------
drop trigger on_auth_user_created on auth.users;
drop trigger profiles_guard on public.profiles;

drop function public.handle_new_user();
drop function public.guard_profile_elevation();

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create trigger profiles_guard
  before insert or update on public.profiles
  for each row execute function private.guard_profile_elevation();

-- --------------------------------------------------------------------------
-- 6. lock the exposed surface: PUBLIC and anon lose EXECUTE on everything
--    SECURITY DEFINER; authenticated keeps is_admin (RLS policies run as
--    authenticated and must be able to ask the question).
-- --------------------------------------------------------------------------
revoke execute on function private.is_admin()              from public, anon;
revoke execute on function private.handle_new_user()       from public, anon, authenticated;
revoke execute on function private.guard_profile_elevation() from public, anon, authenticated;

revoke execute on function public.set_updated_at() from public, anon;

grant execute on function private.is_admin() to authenticated, service_role, postgres;
grant execute on function private.handle_new_user() to postgres;
grant execute on function private.guard_profile_elevation() to postgres;
grant execute on function public.set_updated_at() to postgres;

-- --------------------------------------------------------------------------
-- 7. keep updated_at honest
--    conversations_ws_time_idx orders the conversation list by updated_at,
--    so an un-stamped row would strand a conversation at the bottom of the
--    list. Enforced in the database rather than trusted from the client.
-- --------------------------------------------------------------------------
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger workspaces_updated_at
  before update on public.workspaces
  for each row execute function public.set_updated_at();

create trigger conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create trigger files_updated_at
  before update on public.files
  for each row execute function public.set_updated_at();

create trigger payment_claims_updated_at
  before update on public.payment_claims
  for each row execute function public.set_updated_at();

create trigger platform_settings_updated_at
  before update on public.platform_settings
  for each row execute function public.set_updated_at();
