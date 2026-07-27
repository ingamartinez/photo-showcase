# Agent Instructions

## Task tracking

This project uses **kanban-md** for task management. Always follow the workflow defined in [`KANBAN.md`](./KANBAN.md): create a task per slice, claim it before coding, and move it to `done` only after `photo-reviewer` returns `VERDICT: PASS`. Keep the board and the code in sync at all times.

## Source of truth

**The kanban board is the source of truth.** Each task body carries its own goal, verified context, acceptance criteria and known traps — read the task first, and treat it as sufficient. Work is grouped into epics (parent tasks tagged `epic`); epics are never implemented directly, only their child slices are.

[`PLAN.md`](./PLAN.md) is the background: the product's reasoning, domain model, business rules and phasing. Read it for _why_. When the board and the plan disagree, the board wins — and the drift gets written into the task body so it stays visible. That has already happened once: the identity model collapsed `clients` into `users`, deviating from `PLAN.md` §6 for a reason recorded in the code and the commit.

Priority order is set by the project owner and overrides the plan's own sequencing: **the admin dashboard first, the public site last.**

## Verification is not optional

Nothing is "done" because it compiles. Before closing a slice:

```bash
bun run typecheck && bun run lint && bun run test
```

And for anything touching a route, a build-time import, or the environment, reproduce the CI build in a clean worktree — the local `.env.local` hides this entire class of failure:

```bash
git worktree add /tmp/ci-check <branch> && cd /tmp/ci-check && bun install && bun run build
```
