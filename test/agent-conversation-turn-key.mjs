// GC-7152: gc_agent_conversation turn carries an idempotency_key (the caller's,
// or one gc_mcp generates), waits a turn-sized deadline, and on a client-side
// timeout reports the key so a retry cannot send the turn twice.
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

let callToolHandler = null;
const seen = [];
let delayMs = 0;
const daemon = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/gc/delegations/take") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, items: [] }));
      return;
    }
    seen.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, response: "hi" }));
    }, delayMs);
  });
});
await new Promise((done) => daemon.listen(0, "127.0.0.1", done));
process.env.GC_DAEMON_URL = `http://127.0.0.1:${daemon.address().port}`;
process.env.GC_MCP_TURN_TIMEOUT_MS = "300";

const originalConnect = McpServer.prototype.connect;
const originalSetRequestHandler = Server.prototype.setRequestHandler;
try {
  McpServer.prototype.connect = async function () {};
  Server.prototype.setRequestHandler = function (schema, handler) {
    const literal = schema?._def?.shape?.method;
    const method = literal?.values ? [...literal.values][0] : literal?._def?.value;
    if (method === "tools/call") callToolHandler = handler;
    return originalSetRequestHandler.call(this, schema, handler);
  };
  await import("../dist/index.js");
  assert.ok(callToolHandler, "Failed to capture tools/call handler");

  const call = (args) =>
    callToolHandler(
      { method: "tools/call", params: { name: "gc_agent_conversation", arguments: args } },
      {},
    );
  const textOf = (r) => r.content.map((c) => c.text).join("");

  // no key: one is generated and sent
  await call({ action: "turn", session_id: "s1", message: "hello" });
  const sent = seen.at(-1);
  assert.equal(sent.url, "/gc/agent_conversation/s1/turn");
  assert.equal(sent.body.message, "hello");
  assert.match(sent.body.idempotency_key, /^gcmcp-turn-[0-9a-f-]{36}$/);

  // the caller's key is forwarded unchanged
  await call({ action: "turn", session_id: "s1", message: "again", idempotency_key: "mine-1" });
  assert.equal(seen.at(-1).body.idempotency_key, "mine-1");

  // two calls without a key get different keys (a new turn is not a retry)
  await call({ action: "turn", session_id: "s1", message: "hello" });
  assert.notEqual(seen.at(-1).body.idempotency_key, sent.body.idempotency_key);

  // a client-side timeout names the key to retry with
  delayMs = 1000;
  const timedOut = await call({ action: "turn", session_id: "s1", message: "slow" });
  const key = seen.at(-1).body.idempotency_key;
  assert.equal(timedOut.isError, true);
  assert.ok(textOf(timedOut).includes(`idempotency_key "${key}"`), textOf(timedOut));
  assert.ok(textOf(timedOut).includes("turn_in_progress"));

  // an over-long key is refused by the schema before anything is sent
  const before = seen.length;
  const bad = await call({
    action: "turn",
    session_id: "s1",
    message: "x",
    idempotency_key: "k".repeat(129),
  }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal(bad.isError, true);
  assert.equal(seen.length, before);

  console.log("agent-conversation-turn-key: ok");
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  daemon.closeAllConnections?.();
  daemon.close();
}
