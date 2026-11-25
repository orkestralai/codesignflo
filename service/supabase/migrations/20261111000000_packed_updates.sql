-- A Live update's compiled code (its components and pages) travels gzipped in `bundle` (base64), not as JSON in
-- the payload: a 37-page app compiles to ~8 MB of JSON, which the database took longer to store than a
-- statement may run (and the plugin took as long to read back); gzipped it's ~0.5 MB. The payload keeps the
-- small parts (registry, tokens, setup) that the CLI and the hosted MCP read.
alter table public.live_updates add column if not exists bundle text;

-- Once an update is applied, the older ones are never applied again: drop their compiled code.
create or replace function public.finish_update(p_id bigint, p_ok boolean, p_log text) returns void
language plpgsql security definer set search_path = public as $$
declare
  p text;
begin
  update live_updates set status = case when p_ok then 'applied' else 'failed' end, log = p_log
  where id = p_id and status = 'applying' and taken_by = auth.uid()
  returning project_id into p;
  if not found then raise exception 'this update is not being applied by you'; end if;
  if p_ok then
    update live_updates set bundle = null, payload = payload - 'sets' - 'screens'
    where project_id = p and id < p_id and status in ('applied', 'superseded', 'failed')
      and (bundle is not null or payload ? 'sets' or payload ? 'screens');
  end if;
end;
$$;

-- The same for what's already stored: every project keeps its newest update whole.
update public.live_updates u set bundle = null, payload = u.payload - 'sets' - 'screens'
where u.status in ('applied', 'superseded', 'failed')
  and (u.payload ? 'sets' or u.payload ? 'screens')
  and exists (select 1 from public.live_updates n where n.project_id = u.project_id and n.id > u.id and n.status = 'applied');
