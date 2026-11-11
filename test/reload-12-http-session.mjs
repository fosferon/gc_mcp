// GC-7182 test 12: a streamable-HTTP session created after a reload lists the
// new tool module's action.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { makeToolsCopy, startDaemon } from "./reload-harness.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });

const OLD = '["linear", "deep", "full"]';
const NEW = '["linear", "deep", "full", "http_after_reload"]';

const port = await freePort();
const daemon = await startDaemon(() => ({ status: 200, body: { ok: true } }));
const copy = makeToolsCopy("http");
const code = readFileSync(copy.path, "utf8");
writeFileSync(copy.path, `${code.replace(OLD, NEW)}\n// http session\n`);

Object.assign(process.env, {
  GC_DAEMON_URL: daemon.url,
  GC_MCP_TRANSPORT: "streamable-http",
  GC_MCP_HOST: "127.0.0.1",
  GC_MCP_PORT: String(port),
  GC_MCP_PATH: "/mcp",
  GC_MCP_TOOLS_PATH: copy.path,
  GC_MCP_RELOAD: "0",
});

let client;
try {
  const mod = await import("../dist/index.js");
  await mod.__reloadNow();

  const url = `http://127.0.0.1:${port}/mcp`;
  for (let i = 0; i < 100; i += 1) {
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: "{}",
      });
      break;
    } catch {
      await sleep(25);
    }
  }

  client = new Client({ name: "gc-http-reload-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));

  const listed = await client.listTools();
  const recall = listed.tools.find((tool) => tool.name === "gc_recall");
  assert.ok(
    recall.inputSchema.properties.mode.enum.includes("http_after_reload"),
    "a post-swap HTTP session must list the new action",
  );

  process.stdout.write("Verified a post-swap HTTP session lists the new action.\n");
  process.exitCode = 0;
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  if (client) await client.close().catch(() => undefined);
  await daemon.close();
  // The HTTP listener keeps the process alive; end the test explicitly.
  process.exit(process.exitCode ?? 1);
}
