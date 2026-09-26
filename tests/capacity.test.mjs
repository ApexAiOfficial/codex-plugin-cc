import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  ACCOUNT_FRESH_MS,
  MAX_THREAD_RECORDS,
  THREAD_RETENTION_MS,
  accountFreshness,
  applyRateLimitsRead,
  applyRateLimitsUpdate,
  applyThreadTokenUsage,
  deriveContext,
  readCapacity,
  threadFreshness,
  updateCapacity,
  windowLabel
} from "../plugins/codex/scripts/lib/capacity.mjs";
import { makeTempDir } from "./helpers.mjs";

const TOKEN_FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens"
];

function breakdown(totalTokens, overrides = {}) {
  return {
    totalTokens,
    inputTokens: 100,
    cachedInputTokens: 20,
    cacheWriteInputTokens: 10,
    outputTokens: 30,
    reasoningOutputTokens: 5,
    ...overrides
  };
}

function onlyTotal(totalTokens) {
  return breakdown(totalTokens, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0
  });
}

function rateLimit(limitId, primaryDuration = 300, secondaryDuration = 10080) {
  return {
    limitId,
    limitName: `${limitId} limit`,
    planType: "pro",
    ordinaryUsageAllowed: true,
    primary: { usedPercent: 12.5, windowDurationMins: primaryDuration, resetsAt: 1_800_000_000 },
    secondary: { usedPercent: 34.5, windowDurationMins: secondaryDuration, resetsAt: 1_800_100_000 }
  };
}

test("deriveContext uses the latest active context, never cumulative total", () => {
  const context = deriveContext({
    total: breakdown(2_000_000, {
      inputTokens: 1_650_000,
      cachedInputTokens: 800_000,
      cacheWriteInputTokens: 25_000,
      outputTokens: 290_000,
      reasoningOutputTokens: 60_000
    }),
    last: breakdown(90_000, {
      inputTokens: 75_000,
      cachedInputTokens: 30_000,
      cacheWriteInputTokens: 2_000,
      outputTokens: 12_000,
      reasoningOutputTokens: 3_000
    }),
    modelContextWindow: 258_400
  });

  assert.equal(context.usedTokens, 90_000);
  assert.equal(context.usedPercent, 34.8);
  assert.equal(context.remainingPercent, 65.2);
  assert.equal(context.exceeded, false);
  assert.notEqual(context.usedPercent, Math.round((2_000_000 / 258_400) * 1_000) / 10);
  assert.ok(context.usedPercent <= 100);
});

test("a lower latest context replaces prior thread occupancy after compaction", () => {
  const observedAt = "2026-01-01T00:00:00.000Z";
  const first = applyThreadTokenUsage(
    null,
    {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { total: breakdown(1_000_000), last: breakdown(90_000), modelContextWindow: 258_400 }
    },
    { observedAt, workspaceRoot: "/workspace" }
  );
  const latestTotal = breakdown(1_250_000, { inputTokens: 1_100_000, outputTokens: 140_000 });
  const second = applyThreadTokenUsage(
    first,
    {
      threadId: "thread-1",
      turnId: "turn-2",
      tokenUsage: { total: latestTotal, last: breakdown(20_000), modelContextWindow: 258_400 }
    },
    { observedAt: "2026-01-01T00:01:00.000Z", workspaceRoot: "/other" }
  );

  assert.equal(first.context.usedTokens, 90_000);
  assert.equal(second.context.usedTokens, 20_000);
  assert.ok(second.context.usedPercent < first.context.usedPercent);
  assert.deepEqual(second.tokenUsage.total, latestTotal);
});

test("unknown or missing context inputs stay unknown rather than becoming zero", () => {
  const unknownWindow = deriveContext({ total: breakdown(500_000), last: breakdown(42_000), modelContextWindow: null });
  assert.equal(unknownWindow.usedTokens, 42_000);
  assert.equal(unknownWindow.windowTokens, null);
  assert.equal(unknownWindow.usedPercent, null);
  assert.equal(unknownWindow.remainingPercent, null);
  assert.equal(unknownWindow.codexContextLeftPercent, null);

  for (const tokenUsage of [{ total: breakdown(500_000), modelContextWindow: 258_400 }, undefined]) {
    const context = deriveContext(tokenUsage);
    assert.equal(context.usedTokens, null);
    assert.equal(context.windowTokens, tokenUsage ? 258_400 : null);
    assert.equal(context.usedPercent, null);
    assert.equal(context.remainingPercent, null);
    assert.equal(context.codexContextLeftPercent, null);
  }
});

test("deriveContext recognizes only the native context-window-exceeded sentinel", () => {
  const exceeded = deriveContext({ total: onlyTotal(258_400), last: onlyTotal(1_000), modelContextWindow: 258_400 });
  assert.equal(exceeded.exceeded, true);
  assert.equal(exceeded.usedTokens, 258_400);
  assert.equal(exceeded.usedPercent, 100);
  assert.equal(exceeded.codexContextLeftPercent, 0);

  const compacted = deriveContext({ total: breakdown(200_000), last: onlyTotal(50_000), modelContextWindow: 258_400 });
  assert.equal(compacted.exceeded, false);
  assert.equal(compacted.usedTokens, 50_000);
});

test("Codex context-left percentage excludes the 12,000-token baseline", () => {
  assert.equal(deriveContext({ last: breakdown(12_000), modelContextWindow: 258_400 }).codexContextLeftPercent, 100);
  assert.equal(deriveContext({ last: breakdown(135_200), modelContextWindow: 258_400 }).codexContextLeftPercent, 50);
  assert.equal(deriveContext({ last: breakdown(258_400), modelContextWindow: 258_400 }).codexContextLeftPercent, 0);
  assert.equal(deriveContext({ last: breakdown(1), modelContextWindow: 12_000 }).codexContextLeftPercent, 0);
  assert.equal(deriveContext({ last: breakdown(1), modelContextWindow: 10_000 }).codexContextLeftPercent, 0);
});

test("applyThreadTokenUsage preserves metadata and replaces the complete raw token payload", () => {
  const total = breakdown(400_000, { inputTokens: 300_000, cachedInputTokens: 125_000, cacheWriteInputTokens: 4_000, outputTokens: 80_000, reasoningOutputTokens: 16_000 });
  const last = breakdown(55_000, { inputTokens: 44_000, cachedInputTokens: 11_000, cacheWriteInputTokens: 900, outputTokens: 9_000, reasoningOutputTokens: 2_000 });
  const record = applyThreadTokenUsage(
    {
      threadId: "thread-1",
      workspaceRoot: "/original",
      model: "gpt-test",
      parentThreadId: "parent-1",
      tokenUsage: { total: breakdown(1), last: breakdown(1), modelContextWindow: 2 },
      unrelated: "keep"
    },
    { threadId: "thread-1", turnId: "turn-9", tokenUsage: { total, last, modelContextWindow: 258_400 } },
    { observedAt: "2026-01-02T03:04:05.000Z", workspaceRoot: "/replacement" }
  );

  assert.equal(record.workspaceRoot, "/original");
  assert.equal(record.model, "gpt-test");
  assert.equal(record.parentThreadId, "parent-1");
  assert.equal(record.unrelated, "keep");
  assert.equal(record.turnId, "turn-9");
  assert.equal(record.observedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(record.source, "thread/tokenUsage/updated");
  assert.deepEqual(record.tokenUsage, { total, last, modelContextWindow: 258_400 });
  assert.deepEqual(Object.keys(record.tokenUsage.total), TOKEN_FIELDS);
  assert.deepEqual(Object.keys(record.tokenUsage.last), TOKEN_FIELDS);
});

test("rate-limit reads preserve all native buckets and account metadata", () => {
  const observedAt = "2026-01-03T00:00:00.000Z";
  const account = applyRateLimitsRead(
    {
      accountId: "account-1",
      ordinaryUsageAllowed: false,
      rateLimitsByLimitId: {
        codex: rateLimit("codex"),
        codex_other: rateLimit("codex_other")
      }
    },
    { observedAt }
  );

  assert.deepEqual(Object.keys(account.limits), ["codex", "codex_other"]);
  assert.equal(account.limits.codex.limitId, "codex");
  assert.equal(account.limits.codex_other.limitId, "codex_other");
  assert.ok(account.limits.codex.primary);
  assert.ok(account.limits.codex.secondary);
  assert.ok(account.limits.codex_other.primary);
  assert.ok(account.limits.codex_other.secondary);
  assert.equal(account.accountId, "account-1");
  assert.equal(account.ordinaryUsageAllowed, false);
});

test("single-bucket reads use the native id or the default fallback without inventing an id", () => {
  const observedAt = "2026-01-03T00:00:00.000Z";
  const named = applyRateLimitsRead({ rateLimitsByLimitId: null, rateLimits: rateLimit("codex") }, { observedAt });
  assert.deepEqual(Object.keys(named.limits), ["codex"]);
  assert.equal(named.limits.codex.limitId, "codex");

  const unnamed = applyRateLimitsRead(
    { rateLimitsByLimitId: null, rateLimits: { ...rateLimit(null), limitId: null } },
    { observedAt }
  );
  assert.deepEqual(Object.keys(unnamed.limits), ["default"]);
  assert.equal(unnamed.limits.default.limitId, null);
});

test("rate-limit normalization tolerates missing fields and ignores unknown fields", () => {
  const account = applyRateLimitsRead(
    {
      unknownTopLevel: "ignored",
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 17, unknownWindowField: true },
        secondary: { usedPercent: "17", windowDurationMins: 300 },
        unknownLimitField: { nested: true }
      }
    },
    { observedAt: "2026-01-03T00:00:00.000Z" }
  );

  assert.deepEqual(account.limits.codex.primary, { usedPercent: 17, windowDurationMins: null, resetsAt: null });
  assert.equal(account.limits.codex.secondary, null);
  assert.equal("unknownLimitField" in account.limits.codex, false);
});

test("window labels follow duration and storage does not reinterpret primary or secondary slots", () => {
  assert.equal(windowLabel(300), "5h");
  assert.equal(windowLabel(10080), "7d");
  assert.equal(windowLabel(30), "30m");
  assert.equal(windowLabel(1440), "1440m");
  assert.equal(windowLabel(null), "window");

  const account = applyRateLimitsRead(
    { rateLimits: rateLimit("codex", 10080, 300) },
    { observedAt: "2026-01-03T00:00:00.000Z" }
  );
  assert.equal(account.limits.codex.primary.windowDurationMins, 10080);
  assert.equal(account.limits.codex.secondary.windowDurationMins, 300);
});

test("sparse rate-limit updates preserve omitted data and unrelated buckets", () => {
  const account = applyRateLimitsRead(
    {
      accountId: "account-1",
      rateLimitsByLimitId: { codex: rateLimit("codex"), codex_other: rateLimit("codex_other") }
    },
    { observedAt: "2026-01-03T00:00:00.000Z" }
  );
  const otherBefore = account.limits.codex_other;
  const secondaryBefore = account.limits.codex.secondary;
  const updated = applyRateLimitsUpdate(
    account,
    {
      limitId: "codex",
      primary: { usedPercent: 81, windowDurationMins: 300, resetsAt: 1_800_200_000 },
      secondary: null,
      limitName: null,
      spendControlReached: null
    },
    {
      observedAt: "2026-01-03T00:05:00.000Z",
      connectionAccount: { known: true, accountId: "account-1" }
    }
  );

  assert.deepEqual(updated.limits.codex_other, otherBefore);
  assert.equal(updated.limits.codex.limitName, account.limits.codex.limitName);
  assert.equal(updated.limits.codex.planType, account.limits.codex.planType);
  assert.equal(updated.limits.codex.spendControlReached, account.limits.codex.spendControlReached);
  assert.equal(updated.limits.codex.rateLimitReachedType, account.limits.codex.rateLimitReachedType);
  assert.deepEqual(updated.limits.codex.secondary, secondaryBefore);
  assert.deepEqual(updated.limits.codex.primary, { usedPercent: 81, windowDurationMins: 300, resetsAt: 1_800_200_000 });
  assert.equal(updated.observedAt, "2026-01-03T00:05:00.000Z");
  assert.equal(updated.source, "update");
});

test("rate-limit updates are isolated to an unambiguous matching account", () => {
  const observedAt = "2026-01-03T00:00:00.000Z";
  const account = applyRateLimitsRead(
    {
      accountId: "account-1",
      rateLimitsByLimitId: { codex: rateLimit("codex"), codex_other: rateLimit("codex_other") }
    },
    { observedAt }
  );
  const update = { limitId: "codex", primary: { usedPercent: 50 } };

  assert.equal(
    applyRateLimitsUpdate(account, update, { observedAt, connectionAccount: { known: false, accountId: "account-1" } }),
    null
  );
  assert.equal(
    applyRateLimitsUpdate(account, update, { observedAt, connectionAccount: { known: true, accountId: "account-2" } }),
    null
  );
  assert.equal(
    applyRateLimitsUpdate(null, update, { observedAt, connectionAccount: { known: true, accountId: "account-1" } }),
    null
  );
  assert.equal(
    applyRateLimitsUpdate(account, { ...update, limitId: null }, { observedAt, connectionAccount: { known: true, accountId: "account-1" } }),
    null
  );

  const single = applyRateLimitsRead(
    { accountId: "account-1", rateLimits: rateLimit("codex") },
    { observedAt }
  );
  const merged = applyRateLimitsUpdate(
    single,
    { limitId: null, primary: { usedPercent: 66 } },
    { observedAt: "2026-01-03T00:01:00.000Z", connectionAccount: { known: true, accountId: "account-1" } }
  );
  assert.equal(merged.limits.codex.primary.usedPercent, 66);

  const replacement = applyRateLimitsRead(
    { accountId: "account-2", rateLimitsByLimitId: { replacement: rateLimit("replacement") } },
    { observedAt: "2026-01-03T00:02:00.000Z" }
  );
  assert.equal(replacement.accountId, "account-2");
  assert.deepEqual(Object.keys(replacement.limits), ["replacement"]);
  assert.equal("codex" in replacement.limits, false);
  assert.equal("codex_other" in replacement.limits, false);
});

test("accountFreshness distinguishes fresh, expired, reset, and unavailable records", () => {
  const now = Date.parse("2026-01-03T00:10:00.000Z");
  const fresh = applyRateLimitsRead(
    { accountId: "account-1", rateLimits: rateLimit("codex") },
    { observedAt: new Date(now).toISOString() }
  );
  assert.deepEqual(accountFreshness(fresh, now), { status: "fresh", reason: null });

  const old = applyRateLimitsRead(
    { accountId: "account-1", rateLimits: rateLimit("codex") },
    { observedAt: new Date(now - ACCOUNT_FRESH_MS - 1).toISOString() }
  );
  assert.equal(accountFreshness(old, now).status, "stale");

  const observedMs = now - 10_000;
  const reset = applyRateLimitsRead(
    {
      accountId: "account-1",
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: (observedMs + 5_000) / 1000 }
      }
    },
    { observedAt: new Date(observedMs).toISOString() }
  );
  assert.deepEqual(accountFreshness(reset, now), { status: "stale", reason: "a window has reset since it was observed" });

  assert.deepEqual(accountFreshness(null, now), { status: "unavailable", reason: "never read" });
  assert.deepEqual(accountFreshness({ limits: {} }, now), { status: "unavailable", reason: "never read" });
  assert.deepEqual(accountFreshness({ limits: {}, lastError: { message: "read failed" } }, now), {
    status: "unavailable",
    reason: "read failed"
  });
});

test("readCapacity rejects missing, corrupt, and wrong-version files and updateCapacity recovers each", async (t) => {
  const cases = [
    ["missing", null],
    ["corrupt", "{not-json"],
    ["wrong version", JSON.stringify({ version: 99, account: { accountId: "old" }, threads: { old: {} } })]
  ];
  for (const [name, contents] of cases) {
    await t.test(name, () => {
      const file = path.join(makeTempDir("capacity-persistence-"), "capacity.json");
      if (contents !== null) {
        fs.writeFileSync(file, contents);
      }
      assert.deepEqual(readCapacity(file), { version: 1, updatedAt: null, account: null, threads: {} });

      assert.equal(
        updateCapacity(
          (capacity) => {
            capacity.threads.recovered = { threadId: "recovered", observedAt: "2026-01-04T00:00:00.000Z" };
            return capacity;
          },
          { file, now: new Date("2026-01-04T00:00:01.000Z") }
        ),
        true
      );
      const recovered = readCapacity(file);
      assert.equal(recovered.version, 1);
      assert.equal(recovered.threads.recovered.threadId, "recovered");
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")));
    });
  }
});

test("updateCapacity prunes old threads and retains only the newest bounded set", () => {
  const file = path.join(makeTempDir("capacity-retention-"), "capacity.json");
  const now = Date.parse("2026-01-10T00:00:00.000Z");
  const threads = {};
  for (let index = 0; index < MAX_THREAD_RECORDS + 6; index += 1) {
    threads[`thread-${index}`] = {
      threadId: `thread-${index}`,
      observedAt: new Date(now - index * 1_000).toISOString()
    };
  }
  threads.stale = { threadId: "stale", observedAt: new Date(now - THREAD_RETENTION_MS - 1).toISOString() };

  assert.equal(
    updateCapacity(
      (capacity) => {
        capacity.threads = threads;
        return capacity;
      },
      { file, now: new Date(now) }
    ),
    true
  );
  const retained = readCapacity(file).threads;
  assert.equal(Object.keys(retained).length, MAX_THREAD_RECORDS);
  assert.ok(retained["thread-0"]);
  assert.ok(retained[`thread-${MAX_THREAD_RECORDS - 1}`]);
  assert.equal(retained[`thread-${MAX_THREAD_RECORDS}`], undefined);
  assert.equal(retained.stale, undefined);
});

test("updateCapacity quickly drops an observation while a live process owns its lock", async () => {
  const file = path.join(makeTempDir("capacity-lock-"), "capacity.json");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  try {
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: child.pid, token: "live-child" }));
    const started = performance.now();
    const result = updateCapacity((capacity) => capacity, { file });
    const elapsedMs = performance.now() - started;

    assert.equal(result, false);
    assert.ok(elapsedMs < 1_000, `expected advisory timeout under 1s, observed ${elapsedMs.toFixed(1)}ms`);
    assert.equal(fs.existsSync(file), false);
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

test("threadFreshness follows token observation and turn identity", () => {
  assert.deepEqual(threadFreshness({ turnId: "turn-1" }, { turnId: "turn-1" }), {
    status: "unknown",
    reason: "no token usage observed"
  });
  const record = {
    turnId: "turn-1",
    tokenUsage: { total: breakdown(100), last: breakdown(100), modelContextWindow: 1_000 }
  };
  assert.deepEqual(threadFreshness(record, { turnId: "turn-1" }), { status: "fresh", reason: null });
  assert.deepEqual(threadFreshness(record, { turnId: "turn-2" }), {
    status: "stale",
    reason: "a newer turn has not reported token usage yet"
  });
});
