-- Plugin versions: the plugin says which version it is when it checks in; the service hands Live updates only to a
-- plugin at least plugin_minimum() (an older one built Live with bugs since fixed), and emails designers whose plugin
-- is behind the newest (once per version). Plugins from before this (0.5.8 and older) don't say their version: they
-- count as older than the minimum, and their calls get a message saying to update.

-- The lowest plugin that may apply Live updates. Raised (by a migration) when an older plugin would build Live wrong.
create or replace function public.plugin_minimum() returns text
language sql immutable as $$ select '0.5.9'::text $$;
grant execute on function public.plugin_minimum() to anon, authenticated;

-- "0.5.10" < "0.6.0": compared number by number; a missing version is older than any.
create or replace function public.version_below(p_version text, p_than text) returns boolean
language sql immutable as $$
  select p_version is null or p_version !~ '^\d+(\.\d+)*$'
    or string_to_array(p_version, '.')::int[] < string_to_array(p_than, '.')::int[];
$$;

alter table public.plugin_presence add column if not exists plugin_version text;

-- Checked in with its version (plugin 0.5.9 and later). The two-argument form stays for older plugins: their
-- version is unknown (null).
create or replace function public.plugin_seen(p_project text, p_file_name text, p_version text) returns void
language sql security definer set search_path = public as $$
  insert into plugin_presence (project_id, user_id, file_name, seen_at, plugin_version)
  select p_project, auth.uid(), p_file_name, now(), left(p_version, 20) where public.is_member(p_project)
  on conflict (project_id, user_id) do update set seen_at = now(), file_name = excluded.file_name, plugin_version = excluded.plugin_version;
$$;
create or replace function public.plugin_seen(p_project text, p_file_name text) returns void
language sql security definer set search_path = public as $$
  insert into plugin_presence (project_id, user_id, file_name, seen_at, plugin_version)
  select p_project, auth.uid(), p_file_name, now(), null where public.is_member(p_project)
  on conflict (project_id, user_id) do update set seen_at = now(), file_name = excluded.file_name, plugin_version = null;
$$;
grant execute on function public.plugin_seen(text, text, text) to authenticated;
grant execute on function public.plugin_seen(text, text) to authenticated;

-- The update a plugin applies next, for a plugin at least the minimum. The one-argument forms (plugins from before
-- versions were sent) refuse with what to do: the message is shown by those plugins as it is.
create or replace function public.take_next_update(p_project text, p_plugin_version text) returns setof public.live_updates
language plpgsql security definer set search_path = public as $$
declare
  newest bigint;
  b text;
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if public.version_below(p_plugin_version, public.plugin_minimum()) then
    raise exception 'Update the CoDesignFlo plugin to % or later to apply Live updates: download it from codesignflo.com/plugin.zip', public.plugin_minimum()
      using errcode = 'P0426';
  end if;
  if exists (
    select 1 from live_updates
    where project_id = p_project and kind in ('live', 'preview') and status = 'applying' and taken_at > now() - interval '10 minutes'
  ) then
    return;
  end if;
  select max(id) into newest from live_updates where project_id = p_project and kind = 'live' and status in ('pending', 'applying');
  if newest is not null then
    update live_updates set status = 'superseded'
    where project_id = p_project and kind = 'live' and status in ('pending', 'applying') and id < newest;
  else
    select id, branch into newest, b from live_updates
    where project_id = p_project and kind = 'preview' and status in ('pending', 'applying')
    order by id desc limit 1;
    if newest is null then return; end if;
    update live_updates set status = 'superseded'
    where project_id = p_project and kind = 'preview' and branch is not distinct from b and status in ('pending', 'applying') and id < newest;
  end if;
  return query
    update live_updates set status = 'applying', taken_at = now(), taken_by = auth.uid()
    where id = newest returning *;
end;
$$;
grant execute on function public.take_next_update(text, text) to authenticated;

create or replace function public.take_next_update(p_project text) returns setof public.live_updates
language plpgsql security definer set search_path = public as $$
begin
  return query select * from public.take_next_update(p_project, null);
end;
$$;
create or replace function public.take_update(p_project text) returns setof public.live_updates
language plpgsql security definer set search_path = public as $$
begin
  return query select * from public.take_next_update(p_project, null);
end;
$$;

-- Designers told about a plugin version (by email, once per version).
create table if not exists public.plugin_update_notices (
  user_id uuid not null references auth.users (id) on delete cascade,
  version text not null,
  at timestamptz not null default now(),
  primary key (user_id, version)
);
alter table public.plugin_update_notices enable row level security;
revoke all on public.plugin_update_notices from anon, authenticated;

-- Who to email about plugin p_latest (the service's cron only): people who opened the plugin in the last 90 days,
-- whose newest plugin there is older, who haven't turned emails off, and who weren't told about it yet.
create or replace function public.plugin_update_recipients(p_latest text, p_limit int default 100)
returns table (user_id uuid, email text, version text, too_old boolean)
language sql stable security definer set search_path = public as $$
  with seen as (
    select pp.user_id,
           (array_agg(pp.plugin_version order by pp.seen_at desc))[1] as version
    from plugin_presence pp
    where pp.seen_at > now() - interval '90 days'
    group by pp.user_id
  )
  select s.user_id, u.email::text, s.version, public.version_below(s.version, public.plugin_minimum())
  from seen s
  join auth.users u on u.id = s.user_id
  left join profiles p on p.id = s.user_id
  where u.email is not null
    and public.version_below(s.version, p_latest)
    and coalesce(p.notify_email, true)
    and not exists (select 1 from plugin_update_notices n where n.user_id = s.user_id and n.version = p_latest)
  limit p_limit;
$$;
revoke execute on function public.plugin_update_recipients(text, int) from public, anon, authenticated;
