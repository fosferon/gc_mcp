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

  process.stdout.write(`Verified ${result.tools.length} tools with no advertised $ref schemas.\n`);
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
}
