-- ==========================================================================
-- P2 — BYOK columns on profiles
--
-- PLAN 3.1: "each user stores their own provider + API key in their
-- profile. No shared server key, no cost to the operator."
--
-- This mirrors the local data/settings.json shape
--   { provider, apiKey, baseUrl, keys }
-- that server.js's providerConf() reads, so porting the proxy to an Edge
-- Function is a read-from-a-different-place change rather than a redesign.
--
-- ON STORING THE KEY IN CLEARTEXT
-- The value has to be readable by something that can then call the provider
-- on the user's behalf, so it is either here or in a secret manager we do
-- not have on the free tier. RLS is the boundary: the only SELECT policy on
-- profiles is "read own or admin", so a key is visible to its owner and to
-- the operator. That is the same exposure as any server-side BYOK store.
-- Hardening later: encrypt with a key held in Supabase Vault, which costs a
-- column swap and gives up indexing - not worth it until there is a reason.
--
-- Nothing here is exposed to `anon`: every table privilege was revoked from
-- anon in 20261004000000, and profiles carries FORCE-adjacent restrictions
-- (RLS enabled, not forced - see PLAN 3.3 for why).
-- ==========================================================================

alter table public.profiles
  add column provider      text   not null default 'auto',
  add column api_key       text,
  add column base_url      text   not null default '',
  add column provider_keys jsonb  not null default '{}'::jsonb;

comment on column public.profiles.provider is
  'Active provider id (PROVIDERS key in server.js); ''auto'' is the pseudo-provider that failovers.';
comment on column public.profiles.api_key is
  'BYOK key for `provider`. Plain text by choice - see header. Readable only via the read-own-or-admin RLS policy.';
comment on column public.profiles.base_url is
  'Custom endpoint, only meaningful when provider is custom.';
comment on column public.profiles.provider_keys is
  'Saved key per provider id, so Auto routing can reuse any key the user has entered. Shape: { "<provider>": "<key>" }.';
