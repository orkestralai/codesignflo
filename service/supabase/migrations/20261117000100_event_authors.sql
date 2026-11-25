-- Who really wrote each fact, and only the side that makes a decision can record it.
--
-- 1. Every event records the account that wrote it (user_id, set by the database: a client can't choose it).
-- 2. A designer's decisions (claiming, sending a design, answering, keeping, accepting…) are recorded only from a
--    designer or an admin; a developer's (reviewing, building, delivering, resolving a clash) only from a
--    developer or an admin. Facts written while applying Live (generated, closed, removed_in_code…) come from
--    whoever has the Figma file open, designer or developer, so any member may write those.
-- 3. A proposal's design (payload) is written only by designers and admins; its progress in code (code_check)
--    only by developers and admins.
-- What isn't allowed is dropped, not refused: clients send events in batches, and a refusal would hold up the
-- rest of the batch (an installed plugin would retry it forever). Nothing that isn't allowed is recorded.
-- The service role (the server's own work) is unaffected.

alter table public.events add column if not exists user_id uuid references auth.users (id) on delete set null;
alter table public.events alter column user_id set default auth.uid();

drop policy if exists "members append history" on public.events;
create policy "members append history" on public.events for insert
  with check (public.is_member(project_id) and user_id = auth.uid());

create or replace function public.events_author() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text;
begin
  if auth.uid() is null then return new; end if;
  new.user_id := auth.uid();
  select role into r from project_members where project_id = new.project_id and user_id = auth.uid();
  if r is null or r = 'admin' then return new; end if;  -- not a member: the policy refuses it
  if new.kind in ('claimed', 'unclaimed', 'reopened', 'ready', 'designed_new', 'review_answered', 'review_requested',
                  'kept', 'unkept', 'accepted', 'ignored') and r <> 'designer' then
    return null;
  end if;
  if new.kind in ('dev_reviewed', 'building', 'stopped_building', 'delivered', 'resolved') and r <> 'developer' then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists events_author on public.events;
create trigger events_author before insert on public.events for each row execute function public.events_author();

create or replace function public.proposals_sides() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text;
begin
  if auth.uid() is null then return new; end if;
  select role into r from project_members where project_id = new.project_id and user_id = auth.uid();
  if r is null or r = 'admin' then return new; end if;
  if tg_op = 'INSERT' then
    return case when r = 'designer' then new else null end;
  end if;
  if r <> 'designer' then
    new.payload := old.payload;
    new.component := old.component;
  end if;
  if r <> 'developer' then new.code_check := old.code_check; end if;
  return new;
end;
$$;
drop trigger if exists proposals_sides on public.proposals;
create trigger proposals_sides before insert or update on public.proposals for each row execute function public.proposals_sides();
