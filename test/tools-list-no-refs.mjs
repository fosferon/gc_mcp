import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

let listToolsHandler = null;

const originalConnect = McpServer.prototype.connect;
const originalSetRequestHandler = Server.prototype.setRequestHandler;

try {
  McpServer.prototype.connect = async function () {
    return;
  };

  Server.prototype.setRequestHandler = function (schema, handler) {
    const literal = schema?._def?.shape?.method;
    const method = literal?.values ? [...literal.values][0] : literal?._def?.value;

    if (method === "tools/list") {
      listToolsHandler = handler;
    }

    return originalSetRequestHandler.call(this, schema, handler);
  };

  await import("../dist/index.js");

  assert.ok(listToolsHandler, "Failed to capture tools/list handler");

  const result = await listToolsHandler({ method: "tools/list", params: {} }, {});
  const refs = [];

  const visit = (node, path = []) => {
    if (!node || typeof node !== "object") return;

    if ("$ref" in node) {
      refs.push({ path: path.join("."), ref: node.$ref });
    }

    for (const [key, value] of Object.entries(node)) {
      visit(value, path.concat(key));
    }
  };

  visit(result);

  assert.equal(refs.length, 0, `tools/list should not advertise $ref schemas: ${JSON.stringify(refs.slice(0, 10), null, 2)}`);
  assert.ok(Array.isArray(result.tools) && result.tools.length > 0, "tools/list returned no tools");

  // GC-5441: a bare count let a tool go missing for weeks — gc_a2a's
  // registration sat inside getResolveBridgePath() and never ran, and "63
  // tools" looked fine. Every tool the server's own instructions advertise
  // must be in the list by name.
  const advertised = [
    "gc_a2a", "gc_capability", "gc_capability_watch", "gc_checkpoint", "gc_control",
    "gc_convergence", "gc_cost", "gc_dispatch", "gc_docs", "gc_hindsight", "gc_onboarding",
    "gc_peer_conversation", "gc_plan", "gc_posture", "gc_recall", "gc_reload", "gc_retain",
    "gc_run", "gc_ticker", "gc_work", "gc_workflow", "gc_workflow_watch", "davinci_resolve",
  ];
  const names = new Set(result.tools.map((tool) => tool.name));
  const missing = advertised.filter((name) => !names.has(name));
  assert.deepEqual(missing, [], `tools/list is missing advertised tools: ${missing.join(", ")}`);

  process.stdout.write(`Verified ${result.tools.length} tools with no advertised $ref schemas.\n`);
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
}
