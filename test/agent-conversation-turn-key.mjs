// GC-7152: gc_agent_conversation turn carries an idempotency_key (the caller's,
// or one gc_mcp generates), waits a turn-sized deadline, and on a client-side
// timeout reports the key so a retry cannot send the turn twice.
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

let callToolHandler = null;
const seen = [];
let delayMs = 0;
let status = 200;
let answer = { ok: true, response: "hi" };
let destroy = false;
let takeBody = { ok: true, items: [] };
const daemon = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url === "/gc/delegations/take") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(takeBody));
      return;
    }
    seen.push({ url: req.url, method: req.method, body: body ? JSON.parse(body) : null });
    setTimeout(() => {
      if (res.destroyed) return;
      if (destroy) {
        res.socket?.destroy();
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer));
    }, delayMs);
  });
});
await new Promise((done) => daemon.listen(0, "127.0.0.1", done));
process.env.GC_DAEMON_URL = `http://127.0.0.1:${daemon.address().port}`;
process.env.GC_MCP_TURN_TIMEOUT_MS = "300";

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
  const mod = await import("../dist/index.js");
  assert.ok(callToolHandler, "Failed to capture tools/call handler");

  const call = (args) =>
    callToolHandler(
      { method: "tools/call", params: { name: "gc_agent_conversation", arguments: args } },
      {},
    );
  const textOf = (r) => r.content.map((c) => c.text).join("");
  const callWith = (args, extra) =>
    callToolHandler(
      { method: "tools/call", params: { name: "gc_agent_conversation", arguments: args } },
      extra,
    );

  // no key: one is generated and sent
  await call({ action: "turn", session_id: "s1", message: "hello" });
  const sent = seen.at(-1);
  assert.equal(sent.url, "/gc/agent_conversation/s1/turn");
  assert.equal(sent.body.message, "hello");
  assert.match(sent.body.idempotency_key, /^gcmcp-turn-[0-9a-f-]{36}$/);

  // the caller's key is forwarded unchanged
  await call({ action: "turn", session_id: "s1", message: "again", idempotency_key: "mine-1" });
  assert.equal(seen.at(-1).body.idempotency_key, "mine-1");

  // two calls without a key get different keys (a new turn is not a retry)
  await call({ action: "turn", session_id: "s1", message: "hello" });
  assert.notEqual(seen.at(-1).body.idempotency_key, sent.body.idempotency_key);

  // a client-side timeout names the key to retry with
  delayMs = 1000;
  const timedOut = await call({ action: "turn", session_id: "s1", message: "slow" });
  const key = seen.at(-1).body.idempotency_key;
  assert.equal(timedOut.isError, true);
  assert.ok(textOf(timedOut).includes(`idempotency_key "${key}"`), textOf(timedOut));
  assert.ok(textOf(timedOut).includes("turn_in_progress"));

  // the same message sent again to the same session after a cut-short call is a
  // retry of that turn: it reuses the key (audit r1 F2)
  delayMs = 0;
  await call({ action: "turn", session_id: "s1", message: "slow" });
  assert.equal(seen.at(-1).body.idempotency_key, key);

  // once that result was delivered, the same message again is a new turn
  await call({ action: "turn", session_id: "s1", message: "slow" });
  assert.notEqual(seen.at(-1).body.idempotency_key, key);

  // the key is kept until an outcome reaches the caller (audit r3 F1): cut
  // short twice and answered turn_in_progress once, every resend reuses it; the
  // first delivered outcome frees it
  delayMs = 1000;
  await call({ action: "turn", session_id: "s3", message: "twice" });
  const k1 = seen.at(-1).body.idempotency_key;
  await call({ action: "turn", session_id: "s3", message: "twice" });
  assert.equal(seen.at(-1).body.idempotency_key, k1);
  delayMs = 0;
  status = 409;
  answer = { ok: false, error: "turn_in_progress", retryable: true };
  await call({ action: "turn", session_id: "s3", message: "twice" });
  assert.equal(seen.at(-1).body.idempotency_key, k1);
  status = 200;
  answer = { ok: true, response: "hi", replayed: true };
  await call({ action: "turn", session_id: "s3", message: "twice" });
  assert.equal(seen.at(-1).body.idempotency_key, k1);
  await call({ action: "turn", session_id: "s3", message: "twice" });
  assert.notEqual(seen.at(-1).body.idempotency_key, k1);

  // a definitive daemon error (here turn_interrupted) also frees the key
  delayMs = 1000;
  await call({ action: "turn", session_id: "s4", message: "m" });
  const k4 = seen.at(-1).body.idempotency_key;
  delayMs = 0;
  status = 409;
  answer = { ok: false, error: "turn_interrupted", retryable: false };
  await call({ action: "turn", session_id: "s4", message: "m" });
  assert.equal(seen.at(-1).body.idempotency_key, k4);
  status = 200;
  answer = { ok: true, response: "hi" };
  await call({ action: "turn", session_id: "s4", message: "m" });
  assert.notEqual(seen.at(-1).body.idempotency_key, k4);

  // a 5xx keeps the key: the turn may be stored before the error (audit r4 F2)
  status = 500;
  answer = { ok: false, error: "boom" };
  await call({ action: "turn", session_id: "s6", message: "m" });
  const k6 = seen.at(-1).body.idempotency_key;
  status = 200;
  answer = { ok: true, response: "hi" };
  await call({ action: "turn", session_id: "s6", message: "m" });
  assert.equal(seen.at(-1).body.idempotency_key, k6);

  // a transport failure keeps the key too
  destroy = true;
  await call({ action: "turn", session_id: "s7", message: "m" }).catch(() => null);
  const k7 = seen.at(-1).body.idempotency_key;
  destroy = false;
  await call({ action: "turn", session_id: "s7", message: "m" });
  assert.equal(seen.at(-1).body.idempotency_key, k7);

  // a host cancel keeps the key even though the daemon answered (audit r4 test gap)
  const cancelled = new AbortController();
  cancelled.abort();
  await callWith({ action: "turn", session_id: "s8", message: "m" }, { signal: cancelled.signal });
  const k8 = seen.at(-1).body.idempotency_key;
  await call({ action: "turn", session_id: "s8", message: "m" });
  assert.equal(seen.at(-1).body.idempotency_key, k8);
  await call({ action: "turn", session_id: "s8", message: "m" });
  assert.notEqual(seen.at(-1).body.idempotency_key, k8);

  // a session id containing the words does not flip the classification (audit r4 F3)
  status = 500;
  answer = { ok: false, error: "boom", detail: "turn_in_progress mentioned in passing" };
  await call({ action: "turn", session_id: "turn_in_progress-sid", message: "m" });
  status = 404;
  answer = { ok: false, error: "session not found" };
  await call({ action: "turn", session_id: "turn_in_progress-sid", message: "m" });
  const k9 = seen.at(-1).body.idempotency_key;
  status = 200;
  answer = { ok: true, response: "hi" };
  await call({ action: "turn", session_id: "turn_in_progress-sid", message: "m" });
  assert.notEqual(seen.at(-1).body.idempotency_key, k9);

  // a caller's own key is sent verbatim on its retry after a cut short
  delayMs = 1000;
  await call({ action: "turn", session_id: "s5", message: "m", idempotency_key: "own-1" });
  delayMs = 0;
  await call({ action: "turn", session_id: "s5", message: "m", idempotency_key: "own-1" });
  assert.equal(seen.at(-1).body.idempotency_key, "own-1");

  // another session or another message does not inherit the kept key
  delayMs = 1000;
  await call({ action: "turn", session_id: "s1", message: "slow again" });
  const kept = seen.at(-1).body.idempotency_key;
  delayMs = 0;
  await call({ action: "turn", session_id: "s2", message: "slow again" });
  assert.notEqual(seen.at(-1).body.idempotency_key, kept);

  // a key with a space is accepted; a tab is refused by the schema (audit r1 F5)
  await call({ action: "turn", session_id: "s1", message: "x", idempotency_key: "sess 42" });
  assert.equal(seen.at(-1).body.idempotency_key, "sess 42");
  const countBeforeTab = seen.length;
  const tab = await call({
    action: "turn",
    session_id: "s1",
    message: "x",
    idempotency_key: "a\tb",
  }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal(tab.isError, true);
  assert.equal(seen.length, countBeforeTab);

  // an over-long key is refused by the schema before anything is sent
  const before = seen.length;
  const bad = await call({
    action: "turn",
    session_id: "s1",
    message: "x",
    idempotency_key: "k".repeat(129),
  }).catch((e) => ({ isError: true, content: [{ text: String(e) }] }));
  assert.equal(bad.isError, true);
  assert.equal(seen.length, before);

  // concurrent identical calls on one slot (audit r5 F1): a delivered call does
  // not free the key while another call on the slot is still in flight
  const slotA = "conn-x\u0000s\u0000digest-a";
  const kA = mod.turnKeyFor(slotA, 0);
  assert.equal(mod.turnKeyFor(slotA, 1), kA); // the second, concurrent call reuses it
  mod.finishTurnKey(slotA, true, 2); // B delivered
  assert.equal(mod.turnKeyKept(slotA), kA); // A still in flight: kept
  mod.finishTurnKey(slotA, false, 3); // A cut short
  assert.equal(mod.turnKeyKept(slotA), kA);
  assert.equal(mod.turnKeyFor(slotA, 4), kA); // A's retry reuses the key
  mod.finishTurnKey(slotA, true, 5); // delivered, nothing else in flight
  assert.equal(mod.turnKeyKept(slotA), undefined);

  // the freeing order with the unsettled sibling first (audit r6 F3)
  const slotO = "conn-x\u0000s\u0000digest-order";
  const kO = mod.turnKeyFor(slotO, 0);
  mod.turnKeyFor(slotO, 1);
  mod.finishTurnKey(slotO, false, 2);
  assert.equal(mod.turnKeyKept(slotO), kO);
  mod.finishTurnKey(slotO, true, 3);
  assert.equal(mod.turnKeyKept(slotO), undefined);

  // another connection never shares a slot
  const kB = mod.turnKeyFor("conn-y\u0000s\u0000digest-a", 0);
  assert.notEqual(kB, kA);
  mod.finishTurnKey("conn-y\u0000s\u0000digest-a", true, 0);

  // a kept key expires about half an hour after the last call on it ended,
  // never while a call on it is in flight
  const slotT = "conn-x\u0000s\u0000digest-t";
  mod.turnKeyFor(slotT, 0);
  mod.turnKeyFor("conn-x\u0000s\u0000digest-sweeper", 10_000_000); // sweep while T in flight
  assert.ok(mod.turnKeyKept(slotT));
  mod.finishTurnKey(slotT, false, 10_000_000);
  mod.turnKeyFor("conn-x\u0000s\u0000digest-sweeper", 10_000_000 + 59_000); // inside the TTL
  assert.ok(mod.turnKeyKept(slotT));
  mod.turnKeyFor("conn-x\u0000s\u0000digest-sweeper", 10_000_000 + 10_000_000); // past it
  assert.equal(mod.turnKeyKept(slotT), undefined);

  // through the real handler: two overlapping identical turns on one connection
  // send the same key (the slot carries a live connection id; with none, each
  // call would get its own key and this would fail) (audit r6 F4)
  delayMs = 200;
  status = 200;
  answer = { ok: true, response: "hi" };
  const before2 = seen.length;
  await Promise.all([
    call({ action: "turn", session_id: "s-par", message: "same" }),
    call({ action: "turn", session_id: "s-par", message: "same" }),
  ]);
  const par = seen.slice(before2).map((r) => r.body.idempotency_key);
  assert.equal(par.length, 2);
  assert.equal(par[0], par[1]);
  delayMs = 0;

  // a malformed delivery body cannot fail the call after the turn succeeded,
  // and the key is settled only after delivery (audit r7 N1)
  takeBody = { ok: true, outcomes: "not a list" };
  const r = await call({ action: "turn", session_id: "s-deliv", message: "m" });
  assert.notEqual(r.isError, true);
  const kd = seen.at(-1).body.idempotency_key;
  await call({ action: "turn", session_id: "s-deliv", message: "m" });
  assert.notEqual(seen.at(-1).body.idempotency_key, kd); // delivered, freed
  takeBody = { ok: true, items: [] };

  // undici's own limits count as cut short (audit r1 F3, r2 test gap)
  const undici = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  assert.equal(mod.isClientCutShort(undici("UND_ERR_HEADERS_TIMEOUT")), true);
  assert.equal(mod.isClientCutShort(undici("UND_ERR_BODY_TIMEOUT")), true);
  assert.equal(mod.isClientCutShort(Object.assign(new Error("t"), { name: "TimeoutError" })), true);
  assert.equal(mod.isClientCutShort(undici("ECONNREFUSED")), false);

  console.log("agent-conversation-turn-key: ok");
} finally {
  McpServer.prototype.connect = originalConnect;
  Server.prototype.setRequestHandler = originalSetRequestHandler;
  daemon.closeAllConnections?.();
  daemon.close();
}
