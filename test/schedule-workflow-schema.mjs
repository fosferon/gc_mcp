// GC-6963: gc_schedule advertises the workflow action type, accepts `workflow`
// and `params` (object or JSON string), and says what a fire records and what a
// manual fire leaves alone.
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const originalConnect = McpServer.prototype.connect;
let server;
McpServer.prototype.connect = async function () { server = this; };
process.env.GC_MCP_NO_AUTOSTART = "1";
try {
  await import("../dist/index.js");
  const schedule = server._registeredTools?.gc_schedule;
  assert.ok(schedule, "gc_schedule is registered");

  const obj = schedule.inputSchema.safeParse({
    action: "create", name: "w", trigger: "cron", cron: "7 * * * *",
    action_type: "workflow", workflow: "support-queue-watcher", params: { dry_run: true },
  });
  assert.ok(obj.success, JSON.stringify(obj.error?.issues));
  const str = schedule.inputSchema.safeParse({
    action: "create", action_type: "workflow", workflow: "x", params: '{"a":1}',
  });
  assert.ok(str.success, JSON.stringify(str.error?.issues));
  const bad = schedule.inputSchema.safeParse({ action: "create", params: 5 });
  assert.ok(!bad.success, "params must be an object or a string");

  assert.match(schedule.description, /action_type "workflow" runs a\s+workflow with no model in the path/);
  assert.match(schedule.description, /execution id in place of a job id/);
  assert.match(schedule.description, /GC_WORKFLOW_STATE_DIR/);
  assert.match(schedule.description, /fire runs the schedule now/);

  process.stdout.write("gc_schedule workflow action type verified.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
}
