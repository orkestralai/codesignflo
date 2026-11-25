-- Signing in with Google or an email link (besides Figma and GitHub): the sign-in no longer tells which side a
-- person works on. Whoever starts a project from Figma (the plugin makes it without code) works on the design
-- side; signing in with Figma still says so too. Used where a role doesn't say: an admin's side (notifications)
-- and who can refer designers. Replaced in place; safe to run again.

alter table public.profiles add column if not exists design_side boolean not null default false;

create or replace function public.project_design_side() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.repo_root_commit is null then
    update profiles set design_side = true where id = new.owner and not design_side;
  end if;
  return null;
end;
$$;
drop trigger if exists project_design_side on public.projects;
create trigger project_design_side after insert on public.projects for each row execute function public.project_design_side();
revoke execute on function public.project_design_side() from public, anon, authenticated;

-- Projects started from Figma that have no code yet.
update public.profiles p set design_side = true
where not p.design_side and exists (select 1 from public.projects j where j.owner = p.id and j.repo_root_commit is null);

-- Works on the design side: a designer somewhere, signed in with Figma, started a project from Figma, or holding
-- or paying a seat.
create or replace function public.designs_side(p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from project_members where user_id = p_user and role = 'designer')
      or exists (select 1 from profiles where id = p_user and (figma_user_id is not null or design_side))
      or exists (select 1 from designer_seats s where s.payer = p_user
                 or s.email = (select lower(email) from auth.users where id = p_user));
$$;
