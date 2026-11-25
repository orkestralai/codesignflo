-- A developer starting on what the designer sent ("building") is news for the designer: notified like the
-- other hand-offs. Replaces the function in place (the trigger keeps pointing at it).
create or replace function public.notify_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('ready', 'designed_new', 'review_answered', 'sent_back', 'closed', 'building')
     or (new.kind = 'dev_reviewed' and new.body ->> 'decision' = 'questions') then
    insert into notifications (project_id, kind, component, by, body) values (new.project_id, new.kind, new.component, new."by", new.body);
    perform public.ping_notify();
  end if;
  return null;
end;
$$;
