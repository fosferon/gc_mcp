// GC-6913: gc_dispatch advertises `cancel`, accepts it with a job_id, and its
// description says what it keeps and that unfinished output reads are partial;
// gc_lease says a full REDACTED suite still goes through the gc-lease CLI.
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const originalConnect = McpServer.prototype.connect;
let server;
McpServer.prototype.connect = async function () { server = this; };
process.env.GC_MCP_NO_AUTOSTART = "1";
try {
  await import("../dist/index.js");
  assert.ok(server, "server instance captured");
  const dispatch = server._registeredTools?.gc_dispatch;
  assert.ok(dispatch, "gc_dispatch is registered");

  const ok = dispatch.inputSchema.safeParse({ action: "cancel", job_id: "abc123" });
  assert.ok(ok.success, JSON.stringify(ok.error?.issues));
  const bad = dispatch.inputSchema.safeParse({ action: "cancelled", job_id: "abc123" });
  assert.ok(!bad.success, "an unknown action is still refused");

  assert.match(dispatch.description, /cancel \(stop a job and KEEP its record/);
  assert.match(dispatch.description, /gc_run control abort/);
  assert.match(dispatch.description, /partial: true/);
  assert.match(dispatch.description, /delete \(remove one; force also stops a running job but removes the record\)/);

  const lease = server._registeredTools?.gc_lease;
  assert.match(lease.description, /gc_dispatch action:cancel/);
  assert.match(lease.description, /partial: true/);
  assert.match(lease.description, /GC-6913/);
  assert.match(lease.description, /FULL REDACTED suite still goes through the gc-lease CLI/);

  process.stdout.write("gc_dispatch cancel + partial output + gc_lease limit verified.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
}
