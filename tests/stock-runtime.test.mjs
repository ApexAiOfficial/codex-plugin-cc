import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { binaryAvailable } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveJobFile, resolveStateFile, resolveTicketFile } from "../plugins/codex/scripts/lib/state.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "codex", "scripts", "codex-companion.mjs");

function setupRepo(behavior = "review-ok") {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "stock runtime regressions\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return {
    repo,
    binDir,
    env: buildEnv(binDir),
    fakeState: () => JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"))
  };
}

test("binary availability ignores a missing cwd", () => {
  const missingCwd = path.join(makeTempDir(), "removed");

  const result = binaryAvailable(process.execPath, ["--version"], { cwd: missingCwd });

  assert.equal(result.available, true, result.detail);
  assert.match(result.detail, /^v\d+/);
});

test("task treats dash-prefixed tokens after the first prompt token as prompt text", () => {
  const ctx = setupRepo();

  const result = run("node", [SCRIPT, "task", "--json --write review conflict_scan.cli and run -m pytest"], {
    cwd: ctx.repo,
    env: ctx.env
  });

  assert.equal(result.status, 0, result.stderr);
  const turnStart = ctx.fakeState().lastTurnStart;
  assert.equal(turnStart.model, null);
  assert.equal(turnStart.prompt, "review conflict_scan.cli and run -m pytest");
  const state = JSON.parse(fs.readFileSync(resolveStateFile(ctx.repo), "utf8"));
  assert.equal(state.jobs.find((job) => job.jobClass === "task")?.write, true);
});

test("delegate treats dash-prefixed tokens after the brief starts as brief text", async () => {
  const ctx = setupRepo();

  const result = run(
    "node",
    [SCRIPT, "delegate", "--json --ticket parse-boundary --role investigate inspect conflict_scan.cli and run -m pytest"],
    { cwd: ctx.repo, env: ctx.env }
  );

  assert.equal(result.status, 0, result.stderr);
  const ticket = JSON.parse(fs.readFileSync(resolveTicketFile(ctx.repo, "parse-boundary"), "utf8"));
  assert.equal(ticket.model, null);
  assert.equal(ticket.brief, "inspect conflict_scan.cli and run -m pytest");

  const payload = JSON.parse(result.stdout);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const job = JSON.parse(fs.readFileSync(resolveJobFile(ctx.repo, payload.jobId), "utf8"));
    if (["completed", "failed", "cancelled"].includes(job.status)) {
      assert.equal(job.status, "completed", job.errorMessage);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for the delegated regression ticket.");
});

test("a failed completed turn persists and renders a readable error", () => {
  const ctx = setupRepo("failed-turn");

  const result = run("node", [SCRIPT, "task", "--json reproduce the server failure"], {
    cwd: ctx.repo,
    env: ctx.env
  });

  assert.equal(result.status, 1, result.stderr);
  const state = JSON.parse(fs.readFileSync(resolveStateFile(ctx.repo), "utf8"));
  const job = state.jobs.find((candidate) => candidate.jobClass === "task");
  assert.ok(job);
  assert.equal(job.status, "failed");
  assert.equal(job.errorMessage, "usage limit reached");
  assert.equal(job.summary, "usage limit reached");
  assert.notEqual(job.summary, "{");

  const storedJob = JSON.parse(fs.readFileSync(resolveJobFile(ctx.repo, job.id), "utf8"));
  assert.equal(storedJob.errorMessage, "usage limit reached");

  const status = run("node", [SCRIPT, "status", job.id], { cwd: ctx.repo, env: ctx.env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Error: usage limit reached/);

  const renderedResult = run("node", [SCRIPT, "result", job.id], { cwd: ctx.repo, env: ctx.env });
  assert.equal(renderedResult.status, 0, renderedResult.stderr);
  assert.match(renderedResult.stdout, /Error: usage limit reached/);
});
