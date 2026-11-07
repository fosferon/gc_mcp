// gc_lease `run` reaches POST /gc/lease with exactly the caller's
// parameters (coerced types, no extras, nothing dropped), including the
// `wait: true` path, and the daemon's answer comes back unchanged.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

let callToolHandler = null;
const seen = [];
const daemon = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ url: req.url, method: req.method, body: JSON.parse(body || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, job_id: "j1", status: "queued", position: 2, resource: "host:heavy" }));
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
    callToolHandler({ method: "tools/call", params: { name: "gc_lease", arguments: args } }, {});

  // fire-and-forget form
  const testCwd = join(tmpdir(), "gc-mcp-lease-test");
  let result = await call({ action: "run", command: "mix test", cwd: testCwd, issue: "EX-1", timeout_ms: "5000" });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    url: "/gc/lease",
    method: "POST",
    body: { action: "run", command: "mix test", cwd: testCwd, issue: "EX-1", timeout_ms: 5000 },
  });
  const answer = JSON.parse(result.content[0].text);
  assert.deepEqual(answer, { ok: true, job_id: "j1", status: "queued", position: 2, resource: "host:heavy" });

  // wait:true form (no client-side timeout path) forwards the same way, wait coerced to a boolean
  await call({ action: "run", command: "true", cwd: testCwd, wait: "true", resource: "host:heavy" });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].body, { action: "run", command: "true", cwd: testCwd, wait: true, resource: "host:heavy" });

  process.stdout.write("gc_lease run forwards its parameters to /gc/lease unchanged.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  daemon.close();
}
