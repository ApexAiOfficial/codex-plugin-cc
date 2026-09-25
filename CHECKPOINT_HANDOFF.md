# Checkpoint handoff

Operational recovery notes. This file is overwritten at each safe checkpoint; git history keeps the earlier versions. `PROJECT_STATUS.md` describes the system, `UPSTREAM_AUDIT.md` holds the upstream defect evidence, `IDEA_BANK_REVIEW.md` classifies the 100-item idea bank, and `RUNBOOK.md` holds validated procedures.

## Current checkpoint — 2026-09-25 (pre-compaction)

- **Branch** `orchestration`, pushed to `origin` (ApexAiOfficial/codex-plugin-cc). `main` is untouched and equals upstream `db52e28`.
- **Latest code checkpoint:** `edc94de`. The docs commit containing this file is the branch tip (`git log -1`).
- **Working tree:** clean after this commit. No intentional uncommitted work.
- **Validation at `edc94de`:** `npm test` 175/175. `npm run build` (tsc over all runtime and orchestration modules) is clean. No stray broker, app-server, or worker processes after the run.
- **Codex tickets:** none open. All 9 dogfood tickets (`unit-tests`, `review-core`, `fix-integration`, `stock-fixes`, `drill-kill`, `doctor`, `linux-platform`, plus 2 earlier) are closed with decision records. No ticket worktrees remain (`git worktree list` shows only the main checkout), and no `refs/codex-companion/*` refs remain.
- **Waiters/monitors:** none running. The session's Monitor watch expired, and the background `wait` completed.
- **Processes:** no unintended descendants, checked with `ps -eo cmd | grep -E 'app-server-broker.mjs serve|codex-plugin-test|task-worker'`.

## Completed in this context window

- The first dogfood cycle and upstream audit (details in `UPSTREAM_AUDIT.md`). Substrate: `a17c2d7`, `983435f`, `3476adc`, `ad935c8`.
- README and CHANGELOG coverage of the fork (`61a3d82`); idea-bank classification (`efce6dd`); type-checking of all new modules (`0222176`); `RUNBOOK.md` (`e741a6d`, extended in this commit).
- A real recovery drill: a worker killed mid-turn was reconciled to `worker-lost` immediately, with no orphans, and `followup` continued the ticket.
- The `linux-platform` investigation found a real stale-lock mutual-exclusion race. Fixed in `bbc7640` with a recovery gate and a deterministic regression test that fails on the old code.
- `doctor` / `/codex:doctor` (Codex ticket, `edc94de`): read-only, pressure-tested against 5 injected faults, and it changes nothing.
- Decision: Linux is the reference platform tier, with capability detection and portable fallbacks.

## Next-work order (reconciled; start at the top)

1. **More RUNBOOK drills on real processes:** broker death and a busy broker at SessionEnd (currently [test]-only). Use disposable fixtures.
2. **Linux tier, part 1:** `flock(1)`-backed state locks, via an fd passed to `flock -n 3`, capability-detected. Keep `O_EXCL` + recovery gate as the fallback, and test both paths. This removes stale-owner logic on Linux.
3. **Linux tier, part 2:** cgroup/systemd containment of worker process trees, since Codex child processes can escape the process group. Capability-detected; fall back to process groups.
4. **Retention of closed tickets, job history, and journals** (ideas 48–49). Codex implement ticket.
5. **Live-session verification** of the monitor, SessionStart ledger, and Stop nudge (`claude --plugin-dir plugins/codex`). Needs the human, below.
6. **Model discovery** via `model/list` and role-based model/effort guidance (#638, ideas 50–52).
7. **Delegation metrics** (ideas 79–81), only after real usage.
8. Optional: route foreground `/codex:rescue` through durable jobs (#738).

Public commands: only `/codex:doctor` was added. `/codex:tickets`, `/codex:watch`, and `/codex:delegate` were rejected as duplicates of `/codex:status`, the monitor, and the skill.

## Exact first action after compaction

Read this file, run `node plugins/codex/scripts/codex-companion.mjs doctor` (with the dogfood env below), confirm there are no FAILs, then start item 1.

Dogfood environment. It keeps the installed upstream plugin from touching fork tickets:

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"
```

## Known issues / unresolved

- **Human decision:** the Codex CLI (0.144.1) cannot resume some threads because it shares `~/.codex` with the desktop app's Codex 0.155-alpha. The fallback handles this, but thread context is lost when it triggers. To avoid it, update the CLI or set `CODEX_COMPANION_CODEX_BIN`. `doctor` reports this as a WARN.
- **Human action:** the interactive live-session check (item 5).
- One broker test (`…subagent threads, once the last client disconnects`) failed once under full-suite load and passed alone and as a file. It now has a 30 s wait; watch for recurrence.
- `close --purge` on an already-purged ticket still prints "Removed the retained worktree" (cosmetic).
- `~/.claude/plugins/data/codex-openai-codex/state/codex-plugin-test-*` holds stale test state from runs before the suite was made hermetic. It is safe to delete and has not been deleted.

## Do not destroy

- Branch `orchestration` (local and `origin`).
- `~/.cache/codex-companion-fork/`: fork dogfood state and ticket history (decision records).
- Any `*.integration-journal` or `*.lock.recover` file, while any companion process may be running.

## Recovery

- Restore this checkpoint: `git fetch origin && git checkout orchestration && git reset --hard edc94de`, or the docs tip. Check `git status` first, since the reset discards local changes.
- Return to upstream behavior: check out `main`. The installed marketplace plugin (`codex@openai-codex` 1.0.6) is upstream and unaffected.
- Stray test processes after an interrupted run: see `RUNBOOK.md` → "Validate a change".
