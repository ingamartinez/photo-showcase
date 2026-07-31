#!/usr/bin/env sh
# Manual, early check for whether this worktree's pre-commit hooks are
# fully wired up. Enforcement itself does not depend on this script: the
# tracked `.husky/_/pre-commit` fallback blocks a commit loudly on its own
# when `node_modules` is missing (see that file's header for how). This
# script exists so you can find out *before* attempting a commit, with a
# clearer diagnosis than a failed commit gives you.
#
# core.hooksPath is set to `.husky/_`, which husky regenerates via the
# `prepare` script on `bun install`. Before that first install in a given
# worktree, `.husky/_` only contains the one tracked fallback file -- no
# `node_modules`, no full shim chain -- which is what this script reports.
#
# Run this by hand, before your first commit in any freshly created
# worktree, or just trust the hook itself to block you. See #101 and #123.

set -eu

cd "$(git rev-parse --show-toplevel)"

fail=0

if [ ! -d ".husky/_" ]; then
  echo "FAIL: .husky/_ is missing." >&2
  echo "  Pre-commit hooks (eslint --fix, prettier --write via lint-staged)" >&2
  echo "  cannot fully run in this worktree yet." >&2
  fail=1
fi

if [ ! -d "node_modules" ]; then
  echo "FAIL: node_modules is missing." >&2
  echo "  bunx lint-staged has nothing to run. The tracked pre-commit" >&2
  echo "  fallback will block any commit you attempt until this is fixed." >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "Run 'bun install' now -- it regenerates .husky/_ via the 'prepare' script." >&2
  exit 1
fi

echo "OK: .husky/_ and node_modules are present -- pre-commit hooks are wired up."
