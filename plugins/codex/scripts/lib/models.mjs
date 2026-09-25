import fs from "node:fs";
import path from "node:path";

import { withCodexClient } from "./codex.mjs";
import { writeJsonAtomic } from "./locking.mjs";
import { resolveStateDir } from "./state.mjs";

// Model discovery through the app-server (`model/list`, `config/read`); no model is called. The
// runtime hardcodes no model generations: what exists, which efforts each model supports, and the
// user's configured default all come from Codex itself.
const CATALOG_FILE = "models.json";
const CATALOG_TTL_MS = 30 * 60 * 1000;
const MAX_PAGES = 10;

function catalogPath(workspaceRoot) {
  return path.join(resolveStateDir(workspaceRoot), CATALOG_FILE);
}

export function readCachedModelCatalog(workspaceRoot) {
  try {
    const catalog = JSON.parse(fs.readFileSync(catalogPath(workspaceRoot), "utf8"));
    return Date.now() - Date.parse(catalog.at) <= CATALOG_TTL_MS ? catalog : null;
  } catch {
    return null;
  }
}

function summarizeModel(entry) {
  return {
    id: entry.id ?? entry.model,
    description: entry.description ?? null,
    isDefault: Boolean(entry.isDefault),
    hidden: Boolean(entry.hidden),
    efforts: (entry.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort).filter(Boolean),
    defaultEffort: entry.defaultReasoningEffort ?? null
  };
}

export async function fetchModelCatalog(workspaceRoot, { cwd = workspaceRoot } = {}) {
  const catalog = await withCodexClient(
    cwd,
    async (client) => {
      const models = [];
      const cursors = new Set();
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        // Hidden models are included so a valid explicit --model is never rejected.
        const response = await client.request("model/list", { includeHidden: true, ...(cursor ? { cursor } : {}) });
        models.push(...(response.data ?? []).map(summarizeModel));
        cursor = response.nextCursor ?? null;
        if (!cursor || cursors.has(cursor)) {
          break;
        }
        cursors.add(cursor);
      }
      if (cursor) {
        // A partial list would reject valid models; report discovery as unavailable instead.
        throw new Error("model/list did not finish paging");
      }
      // Only the two fields we need: the effective config can hold credentials (MCP env, tokens).
      let configured = { model: null, effort: null };
      try {
        const { config } = await client.request("config/read", { cwd });
        configured = { model: config?.model ?? null, effort: config?.model_reasoning_effort ?? null };
      } catch {
        // Older app-servers lack config/read; the account default still applies.
      }
      return { at: new Date().toISOString(), models, configured };
    },
    { direct: true }
  );
  try {
    writeJsonAtomic(catalogPath(workspaceRoot), catalog);
  } catch {
    // The cache is an optimization only.
  }
  return catalog;
}

/** The cached catalog, or a fresh one; null when discovery is unavailable (old CLI, offline). */
export async function loadModelCatalog(workspaceRoot, options = {}) {
  return readCachedModelCatalog(workspaceRoot) ?? (await fetchModelCatalog(workspaceRoot, options).catch(() => null));
}

/**
 * Check an explicit --model/--effort against what Codex offers, before a turn is spent on it.
 * Returns an error message, or null when the choice is valid or cannot be checked.
 */
export function validateModelChoice(catalog, { model = null, effort = null } = {}) {
  if (!catalog?.models?.length || (!model && !effort)) {
    return null;
  }
  const available = catalog.models.filter((entry) => !entry.hidden).map((entry) => entry.id).join(", ");
  const resolvedId = model ?? catalog.configured?.model ?? catalog.models.find((entry) => entry.isDefault)?.id ?? null;
  const chosen = catalog.models.find((entry) => entry.id === resolvedId) ?? null;
  if (model && !chosen) {
    return `Codex does not offer model "${model}" to this account. Available: ${available}.`;
  }
  if (effort && chosen?.efforts.length && !chosen.efforts.includes(effort)) {
    return `Model ${chosen.id} does not support effort "${effort}". Supported: ${chosen.efforts.join(", ")}.`;
  }
  return null;
}

export function renderModelCatalog(catalog) {
  if (!catalog?.models?.length) {
    return ["Models: unavailable (this Codex CLI does not support model discovery)."];
  }
  const configured = catalog.configured?.model
    ? `${catalog.configured.model}${catalog.configured.effort ? ` at ${catalog.configured.effort} effort` : ""} (from Codex config)`
    : `${catalog.models.find((entry) => entry.isDefault)?.id ?? "account default"} (account default)`;
  const lines = [`Models: tickets use ${configured} unless --model/--effort is given.`];
  for (const entry of catalog.models.filter((candidate) => !candidate.hidden)) {
    lines.push(`- ${entry.id}${entry.isDefault ? " (account default)" : ""}: ${entry.description ?? ""} Efforts: ${entry.efforts.join(", ") || "unknown"}.`);
  }
  return lines;
}
