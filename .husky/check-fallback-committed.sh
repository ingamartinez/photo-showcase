#!/usr/bin/env sh
# CI guard for #123: confirms the COMMITTED blob at `.husky/_/pre-commit` is
# still the enforcement fallback, not husky's generated delegator stub.
#
# `.husky/_/pre-commit` is tracked so it exists in a fresh worktree before
# any install ever runs -- see that file's own header for the full story.
# But `bun install` overwrites it on disk unconditionally, every time
# (husky's own `prepare` script does this to every file under `.husky/_`).
# After that, an entirely ordinary `git add -A && git commit` -- no flags,
# no warning from git or lint-staged -- commits husky's 2-line generated
# delegator right over the fallback. Nothing about that commit looks wrong
# locally: the working tree is clean, the hook still exists, it just no
# longer knows how to fail loudly when `node_modules` is missing (it fails
# with a confusing "no such file" instead, because it delegates to a `./h`
# helper that only the generated `.husky/_` tree provides).
#
# This has to run against the committed blob, not the working tree: any CI
# runner has already gone through its own `bun install`, so the working
# tree's copy of this file is always the regenerated one and would prove
# nothing either way.

set -eu

marker='node_modules'

if ! git show HEAD:.husky/_/pre-commit | grep -q "$marker"; then
	echo "FAIL: .husky/_/pre-commit no longer contains the fallback's node_modules check." >&2
	echo "  This usually means a 'bun install' followed by an ordinary commit" >&2
	echo "  overwrote the tracked enforcement shim with husky's generated" >&2
	echo "  delegator. Restore the fallback from git history (see #123) and" >&2
	echo "  re-track it explicitly with 'git add -f .husky/_/pre-commit'." >&2
	exit 1
fi

echo "OK: .husky/_/pre-commit still carries the fallback's node_modules check."
