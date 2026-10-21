#!/usr/bin/env bash
# watch-seat.sh — ONE watcher per seat, never one that waits for all of them.
#
# The coordinator starts this with the `process` tool (@aliou/pi-processes) and ends its turn; the
# extension wakes it up through `notify.logMatches` on the line this script prints.
#
#   watch-seat.sh <name> <delivery-path> [timeout-seconds]
#
#   process start name=seat-implement-276 \
#     command="bash scripts/photo/seats/watch-seat.sh implement-276 <output> 2400"
#     notify.logMatches: [{pattern: "DELIVERED implement-276", mode: literal, on: turn},
#                         {pattern: "TIMEOUT",                mode: literal, on: turn}]
#
# Prints ONE line and exits:
#   DELIVERED <name> bytes=<n>     the delivery file has content
#   TIMEOUT <name> after <n>s      the ceiling passed with nothing delivered
#   MISSING <name> <path>          the path does not exist (a typo in the launcher's output=)
#
# Why one per seat instead of one waiting for all (measured 2026-10-20 in the SYC lane):
#   - A combined watcher firing on ALL-DELIVERED makes you wait for the SLOWEST seat: the same defect
#     as `--wait`, at a smaller scale. `ship` delivers in 2-3 min and `implement` in 10; the PR is
#     open and the coordinator has not been told.
#   - With one process per seat the event NAMES the seat (`DELIVERED ship-276`), so that delivery can
#     be read and that tab closed without touching the others.
#   - A failure stays isolated: a seat that dies without writing leaves its own named TIMEOUT instead
#     of a collective one that does not say which seat it was.
#   - The ceiling is per seat: ship 20 min, implement 40, review 30.
set -uo pipefail

name="${1:?usage: watch-seat.sh <name> <delivery-path> [timeout-seconds]}"
path="${2:?usage: watch-seat.sh <name> <delivery-path> [timeout-seconds]}"
limit="${3:-2400}"

if [ ! -e "$path" ]; then
  printf 'MISSING %s %s\n' "$name" "$path"
  exit 3
fi

deadline=$(( $(date +%s) + limit ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  bytes=$(wc -c < "$path" 2>/dev/null | tr -d ' ')
  if [ -n "$bytes" ] && [ "$bytes" -gt 0 ]; then
    printf 'DELIVERED %s bytes=%s\n' "$name" "$bytes"
    exit 0
  fi
  sleep 8
done

printf 'TIMEOUT %s after %ss\n' "$name" "$limit"
exit 1
