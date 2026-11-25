-- Self-hosted sign-up, hardened (security review of 20261124000000_selfhost). Nothing changes in CoDesignFlo's
-- cloud: every check below starts with selfhost(), false there.
--
--  1. Owning the email is proven before it counts. On a box whose Auth confirms addresses by email (SMTP set and
--     EMAIL_AUTOCONFIRM=false: app_config 'email_proof' = 'true', written by the box's setup), an invitation or an
--     allowed domain lets the address sign up, and the account works once its link is opened. On any other box,
--     nothing proves the address, so an invitation needs its sign-up code (made with the invitation, seen only by
--     whoever invited and the project's admins: invitation_code()), given at sign-up in the user metadata
--     ('codesignflo_code'); allowed domains count only with email proof.
--  2. The first account needs the box's setup code (SETUP_CODE in .env, app_config 'setup_code'): whoever reaches a
--     fresh box first doesn't become its admin. It is "first" while the box has no admin, and sign-ups queue on a
--     lock, so two at once can't both be first.
--  3. An account's email can't be changed on a box (it's what invitations match).
--  4. One answer for every refusal: it doesn't tell whether an address is invited.
-- Replaced in place; safe to run again.

-- ── Sign-up codes ───────────────────────────────────────────────────────────────────────────────────────────

-- Kept apart from invitations (which every member of the project reads): no client reads this table.
create table if not exists public.invitation_codes (
  project_id text not null,
  email text not null,
  code text not null,
  created_at timestamptz not null default now(),
  primary key (project_id, email),
  foreign key (project_id, email) references public.invitations (project_id, email) on delete cascade
);
alter table public.invitation_codes enable row level security;
revoke all on public.invitation_codes from public, anon, authenticated;

-- 8 letters and digits, without the look-alikes (0/O, 1/I/L), shown as XXXX-XXXX.
create or replace function public.new_signup_code() returns text
language plpgsql volatile as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  b bytea := extensions.gen_random_bytes(8);
  v_out text := '';
begin
  for i in 0..7 loop
    v_out := v_out || substr(alphabet, (get_byte(b, i) % length(alphabet)) + 1, 1);
    if i = 3 then v_out := v_out || '-'; end if;
  end loop;
  return v_out;
end;
$$;

-- Every invitation on a box gets a code (the first time; inviting again keeps it).
create or replace function public.invitation_code_make() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.selfhost() then
    insert into invitation_codes (project_id, email, code) values (new.project_id, new.email, public.new_signup_code())
    on conflict (project_id, email) do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists invitation_code_make on public.invitations;
create trigger invitation_code_make after insert or update on public.invitations for each row execute function public.invitation_code_make();

-- Whether this box proves email addresses (see 1).
create or replace function public.selfhost_email_proof() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value from app_config where key = 'email_proof'), '') = 'true';
$$;

-- A pending invitation's sign-up code, for whoever invited that email or an admin of the project; null otherwise,
-- or when the box doesn't need codes (it proves emails, or it's the cloud).
create or replace function public.invitation_code(p_project text, p_email text) returns text
language sql stable security definer set search_path = public as $$
  select c.code from invitation_codes c join invitations i using (project_id, email)
  where public.selfhost() and not public.selfhost_email_proof()
    and c.project_id = p_project and c.email = lower(btrim(p_email)) and i.accepted_at is null
    and (i.invited_by = auth.uid() or public.is_member(p_project, array['admin']));
$$;

-- ── Who may sign up ─────────────────────────────────────────────────────────────────────────────────────────

-- Why an email may make an account on a box: 'admin' (the setup code, while there's no admin), 'invited',
-- 'domain', or null (refused). p_code: what the person typed as their code (setup or invitation).
drop function if exists public.selfhost_signup(text, boolean);
create or replace function public.selfhost_signup(p_email text, p_code text) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  e text := lower(btrim(coalesce(p_email, '')));
  d text := split_part(lower(btrim(coalesce(p_email, ''))), '@', 2);
  v_code text := upper(btrim(coalesce(p_code, '')));
  setup text := (select value from app_config where key = 'setup_code');
begin
  if e = '' then return null; end if;
  if not exists (select 1 from admins) then
    if setup is not null and setup <> '' and v_code = upper(btrim(setup)) then return 'admin'; end if;
    return null;
  end if;
  if public.selfhost_email_proof() then
    if exists (select 1 from invitations where email = e and accepted_at is null) then return 'invited'; end if;
    if d <> '' and d in (
         select ltrim(lower(btrim(x)), '@') from unnest(string_to_array(coalesce((select value from app_config where key = 'allowed_domains'), ''), ',')) x
         where btrim(x) <> '') then
      return 'domain';
    end if;
    return null;
  end if;
  if v_code <> '' and exists (
       select 1 from invitation_codes c join invitations i using (project_id, email)
       where c.email = e and i.accepted_at is null and c.code = v_code) then
    return 'invited';
  end if;
  return null;
end;
$$;

create or replace function public.selfhost_signup_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.selfhost() then return new; end if;
  if public.demo_account(new.email) then
    -- Only the server makes it: its user_metadata carries the box's demo key.
    if new.raw_user_meta_data ->> 'codesignflo_demo_key' = (select value from app_config where key = 'demo_key') then return new; end if;
    raise exception 'that address is kept for the demo' using errcode = '42501';
  end if;
  -- One sign-up at a time: "no admin yet" is decided once.
  perform pg_advisory_xact_lock(hashtext('codesignflo.selfhost_signup'));
  if public.selfhost_signup(new.email, new.raw_user_meta_data ->> 'codesignflo_code') is null then
    raise exception 'Ask a teammate to invite you: this CoDesignFlo server lets in only people invited to a project'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists selfhost_signup on auth.users;
create trigger selfhost_signup before insert on auth.users for each row execute function public.selfhost_signup_guard();

-- The account made with the setup code, while the box has no admin, is its admin.
create or replace function public.selfhost_first_admin() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  setup text := (select value from app_config where key = 'setup_code');
begin
  if public.selfhost() and not public.demo_account(new.email) and not exists (select 1 from admins)
     and setup is not null and setup <> ''
     and upper(btrim(coalesce(new.raw_user_meta_data ->> 'codesignflo_code', ''))) = upper(btrim(setup)) then
    insert into admins (user_id) values (new.id) on conflict do nothing;
  end if;
  return null;
end;
$$;
drop trigger if exists selfhost_first_admin on auth.users;
create trigger selfhost_first_admin after insert on auth.users for each row execute function public.selfhost_first_admin();

-- ── 3. No email changes on a box ────────────────────────────────────────────────────────────────────────────

create or replace function public.selfhost_email_change_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.selfhost() and (new.email is distinct from old.email or coalesce(new.email_change, '') <> '') then
    raise exception 'on this CoDesignFlo server an account''s email can''t be changed: ask the admin for a new account'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists selfhost_email_change on auth.users;
create trigger selfhost_email_change before update of email, email_change on auth.users
  for each row execute function public.selfhost_email_change_guard();

-- ── Who may call them ───────────────────────────────────────────────────────────────────────────────────────

revoke execute on function public.new_signup_code() from public, anon, authenticated;
revoke execute on function public.invitation_code_make() from public, anon, authenticated;
revoke execute on function public.selfhost_email_proof() from public, anon, authenticated;
revoke execute on function public.selfhost_signup(text, text) from public, anon, authenticated;
revoke execute on function public.selfhost_signup_guard() from public, anon, authenticated;
revoke execute on function public.selfhost_first_admin() from public, anon, authenticated;
revoke execute on function public.selfhost_email_change_guard() from public, anon, authenticated;
revoke execute on function public.invitation_code(text, text) from public, anon;
grant execute on function public.invitation_code(text, text) to authenticated, service_role;
grant execute on function public.selfhost_email_proof() to service_role;
grant all on public.invitation_codes to service_role;
