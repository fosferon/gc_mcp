import assert from "node:assert/strict";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { z as z3 } from "zod";
import * as z4 from "zod/v4";
import * as z4mini from "zod/v4-mini";

let callToolHandler = null;
let listToolsHandler = null;
let daemonRequests = 0;
let daemonBody = null;
const registeredTools = [];
const registeredToolShapes = new Map();
const registeredToolRequired = new Map();
let mcpServer = null;

const originalConnect = McpServer.prototype.connect;
const originalRegisterTool = McpServer.prototype.registerTool;
const originalSetRequestHandler = Server.prototype.setRequestHandler;
const originalFetch = globalThis.fetch;

try {
  McpServer.prototype.connect = async function () {
    mcpServer = this;
    return;
  };

  McpServer.prototype.registerTool = function (name, config, callback) {
    registeredTools.push(name);
    registeredToolShapes.set(name, Object.keys(config.inputSchema.shape || {}));
    registeredToolRequired.set(
      name,
      Object.entries(config.inputSchema.shape || {})
        .filter(([_field, schema]) => !schema.safeParse(undefined).success)
        .map(([field]) => field),
    );
    return originalRegisterTool.call(this, name, config, callback);
  };

  Server.prototype.setRequestHandler = function (schema, handler) {
    const literal = schema?._def?.shape?.method;
    const method = literal?.values ? [...literal.values][0] : literal?._def?.value;

    if (method === "tools/call") {
      callToolHandler = handler;
    }

    if (method === "tools/list") {
      listToolsHandler = handler;
    }

    return originalSetRequestHandler.call(this, schema, handler);
  };

  globalThis.fetch = async (_url, init) => {
    daemonRequests += 1;
    daemonBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await import("../dist/index.js");

  assert.ok(callToolHandler, "Failed to capture tools/call handler");
  assert.ok(listToolsHandler, "Failed to capture tools/list handler");
  assert.ok(mcpServer, "Failed to capture MCP server");

  // Exercise all other input-schema forms accepted by the SDK so a future
  // registration cannot reintroduce v3-only strictness.
  const compatibilityTools = [
    ["gc_test_v3_raw_shape", { value: z3.string() }, { value: "v3" }],
    ["gc_test_raw_shape_field", { shape: z3.string() }, { shape: "field" }],
    ["gc_test_v4_object", z4.object({ value: z4.string() }), { value: "v4" }],
    ["gc_test_v4_raw_shape", { value: z4mini.string() }, { value: "mini raw" }],
    ["gc_test_v4mini_object", z4mini.object({ value: z4mini.string() }), { value: "mini object" }],
    ["gc_test_v4_empty_object", z4.object({}), {}],
  ];

  for (const [name, inputSchema] of compatibilityTools) {
    mcpServer.registerTool(
      name,
      { description: "strict schema compatibility test", inputSchema },
      async () => ({ content: [{ type: "text", text: "unexpected callback" }] }),
    );
  }

  mcpServer.registerTool(
    "gc_test_zero_arg",
    { description: "strict zero-argument compatibility test" },
    async () => ({ content: [{ type: "text", text: "zero args accepted" }] }),
  );

  for (const [name, inputSchema] of [
    ["gc_test_v3_refined_root", z3.object({ value: z3.string() }).refine(() => true)],
    ["gc_test_v4_refined_root", z4.object({ value: z4.string() }).refine(() => true)],
  ]) {
    assert.throws(
      () =>
        mcpServer.registerTool(
          name,
          { description: "unsupported refined root", inputSchema },
          async () => ({ content: [{ type: "text", text: "unexpected callback" }] }),
        ),
      /direct Zod object or raw shape; wrapped or refined root schemas/,
      `${name} must fail registration rather than losing root constraints`,
    );
  }

  const listed = await listToolsHandler({ method: "tools/list", params: {} }, {});
  for (const tool of listed.tools) {
    const expectedProperties = registeredToolShapes.get(tool.name);
    assert.ok(expectedProperties, `${tool.name} must retain an object input schema`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name} must list an object schema`);
    assert.equal(
      tool.inputSchema.additionalProperties,
      false,
      `${tool.name} must advertise strict root parameters`,
    );
    assert.deepEqual(
      Object.keys(tool.inputSchema.properties || {}).sort(),
      expectedProperties.sort(),
      `${tool.name} must retain every registered property in tools/list`,
    );
    assert.deepEqual(
      [...(tool.inputSchema.required || [])].sort(),
      registeredToolRequired.get(tool.name).sort(),
      `${tool.name} must retain every required field in tools/list`,
    );
  }

  const result = await callToolHandler(
    {
      method: "tools/call",
      params: {
        name: "gc_work",
        arguments: { action: "list", resolution: "low" },
      },
    },
    {},
  );

  // The SDK turns its InvalidParams exception into a tool error result at the
  // tools/call boundary. The diagnostic still originates from input validation
  // and must arrive before the callback/daemon transport.
  assert.equal(result.isError, true, "expected MCP invalid-params tool error");
  const diagnostic = result.content?.[0]?.text || "";
  assert.match(diagnostic, /resolution/, "diagnostic names rejected key");
  assert.match(
    diagnostic,
    /Accepted parameters:.*action/,
    "diagnostic lists registered parameters",
  );

  assert.equal(daemonRequests, 0, "invalid parameters must not reach gc_daemon");

  const multipleUnknown = await callToolHandler(
    {
      method: "tools/call",
      params: {
        name: "gc_work",
        arguments: { action: "list", resolution: "low", verbosity: "high" },
      },
    },
    {},
  );
  const multipleDiagnostic = multipleUnknown.content?.[0]?.text || "";
  assert.equal(multipleUnknown.isError, true, "multiple unknown keys must reject");
  assert.match(multipleDiagnostic, /resolution/, "first unknown key is named");
  assert.match(multipleDiagnostic, /verbosity/, "second unknown key is named");

  assert.ok(registeredTools.length > 0, "expected at least one registered tool");

  for (const name of registeredTools) {
    const allToolsResult = await callToolHandler(
      {
        method: "tools/call",
        params: {
          name,
          arguments: { __gc3703_undeclared_root_key: true },
        },
      },
      {},
    );

    assert.equal(
      allToolsResult.isError,
      true,
      `${name} must reject an undeclared root parameter`,
    );
    assert.match(
      allToolsResult.content?.[0]?.text || "",
      /__gc3703_undeclared_root_key/,
      `${name} diagnostic must name the undeclared root parameter`,
    );
  }

  assert.equal(
    daemonRequests,
    0,
    "no registered tool may fetch when its root arguments are invalid",
  );

  for (const [name, _inputSchema, arguments_] of compatibilityTools) {
    const validResult = await callToolHandler(
      { method: "tools/call", params: { name, arguments: arguments_ } },
      {},
    );
    assert.notEqual(validResult.isError, true, `${name} must accept valid arguments`);
  }

  const zeroArgResult = await callToolHandler(
    { method: "tools/call", params: { name: "gc_test_zero_arg", arguments: {} } },
    {},
  );
  assert.notEqual(zeroArgResult.isError, true, "zero-argument tool must accept {}");

  const nestedResult = await callToolHandler(
    {
      method: "tools/call",
      params: {
        name: "gc_records",
        arguments: {
          action: "list",
          params: { future_filter: { nested: "preserved" } },
        },
      },
    },
    {},
  );

  assert.notEqual(nestedResult.isError, true, "declared nested map remains valid");
  assert.equal(daemonRequests, 1, "valid call reaches gc_daemon once");
  assert.deepEqual(daemonBody, {
    action: "list",
    params: { future_filter: { nested: "preserved" } },
  });
  process.stdout.write(
    `Verified strict root MCP parameter rejection across ${registeredTools.length} tools.\n`,
  );
} finally {
  McpServer.prototype.connect = originalConnect;
  McpServer.prototype.registerTool = originalRegisterTool;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  globalThis.fetch = originalFetch;
}
