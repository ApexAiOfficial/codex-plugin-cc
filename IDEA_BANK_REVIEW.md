# Idea bank review

Classification of the 100-item orchestration idea bank against what the fork actually does (branch `orchestration`, 2026-09-25). "Adopted" means implemented as described, "adapted" means implemented in a different or narrower form, and "deferred" items are on the roadmap in `CHECKPOINT_HANDOFF.md`.

| # | Idea | Disposition | Where / why |
| --- | --- | --- | --- |
| 1 | Claude-native worker interface | Adopted | Ticket commands via `$CODEX_COMPANION`, taught by the `codex-delegation` skill |
| 2 | Durable engineering jobs | Adopted | Tickets; workers on private app-servers survive session end |
| 3 | Concurrency-safe state | Adopted | `locking.mjs`, `state.mjs` (race reproduced and fixed) |
| 4 | Capability-aware routing | Adopted | Sandbox-measured `preflight` plus skill routing rules |
| 5 | Structured work-package contracts | Adopted | `prompts/work-package.md`, `schemas/work-report.schema.json` |
| 6 | Isolated parallel writers | Adopted | `--isolation worktree` |
| 7 | Evidence-based acceptance | Adopted | Snapshots, ownership checks, claim checks, `verify` |
| 8 | Event-driven completion | Adopted | Plugin monitor, background `wait`, Stop nudge (all three verified in a live session) |
| 9 | Dependency-aware DAG scheduling | Deferred | Claude sequences tickets; no workload has needed a DAG executor |
| 10 | Independent peer modes | Adopted | `investigate` / `review` roles, scratch worktrees |
| 11 | Mid-flight steering | Adopted | `steer` via `turn/steer` |
| 12 | Logical worker handles | Adopted | A ticket spans turns, jobs, and even thread resets |
| 13 | Failure-return loop | Adopted | `followup` with auto-attached verify output (proven twice in dogfood) |
| 14 | Changed-file ownership enforcement | Adopted | `--owns`, violations on card and in `verify` |
| 15 | Semantic / interface ownership | Adapted | `--interface` is declared in the contract, not mechanically enforced |
| 16 | Deterministic integration controller | Adopted | `integrate` (journaled, symlink-safe) |
| 17 | Package-level verification | Adopted | Acceptance commands run in the worktree |
| 18 | Combined integration verification | Adapted | `verify` runs in the checkout after integration; Claude runs suites |
| 19 | Risk-triggered review | Adapted | Skill guidance plus the `review` role |
| 20 | Bounded worker pool | Adopted | `setup --max-parallel` (default 3) |
| 21 | Coordination-cost heuristic | Adopted | The skill's "decide whether to delegate" rules |
| 22 | Critical-path-aware delegation | Adopted | Skill guidance |
| 23 | Worker liveness and heartbeats | Adopted | pid identity, heartbeat file, turn watchdog (`thread/read`) |
| 24 | Process-identity-safe termination | Adopted | Four-state identity; kills fail closed |
| 25 | Low-context progress telemetry | Adopted | `show` on a running ticket |
| 26 | Drill-down traces | Adopted | `show`, `--commands`, `--command N`, `--prompt` |
| 27 | Persistent execution evidence | Adopted | Job payload plus trace file |
| 28 | Clean blocker protocol | Adopted | `blocker_protocol` and blocker kinds |
| 29 | Capability profiles | Adapted | read-only / write / write+network / scratch |
| 30 | Fail-closed privilege escalation | Adopted | Explicit `--network`; explicit sandbox policy on every turn |
| 31 | Workspace leases | Adapted | Per-ticket operation lock plus active-job binding; no expiring leases |
| 32 | Dead-job reconciliation | Adopted | `worker-lost` (drilled on real processes) |
| 33 | Crash-safe state writes | Adopted | Atomic write-and-rename |
| 34 | State-schema versioning | Adapted | Version fields and normalization; no migration framework yet |
| 35 | Project-level state | Adopted | Per-repository state dir |
| 36 | Explicit task-identity resume | Adopted | Tickets |
| 37 | Parallel read-only investigation | Adopted | Investigate tickets |
| 38 | Competing prototypes | Adopted | Guidance; worktree implement tickets |
| 39 | Implementer / reviewer separation | Adopted | Separate review tickets (`review-core` found 6 defects) |
| 40 | Package-scoped failure isolation | Adopted | Tickets are independent |
| 41 | Optional work packages | Unnecessary | Without a DAG, Claude simply does not wait on optional tickets |
| 42 | Rich outcome states | Adopted | 11 outcome classes |
| 43 | Executable acceptance criteria | Adopted | `--accept` |
| 44 | Controller-owned commit normalization | Adapted | Codex cannot commit (`.git` read-only); integration writes the working tree and Claude commits |
| 45 | Isolated integration worktree | Rejected for now | A per-file three-way merge with atomic abort plus journal is simpler; revisit if conflicts become common |
| 46 | Safe final application | Adapted | Index never touched, HEAD-moved warning, conflict abort |
| 47 | Failed-artifact preservation | Adopted | Rejected/abandoned tickets keep worktrees; journals are kept |
| 48 | Success-aware cleanup | Adopted | Accepting removes the worktree and refs |
| 49 | Retention policy | Deferred | Roadmap 7 |
| 50–52 | Model / effort routing, escalation, discovery | Adapted | Discovery and validation via `model/list` (`models.mjs`). Routing is skill guidance (default config; raise effort for hard packages; avoid `ultra` unless asked), not an automatic router |
| 53 | Agent-budget accounting | Adapted | Subagent count recorded; not budgeted |
| 54 | Native child-agent awareness | Adapted | Subagent tracking in capture and in broker ownership |
| 55 | Recursion limits | Unnecessary | Codex's own configuration bounds its subagents; tickets cannot spawn tickets |
| 56 | Automatic orchestration threshold | Adopted (conservative) | Skill trigger plus decision rules |
| 57 | Explicit orchestration override | Adopted | Ask Claude to delegate (or not); `/codex:rescue` remains |
| 58 | Simple user experience | Adopted | No new commands besides `/codex:doctor` |
| 59 | Minimal public command vocabulary | Adopted | See roadmap command decision |
| 60 | One abstraction, many strategies | Adopted | Tickets × roles × isolation |
| 61 | Declarative execution plans | Rejected for now | No DAG executor (see 9) |
| 62 | Pre-execution plan validation | Adapted | `delegate` validates role, isolation, limits, overlap |
| 63 | Controlled replanning | Unnecessary as a mechanism | Claude's judgment at each turn boundary |
| 64 | Package circuit breakers | Adapted | Warning from turn 4 onward; no automatic stop |
| 65 | Retry budgets | Adapted | Outcomes separate quota/transient from bad work; no automatic retries |
| 66 | Timeout policies | Adopted | RPC timeout, acceptance timeout, turn watchdog |
| 67 | Graceful cancellation | Adopted | Interrupt through the worker, then an identity-checked kill |
| 68–69 | Cross-platform lifecycle / paths | Partial | Windows paths exist (command-line identity, junctions) but are untested |
| 70 | External-capability requirements | Adapted | Preflight plus routing rules instead of per-ticket `--needs` |
| 71 | Environment preflight | Adopted | `preflight` (caught 2 real sandbox quirks) |
| 72–75 | Direct repo context, progressive disclosure, lean and role-specific prompts | Adopted | Skill and references; the contract wraps the brief |
| 76 | Resume handoff summaries | Adopted | Fresh-thread handoff (driven by a real dogfood failure) |
| 77 | Claude compaction resilience | Adopted | SessionStart ledger; durable tickets |
| 78 | Repository as source of truth | Adopted | Principle in docs and skill |
| 79–81 | Metrics, failure telemetry, experience-based routing | Deferred | Roadmap 10; outcomes and decision records are already captured |
| 82 | Keep routing explainable | Adopted | Deterministic heuristics only |
| 83–84 | Dogfooding; controlled self-improvement | Adopted | 6 real tickets; every accepted change independently verified |
| 85–86 | Upstream-compatible boundary; modular components | Adopted | Orchestration in separate modules; substrate fixes minimal |
| 87 | Experimental feature flags | Unnecessary so far | The monitor starts only on skill use; behavior knobs are env vars |
| 88 | Stock-path fallback | Adopted | Stock commands keep working unchanged |
| 89 | Runtime health diagnostics | Adopted | `doctor` / `/codex:doctor` (read-only, pressure-tested) |
| 90 | Benchmark suite | Deferred | After metrics exist |
| 91 | Resource-pressure awareness | Deferred | Linux PSI judged an optimization, not a correctness need |
| 92 | Rate-limit / quota awareness | Adopted | `quota` outcome; the thread persists for a later followup |
| 93 | Fair worker scheduling | Unnecessary | At most 3 concurrent tickets |
| 94 | Speculative work with cancellation | Adopted | `cancel` plus guidance |
| 95 | Stale-result detection | Adapted | HEAD-moved warning; merge against the current checkout |
| 96 | Conflict prediction before dispatch | Adopted | Ownership-overlap warning (implement tickets only) |
| 97 | Integration decision records | Adopted | `close --reason` |
| 98 | User-intent invariant | Adopted as guidance | Claude owns scope; the contract forbids scope creep |
| 99 | Quality over utilization | Adopted | The skill treats "no delegation" as a valid outcome |
| 100 | Critical-path throughput metric | Deferred | Needs metrics (79–81) |
