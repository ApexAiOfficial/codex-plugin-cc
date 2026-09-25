import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  createTicketWorktree,
  integrateWorktree,
  recoverInterruptedIntegration
} from "../plugins/codex/scripts/lib/worktree.mjs";

function runChecked(command, args, options) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed: ${result.stderr}${result.stdout}`);
  return result.stdout.trim();
}

function setupFixture(files, ticketId) {
  const repoRoot = makeTempDir("codex-integration-repo-");
  initGitRepo(repoRoot);
  for (const [filePath, content] of Object.entries(files)) {
    const target = path.join(repoRoot, filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  runChecked("git", ["add", "."], { cwd: repoRoot });
  runChecked("git", ["commit", "-m", "base"], { cwd: repoRoot });

  const worktreesRoot = makeTempDir("codex-integration-state-");
  const worktree = createTicketWorktree({
    repoRoot,
    worktreePath: path.join(worktreesRoot, ticketId),
    ticketId,
    linkDirs: []
  });
  return { repoRoot, worktree, ticketId, journalDir: `${worktree.path}.integration-journal` };
}

function writeWorktreeFile(worktree, filePath, content) {
  const target = path.join(worktree.path, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function integratedRef(repoRoot, ticketId) {
  const result = run("git", ["rev-parse", "--verify", "--quiet", `refs/codex-companion/tickets/${ticketId}/integrated`], { cwd: repoRoot });
  return result.status === 0 ? result.stdout.trim() : null;
}

function leaveInterruptedJournal(fixture, firstTarget, laterTarget) {
  const originalRmSync = fs.rmSync;
  let phase = "apply";
  fs.rmSync = function rmSyncWithInterruptedRollback(filePath, ...args) {
    const resolved = path.resolve(filePath);
    if (phase === "apply" && resolved === laterTarget) {
      phase = "rollback";
      throw new Error("injected apply failure");
    }
    if (phase === "rollback" && resolved === firstTarget) {
      phase = "recover";
      throw new Error("injected rollback interruption");
    }
    return originalRmSync.call(this, filePath, ...args);
  };
  try {
    assert.throws(() => integrateWorktree(fixture), /rollback was incomplete/);
  } finally {
    fs.rmSync = originalRmSync;
  }
}

test("integration refuses a target beneath a symlinked lead directory", { skip: process.platform === "win32" }, () => {
  const fixture = setupFixture({ "src/nested/value.txt": "base\n" }, "symlink-parent");
  writeWorktreeFile(fixture.worktree, "src/nested/value.txt", "ticket\n");

  const outside = makeTempDir("codex-integration-outside-");
  const outsideTarget = path.join(outside, "value.txt");
  fs.writeFileSync(outsideTarget, "outside\n");
  fs.rmSync(path.join(fixture.repoRoot, "src", "nested"), { recursive: true });
  fs.symlinkSync(outside, path.join(fixture.repoRoot, "src", "nested"), "dir");

  const result = integrateWorktree(fixture);

  assert.equal(result.applied, false);
  assert.deepEqual(result.conflicts, [{ path: "src/nested/value.txt", reason: "path traverses a symlink" }]);
  assert.equal(fs.readFileSync(outsideTarget, "utf8"), "outside\n");
  assert.equal(fs.existsSync(fixture.journalDir), false);
  assert.equal(integratedRef(fixture.repoRoot, fixture.ticketId), null);
});

test("a later apply failure restores earlier targets exactly", () => {
  const fixture = setupFixture({ "a-first.txt": "first base\n", "z-later.txt": "later base\n" }, "rollback");
  writeWorktreeFile(fixture.worktree, "a-first.txt", "first ticket\n");
  writeWorktreeFile(fixture.worktree, "z-later.txt", "later ticket\n");
  const firstTarget = path.join(fixture.repoRoot, "a-first.txt");
  const laterTarget = path.join(fixture.repoRoot, "z-later.txt");
  if (process.platform !== "win32") {
    fs.chmodSync(firstTarget, 0o600);
  }
  const originalMode = fs.statSync(firstTarget).mode & 0o7777;

  const originalWriteFileSync = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function writeFileSyncWithFailure(filePath, ...args) {
    if (!injected && path.resolve(filePath) === laterTarget) {
      injected = true;
      const error = new Error("injected apply failure");
      error.code = "EIO";
      throw error;
    }
    return originalWriteFileSync.call(this, filePath, ...args);
  };
  try {
    assert.throws(() => integrateWorktree(fixture), /injected apply failure/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(fs.readFileSync(firstTarget, "utf8"), "first base\n");
  assert.equal(fs.readFileSync(laterTarget, "utf8"), "later base\n");
  assert.equal(fs.statSync(firstTarget).mode & 0o7777, originalMode);
  assert.equal(fs.existsSync(fixture.journalDir), false);
  assert.equal(integratedRef(fixture.repoRoot, fixture.ticketId), null);
});

test("leftover integration journals restore targets and are removed", () => {
  const fixture = setupFixture({ "a-first.txt": "first base\n", "z-later.txt": "later base\n" }, "recover");
  writeWorktreeFile(fixture.worktree, "a-first.txt", "first ticket\n");
  writeWorktreeFile(fixture.worktree, "z-later.txt", "later ticket\n");
  const firstTarget = path.join(fixture.repoRoot, "a-first.txt");
  const laterTarget = path.join(fixture.repoRoot, "z-later.txt");

  leaveInterruptedJournal(fixture, firstTarget, laterTarget);

  assert.equal(fs.existsSync(path.join(fixture.journalDir, "manifest.json")), true);
  assert.equal(fs.readFileSync(firstTarget, "utf8"), "first ticket\n");
  assert.equal(fs.readFileSync(laterTarget, "utf8"), "later base\n");

  const recovery = recoverInterruptedIntegration(fixture);

  assert.equal(recovery.recovered, true);
  assert.deepEqual(recovery.restored, ["a-first.txt"]);
  assert.equal(fs.readFileSync(firstTarget, "utf8"), "first base\n");
  assert.equal(fs.readFileSync(laterTarget, "utf8"), "later base\n");
  assert.equal(fs.existsSync(fixture.journalDir), false);
  assert.equal(integratedRef(fixture.repoRoot, fixture.ticketId), null);

  leaveInterruptedJournal(fixture, firstTarget, laterTarget);
  const integrated = integrateWorktree(fixture);
  assert.equal(integrated.recovery.recovered, true);
  assert.deepEqual(integrated.recovery.restored, ["a-first.txt"]);
  assert.equal(fs.readFileSync(firstTarget, "utf8"), "first ticket\n");
  assert.equal(fs.readFileSync(laterTarget, "utf8"), "later ticket\n");
  assert.equal(fs.existsSync(fixture.journalDir), false);
});

test("recovery preserves a lead edit made after an interrupted integration", () => {
  const fixture = setupFixture({ "a-first.txt": "first base\n", "z-later.txt": "later base\n" }, "recover-diverged");
  writeWorktreeFile(fixture.worktree, "a-first.txt", "first ticket\n");
  writeWorktreeFile(fixture.worktree, "z-later.txt", "later ticket\n");
  const firstTarget = path.join(fixture.repoRoot, "a-first.txt");
  const laterTarget = path.join(fixture.repoRoot, "z-later.txt");

  leaveInterruptedJournal(fixture, firstTarget, laterTarget);
  fs.writeFileSync(firstTarget, "lead edit after interruption\n");

  assert.throws(() => integrateWorktree(fixture), (error) => {
    assert.equal(error.code, "ERR_INTEGRATION_RECOVERY_CONFLICT");
    assert.deepEqual(error.paths, ["a-first.txt"]);
    return true;
  });
  assert.equal(fs.readFileSync(firstTarget, "utf8"), "lead edit after interruption\n");
  assert.equal(fs.readFileSync(laterTarget, "utf8"), "later base\n");
  assert.equal(fs.existsSync(path.join(fixture.journalDir, "manifest.json")), true);
  assert.equal(integratedRef(fixture.repoRoot, fixture.ticketId), null);
});

test("a clean integration applies normally and removes its journal", () => {
  const fixture = setupFixture({ "existing.txt": "base\n" }, "clean");
  writeWorktreeFile(fixture.worktree, "existing.txt", "updated\n");
  writeWorktreeFile(fixture.worktree, "new/nested.txt", "created\n");

  const result = integrateWorktree(fixture);

  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(path.join(fixture.repoRoot, "existing.txt"), "utf8"), "updated\n");
  assert.equal(fs.readFileSync(path.join(fixture.repoRoot, "new", "nested.txt"), "utf8"), "created\n");
  assert.equal(fs.existsSync(fixture.journalDir), false);
  assert.equal(integratedRef(fixture.repoRoot, fixture.ticketId), result.integratedCommit);
  assert.equal(runChecked("git", ["diff", "--cached", "--name-only"], { cwd: fixture.repoRoot }), "");
});
