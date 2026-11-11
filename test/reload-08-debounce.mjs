// GC-7182 test 8: one poll that sees a change does not reload; two agreeing
// polls do.
import assert from "node:assert/strict";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";

import {
  loadEntry,
  makeToolsCopy,
  startDaemon,
} from "./reload-harness.mjs";

const OLD = '["linear", "deep", "full"]';
const NEW = '["linear", "deep", "full", "debounced"]';

const daemon = await startDaemon(() => ({ status: 200, body: { ok: true } }));
const copy = makeToolsCopy("debounce");
const { mod, listTools } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});

const enumValues = async () => {
  const result = await listTools();
  return result.tools.find((tool) => tool.name === "gc_recall").inputSchema.properties.mode
    .enum;
};

try {
  assert.deepEqual(await enumValues(), ["linear", "deep", "full"]);

  const code = readFileSync(copy.path, "utf8");
  writeFileSync(copy.path, `${code.replace(OLD, NEW)}\n// debounce\n`);
  const stamp = new Date(Date.now() + 3_000);
  utimesSync(copy.path, stamp, stamp);

  await mod.__pollOnce();
  assert.deepEqual(
    await enumValues(),
    ["linear", "deep", "full"],
    "one poll must not reload",
  );

  await mod.__pollOnce();
  assert.deepEqual(
    await enumValues(),
    ["linear", "deep", "full", "debounced"],
    "two agreeing polls must reload",
  );

  process.stdout.write("Verified the two-poll debounce.\n");
} finally {
  await daemon.close();
}
