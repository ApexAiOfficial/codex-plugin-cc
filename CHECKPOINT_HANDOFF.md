# Checkpoint handoff

Operational recovery notes. This file is overwritten at each safe checkpoint; git history keeps the earlier versions. `PROJECT_STATUS.md` describes the system, `UPSTREAM_AUDIT.md` holds the upstream defect evidence, `IDEA_BANK_REVIEW.md` classifies the 100-item idea bank, and `RUNBOOK.md` holds validated procedures.

## Current checkpoint — 2026-09-24 22:45 EDT (model discovery added)

- **Branch** `orchestration`, pushed to `origin` (ApexAiOfficial/codex-plugin-cc). `main` is untouched and equals upstream `db52e28`.
- **Latest code checkpoint:** the commit containing this file (`git log -1`). Earlier today: `54f68d3` (monitor fix), `4fe8ccb` (Linux-tier decisions), `ec5025d` (Codex 0.156.1).
- **Validation:** `npm test` is 183/183 and tsc is clean. The drills pass (`tests/drills/broker-drill.mjs`, `sandbox-containment-drill.mjs`). A full run leaves no stray processes and no temp or state dirs (measured).
- **Codex CLI:** the standalone `codex` is 0.156.1 (it was 0.144.1). The desktop app's `CODEX_CLI_PATH` is 0.155.0-alpha.16.4. `doctor` reports OK (companion newer). Roll back with `ln -sfn ~/.codex/packages/standalone/releases/0.144.1-x86_64-unknown-linux-musl ~/.codex/packages/standalone/current`.
- **Codex account:** usage limit hit at 21:20 EDT; Codex says to retry at 23:10 EDT.
- **Tickets:** none open in the dogfood state (`~/.cache/codex-companion-fork`).
- **Live check:** done and cleaned up. The workspace, its `codex-inline` state, and the backgrounded session are all removed or stopped. The transcripts remain under `~/.claude/projects/-home-logan--cache-codex-companion-live-check-repo/`.

## Completed since the last handoff

- **Codex version skew resolved** by `codex update`, after a measured side-by-side test. `doctor` is now direction-aware, and a ticket's quota/auth error text shows on the card.
- **Broker drills on real processes:** all four recovery cases pass.
- **Linux tier:** cgroup/systemd containment dropped (Codex's bwrap pid namespace already contains commands; measured). `flock` deferred. The recovery gate records a start marker.
- **Interactive live check (the human ran it):** the ledger, the Stop nudge, the monitor, and `/codex:doctor` all pass. It found that the **monitor never armed** (`on-skill-invoke` matches the namespaced skill name exactly); fixed and re-verified live.
- **The "flaky" broker test was a real leak:** a subagent thread started after its parent's last client left was never unsubscribed. Fixed, with a deterministic test that fails on the old code.
- **Test hygiene:** the suite no longer leaks about 300 temp and state dirs per run.
- **Model discovery (#638):** `preflight` lists the models and efforts, and ticket `--model`/`--effort` are validated before a turn runs. Verified against real Codex 0.156.1.

## Next-work order (start at the top)

1. **Real multi-turn ticket on Codex 0.156.1, after 23:10 EDT.** Use it for real work: retention (item 2) as a two-turn implement ticket whose second turn depends on the first. Confirm that the `threadId` is unchanged and there is no `threadHistory` reset.
2. **Retention** of closed tickets, job history, and journals (ideas 48–49).
3. **Delegation metrics** (ideas 79–81), only after real usage.
4. Optional: route a foreground `/codex:rescue` through durable jobs (#738).

## Exact first action after compaction

Read this file. Run `node plugins/codex/scripts/codex-companion.mjs doctor` with the dogfood env below and confirm there are no FAILs. Then continue from the top of the list above. Check the time against the Codex reset (23:10 EDT on 2026-09-24).

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"
```

## Known issues / unresolved

- The broker subagent-release test's flakiness was the late-subagent leak fixed in this checkpoint. If it ever fails again, that is a new defect.
- `close --purge` on an already-purged ticket still prints "Removed the retained worktree" (cosmetic).
- Stale dirs from test runs before the cleanup fix remain: about 4,100 `/tmp/codex-plugin-test-*`, about 1,650 `/tmp/codex-companion/codex-plugin-test-*`, and 99 `~/.claude/plugins/data/codex-openai-codex/state/codex-plugin-test-*`. They are safe to delete. Claude's bulk delete in `/tmp` was blocked by the permission classifier, so this is left to the human.
- The standalone Claude Code (`~/.config/Claude/claude-code/<version>/claude`) is now signed in and was switched to auto mode during the live check.

## Do not destroy

- Branch `orchestration` (local and `origin`).
- `~/.cache/codex-companion-fork/`: fork dogfood state and ticket history (decision records).
- `~/.codex/packages/standalone/releases/0.144.1-*`: the rollback target for the CLI.
- Any `*.integration-journal` or `*.lock.recover` file, while any companion process may be running.

## Recovery

- Restore this checkpoint: `git fetch origin && git checkout orchestration && git reset --hard <sha>`. Check `git status` first, since the reset discards local changes.
- Return to upstream behavior: check out `main`. The installed marketplace plugin (`codex@openai-codex` 1.0.6) is upstream and unaffected.
- Stray test processes after an interrupted run: see `RUNBOOK.md` → "Validate a change".
