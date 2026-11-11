// GC-7182 test 6: the reloaded notice rides successful results until the
// client re-lists; an error result never carries a notice.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import {
  connectPair,
  loadEntry,
  makeToolsCopy,
  startDaemon,
  textOf,
} from "./reload-harness.mjs";

let fail = false;
const daemon = await startDaemon(() =>
  fail ? { status: 500, body: { ok: false } } : { status: 200, body: { ok: true } },
);
const copy = makeToolsCopy("notice");
const { mod, server } = await loadEntry({
  GC_DAEMON_URL: daemon.url,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});
const { client } = await connectPair(server);

const hasReloadedNotice = (result) =>
  result.content.some((item) =>
    item.text?.startsWith("[gc_mcp] Tools were reloaded from a newer build"),
  );

try {
  const code = readFileSync(copy.path, "utf8");
  writeFileSync(
    copy.path,
    `${code.replace(
      '["linear", "deep", "full"]',
      '["linear", "deep", "full", "reload_test"]',
    )}\n// notice lifecycle\n`,
  );
  await mod.__reloadNow();

  const success = await client.callTool({
    name: "gc_recall",
    arguments: { query: "x" },
  });
  assert.notEqual(success.isError, true, textOf(success));
  assert.ok(hasReloadedNotice(success), "a post-reload result carries the notice");
  const reloadedText = success.content.find((item) => item.text?.startsWith("[gc_mcp]")).text;
  assert.match(
    reloadedText,
    /^\[gc_mcp\] Tools were reloaded from a newer build \(tools\.js@\S+ → tools\.js@\S+\)\. If an action you expect is refused as unknown, reconnect the gc MCP server\.$/,
    "the reloaded notice text is exactly the design §2.3 text",
  );

  fail = true;
  const error = await client.callTool({
    name: "gc_recall",
    arguments: { query: "x" },
  });
  assert.equal(error.isError, true);
  assert.equal(hasReloadedNotice(error), false, "an error result never carries a notice");
  fail = false;

  await client.listTools();

  const afterRelist = await client.callTool({
    name: "gc_recall",
    arguments: { query: "x" },
  });
  assert.notEqual(afterRelist.isError, true, textOf(afterRelist));
  assert.equal(
    afterRelist.content.some((item) => item.text?.startsWith("[gc_mcp]")),
    false,
    "re-listing clears the reloaded notice",
  );

  process.stdout.write("Verified the reloaded notice lifecycle.\n");
} finally {
  await client.close();
  await daemon.close();
}
