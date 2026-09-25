// Real-process drill: can a process started by a sandboxed Codex command outlive that command?
// Uses app-server `command/exec` under the same sandbox policies tickets use (no model turns, no
// Codex quota) and a disposable directory. On Linux, Codex runs commands under
// `bwrap --unshare-pid --as-pid-1 --die-with-parent`, so everything a command starts (including
// setsid/nohup/double-forked daemons) dies with it. This drill guards that assumption, which is why
// the companion needs no cgroup containment for ticket commands. Not part of `npm test`:
//   node tests/drills/sandbox-containment-drill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "codex-containment-drill-"));
process.env.CLAUDE_PLUGIN_DATA = path.join(SCRATCH, "data");
const { CodexAppServerClient } = await import(path.join(REPO, "plugins/codex/scripts/lib/app-server.mjs"));
const { buildSandboxPolicy } = await import(path.join(REPO, "plugins/codex/scripts/lib/capabilities.mjs"));

const tag = `containment${process.pid}`;
// `node` keeps its extra argv visible to ps (a shell would exec `sleep` and drop the marker).
const daemon = (name, ms = 300000) => `node -e 'setTimeout(() => {}, ${ms})' ${tag}-${name}`;
const matching = () =>
  execFileSync("ps", ["-eo", "pid=,cmd="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(tag) && !line.includes("ps -eo"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures += 1;
};

const variants = [
  ["background", `${daemon("bg")} &`],
  ["nohup", `nohup ${daemon("nohup")} >/dev/null 2>&1 &`],
  ["setsid", `setsid ${daemon("setsid")} >/dev/null 2>&1 < /dev/null &`],
  ["double fork", `( ( ${daemon("fork")} >/dev/null 2>&1 & ) & ) ;`]
];

const client = await CodexAppServerClient.connect(SCRATCH, { disableBroker: true });
try {
  for (const [label, policy] of [
    ["workspace-write", buildSandboxPolicy({ workdir: SCRATCH, write: true })],
    ["workspace-write + network", buildSandboxPolicy({ workdir: SCRATCH, write: true, network: true })],
    ["read-only", buildSandboxPolicy({ workdir: SCRATCH, write: false })]
  ]) {
    console.log(`\n# ${label}`);
    // Positive control: while the command still runs, its detached child must be visible.
    const running = client.request("command/exec", {
      command: ["sh", "-c", `setsid ${daemon("control")} >/dev/null 2>&1 < /dev/null & ${daemon("fg", 3000)}; echo done`],
      cwd: SCRATCH,
      sandboxPolicy: policy,
      timeoutMs: 20000
    });
    await sleep(1500);
    check(matching().some((line) => line.includes(`${tag}-control`)), "control: a detached child is visible while its command runs");
    const result = await running;
    check(result.exitCode === 0, "control command exited 0");
    for (const [name, script] of variants) {
      const started = await client.request("command/exec", {
        command: ["sh", "-c", `${script} echo started`],
        cwd: SCRATCH,
        sandboxPolicy: policy,
        timeoutMs: 20000
      });
      check(started.exitCode === 0, `${name}: launched`);
    }
    await sleep(1000);
    const survivors = matching();
    check(survivors.length === 0, survivors.length ? `SURVIVORS: ${survivors.join(" | ")}` : "nothing outlived its command");
    for (const line of survivors) {
      try {
        process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL");
      } catch {}
    }
  }
} finally {
  await client.close();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} FAILED` : "ALL DRILLS PASSED"}`);
process.exit(failures ? 1 : 0);
