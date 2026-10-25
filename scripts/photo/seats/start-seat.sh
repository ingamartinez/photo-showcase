#!/usr/bin/env bash
# Launch one photo-showcase seat as a pi session in an Orca terminal.
#
#   scripts/photo/seats/start-seat.sh implement --id 276 --prompt-file /tmp/photo-impl-brief.md
#   scripts/photo/seats/start-seat.sh explore --prompt "Task 42, epic 3" --output /tmp/digest.md
#
# DO NOT USE --wait TO COORDINATE SEVERAL SEATS. `--wait` blocks the coordinator's turn until THAT
# seat delivers, so while it waits the others deliver unseen — measured in the sibling SYC lane on
# 2026-10-20, with the owner watching. The pattern is: launch WITHOUT --wait, start ONE `process`
# watcher per seat (scripts/photo/seats/watch-seat.sh) with notify.logMatches on
# `DELIVERED <seat>`, and end the turn. A single combined watcher that fires on ALL-DELIVERED is the
# same defect at a smaller scale: it serialises behind the slowest seat. See ORCA.md and the
# photo-orchestrator skill. `--wait` stays for a one-off seat you are watching yourself.
#
# Without --wait the tab is NOT closed by the launcher: close it yourself once you have read the
# delivery (`orca terminal close --terminal <handle> --tab`), or with
# `scripts/photo/seats/seat-status.sh --close-settled`.
#
# Prints key=value lines and nothing else, so the caller can parse it with sed:
#
#   seat=implement
#   agent=photo-implement-seat
#   terminal=term_<uuid>          # handle for orca terminal wait|read|close
#   tab=<tabId>
#   title=photo-implement-276     # joins the tab, the watcher and the `process` by name
#   model=opencode-go/deepseek-v4.1-flash
#   thinking=high
#   tools=read,bash,edit,write,mcp__codegraph__*
#   contract=/abs/path/scripts/photo/seats/implement.md
#   output=/abs/path/to/the/delivery/file
#   status=ok|empty|timeout       # only with --wait
#   output-bytes=<n>              # only with --wait
#   cleanup=tab-closed|left-open|close-failed   # only with --wait
#
# The seat writes its result to `output`; the terminal is the transport, the file is the record.
# A `<output>.handoff` file carrying the same lines is written BEFORE any blocking wait, so an
# interrupted run is still attributable — that is what `seat-status.sh` reconciles against.
#
# Requires: an Orca-managed worktree (orca CLI reachable) and a pi build that knows the provider.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: start-seat.sh <explore|plan|implement|review|ship> --prompt <text>|--prompt-file <path>
                     [--output <path>] [--wait] [--timeout-ms <ms>]
                     [--worktree <selector>] [--id <task-id>] [--attempt <n>]
                     [--title <tab title>]

  --prompt <text>        Brief handed to the seat. The launcher appends "Output path: <path>"
                         when the brief does not already name it.
  --prompt-file <path>   Read the brief from a file instead of the command line.
  --output <path>        Absolute delivery path. Default: a fresh mktemp file, printed as output=.
  --wait                 Block until this seat delivers, then report status=ok|empty|timeout.
                         Blocks the coordinator's turn: for several seats launch WITHOUT it and put
                         one `process` watcher per seat on watch-seat.sh (see the header).  --timeout-ms <ms>      Ceiling for --wait (default 900000).
  --dry-run              Print the exact command that would be typed into the terminal and stop.
  --keep-open            Leave the seat's tab open even when it delivered (default: close it).
  --worktree <selector>  Orca worktree selector (default: the lane you are standing in). A seat is
                         never launched in the primary checkout: open the slice's workspace with
                         new-lane.sh first, or pass --allow-main to override.
  --allow-main           Permit a seat in the primary checkout. Only for a one-off you are watching.
  --id <task-id>         Board slice id. Composes the tab title as photo-<seat>-<id>[-r<N>]; use the
                         same name for the watcher and the `process`, that is the join key.
  --attempt <n>          1-based. With n>1 the title carries -r<N> (a retry of the SAME seat on the
                         same slice). Never 'b', '-v2' or '-final'.
  --title <text>         Tab title for a case the convention does not cover.

Overrides without editing this script: SEAT_PROVIDER, SEAT_MODEL, SEAT_THINKING, SEAT_TIMEOUT_MS,
SEAT_MCP (1 = leave every MCP server connected), SEAT_MEMORY (1 = let the seat write Engram memory).
To change ONE seat's thinking level: SEAT_THINKING_<SEAT> (e.g. SEAT_THINKING_PLAN=high), which wins
over the global SEAT_THINKING — exporting the global for one deepseek seat would otherwise change
plan's and review's thinking too.
EOF
}

seat=""
prompt=""
prompt_file=""
output=""
do_wait=0
do_dry_run=0
do_keep_open=0
allow_main=0
timeout_ms="${SEAT_TIMEOUT_MS:-900000}"
worktree="active"
tab_title=""
task_id=""
attempt=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --prompt)      prompt="${2:?--prompt needs a value}"; shift 2 ;;
    --prompt-file) prompt_file="${2:?--prompt-file needs a value}"; shift 2 ;;
    --output)      output="${2:?--output needs a value}"; shift 2 ;;
    --timeout-ms)  timeout_ms="${2:?--timeout-ms needs a value}"; shift 2 ;;
    --worktree)    worktree="${2:?--worktree needs a value}"; shift 2 ;;
    --title)       tab_title="${2:?--title needs a value}"; shift 2 ;;
    --id)          task_id="${2:?--id needs a value}"; shift 2 ;;
    --attempt)     attempt="${2:?--attempt needs a value}"; shift 2 ;;
    --allow-main)  allow_main=1; shift ;;
    --wait)        do_wait=1; shift ;;
    --dry-run)     do_dry_run=1; shift ;;
    --keep-open)   do_keep_open=1; shift ;;
    -*) echo "unknown option: $1" >&2; usage; exit 2 ;;
    *)  [ -z "$seat" ] || { echo "unexpected argument: $1" >&2; usage; exit 2; }
        seat="$1"; shift ;;
  esac
done

# THE SEAT MAP. explore, implement and ship run deepseek-v4.1-flash through OpenCode Go (provider
# `opencode-go`), replacing `deepseek/deepseek-flash` on 2026-10-25. Plan runs Opus through
# claude-bridge, review runs gpt-6.1-sol through openai. Plan and review on DIFFERENT models is the
# point of review: the reviewer is never the implementer, and never shares a model line with whoever
# decided the how.
#
# MIND THE THINKING LEVELS OF THE DEEPSEEK SEATS. That model maps only `low`, `high` and `max`:
# `medium` does not exist (`thinkingLevelMap.medium = null`) and neither does `minimal`. A deepseek
# seat launched with `medium` dies after 3-4 tool calls with status=empty and output-bytes=0, leaving
# its tab open — which reads like a timeout and is not one. Explore and ship run `low`; implement
# runs `high`, because the seat that writes code is the most expensive one to under-think.

# SEAT_THINKING_<SEAT> > SEAT_THINKING > the map's default.
seat_thinking() {
  local override="SEAT_THINKING_$(printf '%s' "$seat" | tr '[:lower:]' '[:upper:]')"
  if [ -n "${!override:-}" ]; then printf '%s' "${!override}"; return; fi
  if [ -n "${SEAT_THINKING:-}" ]; then printf '%s' "$SEAT_THINKING"; return; fi
  printf '%s' "$1"
}

case "$seat" in
  explore)
    agent_name="photo-explore-seat"
    provider="${SEAT_PROVIDER:-opencode-go}";   model="${SEAT_MODEL:-deepseek-v4.1-flash}"
    thinking="$(seat_thinking low)";           tools="read,bash"
    ;;
  plan)
    agent_name="photo-plan-seat"
    provider="${SEAT_PROVIDER:-claude-bridge}"; model="${SEAT_MODEL:-claude-opus-5-5}"
    thinking="$(seat_thinking high)";          tools="read,bash"
    ;;
  implement)
    agent_name="photo-implement-seat"
    provider="${SEAT_PROVIDER:-opencode-go}";   model="${SEAT_MODEL:-deepseek-v4.1-flash}"
    thinking="$(seat_thinking high)";          tools="read,bash,edit,write"
    ;;
  review)
    agent_name="photo-review-seat"
    provider="${SEAT_PROVIDER:-openai}";        model="${SEAT_MODEL:-gpt-6.1-sol}"
    thinking="$(seat_thinking high)";          tools="read,bash"
    ;;
  ship)
    agent_name="photo-ship-seat"
    provider="${SEAT_PROVIDER:-opencode-go}";   model="${SEAT_MODEL:-deepseek-v4.1-flash}"
    thinking="$(seat_thinking low)";           tools="read,bash"
    ;;
  *)
    echo "usage: $0 <explore|plan|implement|review|ship>" >&2
    exit 2
    ;;
esac

# photo-<seat>-<id>[-r<N>]. The name is the join key between the tab, the watcher process and the
# board slice; pi rewrites the tab's own title once it boots, so this is the only handle that
# survives.
if [ -z "$tab_title" ]; then
  if [ -n "$task_id" ]; then
    tab_title="photo-$seat-$task_id"
    if [ -n "$attempt" ] && [ "$attempt" -gt 1 ] 2>/dev/null; then tab_title="$tab_title-r$attempt"; fi
  else
    tab_title="photo-$seat-seat"
  fi
fi

command -v orca >/dev/null 2>&1 || { echo "orca CLI not found; install Orca or fix PATH" >&2; exit 2; }
command -v pi   >/dev/null 2>&1 || { echo "pi CLI not found; install pi or fix PATH" >&2; exit 2; }

# Seats run in the SLICE'S OWN WORKSPACE, never in the primary checkout. That is the whole point of
# `new-lane.sh`: two slices in parallel are two checkouts, and a seat that edits the primary tree
# holds the coordinator's own checkout hostage. The coordinator therefore starts pi in the primary
# workspace and opens a lane per slice.
#
# Two checks, and they are different questions:
#   1. is the caller inside an Orca-managed worktree at all? Outside one, `terminal create` has no
#      workspace to attach to. `active`/`current` means "the worktree I am standing in".
#   2. is that worktree the primary checkout? `git-dir` and `git-common-dir` are the same path only
#      there. A shared `orca worktree current` says nothing about this: it answers for the primary
#      checkout too.
#
# An explicit `name:`/`id:` selector is Orca's to resolve, so it is not checked here; `path:` is.
target_dir=""
case "$worktree" in
  active|current) target_dir="$PWD" ;;
  path:*)         target_dir="${worktree#path:}" ;;
esac

if [ -n "$target_dir" ]; then
  if [ "$target_dir" = "$PWD" ] && ! orca worktree current --json >/dev/null 2>&1; then
    echo "not inside an Orca-managed worktree; open this directory from Orca and retry" >&2
    exit 2
  fi
  if [ "$allow_main" -eq 0 ]; then
    git_dir="$(cd "$target_dir" && git rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
    common_dir="$(cd "$target_dir" && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
    if [ -n "$git_dir" ] && [ "$git_dir" = "$common_dir" ]; then
      echo "refusing to launch a seat in the primary checkout: $target_dir" >&2
      echo "open the slice's workspace first:" >&2
      echo "  scripts/photo/seats/new-lane.sh <task-id> --slug <slug>" >&2
      echo "then run this from that lane, or pass --worktree name:<workspace-name>" >&2
      echo "(--allow-main overrides, for a one-off you are watching)" >&2
      exit 2
    fi
  fi
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
#
# MCP IS SCOPED TO THE CODE GRAPH. A `--tools` entry beginning with `mcp__` makes pi filter the
# servers, so a seat gets `codegraph` (read-only queries over this repository) and NOT figma — which
# ships tools that write (`add_code_connect_map`, `send_code_connect_mappings`) — nor context7. A
# read-only seat with an unaccounted second surface is not read-only. SEAT_MCP=1 is the escape hatch
# for a one-off seat you are watching yourself.
#
# ENGRAM_STARTUP_POLICY=disabled keeps the memory store single-writer: the orchestrator persists the
# plan, the verdict and whatever outlives the slice, with project: "photo-showcase". SEAT_MEMORY=1 is
# the escape hatch.
mcp_scope="mcp__codegraph__*"
cmd="pi"
[ "${SEAT_MEMORY:-0}" = "1" ] || cmd="ENGRAM_STARTUP_POLICY=disabled pi"
add_arg() { cmd="$cmd $(printf '%q' "$1")"; }
add_arg --provider;      add_arg "$provider"
add_arg --model;         add_arg "$model"
add_arg --thinking;      add_arg "$thinking"
if [ "${SEAT_MCP:-0}" = "1" ]; then
  add_arg --tools;       add_arg "$tools"
else
  add_arg --tools;       add_arg "$tools,$mcp_scope"
fi
add_arg --approve
add_arg --no-session
add_arg --append-system-prompt; add_arg "$contract"
add_arg --;              add_arg "$prompt"

[ "$do_dry_run" -eq 1 ] && { printf 'command=%s\n' "$cmd"; exit 0; }

json="$(orca terminal create --worktree "$worktree" --title "$tab_title" --command "$cmd" --json)"
handle="$(printf '%s' "$json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["terminal"]["handle"])')"
tab="$(printf '%s' "$json"    | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["terminal"]["tabId"])')"
[ -n "$handle" ] || { echo "orca returned no terminal handle: $json" >&2; exit 1; }

handoff="$(printf 'seat=%s\nagent=%s\nterminal=%s\ntab=%s\ntitle=%s\nmodel=%s/%s\nthinking=%s\ntools=%s\ncontract=%s\noutput=%s\n' \
  "$seat" "$agent_name" "$handle" "$tab" "$tab_title" "$provider" "$model" "$thinking" "$tools,$mcp_scope" "$contract" "$output")"
printf '%s\n' "$handoff"

# The handoff is printed BEFORE the blocking wait, and a caller that is interrupted mid-wait
# (Ctrl-C, an agent harness aborting the command, a dropped SSH) never receives those lines: the
# terminal is then orphaned with nothing on disk saying which seat it is or who started it. The
# file is written first, so an interrupted run is always recoverable by reading it back. Same
# content, same keys — `sed -n 's/^terminal=//p' "$output.handoff"` is the recovery path.
printf '%s\n' "$handoff" > "$output.handoff"

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
  # `$agent_name`, not `$agent`: the shell runs under `set -u`, so the wrong name is an
  # immediate fatal error on the FIRST progress tick (~30s), which killed the launcher while
  # the seat it had just started kept running in its terminal. An `if` rather than `a && b`
  # so a non-progress tick cannot be mistaken for a failed command.
  if [ $(( ticks % 15 )) -eq 0 ]; then
    echo "… waiting for $agent_name ($(( now - started ))s)" >&2
  fi
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

# The tab is not part of the handoff: once the file is written and the TUI is settled, nothing in
# this terminal is worth keeping, and leaving it open leaves tabs somebody has to close by hand —
# and pi rewrites the tab title, so they cannot even be found by the seat name afterwards. A failed
# seat keeps its tab, because that is the one you need to look at: read the screen, then close it.
cleanup="left-open"
if [ "$status" = "ok" ] && [ "$do_keep_open" -eq 0 ]; then
  if orca terminal close --terminal "$handle" --tab >/dev/null 2>&1; then
    cleanup="tab-closed"
  else
    cleanup="close-failed"
  fi
fi

# Appended to the handoff file, never replacing it: an interrupted run leaves the file with the
# seat identity and no status, which is itself the signal that nobody read the delivery.
printf 'status=%s\noutput-bytes=%s\ncleanup=%s\n' "$status" "${bytes:-0}" "$cleanup" | tee -a "$output.handoff"

[ "$status" = "ok" ] || exit 1
