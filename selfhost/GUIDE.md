# Running your own CoDesignFlo

This guide sets up a CoDesignFlo server ("team box") for your team, so designers and developers on different
computers work together without codesignflo.com. Everything runs on one machine: a developer's laptop, an office
computer or a small cloud server.

What you get is the full product (Live in Figma, proposals, the history, the panel, coding agents over MCP) with no
billing and no limits. Sign-in is by email and password, so you don't need Figma or GitHub apps.

## 1. Choose where it runs

| Where | Good for | Reachable from other computers by |
|---|---|---|
| A developer's laptop, same office or home network | Trying it, two people in one place | The laptop's network name, e.g. `http://mac-mini.local:8080` |
| A developer's laptop, anywhere | Small teams, freelancer and client | A private network such as Tailscale (a free `https://….ts.net` address) |
| A small server (any cloud, about €5–10 a month) | Teams in different places or time zones | Your own domain, with HTTPS set up automatically |

On a laptop, the box works only while the laptop is on and awake. Designers can keep working in Figma meanwhile;
what they send goes out when the box is back. You can move the box to a server later (section 8).

**Needs:** Docker with Compose v2, Node 22 (for one setup script), about 1 GB of free memory and 6 GB of disk.

## 2. Start the box

From a copy of this repository:

```sh
cd selfhost
cp .env.example .env
# set PUBLIC_URL to the address people will use (see section 3), then:
node scripts/generate-keys.mjs     # creates the passwords and keys in .env
docker compose up -d --build       # the first start takes a few minutes
```

Open `PUBLIC_URL` in a browser and **create the first account with the setup code** that `generate-keys.mjs` printed
(`SETUP_CODE` in `.env`): it becomes the box's admin. Without the code nobody can, so a box that's reachable before
you get to it is safe.

After that, only people you invite to a project can create an account. Unless the box confirms email addresses
(section 4), each invitation has a **sign-up code**: you see it in People when you invite someone (only you and the
project's admins do), and they type it when they create their account with the invited email. To let your whole
company in without invitations, set `ALLOWED_DOMAINS=yourcompany.com` in `.env` and run `docker compose up -d` again:
this needs email confirmation (section 4), since otherwise anyone could claim an address at your domain.

Check it's healthy: `<PUBLIC_URL>/healthz` shows `"ok":true`.

## 3. Make it reachable

The Figma plugin and the CLI need one address for the box, the same for everybody: `PUBLIC_URL`.

**Same network.** Use the computer's network name: `PUBLIC_URL=http://<name>.local:8080` (on a Mac:
System Settings → General → Sharing → Local hostname). Use a name, not an IP address: Figma doesn't accept IP
addresses for plugins.

**Anywhere, with Tailscale (recommended for a laptop).** Install Tailscale on the box's computer and on each team
member's computer, all signed in to the same tailnet. On the box's computer:

```sh
tailscale serve --bg 8080
```

It prints an address like `https://laptop.tail1234.ts.net`. Set `PUBLIC_URL` to it and restart
(`docker compose up -d`). A Cloudflare tunnel works the same way if you prefer.

**A server with a domain.** Point a DNS name (e.g. `codesignflo.yourcompany.com`) at the server, then in `.env`:

```
PUBLIC_URL=https://codesignflo.yourcompany.com
SITE_ADDRESS=codesignflo.yourcompany.com
HTTP_PORT=443
```

The box gets an HTTPS certificate by itself on the first start (ports 80 and 443 must be open).

## 4. Emails (optional)

Without email settings, the box sends no emails: when you invite someone, tell them yourself to create their
account at `PUBLIC_URL` with the invited address and the invitation's sign-up code (in People). With SMTP (any
provider: your company's mail, Postmark, SendGrid…) set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and
`SMTP_FROM_EMAIL` in `.env`: invitations (with their code) and notifications are emailed, and people can sign in with
an emailed link.

Once emails work, also set `EMAIL_AUTOCONFIRM=false`: people then confirm their address by email when they create
their account, so invitations need no code and `ALLOWED_DOMAINS` works. Accounts' email addresses can't be changed
on a box (invitations go by them).

## 5. Designers: the Figma plugin

Every box has its own plugin, made for its `PUBLIC_URL` (the address and the box's key are built in), so it isn't in
Figma's Community. Each designer installs it once:

1. Sign in at `PUBLIC_URL`, open **Set up** (top right) and choose **Download the plugin**. Unzip it and keep the
   `CoDesignFlo` folder somewhere permanent.
2. In the **Figma desktop app** (macOS or Windows; Figma in a browser can't install plugins this way, and Figma has
   no Linux app), open any design file: **Plugins → Development → Import plugin from manifest…** and pick
   `manifest.json` in that folder.
3. Run it from **Plugins → Development → CoDesignFlo (<host>)**, choose Sign in, and sign in on the page that opens.

After a CoDesignFlo update, download it again and replace the files in the same folder: Figma picks up the new
version without importing again. If `PUBLIC_URL` changes, everyone installs the new plugin.

With Node 22 you can also make it from the command line: `npx @codesignflo/cli plugin build --server <PUBLIC_URL>`.

## 6. Developers: the CLI and the coding agent

Each developer, once:

```sh
npx @codesignflo/cli connect <PUBLIC_URL>
npx @codesignflo/cli login
```

Then set up the app as usual (`npx @codesignflo/cli init`, or ask your coding agent to "set up CoDesignFlo"). `init`
prints the command that connects your coding agent to the box's MCP (`<PUBLIC_URL>/mcp`). To go back to
codesignflo.com: `npx @codesignflo/cli connect --cloud`.

## 7. Updates and backups

**Update:** get the new version of this repository (`git pull`), then `docker compose up -d --build`. New database
changes are applied by themselves on start. Then designers download the plugin again from Set up (same folder) and developers update the CLI
(`npx @codesignflo/cli@latest`).

**Backup:** `sh scripts/backup.sh` saves the database, the stored files and `.env` into `backups/<date>/`. Copy that
folder somewhere else (a cloud drive). On a laptop, run it daily, for example with cron:
`0 18 * * * cd /path/to/selfhost && sh scripts/backup.sh`.

**Restore:** on a fresh box with the backed-up `.env`, follow the steps at the top of `scripts/backup.sh`. Try a
restore once on a spare machine before you need it.

## 8. Moving the box (laptop to server)

1. On the old box: `sh scripts/backup.sh`, then `docker compose down`.
2. On the new machine: copy this repository and the backup, put the backed-up `.env` in `selfhost/`, change
   `PUBLIC_URL` (and `SITE_ADDRESS` for a domain), start the box and restore the backup.
3. Designers download the plugin again from the new address (Set up) and import it; developers run
   `connect <new address>` and `login` again.

## 9. Stopping and removing

- `docker compose down` stops the box and keeps all data.
- `docker compose down -v` **deletes** the database and all stored files. Back up first.

## Troubleshooting

- **The plugin can't connect:** check `PUBLIC_URL` opens in the designer's browser, and that the plugin came from
  exactly that address (download it again from Set up).
- **"Ask a teammate to invite you":** that email isn't invited to any project, or the sign-up code is missing or wrong.
  Invite it from People in a project and pass on the code shown there (or, with email confirmation, add its domain to
  `ALLOWED_DOMAINS`). The first account needs `SETUP_CODE` from `.env`.
- **Forgotten password:** with SMTP set, use the emailed sign-in link. Without SMTP, the admin sets a new one on
  the box's computer, with the key from `.env`:
  ```sh
  docker compose exec db psql -U supabase_admin -d postgres -Atc "select id from auth.users where email = 'name@company.com'"
  curl -X PUT http://localhost:8080/auth/v1/admin/users/<id> \
    -H "apikey: <SERVICE_ROLE_KEY>" -H "Authorization: Bearer <SERVICE_ROLE_KEY>" \
    -H "content-type: application/json" -d '{"password":"<new password>"}'
  ```
- **Logs:** `docker compose logs -f codesignflo` (the CoDesignFlo server), or `auth`, `db`, `gateway`.

CoDesignFlo is also available hosted at https://codesignflo.com, with nothing to run.
