# Agent Instructions

## Task tracking

This project uses **kanban-md** for task management. Always follow the workflow defined in [`KANBAN.md`](./KANBAN.md): create a task per slice, claim it before coding, and move it to `done` only after `photo-reviewer` returns `VERDICT: PASS`. Keep the board and the code in sync at all times.

## Source of truth

[`PLAN.md`](./PLAN.md) is the approved architecture, domain model, and phased roadmap. Deviating from it is allowed only when the deviation is deliberate, explained, and recorded — as the identity model already was (one `users` table with a role, instead of the separate `clients` table the plan originally described).

## Verification is not optional

Nothing is "done" because it compiles. Before closing a slice:

```bash
bun run typecheck && bun run lint && bun run test
```

And for anything touching a route, a build-time import, or the environment, reproduce the CI build in a clean worktree — the local `.env.local` hides this entire class of failure:

```bash
git worktree add /tmp/ci-check <branch> && cd /tmp/ci-check && bun install && bun run build
```
