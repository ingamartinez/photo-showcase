# OpenCode lane

This repository runs two agent lanes over the same board:

- **Claude Code** — `.claude/agents/photo-implementer | photo-reviewer | photo-shipper`, driven
  by `KANBAN.md`. Unchanged.
- **OpenCode** — one primary orchestrator plus five **pi seats**, added 2026-10-17. OpenCode
  keeps the thread and the board; every working role runs in pi through herdr.

Both lanes follow the same board, task bodies and acceptance criteria.

## Starting a slice in OpenCode

Switch the primary agent to `photo-orchestrator` (agent picker / `Tab` in the TUI). It is a
primary agent, so it is selectable like any other; it is not forced as the repo default.

The orchestrator never writes code. It delegates every step:

| Step           | Seat                   | Provider / model                  | Thinking | Tools                  |
| -------------- | ---------------------- | --------------------------------- | -------- | ---------------------- |
| Map the slice  | `photo-explore-seat`   | `llm-gateway/gpt-6-luna`          | medium   | `read,bash`            |
| Decide the how | `photo-plan-seat`      | `claude-bridge/claude-opus-5-5`   | high     | `read,bash`            |
| Implement      | `photo-implement-seat` | `llm-gateway/deepseek-v4.1-flash` | medium   | `read,bash,edit,write` |
| Review         | `photo-review-seat`    | `claude-bridge/claude-opus-5-5`   | high     | `read,bash`            |
| Ship           | `photo-ship-seat`      | `llm-gateway/deepseek-v4.1-flash` | medium   | `read,bash`            |

Overrides without editing the script: `SEAT_PROVIDER`, `SEAT_MODEL`, `SEAT_THINKING`.

## Why the seats are pi and not OpenCode subagents

`claude-bridge` is a **pi extension** (`pi-claude-bridge`), not a model gateway. It drives Claude
Code through the Agent SDK, so OpenCode cannot use it as a provider. Rather than split the
working roles across two harnesses, the whole working layer runs in pi and OpenCode keeps only
the coordination thread.

Consequences worth knowing:

- The `claude-bridge` seats draw on the **Claude subscription quota**, not per-token billing.
  Opus runs are not unlimited; the plan and review seats are the two that use them.
- The `llm-gateway` seats are ordinary API models with per-token billing.
- `pi auth check` reports `invalid_state` for `claude-bridge` even when it works, because it only
  understands built-in providers. The launcher therefore requires the provider to exist in pi's
  catalog and treats a non-ready auth state as a warning.
- OpenCode's native `subagent` tool is denied for the orchestrator. Delegation is `herdr agent
prompt`, not a subagent call.

## Driving a seat

```bash
out="$(mktemp -t photo-plan)"              # pre-assigned output path
pane=$(scripts/photo/seats/start-seat.sh plan | sed -n 's/^pane=//p')
herdr agent prompt photo-plan-seat "Task <id>, epic <pid>, digest <path>.
Output path: $out" --wait --timeout 600000
herdr agent wait photo-plan-seat --timeout 600000
herdr tab close "$pane"
```

The launcher:

1. checks the provider exists in `pi --list-models`,
2. creates a new tab (never `pane split --current`),
3. starts `pi --provider <p> --model <m> --thinking <t> --tools <set> --approve --no-session
--append-system-prompt <contract>`,
4. prints the pane id, agent name, model and contract path.

`--append-system-prompt <path>` reads the contract file's contents, so the seat starts with its
limits already in the system prompt. A contract change means a **new seat**: it is baked into the
conversation.

**The output path is the only delivery channel.** pi runs fullscreen, so its transcript is not in
host scrollback and `herdr agent read` cannot recover it. The orchestrator creates the path with
`mktemp` before launching, passes it in the prompt, and reads the file once the seat finishes. The
contract requires the seat to write there and reply only `done`. A finished seat with no file is a
failure, not an empty success.

## Read-only is contractual, not enforced

The `explore`, `plan`, `review` and `ship` seats get `read,bash`. `bash` can still write files with
redirection, `sed -i` or `git commit`, so their read-only surface is the contract plus the owner's
review — not a sandbox. This is the same trust model `syc` uses for its seats, accepted
deliberately on 2026-10-17. Only the `implement` seat is allowed to change the tree, and the
launcher gives it `read,bash,edit,write` explicitly.

## Differences from the Claude Code lane

These are deliberate, not drift to "fix":

1. **The OpenCode lane has a plan seat; the Claude lane does not.** The plan seat decides the
   technical path and its output must be approved by the owner before implementation. In the
   Claude lane the implementer reads the task and decides the how itself.
2. **Every working role is a separate pi process**, not a subagent. `.claude/agents/
photo-reviewer.md` remains the reviewer for the Claude lane.
3. **Plan and review share the same model.** The reviewer is still never the implementer, but it
   runs the same Opus as the planner. Accepted tradeoff, same as in `syc`.
4. **Seats are disposable** (`--no-session`). A correction starts a new seat with the findings
   rather than resuming a conversation.
5. **No per-lane git worktree.** The implementer branches in the current checkout and never
   commits to `main`. `syc` isolates each lane in its own worktree; this repo keeps its existing
   convention until that is explicitly requested.

## Files

```
.opencode/agents/photo-orchestrator.md   primary coordinator (no code)
scripts/photo/seats/explore.md           map + digest
scripts/photo/seats/plan.md              technical decision
scripts/photo/seats/implement.md         code + tests + commits
scripts/photo/seats/review.md            verdict
scripts/photo/seats/ship.md              PR, CI, merge, production verification
scripts/photo/seats/start-seat.sh        launcher for all five seats
```

`.claude/agents/` is untouched: the Claude Code lane keeps working exactly as before.
