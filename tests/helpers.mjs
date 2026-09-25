import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
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

// Every temp dir this process created, plus the state dir the runtime derived for it under the
// fallback root (CLAUDE_PLUGIN_DATA is scrubbed above), would otherwise outlive the run: each
// full run used to leave ~200 dirs in the temp dir and ~90 under <tmp>/codex-companion.
function removeTestDirs() {
  const fallbackRoot = path.join(os.tmpdir(), "codex-companion") + path.sep;
  for (const dir of createdTempDirs) {
    try {
      const stateDir = resolveStateDir(dir);
      if (stateDir.startsWith(fallbackRoot)) {
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    } catch {
      // The dir may already be gone; nothing to derive.
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A still-running detached worker may hold files open; leave it.
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
