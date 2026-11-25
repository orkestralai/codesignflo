-- Self-hosted mode: a team runs CoDesignFlo on its own box (Supabase's open-source stack and our server). The
-- database learns the mode from app_config (key 'mode', value 'selfhost'; no row = CoDesignFlo's cloud, which
-- behaves exactly as before). The box's setup inserts it once, at its first start:
--
--   insert into public.app_config (key, value) values ('mode', 'selfhost')
--   on conflict (key) do update set value = excluded.value;
--
-- In self-hosted mode:
--  1. Billing is off: everyone is a paid designer (billing_state answers 'active'), so no send, design or
--     proposal is ever held (billing_guard_events, proposals_sides and every other check of 'unpaid' pass).
--  2. Sign-up is invite-only (a trigger on auth.users): the first account (the box's admin, made an admin of the
--     dashboard), anyone with a pending invitation to a project, or an email whose domain is listed in
--     app_config 'allowed_domains' (comma-separated, e.g. 'acme.com,acme.io'). Anyone else is refused with
--     "Ask a teammate to invite you". The demo's simulated developer (Alex, made by the server the first time
--     someone tries the demo) is let in with the box's demo key (demo_key(), kept in app_config, service role
--     only); nobody else may make an account at the demo's addresses.
-- Replaced in place; safe to run again. New functions are closed to clients (20261122000000_security): none of
-- these is granted to anon or authenticated (triggers and definer functions call them).

-- ── The mode ────────────────────────────────────────────────────────────────────────────────────────────────

create or replace function public.selfhost() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_config where key = 'mode' and value = 'selfhost');
$$;

-- ── 1. Billing off ──────────────────────────────────────────────────────────────────────────────────────────

-- As 20261119000000_free_sends, with self-hosted first: everyone has a seat there.
create or replace function public.billing_state(p_owner uuid) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if public.selfhost() then return 'active'; end if;
  if public.whitelisted(p_owner) then return 'whitelisted'; end if;
  if public.seat_payer(p_owner) is not null then return 'active'; end if;
  if public.sends_used(p_owner) < public.free_sends() then return 'trial'; end if;
  return 'unpaid';
end;
$$;

-- ── 2. Invite-only sign-up ──────────────────────────────────────────────────────────────────────────────────

-- The demo's simulated developer (mcp/demo.ts) and its kind.
create or replace function public.demo_account(p_email text) returns boolean
language sql immutable as $$
  select lower(coalesce(p_email, '')) like '%@demo.codesignflo.com';
$$;

-- Why an email may make an account on a self-hosted box: 'admin' (the first account), 'invited', 'domain' — or
-- null (refused). p_first: no account exists yet (the demo's not counted).
create or replace function public.selfhost_signup(p_email text, p_first boolean) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  d text := split_part(lower(btrim(coalesce(p_email, ''))), '@', 2);
begin
  if p_first then return 'admin'; end if;
  if e = '' then return null; end if;
  if exists (select 1 from invitations where email = e and accepted_at is null) then return 'invited'; end if;
  if d <> '' and d in (
       select ltrim(lower(btrim(x)), '@') from unnest(string_to_array(coalesce((select value from app_config where key = 'allowed_domains'), ''), ',')) x
       where btrim(x) <> '') then
    return 'domain';
  end if;
  return null;
end;
$$;

-- The box's demo key (made the first time): the server puts it in Alex's user_metadata when it makes him, the
-- only way an account at the demo's addresses gets in. Null in the cloud (nothing changes there).
create or replace function public.demo_key() returns text
language plpgsql security definer set search_path = public as $$
declare
  k text;
begin
  if not public.selfhost() then return null; end if;
  select value into k from app_config where key = 'demo_key';
  if k is null then
    insert into app_config (key, value) values ('demo_key', encode(extensions.gen_random_bytes(24), 'hex')) on conflict (key) do nothing;
    select value into k from app_config where key = 'demo_key';
  end if;
  return k;
end;
$$;

create or replace function public.selfhost_signup_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.selfhost() then return new; end if;
  if public.demo_account(new.email) then
    -- Only the server makes it: its user_metadata carries the box's demo key (nobody signs in as Alex, and
    -- accounts' metadata isn't shown to other people).
    if new.raw_user_meta_data ->> 'codesignflo_demo_key' = (select value from app_config where key = 'demo_key') then return new; end if;
    raise exception 'that address is kept for the demo' using errcode = '42501';
  end if;
  if public.selfhost_signup(new.email, not exists (select 1 from auth.users u where not public.demo_account(u.email))) is null then
    raise exception 'Ask a teammate to invite you: this CoDesignFlo server lets in only people invited to a project (sign up with the email they invited)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists selfhost_signup on auth.users;
create trigger selfhost_signup before insert on auth.users for each row execute function public.selfhost_signup_guard();

-- The first account is the box's admin (the dashboard, adding other admins; admins_free puts them on the free list).
create or replace function public.selfhost_first_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.selfhost() and not public.demo_account(new.email)
     and not exists (select 1 from auth.users u where u.id <> new.id and not public.demo_account(u.email)) then
    insert into admins (user_id) values (new.id) on conflict do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists selfhost_first_admin on auth.users;
create trigger selfhost_first_admin after insert on auth.users for each row execute function public.selfhost_first_admin();

-- ── Who may call them: nobody but the service role (and the triggers) ─────────────────────────────────────

revoke execute on function public.selfhost() from public, anon, authenticated;
revoke execute on function public.demo_account(text) from public, anon, authenticated;
revoke execute on function public.demo_key() from public, anon, authenticated;
revoke execute on function public.selfhost_signup(text, boolean) from public, anon, authenticated;
revoke execute on function public.selfhost_signup_guard() from public, anon, authenticated;
revoke execute on function public.selfhost_first_admin() from public, anon, authenticated;
grant execute on function public.selfhost() to service_role;
grant execute on function public.demo_account(text) to service_role;
grant execute on function public.demo_key() to service_role;
grant execute on function public.selfhost_signup(text, boolean) to service_role;

comment on table public.app_config is
  'notify_url: https://<app>/api/notify; notify_secret: the same value as NOTIFY_SECRET in the deployment; mode: selfhost on a self-hosted box (absent: cloud); allowed_domains: comma-separated email domains that may sign up on a self-hosted box; demo_key: made by demo_key() on a self-hosted box';
