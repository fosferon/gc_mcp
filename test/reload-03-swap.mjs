// GC-7182 test 3: a reload swaps the tools in place, advertises the new enum
// action, validates a call with it, and keeps the connection's x-gc-client id.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  connectPair,
  loadEntry,
  makeToolsCopy,
  startDaemon,
  textOf,
} from "./reload-harness.mjs";

const OLD = '["linear", "deep", "full"]';
const NEW = '["linear", "deep", "full", "reload_test"]';

const daemon = await startDaemon((request) => ({
  status: 200,
  body: { ok: true, mode: request.body?.mode },
}));
const copy = makeToolsCopy("swap");
const { mod, server } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});

const { client } = await connectPair(server);
let notifications = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
  notifications += 1;
});

try {
  const before = await client.callTool({
    name: "gc_recall",
    arguments: { query: "x", mode: "linear" },
  });
  assert.notEqual(before.isError, true, textOf(before));
  const beforeClient = daemon.requests.filter((r) => r.url === "/gc/recall").at(-1)
    .headers["x-gc-client"];

  const code = readFileSync(copy.path, "utf8");
  assert.ok(code.includes(OLD), "expected the original recall enum in the copy");
  writeFileSync(copy.path, `${code.replace(OLD, NEW)}\n// reload test\n`);

  await mod.__reloadNow();

  for (let i = 0; i < 100 && notifications === 0; i += 1) {
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.equal(notifications, 1, "client must receive one tools/list_changed");

  const listed = await client.listTools();
  const recall = listed.tools.find((tool) => tool.name === "gc_recall");
  assert.ok(
    recall.inputSchema.properties.mode.enum.includes("reload_test"),
    "tools/list must show the new enum action",
  );

  const after = await client.callTool({
    name: "gc_recall",
    arguments: { query: "x", mode: "reload_test" },
  });
  assert.notEqual(after.isError, true, textOf(after));

  const afterClient = daemon.requests.filter((r) => r.url === "/gc/recall").at(-1)
    .headers["x-gc-client"];
  assert.equal(afterClient, beforeClient, "the connection id survives the swap");

  process.stdout.write("Verified in-place swap, new action and stable x-gc-client.\n");
} finally {
  await client.close();
  await daemon.close();
}
