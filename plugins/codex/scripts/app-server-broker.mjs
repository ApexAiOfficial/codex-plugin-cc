#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { parseArgs } from "./lib/args.mjs";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient } from "./lib/app-server.mjs";
import { parseBrokerEndpoint } from "./lib/broker-endpoint.mjs";

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);
// Requests that subscribe the shared upstream connection to a thread (by params or result).
const THREAD_CLAIMING_METHODS = new Set(["thread/start", "thread/resume", "thread/fork", "turn/start", "review/start", "thread/compact/start"]);
const UNSUBSCRIBE_WAIT_MS = 5000;
// A broker with no clients for this long exits on its own, so a Claude session that ended without
// SessionEnd (crash, killed terminal) cannot leave it running forever.
const IDLE_EXIT_ENV = "CODEX_COMPANION_BROKER_IDLE_MS";
const DEFAULT_IDLE_EXIT_MS = 30 * 60 * 1000;

function buildStreamThreadIds(method, params, result) {
  const threadIds = new Set();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

function threadIdsFromResult(method, params, result) {
  const ids = new Set();
  if (params?.threadId) {
    ids.add(params.threadId);
  }
  if (result?.thread?.id) {
    ids.add(result.thread.id);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    ids.add(result.reviewThreadId);
  }
  return ids;
}

function buildJsonRpcError(code, message, data) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket, message) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

function isInterruptRequest(message) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node scripts/app-server-broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket = null;
  let activeStreamSocket = null;
  let activeStreamThreadIds = null;
  let terminating = false;
  const sockets = new Set();

  // Thread subscription ownership. Starting or resuming a thread subscribes the shared upstream
  // connection; without a matching thread/unsubscribe, finished threads (and their subagents and
  // MCP runtimes) stay loaded for the broker's lifetime. A thread is unsubscribed once its last
  // downstream owner disconnects.
  const socketThreads = new Map();
  const threadOwners = new Map();
  const pendingUnsubscribes = new Map();

  function claimThread(socket, threadId) {
    if (!threadId || socket.destroyed) {
      return;
    }
    if (!socketThreads.has(socket)) {
      socketThreads.set(socket, new Set());
    }
    socketThreads.get(socket).add(threadId);
    if (!threadOwners.has(threadId)) {
      threadOwners.set(threadId, new Set());
    }
    threadOwners.get(threadId).add(socket);
  }

  function unsubscribeWhenUnowned(threadId) {
    const run = async () => {
      if (terminating || threadOwners.get(threadId)?.size) {
        return;
      }
      threadOwners.delete(threadId);
      try {
        await appClient.request("thread/unsubscribe", { threadId }, { timeoutMs: 30000 });
      } catch (error) {
        process.stderr.write(`[broker] thread/unsubscribe ${threadId} failed: ${error.message}\n`);
      }
    };
    // Never reuse a sent unsubscribe: chain a fresh one that re-checks ownership when it runs.
    const previous = pendingUnsubscribes.get(threadId) ?? Promise.resolve();
    const next = previous.then(run, run).finally(() => {
      if (pendingUnsubscribes.get(threadId) === next) {
        pendingUnsubscribes.delete(threadId);
      }
    });
    pendingUnsubscribes.set(threadId, next);
  }

  function releaseSocketThreads(socket) {
    const threads = socketThreads.get(socket);
    socketThreads.delete(socket);
    for (const threadId of threads ?? []) {
      const owners = threadOwners.get(threadId);
      owners?.delete(socket);
      if (!owners || owners.size === 0) {
        unsubscribeWhenUnowned(threadId);
      }
    }
  }

  /** A request for a thread must not race that thread's in-flight unsubscribe. */
  async function awaitThreadUnsubscribe(threadId) {
    const pending = threadId ? pendingUnsubscribes.get(threadId) : null;
    if (!pending) {
      return true;
    }
    let timer = null;
    const settled = await Promise.race([
      pending.then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), UNSUBSCRIBE_WAIT_MS);
      })
    ]);
    clearTimeout(timer);
    return settled;
  }

  function clearSocketOwnership(socket) {
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (message.method === "thread/started" && message.params?.thread?.id) {
      // Subagent threads inherit their parent's owners; otherwise the socket receiving the stream.
      const threadId = message.params.thread.id;
      const parentOwners = threadOwners.get(message.params.thread.parentThreadId ?? "");
      const owners = parentOwners?.size ? [...parentOwners] : target ? [target] : [];
      for (const owner of owners) {
        claimThread(owner, threadId);
      }
      if (!threadOwners.get(threadId)?.size) {
        // Nobody is left to own it: a subagent that started after its parent's last client
        // disconnected. Release it now, or it stays loaded for the broker's lifetime.
        unsubscribeWhenUnowned(threadId);
      }
    }
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === "turn/completed" && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  async function shutdown(server) {
    terminating = true;
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error.message}`)
          });
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "codex-companion-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          // SessionEnd of one Claude session must not kill a broker another session is using:
          // with ifIdle, decline while any other client is connected or a request is in flight.
          const others = [...sockets].filter((candidate) => candidate !== socket && !candidate.destroyed);
          if (message.params?.ifIdle && (others.length > 0 || activeRequestSocket || activeStreamSocket)) {
            send(socket, { id: message.id, result: { shutdown: false, reason: "busy", clients: others.length } });
            continue;
          }
          send(socket, { id: message.id, result: { shutdown: true } });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        const claims = THREAD_CLAIMING_METHODS.has(message.method);
        if (claims && !(await awaitThreadUnsubscribe(message.params?.threadId))) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is still releasing this thread; retry.")
          });
          continue;
        }
        activeRequestSocket = socket;

        try {
          const result = await appClient.request(message.method, message.params ?? {});
          if (claims) {
            for (const threadId of threadIdsFromResult(message.method, message.params ?? {}, result)) {
              claimThread(socket, threadId);
            }
            if (socket.destroyed) {
              // The requester left while waiting; do not strand what it just subscribed.
              releaseSocketThreads(socket);
            }
          }
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamSocket = socket;
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(error.rpcCode ?? -32000, error.message)
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && !isStreaming) {
            activeStreamSocket = null;
          }
        }
      }
    });

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      releaseSocketThreads(socket);
      armIdleExit();
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      releaseSocketThreads(socket);
    });
  });

  const idleExitMs = Number(process.env[IDLE_EXIT_ENV] ?? DEFAULT_IDLE_EXIT_MS);
  let idleTimer = null;
  function armIdleExit() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!(idleExitMs > 0) || sockets.size > 0) {
      return;
    }
    idleTimer = setTimeout(async () => {
      if (sockets.size === 0 && !terminating) {
        process.stderr.write(`[broker] idle for ${idleExitMs}ms with no clients; exiting.\n`);
        await shutdown(server);
        process.exit(0);
      }
    }, idleExitMs);
    idleTimer.unref?.();
  }
  server.on("connection", () => armIdleExit());
  server.on("listening", () => armIdleExit());

  // Without its app-server the broker can accept connections but never serve them; exit so the
  // next caller sees a dead endpoint and starts a healthy broker instead of wedging on this one.
  appClient.exitPromise.then(async () => {
    if (terminating) {
      return;
    }
    process.stderr.write(`[broker] codex app-server exited${appClient.exitError ? `: ${appClient.exitError.message}` : ""}; shutting down.\n`);
    await shutdown(server);
    process.exit(1);
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
