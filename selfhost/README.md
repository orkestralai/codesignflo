# CoDesignFlo team box (self-hosted)

CoDesignFlo on your own machine: Supabase's open-source stack (Postgres, Auth, PostgREST, Realtime, Storage), the
CoDesignFlo server (web app + MCP) and one entry (Caddy) that serves all of it on **one origin**, so the Figma
plugin and the CLI need a single address.

## Start

Needs Docker with Compose v2 and Node 22 (for the key script). About 1 GB of RAM in use, 5 GB of disk for images.

```sh
cd selfhost
cp .env.example .env              # then set PUBLIC_URL (and SMTP_*, ALLOWED_DOMAINS if you want them)
node scripts/generate-keys.mjs    # fills the secrets and signs the API keys into .env
docker compose pull               # the server image (ghcr.io/orkestralai/codesignflo-server) and the database's
docker compose up -d              # first start: creates the database, applies migrations
```

Open `PUBLIC_URL` (default http://localhost:8080) and create the first account: it becomes the box's admin.
After that, only people invited to a project (or with an email in `ALLOWED_DOMAINS`) can sign up.

- Coding agents connect to `<PUBLIC_URL>/mcp`.
- Health: `<PUBLIC_URL>/healthz`.
- Update: `git pull`, `docker compose pull`, `docker compose up -d` (the `migrate` service applies new migrations).
- Build the server from this checkout instead: empty `CODESIGNFLO_IMAGE` in `.env`, then `docker compose up -d --build`.
- Backup: `sh scripts/backup.sh` (database, stored files and `.env` into `backups/<date>/`; restore notes inside).
- Stop: `docker compose down` (keeps the data). `docker compose down -v` **deletes** the database and files.

For HTTPS on a domain, see `SITE_ADDRESS` in `.env.example`. The full guide, [GUIDE.md](GUIDE.md), covers the rest: making the box reachable from other computers, the Figma plugin, the CLI, emails, updates, backups and moving the box.
