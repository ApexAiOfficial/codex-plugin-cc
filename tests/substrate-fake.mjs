import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

// A deliberately small fake `codex app-server` for transport, broker, and turn-liveness tests.
// Behavior is chosen at runtime with FAKE_SUBSTRATE_MODE, so one install serves direct clients and
// brokers alike (the broker inherits the environment). Every request is appended to a log file.
export function installSubstrateFake(binDir) {
  const logPath = path.join(binDir, "substrate-log.jsonl");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const LOG = ${JSON.stringify(logPath)};
const MODE = process.env.FAKE_SUBSTRATE_MODE || "normal";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("codex-cli substrate-fake"); process.exit(0); }
if (args[0] === "app-server" && args[1] === "--help") { console.log("help"); process.exit(0); }
if (args[0] !== "app-server") { process.exit(1); }

let nextThread = 1;
let nextTurn = 1;
const threads = new Map();
function log(entry) { fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ...entry }) + "\\n"); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
function thread(id, extra = {}) { return { id, preview: "", ephemeral: true, modelProvider: "openai", createdAt: 0, updatedAt: 0, status: { type: "idle" }, path: null, cwd: process.cwd(), cliVersion: "fake", source: "appServer", agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [], parentThreadId: null, ...extra }; }
function turn(id, status = "inProgress") { return { id, status, items: [], error: null }; }
function complete(threadId, turnId, text) {
  send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "m" + turnId, text, phase: "final_answer" } } });
  send({ method: "turn/completed", params: { threadId, turn: turn(turnId, "completed") } });
}
log({ event: "start", mode: MODE });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  log({ method: message.method, params: message.params || null });
  const p = message.params || {};
  switch (message.method) {
    case "initialize":
      return send({ id: message.id, result: { userAgent: "substrate-fake" } });
    case "thread/start": {
      if (MODE === "hang-thread-start") return;
      // Unique across fake instances so tests sharing one log never confuse threads.
      const id = "thr_" + process.pid + "_" + nextThread++;
      threads.set(id, { status: "idle", turns: [] });
      send({ id: message.id, result: { thread: thread(id), model: "fake", sandbox: { type: "readOnly", networkAccess: false } } });
      return send({ method: "thread/started", params: { thread: thread(id) } });
    }
    case "thread/resume": {
      if (MODE === "resume-unsupported") {
        // Codex CLI 0.144.1 against a thread store written by a newer Codex build.
        return send({ id: message.id, error: { code: -32600, message: "paginated_threads is not supported yet" } });
      }
      const id = p.threadId;
      threads.set(id, threads.get(id) || { status: "idle", turns: [] });
      return send({ id: message.id, result: { thread: thread(id), model: "fake", sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: [] } } });
    }
    case "thread/name/set":
      return send({ id: message.id, result: {} });
    case "command/exec":
      // Enough for the preflight probe: report a sandbox with the requested policy and no network.
      return send({ id: message.id, result: { exitCode: 0, stdout: JSON.stringify({ tools: { node: "fake" }, write: (p.sandboxPolicy || {}).type === "workspaceWrite", gitWrite: false, dockerDaemon: null, network: false, syncSpawnReliable: true }), stderr: "" } });
    case "thread/unsubscribe":
      return send({ id: message.id, result: { status: "unsubscribed" } });
    case "thread/read": {
      const record = threads.get(p.threadId) || { status: "notLoaded", turns: [] };
      return send({ id: message.id, result: { thread: thread(p.threadId, { status: { type: record.status }, turns: p.includeTurns ? record.turns : [] }) } });
    }
    case "turn/start": {
      const threadId = p.threadId;
      const turnId = "turn_" + nextTurn++;
      const record = threads.get(threadId) || { status: "idle", turns: [] };
      threads.set(threadId, record);
      record.status = "active";
      send({ id: message.id, result: { turn: turn(turnId) } });
      send({ method: "turn/started", params: { threadId, turn: turn(turnId) } });
      if (MODE === "subagent" || MODE === "subagent-late") {
        const child = "thr_" + process.pid + "_" + nextThread++;
        threads.set(child, { status: "idle", turns: [] });
        const started = () => send({ method: "thread/started", params: { thread: thread(child, { parentThreadId: threadId, agentNickname: "helper" }) } });
        // "late": the subagent starts after the requesting client has already disconnected, while
        // the turn is still running (so another client can be streaming by then).
        if (MODE === "subagent-late") setTimeout(started, 700); else started();
      }
      if (MODE === "subagent-late") {
        setTimeout(() => { record.status = "idle"; complete(threadId, turnId, "late subagent turn done"); }, 2000);
        return;
      }
      if (MODE === "filechange-without-changes") {
        send({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: "fc", status: "inProgress" } } });
      }
      if (MODE === "retryable-error") {
        send({ method: "error", params: { threadId, turnId, willRetry: true, error: { message: "stream disconnected, retrying", codexErrorInfo: null, additionalDetails: null } } });
      }
      if (MODE === "fatal-error-inferred-completion") {
        send({ method: "error", params: { threadId, turnId, willRetry: false, error: { message: "model rejected the request", codexErrorInfo: "badRequest", additionalDetails: null } } });
        // No turn/completed: completion is inferred from the final answer.
        send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "m" + turnId, text: "partial", phase: "final_answer" } } });
        return;
      }
      if (MODE === "lost-completion") {
        // The turn finishes server-side but its completion notification never arrives.
        setTimeout(() => { record.status = "idle"; record.turns.push(turn(turnId, "completed")); }, 150);
        return;
      }
      if (MODE === "silent-but-active") {
        // Quiet for a while (as during long reasoning), still active, then completes.
        setTimeout(() => { record.status = "idle"; complete(threadId, turnId, "finished after a quiet period"); }, 1500);
        return;
      }
      if (MODE === "exit-mid-turn") {
        setTimeout(() => process.exit(3), 150);
        return;
      }
      if (MODE === "hang-turn") {
        return;
      }
      record.status = "idle";
      return complete(threadId, turnId, "fake turn done");
    }
    default:
      return send({ id: message.id, error: { code: -32601, message: "unsupported " + message.method } });
  }
});
`;
  writeExecutable(path.join(binDir, "codex"), source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "codex.cmd"), `@echo off\r\nnode "%~dp0codex" %*\r\n`, "utf8");
  }
  return {
    logPath,
    entries: () =>
      fs.existsSync(logPath)
        ? fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : []
  };
}
