-- How far the plugin is with the update it's applying: { done, total, item }, saved every few seconds. Each
-- save also moves taken_at on, so the 10 minutes after which another plugin may take the update over count
-- from the last sign of life, not from when it was taken (a big app takes longer than 10 minutes to apply).
alter table public.live_updates add column if not exists progress jsonb;

create or replace function public.update_progress(p_id bigint, p_done int, p_total int, p_item text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update live_updates set progress = jsonb_build_object('done', p_done, 'total', p_total, 'item', p_item), taken_at = now()
  where id = p_id and status = 'applying' and taken_by = auth.uid();
  if not found then raise exception 'this update is not being applied by you'; end if;
end;
$$;
grant execute on function public.update_progress to authenticated;
