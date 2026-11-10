// GC-7153: gc_conversation turn carries an idempotency_key like
// gc_agent_conversation (GC-7152): the caller's, or one generated and kept per
// connection, route, session and message; a turn-sized deadline; a cut-short
// names the key. The two routes never share a generated key.
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
      res.end(JSON.stringify({ ok: true, outcomes: [] }));
      return;
    }
    seen.push({ url: req.url, body: body ? JSON.parse(body) : null });
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reply: "hi", done: true, tool_calls: [] }));
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

  const call = (name, args) =>
    callToolHandler({ method: "tools/call", params: { name, arguments: args } }, {});
  const textOf = (r) => r.content.map((c) => c.text).join("");

  // a generated key is sent on the /gc/conversation turn route
  await call("gc_conversation", { action: "turn", session_id: "s1", message: "hello" });
  assert.equal(seen.at(-1).url, "/gc/conversation/s1/turn");
  assert.match(seen.at(-1).body.idempotency_key, /^gcmcp-turn-[0-9a-f-]{36}$/);

  // the caller's key is forwarded unchanged
  await call("gc_conversation", { action: "turn", session_id: "s1", message: "x", idempotency_key: "mine" });
  assert.equal(seen.at(-1).body.idempotency_key, "mine");

  // a cut-short names the key, and the resend reuses it
  delayMs = 1000;
  const cut = await call("gc_conversation", { action: "turn", session_id: "s2", message: "slow" });
  const k = seen.at(-1).body.idempotency_key;
  assert.equal(cut.isError, true);
  assert.ok(textOf(cut).includes(`idempotency_key "${k}"`), textOf(cut));
  delayMs = 0;
  await call("gc_conversation", { action: "turn", session_id: "s2", message: "slow" });
  assert.equal(seen.at(-1).body.idempotency_key, k);

  // the two routes never share a generated key for the same session and message
  delayMs = 1000;
  await call("gc_conversation", { action: "turn", session_id: "s3", message: "m" });
  const kConv = seen.at(-1).body.idempotency_key;
  delayMs = 0;
  await call("gc_agent_conversation", { action: "turn", session_id: "s3", message: "m" });
  assert.equal(seen.at(-1).url, "/gc/agent_conversation/s3/turn");
  assert.notEqual(seen.at(-1).body.idempotency_key, kConv);

  // submit_tool_results and cut_in are unchanged: no key is added
  await call("gc_conversation", { action: "submit_tool_results", session_id: "s1", tool_results: [] });
  assert.equal(seen.at(-1).url, "/gc/conversation/s1/tool_results");
  assert.equal(seen.at(-1).body.idempotency_key, undefined);

  console.log("conversation-turn-key: ok");
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  daemon.closeAllConnections?.();
  daemon.close();
}
