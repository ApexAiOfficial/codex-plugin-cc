import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { makeTempDir } from "./helpers.mjs";

const LOCKING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex", "scripts", "lib", "locking.mjs");

// Regression for a defect found by the linux-platform Codex review: when a lock's holder died,
// several contenders could each judge it stale and rename the lock path, and a later contender
// could rename away a fresh lock that another contender had just acquired. That let multiple
// processes into the critical section at once (up to 14 of 32 in the reviewer's stress test).
test("stale-lock recovery never admits two holders at once", async () => {
  const dir = makeTempDir();
  const lockPath = path.join(dir, "state.lock");
  const inside = path.join(dir, "inside");
  const overlaps = path.join(dir, "overlaps");
  const worker = path.join(dir, "worker.mjs");
  fs.writeFileSync(
    worker,
    `import fs from "node:fs";
const { withFileLock } = await import(${JSON.stringify(LOCKING)});
const [lockPath, inside, overlaps, go] = process.argv.slice(2);
// Start barrier: every contender reaches the stale lock at the same moment.
while (!fs.existsSync(go)) {}
for (let round = 0; round < 4; round += 1) {
  withFileLock(lockPath, () => {
    try {
      fs.writeFileSync(inside, String(process.pid), { flag: "wx" });
    } catch {
      fs.appendFileSync(overlaps, process.pid + "\\n");
      return;
    }
    const until = Date.now() + 2;
    while (Date.now() < until) {}
    fs.rmSync(inside, { force: true });
  }, { timeoutMs: 30000 });
}
`
  );

  for (let trial = 0; trial < 5; trial += 1) {
    const go = path.join(dir, `go-${trial}`);
    // A lock left behind by a dead holder, so every contender starts on the recovery path.
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => dead.on("exit", resolve));
    fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, token: "dead", acquiredAt: new Date(0).toISOString() }));
    const children = Array.from({ length: 24 }, () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, lockPath, inside, overlaps, go], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    fs.writeFileSync(go, "");
    await Promise.all(children);
    const overlapCount = fs.existsSync(overlaps) ? fs.readFileSync(overlaps, "utf8").split("\n").filter(Boolean).length : 0;
    assert.equal(overlapCount, 0, `trial ${trial}: ${overlapCount} overlapping critical sections`);
    assert.equal(fs.existsSync(lockPath), false, "the lock is released at the end");
  }
});

test("a lock judged stale is not broken if a live holder took it over meanwhile", async (t) => {
  const { withFileLock } = await import(LOCKING);
  const dir = makeTempDir();
  const lockPath = path.join(dir, "state.lock");
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => dead.on("exit", resolve));
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => live.kill("SIGKILL"));
  fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, token: "dead" }));
  let entered = false;
  assert.throws(
    () =>
      withFileLock(lockPath, () => (entered = true), {
        timeoutMs: 400,
        // Simulate another contender that recovered the stale lock and now holds a fresh one.
        beforeRecover: () => fs.writeFileSync(lockPath, JSON.stringify({ pid: live.pid, token: "live" }))
      }),
    /Timed out/
  );
  assert.equal(entered, false, "the fresh lock was not broken");
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, "live");
});

test("an abandoned recovery gate fails closed instead of guessing", async () => {
  const { withFileLock } = await import(LOCKING);
  const dir = makeTempDir();
  const lockPath = path.join(dir, "state.lock");
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => dead.on("exit", resolve));
  fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, token: "dead" }));
  fs.writeFileSync(`${lockPath}.recover`, JSON.stringify({ pid: dead.pid }));
  assert.throws(() => withFileLock(lockPath, () => "entered", { timeoutMs: 300 }), /recovery gate .*\.recover/);
});

test("a recovery gate whose pid was recycled by another process is also reported as abandoned", async (t) => {
  const { withFileLock } = await import(LOCKING);
  const dir = makeTempDir();
  const lockPath = path.join(dir, "state.lock");
  const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => dead.on("exit", resolve));
  // A live process stands in for the recycled pid; the recorded start marker is from the earlier owner.
  const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => live.kill("SIGKILL"));
  fs.writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, token: "dead" }));
  fs.writeFileSync(`${lockPath}.recover`, JSON.stringify({ pid: live.pid, marker: "linux:1" }));
  assert.throws(() => withFileLock(lockPath, () => "entered", { timeoutMs: 300 }), /abandoned by an earlier process with pid/);
});
