// Prepares (or removes) a disposable workspace for the interactive live-plugin check:
// a git repo, a fake Codex binary (the test fixture; no quota, deterministic), and one finished
// ticket staged in the data dir Claude Code gives a `--plugin-dir` copy of this plugin, so the
// SessionStart ledger has something to show. Not part of `npm test`.
//   node tests/drills/live-check-setup.mjs            # set up, print the command to run
//   node tests/drills/live-check-setup.mjs --cleanup  # remove the workspace and its plugin state
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { installFakeCodex } from "../fake-codex-fixture.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPANION = path.join(REPO, "plugins", "codex", "scripts", "codex-companion.mjs");
const ROOT = path.join(os.homedir(), ".cache", "codex-companion-live-check");
const BIN = path.join(ROOT, "bin");
const WORKSPACE = path.join(ROOT, "repo");
// Claude Code's data dir for a plugin loaded with --plugin-dir (named "<plugin>-inline").
const PLUGIN_DATA = path.join(os.homedir(), ".claude", "plugins", "data", "codex-inline");

const env = {
  ...process.env,
  CLAUDE_PLUGIN_DATA: PLUGIN_DATA,
  CODEX_COMPANION_CODEX_BIN: path.join(BIN, "codex")
};
delete env.CODEX_COMPANION_SESSION_ID;
const companion = (...args) => execFileSync(process.execPath, [COMPANION, ...args], { cwd: WORKSPACE, env, encoding: "utf8" });

function stateDirFor(workspace) {
  // Resolve exactly as the runtime does, so cleanup removes only this workspace's state.
  return execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const { resolveStateDir } = await import(${JSON.stringify(path.join(REPO, "plugins/codex/scripts/lib/state.mjs"))}); process.stdout.write(resolveStateDir(${JSON.stringify(workspace)}));`],
    { env, encoding: "utf8" }
  );
}

if (process.argv.includes("--cleanup")) {
  if (fs.existsSync(WORKSPACE)) {
    const stateDir = stateDirFor(WORKSPACE);
    if (stateDir.startsWith(PLUGIN_DATA + path.sep)) {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(`Removed ${ROOT} and its state under ${PLUGIN_DATA}.`);
  process.exit(0);
}

if (fs.existsSync(WORKSPACE)) {
  fs.rmSync(stateDirFor(WORKSPACE), { recursive: true, force: true });
}
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
installFakeCodex(BIN, "review-ok");
const git = (...args) => execFileSync("git", args, { cwd: WORKSPACE, encoding: "utf8" });
git("init", "-q");
fs.writeFileSync(path.join(WORKSPACE, "notes.txt"), "live check\n");
git("add", ".");
git("-c", "user.email=live-check@example.invalid", "-c", "user.name=live-check", "commit", "-qm", "init");

companion("delegate", "--ticket", "staged", "--title", "Staged ticket for the live check", "Staged before the session so the SessionStart ledger lists it.");
companion("wait", "staged", "--timeout-ms", "30000");
const ledgerCheck = JSON.parse(companion("tickets", "--json"));
const staged = (ledgerCheck.tickets ?? ledgerCheck).find?.((ticket) => ticket.id === "staged");
if (!staged || staged.state !== "needs-review") {
  console.error("Staging failed: ticket 'staged' is not waiting for review.", JSON.stringify(ledgerCheck).slice(0, 400));
  process.exit(1);
}

console.log(`Workspace: ${WORKSPACE}`);
console.log(`Plugin state: ${stateDirFor(WORKSPACE)}`);
console.log("Staged ticket 'staged' is waiting for review.");
