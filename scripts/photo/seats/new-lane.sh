#!/usr/bin/env bash
# Open the workspace (Orca worktree) for ONE slice, ready for seats.
#
#   scripts/photo/seats/new-lane.sh 276 --slug galerias-paginacion
#   → lane=/Users/alejo/orca/workspaces/photo-showcase/276-galerias-paginacion
#     worktree=name:276-galerias-paginacion
#     branch=ingamartinez/276-galerias-paginacion
#     setup=installed
#
# The coordinator runs in the PRIMARY checkout (/Users/alejo/projects/photo-showcase) and never
# lets a seat work there. Every slice gets its own workspace: that is what makes two slices in
# parallel two independent checkouts instead of two seats editing one tree.
#
# Orca owns the checkout: it picks the path (`~/orca/workspaces/<repo>/<name>`) and creates the
# branch as `ingamartinez/<name>` off the base branch. This script does not `git worktree add` by
# hand — a hand-made worktree is invisible to Orca, and a lane nobody can see is a lane nobody
# reviews.
#
# Then it does the two things a fresh checkout lacks, and both get forgotten:
#   1. `codegraph init` — `.codegraph/` is gitignored, so a new lane has no graph, and a seat whose
#      cwd has no graph greps instead of querying it, silently.
#   2. `bun install` — node_modules AND `.husky/_`. Without the install there is no pre-commit hook
#      in that lane (the tracked fallback blocks the commit rather than letting it through), and no
#      test runner.
#
# Prints key=value lines and nothing else. Idempotent: run it again for a lane that already exists
# and it reuses the checkout and only fills in whatever setup is missing.
#
# Requires: orca CLI reachable, bun on PATH, and a git repository.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: new-lane.sh <task-id> [--slug <slug>] [--name <name>] [--base <ref>]
                   [--repo <path>] [--no-activate] [--skip-setup] [--dry-run]

  <task-id>        Board slice id. The workspace name defaults to <id>[-<slug>], and Orca derives
                   the branch from it as ingamartinez/<name>.
  --slug <slug>    Human-readable suffix: name becomes <id>-<slug>. No spaces, no dates.
  --name <name>    Full workspace name, when the convention does not fit.
  --base <ref>     Base branch/ref for the checkout (default: main).
  --repo <path>    Repository whose worktree this is (default: the current repo's main checkout).
  --no-activate    Do not reveal the new workspace in the Orca app.
  --skip-setup     Create the checkout only; no bun install, no codegraph init.
  --dry-run        Print the command and the derived names, then stop.

  Names are the join key: the workspace name, the branch, the tab titles
  (photo-<seat>-<id>) and the board slice all carry the same id.
EOF
}

task_id=""
slug=""
name=""
base="main"
repo=""
do_activate=1
do_setup=1
do_dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --slug)        slug="${2:?--slug needs a value}"; shift 2 ;;
    --name)        name="${2:?--name needs a value}"; shift 2 ;;
    --base)        base="${2:?--base needs a value}"; shift 2 ;;
    --repo)        repo="${2:?--repo needs a value}"; shift 2 ;;
    --no-activate) do_activate=0; shift ;;
    --skip-setup)  do_setup=0; shift ;;
    --dry-run)     do_dry_run=1; shift ;;
    -*) echo "unknown option: $1" >&2; usage; exit 2 ;;
    *)  [ -z "$task_id" ] || { echo "unexpected argument: $1" >&2; usage; exit 2; }
        task_id="$1"; shift ;;
  esac
done

[ -n "$task_id" ] || { usage; exit 2; }
case "$task_id" in
  *[!0-9]*) echo "task id must be numeric, got '$task_id'" >&2; exit 2 ;;
esac

if [ -z "$name" ]; then
  if [ -n "$slug" ]; then name="$task_id-$slug"; else name="slice-$task_id"; fi
fi

command -v orca >/dev/null 2>&1 || { echo "orca CLI not found; install Orca or fix PATH" >&2; exit 2; }

# Resolve the repository whose worktree we are opening. `git-common-dir` points at the shared
# `.git`, whether the caller stands in the primary checkout or inside another lane, so its parent
# is always the primary checkout.
if [ -z "$repo" ]; then
  common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "$common_dir" ] || { echo "not inside a git repository; pass --repo <path>" >&2; exit 2; }
  repo="$(cd "$common_dir/.." && pwd -P)"
fi
[ -d "$repo/.git" ] || [ -f "$repo/.git" ] || { echo "not a git checkout: $repo" >&2; exit 2; }

# Reuse before creating: Orca refuses a duplicate name, and a second run of this script is normal
# (setup failed halfway, a lane was opened yesterday and needs its index rebuilt).
existing_path="$(
  orca worktree list --json 2>/dev/null |
    python3 -c '
import json, sys
name = sys.argv[1]
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for wt in (data.get("result") or {}).get("worktrees") or []:
    if wt.get("displayName") == name and wt.get("path"):
        print(wt["path"])
        break
' "$name"
)"

if [ "$do_dry_run" -eq 1 ]; then
  printf 'name=%s\nbranch=%s\nbase=%s\nrepo=%s\nlane=%s\ncommand=%s\n' \
    "$name" "ingamartinez/$name" "$base" "$repo" "${existing_path:-(new)}" \
    "orca worktree create --name $name --repo path:$repo --parent-worktree active --base-branch $base --setup skip --json"
  exit 0
fi

if [ -n "$existing_path" ]; then
  lane="$existing_path"
  created="reused"
else
  create_cmd=(orca worktree create --name "$name" --repo "path:$repo"
              --parent-worktree active --base-branch "$base" --setup skip --json)
  [ "$do_activate" -eq 1 ] && create_cmd+=(--activate)

  json="$("${create_cmd[@]}")"
  lane="$(
    printf '%s' "$json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
wt = (data.get("result") or {}).get("worktree") or {}
print(wt.get("path", ""))
'
  )"
  [ -n "$lane" ] || { echo "orca created no worktree: $json" >&2; exit 1; }
  created="created"
fi

[ -d "$lane" ] || { echo "workspace path does not exist: $lane" >&2; exit 1; }
branch="$(git -C "$lane" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"

# Setup. Both steps are skipped when already done, so a rerun is cheap.
setup="skipped"
if [ "$do_setup" -eq 1 ]; then
  if [ ! -d "$lane/node_modules" ]; then
    command -v bun >/dev/null 2>&1 || { echo "bun not found; install Bun or fix PATH" >&2; exit 2; }
    ( cd "$lane" && bun install --frozen-lockfile ) >&2
  fi
  # `bun install` overwrites the TRACKED `.husky/_/pre-commit` fallback with husky's generated
  # delegator, every time (AGENTS.md / #123). The hook still works — it runs the same
  # `bunx lint-staged` — but the file is left MODIFIED, one ordinary `git add -A` away from
  # committing the regression `.github/workflows/ci.yml` checks for. Put the tracked copy back so
  # the lane starts clean and the implement seat cannot commit it by accident.
  git -C "$lane" checkout HEAD -- .husky/_/pre-commit 2>/dev/null || true
  if [ ! -d "$lane/.codegraph" ]; then
    command -v codegraph >/dev/null 2>&1 || { echo "codegraph not found; install it or fix PATH" >&2; exit 2; }
    codegraph init -y "$lane" >&2
  fi
  setup="installed"
fi

printf 'lane=%s\nworktree=name:%s\nbranch=%s\nbase=%s\nsetup=%s\nworkspace=%s\n' \
  "$lane" "$name" "$branch" "$base" "$setup" "$created"
