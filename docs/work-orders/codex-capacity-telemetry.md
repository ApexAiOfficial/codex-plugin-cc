# Work order: Codex capacity telemetry (deferred, next planned feature)

Status: **not started.** It was deferred on 2026-09-25 at the human's request, at a Claude usage limit, before any implementation. No code exists for it. This file preserves the work order so the next session does not have to rediscover it. It condenses the human's original work order; every requirement is kept.

## Goal

Codex already knows its own account limits and per-thread context usage. Expose that native information through codex-plugin-cc, accurately, durably, cheaply, and machine-readably. A separate, future standalone Claude limit/context guard must be able to consume it without scraping output or knowing Codex's session format.

It is a small, targeted extension of the existing app-server, broker, job-tracking, and state plumbing. It is not a resource manager, a scheduler, or cross-provider orchestration. Claude is the lead, integrator, verifier, and acceptance authority. Use Codex where it helps (protocol investigation, disjoint tests, adversarial review), not for its own sake.

## Native protocol surfaces (identified; shapes still to verify against the installed Codex)

- `account/rateLimits/read`: a no-model RPC for the initial snapshot. Expected response: `accountId`, `ordinaryUsageAllowed`, `rateLimits`, `rateLimitsByLimitId` (the generic multi-bucket form), `rateLimitResetCredits`, and possibly more.
- `account/rateLimits/updated`: a **sparse** rolling notification, expected to carry a `RateLimitSnapshot` rather than a full response.
  - A `RateLimitSnapshot` is expected to carry `limitId`, `limitName`, `normalModelSlug`, `primary`, `secondary`, `credits`, `individualLimit`, `planType`, `spendControlReached`, `rateLimitReachedType`, and possibly more.
  - A window is expected to carry `usedPercent`, `windowDurationMins`, and `resetsAt`.
- `thread/tokenUsage/updated`: `threadId`, `turnId`, and `tokenUsage { total, last, modelContextWindow }`. The breakdowns carry `inputTokens`, `cachedInputTokens`, `cacheWriteInputTokens`, `outputTokens`, `reasoningOutputTokens`, and `totalTokens`.

Use the generated protocol types of the current install (`codex app-server generate-ts`) and import them into `app-server-protocol.d.ts`; do not duplicate schemas.

## Critical correctness rule

**Never compute context pressure from cumulative or lifetime thread totals.** `tokenUsage.total` is a cumulative ledger and can far exceed the context window. `total.totalTokens / modelContextWindow` is wrong everywhere.

Keep three things distinct: cumulative usage, latest/active-context usage, and the model's context-window size.
- Prove from the current Codex implementation which native fields mean active context: the schema, the Codex core token-usage code, its tests, and one cheap real turn if needed. Do not infer from names.
- If the percentage has to be calculated, document the native semantics that justify the calculation and regression-test it.
- Always keep the raw native fields next to any derived value.
- If the semantics cannot be proven, store the raw fields and mark the context value unknown. **Never fabricate a percentage.**

## Requirements

1. **Account limits.**
   - Take the initial snapshot with `account/rateLimits/read`, added to the typed request map narrowly.
   - Prefer `rateLimitsByLimitId`, and keep the native IDs.
   - Never hardcode "primary = 5 h, secondary = weekly". Duration aliases are for display only: 300 min = 5h, 10080 min = 7d, and any other duration stays as it is.
   - Never invent model-to-limit mappings. Keep only what Codex supplies (`limitId`, `limitName`, `normalModelSlug`).
   - Unknown IDs and fields must degrade safely.
2. **Sparse updates.**
   - Merge a rolling update into the last complete snapshot, or refetch it. An update must never erase other buckets, account metadata, secondary windows, or fields that were merely omitted.
   - If `accountId` changes, drop the previous account's buckets.
   - A malformed or identity-ambiguous update fails safe.
3. **Unavailable limits.** For an old Codex, missing auth, an RPC error, malformed data, or no limits: plugin operations keep working, telemetry says unavailable, and there are no fabricated `0%` values.
4. **Per-thread context.** Persist `thread/tokenUsage/updated` for at least the root thread of every tracked job or ticket. Keep:
   - `threadId`, `turnId`, and the `jobId`/`ticketId` when known
   - the model, only when Codex or runtime metadata supplies it
   - the raw `total`, the raw `last`, and `modelContextWindow`
   - the derived used, used-percent, and remaining-percent values, only if proven
   - `observedAt` and `source`

   Subagents are optional. Attribute one to a job only on explicit `thread/started.parentThreadId` evidence. No subagent accounting project.
5. **Persisted snapshot.** A small, schema-versioned artifact from one normalization and persistence module (for example `lib/capacity.mjs`). It must be:
   - concurrency-safe, using the existing locks and atomic writes
   - tolerant of corrupt or missing state
   - free of secrets
   - bounded (not one record per historical thread forever)
   - durable across Claude restarts, and cheap to read

   Weigh first that account data is account-global while thread data is workspace/thread-specific, and that many processes write: the shared broker, direct clients, ticket workers, task workers, and status/setup.
6. **Freshness.** Every record carries `observedAt` (and `source`) and one of `fresh`, `stale`, `unavailable`, or `unknown`.
   - Prefer evidence-based staleness: a reset time that passed without a newer snapshot, an account change, a running job with no telemetry yet, or a thread whose job no longer exists.
   - Any time threshold must be explicit, centralized, tested, and documented.
   - Missing data never becomes zero.
7. **Transport.**
   - Hook narrowly into `codex.mjs` turn capture. Keep the existing `tokenUsage` return value for compatibility, and never reinterpret the cumulative ticket `payload.tokenUsage` as context.
   - Check whether the broker drops account notifications when there is no active socket, and add the smallest safe hook if so. Do not disturb thread ownership or unsubscribe routing, and do not rewrite the broker.
   - Direct/private workers (`disableBroker: true`) must contribute too.
   - Avoid triplicated logic.
8. **Thread ↔ job association.** Reuse the existing job and ticket identity: pass explicit context into the run, or reconcile `threadId → job` on read. Test a first token update that arrives close to association, a resumed ticket thread, and a direct worker.
9. **Status.**
   - `/codex:status --json` gets a stable capacity section, so there is no scraping.
   - Document the persisted file location, or provide a resolver.
   - The human status stays concise: native IDs and durations, aliases only for recognized durations, and context shown only when accurately known.
   - No new public slash command unless recon proves one is needed.
10. **Safety and compatibility.**
    - Never persist or log tokens, keys, headers, or config objects. An opaque `accountId` is acceptable for detecting account switches.
    - Telemetry is advisory: a capture or write failure must never fail a review, task, ticket, broker, or session.
    - Every existing command and flow keeps working.

## Tests required (use the existing fakes: `fake-codex-fixture.mjs`, `substrate-fake.mjs`)

| Area | Cases |
| --- | --- |
| Protocol | typed `account/rateLimits/read`; an unsupported method degrades gracefully |
| Initial account snapshot | one limit; several buckets; unknown IDs; missing fields |
| Windows | 300 → 5h, 10080 → 7d, arbitrary durations kept; no primary/secondary assumption |
| Sparse merge | a one-bucket update keeps the others; omitted fields do not clear; an account switch drops old buckets; a malformed update fails safe |
| Thread telemetry | raw `total`, `last`, and window preserved; root thread tied to the correct job; resumed ticket; model only when known |
| **Context regression** | `total.totalTokens = 2,000,000` with `modelContextWindow = 258,400` and latest usage well below the window: the percentage follows the latest context, not the total |
| Compaction | a newer post-compaction observation replaces occupancy; no monotonic accumulation |
| Freshness | fresh, stale, missing, and passed-reset cases; never zero |
| Paths | the broker path does not lose account data, and the existing orphan and unsubscribe tests still pass; the direct-worker path works |
| Status | a stable JSON capacity object with honest unknowns; concise human rendering |
| Degradation | missing or corrupt capacity file; old Codex; unavailable read; missing window or latest measurement; existing flows unaffected |

## Real validation

Use no-model probes first: `account/rateLimits/read`, inspecting only the non-secret shape, and confirm that the snapshot persists. At most one tiny real turn for `thread/tokenUsage/updated`. Record blockers (quota, auth, version) truthfully.

## Independent review (Codex)

Focus the review on these risks:
- total-vs-context confusion
- sparse-merge semantics
- mixing data from multiple accounts
- bucket loss
- primary/secondary hardcoding
- invented model mappings
- write races
- broker routing
- direct-worker coverage
- stale presentation
- unbounded retention
- a telemetry failure breaking primary work
- secrets in state or logs
- old-protocol compatibility

Fix valid findings with tests, and send them back for re-review.

## Explicitly out of scope

- a Claude-side guard or Claude usage/context monitoring
- account switching or selection
- cross-provider scheduling, quota-based allocation or delegation, and resource management or reservation
- automatic throttling, model selection, migration, checkpointing/committing, or stopping near limits
- billing beyond native fields
- a generic telemetry framework, dashboards, Prometheus/Netdata, cloud sync, or remote APIs

Record adjacent ideas as future work only.

## Acceptance

The work is accepted when all of these hold:
- The read is supported, and the initial snapshot is persisted.
- Updates merge safely, native IDs and arbitrary durations are preserved, and aliases apply to display only.
- There is no primary/secondary hardcoding and no invented model mapping.
- Thread usage is captured durably and associated with the right job, and the raw `total`, `last`, and window are preserved.
- Context occupancy uses proven active-context semantics, never cumulative totals, and is otherwise accurate or explicitly unknown.
- Freshness is represented, with no fake `0%`.
- The machine interface is stable, `status --json` shows capacity, and the human status stays concise.
- Both the broker and direct-worker paths work, and a write failure cannot break work.
- State is concurrency-safe and bounded.
- Everything else stays green, the docs are updated, the independent review is resolved, the full suite, build, and doctor pass, and a clean checkpoint is pushed. `CHECKPOINT_HANDOFF.md` records the schema and interface, the semantics, the test and validation results, the review result, and any limitations.

## Recon notes from 2026-09-25 (read-only, before deferral)

**Verified:**
- `app-server-broker.mjs` `routeNotification` delivers a notification only to the active request/stream socket and returns when there is none (`if (!target) return;`). Since `18b4a25`, it also drops notifications for orphan threads. So an `account/rateLimits/updated` that arrives with no active socket is currently **dropped** by the broker. This is known from the broker work in `e103287`/`18b4a25`; its timing relative to `turn/completed` has not been measured.
- Codex versions on this machine: the companion uses 0.156.1, the desktop app's `CODEX_CLI_PATH` moved to 0.158.0-alpha.2, and the latest stable npm release is 0.157.1. `doctor` now WARNs for version skew, as designed. A resume probe on the current ticket threads succeeded with all three versions, so no breakage is observed yet. No CLI change was made. Decide at the start of the next session: update to the newest stable once it is ≥ the desktop build, or set `CODEX_COMPANION_CODEX_BIN`. Also generate the protocol types from whichever binary is chosen.

**Not yet verified** (treat as hypotheses; verify before relying on them):
- Work-order observations A–G: the notification handler accepts arbitrary methods; `account/rateLimits/read` is missing from `AppServerMethodMap`; `codex.mjs` keeps root-thread `tokenUsage` in turn capture; `executeTaskRun` does not persist it; tickets persist `tokenUsage: result.tokenUsage?.total` (cumulative, so never context); state is per workspace under `withStateLock`/`writeJsonAtomic`; and status JSON comes from `buildStatusSnapshot`/`buildSingleJobSnapshot`.
- The active-context semantics. The lead's unverified recollection of Codex core is that its TUI derives "context left" from the **last** usage, as roughly `last.totalTokens − last.reasoningOutputTokens`, against the window minus a fixed baseline. This must be confirmed in the Codex source for the chosen version before use.
- Design candidates, still undecided:
  - one account-global capacity file under the plugin data state root, plus bounded thread records, rather than per-workspace copies of account data
  - refreshing the account snapshot at turn start (a no-model RPC), plus an explicit refresh flag on `status`
  - a broker-side hook that persists `account/rateLimits/updated`, with idempotent merging when a client persists it too
