import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { diffTrees, readHead, snapshotWorkingTree } from "./evidence.mjs";
import { formatCommandFailure, runCommand } from "./process.mjs";

// Ignored dependency directories that a fresh worktree lacks and Codex cannot reinstall offline.
export const DEFAULT_LINKED_DIRS = ["node_modules", ".venv", "venv"];
const REF_PREFIX = "refs/codex-companion/tickets";
const JOURNAL_VERSION = 1;
const JOURNAL_MANIFEST = "manifest.json";
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: "Codex Companion",
  GIT_AUTHOR_EMAIL: "codex-companion@localhost",
  GIT_COMMITTER_NAME: "Codex Companion",
  GIT_COMMITTER_EMAIL: "codex-companion@localhost"
};

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

function gitBuffer(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

function commitTree(repoRoot, tree, parent, message) {
  const args = ["commit-tree", tree, "-m", message];
  if (parent) {
    args.push("-p", parent);
  }
  return gitChecked(repoRoot, args, { env: { ...process.env, ...SNAPSHOT_IDENTITY } }).trim();
}

function pinRef(repoRoot, ticketId, name, commit) {
  gitChecked(repoRoot, ["update-ref", `${REF_PREFIX}/${ticketId}/${name}`, commit]);
}

function readRef(repoRoot, ref) {
  const result = git(repoRoot, ["rev-parse", "--verify", "--quiet", ref]);
  if (result.error) {
    throw result.error;
  }
  if (result.status === 1) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result.stdout.trim();
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathTraversalError(filePath) {
  const error = new Error(`Refusing to integrate ${filePath}: path traverses a symlink.`);
  error.code = "ERR_INTEGRATION_PATH_TRAVERSAL";
  return error;
}

/** Validate without following any ancestor symlink in the checkout. */
function assertSafeTarget(repoRoot, filePath) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, filePath);
  if (target === root || !isInside(root, target)) {
    throw pathTraversalError(filePath);
  }

  const realRoot = fs.realpathSync(root);
  const parent = path.dirname(target);
  const relativeParent = path.relative(root, parent);
  let cursor = root;
  let nearestExisting = root;
  for (const part of relativeParent === "" ? [] : relativeParent.split(path.sep)) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if (error.code === "ENOENT") {
        break;
      }
      if (error.code === "ENOTDIR") {
        throw pathTraversalError(filePath);
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw pathTraversalError(filePath);
    }
    if (!stat.isDirectory()) {
      throw pathTraversalError(filePath);
    }
    nearestExisting = cursor;
  }

  const realParent = fs.realpathSync(nearestExisting);
  if (!isInside(realRoot, realParent)) {
    throw pathTraversalError(filePath);
  }
  return target;
}

function ensureSafeParent(repoRoot, filePath) {
  const root = path.resolve(repoRoot);
  const target = assertSafeTarget(root, filePath);
  const relativeParent = path.relative(root, path.dirname(target));
  let cursor = root;
  for (const part of relativeParent === "" ? [] : relativeParent.split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw pathTraversalError(filePath);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      fs.mkdirSync(cursor);
    }
  }
  return assertSafeTarget(root, filePath);
}

/**
 * Create an isolated worktree for a ticket from the lead's *current* working-tree state,
 * including uncommitted and untracked (non-ignored) files, without touching the lead's index.
 */
export function createTicketWorktree({ repoRoot, worktreePath, ticketId, linkDirs = DEFAULT_LINKED_DIRS }) {
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Worktree path already exists: ${worktreePath}`);
  }
  const head = readHead(repoRoot);
  const tree = snapshotWorkingTree(repoRoot);
  const headTree = head ? gitChecked(repoRoot, ["rev-parse", `${head}^{tree}`]).trim() : null;
  const baseCommit = head && tree === headTree ? head : commitTree(repoRoot, tree, head, `codex ticket ${ticketId}: base snapshot of the lead's working tree`);

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  gitChecked(repoRoot, ["worktree", "add", "--detach", worktreePath, baseCommit]);
  pinRef(repoRoot, ticketId, "base", baseCommit);

  const linked = [];
  for (const name of linkDirs) {
    const source = path.join(repoRoot, name);
    const target = path.join(worktreePath, name);
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || fs.existsSync(target)) {
      continue;
    }
    fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
    linked.push(name);
  }

  return {
    path: worktreePath,
    baseCommit,
    baseHead: head,
    snapshotOfDirtyTree: baseCommit !== head,
    integrationBase: baseCommit,
    linked
  };
}

/** Changes in a ticket worktree relative to what has already been integrated. */
export function collectWorktreeChanges(worktree) {
  const tree = snapshotWorkingTree(worktree.path, { exclude: worktree.linked ?? [] });
  return { tree, changes: diffTrees(worktree.path, worktree.integrationBase ?? worktree.baseCommit, tree) };
}

function readTreeEntry(repoRoot, treeish, filePath) {
  const listing = gitChecked(repoRoot, ["ls-tree", "-z", treeish, "--", filePath]).split("\0").find(Boolean);
  if (!listing) {
    return null;
  }
  const [meta] = listing.split("\t");
  const [mode, type, object] = meta.split(" ");
  if (type !== "blob") {
    return { mode, type, content: null };
  }
  return { mode, type, content: gitBuffer(repoRoot, ["cat-file", "blob", object]) };
}

function readWorkingFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { mode: "120000", content: Buffer.from(fs.readlinkSync(filePath)) };
  }
  if (!stat.isFile()) {
    return { mode: "dir", content: null };
  }
  return { mode: stat.mode & 0o111 ? "100755" : "100644", content: fs.readFileSync(filePath) };
}

function sameContent(left, right) {
  if (!left || !right) {
    return !left && !right;
  }
  // Compare kind (symlink vs file) and bytes; the executable bit is unreliable across platforms.
  const leftIsLink = left.mode === "120000";
  const rightIsLink = right.mode === "120000";
  return leftIsLink === rightIsLink && Boolean(left.content) && Boolean(right.content) && left.content.equals(right.content);
}

function isText(buffer) {
  return buffer && !buffer.subarray(0, 8192).includes(0);
}

function mergeText(repoRoot, ours, base, theirs, labels) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-merge-"));
  try {
    const files = ["ours", "base", "theirs"].map((name) => path.join(dir, name));
    fs.writeFileSync(files[0], ours);
    fs.writeFileSync(files[1], base);
    fs.writeFileSync(files[2], theirs);
    const result = spawnSync(
      "git",
      ["merge-file", "-p", "-L", labels[0], "-L", labels[1], "-L", labels[2], ...files],
      { cwd: repoRoot, encoding: "buffer", maxBuffer: 256 * 1024 * 1024, windowsHide: true }
    );
    if (result.status == null || result.status < 0) {
      return { clean: false, content: null };
    }
    return { clean: result.status === 0, content: result.stdout };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureTarget(target, journalDir, index) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }

  const dataFile = `${index}.bin`;
  const dataPath = path.join(journalDir, dataFile);
  if (stat.isSymbolicLink()) {
    fs.writeFileSync(dataPath, fs.readlinkSync(target, { encoding: "buffer" }));
    return { kind: "symlink", dataFile };
  }
  if (!stat.isFile()) {
    throw new Error(`Cannot journal non-file integration target: ${target}`);
  }
  fs.copyFileSync(target, dataPath);
  return { kind: "file", mode: stat.mode & 0o7777, dataFile };
}

function writeManifest(journalDir, manifest) {
  const temporary = path.join(journalDir, `${JOURNAL_MANIFEST}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  fs.renameSync(temporary, path.join(journalDir, JOURNAL_MANIFEST));
}

function createIntegrationJournal({ repoRoot, ticketId, journalDir, plan, integratedCommit }) {
  const integratedRef = `${REF_PREFIX}/${ticketId}/integrated`;
  fs.mkdirSync(path.dirname(journalDir), { recursive: true });
  fs.mkdirSync(journalDir);
  try {
    const entries = plan
      .filter((step) => step.action === "write" || step.action === "delete")
      .map((step, index) => {
        const target = assertSafeTarget(repoRoot, step.path);
        return { path: step.path, state: captureTarget(target, journalDir, index) };
      });
    const manifest = {
      version: JOURNAL_VERSION,
      repoRoot: path.resolve(repoRoot),
      integratedRef,
      previousIntegratedCommit: readRef(repoRoot, integratedRef),
      intendedIntegratedCommit: integratedCommit,
      entries
    };
    writeManifest(journalDir, manifest);
    return manifest;
  } catch (error) {
    fs.rmSync(journalDir, { recursive: true, force: true });
    throw error;
  }
}

function removeEmptyParents(repoRoot, target) {
  const root = path.resolve(repoRoot);
  let parent = path.dirname(target);
  while (parent !== root && isInside(root, parent)) {
    try {
      fs.rmdirSync(parent);
    } catch {
      break;
    }
    parent = path.dirname(parent);
  }
}

function restoreTarget(repoRoot, journalDir, entry) {
  const target = assertSafeTarget(repoRoot, entry.path);
  if (entry.state.kind === "absent") {
    fs.rmSync(target, { force: true });
    removeEmptyParents(repoRoot, target);
    return;
  }

  const safeTarget = ensureSafeParent(repoRoot, entry.path);
  fs.rmSync(safeTarget, { force: true });
  const data = fs.readFileSync(path.join(journalDir, entry.state.dataFile));
  const checkedTarget = assertSafeTarget(repoRoot, entry.path);
  if (entry.state.kind === "symlink") {
    fs.symlinkSync(data, checkedTarget);
    return;
  }
  if (entry.state.kind !== "file" || !Number.isInteger(entry.state.mode)) {
    throw new Error(`Invalid integration journal entry for ${entry.path}.`);
  }
  fs.writeFileSync(checkedTarget, data);
  if (process.platform !== "win32") {
    fs.chmodSync(checkedTarget, entry.state.mode);
  }
}

function restoreIntegratedRef(repoRoot, manifest) {
  const current = readRef(repoRoot, manifest.integratedRef);
  if (current === manifest.previousIntegratedCommit) {
    return;
  }
  if (current !== manifest.intendedIntegratedCommit) {
    throw new Error(`Refusing to overwrite ${manifest.integratedRef}: it changed after the integration journal was created.`);
  }
  if (manifest.previousIntegratedCommit) {
    gitChecked(repoRoot, ["update-ref", manifest.integratedRef, manifest.previousIntegratedCommit]);
  } else if (current) {
    gitChecked(repoRoot, ["update-ref", "-d", manifest.integratedRef]);
  }
}

function restoreIntegrationJournal({ repoRoot, journalDir, manifest }) {
  const errors = [];
  const restored = [];
  for (const entry of manifest.entries) {
    try {
      restoreTarget(repoRoot, journalDir, entry);
      restored.push(entry.path);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    restoreIntegratedRef(repoRoot, manifest);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Failed to restore interrupted integration from ${journalDir}.`);
  }
  fs.rmSync(journalDir, { recursive: true, force: true });
  return restored;
}

/** Restore the lead checkout and integration ref from a journal left by an interrupted apply. */
export function recoverInterruptedIntegration({ repoRoot, worktree, journalDir = `${worktree.path}.integration-journal` }) {
  let journalStat;
  try {
    journalStat = fs.lstatSync(journalDir);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { recovered: false, journalDir, restored: [] };
    }
    throw error;
  }
  if (journalStat.isSymbolicLink() || !journalStat.isDirectory()) {
    throw new Error(`Refusing unsafe integration journal path: ${journalDir}`);
  }

  const manifestPath = path.join(journalDir, JOURNAL_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Refusing incomplete integration journal without a manifest: ${journalDir}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    manifest.version !== JOURNAL_VERSION ||
    manifest.repoRoot !== path.resolve(repoRoot) ||
    !Array.isArray(manifest.entries) ||
    typeof manifest.integratedRef !== "string"
  ) {
    throw new Error(`Invalid integration journal manifest: ${manifestPath}`);
  }
  const restored = restoreIntegrationJournal({ repoRoot, journalDir, manifest });
  return { recovered: true, journalDir, restored };
}

function writeEntry(repoRoot, filePath, entry) {
  const target = ensureSafeParent(repoRoot, filePath);
  fs.rmSync(target, { force: true });
  const checkedTarget = assertSafeTarget(repoRoot, filePath);
  if (entry.mode === "120000") {
    fs.symlinkSync(entry.content.toString(), checkedTarget);
    return;
  }
  fs.writeFileSync(checkedTarget, entry.content);
  if (process.platform !== "win32") {
    fs.chmodSync(checkedTarget, entry.mode === "100755" ? 0o755 : 0o644);
  }
}

/**
 * Apply a worktree's not-yet-integrated changes to the lead's checkout with a per-file three-way
 * merge (base = last integration point, ours = lead's checkout, theirs = worktree). Nothing is
 * written unless every file merges cleanly, or `allowConflicts` is set (conflict markers are then
 * written for text files). The lead's index is never touched.
 */
export function integrateWorktree({ repoRoot, worktree, ticketId, allowConflicts = false, journalDir = `${worktree.path}.integration-journal` }) {
  const recovery = recoverInterruptedIntegration({ repoRoot, worktree, journalDir });
  const base = worktree.integrationBase ?? worktree.baseCommit;
  const { tree: theirsTree, changes } = collectWorktreeChanges(worktree);
  const plan = [];
  const conflicts = [];
  let unsafePath = false;

  for (const change of changes) {
    const baseEntry = readTreeEntry(repoRoot, base, change.path);
    const theirsEntry = readTreeEntry(repoRoot, theirsTree, change.path);
    let target;
    try {
      target = assertSafeTarget(repoRoot, change.path);
    } catch (error) {
      if (error.code !== "ERR_INTEGRATION_PATH_TRAVERSAL") {
        throw error;
      }
      conflicts.push({ path: change.path, reason: "path traverses a symlink" });
      unsafePath = true;
      continue;
    }
    const oursEntry = readWorkingFile(target);

    if (sameContent(oursEntry, baseEntry)) {
      plan.push({ path: change.path, target, action: theirsEntry ? "write" : "delete", entry: theirsEntry, status: change.status });
      continue;
    }
    if (sameContent(oursEntry, theirsEntry)) {
      plan.push({ path: change.path, target, action: "unchanged", status: change.status });
      continue;
    }
    const mergeable =
      oursEntry?.content && theirsEntry?.content && oursEntry.mode !== "120000" && theirsEntry.mode !== "120000" &&
      isText(oursEntry.content) && isText(theirsEntry.content) && (!baseEntry || isText(baseEntry.content));
    if (mergeable) {
      const merged = mergeText(repoRoot, oursEntry.content, baseEntry?.content ?? Buffer.alloc(0), theirsEntry.content, [
        "lead",
        "base",
        `codex/${ticketId}`
      ]);
      if (merged.clean) {
        plan.push({ path: change.path, target, action: "write", entry: { mode: theirsEntry.mode, content: merged.content }, status: "merged" });
        continue;
      }
      conflicts.push({ path: change.path, reason: "both sides changed overlapping lines" });
      if (merged.content) {
        plan.push({ path: change.path, target, action: "write", entry: { mode: theirsEntry.mode, content: merged.content }, status: "conflict", conflict: true });
      }
      continue;
    }
    conflicts.push({
      path: change.path,
      reason: !theirsEntry
        ? "Codex deleted a file the lead modified"
        : !oursEntry
          ? "the lead deleted a file Codex modified"
          : "both sides changed a binary, symlink, or non-file entry"
    });
  }

  if (unsafePath || (conflicts.length > 0 && !allowConflicts)) {
    return { applied: false, conflicts, files: plan.map(({ path: filePath, action, status }) => ({ path: filePath, action, status })), theirsTree, recovery };
  }

  // Creating the commit object cannot alter the checkout or record a completed integration, so do
  // it before opening the journal and applying any files.
  const integratedCommit = commitTree(repoRoot, theirsTree, base, `codex ticket ${ticketId}: integrated state`);
  const mutablePlan = plan.filter((step) => step.action === "write" || step.action === "delete");
  let manifest = null;
  if (mutablePlan.length > 0) {
    manifest = createIntegrationJournal({ repoRoot, ticketId, journalDir, plan: mutablePlan, integratedCommit });
  }

  try {
    for (const step of mutablePlan) {
      // Re-check at the last possible point so a parent replaced after planning cannot redirect an
      // integration write outside the checkout.
      assertSafeTarget(repoRoot, step.path);
      if (step.action === "write") {
        writeEntry(repoRoot, step.path, step.entry);
      } else {
        fs.rmSync(assertSafeTarget(repoRoot, step.path), { force: true });
      }
    }
    pinRef(repoRoot, ticketId, "integrated", integratedCommit);
    if (manifest) {
      fs.rmSync(journalDir, { recursive: true });
    }
  } catch (error) {
    if (!manifest) {
      throw error;
    }
    try {
      restoreIntegrationJournal({ repoRoot, journalDir, manifest });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Integration failed and rollback was incomplete; recovery journal retained at ${journalDir}.`);
    }
    throw error;
  }

  return {
    applied: true,
    conflicts,
    files: plan.map(({ path: filePath, action, status }) => ({ path: filePath, action, status })),
    theirsTree,
    integratedCommit,
    recovery
  };
}

/** Remove a ticket worktree without ever following its dependency symlinks. */
export function removeTicketWorktree({ repoRoot, worktree, ticketId, worktreesRoot }) {
  const resolved = path.resolve(worktree.path);
  const root = path.resolve(worktreesRoot);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to remove ${resolved}: it is not inside ${root}.`);
  }
  for (const name of worktree.linked ?? []) {
    const link = path.join(resolved, name);
    try {
      if (fs.lstatSync(link).isSymbolicLink() || process.platform === "win32") {
        fs.unlinkSync(link);
      }
    } catch {
      // Already gone.
    }
  }
  if (fs.existsSync(resolved)) {
    const removed = git(repoRoot, ["worktree", "remove", "--force", resolved]);
    if (removed.status !== 0 && fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }
  git(repoRoot, ["worktree", "prune"]);
  for (const name of ["base", "integrated"]) {
    git(repoRoot, ["update-ref", "-d", `${REF_PREFIX}/${ticketId}/${name}`]);
  }
}
