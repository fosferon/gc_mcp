// GC-7182 test 11: a tools/list racing __reloadNow() never sees a partial set.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import {
  connectPair,
  loadEntry,
  makeToolsCopy,
  startDaemon,
} from "./reload-harness.mjs";

const OLD = '["linear", "deep", "full"]';
const NEW = '["linear", "deep", "full", "atomic"]';

const daemon = await startDaemon(() => ({ status: 200, body: { ok: true } }));
const copy = makeToolsCopy("atomic");
const { mod, server } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});
const { client } = await connectPair(server);

const assertComplete = (listed) => {
  assert.equal(listed.tools.length, 65, "tools/list must never see a partial set");
  const recall = listed.tools.find((tool) => tool.name === "gc_recall");
  const mode = recall.inputSchema.properties.mode.enum;
  const oldModes = JSON.parse(OLD);
  const newModes = JSON.parse(NEW);
  const sameAs = (expected) =>
    mode.length === expected.length && mode.every((value, index) => value === expected[index]);
  assert.ok(
    sameAs(oldModes) || sameAs(newModes),
    `unexpected recall enum during the swap: ${JSON.stringify(mode)}`,
  );
};

try {
  const code = readFileSync(copy.path, "utf8");
  writeFileSync(copy.path, `${code.replace(OLD, NEW)}\n// atomic swap\n`);

  const reload = mod.__reloadNow();
  const during = await Promise.all(
    Array.from({ length: 10 }, () => client.listTools()),
  );
  for (const listed of during) assertComplete(listed);

  await reload;
  assertComplete(await client.listTools());

  process.stdout.write("Verified tools/list never sees a partial swap.\n");
} finally {
  await client.close();
  await daemon.close();
}
