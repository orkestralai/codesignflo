-- People: invitations (anyone in the project can invite — usually the designer invites the developer),
-- members visible to each other by email, projects started by a designer before any code is linked.

alter table public.profiles add column if not exists email text;
update public.profiles p set email = u.email from auth.users u where u.id = p.id and p.email is null;

create or replace function public.on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, figma_user_id, github_user_id)
  values (
    new.id,
    new.email,
    case when new.raw_app_meta_data ->> 'provider' = 'figma' then new.raw_user_meta_data ->> 'provider_id' end,
    case when new.raw_app_meta_data ->> 'provider' = 'github' then new.raw_user_meta_data ->> 'provider_id' end
  )
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

-- Members of a shared project see each other's email (to know who is who).
create policy "project mates' profiles" on public.profiles for select using (
  exists (
    select 1 from project_members a join project_members b on a.project_id = b.project_id
    where a.user_id = auth.uid() and b.user_id = profiles.id
  )
);

create table public.invitations (
  project_id text not null references public.projects (id) on delete cascade,
  email text not null,
  role text not null check (role in ('admin', 'developer', 'designer')),
  invited_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  primary key (project_id, email)
);
alter table public.invitations enable row level security;
create policy "members see invitations" on public.invitations for select using (public.is_member(project_id));

-- Invite someone by email: members join at once if they already have an account, otherwise at sign-in.
create function public.invite(p_project text, p_email text, p_role text default 'developer') returns text
language plpgsql security definer set search_path = public as $$
declare
  existing uuid;
  e text := lower(trim(p_email));
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if p_role not in ('developer', 'designer', 'admin') then raise exception 'role must be developer, designer or admin'; end if;
  if p_role = 'admin' and not public.is_member(p_project, array['admin']) then raise exception 'only admins can invite admins'; end if;
  insert into invitations (project_id, email, role, invited_by) values (p_project, e, p_role, auth.uid())
  on conflict (project_id, email) do update set role = excluded.role, invited_by = excluded.invited_by;
  select id into existing from auth.users where lower(email) = e;
  if existing is not null then
    insert into project_members (project_id, user_id, role) values (p_project, existing, p_role) on conflict do nothing;
    update invitations set accepted_at = now() where project_id = p_project and email = e;
    return 'added';
  end if;
  return 'invited';
end;
$$;

-- On sign-in: join every project this email was invited to.
create function public.accept_invitations() returns integer
language plpgsql security definer set search_path = public as $$
declare
  e text := lower((select email from auth.users where id = auth.uid()));
  n integer;
begin
  if auth.uid() is null then return 0; end if;
  insert into project_members (project_id, user_id, role)
  select project_id, auth.uid(), role from invitations where email = e and accepted_at is null
  on conflict do nothing;
  get diagnostics n = row_count;
  update invitations set accepted_at = now() where email = e and accepted_at is null;
  return n;
end;
$$;

-- People of a project, for the plugin's People screen.
create function public.project_people(p_project text) returns table (email text, role text, pending boolean)
language sql stable security definer set search_path = public as $$
  select pr.email, m.role, false from project_members m join profiles pr on pr.id = m.user_id
  where m.project_id = p_project and public.is_member(p_project)
  union all
  select i.email, i.role, true from invitations i
  where i.project_id = p_project and i.accepted_at is null and public.is_member(p_project)
  order by 3, 1;
$$;

-- A designer can start a project from a Figma file before any code exists; the developer links the
-- codebase later (once: a codebase belongs to one project).
create function public.link_codebase(p_project text, p_root_commit text, p_folder text default '.') returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_project, array['admin', 'developer']) then raise exception 'only the project''s developers can link its code'; end if;
  if exists (select 1 from projects where repo_root_commit = p_root_commit and repo_folder = p_folder and id <> p_project) then
    raise exception 'this app already has a CoDesignFlo project — ask its owner to invite you';
  end if;
  update projects set repo_root_commit = p_root_commit, repo_folder = p_folder
  where id = p_project and (repo_root_commit is null or (repo_root_commit = p_root_commit and repo_folder = p_folder));
  if not found then raise exception 'this project is already linked to other code'; end if;
  return p_project;
end;
$$;

-- Projects waiting for code, for a developer's init to offer.
create function public.projects_without_code() returns table (project_id text, name text)
language sql stable security definer set search_path = public as $$
  select p.id, p.name from projects p where p.repo_root_commit is null and public.is_member(p.id, array['admin', 'developer']);
$$;

grant execute on function public.invite to authenticated;
grant execute on function public.accept_invitations to authenticated;
grant execute on function public.project_people to authenticated;
grant execute on function public.link_codebase to authenticated;
grant execute on function public.projects_without_code to authenticated;
