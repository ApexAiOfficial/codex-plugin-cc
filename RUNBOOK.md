# Runbook

How to operate, diagnose, and recover this fork. Each procedure is tagged with how it was validated: **[real]** means exercised against real Codex or real processes, **[test]** means covered by an automated test. When the docs and runtime state disagree, trust in this order: the actual processes and files, then ticket/job records (`tickets --all`, `show`), then git state, then these docs.

Shorthand used below:

```bash
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"   # from the repo root
cx() { node "$CODEX_COMPANION" "$@"; }
```

Inside a Claude session with the fork loaded, `$CODEX_COMPANION` is exported automatically.

## First: run the doctor [real]

```bash
cx doctor          # or /codex:doctor in Claude; read-only, exit 1 on any FAIL
```

It reports Codex version skew, state, lock and recovery-gate files, broker health, worker liveness and heartbeats, ticket consistency, and worktree, journal, and ref leftovers. Each finding comes with a fix hint. It never changes anything; this was pressure-tested against injected faults, and state files stayed byte-identical. An abandoned `*.lock.recover` gate is a FAIL: remove it once no companion process is running.

## Validate a change [real]

```bash
npm test                      # ~2.5 min; must be fully green (drills in tests/drills/ are manual)
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

Symptom: the card says `Thread reset: … could not be resumed (paginated_threads is not supported yet)`. Cause seen here: the companion's Codex CLI (0.144.1) was older than the desktop app's Codex (0.155-alpha), which shares `~/.codex`. An older binary cannot resume threads a newer one wrote. On the same threads, 0.155-alpha and 0.156.1 both resumed fine. The turn continued on a fresh thread with a handoff of earlier turns (`threadHistory` on the ticket), so no action is required. To keep thread context, make the companion's Codex at least as new as the other install (next section). `doctor` warns only in that direction.

## Update or roll back the Codex CLI [real]

The standalone install keeps every release under `~/.codex/packages/standalone/releases/`. `current` is a symlink to one of them.

```bash
codex --version                       # the companion resolves `codex` from PATH unless CODEX_COMPANION_CODEX_BIN is set
codex update                          # standalone install: downloads the latest release and repoints `current`
cx doctor | grep CODEX_CLI_PATH       # expect OK: companion same as or newer than the desktop build
cx preflight                          # the sandbox profile should be unchanged
```

Before switching, test a candidate without touching the default: `npm pack @openai/codex@<version>-linux-x64` into a scratch dir, then run `preflight` and a thread-resume probe with `CODEX_COMPANION_CODEX_BIN=<scratch>/package/vendor/x86_64-unknown-linux-musl/bin/codex`. Roll back by repointing the symlink:

```bash
ln -sfn ~/.codex/packages/standalone/releases/<old-release-dir> ~/.codex/packages/standalone/current
```

Done here on 2026-09-24: 0.144.1 → 0.156.1. The generated app-server types changed only additively for the methods the companion calls, and tsc and the full suite pass against them. Setting `CODEX_COMPANION_CODEX_BIN=/usr/lib/chatgpt/resources/codex` also works (it tracks the desktop build exactly). It was not chosen because it pins the companion to an alpha build that belongs to another app, and every hook and worker environment would need the variable.

## Codex usage limits [real]

Symptom: the card says `stopped by usage limits` and shows Codex's message, which includes the reset time ("try again at 11:10 PM"). Nothing ran, and the thread persists. Either wait and `cx followup <ticket>`, or do the work in Claude and `cx close <ticket> --abandoned --reason "…"`. Buying credits or upgrading the plan is the account owner's decision.

## A turn seems stuck [test]

`cx show <ticket>` shows the heartbeat and recent activity. Silence alone is normal (long reasoning or test runs). After 2 minutes of silence the watchdog asks the app-server whether the thread is still active. It recovers a turn whose completion was lost, and fails the turn only if the app-server stops answering or its connection closes. To stop a turn: `cx cancel <ticket>`. It interrupts the turn through the worker, then kills the worker only if its identity is verified.

## Interrupted integration [test]

If `integrate` was killed mid-way, a `<worktree>.integration-journal/` directory remains. Do not delete it. Rerun `cx integrate <ticket>`: it restores the files the interrupted run wrote, then integrates again. If it refuses with "paths changed after the interrupted integration", you edited those files since. Resolve them by hand, then rerun. A conflict in normal integration writes nothing: resolve from the worktree, or `followup` with instructions.

## Broker trouble [real]

The shared broker only serves foreground stock commands (`review`, `task`, the stop gate); tickets never use it. Recovery is automatic in every case below. Each was exercised with a real `codex app-server` behind the real broker:

- The broker's app-server dies: the broker exits by itself, and the next caller gets a fresh broker.
- The broker dies (SIGKILL): its app-server exits too (stdin EOF), leaving no orphan. The stale metadata stays on disk until the next caller replaces it.
- A session ends while the broker is serving a request: the broker declines the shutdown (busy), the request finishes, and a later idle SessionEnd stops it and clears its metadata.
- An idle broker exits after `CODEX_COMPANION_BROKER_IDLE_MS` (default 30 min); the next caller transparently starts a new one.

A busy broker is never killed because it answered slowly ([test]); that call uses a private app-server instead. To re-run the drill (about 30 s, no model turns, disposable repo and state):

```bash
node tests/drills/broker-drill.mjs      # expect ALL DRILLS PASSED
```

## Processes started by Codex commands [real]

On Linux, Codex runs every sandboxed command, including tickets granted `--network`, under `bwrap --unshare-pid --as-pid-1 --die-with-parent`. Anything the command starts dies when the command ends, including `setsid`, `nohup`, and double-forked daemons, and it cannot outlive the app-server either. A ticket therefore cannot leave a stray dev server or watcher behind. Re-check after a Codex update:

```bash
node tests/drills/sandbox-containment-drill.mjs   # ~15 s, no model turns; expect ALL DRILLS PASSED
```

A test that needs a long-running service (a dev server, a database) cannot keep it running between Codex commands. Run such checks in Claude (`verify`) or start the service inside the same command.

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

## A lock recovery gate is abandoned [test]

Symptom: every companion command fails with `Lock recovery gate …state.lock.recover was abandoned…`, and `doctor` reports a FAIL. This happens only if a process dies inside the sub-millisecond window while it breaks a stale lock, or if its pid was reused after a reboot. Fix: confirm that no companion process is running (`ps -eo pid,cmd | grep codex-companion`), then remove the named `.recover` file. The gate is never removed automatically; guessing there could admit two lock holders.

## Never delete while work is active

The state dir (`$CLAUDE_PLUGIN_DATA/state/<repo>-<hash>/`), `*.integration-journal` directories, ticket worktrees (use `close --purge`), and `refs/codex-companion/*` refs of open tickets.

## Live plugin check [pending: headless parts real]

Checks the model-facing surfaces in one interactive session, against a fake Codex in a disposable repo (no quota). Covered: the SessionStart ledger reaching the model, the Stop reminder, a monitor notification, and `/codex:doctor`. Verified headless (no login needed): `--plugin-dir` replaces the installed upstream `codex` plugin for that session, and the SessionStart hook prints the ledger.

```bash
node tests/drills/live-check-setup.mjs                                   # repo, fake Codex, one staged ticket
cd ~/.cache/codex-companion-live-check/repo
CODEX_COMPANION_CODEX_BIN="$HOME/.cache/codex-companion-live-check/bin/codex" ~/.config/Claude/claude-code/<version>/claude --plugin-dir "<fork>/plugins/codex" --allowedTools "Bash(node:*)" "Bash(sleep:*)"
```

In the session, paste the prompt from `tests/drills/live-check-prompt.md`, wait for the monitor notification, run `/codex:doctor`, then `/exit`. The transcript is under `~/.claude/projects/-home-logan--cache-codex-companion-live-check-repo/`. Clean up with `node tests/drills/live-check-setup.mjs --cleanup`.

## Not yet validated here

These are expected to work but have not been exercised end to end: the interactive live check above, Windows and macOS behavior, and account switching mid-ticket.
