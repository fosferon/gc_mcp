// GC-7182 test 7: an entry change is permanent and wins over other notices.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadEntry,
  repoRoot,
  startDaemon,
  textOf,
} from "./reload-harness.mjs";

const daemon = await startDaemon(() => ({ status: 200, body: { ok: true } }));
const dir = mkdtempSync(join(repoRoot, ".tmp", "gc7182-entry-"));
const entryPath = join(dir, "entry.js");
writeFileSync(entryPath, "// entry\n");

const { mod, callTool } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_ENTRY_PATH: entryPath,
  GC_MCP_RELOAD: "0",
});

try {
  writeFileSync(entryPath, "// entry rebuilt\n");

  await mod.__pollOnce();
  const before = await callTool("gc_recall", { query: "x" });
  assert.equal(
    before.content.some((item) => item.text?.includes("entry was rebuilt")),
    false,
    "one poll must not mark the entry changed",
  );

  await mod.__pollOnce();
  const after = await callTool("gc_recall", { query: "x" });
  assert.notEqual(after.isError, true, textOf(after));
  assert.ok(
    after.content.some((item) =>
      item.text?.includes(
        "[gc_mcp] The gc_mcp entry was rebuilt; reconnect the gc MCP server to load it.",
      ),
    ),
    "the entry_changed notice must reach the next result",
  );

  process.stdout.write("Verified the entry_changed notice after two polls.\n");
} finally {
  await daemon.close();
}
