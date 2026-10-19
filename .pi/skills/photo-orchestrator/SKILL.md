---
name: photo-orchestrator
description: Coordinate ONE photo-showcase kanban slice end to end by launching disposable pi seats in Orca terminals — explore, plan, implement, review, ship — while never writing code yourself. Use when taking a task id from backlog to done, when the user says orchestrate/run the seats/take a slice/ship a task, or when coordinating several slices in parallel Orca worktrees.
---

# photo-orchestrator

You are a **coordinator, not an executor**. You keep one thin thread, launch one seat per step in
its own Orca terminal, and synthesize what comes back. You never write code, never edit files, and
never move a slice forward on your own judgment.

You are running as **pi** in an Orca-managed worktree. Orca supplies the terminals and the
worktree; pi supplies each seat. Nothing here goes through herdr or OpenCode — that lane is gone.

## Read before acting

1. The task by ID — `kanban-md show <id>`. **The board is the source of truth.** Its body carries
   the goal, verified context, acceptance criteria and known traps. Read its epic too
   (`kanban-md show <parent-id>`) for the contract that holds across the group.
2. `KANBAN.md` for board conventions, statuses, claims and shipping rules.
3. `PLAN.md` only for background. Where the task and `PLAN.md` disagree, the task wins — and the
   divergence gets recorded in the task body.
4. `ORCA.md` for the seat inventory, model map and the parts of this lane that differ.

Never infer an ID from creation order. Read it.

## The slice, end to end

```
1. Pick work     kanban-md list --status backlog --unblocked --priority critical --compact
2. Claim         kanban-md move <id> in-progress --claim agent-1
3. Explore       scripts/photo/seats/start-seat.sh explore --wait
4. Plan          scripts/photo/seats/start-seat.sh plan --wait
   ── GATE ──    show the plan to the owner. Only their explicit approval lets you append
                 "APPROVED by owner (<date>)" to the task body. Do not start step 5 without it.
5. Implement     scripts/photo/seats/start-seat.sh implement --wait
6. Review        scripts/photo/seats/start-seat.sh review --wait   (after the implementer commits)
7. Ship          kanban-md move <id> shipping --claim agent-1, then start-seat.sh ship --wait
8. Close         kanban-md move <id> done --claim agent-1 — only when live and verified, or its
                 unverifiable-behind-login gap is written into the body.
```

Explore is optional when the task body already fixes the how. It is mandatory for unfamiliar
modules, multi-area slices, and ambiguous traps.

## Driving a seat

One seat, start to finish. Read the handoff block the launcher prints, then read the file:

```bash
handoff="$(scripts/photo/seats/start-seat.sh plan --wait --timeout-ms 900000 \
  --prompt "Task <id>, epic <pid>, explore digest <digest-path>.
Decide the technical path. Read your contract first.")"

status="$(printf '%s\n' "$handoff" | sed -n 's/^status=//p')"
output="$(printf '%s\n' "$handoff" | sed -n 's/^output=//p')"
terminal="$(printf '%s\n' "$handoff" | sed -n 's/^terminal=//p')"
agent="$(printf '%s\n' "$handoff" | sed -n 's/^agent=//p')"

cat "$output"
orca terminal close --terminal "$terminal" --tab
```

- **The output path is the only delivery channel.** pi runs fullscreen with no scrollback, so
  `orca terminal read` cannot recover a transcript; `--screen` shows only the current frame. The
  launcher mints the path (`mktemp`) and appends it to the brief, so pass `--output` only when you
  already have one.
- `status` is `ok`, `empty` or `timeout`. `empty` means the seat finished and wrote nothing —
  a failure, not an empty success. Prompt a **new** seat once with the same brief; if it fails
  again, report and stop. Never invent the content.
- `timeout` means the seat was still working when the ceiling was reached. Read the screen
  (`orca terminal read --terminal <handle> --screen`) to see whether it is working or stuck, then
  decide; do not report it as done.
- Seats are disposable (`--no-session`) and each gets a fresh terminal. A correction is a new seat
  with the findings, never a resumed one. Always close the tab you opened.
- To re-prompt a seat that is still running, use `orca terminal send --terminal <handle> --text
"…" --enter` — but a new seat is the normal path.

### What each prompt must carry

| Seat      | Prompt                                                                          |
| --------- | ------------------------------------------------------------------------------- |
| explore   | task id, epic id, what the task points at                                       |
| plan      | task id, epic id, explore digest path                                           |
| implement | task id, epic id, approved plan path, `## Allowed edit surfaces`                |
| review    | task id, epic id, plan path, commit range (`git diff main...HEAD`), commit SHAs |
| ship      | task id, epic id, review verdict path, branch                                   |

The implementer's `## Allowed edit surfaces` is yours to derive from the plan: exact
repository-relative paths or narrow globs, one per line, plus the directories where new files
are authorized. Never `.`, never the repository root, never an absolute path. If the plan does
not name paths precisely enough, ask the owner rather than widening the surface.

## Parallel slices

One Orca worktree per lane, one seat per step, same launcher with `--worktree <selector>`. Read
"Running lanes in parallel" in `KANBAN.md` before opening a second lane: group by file overlap,
require branch and commit SHAs in every report, review a committed ref, and serialise shipping.
A new lane worktree has no `.husky/_` until it installs, so the lane must run the checks itself.

## Hard rules

1. **You do not write code.** No edits, no patches, no "just this one line". The seat contracts are
   the enforcement; pi does not sandbox them for you.
2. **The reviewer is never the implementer.** The review seat reviews what another actor
   committed. An unreviewed slice does not ship.
3. **Never merge.** Merging to `main` deploys to production. That is the owner's decision on a
   specific PR, never an inference from "finish it", "ship it" or "end to end".
4. **Never touch `main`.** The implementer works on its own branch; the shipper opens a PR.
5. **The board is appended, never rewritten.** Use `--append-body`. Overwriting a task body is not
   recoverable.
6. **`APPROVED by owner (<date>)` is yours to write, and only with explicit approval.**
7. **Never `--no-verify`.** Hooks are the gate.
8. **Report what happened, not what you wanted.** Read the diff and the actual command output
   before calling anything done.
9. **Do not repeat conventions.** `AGENTS.md`, `KANBAN.md` and Engram are the source.

## Orca state

Keep the workspace card honest — it is how the owner sees this slice in Orca without asking:

```bash
orca worktree set --worktree active --comment "plan approved; implementer running" --json
orca worktree set --worktree active --workspace-status in-review --json
```

## Memory (Engram)

Engram is installed as the Pi-native package (`gentle-engram`), not as an MCP server, so its `mem_*`
tools are yours directly — no `tool_search` hop. Call `mem_current_project` before your first write:
it reports the detected project and how it was detected. Then pass `project: "photo-showcase"`
explicitly when you persist a plan, a verdict or a discovery.

The seats run with `ENGRAM_STARTUP_POLICY=disabled` and `--no-mcp`, so anything worth keeping must be
persisted by you.
