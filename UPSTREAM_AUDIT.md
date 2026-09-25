# Upstream defect audit

This audit checks open issues and PRs on [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) (main is still `db52e28`) against this fork. Each item was inspected against our code, then reproduced or verified where practical. "Commit" is the fork commit on `orchestration` that carries the fix and its regression test. Upstream patches served as evidence and were not merged.

## Runtime / transport / broker

| Upstream | Defect | Disposition | Evidence and fork change | Commit |
| --- | --- | --- | --- | --- |
| #581 | Buffered `thread/started` dropped before the turn id is known | **Fixed** (found independently) | This caused a flaky subagent-naming test (1/5 failures). Buffered replay now passes thread metadata through; a 12-run stress test had 0 failures. | `dd963e0` |
| #460 | Concurrent `state.json` read-modify-write | **Fixed differently, stronger** | Reproduced: with 6 writers, 23 of 50 expected jobs were indexed and 17 of those had their files deleted. Fixed with a cross-process lock, atomic writes, corruption rebuild, and prune protection. Test: concurrent writers. | `dd963e0` |
| #439 | Family of multi-session state/broker/identity/cancel failures | **Partially solved** | Covered by locking, pid identity, durable jobs, graceful cancel, and serialized broker acquisition. The 19 findings were not re-audited one by one. | several |
| #355 | SessionEnd kills detached background work | **Fixed differently** | Workers own private app-servers, and SessionEnd no longer kills or deletes jobs. A test checks that a worker survives SessionEnd. Also fixed: SessionEnd fires on `/clear` and resume. | `dd963e0` |
| #475 | `--resume-last` ambiguous with concurrent jobs | **Solved differently** | Tickets map a name to a persistent thread. Stock `task --resume-last` stays session-scoped and ignores ticket threads. | `dd963e0` |
| #662 | Launch-before-durable-state, cancel resurrection, dead workers | **Fixed differently** | Persist-before-bind/spawn transaction, cancel wins over late completion, worker-lost reconciliation, per-ticket operation lock. Found independently by the `review-core` ticket; tests exist for each. Stop-review concurrency was not examined. | `3864ca2` |
| #738 | Background rescue durability | **Partially solved** | `task --background` workers are durable. A foreground `/codex:rescue` running inside a subagent's Bash call is still bounded by Bash's timeout (it becomes `worker-lost`, not stuck). Deferred: tickets are the durable path. | `dd963e0` |
| #706 / #707 | Broker never unsubscribes threads, so finished threads and MCP runtimes accumulate | **Fixed differently, simpler** | Per-socket thread ownership, subagents inherit parent owners, `thread/unsubscribe` when the last owner leaves, and requests wait (bounded) for an in-flight unsubscribe. Our broker already serializes active requests, so most of #707's race machinery is unneeded. Tests: release incl. subagent; shared thread. | `a17c2d7` |
| #302 | Unbounded RPC and turn waits | **Fixed differently** | Bounded RPC timeout (method-aware, env-overridable), and dead connections fail fast. The turn watchdog probes `thread/read` instead of using a silence timeout. #302's 240s idle timeout would kill legitimate silent turns (reasoning and command-output deltas are opted out). It recovers lost completions. 5 tests. | `a17c2d7` |
| #453 | Zombie broker after its app-server dies | **Fixed** | The broker exits when its child exits, guarded against intentional shutdown. Test: kill the child, then the next caller gets a healthy broker. | `a17c2d7` |
| #762 + #768 | Teardown orphans brokers; a 150 ms probe declares live brokers dead | **Fixed together** | Serialized acquisition, 3 s probe, a live broker is never torn down (the caller uses a private app-server), metadata is cleared only for provably dead processes, and only a just-spawned, never-ready broker is killed (identity-checked). Tests: busy broker kept, dead broker replaced, concurrent callers share one broker. | `a17c2d7` |
| #381 / #457 | Session-unaware broker shutdown; no idle exit | **Fixed differently** | Per-workspace broker with `broker/shutdown {ifIdle}`: SessionEnd of one session cannot kill a broker another session is using, and an idle broker exits after 30 min. 2 tests. | `983435f` |
| #343 / #404 | Stale-broker cleanup, readiness/startup race | **Covered** by the #762/#768 design | | `a17c2d7` |

## Task path / results / privilege

| Upstream | Defect | Disposition | Evidence and fork change | Commit |
| --- | --- | --- | --- | --- |
| #393 / #574 RC1 | Missing cwd reported as "Codex not installed" | **Fixed** | Probes fall back when the cwd is missing. Implemented by the `stock-fixes` ticket. | `ad935c8` |
| #393 / #574 RC2 | Prompt text parsed as flags (`-m pytest` becomes the model) | **Fixed, narrower** | The boundary applies only to single raw-string input. Codex's first attempt applied it everywhere and broke 17 tests; it was returned with evidence and fixed. | `ad935c8` |
| #574 RC3 | Turn error ignored when completion is inferred | **Fixed differently** | The upstream fix (any error fails the turn) is wrong: `error` notifications carry `willRetry`. Only non-retryable errors fail. Test covers both. | `a17c2d7` |
| #775 | `fileChange` start without `changes` throws | **Fixed** | Test. | `a17c2d7` |
| #757 / #763 | Failed turn stores no `errorMessage`; summary `{` | **Fixed** | Implemented by the `stock-fixes` ticket; tests. | `ad935c8` |
| #740 / #742 | Sandbox change on live `thread/resume` ignored | **Reproduced with real Codex 0.144.1, fixed** | Live resume kept the old sandbox both ways; a write-capable thread stayed writable after a read-only resume. A per-turn `sandboxPolicy` is honored, but it persists to later turns. Every turn now sends an explicit policy. Test. | `a17c2d7` |

## Deferred / reference only

| Upstream | Disposition |
| --- | --- |
| #638 (GPT-5.6 models, efforts, prompting) | **Solved differently.** Nothing is hardcoded. On Codex 0.156.1, `model/list` reports the models (currently gpt-6-astra/sol/luna, gpt-5.6-*, gpt-5.5) and each model's efforts, up to `ultra`. `preflight` shows them, and ticket `--model`/`--effort` are validated against them before a turn runs. The stock `task` path is unchanged. |
| #586 (sharded parallel review) | **Not adopted.** Its workarounds (staggered launches, supervision) exist because of the substrate defects fixed above; tickets cover parallel review generically. |

## Defects found by dogfooding (not reported upstream)

| Defect | Fork change | Commit |
| --- | --- | --- |
| Codex CLI 0.144.1 cannot resume threads in a store shared with the desktop app's 0.155 (`paginated_threads is not supported yet`) | `CODEX_COMPANION_CODEX_BIN`; tickets continue on a fresh thread with a handoff of earlier turns. Exercised on real Codex. The failure only occurs when the companion is the older binary: 0.155-alpha and 0.156.1 resume the failing thread. Resolved here by updating the CLI to 0.156.1, and `doctor` now warns only in that direction. | `3476adc`, this checkpoint |
| In the Codex sandbox, `spawnSync` reports EPERM and Node children lose stdout | Preflight detects and reports it, so the lead's `verify` stays authoritative. | `edcb5b0`, `3864ca2` |
| Test suite leaked detached brokers (about 100 MB per test); repeated runs froze the dev machine | Harness stops brokers on exit and on signals. | `084b6f8`, `a17c2d7` |
| Same-process async lock holders broke each other's lock | Async holders tracked in-process. | `a17c2d7` |
| Stale-lock recovery admitted several holders at once (reproduced by the `linux-platform` ticket: up to 14 of 32 processes) | Recovery serialized through a `.recover` gate with a re-check; an abandoned gate fails closed; deterministic regression test | `bbc7640` |
| Claim checks flagged honest failed-then-rerun claims | A claim is consistent if any matching run agrees. | `f269ceb` |
| A ticket turn stopped by usage limits recorded no `errorMessage`, and its card hid Codex's reset time (observed on a real quota hit) | Codex's error text is persisted on the job and shown on the card | `ec5025d` |
| Ticket monitor never armed: `on-skill-invoke` matches the dispatched, plugin-namespaced skill name exactly (found by the interactive live check) | Both name forms are registered, and `watch` claims notifications so watchers never double-notify | `54f68d3` |
| Broker leaked a subagent thread whose `thread/started` arrived after its parent's last client disconnected (the "flaky" broker test; recurred under load) | An unowned new thread is released immediately; a deterministic late-subagent test fails on the old code | this checkpoint |
| Test suite leaked about 300 temp and state dirs per run | Temp dirs and their state dirs are removed on exit | this checkpoint |
