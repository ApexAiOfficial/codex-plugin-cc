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
  assert.equal(payload.tokenUsage.totalTokens, 1234);
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

test("infrastructure failures are classified separately from bad work", () => {
  const ctx = setupRepo();
  const { waited } = delegateAndWait(ctx, ["--ticket", "quota", "Anything.\nFAKE_TURN_FAIL"]);
  assert.equal(waited.ticket.lastOutcome, "quota");
  assert.equal(waited.job.failureKind, "quota");
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
  const ticket = readTicketRecord(ctx.repo, "after");
  assert.ok(JSON.parse(fs.readFileSync(resolveJobFile(ctx.repo, ticket.lastJobId), "utf8")).notifiedAt);
});
