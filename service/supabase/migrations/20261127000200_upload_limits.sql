-- Upload limits: how much a signed-in member can put in a project, generous next to real use, so a free account
-- can't fill the database or storage. Measured on 2026-11-27: Live update payloads up to 22 KB, gzipped bundles
-- about 0.6 MB (a 37-page app), layer snapshots up to 0.5 MB, proposals up to 170 KB, a busy project 30 updates
-- a day. Each limit is a check in the database, whatever the client. The service's own server functions (no
-- signed-in user) aren't counted.
--
-- Constraints are NOT VALID: they hold for every new or changed row, and rows already there are left as they are.

-- ── 1. Sizes of what members write ──────────────────────────────────────────────────────────────────────────
alter table public.live_updates drop constraint if exists live_updates_bundle_size;
alter table public.live_updates add constraint live_updates_bundle_size
  check (bundle is null or octet_length(bundle) <= 64 * 1024 * 1024) not valid;
alter table public.live_updates drop constraint if exists live_updates_payload_size;
alter table public.live_updates add constraint live_updates_payload_size
  check (octet_length(payload::text) <= 16 * 1024 * 1024) not valid;

alter table public.generations drop constraint if exists generations_snapshot_size;
alter table public.generations add constraint generations_snapshot_size
  check (octet_length(snapshot::text) <= 32 * 1024 * 1024) not valid;

alter table public.proposals drop constraint if exists proposals_payload_size;
alter table public.proposals add constraint proposals_payload_size
  check (octet_length(payload::text) <= 32 * 1024 * 1024) not valid;

alter table public.events drop constraint if exists events_body_size;
alter table public.events add constraint events_body_size
  check (octet_length(body::text) <= 8 * 1024 * 1024) not valid;

-- ── 2. How often: Live updates per project an hour, and per person a day ────────────────────────────────────
create index if not exists live_updates_project_created on public.live_updates (project_id, created_at);
create index if not exists live_updates_creator_created on public.live_updates (created_by, created_at);

create or replace function public.live_updates_rate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;
  if (select count(*) from live_updates where project_id = new.project_id and created_at > now() - interval '1 hour') >= 300 then
    raise exception 'this project has had 300 syncs in the last hour: try again in a while' using errcode = 'P0429';
  end if;
  if (select count(*) from live_updates where created_by = auth.uid() and created_at > now() - interval '1 day') >= 3000 then
    raise exception 'you''ve synced 3000 times today: try again tomorrow' using errcode = 'P0429';
  end if;
  return new;
end;
$$;
revoke execute on function public.live_updates_rate() from public, anon, authenticated;

drop trigger if exists live_updates_rate on public.live_updates;
create trigger live_updates_rate before insert on public.live_updates
  for each row execute function public.live_updates_rate();

-- ── 3. Pictures: room per project in the media bucket ───────────────────────────────────────────────────────
-- At most 100,000 pictures and 10 GB per project (each picture is already at most 20 MB, by the bucket). Pictures
-- are stored under <project id>/<content hash>, so a sync uploads only new ones.
create or replace function public.media_room(p text) returns boolean
language sql stable security definer set search_path = public, storage as $$
  select count(*) < 100000 and coalesce(sum((o.metadata ->> 'size')::bigint), 0) < 10::bigint * 1024 * 1024 * 1024
  from storage.objects o
  where o.bucket_id = 'media' and left(o.name, char_length(p) + 1) = p || '/';
$$;
revoke execute on function public.media_room(text) from public, anon;
grant execute on function public.media_room(text) to authenticated;

drop policy if exists "developers add media" on storage.objects;
create policy "developers add media" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'media'
    and public.is_member((storage.foldername(name))[1], array['admin', 'developer'])
    and public.media_room((storage.foldername(name))[1])
  );
