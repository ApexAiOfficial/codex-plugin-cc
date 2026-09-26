# Checkpoint handoff

Operational recovery notes. This file is overwritten at each safe checkpoint; git history keeps the earlier versions. `PROJECT_STATUS.md` describes the system, `UPSTREAM_AUDIT.md` holds defect evidence, `IDEA_BANK_REVIEW.md` classifies the idea bank, and `RUNBOOK.md` holds validated procedures.

## Current checkpoint — 2026-09-25 late (capacity telemetry recorded, not started)

- **Branch** `orchestration`, pushed. The checkpoint SHA is the commit containing this file (`git log -1`; verify with `git rev-parse HEAD origin/orchestration`). This checkpoint changes docs only. The last code checkpoint is `2eac4ec`, and the previous docs checkpoint is `1a3cddd`. `main` is untouched and equals upstream `db52e28`. No other branches exist: `wip/review-today-fixes` was merged and deleted locally and on `origin`.
- **Working tree:** clean after this commit.
- **Validation at `2eac4ec`:** `npm test` 197/197, tsc clean. The run left no temp or state dirs, and there are no stray broker, worker, or watch processes. `doctor` reports no failures.
- **Codex CLI:** standalone `codex` 0.156.1. The desktop app's `CODEX_CLI_PATH` has since moved to **0.158.0-alpha.2**, so `doctor` now WARNs for version skew with the companion older, as designed. The latest stable is 0.157.1, still older than the desktop build. A resume probe on the current ticket threads succeeded with 0.156.1, 0.157.1, and 0.158-alpha, so there is no breakage yet. The CLI was left unchanged. Roll back with `ln -sfn ~/.codex/packages/standalone/releases/0.144.1-x86_64-unknown-linux-musl ~/.codex/packages/standalone/current`.
- **Codex tickets:** none open. No ticket worktrees and no `refs/codex-companion/*` refs remain.
- **Integration journals / `.recover` gates:** none. **Active processes:** none of ours.

## Completed since the previous checkpoint (`8dec6af`)

The `review-today` Codex review is fully resolved, over 4 turns on one thread (`01a0d68c-05b5-7070-af4a-afa327c6f345`). Details and commits are in `UPSTREAM_AUDIT.md` → "Codex review-today findings".
- `e103287`: fixes for all 6 original findings, each with a regression test. The lead verified every test fails on `e5ee6fe` and passes on the fix. The tests for 3–5 came from Codex ticket `review-tests-unit`: its sandbox could not run the paging test, so the lead ran it outside.
- `18b4a25`: the turn-2 residuals. Orphan-thread notifications now go to no one, `watch` claims are identity-bound and lapse, and SemVer core numbers compare exactly.
- `2eac4ec`: the turn-3 lifecycle gaps. A failed confirmation is retried, and orphan markers are removed. Turn 4 confirmed that nothing concrete remains.
- Continuity docs reconciled.

## Next-work order

1. **Codex capacity telemetry: the next planned feature, not started.** Deferred at the human's request (Claude usage limit) before any implementation. The full work order, requirements, tests, acceptance criteria, exclusions, and read-only recon notes are in **`docs/work-orders/codex-capacity-telemetry.md`**.
   - Goal: expose Codex-native account rate limits (`account/rateLimits/read`, `account/rateLimits/updated`) and per-thread active-context usage (`thread/tokenUsage/updated`) in a stable, machine-readable form, so a separate standalone Claude limit/context guard can consume them.
   - **Rule: never compute context pressure from cumulative thread totals.** Use the proven active/latest semantics and the model context window. Keep the raw native fields, and never fabricate mappings or percentages.
   - Out of scope: a Claude-side guard, a resource manager, cross-provider scheduling, quota-based delegation, account switching, and automatic checkpoint/commit behavior.
2. Delegation metrics (ideas 79–81), only once there is real usage to measure.
3. Optional: route a foreground `/codex:rescue` through durable jobs (#738).

## Exact first action for the next Claude session

1. Verify the state:
   - `git status`, `git branch --show-current` (expect `orchestration`, not `main`), and `git rev-parse HEAD origin/orchestration`.
   - Run `node plugins/codex/scripts/codex-companion.mjs doctor` with the dogfood env below. The version-skew WARN is expected; no FAIL is.
   - No tickets, worktrees, refs, or companion processes.
2. Decide the Codex binary: take the newest stable if it is ≥ the desktop build, or set `CODEX_COMPANION_CODEX_BIN`, following RUNBOOK "Update or roll back the Codex CLI". Generate the protocol types from that binary.
3. Start the capacity-telemetry work order (`docs/work-orders/codex-capacity-telemetry.md`):
   - focused protocol and repo recon first: verify observations A–G and the active-context semantics in the Codex source
   - then the targeted implementation, tests, real no-model validation, and a Codex adversarial review
   - then a checkpoint

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"
cx() { node "$CODEX_COMPANION" "$@"; }
```

## Known issues / limitations

- Two proofs are weaker than the rest:
  - The failed-confirmation retry (`2eac4ec`) is proven by a unit test whose failure on the old code is structural, since the old function neither was exported nor returned a result. Reproducing the real trigger, a state lock held for more than 15 s, is impractical.
  - The orphan-marker cleanup is internal state with no behavioral test.

  Codex's re-review found no defect in either.
- About 4,145 `/tmp/codex-plugin-test-*`, 1,654 `/tmp/codex-companion/codex-plugin-test-*`, and 99 `~/.claude/plugins/data/codex-openai-codex/state/codex-plugin-test-*` stale dirs remain from before the cleanup fix. They are safe to delete; the human can run `find /tmp /tmp/codex-companion ~/.claude/plugins/data/codex-openai-codex/state -maxdepth 1 -name 'codex-plugin-test-*' -exec rm -rf {} +`, since Claude's bulk delete was blocked. New ones come only from Codex's sandboxed test runs, which share the host `/tmp`.
- The standalone Claude Code (`~/.config/Claude/claude-code/<version>/claude`) is signed in and defaults to auto mode after the live check.

## Do not destroy

- Branch `orchestration` (local and `origin`).
- `~/.cache/codex-companion-fork/`: dogfood state and ticket decision records.
- `~/.codex/packages/standalone/releases/0.144.1-*`: the CLI rollback target.
- Any `*.integration-journal` or `*.lock.recover` file while a companion process may run (none exist now).

## Recovery

- Restore this checkpoint: `git fetch origin && git checkout orchestration && git reset --hard origin/orchestration`. Check `git status` first.
- Return to upstream behavior: check out `main`. The installed marketplace plugin (`codex@openai-codex` 1.0.6) is unaffected.
- Stray test processes after an interrupted run: `RUNBOOK.md` → "Validate a change".
