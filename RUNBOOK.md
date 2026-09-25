# Runbook

How to operate, diagnose, and recover this fork. Each procedure is tagged with how it was validated: **[real]** means exercised against real Codex or real processes, **[test]** means covered by an automated test. When the docs and runtime state disagree, trust in this order: the actual processes and files, then ticket/job records (`tickets --all`, `show`), then git state, then these docs.

Shorthand used below:

```bash
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"   # from the repo root
cx() { node "$CODEX_COMPANION" "$@"; }
```

Inside a Claude session with the fork loaded, `$CODEX_COMPANION` is exported automatically.

## Validate a change [real]

```bash
npm test                      # ~2.5 min; must be fully green
npm run build                 # tsc over the runtime modules
ps -eo pid,cmd | grep -E 'app-server-broker.mjs serve|codex-plugin-test|task-worker' | grep -v grep   # expect nothing
```

A test run killed by a timeout used to strand brokers. The harness now stops them on exit and on signals. If the `ps` line shows `/tmp/codex-plugin-test-*` or `app-server-broker.mjs serve` processes, kill them; they are test-only.

## Dogfood the fork next to an installed upstream plugin [real]

Give the fork its own data dir, so the upstream plugin's hooks never see or clean up fork tickets:

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
```

## Delegate and follow work [real]

```bash
cx preflight                               # what the Codex sandbox can and cannot do here
cx delegate --ticket t1 --owns src/x/ --accept "npm test -- x" --brief-file brief.md
cx tickets                                 # open tickets
cx show t1                                 # running: heartbeat, thread, recent activity; finished: full report
cx wait t1                                 # blocks until the turn ends (use run_in_background in Claude)
cx verify t1 && cx integrate t1            # worktree tickets; shared tickets skip integrate
cx close t1 --accepted --reason "…"
```

Watch a turn live in Codex's own UI: `codex resume <thread>` (the thread id is shown by `show`).

## A worker died (`worker-lost`) [real]

Symptom: the outcome is `worker-lost` ("exited without recording a result"), reported on the next `tickets`/`show`/`status` read and by the monitor. The worker's app-server dies with its process group.
Recovery: `cx followup <ticket> "…"` continues the same ticket; the work already done in the working tree is kept.

## A thread cannot be resumed [real]

Symptom: the card says `Thread reset: … could not be resumed (paginated_threads is not supported yet)`. Cause seen here: Codex CLI 0.144.1 sharing `~/.codex` with the desktop app's newer Codex. The turn continued on a fresh thread with a handoff of earlier turns (`threadHistory` on the ticket), so no action is required. To keep thread context, update the CLI, or point the runtime at the newer binary:

```bash
export CODEX_COMPANION_CODEX_BIN=/usr/lib/chatgpt/resources/codex
```

## A turn seems stuck [test]

`cx show <ticket>` shows the heartbeat and recent activity. Silence alone is normal (long reasoning or test runs). After 2 minutes of silence the watchdog asks the app-server whether the thread is still active. It recovers a turn whose completion was lost, and fails the turn only if the app-server stops answering or its connection closes. To stop a turn: `cx cancel <ticket>`. It interrupts the turn through the worker, then kills the worker only if its identity is verified.

## Interrupted integration [test]

If `integrate` was killed mid-way, a `<worktree>.integration-journal/` directory remains. Do not delete it. Rerun `cx integrate <ticket>`: it restores the files the interrupted run wrote, then integrates again. If it refuses with "paths changed after the interrupted integration", you edited those files since. Resolve them by hand, then rerun. A conflict in normal integration writes nothing: resolve from the worktree, or `followup` with instructions.

## Broker trouble [test]

The shared broker only serves foreground stock commands (`review`, `task`, the stop gate); tickets never use it. A dead broker's metadata is replaced on next use. A broker whose app-server died exits by itself. A busy broker is never killed because it answered slowly; that call uses a private app-server instead. A Claude session ending does not stop a broker another session is using, and an idle broker exits after `CODEX_COMPANION_BROKER_IDLE_MS` (default 30 min).

## State corruption [test]

A corrupt `state.json` is moved aside to `state.json.corrupt-<ts>` and the job index is rebuilt from the job files automatically. Ticket files are separate and unaffected.

## Worktrees and cleanup [real]

- Ticket worktrees live under the state dir's `worktrees/` and are registered with `git worktree`. Remove them only with `cx close <ticket> --purge` (rejected or abandoned tickets keep theirs), never with `rm -rf`, which leaves stale git metadata.
- Accepting a ticket removes its worktree and its `refs/codex-companion/tickets/<id>/*` refs.

## Roll back

```bash
git status                     # make sure nothing uncommitted matters
git fetch origin && git reset --hard <checkpoint-sha>   # checkpoints are listed in CHECKPOINT_HANDOFF.md / git log
```

Checking out `main` returns the plugin source to upstream behavior. The installed marketplace plugin is unaffected by this branch.

## Never delete while work is active

The state dir (`$CLAUDE_PLUGIN_DATA/state/<repo>-<hash>/`), `*.integration-journal` directories, ticket worktrees (use `close --purge`), and `refs/codex-companion/*` refs of open tickets.

## Not yet validated here

These are expected to work but have not been exercised end to end: loading the fork as the active plugin in an interactive session (`claude --plugin-dir plugins/codex`) with live monitor notifications, the SessionStart ledger, and the Stop nudge; Windows and macOS behavior; account switching mid-ticket.
