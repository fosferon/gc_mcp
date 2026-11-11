// Shared harness for the GC-7182 reload tests. It never contacts the daemon:
// every test points GC_DAEMON_URL at a local stub before importing the entry.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** A repo-internal .tmp/ copy, so bare specifiers still resolve. */
// GC-7182 impl r1 F4: every scratch dir is removed when the test process exits.
const scratchDirs = new Set();
process.on("exit", () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A repo-internal .tmp/ scratch dir, removed at process exit. */
export function makeScratchDir(name) {
  const tmp = join(repoRoot, ".tmp");
  mkdirSync(tmp, { recursive: true });
  const dir = mkdtempSync(join(tmp, `gc7182-${name}-`));
  scratchDirs.add(dir);
  return dir;
}

export function makeToolsCopy(name = "tools") {
  const dir = makeScratchDir(name);
  const path = join(dir, "tools.js");
  copyFileSync(join(repoRoot, "dist", "tools.js"), path);
  return { dir, path };
}

/**
 * Capture the entry's live server and request handlers while suppressing its
 * real transport, the pattern the existing tests use.
 */
export async function loadEntry(env = {}) {
  Object.assign(process.env, env);

  const originalConnect = McpServer.prototype.connect;
  const originalSetRequestHandler = Server.prototype.setRequestHandler;
  let callToolHandler = null;
  let listToolsHandler = null;
  let server = null;

  McpServer.prototype.connect = async function () {
    server = this;
  };
  Server.prototype.setRequestHandler = function (schema, handler) {
    const literal = schema?._def?.shape?.method;
    const method = literal?.values ? [...literal.values][0] : literal?._def?.value;
    if (method === "tools/call") callToolHandler = handler;
    if (method === "tools/list") listToolsHandler = handler;
    return originalSetRequestHandler.call(this, schema, handler);
  };

  let mod;
  try {
    mod = await import("../dist/index.js");
  } finally {
    // Restore before the test connects a real transport or calls a handler.
    McpServer.prototype.connect = originalConnect;
    Server.prototype.setRequestHandler = originalSetRequestHandler;
  }

  if (!server) throw new Error("entry did not build a server");
  if (!callToolHandler) throw new Error("entry did not install tools/call");
  if (!listToolsHandler) throw new Error("entry did not install tools/list");

  return {
    mod,
    server,
    callTool: (name, args, extra = {}) =>
      callToolHandler(
        { method: "tools/call", params: { name, arguments: args } },
        extra,
      ),
    listTools: () => listToolsHandler({ method: "tools/list", params: {} }, {}),
  };
}

/** Connect an already-built entry server to an in-memory MCP client. */
export async function connectPair(server) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const client = new Client({ name: "gc-reload-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, clientTransport, serverTransport };
}

/** A local HTTP stub daemon. The delivery take is always acknowledged empty. */
export async function startDaemon(respond = () => ({ status: 200, body: { ok: true } })) {
  const requests = [];
  const daemon = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const entry = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        body,
      };
      requests.push(entry);

      if (req.url === "/gc/delegations/take") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, outcomes: [] }));
        return;
      }

      const answer = respond(entry) ?? {};
      if (answer.destroy) {
        res.socket?.destroy();
        return;
      }
      const delay = answer.delayMs ?? 0;
      setTimeout(() => {
        if (res.destroyed) return;
        res.writeHead(answer.status ?? 200, {
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify(answer.body ?? { ok: true }));
      }, delay);
    });
  });
  await new Promise((done) => daemon.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${daemon.address().port}`,
    requests,
    close: () => new Promise((done) => daemon.close(done)),
  };
}

export function textOf(result) {
  return (result.content ?? []).map((item) => item.text).join("");
}

/** The wire form of a tools/list result: undefined-valued keys disappear. */
export function wire(value) {
  return JSON.parse(JSON.stringify(value));
}
