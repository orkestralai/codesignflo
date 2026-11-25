-- A plugin that took an update but can't apply it (closing, or replaced) gives it back at once instead of
-- leaving it taken for 10 minutes.
create function public.release_update(p_id bigint) returns void
language sql security definer set search_path = public as $$
  update live_updates set status = 'pending', taken_at = null, taken_by = null
  where id = p_id and status = 'applying' and taken_by = auth.uid();
$$;
grant execute on function public.release_update to authenticated;
