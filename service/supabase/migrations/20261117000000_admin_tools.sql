-- CoDesignFlo's admins manage admins and the free list from the admin app (Billing), or from a terminal with
-- scripts/admin.mjs (the service role key). Every call checks that the caller is an admin (or the service role).
-- A new admin is also put on the free list.

create or replace function public.admin_caller() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or coalesce(auth.role(), '') = 'service_role';
$$;

-- 1. A new admin never pays.
create or replace function public.admins_free() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into billing_whitelist (email, note, added_by)
  select lower(u.email), 'CoDesignFlo admin', auth.uid() from auth.users u where u.id = new.user_id and u.email is not null
  on conflict do nothing;
  return null;
end;
$$;
drop trigger if exists admins_free on public.admins;
create trigger admins_free after insert on public.admins for each row execute function public.admins_free();

-- 2. Admins and the free list, together.
create or replace function public.admin_people()
returns table (email text, admin boolean, free boolean, note text, added_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.admin_caller() then raise exception 'admins only'; end if;
  return query
    with a as (select lower(u.email) as email, ad.added_at from admins ad join auth.users u on u.id = ad.user_id)
    select coalesce(a.email, w.email), a.email is not null, w.email is not null, w.note, coalesce(a.added_at, w.added_at)
    from a full join billing_whitelist w on w.email = a.email
    order by 2 desc, 1;
end;
$$;
grant execute on function public.admin_people to authenticated, service_role;

-- 3. Make someone an admin (they must have signed in once) — and so free.
create or replace function public.admin_add(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
begin
  if not public.admin_caller() then raise exception 'admins only'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception '% has no CoDesignFlo account yet — they sign in once first (web app, plugin or CLI)', p_email; end if;
  if exists (select 1 from admins where user_id = uid) then return 'already'; end if;
  insert into admins (user_id) values (uid);
  return 'added';
end;
$$;
grant execute on function public.admin_add to authenticated, service_role;

-- 4. No longer an admin (they stay on the free list; never the last admin).
create or replace function public.admin_remove(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid;
begin
  if not public.admin_caller() then raise exception 'admins only'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null or not exists (select 1 from admins where user_id = uid) then return 'not_admin'; end if;
  if (select count(*) from admins) = 1 then raise exception 'that''s the last admin — add another one first'; end if;
  delete from admins where user_id = uid;
  return 'removed';
end;
$$;
grant execute on function public.admin_remove to authenticated, service_role;

-- 5. The free list (no account needed: it applies once they sign up).
create or replace function public.free_add(p_email text, p_note text default null) returns text
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(p_email));
begin
  if not public.admin_caller() then raise exception 'admins only'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'not an email: %', p_email; end if;
  insert into billing_whitelist (email, note, added_by) values (e, p_note, auth.uid())
  on conflict (email) do update set note = coalesce(excluded.note, billing_whitelist.note);
  return 'added';
end;
$$;
grant execute on function public.free_add to authenticated, service_role;

create or replace function public.free_remove(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(p_email));
begin
  if not public.admin_caller() then raise exception 'admins only'; end if;
  delete from billing_whitelist where email = e;
  return case when found then 'removed' else 'not_free' end;
end;
$$;
grant execute on function public.free_remove to authenticated, service_role;
