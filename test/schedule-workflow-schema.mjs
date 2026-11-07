// gc_schedule advertises the workflow action type, accepts `workflow`
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

  assert.match(schedule.description, /action_type "workflow" runs a\s+workflow directly, with no agent or model dispatch added by the schedule/);
  assert.match(schedule.description, /a workflow's own\s+prompt\/dispatch steps still call a model/);
  assert.match(schedule.description, /child-only workflow is refused/);
  assert.match(schedule.description, /a schedule that is due at that\s+moment counts as fired \(for an enabled schedule that also stops the next tick/);
  assert.match(schedule.description, /e\.g\. a busy\s+workflow database, a draining daemon/);
  assert.match(schedule.description, /'params' \(a JSON object or its JSON string\)/);
  assert.doesNotMatch(schedule.description, /notify/);
  assert.match(schedule.description, /execution id in place of a job id/);
  assert.match(schedule.description, /GC_WORKFLOW_STATE_DIR/);
  assert.match(schedule.description, /fire runs the\s+schedule now/);

  // The advertised params property is a union of an object and a string.
  const props = schedule.inputSchema.shape ?? schedule.inputSchema._def?.shape?.();
  assert.ok(props?.params, "params is a declared property");
  assert.ok(props?.workflow, "workflow is a declared property");

  process.stdout.write("gc_schedule workflow action type verified.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
}
