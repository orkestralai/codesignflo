-- Invitation emails. Inviting someone (from the web app, the plugin, the CLI or a coding agent) emails them
-- what to do for their role: developers how to connect their coding agent, designers how to open the plugin.
-- A pending invitation can be sent again. Each invitation records how its last email went, for the People
-- lists to show. The email itself goes through the notifications outbox (sent by /api/notify).

alter table public.invitations add column if not exists email_status text check (email_status in ('queued', 'sent', 'failed'));
alter table public.invitations add column if not exists email_error text;
alter table public.invitations add column if not exists last_sent_at timestamptz;

-- Queues the invitation email (callers check membership). Limits: one email per invitation every 2 minutes,
-- and 30 invitation emails per project per hour, so inviting can't be used to send mail at will.
create function public.queue_invitation_email(p_project text, p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare
  inv invitations;
  inviter text := coalesce((select email from profiles where id = auth.uid()), 'Someone');
begin
  select * into inv from invitations where project_id = p_project and email = p_email;
  if inv.email is null then raise exception 'no invitation for % in this project', p_email; end if;
  if inv.last_sent_at > now() - interval '2 minutes' then
    raise exception 'an invitation email went to % a moment ago — wait a couple of minutes before sending it again', p_email;
  end if;
  if (select count(*) from notifications where project_id = p_project and kind = 'invited' and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'too many invitation emails from this project in the last hour — try again later';
  end if;
  -- One email waiting per invitation: sending again before the last one left doesn't send two.
  if not exists (select 1 from notifications where project_id = p_project and kind = 'invited' and sent_at is null and attempts < 5 and body ->> 'email' = inv.email) then
    insert into notifications (project_id, kind, component, by, body)
    values (p_project, 'invited', '', inviter, jsonb_build_object('email', inv.email, 'role', inv.role, 'added', inv.accepted_at is not null));
  end if;
  update invitations set last_sent_at = now(), email_status = 'queued', email_error = null
  where project_id = p_project and email = p_email;
  perform public.ping_notify();
end;
$$;
revoke execute on function public.queue_invitation_email from public, anon, authenticated;

-- invite() now also sends the invitation email (p_email_them: false to only record it).
drop function public.invite(text, text, text);
create function public.invite(p_project text, p_email text, p_role text default 'developer', p_email_them boolean default true) returns text
language plpgsql security definer set search_path = public as $$
declare
  existing uuid;
  e text := lower(trim(p_email));
  result text := 'invited';
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if p_role not in ('developer', 'designer', 'admin') then raise exception 'role must be developer, designer or admin'; end if;
  if p_role = 'admin' and not public.is_member(p_project, array['admin']) then raise exception 'only admins can invite admins'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address'; end if;
  insert into invitations (project_id, email, role, invited_by) values (p_project, e, p_role, auth.uid())
  on conflict (project_id, email) do update set role = excluded.role, invited_by = excluded.invited_by;
  select id into existing from auth.users where lower(email) = e;
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

-- Sends a pending invitation's email again (anyone in the project, as for inviting).
create function public.resend_invitation(p_project text, p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare
  e text := lower(trim(p_email));
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if not exists (select 1 from invitations where project_id = p_project and email = e and accepted_at is null) then
    raise exception '% has no pending invitation in this project', e;
  end if;
  perform public.queue_invitation_email(p_project, e);
end;
$$;
grant execute on function public.resend_invitation to authenticated;

-- People, now with how each pending invitation's email went.
drop function public.project_people(text);
create function public.project_people(p_project text)
returns table (email text, role text, pending boolean, email_status text, email_error text, last_sent_at timestamptz)
language sql stable security definer set search_path = public as $$
  select pr.email, m.role, false, null::text, null::text, null::timestamptz from project_members m join profiles pr on pr.id = m.user_id
  where m.project_id = p_project and public.is_member(p_project)
  union all
  select i.email, i.role, true, i.email_status, i.email_error, i.last_sent_at from invitations i
  where i.project_id = p_project and i.accepted_at is null and public.is_member(p_project)
  order by 3, 1;
$$;
grant execute on function public.project_people to authenticated;
