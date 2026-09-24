import { randomBytes } from "node:crypto";
import fs from "node:fs";

import { buildTurnInput } from "./codex.mjs";
import { writeJsonAtomic } from "./locking.mjs";
import { resolveJobArtifactPath } from "./state.mjs";

const POLL_INTERVAL_MS = 400;

function inboxFile(workspaceRoot, jobId) {
  return resolveJobArtifactPath(workspaceRoot, jobId, ".inbox.jsonl");
}

function ackFile(workspaceRoot, jobId) {
  return resolveJobArtifactPath(workspaceRoot, jobId, ".inbox-ack.json");
}

function readInbox(workspaceRoot, jobId) {
  let raw = "";
  try {
    raw = fs.readFileSync(inboxFile(workspaceRoot, jobId), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((message) => message && typeof message.id === "string");
}

export function readControlAcks(workspaceRoot, jobId) {
  try {
    return JSON.parse(fs.readFileSync(ackFile(workspaceRoot, jobId), "utf8"));
  } catch {
    return {};
  }
}

/** Queue a control message for a running worker. Appends are atomic for these small lines. */
export function sendControlMessage(workspaceRoot, jobId, message) {
  const id = `msg-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  fs.appendFileSync(inboxFile(workspaceRoot, jobId), `${JSON.stringify({ id, at: new Date().toISOString(), ...message })}\n`, "utf8");
  return id;
}

export async function waitForControlAck(workspaceRoot, jobId, messageId, { timeoutMs = 15000, isJobActive = () => true } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ack = readControlAcks(workspaceRoot, jobId)[messageId];
    if (ack) {
      return ack;
    }
    if (!isJobActive()) {
      return readControlAcks(workspaceRoot, jobId)[messageId] ?? null;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

/**
 * Worker side: relay inbox messages into the live turn with turn/steer and turn/interrupt.
 * Messages that arrive before the turn starts are held and delivered once it does.
 */
export function createJobController(workspaceRoot, jobId, { onEvent = null } = {}) {
  const acks = readControlAcks(workspaceRoot, jobId);
  let context = null;
  let timer = null;
  let busy = false;
  let inflight = null;
  let interruptRequested = false;

  function ack(message, status, detail = null) {
    if (acks[message.id]) {
      return;
    }
    acks[message.id] = { status, detail, type: message.type, at: new Date().toISOString() };
    writeJsonAtomic(ackFile(workspaceRoot, jobId), acks);
    onEvent?.({ message, status, detail });
  }

  async function deliver(message) {
    const { client, threadId, turnId } = context;
    if (message.type === "interrupt") {
      interruptRequested = true;
      await client.request("turn/interrupt", { threadId, turnId });
      ack(message, "delivered", `Interrupted turn ${turnId}.`);
      return;
    }
    if (message.type === "steer") {
      await client.request("turn/steer", { threadId, expectedTurnId: turnId, input: buildTurnInput(String(message.text ?? "")) });
      ack(message, "delivered", `Steered turn ${turnId}.`);
      return;
    }
    ack(message, "rejected", `Unknown control message type: ${message.type}`);
  }

  async function poll() {
    if (busy || !context) {
      return;
    }
    busy = true;
    try {
      for (const message of readInbox(workspaceRoot, jobId)) {
        if (acks[message.id] || !context) {
          continue;
        }
        inflight = message;
        try {
          await deliver(message);
        } catch (error) {
          if (message.type === "interrupt") {
            interruptRequested = true;
          }
          ack(message, "failed", error instanceof Error ? error.message : String(error));
        } finally {
          inflight = null;
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    attach(nextContext) {
      context = nextContext;
      void poll();
      timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
      timer.unref?.();
    },
    detach() {
      context = null;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Codex completes the turn before answering turn/interrupt, and the connection closes right
      // after, so settle an in-flight request here instead of reporting a spurious failure.
      if (inflight?.type === "interrupt") {
        ack(inflight, "delivered", "The turn ended after the interrupt was sent.");
      } else if (inflight) {
        ack(inflight, "undelivered", "The turn ended while this message was being delivered; send it as a follow-up if it still matters.");
      }
    },
    /** Resolve anything still queued once the turn is over so senders are not left waiting. */
    finalize() {
      for (const message of readInbox(workspaceRoot, jobId)) {
        if (acks[message.id]) {
          continue;
        }
        if (message.type === "interrupt") {
          interruptRequested = true;
          ack(message, "delivered", "The turn had already ended.");
        } else {
          ack(message, "undelivered", "The turn finished before this message could be delivered; send it as a follow-up instead.");
        }
      }
    },
    get interruptRequested() {
      return interruptRequested || readInbox(workspaceRoot, jobId).some((message) => message.type === "interrupt");
    }
  };
}
