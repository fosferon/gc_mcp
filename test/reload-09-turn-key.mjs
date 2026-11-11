// GC-7182 test 9: the turn-key store lives in the entry, so a retry after a
// reload carries the same idempotency key as the cut-short turn before it.
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { loadEntry, makeToolsCopy, textOf } from "./reload-harness.mjs";

const seen = [];
let holdTurn = true;
const daemon = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : null;
    if (req.url === "/gc/delegations/take") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, outcomes: [] }));
      return;
    }
    seen.push({ url: req.url, body });
    const answer = () => {
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, response: "hi" }));
    };
    if (holdTurn && req.url?.includes("/turn")) setTimeout(answer, 700);
    else answer();
  });
});
await new Promise((done) => daemon.listen(0, "127.0.0.1", done));

const copy = makeToolsCopy("turn-key");
const { mod, callTool } = await loadEntry({
  GC_DAEMON_URL: `http://127.0.0.1:${daemon.address().port}`,
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
  GC_MCP_TURN_TIMEOUT_MS: "300",
});

const turns = () => seen.filter((entry) => entry.url?.includes("/turn"));

try {
  const cut = await callTool("gc_agent_conversation", {
    action: "turn",
    session_id: "s1",
    message: "hello",
  });
  assert.equal(cut.isError, true);
  assert.match(textOf(cut), /idempotency_key/);
  const first = turns().at(-1);
  assert.ok(first, "the first turn must reach the stub");
  const key = first.body.idempotency_key;
  assert.match(key, /^gcmcp-turn-/);

  holdTurn = false;
  await mod.__reloadNow();

  const retry = await callTool("gc_agent_conversation", {
    action: "turn",
    session_id: "s1",
    message: "hello",
  });
  assert.notEqual(retry.isError, true, textOf(retry));

  const second = turns().at(-1);
  assert.equal(
    second.body.idempotency_key,
    key,
    "the retry after a reload must reuse the kept turn key",
  );

  process.stdout.write("Verified turn-key continuity across a reload.\n");
} finally {
  await new Promise((done) => daemon.close(done));
}
