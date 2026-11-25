-- Table access for the API roles. Newer Supabase projects no longer grant it by default, and without it every
-- request fails, the service's own included (registering an MCP client answered 500). Row-level security on every
-- table still decides what anon and signed-in people see and change. Safe to run again.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- The grant above reopens the one table restriction the migrations make (20261014000000_hosted.sql).
revoke update on public.projects from anon, authenticated;
grant update (name) on public.projects to authenticated;
