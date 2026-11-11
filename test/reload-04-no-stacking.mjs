// GC-7182 test 4: after three reloads neither the delivery take nor the notice
// stacks — one successful call produces exactly one take and one notice item.
import assert from "node:assert/strict";
import { utimesSync, writeFileSync } from "node:fs";

import {
  connectPair,
  loadEntry,
  makeToolsCopy,
  startDaemon,
  textOf,
} from "./reload-harness.mjs";

const daemon = await startDaemon(() => ({ status: 200, body: { ok: true } }));
const copy = makeToolsCopy("stacking");
const { mod, server } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});
const { client } = await connectPair(server);

try {
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(copy.path, `\n// reload ${i}\n`, { flag: "a" });
    const stamp = new Date(Date.now() + (i + 1) * 1_000);
    utimesSync(copy.path, stamp, stamp);
    await mod.__reloadNow();
  }

  daemon.requests.length = 0;
  const result = await client.callTool({
    name: "gc_recall",
    arguments: { query: "x" },
  });
  assert.notEqual(result.isError, true, textOf(result));

  const takes = daemon.requests.filter((r) => r.url === "/gc/delegations/take");
  assert.equal(takes.length, 1, "exactly one delegation take per call");

  const notices = result.content.filter((item) =>
    item.text?.startsWith("[gc_mcp] Tools were reloaded"),
  );
  assert.equal(notices.length, 1, "exactly one reloaded notice per result");

  process.stdout.write("Verified one take and one notice after three reloads.\n");
} finally {
  await client.close();
  await daemon.close();
}
