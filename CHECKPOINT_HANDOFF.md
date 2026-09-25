# Checkpoint handoff

Operational recovery notes. This file is overwritten at each safe checkpoint; git history keeps the earlier versions. `PROJECT_STATUS.md` describes the system, and `UPSTREAM_AUDIT.md` holds the upstream defect evidence.

## Current checkpoint — 2026-09-25

- Branch `orchestration`, pushed to `origin` (ApexAiOfficial/codex-plugin-cc). `main` is untouched and equals upstream `db52e28`.
- Latest pushed checkpoint: `e741a6d`. The last code-validated checkpoint is `0222176` (164/164 tests, tsc clean).
- Working tree: clean apart from this file.
- **Active Codex tickets** (fork data dir `~/.cache/codex-companion-fork`; do not delete their worktrees):
  - `doctor`: implement, worktree `…/worktrees/doctor`; owns `lib/doctor.mjs`, `commands/doctor.md`, `codex-companion.mjs`, `tests/doctor.test.mjs`, `tests/commands.test.mjs`.
  - `linux-platform`: investigate, scratch worktree `…/worktrees/linux-platform`; report only.
- Validation at `ad935c8`: `npm test` 164/164, `npm run build` (tsc) clean, no stray broker/app-server/worker processes after a full run.

### Completed since the last handoff (`748cc16`)

- The first full dogfood cycle on real Codex 0.144.1, with 5 tickets. `unit-tests` found 3 real library bugs. `review-core` found 6 real defects, all fixed. `fix-integration` and `stock-fixes` were implemented by Codex, returned with evidence, and accepted after independent verification.
- An upstream audit of 17+ items; every disposition is in `UPSTREAM_AUDIT.md` with evidence. Substrate hardening landed in `a17c2d7`, `983435f`, `3476adc`, and `ad935c8`.
- A resume fallback for Codex threads that cannot be resumed (version skew between the CLI 0.144.1 and the desktop app's 0.155 sharing `~/.codex`). It was exercised on real Codex, and the continued turn's work was accepted.

### Dogfood environment

Run the fork's runtime with its own data dir, so the installed upstream plugin (active in normal Claude sessions) cannot touch fork tickets:

```bash
export CLAUDE_PLUGIN_DATA="$HOME/.cache/codex-companion-fork"
export CODEX_COMPANION="$PWD/plugins/codex/scripts/codex-companion.mjs"
node "$CODEX_COMPANION" tickets --all
```

## Roadmap (reconciled 2026-09-25)

These sources were reconciled: the pre-audit plan (`PROJECT_STATUS.md` at `748cc16` and this file's "Next" at that checkpoint), the original request to classify the 100-item idea bank, the upstream audit, dogfood findings, and the roadmap items added on 2026-09-25 (Linux reference platform, human-facing commands, RUNBOOK). The work is ordered by dependency and risk.

| # | Item | Why now / dependency | Lane |
| --- | --- | --- | --- |
| 1 ✅ `61a3d82` | README + CHANGELOG for the fork's public behavior (durable jobs, SessionEnd change, tickets via skill, new env vars) | Public behavior changed without docs; overdue | Claude |
| 2 ⏳ ticket `doctor` | `doctor` diagnostic (companion subcommand plus `/codex:doctor`): Codex binaries/versions and skew, auth, broker health and identity, workers and heartbeats, open tickets, registered vs recorded worktrees, leftover journals/refs/locks, state integrity, platform capability (start markers) | Prerequisite for runbook procedures; also the most useful human-facing command | Codex implement ticket (new module + tests) while Claude does item 1 |
| 3 ◐ `e741a6d` | `RUNBOOK.md`: only procedures pressure-tested with controlled fixtures (worker death, broker death, busy broker at SessionEnd, interrupted integration, resume fallback, state corruption, rollback) | Needs `doctor`; failure injection needs the host (Codex's sandbox cannot run app-servers) | Claude |
| 4 | Observe the monitor, SessionStart ledger, and Stop nudge live (`claude --plugin-dir plugins/codex`, and `claude -p` where headless suffices) | Only unit-tested so far | Claude, with the user for interactive checks |
| 5 ⏳ ticket `linux-platform` | Linux reference platform: evaluate `flock` (auto-release on death, removing stale-lock logic), pidfd (race-free signalling), inotify for `watch`, `/proc/pressure` for dispatch, child subreaper for worker trees; keep portable fallbacks | After the substrate stabilizes; no current Linux defect forces it | Codex investigate ticket (scratch worktree), then a Claude decision |
| 6 ✅ `efce6dd` | Classify the 100-item idea bank (already solved / adopted / adapted / rejected / deferred), with evidence | Original request; best done now that the architecture is stable | Claude |
| 7 | Retention of closed tickets, job history, and journals (ideas 48–49) | Unbounded growth, low urgency | Codex implement |
| 8 ✅ `0222176` | Type-check the new modules (extend `tsconfig.app-server.json`) | Maintainability | Codex implement |
| 9 | Model discovery via `model/list` (#638) and role-based model/effort guidance (ideas 50–52) | No hardcoded generations exist today | Later |
| 10 | Delegation metrics/telemetry (ideas 79–81) | Needs real usage first | Later |
| 11 | Route foreground `/codex:rescue` through durable jobs (#738) | The stock path is bounded by the Bash timeout | Later / optional |

Public command surface: add only `/codex:doctor` for now. `/codex:status` already shows tickets. The monitor is automatic. Delegation is Claude-facing through the `codex-delegation` skill, so `/codex:tickets`, `/codex:watch`, and `/codex:delegate` would duplicate existing surfaces. Revisit `/codex:handoff` after the RUNBOOK work.

## Exact next action

When `doctor` finishes: `verify doctor`, review the diff, `integrate doctor`, run `npm test` and `npm run build`, then close the ticket. Add a validated doctor section to `RUNBOOK.md` by running it against controlled bad states (corrupt state, a leftover journal, dead broker metadata). When `linux-platform` finishes, decide which Linux primitives to adopt and put them on the roadmap. Then continue with items 4 and 7.

## Do not destroy

- Branch `orchestration` (local and `origin`).
- `~/.cache/codex-companion-fork/`: fork dogfood state and ticket history (all tickets are closed).
- Any `*.integration-journal` directory next to a ticket worktree. It is recovery data for an interrupted integration; `integrate` recovers it automatically.

## Known issues / unresolved

- Codex CLI 0.144.1 cannot resume some threads (`paginated_threads is not supported yet`) while the desktop app's Codex 0.155 shares `~/.codex`. The fallback handles it, but the user may want to update the CLI or set `CODEX_COMPANION_CODEX_BIN`.
- `close <ticket> --purge` on an already-closed ticket prints "Removed the retained worktree" even when nothing remained (cosmetic).
- `~/.claude/plugins/data/codex-openai-codex/state/codex-plugin-test-*` holds stale test state from runs before the suite was made hermetic. It is safe to delete and has not been deleted yet.

## Recovery

- Restore this checkpoint: `git fetch origin && git checkout orchestration && git reset --hard ad935c8`. Check `git status` first, since the reset discards local changes.
- Return to upstream behavior: check out `main`. The installed marketplace plugin (`codex@openai-codex` 1.0.6) is upstream and unaffected.
- Stray processes after an interrupted test run: `ps -eo pid,cmd | grep -E 'app-server-broker.mjs serve|codex-plugin-test'`, then kill those pids. These are test-only processes in temp dirs.
