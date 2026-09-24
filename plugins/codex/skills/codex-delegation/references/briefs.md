# Brief templates

The runtime wraps every brief in a work-package contract (role rules, ownership, acceptance, measured sandbox limits, the blocker protocol, and a JSON final report). So the brief covers only what Codex cannot learn quickly from the repository. Aim for 5–25 lines.

## Implement

```text
Objective: <what must be true when done, in one or two sentences, and why>.

Context:
- <decision already made, e.g. "tokens refresh lazily on first 401, not on a timer">
- <interface to honour, e.g. "SessionStore.get(id)/put(id, value) is fixed; do not change it">
- Start from: <paths, not pasted contents>

Constraints:
- <what must not change: public API, schema, file formats, behaviour flags>
- <non-functional: no new dependencies, O(n) memory, keep the error messages>

Done when:
- <observable behaviour>
- <tests that must exist or pass beyond the --accept commands>
```

## Investigate

```text
Question: <the precise thing to establish, e.g. "why does test X fail only under --runInBand">.

Known facts:
- Reproduction: <command and observed output>
- Ruled out: <hypotheses already checked, with evidence>

Scope: read-only. Run targeted commands as needed; do not fix anything.

Answer with: the root cause with file:line evidence, confidence, the smallest fix you would make, and what would falsify your conclusion.
```

To get independent views on an ambiguous bug, give each investigator a different hypothesis or surface, and do not include the lead's current theory.

## Review / pressure test

```text
Target: <the design, module, or change: paths, or "the diff between X and Y">.
Risk focus: <what failure would be expensive: concurrency, data loss, auth bypass, migration rollback>.
Context: <invariants the design relies on>.

Try to break it. Report only material findings with concrete locations and evidence. Say plainly if it holds up.
```

## Follow-up phrasing

Concrete evidence beats restating the task. The failing verification output is attached automatically.

- Failure: `verify fails on refresh-after-expiry: expected no retry, saw 2 calls. Fix the cause; keep the retry policy for 5xx.`
- Blocker resolved: `Unblocked: freezegun 1.5 is now installed in .venv. Continue.`
- Interface change: `Contract changed: SessionStore.get is now async. Adapt the callers you own.`
- Scope correction: `Out of scope: do not touch src/api/. Revert those edits and route the change through the adapter instead.`
- Infrastructure retry: `followup <ticket>` with no text continues from the current state.
