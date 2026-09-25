# Checkpoint handoff

Operational recovery notes. This file is overwritten at each safe checkpoint; git history keeps the earlier versions. `PROJECT_STATUS.md` describes the system, `UPSTREAM_AUDIT.md` holds defect evidence, `IDEA_BANK_REVIEW.md` classifies the idea bank, and `RUNBOOK.md` holds validated procedures.

## Current checkpoint — 2026-09-24 ~23:45 EDT (usage-limit checkpoint)

- **Branch** `orchestration`, pushed. The checkpoint SHA is the commit containing this file (`git log -1`; verify with `git rev-parse HEAD origin/orchestration`). `main` is untouched and equals upstream `db52e28`.
- **Also pushed:** branch `wip/review-today-fixes` at `fded592`, based on `e5ee6fe`. It holds untested, unmerged fixes for review findings 1–5 (see below). It is *not* part of `orchestration`.
- **Working tree:** clean after this commit.
- **Validation at this checkpoint:** `npm test` 187/187, tsc clean. The final suite run left no new temp or state dirs, and there are no stray broker, worker, or app-server processes. `doctor` reports no failures; its only WARN is that `CODEX_COMPANION` is not exported in this shell.
- **Codex CLI:** the standalone `codex` is 0.156.1 (it was 0.144.1). The desktop app's `CODEX_CLI_PATH` is 0.155.0-alpha.16.4, and `doctor` reports OK. Roll back with `ln -sfn ~/.codex/packages/standalone/releases/0.144.1-x86_64-unknown-linux-musl ~/.codex/packages/standalone/current`.
- **Active processes:** none of ours. The desktop app's own `/usr/lib/chatgpt/resources/codex app-server` is unrelated.
- **Integration journals / `.recover` gates:** none.

## Real multi-turn resume test on Codex 0.156.1: PASSED

Ticket `retention` ran 2 turns on the same thread `01a0d68c-01d0-72b1-907a-eea1af232ff9`:
- The log shows "Resuming thread … Thread ready" with the same id.
- `threadHistory` is empty, so there was no fresh-thread fallback.
- App-server `thread/read` reports 2 completed turns.
- Turn 2 correctly fixed a defect in turn 1's own code from a short followup.

## Ticket state

- **`retention`: accepted and closed.** It was verified outside the sandbox (acceptance passed twice) and integrated. Committed as `e5ee6fe`, plus a lead fix in this checkpoint: `doctor` listed shared tickets' checkouts as retained worktrees. Its worktree and refs are removed.
- **`review-today`: OPEN, `needs-review`**. Do not purge it.
  - Role review, scratch worktree at `~/.cache/codex-companion-fork/state/codex-plugin-cc-d975f0e6e69b7c55/worktrees/review-today` (detached at `33ce8a4`), ref `refs/codex-companion/tickets/review-today/base`.
  - Thread `01a0d68c-05b5-7070-af4a-afa327c6f345`, 1 turn, no uncommitted changes of value in its worktree.
  - It reported 6 findings on the lead's changes `a7908ae..e76bf8a`. All 6 were judged valid (details in `UPSTREAM_AUDIT.md` → "Open: Codex review-today findings").

## Completed since the previous checkpoint (`33ce8a4`)

- `retention` (Codex): `show` degrades cleanly to the ticket record after job pruning, `doctor` lists retained closed-ticket worktrees, and `close --purge` on an already-purged ticket is truthful. Retention is otherwise measured bounded.
- The two-turn continuity test on 0.156.1 (above).
- The adversarial review of today's lead changes (`review-today`), with 6 findings recorded.
- Lead fix: the `doctor` retained-worktree false positive for shared tickets.

## In progress (not on `orchestration`)

Fixes for the review findings, on branch `wip/review-today-fixes` (`fded592`):
- **Drafted, 1–5:** `watch` claim→write→release plus a startup scan for this session; broker orphan-subagent ownership; gate pid and marker handling; `model/list` incomplete paging; SemVer identifiers. tsc is clean and the locking and doctor tests pass; the full suite has not been run.
- **Not started, 6:** before removing dirs, test cleanup must stop the live detached workers recorded in those dirs.
- **Missing:** regression tests for 1–6. Planned:
  1. A `watch` test with stdout failing, and one with a turn finished before the watcher starts.
  2. A broker test in the `subagent-late` fake mode with the turn held open. Change the fake so a turn completes after about 2 s and the child starts at about 700 ms. Client A starts a turn and leaves, client B streams, and A's child must be unsubscribed while B is still connected.
  3. A gate test with the current pid, and one with a null marker.
  4. A units test of the page cap.
  5. SemVer cases `ALPHA`/`alpha` and very large numbers.
  6. A helpers test with a detached child.

## Exact first action for the next Claude session

1. Read this file. Run `node plugins/codex/scripts/codex-companion.mjs doctor` with the dogfood env below and confirm there are no FAILs. Check `git status`, and `git rev-parse HEAD origin/orchestration`.
2. `git switch wip/review-today-fixes`. Finish fix 6, add the regression tests listed above (each must fail on `e5ee6fe`'s code), then run `npm test` and `npm run build`.
3. Merge into `orchestration` (fast-forward or rebase onto its tip), push, and delete the WIP branch.
4. `cx followup review-today "Fixes are in <sha> (…); re-review them for correctness"`. That reuses the review thread's context. Then close `review-today --accepted` with a reason.
5. After that, the roadmap is at: delegation metrics (only after real usage), then the optional foreground `/codex:rescue` via durable jobs (#738). Nothing else is pending.

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"
cx() { node "$CODEX_COMPANION" "$@"; }
```

## Known issues / unresolved

- The 6 open review findings above. Findings 1 and 2 are medium, and both are in live code on `orchestration` until the WIP merges. Their practical impact is low: a lost monitor line still gets a `wait` or the Stop reminder, and an orphan subagent claimed by another client is released when that client leaves.
- About 4,145 `/tmp/codex-plugin-test-*`, 1,654 `/tmp/codex-companion/codex-plugin-test-*`, and 99 `~/.claude/plugins/data/codex-openai-codex/state/codex-plugin-test-*` stale dirs remain. They are test-only and safe to delete. Claude's bulk delete was blocked by the permission classifier, so the human can run the `find … -exec rm -rf {} +` shown in chat. New ones now come only from Codex's sandboxed test runs, which share the host `/tmp`.
- The standalone Claude Code (`~/.config/Claude/claude-code/<version>/claude`) is signed in and defaults to auto mode after the live check.

## Do not destroy

- Branches `orchestration` and `wip/review-today-fixes` (local and `origin`).
- The `review-today` ticket, its scratch worktree, and `refs/codex-companion/tickets/review-today/base`, until it is closed.
- `~/.cache/codex-companion-fork/`: dogfood state and ticket decision records.
- `~/.codex/packages/standalone/releases/0.144.1-*`: the CLI rollback target.
- Any `*.integration-journal` or `*.lock.recover` file while a companion process may run (none exist now).

## Recovery

- Restore this checkpoint: `git fetch origin && git checkout orchestration && git reset --hard origin/orchestration`. Check `git status` first.
- The WIP is recoverable from `origin/wip/review-today-fixes` even if the local branch is lost.
- Return to upstream behavior: check out `main`. The installed marketplace plugin (`codex@openai-codex` 1.0.6) is unaffected.
- Stray test processes after an interrupted run: `RUNBOOK.md` → "Validate a change".
