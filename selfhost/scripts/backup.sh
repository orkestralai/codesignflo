#!/bin/sh
# Backs up the box into backups/<date>/: the database (pg_dump, custom format), the stored files (Storage's volume
# as a tar) and the settings (.env, with its secrets: keep the backup as private as .env). The box keeps running.
#
#   sh scripts/backup.sh [backups-folder]        (run from selfhost/, where docker-compose.yml is)
#
# Restore, on a fresh box with the same .env (the same JWT_SECRET and POSTGRES_PASSWORD):
#   cp backups/<date>/.env .env
#   docker compose up -d db                       # the database alone; wait until it's healthy
#   docker compose exec -T db pg_restore -U supabase_admin -d postgres --clean --if-exists --no-owner \
#     --disable-triggers < backups/<date>/db.dump
#   docker compose run --rm -v "$PWD/backups/<date>:/backup:ro" --entrypoint sh storage \
#     -c 'tar -xzf /backup/storage.tar.gz -C /var/lib/storage'
#   docker compose up -d
# (Not yet rehearsed end to end. pg_restore may report a few errors about objects Supabase's own setup owns; the app's data comes back. Try a
# restore on a spare machine before you need one.)
set -eu
cd "$(dirname "$0")/.."
out="${1:-backups}/$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$out"
chmod 700 "$out"

echo "backup: database -> $out/db.dump"
# supabase_admin: the dump includes the auth and storage schemas (accounts, file records), not only public.
docker compose exec -T db pg_dump -U supabase_admin -d postgres -Fc --exclude-schema=_realtime > "$out/db.dump"

echo "backup: stored files -> $out/storage.tar.gz"
docker compose exec -T storage tar -czf - -C /var/lib/storage . > "$out/storage.tar.gz"

cp .env "$out/.env"
chmod 600 "$out/.env" "$out/db.dump" "$out/storage.tar.gz"
echo "backup: done, $(du -sh "$out" | cut -f1) in $out"
