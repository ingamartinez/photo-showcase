# Orca lane (pi seats)

This repository runs two agent lanes over the same board:

- **Claude Code** — `.claude/agents/photo-implementer | photo-reviewer | photo-shipper`, driven
  by `KANBAN.md`. Unchanged.
- **Orca** — the **pi harness** keeps the coordination thread and the board; **Orca** supplies the
  terminals, the worktree, and the workspace card. Five disposable **pi seats** do the work. This
  replaced the herdr + OpenCode lane on 2026-10-18.

Both lanes follow the same board, task bodies and acceptance criteria.

## Starting a slice

**Open pi in the primary checkout** (`/Users/alejo/projects/photo-showcase`) and run:

```text
/skill:photo-orchestrator 42
```

The skill (`.pi/skills/photo-orchestrator/SKILL.md`) is the coordinator contract: it reads the
task and its epic, claims it, **opens that slice's own workspace** (`new-lane.sh`), and delegates
every step to a seat. It is discovered automatically when the task calls for orchestration; the
explicit command is there when you want it forced.

The orchestrator never writes code, never lets a seat work in the primary checkout, and is the only
actor that moves board columns. Several slices can run at once: each gets its own workspace, branch,
tabs and watcher names.

| Step           | Seat                   | Provider / model                | Thinking | Tools                          |
| -------------- | ---------------------- | ------------------------------- | -------- | ------------------------------ |
| Map the slice  | `photo-explore-seat`   | `deepseek/deepseek-flash`       | low      | `read,bash` + codegraph        |
| Decide the how | `photo-plan-seat`      | `claude-bridge/claude-opus-5-5` | high     | `read,bash` + codegraph        |
| Implement      | `photo-implement-seat` | `deepseek/deepseek-flash`       | high     | `read,bash,edit,write` + graph |
| Review         | `photo-review-seat`    | `openai/gpt-6.1-sol`            | high     | `read,bash` + codegraph        |
| Ship           | `photo-ship-seat`      | `deepseek/deepseek-flash`       | low      | `read,bash` + codegraph        |

Every seat also gets `mcp__codegraph__*` and nothing else from MCP (see "MCP servers and memory").

Overrides without editing the script: `SEAT_PROVIDER`, `SEAT_MODEL`, `SEAT_THINKING`,
`SEAT_THINKING_<SEAT>` (one seat only — the global, exported for a deepseek seat, would also change
plan's and review's thinking), `SEAT_TIMEOUT_MS`.

**The deepseek seats run the official API (`provider: deepseek`, model `deepseek-flash`), not
`llm-gateway`.** Their predecessor here was `llm-gateway/deepseek-v4.1-flash-1017`; the gateway id is
retired in this lane, adopted from SYC on 2026-10-20.

**That model maps only `low`, `high` and `max`.** `medium` does not exist
(`thinkingLevelMap.medium = null`) and neither does `minimal`. A deepseek seat launched with `medium`
dies after 3-4 tool calls with `status=empty` and `output-bytes=0`, leaving its tab open — it reads
like a timeout and is not one. Explore and ship run `low`; implement runs `high`, because the seat
that writes code is the most expensive one to under-think.

Plan and review on **different** model lines is deliberate: the reviewer is never the implementer,
and no longer shares a model with whoever decided the how.

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
scripts/photo/seats/start-seat.sh plan --id 42 \
  --prompt "Task 42, epic 3, explore digest /tmp/photo-explore.abc123.
Decide the technical path. Read your contract first."
```

The launcher prints `key=value` lines and nothing else:

```
seat=plan
agent=photo-plan-seat
terminal=term_<uuid>          # handle for orca terminal wait|read|send|close
tab=<tabId>
title=photo-plan-42           # joins the tab, the watcher and the `process` by name
model=claude-bridge/claude-opus-5-5
thinking=high
tools=read,bash,mcp__codegraph__*
contract=/abs/path/scripts/photo/seats/plan.md
output=/var/folders/…/photo-plan.XXXXXX
status=ok|empty|timeout       # only with --wait
output-bytes=<n>              # only with --wait
cleanup=tab-closed|left-open|close-failed   # only with --wait
```

What it does:

1. refuses to run outside an Orca-managed worktree (`orca worktree current`) or without a brief,
2. checks the provider exists in `pi --list-models`,
3. mints the delivery path with `mktemp` and appends `Output path: <path>` to the brief,
4. `orca terminal create --worktree <selector> --title photo-<seat>-<id> --command "pi …"`,
   where the selector is the slice's lane (`name:<workspace>`), never the primary checkout,
5. writes the same `key=value` block to `<output>.handoff` **before** any wait, so an interrupted
   run is still attributable (`seat-status.sh` reconciles against those files),
6. with `--wait`, polls the **output file** until it appears, then waits for the TUI to settle, and
7. closes the tab it opened, but only when the seat delivered (`--keep-open` opts out).

The tab title is `photo-<seat>-<id>`, or `photo-<seat>-<id>-r<N>` for a retry of the same seat
(`--attempt N`) — never `-final`, `-v2` or `-b`. **The name is the join key**: it is what the watcher
process is called, and the only handle that survives, because pi's titlebar extension rewrites the
tab title to `π - photo-showcase` once it boots.

Step 7 is not tidiness. A finished seat's terminal has nothing left in it — the file is the handoff —
and a leftover tab cannot even be recognised later, for the reason above. A failed seat keeps its tab
on purpose: that is the one worth reading with `orca terminal read --terminal <handle> --screen`
before closing it. **Without `--wait` nobody closes the tab for you.** Close it once you have read
the delivery (`orca terminal close --terminal <handle> --tab`, or
`scripts/photo/seats/seat-status.sh --close-settled`).

The pi command line is:

```
ENGRAM_STARTUP_POLICY=disabled pi --provider <p> --model <m> --thinking <t> \
   --tools <set>,'mcp__codegraph__*' --approve --no-session \
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

## Waiting without blocking: the seat tells you

`--wait` blocks the coordinating turn until **that** seat delivers, so with seats in parallel the
others deliver unseen. That is measured, not theoretical: in the sibling SYC lane on 2026-10-20 two
reviews ran, the first delivered, and the coordinator was still blocking on the second while the PR
sat open. The protocol is now:

1. **Launch without `--wait`.** It returns in seconds with `terminal=` and `output=`.
2. **Start ONE `process` watcher per seat** — never a combined one — and end the turn:

   ```jsonc
   {
     "action": "start",
     "name": "seat-implement-42",
     "command": "bash scripts/photo/seats/watch-seat.sh implement-42 <output> 2400",
     "notify": {
       "logMatches": [
         { "pattern": "DELIVERED implement-42", "on": "turn" },
         { "pattern": "TIMEOUT", "on": "turn" },
       ],
     },
   }
   ```

   `watch-seat.sh <name> <delivery-path> <seconds>` polls `wc -c` every ~8 s and prints one line:
   `DELIVERED <name> bytes=<n>`, `TIMEOUT <name> after <n>s`, or `MISSING <name> <path>`. The
   extension wakes the coordinator on the match; nothing polls from the coordinator's side.

3. Read the file, act, **close that tab** (`orca terminal close --terminal <handle> --tab`), and
   `process clear` the finished watcher.

Ceilings are per seat because one combined watcher would have to use the slowest one for everybody:
ship 20 min, implement 40, review 30. A combined ALL-DELIVERED watcher is the `--wait` defect at a
smaller scale. Naming the seat in the pattern is what stops one seat's event waking you for another.
`MISSING` (exit 3) is a typo in the launcher's `output=`, not a slow seat.

The reconcile safety net is still `scripts/photo/seats/seat-status.sh`: it derives every seat's state
from the `*.handoff` files, so a turn that starts after an aborted wait loses nothing.

## Read-only is contractual, not enforced

The `explore`, `plan`, `review` and `ship` seats get `read,bash`. `bash` can still write files with
redirection, `sed -i` or `git commit`, so their read-only surface is the contract plus the owner's
review — not a sandbox. This is the same trust model the lane had before Orca, accepted
deliberately on 2026-10-17. Only the `implement` seat is allowed to change the tree, and the
launcher gives it `read,bash,edit,write` explicitly.

## MCP servers and memory

Memory and MCP are two different mechanisms here, and confusing them is a real mistake — this lane
made it once, by registering Engram as an MCP server.

**Memory is a Pi package, not MCP.** `engram setup pi` installed `gentle-engram@0.4.2`, recorded in
`~/.pi/agent/settings.json` as a package (`pi list` shows it). It exposes the `mem_*` tools natively
and talks to `engram serve` over HTTP, binding writes to pi's real session id. Its `0 files` output
is expected: it adds a package entry, it does not copy files.

Engram must **not** appear in `mcp.json`. Upstream's Pi guide says native-only writes are not
guaranteed while an `mcpServers.engram` entry exists, so the one this lane briefly had was removed.
`mem_current_project` is the cheap proof either way — it reports the detected project and its
source (`photo-showcase` via `git_remote` here).

**MCP servers** live in `~/.pi/agent/mcp.json`. The orchestrator's session keeps all three; a seat's
`--tools` scoping narrows them to `codegraph` (next paragraph):

| Server      | Exposure | What it gives you                                      |
| ----------- | -------- | ------------------------------------------------------ |
| `codegraph` | direct   | `codegraph_explore` over this repository               |
| `context7`  | direct   | current library documentation                          |
| `figma`     | direct   | design context; needs the Figma desktop app on `:3845` |

**The seats get `codegraph` and nothing else.** The launcher passes
`--tools <set>,'mcp__codegraph__*'`: an entry beginning with `mcp__` makes pi filter the servers, so a
seat sees the code graph over this repository and not `figma` — which ships tools that write
(`add_code_connect_map`, `send_code_connect_mappings`) — nor `context7`. A read-only seat with an
unaccounted second surface is not read-only. Adopted from SYC on 2026-10-20; before that the lane
passed `--no-mcp` and the exploring seats grep'd instead of querying the graph.

Memory stays off for the same reason, via `ENGRAM_STARTUP_POLICY=disabled`: a seat that could save
memory would be a second writer to a store the orchestrator owns. Escape hatches for a seat you are
watching yourself: `SEAT_MCP=1` (all servers, no codegraph scoping) and `SEAT_MEMORY=1`.

So memory belongs to the orchestrator: a plan, a verdict or a discovery worth keeping is persisted
by it, with `project: "photo-showcase"` passed explicitly.

**The seats' file is the pipe, not the archive.** Seats hand work back through the `mktemp` path the
launcher mints — it exists before the seat starts (so `status=empty` is a real failure), every attempt
gets its own path (so a retry cannot overwrite the attempt you are diagnosing), and it needs no
server. What changes is durability: `$TMPDIR` is cleared on reboot, so anything that has to outlive
the slice — the approved plan, the review verdict, the ship report with its unverifiable criteria —
is upserted into Engram by the orchestrator under `photo-showcase/slice-<id>/plan|review|ship`.
Moving the handoff itself into Engram was considered and rejected: the readiness signal would become
a search, retries would collide on the topic key, and a seat would need write access to the store the
orchestrator owns.

`figma` warns at startup when the desktop app is not running. That is noise, not a failure: the
other two still connect.

### Web search needs its own model

`pi-web-search` searches with the **conversation** model by default, and the conversation model here
(`llm-gateway/deepseek-v4.1-flash-1017`) has no provider-native search — so `web_search` fails
outright rather than falling back. It is fixed by a dedicated search model in
`~/.pi/agent/web-search.json`:

```json
{ "provider": "openai", "model": "gpt-6-luna" }
```

Verified on 2026-10-19 by running real searches: `openai/gpt-6-luna` (what is configured now),
`openai/gpt-6.1-sol` and `deepseek/deepseek-flash` all answer with sources. All three live on
credentials the machine already has — `openai` draws on the ChatGPT subscription, `deepseek` on its
own API key. Delete the file and search breaks again; the extension reads it per call, so no restart
is needed to switch.

## Permissions

`pi-permission-system` (a pi package) enforces `.pi/agent/pi-permissions.jsonc` for every pi session
in this repository — orchestrator and seats alike, since a seat starts in the same worktree.

**Posture: allow by default.** OpenCode's lane was permissive and this keeps that shape; what it
adds is a hard floor under the rules this repository already stated in prose:

| Denied                                                                   | Why                                                                  |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| anything containing `--no-verify`                                        | `AGENTS.md`: hooks are the gate                                      |
| `kanban-md edit … --body`                                                | the board is appended, never rewritten (`--append-body` still works) |
| `git push --force`                                                       | branches rebase onto `main`, they are not forced over it             |
| `sudo`, `rm -rf --no-preserve-root`, literal `rm -rf /` and `rm -rf ~/*` | unrecoverable outside the repo                                       |

**Deny, never `ask`.** Nobody is watching a seat's terminal: an `ask` there is a hung seat and a
burned slice, not a safety net. The policy therefore has no `ask` rules at all, and the two rules that
could have produced a false positive are deliberately narrow (`rm -rf /tmp/…` stays allowed — the
literal `rm -rf /` rule is an exact match rather than a wildcard).

**The rules match substrings over the whole command line, so they also block WRITING about them.**
A seat that writes its report with bash redirection (`cat > "$path" <<'EOF' … EOF`) puts the file's
content inside the command, and if the report quotes a denied command the write is denied — the seat
then stops with "the output path does not exist yet" and asks. Measured 2026-10-20: the plan seat
could not write a plan that quoted the production query until the command was described in words.
That is the policy working as written, not a bug to route around: the seat's contract says to
describe such a command instead of pasting it, and the orchestrator answers the question rather than
widening the rule.

Verified by running the commands rather than reading the config: `git commit --no-verify -m probe`
is blocked with the matched pattern (`*--no-verify*`) both in a `pi -p` session and inside a real
review seat (`verdict=BLOCKED`), while `kanban-md edit … --append-body` and `rm -rf /tmp/junk` still
pass.

**What it does not enforce is per-role policy.** OpenCode's coordinator denied _itself_ `edit`; here
the policy is per-repository, so a project-wide edit deny would also disarm the implement seat. Role
discipline stays in the skill and the contracts. If role-level enforcement is ever wanted, this
extension supports per-agent frontmatter at `.pi/agent/agents/<name>.md`, activated by an
`<active_agent name="…">` tag in the system prompt — the seats could carry that tag in their
contracts, while the orchestrator would need a launch wrapper, because pi has no agent picker at
startup.

**The SYC merge policy is deliberately NOT ported.** That workspace makes `gh pr merge` an `ask` — the
owner clicks, and a seat (no UI) blocks. Here the **ship seat merges and watches the deploy**
(`scripts/photo/seats/ship.md`), so an `ask` rule would turn every ship run into a hung seat. The
gate in this lane is the review verdict plus a green CI, not a click. If this repository ever moves
to "the pipeline ends at an open PR", the rule to copy is `*gh pr merge*: "ask"` plus
`*gh api*merge*: "deny"` — in that order, and the ship contract changes with it.

## Workspaces: one per slice, the coordinator in the primary checkout

**The coordinator runs pi in the primary checkout** (`/Users/alejo/projects/photo-showcase`) and
**opens a workspace per slice**. Seats never work in the primary checkout — that is the check
`start-seat.sh` enforces, and not a formality: the primary tree is where the owner's own checkout and
the coordinator's board live, and two seats editing it is the same tree twice.

```bash
scripts/photo/seats/new-lane.sh 276 --slug galerias-paginacion
# lane=/Users/alejo/orca/workspaces/photo-showcase/276-galerias-paginacion
# worktree=name:276-galerias-paginacion
# branch=ingamartinez/276-galerias-paginacion   (Orca derives it from the name, off main)
# setup=installed
```

Then every seat for that slice is launched with `--worktree name:276-galerias-paginacion --id 276`
(or simply from inside the lane, where the default `active` resolves to it). Two slices in parallel
are then two checkouts, two branches and two sets of tabs — and the `--id` in each tab/watcher name
keeps them apart.

`new-lane.sh` passes `--no-parent` on purpose: a slice is a **peer** of the primary checkout, not a
child of it. Without that flag Orca records real lineage from the caller and the workspace shows up
collapsed under `main` as “1 child”, which reads as a sub-folder rather than as its own workspace.
`orca worktree set --worktree name:<workspace> --no-parent` detaches one that was created as a child
(this happened to the first lane, 2026-10-20).

`new-lane.sh` is idempotent: run it again and it reuses the workspace and only fills in whatever
setup is missing. It skips the two things a fresh checkout lacks (both get forgotten), plus a third
this repository taught us:

1. **Its own `.codegraph/`** — gitignored, so a new lane has no graph, and a seat whose cwd has no
   graph greps instead of querying it, silently.
2. **`bun install`** — node_modules AND `.husky/_`; without the install the lane has no pre-commit
   hook to speak of.
3. **Restoring the tracked `.husky/_/pre-commit`** — the install overwrites it with husky's
   generated delegator every time (#123). The hook still runs the same `bunx lint-staged`, but the
   file is left modified, one ordinary `git add -A` away from committing the regression CI checks
   for. The script puts the tracked copy back, so a lane starts clean.

`.pi/` needs nothing: it is tracked here, so the checkout carries the policy and the skill. This
lane does **not** need the `link-pi-config.sh` symlinking the SYC umbrella uses, because that
workspace keeps `.pi/` out of git.

Read "Running lanes in parallel" in `KANBAN.md` before opening a second lane, and remove the
workspace when the slice merges (`orca worktree remove`, tab closed, `process` cleared) instead of
half-cleaning it.

`orca worktree create --agent pi --prompt "…"` starts an agent the way Orca's new-agent tab does
(chat or terminal, per your Chat UI setting) — useful for ad-hoc work, but **not** for seats: it
cannot pass the contract, the model, the thinking level or the tool set. Seats go through the
launcher.

## Board and card stay in sync

Board columns are kanban-md's; the Orca card is the owner's glanceable view. The orchestrator keeps
both current:

```bash
kanban-md move 42 in-progress --claim agent-1
orca worktree set --worktree name:<workspace> --comment "plan approved; implementer running" --json
orca worktree set --worktree name:<workspace> --workspace-status in-review --json
```

## Differences from the Claude Code lane

These are deliberate, not drift to "fix":

1. **The Orca lane has a plan seat; the Claude lane does not.** The plan seat decides the
   technical path and its output must be approved by the owner before implementation. In the
   Claude lane the implementer reads the task and decides the how itself.
2. **Every working role is a separate pi process in its own terminal**, not a subagent.
   `.claude/agents/photo-reviewer.md` remains the reviewer for the Claude lane.
3. **Plan and review run different models.** The reviewer is never the implementer, and since
   2026-10-20 it no longer shares a model line with whoever decided the how: plan is Opus through
   `claude-bridge`, review is `gpt-6.1-sol` through `openai`. If both show the same model, somebody
   reverted the seat map in `start-seat.sh` by accident.
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
scripts/photo/seats/new-lane.sh          one workspace per slice: checkout + branch + index + install
scripts/photo/seats/watch-seat.sh        one delivery watcher per seat, for the `process` tool
scripts/photo/seats/seat-status.sh       reconcile: what is in flight, what delivered unread
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
