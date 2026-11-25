-- Branch previews: a developer's sync on a feature branch (committed) can upload a preview of it, which the
-- plugin builds in a "Branch: <name>" section on the Live page — only what differs from Live, nothing recorded
-- in the history. Replaced by the branch's next preview; taken out of Figma when the branch is merged.
alter table public.live_updates drop constraint if exists live_updates_kind_check;
alter table public.live_updates add constraint live_updates_kind_check check (kind in ('live', 'check', 'preview'));

drop policy "developers upload updates" on public.live_updates;
create policy "developers upload updates" on public.live_updates for insert
  with check (
    public.is_member(project_id, array['admin', 'developer']) and created_by = auth.uid()
    and ((kind in ('live', 'preview') and status = 'pending') or (kind = 'check' and status = 'checked'))
  );

drop index if exists public.live_updates_pending;
create index live_updates_pending on public.live_updates (project_id, id) where kind in ('live', 'preview') and status in ('pending', 'applying');

-- The next update for an open plugin: Live first (the newest; older ones superseded, as before), else the
-- newest preview of a branch (older previews of that branch superseded). One at a time per project.
-- take_update (Live only) stays for plugins from before previews, which would build a preview as Live.
create or replace function public.take_next_update(p_project text) returns setof public.live_updates
language plpgsql security definer set search_path = public as $$
declare
  newest bigint;
  b text;
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
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
grant execute on function public.take_next_update to authenticated;

-- Plugins from before previews: Live updates only (unchanged otherwise), so they never build a preview as Live.
create or replace function public.take_update(p_project text) returns setof public.live_updates
language plpgsql security definer set search_path = public as $$
declare
  newest bigint;
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if exists (
    select 1 from live_updates
    where project_id = p_project and kind in ('live', 'preview') and status = 'applying' and taken_at > now() - interval '10 minutes'
  ) then
    return;
  end if;
  select max(id) into newest from live_updates where project_id = p_project and kind = 'live' and status in ('pending', 'applying');
  if newest is null then return; end if;
  update live_updates set status = 'superseded' where project_id = p_project and kind = 'live' and status in ('pending', 'applying') and id < newest;
  return query
    update live_updates set status = 'applying', taken_at = now(), taken_by = auth.uid()
    where id = newest returning *;
end;
$$;
