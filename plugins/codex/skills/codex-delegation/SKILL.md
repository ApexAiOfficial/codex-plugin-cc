---
name: codex-delegation
description: This skill should be used when Claude leads a substantial engineering work order that has a separable, repo-local part Codex could build or investigate in parallel ("implement this", "build the feature", "fix these bugs", "refactor X and add tests", "work on this in parallel"), when the user asks to "delegate to Codex", "have Codex do it", "use Codex as a second engineer", or wants an independent root-cause investigation, alternative implementation, second opinion, or pressure test from Codex, and when open Codex tickets exist and must be verified, followed up, integrated, or closed.
user-invocable: false
---

# Codex as a Parallel Engineer

Codex runs as a durable peer engineer. Claude stays lead: it decomposes the work, owns integration and final acceptance, and verifies every result from evidence. Each delegated package is a **ticket**, a named work order bound to one persistent Codex thread. It survives Claude sessions, `/clear`, compaction, and restarts until Claude closes it.

Runtime: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" <command>`. The same path is exported to Bash as `$CODEX_COMPANION`, which is the form to use after compaction. Examples below use `$CODEX_COMPANION`.

## Decide whether to delegate

Delegate only when parallel work shortens the critical path to a correct result. Choosing not to delegate is a valid, common outcome.

Delegate a package when **all** of these hold:
- It is substantial (roughly 15+ minutes of focused work) and separable from Claude's own lane, meaning disjoint files or a clean interface boundary.
- It is repo-local: it needs only code, the existing dependencies, and local tests.
- It can be described by outcome, with acceptance checks Claude can run independently.
- Claude has other genuinely useful work to do meanwhile, or wants an independent second view.

Keep these with Claude, never delegated: dependency installation, anything needing the network (package registries, external APIs, remote git), secrets and credentials, deployment, environment provisioning, Docker-backed services, final integration, and acceptance. The Codex sandbox has no network by default and a read-only `.git` (no staging or commits). When unsure what the sandbox can run, measure it rather than guessing:

```bash
node "$CODEX_COMPANION" preflight --check "npm test -- --listTests"
```

It reports what differs between the host and the sandbox (network, Docker daemon, missing tools) and whether each `--check` command works there. Nothing is sent to the model.

Good packages include a self-contained module with its tests, a bounded refactor behind a stable interface, test coverage for existing code, an investigation of a bug with unclear root cause, a competing prototype for a risky design choice, and an adversarial review of a high-blast-radius change (auth, concurrency, migrations, data loss, public APIs).

Poor packages include tiny fixes, work that needs constant back-and-forth, changes to the same files Claude is editing, and anything whose "done" cannot be checked.

## Run the loop

1. **Delegate** with a lean brief (see below):

   ```bash
   node "$CODEX_COMPANION" delegate --ticket token-refresh \
     --owns src/auth/refresh.ts --owns tests/auth/ \
     --accept "npm test -- tests/auth" \
     --brief-file /tmp/brief.md
   ```

   Roles: `--role implement` (default, write), `--role investigate` or `--role review` (read-only; findings instead of edits). Isolation: default `shared` (Codex edits this checkout, so ownership must be disjoint from Claude's lane) or `--isolation worktree` (a private worktree created from the current state, uncommitted changes included, and integrated back later). `--network` grants network access deliberately and visibly; never add it just to get past a blocker without deciding that is right. Up to 3 tickets run at once (`setup --max-parallel`).

2. **Continue Claude's own lane immediately.** Do not poll. The ticket monitor posts a notification when a turn finishes, where the host supports monitors. Otherwise start one background waiter right after delegating: `Bash(run_in_background: true)` with `node "$CODEX_COMPANION" wait token-refresh`. The Stop hook is a last-resort reminder for finished work that nothing surfaced.

3. **Redirect mid-flight when something changes** (an interface decision, a corrected assumption, an abandoned path), without restarting the thread:

   ```bash
   node "$CODEX_COMPANION" steer token-refresh "The session store API is now get(id)/put(id, value); adapt to it."
   ```

4. **Review the finished turn.** The completion card shows the outcome (`completed`, `partial`, `blocked`, `failed`, or an infrastructure class such as `quota` or `transient`), the summary, attributed file changes, ownership violations, blockers, and claim checks, where Codex claimed a test passed but no matching command was observed or it exited non-zero. Drill down only as needed: `show <ticket>` for the full report, `show <ticket> --commands` for the command trace, `show <ticket> --command N` for one command's output.

5. **Verify independently.** "Codex says done" is not acceptance.

   ```bash
   node "$CODEX_COMPANION" verify token-refresh
   ```

   This runs the acceptance commands outside the sandbox (in the worktree before integration, in the checkout after), re-checks ownership over everything the ticket changed, and records the result on the ticket. Then read the actual diff (`git diff`, or the files inside the worktree) and judge the semantics yourself: correctness, fit with the architecture, test quality, and scope creep.

6. **Return concrete failures to the same thread** before reclaiming the work:

   ```bash
   node "$CODEX_COMPANION" followup token-refresh "verify fails: refresh on an expired token must not retry. Fix the cause, keep the API."
   ```

   The failing output from the last `verify` is attached automatically. Resolve blockers first: install the dependency, provide the fixture, or make the interface decision, then follow up with "Unblocked: …". After three or four unproductive turns, re-scope or reclaim the work instead of retrying.

7. **Integrate worktree tickets** with `integrate <ticket>`. It performs a per-file three-way merge into the checkout and never touches the index. It writes nothing if any file conflicts, unless `--allow-conflicts` is given. Shared tickets are already in the checkout.

8. **Run combined validation** (the full relevant test suite, build, and lint) on the integrated state. Package success does not prove integration success.

9. **Close with a decision and a reason**; the reason is kept as an audit record:

   ```bash
   node "$CODEX_COMPANION" close token-refresh --accepted --reason "tests pass; adopted as-is"
   ```

   `--rejected` and `--abandoned` keep a worktree for inspection (`close <ticket> --purge` removes it later). Accepting removes it.

## Write the brief

Delegate outcomes, not keystrokes. The runtime already wraps the brief in a work-package contract covering role, ownership, acceptance, measured environment limits, a blocker protocol, and a structured final report. So the brief itself should contain only:

- **Objective**: what must be true when done, and why it matters.
- **Context Codex cannot infer quickly**: decisions already made, interfaces to honour, relevant files as starting points (paths, not pasted contents), known pitfalls.
- **Constraints**: what not to change, compatibility requirements, performance or security expectations.
- **Definition of done**, in addition to the `--accept` commands.

Keep it to 5–25 lines. Codex reads the repository itself, so do not paste source files or dictate step-by-step edits. See `references/briefs.md` for role-specific templates.

## Use independent peer modes

- **Root-cause investigation**: `--role investigate` with the symptom, reproduction, and hypotheses already ruled out. For ambiguous bugs, run it while Claude pursues a different hypothesis, then compare evidence before anyone edits code.
- **Second opinion or pressure test**: `--role review` on a specific design or diff, with the risk to focus on. Use it where mistakes have a large blast radius, not on routine changes. For reviewing the git diff itself, `/codex:review` and `/codex:adversarial-review` also exist.
- **Competing prototype**: an implement ticket with `--isolation worktree` for a consequential design choice. Compare real results before choosing.

Keep independence intact before synthesis: do not feed Codex Claude's conclusion when the goal is an independent view.

## Keep ownership honest

- Declare `--owns` for every write ticket and keep Claude's own edits outside it. The runtime warns when declared ownerships of open tickets overlap. Change the decomposition rather than accept a likely collision.
- Use `--interface` to name contracts the ticket owns (for example "SessionStore API"), so shared logical boundaries are explicit even when files are disjoint.
- In a shared checkout, Claude's own edits show up as "also changed during the turn". That is expected, not a Codex violation.
- Prefer `--isolation worktree` when Claude will edit near the package, or for prototypes. Prefer `shared` when dependencies are editable-installed or linked monorepo workspaces, since a worktree's symlinked dependencies can resolve to the main checkout's code. See `references/isolation.md`.

## Recover after interruptions

Ticket state lives outside Claude's context. After compaction, restart, or `/clear`, the session start lists open tickets. Run `node "$CODEX_COMPANION" tickets` for the ledger and `show <ticket>` for details. Repository evidence (the diff, test results, the ticket record) outranks recollection. A worker that died is reported as `worker-lost`, and `followup` continues the same thread.

Stop a ticket with `node "$CODEX_COMPANION" cancel <ticket>`. The live turn is interrupted cleanly first, and the verified process tree is terminated only if it does not exit.

## Additional resources

- **`references/commands.md`**: every ticket command, its flags, and its output.
- **`references/briefs.md`**: brief templates for implement, investigate, and review tickets, and follow-up phrasing.
- **`references/isolation.md`**: choosing shared vs worktree, dependency caveats, and integration mechanics.
