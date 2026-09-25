#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { terminateRecordedProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/app-server.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import { renderSessionLedger } from "./lib/ticket-commands.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const COMPANION_ENV = "CODEX_COMPANION";
const COMPANION_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "codex-companion.mjs");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  // The Bash tool does not see CLAUDE_PLUGIN_ROOT, so give Claude a stable handle on the runtime.
  appendEnvVar(COMPANION_ENV, COMPANION_SCRIPT);
  if (process.env.CLAUDE_ENV_FILE) {
    // Hints rendered below may then use "$CODEX_COMPANION", which the export above guarantees.
    process.env[COMPANION_ENV] = COMPANION_SCRIPT;
  }

  // Open tickets outlive sessions and compaction; surface them so Claude never loses track.
  // SessionStart stdout is added to Claude's context. Stay silent when there is nothing open.
  try {
    const cwd = input.cwd || process.cwd();
    const ledger = renderSessionLedger(resolveWorkspaceRoot(cwd), COMPANION_SCRIPT);
    if (ledger) {
      process.stdout.write(ledger);
    }
  } catch {
    // Never let ledger rendering break session startup.
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const brokerSession =
    loadBrokerSession(cwd) ??
    (process.env[BROKER_ENDPOINT_ENV]
      ? {
          endpoint: process.env[BROKER_ENDPOINT_ENV],
          pidFile: process.env[PID_FILE_ENV] ?? null,
          logFile: process.env[LOG_FILE_ENV] ?? null
        }
      : null);
  const brokerEndpoint = brokerSession?.endpoint ?? null;
  const pidFile = brokerSession?.pidFile ?? null;
  const logFile = brokerSession?.logFile ?? null;
  const sessionDir = brokerSession?.sessionDir ?? null;
  const pid = brokerSession?.pid ?? null;
  const pidMarker = brokerSession?.pidMarker ?? null;

  if (brokerEndpoint) {
    // The broker is per workspace, so another Claude session may still be using it. A busy broker
    // declines and later exits on its own once idle.
    const { shutdown } = await sendBrokerShutdown(brokerEndpoint, { ifIdle: true });
    if (!shutdown) {
      return;
    }
  }

  // Jobs are deliberately left alone. Background workers own a private app-server (not this
  // session's broker), so they finish and persist their results after the session ends. That
  // matters because SessionEnd also fires on /clear and resume, not only on a real exit.
  teardownBrokerSession({
    endpoint: brokerEndpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    // The broker normally exits on broker/shutdown; only signal the pid if it is still that broker.
    killProcess: (target) => terminateRecordedProcessTree(target, pidMarker, { commandHint: "app-server-broker.mjs" })
  });
  clearBrokerSession(cwd);
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
