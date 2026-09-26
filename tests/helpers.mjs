import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { sleepSync } from "../plugins/codex/scripts/lib/locking.mjs";
import { isSameProcess } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";

// Tests must not inherit the host Claude session's plugin wiring. When the suite runs inside a
// Claude Code session with this plugin installed, these variables point at the user's real
// session and plugin data directory, which both leaks state into tests and pollutes that directory.
for (const name of [
  "CODEX_COMPANION_SESSION_ID",
  "CODEX_COMPANION_TRANSCRIPT_PATH",
  "CODEX_COMPANION_APP_SERVER_ENDPOINT",
  "CODEX_COMPANION_APP_SERVER_PID_FILE",
  "CODEX_COMPANION_APP_SERVER_LOG_FILE",
  "CODEX_COMPANION",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_ENV_FILE"
]) {
  delete process.env[name];
}

const createdTempDirs = new Set();

export function makeTempDir(prefix = "codex-plugin-test-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdTempDirs.add(dir);
  return dir;
}

// Capacity telemetry is shared across workspaces (one file under the state root); give each test
// process its own file so parallel test files never read each other's telemetry. Children inherit it.
process.env.CODEX_COMPANION_CAPACITY_FILE = path.join(makeTempDir("codex-capacity-"), "capacity.json");

// Foreground commands lazily start a detached shared broker (plus its app-server) for their
// workspace, exactly as in a real session where SessionEnd shuts it down. Tests never end a
// session, so without this every such test leaked two long-lived processes; repeated runs could
// exhaust memory. Only brokers of workspaces created by this test process are touched.
function shutDownTestBrokers() {
  for (const dir of createdTempDirs) {
    let session = null;
    try {
      session = loadBrokerSession(dir);
    } catch {
      continue;
    }
    if (!Number.isInteger(session?.pid)) {
      continue;
    }
    for (const target of process.platform === "win32" ? [session.pid] : [-session.pid, session.pid]) {
      try {
        process.kill(target, "SIGTERM");
        break;
      } catch {
        // Already gone, or not a process group leader; try the next form.
      }
    }
  }
}

// Every temp dir this process created, plus the state dirs the runtime derived for it, would
// otherwise outlive the run: each full run used to leave ~200 dirs in the temp dir and ~90 under
// <tmp>/codex-companion. A state dir is either under the fallback root (CLAUDE_PLUGIN_DATA is
// scrubbed above) or under <dir>/state/ when the dir served as a child's CLAUDE_PLUGIN_DATA.
function stateDirsFor(dir, fallbackRoot) {
  const found = [];
  try {
    const derived = resolveStateDir(dir);
    if (derived.startsWith(fallbackRoot)) {
      found.push(derived);
    }
  } catch {
    // The dir may already be gone; nothing to derive.
  }
  try {
    for (const entry of fs.readdirSync(path.join(dir, "state"), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        found.push(path.join(dir, "state", entry.name));
      }
    }
  } catch {
    // Not a plugin data dir.
  }
  return found;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// A detached ticket worker a test left running would otherwise keep going with its cwd and state
// deleted underneath it. Stop the ones recorded in these state dirs first, identity-checked.
function stopRecordedWorkers(stateDirs) {
  const live = [];
  for (const stateDir of stateDirs) {
    let jobs = [];
    try {
      jobs = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")).jobs ?? [];
    } catch {
      continue;
    }
    for (const job of jobs) {
      const active = job.status === "queued" || job.status === "running";
      if (active && Number.isInteger(job.pid) && isSameProcess(job.pid, job.pidMarker ?? null, { commandHint: job.pidCommandHint })) {
        live.push(job.pid);
      }
    }
  }
  const signal = (name) => {
    for (const pid of live) {
      for (const target of process.platform === "win32" ? [pid] : [-pid, pid]) {
        try {
          process.kill(target, name);
          break;
        } catch {
          // Not a group leader, or already gone.
        }
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 2000;
  while (live.some(isAlive) && Date.now() < deadline) {
    sleepSync(25);
  }
  if (live.some(isAlive)) {
    signal("SIGKILL");
  }
}

function removeTestDirs() {
  const fallbackRoot = path.join(os.tmpdir(), "codex-companion") + path.sep;
  const stateDirs = [...createdTempDirs].flatMap((dir) => stateDirsFor(dir, fallbackRoot));
  stopRecordedWorkers(stateDirs);
  for (const target of [...stateDirs, ...createdTempDirs]) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Leave anything that cannot be removed.
    }
  }
}

process.on("exit", () => {
  shutDownTestBrokers();
  if (!process.env.CODEX_TEST_KEEP_TEMP) {
    removeTestDirs();
  }
});
// A test file killed by a timeout or Ctrl-C must not strand brokers either.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    shutDownTestBrokers();
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
  });
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
