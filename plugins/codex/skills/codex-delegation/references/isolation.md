# Shared checkout vs isolated worktree

## Shared (default)

Codex edits the same working tree as Claude.

- Best for disjoint ownership (`--owns`) where Claude works elsewhere in the repo.
- The environment is exactly the lead's: installed dependencies, editable installs, and monorepo links all behave normally.
- Evidence: the runtime snapshots the working tree before and after each turn. Files Codex reported editing are attributed to it. Other files that changed during the turn show as unattributed: either Claude's own edits, or Codex editing through a shell command.
- Risk: while Claude is mid-edit, Codex's test runs can see half-finished code, and the other way round. The work-package contract tells Codex that failures outside its ownership are not its to fix.
- Nothing to integrate. The changes are already in the checkout; verify, then run combined validation.

## Worktree (`--isolation worktree`)

Codex works in a private git worktree under the plugin data directory.

- Created from a snapshot of the lead's current working tree, including uncommitted and untracked (non-ignored) files, so Codex starts from what Claude sees now, not from `HEAD`. The lead's index is never touched.
- Ignored dependency directories (`node_modules`, `.venv`, `venv`) are symlinked from the main checkout so tests can run offline. They are read-only from inside the sandbox.
- All changes in the worktree are attributable to Codex, so ownership checks are exact.
- Best for Claude editing near the package, competing prototypes, or risky changes you may discard.

### Dependency caveats

Because dependency directories are shared by symlink, some setups resolve imports to the *main checkout's* code instead of the worktree's:

- Python packages installed in editable/develop mode (`pip install -e .`, `uv pip install -e`) import from the main checkout.
- JavaScript monorepo workspace packages linked into `node_modules` (npm, yarn, or pnpm workspaces) resolve to the main checkout's package sources.

In those repositories, tests run in the worktree may exercise the wrong code. Prefer `shared` isolation, or limit worktree tickets to leaf code that is imported by relative path.

### Integration mechanics

`integrate <ticket>` computes, per file, base (the last integration point), ours (the lead's checkout now), and theirs (the worktree now):

- ours == base → take theirs (add, modify, or delete).
- ours == theirs → nothing to do.
- both changed text → `git merge-file`; a clean merge is taken.
- overlapping edits, binary/symlink conflicts, or delete-vs-modify → conflict.

Any conflict aborts the whole integration with nothing written, unless `--allow-conflicts` is given (conflict markers are written into text files). After integrating, the integration point advances, so a later `followup` plus `integrate` applies only the new delta. If `HEAD` moved since the ticket started, the output says so; re-run combined validation either way.

Resolving conflicts: either merge by hand using the worktree files (`show <ticket>` prints the worktree path), or send the ticket back with `followup` describing the lead's changes it must adapt to, then integrate again.
