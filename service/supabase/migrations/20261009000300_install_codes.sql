-- Turning on auto-update from the hosted MCP: a one-time code (10 minutes) the hook-install command
-- exchanges for this machine's own sign-in — no second browser approval, nothing reusable in a transcript.
-- Server-side only (service role).
create table public.install_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  refresh_token text,
  created_at timestamptz not null default now(),
  used_at timestamptz
);
alter table public.install_codes enable row level security;
