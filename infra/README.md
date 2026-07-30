# infra/

Droplet-side scaffolding for deploying photo-showcase as a **second site** on
the existing DigitalOcean droplet that already runs findash. The CD workflow
(`.github/workflows/deploy.yml`) automates the per-release steps; everything in
this README is one-time host setup **you run by SSH**.

## Files

| Path                             | Purpose                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `systemd/photoshowcase.service`  | systemd unit for the Next.js standalone process (port 3300).                              |
| `caddy/Caddyfile`                | Reverse-proxy block for `alejoframes.com` (apex) + `www` redirect.                        |
| `cron/photoshowcase-backup.sh`   | Daily `pg_dump` + daily R2 off-site sync of the `photoshowcase` DB. See `cron/README.md`. |
| `cron/photoshowcase-backup.cron` | `/etc/cron.d` schedule for the backup script.                                             |

## One-time droplet bring-up

Run as a sudo-capable user on the droplet. `$USER_NAME` = `photoshowcase`.

### 1. Service user + directory layout

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin photoshowcase
sudo mkdir -p /srv/photoshowcase/app/releases /srv/photoshowcase/env /srv/photoshowcase/logs
# chown the WHOLE tree: `install -d` only sets ownership on the last path
# component, leaving /srv/photoshowcase and /srv/photoshowcase/app root-owned —
# then the CD `ln -s current` fails with EACCES.
sudo chown -R photoshowcase:photoshowcase /srv/photoshowcase
```

### 1b. Shared bun runtime

The systemd unit and the CD migration step run `/opt/bun/bin/bun`. The distro's
`/usr/local/bin/bun` is a symlink into `/home/findash/.bun`, which the
`photoshowcase` user cannot traverse — so install a neutral, root-owned copy:

```bash
sudo install -D -m 0755 /home/findash/.bun/bin/bun /opt/bun/bin/bun
sudo -u photoshowcase /opt/bun/bin/bun --version   # verify photoshowcase can exec it
```

### 2. Postgres DB + role (peer auth)

```bash
sudo -u postgres createuser photoshowcase          # peer-auth role, no password
sudo -u postgres createdb  -O photoshowcase photoshowcase
```

The app connects over the unix socket as the `photoshowcase` OS user → peer
auth, no password in the env file. Matches `src/lib/db/index.ts`.

### 3. Runtime env file

```bash
sudo -u photoshowcase tee /srv/photoshowcase/env/photoshowcase.env >/dev/null <<'EOF'
PGDATABASE=photoshowcase
# Phase 2+: AUTH_SECRET, RESEND_API_KEY, R2_* — added when those features land.
EOF
sudo chmod 0640 /srv/photoshowcase/env/photoshowcase.env
```

### 4. systemd unit

```bash
sudo cp infra/systemd/photoshowcase.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable photoshowcase.service   # starts after first CD deploy
```

The unit declares `CacheDirectory=photoshowcase` — unlike `/srv/photoshowcase`
above, `/var/cache/photoshowcase` needs no manual `mkdir`/`chown`; systemd
creates it (owned by `photoshowcase:photoshowcase`) on every service start and
leaves it in place across restarts and deploys. The CD workflow symlinks each
release's `.next/cache` to it, since Next's image optimizer cache has to live
somewhere writable and the release tree itself is read-only to the running
process by design (`ProtectSystem=strict`). See task #99.

### 5. Caddy site block

Caddy already fronts findash on this droplet as a single `/etc/caddy/Caddyfile`
(no `import`). Append this site's block to it. **Do this only after steps 6–7
(the apex origin cert must be on disk)** — otherwise `caddy validate` fails on
the missing `tls` files and the reload is rejected.

```bash
cat infra/caddy/Caddyfile | sudo tee -a /etc/caddy/Caddyfile >/dev/null
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**The `tee -a` command above is for the first install only.** It appends —
running it again on a droplet that already has this site block produces a
_second_ `alejoframes.com` block, and Caddy rejects the merged file with
`Error: ambiguous site definition`. See the next section for updating an
already-installed block.

### Updating an already-installed site block

`infra/caddy/Caddyfile` has no `import`, so a change to it (e.g. task #69's
`trusted_proxies` pinning) does not ship on its own — nothing in CD touches
Caddy. To land a change to this file on the droplet, replace the existing
`alejoframes.com` block (and its header comment) in `/etc/caddy/Caddyfile`
with the new contents of `infra/caddy/Caddyfile`, by hand:

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
sudoedit /etc/caddy/Caddyfile   # replace the existing alejoframes.com block
                                # (and its header comment) with this file's contents
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If `caddy validate` rejects the edit, `/etc/caddy/Caddyfile.bak` is the
pre-edit copy to restore from; the running Caddy process keeps serving the
old config until `reload` succeeds, so a bad edit fails safe.

### 6. Cloudflare origin cert (apex)

The findash cert is scoped to its subdomain and does **not** cover the apex.
Issue a Cloudflare origin cert that includes `alejoframes.com` (and
`www.alejoframes.com`), then:

```bash
sudo install -m 0644 alejoframes-origin.pem /etc/caddy/alejoframes-origin.pem
sudo install -m 0640 -g caddy alejoframes-origin.key /etc/caddy/alejoframes-origin.key
sudo systemctl reload caddy
```

### 7. DNS (Cloudflare dashboard)

- `alejoframes.com` (apex) → droplet IP, **proxied** (orange cloud).
- `www.alejoframes.com` → droplet IP, proxied (Caddy redirects it to the apex).
- SSL/TLS mode: **Full (strict)**.

## GitHub Actions secrets (repo settings)

The deploy workflow needs these repo secrets:

| Secret           | Value                                                       |
| ---------------- | ----------------------------------------------------------- |
| `DEPLOY_HOST`    | droplet IP (`147.182.138.79`)                               |
| `DEPLOY_USER`    | `deploy` (low-priv CD user, narrow sudo)                    |
| `DEPLOY_SSH_KEY` | private key authorized for `deploy` (dedicated, not root's) |

The deploy workflow health-probes `http://127.0.0.1:3300/api/health` on the
droplet over SSH, so it does not need a public URL and works before Cloudflare
DNS + the apex origin cert are in place.

## First deploy

Push to `main` (or run the **Deploy** workflow manually). On success:

```bash
curl https://alejoframes.com/api/health   # expect {"ok":true,...,"db":"ok"}
```

## Ops scripts (scripts/) — how they reach the droplet, and how to run one

Every file under `scripts/` (and every module it imports from `src/lib/`)
ships to the droplet inside every release, staged by the CD workflow's
"Package release tarball" step. This is a **wholesale overlay**, not an
allowlist: nothing needs to be added to `.github/workflows/deploy.yml` for a
new script to reach `/srv/photoshowcase/app/current/scripts/`.

**This was not always true.** Task #104: `backfill-display-derivatives.ts`
(task #89) shipped in `package.json`'s `backfill:display` script but was
invisible to the droplet, because the packaging step staged ops scripts by an
explicit allowlist — one `cp` per file — and nobody added a line for the new
one. `git log` on that step's history is the record of every time this was
almost repeated; the fix was to stop needing a line at all. If a future
change reintroduces per-file `cp` lines there, that is a regression — reread
task #104's reasoning in the step's own comment before doing it.

**The one thing that can still require a manual `deploy.yml` edit**: a script
that imports an npm package no route in the app already uses (so Next's
standalone build never traced it into `.next/standalone/node_modules`). The
step already overlays `drizzle-orm` and `postgres` for exactly this reason —
`scripts/migrate-prod.ts` is the only caller of `drizzle-orm/postgres-js/
migrator` anywhere in the codebase. A script that stays within packages the
app itself already imports (`sharp`, `zod`, the `bun` types, …) needs nothing
extra.

### Running `bun run backfill:display` (task #89's required post-deploy step)

This backfills the unwatermarked, browsing-sized `display` derivative (task
#89) for finals uploaded before that feature shipped. Idempotent and
resumable — safe to re-run, and it skips any asset whose derivative already
exists.

**It refuses to run if `APP_ENV` is unset**, on purpose (task #81, task
#104): a script invoked by hand over SSH inherits none of systemd's
`EnvironmentFile`s, and `src/lib/r2.ts`'s `namespacedKey()` silently prefixes
every key with `dev/` when `APP_ENV` is unset — this script would otherwise
write every display derivative into the dev namespace, print success, and
leave production's real objects untouched. Source both env files explicitly
first:

```bash
ssh deploy@<droplet-host>
cd /srv/photoshowcase/app/current
set -a
. /srv/photoshowcase/env/photoshowcase.env      # R2_*, PGDATABASE, ...
. release.env                                   # APP_ENV=production, GIT_SHA
set +a
sudo -n -u photoshowcase /opt/bun/bin/bun run backfill:display -- --dry  # report only
sudo -n -u photoshowcase /opt/bun/bin/bun run backfill:display           # writes to R2
```

Run the `--dry` pass first and read its output — it lists every asset it
would touch and why (already present vs. would write) before anything is
written. Prove a write landed in the **production** namespace, not `dev/`,
by listing the resulting key (e.g. via `check-r2.ts`'s pattern or the R2
dashboard) rather than trusting the script's own "written" count alone.

## Backups

The `photoshowcase` database — not the R2 media bucket — is the irreplaceable
artifact: it's what says which photos belong to which client, what they
selected, and what they were quoted at. See `cron/README.md` for the full
runbook (install steps, retention, manual runs, restore-test log).

Quick install:

```bash
sudo install -m 0755 infra/cron/photoshowcase-backup.sh /usr/local/bin/photoshowcase-backup.sh
sudo install -m 0644 infra/cron/photoshowcase-backup.cron /etc/cron.d/photoshowcase-backup
```

## Media storage (R2) — Phase 2

Gallery media lives in a private Cloudflare R2 bucket served via presigned URLs
(see PLAN.md §5). Provision the bucket + credentials when Phase 2 lands; nothing
to do at Phase 0.

## Proof processing (sharp) — server font prerequisite

`src/lib/images.ts` renders the watermark as an SVG `<text>` element through
sharp's bundled librsvg/pango/fontconfig stack. sharp ships that text-rendering
stack but ships **no font files** — on Linux it resolves fonts from the host's
fontconfig, so the droplet needs at least one font package installed:

```bash
sudo apt-get install -y fonts-dejavu-core
```

If no font is resolvable, librsvg silently rasterizes fully transparent
glyphs. `processProof` guards against this (`assertTileHasInk` throws if the
rasterized watermark tile's alpha channel is fully transparent), so a missing
font surfaces as a loud proof-processing failure rather than a silently
unwatermarked proof — but the guard only turns the failure mode from silent
to loud, it doesn't fix it. Install the font package before shipping this
slice to the droplet.
