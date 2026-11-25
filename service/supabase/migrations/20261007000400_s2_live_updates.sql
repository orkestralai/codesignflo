-- Step 2: Live is updated through the service. The developer's CLI (or CI) uploads a compiled update; the
-- plugin applies it when the Figma file is open (Figma's free plan: only an open plugin can write a file)
-- and stores each new generation (what Live showed, as a layer snapshot — JSON, never pictures).

create table public.generations (
  project_id text not null references public.projects (id) on delete cascade,
  component text not null,
  gen text not null,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users (id),
  primary key (project_id, component, gen)
);
alter table public.generations enable row level security;
create policy "members read generations" on public.generations for select using (public.is_member(project_id));
-- Written by whoever applies an update (developer's CLI or the designer's plugin); never changed afterwards.
create policy "members add generations" on public.generations for insert with check (public.is_member(project_id));

create table public.live_updates (
  id bigint generated always as identity primary key,
  project_id text not null references public.projects (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references auth.users (id),
  commit text not null,
  branch text,
  -- compiled specs, tokens, the code's keys, deliveries (no pictures)
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'applying', 'applied', 'failed', 'superseded')),
  taken_at timestamptz,
  taken_by uuid references auth.users (id),
  log text
);
create index live_updates_pending on public.live_updates (project_id, id) where status in ('pending', 'applying');
alter table public.live_updates enable row level security;
create policy "members see updates" on public.live_updates for select using (public.is_member(project_id));
create policy "developers upload updates" on public.live_updates for insert
  with check (public.is_member(project_id, array['admin', 'developer']) and created_by = auth.uid() and status = 'pending');

-- The plugin takes the newest pending update (older pending ones are superseded: the newest has all the code).
-- One plugin at a time: an update being applied is not handed out again for 10 minutes.
create function public.take_update(p_project text) returns setof public.live_updates
language plpgsql security definer set search_path = public as $$
declare
  newest bigint;
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if exists (select 1 from live_updates where project_id = p_project and status = 'applying' and taken_at > now() - interval '10 minutes') then
    return;
  end if;
  select max(id) into newest from live_updates where project_id = p_project and status in ('pending', 'applying');
  if newest is null then return; end if;
  update live_updates set status = 'superseded' where project_id = p_project and status in ('pending', 'applying') and id < newest;
  return query
    update live_updates set status = 'applying', taken_at = now(), taken_by = auth.uid()
    where id = newest returning *;
end;
$$;

create function public.finish_update(p_id bigint, p_ok boolean, p_log text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update live_updates set status = case when p_ok then 'applied' else 'failed' end, log = p_log
  where id = p_id and status = 'applying' and taken_by = auth.uid();
  if not found then raise exception 'this update is not being applied by you'; end if;
end;
$$;

grant execute on function public.take_update to authenticated;
grant execute on function public.finish_update to authenticated;
