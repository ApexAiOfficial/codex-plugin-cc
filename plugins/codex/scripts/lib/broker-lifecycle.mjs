import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.mjs";
import { withFileLockAsync } from "./locking.mjs";
import { getProcessStartMarker, probeProcessIdentity, terminateRecordedProcessTree } from "./process.mjs";
import { resolveStateDir } from "./state.mjs";

export const PID_FILE_ENV = "CODEX_COMPANION_APP_SERVER_PID_FILE";
export const LOG_FILE_ENV = "CODEX_COMPANION_APP_SERVER_LOG_FILE";
const BROKER_STATE_FILE = "broker.json";
const BROKER_LOCK_FILE = "broker.lock";
// A healthy broker serving a turn can be slow to accept a probe connection; this is generous on
// purpose, and a miss only ever means "use a private app-server this time", never "kill it".
const EXISTING_BROKER_PROBE_MS = 3000;
const NEW_BROKER_READY_MS = 8000;
const BROKER_COMMAND_HINT = "app-server-broker.mjs";

export function createBrokerSessionDir(prefix = "cxc-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint) {
  await new Promise((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerStateFile(cwd) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd, session) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint, timeoutMs) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, timeoutMs);
  } catch {
    return false;
  }
}

function brokerIdentity(session) {
  if (!Number.isInteger(session?.pid)) {
    return "gone";
  }
  return probeProcessIdentity(session.pid, session.pidMarker ?? null, { commandHint: BROKER_COMMAND_HINT });
}

/**
 * Return a usable shared broker for this workspace, starting one when needed, or null when the
 * caller should use a private app-server. Acquisition is serialized so concurrent callers share one
 * broker. A broker whose process is alive is never torn down because it answered a probe slowly;
 * its metadata is removed only once the process is provably gone.
 */
export async function ensureBrokerSession(cwd, options = {}) {
  const lockPath = path.join(resolveStateDir(cwd), BROKER_LOCK_FILE);
  return withFileLockAsync(lockPath, () => acquireBrokerSession(cwd, options), {
    timeoutMs: options.lockTimeoutMs ?? 10000,
    onTimeout: () => null
  });
}

async function acquireBrokerSession(cwd, options) {
  const existing = loadBrokerSession(cwd);
  if (existing) {
    if (await isBrokerEndpointReady(existing.endpoint, options.probeTimeoutMs ?? EXISTING_BROKER_PROBE_MS)) {
      return existing;
    }
    const identity = brokerIdentity(existing);
    if (identity === "same" || identity === "unknown") {
      // Alive but not answering in time (busy, or wedged): leave it and its turn alone.
      return null;
    }
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");
  const scriptPath =
    options.scriptPath ??
    fileURLToPath(new URL("../app-server-broker.mjs", import.meta.url));

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });
  const pid = child.pid ?? null;
  const pidMarker = getProcessStartMarker(pid);

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? NEW_BROKER_READY_MS);
  if (!ready) {
    // We spawned this process moments ago and know its identity, so stopping it is safe.
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid,
      killProcess: options.killProcess ?? ((target) => terminateRecordedProcessTree(target, pidMarker, { commandHint: BROKER_COMMAND_HINT }))
    });
    return null;
  }

  const session = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid,
    pidMarker
  };
  saveBrokerSession(cwd, session);
  return session;
}

export function teardownBrokerSession({ endpoint = null, pidFile, logFile, sessionDir = null, pid = null, killProcess = null }) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
