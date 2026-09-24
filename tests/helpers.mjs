import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

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

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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
