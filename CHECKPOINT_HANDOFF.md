# Checkpoint handoff

Operational recovery notes. This file is overwritten at each safe checkpoint; git history keeps the earlier versions. For architecture and rationale, see `PROJECT_STATUS.md`.

## Current checkpoint — 2026-09-24

- Branch: `orchestration`, pushed to `origin` (ApexAiOfficial/codex-plugin-cc). `main` is untouched and equals upstream `db52e28`.
- Code checkpoint commit: `748cc16`. This handoff is committed immediately on top of it.
- Working tree: clean apart from this file at the time of writing. No intentional uncommitted work.

### Completed (all on `orchestration`)

1. `dd963e0`: durable tickets, concurrency-safe state, evidence, isolation, steering, the delegation skill, monitor, and hooks.
2. `084b6f8`: test harness no longer leaks detached brokers (this caused memory exhaustion and a machine freeze during repeated test runs); typecheck fix.
3. `edcb5b0`: fixes found by real-sandbox dogfooding (tool probing under EPERM, scratch worktrees for investigate/review, direct-only preflight).
4. `748cc16`: `PROJECT_STATUS.md`; overlap prediction skips scratch tickets.

### Tests and checks at `748cc16`

- `npm test`: 112/112 pass (about 80s). `node --test tests/orchestration.test.mjs`: 21/21.
- `npm run build`: passes.
- No stray processes after a full run (`ps -eo cmd | grep -E 'app-server-broker.mjs|codex-plugin-test'`).
- Real Codex 0.144.1 preflight on this repo: tools runnable in the sandbox; limitations are network and Docker daemon only.

### In progress: live Codex dogfood tickets

These tickets ran through the fork's runtime with a separate data dir, `CLAUDE_PLUGIN_DATA=$HOME/.cache/codex-companion-fork`. The separate dir keeps the upstream plugin active in the lead's session from touching them.

| Ticket | Role / isolation | Job | Codex thread | Worktree |
| --- | --- | --- | --- | --- |
| `review-core` | review, scratch worktree | `ticket-mug34bot-7gvqig` | `01a0d577-b8d8-7a21-a0c2-df80892d2098` | `~/.cache/codex-companion-fork/state/codex-plugin-cc-d975f0e6e69b7c55/worktrees/review-core` |
| `unit-tests` | implement, worktree; owns `tests/orchestration-units.test.mjs` | `ticket-mug34c9l-p68vqa` | `01a0d577-bf41-72d1-9b6e-4fcdc2d0f0dd` | `…/worktrees/unit-tests` |

Inspect them with:

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
node plugins/codex/scripts/codex-companion.mjs tickets --all
node plugins/codex/scripts/codex-companion.mjs show review-core
```

### Next

1. Review `review-core` findings; fix whatever is confirmed (Claude owns the fixes).
2. `verify unit-tests`, read its diff in the worktree, `integrate unit-tests`, run `npm test`, then close both tickets with reasons.
3. Record the dogfood observations in `PROJECT_STATUS.md`.
4. Exercise the fork as the active plugin (`claude --plugin-dir plugins/codex`) to observe the monitor, SessionStart ledger, and Stop nudge live.

### Do not destroy

- Branch `orchestration` (local and `origin`).
- `~/.cache/codex-companion-fork/`: fork dogfood state, including open tickets and their worktrees.
- Refs `refs/codex-companion/tickets/*` in this repository. They pin ticket base and integration commits; `close` removes them.
- Registered git worktrees: `git worktree list` shows the ticket worktrees. Remove them only through `close … --purge`, not `rm -rf`, which leaves stale worktree metadata.

### Unresolved

- The ticket record only learns its Codex thread ID when a turn finishes (the running job file has it). `show` on a running ticket should display it.
- `~/.claude/plugins/data/codex-openai-codex/state/` holds `codex-plugin-test-*` directories written by test runs before the suite was made hermetic. They are safe to delete; they have not been deleted yet.

### Recovery

- Restore this checkpoint: `git fetch origin && git checkout orchestration && git reset --hard 748cc16`. `git reset --hard` discards local changes, so check `git status` first.
- Return to upstream behavior: check out `main`. The installed marketplace plugin (`codex@openai-codex` 1.0.6) is upstream and unaffected by this branch.
- Stuck ticket: `cancel <ticket>` interrupts it gracefully, then kills the identity-checked process. A dead worker is reconciled automatically as `worker-lost`, and `followup <ticket>` continues the same thread.
