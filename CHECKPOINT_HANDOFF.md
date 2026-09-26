# Checkpoint handoff

Operational recovery notes. This file is overwritten at each safe checkpoint; git history keeps the earlier versions. `PROJECT_STATUS.md` describes the system, `UPSTREAM_AUDIT.md` holds defect evidence, `IDEA_BANK_REVIEW.md` classifies the idea bank, and `RUNBOOK.md` holds validated procedures.

## Current checkpoint — 2026-09-26 (Codex capacity telemetry accepted)

- **Branch** `orchestration`, pushed. The checkpoint SHA is the commit containing this file (`git log -1`; verify with `git rev-parse HEAD origin/orchestration`). The code beneath it is `a95a323`. `main` is untouched and equals upstream `db52e28`. No other branches.
- **Working tree:** clean after this commit.
- **Validation at `a95a323`:** `npm test` 240/240, tsc clean. No leftover temp or state dirs, and no stray broker, worker, watch, or app-server processes.
- **`doctor`:** no failures. The WARNs are the expected Codex version skew (companion 0.157.1 vs the desktop's 0.158.0-alpha.2), plus `CODEX_COMPANION` when it is not exported in the shell.
- **Codex CLI:** the standalone `codex` is **0.157.1**, updated from 0.156.1 this session after a side-by-side check. The telemetry protocol types are identical in 0.156.1, 0.157.1, and 0.158-alpha; tsc passes against the 0.157.1 types; preflight is unchanged; and resume works on all three versions. Roll back with `ln -sfn ~/.codex/packages/standalone/releases/0.156.1-x86_64-unknown-linux-musl ~/.codex/packages/standalone/current` (0.144.1 is also kept).
- **Codex tickets:** none open (`capacity-unit-tests` and `capacity-review` are closed as accepted). No ticket worktrees and no `refs/codex-companion/*` refs. No journals and no `.recover` gates.

## Feature: Codex capacity telemetry

The work order is `docs/work-orders/codex-capacity-telemetry.md`. The code is in `plugins/codex/scripts/lib/capacity.mjs`, whose header states the verified native semantics.

**Interface.**
- `status --json` → `capacity` (`schemaVersion: 1`): `file`, `account { freshness, accountId, ordinaryUsageAllowed, readAt, observedAt, lastError, limits[] }`, and `threads[]` for running jobs and open tickets.
  - Each limit carries `key`, `limitId`, `limitName`, `normalModelSlug`, `planType`, `rateLimitReachedType`, `spendControlReached`, `observedAt`, and `windows[]` (`slot`, `label`, `usedPercent`, `windowDurationMins`, `resetsAt`).
  - Each thread carries `threadId`, `jobId`, `ticketId`, `jobStatus`, `model`, `turnId`, `observedAt`, `freshness`, `context`, and the raw `tokenUsage`.
- The persisted file is `<CLAUDE_PLUGIN_DATA>/state/capacity.json`, overridable with `CODEX_COMPANION_CAPACITY_FILE`. It is one file per plugin data dir, since the account is global and thread IDs are unique.
- The human `/codex:status` shows a short "Codex capacity" section. `status --refresh-capacity` does one no-model read on demand.

**Initial read.** One `account/rateLimits/read` (no model, no quota) at every task, review, and ticket turn start, plus a bounded 1 s settle before the connection closes. The read also runs on `--refresh-capacity`. It is in the typed `AppServerMethodMap`, using the generated types.

**Rolling updates.** `account/rateLimits/updated` is sparse and is merged per bucket: null fields keep their previous values, and other buckets are untouched.
- Updates are merged only on a connection whose last read succeeded with a non-null `accountId` equal to the stored one; any read error clears that identity.
- Ordering across connections uses sub-millisecond observation keys:
  - Complete reads are totally ordered by `readKey`. The newest read defines the bucket set and the account fields, and an older read is ignored.
  - A sparse update applies only if it is newer than the latest complete read and than its bucket's latest observation.
  - A stored stamp more than 5 s in the future (a clock change) is untrusted and reads as stale.

**Account switch.** A read for another account replaces everything, but only if it is newer than every stored observation. Accounts are never mixed.

**Active-context semantics.** Verified in the Codex 0.157.1 source:
- **Occupancy** = `last.totalTokens / modelContextWindow`.
- **Evidence:**
  - The TUI (`tui/src/token_usage.rs`) documents `last_token_usage` as "the latest active context size" and computes "context left" from it (`chatwidget.rs`, `status_controls.rs`, `status/card.rs`).
  - The app-server maps `total ← total_token_usage` and `last ← last_token_usage` 1:1.
  - After compaction, core `recompute_token_usage` replaces `last` with the compacted estimate.
- **Why cumulative totals are not used:** `total` is cumulative (`append_last_usage`). A real ticket on this machine already had `total` at 412,331 tokens, 1.6× its 258,400 window, while its active context was 21.7%.
- **Exceeded sentinel:** on `ContextWindowExceeded`, core `fill_to_context_window` sets `total = window` and every other field to 0; that is reported as `exceeded` (100%).
- **Also exposed:** `codexContextLeftPercent`, which reproduces Codex's own baseline-12,000 figure. Unknown values are null, never 0.

**Freshness.**
- An account is `stale` once any bucket is older than 10 minutes (`ACCOUNT_FRESH_MS`), a window has reset since it was observed, or it is future-stamped. It is `unavailable` when there are no limits: an unsupported method, auth without limits, an empty read, or a corrupt file.
- A thread is `stale` while its running turn has not reported, and `unknown` when nothing was observed.

**Broker and direct workers.** The observer runs on every direct app-server connection (`SpawnedCodexAppServerClient`), including the broker's own upstream connection, and never on broker clients.
- The broker therefore no longer loses account updates that arrive with no active client (verified with a post-turn update test), and nothing is recorded twice.
- Observations are queued in memory and flushed asynchronously in batches: an async lock, bounded retries, one flush in flight, and a bounded drain on close (1.5 s plus at most one local write).
- Thread-to-job association happens at read time from the workspace's job index, so it works for worktree tickets too.

**Retention.** At most 256 records and 7 days. Subagents are evicted before roots. An open ticket's root is pinned until the ticket closes; pins lapse after 30 days and are bounded by the cap.

**Tests.**
- 20 unit tests (Codex ticket `capacity-unit-tests`). A mutant using the cumulative total fails 5 of them, including the regression with `total` 2,000,000 against a window of 258,400.
- 15 review-regression tests (`tests/capacity-review.test.mjs`), each shown to fail on the prior code.
- 3 transport tests: direct, broker post-turn update, and unsupported read.
- 3 status tests: JSON and human association, a worktree ticket with pin/unpin, and a corrupt file plus old Codex.
- Full suite 240/240.

**Real-protocol validation.**
- A no-model `account/rateLimits/read` on 0.157.1 returned one native bucket `codex` (Plus) with 300 min (5h) and 10080 min (7d) windows. They persisted correctly, and the file contains no secrets.
- Real `thread/tokenUsage/updated` data from live Codex tickets was captured, including model `gpt-5.6-sol` from `thread/start`. Status showed a running ticket's context live, for example "22% used (56842/258400 tokens)".

**Independent review.** Codex ticket `capacity-review` ran 7 turns on one thread.
- Turn 1 found 7 issues, and the worktree-status bug was found in parallel by dogfooding.
- Turns 2–6 found 4, 3, 1, 1, and 1 residuals.
- Turn 7 confirmed the ordering model with no new defect.
- Fix commits: `885f805`, `8a11734`, `a8e8ebc`, `a15d8c3`, `f845f52`, `a95a323`.

## Known limitations

**Capacity telemetry:**
- Account data is only as fresh as the last read (turn start or `--refresh-capacity`) or pushed update; usage on other devices is not seen in between.
- A sparse update is dropped whenever identity is ambiguous: a null `accountId`, or a failed read. The next read corrects it.
- The context figure is Codex's own, so the current turn's pending tool calls are not included.
- On close, anything still unwritten after the bounded drain is dropped.
- Cross-process ordering is only as good as the machine clock anchoring `performance.timeOrigin`.

**Weaker proofs:**
- The failed-confirmation retry (`2eac4ec`) is proven structurally.
- The orphan-marker cleanup and the capacity `drain` test's failure on `4cc5432` are structural too, because the function did not exist yet.

**Environment:**
- The desktop app's Codex alpha is ahead of stable, so the skew WARN persists until stable catches up. Resume was measured fine.

## Deferred (not started)

1. Delegation metrics (ideas 79–81), only after real usage.
2. Optional: route a foreground `/codex:rescue` through durable jobs (#738).
3. Future, from this feature, out of its scope: the standalone Claude limit/context guard, which would consume `capacity.json` or `status --json`.

## Exact first action for the next Claude session

1. Read this file.
2. Verify `git status`, `git branch --show-current` (`orchestration`), and `git rev-parse HEAD origin/orchestration`.
3. Run `node plugins/codex/scripts/codex-companion.mjs doctor` with the env below; expect no FAIL.
4. Check `codex --version` against the desktop build: take the newest stable once it is ≥ the desktop build (RUNBOOK "Update or roll back the Codex CLI").
5. Then follow the human's next instruction. No roadmap item is in flight.

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"
cx() { node "$CODEX_COMPANION" "$@"; }
```

## Do not destroy

- Branch `orchestration` (local and `origin`).
- `~/.cache/codex-companion-fork/`: dogfood state, ticket decision records, and `state/capacity.json`. The capacity file is telemetry only, so deleting it is safe; it is rebuilt.
- `~/.codex/packages/standalone/releases/0.156.1-*` and `0.144.1-*`: the CLI rollback targets.
- Any `*.integration-journal` or `*.lock.recover` file while a companion process may run (none exist now).

## Recovery

- Restore this checkpoint: `git fetch origin && git checkout orchestration && git reset --hard origin/orchestration`. Check `git status` first.
- Disable capacity telemetry's effect on status: it is advisory; delete the capacity file if it is suspect. The code paths fail open.
- Return to upstream behavior: check out `main`. The installed marketplace plugin (`codex@openai-codex` 1.0.6) is unaffected.
- Stray test processes after an interrupted run: `RUNBOOK.md` → "Validate a change".
