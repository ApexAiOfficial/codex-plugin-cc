import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { getProcessStartMarker } from "./process.mjs";

const DEFAULT_LOCK_TIMEOUT_MS = 15000;
// Only for a lock whose owner record is unreadable (the holder died between create and write).
// A lock whose recorded owner is alive is never broken, however old: that would let two
// writers run their critical sections concurrently.
const DEFAULT_LOCK_STALE_MS = 30000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
const heldLocks = new Map();
// Locks held by in-flight withFileLockAsync calls of this process (lockPath -> token).
const asyncHeldLocks = new Map();

export function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, Math.max(0, ms));
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readLockOwner(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function lockIsStale(lockPath, staleMs) {
  let stat;
  try {
    stat = fs.statSync(lockPath);
  } catch {
    return false;
  }
  const owner = readLockOwner(lockPath);
  if (owner && Number.isInteger(owner.pid)) {
    if (owner.pid === process.pid) {
      // Held locks are tracked in-process; an unknown one with our pid is a recycled-pid leftover.
      return !heldLocks.has(lockPath) && asyncHeldLocks.get(lockPath) !== owner.token;
    }
    if (!isPidAlive(owner.pid)) {
      return true;
    }
    // Alive: stale only if that pid now belongs to a different process incarnation.
    const marker = owner.marker ? getProcessStartMarker(owner.pid) : null;
    return Boolean(owner.marker && marker && marker !== owner.marker);
  }
  // No readable owner: the holder is between create and write, or died there; only age decides.
  return Date.now() - stat.mtimeMs > staleMs;
}

/**
 * Break a lock judged stale, safely against concurrent contenders. Several contenders can judge the
 * same stale lock at once; if each renamed the path, a later one could rename away a fresh lock
 * another had just acquired, admitting two holders. So breaking is serialized through a recovery
 * gate, and staleness is re-checked inside it. While the stale lock exists nobody can create a new
 * one (O_EXCL), so under the gate the path can only change through this breaker. An abandoned gate
 * (its holder died in this microsecond window) is never broken automatically: fail closed.
 */
function recoverStaleLock(lockPath, staleMs) {
  const gate = `${lockPath}.recover`;
  let gateFd;
  try {
    gateFd = fs.openSync(gate, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
    const holder = readLockOwner(gate);
    if (holder && Number.isInteger(holder.pid)) {
      // Abandoned: the holder is dead, or its pid now belongs to another process (for example after
      // a reboot). Recovery is synchronous, so a gate carrying this process's own pid is never a live
      // concurrent holder. An unreadable current marker proves nothing, so it never counts as recycled.
      const alive = isPidAlive(holder.pid);
      const currentMarker = alive && holder.marker ? getProcessStartMarker(holder.pid) : null;
      const recycled = holder.pid === process.pid || Boolean(currentMarker && currentMarker !== holder.marker);
      if (!alive || recycled) {
        throw new Error(
          `Lock recovery gate ${gate} was abandoned by ${alive ? "an earlier process with" : "dead"} pid ${holder.pid}; remove it once no Codex companion process is running.`
        );
      }
    }
    return false;
  }
  try {
    fs.writeSync(gateFd, JSON.stringify({ pid: process.pid, marker: getProcessStartMarker(process.pid), at: new Date().toISOString() }));
    if (!lockIsStale(lockPath, staleMs)) {
      return false;
    }
    breakStaleLock(lockPath);
    return true;
  } finally {
    fs.closeSync(gateFd);
    fs.rmSync(gate, { force: true });
  }
}

function breakStaleLock(lockPath) {
  // Rename first so that exactly one contender wins the right to discard the stale lock.
  const graveyard = `${lockPath}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockPath, graveyard);
  } catch {
    return;
  }
  try {
    fs.unlinkSync(graveyard);
  } catch {
    // Ignore; the lock itself is already released.
  }
}

/**
 * Run `fn` while holding an exclusive cross-process lock at `lockPath`.
 * Re-entrant within one process so nested state helpers never self-deadlock.
 */
export function withFileLock(lockPath, fn, options = {}) {
  const held = heldLocks.get(lockPath);
  if (held) {
    held.depth += 1;
    try {
      return fn();
    } finally {
      held.depth -= 1;
    }
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;
  let delayMs = 4;
  let fd = null;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (lockIsStale(lockPath, staleMs)) {
        options.beforeRecover?.();
        if (recoverStaleLock(lockPath, staleMs)) {
          continue;
        }
      }
      if (Date.now() >= deadline) {
        const owner = readLockOwner(lockPath);
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for Codex companion state lock ${lockPath}${owner?.pid ? ` (held by pid ${owner.pid})` : ""}.`
        );
      }
      sleepSync(delayMs + Math.random() * delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }

  try {
    fs.writeSync(
      fd,
      JSON.stringify({ pid: process.pid, marker: getProcessStartMarker(process.pid), token, acquiredAt: new Date().toISOString() })
    );
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
    throw error;
  }

  heldLocks.set(lockPath, { depth: 1 });
  try {
    return fn();
  } finally {
    heldLocks.delete(lockPath);
    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close failures during release.
    }
    // Only remove the lock if it is still ours; a peer may have broken it as stale.
    if (readLockOwner(lockPath)?.token === token) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Ignore; another process may have already reclaimed it.
      }
    }
  }
}

/**
 * Async variant for critical sections that await (for example broker readiness). Same lock-file
 * protocol and stale rules as withFileLock; not re-entrant. Resolves to `onTimeout()` when the
 * lock cannot be acquired in time.
 */
export async function withFileLockAsync(lockPath, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;
  let delayMs = 10;
  let fd = null;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      if (lockIsStale(lockPath, staleMs) && recoverStaleLock(lockPath, staleMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        if (options.onTimeout) {
          return options.onTimeout();
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for lock ${lockPath}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs + Math.random() * delayMs));
      delayMs = Math.min(delayMs * 2, 200);
    }
  }
  asyncHeldLocks.set(lockPath, token);
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, marker: getProcessStartMarker(process.pid), token, acquiredAt: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  try {
    return await fn();
  } finally {
    if (asyncHeldLocks.get(lockPath) === token) {
      asyncHeldLocks.delete(lockPath);
    }
    if (readLockOwner(lockPath)?.token === token) {
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function renameWithRetry(source, target) {
  let lastError = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.renameSync(source, target);
      return;
    } catch (error) {
      lastError = error;
      // Windows reports transient sharing violations while another process has the target open.
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) {
        break;
      }
      sleepSync(10 * (attempt + 1));
    }
  }
  try {
    fs.unlinkSync(source);
  } catch {
    // Ignore temp cleanup failures.
  }
  throw lastError;
}

/** Write `contents` so readers observe either the previous file or the complete new one. */
export function writeFileAtomic(filePath, contents) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tempPath, "w");
  try {
    fs.writeFileSync(fd, contents, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  renameWithRetry(tempPath, filePath);
}

export function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
