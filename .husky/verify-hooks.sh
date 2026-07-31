#!/usr/bin/env sh
# Confirms this worktree's pre-commit hooks are actually wired up.
#
# core.hooksPath is set to `.husky/_`, which husky regenerates via the
# `prepare` script -- but only when `bun install` runs. A worktree created
# fresh (e.g. by the agent harness under `.claude/worktrees/agent-*`) starts
# with no `node_modules` and therefore no `.husky/_`. Git resolves a
# `core.hooksPath` that points at a missing directory by silently doing
# nothing: no error, no warning, the commit just succeeds without
# `lint-staged` ever running `eslint --fix` or `prettier --write`.
#
# This cannot be checked from inside the hook itself, because the hook is
# exactly the thing that is missing. Run this script by hand, before your
# first commit in any freshly created worktree. See #101 and #123.

set -eu

fail=0

if [ ! -d ".husky/_" ]; then
  echo "FAIL: .husky/_ is missing." >&2
  echo "  Pre-commit hooks (eslint --fix, prettier --write via lint-staged)" >&2
  echo "  will NOT run in this worktree. Git silently no-ops instead of erroring." >&2
  fail=1
fi

if [ ! -d "node_modules" ]; then
  echo "FAIL: node_modules is missing." >&2
  echo "  bunx lint-staged has nothing to run." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "Run 'bun install' now -- it regenerates .husky/_ via the 'prepare' script." >&2
  exit 1
fi

echo "OK: .husky/_ and node_modules are present -- pre-commit hooks are wired up."
