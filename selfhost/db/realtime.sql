-- From Supabase's self-hosting setup (docker/volumes/db/realtime.sql): Realtime keeps its own tables here.
\set pguser `echo "$POSTGRES_USER"`

create schema if not exists _realtime;
alter schema _realtime owner to :pguser;
