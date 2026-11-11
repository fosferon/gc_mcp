// GC-7182 test 5: a tools.js that throws on import leaves the old tools in
// place, and the next successful result carries the failed notice.
import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";

import {
  loadEntry,
  makeToolsCopy,
  startDaemon,
  textOf,
  wire,
} from "./reload-harness.mjs";

const daemon = await startDaemon(() => ({ status: 200, body: { ok: true } }));
const copy = makeToolsCopy("failed");
const { mod, callTool, listTools } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});

try {
  const before = wire(await listTools());

  writeFileSync(copy.path, 'throw new Error("boom");\n');
  const stamp = new Date(Date.now() + 2_000);
  utimesSync(copy.path, stamp, stamp);

  await mod.__reloadNow();

  assert.deepEqual(wire(await listTools()), before, "failed reload changed tools/list");

  const result = await callTool("gc_recall", { query: "x" });
  assert.notEqual(result.isError, true, textOf(result));
  assert.ok(
    result.content.some((item) =>
      item.text?.includes("[gc_mcp] A newer build failed to load (boom)"),
    ),
    "the failed notice must reach the next successful result",
  );
  const failedText = result.content.find((item) => item.text?.startsWith("[gc_mcp]")).text;
  assert.match(
    failedText,
    /^\[gc_mcp\] A newer build failed to load \(boom\); still serving tools\.js@\S+\.$/,
    "the failed notice text is exactly the design §2.3 text",
  );

  process.stdout.write("Verified a failed reload keeps the old tools and reports.\n");
} finally {
  await daemon.close();
}
