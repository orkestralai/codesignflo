-- Uploads from code are either a Live update (from the Live branch, committed code) or a check (any other
-- branch, or uncommitted changes): a check only records how far the code is with each proposal.
alter table public.live_updates add column kind text not null default 'live' check (kind in ('live', 'check'));
alter table public.live_updates drop constraint live_updates_status_check;
alter table public.live_updates add constraint live_updates_status_check
  check (status in ('pending', 'applying', 'applied', 'failed', 'superseded', 'checked'));
drop policy "developers upload updates" on public.live_updates;
create policy "developers upload updates" on public.live_updates for insert
  with check (
    public.is_member(project_id, array['admin', 'developer']) and created_by = auth.uid()
    and ((kind = 'live' and status = 'pending') or (kind = 'check' and status = 'checked'))
  );
drop index public.live_updates_pending;
create index live_updates_pending on public.live_updates (project_id, id) where kind = 'live' and status in ('pending', 'applying');
create index live_updates_by_commit on public.live_updates (project_id, commit);

-- What the code does with a proposal, as predicted from the compiled code (no Figma):
-- { done, total, exact, branch, commit, at }. Confirmed when the plugin applies the update to Live.
alter table public.proposals add column code_check jsonb;

create or replace function public.take_update(p_project text) returns setof public.live_updates
language plpgsql security definer set search_path = public as $$
declare
  newest bigint;
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if exists (select 1 from live_updates where project_id = p_project and kind = 'live' and status = 'applying' and taken_at > now() - interval '10 minutes') then
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

-- The branch whose commits update Live (default: the repo's default branch, set at init).
create function public.set_live_branch(p_project text, p_branch text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_project, array['admin', 'developer']) then raise exception 'only the project''s developers choose the Live branch'; end if;
  if coalesce(trim(p_branch), '') = '' then raise exception 'give a branch name'; end if;
  update projects set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('liveBranch', trim(p_branch)) where id = p_project;
end;
$$;
grant execute on function public.set_live_branch to authenticated;
