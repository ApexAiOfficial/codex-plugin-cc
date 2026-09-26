import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveJobFile, resolveStateDir, resolveStateFile, resolveTicketFile } from "../plugins/codex/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STATE_LIB = path.join(PLUGIN_ROOT, "scripts", "lib", "state.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function setupRepo(behavior = "review-ok") {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "."], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, env: buildEnv(binDir), fakeState: () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")) };
}

function companion(args, { cwd, env, input } = {}) {
  const result = run("node", [SCRIPT, ...args], { cwd, env, input });
  return result;
}

function companionJson(args, options) {
  const result = companion([...args, "--json"], options);
  assert.equal(result.status, 0, `${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  return JSON.parse(result.stdout);
}

function delegateAndWait(ctx, args) {
  const launched = companionJson(["delegate", ...args], { cwd: ctx.repo, env: ctx.env });
  const waited = companionJson(["wait", launched.ticketId, "--timeout-ms", "20000"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(waited.waitTimedOut, false);
  return { launched, waited };
}

function readTicketRecord(repo, id) {
  return JSON.parse(fs.readFileSync(resolveTicketFile(repo, id), "utf8"));
}

// ------------------------------------------------------------------------------------------
// State robustness

test("concurrent writers never lose jobs or delete each other's job files", async () => {
  const workspace = makeTempDir();
  const writer = path.join(makeTempDir(), "writer.mjs");
  fs.writeFileSync(
    writer,
    `import fs from "node:fs";
const { upsertJob, writeJobFile, resolveJobLogFile } = await import(${JSON.stringify(STATE_LIB)});
const [ws, id] = process.argv.slice(2);
for (let i = 0; i < 15; i += 1) {
  const jobId = id + "-" + i;
  const logFile = resolveJobLogFile(ws, jobId);
  fs.writeFileSync(logFile, "log\\n");
  writeJobFile(ws, jobId, { id: jobId });
  upsertJob(ws, { id: jobId, status: "completed", logFile, updatedAt: new Date().toISOString() });
  upsertJob(ws, { id: jobId, phase: "done" });
}
`
  );
  await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [writer, workspace, `w${index}`], { stdio: "inherit", env: process.env });
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}`))));
      })
    )
  );
  const state = JSON.parse(fs.readFileSync(resolveStateFile(workspace), "utf8"));
  // 75 finished jobs against a 50-job cap: exactly 50 survive, each with its files intact.
  assert.equal(state.jobs.length, 50);
  for (const job of state.jobs) {
    assert.equal(fs.existsSync(resolveJobFile(workspace, job.id)), true, `${job.id} lost its job file`);
    assert.equal(job.phase, "done");
  }
  const jobFiles = fs.readdirSync(path.join(resolveStateDir(workspace), "jobs")).filter((name) => name.endsWith(".json"));
  assert.equal(jobFiles.length, 50);
});

test("a corrupt state index is quarantined and rebuilt from job files", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "jobs", "task-a.json"),
    JSON.stringify({ id: "task-a", status: "completed", title: "Codex Task", createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:01:00.000Z" })
  );
  fs.writeFileSync(path.join(stateDir, "state.json"), "{ not json");

  const status = companionJson(["status", "--all"], { cwd: workspace });
  assert.deepEqual([status.latestFinished?.id], ["task-a"]);

  companionJson(["setup", "--max-parallel", "2"], { cwd: workspace });
  const repaired = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.deepEqual(repaired.jobs.map((job) => job.id), ["task-a"]);
  assert.equal(repaired.config.maxParallelTickets, 2);
  assert.ok(fs.readdirSync(stateDir).some((name) => name.startsWith("state.json.corrupt-")));
});

test("jobs whose worker died are reconciled as worker-lost instead of running forever", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const deadPid = dead.pid;
  const job = { id: "task-dead", status: "running", title: "Codex Task", jobClass: "task", pid: deadPid, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  return new Promise((resolve) => dead.on("exit", resolve)).then(() => {
    fs.writeFileSync(path.join(stateDir, "jobs", "task-dead.json"), JSON.stringify(job));
    fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, config: {}, jobs: [job] }));
    const status = companionJson(["status", "task-dead"], { cwd: workspace });
    assert.equal(status.job.status, "failed");
    assert.equal(status.job.failureKind, "worker-lost");
  });
});

test("process identity rejects a recycled pid", async () => {
  const { getProcessStartMarker, isSameProcess, terminateRecordedProcessTree } = await import("../plugins/codex/scripts/lib/process.mjs");
  const marker = getProcessStartMarker(process.pid);
  assert.equal(isSameProcess(process.pid, marker), true);
  if (marker) {
    assert.equal(isSameProcess(process.pid, `${marker}-different`), false);
    assert.equal(terminateRecordedProcessTree(process.pid, `${marker}-different`).attempted, false);
  }
});

// ------------------------------------------------------------------------------------------
// Tickets

test("a shared ticket records evidence, attributes changes, and passes independent verification", () => {
  const ctx = setupRepo();
  const { launched, waited } = delegateAndWait(ctx, [
    "--ticket", "feat-a",
    "--owns", "src/",
    "--accept", "node -e \"process.exit(require('fs').existsSync('src/feature.js') ? 0 : 1)\"",
    "Build the feature.\nFAKE_WRITE src/feature.js export const feature = true;\nFAKE_RUN 0 npm test\nFAKE_CLAIM passed npm test"
  ]);
  assert.equal(launched.ticketId, "feat-a");
  assert.equal(waited.ticket.state, "needs-review");
  assert.equal(waited.ticket.lastOutcome, "completed");
  const payload = waited.job.result;
  assert.deepEqual(payload.evidence.codexReported, ["src/feature.js"]);
  assert.deepEqual(payload.evidence.ownership.violations, []);
  assert.equal(payload.claims[0].observation, "consistent");
  assert.equal(payload.tokenUsage.totalTokens, 2000000, "the ticket payload keeps the cumulative total (not a context measure)");
  assert.equal(fs.readFileSync(path.join(ctx.repo, "src", "feature.js"), "utf8"), "export const feature = true;");

  const turnStart = ctx.fakeState().lastTurnStart;
  assert.equal(turnStart.sandboxPolicy.type, "workspaceWrite");
  assert.equal(turnStart.sandboxPolicy.networkAccess, false);
  assert.match(turnStart.prompt, /<work_package ticket="feat-a" role="implement">/);
  assert.match(turnStart.prompt, /You own these paths/);
  assert.match(turnStart.prompt, /Network access is disabled/);

  const verification = companionJson(["verify", "feat-a"], { cwd: ctx.repo, env: ctx.env });
  assert.deepEqual(verification.verification.problems, []);
  assert.equal(verification.verification.results[0].exitCode, 0);

  const closed = companionJson(["close", "feat-a", "--accepted", "--reason", "tests pass"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(closed.state, "accepted");
  const record = readTicketRecord(ctx.repo, "feat-a");
  assert.equal(record.decisions.at(-1).reason, "tests pass");
  assert.equal(companionJson(["tickets"], { cwd: ctx.repo, env: ctx.env }).tickets.length, 0);
});

test("show falls back to durable ticket history when job details were pruned", () => {
  const ctx = setupRepo();
  delegateAndWait(ctx, ["--ticket", "old", "Finish old work."]);
  const ticket = readTicketRecord(ctx.repo, "old");
  const jobFile = resolveJobFile(ctx.repo, ticket.lastJobId);
  fs.rmSync(jobFile);

  const open = companion(["show", "old"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(open.status, 0, open.stderr);
  assert.match(open.stdout, /turn 1: completed/);
  assert.match(open.stdout, new RegExp(`Summary: ${ticket.lastSummary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(open.stdout, /Turn details .* were pruned from job history, which keeps the newest 50 jobs/);
  assert.match(open.stdout, /followup old/);

  for (const args of [["show", "old", "--commands"], ["show", "old", "--command", "1"]]) {
    const trace = companion(args, { cwd: ctx.repo, env: ctx.env });
    assert.equal(trace.status, 0, trace.stderr);
    assert.match(trace.stdout, /command trace .* was pruned from job history/);
  }

  companionJson(["close", "old", "--accepted", "--reason", "history verified"], { cwd: ctx.repo, env: ctx.env });
  const closed = companion(["show", "old"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(closed.status, 0, closed.stderr);
  assert.match(closed.stdout, /turn 1: completed/);
  assert.match(closed.stdout, /State: accepted; turns: 1/);
  assert.match(closed.stdout, /Decision .*: accepted — history verified/);
  assert.doesNotMatch(closed.stdout, /Inspect: .*show old/);
});

test("show keeps worker-lost errors when the job exists without a result payload", () => {
  const ctx = setupRepo();
  const stateDir = resolveStateDir(ctx.repo);
  const timestamp = nowStamp(-5 * 60 * 1000);
  const job = {
    id: "ticket-worker-lost",
    status: "failed",
    failureKind: "worker-lost",
    errorMessage: "The delegated worker exited before producing a result.",
    result: null,
    kind: "ticket",
    jobClass: "task",
    ticketId: "worker-lost",
    createdAt: timestamp,
    completedAt: timestamp
  };
  const ticket = {
    version: 1,
    id: "worker-lost",
    role: "implement",
    title: "Worker lost",
    brief: "Exercise missing turn payload handling.",
    state: "needs-review",
    lastJobId: job.id,
    lastOutcome: "worker-lost",
    lastSummary: job.errorMessage,
    workdir: ctx.repo,
    isolation: "shared",
    sandbox: { write: true, network: false },
    turns: [{ turn: 1, jobId: job.id, outcome: "worker-lost", completedAt: timestamp }],
    decisions: [],
    verifications: [],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "tickets"), { recursive: true });
  fs.writeFileSync(resolveJobFile(ctx.repo, job.id), JSON.stringify(job), "utf8");
  fs.writeFileSync(resolveTicketFile(ctx.repo, ticket.id), JSON.stringify(ticket), "utf8");

  const shown = companion(["show", ticket.id], { cwd: ctx.repo, env: ctx.env });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /worker process died without a result/);
  assert.match(shown.stdout, /Error: The delegated worker exited before producing a result\./);
  assert.doesNotMatch(shown.stdout, /pruned from job history/);

  const commands = companion(["show", ticket.id, "--commands"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(commands.status, 0, commands.stderr);
  assert.match(commands.stdout, /No commands were recorded for this turn/);
  assert.doesNotMatch(commands.stdout, /pruned from job history/);
});

test("ownership violations and contradicted verification claims are flagged", () => {
  const ctx = setupRepo();
  const { waited } = delegateAndWait(ctx, [
    "--ticket", "scoped",
    "--owns", "src/feature.js",
    "Touch too much.\nFAKE_WRITE src/feature.js ok\nFAKE_WRITE README.md changed\nFAKE_RUN 1 npm test\nFAKE_CLAIM passed npm test"
  ]);
  assert.deepEqual(waited.job.result.evidence.ownership.violations, ["README.md"]);
  assert.equal(waited.job.result.claims[0].observation, "contradicted");

  const verify = companion(["verify", "scoped", "--json"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(verify.status, 2);
  const problems = JSON.parse(verify.stdout).verification.problems.join("\n");
  assert.match(problems, /outside declared ownership .*README\.md/);
  assert.match(problems, /claimed `npm test` passed, but the observed run exited 1/);
});

test("blocked tickets continue on the same thread with failing verification attached", () => {
  const ctx = setupRepo();
  const { waited } = delegateAndWait(ctx, [
    "--ticket", "needs-dep",
    "--accept", "node -e \"process.exit(4)\"",
    "Needs a dependency.\nFAKE_STATUS blocked\nFAKE_BLOCKER dependency the freezegun package"
  ]);
  assert.equal(waited.ticket.lastOutcome, "blocked");
  assert.equal(waited.job.result.report.blockers[0].kind, "dependency");
  const firstThread = waited.ticket.threadId;

  const verify = companion(["verify", "needs-dep"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(verify.status, 2);

  const follow = companionJson(["followup", "needs-dep", "Unblocked: installed it.\nFAKE_WRITE src/fixed.js yes"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(follow.turn, 2);
  assert.equal(follow.attachVerification, true);
  const second = companionJson(["wait", "needs-dep", "--timeout-ms", "20000"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(second.ticket.lastOutcome, "completed");
  assert.equal(second.ticket.threadId, firstThread);
  const turns = ctx.fakeState().turnStarts;
  assert.equal(turns.at(-1).threadId, turns.at(-2).threadId);
  assert.match(turns.at(-1).prompt, /<lead_feedback ticket="needs-dep" turn="2">/);
  assert.match(turns.at(-1).prompt, /<lead_verification>[\s\S]*node -e "process\.exit\(4\)"  \(exit 4\)/);
});

test("read-only roles run in a read-only sandbox and network is only granted explicitly", () => {
  const ctx = setupRepo();
  delegateAndWait(ctx, ["--ticket", "probe", "--role", "investigate", "Why is it slow?"]);
  assert.equal(ctx.fakeState().lastTurnStart.sandboxPolicy.type, "readOnly");
  assert.match(ctx.fakeState().lastTurnStart.prompt, /This is an investigation, not an implementation/);
  assert.match(ctx.fakeState().lastTurnStart.prompt, /Read-only package: you own no files/);

  delegateAndWait(ctx, ["--ticket", "net", "--network", "Fetch something.\nFAKE_WRITE src/n.js 1"]);
  assert.equal(ctx.fakeState().lastTurnStart.sandboxPolicy.networkAccess, true);
  assert.match(ctx.fakeState().lastTurnStart.prompt, /Network access is enabled/);
});

test("investigate tickets can experiment in a scratch worktree that is never integrated", () => {
  const ctx = setupRepo();
  const { launched, waited } = delegateAndWait(ctx, [
    "--ticket", "repro",
    "--role", "investigate",
    "--isolation", "worktree",
    "Reproduce the bug.\nFAKE_WRITE src/app.js // instrumented"
  ]);
  const turnStart = ctx.fakeState().lastTurnStart;
  assert.equal(turnStart.sandboxPolicy.type, "workspaceWrite");
  assert.equal(turnStart.cwd, launched.workdir);
  assert.match(turnStart.prompt, /disposable scratch worktree/);
  assert.equal(waited.job.result.evidence.ownership, null);
  assert.equal(fs.readFileSync(path.join(ctx.repo, "src", "app.js"), "utf8"), "export const value = 1;\n");
  assert.deepEqual(companionJson(["verify", "repro"], { cwd: ctx.repo, env: ctx.env }).verification.problems, []);
  const integrate = companion(["integrate", "repro"], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(integrate.status, 0);
  assert.match(integrate.stderr, /scratch worktree holds experiments/);
  companionJson(["close", "repro", "--accepted", "--reason", "root cause found"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(fs.existsSync(launched.workdir), false);
});

test("an explicit model or effort Codex does not offer is rejected before any turn runs", () => {
  const ctx = setupRepo();
  const unknown = companion(["delegate", "--ticket", "m1", "--model", "gpt-nope", "Work."], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /does not offer model "gpt-nope".*Available: fake-frontier\./);
  assert.doesNotMatch(unknown.stderr, /fake-hidden/, "hidden models are not advertised");
  const effort = companion(["delegate", "--ticket", "m2", "--model", "fake-hidden", "--effort", "high", "Work."], { cwd: ctx.repo, env: ctx.env });
  assert.match(effort.stderr, /fake-hidden does not support effort "high"\. Supported: low\./);
  assert.equal(fs.existsSync(resolveTicketFile(ctx.repo, "m1")), false, "no ticket is created for a rejected choice");
  assert.equal(fs.existsSync(resolveTicketFile(ctx.repo, "m2")), false);
  const launched = companionJson(["delegate", "--ticket", "m3", "--effort", "high", "Work."], { cwd: ctx.repo, env: ctx.env });
  assert.equal(launched.ticketId, "m3");
  companionJson(["wait", "m3", "--timeout-ms", "20000"], { cwd: ctx.repo, env: ctx.env });
  const preflight = companion(["preflight"], { cwd: ctx.repo, env: ctx.env });
  assert.match(preflight.stdout, /Models: tickets use fake-frontier \(account default\)/);
});

function capacityEnv(ctx) {
  return { ...ctx.env, CODEX_COMPANION_CAPACITY_FILE: path.join(makeTempDir(), "capacity.json") };
}

test("status --json reports account limits and a ticket's active context, never its cumulative total", () => {
  const ctx = setupRepo();
  const env = capacityEnv(ctx);
  const { launched } = delegateAndWait({ ...ctx, env }, ["--ticket", "ctx", "Work.\nFAKE_WRITE src/c.js 1"]);
  const status = companionJson(["status"], { cwd: ctx.repo, env });
  const { capacity } = status;
  assert.equal(capacity.schemaVersion, 1);
  assert.equal(capacity.file, env.CODEX_COMPANION_CAPACITY_FILE);
  assert.equal(capacity.account.freshness.status, "fresh");
  assert.deepEqual(capacity.account.limits.map((limit) => limit.key).sort(), ["codex", "codex_other"]);
  const other = capacity.account.limits.find((limit) => limit.key === "codex_other");
  assert.deepEqual(other.windows.map((window) => [window.label, window.windowDurationMins]), [["30m", 30]], "an unrecognized duration stays as it is");
  assert.equal(other.normalModelSlug, "fake-frontier", "a model association only because Codex supplied it");
  const thread = capacity.threads.find((entry) => entry.ticketId === "ctx");
  assert.ok(thread, JSON.stringify(capacity.threads));
  assert.equal(thread.jobId, readTicketRecord(ctx.repo, "ctx").lastJobId);
  assert.equal(thread.freshness.status, "fresh");
  assert.equal(thread.tokenUsage.total.totalTokens, 2000000, "the raw cumulative total is preserved");
  assert.equal(thread.context.usedTokens, 64600);
  assert.equal(thread.context.usedPercent, 25, "64600 / 258400 of the window, not 2000000 / 258400");
  assert.equal(thread.context.windowTokens, 258400);
  assert.ok(launched.ticketId);

  const human = companion(["status"], { cwd: ctx.repo, env }).stdout;
  assert.match(human, /Codex capacity:\n- codex 5h: 12% used · resets [^\n]+\n- codex 7d: 40% used/);
  assert.match(human, /- codex_other \(Other\) 30m: 5% used/);
  assert.match(human, /- ticket ctx: context 25% used \(64600\/258400 tokens\)/);
});

test("a corrupt capacity file or an older Codex leaves status working and reports telemetry as unavailable", () => {
  const ctx = setupRepo("rate-limits-unsupported");
  const env = capacityEnv(ctx);
  fs.mkdirSync(path.dirname(env.CODEX_COMPANION_CAPACITY_FILE), { recursive: true });
  fs.writeFileSync(env.CODEX_COMPANION_CAPACITY_FILE, "{not json");
  const corrupt = companionJson(["status"], { cwd: ctx.repo, env });
  assert.equal(corrupt.capacity.account.freshness.status, "unavailable");
  assert.deepEqual(corrupt.capacity.account.limits, []);

  const { waited } = delegateAndWait({ ...ctx, env }, ["--ticket", "old", "Work.\nFAKE_WRITE src/o.js 1"]);
  assert.equal(waited.ticket.lastOutcome, "completed", "telemetry failure never fails the ticket turn");
  const after = companionJson(["status"], { cwd: ctx.repo, env });
  assert.equal(after.capacity.account.freshness.status, "unavailable");
  assert.match(after.capacity.account.freshness.reason, /Unsupported method/);
  assert.ok(!after.capacity.account.limits.some((limit) => limit.windows.some((window) => window.usedPercent === 0)), "no fabricated 0%");
  assert.match(companion(["status"], { cwd: ctx.repo, env }).stdout, /Codex capacity: account limits unavailable \(Unsupported method/);
});

test("infrastructure failures are classified separately from bad work", () => {
  const ctx = setupRepo();
  const { waited } = delegateAndWait(ctx, ["--ticket", "quota", "Anything.\nFAKE_TURN_FAIL"]);
  assert.equal(waited.ticket.lastOutcome, "quota");
  assert.equal(waited.job.failureKind, "quota");
  // Codex's own message (in real use it says when the limit resets) reaches the job and the card.
  assert.match(waited.job.errorMessage, /usage limit reached/);
  const card = companion(["show", "quota"], { cwd: ctx.repo, env: ctx.env });
  assert.match(card.stdout, /stopped by usage limits[\s\S]*Error: usage limit reached/);
});

test("steer delivers a message into the running turn", async () => {
  const ctx = setupRepo();
  companionJson(["delegate", "--ticket", "slow", "Long work.\nFAKE_SLOW"], { cwd: ctx.repo, env: ctx.env });
  await waitFor(() => {
    const ticket = readTicketRecord(ctx.repo, "slow");
    const job = JSON.parse(fs.readFileSync(resolveJobFile(ctx.repo, ticket.activeJobId), "utf8"));
    return job.turnId ? job : null;
  });
  const steered = companionJson(["steer", "slow", "switch to the async API"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(steered.status, "delivered");
  const waited = companionJson(["wait", "slow", "--timeout-ms", "20000"], { cwd: ctx.repo, env: ctx.env });
  assert.match(waited.ticket.lastSummary, /Steered: switch to the async API/);
  assert.equal(ctx.fakeState().lastSteer.text, "switch to the async API");
});

test("cancelling a ticket interrupts the live turn and leaves it ready for followup", async () => {
  const ctx = setupRepo();
  companionJson(["delegate", "--ticket", "stopme", "Long work.\nFAKE_SLOW"], { cwd: ctx.repo, env: ctx.env });
  await waitFor(() => {
    const ticket = readTicketRecord(ctx.repo, "stopme");
    return JSON.parse(fs.readFileSync(resolveJobFile(ctx.repo, ticket.activeJobId), "utf8")).turnId;
  });
  const cancelled = companionJson(["cancel", "stopme"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(cancelled.turnInterrupted, true);
  assert.equal(cancelled.forcedTermination, false);
  const ticket = readTicketRecord(ctx.repo, "stopme");
  assert.equal(ticket.state, "needs-review");
  assert.equal(ticket.lastOutcome, "cancelled");
  assert.ok(ctx.fakeState().lastInterrupt);
});

test("ticket workers survive the Claude session ending", async () => {
  const ctx = setupRepo();
  companionJson(["delegate", "--ticket", "durable", "Long work.\nFAKE_SLOW\nFAKE_WRITE src/late.js done"], { cwd: ctx.repo, env: ctx.env });
  await waitFor(() => readTicketRecord(ctx.repo, "durable").activeJobId);
  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: ctx.repo,
    env: ctx.env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", cwd: ctx.repo, reason: "clear" })
  });
  assert.equal(ended.status, 0, ended.stderr);
  const waited = companionJson(["wait", "durable", "--timeout-ms", "25000"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(waited.ticket.lastOutcome, "completed");
  assert.equal(fs.existsSync(path.join(ctx.repo, "src", "late.js")), true);
});

test("the concurrent ticket limit is enforced", () => {
  const ctx = setupRepo();
  companionJson(["setup", "--max-parallel", "1"], { cwd: ctx.repo, env: ctx.env });
  companionJson(["delegate", "--ticket", "one", "Long.\nFAKE_SLOW"], { cwd: ctx.repo, env: ctx.env });
  const second = companion(["delegate", "--ticket", "two", "Another."], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already running \(one\); the limit is 1/);
  companionJson(["cancel", "one"], { cwd: ctx.repo, env: ctx.env });
});

test("rescue resume never picks up a ticket thread", () => {
  const ctx = setupRepo();
  delegateAndWait(ctx, ["--ticket", "private", "Work.\nFAKE_WRITE src/p.js 1"]);
  const candidate = companionJson(["task-resume-candidate"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(candidate.available, false);
});

// ------------------------------------------------------------------------------------------
// Worktree isolation

test("worktree tickets start from the lead's dirty state and integrate without touching the index", () => {
  const ctx = setupRepo();
  fs.writeFileSync(path.join(ctx.repo, "src", "app.js"), "export const value = 2; // uncommitted\n");
  fs.writeFileSync(path.join(ctx.repo, "src", "draft.js"), "untracked draft\n");
  fs.mkdirSync(path.join(ctx.repo, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(ctx.repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(ctx.repo, ".gitignore"), "node_modules/\n");

  const { launched, waited } = delegateAndWait(ctx, [
    "--ticket", "iso",
    "--isolation", "worktree",
    "--owns", "src/",
    "--accept", "node -e \"process.exit(require('fs').existsSync('src/new.js') ? 0 : 1)\"",
    "Isolated.\nFAKE_WRITE src/new.js created in worktree"
  ]);
  const worktree = launched.workdir;
  assert.notEqual(worktree, ctx.repo);
  assert.equal(fs.readFileSync(path.join(worktree, "src", "app.js"), "utf8"), "export const value = 2; // uncommitted\n");
  assert.equal(fs.readFileSync(path.join(worktree, "src", "draft.js"), "utf8"), "untracked draft\n");
  assert.equal(fs.lstatSync(path.join(worktree, "node_modules")).isSymbolicLink(), true);
  assert.equal(ctx.fakeState().lastTurnStart.cwd, worktree);
  assert.deepEqual(waited.job.result.evidence.changed.map((change) => change.path), ["src/new.js"]);
  assert.equal(fs.existsSync(path.join(ctx.repo, "src", "new.js")), false);

  assert.deepEqual(companionJson(["verify", "iso"], { cwd: ctx.repo, env: ctx.env }).verification.problems, []);
  const refused = companion(["close", "iso", "--accepted"], { cwd: ctx.repo, env: ctx.env });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /never integrated/);

  const integrated = companionJson(["integrate", "iso"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(integrated.applied, true);
  assert.equal(fs.readFileSync(path.join(ctx.repo, "src", "new.js"), "utf8"), "created in worktree");
  assert.equal(run("git", ["diff", "--cached", "--name-only"], { cwd: ctx.repo }).stdout.trim(), "");
  assert.equal(readTicketRecord(ctx.repo, "iso").state, "integrated");

  companionJson(["close", "iso", "--accepted", "--reason", "merged"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fs.readFileSync(path.join(ctx.repo, "node_modules", "dep", "index.js"), "utf8"), "module.exports = 1;\n");
  assert.equal(run("git", ["for-each-ref", "refs/codex-companion"], { cwd: ctx.repo }).stdout.trim(), "");
});

test("worktree integration aborts atomically on conflicting edits and merges clean ones", () => {
  const ctx = setupRepo();
  fs.writeFileSync(path.join(ctx.repo, "src", "shared.js"), "line one\nline two\nline three\n");
  run("git", ["add", "."], { cwd: ctx.repo });
  run("git", ["commit", "-m", "shared"], { cwd: ctx.repo });
  delegateAndWait(ctx, [
    "--ticket", "clash",
    "--isolation", "worktree",
    "Edit.\nFAKE_WRITE src/shared.js line one\\nline two (codex)\\nline three\\n\nFAKE_WRITE src/other.js new"
  ]);
  fs.writeFileSync(path.join(ctx.repo, "src", "shared.js"), "line one\nline two (lead)\nline three\n");

  const aborted = companion(["integrate", "clash", "--json"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(aborted.status, 2);
  const payload = JSON.parse(aborted.stdout);
  assert.equal(payload.applied, false);
  assert.deepEqual(payload.conflicts.map((conflict) => conflict.path), ["src/shared.js"]);
  assert.equal(fs.existsSync(path.join(ctx.repo, "src", "other.js")), false, "nothing is written when any file conflicts");

  fs.writeFileSync(path.join(ctx.repo, "src", "shared.js"), "line zero (lead)\nline one\nline two\nline three\n");
  const merged = companionJson(["integrate", "clash"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(merged.applied, true);
  assert.equal(fs.readFileSync(path.join(ctx.repo, "src", "shared.js"), "utf8"), "line zero (lead)\nline one\nline two (codex)\nline three\n");
  assert.equal(fs.readFileSync(path.join(ctx.repo, "src", "other.js"), "utf8"), "new");
  companionJson(["close", "clash", "--rejected", "--reason", "testing retention"], { cwd: ctx.repo, env: ctx.env });
  const record = readTicketRecord(ctx.repo, "clash");
  assert.equal(fs.existsSync(record.workdir), true, "rejected tickets keep their worktree");
  companionJson(["close", "clash", "--purge"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(fs.existsSync(record.workdir), false);
  const alreadyPurged = companion(["close", "clash", "--purge"], { cwd: ctx.repo, env: ctx.env });
  assert.equal(alreadyPurged.status, 0, alreadyPurged.stderr);
  assert.match(alreadyPurged.stdout, /No retained worktree for clash/);
  assert.equal(companionJson(["close", "clash", "--purge"], { cwd: ctx.repo, env: ctx.env }).purged, false);
});

// ------------------------------------------------------------------------------------------
// Preflight, hooks, monitor

test("preflight measures the sandbox through command/exec with the ticket policy", () => {
  const ctx = setupRepo("sandbox-no-docker");
  const report = companionJson(["preflight", "--check", "node -e \"process.exit(3)\""], { cwd: ctx.repo, env: ctx.env });
  assert.equal(report.policy.type, "workspaceWrite");
  assert.equal(report.sandbox.network, false);
  assert.equal(report.checks[0].exitCode, 3);
  const execs = ctx.fakeState().commandExecs;
  assert.ok(execs.every((entry) => entry.sandboxPolicy?.type === "workspaceWrite"));
  const rendered = companion(["preflight"], { cwd: ctx.repo, env: ctx.env }).stdout;
  assert.match(rendered, /Route to Claude, not Codex/);
});

test("session start exports the runtime path and injects the open-ticket ledger", () => {
  const ctx = setupRepo();
  delegateAndWait(ctx, ["--ticket", "ledger", "Work.\nFAKE_WRITE src/l.js 1"]);
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "");
  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: ctx.repo,
    env: { ...ctx.env, CLAUDE_ENV_FILE: envFile },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-1", cwd: ctx.repo, source: "compact" })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(envFile, "utf8"), /export CODEX_COMPANION='.*codex-companion\.mjs'/);
  assert.match(result.stdout, /Open Codex tickets in this repository/);
  assert.match(result.stdout, /- ledger: needs-review, last outcome completed/);
  assert.match(result.stdout, /node "\$CODEX_COMPANION" tickets/);

  const emptyRepo = setupRepo();
  const quiet = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: emptyRepo.repo,
    env: emptyRepo.env,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-1", cwd: emptyRepo.repo })
  });
  assert.equal(quiet.stdout, "");
});

test("the stop hook notes a running ticket without suggesting cancel", async () => {
  const ctx = setupRepo();
  const env = { ...ctx.env, CODEX_COMPANION_SESSION_ID: "sess-running" };
  companionJson(["delegate", "--ticket", "busy", "Long work.\nFAKE_SLOW"], { cwd: ctx.repo, env });
  const note = run("node", [STOP_HOOK], { cwd: ctx.repo, env, input: JSON.stringify({ hook_event_name: "Stop", session_id: "sess-running", cwd: ctx.repo }) });
  assert.equal(note.status, 0, note.stderr);
  assert.equal(note.stdout.trim(), "");
  assert.match(note.stderr, /Codex ticket busy is still running; it keeps running after this turn/);
  assert.doesNotMatch(note.stderr, /codex:cancel/);
  companion(["cancel", "busy"], { cwd: ctx.repo, env });
});

test("the stop hook surfaces an unreviewed ticket turn exactly once", () => {
  const ctx = setupRepo();
  const env = { ...ctx.env, CODEX_COMPANION_SESSION_ID: "sess-nudge" };
  companionJson(["delegate", "--ticket", "nudge", "Work.\nFAKE_WRITE src/x.js 1"], { cwd: ctx.repo, env });
  const hookInput = JSON.stringify({ hook_event_name: "Stop", session_id: "sess-nudge", cwd: ctx.repo });
  // Wait for the turn to finish without surfacing it (wait/show would mark it collected).
  return waitFor(() => {
    const ticket = readTicketRecord(ctx.repo, "nudge");
    const job = JSON.parse(fs.readFileSync(resolveJobFile(ctx.repo, ticket.activeJobId ?? ticket.lastJobId), "utf8"));
    return job.status === "completed";
  }).then(() => {
    const first = run("node", [STOP_HOOK], { cwd: ctx.repo, env, input: hookInput });
    assert.equal(first.status, 0, first.stderr);
    const decision = JSON.parse(first.stdout);
    assert.equal(decision.decision, "block");
    assert.match(decision.reason, /- nudge: completed/);
    const second = run("node", [STOP_HOOK], { cwd: ctx.repo, env, input: hookInput });
    assert.equal(second.stdout.trim(), "");
    const active = run("node", [STOP_HOOK], { cwd: ctx.repo, env, input: JSON.stringify({ ...JSON.parse(hookInput), stop_hook_active: true }) });
    assert.equal(active.stdout.trim(), "");
  });
});

test("the plugin monitor arms for the skill name Claude Code dispatches", () => {
  // Claude Code compares `when` to the dispatched name verbatim: the Skill tool and slash commands
  // use the plugin-namespaced name ("codex:codex-delegation"); a bare name is also accepted.
  const pluginRoot = path.resolve(path.dirname(SCRIPT), "..");
  const monitors = JSON.parse(fs.readFileSync(path.join(pluginRoot, "monitors", "monitors.json"), "utf8"));
  const pluginName = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).name;
  const triggers = monitors.map((monitor) => monitor.when);
  assert.ok(triggers.includes(`on-skill-invoke:${pluginName}:codex-delegation`), triggers.join(", "));
  assert.ok(triggers.includes("on-skill-invoke:codex-delegation"), triggers.join(", "));
  assert.equal(new Set(monitors.map((monitor) => monitor.name)).size, monitors.length, "monitor names are unique");
  for (const monitor of monitors) {
    assert.ok(monitor.command && monitor.description, `${monitor.name} has a command and description`);
    const skill = monitor.when.slice("on-skill-invoke:".length).split(":").pop();
    assert.ok(fs.existsSync(path.join(pluginRoot, "skills", skill, "SKILL.md")), `${monitor.when} names a real skill`);
  }
});

test("two armed watchers report a finished turn only once", async (t) => {
  const ctx = setupRepo();
  const watchers = [0, 1].map(() => spawn(process.execPath, [SCRIPT, "watch", "--interval-ms", "250"], { cwd: ctx.repo, env: ctx.env }));
  let output = "";
  for (const watcher of watchers) {
    t.after(() => watcher.kill("SIGTERM"));
    watcher.stdout.on("data", (chunk) => {
      output += chunk;
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  companionJson(["delegate", "--ticket", "twice", "Once.\nFAKE_WRITE src/t.js 1"], { cwd: ctx.repo, env: ctx.env });
  await waitFor(() => output.includes("Codex ticket twice finished turn 1"), { timeoutMs: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(output.trim().split("\n").length, 1, `duplicate notifications:\n${output}`);
});

function watchLines(watcher) {
  const state = { output: "" };
  watcher.stdout.on("data", (chunk) => {
    state.output += chunk;
  });
  return state;
}

function readJobFor(repo, ticketId) {
  const ticket = readTicketRecord(repo, ticketId);
  return JSON.parse(fs.readFileSync(resolveJobFile(repo, ticket.activeJobId ?? ticket.lastJobId), "utf8"));
}

// Regression (review finding): watch persisted notifiedAt before writing, so a failed write lost
// the notification for good; no other watcher or the Stop reminder would ever surface it.
test("a notification whose write fails is released for another watcher", async (t) => {
  const ctx = setupRepo();
  const env = { ...ctx.env, CODEX_COMPANION_SESSION_ID: "sess-watch" };
  const broken = spawn(process.execPath, [SCRIPT, "watch", "--interval-ms", "250"], { cwd: ctx.repo, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => broken.kill("SIGKILL"));
  broken.stdout.destroy();
  const exited = new Promise((resolve) => broken.on("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 600));
  companionJson(["delegate", "--ticket", "lost", "Work.\nFAKE_WRITE src/l.js 1"], { cwd: ctx.repo, env });
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 20000))]);
  assert.equal(readJobFor(ctx.repo, "lost").notifiedAt, undefined, "the failed delivery gave its claim back");

  const healthy = spawn(process.execPath, [SCRIPT, "watch", "--interval-ms", "250"], { cwd: ctx.repo, env });
  t.after(() => healthy.kill("SIGTERM"));
  const lines = watchLines(healthy);
  await waitFor(() => lines.output.includes("Codex ticket lost finished turn 1"), { timeoutMs: 10000 });
});

// Regression (review finding): a turn that finished before the watcher armed was treated as
// already seen and never announced.
test("a turn that finished before the watcher armed is announced once, for its own session only", async (t) => {
  const ctx = setupRepo();
  const mine = { ...ctx.env, CODEX_COMPANION_SESSION_ID: "sess-early" };
  const other = { ...ctx.env, CODEX_COMPANION_SESSION_ID: "sess-other" };
  companionJson(["delegate", "--ticket", "early", "Work.\nFAKE_WRITE src/e.js 1"], { cwd: ctx.repo, env: mine });
  companionJson(["delegate", "--ticket", "elsewhere", "Work.\nFAKE_WRITE src/w.js 1"], { cwd: ctx.repo, env: other });
  // Collected through wait: Claude has already seen this one.
  delegateAndWait({ ...ctx, env: mine }, ["--ticket", "collected", "Work.\nFAKE_WRITE src/c.js 1"]);
  await waitFor(() => ["early", "elsewhere"].every((id) => readJobFor(ctx.repo, id).status === "completed"));

  const watcher = spawn(process.execPath, [SCRIPT, "watch", "--interval-ms", "250"], { cwd: ctx.repo, env: mine });
  t.after(() => watcher.kill("SIGTERM"));
  const lines = watchLines(watcher);
  await waitFor(() => lines.output.includes("Codex ticket early finished turn 1"), { timeoutMs: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(lines.output.trim().split("\n").length, 1, `unexpected monitor output:\n${lines.output}`);
  assert.doesNotMatch(lines.output, /elsewhere|collected/);
});

// Regression (re-review): the claim was permanent once set, so a watcher that died, or whose rollback
// after a failed write also failed, suppressed the turn for every later watcher and the Stop reminder.
test("a notification claim lapses when the watcher that made it is gone", async (t) => {
  const ctx = setupRepo();
  const env = { ...ctx.env, CODEX_COMPANION_SESSION_ID: "sess-lapse" };
  companionJson(["delegate", "--ticket", "stale", "Work.\nFAKE_WRITE src/s.js 1"], { cwd: ctx.repo, env });
  companionJson(["delegate", "--ticket", "held", "Work.\nFAKE_WRITE src/h.js 1"], { cwd: ctx.repo, env });
  await waitFor(() => ["stale", "held"].every((id) => readJobFor(ctx.repo, id).status === "completed"));
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => dead.on("exit", resolve));
  const claim = (id, pending) => {
    const file = resolveJobFile(ctx.repo, readTicketRecord(ctx.repo, id).lastJobId);
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), notifiedAt: new Date().toISOString(), notifyPending: pending }));
  };
  claim("stale", { pid: dead.pid, marker: null });
  // A live claimer (this test process) is still delivering: its turn stays claimed.
  const { getProcessStartMarker } = await import("../plugins/codex/scripts/lib/process.mjs");
  claim("held", { pid: process.pid, marker: getProcessStartMarker(process.pid) });

  const watcher = spawn(process.execPath, [SCRIPT, "watch", "--interval-ms", "250"], { cwd: ctx.repo, env });
  t.after(() => watcher.kill("SIGTERM"));
  const lines = watchLines(watcher);
  await waitFor(() => lines.output.includes("Codex ticket stale finished turn 1"), { timeoutMs: 10000 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.doesNotMatch(lines.output, /ticket held/, "a live watcher's claim is respected");
  assert.equal(readJobFor(ctx.repo, "stale").notifyPending, undefined, "the new watcher confirmed its delivery");
});

test("watch emits one notification line per finished ticket turn", async (t) => {
  const ctx = setupRepo();
  delegateAndWait(ctx, ["--ticket", "before", "Old.\nFAKE_WRITE src/o.js 1"]);
  const watcher = spawn(process.execPath, [SCRIPT, "watch", "--interval-ms", "250"], { cwd: ctx.repo, env: ctx.env });
  t.after(() => watcher.kill("SIGTERM"));
  let output = "";
  watcher.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await new Promise((resolve) => setTimeout(resolve, 600));
  companionJson(["delegate", "--ticket", "after", "New.\nFAKE_WRITE src/n.js 1"], { cwd: ctx.repo, env: ctx.env });
  await waitFor(() => output.includes("Codex ticket after finished turn 1: completed"), { timeoutMs: 20000 });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(output.trim().split("\n").length, 1, `unexpected monitor output:\n${output}`);
  assert.doesNotMatch(output, /ticket before/);
  assert.doesNotMatch(output, /\.\. Review/, "a summary ending in a period gets no second period");
  const ticket = readTicketRecord(ctx.repo, "after");
  assert.ok(JSON.parse(fs.readFileSync(resolveJobFile(ctx.repo, ticket.lastJobId), "utf8")).notifiedAt);
});

// ------------------------------------------------------------------------------------------
// Regressions for defects found by the Codex review ticket (review-core)

test("a lock whose owner is alive is never broken on age alone", async (t) => {
  const { withFileLock } = await import("../plugins/codex/scripts/lib/locking.mjs");
  const { getProcessStartMarker } = await import("../plugins/codex/scripts/lib/process.mjs");
  const lockPath = path.join(makeTempDir(), "state.lock");
  const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  await waitFor(() => getProcessStartMarker(holder.pid));
  fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, marker: getProcessStartMarker(holder.pid), token: "held" }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockPath, old, old);
  assert.throws(() => withFileLock(lockPath, () => "entered", { timeoutMs: 300, staleMs: 50 }), /Timed out .*held by pid/);

  // A recorded owner whose pid now belongs to a different process incarnation is stale.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, marker: "linux:0-recycled", token: "old" }));
  if (getProcessStartMarker(holder.pid)) {
    assert.equal(withFileLock(lockPath, () => "entered", { timeoutMs: 300 }), "entered");
  }
});

test("unverifiable process identity fails closed for kills and open for liveness", async (t) => {
  const { probeProcessIdentity, terminateRecordedProcessTree } = await import("../plugins/codex/scripts/lib/process.mjs");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "codex-probe-hint"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await waitFor(() => fs.existsSync(`/proc/${child.pid}`) || process.platform !== "linux");
  assert.equal(probeProcessIdentity(child.pid, null), "unknown");
  assert.equal(terminateRecordedProcessTree(child.pid, null).attempted, false);
  assert.equal(probeProcessIdentity(child.pid, null, { commandHint: "some-other-worker" }), process.platform === "linux" ? "different" : probeProcessIdentity(child.pid, null, { commandHint: "some-other-worker" }));
  if (process.platform === "linux") {
    assert.equal(probeProcessIdentity(child.pid, null, { commandHint: "codex-probe-hint" }), "same");
  }

  // Reconciliation must not declare a live worker lost just because identity is unverifiable.
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  const job = { id: "task-unknown", status: "running", title: "Codex Task", jobClass: "task", pid: child.pid, createdAt: nowStamp(), updatedAt: nowStamp() };
  fs.writeFileSync(path.join(stateDir, "jobs", "task-unknown.json"), JSON.stringify(job));
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 2, config: {}, jobs: [job] }));
  assert.equal(companionJson(["status", "task-unknown"], { cwd: workspace }).job.status, "running");
});

function nowStamp(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

test("concurrent followups cannot launch two turns for one ticket", async () => {
  const ctx = setupRepo();
  delegateAndWait(ctx, ["--ticket", "race", "Work.\nFAKE_WRITE src/r.js 1"]);
  const launch = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, "followup", "race", "Again.\nFAKE_SLOW", "--json"], { cwd: ctx.repo, env: ctx.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (code) => resolve({ code, stdout, stderr }));
    });
  const results = await Promise.all([launch(), launch(), launch()]);
  const succeeded = results.filter((result) => result.code === 0);
  assert.equal(succeeded.length, 1, JSON.stringify(results));
  for (const failure of results.filter((result) => result.code !== 0)) {
    assert.match(failure.stderr, /already has a running turn|is still running/);
  }
  const ticket = readTicketRecord(ctx.repo, "race");
  assert.deepEqual(ticket.turns.map((turn) => turn.turn), [1, 2]);
  companionJson(["cancel", "race"], { cwd: ctx.repo, env: ctx.env });
});

test("a ticket bound to a launch that never started is recovered as worker-lost", () => {
  const ctx = setupRepo();
  const stateDir = resolveStateDir(ctx.repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "tickets"), { recursive: true });
  const old = nowStamp(-5 * 60 * 1000);
  const job = { id: "ticket-stuck", status: "queued", kind: "ticket", jobClass: "task", ticketId: "stuck", pid: null, createdAt: old, updatedAt: old };
  fs.writeFileSync(path.join(stateDir, "jobs", "ticket-stuck.json"), JSON.stringify(job));
  fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ version: 2, config: {}, jobs: [job] }));
  const base = { version: 1, role: "implement", title: "Stuck", brief: "x", workdir: ctx.repo, isolation: "shared", sandbox: { write: true, network: false }, owns: [], acceptance: [], verifications: [], integrations: [], decisions: [], createdAt: old, updatedAt: old };
  fs.writeFileSync(path.join(stateDir, "tickets", "stuck.json"), JSON.stringify({ ...base, id: "stuck", state: "running", activeJobId: "ticket-stuck", turns: [{ turn: 1, jobId: "ticket-stuck" }] }));
  fs.writeFileSync(path.join(stateDir, "tickets", "orphan.json"), JSON.stringify({ ...base, id: "orphan", state: "running", activeJobId: "ticket-missing", turns: [{ turn: 1, jobId: "ticket-missing" }] }));

  const tickets = companionJson(["tickets"], { cwd: ctx.repo, env: ctx.env }).tickets;
  const byId = Object.fromEntries(tickets.map((ticket) => [ticket.id, ticket]));
  assert.equal(byId.stuck.state, "needs-review");
  assert.equal(byId.stuck.lastOutcome, "worker-lost");
  assert.equal(byId.orphan.state, "needs-review");
  assert.equal(byId.orphan.lastOutcome, "worker-lost");
});
