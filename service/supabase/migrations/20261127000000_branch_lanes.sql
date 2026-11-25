-- Branch lanes: a developer connects a feature branch to CoDesignFlo, and from then on every sync on it (by hand,
-- the agent or the git hook) updates its lane beside Live in Figma: what differs from Live, with the designs it
-- builds marked. A lane goes when the branch is disconnected, or merged into the Live branch (Live has it then).
-- Built on branch previews (live_updates kind 'preview'): a lane is a preview kept up to date.

create table if not exists public.project_branches (
  project_id text not null references public.projects (id) on delete cascade,
  branch text not null check (length(branch) between 1 and 255),
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz not null default now(),
  primary key (project_id, branch)
);
alter table public.project_branches enable row level security;
revoke all on public.project_branches from anon, authenticated;
grant select on public.project_branches to authenticated;
grant all on public.project_branches to service_role;
drop policy if exists "members read branches" on public.project_branches;
create policy "members read branches" on public.project_branches for select using (public.is_member(project_id));

-- Developers and admins connect a branch (not the Live branch: Live is its lane). Connecting again keeps it.
create or replace function public.connect_branch(p_project text, p_branch text) returns text
language plpgsql security definer set search_path = public as $$
declare
  b text := btrim(coalesce(p_branch, ''));
  live text;
begin
  if not public.is_member(p_project, array['admin', 'developer']) then
    raise exception 'only the project''s developers and admins connect branches' using errcode = '42501';
  end if;
  if b = '' or length(b) > 255 or b ~ '[[:cntrl:][:space:]~^:?*\[\\]' or b like '-%' or b like '%..%' then
    raise exception 'not a branch name: %', left(b, 80) using errcode = '22023';
  end if;
  select settings ->> 'liveBranch' into live from projects where id = p_project;
  if b = live then
    raise exception '% is the Live branch: Live is its lane', b using errcode = '22023';
  end if;
  insert into project_branches (project_id, branch, connected_by) values (p_project, b, auth.uid())
  on conflict (project_id, branch) do nothing;
  return b;
end;
$$;

-- Disconnecting (or merged): the lane goes from Figma the next time the plugin runs.
create or replace function public.disconnect_branches(p_project text, p_branches text[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if not public.is_member(p_project, array['admin', 'developer']) then
    raise exception 'only the project''s developers and admins disconnect branches' using errcode = '42501';
  end if;
  delete from project_branches where project_id = p_project and branch = any (coalesce(p_branches, '{}'));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- The connected branches, with who connected each (their name as shown in the project).
create or replace function public.project_lanes(p_project text)
returns table (branch text, connected_by text, connected_at timestamptz)
language sql stable security definer set search_path = public as $$
  select b.branch, public.display_name(b.connected_by), b.connected_at
  from project_branches b
  where b.project_id = p_project and public.is_member(p_project)
  order by b.connected_at;
$$;

revoke execute on function public.connect_branch(text, text) from public, anon;
revoke execute on function public.disconnect_branches(text, text[]) from public, anon;
revoke execute on function public.project_lanes(text) from public, anon;
grant execute on function public.connect_branch(text, text) to authenticated;
grant execute on function public.disconnect_branches(text, text[]) to authenticated;
grant execute on function public.project_lanes(text) to authenticated;
