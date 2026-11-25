-- Onboarding: which of my projects have their code and their Figma file yet (to offer "Use this file for…"
-- when the developer started first), and recording the file a project uses.

-- The Figma file a project uses (its name, and when it was set up): projects.settings.file.
create function public.link_file(p_project text, p_file_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  update projects set settings = coalesce(settings, '{}'::jsonb)
    || jsonb_build_object('file', jsonb_build_object('name', p_file_name, 'at', now()))
  where id = p_project;
end;
$$;

create function public.my_projects() returns table (project_id text, name text, role text, has_code boolean, file_name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name, m.role, p.repo_root_commit is not null, p.settings -> 'file' ->> 'name'
  from projects p join project_members m on m.project_id = p.id and m.user_id = auth.uid()
  order by p.created_at desc;
$$;

grant execute on function public.link_file to authenticated;
grant execute on function public.my_projects to authenticated;
