# Task Management with kanban-md

This project uses **kanban-md** as the task board. Every task is a Markdown file under `kanban/`.
You (the agent) own the board: claim tasks, work them, and move them as you go.

The board itself is gitignored (`kanban/`) — it is local working state, not a committed artifact.
This file, `AGENTS.md`, and the sub-agent definitions under `.claude/agents/` ARE committed;
`.gitignore` excludes `.claude/*` but re-includes `.claude/agents/`.

## The board is the source of truth

**The board — not `PLAN.md` — is what the work follows.** A task's body carries the
goal, the verified context, the acceptance criteria and the traps. Read the task
before anything else; it is written to be sufficient on its own.

`PLAN.md` remains the background: why the product is shaped this way, the domain
model, the business rules, the reasoning behind decisions. Consult it for rationale.
When the two disagree, **the board wins**, and the disagreement gets recorded in the
task body so the drift is visible instead of silent. (This has already happened once:
the identity model collapsed `clients` into `users`, deviating from `PLAN.md` §6.)

## Board conventions

- Statuses: `epics` (containers, never worked) and `backlog` → `in-progress` → `review` → `shipping` → `done`. (`archived` exists but is unused.)
- `in-progress`, `review` and `shipping` require a claim (`require_claim: true`). Always pass `--claim agent-1`.
- `shipping` is its own column because getting a slice to production is the longest
  and most failure-prone step — CI, a merge, a deploy, and a live verification, all
  depending on systems outside this machine. Without it, a slice that passed review
  but broke on deploy sits in `review`, pointing at the wrong problem.
- `done` means live in production and verified there. Not merged. Not "should work".
  The one sanctioned exception is behaviour behind a login — see "What the shipping
  agent cannot verify" below. Such a slice reaches `done` with the gap written into
  its own body, never with a silent claim of verification.
- One task per vertical slice. A slice is vertical: it should leave the app in a
  working, deployable state on its own.
- Titles short and action-oriented. The body carries the detail — and it should carry
  **all** of it: a task that needs a conversation to be understood is not ready.

## Epics

Work is grouped with kanban-md's native parent/child support. Epics are tasks tagged
`epic`, titled `EPIC — …`, and every slice is created with `--parent <epic-id>`.

- **Epics are never claimed, implemented, or moved to `in-progress`.** They are
  containers and context. Only leaf slices get worked.
- Epics live in their own `epics` column, not in `backlog`. This is why the unused
  `todo` status was renamed in `kanban/config.yml`: a rule that says "never claim an
  epic" is only as good as everyone's memory, whereas keeping them out of `backlog`
  means a query for workable tasks cannot return one.
- An epic body holds what is true across all its slices — what already exists, the
  rules that must hold everywhere, and what "done" means for the group.
- An epic moves to `done` only when all its children are `done`.

```bash
kanban-md list --tag epic --compact       # the eight epics
kanban-md list --parent 3 --compact       # the slices inside one epic
```

## Dependencies

Slices declare real ordering with `--depends-on <ids>`. Choose the next task by
listing what is actually unblocked, highest priority first, then claim it:

```bash
kanban-md list --status backlog --unblocked --priority critical --compact
kanban-md move <id> in-progress --claim agent-1
```

**Do not use `kanban-md pick` here.** Verified against 0.36.1 and 0.37.0: `pick` accepts neither
`--unblocked` nor `--priority`, so it will happily hand you a low-priority task whose
dependencies are unfinished. The two-step above is deliberate — the choice of what to
work on next should be made looking at the unblocked set, not delegated to an ID sort.

## Priority policy

Set by the project owner, and it overrides the order things appear in `PLAN.md`:

1. **The admin dashboard first** — epics 1, 2 and 3 (`critical`). The photographer
   must be able to run a real session end to end before anything else is polished.
2. Then the client-facing gallery and delivery — epics 4 and 5 (`high`).
3. GraphQL and operations — epics 6 and 8 (`medium`).
4. **The public site last** — epic 7 (`low`). It is already live and earning its keep.

## Three-agent flow (follow on every slice)

Every slice passes through three sub-agents: `photo-implementer` writes the code,
`photo-reviewer` (fresh context) audits it, and only then `photo-shipper` takes it
to production. Each hands off to the next; none of them skips ahead.

1. **Board first**: the backlog is already populated with 8 epics and 34 slices. New
   work becomes a task before it becomes code:

   ```bash
   kanban-md create "Title" --parent <epic-id> --status backlog --priority high \
     --tags media --depends-on 13,14 --estimate 4h --body "…"
   ```

2. **Claim the next unblocked task** before any work (see Dependencies below — do
   not use `kanban-md pick`):

   ```bash
   kanban-md list --status backlog --unblocked --priority critical --compact
   kanban-md move <id> in-progress --claim agent-1
   ```

3. **Implement**: delegate to the `photo-implementer` sub-agent with the task ID.
   It reads the task and its epic first, `PLAN.md` for background, then writes code
   and tests and reports back. Do not start another task while one is in flight.

4. **Hand off to review**:

   ```bash
   kanban-md handoff <id> --claim agent-1 --note "what changed, what to look at" --timestamp
   ```

5. **Review**: delegate to the `photo-reviewer` sub-agent with the task ID and the
   changed files. It returns `VERDICT: PASS` or `VERDICT: FAIL` with findings.
   - **FAIL** → send the findings back to `photo-implementer`, move the task back
     to `in-progress`, and repeat from step 3. Never close a failed review.
   - **PASS** → proceed.

6. **Ship it**: move the task, then delegate to the `photo-shipper` sub-agent:

   ```bash
   kanban-md move <id> shipping --claim agent-1
   ```

   It makes the work-unit commits, reproduces the CI build in a clean worktree,
   opens the PR, waits for checks, merges, watches the deploy, and verifies
   production — including that `findash`, which shares the droplet, is still
   healthy. It refuses to ship a slice that did not pass review.

   If shipping fails, the task STAYS in `shipping`. That is the column's whole
   purpose: a slice stuck between merged and working is a distinct, visible state,
   not a review problem.

7. **Close it** only after the slice is live and verified:

   ```bash
   kanban-md move <id> done --claim agent-1
   ```

   If the shipper reported acceptance criteria it could not verify, append them to
   the task body BEFORE closing — name what was and was not confirmed live, and what
   the owner should open to close it. The board's own rule is that drift gets
   recorded rather than silently resolved; an unverifiable criterion is drift.

   ```bash
   kanban-md edit <id> --claim agent-1 --append-body "…"
   ```

8. Repeat until the backlog is empty.

## Running lanes in parallel

Several slices can run at once, one agent per slice, each in its own worktree. It
works — six slices shipped this way on 2026-07-30 — but it has its own failure
modes, and all of them are quiet ones. Each rule below was paid for that day.

**Group by file overlap, not by priority.** Decide the lanes by reading which files
each task will touch, then tell every lane which regions its neighbours are in and
to stay out of them. Two lanes editing distant regions of one large file
(`actions.ts` at ~1300 lines held two) rebase cleanly; two lanes editing the same
function do not. Where two tickets share files, run them as ONE lane — #90 and #49
were bundled for this reason and their own bodies asked for it.

**Every lane branches and commits early.** This is the one that costs the most when
ignored. An agent that works only in its working tree has produced nothing durable:
the harness reclaims an isolation worktree it considers UNCHANGED, and unchanged
means _no commits on its branch_, not _no edits on disk_. A whole reviewed slice was
destroyed this way while four siblings survived, and the only difference was that
they had committed. Require branch and commit SHAs in every implementer report.

**Review against a committed ref, never a working tree.** The lost slice's review
report says it read "the full diff (working tree, uncommitted)" — that sentence was
the visible early warning, hours before the loss. Handoff notes carry the SHA.

**Fresh worktrees have no hooks.** `.husky/_` is generated by `prepare: husky` on
install, so until something runs `bun install` in that exact worktree it does not
exist — and git silently no-ops a `core.hooksPath` pointing at nothing. `lint-staged`
never fires, so `prettier --write` and `eslint --fix` never run. Every lane must run
the checks itself rather than trusting the hooks. See #123.

**Serialise shipping.** Reviews run in parallel; merges do not. One droplet, and
each merge triggers a symlink flip and a service restart. Ship one slice at a time,
and wait for production to confirm healthy before merging the next — not for timing
reasons, but so a failed deploy stays one diagnosable problem instead of two
entangled ones.

**Expect branches to fall behind.** By the last slice, `main` had moved four times.
Each shipper rebases onto current `main` and re-runs the suite. If a rebase
conflicts, that means the file-overlap analysis was wrong: stop and escalate rather
than improvising a resolution.

## What the shipping agent cannot verify

The admin dashboard and every client-facing surface sit behind a magic-link login.
That design is correct and is not changing. The consequence is that **the agent that
ships a slice cannot see most of what it shipped.** It can prove the guard fires —
`/dashboard` 307s when signed out — which is not the same as proving the feature
works.

The decision, made deliberately after weighing the alternatives in #82: **no
standing credential is minted for an automated agent against production.** A
read-only smoke account and a seeded staging environment were both considered and
both rejected as too much standing blast radius for a one-photographer site. The
cost is accepted instead, and paid like this:

- `photo-shipper` is told in its own instructions that it may not obtain a session
  by any means, and that "I could not verify this, it requires an authenticated
  session" is a correct and complete outcome. That prohibition is not advisory —
  it exists because an agent shipping #38 invented its own path into production
  auth when it found none sanctioned, and the improvisation looked entirely
  reasonable.
- Every such gap is written into the task body at close, naming the criteria.
- **The owner verifies by hand.** For an admin-facing or client-facing slice that
  is the last step, and the slice is not truly finished until it happens.

If this ever becomes too expensive — enough slices, enough manual checks — reopen
the decision rather than letting an agent route around it.

## Command reference (verified against kanban-md 0.37.0)

Board config is schema **v11**. It migrated automatically from v10 on the first
0.37.0 run; a v10 binary will no longer open it. If this board is ever opened from
a second machine, upgrade that client first.

| Action                | Command                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Create task           | `kanban-md create "Title" --parent <id> --status backlog --priority high --tags media --depends-on 13 --estimate 4h --body "…"` |
| List tasks            | `kanban-md list --status backlog,in-progress`                                                                                   |
| List epics            | `kanban-md list --tag epic --compact`                                                                                           |
| List an epic's slices | `kanban-md list --parent <id> --compact`                                                                                        |
| Show a task           | `kanban-md show <id>`                                                                                                           |
| See what is workable  | `kanban-md list --status backlog --unblocked --priority critical --compact`                                                     |
| Claim it              | `kanban-md move <id> in-progress --claim agent-1`                                                                               |
| Hand off to review    | `kanban-md handoff <id> --claim agent-1 --note "…" --timestamp`                                                                 |
| Hand to shipping      | `kanban-md move <id> shipping --claim agent-1`                                                                                  |
| Close it              | `kanban-md move <id> done --claim agent-1`                                                                                      |
| Undo a wrong move     | `kanban-md edit <id> --clear-started --clear-completed --release`                                                               |
| Board summary         | `kanban-md board`                                                                                                               |

Upstream documentation: <https://github.com/antopolskiy/kanban-md>

## Task file format

```markdown
---
id: 1
title: R2 upload pipeline
status: backlog
priority: high
created: 2026-07-27T10:30:00Z
updated: 2026-07-27T10:30:00Z
tags:
  - media
---

Optional body: acceptance criteria, affected files, or notes for this slice.
```

## Rules

- Never skip the board: if you write code for a slice, that slice MUST have a claimed task.
- Never delete tasks. Move completed ones to `done`.
- If a kanban-md command fails, report it once and continue with the code — do not block on the board.
- Keep the board and the code in sync at all times.
