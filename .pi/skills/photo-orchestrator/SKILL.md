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

## The seats, and why each one runs on that model

| Step      | Seat                   | Provider / model                  | Thinking | Tools                          |
| --------- | ---------------------- | --------------------------------- | -------- | ------------------------------ |
| Explore   | `photo-explore-seat`   | `opencode-go/deepseek-v4.1-flash` | low      | `read,bash` + codegraph        |
| Plan      | `photo-plan-seat`      | `claude-bridge/claude-opus-5-5`   | high     | `read,bash` + codegraph        |
| Implement | `photo-implement-seat` | `opencode-go/deepseek-v4.1-flash` | high     | `read,bash,edit,write` + graph |
| Review    | `photo-review-seat`    | `openai/gpt-6.1-sol`              | high     | `read,bash` + codegraph        |
| Ship      | `photo-ship-seat`      | `opencode-go/deepseek-v4.1-flash` | low      | `read,bash` + codegraph        |

The map lives in `scripts/photo/seats/start-seat.sh`; you never type a model by hand. Two things
about it that are not obvious:

- **The deepseek seats run through OpenCode Go, and that model maps only `low`, `high` and `max`.**
  `medium` does not exist. A deepseek seat launched with `medium` dies after 3-4 tool calls with
  `status=empty` and `output-bytes=0`, leaving its tab open — it looks like a timeout and is not one.
  Implement runs `high` on purpose: it is the seat that is most expensive to under-think.
- **Plan and review on different model lines** is the reason review exists. If you ever see the same
  model in both, the seat map was reverted by accident.

## The slice, end to end

```
1. Pick work     kanban-md list --status backlog --unblocked --priority critical --compact
2. Claim         kanban-md move <id> in-progress --claim agent-1
3. Workspace     new-lane.sh <id> --slug <slug>   ← you run this from the PRIMARY checkout
                 → lane=<path> worktree=name:<name>   (every seat below gets --worktree name:<name>)
4. Explore       start-seat.sh explore --id <id>      (optional when the body fixes the how)
5. Plan          start-seat.sh plan --id <id>
   ── GATE ──    show the plan to the owner. Only their explicit approval lets you append
                 "APPROVED by owner (<date>)" to the task body. Do not start step 6 without it.
6. Implement     start-seat.sh implement --id <id>
7. Review        start-seat.sh review --id <id>        (after the implementer commits)
8. Ship          kanban-md move <id> shipping --claim agent-1, then start-seat.sh ship --id <id>
9. Close         kanban-md move <id> done --claim agent-1 — only when live and verified, or its
                 unverifiable-behind-login gap is written into the body.
```

**You run in the primary checkout; the seats do not.** You open pi in
`/Users/alejo/projects/photo-showcase` and `new-lane.sh` creates the slice's workspace (Orca's
`~/orca/workspaces/photo-showcase/<name>`, branch `ingamartinez/<name>` off `main`, its own
`codegraph` index and `bun install`). Every seat then runs in that lane. `start-seat.sh` refuses the
primary checkout outright, which is the point: two slices in parallel are two checkouts, not two
seats editing one tree.

**No step passes `--wait`.** Each launch returns in seconds with `terminal=` and `output=`; you then
start one `process` watcher for that seat and **end your turn**. See "Waiting without blocking".

Every turn begins with `seat-status.sh` — see "Reconcile, don't remember". A step is never "in
flight" in your memory: it is whatever the handoff files say when you look.

Explore is optional when the task body already fixes the how. It is mandatory for unfamiliar
modules, multi-area slices, and ambiguous traps.

**Ask for several slices at once and you run this list once per slice, interleaved**: workspaces
first for all of them, then the seats as each slice reaches them. Never two slices in one workspace,
and never two seats of the same step on one slice.

## Driving a seat

One seat, start to finish. Read the handoff block the launcher prints, then read the file:

```bash
handoff="$(scripts/photo/seats/start-seat.sh plan --id <id> \
  --prompt "Task <id>, epic <pid>, explore digest <digest-path>.
Decide the technical path. Read your contract first.")"

output="$(printf '%s\n' "$handoff" | sed -n 's/^output=//p')"
terminal="$(printf '%s\n' "$handoff" | sed -n 's/^terminal=//p')"
title="$(printf '%s\n' "$handoff" | sed -n 's/^title=//p')"
```

- **The output path is the only delivery channel.** pi runs fullscreen with no scrollback, so
  `orca terminal read` cannot recover a transcript; `--screen` shows only the current frame. The
  launcher mints the path (`mktemp`) and appends it to the brief, so pass `--output` only when you
  already have one.
- **Without `--wait`, closing the tab is yours.** `orca terminal close --terminal <handle> --tab`
  once you have read the delivery, or `seat-status.sh --close-settled` in bulk. A finished seat's
  tab holds nothing but repaint fragments, and pi rewrites the title to `π - photo-showcase`, so a
  leftover cannot be found later by `photo-<seat>-<id>`. `--keep-open` exists for a seat you are
  watching yourself.
- **`status=empty` is a failure, not an empty success** (only visible under `--wait`; without it a
  failed seat shows up as its own `TIMEOUT <seat>`). Re-prompt a **new** seat once with the same
  brief; if it fails again, report and stop. Never invent the content.
- **If a seat cannot write its report at all**, check screen: it probably quoted a command the
  permission policy denies, and the policy matches substrings over the whole command line, so a
  `cat > … <<EOF` containing that command is denied. Answer it in place
  (`orca terminal send … --text "write it with that command described in words" --enter`); do not
  widen the rule.
- A failed seat keeps its tab open on purpose, because that is the one worth looking at. Read the
  screen (`orca terminal read --terminal <handle> --screen`), then close it. Nothing else should
  outlive the run.
- Seats are disposable (`--no-session`) and each gets a fresh terminal. A correction is a new seat
  with the findings, never a resumed one — and a retry of the same seat on the same slice carries
  `--attempt <n>`, which is what makes its title `photo-<seat>-<id>-r2`.
- To re-prompt a seat that is still running, use `orca terminal send --terminal <handle> --text
"…" --enter` — but a new seat is the normal path.

### Waiting without blocking: the seat tells you

**Do not pass `--wait` to coordinate.** It blocks your turn until _that_ seat delivers, so while you
wait the others deliver unseen. Measured in the sibling SYC lane on 2026-10-20, with the owner
watching: two reviews in parallel, the first delivered, and the coordinator was still blocking on the
second while the PR sat open.

The protocol, with the `@aliou/pi-processes` extension:

1. **Launch without `--wait`** — returns in seconds with `terminal=` and `output=`.
2. **Start ONE `process` per seat** — never one combined watcher — and end the turn:

   ```jsonc
   {
     "action": "start",
     "name": "seat-implement-<id>",
     "command": "bash scripts/photo/seats/watch-seat.sh implement-<id> <output> 2400",
     "notify": {
       "logMatches": [
         { "pattern": "DELIVERED implement-<id>", "on": "turn" },
         { "pattern": "TIMEOUT", "on": "turn" },
       ],
     },
   }
   ```

   `watch-seat.sh <name> <delivery-path> <seconds>` polls `wc -c` every ~8 s and prints exactly one
   line: `DELIVERED <name> bytes=<n>`, `TIMEOUT <name> after <n>s`, or `MISSING <name> <path>`.
   The extension wakes you on the match — no polling from your side, no retained turn.

3. Read the file, act, **close that tab**, and `process clear` the finished watcher.

Ceilings are per seat because a combined watcher would have to use the slowest one for everyone:
ship 20 min (`1200`), implement 40 (`2400`), review 30 (`1800`). A combined ALL-DELIVERED watcher is
the `--wait` defect at a smaller scale: it serialises behind the slowest seat and loses the isolation
of a failure. Naming the seat in the pattern is what stops one seat's event waking you for another.
`MISSING` (exit 3) is a typo in the launcher's `output=`, not a slow seat.

Launch every seat you need before reading any of them. The parallelism is not a shell `&`: each seat
runs in its own Orca terminal and you never wait on it.

### Reconcile, don't remember

**Every turn starts with the reconciliation, never with your memory of what you launched:**

```bash
scripts/photo/seats/seat-status.sh
```

`delivered` means a seat finished and NOBODY HAS READ IT — read it now. `empty` means it finished and
wrote nothing, which is a failure: re-prompt a NEW seat once. `gone` means its terminal died with no
delivery. `settled` means a completed launcher already recorded the outcome.

This is the safety net under the watcher, and it exists because the watcher can be lost: a Ctrl-C, an
owner's question, a harness that kills the command. `start-seat.sh` writes `<output>.handoff`
**before** it returns, so a wake-up at an arbitrary moment — or a turn that begins after an aborted
wait — loses nothing. `seat-status.sh --close-settled` closes delivered and empty seats' tabs and
never touches a running one.

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

## The file is the pipe, Engram is the archive

Seats hand you work through the file the launcher mints. Keep it that way, for reasons that are
about the transport, not about taste:

- the file exists **before** the seat starts, so "empty" is a real failure signal and `status`
  means something;
- every attempt gets its own path, so retrying a seat cannot overwrite the attempt you are still
  diagnosing;
- it needs no server, so a seat can deliver while Engram is down or unregistered.

Engram is where the artifacts that **outlive the slice** go, and persisting them is your job, not
the seat's — a seat that wrote memory would be a second writer to a store you own. After the owner
approves a plan, and after a review returns a verdict:

```
mem_save(project: "photo-showcase", type: "architecture",
         topic_key: "photo-showcase/slice-<id>/plan",   # or /review, /ship
         title: "Slice <id> approved plan", content: <the file's content>)
```

The topic key upserts, so a slice reviewed twice keeps one record — the latest — while the files
stay per-attempt. Save the ship report when the slice closes, including the acceptance criteria
nobody could verify live: that is the part you will want to find in six weeks.

## Parallel slices

One workspace per slice — `new-lane.sh <id> --slug <slug>` — one seat per step, and every launch
carries `--worktree name:<workspace> --id <id>`, so tab, watcher and board slice share one name and
two lanes cannot wake each other. **That workspace is a peer of the primary checkout, not a child of
it** (`new-lane.sh` passes `--no-parent`): a child is collapsed under `main` in the sidebar and stops
reading as its own workspace. If one was created as a child,
`orca worktree set --worktree name:<workspace> --no-parent` detaches it.

Read "Running lanes in parallel" in `KANBAN.md` before opening a second lane: group by file overlap,
require branch and commit SHAs in every report, review a committed ref, and serialise shipping.

The workspace's branch is created from `main` by Orca; the implementer commits to it and never
touches `main`. Open the lane with `new-lane.sh` rather than `git worktree add`: a hand-made
worktree is invisible to Orca, and a lane nobody can see is a lane nobody reviews.

## Hard rules

1. **You do not write code.** No edits, no patches, no "just this one line". The seat contracts are
   the enforcement; pi does not sandbox them for you.
2. **The reviewer is never the implementer.** The review seat reviews what another actor
   committed. An unreviewed slice does not ship. Plan and review also run different models.
3. **Never merge.** Merging to `main` deploys to production — that is the owner's decision on a
   specific PR, never an inference from "finish it", "ship it" or "end to end". The **ship seat**
   merges the PR the owner approved; you do not.
4. **Never touch `main`.** The implementer works on its own branch; the shipper opens a PR.
5. **The board is appended, never rewritten.** Use `--append-body`. Overwriting a task body is not
   recoverable.
6. **`APPROVED by owner (<date>)` is yours to write, and only with explicit approval.**
7. **Never `--no-verify`.** Hooks are the gate.
8. **Report what happened, not what you wanted.** Read the diff and the actual command output
   before calling anything done.
9. **Do not repeat conventions.** `AGENTS.md`, `KANBAN.md` and Engram are the source.
10. **Never block a turn on a seat.** No `--wait` while coordinating: one `process` watcher per
    seat, then end the turn. Several seats in parallel make `--wait` lose the ones that delivered
    while you waited for the slowest.
11. **Close what you have read.** That seat's tab (`orca terminal close --terminal <handle> --tab`)
    and its finished `process` (`process clear`). A leftover tab is indistinguishable later, and a
    watcher left alive on a seat you already read wakes you for nothing.

## Orca state

Keep the **lane's** workspace card honest — it is how the owner sees this slice in Orca without
asking, and it is the card of the slice's own workspace (`name:<workspace>`), not the primary
checkout's:

```bash
orca worktree set --worktree name:<workspace> --comment "plan approved; implementer running" --json
orca worktree set --worktree name:<workspace> --workspace-status in-review --json
```

## Memory (Engram)

Engram is installed as the Pi-native package (`gentle-engram`), not as an MCP server, so its `mem_*`
tools are yours directly — no `tool_search` hop. Call `mem_current_project` before your first write:
it reports the detected project and how it was detected. Then pass `project: "photo-showcase"`
explicitly when you persist a plan, a verdict or a discovery.

The seats run with `ENGRAM_STARTUP_POLICY=disabled` and with MCP scoped to `mcp__codegraph__*`, so
anything worth keeping must be persisted by you. Their graph access is the one MCP surface they get —
it is read-only, and the writers (`figma`) stay out of it.
