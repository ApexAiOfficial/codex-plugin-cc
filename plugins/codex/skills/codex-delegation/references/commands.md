# Ticket command reference

All commands: `node "$CODEX_COMPANION" <command> …` (or `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs"`). Every command accepts `--cwd <path>` and `--json`. State is per repository and is stored under the plugin data directory.

## delegate

Create a ticket and start its first turn in a detached, durable worker. Returns immediately.

| Flag | Meaning |
| --- | --- |
| `--ticket <name>` | Stable handle (lowercase, digits, `.`, `_`, `-`; ≤48). Derived from the brief when omitted. |
| `--role implement\|investigate\|review` | `implement` writes code (default); the others are read-only and report findings. |
| `--isolation shared\|worktree` | `shared` edits this checkout; `worktree` uses a private worktree created from the current state. |
| `--owns <path\|glob>` | Repeatable or comma-separated. Plain paths own their subtree; globs use `*`, `**`, `?`. |
| `--interface <contract>` | Repeatable. Logical contracts the ticket owns. |
| `--accept <command>` | Repeatable. Acceptance checks that `verify` runs outside the sandbox. |
| `--acceptance-notes <text>` | Extra definition of done. |
| `--network` | Grant network access to the sandbox (explicit and recorded). |
| `--read-only` | Force a read-only implement ticket (rare). |
| `--model <m>`, `--effort <e>` | Leave unset by default; the user's Codex config chooses. Both are checked against what Codex offers (`preflight` lists the models and their efforts), and an invalid choice is rejected before any turn runs. Only raise the effort for a hard or high-risk package, and name a model only when the user asks or the task clearly needs another tier. `ultra` makes Codex delegate to its own subagents and multiplies usage, so avoid it unless asked. |
| `--title <t>` | Short title; defaults to the first line of the brief. |
| `--brief-file <path>` / text / stdin | The brief. |

Refuses when the concurrent-ticket limit is reached. Warns about declared ownership overlap with open write tickets.

## wait [ticket|job]…

Block until a turn finishes, then print the completion card and mark it as surfaced. With no argument it waits for whichever running ticket finishes first. `--timeout-ms` (default: none) and `--poll-interval-ms`. Designed for `Bash(run_in_background: true)`. Killing the waiter never affects the ticket.

## steer <ticket> <message>

Deliver a message into the running turn via `turn/steer`. It waits up to 20s for the worker's acknowledgement: `delivered`, `queued` (held until the turn is active), `undelivered` (the turn already ended; use followup), or `failed`.

## followup <ticket> [feedback]

Start the next turn on the same Codex thread. The failing output of the latest `verify` for the last turn is attached unless `--no-verification`. `--model` and `--effort` override for this turn. Refuses while a turn is running (use steer) or after the ticket is closed.

## tickets [--all]

Ledger of open tickets (`--all` adds up to 30 closed ones): state, last outcome, kind, age, summary.

## show <ticket>

- default: completion card plus the full structured report (changes, verification, findings, blockers, risks, next steps), decisions, and verifications.
- running ticket: phase, elapsed time, heartbeat age, recent activity.
- `--turn <n>`: a specific turn.
- `--commands`: command trace (exit code, duration, command).
- `--command <n>`: full captured output of one command (up to 16 KB).
- `--prompt`: the exact prompt sent for the turn.

## verify <ticket>

Mechanical acceptance checks. It runs `--accept` commands (unless `--no-run`; `--timeout-ms` per command, default 20 min) in the ticket worktree before integration and in the checkout after. It flags non-`completed` outcomes, ownership violations across all turns, no attributable changes, writes by read-only tickets, and contradicted verification claims. Exit code 2 when problems are found. The result is recorded on the ticket and attached to the next followup.

## integrate <ticket>

Worktree tickets only. Per-file three-way merge (base = last integration point, ours = checkout, theirs = worktree) written to the working tree only; the index is untouched. Aborts with nothing written on any conflict unless `--allow-conflicts`, which writes conflict markers into text files. Notes when HEAD moved since the ticket started. Re-integrating after a followup applies only the new delta.

## close <ticket> --accepted|--rejected|--abandoned

Records a decision with `--reason`. Accepting a worktree ticket with un-integrated changes is refused unless `--force`. Accepting removes the worktree (`--keep-worktree` to retain it); rejecting or abandoning keeps it. `close <ticket> --purge` removes a retained worktree later.

## cancel <ticket|job>

Graceful: interrupt the live turn through the worker (partial evidence is recorded), then terminate the verified process tree only if it does not exit within about 10s.

## preflight

Probe the Codex sandbox with the same policy a ticket uses, via app-server `command/exec` (no model involved). Reports runnable tools, workdir and `.git` writability, network, the Docker daemon, and host-vs-sandbox differences. Flags: `--network`, `--read-only`, `--check <command>` (repeatable; runs inside the sandbox and reports exit code and output tail). The base probe is cached for 30 minutes and reused by ticket workers. It also lists the models Codex offers this account, their supported efforts, and the model tickets use by default (from the user's Codex config).

## watch

Long-running event stream used by the plugin monitor. It prints one line per finished ticket turn. It is not normally run by hand.

## Outcomes

| Outcome | Meaning | Usual next step |
| --- | --- | --- |
| `completed` | Codex reports the objective met and verified | `verify`, read the diff, integrate |
| `partial` | Meaningful required work remains | `followup` with direction, or re-scope |
| `blocked` | Needs something only the lead can provide | Resolve it, then `followup "Unblocked: …"` |
| `failed` | Codex's approach did not work | Read the findings; replan or reclaim |
| `unstructured` | No parseable report | `show` the raw final message |
| `quota` / `transient` | Usage limit or infrastructure error | `followup` later; the thread persists |
| `context-window` | The thread is too long | Close it and open a fresh, narrower ticket |
| `worker-lost` | The worker process died | `followup` continues the thread |
| `cancelled` | Stopped by cancel | `followup` or close |
