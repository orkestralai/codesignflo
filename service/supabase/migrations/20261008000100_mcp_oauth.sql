-- Sign-in for the hosted MCP (OAuth 2.1 as MCP clients expect: dynamic client registration, PKCE). The MCP
-- server owns these tables (service role); the sign-in page only approves a request for the signed-in person.

create table public.mcp_clients (
  client_id text primary key,
  name text,
  redirect_uris text[] not null,
  created_at timestamptz not null default now()
);
alter table public.mcp_clients enable row level security;

create table public.mcp_auth_requests (
  id text primary key,
  client_id text not null references public.mcp_clients (client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  state text,
  created_at timestamptz not null default now(),
  -- set when the person approves
  user_id uuid references auth.users (id),
  refresh_token text,
  code text unique,
  used_at timestamptz
);
alter table public.mcp_auth_requests enable row level security;

-- What the sign-in page shows: which app asks (no secrets).
create function public.mcp_request_info(p_request text) returns table (client_name text)
language sql stable security definer set search_path = public as $$
  select coalesce(c.name, 'An MCP client') from mcp_auth_requests r join mcp_clients c using (client_id)
  where r.id = p_request and r.code is null and r.created_at > now() - interval '15 minutes';
$$;

-- The signed-in person approves: their session goes to that MCP client (through a one-time code). The page
-- sends the browser back to the client with the code (it builds the URL, so the state is encoded properly).
create function public.approve_mcp(p_request text, p_refresh_token text) returns table (redirect_uri text, code text, state text)
language plpgsql security definer set search_path = public as $$
declare
  r mcp_auth_requests;
  c text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  update mcp_auth_requests q set user_id = auth.uid(), refresh_token = p_refresh_token, code = c
  where q.id = p_request and q.code is null and q.created_at > now() - interval '15 minutes'
  returning * into r;
  if r.id is null then raise exception 'this request expired — connect again from your coding agent'; end if;
  return query select r.redirect_uri, c, r.state;
end;
$$;

grant execute on function public.mcp_request_info to anon, authenticated;
grant execute on function public.approve_mcp to authenticated;
