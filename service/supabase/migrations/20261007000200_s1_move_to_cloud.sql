-- Moving an existing local project to the cloud keeps its id (the Figma file already carries it).
drop function public.create_project(text, text, text, jsonb);
create function public.create_project(p_name text, p_root_commit text, p_folder text default '.', p_settings jsonb default '{}'::jsonb, p_id text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  new_id text;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if p_root_commit is not null and exists (select 1 from projects where repo_root_commit = p_root_commit and repo_folder = p_folder) then
    raise exception 'this app already has a CoDesignFlo project — ask its owner to invite you' using errcode = 'P0001';
  end if;
  if exists (select 1 from projects where owner = uid and plan = 'free') then
    raise exception 'your free project is already in use — upgrade to add another' using errcode = 'P0002';
  end if;
  if p_id is not null and (p_id !~ '^p_[0-9a-f]{12}$' or exists (select 1 from projects where id = p_id)) then
    raise exception 'that project id is taken or invalid';
  end if;
  insert into projects (id, name, owner, repo_root_commit, repo_folder, settings)
  values (coalesce(p_id, 'p_' || encode(extensions.gen_random_bytes(6), 'hex')), p_name, uid, p_root_commit, p_folder, p_settings)
  returning id into new_id;
  insert into project_members (project_id, user_id, role) values (new_id, uid, 'admin');
  return new_id;
end;
$$;
grant execute on function public.create_project to authenticated;
