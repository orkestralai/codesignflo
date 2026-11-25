-- CoDesignFlo service, step 1: projects, members, the shared history and proposals.
-- Small structured data only: no images or media are ever stored here.
-- Access is decided here (row-level security): a user sees only projects they are a member of.

create extension if not exists pgcrypto;

-- People. Identity comes from the sign-in provider: Figma for designers, GitHub for developers.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  figma_user_id text unique,
  github_user_id text unique,
  created_at timestamptz not null default now()
);

-- A project = one codebase (identified by its first commit + app folder) and its Figma file(s).
create table public.projects (
  id text primary key default ('p_' || encode(gen_random_bytes(6), 'hex')),
  name text not null,
  owner uuid not null references auth.users (id),
  plan text not null default 'free' check (plan in ('free', 'paid')),
  repo_root_commit text,
  repo_folder text not null default '.',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- One project per codebase: a new login can't get a second free project for the same app.
  unique (repo_root_commit, repo_folder)
);

create table public.project_members (
  project_id text not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'developer', 'designer')),
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- The history: append-only, one row per fact (claimed, ready, delivered, closed…), written by the plugin
-- or the CLI. Same shape as the local events.jsonl; `seq` gives the order the service received them in.
create table public.events (
  project_id text not null references public.projects (id) on delete cascade,
  id text not null,
  seq bigserial,
  at timestamptz not null,
  by text not null,
  component text not null,
  kind text not null,
  body jsonb not null default '{}'::jsonb,
  primary key (project_id, id)
);
create index events_by_project on public.events (project_id, seq);

-- Proposals: what the designer sent (changes, note, version answers, snapshots as JSON — no pictures).
create table public.proposals (
  project_id text not null references public.projects (id) on delete cascade,
  claim_id text not null,
  component text not null,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (project_id, claim_id)
);

-- Membership check used by every policy (security definer: no recursion through the members table's own policy).
create function public.is_member(p text, roles text[] default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from project_members m
    where m.project_id = p and m.user_id = auth.uid() and (roles is null or m.role = any (roles))
  );
$$;

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.events enable row level security;
alter table public.proposals enable row level security;

create policy "own profile" on public.profiles for select using (id = auth.uid());
create policy "members see the project" on public.projects for select using (public.is_member(id));
create policy "admins edit the project" on public.projects for update using (public.is_member(id, array['admin']));
create policy "members see the members" on public.project_members for select using (public.is_member(project_id));
create policy "admins add members" on public.project_members for insert with check (public.is_member(project_id, array['admin']));
create policy "admins remove members" on public.project_members for delete using (public.is_member(project_id, array['admin']));
-- History: members read and append; nobody edits or deletes (no update/delete policies).
create policy "members read history" on public.events for select using (public.is_member(project_id));
create policy "members append history" on public.events for insert with check (public.is_member(project_id));
create policy "members read proposals" on public.proposals for select using (public.is_member(project_id));
create policy "members write proposals" on public.proposals for insert with check (public.is_member(project_id));
create policy "members update proposals" on public.proposals for update using (public.is_member(project_id));

-- A profile row for every new user (identity ids from the provider's metadata).
create function public.on_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, figma_user_id, github_user_id)
  values (
    new.id,
    case when new.raw_app_meta_data ->> 'provider' = 'figma' then new.raw_user_meta_data ->> 'provider_id' end,
    case when new.raw_app_meta_data ->> 'provider' = 'github' then new.raw_user_meta_data ->> 'provider_id' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.on_new_user();

-- Creating a project: one free project per person; one project per codebase (first commit + folder).
create function public.create_project(p_name text, p_root_commit text, p_folder text default '.', p_settings jsonb default '{}'::jsonb)
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
  insert into projects (name, owner, repo_root_commit, repo_folder, settings)
  values (p_name, uid, p_root_commit, p_folder, p_settings) returning id into new_id;
  insert into project_members (project_id, user_id, role) values (new_id, uid, 'admin');
  return new_id;
end;
$$;

-- Which project is this code? Found by codebase identity; says when it exists but you have no access.
create function public.find_project(p_root_commit text, p_folder text default '.')
returns table (project_id text, name text, access boolean)
language sql stable security definer set search_path = public as $$
  select p.id, case when public.is_member(p.id) then p.name else null end, public.is_member(p.id)
  from projects p where p.repo_root_commit = p_root_commit and p.repo_folder = p_folder;
$$;

grant execute on function public.create_project to authenticated;
grant execute on function public.find_project to authenticated;
