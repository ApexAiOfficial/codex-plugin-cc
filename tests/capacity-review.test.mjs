import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { makeTempDir } from "./helpers.mjs";
import {
  accountFreshness,
  applyRateLimitsRead,
  createCapacityObserver,
  MAX_THREAD_RECORDS,
  pruneThreads,
  readCapacity,
  threadFreshness
} from "../plugins/codex/scripts/lib/capacity.mjs";

// Regressions for the Codex `capacity-review` findings on 4cc5432.

const window = (usedPercent, windowDurationMins = 300) => ({ usedPercent, windowDurationMins, resetsAt: 4102444800 });
const bucket = (limitId, used) => ({ limitId, limitName: null, normalModelSlug: null, primary: window(used), secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: "plus", rateLimitReachedType: null });
const readResult = (accountId, used = 10) => ({ accountId, ordinaryUsageAllowed: true, rateLimits: bucket("codex", used), rateLimitsByLimitId: { codex: bucket("codex", used) } });
const tokenParams = (threadId, last) => ({ threadId, turnId: "turn-1", tokenUsage: { total: { totalTokens: 900000, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, last: { totalTokens: last, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }, modelContextWindow: 258400 } });

async function waitFor(predicate, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

// Finding: the observer took the lock synchronously inside the connection's message handling,
// stalling it for the full lock timeout, then dropped the observation (possibly the only one).
test("a contended capacity lock neither stalls the connection nor loses the observation", async (t) => {
  const file = path.join(makeTempDir(), "capacity.json");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: holder.pid, token: "held", acquiredAt: new Date().toISOString() }));
  const observer = createCapacityObserver({ file });

  const started = Date.now();
  observer.onNotification("thread/tokenUsage/updated", tokenParams("thread-final", 25840));
  assert.ok(Date.now() - started < 50, `the observe call returned in ${Date.now() - started} ms`);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(readCapacity(file).threads["thread-final"], undefined, "still queued while the lock is held");
  holder.kill("SIGKILL");
  const record = await waitFor(() => readCapacity(file).threads["thread-final"]);
  assert.equal(record?.context.usedTokens, 25840, "delivered once the lock was free");
});

test("drain flushes queued observations before a connection closes", async () => {
  const file = path.join(makeTempDir(), "capacity.json");
  const observer = createCapacityObserver({ file });
  observer.onNotification("thread/tokenUsage/updated", tokenParams("thread-drain", 1000));
  await observer.drain();
  assert.equal(observer.pendingCount(), 0);
  assert.equal(readCapacity(file).threads["thread-drain"].context.usedTokens, 1000);
});

// Finding: a null account id counted as a known identity, and a failed read kept the old one.
test("sparse updates merge only after a successful read with a non-null account id on that connection", async () => {
  const file = path.join(makeTempDir(), "capacity.json");
  const nullReader = createCapacityObserver({ file });
  nullReader.onResponse("account/rateLimits/read", readResult(null, 10));
  nullReader.onNotification("account/rateLimits/updated", { rateLimits: bucket("codex", 55) });
  await nullReader.drain();
  assert.equal(readCapacity(file).account.limits.codex.primary.usedPercent, 10, "a null identity never accepts sparse updates");

  const switching = createCapacityObserver({ file });
  switching.onResponse("account/rateLimits/read", readResult("acct-a", 20));
  switching.onNotification("account/rateLimits/updated", { rateLimits: bucket("codex", 21) });
  await switching.drain();
  assert.equal(readCapacity(file).account.limits.codex.primary.usedPercent, 21, "same known account merges");
  switching.onResponse("account/rateLimits/read", null, { message: "auth changed" });
  switching.onNotification("account/rateLimits/updated", { rateLimits: bucket("codex", 88) });
  await switching.drain();
  const account = readCapacity(file).account;
  assert.equal(account.limits.codex.primary.usedPercent, 21, "after a failed read the update is ambiguous and ignored");
  assert.equal(account.accountId, "acct-a");
  assert.match(account.lastError.message, /auth changed/);
});

// Finding: an empty read counted as fresh, and one busy bucket hid another bucket's age.
test("an empty read is unavailable, and freshness follows the oldest bucket", () => {
  const empty = applyRateLimitsRead({}, { observedAt: new Date().toISOString() });
  assert.equal(accountFreshness(empty).status, "unavailable");
  assert.match(accountFreshness(empty).reason, /no limits/);

  const now = Date.now();
  const old = new Date(now - 11 * 60 * 1000).toISOString();
  const account = {
    accountId: "acct",
    readAt: old,
    observedAt: new Date(now).toISOString(),
    limits: {
      hot: { limitId: "hot", primary: window(5), secondary: null, observedAt: new Date(now).toISOString() },
      cold: { limitId: "cold", primary: window(5), secondary: null, observedAt: old }
    }
  };
  assert.equal(accountFreshness(account, now).status, "stale", "an 11-minute-old bucket is stale even if another was just updated");
});

// Finding: the global cap could evict an active root thread in favor of newer subagent records.
test("pruning evicts subagent records before any root thread", () => {
  const now = Date.now();
  const threads = { root: { threadId: "root", observedAt: new Date(now - 60 * 60 * 1000).toISOString() } };
  for (let index = 0; index < MAX_THREAD_RECORDS + 20; index += 1) {
    threads[`sub-${index}`] = { threadId: `sub-${index}`, parentThreadId: "root", observedAt: new Date(now - index).toISOString() };
  }
  const kept = pruneThreads(threads, now);
  assert.ok(kept.root, "the older root survives newer subagents");
  assert.equal(Object.keys(kept).length, MAX_THREAD_RECORDS);
});

// Finding: a running turn whose turn id was not persisted yet showed the previous turn's context as fresh.
test("a running job without an observation from its current turn is stale", () => {
  const record = { turnId: "old-turn", tokenUsage: {} };
  assert.equal(threadFreshness(record, { status: "running", turnId: null }).status, "stale");
  assert.equal(threadFreshness(record, { status: "running", turnId: "new-turn" }).status, "stale");
  assert.equal(threadFreshness(record, { status: "running", turnId: "old-turn" }).status, "fresh");
  assert.equal(threadFreshness(record, { status: "completed", turnId: "old-turn" }).status, "fresh");
});

// ---- Turn 2 residuals (re-review of 885f805) ----

// Several connections commit independently; the last to take the lock used to win even with older data.
test("an older observation from another connection never overwrites a newer one", async () => {
  const file = path.join(makeTempDir(), "capacity.json");
  const older = createCapacityObserver({ file });
  const newer = createCapacityObserver({ file });
  older.onResponse("account/rateLimits/read", readResult("acct-old", 10));
  older.onNotification("thread/tokenUsage/updated", tokenParams("shared-thread", 1000));
  // A synchronous pause: later timestamps for `newer`, and no timer (older's flush) can run meanwhile.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  newer.onResponse("account/rateLimits/read", readResult("acct-new", 70));
  newer.onNotification("thread/tokenUsage/updated", tokenParams("shared-thread", 2000));
  // newer commits first (drain flushes synchronously up to the write); older's flush lands after it.
  await newer.drain();
  await older.drain();
  const capacity = readCapacity(file);
  assert.equal(capacity.account.accountId, "acct-new");
  assert.equal(capacity.account.limits.codex.primary.usedPercent, 70);
  assert.equal(capacity.threads["shared-thread"].context.usedTokens, 2000);
});

// drain returned while its batch was in flight (pendingCount 0) and could lose it; it also outran its bound.
test("drain keeps an unwritten batch queued and stays within its budget", async (t) => {
  const file = path.join(makeTempDir(), "capacity.json");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: holder.pid, token: "held", acquiredAt: new Date().toISOString() }));
  const observer = createCapacityObserver({ file });
  observer.onNotification("thread/tokenUsage/updated", tokenParams("thread-held", 3000));
  const started = Date.now();
  await observer.drain(300);
  assert.ok(Date.now() - started < 900, `drain returned in ${Date.now() - started} ms`);
  assert.equal(observer.pendingCount(), 1, "the unwritten observation is still queued, not silently gone");
  holder.kill("SIGKILL");
  await observer.drain(3000);
  assert.equal(readCapacity(file).threads["thread-held"]?.context.usedTokens, 3000);
});

// Root priority alone still let 256 newer roots (or 7 idle days) evict an open ticket's root.
test("an open ticket's pinned root survives age and cap pruning until it is unpinned", async () => {
  const { pinCapacityThread, unpinCapacityThreads, THREAD_RETENTION_MS } = await import("../plugins/codex/scripts/lib/capacity.mjs");
  const now = Date.now();
  const threads = { ticketRoot: { threadId: "ticketRoot", observedAt: new Date(now - THREAD_RETENTION_MS - 60000).toISOString(), pinned: { ticketId: "t1", at: new Date(now).toISOString() } } };
  for (let index = 0; index < MAX_THREAD_RECORDS + 5; index += 1) {
    threads[`root-${index}`] = { threadId: `root-${index}`, observedAt: new Date(now - index).toISOString() };
  }
  const kept = pruneThreads(threads, now);
  assert.ok(kept.ticketRoot, "pinned despite being older than the retention and behind 256 newer roots");
  assert.equal(Object.keys(kept).length, MAX_THREAD_RECORDS);

  const file = path.join(makeTempDir(), "capacity.json");
  assert.equal(pinCapacityThread("thread-x", { ticketId: "t1", jobId: "job-1" }, { file }), true);
  assert.equal(readCapacity(file).threads["thread-x"].pinned.ticketId, "t1");
  assert.equal(unpinCapacityThreads(["thread-x"], { file }), true);
  // Unpinned, a record that never had an observation has nothing left to keep and is pruned.
  assert.equal(readCapacity(file).threads["thread-x"]?.pinned, undefined);
});

// A 4cc5432-era record (readAt set, no limits) stayed fresh forever under the same schema version.
test("an empty limit map is unavailable even when it carries a read time", () => {
  const legacy = { accountId: "acct", readAt: "2026-09-01T00:00:00.000Z", observedAt: "2026-09-01T00:00:00.000Z", limits: {} };
  assert.equal(accountFreshness(legacy, Date.parse("2026-09-26T00:00:00.000Z")).status, "unavailable");
});

// ---- Turn 3 residuals (re-review of 8a11734) ----

// Millisecond timestamps tied, so a delayed older observation from the same millisecond won.
test("observations within the same millisecond still keep their real order", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-26T12:00:00.000Z") });
  const file = path.join(makeTempDir(), "capacity.json");
  const older = createCapacityObserver({ file });
  const newer = createCapacityObserver({ file });
  older.onResponse("account/rateLimits/read", readResult("acct-old", 10));
  newer.onResponse("account/rateLimits/read", readResult("acct-new", 70));
  t.mock.timers.reset();
  await newer.drain();
  await older.drain();
  assert.equal(readCapacity(file).account.accountId, "acct-new", "the later observation wins despite an identical Date");
});

// A record written while the clock ran ahead blocked every real update and looked fresh.
test("a record observed in the future neither blocks newer data nor reads as fresh", async () => {
  const { CLOCK_SKEW_TOLERANCE_MS, mayReplace } = await import("../plugins/codex/scripts/lib/capacity.mjs");
  const future = Date.now() + 60 * 60 * 1000;
  assert.equal(mayReplace(Date.now(), future, null), true, "a future stored key is untrusted");
  assert.equal(mayReplace(Date.now() - 1000, Date.now(), null), false, "a genuinely older key is refused");
  assert.equal(mayReplace(Date.now(), null, new Date(Date.now() - 1000).toISOString()), true, "legacy records compare by observedAt");

  const file = path.join(makeTempDir(), "capacity.json");
  const futureIso = new Date(future).toISOString();
  fs.writeFileSync(file, JSON.stringify({ version: 1, account: { accountId: "acct", readAt: futureIso, observedAt: futureIso, observedKey: future, limits: { codex: { limitId: "codex", primary: window(10), secondary: null, observedAt: futureIso, observedKey: future } } }, threads: {} }));
  assert.equal(accountFreshness(readCapacity(file).account).status, "stale");
  const observer = createCapacityObserver({ file });
  observer.onResponse("account/rateLimits/read", readResult("acct", 90));
  await observer.drain();
  assert.equal(readCapacity(file).account.limits.codex.primary.usedPercent, 90, "the real read replaced the future record");
  assert.ok(CLOCK_SKEW_TOLERANCE_MS > 0);
});

// drain's losing race timer stayed referenced and held a finished worker open for the full budget.
test("a fast drain does not hold the process open", async () => {
  const dir = makeTempDir();
  const script = path.join(dir, "drain.mjs");
  const capacity = path.resolve("plugins/codex/scripts/lib/capacity.mjs");
  fs.writeFileSync(script, `const { createCapacityObserver } = await import(${JSON.stringify(capacity)});
const observer = createCapacityObserver({ file: ${JSON.stringify(path.join(dir, "capacity.json"))} });
observer.onNotification("thread/tokenUsage/updated", ${JSON.stringify(tokenParams("thread-exit", 10))});
await observer.drain(1500);
`);
  const started = Date.now();
  const child = spawn(process.execPath, [script], { stdio: "ignore" });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 1200, `the process exited ${Date.now() - started} ms after start`);
});

// Pins were exempt from the record cap, so enough open tickets could exceed it.
test("pinned records are bounded by the record cap too", () => {
  const now = Date.now();
  const threads = {};
  for (let index = 0; index < MAX_THREAD_RECORDS + 1; index += 1) {
    threads[`pin-${index}`] = { threadId: `pin-${index}`, pinned: { ticketId: `t${index}`, at: new Date(now - index).toISOString() } };
  }
  const kept = pruneThreads(threads, now);
  assert.equal(Object.keys(kept).length, MAX_THREAD_RECORDS);
  assert.ok(kept["pin-0"] && !kept[`pin-${MAX_THREAD_RECORDS}`], "the newest pins are kept");
});
