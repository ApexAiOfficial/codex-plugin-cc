import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

import { getProcessStartMarker, isSameProcess } from "./process.mjs";
import {
  ACTIVE_JOB_STATUSES,
  listJobs,
  readJobFile,
  resolveJobArtifactPath,
  resolveJobFile,
  resolveJobLogFile,
  updateJobFile,
  upsertJob,
  withStateLock,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const HEARTBEAT_INTERVAL_MS = 15000;
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** The index holds lightweight metadata only; prompts and results stay in the job file. */
function indexRecord(record) {
  const { request: _request, result: _result, rendered: _rendered, ...rest } = record;
  return rest;
}

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    withStateLock(workspaceRoot, () => {
      upsertJob(workspaceRoot, patch);
      updateJobFile(workspaceRoot, jobId, (storedJob) => (storedJob ? { ...storedJob, ...patch } : null));
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

/** Touch a per-job heartbeat file so status can tell a quiet worker from a wedged one. */
export function startJobHeartbeat(workspaceRoot, jobId, intervalMs = HEARTBEAT_INTERVAL_MS) {
  const heartbeatFile = resolveJobArtifactPath(workspaceRoot, jobId, ".hb");
  const beat = () => {
    try {
      fs.writeFileSync(heartbeatFile, `${nowIso()}\n`, "utf8");
    } catch {
      // Heartbeats are advisory.
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

export function readJobHeartbeatAgeMs(workspaceRoot, jobId) {
  try {
    return Math.max(0, Date.now() - fs.statSync(resolveJobArtifactPath(workspaceRoot, jobId, ".hb")).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Launch `task-worker` as a detached process that outlives this command and the Claude session.
 * The worker talks to its own app-server, so nothing session-scoped can take it down.
 */
export function enqueueDetachedJob({ scriptPath, cwd, job, request, logFile }) {
  appendLogLine(logFile, "Queued for background execution.");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", job.id], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    pidMarker: getProcessStartMarker(child.pid ?? null),
    control: true,
    logFile,
    request
  };
  withStateLock(job.workspaceRoot, () => {
    writeJobFile(job.workspaceRoot, job.id, queuedRecord);
    upsertJob(job.workspaceRoot, indexRecord(queuedRecord));
  });
  return queuedRecord;
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    pidMarker: getProcessStartMarker(process.pid),
    logFile: options.logFile ?? job.logFile ?? null
  };
  withStateLock(job.workspaceRoot, () => {
    writeJobFile(job.workspaceRoot, job.id, runningRecord);
    upsertJob(job.workspaceRoot, indexRecord(runningRecord));
  });

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    withStateLock(job.workspaceRoot, () => {
      const stored = readStoredJobOrNull(job.workspaceRoot, job.id);
      // A cancel that already landed wins over a late completion write.
      const status = stored?.status === "cancelled" ? "cancelled" : (execution.statusOverride ?? completionStatus);
      const phase = status === "completed" ? "done" : status;
      const base = { ...runningRecord, ...(stored ?? {}) };
      writeJobFile(job.workspaceRoot, job.id, {
        ...base,
        status,
        threadId: execution.threadId ?? base.threadId ?? null,
        turnId: execution.turnId ?? base.turnId ?? null,
        pid: null,
        phase,
        completedAt,
        failureKind: execution.failureKind ?? null,
        result: execution.payload,
        rendered: execution.rendered
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase,
        failureKind: execution.failureKind ?? null,
        pid: null,
        completedAt
      });
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    withStateLock(job.workspaceRoot, () => {
      const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
      const status = existing.status === "cancelled" ? "cancelled" : "failed";
      writeJobFile(job.workspaceRoot, job.id, {
        ...existing,
        status,
        phase: status,
        errorMessage: existing.errorMessage ?? errorMessage,
        pid: null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        status,
        phase: status,
        pid: null,
        errorMessage: existing.errorMessage ?? errorMessage,
        completedAt
      });
    });
    throw error;
  }
}

/**
 * Reconcile jobs recorded as active against real processes. A worker that died without
 * recording a result (crash, OOM, reboot, killed shell) is marked failed with failureKind
 * "worker-lost" instead of staying "running" forever. Returns the ids that were reconciled.
 */
export function reconcileActiveJobs(workspaceRoot) {
  const candidates = listJobs(workspaceRoot).filter(
    (job) => ACTIVE_JOB_STATUSES.has(job.status) && Number.isInteger(job.pid) && !isSameProcess(job.pid, job.pidMarker)
  );
  if (candidates.length === 0) {
    return [];
  }

  const reconciled = [];
  withStateLock(workspaceRoot, () => {
    const fresh = new Map(listJobs(workspaceRoot).map((job) => [job.id, job]));
    for (const candidate of candidates) {
      const job = fresh.get(candidate.id);
      if (!job || !ACTIVE_JOB_STATUSES.has(job.status) || isSameProcess(job.pid, job.pidMarker)) {
        continue;
      }
      const stored = readStoredJobOrNull(workspaceRoot, job.id);
      if (stored && TERMINAL_JOB_STATUSES.has(stored.status)) {
        // The worker finished its job file but died before updating the index.
        upsertJob(workspaceRoot, {
          id: job.id,
          status: stored.status,
          phase: stored.phase ?? stored.status,
          pid: null,
          completedAt: stored.completedAt ?? nowIso()
        });
        reconciled.push(job.id);
        continue;
      }
      const completedAt = nowIso();
      const errorMessage = "The Codex worker process exited without recording a result.";
      writeJobFile(workspaceRoot, job.id, {
        ...(stored ?? job),
        status: "failed",
        phase: "failed",
        failureKind: "worker-lost",
        errorMessage,
        pid: null,
        completedAt
      });
      upsertJob(workspaceRoot, {
        id: job.id,
        status: "failed",
        phase: "failed",
        failureKind: "worker-lost",
        errorMessage,
        pid: null,
        completedAt
      });
      appendLogLine(job.logFile, errorMessage);
      reconciled.push(job.id);
    }
  });
  return reconciled;
}
