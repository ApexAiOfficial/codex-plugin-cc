import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import { loadModelCatalog } from "../plugins/codex/scripts/lib/models.mjs";
import { resolveStateDir } from "../plugins/codex/scripts/lib/state.mjs";
import { makeTempDir, writeExecutable } from "./helpers.mjs";

function installPagingCodex(binDir, mode) {
  const scriptPath = path.join(binDir, "codex");
  const requestLog = path.join(binDir, "model-list.jsonl");
  writeExecutable(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const mode = ${JSON.stringify(mode)};
const requestLog = ${JSON.stringify(requestLog)};
const args = process.argv.slice(2);
if (args[0] !== "app-server") {
  console.log("codex-cli paging-fixture");
  process.exit(0);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "paging-fixture" } });
  } else if (message.method === "initialized") {
    return;
  } else if (message.method === "model/list") {
    fs.appendFileSync(requestLog, JSON.stringify(message.params) + "\\n");
    const page = message.params.cursor ? Number(message.params.cursor.slice("cursor-".length)) : 0;
    const nextCursor = mode === "repeat" ? "cursor-repeat" : "cursor-" + (page + 1);
    send({ id: message.id, result: { data: [{ id: "model-" + page }], nextCursor } });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config: {} } });
  } else {
    send({ id: message.id, error: { code: -32601, message: "Unsupported method: " + message.method } });
  }
});
`
  );
  return { requestLog, scriptPath };
}

async function exerciseUnfinishedPaging(mode, expectedRequests) {
  const workspaceRoot = makeTempDir(`codex-models-${mode}-workspace-`);
  const pluginData = makeTempDir(`codex-models-${mode}-data-`);
  const binDir = makeTempDir(`codex-models-${mode}-bin-`);
  const { requestLog, scriptPath } = installPagingCodex(binDir, mode);
  const previous = new Map(
    ["CLAUDE_PLUGIN_DATA", "CODEX_COMPANION_CODEX_BIN"].map((name) => [name, process.env[name]])
  );
  process.env.CLAUDE_PLUGIN_DATA = pluginData;
  process.env.CODEX_COMPANION_CODEX_BIN = scriptPath;
  try {
    const catalog = await loadModelCatalog(workspaceRoot);
    const requests = fs.existsSync(requestLog)
      ? fs.readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const cachePath = path.join(resolveStateDir(workspaceRoot), "models.json");

    assert.equal(requests.length, expectedRequests, "the fixture exercised the intended paging boundary");
    assert.equal(catalog, null, "an unfinished catalog is unavailable rather than partial");
    assert.equal(fs.existsSync(cachePath), false, "an unfinished catalog is not cached");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("model discovery rejects a catalog still paginating at the page limit", async () => {
  await exerciseUnfinishedPaging("unique", 10);
});

test("model discovery rejects a repeated paging cursor", async () => {
  await exerciseUnfinishedPaging("repeat", 2);
});
