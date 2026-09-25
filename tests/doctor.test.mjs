import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { collectDoctorReport, renderDoctorReport } from "../plugins/codex/scripts/lib/doctor.mjs";
import { makeTempDir } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function setupWorkspace() {
  const repo = makeTempDir("codex-doctor-repo-");
  const pluginData = makeTempDir("codex-doctor-data-");
  const home = makeTempDir("codex-doctor-home-");
  fs.writeFileSync(path.join(repo, "README.md"), "doctor fixture\n", "utf8");
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, ".codex"),
    CLAUDE_PLUGIN_DATA: pluginData,
    CODEX_COMPANION: SCRIPT
  };
  return { repo, env, pluginData };
}

async function doctor(ctx, overrides = {}) {
  return collectDoctorReport(ctx.repo, {
    env: ctx.env,
    scriptPath: SCRIPT,
    binaryAvailableImpl: () => ({ available: true, detail: "codex-cli test" }),
    runCommandImpl: (_command, args, options) => ({
      status: 0,
      signal: null,
      stdout: args[0] === "worktree" ? `worktree ${options.cwd}\nHEAD 0000000\n\n` : "",
      stderr: "",
      error: null
    }),
    waitForBrokerEndpointImpl: async () => false,
    ...overrides
  });
}

async function withWorkspace(callback) {
  const ctx = setupWorkspace();
  const names = ["CLAUDE_PLUGIN_DATA", "CODEX_COMPANION", "HOME", "CODEX_HOME"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    process.env[name] = ctx.env[name];
  }
  try {
    const initial = await doctor(ctx);
    assert.equal(initial.ok, true);
    ctx.stateDir = initial.stateDir;
    return await callback(ctx);
  } finally {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

function finding(report, code) {
  return report.findings.find((entry) => entry.code === code);
}

function findings(report, code) {
  return report.findings.filter((entry) => entry.code === code);
}

function writeState(stateDir, jobs = []) {
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "state.json"), `${JSON.stringify({ version: 2, config: {}, jobs }, null, 2)}\n`, "utf8");
}

function snapshotTree(root) {
  if (!fs.existsSync(root)) {
    return null;
  }
  const snapshot = {};
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.join(prefix, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = "directory";
        visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        snapshot[relative] = `symlink:${fs.readlinkSync(absolute)}`;
      } else {
        snapshot[relative] = fs.readFileSync(absolute).toString("base64");
      }
    }
  };
  visit(root);
  return snapshot;
}

test("a clean workspace passes and renders every health section", async () => withWorkspace(async (ctx) => {
  const report = await doctor(ctx);

  assert.equal(report.ok, true);
  assert.deepEqual(report.sections.map((section) => section.id), ["runtime", "state", "broker", "jobs", "tickets", "worktrees", "platform"]);
  assert.equal(report.findings.some((entry) => entry.status === "FAIL"), false);
  assert.equal(finding(report, "codex-version").data.version, "codex-cli test");

  const human = renderDoctorReport(report);
  assert.match(human, /Runtime:\nOK /);
  assert.match(human, /State:/);
  assert.match(human, /Broker:/);
  assert.match(human, /Jobs and workers:/);
  assert.match(human, /Tickets:/);
  assert.match(human, /Worktrees:/);
  assert.match(human, /Platform:/);
  assert.match(human, /Fix: /);
}));

test("a corrupt state.json is a failure and is not quarantined or rewritten", async () => withWorkspace(async (ctx) => {
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  const corrupt = "{ definitely not json\n";
  fs.writeFileSync(path.join(ctx.stateDir, "state.json"), corrupt, "utf8");

  const before = snapshotTree(ctx.stateDir);
  const report = await doctor(ctx);
  const after = snapshotTree(ctx.stateDir);

  assert.equal(report.ok, false);
  assert.equal(finding(report, "state-json").status, "FAIL");
  assert.match(finding(report, "state-json").summary, /does not parse/i);
  assert.deepEqual(after, before);
  assert.equal(fs.readFileSync(path.join(ctx.stateDir, "state.json"), "utf8"), corrupt);
  assert.equal(fs.readdirSync(ctx.stateDir).some((name) => name.startsWith("state.json.corrupt-")), false);
}));

test("a leftover integration journal is a failure with recovery guidance", async () => withWorkspace(async (ctx) => {
  writeState(ctx.stateDir);
  const journal = path.join(ctx.stateDir, "worktrees", "ticket-a.integration-journal");
  fs.mkdirSync(journal, { recursive: true });
  fs.writeFileSync(path.join(journal, "manifest.json"), "{}\n", "utf8");

  const report = await doctor(ctx);
  const diagnostic = finding(report, "integration-journals");

  assert.equal(report.ok, false);
  assert.equal(diagnostic.status, "FAIL");
  assert.match(diagnostic.summary, /ticket-a\.integration-journal/);
  assert.match(diagnostic.fix, /next integrate recovers/i);
}));

test("an orphan worktree directory is reported without changing it", async () => withWorkspace(async (ctx) => {
  writeState(ctx.stateDir);
  const orphan = path.join(ctx.stateDir, "worktrees", "orphan-ticket");
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "keep.txt"), "keep\n", "utf8");

  const before = snapshotTree(ctx.stateDir);
  const report = await doctor(ctx);

  assert.equal(report.ok, true);
  assert.equal(finding(report, "orphan-worktree-directories").status, "WARN");
  assert.deepEqual(finding(report, "orphan-worktree-directories").data.paths, [orphan]);
  assert.deepEqual(snapshotTree(ctx.stateDir), before);
}));

test("dead broker metadata is reported as stale after a connection-only probe", async () => withWorkspace(async (ctx) => {
  writeState(ctx.stateDir);
  const broker = {
    pid: 2147483647,
    pidMarker: "linux:dead",
    endpoint: `unix:${path.join(ctx.stateDir, "missing-broker.sock")}`,
    pidFile: path.join(ctx.stateDir, "missing.pid"),
    logFile: path.join(ctx.stateDir, "missing.log")
  };
  fs.writeFileSync(path.join(ctx.stateDir, "broker.json"), `${JSON.stringify(broker, null, 2)}\n`, "utf8");

  const before = snapshotTree(ctx.stateDir);
  const report = await doctor(ctx);

  assert.equal(report.ok, true);
  assert.equal(finding(report, "broker-identity").data.identity, "gone");
  assert.equal(finding(report, "broker-stale-metadata").status, "WARN");
  assert.equal(finding(report, "broker-endpoint").data.reachable, false);
  assert.deepEqual(snapshotTree(ctx.stateDir), before);
}));

test("a dead running job is flagged exactly as worker-lost reconciliation would", async () => withWorkspace(async (ctx) => {
  const job = {
    id: "ticket-dead",
    kind: "ticket",
    status: "running",
    phase: "working",
    ticketId: "dead-ticket",
    pid: 2147483647,
    pidMarker: "linux:dead",
    pidCommandHint: "--job-id ticket-dead",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    updatedAt: "2026-01-01T00:00:02.000Z"
  };
  writeState(ctx.stateDir, [job]);
  fs.writeFileSync(path.join(ctx.stateDir, "jobs", `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`, "utf8");

  const before = snapshotTree(ctx.stateDir);
  const report = await doctor(ctx);
  const diagnostic = findings(report, "active-job").find((entry) => entry.data.id === job.id);

  assert.equal(report.ok, false);
  assert.equal(diagnostic.status, "FAIL");
  assert.equal(diagnostic.data.identity, "gone");
  assert.equal(diagnostic.data.wouldReconcileWorkerLost, true);
  assert.match(diagnostic.summary, /worker-lost/);
  assert.deepEqual(snapshotTree(ctx.stateDir), before);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ctx.stateDir, "state.json"), "utf8")).jobs[0].status, "running");
}));

test("runtime skew, stale locks, inconsistent tickets, missing worktrees, and closed refs are structured findings", async () => withWorkspace(async (ctx) => {
  writeState(ctx.stateDir);
  fs.mkdirSync(path.join(ctx.env.HOME, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(ctx.env.HOME, ".codex", "config.toml"), 'CODEX_CLI_PATH = "/alternate/codex"\n', "utf8");
  fs.writeFileSync(
    path.join(ctx.stateDir, "state.lock"),
    JSON.stringify({ pid: 2147483647, marker: "linux:dead", token: "stale-token" }),
    "utf8"
  );
  fs.mkdirSync(path.join(ctx.stateDir, "tickets"), { recursive: true });
  const missingPath = path.join(ctx.stateDir, "worktrees", "running-ticket");
  fs.writeFileSync(
    path.join(ctx.stateDir, "tickets", "running-ticket.json"),
    JSON.stringify({
      id: "running-ticket",
      state: "running",
      activeJobId: "missing-job",
      isolation: "worktree",
      workdir: missingPath,
      worktree: { path: missingPath },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(ctx.stateDir, "tickets", "closed-ticket.json"),
    JSON.stringify({ id: "closed-ticket", state: "accepted", closedAt: "2026-01-02T00:00:00.000Z" }),
    "utf8"
  );

  const before = snapshotTree(ctx.stateDir);
  const report = await doctor(ctx, {
    binaryAvailableImpl: (command) => ({
      available: true,
      detail: command === "/alternate/codex" ? "codex-cli newer" : "codex-cli test"
    }),
    runCommandImpl: (_command, args, options) => ({
      status: 0,
      signal: null,
      stdout:
        args[0] === "worktree"
          ? `worktree ${options.cwd}\nHEAD 0000000\n\n`
          : "refs/codex-companion/tickets/closed-ticket/base\n",
      stderr: "",
      error: null
    })
  });

  assert.equal(finding(report, "codex-version-skew").status, "WARN");
  assert.match(finding(report, "codex-version-skew").summary, /cannot be resumed.*fresh threads/i);
  assert.equal(finding(report, "state-lock").data.identity, "gone");
  assert.equal(finding(report, "open-ticket").data.inconsistent, true);
  assert.equal(finding(report, "missing-recorded-worktrees").status, "FAIL");
  assert.deepEqual(finding(report, "closed-ticket-refs").data.refs, ["refs/codex-companion/tickets/closed-ticket/base"]);
  assert.equal(report.ok, false);
  assert.deepEqual(snapshotTree(ctx.stateDir), before);
}));
