-- Security fixes (audit of 2026-11-22). Everything is replaced in place and safe to run again.
--
--  1. The demo flag (settings.demo: sends never count) is set by the service only, never by a client.
--  2. Sends to dev are counted from a ledger that outlives the project (deleting a project no longer gives the
--     5 free sends back).
--  3. Functions: nobody may call a function unless it's granted here. Internal helpers (billing_state,
--     sends_used, seat_payer, whitelisted, is_demo…) are no longer callable through the API.
--     NOTE for later migrations: new functions in public are closed by default from now on (default privileges
--     below) — every function a client calls needs its own `grant execute … to authenticated` (or anon).
--  4. Project members are added only through invite() / accept_invitations(); the owner and the last admin
--     can't be removed.
--  5. Limits: invitation emails per inviter, new projects per account, project names 1–80 characters.
--  6. Designer seats: a claim by someone who doesn't pay doesn't block the designer or a paying payer; adding a
--     seat no longer tells whether an email is on the free list.
--  7. Proposals: project and claim can't be changed; a design (payload) written without a seat waits like a
--     send to dev does.
--  8. Events: only the kinds clients write; the author's name comes from their account unless it's one of
--     their own names.
--  9. Sign-in requests and telemetry without a project are capped.

-- A small log of rate-limited actions (who, what, when). Service only; pruned by cleanup_expired.
create table if not exists public.rate_log (
  user_id uuid not null references auth.users (id) on delete cascade,
  what text not null,
  at timestamptz not null default now()
);
create index if not exists rate_log_by_user on public.rate_log (user_id, what, at);
alter table public.rate_log enable row level security; -- no policies: definer functions only
revoke all on public.rate_log from anon, authenticated;

-- ── 1. The demo flag ──────────────────────────────────────────────────────────────────────────────────────

-- Signed-in people and anon never set or change settings.demo, through whatever path (create_project, the
-- functions that update settings, future ones). The service role (/api/demo/start) and migrations do.
create or replace function public.projects_demo_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'INSERT' then
    new.settings := coalesce(new.settings, '{}'::jsonb) - 'demo';
  elsif old.settings ? 'demo' then
    new.settings := (coalesce(new.settings, '{}'::jsonb) - 'demo') || jsonb_build_object('demo', old.settings -> 'demo');
  else
    new.settings := coalesce(new.settings, '{}'::jsonb) - 'demo';
  end if;
  return new;
end;
$$;
drop trigger if exists demo_guard on public.projects;
create trigger demo_guard before insert or update on public.projects for each row execute function public.projects_demo_guard();

-- Projects marked demo before this by someone else than the service: a real demo always has Alex (the demo's
-- simulated developer) in it. Others lose the flag (and their sends count, see the ledger's backfill below).
update public.projects p set settings = p.settings - 'demo'
where p.settings ? 'demo'
  and not exists (
    select 1 from public.project_members m join public.profiles pr on pr.id = m.user_id
    where m.project_id = p.id and pr.email = 'alex@demo.codesignflo.com'
  );

-- A demo project is for trying CoDesignFlo with Alex: nobody else is invited into it, no other code is linked
-- to it, and Live there comes from the service only.
create or replace function public.demo_live_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.is_demo(new.project_id) then
    raise exception 'the demo project shows its sample app only — connect your own app in a project of your own' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists demo_guard on public.live_updates;
create trigger demo_guard before insert on public.live_updates for each row execute function public.demo_live_guard();

create or replace function public.link_codebase(p_project text, p_root_commit text, p_folder text default '.') returns text
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_project, array['admin', 'developer']) then raise exception 'only the project''s developers can link its code'; end if;
  if public.is_demo(p_project) then raise exception 'the demo project can''t be linked to code — start a project of your own' using errcode = '42501'; end if;
  if exists (select 1 from projects where repo_root_commit = p_root_commit and repo_folder = p_folder and id <> p_project) then
    raise exception 'this app already has a CoDesignFlo project — ask its owner to invite you';
  end if;
  update projects set repo_root_commit = p_root_commit, repo_folder = p_folder
  where id = p_project and (repo_root_commit is null or (repo_root_commit = p_root_commit and repo_folder = p_folder));
  if not found then raise exception 'this project is already linked to other code'; end if;
  return p_project;
end;
$$;

-- ── 5. Project names, and new projects per account ───────────────────────────────────────────────────────

-- NOT VALID: rows from before aren't checked (none are known to break it); every new or renamed one is.
alter table public.projects drop constraint if exists projects_name_length;
alter table public.projects add constraint projects_name_length check (char_length(btrim(name)) between 1 and 80) not valid;

create or replace function public.create_project(p_name text, p_root_commit text, p_folder text default '.', p_settings jsonb default '{}'::jsonb, p_id text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  new_id text;
  n text := btrim(coalesce(p_name, ''));
  -- Only the settings clients start a project with (the CLI moving a local project: tokens, trackedBranch).
  s jsonb := coalesce((select jsonb_object_agg(key, value) from jsonb_each(coalesce(p_settings, '{}'::jsonb))
                       where key in ('tokens', 'trackedBranch', 'liveBranch')), '{}'::jsonb);
begin
  if uid is null then raise exception 'sign in first'; end if;
  if char_length(n) not between 1 and 80 then raise exception 'a project''s name is 1 to 80 characters'; end if;
  if p_root_commit is not null and exists (select 1 from projects where repo_root_commit = p_root_commit and repo_folder = p_folder) then
    raise exception 'this app already has a CoDesignFlo project — ask its owner to invite you' using errcode = 'P0001';
  end if;
  if p_id is not null and (p_id !~ '^p_[0-9a-f]{12}$' or exists (select 1 from projects where id = p_id)) then
    raise exception 'that project id is taken or invalid';
  end if;
  if (select count(*) from rate_log where user_id = uid and what = 'project' and at > now() - interval '1 day') >= 20 then
    raise exception 'you''ve started 20 projects today — try again tomorrow' using errcode = 'P0429';
  end if;
  insert into rate_log (user_id, what) values (uid, 'project');
  insert into projects (id, name, owner, repo_root_commit, repo_folder, settings)
  values (coalesce(p_id, 'p_' || encode(extensions.gen_random_bytes(6), 'hex')), n, uid, p_root_commit, p_folder, s)
  returning id into new_id;
  insert into project_members (project_id, user_id, role) values (new_id, uid, 'admin');
  return new_id;
end;
$$;

-- ── 5. Invitations: emails per inviter (all projects); none into a demo project ──────────────────────────

create or replace function public.queue_invitation_email(p_project text, p_email text) returns void
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
  if auth.uid() is not null then
    if (select count(*) from rate_log where user_id = auth.uid() and what = 'invite_email' and at > now() - interval '1 day') >= 50 then
      raise exception 'you''ve sent 50 invitation emails today — try again tomorrow' using errcode = 'P0429';
    end if;
    insert into rate_log (user_id, what) values (auth.uid(), 'invite_email');
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

create or replace function public.invite(p_project text, p_email text, p_role text default 'developer', p_email_them boolean default true) returns text
language plpgsql security definer set search_path = public as $$
declare
  existing uuid;
  current_role_ text;
  e text := lower(trim(p_email));
  result text := 'invited';
begin
  if not public.is_member(p_project) then raise exception 'you are not in this project'; end if;
  if public.is_demo(p_project) then raise exception 'the demo project is just for you and Alex — start a project of your own to invite people' using errcode = '42501'; end if;
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

-- ── 2. The send ledger ───────────────────────────────────────────────────────────────────────────────────

-- One row per send to dev (Ready for dev, a new design) outside demo projects. Insert-only, written by the
-- events trigger below; it has no link to the project, so deleting a project keeps its sends counted.
create table if not exists public.send_ledger (
  project_id text not null,
  event_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  at timestamptz not null default now(),
  primary key (project_id, event_id)
);
create index if not exists send_ledger_by_user on public.send_ledger (user_id);
alter table public.send_ledger enable row level security; -- no policies: counted through my_sends / my_billing
revoke all on public.send_ledger from anon, authenticated;

-- A BEFORE trigger (after billing_guard and events_author, which fire first by name) so the guard of the next
-- row in the same batch sees this one: the 6th send in a batch is still refused. A duplicate event (clients
-- send with on conflict do nothing) hits the ledger's own key and isn't counted twice.
create or replace function public.record_send() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('ready', 'designed_new') and new.user_id is not null and not public.is_demo(new.project_id) then
    insert into send_ledger (project_id, event_id, user_id, kind, at) values (new.project_id, new.id, new.user_id, new.kind, now())
    on conflict do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists sends_ledger on public.events;
create trigger sends_ledger before insert on public.events for each row execute function public.record_send();

-- The sends counted until now (the same events sends_used counted).
insert into public.send_ledger (project_id, event_id, user_id, kind, at)
select e.project_id, e.id, e.user_id, e.kind, e.at from public.events e
where e.kind in ('ready', 'designed_new') and e.user_id is not null and not public.is_demo(e.project_id)
on conflict do nothing;

create or replace function public.sends_used(p_user uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from send_ledger where user_id = p_user;
$$;

-- ── 4. Project members ───────────────────────────────────────────────────────────────────────────────────

-- Added only by invite() and accept_invitations() (definer); no direct inserts.
drop policy if exists "admins add members" on public.project_members;
-- Admins remove members, but never the owner nor the last admin (checked after the delete, so removing
-- several at once can't leave a project without an admin). A project being deleted takes all its members.
drop policy if exists "admins remove members" on public.project_members;
create policy "admins remove members" on public.project_members for delete using (public.is_member(project_id, array['admin']));

create or replace function public.members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o uuid;
begin
  if auth.uid() is null then return null; end if;
  select owner into o from projects where id = old.project_id;
  if o is null then return null; end if;  -- the project itself is being deleted
  if old.user_id = o then raise exception 'the project''s owner stays in the project' using errcode = '42501'; end if;
  if old.role = 'admin' and not exists (select 1 from project_members where project_id = old.project_id and role = 'admin') then
    raise exception 'that''s the project''s last admin — make someone else an admin first' using errcode = '42501';
  end if;
  return null;
end;
$$;
drop trigger if exists members_guard on public.project_members;
create trigger members_guard after delete on public.project_members for each row execute function public.members_guard();

-- ── 6. Designer seats ────────────────────────────────────────────────────────────────────────────────────

-- Pay for a seat: 'added', 'yours' (already), 'taken' (someone who pays for it holds it). A claim by someone
-- without an active subscription doesn't block: the designer themselves, someone subscribed, or anyone after a
-- day takes it over. The free list isn't revealed: a free-listed email is added like any other (billing_seats
-- never charges for it); only the designer's own address answers 'free' (they see it in Billing anyway).
create or replace function public.add_seat(p_email text) returns text
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  e text := lower(trim(p_email));
  mine text := lower((select email from auth.users where id = auth.uid()));
  held designer_seats;
  holder_pays boolean;
begin
  if uid is null then raise exception 'sign in first'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'that is not an email address'; end if;
  if e = mine and exists (select 1 from billing_whitelist where email = e) then return 'free'; end if;
  select * into held from designer_seats where email = e;
  if held.payer = uid then return 'yours'; end if;
  if held.payer is not null then
    holder_pays := exists (select 1 from billing_accounts a where a.user_id = held.payer and a.status in ('active', 'trialing', 'past_due'));
    if holder_pays
       or not (e = mine
               or exists (select 1 from billing_accounts a where a.user_id = uid and a.status in ('active', 'trialing', 'past_due'))
               or held.added_at < now() - interval '1 day') then
      return 'taken';
    end if;
    update designer_seats set payer = uid, added_at = now() where email = e;
  else
    insert into designer_seats (email, payer) values (e, uid);
  end if;
  perform public.ping_notify();  -- a subscribed payer's quantity follows
  return 'added';
end;
$$;

-- ── 7. Proposals ─────────────────────────────────────────────────────────────────────────────────────────

drop policy if exists "members update proposals" on public.proposals;
create policy "members update proposals" on public.proposals for update
  using (public.is_member(project_id)) with check (public.is_member(project_id));

-- Each side writes its own part (20261117000100_event_authors); project and claim never change; a design
-- written by a designer (or admin) whose free sends are used waits, as its send to dev does (the plugin
-- uploads the proposal with the send and keeps both queued on the refusal).
create or replace function public.proposals_sides() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text;
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'UPDATE' and (new.project_id is distinct from old.project_id or new.claim_id is distinct from old.claim_id) then
    raise exception 'a proposal stays in its project and claim' using errcode = '42501';
  end if;
  select role into r from project_members where project_id = new.project_id and user_id = auth.uid();
  if r is null then return new; end if;  -- not a member: the policy refuses it
  if r = 'developer' then
    if tg_op = 'INSERT' then return null; end if;
    new.payload := old.payload;
    new.component := old.component;
    return new;
  end if;
  if r = 'designer' and tg_op = 'UPDATE' then new.code_check := old.code_check; end if;
  if (tg_op = 'INSERT' or new.payload is distinct from old.payload or new.component is distinct from old.component)
     and not public.is_demo(new.project_id)
     and public.billing_state(auth.uid()) = 'unpaid' then
    raise exception '%', public.read_only_message(new.project_id) using errcode = 'P0402';
  end if;
  return new;
end;
$$;

-- ── 8. Events: known kinds, and the author's name ────────────────────────────────────────────────────────

-- The name a person is shown by: their provider's name, else their email.
create or replace function public.display_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
    nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(u.raw_user_meta_data ->> 'user_name'), ''),
    u.email::text,
    'someone')
  from auth.users u where u.id = p_user;
$$;

create or replace function public.events_author() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text;
  u auth.users;
begin
  if auth.uid() is null then return new; end if;
  new.user_id := auth.uid();
  select role into r from project_members where project_id = new.project_id and user_id = auth.uid();
  if r is null then return new; end if;  -- not a member: the policy refuses it
  -- Only the kinds clients write (packages/core/src/ledger/events.ts); anything else is dropped.
  if new.kind not in ('generated', 'registered', 'delivered', 'sent_back', 'dev_reviewed', 'building', 'stopped_building',
                      'resolved', 'closed', 'proposal_changed_after_ready', 'removed_in_code', 'claimed', 'unclaimed',
                      'reopened', 'ready', 'seen', 'accepted', 'ignored', 'compared', 'review_requested', 'kept', 'unkept',
                      'designed_new', 'review_answered') then
    return null;
  end if;
  -- The author shown: what the client says only when it's one of the person's own names (their Figma name,
  -- their email…) or the CLI's own label; otherwise their name from their account.
  select * into u from auth.users where id = auth.uid();
  if new."by" is null or (lower(btrim(new."by")) <> 'cli' and lower(btrim(new."by")) not in (
       select lower(btrim(x)) from unnest(array[
         u.email::text, u.raw_user_meta_data ->> 'name', u.raw_user_meta_data ->> 'full_name',
         u.raw_user_meta_data ->> 'user_name', u.raw_user_meta_data ->> 'preferred_username']) x where x is not null)) then
    new."by" := public.display_name(auth.uid());
  end if;
  if r = 'admin' then return new; end if;
  if new.kind in ('claimed', 'unclaimed', 'reopened', 'ready', 'designed_new', 'review_answered', 'review_requested',
                  'kept', 'unkept', 'accepted', 'ignored') and r <> 'designer' then
    return null;
  end if;
  if new.kind in ('dev_reviewed', 'building', 'stopped_building', 'delivered', 'resolved') and r <> 'developer' then
    return null;
  end if;
  return new;
end;
$$;

-- ── 9. Sign-in requests, telemetry without a project ─────────────────────────────────────────────────────

create or replace function public.start_login(p_client text) returns table (device_code text, user_code text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  d text := encode(extensions.gen_random_bytes(24), 'hex');
  u text;
begin
  delete from login_requests where login_requests.expires_at < now();
  -- Requests live 10 minutes: this many at once is someone filling the table, not people signing in.
  if (select count(*) from login_requests) >= 1000 then
    raise exception 'too many sign-ins are starting right now — try again in a few minutes' using errcode = 'P0429';
  end if;
  loop
    -- 8 characters, no look-alikes (0/O, 1/I), shown as XXXX-XXXX
    u := (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 32), 1), '')
          from (select extensions.gen_random_bytes(8) b) r, generate_series(0, 7) i);
    exit when not exists (select 1 from login_requests where login_requests.user_code = u);
  end loop;
  insert into login_requests (device_code, user_code, client) values (d, u, p_client);
  return query select d, u, now() + interval '10 minutes';
end;
$$;

-- Telemetry with no project (a crash before init): 200 rows per person per day; more are dropped, not refused
-- (clients send in batches).
create index if not exists telemetry_no_project on public.telemetry (user_id, at) where project_id is null;
create or replace function public.telemetry_cap() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.project_id is null and auth.uid() is not null
     and (select count(*) from telemetry where user_id = auth.uid() and project_id is null and at > now() - interval '1 day') >= 200 then
    return null;
  end if;
  return new;
end;
$$;
drop trigger if exists telemetry_cap on public.telemetry;
create trigger telemetry_cap before insert on public.telemetry for each row execute function public.telemetry_cap();

create or replace function public.cleanup_expired() returns void
language sql security definer set search_path = public as $$
  delete from login_requests where expires_at < now();
  delete from mcp_auth_requests where created_at < now() - interval '15 minutes';
  delete from install_codes where created_at < now() - interval '10 minutes';
  delete from cli_tickets where created_at < now() - interval '10 minutes';
  delete from mcp_clients c where coalesce(c.last_used_at, c.created_at) < now() - interval '1 day'
    and not exists (select 1 from mcp_auth_requests r where r.client_id = c.client_id);
  delete from rate_log where at < now() - interval '2 days';
$$;

-- ── 3. Who may call which function ───────────────────────────────────────────────────────────────────────

-- Closed by default: functions created from now on (by postgres, the role migrations run as) aren't callable
-- by PUBLIC, anon or authenticated until a migration grants them. service_role keeps its default grant.
-- (Global for postgres: a per-schema rule can't take back the global PUBLIC default. Supabase's own schemas are
-- created by other roles, so this only closes functions our migrations create.)
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- Before signing in (the plugin's and the CLI's sign-in, the agent-connect page). is_member: the row-level
-- policies that apply to every role call it (it answers false for anon).
grant execute on function public.start_login(text) to anon, authenticated;
grant execute on function public.poll_login(text) to anon, authenticated;
grant execute on function public.mcp_request_info(text) to anon, authenticated;
grant execute on function public.is_member(text, text[]) to anon, authenticated;

-- Used in row-level policies (tables, storage) — evaluated as the signed-in person.
grant execute on function public.is_admin() to authenticated;
grant execute on function public.shares_content(text) to authenticated;

-- What the plugin, the CLI, the web app and the MCP (as the signed-in person) call.
grant execute on function public.accept_invitations() to authenticated;
grant execute on function public.add_seat(text) to authenticated;
grant execute on function public.admin_add(text) to authenticated;
grant execute on function public.admin_billing() to authenticated;
grant execute on function public.admin_people() to authenticated;
grant execute on function public.admin_projects() to authenticated;
grant execute on function public.admin_remove(text) to authenticated;
grant execute on function public.approve_login(text, text) to authenticated;
grant execute on function public.approve_mcp(text, text) to authenticated;
grant execute on function public.create_project(text, text, text, jsonb, text) to authenticated;
grant execute on function public.delete_project(text) to authenticated;
grant execute on function public.find_project(text, text) to authenticated;
grant execute on function public.finish_update(bigint, boolean, text) to authenticated;
grant execute on function public.free_add(text, text) to authenticated;
grant execute on function public.free_remove(text) to authenticated;
grant execute on function public.invite(text, text, text, boolean) to authenticated;
grant execute on function public.link_codebase(text, text, text) to authenticated;
grant execute on function public.link_file(text, text) to authenticated;
grant execute on function public.my_billing() to authenticated;
grant execute on function public.my_notifications() to authenticated;
grant execute on function public.my_projects() to authenticated;
grant execute on function public.my_role(text) to authenticated;
grant execute on function public.my_seats() to authenticated;
grant execute on function public.my_sends() to authenticated;
grant execute on function public.plugin_seen(text, text) to authenticated;
grant execute on function public.project_billing(text) to authenticated;
grant execute on function public.project_people(text) to authenticated;
grant execute on function public.projects_without_code() to authenticated;
grant execute on function public.release_update(bigint) to authenticated;
grant execute on function public.remove_seat(text) to authenticated;
grant execute on function public.resend_invitation(text, text) to authenticated;
grant execute on function public.set_build_mode(text, text) to authenticated;
grant execute on function public.set_live_branch(text, text) to authenticated;
grant execute on function public.set_my_notifications(boolean) to authenticated;
grant execute on function public.set_share_content(text, boolean) to authenticated;
grant execute on function public.set_slack_webhook(text, text) to authenticated;
grant execute on function public.take_next_update(text) to authenticated;
grant execute on function public.take_update(text) to authenticated;
grant execute on function public.telemetry_summary(integer) to authenticated;
grant execute on function public.telemetry_timings(integer) to authenticated;
grant execute on function public.update_progress(bigint, integer, integer, text) to authenticated;
grant execute on function public.update_progress(bigint, integer, integer, text, boolean) to authenticated;
