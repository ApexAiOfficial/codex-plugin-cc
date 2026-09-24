import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCommand, formatCommandFailure } from "./process.mjs";

// Controller-side git plumbing never goes through a shell (paths come from the repository).
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false, maxBuffer: 64 * 1024 * 1024 });
}

function gitChecked(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result.stdout;
}

export function isGitWorkTree(cwd) {
  const result = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.status === 0 && result.stdout.trim() === "true";
}

export function readHead(cwd) {
  const result = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function emptyTree(cwd) {
  return gitChecked(cwd, ["mktree"], { input: "" }).trim();
}

/**
 * Record the full working-tree state of `dir` (tracked and untracked, honouring .gitignore) as a
 * git tree object, using a temporary index so the real index and working tree are untouched.
 */
export function snapshotWorkingTree(dir, options = {}) {
  const indexPath = path.resolve(dir, gitChecked(dir, ["rev-parse", "--git-path", "index"]).trim());
  const tempIndex = path.join(os.tmpdir(), `codex-snapshot-${process.pid}-${randomBytes(4).toString("hex")}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try {
    if (fs.existsSync(indexPath)) {
      // Starting from the real index lets git reuse its stat cache instead of rehashing everything.
      fs.copyFileSync(indexPath, tempIndex);
    }
    gitChecked(dir, ["add", "-A", "--", "."], { env });
    for (const excluded of options.exclude ?? []) {
      git(dir, ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", excluded], { env });
    }
    return gitChecked(dir, ["write-tree"], { env }).trim();
  } finally {
    fs.rmSync(tempIndex, { force: true });
    fs.rmSync(`${tempIndex}.lock`, { force: true });
  }
}

/** Files that differ between two tree-ish values, with line counts where git can compute them. */
export function diffTrees(cwd, fromTree, toTree) {
  if (!fromTree || !toTree || fromTree === toTree) {
    return [];
  }
  const nameStatus = gitChecked(cwd, ["diff", "--name-status", "-z", "--no-renames", fromTree, toTree]).split("\0");
  const changes = [];
  for (let index = 0; index + 1 < nameStatus.length; index += 2) {
    const status = nameStatus[index];
    const filePath = nameStatus[index + 1];
    if (status && filePath) {
      changes.push({ path: filePath, status: status[0], added: null, deleted: null });
    }
  }
  const byPath = new Map(changes.map((change) => [change.path, change]));
  const numstat = gitChecked(cwd, ["diff", "--numstat", "-z", "--no-renames", fromTree, toTree]).split("\0");
  for (const entry of numstat) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
    const change = match ? byPath.get(match[3]) : null;
    if (change) {
      change.added = match[1] === "-" ? null : Number(match[1]);
      change.deleted = match[2] === "-" ? null : Number(match[2]);
    }
  }
  return changes;
}

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        const followedBySlash = pattern[index + 2] === "/";
        source += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegExp(character);
    }
  }
  return new RegExp(`^${source}$`);
}

export function normalizeRepoPath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Compile ownership globs. Plain paths own themselves and everything beneath them. */
export function compileOwnership(patterns) {
  const matchers = (patterns ?? [])
    .map((pattern) => normalizeRepoPath(pattern))
    .filter(Boolean)
    .map((pattern) => {
      if (!/[*?]/.test(pattern)) {
        return (candidate) => candidate === pattern || candidate.startsWith(`${pattern}/`);
      }
      const regex = globToRegExp(pattern);
      return (candidate) => regex.test(candidate);
    });
  return (candidate) => matchers.some((matches) => matches(normalizeRepoPath(candidate)));
}

/** Map Codex fileChange items (absolute or relative paths) to repository-relative paths. */
export function reportedPathsRelativeTo(workdir, fileChanges) {
  const paths = new Set();
  const root = path.resolve(workdir);
  for (const fileChange of fileChanges ?? []) {
    for (const change of fileChange.changes ?? []) {
      for (const candidate of [change.path, change.kind?.move_path]) {
        if (!candidate) {
          continue;
        }
        const absolute = path.resolve(root, candidate);
        const relative = path.relative(root, absolute);
        if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
          paths.add(normalizeRepoPath(relative));
        } else {
          paths.add(normalizeRepoPath(candidate));
        }
      }
    }
  }
  return [...paths].sort();
}

/**
 * Build the controller's evidence for one Codex turn from before/after snapshots.
 * In a shared checkout the diff is "what changed during the turn, by anyone"; only paths Codex
 * reported editing are attributable to it. In a private worktree every change is Codex's.
 */
export function buildTurnEvidence({ workdir, isolation, owns, startTree, endTree, headAtStart, headAtEnd, fileChanges }) {
  const changed = startTree && endTree ? diffTrees(workdir, startTree, endTree) : [];
  const changedPaths = changed.map((change) => change.path);
  const reported = reportedPathsRelativeTo(workdir, fileChanges);
  const attributed = isolation === "worktree" ? changedPaths : reported;
  const reportedSet = new Set(reported);
  const unattributed = isolation === "worktree" ? [] : changedPaths.filter((candidate) => !reportedSet.has(candidate));
  const isOwned = owns?.length ? compileOwnership(owns) : null;
  return {
    workdir,
    isolation,
    startTree: startTree ?? null,
    endTree: endTree ?? null,
    headAtStart: headAtStart ?? null,
    headAtEnd: headAtEnd ?? null,
    headMoved: Boolean(headAtStart && headAtEnd && headAtStart !== headAtEnd),
    changed,
    codexReported: reported,
    unattributed,
    ownership: isOwned
      ? { patterns: owns, violations: attributed.filter((candidate) => !isOwned(candidate)) }
      : null
  };
}

function normalizeCommandText(command) {
  return String(command ?? "")
    .replace(/^\S*(?:ba|z)?sh\s+-l?c\s+/, "")
    .replace(/['"`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compare what Codex claims it verified against the commands it was observed running.
 * This is a heuristic signal for the lead, not a verdict: matching is by normalized substring.
 */
export function crossCheckVerificationClaims(report, commands) {
  const observed = (commands ?? []).map((command) => ({ ...command, normalized: normalizeCommandText(command.command) }));
  return (report?.verification ?? [])
    .filter((claim) => claim.outcome !== "not_run" && claim.command)
    .map((claim) => {
      const wanted = normalizeCommandText(claim.command);
      const matches = observed.filter(
        (command) => wanted && command.normalized && (command.normalized.includes(wanted) || wanted.includes(command.normalized))
      );
      const last = matches.at(-1) ?? null;
      let observation = "not-observed";
      if (last) {
        const passed = last.exitCode === 0;
        observation = passed === (claim.outcome === "passed") ? "consistent" : "contradicted";
      }
      return {
        command: claim.command,
        claimed: claim.outcome,
        observation,
        observedExitCode: last?.exitCode ?? null
      };
    });
}
