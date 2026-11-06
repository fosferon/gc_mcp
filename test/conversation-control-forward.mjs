// GC-6985/6986: gc_conversation reaches the daemon's turn controls. `stop` and
// `release_effect_fence` POST to their routes, `effect_fence` GETs the fence,
// and cut_in carries its `mode` (zod strips unknown keys, so a missing schema
// field would silently drop it and every cut-in would be a queue).
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

let callToolHandler = null;
const seen = [];
const daemon = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, answered: req.url }));
  });
});
await new Promise((done) => daemon.listen(0, "127.0.0.1", done));
process.env.GC_DAEMON_URL = `http://127.0.0.1:${daemon.address().port}`;

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
    callToolHandler({ method: "tools/call", params: { name: "gc_conversation", arguments: args } }, {});

  await call({ action: "stop", session_id: "s 1" });
  assert.deepEqual(seen.at(-1), { url: "/gc/conversation/s%201/stop", method: "POST", body: {} });

  await call({ action: "release_effect_fence", id: "s1" });
  assert.deepEqual(seen.at(-1), {
    url: "/gc/conversation/s1/release_effect_fence",
    method: "POST",
    body: {},
  });

  await call({ action: "effect_fence", session_id: "s1" });
  assert.equal(seen.at(-1).url, "/gc/conversation/s1/effect_fence");
  assert.equal(seen.at(-1).method, "GET");

  await call({ action: "cut_in", session_id: "s1", message: "change course", mode: "interrupt" });
  assert.equal(seen.at(-1).url, "/gc/conversation/s1/cut_in");
  assert.equal(seen.at(-1).body.mode, "interrupt");
  assert.equal(seen.at(-1).body.message, "change course");

  const before = seen.length;
  const missing = await call({ action: "stop" });
  assert.equal(seen.length, before, "no request without a session id");
  assert.match(missing.content[0].text, /session_id/);

  process.stdout.write("gc_conversation stop / effect_fence / release_effect_fence / cut_in mode reach the daemon.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  daemon.close();
}
