# infra/

Droplet-side scaffolding for deploying photo-showcase as a **second site** on
the existing DigitalOcean droplet that already runs findash. The CD workflow
(`.github/workflows/deploy.yml`) automates the per-release steps; everything in
this README is one-time host setup **you run by SSH**.

## Files

| Path                                 | Purpose                                                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `systemd/photoshowcase.service`      | systemd unit for the Next.js standalone process (port 3300).                                              |
| `sudoers/photoshowcase-unit-install` | Proposed sudoers rule letting CD install the unit above + `daemon-reload`. Not yet applied — see step 4a. |
| `caddy/Caddyfile`                    | Reverse-proxy block for `alejoframes.com` (apex) + `www` redirect.                                        |
| `cron/photoshowcase-backup.sh`       | Daily `pg_dump` + daily R2 off-site sync of the `photoshowcase` DB. See `cron/README.md`.                 |
| `cron/photoshowcase-backup.cron`     | `/etc/cron.d` schedule for the backup script.                                                             |
| `email-deliverability.md`            | SPF/DKIM/DMARC for `alejoframes.com` — what is published, and why the apex has no SPF **on purpose**.     |

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

Ongoing changes to `infra/systemd/photoshowcase.service` ship through CD, not
by hand — the "Install systemd unit" step in `.github/workflows/deploy.yml`
(now positioned right before "Flip symlink + restart", so the unit and the
release flip together) stages the file into a `deploy`-only-writable
directory and runs `install` + `daemon-reload` on every deploy. That needs a
one-time sudoers grant on the droplet first; a brand-new droplet also needs
the very first install done by hand, before that grant can take effect.

**4a. One-time sudoers grant (root).** Read this plainly before applying it:
**this grant is root-equivalent for `deploy`, full stop.** `deploy` already
controls the `ExecStart=` a root-owned unit runs and already holds
`systemctl restart photoshowcase.service`, so letting it write this one unit
file lets it run anything as root on the next restart. Scoping the grant to
one exact source path and one exact destination path bounds _which file_
gets written, not what a hostile or buggy `deploy` could put in it — it
protects against `deploy` mistyping a path, not against a compromised or
malicious `deploy`. The real enforcement boundary is PR review of
`infra/systemd/photoshowcase.service`, branch protection on `main`, custody
of the `DEPLOY_SSH_KEY` secret, and who may dispatch the Deploy workflow.

This is also not a _new_ escalation on this shared droplet: `deploy` already
has an equivalent root-equivalent grant via `findash-redis-provision`
(installing a unit file as root, plus a redis restart). This adds a second
instance of a power `deploy` already has, not a fresh one. See
`infra/sudoers/photoshowcase-unit-install` for the rule itself and the full
reasoning, including why it stages into `/home/deploy/staging` rather than
world-writable `/tmp`.

```bash
sudo cp infra/sudoers/photoshowcase-unit-install /etc/sudoers.d/photoshowcase-unit-install
sudo chmod 0440 /etc/sudoers.d/photoshowcase-unit-install
sudo visudo -c
```

Until this is applied, every deploy's "Install systemd unit" step fails
loudly with the commands above, rather than silently skipping the install —
see that step in `deploy.yml`. That step can still fail _after_ the grant is
applied too (e.g. `install` succeeds but `daemon-reload` does not), leaving
the new unit file on disk but not yet reloaded — the deploy still stops
before anything is restarted, but do not read "the step failed" as always
meaning "the sudoers grant is missing."

This step now runs after migrations and seeding, not before them — a missing
or broken grant fails the deploy _after_ the database has already moved
forward for the new release, not before. That's a deliberate trade, not an
oversight: unit/release skew is persistent host state that outlives the job,
while "the database is ahead of the currently-running code" is a state this
pipeline already reaches at several earlier failure points (a failed seed
step, a failed health probe) with no dedicated data rollback either.

**4b. First install (bootstrap only, root).** Before 4a exists, no deploy can
install the unit itself:

```bash
sudo cp infra/systemd/photoshowcase.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable photoshowcase.service   # starts after first CD deploy
```

Once 4a is applied, the `cp` and `daemon-reload` above become redundant —
every deploy repeats them automatically from then on. The one line that
stays genuinely manual is `systemctl enable`: `deploy` has no `enable` grant,
so a brand-new droplet still needs this run once by hand before the first
CD deploy.

After 4a and 4b, do not hand-edit
`/etc/systemd/system/photoshowcase.service` — edit
`infra/systemd/photoshowcase.service` and deploy instead. **A hand-edit does
not survive the next deploy and nothing warns you when it is lost:** the
deploy pipeline's "Install systemd unit" step overwrites whatever is
installed with the repo's copy, and the follow-up "Verify installed unit
matches repo" step then compares repo against repo — it cannot detect a
hand-edit that the install step already erased, it can only confirm the
install itself took effect byte-for-byte. If a unit change is made directly
on the droplet during an incident, port it back into
`infra/systemd/photoshowcase.service` before the next deploy, or expect it to
disappear silently.

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

**The one thing that can still require a manual `deploy.yml` edit — and it is
a CHECK now, not a vibe.** File presence (the overlay above) says nothing
about whether a script's bare npm imports can actually be resolved once it's
staged: Next's standalone tracing only emits a `node_modules/<pkg>` directory
for packages reachable from an app **route** — anything imported only by a
script (or by an `src/lib/` module a script pulls in) needs its package
hand-overlaid in the same step, or the script dies on `import` with "Cannot
find package '\<name\>'" the moment it actually runs on the droplet, which is
exactly what happened in task #104's first review round: `zod` (imported by
`src/lib/env.ts`) is used by several routes too, but only through Next's
bundler, which inlines it away — nothing ever left a real, `require`-able
`zod` package behind for a raw script to find. **Hand-overlaid today:
`drizzle-orm`, `postgres`, `zod`.** The "Verify ops script import graphs
resolve in the staged tarball" CI step (right after packaging) is the actual
enforcement: it runs `bun build` against every `package.json` script that
points at `scripts/`, statically resolving its whole import graph against
the staged tarball without executing any of it, and fails the deploy loud if
anything doesn't resolve. Trust that step's pass, not this paragraph's list —
the list is why the step exists, and the step is what makes it true.

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
leave production's real objects untouched.

**Source both env files INSIDE the `sudo -u photoshowcase` shell, not
before it.** Both env files are `0640 photoshowcase:photoshowcase` — the
`deploy` user (and anyone SSHing in as it) cannot read either one directly,
so sourcing them before `sudo` fails outright. And even granted a way to read
them first, `sudo` would drop the exported vars anyway: this droplet's sudo
runs with `env_reset` (`/etc/sudoers`), which clears the environment for the
command it invokes unless a variable is explicitly allowlisted with
`env_keep`. Neither `APP_ENV` nor any `R2_*` var is allowlisted, so a child
process started that way sees none of them regardless of what the parent
shell had. The env files have to be sourced by the `photoshowcase` user
itself, inside the `sudo`'d shell that will run the script.

**Invoke the script file directly — `bun <file>.ts`, not `bun run
<package.json alias>`.** This droplet's `sudo` has `secure_path` set to
`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin`,
which does not include `/opt/bun/bin`; Bun 1.3.12 on Linux shells
`package.json` scripts out to `/usr/bin/bash` without prepending its own
directory first, so `bun run backfill:display` inside the `sudo`'d shell
resolves the `bun` it needs to run the alias's own command to nothing:
`bash: line 1: bun: command not found`, `exited with code 127`. (Bun 1.3.10
on macOS does prepend its own directory there — this only reproduces on the
droplet's Linux build, which is why testing this runbook locally would not
have caught it.) Invoking the file directly sidesteps the alias, and its
`bun` entirely — this is the same shape `deploy.yml` already uses in
production for `migrate-prod.ts` and `seed-prod.ts`:

```bash
ssh deploy@<droplet-host>
sudo -n -u photoshowcase /bin/sh -c '
  set -a
  . /srv/photoshowcase/env/photoshowcase.env
  . /srv/photoshowcase/app/current/release.env
  set +a
  cd /srv/photoshowcase/app/current
  exec /opt/bun/bin/bun scripts/backfill-display-derivatives.ts --dry'   # report only, writes nothing

# once the --dry output looks right, drop --dry to actually write:
sudo -n -u photoshowcase /bin/sh -c '
  set -a
  . /srv/photoshowcase/env/photoshowcase.env
  . /srv/photoshowcase/app/current/release.env
  set +a
  cd /srv/photoshowcase/app/current
  exec /opt/bun/bin/bun scripts/backfill-display-derivatives.ts'
```

**What has actually been verified on the droplet, and what has not.** This
exact `--dry` command (env-sourcing, `cd`, and the direct `bun <file>.ts`
invocation together, read-only, no writes) was run against the droplet: it
correctly sourced both env files and reached `exec /opt/bun/bin/bun
scripts/backfill-display-derivatives.ts --dry`, which failed with bun's own
`error: Module not found "scripts/backfill-display-derivatives.ts"` (exit
code 1) — because the script is not staged on the droplet yet (that is this
task's own deploy, not done at the time of writing), not because of the
PATH problem the earlier `bun run` form hit. That confirms the invocation
shape itself — env vars reach the shell, `cd` lands in the release dir,
`/opt/bun/bin/bun` is found and runs directly — without needing the script
to exist first. What this has **not** verified: the script's own behavior
(the `--dry` report, the `assertAppEnvIsSet` guard, an actual R2
read/write) — that only happens once the script is really on the box, after
this task's deploy. Treat the first real `--dry` run post-deploy as the
actual first execution, read its output, and confirm the printed keys land
under the production prefix before dropping `--dry`.

Run the `--dry` pass first and read its output — it lists every asset it
would touch and why (already present vs. would write) before anything is
written. Prove a write landed in the **production** namespace, not `dev/`, by
reading the key the write log itself prints for each asset (it includes the
full resolved R2 key, `dev/`-prefixed or not, not just dimensions/size) —
don't trust the script's own "written" count alone, and don't assume
`APP_ENV=production` was actually what got sourced: a typo'd value
(`prod`, `Production`, a stray trailing space from a bad copy-paste) passes
the unset-check just as easily and still lands every write in `dev/`, so
read the printed key, not just the summary line.

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
