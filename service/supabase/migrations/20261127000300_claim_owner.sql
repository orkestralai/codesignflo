-- A claimed copy is its designer's alone: only the person who claimed it sends it, takes it back, keeps editing it
-- after sending, answers the developer's review of it, or writes its proposal. Another designer's plugin could do
-- those for a copy it could see (found on 2026-11-27: a second designer sent the first one's copy). Refused rows are
-- dropped rather than failing, as the other event rules do, so one refused event never holds up a batch.

-- Who claimed it: the author of the claim's "claimed" event (null for a claim the service hasn't heard of).
create index if not exists events_claims on public.events (project_id, (body ->> 'claim')) where kind = 'claimed';

create or replace function public.claimant(p_project text, p_claim text) returns uuid
language sql stable security definer set search_path = public as $$
  select e.user_id from events e
  where e.project_id = p_project and e.kind = 'claimed' and e.body ->> 'claim' = p_claim and e.user_id is not null
  order by e.seq limit 1;
$$;
revoke execute on function public.claimant(text, text) from public, anon, authenticated;

create or replace function public.events_claim_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  owner uuid;
begin
  if auth.uid() is null or new.kind not in ('ready', 'unclaimed', 'reopened', 'review_answered') or new.body ->> 'claim' is null then
    return new;
  end if;
  owner := public.claimant(new.project_id, new.body ->> 'claim');
  if owner is not null and owner <> auth.uid() then return null; end if;
  return new;
end;
$$;
revoke execute on function public.events_claim_owner() from public, anon, authenticated;

-- After events_author (triggers run in name order): the author is the signed-in user by then.
drop trigger if exists events_claim_owner on public.events;
create trigger events_claim_owner before insert on public.events
  for each row execute function public.events_claim_owner();

create or replace function public.proposals_claim_owner() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  owner uuid;
  r text;
begin
  if auth.uid() is null then return new; end if;
  select role into r from project_members where project_id = new.project_id and user_id = auth.uid();
  -- The developer's side (the code's check) has its own rule (proposals_sides); not a member: the policy refuses it.
  if r is null or r = 'developer' then return new; end if;
  if tg_op = 'UPDATE' and new.payload is not distinct from old.payload and new.component is not distinct from old.component then
    return new;
  end if;
  owner := public.claimant(new.project_id, new.claim_id);
  if owner is null or owner = auth.uid() then return new; end if;
  if tg_op = 'INSERT' then return null; end if;
  new.payload := old.payload;
  new.component := old.component;
  return new;
end;
$$;
revoke execute on function public.proposals_claim_owner() from public, anon, authenticated;

drop trigger if exists proposals_claim_owner on public.proposals;
create trigger proposals_claim_owner before insert or update on public.proposals
  for each row execute function public.proposals_claim_owner();
