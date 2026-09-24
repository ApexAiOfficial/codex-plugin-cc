const MAX_LISTED_FILES = 12;

function shorten(text, limit = 160) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function elapsedBetween(start, end = null) {
  const startMs = Date.parse(start ?? "");
  const endMs = end ? Date.parse(end) : Date.now();
  return Number.isFinite(startMs) && Number.isFinite(endMs) ? formatDuration(endMs - startMs) : null;
}

function listFiles(paths) {
  if (paths.length <= MAX_LISTED_FILES) {
    return paths.join(", ");
  }
  return `${paths.slice(0, MAX_LISTED_FILES).join(", ")}, … (+${paths.length - MAX_LISTED_FILES} more)`;
}

function describeWhere(ticket) {
  const parts = [ticket.role, ticket.isolation === "worktree" ? "worktree" : ticket.sandbox?.write ? "shared checkout" : "read-only"];
  if (ticket.sandbox?.network) {
    parts.push("network");
  }
  return parts.join(", ");
}

function changeCounts(evidence) {
  const changed = evidence?.changed ?? [];
  const added = changed.reduce((sum, change) => sum + (change.added ?? 0), 0);
  const deleted = changed.reduce((sum, change) => sum + (change.deleted ?? 0), 0);
  return `${changed.length} file(s) (+${added} −${deleted})`;
}

export function renderLaunch(ticket, job, { companion, followup = false, notes = [] }) {
  const lines = [
    `Codex ticket ${ticket.id} ${followup ? `turn ${ticket.turns?.length ?? "?"} started` : "started"} (${describeWhere(ticket)}) as job ${job.id}.`
  ];
  if (ticket.isolation === "worktree") {
    lines.push(`Worktree: ${ticket.workdir}${ticket.worktree?.snapshotOfDirtyTree ? " (includes your uncommitted changes at launch)" : ""}`);
  }
  if (ticket.owns?.length) {
    lines.push(`Owns: ${ticket.owns.join(", ")}`);
  }
  if (ticket.acceptance?.length) {
    lines.push(`Acceptance: ${ticket.acceptance.map((command) => `\`${command}\``).join(", ")}`);
  }
  for (const note of notes) {
    lines.push(`Note: ${note}`);
  }
  lines.push(
    `Completion: notified by the ticket monitor when available; otherwise run \`node ${companion} wait ${ticket.id}\` with run_in_background.`
  );
  return `${lines.join("\n")}\n`;
}

export function describeOutcome(outcome) {
  switch (outcome) {
    case "completed":
      return "completed";
    case "partial":
      return "partial — required work remains";
    case "blocked":
      return "blocked — Codex needs something from the lead";
    case "failed":
      return "failed — Codex reports its approach did not work";
    case "unstructured":
      return "finished without a structured report";
    case "cancelled":
      return "cancelled";
    case "quota":
      return "stopped by usage limits (retry later with followup)";
    case "transient":
      return "stopped by a transient infrastructure error (retry with followup)";
    case "context-window":
      return "stopped: the thread exceeded its context window";
    case "auth":
      return "stopped: Codex authentication failed (run /codex:setup)";
    case "worker-lost":
      return "worker process died without a result";
    default:
      return outcome ?? "unknown";
  }
}

export function suggestNextSteps(ticket, outcome, companion) {
  const id = ticket.id;
  const cmd = (rest) => `node ${companion} ${rest}`;
  switch (outcome) {
    case "completed":
    case "partial":
    case "unstructured":
      if (ticket.role !== "implement") {
        return [`Review the findings; close with \`${cmd(`close ${id} --accepted --reason "…"`)}\` or ask more with \`${cmd(`followup ${id} "…"`)}\`.`];
      }
      return [
        `Verify independently: \`${cmd(`verify ${id}`)}\``,
        ticket.isolation === "worktree" ? `Then integrate: \`${cmd(`integrate ${id}`)}\`` : "Then run combined validation in your checkout.",
        `Return problems to the same thread: \`${cmd(`followup ${id} "…"`)}\` (failing verification output is attached automatically).`
      ];
    case "blocked":
      return [
        "Resolve the blocker yourself (network, installs, credentials, services are yours) or decide to reclaim the work.",
        `Then continue the same thread: \`${cmd(`followup ${id} "Unblocked: …"`)}\``
      ];
    case "quota":
    case "transient":
    case "worker-lost":
    case "cancelled":
      return [`Continue the same thread when ready: \`${cmd(`followup ${id}`)}\`, or \`${cmd(`close ${id} --abandoned --reason "…"`)}\`.`];
    default:
      return [`Inspect: \`${cmd(`show ${id}`)}\``];
  }
}

/** The compact card Claude sees when a ticket turn finishes. */
export function renderTurnCard(ticket, job, payload, { companion }) {
  const outcome = payload?.outcome ?? job?.failureKind ?? (job?.status === "failed" ? "error" : null);
  const report = payload?.report ?? null;
  const evidence = payload?.evidence ?? null;
  const lines = [
    `# Codex ticket ${ticket.id} — turn ${payload?.turn ?? ticket.turns?.length ?? "?"}: ${describeOutcome(outcome)}`,
    [describeWhere(ticket), elapsedBetween(job?.startedAt, job?.completedAt), payload?.runtime?.model].filter(Boolean).join(" · ")
  ];

  if (report?.summary) {
    lines.push(`Summary: ${report.summary}`);
  } else if (payload?.rawOutput) {
    lines.push(`Final message: ${shorten(payload.rawOutput, 400)}`);
  } else if (job?.errorMessage) {
    lines.push(`Error: ${shorten(job.errorMessage, 400)}`);
  }

  if (evidence) {
    const attributed = ticket.isolation === "worktree" ? evidence.changed.map((change) => change.path) : evidence.codexReported;
    lines.push(`Changed: ${changeCounts(evidence)}${attributed.length ? ` — ${listFiles(attributed)}` : ""}`);
    if (evidence.unattributed?.length) {
      lines.push(`Also changed during the turn (not reported by Codex; you, or Codex via shell): ${listFiles(evidence.unattributed)}`);
    }
    if (evidence.ownership?.violations?.length) {
      lines.push(`OWNERSHIP VIOLATION outside ${evidence.ownership.patterns.join(", ")}: ${listFiles(evidence.ownership.violations)}`);
    }
  }

  for (const claim of payload?.claims ?? []) {
    if (claim.observation !== "consistent") {
      lines.push(
        `Claim check: \`${shorten(claim.command, 80)}\` reported ${claim.claimed} but ${claim.observation === "contradicted" ? `observed exit ${claim.observedExitCode}` : "no matching command was observed"}.`
      );
    }
  }
  const verified = (report?.verification ?? []).filter((check) => check.outcome !== "not_run");
  if (verified.length) {
    lines.push(`Codex verification: ${verified.map((check) => `\`${shorten(check.command, 60)}\` ${check.outcome}`).join("; ")}`);
  }
  for (const blocker of report?.blockers ?? []) {
    lines.push(`BLOCKER [${blocker.kind}]: ${shorten(blocker.detail, 240)}${blocker.neededFromLead ? ` — needs: ${shorten(blocker.neededFromLead, 200)}` : ""}`);
  }
  if (ticket.role !== "implement") {
    for (const finding of (report?.findings ?? []).slice(0, 6)) {
      const confidence = Number.isFinite(finding.confidence) ? ` (${Math.round(finding.confidence * 100)}%)` : "";
      lines.push(`Finding${confidence}: ${finding.title} — ${shorten(finding.detail, 200)}`);
    }
  }
  for (const risk of (report?.risks ?? []).slice(0, 4)) {
    lines.push(`Risk: ${shorten(risk, 200)}`);
  }
  if (payload?.parseError && payload?.rawOutput) {
    lines.push(`(Report parse issue: ${payload.parseError})`);
  }
  lines.push("Next:");
  for (const step of suggestNextSteps(ticket, outcome, companion)) {
    lines.push(`- ${step}`);
  }
  if ((ticket.turns?.length ?? 0) >= 4 && ["partial", "failed", "blocked"].includes(outcome)) {
    lines.push(`- This ticket has used ${ticket.turns.length} turns. Consider re-scoping, replanning, or reclaiming it instead of another retry.`);
  }
  lines.push(`Drill down: \`node ${companion} show ${ticket.id}\` (report), \`--commands\` (trace), \`--command N\` (one command's output).`);
  return `${lines.join("\n")}\n`;
}

export function renderTicketList(tickets, { companion, includeClosed = false }) {
  if (tickets.length === 0) {
    return includeClosed ? "No Codex tickets recorded for this repository.\n" : "No open Codex tickets for this repository.\n";
  }
  const lines = ["| Ticket | State | Last outcome | Kind | Age | Summary |", "| --- | --- | --- | --- | --- | --- |"];
  for (const ticket of tickets) {
    lines.push(
      `| ${ticket.id} | ${ticket.state} | ${ticket.lastOutcome ?? "—"} | ${describeWhere(ticket)} | ${elapsedBetween(ticket.createdAt) ?? ""} | ${shorten(ticket.lastSummary ?? ticket.title, 90).replace(/\|/g, "\\|")} |`
    );
  }
  lines.push("", `Details: \`node ${companion} show <ticket>\``);
  return `${lines.join("\n")}\n`;
}

function renderReportDetails(lines, report) {
  if (!report) {
    return;
  }
  if (report.changes.length) {
    lines.push("", "Changes (as reported by Codex):");
    for (const change of report.changes) {
      lines.push(`- ${change.path}: ${change.description}`);
    }
  }
  if (report.verification.length) {
    lines.push("", "Verification (as reported by Codex):");
    for (const check of report.verification) {
      lines.push(`- [${check.outcome}] \`${check.command}\`${check.detail ? ` — ${check.detail}` : ""}`);
    }
  }
  if (report.findings.length) {
    lines.push("", "Findings:");
    for (const finding of report.findings) {
      const confidence = Number.isFinite(finding.confidence) ? ` (confidence ${finding.confidence})` : "";
      lines.push(`- ${finding.title}${confidence}: ${finding.detail}`);
      if (finding.evidence) {
        lines.push(`  Evidence: ${finding.evidence}`);
      }
    }
  }
  if (report.blockers.length) {
    lines.push("", "Blockers:");
    for (const blocker of report.blockers) {
      lines.push(`- [${blocker.kind}] ${blocker.detail}${blocker.neededFromLead ? `\n  Needed from lead: ${blocker.neededFromLead}` : ""}`);
    }
  }
  if (report.risks.length) {
    lines.push("", "Risks:", ...report.risks.map((risk) => `- ${risk}`));
  }
  if (report.nextSteps.length) {
    lines.push("", "Codex's suggested next steps:", ...report.nextSteps.map((step) => `- ${step}`));
  }
}

export function renderTicketDetail(ticket, job, payload, { companion }) {
  const lines = [renderTurnCard(ticket, job, payload, { companion }).trimEnd()];
  renderReportDetails(lines, payload?.report ?? null);
  if (!payload?.report && payload?.rawOutput) {
    lines.push("", "Final message:", payload.rawOutput.trim());
  }
  lines.push("", "Ticket:");
  lines.push(`- State: ${ticket.state}; turns: ${ticket.turns?.length ?? 0}; thread: ${ticket.threadId ?? "not started"}`);
  lines.push(`- Workdir: ${ticket.workdir}`);
  if (ticket.threadId) {
    lines.push(`- Open in Codex: codex resume ${ticket.threadId}`);
  }
  for (const verification of (ticket.verifications ?? []).slice(-2)) {
    lines.push(`- Verified ${verification.at}: ${verification.problems?.length ? verification.problems.join("; ") : "no problems"}`);
  }
  for (const decision of ticket.decisions ?? []) {
    lines.push(`- Decision ${decision.at}: ${decision.action}${decision.reason ? ` — ${decision.reason}` : ""}`);
  }
  lines.push(`- Brief: ${shorten(ticket.brief, 300)}`);
  return `${lines.join("\n")}\n`;
}

export function renderCommandTrace(commands) {
  if (!commands?.length) {
    return "No commands were recorded for this turn.\n";
  }
  const lines = ["| # | Exit | Duration | Command |", "| --- | --- | --- | --- |"];
  commands.forEach((command, index) => {
    lines.push(
      `| ${index + 1} | ${command.exitCode ?? command.status ?? "?"} | ${formatDuration(command.durationMs) ?? ""} | \`${shorten(command.command, 140).replace(/\|/g, "\\|")}\` |`
    );
  });
  return `${lines.join("\n")}\n`;
}

export function renderCommandDetail(entry, index) {
  return [
    `# Command ${index}`,
    `$ ${entry.command}`,
    `cwd: ${entry.cwd ?? "?"} · exit: ${entry.exitCode ?? "?"} · status: ${entry.status ?? "?"} · duration: ${formatDuration(entry.durationMs) ?? "?"}`,
    "",
    entry.output?.trim() || "(no output captured)",
    ""
  ].join("\n");
}

export function renderVerification(ticket, verification, { companion }) {
  const lines = [`# Verification of ${ticket.id} (${verification.where})`];
  if (verification.results.length === 0) {
    lines.push("No acceptance commands are declared for this ticket; only evidence checks ran.");
  }
  for (const result of verification.results) {
    lines.push(`- ${result.exitCode === 0 ? "PASS" : "FAIL"} \`${result.command}\` (exit ${result.exitCode ?? "?"}, ${formatDuration(result.durationMs) ?? "?"})`);
    if (result.exitCode !== 0 && result.outputTail) {
      lines.push("```text", result.outputTail.trim().split("\n").slice(-40).join("\n"), "```");
    }
  }
  if (verification.pendingChanges) {
    lines.push(`Pending worktree changes: ${verification.pendingChanges.length} file(s)${verification.pendingChanges.length ? ` — ${listFiles(verification.pendingChanges.map((change) => change.path))}` : ""}`);
  }
  if (verification.problems.length === 0) {
    lines.push("Verdict: no mechanical problems found. Judge the semantics, then integrate/accept.");
  } else {
    lines.push("Verdict: NEEDS ATTENTION");
    for (const problem of verification.problems) {
      lines.push(`- ${problem}`);
    }
    lines.push(`Return it to Codex with: \`node ${companion} followup ${ticket.id} "…"\` (this verification output is attached automatically).`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderIntegration(ticket, result, { companion }) {
  const lines = [];
  if (!result.applied) {
    lines.push(`# Integration of ${ticket.id} aborted: nothing was written`);
    for (const conflict of result.conflicts) {
      lines.push(`- CONFLICT ${conflict.path}: ${conflict.reason}`);
    }
    lines.push(
      "Options: resolve by hand from the worktree, send the ticket back with instructions to adapt to your changes,",
      `or rerun with \`--allow-conflicts\` to write conflict markers into your checkout.`
    );
    return `${lines.join("\n")}\n`;
  }
  const written = result.files.filter((file) => file.action !== "unchanged");
  lines.push(`# Integrated ${ticket.id}: ${written.length} file(s) applied to your checkout (index untouched)`);
  for (const file of written) {
    lines.push(`- ${file.action === "delete" ? "deleted" : file.status === "merged" ? "merged" : file.status === "conflict" ? "CONFLICT MARKERS" : "written"} ${file.path}`);
  }
  lines.push(`Next: run combined validation, then \`node ${companion} close ${ticket.id} --accepted --reason "…"\`.`);
  return `${lines.join("\n")}\n`;
}

export function renderPreflight(report) {
  const lines = [`# Codex sandbox preflight (${report.policy.type}${report.policy.networkAccess ? ", network" : ", offline"})`];
  const tools = Object.entries(report.sandbox?.tools ?? {});
  if (tools.length) {
    const available = tools.filter(([, version]) => version).map(([tool]) => tool);
    const missing = tools.filter(([, version]) => !version).map(([tool]) => tool);
    lines.push(`Tools runnable in sandbox: ${available.join(", ") || "none"}`);
    if (missing.length) {
      lines.push(`Not available: ${missing.join(", ")}`);
    }
  }
  lines.push(`Write workdir: ${report.sandbox?.write ? "yes" : "no"} · write .git: ${report.sandbox?.gitWrite ? "yes" : "no"} · network: ${report.sandbox?.network ? "yes" : "no"}${report.sandbox?.dockerDaemon == null ? "" : ` · docker daemon: ${report.sandbox.dockerDaemon ? "yes" : "no"}`}`);
  for (const limitation of report.limitations) {
    lines.push(`Limitation: ${limitation}`);
  }
  for (const check of report.checks ?? []) {
    lines.push(`Check ${check.exitCode === 0 ? "PASS" : "FAIL"} \`${check.command}\` (exit ${check.exitCode ?? "?"})`);
    if (check.exitCode !== 0 && check.outputTail) {
      lines.push("```text", check.outputTail.trim().split("\n").slice(-20).join("\n"), "```");
    }
  }
  lines.push("Route to Claude, not Codex: anything needing what is listed as unavailable here.");
  return `${lines.join("\n")}\n`;
}
