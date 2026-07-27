# Task Management with kanban-md

This project uses **kanban-md** as the task board. Every task is a Markdown file under `kanban/`.
You (the agent) own the board: create tasks from `PLAN.md`, claim them, and move them as you work.

The board itself is gitignored (`kanban/`) — it is local working state, not a committed artifact.
`.claude/agents/` is gitignored too, under this repo's existing "claude code per-user config" rule,
so the sub-agent definitions currently live only on this machine. This file and `AGENTS.md` are
committed.

## Board conventions

- Statuses: `backlog` → `in-progress` → `review` → `done`. (`todo` and `archived` exist but are unused by default.)
- `in-progress` and `review` require a claim (`require_claim: true`). Always pass `--claim agent-1`.
- One task per vertical slice of `PLAN.md`. Titles short and action-oriented
  (e.g. "R2 upload pipeline", "Admin gallery creation", "Client selection flow").
- A slice is vertical: it should leave the app in a working, deployable state on its own.

## Two-agent flow (follow on every slice)

Every slice passes through two sub-agents: `photo-implementer` writes the code,
then `photo-reviewer` (fresh context) audits it before it can be `done`.

1. **Plan → board**: after the plan is approved, create one backlog task per slice:

   ```bash
   kanban-md create "R2 upload pipeline" --status backlog --priority high --tags media
   ```

2. **Claim the next task** before any work:

   ```bash
   kanban-md pick --claim agent-1 --status backlog --move in-progress
   ```

3. **Implement**: delegate to the `photo-implementer` sub-agent with the task ID.
   It reads `PLAN.md` + the task, writes code and tests, and reports back.
   Do not start another task while one is in flight.

4. **Hand off to review**:

   ```bash
   kanban-md handoff <id> --claim agent-1 --note "what changed, what to look at" --timestamp
   ```

5. **Review**: delegate to the `photo-reviewer` sub-agent with the task ID and the
   changed files. It returns `VERDICT: PASS` or `VERDICT: FAIL` with findings.
   - **FAIL** → send the findings back to `photo-implementer`, move the task back
     to `in-progress`, and repeat from step 3. Never close a failed review.
   - **PASS** → proceed.

6. **Close it** only after review passes and checks are green:

   ```bash
   kanban-md move <id> done --claim agent-1
   ```

7. Repeat until the backlog is empty.

## Command reference (verified against kanban-md 0.36.1)

| Action             | Command                                                                  |
| ------------------ | ------------------------------------------------------------------------ |
| Create task        | `kanban-md create "Title" --status backlog --priority high --tags media` |
| List tasks         | `kanban-md list --status backlog,in-progress`                            |
| Show a task        | `kanban-md show <id>`                                                    |
| Claim next         | `kanban-md pick --claim agent-1 --status backlog --move in-progress`     |
| Hand off to review | `kanban-md handoff <id> --claim agent-1 --note "…" --timestamp`          |
| Move task          | `kanban-md move <id> done --claim agent-1`                               |
| Board summary      | `kanban-md board`                                                        |

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
