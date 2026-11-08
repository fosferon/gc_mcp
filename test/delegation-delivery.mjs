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
let takeFails = false;
let takeDelayMs = 0;

const daemon = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    seen.push({ url: req.url, client: req.headers["x-gc-client"], body: parsed });
    if (!(req.url === "/gc/delegations/take" && takeFails))
      res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url === "/gc/delegations/take") {
      if (takeFails) {
        res.writeHead(503);
        return res.end(JSON.stringify({ ok: false }));
      }
      for (const seq of parsed.ack ?? []) pending.delete(seq);
      const outcomes = [...pending].map(([seq, line]) => ({ seq, line }));
      setTimeout(() => res.end(JSON.stringify({ ok: true, outcomes })), takeDelayMs);
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

  // 6. A take that fails leaves the tool's answer alone and acknowledges nothing.
  pending.set(10, "dispatch j-10 (droid) completed at T4 -> gc_dispatch output job_id=j-10");
  result = await call({ action: "status", job_id: "j-1" }); // shows 10, pending ack [10]
  assert.match(result.content[1].text, /j-10/);
  takeFails = true;
  result = await call({ action: "status", job_id: "j-1" });
  takeFails = false;
  assert.equal(result.content.length, 1);
  JSON.parse(result.content[0].text);
  assert.ok(pending.has(10), "a failed take acknowledged nothing");
  await call({ action: "status", job_id: "j-1" });
  assert.deepEqual(takes().at(-1).body, { ack: [10] }, "the ack is sent again");
  assert.equal(pending.size, 0);

  // 7. Parallel calls on one connection: their takes run one after the other,
  //    every line is shown exactly once, and every shown seq is acknowledged once.
  pending.set(11, "dispatch j-11 (droid) completed at T5 -> gc_dispatch output job_id=j-11");
  pending.set(12, "dispatch j-12 (droid) completed at T6 -> gc_dispatch output job_id=j-12");
  takeDelayMs = 30;
  const before = takes().length;
  const [r1, r2] = await Promise.all([
    call({ action: "status", job_id: "j-1" }),
    call({ action: "status", job_id: "j-1" }),
  ]);
  takeDelayMs = 0;
  const blocks = [r1, r2].filter((r) => r.content.length === 2).map((r) => r.content[1].text);
  assert.equal(blocks.length, 1, "the lines are shown in one response only");
  assert.match(blocks[0], /j-11/);
  assert.match(blocks[0], /j-12/);
  const parallelTakes = takes().slice(before);
  assert.deepEqual(parallelTakes[0].body, { ack: [] });
  assert.deepEqual(parallelTakes[1].body.ack.sort(), [11, 12], "the second take acks what the first showed");
  await call({ action: "status", job_id: "j-1" });
  assert.equal(pending.size, 0, "everything shown was acknowledged");

  process.stdout.write("Finished delegations reach the caller once per seq, by connection id.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  daemon.close();
}
