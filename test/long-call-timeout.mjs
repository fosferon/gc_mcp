// GC-5374 — a daemon call that blocks longer than 300 s must not be cut by the
// HTTP client, and a transport failure must say what it was.
//
// The fast half runs in `npm test`. The slow half is the real thing — a server
// that answers after 320 s — and runs only with GC_MCP_SLOW_TESTS=1
// (`npm run test:slow`), because nothing can shorten undici's built-in limit.
//
// GC_MCP_DIST points the test at another build, which is how the slow half is
// shown red against a build without the fix.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Agent } from "undici";

const SLOW = process.env.GC_MCP_SLOW_TESTS === "1";
const SLOW_DELAY_MS = 320_000;
const distEntry = resolve(process.env.GC_MCP_DIST || "dist/index.js");

let callToolHandler = null;
const originalConnect = McpServer.prototype.connect;
const originalSetRequestHandler = Server.prototype.setRequestHandler;
const originalFetch = globalThis.fetch;
const originalDaemonUrl = process.env.GC_DAEMON_URL;

// A stand-in daemon: answers at once, or after SLOW_DELAY_MS for /gc/workflow.
const daemon = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    const delay = req.url === "/gc/workflow" ? SLOW_DELAY_MS : 0;
    const timer = setTimeout(() => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, status: "halted", answered_after_ms: delay }));
    }, delay);
    res.on("close", () => clearTimeout(timer));
  });
});
await new Promise((done) => daemon.listen(0, "127.0.0.1", done));
process.env.GC_DAEMON_URL = `http://127.0.0.1:${daemon.address().port}`;

const callTool = (name, args) =>
  callToolHandler({ method: "tools/call", params: { name, arguments: args } }, {});
const textOf = (result) => result.content?.[0]?.text || "";

try {
  McpServer.prototype.connect = async function () {};
  Server.prototype.setRequestHandler = function (schema, handler) {
    const literal = schema?._def?.shape?.method;
    const method = literal?.values ? [...literal.values][0] : literal?._def?.value;
    if (method === "tools/call") callToolHandler = handler;
    return originalSetRequestHandler.call(this, schema, handler);
  };

  await import(pathToFileURL(distEntry).href);
  assert.ok(callToolHandler, "Failed to capture tools/call handler");

  // ── every daemon request carries the no-limit dispatcher ────────────────
  const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  const lastInit = () => seen.at(-1).init;

  await callTool("gc_workflow", { action: "resume", id: "wf-1" });
  assert.ok(
    lastInit().dispatcher instanceof Agent,
    "gc_workflow resume must pass an undici Agent as dispatcher",
  );
  const dispatcher = lastInit().dispatcher;

  // The limits themselves. undici keeps an Agent's options under a private
  // symbol; reading it is what lets the fast suite tell `new Agent({})` — which
  // fails at 300 s exactly as before — from the real fix. If undici ever drops
  // the symbol this fails loudly rather than passing blind; the slow half is
  // then the only proof, and this block has to be rewritten, not deleted.
  const optionsKey = Object.getOwnPropertySymbols(dispatcher).find(
    (symbol) => symbol.description === "options",
  );
  assert.ok(optionsKey, "undici Agent no longer exposes Symbol(options); rewrite this check");
  assert.deepEqual(
    {
      headersTimeout: dispatcher[optionsKey].headersTimeout,
      bodyTimeout: dispatcher[optionsKey].bodyTimeout,
    },
    { headersTimeout: 0, bodyTimeout: 0 },
    "the daemon dispatcher must disable undici's 300 s headers and body limits",
  );
  assert.equal(
    lastInit().signal,
    undefined,
    "gc_workflow resume with no timeout must carry no client-side deadline",
  );

  await callTool("gc_workflow", { action: "resume", id: "wf-1", timeout: 60 });
  assert.ok(
    lastInit().signal instanceof AbortSignal,
    "an explicit resume timeout must still set a client-side deadline",
  );

  await callTool("gc_workflow", { action: "run", name: "wf" });
  assert.ok(
    lastInit().signal instanceof AbortSignal,
    "a sync run keeps its 300 s default deadline",
  );

  for (const spelling of ["none", "infinity", "infinite"]) {
    await callTool("gc_dispatch", {
      action: "dispatch",
      agent: "auditor",
      task: "t",
      wait: true,
      timeout: spelling,
    });
    assert.equal(
      lastInit().signal,
      undefined,
      `gc_dispatch wait:true timeout:"${spelling}" must carry no client-side deadline`,
    );
    assert.equal(lastInit().dispatcher, dispatcher, "one shared dispatcher for every daemon call");
  }

  await callTool("gc_recall", { query: "x" });
  assert.equal(lastInit().dispatcher, dispatcher, "short calls use the same dispatcher");
  assert.ok(lastInit().signal instanceof AbortSignal, "short calls keep their 15 s deadline");

  process.stdout.write("Verified the no-limit dispatcher and deadlines on daemon calls.\n");

  // ── a transport failure names its cause ──────────────────────────────────
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4242"), {
        code: "ECONNREFUSED",
      }),
    });
  };
  const refused = await callTool("gc_recall", { query: "x" });
  assert.equal(refused.isError, true);
  assert.match(
    textOf(refused),
    /fetch failed \(ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:4242\)/,
    "a transport failure must carry undici's cause",
  );

  globalThis.fetch = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const timedOut = await callTool("gc_workflow", { action: "resume", id: "wf-1", timeout: 1 });
  assert.match(
    textOf(timedOut),
    /MCP client's own deadline; the daemon may still be working/,
    "a client-side deadline must not read as a daemon failure",
  );

  process.stdout.write("Verified transport errors name their cause.\n");

  // ── the real thing: a daemon that answers after 320 s ────────────────────
  if (SLOW) {
    globalThis.fetch = originalFetch;
    const started = Date.now();
    const result = await callTool("gc_workflow", { action: "resume", id: "wf-slow" });
    const elapsed = Math.round((Date.now() - started) / 1000);
    assert.notEqual(
      result.isError,
      true,
      `resume must survive a ${SLOW_DELAY_MS / 1000} s daemon call; after ${elapsed} s got: ${textOf(result)}`,
    );
    assert.match(textOf(result), /"answered_after_ms": 320000/);
    process.stdout.write(`Verified a ${elapsed} s daemon call completes.\n`);
  }
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  globalThis.fetch = originalFetch;
  if (originalDaemonUrl === undefined) delete process.env.GC_DAEMON_URL;
  else process.env.GC_DAEMON_URL = originalDaemonUrl;
  daemon.closeAllConnections();
  daemon.close();
}
