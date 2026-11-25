-- Signing in from the plugin and the CLI without typing a password there ("device code", like gh auth login):
-- 1. the plugin/CLI calls start_login → a secret device code + a short user code;
-- 2. the person opens the login page, signs in (Figma / GitHub), approves the user code;
-- 3. the plugin/CLI polls with its device code and receives the session once. Requests expire in 10 minutes.
create table public.login_requests (
  device_code text primary key,
  user_code text not null unique,
  client text not null check (client in ('plugin', 'cli')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  refresh_token text,
  approved_by uuid references auth.users (id)
);
alter table public.login_requests enable row level security; -- no direct access: only the functions below

create function public.start_login(p_client text) returns table (device_code text, user_code text, expires_at timestamptz)
language plpgsql security definer set search_path = public as $$
declare
  d text := encode(extensions.gen_random_bytes(24), 'hex');
  u text;
begin
  delete from login_requests where login_requests.expires_at < now();
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

create function public.approve_login(p_user_code text, p_refresh_token text) returns text
language plpgsql security definer set search_path = public as $$
declare
  req login_requests;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select * into req from login_requests where user_code = upper(replace(p_user_code, '-', '')) and expires_at > now();
  if req is null then raise exception 'this code has expired or is wrong — start again from the plugin or terminal'; end if;
  update login_requests set refresh_token = p_refresh_token, approved_by = auth.uid() where device_code = req.device_code;
  return req.client;
end;
$$;

-- Returns the session token once (then forgets it); null while not approved yet.
create function public.poll_login(p_device_code text) returns text
language plpgsql security definer set search_path = public as $$
declare
  t text;
begin
  delete from login_requests where device_code = p_device_code and refresh_token is not null and expires_at > now()
  returning refresh_token into t;
  if t is null and not exists (select 1 from login_requests where device_code = p_device_code and expires_at > now()) then
    raise exception 'login expired — start again';
  end if;
  return t;
end;
$$;

grant execute on function public.start_login to anon, authenticated;
grant execute on function public.poll_login to anon, authenticated;
grant execute on function public.approve_login to authenticated;
