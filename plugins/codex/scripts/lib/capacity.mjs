import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { withFileLock, withFileLockAsync, writeJsonAtomic } from "./locking.mjs";
import { resolveStateRootDir } from "./state.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

// Codex capacity telemetry: Codex's own account rate limits and per-thread context usage, captured
// from the app-server and persisted so Claude (and a future standalone guard) can read them without
// scraping output. Advisory only: nothing here may fail or stall primary Codex work.
//
// Native semantics (verified against the Codex 0.157.1 source, codex-rs):
// - `thread/tokenUsage/updated.tokenUsage` is `ThreadTokenUsage { total, last, modelContextWindow }`,
//   converted 1:1 from core `TokenUsageInfo { total_token_usage, last_token_usage, ... }`.
// - `total` is cumulative: core `append_last_usage` adds each `last` into it. It can exceed the
//   window by any amount and is NEVER a context measure here.
// - `last.totalTokens` is the active context size: the Codex TUI documents it as "the latest active
//   context size" and computes its own "context left" from `last_token_usage` only. After
//   compaction, core `recompute_token_usage` replaces `last` with the compacted history estimate.
// - On `ContextWindowExceeded`, core `fill_to_context_window` sets `total = window` and
//   `last = window - previous total` with every other field zero; that sentinel means "full".
// - `account/rateLimits/updated` is sparse: merge into the last `account/rateLimits/read`; null
//   values mean "unavailable", never "cleared".

export const CAPACITY_SCHEMA_VERSION = 1;
export const CAPACITY_FILE_ENV = "CODEX_COMPANION_CAPACITY_FILE";
const CAPACITY_FILE = "capacity.json";
// Rate-limit values change through usage this machine does not observe (other sessions, devices,
// the desktop app share the account), so an account snapshot is only "fresh" for a bounded time.
export const ACCOUNT_FRESH_MS = 10 * 60 * 1000;
// Bounded retention: nothing older than a week, and at most MAX_THREAD_RECORDS records, evicting
// subagent threads before root threads (a job's or ticket's root is what status and a guard need).
export const MAX_THREAD_RECORDS = 256;
export const THREAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// The synchronous writer (tests, tools) never waits long; the observer uses the async path.
const LOCK_TIMEOUT_MS = 250;
// Observer flushes: an async lock wait (never blocks the app-server message loop), retried a
// bounded number of times before an observation is given up.
const FLUSH_LOCK_TIMEOUT_MS = 2000;
const FLUSH_RETRY_MS = 250;
const FLUSH_MAX_ATTEMPTS = 8;
const DRAIN_TIMEOUT_MS = 1500;
// An open ticket's root thread is pinned (never pruned) until the ticket closes; a pin not
// refreshed for this long lapses, so a crashed close cannot pin a record forever.
export const PIN_MAX_MS = 30 * 24 * 60 * 60 * 1000;
// Codex TUI's "context left" excludes a fixed baseline (prompts, tools, compaction headroom).
const CODEX_CONTEXT_BASELINE_TOKENS = 12000;
const TOKEN_FIELDS = ["totalTokens", "inputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"];
const LIMIT_FIELDS = ["limitName", "normalModelSlug", "planType", "credits", "individualLimit", "spendControlReached", "rateLimitReachedType"];

export function resolveCapacityFile() {
  return process.env[CAPACITY_FILE_ENV] || path.join(resolveStateRootDir(), CAPACITY_FILE);
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------------------------
// Account rate limits

function normalizeWindow(window) {
  if (!window || !isNumber(window.usedPercent)) {
    return null;
  }
  return {
    usedPercent: window.usedPercent,
    windowDurationMins: isNumber(window.windowDurationMins) ? window.windowDurationMins : null,
    resetsAt: isNumber(window.resetsAt) ? window.resetsAt : null
  };
}

function normalizeLimit(snapshot, observedAt) {
  const limit = { limitId: snapshot?.limitId ?? null, primary: normalizeWindow(snapshot?.primary), secondary: normalizeWindow(snapshot?.secondary) };
  for (const field of LIMIT_FIELDS) {
    limit[field] = snapshot?.[field] ?? null;
  }
  limit.observedAt = observedAt;
  return limit;
}

/** A complete `account/rateLimits/read` result replaces the account record (also on account switch). */
export function applyRateLimitsRead(result, { observedAt }) {
  const limits = {};
  const byId = result?.rateLimitsByLimitId;
  if (byId && typeof byId === "object") {
    for (const [key, snapshot] of Object.entries(byId)) {
      if (snapshot) {
        limits[key] = normalizeLimit({ ...snapshot, limitId: snapshot.limitId ?? key }, observedAt);
      }
    }
  }
  if (Object.keys(limits).length === 0 && result?.rateLimits) {
    // Single-bucket view. With no limitId from Codex the key is "default"; limitId stays null.
    limits[result.rateLimits.limitId ?? "default"] = normalizeLimit(result.rateLimits, observedAt);
  }
  const usable = Object.keys(limits).length > 0;
  return {
    accountId: typeof result?.accountId === "string" && result.accountId ? result.accountId : null,
    ordinaryUsageAllowed: typeof result?.ordinaryUsageAllowed === "boolean" ? result.ordinaryUsageAllowed : null,
    limits,
    // A read with no usable limits is not a snapshot: telemetry is unavailable, not "fresh".
    readAt: usable ? observedAt : null,
    observedAt,
    source: "read",
    lastError: usable ? null : { at: observedAt, message: "the rate-limit read returned no limits" }
  };
}

/**
 * Merge a sparse `account/rateLimits/updated` snapshot. It carries no account id, so it is only
 * merged when the connection that delivered it last read this same, non-null account id; anything
 * ambiguous (no or null identity, a failed read since) is ignored (fail safe) rather than guessed.
 */
export function applyRateLimitsUpdate(account, snapshot, { observedAt, connectionAccount }) {
  if (!account || !snapshot || !account.accountId || !connectionAccount?.known || connectionAccount.accountId !== account.accountId) {
    return null;
  }
  const keys = Object.keys(account.limits ?? {});
  const key = snapshot.limitId ?? (keys.length === 1 ? keys[0] : null);
  if (!key) {
    return null;
  }
  const previous = account.limits[key] ?? normalizeLimit({ limitId: key }, observedAt);
  if (Date.parse(previous.observedAt) > Date.parse(observedAt)) {
    // Observed before what is stored (another connection committed first): never go backwards.
    return null;
  }
  const merged = { ...previous, limitId: previous.limitId ?? key };
  for (const window of ["primary", "secondary"]) {
    const next = normalizeWindow(snapshot[window]);
    if (next) {
      merged[window] = next;
    }
  }
  for (const field of LIMIT_FIELDS) {
    if (snapshot[field] !== null && snapshot[field] !== undefined) {
      merged[field] = snapshot[field];
    }
  }
  merged.observedAt = observedAt;
  return { ...account, limits: { ...account.limits, [key]: merged }, observedAt, source: "update" };
}

/** Display-only alias for a window duration; the stored duration is always the real one. */
export function windowLabel(windowDurationMins) {
  if (windowDurationMins === 300) {
    return "5h";
  }
  if (windowDurationMins === 10080) {
    return "7d";
  }
  return isNumber(windowDurationMins) ? `${windowDurationMins}m` : "window";
}

function limitFreshness(limit, fallbackObservedAt, now) {
  const observedMs = Date.parse(limit.observedAt ?? fallbackObservedAt);
  for (const window of [limit.primary, limit.secondary]) {
    if (window?.resetsAt && window.resetsAt * 1000 <= now && window.resetsAt * 1000 > observedMs) {
      return { status: "stale", reason: "a window has reset since it was observed" };
    }
  }
  if (!Number.isFinite(observedMs) || now - observedMs > ACCOUNT_FRESH_MS) {
    return { status: "stale", reason: `older than ${Math.round(ACCOUNT_FRESH_MS / 60000)} minutes` };
  }
  return { status: "fresh", reason: null };
}

/** fresh | stale | unavailable for the whole account: the worst of its buckets, with the evidence. */
export function accountFreshness(account, now = Date.now()) {
  if (!account || !Object.keys(account.limits ?? {}).length) {
    return { status: "unavailable", reason: account?.lastError?.message ?? (account?.readAt ? "the rate-limit read returned no limits" : "never read") };
  }
  for (const limit of Object.values(account.limits ?? {})) {
    const freshness = limitFreshness(limit, account.observedAt, now);
    if (freshness.status !== "fresh") {
      return freshness;
    }
  }
  return { status: "fresh", reason: null };
}

// ---------------------------------------------------------------------------------------------
// Thread context

function normalizeBreakdown(breakdown) {
  if (!breakdown || !isNumber(breakdown.totalTokens)) {
    return null;
  }
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, isNumber(breakdown[field]) ? breakdown[field] : null]));
}

function onlyTotal(breakdown) {
  return TOKEN_FIELDS.every((field) => field === "totalTokens" || !breakdown[field]);
}

/** Codex TUI's "context left" percentage for the same numbers (baseline-normalized). */
function codexContextLeftPercent(usedTokens, windowTokens) {
  if (windowTokens <= CODEX_CONTEXT_BASELINE_TOKENS) {
    return 0;
  }
  // Same arithmetic as codex-rs `TokenUsage::percent_of_context_window_remaining`.
  const effective = windowTokens - CODEX_CONTEXT_BASELINE_TOKENS;
  const used = Math.max(0, usedTokens - CODEX_CONTEXT_BASELINE_TOKENS);
  const remaining = Math.max(0, effective - used);
  return Math.round(Math.min(100, Math.max(0, (remaining / effective) * 100)));
}

/**
 * Active-context occupancy from the native token usage: `last.totalTokens` against
 * `modelContextWindow`. The cumulative `total` is never used, except to recognize Codex's
 * "window exceeded" sentinel. Unknown inputs give null values, never zero.
 */
export function deriveContext(tokenUsage) {
  const last = normalizeBreakdown(tokenUsage?.last);
  const total = normalizeBreakdown(tokenUsage?.total);
  const windowTokens = isNumber(tokenUsage?.modelContextWindow) && tokenUsage.modelContextWindow > 0 ? tokenUsage.modelContextWindow : null;
  const unknown = { basis: "last.totalTokens", usedTokens: null, windowTokens, usedPercent: null, remainingPercent: null, codexContextLeftPercent: null, exceeded: false };
  if (!last) {
    return unknown;
  }
  const exceeded = Boolean(windowTokens && total && total.totalTokens === windowTokens && onlyTotal(total) && onlyTotal(last));
  const usedTokens = exceeded ? windowTokens : last.totalTokens;
  if (!windowTokens) {
    return { ...unknown, usedTokens };
  }
  const usedPercent = round1(Math.min(100, (usedTokens / windowTokens) * 100));
  return {
    basis: exceeded ? "context window exceeded" : "last.totalTokens",
    usedTokens,
    windowTokens,
    usedPercent,
    remainingPercent: round1(Math.max(0, 100 - usedPercent)),
    codexContextLeftPercent: exceeded ? 0 : codexContextLeftPercent(usedTokens, windowTokens),
    exceeded
  };
}

export function applyThreadTokenUsage(record, params, { observedAt, workspaceRoot }) {
  const tokenUsage = {
    total: normalizeBreakdown(params?.tokenUsage?.total),
    last: normalizeBreakdown(params?.tokenUsage?.last),
    modelContextWindow: isNumber(params?.tokenUsage?.modelContextWindow) ? params.tokenUsage.modelContextWindow : null
  };
  return {
    ...(record ?? {}),
    threadId: params.threadId,
    workspaceRoot: record?.workspaceRoot ?? workspaceRoot ?? null,
    turnId: params.turnId ?? null,
    observedAt,
    source: "thread/tokenUsage/updated",
    tokenUsage,
    context: deriveContext(tokenUsage)
  };
}

export function pruneThreads(threads, now = Date.now()) {
  const seenAt = (record) => Date.parse(record.observedAt ?? record.annotatedAt ?? 0);
  const entries = Object.entries(threads ?? {});
  // Open tickets' roots are kept regardless of age or cap (bounded by the number of open tickets).
  const pinned = entries.filter(([, record]) => record.pinned && now - Date.parse(record.pinned.at ?? 0) <= PIN_MAX_MS);
  const recent = entries
    .filter(([, record]) => !pinned.some(([, kept]) => kept === record) && now - seenAt(record) <= THREAD_RETENTION_MS)
    .sort(([, a], [, b]) => seenAt(b) - seenAt(a));
  const roots = recent.filter(([, record]) => !record.parentThreadId);
  const subagents = recent.filter(([, record]) => record.parentThreadId);
  return Object.fromEntries([...pinned, ...[...roots, ...subagents].slice(0, Math.max(0, MAX_THREAD_RECORDS - pinned.length))]);
}

/** Pin an open ticket's root thread so pruning keeps it; advisory, never throws. */
export function pinCapacityThread(threadId, { ticketId = null, jobId = null } = {}, options = {}) {
  if (!threadId) {
    return false;
  }
  return updateCapacity((capacity) => {
    const existing = capacity.threads[threadId] ?? { threadId };
    capacity.threads[threadId] = { ...existing, pinned: { ticketId, jobId, at: new Date().toISOString() } };
    return capacity;
  }, options);
}

/** Release pins when a ticket closes; advisory, never throws. */
export function unpinCapacityThreads(threadIds, options = {}) {
  const ids = threadIds.filter(Boolean);
  if (!ids.length) {
    return false;
  }
  return updateCapacity((capacity) => {
    let changed = false;
    for (const threadId of ids) {
      if (capacity.threads[threadId]?.pinned) {
        const { pinned, ...rest } = capacity.threads[threadId];
        capacity.threads[threadId] = rest;
        changed = true;
      }
    }
    return changed ? capacity : null;
  }, options);
}

/**
 * fresh: the latest observation belongs to the thread's latest known turn (context does not
 * change between turns); stale: a newer turn ran without telemetry; unknown: nothing observed.
 */
export function threadFreshness(record, job = null) {
  if (!record?.tokenUsage) {
    return { status: "unknown", reason: "no token usage observed" };
  }
  const running = job?.status === "queued" || job?.status === "running";
  if (running && (!job.turnId || job.turnId !== record.turnId)) {
    return { status: "stale", reason: "the running turn has not reported token usage yet" };
  }
  if (job?.turnId && record.turnId && job.turnId !== record.turnId) {
    return { status: "stale", reason: "a newer turn has not reported token usage yet" };
  }
  return { status: "fresh", reason: null };
}

// ---------------------------------------------------------------------------------------------
// Persistence (advisory: every failure is swallowed and reported as false)

function emptyCapacity() {
  return { version: CAPACITY_SCHEMA_VERSION, updatedAt: null, account: null, threads: {} };
}

export function readCapacity(file = resolveCapacityFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.version !== CAPACITY_SCHEMA_VERSION || typeof parsed !== "object") {
      return emptyCapacity();
    }
    return { ...emptyCapacity(), ...parsed, threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {} };
  } catch {
    return emptyCapacity();
  }
}

export function updateCapacity(mutate, { file = resolveCapacityFile(), now = new Date() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return withFileLock(
      `${file}.lock`,
      () => {
        const current = readCapacity(file);
        const next = mutate(current);
        if (!next) {
          return false;
        }
        next.version = CAPACITY_SCHEMA_VERSION;
        next.updatedAt = now.toISOString();
        next.threads = pruneThreads(next.threads, now.getTime());
        writeJsonAtomic(file, next);
        return true;
      },
      { timeoutMs: LOCK_TIMEOUT_MS }
    );
  } catch {
    return false;
  }
}

/**
 * Async variant for the observer: waits for the lock without blocking the event loop. Resolves to
 * "written", "unchanged", or "failed" (lock timeout or I/O error; the caller may retry).
 */
export async function updateCapacityAsync(mutate, { file = resolveCapacityFile(), timeoutMs = FLUSH_LOCK_TIMEOUT_MS } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return await withFileLockAsync(
      `${file}.lock`,
      () => {
        const current = readCapacity(file);
        const next = mutate(current);
        if (!next) {
          return "unchanged";
        }
        const now = new Date();
        next.version = CAPACITY_SCHEMA_VERSION;
        next.updatedAt = now.toISOString();
        next.threads = pruneThreads(next.threads, now.getTime());
        writeJsonAtomic(file, next);
        return "written";
      },
      { timeoutMs: Math.max(1, timeoutMs), onTimeout: () => "failed" }
    );
  } catch {
    return "failed";
  }
}

/**
 * Observer for one app-server connection that talks to a real `codex app-server` (never a broker
 * client, so nothing is recorded twice). Observations are queued in memory and flushed
 * asynchronously, so the connection's message handling never waits on the capacity lock; a failed
 * flush is retried, and `drain()` gives the queue a bounded final flush when the connection closes.
 * The observer also learns which account this connection read, so a sparse update is only merged
 * into that account's record.
 *
 * @param {{ cwd?: string, file?: string }} [options]
 */
export function createCapacityObserver({ cwd, file } = {}) {
  const connectionAccount = { known: false, accountId: null };
  const target = () => file ?? resolveCapacityFile();
  let workspaceRoot;
  const workspace = () => {
    if (workspaceRoot === undefined) {
      try {
        workspaceRoot = cwd ? resolveWorkspaceRoot(cwd) : null;
      } catch {
        workspaceRoot = null;
      }
    }
    return workspaceRoot;
  };

  /** @type {Array<(capacity: any) => any>} */
  const queue = [];
  let timer = null;
  let flushing = null;
  let attempts = 0;

  const flush = async (timeoutMs = FLUSH_LOCK_TIMEOUT_MS) => {
    // The batch stays in the queue until it is written, so nothing in flight is invisible or lost.
    const batch = queue.slice();
    if (!batch.length) {
      return;
    }
    const outcome = await updateCapacityAsync(
      (capacity) => {
        let changed = false;
        for (const mutation of batch) {
          try {
            if (mutation(capacity)) {
              changed = true;
            }
          } catch {
            // One malformed observation must not discard the rest of the batch.
          }
        }
        return changed ? capacity : null;
      },
      { file: target(), timeoutMs }
    );
    if (outcome === "failed" && ++attempts < FLUSH_MAX_ATTEMPTS) {
      return;
    }
    queue.splice(0, batch.length);
    attempts = 0;
  };

  const schedule = (delayMs = 0) => {
    if (timer || flushing) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      flushing = flush()
        .catch(() => {})
        .finally(() => {
          flushing = null;
          if (queue.length) {
            schedule(attempts ? FLUSH_RETRY_MS : 0);
          }
        });
    }, delayMs);
    timer.unref?.();
  };

  const enqueue = (mutation) => {
    queue.push(mutation);
    schedule();
  };

  const annotate = (threadId, fields) =>
    enqueue((capacity) => {
      const existing = capacity.threads[threadId] ?? { threadId, workspaceRoot: workspace() };
      capacity.threads[threadId] = { ...existing, ...fields, annotatedAt: new Date().toISOString() };
      return true;
    });

  return {
    onResponse(method, result, error) {
      try {
        if (method === "account/rateLimits/read") {
          const observedAt = new Date().toISOString();
          if (error) {
            // A failed read (auth change, old Codex) ends this connection's known identity.
            connectionAccount.known = false;
            connectionAccount.accountId = null;
            const message = String(error.message ?? "read failed").slice(0, 200);
            enqueue((capacity) => {
              if (Date.parse(capacity.account?.observedAt ?? 0) > Date.parse(observedAt)) {
                return false;
              }
              capacity.account = { ...(capacity.account ?? { limits: {} }), lastError: { at: observedAt, message } };
              return true;
            });
            return;
          }
          const account = applyRateLimitsRead(result, { observedAt });
          // Only a usable read with a non-null account id establishes identity for sparse updates.
          connectionAccount.known = Boolean(account.readAt && account.accountId);
          connectionAccount.accountId = connectionAccount.known ? account.accountId : null;
          enqueue((capacity) => {
            // Several connections commit independently: an older snapshot never replaces a newer one.
            if (Date.parse(capacity.account?.observedAt ?? 0) > Date.parse(observedAt)) {
              return false;
            }
            capacity.account = account;
            return true;
          });
        } else if (!error && (method === "thread/start" || method === "thread/resume" || method === "thread/fork") && result?.thread?.id) {
          annotate(result.thread.id, { model: result.model ?? null });
        }
      } catch {
        // Telemetry is advisory.
      }
    },
    onNotification(method, params) {
      try {
        if (method === "account/rateLimits/updated") {
          const gate = { ...connectionAccount };
          const observedAt = new Date().toISOString();
          enqueue((capacity) => {
            const merged = applyRateLimitsUpdate(capacity.account, params?.rateLimits, { observedAt, connectionAccount: gate });
            if (!merged) {
              return false;
            }
            capacity.account = merged;
            return true;
          });
        } else if (method === "thread/tokenUsage/updated" && params?.threadId) {
          const observedAt = new Date().toISOString();
          enqueue((capacity) => {
            const existing = capacity.threads[params.threadId];
            if (Date.parse(existing?.observedAt ?? 0) > Date.parse(observedAt)) {
              return false;
            }
            capacity.threads[params.threadId] = applyThreadTokenUsage(existing, params, { observedAt, workspaceRoot: workspace() });
            return true;
          });
        } else if (method === "thread/started" && params?.thread?.id && params.thread.parentThreadId) {
          annotate(params.thread.id, { parentThreadId: params.thread.parentThreadId });
        }
      } catch {
        // Telemetry is advisory.
      }
    },
    /**
     * Bounded final flush on connection close. Never throws. Each lock attempt gets only the
     * remaining budget, so it returns within DRAIN_TIMEOUT_MS plus at most one local file write;
     * observations still queued at the deadline are dropped (telemetry is advisory).
     */
    async drain(timeoutMs = DRAIN_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      const remaining = () => Math.max(0, deadline - Date.now());
      while ((queue.length || flushing) && remaining() > 0) {
        if (!flushing) {
          // Exactly one flush in flight, so batches (a read, then its updates) keep their order.
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          flushing = flush(remaining())
            .catch(() => {})
            .finally(() => {
              flushing = null;
            });
        }
        // A flush started before drain may carry the normal lock wait; never wait past the budget.
        await Promise.race([flushing, new Promise((resolve) => setTimeout(resolve, remaining()))]);
        if (queue.length && attempts) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(FLUSH_RETRY_MS, remaining())));
        }
      }
    },
    pendingCount: () => queue.length
  };
}

const ACCOUNT_READ_GRACE_MS = 1000;

/**
 * Give a pending account read a bounded moment to land before the connection closes (a fast turn
 * can finish first). Never throws; at most ACCOUNT_READ_GRACE_MS, and nothing when already done.
 */
export async function settleAccountRead(pending) {
  if (!pending?.then) {
    return;
  }
  let timer;
  await Promise.race([
    pending.then(() => {}, () => {}),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ACCOUNT_READ_GRACE_MS);
    })
  ]);
  clearTimeout(timer);
}

/**
 * Ask the connected app-server for a complete account snapshot; the observer persists it.
 * @param {{ request: (method: "account/rateLimits/read", params: import("./app-server-protocol").AppServerRequestParams<"account/rateLimits/read">) => Promise<import("./app-server-protocol").AppServerResponse<"account/rateLimits/read">> }} client
 */
export function requestAccountRateLimits(client) {
  try {
    const pending = client.request("account/rateLimits/read", {});
    pending?.catch?.(() => {});
    return pending;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Views for status

function viewLimit(key, limit) {
  const windows = [];
  for (const slot of ["primary", "secondary"]) {
    const window = limit[slot];
    if (window) {
      windows.push({ slot, label: windowLabel(window.windowDurationMins), ...window });
    }
  }
  return {
    key,
    limitId: limit.limitId ?? null,
    limitName: limit.limitName ?? null,
    normalModelSlug: limit.normalModelSlug ?? null,
    planType: limit.planType ?? null,
    rateLimitReachedType: limit.rateLimitReachedType ?? null,
    spendControlReached: limit.spendControlReached ?? null,
    observedAt: limit.observedAt ?? null,
    windows
  };
}

/** The capacity section of `status --json`: account limits plus the given (this workspace's) job threads. */
export function buildCapacityView(jobs = [], { now = Date.now(), file = resolveCapacityFile() } = {}) {
  const capacity = readCapacity(file);
  const account = capacity.account;
  const threads = [];
  for (const job of jobs) {
    if (!job?.threadId) {
      continue;
    }
    const record = capacity.threads[job.threadId] ?? null;
    threads.push({
      threadId: job.threadId,
      jobId: job.id ?? null,
      ticketId: job.ticketId ?? null,
      jobStatus: job.status ?? null,
      model: record?.model ?? null,
      turnId: record?.turnId ?? null,
      observedAt: record?.observedAt ?? null,
      freshness: threadFreshness(record, job),
      context: record?.context ?? deriveContext(null),
      tokenUsage: record?.tokenUsage ?? null
    });
  }
  return {
    schemaVersion: CAPACITY_SCHEMA_VERSION,
    file,
    account: {
      freshness: accountFreshness(account, now),
      accountId: account?.accountId ?? null,
      ordinaryUsageAllowed: account?.ordinaryUsageAllowed ?? null,
      readAt: account?.readAt ?? null,
      observedAt: account?.observedAt ?? null,
      lastError: account?.lastError ?? null,
      limits: Object.entries(account?.limits ?? {}).map(([key, limit]) => viewLimit(key, limit))
    },
    // The jobs come from this workspace's own index, so their threads belong here, even when the
    // recording worker ran in a ticket worktree (its record's workspaceRoot is that worktree).
    threads
  };
}
