// GC-6907: gc_workflow advertises `include_child_only` (list_workflows), accepts
// boolean and string forms, and still rejects unknown params.
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const originalConnect = McpServer.prototype.connect;
let server;
McpServer.prototype.connect = async function () { server = this; };
process.env.GC_MCP_NO_AUTOSTART = "1";
try {
  await import("../dist/index.js");
  assert.ok(server, "server instance captured");
  const tool = server._registeredTools?.gc_workflow;
  assert.ok(tool, "gc_workflow is registered");

  for (const value of [true, false, "true", "false"]) {
    const parsed = tool.inputSchema.safeParse({ action: "list_workflows", include_child_only: value });
    assert.ok(parsed.success, `include_child_only=${JSON.stringify(value)}: ${JSON.stringify(parsed.error?.issues)}`);
  }
  const bad = tool.inputSchema.safeParse({ action: "list_workflows", include_child_only: "maybe" });
  assert.ok(!bad.success, "a non-boolean value is rejected");
  const unknown = tool.inputSchema.safeParse({ action: "list_workflows", include_children: true });
  assert.ok(!unknown.success, "a misspelt param is still rejected (strict schema)");

  assert.match(tool.description, /include_child_only/);
  assert.match(tool.description, /Child-only workflows/);
  assert.match(tool.description, /show and detail responses carry children: \[\{ child_id, workflow, step, status \}\]/);
  assert.match(tool.description, /explicit select by name always returns a child-only workflow/);
  process.stdout.write("gc_workflow include_child_only schema verified.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
}
