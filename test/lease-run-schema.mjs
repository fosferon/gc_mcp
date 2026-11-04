// GC-6858: gc_lease advertises `run`, accepts its params, and the server
// instructions state the heavy-work rule (the zero-install channel).
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const originalConnect = McpServer.prototype.connect;
let server;
McpServer.prototype.connect = async function () { server = this; };
process.env.GC_MCP_NO_AUTOSTART = "1";
try {
  await import("../dist/index.js");
  assert.ok(server, "server instance captured");
  const instructions = server.server._instructions ?? "";
  assert.match(instructions, /gc_lease action:run/, "instructions state the heavy-work rule");
  assert.match(instructions, /queued, position N/);
  const tool = server._registeredTools?.gc_lease;
  assert.ok(tool, "gc_lease is registered");
  const parsed = tool.inputSchema.safeParse({ action: "run", command: "mix test", cwd: "/x", issue: "GC-1", wait: "true", timeout_ms: "5000" });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.match(tool.description, /run: the daemon runs a heavy command/);
  process.stdout.write("gc_lease run schema + instructions verified.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
}
