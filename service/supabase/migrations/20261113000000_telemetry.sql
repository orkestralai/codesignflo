-- What happens in projects, so CoDesignFlo's own team sees what to improve: crashes, where Live differs from
-- the app, how long each step takes, which versions run, and reports coding agents file. Rows hold structure
-- and numbers only (a signature to group by, sizes, timings, versions), never the app's content; a project's
-- content (full logs, a page's layers or screenshot) is kept only when the project shares it (opt-in, off by
-- default), in a private bucket. Read by CoDesignFlo's admins only (the admin dashboard); kept 90 days.

-- 1. CoDesignFlo's admins: who sees the dashboard (added by hand; no way to add one from the app).
create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.admins enable row level security;
drop policy if exists "admins see themselves" on public.admins;
create policy "admins see themselves" on public.admins for select to authenticated using (user_id = auth.uid());

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where user_id = auth.uid());
$$;
grant execute on function public.is_admin to authenticated;

insert into public.admins (user_id)
select id from auth.users where lower(email) = 'admin@example.com'
on conflict do nothing;

-- Whether a project shares its content (see 3).
create or replace function public.shares_content(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (settings ->> 'shareContent')::boolean from projects where id = p), false);
$$;
grant execute on function public.shares_content to authenticated;

-- 2. Events.
create table if not exists public.telemetry (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  project_id text references public.projects (id) on delete cascade,
  user_id uuid default auth.uid() references auth.users (id) on delete set null,
  source text not null check (source in ('cli', 'plugin', 'mcp', 'agent')),
  kind text not null check (kind in ('crash', 'error', 'gap', 'timing', 'setup', 'report')),
  -- What groups like events: "compile: Cannot read properties of undefined (reading '<x>')",
  -- "text wraps or breaks differently", "sync.render". Numbers and the app's words are taken out.
  signature text not null check (length(signature) <= 300),
  version text check (length(version) <= 40),
  -- Structure and numbers (sizes, durations, counts, versions; a report's own words).
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) <= 32768),
  -- The project's content, when it shares it: a path in the telemetry bucket.
  content text check (content is null or content ~ '^[a-z0-9_]+/[A-Za-z0-9._-]+$')
);
create index if not exists telemetry_at on public.telemetry (at desc);
create index if not exists telemetry_kind_signature on public.telemetry (kind, signature, at desc);
create index if not exists telemetry_project on public.telemetry (project_id, at desc);
alter table public.telemetry enable row level security;

-- Anyone signed in records their own events, for projects they're in (or none: a crash before init).
drop policy if exists "members record telemetry" on public.telemetry;
create policy "members record telemetry" on public.telemetry for insert to authenticated
  with check (
    user_id = auth.uid()
    and (project_id is null or public.is_member(project_id))
    and (content is null or (split_part(content, '/', 1) = project_id and public.shares_content(project_id)))
  );
drop policy if exists "admins read telemetry" on public.telemetry;
create policy "admins read telemetry" on public.telemetry for select to authenticated using (public.is_admin());

-- 3. Content, opt-in per project (the project's admins and developers switch it on).
create or replace function public.set_share_content(p_project text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_project, array['admin', 'developer']) then
    raise exception 'only the project''s admins and developers choose whether it shares content';
  end if;
  update projects set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('shareContent', p_on) where id = p_project;
end;
$$;
grant execute on function public.set_share_content to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('telemetry', 'telemetry', false, 10485760, array['application/json', 'text/plain', 'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "sharing members add telemetry content" on storage.objects;
create policy "sharing members add telemetry content" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'telemetry'
    and public.is_member((storage.foldername(name))[1])
    and public.shares_content((storage.foldername(name))[1])
  );
drop policy if exists "admins read telemetry content" on storage.objects;
create policy "admins read telemetry content" on storage.objects for select to authenticated
  using (bucket_id = 'telemetry' and public.is_admin());

-- 4. The dashboard: events grouped by signature over the last days (admins only).
create or replace function public.telemetry_summary(p_days int default 7)
returns table (
  kind text,
  signature text,
  source text,
  events bigint,
  projects bigint,
  first_at timestamptz,
  last_at timestamptz,
  versions text[],
  previous bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query
    select t.kind, t.signature, t.source,
      count(*) filter (where t.at >= now() - make_interval(days => p_days)),
      count(distinct t.project_id) filter (where t.at >= now() - make_interval(days => p_days)),
      min(t.at) filter (where t.at >= now() - make_interval(days => p_days)),
      max(t.at) filter (where t.at >= now() - make_interval(days => p_days)),
      array_remove(array_agg(distinct t.version) filter (where t.at >= now() - make_interval(days => p_days)), null),
      -- The days before, as long again: is it new, growing, going away?
      count(*) filter (where t.at < now() - make_interval(days => p_days))
    from telemetry t
    where t.at >= now() - make_interval(days => 2 * p_days)
    group by t.kind, t.signature, t.source
    having count(*) filter (where t.at >= now() - make_interval(days => p_days)) > 0
    order by 5 desc, 4 desc;
end;
$$;
grant execute on function public.telemetry_summary to authenticated;

-- Durations by step (median and slowest), for the dashboard's speed view.
create or replace function public.telemetry_timings(p_days int default 7)
returns table (source text, signature text, runs bigint, median_ms double precision, p95_ms double precision, max_ms double precision)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query
    select t.source, t.signature, count(*),
      percentile_cont(0.5) within group (order by (t.data ->> 'ms')::double precision),
      percentile_cont(0.95) within group (order by (t.data ->> 'ms')::double precision),
      max((t.data ->> 'ms')::double precision)
    from telemetry t
    where t.kind = 'timing' and t.at >= now() - make_interval(days => p_days) and t.data ? 'ms'
    group by t.source, t.signature
    order by 5 desc;
end;
$$;
grant execute on function public.telemetry_timings to authenticated;

-- 5. Progress: whether Figma is in the background (the developer is told to bring it to the front). A version
-- with one more argument, next to the four-argument one that plugins before this one still call.
create or replace function public.update_progress(p_id bigint, p_done int, p_total int, p_item text, p_background boolean)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update live_updates
    set progress = jsonb_build_object('done', p_done, 'total', p_total, 'item', p_item, 'background', p_background), taken_at = now()
  where id = p_id and status = 'applying' and taken_by = auth.uid();
  if not found then raise exception 'this update is not being applied by you'; end if;
end;
$$;
grant execute on function public.update_progress(bigint, int, int, text, boolean) to authenticated;

-- 6. Kept 90 days (the bucket's files are removed by the service's cleanup: storage files go through its API).
create or replace function public.cleanup_telemetry() returns void
language sql security definer set search_path = public as $$
  delete from telemetry where at < now() - interval '90 days';
$$;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('codesignflo-telemetry-cleanup', '17 3 * * *', 'select public.cleanup_telemetry()');
  end if;
exception when others then
  raise notice 'pg_cron not available (%): telemetry is cleaned up by hand', sqlerrm;
end;
$$;

-- 7. Project names for the dashboard (admins see every project's name, nothing else of it).
create or replace function public.admin_projects()
returns table (id text, name text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query select p.id, p.name, p.created_at from projects p;
end;
$$;
grant execute on function public.admin_projects to authenticated;
