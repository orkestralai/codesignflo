-- Where the developer builds the designer's designs: in Storybook first (components and page stories; the
-- app is wired up after the design is reviewed in Figma), or in Storybook and the app together.
create function public.set_build_mode(p_project text, p_mode text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_project, array['admin', 'developer']) then raise exception 'only the project''s developers choose where designs are built'; end if;
  if p_mode not in ('storybook-first', 'storybook-and-app') then raise exception 'build mode is storybook-first or storybook-and-app'; end if;
  update projects set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('buildMode', p_mode) where id = p_project;
end;
$$;
grant execute on function public.set_build_mode to authenticated;
