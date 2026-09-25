# Checkpoint handoff

Operational recovery notes. This file is overwritten at each safe checkpoint; git history keeps the earlier versions. `PROJECT_STATUS.md` describes the system, `UPSTREAM_AUDIT.md` holds the upstream defect evidence, `IDEA_BANK_REVIEW.md` classifies the 100-item idea bank, and `RUNBOOK.md` holds validated procedures.

## Current checkpoint — 2026-09-24 21:50 EDT

- **Branch** `orchestration`, pushed to `origin` (ApexAiOfficial/codex-plugin-cc). `main` is untouched and equals upstream `db52e28`.
- **Latest code checkpoint:** the commit containing this file (`git log -1`). The previous one is `ec5025d` (Codex 0.156.1, direction-aware skew check, broker drills).
- **Validation:** `npm test` is 177/177 (176 at `ec5025d`, plus a locking test), and tsc is clean. The drills pass: `tests/drills/broker-drill.mjs`, `tests/drills/sandbox-containment-drill.mjs`. No stray processes.
- **Codex CLI:** the standalone `codex` is now 0.156.1 (it was 0.144.1). The desktop app's `CODEX_CLI_PATH` is 0.155.0-alpha.16.4. `doctor` reports OK (companion newer). Roll back with `ln -sfn ~/.codex/packages/standalone/releases/0.144.1-x86_64-unknown-linux-musl ~/.codex/packages/standalone/current`.
- **Codex account:** usage limit hit at 21:20 EDT; Codex says to retry at 23:10 EDT. The ticket `doctor-skew` was closed as abandoned, and the lead implemented that change.
- **Tickets:** none open in the dogfood state (`~/.cache/codex-companion-fork`).
- **Live-check workspace:** staged at `~/.cache/codex-companion-live-check/` for the interactive check (item 1 below). It holds the ticket `staged`, whose state is in `~/.claude/plugins/data/codex-inline/state/repo-*`. Remove both with `node tests/drills/live-check-setup.mjs --cleanup` once the check is done.

## Completed since the last handoff

- **Codex version skew resolved.** Measured first: 0.144.1 fails `thread/resume` on a desktop-written thread (`paginated_threads`), while 0.155-alpha and 0.156.1 both succeed. 0.156.1 was tested side by side through `CODEX_COMPANION_CODEX_BIN`: protocol diff, tsc, and preflight. Then `codex update`. `doctor` is now direction-aware.
- A ticket's quota/auth/infra error text is persisted and shown on the card. Found on the real usage-limit hit, where the reset time was hidden.
- **Broker drills on real processes:** SessionEnd while busy, app-server death, broker death, and idle exit all pass. The RUNBOOK broker section is now [real].
- **Linux tier decided on evidence:**
  - cgroup/systemd containment is **dropped**. Codex's bwrap pid namespace already kills everything a sandboxed command starts, including setsid'd, nohup'd, and double-forked processes, with and without network.
  - `flock(1)` locks are **deferred**. The O_EXCL lock plus recovery gate is correct under stress, and a `flock` gate conflicts with the portable fallback; see PROJECT_STATUS "Key design decisions".
  - Fixed: a recovery gate left by a reused pid is reported as abandoned.
- Headless check under Claude Code 2.1.280: `--plugin-dir` replaces the installed upstream `codex` plugin for that session (`codex@inline`), all `/codex:*` commands including `doctor` register, and the SessionStart hook prints the ticket ledger from the `codex-inline` data dir.

## Next-work order (start at the top)

1. **Interactive live check.** The human runs one session (instructions are in the chat that produced this checkpoint, and in `RUNBOOK.md` → "Live plugin check"). The lead then analyzes the transcript under `~/.claude/projects/-home-logan--cache-codex-companion-live-check-repo/`, fixes what fails, and cleans up.
2. **Real multi-turn ticket on Codex 0.156.1, after 23:10 EDT.** Two turns on one thread, where the second depends on context from the first. Confirm that the `threadId` is unchanged and that there is no `threadHistory` reset.
3. **Retention** of closed tickets, job history, and journals (ideas 48–49). A good Codex implement ticket.
4. **Model discovery** via `model/list`, and role-based model/effort guidance (#638, ideas 50–52).
5. **Delegation metrics** (ideas 79–81), only after real usage.
6. Optional: route a foreground `/codex:rescue` through durable jobs (#738).

## Exact first action after compaction

Read this file. Run `node plugins/codex/scripts/codex-companion.mjs doctor` with the dogfood env below and confirm there are no FAILs. Then continue from the top of the list above: check whether the human has reported the live check, and check the time against the Codex reset.

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"
```

## Known issues / unresolved

- One broker test (`…subagent threads, once the last client disconnects`) failed once under full-suite load. It has had a 30 s wait since; watch for recurrence.
- `close --purge` on an already-purged ticket still prints "Removed the retained worktree" (cosmetic).
- `~/.claude/plugins/data/codex-openai-codex/state/codex-plugin-test-*` holds stale state from pre-hermetic test runs. It is safe to delete and has not been deleted.
- A standalone `claude` outside the desktop app is not logged in (headless runs say "Not logged in"), so the interactive check needs the human to sign in once.

## Do not destroy

- Branch `orchestration` (local and `origin`).
- `~/.cache/codex-companion-fork/`: fork dogfood state and ticket history (decision records).
- `~/.codex/packages/standalone/releases/0.144.1-*`: the rollback target for the CLI.
- Any `*.integration-journal` or `*.lock.recover` file, while any companion process may be running.

## Recovery

- Restore this checkpoint: `git fetch origin && git checkout orchestration && git reset --hard <sha>`. Check `git status` first, since the reset discards local changes.
- Return to upstream behavior: check out `main`. The installed marketplace plugin (`codex@openai-codex` 1.0.6) is upstream and unaffected.
- Stray test processes after an interrupted run: see `RUNBOOK.md` → "Validate a change".
