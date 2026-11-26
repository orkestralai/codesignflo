-- A file linked to a project after its last Live update (a designer's new file, or one switched over from the
-- plugin's Projects screen) got nothing: the update was applied already, in another file, so no plugin took it,
-- and Live stayed empty until the developer's next sync. The plugin asks for the latest Live again: the newest
-- applied update (its bundle is kept) goes back to pending, unless an update is already on its way. Other files
-- of the project apply it again too, which changes nothing there (unchanged items are skipped).
create or replace function public.resend_live(p_project text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  last_id bigint;
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if exists (
    select 1 from live_updates where project_id = p_project and kind = 'live' and status in ('pending', 'applying')
  ) then
    return false;
  end if;
  select id into last_id from live_updates
  where project_id = p_project and kind = 'live' and status = 'applied' and bundle is not null
  order by id desc limit 1;
  if last_id is null then return false; end if;
  update live_updates set status = 'pending', taken_at = null, taken_by = null, progress = null where id = last_id;
  return true;
end;
$$;
revoke execute on function public.resend_live(text) from public, anon;
grant execute on function public.resend_live(text) to authenticated;
