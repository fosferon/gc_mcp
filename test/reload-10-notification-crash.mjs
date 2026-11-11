// GC-7182 test 10: a reload sends exactly one tools/list_changed per server,
// and a rejecting client transport does not become an unhandled rejection.
import assert from "node:assert/strict";

import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  connectPair,
  loadEntry,
  makeToolsCopy,
  startDaemon,
} from "./reload-harness.mjs";

const daemon = await startDaemon(() => ({ status: 200, body: { ok: true } }));
const copy = makeToolsCopy("notification");
const { mod, server } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});
const { client } = await connectPair(server);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
let notifications = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
  notifications += 1;
});

try {
  await mod.__reloadNow();
  for (let i = 0; i < 100 && notifications === 0; i += 1) await sleep(5);
  assert.equal(notifications, 1, "one caught notification after the swap");

  const transport = server.server.transport;
  const originalSend = transport.send.bind(transport);
  let attempts = 0;
  transport.send = async (message) => {
    if (message?.method === "notifications/tools/list_changed") {
      attempts += 1;
      throw new Error("client transport is dead");
    }
    return originalSend(message);
  };

  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await mod.__reloadNow();
    await sleep(100);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    transport.send = originalSend;
  }

  assert.equal(attempts, 1, "exactly one send attempt on the dead transport");
  assert.equal(unhandled, 0, "a dead client must not raise unhandledRejection");

  process.stdout.write("Verified one caught notification per reload.\n");
} finally {
  await client.close();
  await daemon.close();
}
