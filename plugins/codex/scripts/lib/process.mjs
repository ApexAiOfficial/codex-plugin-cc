import { spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: options.shell ?? (process.platform === "win32" ? (process.env.SHELL || true) : false),
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function isProcessAlive(pid) {
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

/**
 * A value that identifies one incarnation of `pid`, so a recycled pid is never mistaken for the
 * process we launched. Returns null where no cheap marker exists (Windows) or the pid is gone.
 */
export function getProcessStartMarker(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return null;
  }
  if (platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      // Fields after the parenthesized command name; starttime is field 22 overall.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return fields[19] ? `linux:${fields[19]}` : null;
    } catch {
      return null;
    }
  }
  const result = runCommand("ps", ["-o", "lstart=", "-p", String(pid)], { shell: false });
  const started = result.status === 0 ? result.stdout.trim() : "";
  return started ? `ps:${started}` : null;
}

/** Command line of a live process, or null when it cannot be read on this platform. */
export function readProcessCommandLine(pid, options = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ") || null;
    } catch {
      return null;
    }
  }
  const result =
    platform === "win32"
      ? runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { shell: false })
      : runCommand("ps", ["-o", "command=", "-p", String(pid)], { shell: false });
  const text = result.status === 0 ? result.stdout.trim() : "";
  return text || null;
}

/**
 * Identify a recorded process: "gone" (not running), "same" (verified to be the process we
 * recorded), "different" (the pid now belongs to another process), or "unknown" (alive, but
 * identity cannot be verified). Verification uses the start marker when one was recorded and
 * otherwise a command-line hint (for platforms without markers, such as Windows).
 */
export function probeProcessIdentity(pid, marker, options = {}) {
  if (!isProcessAlive(pid)) {
    return "gone";
  }
  if (marker) {
    const current = getProcessStartMarker(pid, options);
    if (current == null) {
      return "unknown";
    }
    return current === marker ? "same" : "different";
  }
  if (options.commandHint) {
    const commandLine = readProcessCommandLine(pid, options);
    if (commandLine == null) {
      return "unknown";
    }
    return commandLine.includes(options.commandHint) ? "same" : "different";
  }
  return "unknown";
}

/** Kill-safety check: true only when the process is verified to be the one we recorded. */
export function isSameProcess(pid, marker, options = {}) {
  return probeProcessIdentity(pid, marker, options) === "same";
}

/** Terminate a process tree only when it is verified to be the incarnation we recorded (fail closed). */
export function terminateRecordedProcessTree(pid, marker, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null, reason: "no-pid" };
  }
  const identity = probeProcessIdentity(pid, marker, options);
  if (identity !== "same") {
    return { attempted: false, delivered: false, method: null, reason: identity === "gone" ? "not-running" : `identity-${identity}` };
  }
  return terminateProcessTree(pid, options);
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
