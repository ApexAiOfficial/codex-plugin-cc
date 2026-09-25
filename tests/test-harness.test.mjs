import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TESTS = path.dirname(fileURLToPath(import.meta.url));
const HELPERS = path.join(TESTS, "helpers.mjs");
const STATE = path.join(TESTS, "..", "plugins", "codex", "scripts", "lib", "state.mjs");
const PROCESS = path.join(TESTS, "..", "plugins", "codex", "scripts", "lib", "process.mjs");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Regression for a review finding: exit cleanup removed a test's dirs while a detached worker
// recorded in them was still running, leaving that worker alive in a deleted directory.
test("exit cleanup stops a recorded detached worker before removing its dirs", async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "codex-harness-test-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const script = path.join(scratch, "leave-worker.mjs");
  fs.writeFileSync(
    script,
    `import { spawn } from "node:child_process";
const { makeTempDir } = await import(${JSON.stringify(HELPERS)});
const { upsertJob } = await import(${JSON.stringify(STATE)});
const { getProcessStartMarker } = await import(${JSON.stringify(PROCESS)});
const workspace = makeTempDir();
const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: workspace, detached: true, stdio: "ignore" });
worker.unref();
await new Promise((resolve) => setTimeout(resolve, 200));
upsertJob(workspace, { id: "left-running", kind: "task", status: "running", pid: worker.pid, pidMarker: getProcessStartMarker(worker.pid) });
console.log(JSON.stringify({ workspace, pid: worker.pid }));
`
  );
  const result = spawnSync(process.execPath, [script], { encoding: "utf8", env: { ...process.env, CODEX_TEST_KEEP_TEMP: "" } });
  assert.equal(result.status, 0, result.stderr);
  const { workspace, pid } = JSON.parse(result.stdout.trim().split("\n").pop());
  t.after(() => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already stopped, as expected.
    }
  });

  const until = Date.now() + 3000;
  while (alive(pid) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive(pid), false, "the recorded worker was stopped, not left running in a deleted dir");
  assert.equal(fs.existsSync(workspace), false, "the workspace dir was removed");
});
