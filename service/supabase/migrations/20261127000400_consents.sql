-- What each person agreed to, and when: the Terms and the Privacy policy (needed to use CoDesignFlo, asked once
-- after signing in, again when they change) and product news by email (optional, theirs to change). Every answer is
-- a row (the history stays); the latest row of a kind is the answer now. Written only through record_consent and
-- set_marketing, as the signed-in person.

create table if not exists public.consents (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('terms', 'privacy', 'marketing')),
  -- The legal pages' version agreed to (their "Last updated" date).
  version text not null,
  granted boolean not null,
  -- Where it was given: the website, or the sign-in page the plugin, the CLI or a coding agent opened.
  source text not null default 'web' check (source in ('web', 'plugin', 'cli', 'agent')),
  at timestamptz not null default now()
);
create index if not exists consents_latest on public.consents (user_id, kind, at desc);
alter table public.consents enable row level security;

drop policy if exists "people read their own consents" on public.consents;
create policy "people read their own consents" on public.consents for select to authenticated using (user_id = auth.uid());
drop policy if exists "admins read consents" on public.consents;
create policy "admins read consents" on public.consents for select to authenticated using (public.is_admin());

-- The Terms' and Privacy policy's current version: changing it asks everyone again.
create or replace function public.legal_version() returns text
language sql immutable as $$ select '2026-11-27'::text $$;
grant execute on function public.legal_version() to anon, authenticated;

create or replace function public.record_consent(p_terms boolean, p_marketing boolean, p_source text default 'web')
returns void
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  src text := case when p_source in ('web', 'plugin', 'cli', 'agent') then p_source else 'web' end;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if not coalesce(p_terms, false) then
    raise exception 'agreeing to the Terms and the Privacy policy is needed to use CoDesignFlo' using errcode = 'P0001';
  end if;
  insert into consents (user_id, kind, version, granted, source) values
    (uid, 'terms', legal_version(), true, src),
    (uid, 'privacy', legal_version(), true, src),
    (uid, 'marketing', legal_version(), coalesce(p_marketing, false), src);
end;
$$;
revoke execute on function public.record_consent(boolean, boolean, text) from public, anon;
grant execute on function public.record_consent(boolean, boolean, text) to authenticated;

-- Product news on or off, any time (the answer at sign-up can be changed).
create or replace function public.set_marketing(p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  insert into consents (user_id, kind, version, granted) values (auth.uid(), 'marketing', legal_version(), coalesce(p_on, false));
end;
$$;
revoke execute on function public.set_marketing(boolean) from public, anon;
grant execute on function public.set_marketing(boolean) to authenticated;

-- The signed-in person's answers now: whether they agreed to the current Terms and Privacy policy, and product news.
create or replace function public.my_consent() returns table (agreed boolean, version text, agreed_at timestamptz, marketing boolean)
language sql stable security definer set search_path = public as $$
  with t as (
    select c.version, c.at from consents c
    where c.user_id = auth.uid() and c.kind = 'terms' and c.granted order by c.at desc, c.id desc limit 1
  ), m as (
    select c.granted from consents c where c.user_id = auth.uid() and c.kind = 'marketing' order by c.at desc, c.id desc limit 1
  )
  select coalesce((select t.version from t) = legal_version(), false), (select t.version from t), (select t.at from t),
         coalesce((select m.granted from m), false);
$$;
revoke execute on function public.my_consent() from public, anon;
grant execute on function public.my_consent() to authenticated;
