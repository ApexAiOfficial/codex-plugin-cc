// Real-process broker drills: a real `codex app-server` behind the real broker, a disposable git
// repository, and a disposable state dir. No model turns are used, so no Codex quota is spent.
// Not part of `npm test` (it needs a working Codex CLI); run it by hand:
//   node tests/drills/broker-drill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "codex-broker-drill-"));
const DRILL = path.join(SCRATCH, "repo");
fs.mkdirSync(DRILL);
execFileSync("git", ["init", "-q"], { cwd: DRILL });
process.env.CLAUDE_PLUGIN_DATA = path.join(SCRATCH, "data");
process.env.CODEX_COMPANION_BROKER_IDLE_MS = "4000";
delete process.env.CODEX_COMPANION_APP_SERVER_ENDPOINT;

const lib = (name) => import(path.join(REPO, "plugins/codex/scripts/lib", name));
const { CodexAppServerClient } = await lib("app-server.mjs");
const { loadBrokerSession } = await lib("broker-lifecycle.mjs");
const { buildSandboxPolicy } = await lib("capabilities.mjs");
const HOOK = path.join(REPO, "plugins/codex/scripts/session-lifecycle-hook.mjs");

let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
  if (!ok) failures += 1;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const childrenOf = (pid) =>
  execFileSync("ps", ["-o", "pid=,cmd=", "--ppid", String(pid)], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const waitUntil = async (fn, ms, step = 100) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await sleep(step);
  }
  return fn();
};
const sessionEnd = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK, "SessionEnd"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", cwd: DRILL, session_id: "drill-session" }));
  });
const exec = (client, argv, timeoutMs = 60000) =>
  client.request("command/exec", { command: argv, cwd: DRILL, sandboxPolicy: buildSandboxPolicy({ workdir: DRILL, write: false }), timeoutMs });
const brokerPids = () => {
  const session = loadBrokerSession(DRILL);
  if (!session?.pid) return null;
  const kids = childrenOf(session.pid).filter((line) => / app-server/.test(line));
  return { session, broker: session.pid, appServer: kids.length ? Number(kids[0].split(/\s+/)[0]) : null };
};

// ---- Drill 1: SessionEnd while the broker is busy -------------------------------------------
console.log("\n# Drill 1: SessionEnd during an in-flight request");
{
  const client = await CodexAppServerClient.connect(DRILL, {});
  const pids = brokerPids();
  check(Boolean(pids?.broker && alive(pids.broker)), `broker started (pid ${pids?.broker})`);
  check(Boolean(pids?.appServer && alive(pids.appServer)), `broker owns a real codex app-server (pid ${pids?.appServer})`);
  const inflight = exec(client, ["sh", "-c", "sleep 8; echo drill-done"]);
  await sleep(1500);
  const ended = await sessionEnd();
  check(ended.code === 0, `SessionEnd hook exited 0 (${ended.out.trim() || "no output"})`);
  check(alive(pids.broker) && Boolean(loadBrokerSession(DRILL)), "busy broker survived SessionEnd and kept its metadata");
  const result = await inflight;
  check(result.exitCode === 0 && /drill-done/.test(result.stdout ?? ""), "in-flight command finished normally through the broker");
  await client.close();
  const ended2 = await sessionEnd();
  check(ended2.code === 0, "second SessionEnd (idle) exited 0");
  check(await waitUntil(() => !alive(pids.broker), 5000), "idle broker shut down on SessionEnd");
  check(await waitUntil(() => !alive(pids.appServer), 5000), "its app-server exited too (no orphan)");
  check(!loadBrokerSession(DRILL), "broker metadata cleared");
}

// ---- Drill 2: the broker's app-server dies ------------------------------------------------
console.log("\n# Drill 2: the broker's app-server is SIGKILLed");
{
  const client = await CodexAppServerClient.connect(DRILL, {});
  const pids = brokerPids();
  await exec(client, ["true"]);
  await client.close();
  process.kill(pids.appServer, "SIGKILL");
  check(await waitUntil(() => !alive(pids.broker), 5000), `broker ${pids.broker} exited on its own after its app-server died`);
  const next = await CodexAppServerClient.connect(DRILL, {});
  const after = brokerPids();
  check(after && after.broker !== pids.broker && alive(after.broker), `next caller got a fresh broker (pid ${after?.broker})`);
  const result = await exec(next, ["sh", "-c", "echo healthy"]);
  check(/healthy/.test(result.stdout ?? ""), "fresh broker serves requests");
  await next.close();
}

// ---- Drill 3: the broker itself is SIGKILLed ------------------------------------------------
console.log("\n# Drill 3: the broker process is SIGKILLed");
{
  const pids = brokerPids();
  process.kill(pids.broker, "SIGKILL");
  check(await waitUntil(() => !alive(pids.appServer), 5000), `orphaned app-server ${pids.appServer} exited (stdin EOF)`);
  check(Boolean(loadBrokerSession(DRILL)), "stale metadata is still on disk (expected; replaced on next use)");
  const next = await CodexAppServerClient.connect(DRILL, {});
  const after = brokerPids();
  check(after && after.broker !== pids.broker && alive(after.broker), `dead broker's metadata replaced by a live broker (pid ${after?.broker})`);
  const result = await exec(next, ["sh", "-c", "echo healthy"]);
  check(/healthy/.test(result.stdout ?? ""), "replacement broker serves requests");
  await next.close();
}

// ---- Drill 4: idle exit ----------------------------------------------------------------------
console.log("\n# Drill 4: idle exit (CODEX_COMPANION_BROKER_IDLE_MS)");
{
  const pids = brokerPids();
  const idleMs = Number(process.env.CODEX_COMPANION_BROKER_IDLE_MS);
  check(Number.isFinite(idleMs) && idleMs <= 5000, `drill runs with a short idle window (${idleMs} ms)`);
  check(await waitUntil(() => !alive(pids.broker), idleMs + 8000), `broker ${pids.broker} exited after being idle`);
  check(await waitUntil(() => !alive(pids.appServer), 5000), "its app-server exited too");
  const next = await CodexAppServerClient.connect(DRILL, {});
  const after = brokerPids();
  check(Boolean(after && alive(after.broker)), "next caller transparently gets a new broker");
  await next.close();
  await sessionEnd();
  check(await waitUntil(() => !alive(after.broker), 5000), "cleanup: final SessionEnd stops it");
}

console.log(`\n${failures ? `${failures} FAILED` : "ALL DRILLS PASSED"}`);
const leftover = brokerPids();
if (leftover?.broker && alive(leftover.broker)) {
  process.kill(leftover.broker, "SIGKILL");
}
fs.rmSync(SCRATCH, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
