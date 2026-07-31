# photoshowcase backup cron

Daily automated backups for the `photoshowcase` PostgreSQL database. Started
as a mirror of `personal-financial-dashboard/infra/cron/findash-backup.sh`
(same script shape, same local retention) but intentionally **does not**
copy its weekly-only R2 cadence — see "Why R2 sync is daily, not weekly"
below.

## Why this exists

Gallery photos live in Cloudflare R2 and are durable on their own. The
database is what says WHICH photos belong to WHICH client, what they
selected, and what they were quoted (`included_photos_snapshot`,
`extra_photo_price_cop_snapshot`). Losing it leaves every file in the bucket
and no idea whose it is or what was agreed. The blobs are not the valuable
part — the relationships are.

## What it does

- **Daily at 03:30 UTC**: `pg_dump photoshowcase | gzip` →
  `/srv/photoshowcase/backups/daily/photoshowcase-YYYYMMDDTHHMMSS.sql.gz`.
  Staggered 15 minutes after `findash-backup` (03:15 UTC) so the two dumps
  against the same PostgreSQL instance don't overlap.
- A dump that fails, or produces a truncated/corrupt gzip stream (checked
  with `gzip -t`), is deleted immediately and the script exits non-zero — it
  never occupies a retention slot or gets synced to R2.
- Keeps the **14 most recent** local dumps; older ones are pruned
  automatically.
- **Same run**: syncs the local daily dir to Cloudflare R2
  (`s3://$R2_BUCKET/photoshowcase-db/`), then prunes R2 to the **90 most
  recent** dumps (90 days).
- R2 sync is skipped (exit 0, but still an alert — see below) only if
  `/srv/photoshowcase/env/photoshowcase.env` is missing entirely. If the
  file exists but the R2 credentials in it are incomplete, the script fails
  loudly (exit 1) instead of silently skipping — an R2 token revoked at
  Cloudflare must not look like a successful backup run.
- Routine progress lines go **only** to `/srv/photoshowcase/logs/backup.log`
  — never to stdout/stderr. Only genuine problems print anything on
  stdout/stderr. This matters because cron mails a job's stdout+stderr
  whenever it is non-empty, **regardless of exit status** — not "on
  failure". If routine lines went to stdout too, a fully successful run
  would generate a daily "it worked" email once an MTA exists (#72),
  exactly the alert-fatigue pattern that gets a real failure filtered into
  a folder nobody reads.

## Why R2 sync is daily, not weekly

findash's script (the pattern this one started from) only syncs to R2 once a
week. Copying that cadence here would give this database — the one this
whole change exists to protect — a 7-day recovery point objective, on top of
the "daily" local dumps sitting on the very disk a host failure would take
out. The dump is a few KB gzipped, so daily sync costs nothing (well inside
R2's free tier, no meaningful egress). The stronger reason: a path that only
runs 52 times a year hides a break in it up to 7x longer than one that runs
365 times a year — which is exactly how findash's own R2 sync went unnoticed
(see below). Daily makes the offsite path self-testing.

## Where R2 credentials come from

Unlike findash (which reads a dedicated `/srv/findash/env/r2.env`), this
script reads R2 credentials straight out of the app's own runtime env file,
`/srv/photoshowcase/env/photoshowcase.env`. That file already carries
`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET`
because the app needs them to serve gallery media — reusing it avoids
maintaining a second credentials file that can silently drift out of sync.

The file is read as **plain text** (`grep`/`cut` on the four `R2_*` keys),
never sourced as shell (`. "$ENV_FILE"`). systemd's `EnvironmentFile` format
is not shell — `KEY=VALUE` with VALUE taken literally to end of line, no
quoting or expansion. So a value that is fine to systemd can be hostile to
bash: an unquoted `<` becomes a redirect, and any value anywhere in the file
containing `$(...)` or backticks would **execute** as the `photoshowcase`
user. Plain-text extraction of only the keys this script actually needs
avoids all of that.

**This used to cite `EMAIL_FROM` as the live example, claiming its deployed
value was `Alejo Frames <hi@alejoframes.com>`. That was stale** — measured on
2026-07-31 (task #152), the deployed value is a bare
`no-reply@alejoframes.com`, no display name, no angle brackets. The example is
gone; the rule is not, and does not depend on it. Do not read "there is no `<`
in the file today" as "sourcing it would be safe now": the danger is that
`EnvironmentFile` permits values shell would interpret, and the next key added
to that file is unreviewed by this script. See `infra/email-deliverability.md`
for where `EMAIL_FROM` is measured.

This is a deliberate deviation from the findash pattern: while wiring this up
we found `/srv/findash/env/r2.env` **does not currently exist on the
droplet**, so findash's own weekly R2 sync has been silently skipped every
Sunday it ran (confirmed in `/srv/findash/logs/backup.log`, e.g.
`2026-07-26 03:15:06 WARNING: /srv/findash/env/r2.env not found — skipping
R2 sync`) — and per a subsequent check of the bucket contents, findash has
**zero** offsite backups: `s3://$R2_BUCKET/` only contains `galleries/` and
`photoshowcase-db/`, no `findash/` prefix has ever been created. Findash's
local dumps are still fine; there is simply no offsite copy at all. That's a
pre-existing findash issue, out of scope for this change (touching findash's
backup script, env, or R2 objects was explicitly out of bounds — not
touched), but it's the reason this script avoids a parallel single-purpose
credentials file: one fewer file that can go missing unnoticed.

## Log location

```
/srv/photoshowcase/logs/backup.log
```

Tail live: `ssh -i ~/.ssh/findash_do root@147.182.138.79 'tail -f /srv/photoshowcase/logs/backup.log'`

## Manual one-off run

Every run does both the local dump and the R2 sync — there is no
schedule-skipping flag to reach for anymore:

```bash
ssh -i ~/.ssh/findash_do root@147.182.138.79 'sudo -u photoshowcase /usr/local/bin/photoshowcase-backup.sh'
```

## Install

```bash
sudo install -m 0755 infra/cron/photoshowcase-backup.sh /usr/local/bin/photoshowcase-backup.sh
sudo install -m 0644 infra/cron/photoshowcase-backup.cron /etc/cron.d/photoshowcase-backup
```

The cron becomes live immediately (`cron.d` is picked up without a reload).

## Failure alerting gap — filed as #72, not fixed here

`photoshowcase-backup.cron` sets `MAILTO` so a job's output — which, by
design (see "What it does" above), only exists when something is actually
wrong — gets mailed to a real address instead of vanishing into the
`photoshowcase` service account's non-existent inbox. As of this writing the
droplet has **no local MTA** (`postfix` is inactive, there is no
`/usr/sbin/sendmail` binary), so cron mail does not actually get delivered
yet — a failing run will show up as an error in `journalctl -u cron` (cron
failing to exec the mail command), which is more visible than nothing but
still not real alerting. Closing this needs either a minimal outbound relay
(e.g. `msmtp` against an existing provider) or a log-monitoring check
against `/srv/photoshowcase/logs/backup.log` for `ERROR` lines. Flagged, not
fixed here — installing an MTA is a host-level change outside this ticket's
scope, tracked separately as #72.

## R2 retention: 90 days, decided

`R2_KEEP` is **90**, not the `12` inherited unchanged from findash's
weekly-sync script. With the old weekly cadence, 12 kept objects meant ~12
weeks (~84 days) of offsite history; with daily sync, `R2_KEEP=12` would
have meant ~12 _days_ — trailing the 14-day local retention window instead
of exceeding it, a real regression in recovery depth. At ~4 KB gzipped per
dump, 90 daily copies is ~360 KB total in R2 — a cost that rounds to zero.
So there is no tradeoff here: 90 days gives both daily granularity (a break
in the offsite path surfaces within a day, not up to a week) **and** a
deeper window than the old scheme ever had. Local stays at 14 — it shares a
disk with the database it protects, so depth there buys much less than
depth offsite does.

## What a rotated AUTH_SECRET invalidates (see also #40)

Rotating `AUTH_SECRET` invalidates every **outstanding, unclicked** magic
link and gallery-access link, because both are hashed with the secret
(`SHA256(rawToken + AUTH_SECRET)` — see `@auth/core`'s email-provider
callback). The gallery-access link has a 48h `maxAge`
(`GALLERY_ACCESS_MAX_AGE_SECONDS` in `src/auth.ts`), so any "your gallery is
ready" email sent in the 48h before a rotation is dead afterwards and must
be re-sent. It does **not** invalidate already-established sessions — see
#40 for why.

## Restore test

Two passes have been run against the live droplet. A backup that has never
been restored is a hypothesis, not a backup — and a row-count check alone
only proves cardinality, not that the restored content is actually correct,
so the second pass added a full content diff.

### Pass 1 — cardinality check (2026-07-29, 00:52 UTC)

1. Forced a dump + R2 sync, produced and uploaded `photoshowcase-20260729T0052.sql.gz`.
2. Created a scratch database, deliberately named so it can't be confused
   with `photoshowcase`: `photoshowcase_restoretest_20260728`.
3. Downloaded that dump from `s3://$R2_BUCKET/photoshowcase-db/` and
   restored it into the scratch DB only, never into `photoshowcase`.
4. Compared `\dt` (public-schema table listing only — a gap fixed in pass 2
   below) and `select count(*)` per table against live `photoshowcase` — all
   9 public tables present, all row counts matched.
5. Dropped the scratch database, confirmed it no longer appears in `\l`, and
   re-checked the same row counts on live `photoshowcase` afterwards to
   confirm it was never touched.

Gap found on review: `\dt` only lists the `public` schema, so
`drizzle.__drizzle_migrations` — the one table whose absence would make
`drizzle-kit` silently re-run every migration against a restored DB — was
never checked. And row counts alone don't catch column-level corruption,
e.g. in `included_photos_snapshot` / `extra_photo_price_cop_snapshot`, the
exact columns this whole change exists to protect.

### Pass 2 — full content diff, including the drizzle schema (2026-07-29, 01:14 UTC)

1. `select schemaname, tablename from pg_tables where schemaname not in
('pg_catalog','information_schema')` against live `photoshowcase` → **10**
   tables: the 9 public ones plus `drizzle.__drizzle_migrations`.
2. `pg_dump photoshowcase` (full) for the restore source, and separately
   `pg_dump photoshowcase --data-only --inserts --rows-per-insert=1
--no-owner` for a content-comparable baseline (`live_data_only.sql`).
3. Created a new scratch database, name read back character-by-character
   before any destructive step: `photoshowcase_restoretest_20260729011418`.
   Restored the full dump into it — never into `photoshowcase`.
4. Confirmed all 10 tables restored, including `drizzle.__drizzle_migrations`
   (row count matched: live 2, scratch 2 — same two applied migrations).
5. `pg_dump` the scratch DB with the **same** `--data-only --inserts
--rows-per-insert=1 --no-owner` flags (`scratch_data_only.sql`) and
   `diff`'d it against `live_data_only.sql`. Each file is 144 lines, with
   pg_dump 17's `\restrict`/`\unrestrict` markers at lines 5 and 143 —
   between them sit 137 lines, of which 29 are `INSERT` statements (one per
   row, across the **9** tables that actually hold data; `public.accounts`
   is empty and contributes none, so it's excluded from the 10-table count
   here). The `diff` found exactly two differences in the whole file: the
   `\restrict` and `\unrestrict` lines themselves, which carry a fresh
   random token on every pg_dump 17 invocation — a dump-tool artifact,
   unrelated to data. All 29 `INSERT`s, and every other line in the data
   region, matched exactly — including the `galleries` row's
   `included_photos_snapshot` and `extra_photo_price_cop_snapshot` values.
6. Dropped the scratch database (target re-confirmed character-by-character
   before `dropdb`), verified 0 `restoretest` databases remain, and cleaned
   up the temp dump files on the droplet.

Re-run this (ideally pass 2's content-diff form) whenever the schema changes
materially, to re-validate the restore path still works.
