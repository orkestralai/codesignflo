-- The read-only message no longer states a price (it changes: launch offer, then €25; the web app's Billing says
-- it). Replaced in place.
create or replace function public.read_only_message(p text) returns text
language sql stable security definer set search_path = public as $$
  select format('this project is read-only: the trial of its owner (%s) has ended — they subscribe in the CoDesignFlo web app (Billing)', u.email)
  from projects pr join auth.users u on u.id = pr.owner where pr.id = p;
$$;
