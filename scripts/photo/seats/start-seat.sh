#!/usr/bin/env bash
# Launch one photo-showcase seat as a pi session on DevPass models.
#
#   scripts/photo/seats/start-seat.sh explore
#   scripts/photo/seats/start-seat.sh plan
#   scripts/photo/seats/start-seat.sh implement
#   scripts/photo/seats/start-seat.sh review
#   scripts/photo/seats/start-seat.sh ship
#
# Prints the pane id and the live agent name. Prompt it afterwards with:
#   herdr agent prompt photo-plan-seat "<task + epic + digest>" --wait --timeout 600000
#
# Requires: a Herdr-managed session and a pi build that knows both providers.

set -euo pipefail

seat="${1:-}"
case "$seat" in
  explore)
    agent_name="photo-explore-seat"
    provider="${SEAT_PROVIDER:-llm-gateway}";  model="${SEAT_MODEL:-gpt-6-luna}"
    thinking="${SEAT_THINKING:-medium}";       tools="read,bash"
    ;;
  plan)
    agent_name="photo-plan-seat"
    provider="${SEAT_PROVIDER:-claude-bridge}"; model="${SEAT_MODEL:-claude-opus-5-5}"
    thinking="${SEAT_THINKING:-high}";          tools="read,bash"
    ;;
  implement)
    agent_name="photo-implement-seat"
    provider="${SEAT_PROVIDER:-llm-gateway}";   model="${SEAT_MODEL:-deepseek-v4.1-flash}"
    thinking="${SEAT_THINKING:-medium}";        tools="read,bash,edit,write"
    ;;
  review)
    agent_name="photo-review-seat"
    provider="${SEAT_PROVIDER:-claude-bridge}"; model="${SEAT_MODEL:-claude-opus-5-5}"
    thinking="${SEAT_THINKING:-high}";          tools="read,bash"
    ;;
  ship)
    agent_name="photo-ship-seat"
    provider="${SEAT_PROVIDER:-llm-gateway}";   model="${SEAT_MODEL:-deepseek-v4.1-flash}"
    thinking="${SEAT_THINKING:-medium}";        tools="read,bash"
    ;;
  *)
    echo "usage: $0 <explore|plan|implement|review|ship>" >&2
    exit 2
    ;;
esac

if [ "${HERDR_ENV:-}" != "1" ]; then
  echo "not running inside Herdr (HERDR_ENV != 1); refusing to control panes" >&2
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

# One tab per seat. Never `pane split --current`: seats stacked in the owner's tab are unreadable.
tab_json="$(herdr tab create --cwd "$repo_root" --label "photo-$seat-seat" --no-focus)"
pane_id="$(printf '%s' "$tab_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')"

# A fresh tab can report an unbooted shell and reject `agent start` with agent_pane_busy.
# Prove the shell answers before handing it to herdr.
herdr pane run "$pane_id" 'printf "SEAT_READY\n"' >/dev/null
herdr pane wait-output "$pane_id" --match "SEAT_READY" --timeout 10000 >/dev/null 2>&1
sleep 0.3

# --append-system-prompt takes a path and reads the contract into the system prompt.
# --approve trusts the project's own context files (AGENTS.md) for this run.
start_out=""
for _attempt in 1 2 3; do
  if start_out="$(herdr agent start "$agent_name" --kind pi --pane "$pane_id" -- \
      --provider "$provider" \
      --model "$model" \
      --thinking "$thinking" \
      --tools "$tools" \
      --approve \
      --no-session \
      --append-system-prompt "$contract" 2>&1)"; then
    break
  fi
  sleep 1
done

case "$start_out" in
  *agent_started*) ;;
  *)
    echo "$start_out" >&2
    echo "could not start $agent_name in pane $pane_id; the tab is left open for inspection" >&2
    exit 1
    ;;
esac

printf 'pane=%s\nagent=%s\nmodel=%s/%s\nthinking=%s\ntools=%s\ncontract=%s\n' \
  "$pane_id" "$agent_name" "$provider" "$model" "$thinking" "$tools" "$contract"
