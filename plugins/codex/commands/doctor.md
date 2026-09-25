---
description: Diagnose Codex Companion runtime, state, broker, worker, ticket, and worktree health without changing anything
argument-hint: '[--json] [--cwd <path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" doctor "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve every OK, WARN, FAIL, and fix hint exactly as reported.
