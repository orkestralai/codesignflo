#!/bin/sh
# Brings the box's database up to date (the `migrate` service runs it before the server starts, at every start):
#  1. waits for Postgres, Auth (auth.users) and Storage (storage.buckets): the migrations use their tables;
#  2. applies service/supabase/migrations in filename order, each in one transaction, recorded in
#     supabase_migrations.schema_migrations as the Supabase CLI records them (versions already there are skipped);
#  3. makes sure the storage buckets exist and writes the box's settings into public.app_config
#     (mode = selfhost, where the database pings the server about notifications, allowed_domains).
# Environment: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE; MIGRATIONS_DIR; NOTIFY_URL, NOTIFY_SECRET;
# ALLOWED_DOMAINS (optional, comma-separated).
set -eu

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/app/migrations}"
q() { psql -X -v ON_ERROR_STOP=1 -qtA "$@"; }

echo "migrate: waiting for the database, Auth and Storage"
i=0
until q -c "select 1 from auth.users limit 0; select 1 from storage.buckets limit 0;" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    echo "migrate: the database (or Auth's and Storage's tables) didn't come up in 4 minutes" >&2
    q -c "select 1 from auth.users limit 0; select 1 from storage.buckets limit 0;" || true
    exit 1
  fi
  sleep 2
done

q -c "create schema if not exists supabase_migrations;
      create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);"

applied=0
skipped=0
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  base=$(basename "$f" .sql)
  version=${base%%_*}
  name=${base#*_}
  case "$version$name" in
    *[!A-Za-z0-9_-]*) echo "migrate: unexpected file name $base.sql (want <version>_<name>.sql)" >&2; exit 1 ;;
  esac
  if [ -n "$(q -c "select 1 from supabase_migrations.schema_migrations where version = '$version'")" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "migrate: applying $base"
  # The migration and its record in one transaction: a failed one leaves nothing behind and is tried again.
  psql -X -v ON_ERROR_STOP=1 -q --single-transaction \
    -f "$f" \
    -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name')"
  applied=$((applied + 1))
done
echo "migrate: $applied applied, $skipped already there"

# The buckets the migrations make (media, telemetry): created here too, should a future migration not.
q -c "insert into storage.buckets (id, name, public) values ('media', 'media', false), ('telemetry', 'telemetry', false)
      on conflict (id) do nothing;"

# Auth proves email addresses only with SMTP and EMAIL_AUTOCONFIRM=false (then invitations need no sign-up code).
proof=false
if [ -n "${SMTP_HOST:-}" ] && [ "${EMAIL_AUTOCONFIRM:-true}" = "false" ]; then proof=true; fi

# The box's settings. The database pings NOTIFY_URL (pg_net) when there's something to send.
psql -X -v ON_ERROR_STOP=1 -q \
  -v notify_url="${NOTIFY_URL:-}" -v notify_secret="${NOTIFY_SECRET:-}" -v allowed="${ALLOWED_DOMAINS:-}" \
  -v setup_code="${SETUP_CODE:-}" -v email_proof="$proof" <<'SQL'
insert into public.app_config (key, value) values ('mode', 'selfhost')
on conflict (key) do update set value = excluded.value;
\o /dev/null
select set_config('cdf.notify_url', :'notify_url', false), set_config('cdf.notify_secret', :'notify_secret', false),
       set_config('cdf.allowed', :'allowed', false), set_config('cdf.setup_code', :'setup_code', false),
       set_config('cdf.email_proof', :'email_proof', false);
\o
do $$
begin
  if current_setting('cdf.notify_url') <> '' and current_setting('cdf.notify_secret') <> '' then
    insert into public.app_config (key, value) values ('notify_url', current_setting('cdf.notify_url')), ('notify_secret', current_setting('cdf.notify_secret'))
    on conflict (key) do update set value = excluded.value;
  end if;
  -- The first account's code, and whether Auth proves email addresses (20261125000000_selfhost_signup).
  if current_setting('cdf.setup_code') <> '' then
    insert into public.app_config (key, value) values ('setup_code', current_setting('cdf.setup_code'))
    on conflict (key) do update set value = excluded.value;
  end if;
  insert into public.app_config (key, value) values ('email_proof', current_setting('cdf.email_proof'))
  on conflict (key) do update set value = excluded.value;
  -- Only when given: a value set another way stays as it is.
  if current_setting('cdf.allowed') <> '' then
    insert into public.app_config (key, value) values ('allowed_domains', current_setting('cdf.allowed'))
    on conflict (key) do update set value = excluded.value;
  end if;
end;
$$;
SQL
echo "migrate: done ($(q -c "select count(*) from supabase_migrations.schema_migrations") migrations recorded, mode = $(q -c "select value from public.app_config where key = 'mode'"))"
