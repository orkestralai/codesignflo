-- Is the project's Figma file open with the plugin right now? The plugin says so every time it checks for
-- updates (every 15 s); a sync then waits for its update to be applied and reports how it went.
create table public.plugin_presence (
  project_id text not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  file_name text,
  seen_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
alter table public.plugin_presence enable row level security;
create policy "members see presence" on public.plugin_presence for select using (public.is_member(project_id));

create function public.plugin_seen(p_project text, p_file_name text) returns void
language sql security definer set search_path = public as $$
  insert into plugin_presence (project_id, user_id, file_name, seen_at)
  select p_project, auth.uid(), p_file_name, now() where public.is_member(p_project)
  on conflict (project_id, user_id) do update set seen_at = now(), file_name = excluded.file_name;
$$;
grant execute on function public.plugin_seen to authenticated;
