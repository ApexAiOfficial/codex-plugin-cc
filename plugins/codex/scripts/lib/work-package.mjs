import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./prompts.mjs";

export const TICKET_ROLES = new Set(["implement", "investigate", "review"]);
const REPORT_STATUSES = new Set(["completed", "partial", "blocked", "failed"]);
const BLOCKER_KINDS = new Set(["dependency", "network", "credential", "service", "permission", "scope", "ambiguity", "other"]);

const ROLE_CONTRACTS = {
  implement: [
    "Implement the objective with production-quality code and the tests it deserves.",
    "Prefer the smallest correct change that fits the existing architecture and conventions.",
    "Leave the working tree in a state the lead can integrate directly."
  ],
  investigate: [
    "This is an investigation, not an implementation: deliver an evidence-backed answer, not a patch. Only modify files if you are in a scratch worktree.",
    "Gather evidence by reading code, reproducing, and running targeted commands. Test competing hypotheses instead of settling on the first plausible one.",
    "Separate observed facts from inferences. Put conclusions in findings with concrete evidence and calibrated confidence, and recommend the next concrete step."
  ],
  review: [
    "This is a review, not an implementation: do not fix what you find. Only modify files (for experiments) if you are in a scratch worktree.",
    "Your job is to break confidence in the target, not to validate it. Look for violated invariants, unhandled failure paths, races, stale state, data loss, security and compatibility regressions, and wrong design assumptions.",
    "Report only material findings, each tied to a concrete location with evidence and honest confidence. If it looks sound, say so plainly with no findings."
  ]
};

export function loadWorkReportSchema(rootDir) {
  return readJsonFile(path.join(rootDir, "schemas", "work-report.schema.json"));
}

function bulletList(items, fallback) {
  const lines = (items ?? []).map((item) => String(item).trim()).filter(Boolean);
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : fallback;
}

export function describeOwnership(ticket) {
  if (ticket.role !== "implement") {
    return ticket.isolation === "worktree"
      ? "You are in a disposable scratch worktree created from the lead's current state. You may edit files, add instrumentation, and run anything the environment allows in order to reproduce and test hypotheses. Nothing here is integrated: report conclusions and evidence, and put any proposed fix in findings as a description or small diff."
      : "Read-only package: you own no files.";
  }
  const lines = [];
  if (ticket.owns?.length) {
    lines.push("You own these paths and may change them freely:");
    lines.push(bulletList(ticket.owns));
    lines.push("Do not modify anything outside them. If the objective truly requires a change elsewhere, report it as a \"scope\" blocker instead of making it.");
  } else {
    lines.push("No explicit path ownership was declared. Keep changes to the files the objective needs.");
  }
  if (ticket.interfaces?.length) {
    lines.push("You own these interfaces and contracts:");
    lines.push(bulletList(ticket.interfaces));
  }
  if (ticket.isolation === "shared") {
    lines.push(
      "The lead is editing other files in this same checkout concurrently. Unexpected changes or failing tests outside your ownership are not yours to fix: mention them under risks and carry on."
    );
  } else {
    lines.push("You are in an isolated worktree created from the lead's current state; nobody else edits it.");
  }
  return lines.join("\n");
}

function describeAcceptance(ticket) {
  const lines = [];
  if (ticket.acceptance?.length) {
    lines.push("The lead will independently run these checks before accepting the package; make them pass:");
    lines.push(bulletList(ticket.acceptance.map((command) => `\`${command}\``)));
  }
  if (ticket.acceptanceNotes) {
    lines.push(ticket.acceptanceNotes);
  }
  if (lines.length === 0) {
    lines.push(
      ticket.role === "implement"
        ? "No explicit acceptance commands were given. Choose and run the most relevant existing tests for what you changed."
        : "Done means the question is answered with evidence, or the remaining uncertainty is stated precisely."
    );
  }
  return lines.join("\n");
}

export function describeEnvironment(ticket, preflight) {
  const lines = [`Working directory: ${ticket.workdir}${ticket.isolation === "worktree" ? " (isolated git worktree)" : ""}.`];
  if (ticket.sandbox.write) {
    lines.push("Writes are allowed only inside the working directory and the temp directory.");
  } else {
    lines.push("The sandbox is read-only.");
  }
  lines.push(".git is read-only: git status/diff/log work, but staging and committing do not.");
  lines.push(
    ticket.sandbox.network
      ? "Network access is enabled for this package."
      : "Network access is disabled: package installs, registry downloads, external APIs, and remote git operations will fail."
  );
  for (const limitation of preflight?.limitations ?? []) {
    lines.push(limitation);
  }
  if (ticket.isolation === "worktree" && ticket.worktree?.linked?.length) {
    lines.push(
      `Dependency directories are shared from the main checkout via symlink (${ticket.worktree.linked.join(", ")}); they are not writable from here.`
    );
  }
  return lines.join("\n");
}

export function buildWorkPackagePrompt(rootDir, ticket, preflight) {
  return interpolateTemplate(loadPromptTemplate(rootDir, "work-package"), {
    TICKET_ID: ticket.id,
    ROLE: ticket.role,
    BRIEF: ticket.brief.trim(),
    ROLE_CONTRACT: bulletList(ROLE_CONTRACTS[ticket.role] ?? ROLE_CONTRACTS.implement),
    OWNERSHIP: describeOwnership(ticket),
    ACCEPTANCE: describeAcceptance(ticket),
    ENVIRONMENT: describeEnvironment(ticket, preflight)
  });
}

/**
 * When a ticket's Codex thread cannot be resumed, a fresh thread gets the full work package plus a
 * factual handoff of earlier turns, so the package continues instead of starting over blind.
 */
export function buildResumeHandoffBlock(ticket, previousTurns, reason) {
  const lines = [
    "<previous_turns>",
    `This package already ran ${previousTurns.length} turn(s) on another Codex thread that could no longer be resumed (${reason}). The working directory contains everything that thread changed. Handoff of what it reported:`
  ];
  for (const entry of previousTurns) {
    const report = entry.report;
    lines.push(`Turn ${entry.turn} (${entry.outcome ?? "unknown outcome"}): ${report?.summary || entry.summary || "no summary"}`);
    for (const change of (report?.changes ?? []).slice(0, 12)) {
      lines.push(`- changed ${change.path}: ${change.description}`);
    }
    for (const blocker of report?.blockers ?? []) {
      lines.push(`- blocker [${blocker.kind}]: ${blocker.detail}`);
    }
    if (entry.feedback) {
      lines.push(`- lead feedback given for this turn: ${entry.feedback}`);
    }
  }
  lines.push("Verify the current state of the files yourself before relying on this summary.", "</previous_turns>");
  return lines.join("\n");
}

export function buildFollowupPrompt(rootDir, ticket, { feedback, turn, verification }) {
  let verificationBlock = "";
  const failing = (verification?.results ?? []).filter((result) => result.exitCode !== 0);
  if (failing.length > 0) {
    verificationBlock = [
      "<lead_verification>",
      "The lead ran the acceptance checks independently and these failed:",
      ...failing.map((result) => [`$ ${result.command}  (exit ${result.exitCode})`, result.outputTail?.trim() || "(no output)"].join("\n")),
      "</lead_verification>"
    ].join("\n");
  }
  return interpolateTemplate(loadPromptTemplate(rootDir, "work-followup"), {
    TICKET_ID: ticket.id,
    TURN: String(turn),
    FEEDBACK: feedback?.trim() || "Continue from the current state and finish the package.",
    VERIFICATION_BLOCK: verificationBlock
  });
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? "").trim()).filter(Boolean) : [];
}

function asObjectArray(value) {
  return Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
}

/** Parse Codex's final message into a normalized work report, or null when it is not one. */
export function parseWorkReport(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { report: null, parseError: "Codex returned no final message." };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { report: null, parseError: `Final message is not JSON: ${error.message}` };
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !REPORT_STATUSES.has(data.status)) {
    return { report: null, parseError: "Final message JSON does not look like a work report." };
  }
  return {
    parseError: null,
    report: {
      status: data.status,
      summary: String(data.summary ?? "").trim(),
      changes: asObjectArray(data.changes).map((change) => ({
        path: String(change.path ?? "").trim(),
        description: String(change.description ?? "").trim()
      })),
      verification: asObjectArray(data.verification).map((check) => ({
        command: String(check.command ?? "").trim(),
        outcome: ["passed", "failed", "not_run"].includes(check.outcome) ? check.outcome : "not_run",
        detail: String(check.detail ?? "").trim()
      })),
      findings: asObjectArray(data.findings).map((finding) => ({
        title: String(finding.title ?? "").trim(),
        detail: String(finding.detail ?? "").trim(),
        evidence: String(finding.evidence ?? "").trim(),
        confidence: Number.isFinite(finding.confidence) ? finding.confidence : null
      })),
      blockers: asObjectArray(data.blockers).map((blocker) => ({
        kind: BLOCKER_KINDS.has(String(blocker.kind ?? "").trim()) ? String(blocker.kind).trim() : "other",
        detail: String(blocker.detail ?? "").trim(),
        neededFromLead: String(blocker.needed_from_lead ?? "").trim()
      })),
      risks: asStringArray(data.risks),
      nextSteps: asStringArray(data.next_steps)
    }
  };
}

/**
 * Classify why a turn did not produce a normal result, so the lead can tell a broken
 * implementation from quota exhaustion or infrastructure trouble.
 */
export function classifyTurnFailure(turnError) {
  const info = turnError?.codexErrorInfo ?? null;
  const key = typeof info === "string" ? info : info && typeof info === "object" ? Object.keys(info)[0] : null;
  switch (key) {
    case "usageLimitExceeded":
    case "sessionBudgetExceeded":
      return "quota";
    case "serverOverloaded":
    case "internalServerError":
    case "httpConnectionFailed":
    case "responseStreamConnectionFailed":
    case "responseStreamDisconnected":
    case "responseTooManyFailedAttempts":
      return "transient";
    case "contextWindowExceeded":
      return "context-window";
    case "unauthorized":
      return "auth";
    case "sandboxError":
      return "sandbox";
    case null:
      return turnError ? "error" : null;
    default:
      return "error";
  }
}
