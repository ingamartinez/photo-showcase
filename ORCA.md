# Orca lane (pi seats)

This repository runs two agent lanes over the same board:

- **Claude Code** — `.claude/agents/photo-implementer | photo-reviewer | photo-shipper`, driven
  by `KANBAN.md`. Unchanged.
- **Orca** — the **pi harness** keeps the coordination thread and the board; **Orca** supplies the
  terminals, the worktree, and the workspace card. Five disposable **pi seats** do the work. This
  replaced the herdr + OpenCode lane on 2026-10-18.

Both lanes follow the same board, task bodies and acceptance criteria.

## Starting a slice

Open the repository as an Orca worktree, start pi there, and run:

```text
/skill:photo-orchestrator 42
```

The skill (`.pi/skills/photo-orchestrator/SKILL.md`) is the coordinator contract: it reads the
task and its epic, claims it, and delegates every step to a seat. It is discovered automatically
when the task calls for orchestration; the explicit command is there when you want it forced.

The orchestrator never writes code, and it is the only actor that moves board columns.

| Step           | Seat                   | Provider / model                       | Thinking | Tools                  |
| -------------- | ---------------------- | -------------------------------------- | -------- | ---------------------- |
| Map the slice  | `photo-explore-seat`   | `llm-gateway/deepseek-v4.1-flash-1017` | medium   | `read,bash`            |
| Decide the how | `photo-plan-seat`      | `claude-bridge/claude-opus-5-5`        | high     | `read,bash`            |
| Implement      | `photo-implement-seat` | `llm-gateway/deepseek-v4.1-flash-1017` | medium   | `read,bash,edit,write` |
| Review         | `photo-review-seat`    | `openai/gpt-6.1-sol`                   | high     | `read,bash`            |
| Ship           | `photo-ship-seat`      | `llm-gateway/deepseek-v4.1-flash-1017` | medium   | `read,bash`            |

Overrides without editing the script: `SEAT_PROVIDER`, `SEAT_MODEL`, `SEAT_THINKING`,
`SEAT_TIMEOUT_MS`.

## Why the seats are pi and not subagents

`claude-bridge` is a **pi extension** (`pi-claude-bridge`), not a model gateway. It drives Claude
Code through the Agent SDK, so no other harness can use it as a provider. Rather than split the
working roles across two harnesses, the whole working layer runs in pi and the coordinating thread
is pi too.

Consequences worth knowing:

- The `claude-bridge` seat draws on the **Claude subscription quota**, not per-token billing. Opus
  runs are not unlimited; the plan seat is the only one that uses it.
- The `openai/gpt-6.1-sol` review seat is served by the **ChatGPT account** credential, which is
  entitlement-limited: it is one of the models that account actually serves, while most others are
  rejected with `400 "… not supported when using Codex with a ChatGPT account"`. Do not swap it for
  another `openai/*` model without probing it first.
- The `llm-gateway` seats are ordinary API models with per-token billing. Its **premium tier**
  (`gpt-5.4`, `gpt-5.5`, `claude-opus-5-5` through the gateway) returns `402 weekly allowance` on the
  lite plan once the allowance is spent — which is why plan runs on `claude-bridge` and not on
  `llm-gateway/claude-opus-5-5`.
- `pi auth check` reports `invalid`/`invalid_state` for `claude-bridge` even when it works, because
  it only understands built-in providers. The launcher therefore requires the provider to exist in
  pi's catalog and treats a non-ready auth state as a warning.

## Driving a seat

```bash
scripts/photo/seats/start-seat.sh plan --wait --timeout-ms 900000 \
  --prompt "Task 42, epic 3, explore digest /tmp/photo-explore.abc123.
Decide the technical path. Read your contract first."
```

The launcher prints `key=value` lines and nothing else:

```
seat=plan
agent=photo-plan-seat
terminal=term_<uuid>          # handle for orca terminal wait|read|send|close
tab=<tabId>
model=claude-bridge/claude-opus-5-5
thinking=high
tools=read,bash
contract=/abs/path/scripts/photo/seats/plan.md
output=/var/folders/…/photo-plan.XXXXXX
status=ok|empty|timeout       # only with --wait
output-bytes=<n>              # only with --wait
```

What it does:

1. refuses to run outside an Orca-managed worktree (`orca worktree current`) or without a brief,
2. checks the provider exists in `pi --list-models`,
3. mints the delivery path with `mktemp` and appends `Output path: <path>` to the brief,
4. `orca terminal create --worktree active --title photo-<seat>-seat --command "pi …"`, and
5. with `--wait`, polls the **output file** until it appears, then waits for the TUI to settle.

The pi command line is:

```
pi --provider <p> --model <m> --thinking <t> --tools <set> --approve --no-session \
   --append-system-prompt scripts/photo/seats/<seat>.md -- "<brief>"
```

`--append-system-prompt <path>` reads the contract file's contents, so the seat starts with its
limits already in the system prompt. A contract change means a **new seat**: it is baked into the
conversation. `--dry-run` prints the command without opening a terminal.

## The output path is the only delivery channel

pi runs fullscreen, so there is no scrollback to read and `orca terminal read` returns stacked
repaint fragments; `--screen` gives the current frame only. The launcher pre-creates the file, the
prompt names it, and the contract requires the seat to write there and reply only `done`.

Therefore **completion is decided by the file, not by the terminal.** `tui-idle` fires while pi is
still booting and before the first token, so waiting on it first reports a running seat as
finished — measured on the first probe run of this lane. The launcher polls the file first and only
then lets the TUI settle. `status=empty` (finished, wrote nothing) is a failure; retry once with a
fresh seat, then stop.

Read-only seats (`read,bash`) write their file **with bash** (`cat > "$path" <<'EOF' … EOF`). They
have no `write` tool on purpose — a seat that has one is a seat that "just fixes" the thing it was
asked to report.

## Read-only is contractual, not enforced

The `explore`, `plan`, `review` and `ship` seats get `read,bash`. `bash` can still write files with
redirection, `sed -i` or `git commit`, so their read-only surface is the contract plus the owner's
review — not a sandbox. This is the same trust model the lane had before Orca, accepted
deliberately on 2026-10-17. Only the `implement` seat is allowed to change the tree, and the
launcher gives it `read,bash,edit,write` explicitly.

## Worktrees

Seats run **in the worktree the orchestrator is in** (`--worktree active`). There is no per-lane
worktree by default: the implementer branches in the current checkout and never commits to `main`.

For genuinely parallel slices, open one Orca worktree per lane and point the launcher at it:

```bash
orca worktree create --name slice-90 --parent-worktree active --json
scripts/photo/seats/start-seat.sh implement --worktree name:slice-90 --wait --prompt "…"
```

Read "Running lanes in parallel" in `KANBAN.md` first, and remember that a fresh worktree has no
`.husky/_` until something runs `bun install` there.

`orca worktree create --agent pi --prompt "…"` starts an agent the way Orca's new-agent tab does
(chat or terminal, per your Chat UI setting) — useful for ad-hoc work, but **not** for seats: it
cannot pass the contract, the model, the thinking level or the tool set. Seats go through the
launcher.

## Board and card stay in sync

Board columns are kanban-md's; the Orca card is the owner's glanceable view. The orchestrator keeps
both current:

```bash
kanban-md move 42 in-progress --claim agent-1
orca worktree set --worktree active --comment "plan approved; implementer running" --json
orca worktree set --worktree active --workspace-status in-review --json
```

## Differences from the Claude Code lane

These are deliberate, not drift to "fix":

1. **The Orca lane has a plan seat; the Claude lane does not.** The plan seat decides the
   technical path and its output must be approved by the owner before implementation. In the
   Claude lane the implementer reads the task and decides the how itself.
2. **Every working role is a separate pi process in its own terminal**, not a subagent.
   `.claude/agents/photo-reviewer.md` remains the reviewer for the Claude lane.
3. **Plan and review share the same model.** The reviewer is still never the implementer, but it
   runs the same Opus as the planner. Accepted tradeoff, unchanged from before.
4. **Seats are disposable** (`--no-session`). A correction starts a new seat with the findings
   rather than resuming a conversation.
5. **No per-lane git worktree by default.** `KANBAN.md` describes how to run lanes when you do
   open one.

## Files

```
.pi/skills/photo-orchestrator/SKILL.md   coordinator skill (no code)
scripts/photo/seats/explore.md           map + digest
scripts/photo/seats/plan.md              technical decision
scripts/photo/seats/implement.md         code + tests + commits
scripts/photo/seats/review.md            verdict
scripts/photo/seats/ship.md              PR, CI, merge, production verification
scripts/photo/seats/start-seat.sh        launcher for all five seats (orca terminal create)
```

`.claude/agents/` is untouched: the Claude Code lane keeps working exactly as before.

## What this replaced

The 2026-10-17 lane was OpenCode as the coordinating primary agent plus herdr-managed panes for
the seats. Both are gone from this repository:

- `.opencode/agents/photo-orchestrator.md` → `.pi/skills/photo-orchestrator/SKILL.md`
- `herdr tab create` / `herdr agent start` / `herdr agent prompt` / `herdr agent wait` /
  `herdr pane run` → `orca terminal create --command`, `orca terminal wait`, and the file poll
- `HERDR_ENV` refusal → `orca worktree current` refusal

The herdr extension is still installed in the user's global pi config, so herdr keeps working in
other projects; this repo simply no longer depends on it. `git log -- OPENCODE.md
scripts/photo/seats/start-seat.sh` has the previous version if it is ever needed.
