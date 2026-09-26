# Changelog

## Unreleased (fork: ApexAiOfficial/codex-plugin-cc, branch `orchestration`)

- Durable Codex tickets for parallel delegation: `delegate`, `followup`, `steer`, `wait`, `tickets`, `show`, `verify`, `integrate`, `close`, `preflight`, `watch`, used by Claude through the new `codex-delegation` skill.
- Plugin monitor for finished ticket turns; SessionStart ledger of open tickets; a once-per-turn Stop reminder for unreviewed results.
- Concurrency- and crash-safe state (locking, atomic writes, corruption recovery, prune protection).
- Jobs survive SessionEnd, `/clear`, and resume; workers use private app-servers; identity-checked termination and dead-worker reconciliation.
- Worktree isolation with symlink-safe, transactional, recoverable integration.
- Broker hardening: thread unsubscribe, exit when the app-server dies, serialized acquisition that never kills a live broker, busy-aware shutdown, idle exit.
- Bounded RPCs and a turn watchdog; explicit per-turn sandbox policy; retry-aware turn errors; fixes for missing-cwd probes, prompt text parsed as flags, missing `fileChange.changes`, and empty failure messages (see `UPSTREAM_AUDIT.md`).
- A fresh-thread handoff when a Codex thread cannot be resumed; `CODEX_COMPANION_CODEX_BIN`.
- `/codex:doctor`: read-only runtime health diagnostic.
- Fix: stale-lock recovery could admit two lock holders at once.
- `doctor`: the Codex version-skew check is now direction-aware. Only a companion that is older than the `CODEX_CLI_PATH` install warns; that is the only direction that breaks resume.
- A ticket turn stopped by usage limits, authentication, or infrastructure errors now shows Codex's own error message on the card and in the job record, including the reset time for usage limits.
- `tests/drills/broker-drill.mjs`: a manual real-process drill of broker lifecycle recovery (no model turns).
- `tests/drills/sandbox-containment-drill.mjs`: a manual drill confirming that nothing a sandboxed Codex command starts outlives the command on Linux.
- `tests/drills/live-check-setup.mjs`: a disposable workspace with a fake Codex for the interactive plugin check.
- Fix: a lock recovery gate left by a process whose pid was later reused (for example after a reboot) is now reported as abandoned, instead of making contenders time out with a misleading error.
- Fix: the ticket monitor never started. Claude Code dispatches plugin skills by their namespaced name (`codex:codex-delegation`), and `on-skill-invoke` matches that name exactly. The monitor now registers both forms, and `watch` claims each notification so two watchers never double-notify.
- The Stop hook's note about a running ticket no longer suggests `/codex:cancel`.
- Fix (broker): a subagent thread that started after its parent's last client disconnected was never unsubscribed.
- The test suite removes its temp dirs and their derived state dirs on exit; each run used to leave about 300 behind.
- Retention visibility (Codex ticket). `show` on a ticket whose job history was pruned renders from the ticket record. `doctor` lists the worktrees kept for closed tickets, with age and size, and warns after 14 days. `close --purge` on an already-purged ticket says so.
- Codex capacity telemetry. Account rate limits come from `account/rateLimits/read` and `account/rateLimits/updated`: every native bucket, with its real window duration and reset time. Per-thread context comes from `thread/tokenUsage/updated`, with occupancy from the latest request (`last.totalTokens` against `modelContextWindow`), never the cumulative total. They are persisted to `<plugin data>/state/capacity.json` (schema version 1) and exposed in `status --json` (`capacity`) and the human `/codex:status`. `status --refresh-capacity` reads on demand without using the model. Telemetry is advisory and never fails work.
- Fixes from an adversarial Codex review of the fork's own recent changes (4 turns, all findings resolved, each with a regression test):
  - Monitor notifications are claimed by the delivering watcher and confirmed after the write. A failed or unconfirmed delivery lapses when that watcher exits and is surfaced again; a watcher announces its session's turns that finished before it started.
  - The broker neither hands an orphan subagent to an unrelated client nor routes the orphan's events to it.
  - The lock recovery gate handles the current pid and unreadable start markers.
  - `model/list` paging that does not finish counts as discovery unavailable.
  - `doctor` compares versions with exact SemVer precedence.
  - Test cleanup stops recorded test workers before removing their dirs.
- Model discovery through app-server `model/list` and `config/read`, with no model call. `preflight` lists the models this account can use, their supported efforts, and the default tickets use. `delegate` and `followup` reject an unknown `--model`, or an effort that model does not support, before any turn runs. No model names are hardcoded (#638).

## 1.0.0

- Initial version of the Codex plugin for Claude Code
