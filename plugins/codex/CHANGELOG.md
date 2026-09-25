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

## 1.0.0

- Initial version of the Codex plugin for Claude Code
