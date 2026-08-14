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

  const workPaginationResult = await callToolHandler(
    {
      method: "tools/call",
      params: {
        name: "gc_work",
        arguments: {
          action: "list",
          offset: 25,
          order: "priority:desc,created_at:asc",
          mode: "tree",
          tree: true,
        },
      },
    },
    {},
  );

  assert.notEqual(
    workPaginationResult.isError,
    true,
    "gc_work must accept daemon-supported pagination and tree fields",
  );
  assert.equal(daemonRequests, 1, "valid gc_work pagination reaches gc_daemon");
  assert.deepEqual(daemonBody, {
    action: "list",
    offset: 25,
    order: "priority:desc,created_at:asc",
    mode: "tree",
    tree: true,
  });

  const requestsBeforeInvalidNotify = daemonRequests;
  const invalidNotifyStatus = await callToolHandler(
    {
      method: "tools/call",
      params: {
        name: "gc_notify",
        arguments: { action: "list", status: "invalid" },
      },
    },
    {},
  );

  assert.equal(invalidNotifyStatus.isError, true, "gc_notify must reject an invalid status");
  assert.equal(
    daemonRequests,
    requestsBeforeInvalidNotify,
    "an invalid gc_notify status must fail before daemon transport",
  );

  globalThis.fetch = async (_url, init) => {
    daemonRequests += 1;
    daemonBody = JSON.parse(init.body);

    return new Response(
      JSON.stringify({
        ok: true,
        notifications: [],
        next_checkpoint: "2026-08-14T19:00:00Z",
        next_cursor_id: "cursor-2",
      }),
      { status: 200 },
    );
  };

  const notifyCursorResult = await callToolHandler(
    {
      method: "tools/call",
      params: {
        name: "gc_notify",
        arguments: {
          action: "list",
          status: "all",
          source: "workflow.lifecycle",
          since: "2026-08-14T18:59:00Z",
          cursor_id: "cursor-1",
          limit: 25,
        },
      },
    },
    {},
  );

  assert.notEqual(notifyCursorResult.isError, true, "valid gc_notify cursor polling must pass");
  assert.deepEqual(daemonBody, {
    action: "list",
    status: "all",
    source: "workflow.lifecycle",
    since: "2026-08-14T18:59:00Z",
    cursor_id: "cursor-1",
    limit: 25,
  });

  const notifyResponse = JSON.parse(notifyCursorResult.content?.[0]?.text || "{}");
  assert.equal(notifyResponse.next_checkpoint, "2026-08-14T19:00:00Z");
  assert.equal(notifyResponse.next_cursor_id, "cursor-2");

  globalThis.fetch = async (_url, init) => {
    daemonRequests += 1;
    daemonBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const skillExamplesResult = await callToolHandler(
    {
      method: "tools/call",
      params: {
        name: "gc_skill",
        arguments: {
          action: "update",
          slug: "directory-testing",
          examples: ["test a directory"],
          counterexamples: ["deploy the production database"],
        },
      },
    },
    {},
  );

  assert.notEqual(
    skillExamplesResult.isError,
    true,
    "gc_skill must accept curated examples and counterexamples",
  );
  assert.deepEqual(daemonBody, {
    action: "update",
    slug: "directory-testing",
    examples: ["test a directory"],
    counterexamples: ["deploy the production database"],
  });

  const skillBackfillResult = await callToolHandler(
    {
      method: "tools/call",
      params: {
        name: "gc_skill",
        arguments: { action: "backfill_embeddings" },
      },
    },
    {},
  );

  assert.notEqual(
    skillBackfillResult.isError,
    true,
    "gc_skill must expose the embedding backfill action",
  );
  assert.deepEqual(daemonBody, { action: "backfill_embeddings" });

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
  assert.equal(daemonRequests, 5, "valid calls reach gc_daemon");
  assert.deepEqual(daemonBody, {
    action: "list",
    params: { future_filter: { nested: "preserved" } },
  });
  process.stdout.write(
    `Verified strict root MCP parameter rejection across ${registeredTools.length} tools.\n`,
  );

  // ════════════════════════════════════════════════════════════
  // Response truncation tests
  // ════════════════════════════════════════════════════════════

  // Small responses pass through unchanged.
  const smallPayload = { ok: true, data: "small" };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(smallPayload), { status: 200 });

  const smallResult = await callToolHandler(
    { method: "tools/call", params: { name: "gc_recall", arguments: { query: "x" } } },
    {},
  );
  const smallText = smallResult.content?.[0]?.text || "";
  assert.ok(!smallText.includes("[TRUNCATED"), "small response must not be truncated");
  assert.deepEqual(
    JSON.parse(smallText),
    smallPayload,
    "small response must be verbatim JSON",
  );

  // Large responses get truncated with a diagnostic marker.
  const bigData = "x".repeat(20_000);
  const bigPayload = { ok: true, data: bigData };
  globalThis.fetch = async () =>
    new Response(JSON.stringify(bigPayload), { status: 200 });

  const bigResult = await callToolHandler(
    { method: "tools/call", params: { name: "gc_recall", arguments: { query: "y" } } },
    {},
  );
  const bigText = bigResult.content?.[0]?.text || "";
  assert.ok(bigText.includes("[TRUNCATED"), "large response must carry truncation marker");
  assert.ok(
    bigText.length < 20_000,
    `truncated response must be under 20k chars (got ${bigText.length})`,
  );
  assert.ok(
    bigText.includes("narrower filters"),
    "truncation marker must include remediation hint",
  );
  assert.ok(
    bigText.includes("chars omitted"),
    "truncation marker must report omitted size",
  );

  // Restore the simple mock for any future additions.
  globalThis.fetch = async (_url, init) => {
    daemonRequests += 1;
    daemonBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  process.stdout.write("Verified response truncation for oversized daemon payloads.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
  McpServer.prototype.registerTool = originalRegisterTool;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  globalThis.fetch = originalFetch;
}
