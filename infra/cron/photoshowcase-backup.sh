#!/usr/bin/env bash
# photoshowcase-backup.sh — daily local pg_dump + daily R2 off-site sync.
#
# Started as a mirror of personal-financial-dashboard/infra/cron/findash-backup.sh
# (same local retention, same script shape) but deliberately DOES NOT copy its
# weekly-only R2 cadence: the `photoshowcase` database is the irreplaceable
# artifact here — it is what says WHICH photos in R2 belong to WHICH client,
# what they selected, and what they were quoted (`included_photos_snapshot`,
# `extra_photo_price_cop_snapshot`). A weekly offsite copy means up to a
# 7-day RPO for total host loss, on top of the "daily" dumps living on the
# SAME disk as the database they protect. The dump is a few KB gzipped, so
# daily R2 sync costs nothing (well under R2's free tier) and — just as
# important — a daily run exercises the offsite path 365 times a year
# instead of 52, so a break in it surfaces fast instead of silently, which
# is exactly how findash's own offsite backup went unnoticed (see
# infra/cron/README.md).
#
# Designed to run as the `photoshowcase` OS user (peer-auth to PostgreSQL —
# same role the app itself connects as).
# Install path (managed by hand, see infra/README.md): /usr/local/bin/photoshowcase-backup.sh
# Scheduled via: /etc/cron.d/photoshowcase-backup
#
# Local retention: 14 most recent daily dumps under /srv/photoshowcase/backups/daily/
# R2 retention:    90 most recent dumps under s3://$R2_BUCKET/photoshowcase-db/
#                   (90 days of daily copies at ~4 KB gzipped each is ~360 KB
#                   total — deeper than the old weekly-sync window (~84 days)
#                   AND daily-grained, for a cost that rounds to zero. Local
#                   stays at 14: it shares a disk with the database it
#                   protects, so depth there buys much less.)
#
# R2 credentials are read out of the app's own runtime env file
# (/srv/photoshowcase/env/photoshowcase.env) — unlike findash, this app does
# not keep a separate r2.env. That file already carries R2_ACCOUNT_ID /
# R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET because the app itself
# needs them to serve gallery media, so this script reuses it instead of
# duplicating credentials into a second file that could silently drift out
# of sync (findash's separate r2.env has in fact gone missing on the droplet,
# which silently disabled its R2 sync while the local dump kept "succeeding"
# — see infra/cron/README.md for that finding). The file is NOT sourced as
# shell — see `r2_env_value` below for why — only the four R2_* values are
# read out of it.
#
# Cron output discipline: `log()` below writes ONLY to $LOG_FILE, never to
# stdout/stderr. `err()` writes to both. Cron mails a job's stdout+stderr
# whenever it is non-empty, REGARDLESS of exit status — so if routine
# progress lines went to stdout too, a fully successful run would generate a
# "backup succeeded" email every day once an MTA exists (#72). That is
# exactly the alert-fatigue pattern that gets a real failure filtered into a
# folder nobody reads: the only way cron output stays meaningful is if it
# ONLY ever appears when something is actually wrong.
#
# Usage:
#   sudo -u photoshowcase /usr/local/bin/photoshowcase-backup.sh
#
set -euo pipefail

DB_NAME="photoshowcase"
BACKUP_DIR="/srv/photoshowcase/backups/daily"
LOG_FILE="/srv/photoshowcase/logs/backup.log"
ENV_FILE="/srv/photoshowcase/env/photoshowcase.env"
# Second resolution, not minute: a manual retry inside the same minute (the
# README documents manual runs) would otherwise reuse the previous run's
# filename and `>` would silently truncate it.
TIMESTAMP="$(date +%Y%m%dT%H%M%S)"
DUMP_FILE="$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql.gz"
# Written first, renamed to $DUMP_FILE only after `gzip -t` passes — see the
# dump section below for why.
PARTIAL_FILE="${DUMP_FILE}.partial"
LOCAL_KEEP=14
R2_KEEP=90

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"
}

# For lines that must reach cron's MAILTO alert. A successful run must never
# call this — see the header comment for why. stderr is written FIRST, the
# log second: if $LOG_FILE itself is ever unwritable, that redirect failing
# would trip `set -e` inside this function — writing stderr first means the
# actual alert still gets out even if the log append after it never
# completes.
err() {
  printf '%s\n' "$*" >&2
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"
}

# ---------------------------------------------------------------------------
# Sanity checks
# ---------------------------------------------------------------------------
if [[ "$(id -un)" != "photoshowcase" ]]; then
  printf 'ERROR: must run as photoshowcase user (current: %s)\n' "$(id -un)" >&2
  exit 1
fi

install -d -m 0750 "$BACKUP_DIR"

# Clean up a `.partial` left behind by a run that was SIGKILLed or lost the
# machine to a reboot mid-dump. It never matched the retention glob below
# (so it was never pruned or synced), but it also never gets cleaned up on
# its own — remove any stale one before starting a new attempt.
#
# Bash glob (with nullglob), not `ls | while read`: on the normal day with
# no stale partial, `ls` on a non-matching glob exits non-zero — under
# `set -e` + `pipefail` that would kill the script right here, on every
# single ordinary run, before the dump ever starts. A `for` loop over a
# nullglob-expanded pattern simply doesn't iterate when nothing matches, no
# subprocess exit code involved.
shopt -s nullglob
for stale in "$BACKUP_DIR"/"${DB_NAME}"-*.sql.gz.partial; do
  rm -f "$stale"
  log "backup: removed stale partial from a previous interrupted run: $stale"
done
shopt -u nullglob

# ---------------------------------------------------------------------------
# Daily local dump
# ---------------------------------------------------------------------------
log "backup: starting dump to $DUMP_FILE"
if pg_dump "$DB_NAME" | gzip -9 >"$PARTIAL_FILE"; then
  # A dump that failed partway (or was killed — SIGKILL, OOM, reboot) still
  # leaves a valid-looking, truncated (or zero-byte) file on disk, because
  # `>"$PARTIAL_FILE"` creates/truncates it before pg_dump ever runs.
  # `gzip -t` catches that: it fails on a truncated gzip stream even when
  # the shell pipeline itself reported success (e.g. gzip wrote a partial
  # stream before being killed). Dumping to a `.partial` name and `mv`-ing
  # only after this check passes means no in-progress or corrupt file EVER
  # matches the `${DB_NAME}-*.sql.gz` glob the prune/sync steps below use —
  # a kill/reboot mid-dump can't leave an artifact that silently occupies a
  # retention slot or gets uploaded.
  if gzip -t "$PARTIAL_FILE" 2>/dev/null; then
    mv "$PARTIAL_FILE" "$DUMP_FILE"
    SIZE="$(du -sh "$DUMP_FILE" | cut -f1)"
    log "backup: dump complete — $SIZE"
  else
    err "ERROR: dump integrity check failed (gzip -t) — removing $PARTIAL_FILE"
    rm -f "$PARTIAL_FILE"
    exit 1
  fi
else
  err "ERROR: pg_dump failed — removing partial $PARTIAL_FILE"
  rm -f "$PARTIAL_FILE"
  exit 1
fi

# Prune to LOCAL_KEEP most recent dumps
log "backup: pruning local backups (keep $LOCAL_KEEP)"
# Nullglob existence check first, same reasoning and same technique as the
# `.partial` sweep above: `ls` on a glob that matches nothing exits
# non-zero, and under `set -e` + `pipefail` that kills the script right
# here. This step is safe TODAY only because the `mv` above guarantees at
# least one match immediately before it runs — that is an invariant of the
# current ordering, not a guard. Moving this step, or adding any early-exit
# above it, would silently reintroduce the exact bug the `.partial` sweep
# already had once, so don't rely on the invariant holding forever.
shopt -s nullglob
EXISTING_DUMPS=("$BACKUP_DIR"/"${DB_NAME}"-*.sql.gz)
shopt -u nullglob
if [[ "${#EXISTING_DUMPS[@]}" -gt 0 ]]; then
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR"/"${DB_NAME}"-*.sql.gz | tail -n +$((LOCAL_KEEP + 1)) | while read -r old; do
    rm -f "$old"
    log "backup: pruned local $old"
  done
fi

# ---------------------------------------------------------------------------
# Daily R2 sync
# ---------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  # The whole app reads this same file, so its absence means the app itself
  # is down — that gets noticed through other channels. Still worth an
  # alert here too: while this file is missing, the offsite backup silently
  # stops happening every single day, which is exactly the kind of ongoing
  # degradation that should not depend on someone separately noticing the
  # app is down.
  err "WARNING: $ENV_FILE not found — skipping R2 sync (local backup is complete)"
  exit 0
fi

# Read R2_* values out of the systemd EnvironmentFile WITHOUT sourcing it as
# shell. systemd's EnvironmentFile format is not shell: `KEY=VALUE`, where
# VALUE is everything to end of line, literally — no quoting, no expansion.
# `EMAIL_FROM` in this exact file is `Alejo Frames <hi@alejoframes.com>`;
# `. "$ENV_FILE"` would hand that `<` to bash as a redirect, and any value
# anywhere in the file containing `$(...)` or backticks would EXECUTE as the
# `photoshowcase` user. Plain text extraction has none of those failure
# modes.
r2_env_value() {
  local value
  # `tail -1`, not `grep -m1`: systemd's EnvironmentFile parser applies a
  # LATER assignment over an earlier one for a repeated key (documented
  # behavior — see `infra/systemd/photoshowcase.service`'s
  # `EnvironmentFile=`). Taking the first match would silently diverge from
  # what the app itself loads the moment someone "fixes" a bad value by
  # appending a corrected line at the bottom of the file, which is the most
  # natural way to hand-edit an env file.
  #
  # `|| true`: with `set -e` + `pipefail`, a key that is absent ENTIRELY
  # makes `grep` exit 1, which — without this — would kill the script right
  # here, before the `-z` check below ever runs and can log WHY. A key that
  # IS present with an empty value doesn't hit this path at all; only a
  # wholly missing key does.
  value="$(grep "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
  # systemd strips a single layer of surrounding quotes from
  # EnvironmentFile values; `cut` does not. No value in this file is quoted
  # today (latent-only), but keep this aligned with what the app itself
  # loads rather than let a future quoted value diverge silently.
  case "$value" in
  \"*\") value="${value#\"}" && value="${value%\"}" ;;
  \'*\') value="${value#\'}" && value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

R2_ACCOUNT_ID="$(r2_env_value R2_ACCOUNT_ID)"
R2_ACCESS_KEY_ID="$(r2_env_value R2_ACCESS_KEY_ID)"
R2_SECRET_ACCESS_KEY="$(r2_env_value R2_SECRET_ACCESS_KEY)"
R2_BUCKET="$(r2_env_value R2_BUCKET)"

if [[ -z "$R2_ACCOUNT_ID" || -z "$R2_ACCESS_KEY_ID" || -z "$R2_SECRET_ACCESS_KEY" || -z "$R2_BUCKET" ]]; then
  # Unlike the missing-file case above (which means the whole app is down
  # and gets noticed elsewhere), incomplete credentials in a file that
  # otherwise exists is a silent, backup-only failure — e.g. an R2 token
  # revoked at Cloudflare. That must NOT look like success to cron.
  err "ERROR: R2 credentials incomplete in $ENV_FILE — aborting R2 sync"
  exit 1
fi

R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
R2_PREFIX="s3://${R2_BUCKET}/photoshowcase-db/"

log "backup: syncing $BACKUP_DIR to $R2_PREFIX"
if AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  aws --endpoint-url "$R2_ENDPOINT" \
  s3 sync "$BACKUP_DIR/" "$R2_PREFIX" \
  --no-progress \
  --exclude "*" \
  --include "${DB_NAME}-*.sql.gz" >>"$LOG_FILE" 2>&1; then
  log "backup: R2 sync complete"
else
  err "ERROR: R2 sync failed — see $LOG_FILE for aws output"
  exit 1
fi

# Prune R2 to R2_KEEP most recent
log "backup: pruning R2 backups (keep $R2_KEEP)"
# Same `if ... ; then ... else err ... exit 1; fi` shape as the sync and rm
# calls above: a bare `R2_LIST=$(... | ...)` assignment, with `pipefail`
# propagating `aws`'s failure through the pipeline and `set -e` killing the
# script at the assignment itself, gave a revoked token or a transient
# endpoint blip a 255 exit with ZERO stdout/stderr — the `2>/dev/null` even
# swallowed aws's own diagnostic. Cron only mails non-empty output, so that
# produced no alert at all. Capturing the exit status explicitly (and
# routing aws's stderr into the log instead of discarding it) means a
# failure here is loud instead of invisible. No data is lost either way —
# the dump and the sync have already succeeded by this point — but a broken
# prune should not fail silently forever.
if R2_LIST=$(
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
    aws --endpoint-url "$R2_ENDPOINT" \
    s3 ls "$R2_PREFIX" \
    --no-paginate 2>>"$LOG_FILE" |
    awk '{print $4}' |
    LC_ALL=C sort
); then
  :
else
  err "ERROR: could not list $R2_PREFIX — skipping prune (see $LOG_FILE for aws output)"
  exit 1
fi
if [[ -z "$R2_LIST" ]]; then
  # `printf '%s\n' "$R2_LIST" | wc -l` reports 1 for an empty string, not 0
  # — without this guard an empty bucket listing would compute TOTAL=1 and
  # (harmlessly, since 1 <= R2_KEEP today) but incorrectly report a prune
  # candidate count derived from a phantom line.
  log "backup: no objects found under $R2_PREFIX — nothing to prune"
else
  TOTAL=$(printf '%s\n' "$R2_LIST" | wc -l)
  if [[ "$TOTAL" -gt "$R2_KEEP" ]]; then
    TO_DELETE=$(printf '%s\n' "$R2_LIST" | head -n $((TOTAL - R2_KEEP)))
    while IFS= read -r key; do
      [[ -z "$key" ]] && continue
      if AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
        AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
        aws --endpoint-url "$R2_ENDPOINT" \
        s3 rm "${R2_PREFIX}${key}" >>"$LOG_FILE" 2>&1; then
        log "backup: pruned R2 ${R2_PREFIX}${key}"
      else
        err "ERROR: failed to prune R2 object ${R2_PREFIX}${key}"
        exit 1
      fi
    done <<<"$TO_DELETE"
  fi
fi

log "backup: done"
