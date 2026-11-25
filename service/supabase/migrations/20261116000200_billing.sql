-- Billing: €10 a month per designer seat, developers free. A project's owner pays for the designers in their
-- projects (one subscription per owner, its quantity = their designer seats). 7 days of trial from their
-- first project; after it, an unpaid owner's projects are read-only: Live stops updating (no Live updates or
-- previews uploaded) and no new designs are sent. Nothing is deleted, and reading, checks and reviews go on.
-- Whitelisted emails never pay: as owners their projects are free, as designers they aren't a seat.
-- Stripe holds the subscription; the service mirrors its state here (webhooks, written with the service role).

-- 1. The whitelist (CoDesignFlo's admins manage it: admin.codesignflo.com).
create table if not exists public.billing_whitelist (
  email text primary key check (email = lower(email)),
  note text,
  added_by uuid references auth.users (id) on delete set null,
  added_at timestamptz not null default now()
);
alter table public.billing_whitelist enable row level security;
drop policy if exists "admins manage the whitelist" on public.billing_whitelist;
create policy "admins manage the whitelist" on public.billing_whitelist for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 2. Each owner's billing: their trial, and their Stripe subscription as Stripe last reported it.
create table if not exists public.billing_accounts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  trial_ends_at timestamptz not null default (now() + interval '7 days'),
  stripe_customer_id text unique,
  stripe_subscription_id text,
  -- Stripe's subscription status: trialing, active, past_due, canceled, unpaid, incomplete…
  status text,
  current_period_end timestamptz,
  -- The quantity Stripe bills (kept equal to billing_seats by the service).
  seats int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.billing_accounts enable row level security;
drop policy if exists "owners see their billing" on public.billing_accounts;
create policy "owners see their billing" on public.billing_accounts for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- Owners from before billing: their trial starts now.
insert into public.billing_accounts (user_id) select distinct owner from public.projects on conflict do nothing;

create or replace function public.whitelisted(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from auth.users u join billing_whitelist w on w.email = lower(u.email) where u.id = p_user);
$$;

-- Designer seats an owner pays for: designers in their projects (an admin who signed in with Figma only works
-- on the design side, so counts too), each person once, whitelisted ones not.
create or replace function public.billing_seats(p_owner uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(distinct m.user_id)::int
  from projects p
  join project_members m on m.project_id = p.id
  join auth.users u on u.id = m.user_id
  left join profiles pr on pr.id = m.user_id
  where p.owner = p_owner
    and (m.role = 'designer' or (m.role = 'admin' and pr.figma_user_id is not null and pr.github_user_id is null))
    and not exists (select 1 from billing_whitelist w where w.email = lower(u.email));
$$;

-- An owner's state: whitelisted, free (no designer seats), active (subscribed; past_due is still served while
-- Stripe retries), trial, or unpaid (read-only).
create or replace function public.billing_state(p_owner uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  a billing_accounts;
begin
  if public.whitelisted(p_owner) then return 'whitelisted'; end if;
  if public.billing_seats(p_owner) = 0 then return 'free'; end if;
  select * into a from billing_accounts where user_id = p_owner;
  if a.status in ('active', 'trialing', 'past_due') then return 'active'; end if;
  if a.trial_ends_at is null or a.trial_ends_at > now() then return 'trial'; end if;
  return 'unpaid';
end;
$$;

create or replace function public.project_writable(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.billing_state(owner) <> 'unpaid' from projects where id = p;
$$;

-- For the people in a project (plugin, agent): how it stands, and who pays.
create or replace function public.project_billing(p_project text)
returns table (state text, trial_ends_at timestamptz, owner_email text, seats int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  return query
    select public.billing_state(p.owner), a.trial_ends_at, u.email::text, public.billing_seats(p.owner)
    from projects p join auth.users u on u.id = p.owner left join billing_accounts a on a.user_id = p.owner
    where p.id = p_project;
end;
$$;
grant execute on function public.project_billing to authenticated;

-- For the signed-in person (web app, Billing): their own billing as an owner.
create or replace function public.my_billing()
returns table (state text, trial_ends_at timestamptz, seats int, billed_seats int, status text, current_period_end timestamptz, projects int, subscribed boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first'; end if;
  return query
    select public.billing_state(uid), a.trial_ends_at, public.billing_seats(uid), coalesce(a.seats, 0), a.status, a.current_period_end,
      (select count(*)::int from projects where owner = uid), a.stripe_subscription_id is not null
    from (select uid as id) me left join billing_accounts a on a.user_id = me.id;
end;
$$;
grant execute on function public.my_billing to authenticated;

-- For CoDesignFlo's admins: every owner's billing.
create or replace function public.admin_billing()
returns table (user_id uuid, email text, state text, seats int, status text, trial_ends_at timestamptz, current_period_end timestamptz, projects int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query
    select a.user_id, u.email::text, public.billing_state(a.user_id), public.billing_seats(a.user_id), a.status, a.trial_ends_at,
      a.current_period_end, (select count(*)::int from projects p where p.owner = a.user_id)
    from billing_accounts a join auth.users u on u.id = a.user_id
    order by a.updated_at desc;
end;
$$;
grant execute on function public.admin_billing to authenticated;

-- 3. Read-only when unpaid: said where it's refused, with what to do.
create or replace function public.read_only_message(p text) returns text
language sql stable security definer set search_path = public as $$
  select format('this project is read-only: the trial of its owner (%s) has ended — they subscribe in the CoDesignFlo web app (Billing), €10 a month per designer', u.email)
  from projects pr join auth.users u on u.id = pr.owner where pr.id = p;
$$;

create or replace function public.billing_guard_updates() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('live', 'preview') and not public.project_writable(new.project_id) then
    raise exception '%', public.read_only_message(new.project_id) using errcode = 'P0402';
  end if;
  return new;
end;
$$;
drop trigger if exists billing_guard on public.live_updates;
create trigger billing_guard before insert on public.live_updates for each row execute function public.billing_guard_updates();

create or replace function public.billing_guard_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('ready', 'designed_new') and not public.project_writable(new.project_id) then
    raise exception '%', public.read_only_message(new.project_id) using errcode = 'P0402';
  end if;
  return new;
end;
$$;
drop trigger if exists billing_guard on public.events;
create trigger billing_guard before insert on public.events for each row execute function public.billing_guard_events();

-- A new project: its owner's trial starts with their first one; an unpaid owner subscribes before another.
create or replace function public.billing_guard_projects() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into billing_accounts (user_id) values (new.owner) on conflict do nothing;
  if public.billing_state(new.owner) = 'unpaid' then
    raise exception 'your trial has ended — subscribe in the CoDesignFlo web app (Billing) to start another project' using errcode = 'P0402';
  end if;
  return new;
end;
$$;
drop trigger if exists billing_guard on public.projects;
create trigger billing_guard before insert on public.projects for each row execute function public.billing_guard_projects();

-- Projects are no longer limited to one free one per person: billing is by designer seat.
create or replace function public.create_project(p_name text, p_root_commit text, p_folder text default '.', p_settings jsonb default '{}'::jsonb, p_id text default null)
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

-- 4. Seats change when designers join or leave: the service is pinged (with the notifications) and updates
-- the subscription's quantity in Stripe.
create or replace function public.billing_members_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update billing_accounts set updated_at = now()
  where user_id = (select owner from projects where id = coalesce(new.project_id, old.project_id));
  perform public.ping_notify();
  return null;
end;
$$;
drop trigger if exists billing_members on public.project_members;
create trigger billing_members after insert or delete on public.project_members for each row execute function public.billing_members_changed();

-- CoDesignFlo's own admins never pay.
insert into public.billing_whitelist (email, note)
select lower(u.email), 'CoDesignFlo admin' from public.admins a join auth.users u on u.id = a.user_id where u.email is not null
on conflict do nothing;
