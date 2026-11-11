// GC-7182 test 7: an entry change is permanent and wins over other notices.
import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  loadEntry,
  makeScratchDir,
  makeToolsCopy,
  startDaemon,
  textOf,
} from "./reload-harness.mjs";

const daemon = await startDaemon(() => ({ status: 200, body: { ok: true } }));
const dir = makeScratchDir("entry");
const copy = makeToolsCopy("entry-tools");
const entryPath = join(dir, "entry.js");
writeFileSync(entryPath, "// entry\n");

const { mod, callTool } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_ENTRY_PATH: entryPath,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});

const ENTRY_TEXT =
  "[gc_mcp] The gc_mcp entry was rebuilt; reconnect the gc MCP server to load it.";

try {
  // A tools reload first, so a `reloaded` notice is active when the entry changes.
  writeFileSync(copy.path, `${readFileSync(copy.path, "utf8")}\n// precedence\n`);
  const stamp = new Date(Date.now() + 2_000);
  utimesSync(copy.path, stamp, stamp);
  await mod.__reloadNow();
  const reloaded = await callTool("gc_recall", { query: "x" });
  assert.ok(
    reloaded.content.some((item) => item.text?.startsWith("[gc_mcp] Tools were reloaded")),
    "a reloaded notice is active before the entry changes",
  );

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
  const notices = after.content.filter((item) => item.text?.startsWith("[gc_mcp]"));
  assert.deepEqual(
    notices.map((item) => item.text),
    [ENTRY_TEXT],
    "exactly one notice, the entry_changed text, wins over the active reloaded notice",
  );

  process.stdout.write("Verified the entry_changed notice after two polls and its precedence.\n");
} finally {
  await daemon.close();
}
