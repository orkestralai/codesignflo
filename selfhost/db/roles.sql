-- From Supabase's self-hosting setup (docker/volumes/db/roles.sql): the services' database roles get the box's
-- Postgres password. Runs once, when the database is first created. (Without edge functions here, so without
-- supabase_functions_admin, which Supabase's webhooks.sql makes.)
\set pgpass `echo "$POSTGRES_PASSWORD"`

ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
