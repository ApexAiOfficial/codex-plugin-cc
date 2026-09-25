import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  compileOwnership,
  crossCheckVerificationClaims,
  normalizeRepoPath,
  reportedPathsRelativeTo
} from "../plugins/codex/scripts/lib/evidence.mjs";
import { buildSandboxPolicy, summarizeLimitations } from "../plugins/codex/scripts/lib/capabilities.mjs";
import { deriveTicketId, validateTicketId } from "../plugins/codex/scripts/lib/tickets.mjs";
import { classifyTurnFailure, parseWorkReport } from "../plugins/codex/scripts/lib/work-package.mjs";

function report(overrides = {}) {
  return {
    status: "completed",
    summary: "Work complete.",
    changes: [],
    verification: [],
    findings: [],
    blockers: [],
    risks: [],
    next_steps: [],
    ...overrides
  };
}

// ------------------------------------------------------------------------------------------
// Evidence

test("normalizeRepoPath canonicalizes report and ownership path syntax", () => {
  assert.equal(normalizeRepoPath("./src\\nested\\file.js///"), "src/nested/file.js");
  assert.equal(normalizeRepoPath(".\\tests\\unit.test.mjs/"), "tests/unit.test.mjs");
  assert.equal(normalizeRepoPath("README.md"), "README.md");
  assert.equal(normalizeRepoPath(null), "");
});

test("compileOwnership gives plain paths exact and subtree ownership", () => {
  const owns = compileOwnership(["./src/a/", "docs\\guide"]);

  assert.equal(owns("src/a"), true);
  assert.equal(owns("src/a/index.js"), true);
  assert.equal(owns(".\\src\\a\\nested\\index.js"), true);
  assert.equal(owns("docs/guide/intro.md"), true);
  assert.equal(owns("src/ab.js"), false, "a sibling with the same text prefix is not a subtree");
  assert.equal(owns("src/a-other/index.js"), false);
  assert.equal(owns("docs/guidelines.md"), false);
});

test("compileOwnership implements *, **, **/ and ? glob semantics", () => {
  const directJavaScript = compileOwnership(["src/*.js"]);
  assert.equal(directJavaScript("src/app.js"), true);
  assert.equal(directJavaScript("src/app.mjs"), false);
  assert.equal(directJavaScript("src/nested/app.js"), false, "* must not cross a slash");

  const recursiveAssets = compileOwnership(["assets/**"]);
  assert.equal(recursiveAssets("assets/logo.svg"), true);
  assert.equal(recursiveAssets("assets/icons/dark/logo.svg"), true);
  assert.equal(recursiveAssets("other/assets/logo.svg"), false);

  const testsAtAnyDepth = compileOwnership(["src/**/test?.mjs"]);
  assert.equal(testsAtAnyDepth("src/test1.mjs"), true, "**/ may match no directory");
  assert.equal(testsAtAnyDepth("src/nested/deep/testA.mjs"), true);
  assert.equal(testsAtAnyDepth("src/nested/test10.mjs"), false, "? matches exactly one non-slash character");
  assert.equal(testsAtAnyDepth("src/nested/deep/test/.mjs"), false, "? must not cross a slash");

  const trailingGlobSlash = compileOwnership(["generated/**/"]);
  assert.equal(trailingGlobSlash("generated/output.js"), true);
  assert.equal(trailingGlobSlash("generated/nested/output.js"), true);
});

test("compileOwnership handles empty pattern lists", () => {
  assert.equal(compileOwnership()("src/app.js"), false);
  assert.equal(compileOwnership(["", "./"])("src/app.js"), false);
});

test("reportedPathsRelativeTo maps paths, move targets, and paths outside the workdir", () => {
  const workdir = path.resolve("fixture-workdir");
  const absoluteInside = path.join(workdir, "src", "absolute.js");
  const absoluteOutside = path.resolve(workdir, "..", "outside-absolute.js");
  const fileChanges = [
    {
      changes: [
        { path: "./src/relative.js" },
        { path: absoluteInside },
        { path: "src\\windows.js" },
        { path: "src/old.js", kind: { type: "move", move_path: "src/new.js" } },
        { path: "../outside-relative.js" },
        { path: absoluteOutside },
        { path: "./src/relative.js" },
        { path: null, kind: { move_path: "" } }
      ]
    },
    {}
  ];

  assert.deepEqual(
    reportedPathsRelativeTo(workdir, fileChanges),
    [
      "../outside-relative.js",
      normalizeRepoPath(absoluteOutside),
      "src/absolute.js",
      "src/new.js",
      "src/old.js",
      "src/relative.js",
      "src/windows.js"
    ].sort()
  );
  assert.deepEqual(reportedPathsRelativeTo(workdir), []);
});

test("crossCheckVerificationClaims classifies observed results and ignores not_run claims", () => {
  const claims = crossCheckVerificationClaims(
    {
      verification: [
        { command: "npm test", outcome: "passed" },
        { command: "npm run lint", outcome: "failed" },
        { command: "npm run build", outcome: "passed" },
        { command: "node --test tests/missing.test.mjs", outcome: "passed" },
        { command: "npm run skipped", outcome: "not_run" }
      ]
    },
    [
      { command: "/bin/bash -lc 'npm test'", exitCode: 0 },
      { command: "sh -c `npm run lint`", exitCode: 1 },
      { command: "npm run build", exitCode: 2 },
      { command: "npm run skipped", exitCode: 0 }
    ]
  );

  assert.deepEqual(claims, [
    { command: "npm test", claimed: "passed", observation: "consistent", observedExitCode: 0 },
    { command: "npm run lint", claimed: "failed", observation: "consistent", observedExitCode: 1 },
    { command: "npm run build", claimed: "passed", observation: "contradicted", observedExitCode: 2 },
    {
      command: "node --test tests/missing.test.mjs",
      claimed: "passed",
      observation: "not-observed",
      observedExitCode: null
    }
  ]);
});

test("crossCheckVerificationClaims accepts truthful claims about earlier failing runs of a rerun command", () => {
  // Found while dogfooding: Codex reported a failing first run and a passing rerun of the same
  // command; judging every claim against only the last run flagged the honest "failed" claim.
  const claims = crossCheckVerificationClaims(
    {
      verification: [
        { command: "node --test tests/a.test.mjs", outcome: "failed" },
        { command: "node --test tests/a.test.mjs", outcome: "passed" }
      ]
    },
    [
      { command: "/bin/bash -lc 'node --test tests/a.test.mjs'", exitCode: 1 },
      { command: "/bin/bash -lc 'node --test tests/a.test.mjs'", exitCode: 0 }
    ]
  );
  assert.deepEqual(claims.map((claim) => [claim.claimed, claim.observation, claim.observedExitCode]), [
    ["failed", "consistent", 1],
    ["passed", "consistent", 0]
  ]);
});

test("crossCheckVerificationClaims handles absent reports and command logs", () => {
  assert.deepEqual(crossCheckVerificationClaims(null, null), []);
  assert.deepEqual(
    crossCheckVerificationClaims({ verification: [{ command: "npm test", outcome: "failed" }] }),
    [{ command: "npm test", claimed: "failed", observation: "not-observed", observedExitCode: null }]
  );
});

// ------------------------------------------------------------------------------------------
// Work reports and turn failures

test("parseWorkReport normalizes a valid report", () => {
  const parsed = parseWorkReport(
    JSON.stringify(
      report({
        summary: "  Finished cleanly.  ",
        changes: [{ path: " tests/a.test.mjs ", description: " added coverage " }],
        verification: [{ command: " node --test ", outcome: "passed", detail: " all green " }],
        findings: [{ title: " note ", detail: " detail ", evidence: " file:1 ", confidence: 0.9 }],
        blockers: [{ kind: "dependency", detail: " package absent ", needed_from_lead: " install it " }],
        risks: ["  first risk  ", "", null],
        next_steps: ["  merge it  "]
      })
    )
  );

  assert.equal(parsed.parseError, null);
  assert.deepEqual(parsed.report, {
    status: "completed",
    summary: "Finished cleanly.",
    changes: [{ path: "tests/a.test.mjs", description: "added coverage" }],
    verification: [{ command: "node --test", outcome: "passed", detail: "all green" }],
    findings: [{ title: "note", detail: "detail", evidence: "file:1", confidence: 0.9 }],
    blockers: [{ kind: "dependency", detail: "package absent", neededFromLead: "install it" }],
    risks: ["first risk"],
    nextSteps: ["merge it"]
  });
});

test("parseWorkReport distinguishes non-JSON from JSON that is not a report", () => {
  const nonJson = parseWorkReport("completion: yes");
  assert.equal(nonJson.report, null);
  assert.match(nonJson.parseError, /^Final message is not JSON:/);

  for (const value of [null, [], { status: "done" }, { status: 3 }]) {
    assert.deepEqual(parseWorkReport(JSON.stringify(value)), {
      report: null,
      parseError: "Final message JSON does not look like a work report."
    });
  }
});

test("parseWorkReport supplies empty arrays and normalizes invalid verification outcomes", () => {
  const missingArrays = parseWorkReport(JSON.stringify({ status: "partial", summary: "Still working." }));
  assert.deepEqual(missingArrays.report, {
    status: "partial",
    summary: "Still working.",
    changes: [],
    verification: [],
    findings: [],
    blockers: [],
    risks: [],
    nextSteps: []
  });

  const invalidOutcome = parseWorkReport(
    JSON.stringify(report({ verification: [{ command: "npm test", outcome: "unknown", detail: "ambiguous" }] }))
  );
  assert.equal(invalidOutcome.report.verification[0].outcome, "not_run");
});

test(
  "parseWorkReport normalizes invalid blocker kinds",
  () => {
    const parsed = parseWorkReport(
      JSON.stringify(report({ blockers: [{ kind: "environment", detail: "offline", needed_from_lead: "network" }] }))
    );
    assert.equal(parsed.report.blockers[0].kind, "other");
  }
);

test("classifyTurnFailure maps string codexErrorInfo variants", () => {
  const cases = [
    ["usageLimitExceeded", "quota"],
    ["sessionBudgetExceeded", "quota"],
    ["serverOverloaded", "transient"],
    ["internalServerError", "transient"],
    ["httpConnectionFailed", "transient"],
    ["responseStreamConnectionFailed", "transient"],
    ["responseStreamDisconnected", "transient"],
    ["responseTooManyFailedAttempts", "transient"],
    ["contextWindowExceeded", "context-window"],
    ["unauthorized", "auth"],
    ["sandboxError", "sandbox"],
    ["futureErrorVariant", "error"]
  ];

  for (const [codexErrorInfo, expected] of cases) {
    assert.equal(classifyTurnFailure({ codexErrorInfo }), expected, codexErrorInfo);
  }
});

test("classifyTurnFailure maps object variants and handles missing errors", () => {
  assert.equal(classifyTurnFailure({ codexErrorInfo: { usageLimitExceeded: { resetsAt: 123 } } }), "quota");
  assert.equal(classifyTurnFailure({ codexErrorInfo: { serverOverloaded: null } }), "transient");
  assert.equal(classifyTurnFailure({ codexErrorInfo: { unauthorized: {} } }), "auth");
  assert.equal(classifyTurnFailure({ codexErrorInfo: { somethingNew: {} } }), "error");
  assert.equal(classifyTurnFailure({}), "error");
  assert.equal(classifyTurnFailure(null), null);
  assert.equal(classifyTurnFailure(undefined), null);
});

// ------------------------------------------------------------------------------------------
// Capabilities

test("buildSandboxPolicy constructs writable and read-only policies", () => {
  const workdir = path.join("relative", "workspace");
  assert.deepEqual(buildSandboxPolicy({ workdir, write: true, network: 1 }), {
    type: "workspaceWrite",
    writableRoots: [path.resolve(workdir)],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  });
  assert.deepEqual(buildSandboxPolicy({ workdir, write: false, network: 0 }), {
    type: "readOnly",
    networkAccess: false
  });
});

test("summarizeLimitations reports sandbox-only capability gaps", () => {
  const host = {
    network: true,
    dockerDaemon: true,
    tools: { node: "v22", docker: "27.0", missingEverywhere: null, git: "2.45" }
  };
  const sandbox = {
    write: false,
    network: false,
    dockerDaemon: false,
    tools: { node: "v22", docker: null }
  };

  assert.deepEqual(summarizeLimitations(host, sandbox, { type: "workspaceWrite" }), [
    "Writing to the working directory failed inside the sandbox.",
    "Network is unavailable in the sandbox (the host has it).",
    "The Docker daemon is not reachable from the sandbox, so container-based tests and services cannot run there.",
    "Tools present on the host but not runnable in the sandbox: docker, git."
  ]);
});

test("summarizeLimitations distinguishes machine-wide network loss and missing probes", () => {
  assert.deepEqual(
    summarizeLimitations(
      { network: false, dockerDaemon: false, tools: { node: "v22" } },
      { write: true, network: false, dockerDaemon: false, tools: { node: "v22" } },
      { type: "workspaceWrite" }
    ),
    ["Network is unavailable on this machine."]
  );
  assert.deepEqual(summarizeLimitations({}, null, { type: "readOnly" }), [
    "The sandbox probe did not return a result; treat the Codex environment as unverified."
  ]);
  assert.deepEqual(
    summarizeLimitations(
      { network: true, dockerDaemon: true, tools: { node: "v22" } },
      { write: true, network: true, dockerDaemon: true, tools: { node: "v22" } },
      { type: "workspaceWrite" }
    ),
    []
  );
});

// ------------------------------------------------------------------------------------------
// Ticket IDs

test("validateTicketId accepts the documented alphabet and length boundary", () => {
  for (const id of ["a", "0", "feature-1.2_unit", "a".repeat(48)]) {
    assert.equal(validateTicketId(id), id);
  }
});

test("validateTicketId rejects malformed string IDs", () => {
  for (const id of ["", "UPPER", "-leading", ".leading", "has space", "slash/name", "a".repeat(49)]) {
    assert.throws(() => validateTicketId(id), /Invalid ticket name/, id);
  }
});

test(
  "validateTicketId rejects non-string IDs",
  () => {
    for (const id of [null, undefined, 123]) {
      assert.throws(() => validateTicketId(id), /Invalid ticket name/, String(id));
    }
  }
);

test("deriveTicketId builds a normalized, valid slug with a random suffix", () => {
  const id = deriveTicketId("The <b>Quick</b> fix, with APIs into production and later words");
  assert.match(id, /^quick-fix-apis-production-[0-9a-f]{4}$/);
  assert.equal(validateTicketId(id), id);

  const fallback = deriveTicketId("the and for !!");
  assert.match(fallback, /^ticket-[0-9a-f]{4}$/);

  const long = deriveTicketId("a".repeat(60));
  assert.match(long, new RegExp(`^${"a".repeat(36)}-[0-9a-f]{4}$`));
  assert.ok(long.length <= 48);
});

test(
  "deriveTicketId always returns an ID accepted by validateTicketId",
  () => {
    assert.doesNotThrow(() => validateTicketId(deriveTicketId("-leading punctuation fix")));
  }
);

test("model choices are validated against the discovered catalog", async () => {
  const { validateModelChoice } = await import("../plugins/codex/scripts/lib/models.mjs");
  const catalog = {
    configured: { model: "sol", effort: "high" },
    models: [
      { id: "astra", isDefault: true, hidden: false, efforts: ["low", "high", "ultra"] },
      { id: "sol", isDefault: false, hidden: false, efforts: ["low", "high"] },
      { id: "secret", isDefault: false, hidden: true, efforts: ["low"] }
    ]
  };
  assert.equal(validateModelChoice(catalog, {}), null);
  assert.equal(validateModelChoice(null, { model: "anything" }), null, "unchecked when discovery is unavailable");
  assert.equal(validateModelChoice(catalog, { model: "astra", effort: "ultra" }), null);
  assert.equal(validateModelChoice(catalog, { model: "secret" }), null, "a hidden model is still valid");
  assert.match(validateModelChoice(catalog, { model: "nope" }), /does not offer model "nope".*Available: astra, sol\./);
  // An effort alone is checked against the configured model, not the account default.
  assert.match(validateModelChoice(catalog, { effort: "ultra" }), /Model sol does not support effort "ultra"/);
  assert.equal(validateModelChoice({ ...catalog, configured: { model: null } }, { effort: "ultra" }), null);
});

// Regression (review-today turn 3): a failed confirmation of a delivered notification was dropped
// silently, so the pending claim lapsed when the watcher exited and the turn was announced again.
// Settlement now reports failure, and the watcher retries it while it lives.
test("a failed notification confirmation is reported for retry, then confirmed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const fs = (await import("node:fs")).default;
  const { makeTempDir } = await import("./helpers.mjs");
  const { readJobFile, resolveJobFile, resolveJobsDir, writeJobFile } = await import("../plugins/codex/scripts/lib/state.mjs");
  const { getProcessStartMarker } = await import("../plugins/codex/scripts/lib/process.mjs");
  const { isTurnNotified, settleTurnNotification } = await import("../plugins/codex/scripts/lib/ticket-commands.mjs");
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    const workspace = makeTempDir();
    const pending = { pid: process.pid, marker: getProcessStartMarker(process.pid) };
    writeJobFile(workspace, "job-1", { id: "job-1", status: "completed", notifiedAt: new Date().toISOString(), notifyPending: pending });
    const jobs = resolveJobsDir(workspace);
    fs.chmodSync(jobs, 0o555);
    try {
      assert.equal(settleTurnNotification(workspace, "job-1", true), false, "the failed write is reported, not swallowed");
    } finally {
      fs.chmodSync(jobs, 0o755);
    }
    assert.deepEqual(readJobFile(resolveJobFile(workspace, "job-1")).notifyPending, pending, "still pending, so it can be retried");
    assert.equal(settleTurnNotification(workspace, "job-1", true), true);
    const settled = readJobFile(resolveJobFile(workspace, "job-1"));
    assert.equal(settled.notifyPending, undefined);
    assert.equal(isTurnNotified(settled), true, "confirmed deliveries stay notified after the watcher exits");
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});
