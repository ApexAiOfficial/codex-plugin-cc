import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { withCodexClient } from "./codex.mjs";
import { writeJsonAtomic } from "./locking.mjs";
import { resolveStateDir } from "./state.mjs";

export const PREFLIGHT_PROBE_MARKER = "codex-preflight-probe";
const CAPABILITY_CACHE_FILE = "capabilities.json";
const CACHE_TTL_MS = 30 * 60 * 1000;
const CHECK_TIMEOUT_MS = 120000;
const OUTPUT_TAIL_BYTES = 4000;
const DEFAULT_TOOLS = ["node", "npm", "pnpm", "yarn", "bun", "python3", "pip3", "uv", "pytest", "cargo", "go", "make", "docker", "git"];

// Runs identically on the host and inside the Codex sandbox; prints one JSON object.
// Availability is judged by exit status alone: inside the Codex Linux sandbox, spawnSync runs the
// child successfully yet still reports error EPERM (a denied post-spawn syscall) and can lose the
// child's stdout, so r.error or empty output would misreport working tools as missing.
const PROBE_SCRIPT = `
const cp = require("child_process"), fs = require("fs"), path = require("path"), dns = require("dns");
const tools = JSON.parse(process.argv[2] || "[]");
const out = { tools: {}, write: null, gitWrite: null, dockerDaemon: null, network: null, syncSpawnReliable: null };
const shell = process.platform === "win32";
for (const tool of tools) {
  const r = cp.spawnSync(tool, ["--version"], { encoding: "utf8", timeout: 5000, shell });
  const text = String(r.stdout || r.stderr || "").trim();
  out.tools[tool] = r.status === 0 ? text.split(/\\r?\\n/)[0].slice(0, 80) || "available" : null;
}
const echo = cp.spawnSync(process.execPath, ["-e", "process.stdout.write('codex-probe-echo')"], { encoding: "utf8", timeout: 10000 });
out.syncSpawnReliable = !echo.error && String(echo.stdout).includes("codex-probe-echo");
function canWrite(dir) {
  const probe = path.join(dir, ".codex-preflight-" + process.pid);
  try { fs.writeFileSync(probe, "x"); fs.unlinkSync(probe); return true; } catch { return false; }
}
out.write = canWrite(process.cwd());
const gitDir = cp.spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", shell });
out.gitWrite = gitDir.status === 0 ? canWrite(path.resolve(String(gitDir.stdout).trim())) : null;
if (out.tools.docker) {
  const d = cp.spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 8000, shell });
  out.dockerDaemon = d.status === 0;
}
const timer = setTimeout(() => { out.network = false; finish(); }, 5000);
let done = false;
function finish() { if (done) return; done = true; clearTimeout(timer); process.stdout.write(JSON.stringify(out)); }
dns.lookup("registry.npmjs.org", (error) => { out.network = !error; finish(); });
`;

export function buildSandboxPolicy({ workdir, write, network }) {
  if (write) {
    return {
      type: "workspaceWrite",
      writableRoots: [path.resolve(workdir)],
      networkAccess: Boolean(network),
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    };
  }
  return { type: "readOnly", networkAccess: Boolean(network) };
}

function probeArgv(tools) {
  return ["node", "-e", PROBE_SCRIPT, PREFLIGHT_PROBE_MARKER, JSON.stringify(tools)];
}

function shellArgv(command) {
  return process.platform === "win32" ? ["cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command];
}

function tail(text, limit = OUTPUT_TAIL_BYTES) {
  const value = String(text ?? "");
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

function parseProbe(stdout) {
  try {
    return JSON.parse(String(stdout ?? "").trim());
  } catch {
    return null;
  }
}

function runHostProbe(workdir, tools) {
  const [command, ...args] = probeArgv(tools);
  const result = spawnSync(command === "node" ? process.execPath : command, args, {
    cwd: workdir,
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true
  });
  return parseProbe(result.stdout);
}

/** Human-readable differences that should change routing or the Codex environment brief. */
export function summarizeLimitations(host, sandbox, policy) {
  const limitations = [];
  if (!sandbox) {
    return ["The sandbox probe did not return a result; treat the Codex environment as unverified."];
  }
  if (policy.type === "workspaceWrite" && sandbox.write === false) {
    limitations.push("Writing to the working directory failed inside the sandbox.");
  }
  if (sandbox.network === false && host?.network) {
    limitations.push("Network is unavailable in the sandbox (the host has it).");
  } else if (sandbox.network === false) {
    limitations.push("Network is unavailable on this machine.");
  }
  if (host?.dockerDaemon && sandbox.dockerDaemon === false) {
    limitations.push("The Docker daemon is not reachable from the sandbox, so container-based tests and services cannot run there.");
  }
  if (host?.syncSpawnReliable && sandbox.syncSpawnReliable === false) {
    limitations.push(
      "Synchronous child processes are unreliable in the sandbox (spawnSync/execFileSync report EPERM and Node children lose stdout); tests that shell out synchronously can fail or misreport there, so the lead's verify is authoritative for them."
    );
  }
  const missing = Object.entries(host?.tools ?? {})
    .filter(([tool, version]) => version && !sandbox.tools?.[tool])
    .map(([tool]) => tool);
  if (missing.length > 0) {
    limitations.push(`Tools present on the host but not runnable in the sandbox: ${missing.join(", ")}.`);
  }
  return limitations;
}

function cacheKey(workdir, policy) {
  return `${path.resolve(workdir)}|${policy.type}|${policy.networkAccess ? "net" : "offline"}`;
}

function readCache(workspaceRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveStateDir(workspaceRoot), CAPABILITY_CACHE_FILE), "utf8"));
  } catch {
    return {};
  }
}

export function readCachedPreflight(workspaceRoot, { workdir, write, network }) {
  const policy = buildSandboxPolicy({ workdir, write, network });
  const entry = readCache(workspaceRoot)[cacheKey(workdir, policy)];
  if (!entry || Date.now() - Date.parse(entry.at) > CACHE_TTL_MS) {
    return null;
  }
  return entry;
}

/**
 * Measure what a Codex worker with this sandbox profile can actually do, using the app-server's
 * `command/exec` under the exact sandbox policy a ticket turn will use. No model is involved.
 */
export async function runPreflight(workspaceRoot, { workdir, write, network, checks = [], tools = DEFAULT_TOOLS }) {
  const policy = buildSandboxPolicy({ workdir, write, network });
  const host = runHostProbe(workdir, tools);
  const { sandbox, checkResults } = await withCodexClient(
    workdir,
    async (client) => {
      const probe = await client.request("command/exec", {
        command: probeArgv(tools),
        cwd: workdir,
        sandboxPolicy: policy,
        timeoutMs: 60000
      });
      const results = [];
      for (const check of checks) {
        const started = Date.now();
        try {
          const response = await client.request("command/exec", {
            command: shellArgv(check),
            cwd: workdir,
            sandboxPolicy: policy,
            timeoutMs: CHECK_TIMEOUT_MS
          });
          results.push({
            command: check,
            exitCode: response.exitCode,
            durationMs: Date.now() - started,
            outputTail: tail(`${response.stdout ?? ""}${response.stderr ?? ""}`)
          });
        } catch (error) {
          results.push({ command: check, exitCode: null, durationMs: Date.now() - started, outputTail: error.message });
        }
      }
      return { sandbox: parseProbe(probe.stdout), checkResults: results };
    },
    // A short-lived private app-server: preflight is rare, and starting the shared broker here
    // would leave a long-lived process behind whenever no Claude session later ends it.
    { direct: true }
  );

  const report = {
    at: new Date().toISOString(),
    workdir: path.resolve(workdir),
    policy,
    host,
    sandbox,
    checks: checkResults,
    limitations: summarizeLimitations(host, sandbox, policy)
  };
  try {
    const cache = readCache(workspaceRoot);
    cache[cacheKey(workdir, policy)] = { ...report, checks: [] };
    writeJsonAtomic(path.join(resolveStateDir(workspaceRoot), CAPABILITY_CACHE_FILE), cache);
  } catch {
    // The cache is an optimization only.
  }
  return report;
}
