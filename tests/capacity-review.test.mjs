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
