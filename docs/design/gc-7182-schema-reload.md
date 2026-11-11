# GC-7182: a running gc_mcp picks up a rebuilt tool schema without a reconnect

- **Bee:** GC-7182.
- **Repo:** gc_mcp.
- **Branch:** `gc/7182-schema-reload`, from `master` 4496e1d.
- **Status:** design, before implementation.

## 1. The problem

An MCP client launches gc_mcp once per session, as `node …/dist/index.js`, and the process keeps the tool schema it loaded at startup. After gc_mcp is rebuilt, an older session still advertises and validates against the old schema.

A real case: a session started 2026-11-02 rejected `gc_dispatch action: cancel`, added 2026-11-05 (6149755). It also lacked `explain_route` and `availability`. The process serving that session ran a dist built before both commits, so the strict input schema refused the new actions. Nothing told the agent or the operator why. The only fix was to reconnect the MCP server by hand.

**What the code does today.**
- `src/index.ts` is a single module.
  - It builds the server in `buildMcpServer()` (`:1000-1995`), registers 65 tools through a wrapper that adds strict root validation and delegation delivery (`:1041-1064`), and overrides `tools/list` to inline local `$ref`s (`:5970-5992`).
  - Its last statement calls `main()`, which connects stdio and/or starts the streamable-HTTP listener (`:6158-6175`).
- Per-connection state is created inside `buildMcpServer()`: `connection = newConnection()` (`:1034`). That is the GC-6860 delivery address `gcmcp-<uuid>` and its pending acknowledgements (`:79-102`).
- SDK 1.32.1 (`@modelcontextprotocol/sdk`) already declares `tools: { listChanged: true }` once a tool is registered. A registered tool can be removed (`RegisteredTool.remove()`), and both registering and removing on a connected server send `notifications/tools/list_changed`.

## 2. Decision

**Split the module into a stable entry and a reloadable tool module. Re-register the tools in place when the built tool module changes. Tell the client through `tools/list_changed`, and tell the agent through a stale-build notice until the client re-lists.**

### 2.1 Module split

1. **`src/tools.ts`** (new, built to `dist/tools.js`) holds everything that defines tools: the helpers, `daemonFetch`, delivery, schemas and all 65 registrations.
   - It exports `registerTools(server, connection)`. That function performs today's `buildMcpServer()` body after `new McpServer(...)`: the registration wrapper, every `registerTool`, and the `tools/list` shaping.
   - It also exports `BUILD_ID`, a string fixed at build time. It is the package version plus a hash of the module's own source text, computed when the module is evaluated.
   - **It imports no local module,** only `node:*` and `node_modules`. This keeps a cache-busted re-import complete (§2.2). Test 1 enforces it.
   - It has no top-level side effects beyond defining constants.
2. **`src/index.ts`** (the entry, still `dist/index.js`) keeps the bin path that clients are configured with. It owns:
   - `new McpServer(...)` with its name, version and instructions. The instructions stay in the entry, because they are part of `initialize`, which a client reads once.
   - `newConnection()`: per-connection state survives a reload, so delegation delivery keeps its address and pending acknowledgements;
   - the transports and `main()`;
   - the reload watcher (§2.2) and the notice (§2.3).

   The entry imports `./tools.js` statically for the first load. That keeps the existing tests, which `import("../dist/index.js")` and capture the server through `McpServer.prototype.connect`, working unchanged.

### 2.2 Reload

- **Detection.** The entry polls `dist/tools.js` every 5 s, comparing `mtime` and `size` (`fs.stat`).
  - A change counts only when two consecutive polls agree. `tsc` writes files one at a time, and this avoids reading a half-written build.
  - Polling, not `fs.watch`. A watch is unreliable across editors and atomic renames, and costs more to get right than a 5 s stat.
  - The timer is `unref()`'d, so it never keeps the process alive.
- **Load.** `await import(pathToFileURL(toolsPath).href + "?v=" + mtimeMs)`.
  - Node caches ES modules by URL, so the query string evaluates the new file. The superseded module stays in memory, which is acceptable for a rare event.
  - Because `tools.js` imports no local module, the new code is the whole tool surface.
- **Swap.** This runs for every live `McpServer` the entry owns: the stdio one, and each HTTP session in `sessions`.
  1. Build the new registrations first. The new module's `registerTools` runs against a **scratch** `McpServer` whose `connect` is never called. If it throws, nothing is swapped (see Failure, below).
  2. Then, on the live server:
     - call `remove()` on every tool the entry recorded as registered;
     - call the new module's `registerTools(server, connection)` with the same `connection` object.

     `remove()` and `registerTool` each make the SDK send `notifications/tools/list_changed`. That costs a burst of notifications for one reload.
  3. New HTTP sessions created after the swap use the new module.
- **In-flight calls.** A tool call already running keeps the closure it started with and finishes on the old code. Calls that arrive after the swap use the new registrations. No call is cancelled.
- **Failure.**
  - If the import or the scratch registration throws, the live tools stay as they are. The entry records `{failed_build: mtime, error: message}` and does not retry that same `mtime`.
  - The notice (§2.3) reports the failure.
- **Opt-out.** `GC_MCP_RELOAD=0` disables the watcher (for example when running a published npm package from a read-only install).

### 2.3 Stale-build notice

A client may ignore `tools/list_changed`. Claude Code's handling of it is not something this repo controls. The server cannot tell whether the client acted on it, except by seeing a fresh `tools/list` request.

- After a successful swap, the entry sets `relisted = false` for that server. Its `tools/list` handler sets it back to `true`.
- While `relisted` is false, the delivery wrapper appends one text content item to every tool result, after any delegation block, so JSON results still parse:
  `[gc_mcp] Tools were reloaded from a newer build (<old BUILD_ID> → <new BUILD_ID>). If an action you expect is refused as unknown, reconnect the gc MCP server.`
- After a failed reload, the item reads:
  `[gc_mcp] A newer build failed to load (<error, first 200 characters>); still serving <BUILD_ID>.`
  It shows until a later reload succeeds.
- **Entry changes are not reloadable.** If `dist/index.js` itself changes (its `mtime` is polled with `tools.js`), the item reads:
  `[gc_mcp] The gc_mcp entry was rebuilt; reconnect the gc MCP server to load it.`
  The entry is small and changes rarely, but a change to it must not pass silently.

### 2.4 Scope

- No daemon change.
- No change to any tool's name, schema or behaviour.
- `instructions` stay entry-owned. Changing them still needs a reconnect, and they are not covered by the notice. They change rarely, and their content is advisory text, not a schema.
- `package.json` `files` must include `dist/tools.js`.

## 3. Tests

These are added to `npm test`, as `.mjs` files like the existing ones.

1. **Purity.** `dist/tools.js` contains no `import … from "./` or `"../`.
2. **Split parity.** Importing `dist/index.js` (the existing capture pattern) registers the same 65 tool names, with the same input schemas, as `master`. Compare against a snapshot of the names and of `tools/list` output generated from 4496e1d and committed with the test.
3. **Reload swaps in place.**
   - Connect a server to an in-memory transport pair (`InMemoryTransport.createLinkedPair()` from the SDK) with a client.
   - Copy `dist/` to a temp directory, then write a modified `tools.js` that adds an action to one enum.
   - Trigger the reload through the exported hook (§4).
   - Assert three things:
     - the client receives `notifications/tools/list_changed`;
     - `tools/list` now shows the new action;
     - a call using it validates.
   - The `connection.id` sent in `x-gc-client` is the same before and after. Assert this with a stub `daemonFetch` target, a local HTTP server.
4. **Failed reload keeps the old tools.** A `tools.js` that throws on import leaves `tools/list` unchanged and makes the next tool result carry the failure notice.
5. **Notice lifecycle.** After a successful reload, a tool result carries the reload notice. After the client issues `tools/list`, the next tool result does not.
6. **Entry change notice.** Touch the temp copy of `dist/index.js`. The next result carries the reconnect notice.
7. **Debounce.** A single poll that sees a change does not reload. Two agreeing polls do.

## 4. Seams

- The entry exports `__reloadNow(path?)` and `__pollOnce()`, used only by the tests, so tests 3–7 do not wait on the 5 s timer.
- The tools path is resolved from `import.meta.url`. Tests point it at their temp copy through `GC_MCP_TOOLS_PATH`.
