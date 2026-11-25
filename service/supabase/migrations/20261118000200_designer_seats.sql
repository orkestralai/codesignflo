-- Billing by designer seat, held by the person: a designer with a seat works in any project (theirs or anyone's).
-- A seat is paid by someone: the designer themselves, or anyone paying for others by email (a team lead…). One
-- subscription per payer, its quantity = the seats they pay for. Developers are free, and a project costs nothing
-- in itself. Every account has 7 days of trial from when it was created. After it, someone without a seat can
-- still use everything except sending designs to developers (Ready for dev, a new design): those wait, held by
-- the plugin, until they have a seat. Live keeps updating for everyone. Whitelisted emails never need a seat.
-- Replaces the owner-pays model (20261116000200_billing.sql) in place; nobody had subscribed under it.

-- 1. The seats: an email (an account or someone not signed up yet) and who pays for it.
create table if not exists public.designer_seats (
  email text primary key check (email = lower(email)),
  payer uuid not null references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);
create index if not exists designer_seats_payer on public.designer_seats (payer);
alter table public.designer_seats enable row level security;
drop policy if exists "payers see their seats" on public.designer_seats;
create policy "payers see their seats" on public.designer_seats for select to authenticated
  using (payer = auth.uid() or public.is_admin());

-- 2. The trial: from the account's creation. billing_accounts.trial_ends_at, when set, overrides it (accounts from
-- before this change get 7 days from now).
alter table public.billing_accounts alter column trial_ends_at drop not null;
alter table public.billing_accounts alter column trial_ends_at drop default;
insert into public.billing_accounts (user_id, trial_ends_at)
select id, now() + interval '7 days' from auth.users
on conflict (user_id) do update set trial_ends_at = greatest(billing_accounts.trial_ends_at, excluded.trial_ends_at);

create or replace function public.trial_ends(p_user uuid) returns timestamptz
language sql stable security definer set search_path = public as $$
  select coalesce(a.trial_ends_at, u.created_at + interval '7 days')
  from auth.users u left join billing_accounts a on a.user_id = u.id where u.id = p_user;
$$;

-- Who pays for a person's seat, while that payer's subscription stands (past_due still counts while Stripe retries).
create or replace function public.seat_payer(p_user uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select s.payer from auth.users u
  join designer_seats s on s.email = lower(u.email)
  join billing_accounts a on a.user_id = s.payer and a.status in ('active', 'trialing', 'past_due')
  where u.id = p_user;
$$;

-- Seats a payer pays for (the subscription's quantity); whitelisted emails don't count.
create or replace function public.billing_seats(p_owner uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from designer_seats s
  where s.payer = p_owner and not exists (select 1 from billing_whitelist w where w.email = s.email);
$$;

-- A person's state as a designer: whitelisted, active (a seat someone pays for), trial, or unpaid.
create or replace function public.billing_state(p_owner uuid) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if public.whitelisted(p_owner) then return 'whitelisted'; end if;
  if public.seat_payer(p_owner) is not null then return 'active'; end if;
  if public.trial_ends(p_owner) > now() then return 'trial'; end if;
  return 'unpaid';
end;
$$;

-- 3. What's held without a seat: sending designs (the plugin holds them on this refusal and sends them later;
-- "read-only" is what plugins up to 0.4.3 look for). Live, previews and new projects are never refused now.
create or replace function public.read_only_message(p text) returns text
language sql stable security definer set search_path = public as $$
  select 'read-only for you: your designer trial has ended — designs you send wait until you have a seat (Billing at codesignflo.com, or ask someone to pay for your seat)'::text;
$$;

create or replace function public.billing_guard_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- A developer's are dropped by events_author anyway (not the design side), so only designers and admins count.
  if new.kind in ('ready', 'designed_new') and auth.uid() is not null
     and exists (select 1 from project_members where project_id = new.project_id and user_id = auth.uid() and role in ('designer', 'admin'))
     and public.billing_state(auth.uid()) = 'unpaid' then
    raise exception '%', public.read_only_message(new.project_id) using errcode = 'P0402';
  end if;
  return new;
end;
$$;

drop trigger if exists billing_guard on public.live_updates;
drop trigger if exists billing_guard on public.projects;
drop trigger if exists billing_members on public.project_members;
create or replace function public.project_writable(p text) returns boolean
language sql stable as $$ select true $$;

-- 4. For the plugin and the agent: the signed-in person's own state (the columns plugins up to 0.4.3 read).
create or replace function public.project_billing(p_project text)
returns table (state text, trial_ends_at timestamptz, owner_email text, seats int)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  return query select public.billing_state(uid), public.trial_ends(uid), (select email::text from auth.users where id = uid), 0;
end;
$$;

-- For the web app's Billing: my own seat (and who pays it), and the seats I pay for.
drop function if exists public.my_billing();
create function public.my_billing()
returns table (state text, trial_ends_at timestamptz, paid_by text, seats int, billed_seats int, status text, current_period_end timestamptz, subscribed boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first'; end if;
  return query
    select public.billing_state(uid), public.trial_ends(uid),
      (select email::text from auth.users where id = public.seat_payer(uid)),
      public.billing_seats(uid), coalesce(a.seats, 0), a.status, a.current_period_end, a.stripe_subscription_id is not null
    from (select uid as id) me left join billing_accounts a on a.user_id = me.id;
end;
$$;
grant execute on function public.my_billing to authenticated;

create or replace function public.my_seats()
returns table (email text, signed_up boolean, added_at timestamptz)
language sql stable security definer set search_path = public as $$
  select s.email, exists (select 1 from auth.users u where lower(u.email) = s.email), s.added_at
  from designer_seats s where s.payer = auth.uid() order by s.added_at;
$$;
grant execute on function public.my_seats to authenticated;

-- Pay for a seat: 'added', 'yours' (already), 'taken' (someone else pays for it), 'free' (whitelisted).
create or replace function public.add_seat(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(p_email));
  current_payer uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address'; end if;
  if exists (select 1 from billing_whitelist where email = e) then return 'free'; end if;
  select payer into current_payer from designer_seats where email = e;
  if current_payer = auth.uid() then return 'yours'; end if;
  if current_payer is not null then return 'taken'; end if;
  insert into designer_seats (email, payer) values (e, auth.uid());
  perform public.ping_notify();  -- a subscribed payer's quantity follows
  return 'added';
end;
$$;
grant execute on function public.add_seat to authenticated;

create or replace function public.remove_seat(p_email text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  delete from designer_seats where email = lower(trim(p_email)) and payer = auth.uid();
  if not found then return false; end if;
  perform public.ping_notify();
  return true;
end;
$$;
grant execute on function public.remove_seat to authenticated;

-- For CoDesignFlo's admins: every account's state, and the seats each pays for.
create or replace function public.admin_billing()
returns table (user_id uuid, email text, state text, seats int, status text, trial_ends_at timestamptz, current_period_end timestamptz, projects int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query
    select u.id, u.email::text, public.billing_state(u.id), public.billing_seats(u.id), a.status, public.trial_ends(u.id),
      a.current_period_end, (select count(*)::int from projects p where p.owner = u.id)
    from auth.users u left join billing_accounts a on a.user_id = u.id
    order by (a.stripe_subscription_id is not null) desc, u.created_at desc;
end;
$$;
