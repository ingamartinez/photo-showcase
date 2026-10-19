#!/usr/bin/env bash
# Reconcile the photo-showcase seats: which are running, which delivered and nobody read, which
# failed, which are already closed. This is the answer to "a seat cannot notify the orchestrator".
#
# pi is turn-based: a seat writing its delivery file cannot wake the coordinate thread, and the
# `bash` tool has no run-in-background-and-callback. So the fix is not a notification — it is making
# the state DERIVABLE, so that being woken at an arbitrary moment is enough, and so that an
# interrupted `--wait` costs nothing:
#
#   scripts/photo/seats/seat-status.sh                 # what is in flight, right now
#   scripts/photo/seats/seat-status.sh --wait <output> # block until that seat settles
#   scripts/photo/seats/seat-status.sh --close-settled # close the tabs of settled seats
#
# Read this first on every turn. Never rely on remembering what was launched: the handoff files
# written by start-seat.sh before it blocks are the record.
#
# Verdicts, per seat:
#   delivered  output has content and the seat is idle (or its terminal is gone)  → READ IT
#   running    still working, or the file was just written and the TUI is settling
#   empty      idle with an empty file  → the seat finished and wrote nothing: a FAILURE
#   gone       terminal is gone and nothing was written
#   settled    the handoff already carries a final status= from a completed launcher run
#
# Exit codes: 0 nothing needs attention, 1 a seat needs reading or failed, 3 empty/failed,
# 4 --wait timed out (a checkpoint, not a failure).

set -euo pipefail

tmpdir="${TMPDIR:-/tmp}"
tmpdir="${tmpdir%/}"

wait_for=""
timeout_ms=1800000
do_close=0
show_all=0

usage() {
  cat >&2 <<'EOF'
usage: seat-status.sh [--wait <output-path>] [--timeout-ms <ms>] [--close-settled] [--all]

  --wait <output>   Block until that seat settles (delivered/empty/gone) or the ceiling is hit.
  --timeout-ms <n>  Ceiling for --wait (default 1800000).
  --close-settled   Close the Orca tab of every seat whose output was delivered and is idle.
  --all             Also list legacy delivery files from before handoff files existed.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --wait) wait_for="${2:-}"; [ -n "$wait_for" ] || { usage; exit 2; }; shift 2 ;;
    --timeout-ms) timeout_ms="${2:-}"; shift 2 ;;
    --close-settled) do_close=1; shift ;;
    --all) show_all=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unexpected argument: $1" >&2; usage; exit 2 ;;
  esac
done

# handle -> "present". One `orca terminal list` per pass; the wait loop calls this repeatedly.
terminal_handles() {
  orca terminal list --json 2>/dev/null |
    python3 -c 'import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
for t in d.get("result",{}).get("terminals",[]) or []:
    print(t.get("handle",""))'
}

# tui-idle is the only blocking condition Orca offers. It fires while pi is still booting, so it is
# never used alone: it is only trusted once the delivery file already has content.
is_idle() {
  orca terminal wait --terminal "$1" --for tui-idle --timeout-ms 800 >/dev/null 2>&1
}

handoff_field() {
  # $1 file, $2 key — the launcher writes one key=value line each.
  sed -n "s/^$2=//p" "$1" | head -1
}

bytes_of() {
  if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi
}

# Echoes "<verdict> <terminal-state>" for one handoff file.
verdict() {
  local hf="$1" out status bytes handle present idle=""
  out="$(handoff_field "$hf" output)"
  handle="$(handoff_field "$hf" terminal)"
  status="$(handoff_field "$hf" status)"

  if [ -n "$status" ]; then echo "settled:$status present"; return; fi

  [ -n "$out" ] || { echo "gone absent"; return; }
  bytes="$(bytes_of "$out")"
  present="absent"
  if [ -n "$handle" ] && printf '%s\n' "$PRESENT_HANDLES" | grep -qx "$handle"; then
    present="present"
    if is_idle "$handle"; then idle="idle"; else idle="busy"; fi
  fi

  if [ "$bytes" -gt 0 ]; then
    if [ "$present" = "absent" ] || [ "$idle" = "idle" ]; then echo "delivered $present"; else echo "running $present"; fi
  else
    if [ "$present" = "absent" ]; then echo "gone $present"; else
      if [ "$idle" = "idle" ]; then echo "empty $present"; else echo "running $present"; fi
    fi
  fi
}

close_settled() {
  local hf="$1" v handle
  v="$(verdict "$hf")"; handle="$(handoff_field "$hf" terminal)"
  case "$v" in
    delivered*|empty*|settled:*) ;;
    *) return ;;
  esac
  [ -n "$handle" ] || return
  if printf '%s\n' "$PRESENT_HANDLES" | grep -qx "$handle"; then
    orca terminal close --terminal "$handle" --tab >/dev/null 2>&1 || true
    echo "  closed $handle"
  fi
}

report() {
  local hf out seat verdict terminal n_attention=0
  PRESENT_HANDLES="$(terminal_handles)"
  printf '%-9s %-7s %8s  %-22s %s\n' SEAT VERDICT BYTES OUTPUT
  for hf in "$tmpdir"/photo-*.handoff; do
    [ -e "$hf" ] || continue
    out="$(handoff_field "$hf" output)"
    seat="$(handoff_field "$hf" seat)"
    terminal="$(handoff_field "$hf" terminal)"
    verdict="$(verdict "$hf")"
    printf '%-9s %-7s %8s  %s\n' "${seat:-?}" "${verdict%% *}" "$(bytes_of "${out:-/nonexistent}")" "${out:-?}"
    case "$verdict" in
      delivered*) n_attention=1; printf '          → delivered, UNREAD. Read it, then --close-settled.\n' ;;
      empty*) n_attention=3; printf '          → finished and wrote NOTHING. A failure, not an empty success.\n' ;;
      gone*) n_attention=3; printf '          → terminal is gone with no delivery. Re-prompt as a NEW seat.\n' ;;
    esac
    [ "$do_close" -eq 1 ] && close_settled "$hf"
  done

  if [ "$show_all" -eq 1 ]; then
    # Recent, not the whole graveyard: TMPDIR keeps months of past sessions, and a list nobody
    # reads is the same as no list. `-mmin` is the filter; the sort is newest first.
    echo
    echo "Legacy delivery files, last 12h (no handoff — launched before start-seat.sh wrote one):"
    local f n=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ -f "$f" ] || continue
      case "$f" in *.handoff) continue ;; esac
      n=$(( n + 1 ))
      [ "$n" -le 12 ] || break
      printf '  %8s  %s\n' "$(bytes_of "$f")" "$f"
    done <<EOF
$(find "$tmpdir" -maxdepth 1 -name 'photo-*' -type f ! -name '*.handoff' -mmin -720 -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null)
EOF
    [ "$n" -eq 0 ] && echo '  (none in the last 12h)'
  fi

  return "$n_attention"
}

if [ -n "$wait_for" ]; then
  hf="$wait_for.handoff"
  if [ ! -f "$hf" ]; then
    echo "no handoff file at $hf — cannot attribute that output to a seat." >&2
    echo "Pass the path printed by start-seat.sh as output= (the handoff sits next to it)." >&2
    exit 2
  fi
  started="$(date +%s)"
  deadline=$(( started + timeout_ms / 1000 ))
  while :; do
    PRESENT_HANDLES="$(terminal_handles)"
    v="$(verdict "$hf")"
    case "$v" in
      delivered*|empty*|gone*|settled:*)
        printf 'status=%s verdict=%s bytes=%s output=%s\n' \
          "$(printf '%s' "$v" | cut -d' ' -f1)" "$v" "$(bytes_of "$(handoff_field "$hf" output)")" "$(handoff_field "$hf" output)"
        case "$v" in delivered*|settled:ok*) exit 0 ;; *) exit 3 ;; esac ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "status=timeout verdict=$v after $(( $(date +%s) - started ))s output=$(handoff_field "$hf" output)"
      exit 4
    fi
    sleep 5
  done
fi

report
