// GC-6926: gc_dispatch advertises explain_route and availability, and dispatch's
// call_profile / idempotency_key / metadata, and passes them through to the daemon unchanged.
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const originalConnect = McpServer.prototype.connect;
const originalFetch = globalThis.fetch;
let server;
let sent = null;
McpServer.prototype.connect = async function () { server = this; };
process.env.GC_MCP_NO_AUTOSTART = "1";
try {
  await import("../dist/index.js");
  const dispatch = server._registeredTools?.gc_dispatch;
  assert.ok(dispatch, "gc_dispatch is registered");
  const parse = (v) => dispatch.inputSchema.safeParse(v);

  for (const ok of [
    { action: "explain_route", agent: "auditor", provider: "kimi", model: "m", call_profile: "completion" },
    { action: "availability" },
    { action: "availability", clear: "kimi/kimi-code" },
    { action: "availability", set: "kimi", retry_at: "2026-11-10 13:57", state: "quota", reason: "operator page" },
    { action: "dispatch", agent: "a", task: "t", call_profile: "worker", idempotency_key: "k-1" },
    { action: "dispatch", agent: "a", task: "t", metadata: { run: "r-1" } },
  ]) {
    const r = parse(ok);
    assert.ok(r.success, JSON.stringify(r.error?.issues));
  }
  assert.ok(!parse({ action: "explain_route", call_profile: "batch" }).success, "unknown call_profile refused");
  assert.ok(!parse({ action: "availability", set: "kimi", state: "weird" }).success, "unknown state refused");
  assert.ok(!parse({ action: "dispatch", agent: "a", task: "t", metadata: "nope" }).success, "non-object metadata refused");
  assert.ok(!parse({ action: "dispatch", agent: "a", task: "t", metadata: { big: "x".repeat(17000) } }).success, "metadata over 16 KiB refused");
  assert.ok(!parse({ action: "availabilty" }).success, "a misspelled action is still refused");

  assert.match(dispatch.description, /explain_route \(read-only routing decision/);
  assert.match(dispatch.description, /availability \(the provider availability ledger/);
  assert.match(dispatch.description, /idempotency_key/);
  assert.match(dispatch.description, /call_profile "worker" \(default/);

  // pass-through: the daemon receives the new fields exactly as given
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, entries: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const args = { action: "availability", set: "kimi", retry_at: "2026-11-10 13:57", state: "quota", reason: "r" };
  await dispatch.handler(args, {});
  assert.deepEqual(sent, args);
  for (const more of [
    { action: "explain_route", agent: "auditor", provider: "kimi", model: "m", call_profile: "completion" },
    { action: "availability", clear: "kimi/kimi-code" },
    { action: "dispatch", agent: "a", task: "t", metadata: { run: "r-1" } },
  ]) {
    await dispatch.handler(more, {});
    assert.deepEqual(sent, more);
  }
  assert.ok(!parse({ action: "dispatch", agent: "a", task: "t", idempotency_key: "" }).success, "empty idempotency_key refused");
  await dispatch.handler({ action: "dispatch", agent: "a", task: "t", call_profile: "completion", idempotency_key: "k" }, {});
  assert.equal(sent.call_profile, "completion");
  assert.equal(sent.idempotency_key, "k");
  process.stdout.write("gc_dispatch explain_route + availability + call_profile/idempotency_key/metadata verified.\n");
} finally {
  McpServer.prototype.connect = originalConnect;
  globalThis.fetch = originalFetch;
}
