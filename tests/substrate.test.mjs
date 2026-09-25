import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { installSubstrateFake } from "./substrate-fake.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { ensureBrokerSession, loadBrokerSession, saveBrokerSession, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";
import { runAppServerTurn } from "../plugins/codex/scripts/lib/codex.mjs";
import { getProcessStartMarker, isProcessAlive } from "../plugins/codex/scripts/lib/process.mjs";
import { resolveTicketFile } from "../plugins/codex/scripts/lib/state.mjs";
import { run } from "./helpers.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex", "scripts", "codex-companion.mjs");

// Regression tests for the transport/broker substrate, cross-checked against upstream reports:
// openai/codex-plugin-cc #302 (unbounded waits), #453 (zombie broker), #574 (false success),
// #706/#707 (retained thread subscriptions), #740 (sandbox on live resume), #762/#768 (broker
// teardown vs readiness), #775 (fileChange without changes).

const binDir = makeTempDir();
const fake = installSubstrateFake(binDir);
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

function repo() {
  const dir = makeTempDir();
  initGitRepo(dir);
  return dir;
}

function turnStarts(since = 0) {
  return fake.entries().slice(since).filter((entry) => entry.method === "turn/start");
}

// ------------------------------------------------------------------------------------------
// Transport and turn liveness (#302, #453 root cause)

test("an RPC the app-server never answers fails with a bounded timeout", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "hang-thread-start", CODEX_COMPANION_RPC_TIMEOUT_MS: "300" }, async () => {
    const client = await CodexAppServerClient.connect(repo(), { disableBroker: true });
    const started = Date.now();
    await assert.rejects(client.request("thread/start", { cwd: process.cwd() }), /did not answer thread\/start within 300ms/);
    assert.ok(Date.now() - started < 3000);
    await client.close();
  }));

test("requests on a dead connection fail immediately instead of hanging", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "exit-mid-turn", CODEX_COMPANION_RPC_TIMEOUT_MS: "0" }, async () => {
    const client = await CodexAppServerClient.connect(repo(), { disableBroker: true });
    const { thread } = await client.request("thread/start", {});
    await client.request("turn/start", { threadId: thread.id, input: [] });
    await client.exitPromise;
    await assert.rejects(client.request("thread/read", { threadId: thread.id }), /exited|closed/);
    await client.close();
  }));

test("a turn fails fast when the app-server dies mid-turn", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "exit-mid-turn" }, async () => {
    const started = Date.now();
    await assert.rejects(
      runAppServerTurn(repo(), { prompt: "work", disableBroker: true }),
      /connection closed before the turn completed/
    );
    assert.ok(Date.now() - started < 5000);
  }));

test("a turn whose completion event is lost is recovered from the thread record", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "lost-completion", CODEX_COMPANION_TURN_PROBE_MS: "300" }, async () => {
    const result = await runAppServerTurn(repo(), { prompt: "work", disableBroker: true });
    assert.equal(result.turn.status, "completed");
    assert.equal(result.status, 0);
  }));

test("a quiet but active turn is never failed for silence", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "silent-but-active", CODEX_COMPANION_TURN_PROBE_MS: "250" }, async () => {
    const result = await runAppServerTurn(repo(), { prompt: "think hard", disableBroker: true });
    assert.equal(result.status, 0);
    assert.equal(result.finalMessage, "finished after a quiet period");
    assert.ok(fake.entries().some((entry) => entry.method === "thread/read"), "the watchdog probed instead of assuming");
  }));

// ------------------------------------------------------------------------------------------
// Turn result correctness (#574 RC3, #775) and privilege (#740)

test("retryable errors do not fail a turn, fatal errors do even when completion is inferred", async () => {
  const retried = await withEnv({ FAKE_SUBSTRATE_MODE: "retryable-error" }, () => runAppServerTurn(repo(), { prompt: "work", disableBroker: true }));
  assert.equal(retried.status, 0);
  const fatal = await withEnv({ FAKE_SUBSTRATE_MODE: "fatal-error-inferred-completion" }, () =>
    runAppServerTurn(repo(), { prompt: "work", disableBroker: true })
  );
  assert.equal(fatal.status, 1);
  assert.match(fatal.error.message, /model rejected the request/);
});

test("a fileChange start event without a change list does not crash the turn", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "filechange-without-changes" }, async () => {
    const progress = [];
    const result = await runAppServerTurn(repo(), { prompt: "edit", disableBroker: true, onProgress: (event) => progress.push(event) });
    assert.equal(result.status, 0);
    assert.ok(progress.some((event) => (event.message ?? event) === "Applying file changes."));
  }));

test("every turn sends an explicit sandbox policy, so privilege never carries over from earlier turns", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "normal" }, async () => {
    const dir = repo();
    const before = fake.entries().length;
    await runAppServerTurn(dir, { prompt: "read", sandbox: "read-only", disableBroker: true });
    await runAppServerTurn(dir, { prompt: "write", sandbox: "workspace-write", disableBroker: true });
    // A resumed thread whose live sandbox is still writable must get an explicit read-only turn.
    await runAppServerTurn(dir, { prompt: "read again", resumeThreadId: "thr_live", sandbox: "read-only", disableBroker: true });
    const [readTurn, writeTurn, resumedRead] = turnStarts(before);
    assert.deepEqual(readTurn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(writeTurn.params.sandboxPolicy.type, "workspaceWrite");
    assert.deepEqual(writeTurn.params.sandboxPolicy.writableRoots, [path.resolve(dir)]);
    assert.equal(writeTurn.params.sandboxPolicy.networkAccess, false);
    assert.deepEqual(resumedRead.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  }));

// ------------------------------------------------------------------------------------------
// Broker lifecycle (#706/#707, #453, #762/#768)

async function brokerClient(dir, t) {
  const session = await ensureBrokerSession(dir, { env: process.env });
  assert.ok(session, "a broker should start");
  const client = await CodexAppServerClient.connect(dir, { brokerEndpoint: session.endpoint });
  // An open socket keeps the test process alive, so a failed assertion must not strand clients.
  t.after(() => client.close().catch(() => {}));
  return { session, client };
}

test("the broker unsubscribes a thread, and its subagent threads, once the last client disconnects", (t) =>
  withEnv({ FAKE_SUBSTRATE_MODE: "subagent" }, async () => {
    const dir = repo();
    const { client } = await brokerClient(dir, t);
    const { thread } = await client.request("thread/start", {});
    await client.request("turn/start", { threadId: thread.id, input: [] });
    await client.close();
    const unsubscribed = await waitFor(() => {
      const ids = fake.entries().filter((entry) => entry.method === "thread/unsubscribe").map((entry) => entry.params.threadId);
      return ids.includes(thread.id) && ids.length >= 2 ? ids : null;
    }, { timeoutMs: 30000 });
    const child = fake.entries().filter((entry) => entry.method === "thread/unsubscribe").map((entry) => entry.params.threadId).find((id) => id !== thread.id);
    assert.ok(child, `expected the subagent thread to be released too: ${unsubscribed}`);
  }));

test("a subagent thread that starts after its parent's last client left is released too", (t) =>
  withEnv({ FAKE_SUBSTRATE_MODE: "subagent-late" }, async () => {
    // Under load, the subagent's thread/started can reach the broker after the parent's owner
    // disconnected; the broker then had nobody to hand it to and never unsubscribed it.
    const dir = repo();
    const before = fake.entries().length;
    const { client } = await brokerClient(dir, t);
    const { thread } = await client.request("thread/start", {});
    await client.request("turn/start", { threadId: thread.id, input: [] });
    await client.close();
    const released = () =>
      fake.entries().slice(before).filter((entry) => entry.method === "thread/unsubscribe").map((entry) => entry.params.threadId);
    await waitFor(() => released().includes(thread.id));
    const child = await waitFor(() => released().find((id) => id !== thread.id), { timeoutMs: 5000 });
    assert.ok(child, "the late subagent thread was released");
  }));

// Regression (review finding): an orphan subagent fell back to whichever client was streaming
// when it started, instead of being released; it stayed loaded until that unrelated client left.
test("an orphan subagent is released even while an unrelated client is streaming", (t) =>
  withEnv({ FAKE_SUBSTRATE_MODE: "subagent-late" }, async () => {
    const dir = repo();
    const before = fake.entries().length;
    const { session, client: first } = await brokerClient(dir, t);
    const { thread: parent } = await first.request("thread/start", {});
    await first.request("turn/start", { threadId: parent.id, input: [] });
    await first.close();
    // Another client starts streaming before the first one's subagent announces itself.
    const second = await CodexAppServerClient.connect(dir, { brokerEndpoint: session.endpoint });
    t.after(() => second.close().catch(() => {}));
    const delivered = [];
    second.setNotificationHandler((message) => delivered.push(message));
    const { thread: other } = await second.request("thread/start", {});
    await second.request("turn/start", { threadId: other.id, input: [] });
    const released = () =>
      fake.entries().slice(before).filter((entry) => entry.method === "thread/unsubscribe").map((entry) => entry.params.threadId);
    // Released while the second client is still connected: the parent, and its orphaned subagent.
    const ids = await waitFor(() => (released().length >= 2 ? released() : null), { timeoutMs: 3000 });
    assert.ok(ids.includes(parent.id), `parent released: ${ids}`);
    assert.ok(!ids.includes(other.id), "the streaming client's own thread stays subscribed");
    // Its capture would count any thread/started it receives as its own subagent.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const leaked = delivered.filter((message) => message.params?.thread?.parentThreadId === parent.id);
    assert.deepEqual(leaked, [], "the orphan's notifications reach no client");
    assert.ok(delivered.some((message) => message.params?.thread?.parentThreadId === other.id), "its own subagent still arrives");
  }));

test("a thread shared by two clients stays subscribed until the second one leaves", (t) =>
  withEnv({ FAKE_SUBSTRATE_MODE: "normal" }, async () => {
    const dir = repo();
    const { session, client: first } = await brokerClient(dir, t);
    const { thread } = await first.request("thread/start", {});
    const second = await CodexAppServerClient.connect(dir, { brokerEndpoint: session.endpoint });
    t.after(() => second.close().catch(() => {}));
    await second.request("thread/resume", { threadId: thread.id });
    await first.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const released = () => fake.entries().some((entry) => entry.method === "thread/unsubscribe" && entry.params.threadId === thread.id);
    assert.equal(released(), false, "still owned by the second client");
    await second.close();
    await waitFor(released);
  }));

test("a broker exits when its app-server dies, and the next caller gets a healthy broker", (t) =>
  withEnv({ FAKE_SUBSTRATE_MODE: "normal" }, async () => {
    const dir = repo();
    const first = await ensureBrokerSession(dir, { env: process.env });
    const appServerPid = await waitFor(() => fake.entries().filter((entry) => entry.event === "start").at(-1)?.pid);
    process.kill(appServerPid, "SIGKILL");
    await waitFor(() => !isProcessAlive(first.pid));
    const second = await ensureBrokerSession(dir, { env: process.env });
    assert.ok(second && second.pid !== first.pid);
    const client = await CodexAppServerClient.connect(dir, { brokerEndpoint: second.endpoint });
    t.after(() => client.close().catch(() => {}));
    assert.ok((await client.request("thread/start", {})).thread.id);
  }));

test("a live broker that misses the readiness probe is never torn down", async (t) => {
  const dir = repo();
  // Stand-in for a busy broker: alive, recognisable, but not answering on its endpoint.
  const busy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "app-server-broker.mjs"], { stdio: "ignore" });
  t.after(() => busy.kill("SIGKILL"));
  await waitFor(() => getProcessStartMarker(busy.pid) || process.platform !== "linux");
  const session = {
    endpoint: `unix:${path.join(makeTempDir(), "missing.sock")}`,
    pidFile: null,
    logFile: null,
    sessionDir: null,
    pid: busy.pid,
    pidMarker: getProcessStartMarker(busy.pid)
  };
  saveBrokerSession(dir, session);
  const result = await ensureBrokerSession(dir, { env: process.env, probeTimeoutMs: 200 });
  assert.equal(result, null, "the caller falls back to a private app-server");
  assert.equal(isProcessAlive(busy.pid), true, "the busy broker was not killed");
  assert.deepEqual(loadBrokerSession(dir), session, "its metadata was kept");
});

test("metadata of a dead broker is replaced by a fresh broker", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "normal" }, async () => {
    const dir = repo();
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((resolve) => dead.on("exit", resolve));
    saveBrokerSession(dir, { endpoint: `unix:${path.join(makeTempDir(), "gone.sock")}`, pid: dead.pid, pidMarker: "linux:0" });
    const fresh = await ensureBrokerSession(dir, { env: process.env, probeTimeoutMs: 200 });
    assert.ok(fresh && fresh.pid !== dead.pid);
    assert.equal(loadBrokerSession(dir).pid, fresh.pid);
  }));

test("an idle-only shutdown request never stops a broker another client is using", (t) =>
  withEnv({ FAKE_SUBSTRATE_MODE: "normal" }, async () => {
    const dir = repo();
    const { session, client } = await brokerClient(dir, t);
    await client.request("thread/start", {});
    assert.deepEqual(await sendBrokerShutdown(session.endpoint, { ifIdle: true }), { shutdown: false });
    assert.equal(isProcessAlive(session.pid), true);
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await sendBrokerShutdown(session.endpoint, { ifIdle: true }), { shutdown: true });
    await waitFor(() => !isProcessAlive(session.pid));
  }));

test("a broker with no clients exits on its own after the idle period", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "normal", CODEX_COMPANION_BROKER_IDLE_MS: "400" }, async () => {
    const dir = repo();
    const session = await ensureBrokerSession(dir, { env: process.env });
    const client = await CodexAppServerClient.connect(dir, { brokerEndpoint: session.endpoint });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(isProcessAlive(session.pid), true, "a connected client keeps it alive");
    await client.close();
    await waitFor(() => !isProcessAlive(session.pid), { timeoutMs: 5000 });
  }));

test("concurrent callers share one broker instead of racing to create several", () =>
  withEnv({ FAKE_SUBSTRATE_MODE: "normal" }, async () => {
    const dir = repo();
    const sessions = await Promise.all(Array.from({ length: 4 }, () => ensureBrokerSession(dir, { env: process.env })));
    const endpoints = new Set(sessions.map((session) => session?.endpoint));
    assert.equal(endpoints.size, 1, `expected one shared broker, got ${[...endpoints].join(", ")}`);
    assert.ok(fs.existsSync(loadBrokerSession(dir).pidFile));
  }));

// ------------------------------------------------------------------------------------------
// Ticket continuity when a thread cannot be resumed

test("a followup whose thread cannot be resumed continues on a fresh thread with a handoff", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "a.txt"), "x\n");
  run("git", ["add", "."], { cwd: dir });
  run("git", ["commit", "-qm", "init"], { cwd: dir });
  const env = { ...process.env, FAKE_SUBSTRATE_MODE: "resume-unsupported" };
  const cli = (...args) => {
    const result = run("node", [SCRIPT, ...args, "--json"], { cwd: dir, env });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  cli("delegate", "--ticket", "cont", "--role", "investigate", "Investigate the thing.");
  const first = cli("wait", "cont", "--timeout-ms", "20000");
  const firstThread = first.ticket.threadId;
  assert.ok(firstThread);
  const before = fake.entries().length;
  cli("followup", "cont", "Dig into the second hypothesis.");
  const second = cli("wait", "cont", "--timeout-ms", "20000");
  assert.notEqual(second.ticket.threadId, firstThread, "a fresh thread took over");
  assert.equal(second.job.result.threadReset.previousThreadId, firstThread);
  const ticket = JSON.parse(fs.readFileSync(resolveTicketFile(dir, "cont"), "utf8"));
  assert.equal(ticket.threadHistory[0].previousThreadId, firstThread);
  const prompt = turnStarts(before).at(-1).params.input[0].text;
  assert.match(prompt, /<work_package ticket="cont"/);
  assert.match(prompt, /<previous_turns>[\s\S]*could no longer be resumed \(paginated_threads is not supported yet\)/);
  assert.match(prompt, /Dig into the second hypothesis/);
});
