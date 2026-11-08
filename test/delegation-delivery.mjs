// GC-6860: every daemon request carries this connection's x-gc-client id; after
// every tool call the connection's finished delegations are appended as a second
// content item; a line is acknowledged by its seq on the next call (and comes
// again until it is); a result returned inline is left out of its own block.
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

let callToolHandler = null;
const seen = [];
// The daemon's pending outcomes for the one client, by seq.
let pending = new Map([
  [7, "dispatch j-7 (droid) completed at T1 -> gc_dispatch output job_id=j-7"],
]);
let inlineSeq = null;

const daemon = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    seen.push({ url: req.url, client: req.headers["x-gc-client"], body: parsed });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/gc/delegations/take") {
      for (const seq of parsed.ack ?? []) pending.delete(seq);
      const outcomes = [...pending].map(([seq, line]) => ({ seq, line }));
      res.end(JSON.stringify({ ok: true, outcomes }));
    } else {
      const answer = { ok: true, job_id: "j-9", status: "completed" };
      if (inlineSeq !== null) answer.delegation_seq = inlineSeq;
      res.end(JSON.stringify(answer));
    }
  });
});
await new Promise((done) => daemon.listen(0, "127.0.0.1", done));
process.env.GC_DAEMON_URL = `http://127.0.0.1:${daemon.address().port}`;

const originalConnect = McpServer.prototype.connect;
const originalSetRequestHandler = Server.prototype.setRequestHandler;
try {
  McpServer.prototype.connect = async function () {};
  Server.prototype.setRequestHandler = function (schema, handler) {
    const literal = schema?._def?.shape?.method;
    const method = literal?.values ? [...literal.values][0] : literal?._def?.value;
    if (method === "tools/call") callToolHandler = handler;
    return originalSetRequestHandler.call(this, schema, handler);
  };
  await import("../dist/index.js");
  assert.ok(callToolHandler, "Failed to capture tools/call handler");

  const call = (args) =>
    callToolHandler(
      { method: "tools/call", params: { name: "gc_dispatch", arguments: args } },
      {},
    );
  const takes = () => seen.filter((r) => r.url === "/gc/delegations/take");

  // 1. The tool's own request and the take both carry one stable client id.
  let result = await call({ action: "status", job_id: "j-1" });
  const client = seen[0].client;
  assert.match(client, /^gcmcp-[0-9a-f-]{36}$/);
  assert.ok(seen.every((r) => r.client === client), "every request carries the same id");

  // 2. The block is a second content item; the tool's own text is untouched JSON.
  assert.equal(result.content.length, 2);
  JSON.parse(result.content[0].text);
  assert.equal(
    result.content[1].text,
    "[finished since your last call]\ndispatch j-7 (droid) completed at T1 -> gc_dispatch output job_id=j-7",
  );
  assert.deepEqual(takes()[0].body, { ack: [] });

  // 3. The next call acknowledges seq 7; nothing is pending, so no block.
  result = await call({ action: "status", job_id: "j-1" });
  assert.deepEqual(takes()[1].body, { ack: [7] });
  assert.equal(result.content.length, 1);

  // 4. A line the client never acknowledges comes again.
  pending.set(8, "dispatch j-8 (droid) failed at T2 -> gc_dispatch output job_id=j-8");
  result = await call({ action: "status", job_id: "j-1" });
  assert.match(result.content[1].text, /j-8/);
  // simulate the reply being lost: the client state is what it is; the daemon
  // only forgets 8 when 8 is acknowledged, which the next call does.
  result = await call({ action: "status", job_id: "j-1" });
  assert.deepEqual(takes().at(-1).body, { ack: [8] });

  // 5. A result returned inline is not repeated in its own block, and is
  //    acknowledged by the next call.
  pending.set(9, "dispatch j-9 (droid) completed at T3 -> gc_dispatch output job_id=j-9");
  inlineSeq = 9;
  result = await call({ action: "dispatch", agent: "droid", task: "t", wait: true });
  inlineSeq = null;
  assert.equal(result.content.length, 1, "the inline result is not listed again");
  await call({ action: "status", job_id: "j-1" });
  assert.deepEqual(takes().at(-1).body, { ack: [9] });
  assert.equal(pending.size, 0);

  process.stdout.write("Finished delegations reach the caller once per seq, by connection id.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  daemon.close();
}
