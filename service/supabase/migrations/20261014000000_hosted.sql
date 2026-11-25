-- Hosting the service for real: one-time tickets instead of tokens in commands, cleanup of expired sign-in
-- leftovers, limits on MCP client registration, a tiny realtime signal per project (the plugin and the web app
-- react at once instead of polling), notifications (email, Slack), and project columns people can't edit
-- directly.

-- 1. Tickets: `sync` hands the agent a command with a one-time ticket (10 minutes), not the person's token.
-- The CLI exchanges it once at the MCP's /ticket for the sign-in it needs; after that the ticket is worthless,
-- so a transcript or shell history that keeps the command keeps nothing usable. Server-side only.
create table public.cli_tickets (
  code_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id text not null references public.projects (id) on delete cascade,
  access_token text,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.cli_tickets enable row level security; -- no policies: the MCP server (service role) only

-- 2. MCP clients: who registered them (rate limit) and when they were last used (unused ones are removed).
alter table public.mcp_clients add column if not exists ip text;
alter table public.mcp_clients add column if not exists last_used_at timestamptz;
create index if not exists mcp_clients_by_ip on public.mcp_clients (ip, created_at);

-- 3. Cleanup: sign-in leftovers hold sessions until they are used; expired ones go (pg_cron every 15 minutes
-- where it's available; the MCP server also calls it now and then).
create function public.cleanup_expired() returns void
language sql security definer set search_path = public as $$
  delete from login_requests where expires_at < now();
  delete from mcp_auth_requests where created_at < now() - interval '15 minutes';
  delete from install_codes where created_at < now() - interval '10 minutes';
  delete from cli_tickets where created_at < now() - interval '10 minutes';
  delete from mcp_clients c where coalesce(c.last_used_at, c.created_at) < now() - interval '1 day'
    and not exists (select 1 from mcp_auth_requests r where r.client_id = c.client_id);
$$;
revoke execute on function public.cleanup_expired from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('codesignflo-cleanup', '*/15 * * * *', 'select public.cleanup_expired()');
  end if;
exception when others then
  raise notice 'pg_cron not available (%): cleanup runs from the MCP server only', sqlerrm;
end;
$$;

-- 4. Project columns: admins rename a project; everything else changes through the functions that check
-- roles (settings, code link, owner and plan are not editable directly).
revoke update on public.projects from anon, authenticated;
grant update (name) on public.projects to authenticated;

-- 5. Realtime: one small row per project that changes whenever something happens in it. The plugin and the
-- web app listen to it (row-level security: members only) and reload what they show; nothing large or
-- private travels through realtime.
create table public.project_signals (
  project_id text primary key references public.projects (id) on delete cascade,
  seq bigint not null default 0,
  what text not null default '',
  at timestamptz not null default now()
);
alter table public.project_signals enable row level security;
create policy "members see signals" on public.project_signals for select using (public.is_member(project_id));

create function public.signal() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p text := coalesce(new.project_id, old.project_id);
begin
  -- A project being deleted takes its rows with it: nothing to signal.
  if not exists (select 1 from projects where id = p) then return null; end if;
  insert into project_signals (project_id, seq, what, at) values (p, 1, tg_table_name, now())
  on conflict (project_id) do update set seq = project_signals.seq + 1, what = excluded.what, at = now();
  return null;
end;
$$;
create trigger signal_events after insert on public.events for each row execute function public.signal();
create trigger signal_proposals after insert or update on public.proposals for each row execute function public.signal();
create trigger signal_live_updates after insert or update of status on public.live_updates for each row execute function public.signal();
create trigger signal_members after insert or delete on public.project_members for each row execute function public.signal();

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.project_signals;
  end if;
end;
$$;

-- 6. Notifications. Facts worth telling someone about go to an outbox; the web app's /api/notify sends them
-- (email, Slack) and marks them sent. When pg_net is there and the address is configured (app_config), the
-- database pings it at once; otherwise anything that calls /api/notify (a cron) drains the outbox.
create table public.app_config (
  key text primary key,
  value text not null
);
alter table public.app_config enable row level security; -- service role only
comment on table public.app_config is
  'notify_url: https://<app>/api/notify; notify_secret: the same value as NOTIFY_SECRET in the deployment';

create table public.notifications (
  id bigint generated always as identity primary key,
  project_id text not null references public.projects (id) on delete cascade,
  kind text not null,
  component text not null,
  by text not null,
  body jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts int not null default 0,
  error text
);
create index notifications_unsent on public.notifications (id) where sent_at is null;
alter table public.notifications enable row level security; -- service role only

-- Where a project's notifications go besides email: a Slack incoming webhook (admins only; it's a secret).
create table public.project_integrations (
  project_id text primary key references public.projects (id) on delete cascade,
  slack_webhook text,
  updated_at timestamptz not null default now()
);
alter table public.project_integrations enable row level security;
create policy "admins see integrations" on public.project_integrations for select using (public.is_member(project_id, array['admin']));

-- Each person chooses whether they get emails (default: yes).
alter table public.profiles add column if not exists notify_email boolean not null default true;

create function public.set_slack_webhook(p_project text, p_url text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member(p_project, array['admin']) then raise exception 'only the project''s admins set up Slack'; end if;
  if coalesce(trim(p_url), '') <> '' and p_url !~ '^https://hooks\.slack\.com/' then
    raise exception 'that is not a Slack incoming webhook address (https://hooks.slack.com/…)';
  end if;
  insert into project_integrations (project_id, slack_webhook, updated_at) values (p_project, nullif(trim(p_url), ''), now())
  on conflict (project_id) do update set slack_webhook = excluded.slack_webhook, updated_at = now();
end;
$$;

create function public.set_my_notifications(p_email boolean) returns void
language sql security definer set search_path = public as $$
  update profiles set notify_email = p_email where id = auth.uid();
$$;

create function public.my_notifications() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select notify_email from profiles where id = auth.uid()), true);
$$;

grant execute on function public.set_slack_webhook to authenticated;
grant execute on function public.set_my_notifications to authenticated;
grant execute on function public.my_notifications to authenticated;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
exception when others then
  raise notice 'pg_net not available (%): notifications wait for /api/notify to be called', sqlerrm;
end;
$$;

create function public.ping_notify() returns void
language plpgsql security definer set search_path = public as $$
declare
  u text := (select value from app_config where key = 'notify_url');
  s text := (select value from app_config where key = 'notify_secret');
begin
  if u is null or s is null or not exists (select 1 from pg_extension where extname = 'pg_net') then return; end if;
  execute 'select net.http_post(url := $1, body := ''{}''::jsonb, headers := jsonb_build_object(''content-type'', ''application/json'', ''x-codesignflo-secret'', $2))'
    using u, s;
exception when others then
  -- A notification must never stop the fact itself from being saved.
  raise notice 'notify ping failed: %', sqlerrm;
end;
$$;
revoke execute on function public.ping_notify from public, anon, authenticated;

create function public.notify_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('ready', 'designed_new', 'review_answered', 'sent_back', 'closed')
     or (new.kind = 'dev_reviewed' and new.body ->> 'decision' = 'questions') then
    insert into notifications (project_id, kind, component, by, body) values (new.project_id, new.kind, new.component, new."by", new.body);
    perform public.ping_notify();
  end if;
  return null;
end;
$$;
create trigger notify_events after insert on public.events for each row execute function public.notify_event();

create function public.notify_live() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'live' and new.status in ('applied', 'failed') and old.status is distinct from new.status then
    insert into notifications (project_id, kind, component, by, body)
    values (new.project_id, 'live_' || new.status, '', coalesce(new.branch, ''), jsonb_build_object('commit', new.commit, 'log', left(coalesce(new.log, ''), 2000)));
    perform public.ping_notify();
  end if;
  return null;
end;
$$;
create trigger notify_live_updates after update of status on public.live_updates for each row execute function public.notify_live();

-- Redeems a ticket once: the first caller gets its sign-in, which is cleared in the same statement.
create function public.redeem_cli_ticket(p_hash text) returns table (access_token text, project_id text)
language sql security definer set search_path = public as $$
  with t as (
    select code_hash, cli_tickets.access_token, cli_tickets.project_id from cli_tickets
    where code_hash = p_hash and used_at is null and created_at > now() - interval '10 minutes'
    for update skip locked
  )
  update cli_tickets c set used_at = now(), access_token = null from t
  where c.code_hash = t.code_hash
  returning t.access_token, t.project_id;
$$;
revoke execute on function public.redeem_cli_ticket from public, anon, authenticated;
grant execute on function public.redeem_cli_ticket to service_role;
grant execute on function public.cleanup_expired to service_role;
