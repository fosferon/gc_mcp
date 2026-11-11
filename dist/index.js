#!/usr/bin/env node
/**
 * gc_mcp — Universal MCP server for a local operations daemon
 *
 * Thin translation layer: MCP tool calls → HTTP POST to the daemon (localhost:4242)
 * Plus 3 standalone tools: davinci_resolve, devonthink, gh_issues
 *
 * Usage:
 *   node dist/index.js                          # stdio (default)
 *   GC_MCP_TRANSPORT=streamable-http node dist/index.js
 *   GC_MCP_TRANSPORT=all node dist/index.js
 *
 * Config:
 *   { "mcpServers": { "gc": { "command": "node", "args": ["/path/to/gc_mcp/dist/index.js"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as z4 from "zod/v4";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as toolsModule from "./tools.js";
// ════════════════════════════════════════════════════════════════
// HTTP Client — daemon at localhost:4242
// ════════════════════════════════════════════════════════════════
const GC_BASE = process.env.GC_DAEMON_URL || "http://localhost:4242";
/**
 * Node's global fetch is undici, and undici enforces its own 300 s
 * `headersTimeout` and 300 s `bodyTimeout` whatever AbortSignal the caller
 * passes (or omits). A daemon call that blocks longer than that before
 * answering — a synchronous workflow resume, a wait-mode dispatch — was cut by
 * the HTTP client at exactly 300 s with a bare "fetch failed", while the work
 * carried on in the daemon. The same limit applied to SSE streams
 * that stay quiet for five minutes.
 *
 * Every daemon request therefore goes through this dispatcher, which has
 * neither limit; the per-call AbortSignal is the only client-side deadline.
 *
 * undici is loaded dynamically on purpose. Harnesses launch the committed
 * `dist/index.js` straight from a checkout with no install step, so a static
 * import would stop every MCP server from starting on a tree whose
 * node_modules predates the dependency. Without it the server still runs,
 * with the old 300 s limit, and says so here and in the error it produces.
 */
const daemonDispatcher = await import("undici")
    .then(({ Agent }) => new Agent({ headersTimeout: 0, bodyTimeout: 0 }))
    .catch((e) => {
    process.stderr.write(`gc_mcp: undici is not installed (${e?.code ?? e?.message}); daemon calls longer than 300 s will fail. Run \`npm install\` in the gc_mcp checkout.\n`);
    return undefined;
});
const callStore = new AsyncLocalStorage();
function newConnection() {
    return { id: `gcmcp-${randomUUID()}`, pendingAck: [], queue: Promise.resolve() };
}
/** A daemon answer that returned a delegation's result inline carries its seq. */
function noteInlineSeq(json) {
    const seq = json?.delegation_seq ?? json?.data?.delegation_seq;
    const call = callStore.getStore();
    if (call && Number.isInteger(seq))
        call.inlineSeqs.push(seq);
}
const DELIVERY_HEADER = "[finished since your last call]";
/**
 * Run `fn` after every earlier delivery step of this connection has finished,
 * so parallel tool calls cannot interleave their take and acknowledgement.
 */
function serialized(conn, fn) {
    const next = conn.queue.then(fn, fn);
    conn.queue = next.catch(() => undefined);
    return next;
}
/**
 * Append this connection's finished delegations to `result` and return it.
 * The previous responses' seqs are acknowledged by this take; the seqs this
 * response shows (and the ones it returned inline) become pending only once the
 * block is actually attached, so a line that is never returned is never
 * acknowledged. Never throws: delivery must not break the call it rides on.
 */
async function deliver(call, result) {
    const { conn } = call;
    return serialized(conn, async () => {
        const ack = conn.pendingAck;
        const inline = new Set(call.inlineSeqs);
        let outcomes;
        try {
            const resp = await daemonFetch(`${GC_BASE}/gc/delegations/take`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-gc-client": conn.id },
                body: JSON.stringify({ ack }),
                signal: AbortSignal.timeout(3_000),
            });
            if (!resp.ok) {
                // Not taken, so nothing was acknowledged: keep the pending seqs, add
                // this call's inline ones.
                conn.pendingAck = [...new Set([...ack, ...inline])];
                return result;
            }
            const json = await resp.json();
            const raw = json?.outcomes ?? json?.data?.outcomes;
            // GC-7152 audit r7 N1: a malformed body must not make delivery throw.
            outcomes = Array.isArray(raw) ? raw : [];
        }
        catch {
            conn.pendingAck = [...new Set([...ack, ...inline])];
            return result;
        }
        // The take acknowledged `ack`. What is returned now is pending.
        const shown = outcomes.filter((o) => !inline.has(o.seq));
        const attachable = shown.length > 0 && result && Array.isArray(result.content);
        conn.pendingAck = [
            ...new Set([...(attachable ? shown.map((o) => o.seq) : []), ...inline]),
        ];
        if (!attachable)
            return result;
        const block = [DELIVERY_HEADER, ...shown.map((o) => o.line)].join("\n");
        return { ...result, content: [...result.content, { type: "text", text: block }] };
    });
}
// GC-7152 audit r8 F3: a hook that throws must not turn a delivered reply into an
// error, nor replace the delivery error being rethrown.
function runAfterReply(call, replied) {
    for (const f of call.afterReply) {
        try {
            f(replied);
        }
        catch {
            // the reply (or the error being rethrown) stands
        }
    }
}
function daemonFetch(url, init = {}) {
    const conn = callStore.getStore()?.conn;
    if (conn) {
        const headers = new Headers(init.headers ?? {});
        if (!headers.has("x-gc-client"))
            headers.set("x-gc-client", conn.id);
        init = { ...init, headers };
    }
    if (daemonDispatcher === undefined)
        return fetch(url, init);
    return fetch(url, { ...init, dispatcher: daemonDispatcher });
}
/**
 * Render an error for the agent. undici reports the actual reason
 * (ECONNREFUSED, UND_ERR_SOCKET, ...) on `cause` and leaves `message` as
 * "fetch failed", so the cause has to be spelled out. A client-side deadline
 * says nothing about the daemon-side work, and the text says so.
 */
function describeError(e) {
    const message = e?.message ?? String(e);
    if (e?.name === "TimeoutError") {
        return `${message} — this is the MCP client's own deadline; the daemon may still be working, so check the job or execution status before retrying`;
    }
    const cause = e?.cause;
    if (!cause)
        return message;
    const label = cause.code ?? cause.name;
    const detail = cause.message ?? String(cause);
    const described = label ? `${message} (${label}: ${detail})` : `${message} (${detail})`;
    if (daemonDispatcher === undefined &&
        (label === "UND_ERR_HEADERS_TIMEOUT" || label === "UND_ERR_BODY_TIMEOUT")) {
        return `${described} — the HTTP client's 300 s limit, not a daemon failure: the daemon may still be working. Run \`npm install\` in the gc_mcp checkout to lift the limit`;
    }
    return described;
}
// GC-7152: the daemon's conversation turn budget (Providers.conversation_cli_timeout_ms,
// 30 min) plus a minute, so the client never gives up on a turn the daemon is
// still allowed to finish.
// GC_MCP_TURN_TIMEOUT_MS overrides it for tests only.
const AGENT_CONVERSATION_TURN_TIMEOUT_MS = Number(process.env.GC_MCP_TURN_TIMEOUT_MS) > 0
    ? Number(process.env.GC_MCP_TURN_TIMEOUT_MS)
    : 31 * 60 * 1000;
function isAbortError(e) {
    const name = e?.name;
    return name === "AbortError" || name === "TimeoutError";
}
// GC-7152 audit r1 F3: the call ended on the client side (our deadline, or
// undici's own header/body limit on a checkout without the no-limit
// dispatcher) while the daemon may still be working.
export function isClientCutShort(e) {
    if (isAbortError(e))
        return true;
    const code = e?.cause?.code;
    return code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT";
}
// GC-7152 audit r1 F2: a generated turn key is kept, per session and exact
// message, until gc_mcp has handed that turn's result to a caller that was
// still waiting for it. A turn whose result may not have reached the caller
// (our deadline, an undici limit, the MCP host cancelling the call, a daemon
// error) keeps its key for the turn budget, so the same message sent again
// without a key is a retry of that turn, not a new one. The key is kept until
// an outcome of that turn has left gc_mcp for a waiting caller (audit r3 F1;
// r7 N1: after delivery, not when the tool callback returns): a reply or a
// replay, turn_interrupted, or any other definitive daemon answer clears it,
// and the next identical message is a new turn. A turn_in_progress answer, a
// cut-short call or a host cancel keeps it, because the turn's outcome is still
// unknown. A key the caller passes is always used as given.
// GC-7152 audit r5 F1: a slot is per MCP connection, session and exact
// message, and counts the calls on it still in flight. A delivered outcome
// frees the slot only when no other call on it is in flight, so one caller's
// delivery cannot take the key from a concurrent identical call that has not
// learned its outcome. Different connections never share a slot.
const unconfirmedTurnKeys = new Map();
// GC-7152 audit r4 F1: the kept key outlives the deadline of the call that
// kept it, so the retry that follows a deadline abort still finds it.
const UNCONFIRMED_TURN_KEY_TTL_MS = AGENT_CONVERSATION_TURN_TIMEOUT_MS + 60_000;
// GC-7152 audit r4 F2: the key is freed only on evidence that the turn's
// outcome is settled: delivered (2xx), or a daemon answer that says the turn
// did not run or will not run under this key (400, 404, 422, 409
// turn_interrupted, 409 corrupt_transcript_item). A 409 turn_in_progress, a 5xx (the turn may be stored
// before the error), a transport failure, a cut-short call and a host cancel
// all keep it.
/** Start a call on a slot: the kept key, or a new one. Exported for its test. */
export function turnKeyFor(slot, now = Date.now()) {
    for (const [s, entry] of unconfirmedTurnKeys) {
        // GC-7152 audit r8 F1: an entry whose calls never finished (a delivery that
        // never resolved) is reclaimed one more TTL after it would have expired.
        const backstop = entry.expires + UNCONFIRMED_TURN_KEY_TTL_MS;
        if ((entry.inFlight === 0 && entry.expires <= now) || backstop <= now) {
            unconfirmedTurnKeys.delete(s);
        }
    }
    const kept = unconfirmedTurnKeys.get(slot);
    const key = kept?.key ?? `gcmcp-turn-${randomUUID()}`;
    unconfirmedTurnKeys.set(slot, {
        key,
        expires: now + UNCONFIRMED_TURN_KEY_TTL_MS,
        inFlight: (kept?.inFlight ?? 0) + 1,
    });
    return key;
}
/**
 * End a call on a slot. `settled`: its caller learned the outcome. The slot is
 * freed only when settled and no other call on it is in flight; otherwise the
 * key is kept for the TTL from now. Exported for its test.
 */
export function finishTurnKey(slot, key, settled, now = Date.now()) {
    const entry = unconfirmedTurnKeys.get(slot);
    // GC-7152 audit r9 F1: a late finish from a call whose entry the backstop
    // already reclaimed must not touch a newer entry on the same slot.
    if (!entry || entry.key !== key)
        return;
    const inFlight = Math.max(0, entry.inFlight - 1);
    if (settled && inFlight === 0) {
        unconfirmedTurnKeys.delete(slot);
    }
    else {
        unconfirmedTurnKeys.set(slot, { ...entry, inFlight, expires: now + UNCONFIRMED_TURN_KEY_TTL_MS });
    }
}
/** Whether a slot still holds a key. Exported for its test. */
export function turnKeyKept(slot) {
    return unconfirmedTurnKeys.get(slot)?.key;
}
function resolveJsonPointer(root, ref) {
    if (!ref.startsWith("#/"))
        return undefined;
    return ref
        .slice(2)
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce((current, key) => {
        if (current &&
            typeof current === "object" &&
            key in current) {
            return current[key];
        }
        return undefined;
    }, root);
}
function inlineLocalRefs(schema) {
    const root = structuredClone(schema);
    const visit = (node) => {
        if (Array.isArray(node)) {
            return node.map(visit);
        }
        if (!node || typeof node !== "object") {
            return node;
        }
        const record = node;
        if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
            const target = resolveJsonPointer(root, record.$ref);
            if (target && typeof target === "object") {
                const { $ref: _ignored, ...rest } = record;
                return visit({
                    ...structuredClone(target),
                    ...rest,
                });
            }
        }
        return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, visit(value)]));
    };
    return visit(root);
}
function isSchema(value) {
    return (!!value &&
        typeof value === "object" &&
        typeof value.safeParse === "function");
}
function isRawShape(inputSchema) {
    return (!!inputSchema &&
        typeof inputSchema === "object" &&
        Object.values(inputSchema).every(isSchema));
}
function isZodV4Schema(schema) {
    // `ZodType` is the v3 public base class. Zod v4 Classic and Mini schemas
    // are not instances of it, even though both versions implement Standard
    // Schema (so `~standard` is not a version discriminator).
    return !(schema instanceof z.ZodType);
}
function unsupportedRootParameterMessage(shape, rejected = []) {
    const named = rejected.length ? ` Rejected: ${rejected.join(", ")}.` : "";
    return `Unsupported top-level MCP parameter(s).${named} Accepted parameters: ${Object.keys(shape).sort().join(", ") || "(none)"}.`;
}
function hasRootRefinement(inputSchema) {
    const definition = inputSchema.def;
    return Array.isArray(definition?.checks) && definition.checks.length > 0;
}
function unsupportedRootSchema() {
    throw new TypeError("MCP tool inputSchema must be a direct Zod object or raw shape; wrapped or refined root schemas cannot be made strict without changing their behavior.");
}
/**
 * Normalize the SDK's accepted Zod v3/v4 object and raw-shape forms to an
 * actual strict Zod object. This keeps the schema SDK-normalizable for
 * tools/list and leaves declared nested-map schemas unchanged.
 */
function strictRootInputSchema(inputSchema) {
    if (inputSchema === undefined) {
        return z
            .object({}, {
            errorMap: (issue, ctx) => issue.code === "unrecognized_keys"
                ? { message: unsupportedRootParameterMessage({}, issue.keys) }
                : { message: ctx.defaultError },
        })
            .strict();
    }
    const rawShape = isRawShape(inputSchema);
    const objectSchema = inputSchema;
    if (!rawShape && hasRootRefinement(inputSchema))
        unsupportedRootSchema();
    const candidateShape = rawShape ? inputSchema : objectSchema.shape;
    const shape = typeof candidateShape === "function" ? candidateShape() : candidateShape;
    if (!shape || typeof shape !== "object" || !Object.values(shape).every(isSchema)) {
        unsupportedRootSchema();
    }
    const rootShape = shape;
    const fields = Object.values(rootShape);
    const usesZodV4 = rawShape
        ? fields.some(isZodV4Schema)
        : isZodV4Schema(inputSchema);
    if (usesZodV4 && !fields.every(isZodV4Schema)) {
        throw new TypeError("MCP tool inputSchema cannot mix Zod v3 and v4 fields.");
    }
    // Newer SDKs surface only the issue message, not issue.keys, so the message
    // is built per issue to keep naming the rejected parameter(s).
    const v3ErrorMap = (issue, ctx) => issue.code === "unrecognized_keys"
        ? { message: unsupportedRootParameterMessage(rootShape, issue.keys) }
        : { message: ctx.defaultError };
    if (!usesZodV4 && !rawShape && objectSchema instanceof z.ZodObject) {
        return new z.ZodObject({
            ...objectSchema._def,
            unknownKeys: "strict",
            errorMap: v3ErrorMap,
        });
    }
    if (!usesZodV4) {
        return z
            .object(rootShape, { errorMap: v3ErrorMap })
            .strict();
    }
    // Zod v4's strict() has no per-schema error argument. Recreate only its
    // public object shape with a public error callback so the recovery message
    // includes this tool's accepted root parameters. This also adapts v4-mini
    // raw shapes to the SDK's normalizable v4 Classic object form.
    return z4
        .object(rootShape, {
        error: (issue) => issue.code === "unrecognized_keys"
            ? unsupportedRootParameterMessage(rootShape, issue.keys)
            : undefined,
    })
        .strict();
}
// ════════════════════════════════════════════════════════════════
// GC-7182: shared state, reload registry and the notice
// ════════════════════════════════════════════════════════════════
/** The directory containing the entry module — what dirname(import.meta.url) is today. */
const packageDir = dirname(fileURLToPath(import.meta.url));
export function createShared() {
    return {
        fetch: daemonFetch,
        gcBase: GC_BASE,
        callStore,
        turnKeys: { turnKeyFor, finishTurnKey, turnKeyKept, isClientCutShort },
        noteInlineSeq,
        describeError,
        packageDir,
    };
}
const shared = createShared();
const defaultToolsPath = join(packageDir, "tools.js");
function currentToolsPath() {
    return process.env.GC_MCP_TOOLS_PATH || defaultToolsPath;
}
function currentEntryPath() {
    return process.env.GC_MCP_ENTRY_PATH || fileURLToPath(import.meta.url);
}
function identity(path) {
    try {
        const stat = statSync(path);
        return { mtimeMs: stat.mtimeMs, size: stat.size };
    }
    catch {
        return undefined;
    }
}
function sameIdentity(a, b) {
    return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
function labelFor(mtimeMs) {
    return `tools.js@${new Date(mtimeMs).toISOString()}`;
}
const initialToolsIdentity = identity(currentToolsPath());
let lastToolsIdentity = initialToolsIdentity;
const registry = {
    current: toolsModule,
    currentLabel: initialToolsIdentity
        ? labelFor(initialToolsIdentity.mtimeMs)
        : "tools.js@unknown",
    servers: new Set(),
};
/** Test hook: the live registry and the module currently serving it. */
export const __registry = registry;
let entryChanged = false;
let lastFailure;
let failedToolsMtime;
function newNoticeState() {
    if (entryChanged)
        return { state: "entry_changed" };
    if (lastFailure) {
        return { state: "failed", from: lastFailure.from, error: lastFailure.error };
    }
    return { state: "fresh" };
}
function noticeText(notice) {
    if (notice.state === "entry_changed") {
        return "[gc_mcp] The gc_mcp entry was rebuilt; reconnect the gc MCP server to load it.";
    }
    if (notice.state === "reloaded") {
        return `[gc_mcp] Tools were reloaded from a newer build (\`${notice.from}\` → \`${notice.to}\`, as \`tools.js@<mtime>\` labels). If an action you expect is refused as unknown, reconnect the gc MCP server.`;
    }
    if (notice.state === "failed") {
        return `[gc_mcp] A newer build failed to load (${notice.error ?? "unknown error"}); still serving ${notice.from ?? registry.currentLabel}.`;
    }
    return undefined;
}
/** Append at most one notice item, after any delegation block, on success only. */
function withNotice(result, notice) {
    if (!result || result.isError === true || !Array.isArray(result.content)) {
        return result;
    }
    const text = noticeText(notice);
    if (!text)
        return result;
    return { ...result, content: [...result.content, { type: "text", text }] };
}
/**
 * Install the once-per-server registration wrapper: strict root validation,
 * the call context, delegation delivery, and the stale-build notice.
 */
function installToolWrapper(server, connection, notice) {
    const registerTool = server.registerTool.bind(server);
    server.registerTool = ((name, config, callback) => registerTool(name, {
        ...config,
        inputSchema: strictRootInputSchema(config.inputSchema),
    }, (async (...args) => {
        const call = { conn: connection, inlineSeqs: [], afterReply: [] };
        return callStore.run(call, async () => {
            const result = await callback(...args);
            let delivered;
            try {
                delivered = await deliver(call, result);
            }
            catch (e) {
                runAfterReply(call, false);
                throw e;
            }
            runAfterReply(call, true);
            return withNotice(delivered, notice);
        });
    })));
}
/**
 * The swap sends on live connections for the first time. The SDK's send is
 * fire-and-forget, so a dead client must not become an unhandled rejection.
 * During the synchronous swap every send is suppressed; after it the entry
 * sends one caught notification.
 */
function patchSendToolListChanged(server, entry) {
    const original = server.server.sendToolListChanged.bind(server.server);
    server.server.sendToolListChanged = ((...args) => {
        if (entry.swapping)
            return Promise.resolve();
        return Promise.resolve(original(...args)).catch(() => undefined);
    });
}
/** Install the $ref-inlining tools/list override after the first registration. */
function installListOverride(server, entry) {
    const rawListToolsHandler = server.server._requestHandlers.get("tools/list");
    if (rawListToolsHandler) {
        server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
            const result = await rawListToolsHandler(request, extra);
            // A reloaded notice lives only until the client re-lists.
            if (entry.notice.state === "reloaded") {
                entry.notice.state = "fresh";
                entry.notice.from = undefined;
                entry.notice.to = undefined;
                entry.notice.error = undefined;
            }
            return {
                ...result,
                tools: result.tools.map((tool) => ({
                    ...tool,
                    inputSchema: inlineLocalRefs(tool.inputSchema),
                    ...(tool.outputSchema
                        ? { outputSchema: inlineLocalRefs(tool.outputSchema) }
                        : {}),
                })),
            };
        });
    }
}
function addServer(entry) {
    registry.servers.add(entry);
    entry.server.server.onclose = () => {
        registry.servers.delete(entry);
    };
}
function buildMcpServer() {
    const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
    const server = new McpServer({ name: "gc", version: packageVersion }, {
        instructions: [
            "Operations hub. All tools route to the daemon (localhost:4242).",
            "Use gc_recall for memory search (FTS5, instant). gc_retain to store facts.",
            "gc_docs queries the packaged daemon user manual — use it for setup, configuration, workflows, templates, and troubleshooting.",
            "gc_onboarding drives the guided setup DAG and setup-degree checks.",
            "gc_control executes deterministic, approval-gated operations directly.",
            "gc_capability reports which features are currently lit up.",
            "gc_cost checks cost ceilings, spend, and breaker state.",
            "gc_posture tunes operator trust levels for autonomous actions.",
            "gc_hindsight queries the deep-memory backend (Hindsight today; Foresight is expected to succeed it — the tool name is the stable contract, not the implementation).",
            "gc_conversation / gc_agent_conversation / gc_aden manage interactive chat sessions.",
            "gc_run watches and controls observable workflow/execution runs.",
            "Heavy work rule: run full test suites, test-database setup and landings (Gate → merge → deploy) through gc_lease action:run {command, cwd, issue} (an allowlisted argv such as `mix test`, run contained), never as a raw shell command — the daemon queues them on shared slots, tells you 'queued, position N', and starts them when a slot frees. gc_dispatch of a CLI agent queues by itself the same way (response status queued, with position and resource; it starts when a slot frees), and workflow dispatch steps simply wait for a slot while the run stays running; there is nothing to configure in your harness.",
            "gc_checkpoint fetches and resolves approval checkpoints.",
            "gc_workflow_watch follows a workflow execution live via SSE.",
            "gc_work manages the work graph — issues, dependencies, assignments.",
            "gc_plan answers 'what should I work on next?' with scored recommendations.",
            "gc_convergence tracks strategic vectors — use 'report' for the real 'where are we at?'",
            "gc_ticker provides situational awareness snapshots.",
            "gc_a2a is the Agent-to-Agent protocol client — send tasks to agents, check status, register as a worker.",
            "gc_peer_conversation is the chat-style lane for ongoing dialogue with external A2A peers; use it instead of gc_dispatch when you want a conversation rather than a job.",
        ].join(" "),
    });
    const connection = newConnection();
    const entry = {
        server,
        connection,
        notice: newNoticeState(),
        handles: [],
        swapping: false,
    };
    // GC-6860: this connection's delivery address and acknowledgement state.
    patchSendToolListChanged(server, entry);
    installToolWrapper(server, connection, entry.notice);
    entry.handles = registry.current.registerTools(server, shared);
    installListOverride(server, entry);
    return entry;
}
function recordFailure(t, error) {
    const message = String(error?.message ?? error).slice(0, 200);
    lastFailure = { mtimeMs: t?.mtimeMs, error: message, from: registry.currentLabel };
    if (t) {
        lastToolsIdentity = t;
        failedToolsMtime = t.mtimeMs;
    }
    for (const entry of registry.servers) {
        if (entryChanged)
            continue;
        entry.notice.state = "failed";
        entry.notice.from = registry.currentLabel;
        entry.notice.to = undefined;
        entry.notice.error = message;
    }
    process.stderr.write(`gc_mcp: tools reload failed (${message}); still serving ${registry.currentLabel}\n`);
}
async function reloadFromDisk(toolsPath, observed, force) {
    if (observed && !force && failedToolsMtime === observed.mtimeMs)
        return;
    const version = observed?.mtimeMs ?? Date.now();
    const nextLabel = labelFor(version);
    let nextModule;
    try {
        nextModule = (await import(`${pathToFileURL(toolsPath).href}?v=${version}`));
    }
    catch (e) {
        recordFailure(observed, e);
        return;
    }
    // Validate the whole registration on a scratch server that never connects.
    try {
        if (typeof nextModule.registerTools !== "function") {
            throw new TypeError("tools module does not export registerTools");
        }
        const scratch = new McpServer({ name: "gc-scratch", version: "0" });
        installToolWrapper(scratch, newConnection(), { state: "fresh" });
        nextModule.registerTools(scratch, shared);
    }
    catch (e) {
        recordFailure(observed, e);
        return;
    }
    const fromLabel = registry.currentLabel;
    // GC-7182: this block must stay synchronous — no await inside. As one JS
    // task, no incoming tools/call or tools/list can observe an empty or
    // partial tool set between the removals and the registrations.
    for (const entry of registry.servers) {
        entry.swapping = true;
        try {
            for (const handle of entry.handles)
                handle.remove();
            entry.handles = nextModule.registerTools(entry.server, shared);
        }
        finally {
            entry.swapping = false;
        }
        if (!entryChanged) {
            entry.notice.state = "reloaded";
            entry.notice.from = fromLabel;
            entry.notice.to = nextLabel;
            entry.notice.error = undefined;
        }
        // One caught notification per server, after the block has completed.
        entry.server.sendToolListChanged();
    }
    registry.current = nextModule;
    registry.currentLabel = nextLabel;
    lastToolsIdentity = observed ?? identity(toolsPath);
    failedToolsMtime = undefined;
    lastFailure = undefined;
}
function markEntryChanged() {
    entryChanged = true;
    for (const entry of registry.servers) {
        entry.notice.state = "entry_changed";
        entry.notice.from = undefined;
        entry.notice.to = undefined;
        entry.notice.error = undefined;
    }
}
let pollInFlight = false;
let toolsPollPending;
let entryPollPending;
let lastEntryIdentity = identity(currentEntryPath());
/** Test hook: one watcher pass, including the two-poll debounce. */
export async function __pollOnce() {
    if (pollInFlight)
        return;
    pollInFlight = true;
    try {
        const observedEntry = identity(currentEntryPath());
        if (observedEntry) {
            if (!lastEntryIdentity) {
                lastEntryIdentity = observedEntry;
            }
            else if (sameIdentity(observedEntry, lastEntryIdentity)) {
                entryPollPending = undefined;
            }
            else if (entryPollPending && sameIdentity(observedEntry, entryPollPending)) {
                lastEntryIdentity = observedEntry;
                entryPollPending = undefined;
                markEntryChanged();
            }
            else {
                entryPollPending = observedEntry;
            }
        }
        const toolsPath = currentToolsPath();
        const observedTools = identity(toolsPath);
        if (!observedTools)
            return;
        if (!lastToolsIdentity) {
            lastToolsIdentity = observedTools;
            return;
        }
        if (sameIdentity(observedTools, lastToolsIdentity)) {
            toolsPollPending = undefined;
            return;
        }
        if (failedToolsMtime === observedTools.mtimeMs)
            return;
        if (toolsPollPending && sameIdentity(observedTools, toolsPollPending)) {
            toolsPollPending = undefined;
            await reloadFromDisk(toolsPath, observedTools, false);
        }
        else {
            toolsPollPending = observedTools;
        }
    }
    finally {
        pollInFlight = false;
    }
}
/** Test hook: import and swap immediately, bypassing the poll debounce. */
export async function __reloadNow() {
    const toolsPath = currentToolsPath();
    await reloadFromDisk(toolsPath, identity(toolsPath), true);
}
/** Polling is used rather than fs.watch: a watch is unreliable across editors and renames. */
function startWatcher() {
    if (process.env.GC_MCP_RELOAD === "0")
        return;
    const timer = setInterval(() => {
        void __pollOnce();
    }, 5_000);
    timer.unref();
}
const HTTP_HOST = process.env.GC_MCP_HOST || "127.0.0.1";
const HTTP_PORT = Number(process.env.GC_MCP_PORT || "8765");
const HTTP_PATH = process.env.GC_MCP_PATH || "/mcp";
function getBootstrapTransport() {
    const raw = (process.env.GC_MCP_TRANSPORT || "stdio").toLowerCase();
    if (raw === "stdio" || raw === "streamable-http" || raw === "all") {
        return raw;
    }
    throw new Error(`Invalid GC_MCP_TRANSPORT=${raw}. Expected stdio, streamable-http, or all.`);
}
function isInitializePayload(payload) {
    return (!!payload &&
        typeof payload === "object" &&
        "method" in payload &&
        payload.method === "initialize");
}
async function readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    if (chunks.length === 0)
        return undefined;
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw)
        return undefined;
    return JSON.parse(raw);
}
function writeJsonError(res, status, message) {
    if (res.headersSent)
        return;
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: null,
    }));
}
async function startStreamableHttpServer() {
    const sessions = new Map();
    const listener = createServer(async (req, res) => {
        try {
            const url = new URL(req.url || "/", `http://${req.headers.host || HTTP_HOST}`);
            if (url.pathname !== HTTP_PATH) {
                res.statusCode = 404;
                res.end("Not found");
                return;
            }
            const sessionIdHeader = req.headers["mcp-session-id"];
            const sessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
            if (req.method === "POST") {
                const body = await readJsonBody(req);
                const session = sessionId ? sessions.get(sessionId) : undefined;
                if (!session) {
                    if (sessionId || !isInitializePayload(body)) {
                        writeJsonError(res, 400, "Bad Request: No valid session ID provided");
                        return;
                    }
                    const entry = buildMcpServer();
                    addServer(entry);
                    const server = entry.server;
                    let transport;
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        onsessioninitialized: (newSessionId) => {
                            sessions.set(newSessionId, { server, transport });
                        },
                    });
                    transport.onclose = async () => {
                        const sid = transport.sessionId;
                        if (sid)
                            sessions.delete(sid);
                        registry.servers.delete(entry);
                        await server.close().catch(() => undefined);
                    };
                    await server.connect(transport);
                    await transport.handleRequest(req, res, body);
                    return;
                }
                await session.transport.handleRequest(req, res, body);
                return;
            }
            if (req.method === "GET" || req.method === "DELETE") {
                if (!sessionId) {
                    writeJsonError(res, 400, "Bad Request: Missing MCP session ID");
                    return;
                }
                const session = sessions.get(sessionId);
                if (!session) {
                    writeJsonError(res, 404, "Unknown MCP session ID");
                    return;
                }
                await session.transport.handleRequest(req, res);
                return;
            }
            res.statusCode = 405;
            res.setHeader("Allow", "GET, POST, DELETE");
            res.end("Method not allowed");
        }
        catch (e) {
            writeJsonError(res, 500, e.message || "Internal server error");
        }
    });
    await new Promise((resolveListen, rejectListen) => {
        listener.once("error", rejectListen);
        listener.listen(HTTP_PORT, HTTP_HOST, () => {
            listener.off("error", rejectListen);
            process.stderr.write(`gc_mcp streamable_http listening on http://${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH}\n`);
            resolveListen();
        });
    });
}
async function main() {
    const mode = getBootstrapTransport();
    if (mode === "stdio" || mode === "all") {
        const entry = buildMcpServer();
        addServer(entry);
        const transport = new StdioServerTransport();
        await entry.server.connect(transport);
    }
    if (mode === "streamable-http" || mode === "all") {
        await startStreamableHttpServer();
    }
}
startWatcher();
main().catch((e) => {
    process.stderr.write(`gc_mcp fatal: ${e.message}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map