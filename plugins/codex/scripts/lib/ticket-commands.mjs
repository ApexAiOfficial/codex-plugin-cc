import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import { buildSandboxPolicy, readCachedPreflight, runPreflight } from "./capabilities.mjs";
import { getCodexAvailability, runAppServerTurn } from "./codex.mjs";
import { createJobController, sendControlMessage, waitForControlAck } from "./control-channel.mjs";
import {
  buildTurnEvidence,
  compileOwnership,
  crossCheckVerificationClaims,
  diffTrees,
  readHead,
  snapshotWorkingTree
} from "./evidence.mjs";
import { readStdinIfPiped } from "./fs.mjs";
import { ensureGitRepository } from "./git.mjs";
import { withFileLock } from "./locking.mjs";
import { fetchModelCatalog, loadModelCatalog, renderModelCatalog, validateModelChoice } from "./models.mjs";
import { getProcessStartMarker, probeProcessIdentity, terminateRecordedProcessTree } from "./process.mjs";
import {
  ACTIVE_JOB_STATUSES,
  generateJobId,
  getConfig,
  readJobFile,
  resolveJobArtifactPath,
  resolveJobFile,
  resolveTicketsDir,
  resolveWorktreesDir,
  updateJobFile,
  upsertJob,
  withStateLock,
  writeJobFile
} from "./state.mjs";
import {
  createTicket,
  deriveTicketId,
  isTicketOpen,
  listTickets,
  readTicket,
  resolveTicketReference,
  updateTicket,
  validateTicketId
} from "./tickets.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobRecord,
  LAUNCH_GRACE_MS,
  nowIso,
  readJobHeartbeatAgeMs,
  reconcileActiveJobs,
  SESSION_ID_ENV,
  spawnDetachedWorker,
  startJobHeartbeat,
  writeQueuedJob
} from "./tracked-jobs.mjs";
import {
  buildFollowupPrompt,
  buildResumeHandoffBlock,
  buildWorkPackagePrompt,
  classifyTurnFailure,
  loadWorkReportSchema,
  parseWorkReport,
  TICKET_ROLES
} from "./work-package.mjs";
import { collectWorktreeChanges, createTicketWorktree, integrateWorktree, removeTicketWorktree } from "./worktree.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import {
  elapsedBetween,
  renderCommandDetail,
  renderCommandTrace,
  renderIntegration,
  renderLaunch,
  renderPreflight,
  renderTicketDetail,
  renderTicketList,
  renderTurnCard,
  renderVerification
} from "./ticket-render.mjs";

const DEFAULT_MAX_PARALLEL_TICKETS = 3;
const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 20 * 60 * 1000;
const TRACE_OUTPUT_LIMIT = 16000;
const VERIFY_OUTPUT_LIMIT = 6000;
const GRACEFUL_CANCEL_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------------------------
// Shared helpers

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    return raw && raw.trim() ? splitRawArgumentString(raw) : [];
  }
  return argv;
}

function parse(argv, config) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    stopAtFirstPositional: Boolean(config.stopAtFirstPositional && argv.length === 1),
    aliasMap: { C: "cwd", m: "model", ...(config.aliasMap ?? {}) }
  });
}

function output(value, rendered, asJson) {
  process.stdout.write(asJson ? `${JSON.stringify(value, null, 2)}\n` : rendered);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function firstLine(text) {
  return String(text ?? "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function tail(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

function resolveCwd(options) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function splitList(values) {
  return (values ?? []).flatMap((value) => String(value).split(",")).map((value) => value.trim()).filter(Boolean);
}

/** How to spell the companion in hints Claude will copy: the exported env var when it matches. */
export function companionReference(scriptPath) {
  const exported = process.env.CODEX_COMPANION;
  if (exported && path.resolve(exported) === path.resolve(scriptPath)) {
    return '"$CODEX_COMPANION"';
  }
  return JSON.stringify(scriptPath);
}

function requireRepository(cwd) {
  return ensureGitRepository(cwd);
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

function readStoredJob(workspaceRoot, jobId) {
  if (!jobId) {
    return null;
  }
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  return fs.existsSync(jobFile) ? readJobFile(jobFile) : null;
}

function requireTicket(workspaceRoot, reference) {
  const ticket = resolveTicketReference(workspaceRoot, reference);
  if (!ticket) {
    throw new Error(`No Codex ticket named "${reference}" in this repository. List them with \`tickets --all\`.`);
  }
  return syncTicket(workspaceRoot, ticket);
}

function readBrief(cwd, options, positionals) {
  if (options["brief-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["brief-file"]), "utf8");
  }
  return positionals.join(" ") || readStdinIfPiped();
}

/**
 * A monitor notification is claimed by the delivering watcher (`notifyPending` records its
 * identity) and confirmed once the line is written. A turn counts as notified once confirmed, or
 * while the watcher that claimed it is still alive: if that watcher dies, or its rollback after a
 * failed write fails too, the claim lapses and the turn can be surfaced again.
 */
export function isTurnNotified(job) {
  if (!job?.notifiedAt) {
    return false;
  }
  const pending = job.notifyPending;
  if (!pending) {
    return true;
  }
  const identity = probeProcessIdentity(pending.pid, pending.marker ?? null);
  return identity !== "gone" && identity !== "different";
}

function claimTurnNotification(workspaceRoot, jobId) {
  const claimed = updateJobFile(workspaceRoot, jobId, (job) =>
    !job || job.collectedAt || isTurnNotified(job)
      ? null
      : { ...job, notifiedAt: nowIso(), notifyPending: { pid: process.pid, marker: getProcessStartMarker(process.pid) } }
  );
  return Boolean(claimed);
}

/** Confirm (delivered) or give back this watcher's claim; false when the write failed and should be retried. */
export function settleTurnNotification(workspaceRoot, jobId, delivered) {
  try {
    updateJobFile(workspaceRoot, jobId, (job) => {
      if (!job?.notifyPending || job.notifyPending.pid !== process.pid) {
        return null;
      }
      return delivered ? { ...job, notifyPending: undefined } : { ...job, notifiedAt: undefined, notifyPending: undefined };
    });
    return true;
  } catch {
    return false;
  }
}

/** Set `field` once, under the state lock; true only for the caller that set it. */
function markJob(workspaceRoot, jobId, field) {
  if (!jobId) {
    return false;
  }
  return Boolean(updateJobFile(workspaceRoot, jobId, (job) => (!job || job[field] ? null : { ...job, [field]: nowIso() })));
}

// ---------------------------------------------------------------------------------------------
// Ticket lifecycle

function finalizeTicketTurn(workspaceRoot, ticketId, job) {
  return updateTicket(workspaceRoot, ticketId, (ticket) => {
    if (ticket.activeJobId !== job.id) {
      return;
    }
    const payload = job.result ?? null;
    const outcome = payload?.outcome ?? (job.status === "cancelled" ? "cancelled" : job.failureKind ?? "error");
    ticket.state = "needs-review";
    ticket.activeJobId = null;
    ticket.lastJobId = job.id;
    ticket.lastOutcome = outcome;
    ticket.lastSummary = payload?.report?.summary || shorten(firstLine(payload?.rawOutput), 200) || job.errorMessage || null;
    if (payload?.threadReset) {
      ticket.threadHistory = [...(ticket.threadHistory ?? []), { ...payload.threadReset, replacedBy: payload.threadId ?? null, turn: payload.turn }];
    }
    if (job.threadId || payload?.threadId) {
      ticket.threadId = payload?.threadId ?? job.threadId;
    }
    const turn = ticket.turns.find((entry) => entry.jobId === job.id);
    if (turn) {
      turn.outcome = outcome;
      turn.completedAt = job.completedAt ?? nowIso();
    }
  });
}

function lostLaunchJob(jobId) {
  return {
    id: jobId,
    status: "failed",
    failureKind: "worker-lost",
    errorMessage: "The turn never started: its launch did not complete.",
    completedAt: nowIso(),
    result: null
  };
}

/** Bring a ticket in line with its active job (worker finished, died, or never launched). */
export function syncTicket(workspaceRoot, ticket) {
  if (!ticket || ticket.state !== "running") {
    return ticket;
  }
  const launchAbandoned = Date.now() - Date.parse(ticket.updatedAt ?? "") > LAUNCH_GRACE_MS;
  const job = ticket.activeJobId ? readStoredJob(workspaceRoot, ticket.activeJobId) : null;
  if (!job) {
    // Defensive: launches persist the job before binding it, but never leave a ticket stuck.
    return launchAbandoned ? finalizeTicketTurn(workspaceRoot, ticket.id, lostLaunchJob(ticket.activeJobId ?? null)) : ticket;
  }
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    return ticket;
  }
  return finalizeTicketTurn(workspaceRoot, ticket.id, job);
}

/** Serialize operations that change a ticket's workspace (followup, integrate, close). */
function withTicketOperationLock(workspaceRoot, ticketId, fn) {
  return withFileLock(path.join(resolveTicketsDir(workspaceRoot), `${ticketId}.op.lock`), fn);
}

export function reconcileWorkspace(workspaceRoot) {
  reconcileActiveJobs(workspaceRoot);
  return listTickets(workspaceRoot).map((ticket) => syncTicket(workspaceRoot, ticket));
}

/**
 * Start a ticket turn as one locked transaction: re-read the ticket, refuse if a turn is already
 * active, choose the turn number, persist the queued job, then bind it to the ticket. The job is
 * written first, so a crash leaves either nothing bound or a queued job that reconciliation
 * recovers. `create` makes the ticket itself inside the same transaction.
 */
function launchTicketTurn(workspaceRoot, ticketId, { feedback = null, attachVerification = false, model = null, effort = null, create = null }, ctx) {
  const jobId = generateJobId("ticket");
  const title = `Codex ticket ${ticketId}`;
  const logFile = createJobLogFile(workspaceRoot, jobId, title);
  let job;
  let ticket;
  withStateLock(workspaceRoot, () => {
    const current = create ? null : readTicket(workspaceRoot, ticketId);
    if (create && readTicket(workspaceRoot, ticketId)) {
      throw new Error(`Ticket "${ticketId}" already exists. Pick another name, or use followup to continue it.`);
    }
    if (!create) {
      if (!current) {
        throw new Error(`No ticket named "${ticketId}".`);
      }
      if (!isTicketOpen(current)) {
        throw new Error(`Ticket ${ticketId} is ${current.state}; open a new ticket instead.`);
      }
      if (current.state === "running" || current.activeJobId) {
        throw new Error(`Ticket ${ticketId} already has a running turn. Redirect it with \`steer ${ticketId} "…"\` or wait for it.`);
      }
    }
    const base = create ?? current;
    const turn = (base.turns?.length ?? 0) + 1;
    job = createJobRecord({
      id: jobId,
      kind: "ticket",
      kindLabel: "ticket",
      title,
      workspaceRoot,
      jobClass: "task",
      summary: shorten(turn === 1 ? base.title : feedback || "Continue the package", 96),
      write: base.sandbox.write,
      ticketId
    });
    const request = { kind: "ticket-turn", ticketId, workspaceRoot, turn, feedback, attachVerification, model, effort };
    writeQueuedJob({ job, request, logFile });
    const turnEntry = { turn, jobId, startedAt: nowIso(), feedback: feedback ? shorten(feedback, 300) : null };
    if (create) {
      ticket = createTicket(workspaceRoot, { ...create, state: "running", activeJobId: jobId, turns: [turnEntry] });
    } else {
      ticket = updateTicket(workspaceRoot, ticketId, (record) => {
        record.state = "running";
        record.activeJobId = jobId;
        record.turns.push(turnEntry);
      });
    }
  });

  try {
    spawnDetachedWorker({ scriptPath: ctx.scriptPath, cwd: workspaceRoot, job });
  } catch (error) {
    withStateLock(workspaceRoot, () => {
      const failed = { ...(readStoredJob(workspaceRoot, jobId) ?? job), ...lostLaunchJob(jobId), errorMessage: `Could not start the worker: ${error.message}` };
      writeJobFile(workspaceRoot, jobId, failed);
      upsertJob(workspaceRoot, { id: jobId, status: "failed", phase: "failed", failureKind: "worker-lost", errorMessage: failed.errorMessage, completedAt: failed.completedAt });
    });
    syncTicket(workspaceRoot, { ...readTicket(workspaceRoot, ticketId), updatedAt: new Date(0).toISOString() });
    throw error;
  }
  return { job, ticket };
}

function literalPrefix(pattern) {
  const normalized = String(pattern).replace(/\\/g, "/").replace(/^\.\//, "");
  const index = normalized.search(/[*?]/);
  return (index === -1 ? normalized : normalized.slice(0, index)).replace(/\/+$/, "");
}

/** Cheap pre-dispatch collision check between declared ownerships of concurrent write tickets. */
function predictOwnershipOverlap(workspaceRoot, owns, ticketId) {
  const notes = [];
  const mine = owns.map(literalPrefix);
  for (const other of listTickets(workspaceRoot)) {
    // Only implement tickets ever land changes; scratch investigations cannot collide.
    if (other.id === ticketId || other.role !== "implement" || !other.sandbox?.write) {
      continue;
    }
    if (!owns.length || !other.owns?.length) {
      notes.push(`Ticket ${other.id} is also writing without disjoint declared ownership; collisions are possible.`);
      continue;
    }
    const theirs = other.owns.map(literalPrefix);
    const overlap = mine.some((left) => theirs.some((right) => !left || !right || left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)));
    if (overlap) {
      notes.push(`Declared ownership overlaps with open ticket ${other.id} (${other.owns.join(", ")}).`);
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Worker side: one Codex turn for a ticket

function writeTrace(workspaceRoot, jobId, commandExecutions) {
  const lines = (commandExecutions ?? []).map((item, index) =>
    JSON.stringify({
      index: index + 1,
      command: item.command,
      cwd: item.cwd ?? null,
      status: item.status ?? null,
      exitCode: item.exitCode ?? null,
      durationMs: item.durationMs ?? null,
      output: tail(item.aggregatedOutput ?? "", TRACE_OUTPUT_LIMIT)
    })
  );
  fs.writeFileSync(resolveJobArtifactPath(workspaceRoot, jobId, ".trace.jsonl"), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}

/** thread/resume failed before any turn ran (as opposed to a failure during the turn). */
function isResumeFailure(error) {
  const message = String(error?.message ?? "");
  return /paginated_threads is not supported|no rollout found|thread not found|failed to (?:load|resume) thread|could not resume/i.test(message);
}

function previousTurnHandoff(workspaceRoot, ticket) {
  return (ticket.turns ?? [])
    .filter((entry) => entry.jobId !== ticket.activeJobId)
    .map((entry) => {
      const job = readStoredJob(workspaceRoot, entry.jobId);
      return { turn: entry.turn, outcome: entry.outcome, feedback: entry.feedback, report: job?.result?.report ?? null, summary: job?.summary ?? null };
    });
}

function latestFailingVerification(ticket) {
  const verification = ticket.verifications?.at(-1);
  if (!verification || verification.jobId !== ticket.lastJobId) {
    return null;
  }
  return verification.results?.some((result) => result.exitCode !== 0) ? verification : null;
}

export async function runTicketTurn(request, ctx, { progress, jobId }) {
  const workspaceRoot = request.workspaceRoot;
  const ticket = readTicket(workspaceRoot, request.ticketId);
  if (!ticket) {
    throw new Error(`Ticket ${request.ticketId} no longer exists.`);
  }
  const controller = createJobController(workspaceRoot, jobId, {
    onEvent: ({ message, status, detail }) => progress?.(`Control ${message.type} ${status}${detail ? `: ${detail}` : ""}`)
  });
  const stopHeartbeat = startJobHeartbeat(workspaceRoot, jobId);
  try {
    const workdir = ticket.workdir;
    if (!fs.existsSync(workdir)) {
      throw new Error(`Ticket working directory ${workdir} no longer exists.`);
    }
    const profile = { workdir, write: ticket.sandbox.write, network: ticket.sandbox.network };
    let preflight = readCachedPreflight(workspaceRoot, profile);
    if (!preflight) {
      progress?.({ message: "Probing the Codex sandbox environment.", phase: "starting" });
      preflight = await runPreflight(workspaceRoot, profile).catch((error) => {
        progress?.(`Sandbox preflight failed: ${error.message}`);
        return null;
      });
    }

    const freshThread = !ticket.threadId;
    let prompt = freshThread
      ? buildWorkPackagePrompt(ctx.rootDir, ticket, preflight)
      : buildFollowupPrompt(ctx.rootDir, ticket, {
          feedback: request.feedback,
          turn: request.turn,
          verification: request.attachVerification ? latestFailingVerification(ticket) : null
        });
    if (freshThread && request.turn > 1 && request.feedback) {
      prompt = `${prompt}\n<lead_feedback>\n${request.feedback.trim()}\n</lead_feedback>\n`;
    }
    updateJobFile(workspaceRoot, jobId, (job) => (job ? { ...job, prompt } : null));

    const exclude = ticket.worktree?.linked ?? [];
    const snapshot = () => {
      try {
        return snapshotWorkingTree(workdir, { exclude });
      } catch (error) {
        progress?.(`Working-tree snapshot failed: ${error.message}`);
        return null;
      }
    };
    const startTree = snapshot();
    const headAtStart = readHead(workdir);

    const turnOptions = {
      prompt,
      model: request.model ?? ticket.model ?? null,
      effort: request.effort ?? ticket.effort ?? null,
      sandbox: ticket.sandbox.write ? "workspace-write" : "read-only",
      sandboxPolicy: buildSandboxPolicy(profile),
      outputSchema: loadWorkReportSchema(ctx.rootDir),
      persistThread: true,
      threadName: `Codex Ticket ${ticket.id}: ${shorten(ticket.title, 48)}`,
      disableBroker: true,
      controller,
      onProgress: progress
    };
    let result;
    let threadReset = null;
    try {
      result = await runAppServerTurn(workdir, { ...turnOptions, resumeThreadId: freshThread ? null : ticket.threadId });
    } catch (error) {
      if (freshThread || !isResumeFailure(error)) {
        throw error;
      }
      // The thread exists but cannot be resumed (for example a Codex version that cannot read the
      // thread store). Continue on a fresh thread with the full package and a handoff instead of
      // failing the ticket.
      threadReset = { previousThreadId: ticket.threadId, reason: error.message, at: nowIso() };
      progress?.({ message: `Could not resume thread ${ticket.threadId} (${error.message}); continuing on a fresh thread with a handoff.`, phase: "starting" });
      const handoffPrompt = [
        buildWorkPackagePrompt(ctx.rootDir, ticket, preflight),
        buildResumeHandoffBlock(ticket, previousTurnHandoff(workspaceRoot, ticket), error.message),
        prompt
      ].join("\n\n");
      updateJobFile(workspaceRoot, jobId, (job) => (job ? { ...job, prompt: handoffPrompt, threadReset } : null));
      result = await runAppServerTurn(workdir, { ...turnOptions, prompt: handoffPrompt, resumeThreadId: null });
    }

    const endTree = snapshot();
    const evidence =
      startTree && endTree
        ? buildTurnEvidence({
            workdir,
            isolation: ticket.isolation,
            owns: ticket.role === "implement" ? ticket.owns : ticket.isolation === "worktree" ? null : ["(read-only package)"],
            startTree,
            endTree,
            headAtStart,
            headAtEnd: readHead(workdir),
            fileChanges: result.fileChanges
          })
        : null;
    const parsed = parseWorkReport(result.finalMessage);
    const commands = (result.commandExecutions ?? []).map((item) => ({
      command: item.command,
      cwd: item.cwd ?? null,
      status: item.status ?? null,
      exitCode: item.exitCode ?? null,
      durationMs: item.durationMs ?? null
    }));
    writeTrace(workspaceRoot, jobId, result.commandExecutions);

    const interrupted = controller.interruptRequested || result.turn?.status === "interrupted";
    const failureKind = interrupted ? null : result.status !== 0 ? classifyTurnFailure(result.turn?.error ?? result.error) ?? "error" : null;
    const outcome = interrupted ? "cancelled" : failureKind ?? (parsed.report ? parsed.report.status : "unstructured");
    const payload = {
      ticketId: ticket.id,
      turn: request.turn,
      threadReset,
      outcome,
      report: parsed.report,
      parseError: parsed.report ? null : parsed.parseError,
      rawOutput: parsed.report ? "" : String(result.finalMessage ?? ""),
      evidence,
      commands,
      claims: crossCheckVerificationClaims(parsed.report, commands),
      tokenUsage: result.tokenUsage?.total ?? null,
      runtime: result.runtime ?? null,
      turnStatus: result.turn?.status ?? null,
      turnError: result.turn?.error ?? (result.error ? { message: result.error.message ?? String(result.error) } : null),
      subagentThreadCount: result.subagentThreadCount ?? 0,
      threadId: result.threadId,
      touchedFiles: result.touchedFiles
    };
    const rendered = renderTurnCard(ticket, null, payload, { companion: companionReference(ctx.scriptPath) });
    return {
      exitStatus: failureKind ? 1 : 0,
      statusOverride: interrupted ? "cancelled" : undefined,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: parsed.report?.summary || shorten(firstLine(result.finalMessage), 160) || `Ticket ${ticket.id} turn ${request.turn} finished.`,
      // Codex's own text matters most for quota ("try again at 11:10 PM") and auth failures.
      errorMessage: failureKind ? payload.turnError?.message ?? null : null,
      failureKind
    };
  } finally {
    controller.finalize();
    stopHeartbeat();
  }
}

/** Entry point used by `task-worker` for ticket jobs; always leaves the ticket consistent. */
export async function runTicketWorker(storedJob, ctx, { progress, logFile, runTrackedJob }) {
  const workspaceRoot = storedJob.workspaceRoot;
  try {
    await runTrackedJob({ ...storedJob, logFile }, () => runTicketTurn(storedJob.request, ctx, { progress, jobId: storedJob.id }), {
      logFile
    });
  } finally {
    const ticket = readTicket(workspaceRoot, storedJob.request.ticketId);
    if (ticket) {
      syncTicket(workspaceRoot, ticket);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Commands

async function handleDelegate(argv, ctx) {
  const { options, positionals } = parse(argv, {
    valueOptions: ["ticket", "role", "isolation", "model", "effort", "brief-file", "cwd", "title", "acceptance-notes"],
    multiValueOptions: ["owns", "interface", "accept"],
    booleanOptions: ["json", "read-only", "network"],
    stopAtFirstPositional: true
  });
  const cwd = resolveCwd(options);
  const workspaceRoot = requireRepository(cwd);
  ensureCodexAvailable(cwd);

  const brief = readBrief(cwd, options, positionals);
  if (!brief.trim()) {
    throw new Error("Provide the work package brief as text, --brief-file <path>, or stdin.");
  }
  const role = options.role ?? "implement";
  if (!TICKET_ROLES.has(role)) {
    throw new Error(`Unknown role "${role}". Use implement, investigate, or review.`);
  }
  const isolation = options.isolation ?? "shared";
  if (!["shared", "worktree"].includes(isolation)) {
    throw new Error(`Unknown isolation "${isolation}". Use shared or worktree.`);
  }
  if (isolation === "worktree" && options["read-only"]) {
    throw new Error("--read-only and --isolation worktree are mutually exclusive.");
  }
  // Investigate/review tickets are read-only in the shared checkout. In a worktree they get a
  // disposable scratch copy they may modify to reproduce and experiment; it is never integrated.
  const write = role === "implement" ? !options["read-only"] : isolation === "worktree";

  const tickets = reconcileWorkspace(workspaceRoot);
  const maxParallel = Number(getConfig(workspaceRoot).maxParallelTickets) || DEFAULT_MAX_PARALLEL_TICKETS;
  const running = tickets.filter((ticket) => ticket.state === "running");
  if (running.length >= maxParallel) {
    throw new Error(
      `${running.length} Codex tickets are already running (${running.map((ticket) => ticket.id).join(", ")}); the limit is ${maxParallel}. Wait for one to finish, or raise it with \`setup --max-parallel <n>\`.`
    );
  }

  const ticketId = options.ticket ? validateTicketId(options.ticket) : deriveTicketId(options.title ?? brief);
  if (readTicket(workspaceRoot, ticketId)) {
    throw new Error(`Ticket "${ticketId}" already exists. Pick another name, or use followup to continue it.`);
  }
  await assertModelChoice(workspaceRoot, cwd, { model: options.model ?? null, effort: options.effort ?? null });
  const owns = splitList(options.owns);
  const notes = role === "implement" && write ? predictOwnershipOverlap(workspaceRoot, owns, ticketId) : [];
  if (options.network) {
    notes.push("Network access was granted to this ticket explicitly.");
  }

  let worktree = null;
  let workdir = workspaceRoot;
  if (isolation === "worktree") {
    worktree = createTicketWorktree({ repoRoot: workspaceRoot, worktreePath: path.join(resolveWorktreesDir(workspaceRoot), ticketId), ticketId });
    workdir = worktree.path;
  }

  /** @type {{ job: any, ticket: any }} */
  let launched;
  try {
    launched = launchTicketTurn(workspaceRoot, ticketId, { create: {
      id: ticketId,
      title: options.title ?? shorten(firstLine(brief), 90),
      role,
      brief,
      workspaceRoot,
      workdir,
      isolation,
      worktree,
      sandbox: { write, network: Boolean(options.network) },
      owns,
      interfaces: splitList(options.interface),
      acceptance: options.accept ?? [],
      acceptanceNotes: options["acceptance-notes"] ?? null,
      model: options.model ?? null,
      effort: options.effort ?? null,
      createdBySession: process.env[SESSION_ID_ENV] ?? null,
      threadId: null,
      lastJobId: null,
      turns: [],
      verifications: [],
      integrations: [],
      decisions: []
    } }, ctx);
  } catch (error) {
    if (worktree) {
      removeTicketWorktree({ repoRoot: workspaceRoot, worktree, ticketId, worktreesRoot: resolveWorktreesDir(workspaceRoot) });
    }
    throw error;
  }

  const ticket = launched.ticket;
  const payload = {
    ticketId,
    jobId: launched.job.id,
    role,
    isolation: ticket.isolation,
    workdir,
    sandbox: ticket.sandbox,
    owns,
    acceptance: ticket.acceptance,
    notes
  };
  output(payload, renderLaunch(launched.ticket, launched.job, { companion: companionReference(ctx.scriptPath), notes }), options.json);
}

async function handleFollowup(argv, ctx) {
  const { options, positionals } = parse(argv, {
    valueOptions: ["brief-file", "model", "effort", "cwd"],
    booleanOptions: ["json", "no-verification"],
    stopAtFirstPositional: true
  });
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const ticket = requireTicket(workspaceRoot, positionals[0]);
  if (ticket.state === "running") {
    throw new Error(`Ticket ${ticket.id} is still running. Redirect it with \`steer ${ticket.id} "…"\` or wait for it.`);
  }
  if (!isTicketOpen(ticket)) {
    throw new Error(`Ticket ${ticket.id} is ${ticket.state}; open a new ticket instead.`);
  }
  ensureCodexAvailable(cwd);
  const feedback = options["brief-file"]
    ? fs.readFileSync(path.resolve(cwd, options["brief-file"]), "utf8")
    : positionals.slice(1).join(" ") || readStdinIfPiped();
  const attachVerification = !options["no-verification"] && Boolean(latestFailingVerification(ticket));
  if (options.model || options.effort) {
    // An effort alone is checked against the model this ticket already runs on.
    await assertModelChoice(workspaceRoot, cwd, { model: options.model ?? ticket.model ?? null, effort: options.effort ?? null });
  }
  const launched = withTicketOperationLock(workspaceRoot, ticket.id, () =>
    launchTicketTurn(
      workspaceRoot,
      ticket.id,
      { feedback: feedback?.trim() || null, attachVerification, model: options.model ?? null, effort: options.effort ?? null },
      ctx
    )
  );
  const turn = launched.ticket.turns.length;
  const notes = [];
  if (attachVerification) {
    notes.push("The failing output from your last verify run is attached to this turn.");
  }
  if (turn >= 4) {
    notes.push(`This is turn ${turn}. If the same problem keeps coming back, re-scope or reclaim the work instead of retrying.`);
  }
  output(
    { ticketId: ticket.id, jobId: launched.job.id, turn, attachVerification, notes },
    renderLaunch(launched.ticket, launched.job, { companion: companionReference(ctx.scriptPath), followup: true, notes }),
    options.json
  );
}

async function handleSteer(argv, ctx) {
  const { options, positionals } = parse(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json"],
    stopAtFirstPositional: true
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const ticket = requireTicket(workspaceRoot, positionals[0]);
  const text = positionals.slice(1).join(" ").trim() || readStdinIfPiped().trim();
  if (!text) {
    throw new Error("Provide the message to send to the running Codex turn.");
  }
  const job = readStoredJob(workspaceRoot, ticket.activeJobId);
  if (ticket.state !== "running" || !job || !ACTIVE_JOB_STATUSES.has(job.status)) {
    throw new Error(`Ticket ${ticket.id} has no running turn. Use \`followup ${ticket.id} "…"\` to start one.`);
  }
  const messageId = sendControlMessage(workspaceRoot, job.id, { type: "steer", text });
  const ack = await waitForControlAck(workspaceRoot, job.id, messageId, {
    timeoutMs: Number(options["timeout-ms"]) || 20000,
    isJobActive: () => ACTIVE_JOB_STATUSES.has(readStoredJob(workspaceRoot, job.id)?.status)
  });
  const status = ack?.status ?? "queued";
  const detail =
    status === "delivered"
      ? "Codex received the message in its current turn."
      : status === "queued"
        ? "Not acknowledged yet; the worker delivers it as soon as the turn is active."
        : ack?.detail ?? "";
  output(
    { ticketId: ticket.id, jobId: job.id, messageId, status, detail },
    `Steer ${ticket.id}: ${status}. ${detail}\n`,
    options.json
  );
  if (status === "failed" || status === "undelivered") {
    process.exitCode = 1;
  }
}

function describeTarget(workspaceRoot, reference) {
  const ticket = reference ? resolveTicketReference(workspaceRoot, reference) : null;
  if (ticket) {
    const synced = syncTicket(workspaceRoot, ticket);
    return { ticket: synced, jobId: synced.activeJobId ?? synced.lastJobId };
  }
  if (reference) {
    const job = readStoredJob(workspaceRoot, reference);
    if (!job) {
      throw new Error(`No ticket or job named "${reference}".`);
    }
    return { ticket: job.ticketId ? readTicket(workspaceRoot, job.ticketId) : null, jobId: job.id };
  }
  return null;
}

function renderFinishedTarget(workspaceRoot, target, ctx) {
  const job = readStoredJob(workspaceRoot, target.jobId);
  if (target.ticket) {
    const ticket = syncTicket(workspaceRoot, readTicket(workspaceRoot, target.ticket.id));
    markJob(workspaceRoot, job?.id, "collectedAt");
    return {
      payload: { ticket, job: job ? { ...job, request: undefined, prompt: undefined } : null },
      rendered: renderTurnCard(ticket, job, job?.result ?? null, { companion: companionReference(ctx.scriptPath) })
    };
  }
  markJob(workspaceRoot, job?.id, "collectedAt");
  return {
    payload: { job },
    rendered: `${job?.title ?? job?.id}: ${job?.status}\n${job?.rendered ?? job?.errorMessage ?? ""}`
  };
}

async function handleWait(argv, ctx) {
  const { options, positionals } = parse(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json"]
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const timeoutMs = Math.max(0, Number(options["timeout-ms"]) || 0);
  const pollMs = Math.max(100, Number(options["poll-interval-ms"]) || 1000);
  const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;

  let targets;
  if (positionals.length) {
    targets = positionals.map((reference) => describeTarget(workspaceRoot, reference));
  } else {
    targets = reconcileWorkspace(workspaceRoot)
      .filter((ticket) => ticket.state === "running")
      .map((ticket) => ({ ticket, jobId: ticket.activeJobId }));
    if (targets.length === 0) {
      throw new Error("No Codex tickets are running in this repository.");
    }
  }

  for (;;) {
    reconcileActiveJobs(workspaceRoot);
    const finished = targets.find((target) => !ACTIVE_JOB_STATUSES.has(readStoredJob(workspaceRoot, target.jobId)?.status));
    if (finished) {
      const { payload, rendered } = renderFinishedTarget(workspaceRoot, finished, ctx);
      output({ ...payload, waitTimedOut: false }, rendered, options.json);
      return;
    }
    if (Date.now() >= deadline) {
      const labels = targets.map((target) => target.ticket?.id ?? target.jobId).join(", ");
      output({ waitTimedOut: true, targets: labels }, `Still running after ${timeoutMs}ms: ${labels}\n`, options.json);
      return;
    }
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

async function handleTickets(argv, ctx) {
  const { options } = parse(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "all"] });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  reconcileWorkspace(workspaceRoot);
  const tickets = listTickets(workspaceRoot, { includeClosed: Boolean(options.all) }).slice(0, options.all ? 30 : undefined);
  output({ workspaceRoot, tickets }, renderTicketList(tickets, { companion: companionReference(ctx.scriptPath), includeClosed: options.all }), options.json);
}

function readTraceEntry(workspaceRoot, jobId, index) {
  const traceFile = resolveJobArtifactPath(workspaceRoot, jobId, ".trace.jsonl");
  if (!fs.existsSync(traceFile)) {
    return null;
  }
  const line = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean)[index - 1];
  return line ? JSON.parse(line) : null;
}

async function handleShow(argv, ctx) {
  const { options, positionals } = parse(argv, {
    valueOptions: ["cwd", "turn", "command"],
    booleanOptions: ["json", "commands", "prompt"]
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const ticket = requireTicket(workspaceRoot, positionals[0]);
  let jobId = ticket.activeJobId ?? ticket.lastJobId;
  if (options.turn) {
    jobId = ticket.turns?.find((entry) => String(entry.turn) === String(options.turn))?.jobId ?? null;
    if (!jobId) {
      throw new Error(`Ticket ${ticket.id} has no turn ${options.turn}.`);
    }
  }
  const job = readStoredJob(workspaceRoot, jobId);
  const companion = companionReference(ctx.scriptPath);

  if (options.prompt) {
    output({ ticketId: ticket.id, jobId, prompt: job?.prompt ?? null }, `${job?.prompt ?? "The prompt has not been assembled yet."}\n`, options.json);
    return;
  }
  const tracePruned = !job;
  const prunedTraceMessage = "The command trace for this turn was pruned from job history, which keeps the newest 50 jobs.\n";
  if (options.command) {
    if (tracePruned) {
      output({ ticketId: ticket.id, jobId, command: null, tracePruned: true }, prunedTraceMessage, options.json);
      return;
    }
    const entry = readTraceEntry(workspaceRoot, jobId, Number(options.command));
    if (!entry) {
      throw new Error(`No command #${options.command} was recorded for this turn.`);
    }
    output(entry, renderCommandDetail(entry, Number(options.command)), options.json);
    return;
  }
  if (options.commands) {
    if (tracePruned) {
      output({ ticketId: ticket.id, jobId, commands: [], tracePruned: true }, prunedTraceMessage, options.json);
      return;
    }
    const commands = job?.result?.commands ?? [];
    output({ ticketId: ticket.id, jobId, commands }, renderCommandTrace(commands), options.json);
    return;
  }
  if (job && ACTIVE_JOB_STATUSES.has(job.status)) {
    const heartbeatAge = readJobHeartbeatAgeMs(workspaceRoot, job.id);
    let recent = [];
    try {
      recent = fs
        .readFileSync(job.logFile, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("["))
        .slice(-6)
        .map((line) => line.replace(/^\[[^\]]+\]\s*/, ""));
    } catch {
      recent = [];
    }
    const lines = [
      `# Codex ticket ${ticket.id} — running turn ${ticket.turns?.length ?? "?"} (${job.phase ?? job.status}, ${elapsedBetween(job.startedAt ?? job.createdAt) ?? "?"})`,
      heartbeatAge == null ? "Heartbeat: none yet" : `Heartbeat: ${Math.round(heartbeatAge / 1000)}s ago${heartbeatAge > 90000 ? " (worker may be wedged)" : ""}`,
      job.threadId ? `Codex thread: ${job.threadId} (watch live with \`codex resume ${job.threadId}\`)` : "Codex thread: not started yet",
      "Recent activity:",
      ...recent.map((line) => `- ${shorten(line, 160)}`),
      `Redirect: \`node ${companion} steer ${ticket.id} "…"\` · Stop: \`node ${companion} cancel ${ticket.id}\``
    ];
    output({ ticket, job: { ...job, request: undefined, prompt: undefined }, heartbeatAgeMs: heartbeatAge, recent }, `${lines.join("\n")}\n`, options.json);
    return;
  }
  markJob(workspaceRoot, job?.id, "collectedAt");
  output(
    { ticket, job: job ? { ...job, request: undefined, prompt: undefined } : null },
    renderTicketDetail(ticket, job, job?.result ?? null, { companion }),
    options.json
  );
}

function runAcceptanceCommand(command, cwd, timeoutMs) {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true
  });
  const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ETIMEDOUT";
  return {
    command,
    exitCode: timedOut ? null : result.status ?? null,
    signal: result.signal ?? null,
    timedOut,
    durationMs: Date.now() - started,
    outputTail: tail(`${result.stdout ?? ""}${result.stderr ?? ""}${timedOut ? `\n[timed out after ${timeoutMs}ms]` : ""}`, VERIFY_OUTPUT_LIMIT)
  };
}

function ticketJobs(workspaceRoot, ticket) {
  return (ticket.turns ?? []).map((turn) => readStoredJob(workspaceRoot, turn.jobId)).filter(Boolean);
}

async function handleVerify(argv, ctx) {
  const { options, positionals } = parse(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json", "no-run"]
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const ticket = requireTicket(workspaceRoot, positionals[0]);
  if (ticket.state === "running") {
    throw new Error(`Ticket ${ticket.id} is still running; wait for it before verifying.`);
  }
  const job = readStoredJob(workspaceRoot, ticket.lastJobId);
  const payload = job?.result ?? null;
  const problems = [];
  const outcome = ticket.lastOutcome;
  if (outcome !== "completed") {
    problems.push(`Codex's last turn ended as "${outcome}", not "completed".`);
  }

  let pendingChanges = null;
  let attributed = [];
  if (ticket.isolation === "worktree" && ticket.worktree && fs.existsSync(ticket.workdir)) {
    const { tree, changes } = collectWorktreeChanges(ticket.worktree);
    pendingChanges = changes;
    // Ownership is judged over everything the ticket changed since it started, integrated or not.
    attributed = diffTrees(ticket.workdir, ticket.worktree.baseCommit, tree).map((change) => change.path);
  } else {
    attributed = [...new Set(ticketJobs(workspaceRoot, ticket).flatMap((entry) => entry.result?.evidence?.codexReported ?? []))];
  }
  if (ticket.role === "implement") {
    if (ticket.owns?.length) {
      const isOwned = compileOwnership(ticket.owns);
      const violations = attributed.filter((candidate) => !isOwned(candidate));
      if (violations.length) {
        problems.push(`Changes outside declared ownership (${ticket.owns.join(", ")}): ${violations.join(", ")}`);
      }
    }
    if (attributed.length === 0) {
      problems.push("Codex made no attributable file changes.");
    }
  } else if (attributed.length > 0 && ticket.isolation !== "worktree") {
    problems.push(`A read-only ${ticket.role} ticket changed files: ${attributed.join(", ")}`);
  }
  // Recompute from the stored report and trace so verification never trusts a cached judgement.
  for (const claim of crossCheckVerificationClaims(payload?.report ?? null, payload?.commands ?? [])) {
    if (claim.observation === "contradicted") {
      problems.push(`Codex claimed \`${claim.command}\` ${claim.claimed}, but the observed run exited ${claim.observedExitCode}.`);
    }
  }

  const where = ticket.isolation === "worktree" && ticket.state !== "integrated" ? ticket.workdir : workspaceRoot;
  const timeoutMs = Number(options["timeout-ms"]) || DEFAULT_ACCEPTANCE_TIMEOUT_MS;
  const results = options["no-run"] ? [] : (ticket.acceptance ?? []).map((command) => runAcceptanceCommand(command, where, timeoutMs));
  for (const result of results) {
    if (result.exitCode !== 0) {
      problems.push(`Acceptance check failed: \`${result.command}\` (${result.timedOut ? "timed out" : `exit ${result.exitCode}`}).`);
    }
  }

  const verification = {
    at: nowIso(),
    jobId: ticket.lastJobId,
    where: where === workspaceRoot ? "your checkout" : "ticket worktree",
    head: readHead(where),
    results,
    problems,
    pendingChanges: pendingChanges?.map((change) => ({ path: change.path, status: change.status })) ?? null
  };
  updateTicket(workspaceRoot, ticket.id, (record) => {
    record.verifications = [...(record.verifications ?? []), verification].slice(-10);
  });
  output({ ticketId: ticket.id, verification }, renderVerification(ticket, verification, { companion: companionReference(ctx.scriptPath) }), options.json);
  if (problems.length) {
    process.exitCode = 2;
  }
}

async function handleIntegrate(argv, ctx) {
  const { options, positionals } = parse(argv, { valueOptions: ["cwd"], booleanOptions: ["json", "allow-conflicts"] });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const reference = requireTicket(workspaceRoot, positionals[0]);
  withTicketOperationLock(workspaceRoot, reference.id, () => integrateTicket(workspaceRoot, readTicket(workspaceRoot, reference.id), options, ctx));
}

function integrateTicket(workspaceRoot, ticket, options, ctx) {
  if (ticket.isolation !== "worktree" || !ticket.worktree) {
    throw new Error(`Ticket ${ticket.id} worked directly in your checkout; there is nothing to integrate.`);
  }
  if (ticket.role !== "implement") {
    throw new Error(`Ticket ${ticket.id} is a ${ticket.role} ticket; its scratch worktree holds experiments, not changes to integrate.`);
  }
  if (ticket.state === "running") {
    throw new Error(`Ticket ${ticket.id} is still running.`);
  }
  if (!isTicketOpen(ticket)) {
    throw new Error(`Ticket ${ticket.id} is ${ticket.state}.`);
  }
  if (!fs.existsSync(ticket.workdir)) {
    throw new Error(`The worktree for ${ticket.id} no longer exists at ${ticket.workdir}.`);
  }
  const headNow = readHead(workspaceRoot);
  const result = integrateWorktree({
    repoRoot: workspaceRoot,
    worktree: ticket.worktree,
    ticketId: ticket.id,
    allowConflicts: Boolean(options["allow-conflicts"])
  });
  if (result.applied) {
    updateTicket(workspaceRoot, ticket.id, (record) => {
      record.worktree.integrationBase = result.integratedCommit;
      record.state = "integrated";
      record.integrations = [
        ...(record.integrations ?? []),
        { at: nowIso(), jobId: record.lastJobId, leadHead: headNow, files: result.files, conflicts: result.conflicts }
      ];
    });
  }
  const notes = [];
  if (ticket.worktree.baseHead && headNow && ticket.worktree.baseHead !== headNow) {
    notes.push(`Your HEAD moved since this ticket started (${ticket.worktree.baseHead.slice(0, 10)} → ${headNow.slice(0, 10)}); the merge is per-file, so re-run combined validation.`);
  }
  const rendered = renderIntegration(ticket, result, { companion: companionReference(ctx.scriptPath) }) + notes.map((note) => `Note: ${note}\n`).join("");
  output({ ticketId: ticket.id, ...result, notes }, rendered, options.json);
  if (!result.applied) {
    process.exitCode = 2;
  }
}

async function handleClose(argv, ctx) {
  const { options, positionals } = parse(argv, {
    valueOptions: ["cwd", "reason"],
    booleanOptions: ["json", "accepted", "rejected", "abandoned", "purge", "keep-worktree", "force"]
  });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const reference = requireTicket(workspaceRoot, positionals[0]);
  withTicketOperationLock(workspaceRoot, reference.id, () =>
    closeTicket(workspaceRoot, syncTicket(workspaceRoot, readTicket(workspaceRoot, reference.id)), options)
  );
}

function closeTicket(workspaceRoot, ticket, options) {
  const decisions = ["accepted", "rejected", "abandoned"].filter((decision) => options[decision]);
  const worktreesRoot = resolveWorktreesDir(workspaceRoot);

  if (!isTicketOpen(ticket)) {
    if (!options.purge) {
      throw new Error(`Ticket ${ticket.id} is already ${ticket.state}. Pass --purge to remove its retained worktree.`);
    }
    const purged = Boolean(ticket.worktree && !ticket.worktree.removedAt);
    if (purged) {
      removeTicketWorktree({ repoRoot: workspaceRoot, worktree: ticket.worktree, ticketId: ticket.id, worktreesRoot });
      updateTicket(workspaceRoot, ticket.id, (record) => {
        record.worktree.removedAt = nowIso();
      });
    }
    output(
      { ticketId: ticket.id, purged },
      purged ? `Removed the retained worktree for ${ticket.id}.\n` : `No retained worktree for ${ticket.id}.\n`,
      options.json
    );
    return;
  }
  if (decisions.length !== 1) {
    throw new Error("Choose exactly one of --accepted, --rejected, or --abandoned.");
  }
  if (ticket.state === "running") {
    throw new Error(`Ticket ${ticket.id} is still running. Cancel it first with \`cancel ${ticket.id}\`.`);
  }
  const decision = decisions[0];
  if (decision === "accepted" && ticket.role === "implement" && ticket.worktree && !ticket.worktree.removedAt && fs.existsSync(ticket.workdir) && !options.force) {
    const pending = collectWorktreeChanges(ticket.worktree).changes;
    if (pending.length > 0) {
      throw new Error(
        `Ticket ${ticket.id} has ${pending.length} worktree change(s) that were never integrated. Run \`integrate ${ticket.id}\` first, or pass --force to accept without them.`
      );
    }
  }
  const removeWorktree = Boolean(ticket.worktree && !ticket.worktree.removedAt && ((decision === "accepted" && !options["keep-worktree"]) || options.purge));
  if (removeWorktree) {
    removeTicketWorktree({ repoRoot: workspaceRoot, worktree: ticket.worktree, ticketId: ticket.id, worktreesRoot });
  }
  const closed = updateTicket(workspaceRoot, ticket.id, (record) => {
    record.state = decision;
    record.closedAt = nowIso();
    record.decisions = [
      ...(record.decisions ?? []),
      { at: nowIso(), action: decision, reason: options.reason ?? null, jobId: record.lastJobId, turns: record.turns?.length ?? 0 }
    ];
    if (removeWorktree) {
      record.worktree.removedAt = nowIso();
    }
  });
  const retained = closed.worktree && !closed.worktree.removedAt ? ` Worktree retained at ${closed.workdir} (remove later with \`close ${closed.id} --purge\`).` : "";
  output({ ticketId: closed.id, state: closed.state, worktreeRemoved: removeWorktree }, `Closed ${closed.id} as ${decision}.${retained}\n`, options.json);
}

async function handlePreflight(argv) {
  const { options } = parse(argv, {
    valueOptions: ["cwd"],
    multiValueOptions: ["check"],
    booleanOptions: ["json", "network", "read-only"]
  });
  const cwd = resolveCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  ensureCodexAvailable(cwd);
  const report = await runPreflight(workspaceRoot, {
    workdir: workspaceRoot,
    write: !options["read-only"],
    network: Boolean(options.network),
    checks: options.check ?? []
  });
  report.models = await fetchModelCatalog(workspaceRoot, { cwd }).catch(() => null);
  output(report, `${renderPreflight(report)}${renderModelCatalog(report.models).join("\n")}\n`, options.json);
}

/** Reject a --model/--effort Codex does not offer before a turn is spent; unchecked if discovery is unavailable. */
async function assertModelChoice(workspaceRoot, cwd, choice) {
  if (!choice.model && !choice.effort) {
    return;
  }
  const problem = validateModelChoice(await loadModelCatalog(workspaceRoot, { cwd }), choice);
  if (problem) {
    throw new Error(`${problem} Run \`preflight\` to see the models and efforts available here.`);
  }
}

function watchSignature(ticket) {
  return `${ticket.state}|${ticket.lastJobId ?? ""}|${ticket.lastOutcome ?? ""}`;
}

/** Long-running event stream for a Claude Code plugin monitor: one line per finished ticket turn. */
async function handleWatch(argv, ctx) {
  const { options } = parse(argv, { valueOptions: ["cwd", "interval-ms"], booleanOptions: [] });
  const workspaceRoot = resolveWorkspaceRoot(resolveCwd(options));
  const intervalMs = Math.max(250, Number(options["interval-ms"]) || 2000);
  const companion = companionReference(ctx.scriptPath);
  let stdoutBroken = false;
  process.stdout.on("error", () => {
    stdoutBroken = true;
  });
  const unsettled = new Map();
  const retryUnsettled = () => {
    for (const [jobId, delivered] of unsettled) {
      if (settleTurnNotification(workspaceRoot, jobId, delivered)) {
        unsettled.delete(jobId);
      }
    }
  };
  process.once("SIGTERM", () => {
    retryUnsettled();
    process.exit(0);
  });

  // Claim, write, then confirm, or give the claim back if the write fails, so a lost line is picked
  // up by a later watcher's startup scan or by the Stop reminder (see isTurnNotified). Several
  // watchers can be armed at once (the monitor has one entry per skill-name form), and a turn
  // Claude already saw through wait/show needs no line.
  const announce = (ticket) => {
    if (!claimTurnNotification(workspaceRoot, ticket.lastJobId)) {
      return;
    }
    const summary = ticket.lastSummary ? ` — ${shorten(ticket.lastSummary, 160).replace(/[.\s]+$/, "")}` : "";
    const line = `Codex ticket ${ticket.id} finished turn ${ticket.turns?.length ?? "?"}: ${ticket.lastOutcome}${summary}. Review: node ${companion} show ${ticket.id}\n`;
    const jobId = ticket.lastJobId;
    process.stdout.write(line, (error) => {
      if (error) {
        stdoutBroken = true;
      }
      if (!settleTurnNotification(workspaceRoot, jobId, !error)) {
        // Retried while this watcher lives: an unconfirmed delivery would lapse at exit and repeat.
        unsettled.set(jobId, !error);
      }
    });
  };

  // Snapshot first, then announce this session's turns that finished before the watcher armed and
  // that nothing has surfaced yet: a turn finishing in between still differs from the snapshot.
  const seen = new Map(listTickets(workspaceRoot, { includeClosed: true }).map((ticket) => [ticket.id, watchSignature(ticket)]));
  try {
    for (const { ticket } of findUnsurfacedTicketTurns(workspaceRoot, process.env[SESSION_ID_ENV] || null)) {
      announce(ticket);
    }
  } catch {
    // A transient read error must never kill the monitor.
  }

  while (!stdoutBroken) {
    retryUnsettled();
    try {
      reconcileWorkspace(workspaceRoot);
      for (const ticket of listTickets(workspaceRoot, { includeClosed: true })) {
        const signature = watchSignature(ticket);
        if (seen.get(ticket.id) === signature) {
          continue;
        }
        if (ticket.state === "needs-review" && ticket.lastJobId) {
          announce(ticket);
        }
        // Only after handling it: a throw above (lock timeout, read error) retries on the next poll.
        seen.set(ticket.id, signature);
      }
    } catch {
      // A transient read error must never kill the monitor.
    }
    await sleep(intervalMs);
  }
  retryUnsettled();
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------------------------
// Integration points for cancel, hooks, and status

export function resolveTicketJob(workspaceRoot, reference) {
  const ticket = reference ? readTicket(workspaceRoot, reference) : null;
  if (!ticket) {
    return null;
  }
  return syncTicket(workspaceRoot, ticket).activeJobId ?? null;
}

/**
 * Stop a control-channel worker cleanly: interrupt the live turn through the worker so partial
 * evidence is recorded, then terminate the verified process tree only if it does not exit.
 */
export async function cancelControlledJob(workspaceRoot, job, { timeoutMs = GRACEFUL_CANCEL_TIMEOUT_MS } = {}) {
  const messageId = sendControlMessage(workspaceRoot, job.id, { type: "interrupt" });
  const isActive = () => ACTIVE_JOB_STATUSES.has(readStoredJob(workspaceRoot, job.id)?.status);
  const ack = await waitForControlAck(workspaceRoot, job.id, messageId, { timeoutMs, isJobActive: isActive });
  const deadline = Date.now() + timeoutMs;
  while (isActive() && Date.now() < deadline) {
    await sleep(200);
  }
  let terminated = null;
  if (isActive()) {
    const stored = readStoredJob(workspaceRoot, job.id) ?? job;
    terminated = terminateRecordedProcessTree(stored.pid ?? Number.NaN, stored.pidMarker ?? null, { commandHint: stored.pidCommandHint ?? null });
    withStateLock(workspaceRoot, () => {
      const current = readStoredJob(workspaceRoot, job.id) ?? stored;
      if (ACTIVE_JOB_STATUSES.has(current.status)) {
        const completedAt = nowIso();
        writeJobFile(workspaceRoot, job.id, { ...current, status: "cancelled", phase: "cancelled", pid: null, completedAt, errorMessage: "Cancelled by user." });
        upsertJob(workspaceRoot, { id: job.id, status: "cancelled", phase: "cancelled", pid: null, completedAt, errorMessage: "Cancelled by user." });
      }
    });
  }
  appendLogLine(job.logFile, "Cancelled by user.");
  if (job.ticketId) {
    const ticket = readTicket(workspaceRoot, job.ticketId);
    if (ticket) {
      syncTicket(workspaceRoot, ticket);
    }
  }
  return {
    turnInterruptAttempted: true,
    turnInterrupted: ack?.status === "delivered",
    interruptDetail: ack?.detail ?? null,
    forcedTermination: Boolean(terminated?.delivered)
  };
}

/** Finished ticket turns from this session that nothing has surfaced to Claude yet. */
export function findUnsurfacedTicketTurns(workspaceRoot, sessionId) {
  if (!sessionId) {
    return [];
  }
  return reconcileWorkspace(workspaceRoot)
    .filter((ticket) => ticket.state === "needs-review" && ticket.lastJobId)
    .map((ticket) => ({ ticket, job: readStoredJob(workspaceRoot, ticket.lastJobId) }))
    .filter(({ job }) => job && job.sessionId === sessionId && !job.collectedAt && !isTurnNotified(job) && !job.nudgedAt);
}

export function markTicketTurnsNudged(workspaceRoot, entries) {
  for (const { job } of entries) {
    markJob(workspaceRoot, job.id, "nudgedAt");
  }
}

/** Short ledger injected into Claude's context at session start / resume / compaction. */
export function renderSessionLedger(workspaceRoot, scriptPath) {
  const tickets = reconcileWorkspace(workspaceRoot);
  if (tickets.length === 0) {
    return "";
  }
  const companion = companionReference(scriptPath);
  const lines = ["Open Codex tickets in this repository (durable; they survive sessions and compaction):"];
  for (const ticket of tickets.slice(0, 8)) {
    const where = ticket.isolation === "worktree" ? "worktree" : ticket.sandbox?.write ? "shared checkout" : "read-only";
    const status = ticket.state === "running" ? "running" : `${ticket.state}, last outcome ${ticket.lastOutcome}`;
    lines.push(`- ${ticket.id}: ${status} (${ticket.role}, ${where}) — ${shorten(ticket.lastSummary ?? ticket.title, 110)}`);
  }
  if (tickets.length > 8) {
    lines.push(`- … and ${tickets.length - 8} more`);
  }
  lines.push(`Inspect with \`node ${companion} tickets\` / \`show <ticket>\`; the codex-delegation skill describes the workflow.`);
  return `${lines.join("\n")}\n`;
}

export const TICKET_COMMANDS = {
  delegate: handleDelegate,
  followup: handleFollowup,
  steer: handleSteer,
  wait: handleWait,
  tickets: handleTickets,
  show: handleShow,
  verify: handleVerify,
  integrate: handleIntegrate,
  close: handleClose,
  preflight: handlePreflight,
  watch: handleWatch
};
