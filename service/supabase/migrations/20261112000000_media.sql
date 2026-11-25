-- Pictures a Live update uses: the app's images and each page's screenshot (shown beside the Live page, so
-- the designer sees the app as built). Private: stored under <project id>/<content hash>; the project's
-- members read them, its developers and admins add them (a sync uploads only the ones not there yet).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 20971520, array['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "members read media" on storage.objects;
create policy "members read media" on storage.objects for select to authenticated
  using (bucket_id = 'media' and public.is_member((storage.foldername(name))[1]));

drop policy if exists "developers add media" on storage.objects;
create policy "developers add media" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and public.is_member((storage.foldername(name))[1], array['admin', 'developer']));
