import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withFileLock, writeJsonAtomic } from "./locking.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 2;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const TICKETS_DIR_NAME = "tickets";
const WORKTREES_DIR_NAME = "worktrees";
const MAX_JOBS = 50;
const JOB_ARTIFACT_SUFFIXES = [".json", ".log", ".trace.jsonl", ".inbox.jsonl", ".inbox-ack.json", ".hb"];
const INDEX_FIELDS = [
  "id",
  "kind",
  "kindLabel",
  "title",
  "summary",
  "jobClass",
  "status",
  "phase",
  "write",
  "workspaceRoot",
  "sessionId",
  "ticketId",
  "threadId",
  "turnId",
  "pid",
  "pidMarker",
  "pidCommandHint",
  "logFile",
  "errorMessage",
  "failureKind",
  "createdAt",
  "startedAt",
  "completedAt",
  "updatedAt"
];

export const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
export const OPEN_TICKET_STATES = new Set(["running", "needs-review", "integrated"]);

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveTicketsDir(cwd) {
  return path.join(resolveStateDir(cwd), TICKETS_DIR_NAME);
}

export function resolveTicketFile(cwd, ticketId) {
  return path.join(resolveTicketsDir(cwd), `${ticketId}.json`);
}

export function resolveWorktreesDir(cwd) {
  return path.join(resolveStateDir(cwd), WORKTREES_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

/**
 * Every mutation of workspace state (index, job files, tickets) happens under this one lock.
 * Critical sections are tiny, so a single lock keeps reasoning simple without real contention.
 */
export function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  return withFileLock(path.join(resolveStateDir(cwd), LOCK_FILE_NAME), fn);
}

function normalizeState(parsed) {
  return {
    ...defaultState(),
    ...parsed,
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(parsed?.config ?? {})
    },
    jobs: Array.isArray(parsed?.jobs) ? parsed.jobs : []
  };
}

function toIndexEntry(job) {
  const entry = {};
  for (const field of INDEX_FIELDS) {
    if (job[field] !== undefined) {
      entry[field] = job[field];
    }
  }
  return entry;
}

function rebuildJobsFromJobFiles(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) {
    return [];
  }
  const jobs = [];
  for (const name of fs.readdirSync(jobsDir)) {
    if (!name.endsWith(".json") || name.endsWith(".inbox-ack.json") || name.startsWith(".")) {
      continue;
    }
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir, name), "utf8"));
      if (job && typeof job.id === "string") {
        jobs.push({ updatedAt: job.completedAt ?? job.startedAt ?? job.createdAt ?? null, ...toIndexEntry(job) });
      }
    } catch {
      // Skip unreadable job files; they cannot be indexed.
    }
  }
  return jobs;
}

function readStateFile(cwd, options = {}) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    return normalizeState(JSON.parse(fs.readFileSync(stateFile, "utf8")));
  } catch {
    // A corrupt index must not silently erase history: rebuild it from the per-job files.
    options.onCorrupt?.(stateFile);
    return { ...defaultState(), jobs: rebuildJobsFromJobFiles(cwd) };
  }
}

function quarantineCorruptState(stateFile) {
  try {
    fs.renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`);
    process.stderr.write(`[codex] Recovered from a corrupt ${path.basename(stateFile)}; the job index was rebuilt from job files.\n`);
  } catch {
    // Ignore; the rebuilt state will overwrite it.
  }
}

export function loadState(cwd) {
  return readStateFile(cwd);
}

export function readTicketFile(cwd, ticketId) {
  if (!ticketId) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(resolveTicketFile(cwd, ticketId), "utf8"));
  } catch {
    return null;
  }
}

function isJobProtected(cwd, job) {
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    return true;
  }
  if (job.ticketId) {
    const ticket = readTicketFile(cwd, job.ticketId);
    return Boolean(ticket && OPEN_TICKET_STATES.has(ticket.state));
  }
  return false;
}

function pruneJobs(cwd, jobs) {
  const sorted = [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  if (sorted.length <= MAX_JOBS) {
    return { kept: sorted, pruned: [] };
  }
  // Active jobs and jobs of open tickets always survive; the cap only trims finished history.
  const protectedFlags = sorted.map((job) => isJobProtected(cwd, job));
  let room = Math.max(0, MAX_JOBS - protectedFlags.filter(Boolean).length);
  const kept = [];
  const pruned = [];
  sorted.forEach((job, index) => {
    if (protectedFlags[index]) {
      kept.push(job);
    } else if (room > 0) {
      kept.push(job);
      room -= 1;
    } else {
      pruned.push(job);
    }
  });
  return { kept, pruned };
}

export function resolveJobArtifactPath(cwd, jobId, suffix) {
  return path.join(resolveJobsDir(cwd), `${jobId}${suffix}`);
}

function removeJobArtifacts(cwd, job) {
  for (const suffix of JOB_ARTIFACT_SUFFIXES) {
    fs.rmSync(resolveJobArtifactPath(cwd, job.id, suffix), { force: true });
  }
  if (job.logFile) {
    fs.rmSync(job.logFile, { force: true });
  }
}

function writeStateLocked(cwd, state) {
  ensureStateDir(cwd);
  const { kept, pruned } = pruneJobs(cwd, state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: kept
  };

  writeJsonAtomic(resolveStateFile(cwd), nextState);
  // Delete artifacts only after the index no longer references them, and only for jobs this
  // save pruned. Jobs missing from `state.jobs` for other reasons are never deleted here.
  for (const job of pruned) {
    removeJobArtifacts(cwd, job);
  }
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => writeStateLocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = readStateFile(cwd, { onCorrupt: quarantineCorruptState });
    mutate(state);
    return writeStateLocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeJsonAtomic(jobFile, payload);
  return jobFile;
}

/** Read-modify-write a job file under the state lock. `mutate` returns the next record. */
export function updateJobFile(cwd, jobId, mutate) {
  return withStateLock(cwd, () => {
    const jobFile = resolveJobFile(cwd, jobId);
    const current = fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
    const next = mutate(current);
    if (next) {
      writeJsonAtomic(jobFile, next);
    }
    return next;
  });
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
