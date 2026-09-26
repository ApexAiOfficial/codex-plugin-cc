import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function installFakeCodex(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const scriptPath = path.join(binDir, "codex");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const readline = require("node:readline");

	const STATE_PATH = ${JSON.stringify(statePath)};
	const BEHAVIOR = ${JSON.stringify(behavior)};
	const interruptibleTurns = new Map();

	function loadState() {
	  if (!fs.existsSync(STATE_PATH)) {
	    return { nextThreadId: 1, nextTurnId: 1, appServerStarts: 0, threads: [], capabilities: null, lastInterrupt: null };
	  }
	  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
	}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function requiresExperimental(field, message, state) {
  if (!(field in (message.params || {}))) {
    return false;
  }
  return !state.capabilities || state.capabilities.experimentalApi !== true;
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: thread.preview || "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    path: null,
    cwd: thread.cwd,
    cliVersion: "fake-codex",
    source: "appServer",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress", error = null) {
  return { id, status, items: [], error };
}

function buildAccountReadResult() {
  switch (BEHAVIOR) {
    case "logged-out":
    case "refreshable-auth":
    case "auth-run-fails":
      return { account: null, requiresOpenaiAuth: true };
    case "provider-no-auth":
    case "env-key-provider":
      return { account: null, requiresOpenaiAuth: false };
    case "api-key-account-only":
      return { account: { type: "apiKey" }, requiresOpenaiAuth: true };
    default:
      return {
        account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
        requiresOpenaiAuth: true
      };
  }
}

function buildConfigReadResult() {
  switch (BEHAVIOR) {
    case "provider-no-auth":
      return {
        config: { model_provider: "ollama" },
        origins: {}
      };
    case "env-key-provider":
      return {
        config: {
          model_provider: "openai-custom",
          model_providers: {
            "openai-custom": {
              name: "OpenAI custom",
              env_key: "OPENAI_API_KEY",
              requires_openai_auth: false
            }
          }
        },
        origins: {}
      };
    default:
      return {
        config: { model_provider: "openai" },
        origins: {}
      };
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    preview: "",
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((candidate) => candidate.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function importLedgerPath() {
  return path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "external_agent_session_imports.json");
}

function loadImportLedger() {
  const ledgerPath = importLedgerPath();
  return fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, "utf8")) : { records: [] };
}

function saveImportLedger(ledger) {
  const ledgerPath = importLedgerPath();
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
}

function emitTurnCompleted(threadId, turnId, item) {
  const items = Array.isArray(item) ? item : [item];
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const entry of items) {
    if (entry && entry.started) {
      send({ method: "item/started", params: { threadId, turnId, item: entry.started } });
    }
    if (entry && entry.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: entry.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, "completed") } });
}

function emitTurnCompletedLater(threadId, turnId, item, delayMs) {
  setTimeout(() => {
    emitTurnCompleted(threadId, turnId, item);
  }, delayMs);
}

function nativeReviewText(target) {
  if (target.type === "baseBranch") {
    return "Reviewed changes against " + target.branch + ".\\nNo material issues found.";
  }
  if (target.type === "custom") {
    return "Reviewed custom target.\\nNo material issues found.";
  }
  return "Reviewed uncommitted changes.\\nNo material issues found.";
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({
        verdict: "approve",
        summary: "No material issues found.",
        findings: [],
        next_steps: []
      });
    }

    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resume) {
  if (prompt.includes("<task>") && prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (resume || prompt.includes("Continue from the current thread state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

function parseWorkDirectives(prompt) {
  const directives = { writes: [], runs: [], claims: [], blockers: [], status: "completed", slow: false };
  for (const rawLine of prompt.split("\\n")) {
    const line = rawLine.trim();
    let match;
    if ((match = /^FAKE_WRITE (\\S+) (.*)$/.exec(line))) {
      directives.writes.push({ path: match[1], content: match[2].replace(/\\\\n/g, "\\n") });
    } else if ((match = /^FAKE_RUN (-?\\d+) (.+)$/.exec(line))) {
      directives.runs.push({ exitCode: Number(match[1]), command: match[2] });
    } else if ((match = /^FAKE_CLAIM (passed|failed|not_run) (.+)$/.exec(line))) {
      directives.claims.push({ outcome: match[1], command: match[2] });
    } else if ((match = /^FAKE_BLOCKER (\\S+) (.+)$/.exec(line))) {
      directives.blockers.push({ kind: match[1], detail: match[2], needed_from_lead: "Provide " + match[2] });
    } else if ((match = /^FAKE_STATUS (\\S+)$/.exec(line))) {
      directives.status = match[1];
    } else if (line === "FAKE_SLOW") {
      directives.slow = true;
    } else if (line === "FAKE_TURN_FAIL") {
      directives.turnFail = true;
    }
  }
  return directives;
}

function runWorkTurn(state, thread, turnId, prompt) {
  const directives = parseWorkDirectives(prompt);
  const cwd = thread.cwd || process.cwd();
  const items = [];
  directives.writes.forEach((write, index) => {
    const absolute = path.resolve(cwd, write.path);
    const existed = fs.existsSync(absolute);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, write.content);
    items.push({
      completed: {
        type: "fileChange",
        id: "fc_" + turnId + "_" + index,
        changes: [{ path: absolute, kind: existed ? { type: "update", move_path: null } : { type: "add" }, diff: "" }],
        status: "completed"
      }
    });
  });
  directives.runs.forEach((run, index) => {
    items.push({
      completed: {
        type: "commandExecution",
        id: "cmd_" + turnId + "_" + index,
        command: "/bin/bash -lc '" + run.command + "'",
        cwd,
        processId: null,
        source: "agent",
        status: run.exitCode === 0 ? "completed" : "failed",
        commandActions: [],
        aggregatedOutput: "output of " + run.command + "\\n",
        exitCode: run.exitCode,
        durationMs: 5
      }
    });
  });
  const buildReport = (steerText) => JSON.stringify({
    status: directives.status,
    summary: "Fake work turn changed " + directives.writes.length + " file(s)." + (steerText ? " Steered: " + steerText : ""),
    changes: directives.writes.map((write) => ({ path: write.path, description: "wrote " + write.path })),
    verification: directives.claims.map((claim) => ({ command: claim.command, outcome: claim.outcome, detail: "" })),
    findings: [],
    blockers: directives.blockers,
    risks: [],
    next_steps: []
  });
  return { items, directives, buildReport };
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (BEHAVIOR === "logged-out" || BEHAVIOR === "refreshable-auth" || BEHAVIOR === "auth-run-fails" || BEHAVIOR === "provider-no-auth" || BEHAVIOR === "env-key-provider" || BEHAVIOR === "api-key-account-only") {
    console.error("not authenticated");
    process.exit(1);
  }
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "login") {
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}
const bootState = loadState();
bootState.appServerStarts = (bootState.appServerStarts || 0) + 1;
saveState(bootState);

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        state.capabilities = message.params.capabilities || null;
        saveState(state);
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;

      case "initialized":
        break;

      case "account/read":
        send({ id: message.id, result: buildAccountReadResult() });
        break;

      case "config/read":
        if (BEHAVIOR === "config-read-fails") {
          throw new Error("config/read failed for cwd");
        }
        send({ id: message.id, result: buildConfigReadResult() });
        break;

      case "thread/start": {
        if (BEHAVIOR === "auth-run-fails") {
          throw new Error("authentication expired; run codex login");
        }
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/start.persistFullHistory requires experimentalApi capability");
        }
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }

      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }

      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }

      case "thread/resume": {
        if (requiresExperimental("persistExtendedHistory", message, state) || requiresExperimental("persistFullHistory", message, state)) {
          throw new Error("thread/resume.persistFullHistory requires experimentalApi capability");
        }
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        if (message.params.cwd) {
          thread.cwd = message.params.cwd;
        }
        saveState(state);
        send({ id: message.id, result: { thread: buildThread(thread), model: message.params.model || "gpt-5.4", modelProvider: "openai", serviceTier: null, cwd: thread.cwd, approvalPolicy: "never", sandbox: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false }, reasoningEffort: null } });
        break;
      }

      case "command/exec": {
        const argv = message.params.command || [];
        state.commandExecs = (state.commandExecs || []).concat([{ command: argv, cwd: message.params.cwd || null, sandboxPolicy: message.params.sandboxPolicy || null }]);
        saveState(state);
        if (argv.includes("codex-preflight-probe")) {
          const policy = message.params.sandboxPolicy || {};
          send({
            id: message.id,
            result: {
              exitCode: 0,
              stdout: JSON.stringify({
                tools: { node: "v-fake", git: "git version fake", docker: BEHAVIOR === "sandbox-no-docker" ? "Docker fake" : null },
                write: policy.type === "workspaceWrite",
                gitWrite: false,
                dockerDaemon: BEHAVIOR === "sandbox-no-docker" ? false : null,
                network: Boolean(policy.networkAccess)
              }),
              stderr: ""
            }
          });
          break;
        }
        const { spawnSync } = require("node:child_process");
        const result = spawnSync(argv[0], argv.slice(1), { cwd: message.params.cwd || process.cwd(), encoding: "utf8" });
        send({ id: message.id, result: { exitCode: result.status ?? 1, stdout: result.stdout || "", stderr: result.stderr || "" } });
        break;
      }

      case "turn/steer": {
        const pending = interruptibleTurns.get(message.params.expectedTurnId);
        const text = (message.params.input || []).filter((item) => item.type === "text").map((item) => item.text).join("\\n");
        state.lastSteer = { threadId: message.params.threadId, turnId: message.params.expectedTurnId, text };
        saveState(state);
        if (!pending) {
          send({ id: message.id, error: { code: -32000, message: "no active turn to steer" } });
          break;
        }
        send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
        if (pending.finish) {
          clearTimeout(pending.timer);
          interruptibleTurns.delete(message.params.expectedTurnId);
          pending.finish(text);
        }
        break;
      }

      case "externalAgentConfig/import": {
        if (BEHAVIOR === "external-import-unsupported") {
          send({ id: message.id, error: { code: -32601, message: "Unsupported method: externalAgentConfig/import" } });
          break;
        }
        if (BEHAVIOR === "external-import-fails") {
          send({ id: message.id, result: {} });
          send({ method: "externalAgentConfig/import/completed", params: {} });
          break;
        }
        const sessions = (message.params.migrationItems || [])
          .flatMap((item) => item.details && Array.isArray(item.details.sessions) ? item.details.sessions : []);
        const session = sessions[0];
        if (!session) {
          throw new Error("missing external session migration");
        }
        const sourcePath = fs.realpathSync(session.path);
        const contents = fs.readFileSync(sourcePath, "utf8");
        const contentSha256 = crypto.createHash("sha256").update(contents).digest("hex");
        const ledger = loadImportLedger();
        let record = ledger.records.find(
          (candidate) => candidate.source_path === sourcePath && candidate.content_sha256 === contentSha256
        );
        let thread;
        if (record) {
          thread = ensureThread(state, record.imported_thread_id);
        } else {
          const records = contents.split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
          const title = records.find((entry) => entry.type === "custom-title")?.customTitle || null;
          const messages = records
            .filter((entry) => entry.type === "user" || entry.type === "assistant")
            .map((entry) => ({ role: entry.type, text: entry.message?.content || "" }));
          thread = nextThread(state, session.cwd, false);
          thread.name = title;
          thread.preview = messages.find((entry) => entry.role === "user")?.text || "";
          thread.visibleMessages = messages;
          state.lastExternalAgentImport = { sourcePath, threadId: thread.id, messages };
          record = {
            source_path: sourcePath,
            content_sha256: contentSha256,
            imported_thread_id: thread.id,
            imported_at: now(),
            source_modified_at: null
          };
          ledger.records.push(record);
          saveState(state);
          saveImportLedger(ledger);
        }
        send({ id: message.id, result: {} });
        send({ method: "externalAgentConfig/import/completed", params: {} });
        break;
      }

      case "review/start": {
        const thread = ensureThread(state, message.params.threadId);
        let reviewThread = thread;
        if (message.params.delivery === "detached") {
          reviewThread = nextThread(state, thread.cwd, true);
          send({ method: "thread/started", params: { thread: { id: reviewThread.id } } });
        }
        const turnId = nextTurnId(state);
        send({ id: message.id, result: { turn: buildTurn(turnId), reviewThreadId: reviewThread.id } });
        emitTurnCompleted(reviewThread.id, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Reviewed the changed files and checked the likely regression paths." }],
                    content: []
                  }
                }
              ]
            : []),
          {
            completed: { type: "exitedReviewMode", id: turnId, review: nativeReviewText(message.params.target) }
          }
        ]);
        break;
      }

	      case "turn/start": {
	        const thread = ensureThread(state, message.params.threadId);
	        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        const turnId = nextTurnId(state);
        thread.updatedAt = now();
	        state.lastTurnStart = {
	          threadId: message.params.threadId,
	          turnId,
	          model: message.params.model ?? null,
	          effort: message.params.effort ?? null,
	          sandboxPolicy: message.params.sandboxPolicy ?? null,
	          cwd: thread.cwd,
	          prompt
	        };
	        state.turnStarts = (state.turnStarts || []).concat([{ threadId: message.params.threadId, turnId, cwd: thread.cwd, prompt }]);
	        saveState(state);
	        send({ id: message.id, result: { turn: buildTurn(turnId) } });

        if (BEHAVIOR === "failed-turn") {
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "agentMessage",
                id: "msg_" + turnId,
                text: JSON.stringify({ error: { message: "request could not be completed" } }, null, 2),
                phase: "final_answer"
              }
            }
          });
          send({
            method: "turn/completed",
            params: {
              threadId: thread.id,
              turn: buildTurn(turnId, "failed", {
                message: "usage limit reached",
                codexErrorInfo: "usageLimitExceeded",
                additionalDetails: null
              })
            }
          });
          break;
        }

        const outputProperties = message.params.outputSchema && message.params.outputSchema.properties;
        if (outputProperties && outputProperties.blockers) {
          const work = runWorkTurn(state, thread, turnId, prompt);
          const complete = (steerText) => {
            for (const entry of work.items) {
              send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
            }
            // Cumulative total far beyond the window; the active context (last) is 25% of it.
            send({ method: "thread/tokenUsage/updated", params: { threadId: thread.id, turnId, tokenUsage: {
              total: { totalTokens: 2000000, inputTokens: 1900000, cachedInputTokens: 1500000, cacheWriteInputTokens: 0, outputTokens: 100000, reasoningOutputTokens: 40000 },
              last: { totalTokens: 64600, inputTokens: 62000, cachedInputTokens: 50000, cacheWriteInputTokens: 0, outputTokens: 2600, reasoningOutputTokens: 900 },
              modelContextWindow: 258400
            } } });
            if (work.directives.turnFail) {
              send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "failed", { message: "usage limit reached", codexErrorInfo: "usageLimitExceeded", additionalDetails: null }) } });
              return;
            }
            send({ method: "item/completed", params: { threadId: thread.id, turnId, item: { type: "agentMessage", id: "msg_" + turnId, text: work.buildReport(steerText), phase: "final_answer" } } });
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          };
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          if (work.directives.slow) {
            const timer = setTimeout(() => {
              interruptibleTurns.delete(turnId);
              complete(null);
            }, 8000);
            interruptibleTurns.set(turnId, { threadId: thread.id, timer, finish: complete });
          } else {
            complete(null);
          }
          break;
        }

        const payload = message.params.outputSchema && message.params.outputSchema.properties && message.params.outputSchema.properties.verdict
          ? structuredReviewPayload(prompt)
          : taskPayload(prompt, thread.name && thread.name.startsWith("Codex Companion Task") && prompt.includes("Continue from the current thread state"));

        if (
          BEHAVIOR === "with-subagent" ||
          BEHAVIOR === "with-late-subagent-message" ||
          BEHAVIOR === "with-subagent-no-main-turn-completed"
        ) {
          const subThread = nextThread(state, thread.cwd, true);
          const subThreadRecord = ensureThread(state, subThread.id);
          subThreadRecord.name = "design-challenger";
          saveState(state);
          const subTurnId = nextTurnId(state);

          send({ method: "thread/started", params: { thread: { ...buildThread(subThreadRecord), name: "design-challenger", agentNickname: "design-challenger" } } });
          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
          send({
            method: "item/started",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "inProgress",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "inProgress", message: "Investigating design tradeoffs" }
                }
              }
            }
          });
          if (BEHAVIOR === "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          send({ method: "turn/started", params: { threadId: subThread.id, turn: buildTurn(subTurnId) } });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "reasoning",
                id: "reasoning_" + subTurnId,
                summary: [{ text: "Questioned the retry strategy and the cache invalidation boundaries." }],
                content: []
              }
            }
          });
          send({
            method: "item/completed",
            params: {
              threadId: subThread.id,
              turnId: subTurnId,
              item: {
                type: "agentMessage",
                id: "msg_" + subTurnId,
                text: "The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees.",
                phase: "analysis"
              }
            }
          });
          send({ method: "turn/completed", params: { threadId: subThread.id, turn: buildTurn(subTurnId, "completed") } });
          send({
            method: "item/completed",
            params: {
              threadId: thread.id,
              turnId,
              item: {
                type: "collabAgentToolCall",
                id: "collab_" + turnId,
                tool: "wait",
                status: "completed",
                senderThreadId: thread.id,
                receiverThreadIds: [subThread.id],
                prompt: "Challenge the implementation approach",
                model: null,
                reasoningEffort: null,
                agentsStates: {
                  [subThread.id]: { status: "completed", message: "Finished" }
                }
              }
            }
          });
          if (BEHAVIOR !== "with-late-subagent-message") {
            send({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId,
                item: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
              }
            });
          }
          if (BEHAVIOR !== "with-subagent-no-main-turn-completed") {
            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
          }
          break;
        }

        const items = [
          ...(BEHAVIOR === "with-reasoning"
            ? [
                {
                  completed: {
                    type: "reasoning",
                    id: "reasoning_" + turnId,
                    summary: [{ text: "Inspected the prompt, gathered evidence, and checked the highest-risk paths first." }],
                    content: []
                  }
              }
            ]
            : []),
          {
            completed: { type: "agentMessage", id: "msg_" + turnId, text: payload, phase: "final_answer" }
          }
        ];

	        if (BEHAVIOR === "interruptible-slow-task") {
	          send({ method: "turn/started", params: { threadId: thread.id, turn: buildTurn(turnId) } });
	          const timer = setTimeout(() => {
	            if (!interruptibleTurns.has(turnId)) {
	              return;
	            }
	            interruptibleTurns.delete(turnId);
	            for (const entry of items) {
	              if (entry && entry.completed) {
	                send({ method: "item/completed", params: { threadId: thread.id, turnId, item: entry.completed } });
	              }
	            }
	            send({ method: "turn/completed", params: { threadId: thread.id, turn: buildTurn(turnId, "completed") } });
	          }, 5000);
	          interruptibleTurns.set(turnId, { threadId: thread.id, timer });
	        } else if (BEHAVIOR === "slow-task") {
	          emitTurnCompletedLater(thread.id, turnId, items, 400);
	        } else {
	          emitTurnCompleted(thread.id, turnId, items);
	        }
	        break;
	      }

	      case "turn/interrupt": {
	        state.lastInterrupt = {
	          threadId: message.params.threadId,
	          turnId: message.params.turnId
	        };
	        saveState(state);
	        const pending = interruptibleTurns.get(message.params.turnId);
	        if (pending) {
	          clearTimeout(pending.timer);
	          interruptibleTurns.delete(message.params.turnId);
	          send({
	            method: "turn/completed",
	            params: {
	              threadId: pending.threadId,
	              turn: buildTurn(message.params.turnId, "interrupted")
	            }
	          });
	        }
	        send({ id: message.id, result: {} });
	        break;
	      }

	      case "account/rateLimits/read":
	        if (BEHAVIOR === "rate-limits-unsupported") {
	          send({ id: message.id, error: { code: -32601, message: "Unsupported method: account/rateLimits/read" } });
	          break;
	        }
	        send({ id: message.id, result: { accountId: "acct-fake", ordinaryUsageAllowed: true, rateLimitResetCredits: null, rateLimitUpsell: null,
	          rateLimits: { limitId: "codex", limitName: null, normalModelSlug: null, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 4102444800 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 4102444800 }, credits: null, individualLimit: null, spendControlReached: null, planType: "plus", rateLimitReachedType: null },
	          rateLimitsByLimitId: {
	            codex: { limitId: "codex", limitName: null, normalModelSlug: null, primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 4102444800 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 4102444800 }, credits: null, individualLimit: null, spendControlReached: null, planType: "plus", rateLimitReachedType: null },
	            codex_other: { limitId: "codex_other", limitName: "Other", normalModelSlug: "fake-frontier", primary: { usedPercent: 5, windowDurationMins: 30, resetsAt: 4102444800 }, secondary: null, credits: null, individualLimit: null, spendControlReached: null, planType: "plus", rateLimitReachedType: null }
	          } } });
	        break;
	      case "model/list":
	        send({ id: message.id, result: { nextCursor: null, data: [
	          { id: "fake-frontier", model: "fake-frontier", description: "Fake default model.", isDefault: true, hidden: false, defaultReasoningEffort: "medium",
	            supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }] },
	          { id: "fake-hidden", model: "fake-hidden", description: "Fake hidden model.", isDefault: false, hidden: true, defaultReasoningEffort: "low",
	            supportedReasoningEfforts: [{ reasoningEffort: "low" }] }
	        ] } });
	        break;
	      default:
	        send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`;
  writeExecutable(scriptPath, source);

  // On Windows, npm global binaries are invoked via .cmd wrappers.
  // Create a codex.cmd so the fake binary is discoverable by spawn with shell: true.
  if (process.platform === "win32") {
    const cmdWrapper = `@echo off\r\nnode "%~dp0codex" %*\r\n`;
    fs.writeFileSync(path.join(binDir, "codex.cmd"), cmdWrapper, { encoding: "utf8" });
  }
}

export function buildEnv(binDir) {
  const sep = process.platform === "win32" ? ";" : ":";
  return {
    ...process.env,
    PATH: `${binDir}${sep}${process.env.PATH}`
  };
}
