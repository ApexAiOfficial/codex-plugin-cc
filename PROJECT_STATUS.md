# Project status

Fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) that evolves the Claude Code ↔ Codex bridge into a workflow where Codex is a durable, parallel peer engineer and Claude is the lead: it decomposes the work, verifies from evidence, integrates, and accepts. Development happens on branch `orchestration`. The repository state is authoritative; this file summarizes it.

## Architecture

Upstream pieces, kept recognizable so upstream fixes can still be merged:

| Area | Files | Role |
| --- | --- | --- |
| Transport | `scripts/lib/app-server.mjs`, `app-server-broker.mjs`, `lib/broker-*.mjs` | JSON-RPC client for `codex app-server`; the per-session shared broker |
| Protocol use | `scripts/lib/codex.mjs` | thread/turn orchestration, turn capture, review, auth |
| CLI | `scripts/codex-companion.mjs` | Subcommand entry point |
| Commands, agent, skills | `commands/*.md`, `agents/codex-rescue.md`, `skills/codex-cli-runtime`, `codex-result-handling`, `gpt-5-4-prompting` | Stock `/codex:*` surface and the thin rescue forwarder |

Fork additions, each a separate module (paths under `plugins/codex/`):

| Module | Responsibility |
| --- | --- |
| `scripts/lib/locking.mjs` | Cross-process file lock (stale-holder recovery, re-entrant) and atomic write-and-rename |
| `scripts/lib/state.mjs` (rewritten internals) | Locked read-modify-write of the job index, job files, and tickets; corruption quarantine and rebuild; pruning that never drops active or open-ticket jobs |
| `scripts/lib/tracked-jobs.mjs` (extended) | Detached worker launch, pid + start-marker identity, heartbeats, reconciliation of dead workers (`worker-lost`) |
| `scripts/lib/tickets.mjs` | Durable ticket records (one ticket = one persistent Codex thread) |
| `scripts/lib/ticket-commands.mjs` | `delegate`, `followup`, `steer`, `wait`, `tickets`, `show`, `verify`, `integrate`, `close`, `preflight`, `watch`, the worker-side turn runner, graceful cancel, and hook helpers |
| `scripts/lib/work-package.mjs`, `prompts/work-*.md`, `schemas/work-report.schema.json` | Role-specific prompt contract, blocker protocol, structured final report, failure classification |
| `scripts/lib/evidence.mjs` | Working-tree snapshots via a temporary index, tree diffs, ownership globs, verification claim cross-checks |
| `scripts/lib/worktree.mjs` | Ticket worktrees from a snapshot of the lead's current state, per-file three-way integration, safe removal |
| `scripts/lib/capabilities.mjs` | Sandbox preflight through app-server `command/exec` under the exact ticket policy (no model) |
| `scripts/lib/control-channel.mjs` | Per-job inbox relayed by the worker into `turn/steer` / `turn/interrupt` |
| `skills/codex-delegation/` | Model-invoked skill: when to delegate and the full ticket loop (references hold the details) |
| `monitors/monitors.json` | Plugin monitor running `watch`; starts on first use of the delegation skill |
| `scripts/session-lifecycle-hook.mjs`, `stop-review-gate-hook.mjs` (extended) | Export `$CODEX_COMPANION`, inject the open-ticket ledger at SessionStart, once-per-turn Stop nudge for finished but unreviewed turns |

Per-repository state lives under `$CLAUDE_PLUGIN_DATA/state/<repo-slug>-<hash>/` (falling back to `$TMPDIR/codex-companion/`): `state.json`, `jobs/`, `tickets/`, `worktrees/`, `capabilities.json`, `state.lock`.

## Implemented

- Concurrency-safe, crash-safe state. In a reproduced race, 6 concurrent writers left 23 of an expected 50 indexed jobs, and 17 of those had their job files deleted by other writers. After the fix nothing is lost.
- Durable jobs: detached workers own a private app-server, and SessionEnd (which also fires on `/clear` and resume) no longer kills or deletes jobs.
- Liveness: identity-checked termination, heartbeats, and dead-worker reconciliation on every status/wait/ticket read.
- Tickets: named work packages with role (`implement`, `investigate`, `review`), isolation (`shared`, `worktree`), ownership globs, interface ownership, acceptance commands, and explicit network grant. Each ticket keeps one persistent Codex thread across turns, sessions, and compaction.
- Structured work reports with a blocker protocol, and outcome classes (`completed`, `partial`, `blocked`, `failed`, `unstructured`, `quota`, `transient`, `context-window`, `auth`, `worker-lost`, `cancelled`).
- Evidence the controller collects independently of Codex: before/after tree snapshots, attribution of changes, ownership violations, claimed-vs-observed verification, and a command trace with drill-down.
- `verify` runs acceptance commands outside the sandbox and records the result; `followup` attaches the failing output automatically.
- Worktree isolation: the base is a snapshot of the lead's dirty tree, dependency dirs are symlinked, integration is a per-file three-way merge that is atomic on conflict and never touches the index, and cleanup refuses paths outside the worktrees root and never follows symlinks.
- Scratch worktrees for investigate/review tickets: writable, disposable, never integrated.
- Mid-flight steering and graceful cancel (interrupt through the worker, then an identity-checked kill).
- Completion signaling in three layers: plugin monitor, then a background `wait`, then a Stop-hook nudge. Compaction resilience comes from the SessionStart ledger.
- Sandbox preflight measured against the real sandbox, with host-vs-sandbox differences reported.
- Concurrent ticket cap (default 3, `setup --max-parallel`) and ownership-overlap warnings at dispatch.
- Evidence capture on turns: commands, exit codes, durations, token usage, model, subagent count.
- Transport/broker substrate hardened against the open upstream defect backlog; see `UPSTREAM_AUDIT.md`:
  - bounded RPCs, and a turn watchdog that probes `thread/read` instead of timing out on silence
  - zombie-broker exit, thread unsubscribe on disconnect, serialized broker acquisition that never kills a live broker
  - busy-aware SessionEnd shutdown and broker idle exit
  - an explicit per-turn sandbox policy on every turn
  - retry-aware turn errors
- Ticket continuity when a Codex thread cannot be resumed: a fresh thread with a handoff of earlier turns (recorded in `threadHistory`), plus `CODEX_COMPANION_CODEX_BIN`.
- Worktree integration is symlink-safe and transactional: journaled, rolled back on failure, and recovered after a crash without overwriting lead edits made since.
- `doctor` / `/codex:doctor`: a read-only runtime health diagnostic (the only new public command).
- Stale-lock recovery serialized through a recovery gate. This fixes a reproduced race that admitted multiple lock holders.
- Linux is the reference platform (decision from the `linux-platform` investigation): capability-detected enhancements with portable fallbacks.

## Incomplete / next

The ordered remaining-work plan is in `CHECKPOINT_HANDOFF.md` ("Roadmap"). Open items include:
- More `RUNBOOK.md` drills (broker death and busy-SessionEnd on real processes)
- Linux tier: `flock(1)`-backed state locks and cgroup/systemd containment of worker process trees
- observing the monitor, SessionStart ledger, and Stop nudge live in an interactive session
- retention of closed tickets
- model discovery (#638)
- delegation metrics

## Key design decisions

- **Evolve, don't rewrite.** Transport and protocol code stays close to upstream, and orchestration lives in new modules.
- **One workspace lock** for index, job, and ticket mutation. Critical sections are tiny, so a single lock is simpler to reason about than finer-grained locks and has no measurable contention.
- **Tickets over "resume latest".** Resume by explicit identity; "latest" is unsafe once two jobs exist.
- **Controller owns git.** The Codex sandbox's `.git` is read-only (measured), so Codex cannot stage or commit anyway; integration and cleanup are deterministic code.
- **Fail-closed capability.** Every ticket turn passes an explicit `sandboxPolicy`; network is granted only with `--network` and is recorded.
- **Measure, don't guess.** Preflight uses `command/exec` under the ticket's exact policy. It already caught a real sandbox quirk (spawnSync reports EPERM while succeeding).
- **Evidence over claims.** Codex's report is informative; snapshots, ownership checks, and independent `verify` runs are authoritative.
- **Shared isolation is the default.** It matches the lead's real environment. Worktrees are opt-in because symlinked dependencies can resolve editable installs and monorepo links to the main checkout.
- **Minimal public surface.** No new slash commands. The model uses the runtime through one skill, and `/codex:status` shows tickets.

## Known limitations / technical debt

- Shared-checkout attribution: files changed by Codex through shell commands (not `fileChange` items) show as "unattributed", indistinguishable from the lead's concurrent edits.
- Claim cross-checking is substring heuristics over normalized command text.
- The monitor depends on the experimental plugin-monitor feature (interactive CLI only); `wait` and the Stop nudge are the fallbacks.
- The fork's marketplace name is still `openai-codex`, the same as upstream, so installing both through marketplaces would collide. Use `--plugin-dir` for testing.
- Test suite runtime is about 2.5 min, and the timing-sensitive upstream tests remain.
- On this machine the Codex CLI (0.144.1) cannot resume some threads written alongside the desktop app's newer Codex. Tickets fall back to a fresh thread, which loses the thread's conversational context but not the code or the report handoff. Updating the CLI, or pointing `CODEX_COMPANION_CODEX_BIN` at the newer binary, avoids it.
- A foreground `/codex:rescue` still runs inside a subagent Bash call and is bounded by its timeout.

## Validation status

At the most recent commit on `orchestration` (see `CHECKPOINT_HANDOFF.md` for the exact SHA and results):
- `npm test`: 175 tests passing. Suites: upstream-derived runtime/commands/git/state, `orchestration`, `orchestration-units`, `substrate`, `worktree-safety`, `stock-runtime`.
- `npm run build` (tsc check): passes.
- A full test run leaves no stray processes. The harness stops brokers on exit and on signals.
- Dogfooded against real Codex CLI 0.144.1 with 5 tickets: 1 review, 3 implement, and 1 implement that went through two rejection→followup cycles. The dogfood covered integrate, verify, a monitor notification, the resume fallback, and close/purge. Every accepted change passed independent verification outside the sandbox.

## Runtime assumptions

- Node ≥ 18.18 (developed on 22), git ≥ 2.38, Codex CLI with `app-server` (developed against 0.144.1).
- Claude Code with plugin hooks. Monitors are experimental; `CLAUDE_ENV_FILE` is used for env export.
- The Codex sandbox as measured on Linux: no network by default, `.git` read-only, cwd and `/tmp` writable, Docker daemon unreachable.

## Development commands

```bash
npm test                                   # full suite (~80s)
node --test tests/orchestration.test.mjs   # orchestration suite only
npm run build                              # regenerates app-server types via `codex`, then tsc
claude --plugin-dir plugins/codex          # run Claude Code with this fork's plugin loaded
node plugins/codex/scripts/codex-companion.mjs help
node plugins/codex/scripts/codex-companion.mjs preflight --check "node --test tests/render.test.mjs"
```

When dogfooding from a session where the upstream plugin is also installed, point the fork at its own data dir (for example `CLAUDE_PLUGIN_DATA=~/.cache/codex-companion-fork`) so the upstream plugin's SessionEnd hook cannot touch fork tickets.

## Deviations from upstream behavior

- SessionEnd no longer terminates or deletes session jobs; it only shuts down the session broker.
- Background `task` workers use a private app-server instead of the session broker, and are cancelled through their control channel.
- `/codex:rescue` resume-candidate selection ignores ticket threads.
- `--effort` accepts any well-formed token; the protocol now types effort as an open string.
- SessionStart also exports `CODEX_COMPANION` and may print the open-ticket ledger.
- The Stop hook may block once per finished, unreviewed ticket turn, before the optional review gate.
- `thread/started` notifications that arrive before the `turn/start` response are no longer dropped. This is an upstream bug fix, a good candidate to send upstream.
- `item/commandExecution/outputDelta` and `item/fileChange/outputDelta` notifications are opted out.
- Broker: thread ownership/unsubscribe, exit when its child dies, `broker/shutdown {ifIdle}`, idle exit. Acquisition is lock-serialized and never kills a live broker.
- Every `turn/start` carries an explicit `sandboxPolicy`, and RPCs are bounded (`CODEX_COMPANION_RPC_TIMEOUT_MS`).
- `task`, `delegate`, `followup`, and `steer` stop option parsing at the first free-text token for single raw-string input.
