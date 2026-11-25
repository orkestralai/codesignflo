-- Deleting a project (its owner only): its history, proposals, generations, members, invitations and Live
-- updates go with it (they all cascade). The free project is then free for a new one.
create or replace function public.delete_project(p_project text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not exists (select 1 from projects where id = p_project) then
    raise exception 'this project is already deleted' using errcode = 'P0004';
  end if;
  if not exists (select 1 from projects where id = p_project and owner = auth.uid()) then
    raise exception 'only the project''s owner can delete it' using errcode = '42501';
  end if;
  delete from projects where id = p_project;
end;
$$;

grant execute on function public.delete_project to authenticated;
