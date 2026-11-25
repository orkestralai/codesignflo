-- No more 7-day trial: every designer gets 5 free sends to dev instead, for good. A send is a design sent to the
-- developers (Ready for dev, or a new design), every time, re-sends included, counted per account across all
-- projects. After the 5th, sending waits until the designer has a seat (as after the trial before): the plugin
-- holds those designs and sends them once there's a seat. Everything else never waits. Replaced in place.
-- billing_state keeps its names for clients up to plugin 0.4.5: 'trial' now means "free sends left".

create or replace function public.free_sends() returns int
language sql immutable as $$ select 5 $$;

-- Sends to dev made by a person (events record their author since 20261117000100_event_authors).
create or replace function public.sends_used(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from events where user_id = p_user and kind in ('ready', 'designed_new');
$$;

create or replace function public.billing_state(p_owner uuid) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if public.whitelisted(p_owner) then return 'whitelisted'; end if;
  if public.seat_payer(p_owner) is not null then return 'active'; end if;
  if public.sends_used(p_owner) < public.free_sends() then return 'trial'; end if;
  return 'unpaid';
end;
$$;

create or replace function public.read_only_message(p text) returns text
language sql stable security definer set search_path = public as $$
  select 'read-only for you: your 5 free sends to dev are used — designs you send wait until you have a seat (Billing at codesignflo.com, or ask someone to pay for your seat)'::text;
$$;

-- The guard (20261118000200_designer_seats) is unchanged: a send by someone whose state is 'unpaid' is refused.
-- Within one batch, each row sees the sends before it, so the 6th send in a batch is refused too.

-- For the plugin and the agent: no trial end any more.
create or replace function public.project_billing(p_project text)
returns table (state text, trial_ends_at timestamptz, owner_email text, seats int)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  return query select public.billing_state(uid), null::timestamptz, (select email::text from auth.users where id = uid), 0;
end;
$$;

-- For the plugin (0.4.6 on): my free sends.
create or replace function public.my_sends()
returns table (state text, used int, free int)
language sql stable security definer set search_path = public as $$
  select public.billing_state(auth.uid()), public.sends_used(auth.uid()), public.free_sends();
$$;
grant execute on function public.my_sends to authenticated;

drop function if exists public.my_billing();
create function public.my_billing()
returns table (state text, sends_used int, sends_free int, paid_by text, seats int, billed_seats int, status text, current_period_end timestamptz, subscribed boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'sign in first'; end if;
  return query
    select public.billing_state(uid), public.sends_used(uid), public.free_sends(),
      (select email::text from auth.users where id = public.seat_payer(uid)),
      public.billing_seats(uid), coalesce(a.seats, 0), a.status, a.current_period_end, a.stripe_subscription_id is not null
    from (select uid as id) me left join billing_accounts a on a.user_id = me.id;
end;
$$;
grant execute on function public.my_billing to authenticated;

drop function if exists public.admin_billing();
create function public.admin_billing()
returns table (user_id uuid, email text, state text, seats int, status text, sends_used int, current_period_end timestamptz, projects int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'admins only'; end if;
  return query
    select u.id, u.email::text, public.billing_state(u.id), public.billing_seats(u.id), a.status, public.sends_used(u.id),
      a.current_period_end, (select count(*)::int from projects p where p.owner = u.id)
    from auth.users u left join billing_accounts a on a.user_id = u.id
    order by (a.stripe_subscription_id is not null) desc, u.created_at desc;
end;
$$;
grant execute on function public.admin_billing to authenticated;
