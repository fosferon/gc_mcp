// GC-5374 — harnesses launch the committed dist/index.js from a checkout with
// no install step. On a tree whose node_modules predates the undici dependency
// the server must still start, fall back to plain fetch, and say what to do.

import assert from "node:assert/strict";
import { register } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// Make `import("undici")` fail the way it does when the package is absent.
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier === "undici") {
          const e = new Error("Cannot find package 'undici'");
          e.code = "ERR_MODULE_NOT_FOUND";
          throw e;
        }
        return next(specifier, context);
      }
    `),
);

let callToolHandler = null;
const originalConnect = McpServer.prototype.connect;
const originalSetRequestHandler = Server.prototype.setRequestHandler;
const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write;
let stderrText = "";

try {
  McpServer.prototype.connect = async function () {};
  Server.prototype.setRequestHandler = function (schema, handler) {
    const literal = schema?._def?.shape?.method;
    const method = literal?.values ? [...literal.values][0] : literal?._def?.value;
    if (method === "tools/call") callToolHandler = handler;
    return originalSetRequestHandler.call(this, schema, handler);
  };
  process.stderr.write = (chunk, ...rest) => {
    stderrText += String(chunk);
    return originalStderrWrite.call(process.stderr, chunk, ...rest);
  };

  await import(pathToFileURL(resolve(process.env.GC_MCP_DIST || "dist/index.js")).href);

  assert.ok(callToolHandler, "the server must start without undici");
  assert.match(
    stderrText,
    /undici is not installed \(ERR_MODULE_NOT_FOUND\).*npm install/,
    "startup must say the long-call fix is inactive and how to enable it",
  );

  let lastInit = null;
  globalThis.fetch = async (_url, init = {}) => {
    lastInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const ok = await callToolHandler(
    { method: "tools/call", params: { name: "gc_recall", arguments: { query: "x" } } },
    {},
  );
  assert.notEqual(ok.isError, true, "daemon calls must still work without undici");
  assert.equal("dispatcher" in lastInit, false, "no dispatcher is passed when undici is absent");

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("Headers Timeout Error"), {
        name: "HeadersTimeoutError",
        code: "UND_ERR_HEADERS_TIMEOUT",
      }),
    });
  };
  const cut = await callToolHandler(
    {
      method: "tools/call",
      params: { name: "gc_workflow", arguments: { action: "resume", id: "wf-1" } },
    },
    {},
  );
  assert.match(
    cut.content?.[0]?.text || "",
    /UND_ERR_HEADERS_TIMEOUT.*300 s limit, not a daemon failure.*npm install/,
    "the 300 s cut must explain itself when the fix is inactive",
  );

  process.stdout.write("Verified the server starts and explains itself without undici.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  globalThis.fetch = originalFetch;
  process.stderr.write = originalStderrWrite;
}
