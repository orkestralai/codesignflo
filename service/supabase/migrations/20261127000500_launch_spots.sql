-- The launch price (€15 a seat for the first 6 months) for the first 1,000 designer seats only. A subscription
-- that checkout gave the launch price is marked (launch); the most seats it has had are counted (launch_seats:
-- only ever goes up, so a seat taken isn't given back by cancelling or removing it). The landing page shows the
-- places left (launch_spots, readable without signing in: a count, nothing about anyone).

alter table public.billing_accounts add column if not exists launch boolean not null default false;
alter table public.billing_accounts add column if not exists launch_seats int not null default 0;

create or replace function public.billing_launch_seats() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    -- Once given the launch price, always counted: a later update can't take the mark or the count back.
    new.launch := new.launch or old.launch;
    new.launch_seats := greatest(old.launch_seats, new.launch_seats);
  end if;
  if new.launch then new.launch_seats := greatest(new.launch_seats, new.seats); end if;
  return new;
end;
$$;
revoke execute on function public.billing_launch_seats() from public, anon, authenticated;

drop trigger if exists billing_launch_seats on public.billing_accounts;
create trigger billing_launch_seats before insert or update on public.billing_accounts
  for each row execute function public.billing_launch_seats();

-- How many of the 1,000 launch places are left (web/src/pricing.ts LAUNCH.spots is the same number).
create or replace function public.launch_spots() returns table (total int, taken int, remaining int)
language sql stable security definer set search_path = public as $$
  with t as (select coalesce(sum(launch_seats), 0)::int as n from billing_accounts where launch)
  select 1000, least(t.n, 1000), greatest(1000 - t.n, 0) from t;
$$;
grant execute on function public.launch_spots() to anon, authenticated;
