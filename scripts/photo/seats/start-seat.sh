#!/usr/bin/env bash
# Launch one photo-showcase seat as a pi session in an Orca terminal.
#
#   scripts/photo/seats/start-seat.sh plan --prompt-file /tmp/photo-plan-brief.md --wait
#   scripts/photo/seats/start-seat.sh explore --prompt "Task 42, epic 3" --output /tmp/digest.md
#
# Prints key=value lines and nothing else, so the caller can parse it with sed:
#
#   seat=plan
#   agent=photo-plan-seat
#   terminal=term_<uuid>          # handle for orca terminal wait|read|close
#   tab=<tabId>
#   model=claude-bridge/claude-opus-5-5
#   thinking=high
#   tools=read,bash
#   contract=/abs/path/scripts/photo/seats/plan.md
#   output=/abs/path/to/the/delivery/file
#   status=ok|empty|timeout       # only with --wait
#   output-bytes=<n>              # only with --wait
#
# The seat writes its result to `output`; the terminal is the transport, the file is the record.
# Close it when you are done reading: orca terminal close --terminal <handle> --tab
#
# Requires: an Orca-managed worktree (orca CLI reachable) and a pi build that knows the provider.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: start-seat.sh <explore|plan|implement|review|ship> --prompt <text>|--prompt-file <path>
                     [--output <path>] [--wait] [--timeout-ms <ms>]
                     [--worktree <selector>] [--title <tab title>]

  --prompt <text>        Brief handed to the seat. The launcher appends "Output path: <path>"
                         when the brief does not already name it.
  --prompt-file <path>   Read the brief from a file instead of the command line.
  --output <path>        Absolute delivery path. Default: a fresh mktemp file, printed as output=.
  --wait                 Block until the seat's TUI goes idle, then report status=ok|empty|timeout.
  --timeout-ms <ms>      Ceiling for --wait (default 900000).
  --dry-run              Print the exact command that would be typed into the terminal and stop.
  --worktree <selector>  Orca worktree selector (default: active).
  --title <text>         Terminal tab title (default: photo-<seat>-seat).

Overrides without editing this script: SEAT_PROVIDER, SEAT_MODEL, SEAT_THINKING, SEAT_TIMEOUT_MS.
EOF
}

seat=""
prompt=""
prompt_file=""
output=""
do_wait=0
do_dry_run=0
timeout_ms="${SEAT_TIMEOUT_MS:-900000}"
worktree="active"
tab_title=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --prompt)      prompt="${2:?--prompt needs a value}"; shift 2 ;;
    --prompt-file) prompt_file="${2:?--prompt-file needs a value}"; shift 2 ;;
    --output)      output="${2:?--output needs a value}"; shift 2 ;;
    --timeout-ms)  timeout_ms="${2:?--timeout-ms needs a value}"; shift 2 ;;
    --worktree)    worktree="${2:?--worktree needs a value}"; shift 2 ;;
    --title)       tab_title="${2:?--title needs a value}"; shift 2 ;;
    --wait)        do_wait=1; shift ;;
    --dry-run)     do_dry_run=1; shift ;;
    -*) echo "unknown option: $1" >&2; usage; exit 2 ;;
    *)  [ -z "$seat" ] || { echo "unexpected argument: $1" >&2; usage; exit 2; }
        seat="$1"; shift ;;
  esac
done

case "$seat" in
  explore)
    agent_name="photo-explore-seat"
    provider="${SEAT_PROVIDER:-llm-gateway}";  model="${SEAT_MODEL:-deepseek-v4.1-flash-1017}"
    thinking="${SEAT_THINKING:-medium}";       tools="read,bash"
    ;;
  plan)
    agent_name="photo-plan-seat"
    provider="${SEAT_PROVIDER:-claude-bridge}"; model="${SEAT_MODEL:-claude-opus-5-5}"
    thinking="${SEAT_THINKING:-high}";          tools="read,bash"
    ;;
  implement)
    agent_name="photo-implement-seat"
    provider="${SEAT_PROVIDER:-llm-gateway}";   model="${SEAT_MODEL:-deepseek-v4.1-flash-1017}"
    thinking="${SEAT_THINKING:-medium}";        tools="read,bash,edit,write"
    ;;
  review)
    agent_name="photo-review-seat"
    provider="${SEAT_PROVIDER:-openai}";        model="${SEAT_MODEL:-gpt-6.1-sol}"
    thinking="${SEAT_THINKING:-high}";          tools="read,bash"
    ;;
  ship)
    agent_name="photo-ship-seat"
    provider="${SEAT_PROVIDER:-llm-gateway}";   model="${SEAT_MODEL:-deepseek-v4.1-flash-1017}"
    thinking="${SEAT_THINKING:-medium}";        tools="read,bash"
    ;;
  *)
    echo "usage: $0 <explore|plan|implement|review|ship>" >&2
    exit 2
    ;;
esac

[ -z "$tab_title" ] && tab_title="photo-$seat-seat"

command -v orca >/dev/null 2>&1 || { echo "orca CLI not found; install Orca or fix PATH" >&2; exit 2; }
command -v pi   >/dev/null 2>&1 || { echo "pi CLI not found; install pi or fix PATH" >&2; exit 2; }

# Seats live in the worktree Orca tracks. Outside one, `terminal create` has no workspace to
# attach to, so fail before touching pi.
if ! orca worktree current --json >/dev/null 2>&1; then
  echo "not inside an Orca-managed worktree; open this directory from Orca and retry" >&2
  exit 2
fi

repo_root="$(git rev-parse --show-toplevel)"
contract="$repo_root/scripts/photo/seats/$seat.md"
[ -f "$contract" ] || { echo "missing contract: $contract" >&2; exit 2; }

# The provider must exist in pi's catalog. `pi auth check` only understands built-in providers;
# extension providers such as claude-bridge report invalid_state even when they work, so a
# non-ready auth state is a warning, not a refusal.
if ! pi --list-models 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx "$provider"; then
  echo "pi has no provider '$provider'; run: pi --list-models | grep $provider" >&2
  exit 1
fi
auth_state="$(pi auth check --provider "$provider" --model "$model" 2>/dev/null || true)"
if [ "$auth_state" != "ready" ]; then
  echo "note: pi auth reports '$auth_state' for $provider/$model (expected for extension providers); starting anyway" >&2
fi

# The brief is the only input. A seat with no task is a wasted model run, so refuse one.
if [ -n "$prompt_file" ]; then
  [ -f "$prompt_file" ] || { echo "missing prompt file: $prompt_file" >&2; exit 2; }
  prompt="$(cat "$prompt_file")"
fi
if [ -z "${prompt//[[:space:]]/}" ]; then
  echo "no brief given; pass --prompt or --prompt-file" >&2
  exit 2
fi

# Mint the delivery path here rather than trusting the caller's memory: the file should be fresh
# and empty before the seat starts, so "the seat wrote nothing" and "the seat wrote nothing yet"
# stay distinct. A path that already holds content would be read as an instant success.
output_bytes() { if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi; }

if [ -z "$output" ]; then
  output="$(mktemp -t "photo-$seat")"
else
  if [ -s "$output" ]; then
    echo "output path already has content: $output; pass a fresh path" >&2
    exit 2
  fi
  : > "$output"
fi
case "$prompt" in
  *"$output"*) ;;
  *) prompt="$prompt
Output path: $output" ;;
esac

# --append-system-prompt takes a path and reads the contract into the system prompt.
# --approve trusts the project's own context files (AGENTS.md) for this run.
cmd="pi"
add_arg() { cmd="$cmd $(printf '%q' "$1")"; }
add_arg --provider;      add_arg "$provider"
add_arg --model;         add_arg "$model"
add_arg --thinking;      add_arg "$thinking"
add_arg --tools;         add_arg "$tools"
add_arg --approve
add_arg --no-session
add_arg --append-system-prompt; add_arg "$contract"
add_arg --;              add_arg "$prompt"

[ "$do_dry_run" -eq 1 ] && { printf 'command=%s\n' "$cmd"; exit 0; }

json="$(orca terminal create --worktree "$worktree" --title "$tab_title" --command "$cmd" --json)"
handle="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["terminal"]["handle"])')"
tab="$(printf '%s' "$json"    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["terminal"]["tabId"])')"
[ -n "$handle" ] || { echo "orca returned no terminal handle: $json" >&2; exit 1; }

printf 'seat=%s\nagent=%s\nterminal=%s\ntab=%s\nmodel=%s/%s\nthinking=%s\ntools=%s\ncontract=%s\noutput=%s\n' \
  "$seat" "$agent_name" "$handle" "$tab" "$provider" "$model" "$thinking" "$tools" "$contract" "$output"

[ "$do_wait" -eq 1 ] || exit 0

# Readiness comes from the delivery channel, not from the terminal. `tui-idle` fires while pi is
# still booting its TUI and before the first token is generated, so waiting on it first reports a
# running seat as finished. Poll the output file instead, then let the TUI settle so a half-written
# report is not collected.
status="timeout"
bytes=0
started="$(date +%s)"
deadline=$(( started + timeout_ms / 1000 ))
ticks=0
while :; do
  bytes="$(output_bytes "$output")"
  [ "${bytes:-0}" -gt 0 ] && { status="written"; break; }
  now="$(date +%s)"
  [ "$now" -ge "$deadline" ] && break
  ticks=$(( ticks + 1 ))
  [ $(( ticks % 15 )) -eq 0 ] && echo "… waiting for $agent ($(( now - started ))s)" >&2
  sleep 2
done

if [ "$status" = "written" ]; then
  orca terminal wait --terminal "$handle" --for tui-idle --timeout-ms 120000 >/dev/null 2>&1 || true
  sleep 1
  bytes="$(output_bytes "$output")"
  if [ "${bytes:-0}" -gt 0 ]; then status="ok"; else status="empty"; fi
elif orca terminal wait --terminal "$handle" --for tui-idle --timeout-ms 5000 >/dev/null 2>&1; then
  # Nothing written and the TUI is settled: the seat finished without delivering. That is a
  # failure, not an empty success, and it is the orchestrator's call whether to retry.
  status="empty"
fi

printf 'status=%s\noutput-bytes=%s\n' "$status" "${bytes:-0}"

[ "$status" = "ok" ] || exit 1
