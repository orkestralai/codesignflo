-- One role per person per project; someone who both designs and codes is an admin there. An admin changes an
-- existing member's role by inviting them again with the new role (web app, CLI, the agent's invite). The
-- project's owner stays an admin, and a project always keeps an admin. Others inviting an existing member
-- leave their role as it is, as before.
-- my_role: the signed-in person's role in a project, so the plugin and the agent can say why an action is
-- for the other side.

create or replace function public.invite(p_project text, p_email text, p_role text default 'developer', p_email_them boolean default true) returns text
language plpgsql security definer set search_path = public as $$
declare
  existing uuid;
  current_role_ text;
  e text := lower(trim(p_email));
  result text := 'invited';
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if p_role not in ('developer', 'designer', 'admin') then raise exception 'role must be developer, designer or admin'; end if;
  if p_role = 'admin' and not public.is_member(p_project, array['admin']) then raise exception 'only admins can invite admins'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address'; end if;
  select id into existing from auth.users where lower(email) = e;
  if existing is not null then
    select role into current_role_ from project_members where project_id = p_project and user_id = existing;
  end if;
  -- Already in the project: an admin changes their role; anyone else leaves it as it is.
  if current_role_ is not null then
    if current_role_ = p_role or not public.is_member(p_project, array['admin']) then return 'member'; end if;
    if current_role_ = 'admin' and exists (select 1 from projects where id = p_project and owner = existing) then
      raise exception 'the project''s owner stays an admin';
    end if;
    if current_role_ = 'admin' and (select count(*) from project_members where project_id = p_project and role = 'admin') = 1 then
      raise exception 'that''s the project''s last admin — make someone else an admin first';
    end if;
    update project_members set role = p_role where project_id = p_project and user_id = existing;
    update invitations set role = p_role where project_id = p_project and email = e;
    return 'role_changed';
  end if;
  insert into invitations (project_id, email, role, invited_by) values (p_project, e, p_role, auth.uid())
  on conflict (project_id, email) do update set role = excluded.role, invited_by = excluded.invited_by;
  if existing is not null then
    insert into project_members (project_id, user_id, role) values (p_project, existing, p_role) on conflict do nothing;
    update invitations set accepted_at = now() where project_id = p_project and email = e;
    result := 'added';
  end if;
  -- Inviting the same person again within the email limit still records the invitation; only the email waits.
  if p_email_them and not exists (select 1 from invitations where project_id = p_project and email = e and last_sent_at > now() - interval '2 minutes') then
    perform public.queue_invitation_email(p_project, e);
  end if;
  return result;
end;
$$;
grant execute on function public.invite(text, text, text, boolean) to authenticated;

create or replace function public.my_role(p_project text) returns text
language sql stable security definer set search_path = public as $$
  select role from project_members where project_id = p_project and user_id = auth.uid();
$$;
grant execute on function public.my_role to authenticated;
