-- The guided demo: a designer tries CoDesignFlo in a Figma file of their own, with a sample app in Live and a
-- simulated developer ("Alex", a service account that's a developer member). A demo project is an ordinary
-- project marked settings.demo = true, one per person (the service makes and resets it: /api/demo/start).
-- Its sends to dev never count toward the free sends and are never held. Replaced in place.

create or replace function public.is_demo(p text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (settings->>'demo')::boolean from projects where id = p), false);
$$;

create or replace function public.sends_used(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from events e
  where e.user_id = p_user and e.kind in ('ready', 'designed_new') and not public.is_demo(e.project_id);
$$;

create or replace function public.billing_guard_events() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- A developer's are dropped by events_author anyway (not the design side), so only designers and admins count;
  -- a demo project's sends are never held.
  if new.kind in ('ready', 'designed_new') and auth.uid() is not null
     and not public.is_demo(new.project_id)
     and exists (select 1 from project_members where project_id = new.project_id and user_id = auth.uid() and role in ('designer', 'admin'))
     and public.billing_state(auth.uid()) = 'unpaid' then
    raise exception '%', public.read_only_message(new.project_id) using errcode = 'P0402';
  end if;
  return new;
end;
$$;
