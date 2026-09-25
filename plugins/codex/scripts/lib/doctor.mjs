import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { resolveCodexBinary } from "./app-server.mjs";
import { loadBrokerSession, waitForBrokerEndpoint } from "./broker-lifecycle.mjs";
import { binaryAvailable, getProcessStartMarker, probeProcessIdentity, runCommand } from "./process.mjs";
import {
  ACTIVE_JOB_STATUSES,
  loadState,
  resolveStateDir,
  resolveWorktreesDir
} from "./state.mjs";
import { CLOSED_TICKET_STATES, listTickets, OPEN_TICKET_STATES } from "./tickets.mjs";
import { LAUNCH_GRACE_MS, readJobHeartbeatAgeMs } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STALE_HEARTBEAT_MS = 90000;
const OLD_RETAINED_WORKTREE_MS = 14 * 24 * 60 * 60 * 1000;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const BROKER_COMMAND_HINT = "app-server-broker.mjs";
const TICKET_REF_PREFIX = "refs/codex-companion/tickets/";

function firstLine(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function ageMs(value, now) {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

function nodeVersionSupported(version) {
  const [major = 0, minor = 0] = String(version).split(".").map(Number);
  return Number.isFinite(major) && Number.isFinite(minor) && (major > 18 || (major === 18 && minor >= 18));
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds)) {
    return "unknown age";
  }
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) {
    return "unknown size";
  }
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Apparent file size below `root`, excluding symlinks and never traversing their targets. */
function directorySize(root) {
  let bytes = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of listDirectory(current)) {
        pending.push(path.join(current, entry.name));
      }
    } else if (stat.isFile()) {
      bytes += stat.size;
    }
  }
  return bytes;
}

function readJson(filePath) {
  try {
    return { exists: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")), error: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, value: null, error: null };
    }
    return { exists: true, value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function listDirectory(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function normalizePath(filePath) {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function configuredCodexPath(env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const configPath = path.join(home, ".codex", "config.toml");
  let source;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch {
    return { configPath, binary: null };
  }
  const match = source.match(/^\s*CODEX_CLI_PATH\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/im);
  return { configPath, binary: match ? (match[1] ?? match[2] ?? match[3]).trim() : null };
}

/** `codex-cli 0.155.0-alpha.16.4` → { core: [0, 155, 0], pre: ["alpha", "16", "4"] }, or null. */
function parseCodexVersion(detail) {
  const match = firstLine(detail).match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return match ? { core: match.slice(1, 4).map(Number), pre: match[4] ? match[4].split(".") : [] } : null;
}

/** Semver precedence: negative when `a` is older than `b`, 0 when equal. */
function compareCodexVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] - b.core[index];
    }
  }
  if (!a.pre.length || !b.pre.length) {
    return (b.pre.length ? 1 : 0) - (a.pre.length ? 1 : 0);
  }
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const [left, right] = [a.pre[index], b.pre[index]];
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1;
    }
    const numeric = /^\d+$/.test(left) && /^\d+$/.test(right);
    const order = numeric ? Number(left) - Number(right) : left.localeCompare(right);
    if (order !== 0) {
      return order;
    }
  }
  return 0;
}

function parseWorktreeList(output) {
  return String(output ?? "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean)
    .map(normalizePath);
}

function readStoredJob(stateDir, jobId) {
  if (!jobId) {
    return null;
  }
  return readJson(path.join(stateDir, "jobs", `${jobId}.json`)).value;
}

function inspectLock(lockPath) {
  const parsed = readJson(lockPath);
  if (!parsed.exists) {
    return null;
  }
  const owner = parsed.value;
  const identity = Number.isInteger(owner?.pid)
    ? probeProcessIdentity(owner.pid, owner.marker ?? null)
    : "unknown";
  return {
    path: lockPath,
    pid: Number.isInteger(owner?.pid) ? owner.pid : null,
    marker: owner?.marker ?? null,
    token: owner?.token ?? null,
    acquiredAt: owner?.acquiredAt ?? null,
    identity,
    parseError: parsed.error
  };
}

function markerCapability(platform) {
  if (platform === "win32") {
    return {
      status: "WARN",
      summary: "Process start markers are unavailable on Windows; liveness identity is best-effort.",
      fix: "Confirm process command lines manually before running cancel or removing stale metadata.",
      data: { platform, source: "none", verified: false }
    };
  }
  const marker = getProcessStartMarker(process.pid, { platform });
  if (platform === "linux") {
    return marker
      ? {
          status: "OK",
          summary: "Process identity uses Linux /proc start markers; liveness and kill safety are verified.",
          fix: "No action needed.",
          data: { platform, source: "/proc", verified: true }
        }
      : {
          status: "WARN",
          summary: "Linux /proc start markers are unavailable; process identity is best-effort.",
          fix: "Mount /proc for this environment before managing delegated workers.",
          data: { platform, source: "/proc", verified: false }
        };
  }
  return marker
    ? {
        status: "OK",
        summary: "Process identity uses ps start markers; liveness and kill safety are verified.",
        fix: "No action needed.",
        data: { platform, source: "ps", verified: true }
      }
    : {
        status: "WARN",
        summary: "ps did not provide process start markers; process identity is best-effort.",
        fix: "Ensure ps is installed and can inspect local processes before running cancel.",
        data: { platform, source: "ps", verified: false }
      };
}

function worktreeRecord(ticket) {
  const recordedPath = ticket?.worktree?.path ?? ticket?.workdir ?? null;
  if (!recordedPath || ticket?.worktree?.removedAt) {
    return null;
  }
  return { ticket, path: normalizePath(recordedPath) };
}

function makeReportBuilder(cwd, workspaceRoot, stateDir) {
  const sections = [];
  const findings = [];
  let current = null;
  return {
    section(id, title) {
      current = { id, title, findings: [] };
      sections.push(current);
    },
    add(status, code, summary, fix, data = undefined) {
      const finding = {
        section: current.id,
        status,
        code,
        summary: compact(summary),
        fix: compact(fix),
        ...(data === undefined ? {} : { data })
      };
      current.findings.push(finding);
      findings.push(finding);
    },
    finish() {
      return {
        cwd,
        workspaceRoot,
        stateDir,
        ok: !findings.some((finding) => finding.status === "FAIL"),
        sections,
        findings
      };
    }
  };
}

/** Collect a strictly read-only health report for one workspace. */
export async function collectDoctorReport(cwd, options = {}) {
  const env = options.env ?? process.env;
  const binaryAvailableImpl = options.binaryAvailableImpl ?? binaryAvailable;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const waitForBrokerEndpointImpl = options.waitForBrokerEndpointImpl ?? waitForBrokerEndpoint;
  const now = options.now ?? Date.now();
  const platform = options.platform ?? process.platform;
  const scriptPath = path.resolve(options.scriptPath ?? process.argv[1] ?? "codex-companion.mjs");
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateDir = resolveStateDir(workspaceRoot);
  const report = makeReportBuilder(path.resolve(cwd), workspaceRoot, stateDir);

  report.section("runtime", "Runtime");
  const nodeSupported = nodeVersionSupported(process.versions.node);
  report.add(
    nodeSupported ? "OK" : "FAIL",
    "node-version",
    `Node ${process.version} is running this diagnostic.`,
    nodeSupported ? "No action needed." : "Install Node 18.18 or newer and rerun doctor.",
    { version: process.version, executable: process.execPath }
  );
  const codexBinary = resolveCodexBinary(env);
  const codex = binaryAvailableImpl(codexBinary, ["--version"], { cwd: workspaceRoot, env });
  report.add(
    codex.available ? "OK" : "FAIL",
    "codex-version",
    codex.available
      ? `Codex ${firstLine(codex.detail)} is resolved from ${codexBinary}.`
      : `The configured Codex binary ${codexBinary} is unavailable: ${codex.detail}.`,
    codex.available
      ? "No action needed."
      : "Install Codex or set CODEX_COMPANION_CODEX_BIN to a working Codex executable.",
    { binary: codexBinary, available: codex.available, version: codex.available ? firstLine(codex.detail) : null }
  );
  const alternate = configuredCodexPath(env);
  if (alternate.binary) {
    const configured = binaryAvailableImpl(alternate.binary, ["--version"], { cwd: workspaceRoot, env });
    if (!configured.available) {
      report.add(
        "WARN",
        "configured-codex-unavailable",
        `CODEX_CLI_PATH points to ${alternate.binary}, but it cannot report a version: ${configured.detail}.`,
        `Update or remove CODEX_CLI_PATH in ${alternate.configPath}.`,
        { binary: alternate.binary, configPath: alternate.configPath }
      );
    } else if (codex.available && firstLine(configured.detail) !== firstLine(codex.detail)) {
      // Only an older companion breaks ticket continuity: it cannot resume threads the newer
      // install wrote (measured: 0.144.1 fails on 0.155 threads with "paginated_threads is not
      // supported yet"), while a newer companion resumes threads written by either.
      const companionVersion = parseCodexVersion(codex.detail);
      const configuredVersion = parseCodexVersion(configured.detail);
      const order = companionVersion && configuredVersion ? compareCodexVersions(companionVersion, configuredVersion) : null;
      const direction = order === null ? "unknown" : order < 0 ? "older" : order > 0 ? "newer" : "same";
      const data = {
        direction,
        companionBinary: codexBinary,
        companionVersion: firstLine(codex.detail),
        configuredBinary: alternate.binary,
        configuredVersion: firstLine(configured.detail),
        configPath: alternate.configPath
      };
      if (direction === "newer" || direction === "same") {
        report.add(
          "OK",
          "codex-version-skew",
          `The companion's Codex (${firstLine(codex.detail)}) is ${direction === "same" ? "the same release as" : "newer than"} CODEX_CLI_PATH (${firstLine(configured.detail)}), so tickets can resume threads written by either; the older install may not open threads the companion created until it updates.`,
          "No action needed.",
          data
        );
      } else {
        report.add(
          "WARN",
          "codex-version-skew",
          `Codex version skew: companion uses ${firstLine(codex.detail)}, while CODEX_CLI_PATH uses ${firstLine(configured.detail)}; some threads cannot be resumed and tickets fall back to fresh threads.`,
          direction === "older"
            ? "Update the companion's Codex (`codex update` for the standalone install), or set CODEX_COMPANION_CODEX_BIN to the newer binary."
            : "Update the older Codex install or set CODEX_COMPANION_CODEX_BIN to the intended binary.",
          data
        );
      }
    } else {
      report.add(
        "OK",
        "codex-version-skew",
        `CODEX_CLI_PATH and the companion report the same Codex version (${firstLine(configured.detail)}).`,
        "No action needed.",
        { direction: "same", binary: alternate.binary, version: firstLine(configured.detail), configPath: alternate.configPath }
      );
    }
  } else {
    report.add("OK", "codex-version-skew", "No second Codex install is configured with CODEX_CLI_PATH.", "No action needed.");
  }
  const exportedCompanion = env.CODEX_COMPANION ? path.resolve(env.CODEX_COMPANION) : null;
  report.add(
    exportedCompanion === scriptPath ? "OK" : "WARN",
    "companion-environment",
    exportedCompanion
      ? `CODEX_COMPANION ${exportedCompanion === scriptPath ? "matches" : "does not match"} this script (${scriptPath}).`
      : "CODEX_COMPANION is not exported in this shell.",
    exportedCompanion === scriptPath ? "No action needed." : `Export CODEX_COMPANION=${JSON.stringify(scriptPath)} before delegating work.`,
    { expected: scriptPath, actual: exportedCompanion }
  );
  report.add(
    env.CLAUDE_PLUGIN_DATA ? "OK" : "WARN",
    "plugin-data-environment",
    env.CLAUDE_PLUGIN_DATA
      ? `CLAUDE_PLUGIN_DATA is ${path.resolve(env.CLAUDE_PLUGIN_DATA)}.`
      : "CLAUDE_PLUGIN_DATA is unset; state falls back to the system temporary directory.",
    env.CLAUDE_PLUGIN_DATA ? "No action needed." : "Export CLAUDE_PLUGIN_DATA to a persistent, plugin-specific directory.",
    { value: env.CLAUDE_PLUGIN_DATA ? path.resolve(env.CLAUDE_PLUGIN_DATA) : null }
  );

  report.section("state", "State");
  report.add("OK", "state-directory", `State directory resolves to ${stateDir}.`, "No action needed.", { path: stateDir });
  const stateFile = path.join(stateDir, "state.json");
  const parsedState = readJson(stateFile);
  report.add(
    parsedState.error ? "FAIL" : "OK",
    "state-json",
    parsedState.error
      ? `state.json does not parse: ${parsedState.error}.`
      : parsedState.exists
        ? "state.json parses successfully."
        : "state.json does not exist yet; this workspace has no indexed jobs.",
    parsedState.error
      ? `Back up ${stateFile}; the next delegate or followup command will quarantine it and rebuild the index from job files.`
      : "No action needed.",
    { path: stateFile, exists: parsedState.exists, parses: !parsedState.error }
  );
  const quarantines = listDirectory(stateDir)
    .filter((entry) => entry.name.startsWith("state.json.corrupt-"))
    .map((entry) => path.join(stateDir, entry.name));
  report.add(
    quarantines.length ? "WARN" : "OK",
    "state-quarantines",
    quarantines.length
      ? `${quarantines.length} quarantined corrupt state index file(s) remain.`
      : "No quarantined state.json files were found.",
    quarantines.length ? `Inspect and remove obsolete ${stateFile}.corrupt-* files after confirming job history.` : "No action needed.",
    { paths: quarantines }
  );
  const locks = ["state.lock", "broker.lock"].map((name) => inspectLock(path.join(stateDir, name))).filter(Boolean);
  if (locks.length === 0) {
    report.add("OK", "state-locks", "No state.lock or broker.lock files are present.", "No action needed.", { locks: [] });
  } else {
    for (const lock of locks) {
      const label = `${path.basename(lock.path)} holder ${lock.pid ?? "unknown"} is ${lock.identity}`;
      report.add(
        "WARN",
        "state-lock",
        `${label}${lock.token ? ` (token ${lock.token})` : ""}.`,
        lock.identity === "same"
          ? "Wait for the active command to finish; inspect the holder before removing the lock."
          : `Confirm no companion command is active, then remove ${lock.path}.`,
        lock
      );
    }
  }

  // Stale-lock recovery is serialized through <lock>.recover; a gate abandoned by a dead process
  // makes every later state update fail closed until it is removed.
  for (const name of ["state.lock.recover", "broker.lock.recover"]) {
    const gate = inspectLock(path.join(stateDir, name));
    if (!gate) {
      continue;
    }
    const abandoned = gate.identity === "gone" || gate.identity === "different";
    report.add(
      abandoned ? "FAIL" : "WARN",
      "lock-recovery-gate",
      abandoned
        ? `${name} was abandoned by pid ${gate.pid ?? "unknown"}; companion state updates fail until it is removed.`
        : `${name} is held by live pid ${gate.pid ?? "unknown"} (a stale-lock recovery in progress).`,
      abandoned ? `Confirm no companion command is running, then remove ${gate.path}.` : "Retry shortly; recovery takes milliseconds.",
      gate
    );
  }

  report.section("broker", "Broker");
  const brokerFile = path.join(stateDir, "broker.json");
  const rawBroker = readJson(brokerFile);
  const broker = loadBrokerSession(workspaceRoot);
  if (rawBroker.error) {
    report.add("FAIL", "broker-metadata", `broker.json does not parse: ${rawBroker.error}.`, `Remove ${brokerFile} before retrying a companion command.`, { path: brokerFile });
  } else if (!broker) {
    report.add("OK", "broker-session", "No broker session metadata is present; the broker starts lazily when needed.", "No action needed.", { path: brokerFile });
  } else {
    const identity = Number.isInteger(broker.pid)
      ? probeProcessIdentity(broker.pid, broker.pidMarker ?? null, { commandHint: BROKER_COMMAND_HINT })
      : "gone";
    const identityStatus = identity === "same" ? "OK" : identity === "different" ? "FAIL" : "WARN";
    report.add(
      identityStatus,
      "broker-identity",
      `Broker pid ${broker.pid ?? "missing"} identity is ${identity}.`,
      identity === "same"
        ? "No action needed."
        : identity === "gone"
          ? `Remove stale ${brokerFile}; the next delegated command can create a broker.`
          : "Inspect the recorded pid and broker log before removing broker metadata.",
      { ...broker, identity }
    );
    let reachable = false;
    if (broker.endpoint) {
      try {
        reachable = await waitForBrokerEndpointImpl(broker.endpoint, options.brokerTimeoutMs ?? 250);
      } catch {
        reachable = false;
      }
    }
    report.add(
      reachable ? "OK" : identity === "different" ? "FAIL" : "WARN",
      "broker-endpoint",
      reachable
        ? `Broker endpoint ${broker.endpoint} accepts a connection.`
        : `Broker endpoint ${broker.endpoint ?? "is missing and"} does not accept a connection.`,
      reachable
        ? "No action needed."
        : identity === "same"
          ? "Inspect the broker log; retry after the current turn finishes, or end the owning Claude session."
          : `Remove stale ${brokerFile} before retrying a delegated command.`,
      { endpoint: broker.endpoint ?? null, reachable }
    );
    if (identity === "gone") {
      report.add(
        "WARN",
        "broker-stale-metadata",
        "broker.json is stale because its recorded process is gone.",
        `Remove ${brokerFile}; the next delegated command can create a broker.`,
        { path: brokerFile, pid: broker.pid ?? null }
      );
    }
  }

  report.section("jobs", "Jobs and workers");
  const state = loadState(workspaceRoot);
  const activeJobs = (state.jobs ?? []).filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  if (activeJobs.length === 0) {
    report.add("OK", "active-jobs", "No active jobs are recorded.", "No action needed.", { jobs: [] });
  }
  for (const indexedJob of activeJobs) {
    const storedJob = readStoredJob(stateDir, indexedJob.id);
    const identity = Number.isInteger(indexedJob.pid)
      ? probeProcessIdentity(indexedJob.pid, indexedJob.pidMarker ?? null, { commandHint: indexedJob.pidCommandHint ?? null })
      : "unknown";
    const queuedAgeMs = ageMs(indexedJob.createdAt ?? indexedJob.updatedAt, now);
    const workerDead = Number.isInteger(indexedJob.pid)
      ? identity === "gone" || identity === "different"
      : indexedJob.status === "queued" && queuedAgeMs != null && queuedAgeMs > LAUNCH_GRACE_MS;
    const storedTerminal = TERMINAL_JOB_STATUSES.has(storedJob?.status);
    const workerLost = workerDead && !storedTerminal;
    const heartbeatAgeMs = readJobHeartbeatAgeMs(workspaceRoot, indexedJob.id);
    const elapsedMs = ageMs(indexedJob.startedAt ?? indexedJob.createdAt ?? indexedJob.updatedAt, now);
    let status = "OK";
    let summary = `${indexedJob.id} is ${indexedJob.status}; worker identity ${identity}, heartbeat ${heartbeatAgeMs == null ? "missing" : `${formatDuration(heartbeatAgeMs)} old`}, elapsed ${formatDuration(elapsedMs)}.`;
    let fix = "No action needed.";
    if (workerLost) {
      status = "FAIL";
      summary += " Reconciliation would mark this job worker-lost.";
      fix = `Run node \"$CODEX_COMPANION\" status ${indexedJob.id} to reconcile it, then retry or follow up.`;
    } else if (storedTerminal && workerDead) {
      status = "WARN";
      summary += ` Its job file is already ${storedJob.status}, so reconciliation would repair only the stale index.`;
      fix = `Run node \"$CODEX_COMPANION\" status ${indexedJob.id} to synchronize the index.`;
    } else if ((identity === "same" || identity === "unknown") && heartbeatAgeMs != null && heartbeatAgeMs > STALE_HEARTBEAT_MS) {
      status = "WARN";
      summary += " The live worker heartbeat is stale and may be wedged.";
      fix = `Inspect node \"$CODEX_COMPANION\" show ${indexedJob.ticketId ?? indexedJob.id}; cancel only after reviewing current activity.`;
    } else if (indexedJob.status === "running" && !Number.isInteger(indexedJob.pid)) {
      status = "WARN";
      summary += " A running job without a worker pid cannot be reconciled automatically.";
      fix = `Inspect node \"$CODEX_COMPANION\" status ${indexedJob.id} and cancel it if no worker exists.`;
    }
    report.add(status, "active-job", summary, fix, {
      id: indexedJob.id,
      ticketId: indexedJob.ticketId ?? null,
      status: indexedJob.status,
      pid: indexedJob.pid ?? null,
      identity,
      heartbeatAgeMs,
      elapsedMs,
      wouldReconcileWorkerLost: workerLost,
      storedStatus: storedJob?.status ?? null
    });
  }

  report.section("tickets", "Tickets");
  const allTickets = listTickets(workspaceRoot, { includeClosed: true });
  const openTickets = allTickets.filter((ticket) => OPEN_TICKET_STATES.has(ticket.state));
  if (openTickets.length === 0) {
    report.add("OK", "open-tickets", "No open tickets are recorded.", "No action needed.", { tickets: [] });
  }
  for (const ticket of openTickets) {
    const activeJob = readStoredJob(stateDir, ticket.activeJobId);
    const inconsistent = ticket.state === "running" && (!activeJob || TERMINAL_JOB_STATUSES.has(activeJob.status));
    const ticketAgeMs = ageMs(ticket.updatedAt ?? ticket.createdAt, now);
    report.add(
      inconsistent ? "FAIL" : "OK",
      "open-ticket",
      `${ticket.id} is ${ticket.state}; last outcome ${ticket.lastOutcome ?? "none"}, age ${formatDuration(ticketAgeMs)}${inconsistent ? `; active job ${ticket.activeJobId ?? "is missing"} is ${activeJob?.status ?? "missing"}` : ""}.`,
      inconsistent
        ? `Run node \"$CODEX_COMPANION\" tickets to reconcile the ticket, then use followup ${ticket.id} if more work is needed.`
        : "No action needed.",
      {
        id: ticket.id,
        state: ticket.state,
        lastOutcome: ticket.lastOutcome ?? null,
        ageMs: ticketAgeMs,
        activeJobId: ticket.activeJobId ?? null,
        activeJobStatus: activeJob?.status ?? null,
        inconsistent
      }
    );
  }

  report.section("worktrees", "Worktrees");
  const worktreesRoot = resolveWorktreesDir(workspaceRoot);
  const recorded = allTickets.map(worktreeRecord).filter(Boolean);
  const recordedByPath = new Map(recorded.map((entry) => [entry.path, entry.ticket]));
  const entries = listDirectory(worktreesRoot);
  const journals = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".integration-journal"))
    .map((entry) => path.join(worktreesRoot, entry.name));
  const directories = entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".integration-journal"))
    .map((entry) => normalizePath(path.join(worktreesRoot, entry.name)));
  const missingRecorded = recorded.filter((entry) => !fs.existsSync(entry.path));
  const orphanDirectories = directories.filter((directory) => !recordedByPath.has(directory));
  const worktreeList = runCommandImpl("git", ["worktree", "list", "--porcelain"], { cwd: workspaceRoot, shell: false });
  const registered = worktreeList.status === 0 && !worktreeList.error ? parseWorktreeList(worktreeList.stdout) : [];
  const registeredUnrecorded = registered.filter((directory) => directory !== normalizePath(workspaceRoot) && !recordedByPath.has(directory));
  const refList = runCommandImpl("git", ["for-each-ref", "--format=%(refname)", TICKET_REF_PREFIX], { cwd: workspaceRoot, shell: false });
  const refs = refList.status === 0 && !refList.error ? refList.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  const closedIds = new Set(allTickets.filter((ticket) => CLOSED_TICKET_STATES.has(ticket.state)).map((ticket) => ticket.id));
  const closedRefs = refs.filter((ref) => closedIds.has(ref.slice(TICKET_REF_PREFIX.length).split("/")[0]));
  const retainedClosed = recorded
    .filter((entry) => CLOSED_TICKET_STATES.has(entry.ticket.state) && fs.existsSync(entry.path))
    .map((entry) => ({
      id: entry.ticket.id,
      state: entry.ticket.state,
      path: entry.path,
      closedAt: entry.ticket.closedAt ?? null,
      ageMs: ageMs(entry.ticket.closedAt, now),
      sizeBytes: directorySize(entry.path)
    }));
  const oldRetained = retainedClosed.filter((entry) => entry.ageMs != null && entry.ageMs > OLD_RETAINED_WORKTREE_MS);

  report.add(
    missingRecorded.length ? "FAIL" : "OK",
    "missing-recorded-worktrees",
    missingRecorded.length
      ? `Recorded worktrees are missing for: ${missingRecorded.map((entry) => `${entry.ticket.id} (${entry.path})`).join(", ")}.`
      : "All recorded, retained ticket worktrees exist.",
    missingRecorded.length ? "Close or follow up the affected ticket after restoring its worktree." : "No action needed.",
    { tickets: missingRecorded.map((entry) => ({ id: entry.ticket.id, path: entry.path })) }
  );
  report.add(
    orphanDirectories.length ? "WARN" : "OK",
    "orphan-worktree-directories",
    orphanDirectories.length ? `Unrecorded directories exist under the worktree state root: ${orphanDirectories.join(", ")}.` : "No orphan worktree directories were found.",
    orphanDirectories.length ? "Inspect each directory, then remove it with git worktree remove or a filesystem command if it is not registered." : "No action needed.",
    { paths: orphanDirectories }
  );
  report.add(
    oldRetained.length ? "WARN" : "OK",
    "retained-closed-worktrees",
    retainedClosed.length
      ? `Retained worktrees for closed tickets: ${retainedClosed.map((entry) => `${entry.id} (${entry.state}, ${formatDuration(entry.ageMs)}, ${formatSize(entry.sizeBytes)})`).join(", ")}.`
      : "No retained worktrees for closed tickets.",
    retainedClosed.length
      ? `Remove when no longer needed with ${retainedClosed.map((entry) => `close ${entry.id} --purge`).join("; ")}.`
      : "No action needed.",
    { tickets: retainedClosed }
  );
  if (worktreeList.status !== 0 || worktreeList.error) {
    report.add("WARN", "registered-worktrees", `git worktree list could not run: ${firstLine(worktreeList.stderr || worktreeList.error?.message || "unknown error")}.`, "Run doctor from a valid Git repository with Git installed.");
  } else {
    report.add(
      registeredUnrecorded.length ? "WARN" : "OK",
      "registered-worktrees",
      registeredUnrecorded.length ? `Git has registered worktrees with no ticket record: ${registeredUnrecorded.join(", ")}.` : "Every companion Git worktree is represented by a ticket record.",
      registeredUnrecorded.length ? "Inspect each path with git worktree list, then remove obsolete registrations with git worktree remove or git worktree prune." : "No action needed.",
      { paths: registeredUnrecorded, registered }
    );
  }
  report.add(
    journals.length ? "FAIL" : "OK",
    "integration-journals",
    journals.length ? `Interrupted integration journal(s) remain: ${journals.join(", ")}.` : "No interrupted integration journals were found.",
    journals.length ? "Run integrate for the affected ticket; the next integrate recovers the interrupted integration." : "No action needed.",
    { paths: journals }
  );
  report.add(
    closedRefs.length ? "WARN" : "OK",
    "closed-ticket-refs",
    closedRefs.length ? `Closed tickets still have companion refs: ${closedRefs.join(", ")}.` : "No companion refs remain for closed tickets.",
    closedRefs.length ? "After confirming the ticket is closed, delete each stale ref with git update-ref -d <ref>." : "No action needed.",
    { refs: closedRefs }
  );

  report.section("platform", "Platform");
  const capability = markerCapability(platform);
  report.add(capability.status, "process-markers", capability.summary, capability.fix, capability.data);

  return report.finish();
}

export function renderDoctorReport(report) {
  const lines = [
    `Codex Companion doctor — ${report.ok ? "no failures" : "failures found"}`,
    `Workspace: ${report.workspaceRoot}`,
    `State: ${report.stateDir}`
  ];
  for (const section of report.sections) {
    lines.push("", `${section.title}:`);
    for (const finding of section.findings) {
      lines.push(`${finding.status} ${finding.summary} Fix: ${finding.fix}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
