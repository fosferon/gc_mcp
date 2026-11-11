# GC-7182: a running gc_mcp picks up a rebuilt tool schema without a reconnect

- **Bee:** GC-7182.
- **Repo:** gc_mcp.
- **Branch:** `gc/7182-schema-reload`, from `master` 4496e1d.
- **Status:** design rev 3, before implementation.
  - Rev 2 folded design audit round 1 (`audits/audit-gc-7182-design-round1.md`), which found 2 high, 2 medium and 3 low.
  - Rev 3 folds round 2 (`audits/audit-gc-7182-design-round2.md`), a PASS with conditions: 2 medium and 1 low.

## 1. The problem

An MCP client launches gc_mcp once per session, as `node …/dist/index.js`, and the process keeps the tool schema it loaded at startup. After gc_mcp is rebuilt, an older session still advertises and validates against the old schema.

A real case: a session started 2026-11-02 rejected `gc_dispatch action: cancel`, added 2026-11-05 (6149755). It also lacked `explain_route` and `availability`. The process serving that session ran a dist built before both commits, so the strict input schema refused the new actions. Nothing told the agent or the operator why. The only fix was to reconnect the MCP server by hand.

**What the code does today.**
- `src/index.ts` is a single module.
  - It builds the server in `buildMcpServer()` (`:1000-1995`), registers 65 tools through a wrapper that adds strict root validation and delegation delivery (`:1041-1064`), and overrides `tools/list` to inline local `$ref`s (`:5970-5992`).
  - Its last statement calls `main()`, which connects stdio and/or starts the streamable-HTTP listener (`:6158-6175`).
- **Module-level state that must outlive a reload:**
  - `daemonDispatcher`, the undici Agent (`:55-62`);
  - `callStore`, the AsyncLocalStorage that carries each call's connection (`:98`);
  - `unconfirmedTurnKeys`, GC-7152's at-least-once turn keys (`:554`), with `turnKeyFor`, `finishTurnKey`, `turnKeyKept` and `isClientCutShort` (`:531`, `:583-628`, which the tests import).
- **Per-connection state:** `newConnection()` (`:100`), created inside `buildMcpServer()` (`:1034`).
- **SDK 1.32.1 facts, verified in round 1:**
  - `McpServer` declares `tools.listChanged: true`.
  - `RegisteredTool.remove()` exists.
  - Registering or removing a tool on a connected server sends `notifications/tools/list_changed`, once per operation (`mcp.js:690`, `:695`).
  - The SDK installs its `tools/list` and `tools/call` handlers once per server, lazily, on the first `registerTool` (`mcp.js:96-99`, `:694`).
  - `setRequestHandler` replaces any existing handler (`shared/protocol.js:912-920`).
  - A `tools/call` captures the tool object before it runs (`mcp.js:142`), so a removal does not disturb a running call.

## 2. Decision

**Split the module into a stable entry that owns all setup and state, and a reloadable tool module that holds only tool code. Re-register the tools in place when the built tool module changes. Tell the client through `tools/list_changed`, and tell the agent through a stale-build notice until the client re-lists.**

### 2.1 Module split and ownership (round 1, Findings 1–3)

1. **`src/index.ts`, the entry (built to `dist/index.js`)**, keeps the bin path clients are configured with, and never reloads. It owns everything set up once or holding state:
   - **Process-wide `shared`**, created once:
     - `daemonDispatcher` and `daemonFetch`, the only undici Agent;
     - `callStore`;
     - the turn-key store `unconfirmedTurnKeys` and its four functions, which `dist/index.js` re-exports so `test/agent-conversation-turn-key.mjs` keeps working;
     - `noteInlineSeq`;
     - `describeError` and `packageDir` (§4);
     - `GC_BASE`.
   - **Per server**:
     - `new McpServer(...)` with its name, version and instructions;
     - its `connection` (`newConnection()`);
     - its notice state (§2.3);
     - the handles the current registration returned.
   - **Installed once per server, never re-run:**
     - the `registerTool` wrapper (strict root schema, `callStore.run`, `deliver()`, the notice);
     - after the first `registerTools`, the `tools/list` override (the `$ref` inlining, plus setting `relisted`).
     - The override has to come after that first call because the SDK installs its own handler lazily on the first `registerTool`.
   - Delivery: `deliver()` and `serialized()`.
   - The transports, `main()`, the server registry and the watcher (§2.2).
2. **`src/tools.ts`, the tool module (built to `dist/tools.js`)**, holds the 65 registrations and their tool-local helpers: schemas, formatters and the per-tool HTTP shaping. It exports:
   - **`registerTools(server, shared): RegisteredTool[]`.**
     - It calls `server.registerTool` 65 times. On a live server that is the entry's wrapper, so nothing is wrapped twice.
     - It returns the handles.
     - It reaches daemon HTTP, `callStore`, the turn-key store and `noteInlineSeq` only through `shared`. It assigns `shared` to a module-level `let` on each call. Every server passes the same `shared`, so that is safe.
   - **Build labels.** There is no build-id export. The entry labels each load as `tools.js@<mtime ISO-8601>`, from the `mtimeMs` the watcher already holds; the first load uses the file's `mtime` at startup. That keeps `tools.ts` free of evaluation-time reads (round 1, Finding 7).
   - **Purity rules:**
     - No local imports, static or dynamic, so a cache-busted re-import is complete. Test 1 enforces this.
     - No top-level side effects beyond defining constants and functions: no Agent, no timers, no env-driven I/O.
     - `GH_DEFAULT_REPO` and the gh token path stay simple constant reads, which are acceptable.

   The entry imports `./tools.js` statically for the first load. Existing tests that `import("../dist/index.js")` and capture the server through `McpServer.prototype.connect` therefore see the same 65 tools.

### 2.2 Reload

- **Registry.** The entry keeps `{current: toolsModule, servers: Set<{server, connection, notice, handles}>}`.
  - The stdio server and every HTTP session register in it on creation and unregister on close.
  - `sessions` stays local to the HTTP listener, but its factory calls `registry.add(...)`.
- **Detection.** A 5 s `unref()`'d timer `fs.stat`s two files: `dist/tools.js` (or `GC_MCP_TOOLS_PATH`) and the entry's own file (or `GC_MCP_ENTRY_PATH`).
  - A change counts only when two consecutive polls agree on `mtimeMs` and `size`, so a half-written `tsc` output is never read.
  - Polling is used rather than `fs.watch`, because a watch is unreliable across editors and atomic renames.
- **Load.** `await import(pathToFileURL(toolsPath).href + "?v=" + mtimeMs)`.
  - Node caches ES modules by URL, so the query evaluates the new file.
  - The superseded module stays in memory. That costs one module per reload; the module holds no Agent and no timers.
- **Validate.** Call the new module's `registerTools` on a **scratch** `McpServer` that never connects, with its wrapper installed the same way, and the real `shared`. Registration makes no daemon calls, so the scratch run has no side effects.
  - If the import or this registration throws, nothing is swapped. The entry records `{failed: mtimeMs, error}` and does not retry that `mtimeMs`.
  - The scratch run catches load-time and schema-construction errors. It cannot catch errors that only appear when a tool is called; those surface as tool errors, the same as on a fresh start.
- **Swap (round 1, Finding 4).** For each registered server, run this as **one synchronous block with no `await` inside**:
  1. `handles.forEach((h) => h.remove())`;
  2. `handles = registry.current.registerTools(server, shared)`;
  3. set the notice to "reloaded".

  Because the block is one JS task, no incoming `tools/call` or `tools/list` can observe an empty or partial set. The code carries a comment saying so, so a later refactor does not open the window.
  - Remove plus register is the right primitive: `RegisteredTool.update` cannot take a new ZodObject schema (`mcp.js:678-679`).
- **Notifications (round 2, Finding N2).** Each `remove()` and `registerTool` calls `McpServer.sendToolListChanged()`. That calls the async `Server.sendToolListChanged()` without awaiting or catching it (`mcp.js:809-812`). If the client has died, the rejection goes unhandled, and Node's default `--unhandled-rejections=throw` would end the whole process. Until now this never happened, because every registration ran before `connect`. The swap is the first code that sends on live connections.
  - So, at server creation, the entry replaces `server.server.sendToolListChanged`, once, with a wrapper that:
    - does nothing while that server's `swapping` flag is set;
    - otherwise calls the original and attaches `.catch(() => {})`. A dead client already shows up through the transport's close path.
  - The swap block sets `swapping = true`, removes the tools and registers the new ones, then sets `swapping = false` and sends **one** caught `list_changed`. That replaces the burst of about 130 per server.
  - A client that re-lists on it reads the final set, because the send happens after the block completes.
- **New HTTP sessions** take `registry.current` when they register. A session whose `initialize` lands while an import is in progress gets whichever module is current when it registers. If that is the old one, it is still in the registry and is swapped with the rest, because the swap iterates the registry after the import resolves.
- **In-flight calls** keep the closure they started with and finish on the old code. No call is cancelled.
- **Opt-out.** `GC_MCP_RELOAD=0` disables the watcher.

### 2.3 Stale-build notice (round 1, Findings 2 and 7)

The notice state is per server, in the entry: `{state: "fresh" | "reloaded" | "failed" | "entry_changed", from, to, error}`.
- The `tools/list` override sets `relisted`: a `"reloaded"` notice goes back to `"fresh"` once the client re-lists.
- The wrapper appends at most **one** notice item to each **successful** tool result. It goes after any delegation block, as a separate text content item, so JSON results still parse.
- A refused unknown action is an SDK-generated error that never reaches the wrapper (`mcp.js:181`). So the notice reaches the agent on its next successful call, which is enough to explain the refusal.

The three texts:
- **`reloaded`:** `[gc_mcp] Tools were reloaded from a newer build (`<from>` → `<to>`, as `tools.js@<mtime>` labels). If an action you expect is refused as unknown, reconnect the gc MCP server.` It shows until the client issues `tools/list`.
- **`failed`:** `[gc_mcp] A newer build failed to load (<error, first 200 characters>); still serving <from>.` It shows until a later reload succeeds.
- **`entry_changed`:** `[gc_mcp] The gc_mcp entry was rebuilt; reconnect the gc MCP server to load it.` It is permanent for that process. If more than one state applies, `entry_changed` wins. A tools reload still runs alongside it.

### 2.4 Scope

- No daemon change.
- No change to any tool's name, schema or behaviour.
- `instructions` stay owned by the entry. Changing them still needs a reconnect, and the notice does not cover them, because they are advisory text and rarely change.
- **Packaging:**
  - `package.json` `files` must ship `dist/tools.js`.
  - `bin` and `main` stay `dist/index.js`.

## 3. Tests

All tests are added to `npm test`. Each one that copies `dist/` puts the copy under the repo's `.tmp/` directory, which is gitignored, so bare-specifier imports resolve against `node_modules` (round 1, Finding 6).

1. **Purity.** `dist/tools.js` contains no static `import … from "./"` or `"../"`, and no dynamic `import("./…")` or `import("../…")`.
2. **Split parity.** Importing `dist/index.js` (the existing capture pattern) registers the same 65 tool names, with identical `tools/list` output, as a committed snapshot generated from 4496e1d.
3. **Reload swaps in place.**
   - Set up an in-memory client and server pair (`InMemoryTransport.createLinkedPair()`).
   - Point `GC_MCP_TOOLS_PATH` at a `.tmp/` copy, write a modified `tools.js` that adds an enum action, and call `__reloadNow()`.
   - Assert all of these:
     - the client receives `tools/list_changed`;
     - `tools/list` shows the new action;
     - a call using it validates;
     - the `x-gc-client` header seen by a stub daemon (a local HTTP server, via `GC_DAEMON_URL`) is identical before and after the reload.
4. **No stacking (round 1, Finding 1).** After **three** reloads, one successful tool call produces:
   - exactly **one** `POST /gc/delegations/take` at the stub daemon;
   - exactly **one** notice item.
5. **Failed reload keeps the old tools.** A `tools.js` that throws on import leaves `tools/list` unchanged, and the next successful result carries the `failed` notice.
6. **Notice lifecycle.**
   - After a reload, a result carries the `reloaded` notice.
   - After the client issues `tools/list`, the next result has no notice.
   - An error result never carries one.
7. **Entry change.** Point `GC_MCP_ENTRY_PATH` at a `.tmp/` file and touch it. After two polls, the next result carries the `entry_changed` notice.
8. **Debounce.** One poll that sees a change does not reload. Two agreeing polls do.
9. **Turn-key continuity (round 1, Finding 3).**
   - A `gc_agent_conversation` turn is cut short, against a stub daemon that holds the response.
   - Reload, then retry the same turn.
   - The stub sees the same idempotency key on both requests.
10. **One notification, no crash (round 2, Finding N2).**
    - A reload sends exactly one `tools/list_changed` per server.
    - When the client transport's `send` rejects during a reload, there is no unhandled rejection: the test installs a `process.on('unhandledRejection')` spy and asserts it is never called, and the process stays up.
11. **Atomic swap.** During `__reloadNow()`, a `tools/list` issued concurrently from the client returns either the full old set or the full new set, never a partial one.
12. **HTTP session after a swap.** A streamable-HTTP session created after a reload lists the new action.

## 4. Seams

- **`registerTools(server, shared)`.** `shared` is `{fetch, gcBase, callStore, turnKeys: {turnKeyFor, finishTurnKey, turnKeyKept, isClientCutShort}, noteInlineSeq, describeError, packageDir}`.
  - `describeError` is entry-owned because it reads the entry's `daemonDispatcher === undefined` (`src/index.ts:203-220`). That keeps the degraded-mode text `test/missing-undici.mjs:86-90` pins (round 2, Finding N1).
  - `packageDir` is the directory containing the entry module, i.e. what `dirname(import.meta.url)` returns in `dist/index.js` today, so the fallback's two `..` hops land exactly where they do now. `getResolveBridgePath`'s fallback (`src/index.ts:5108-5114`) resolves from it, not from `import.meta.url`, so a redirected `GC_MCP_TOOLS_PATH` does not move it (round 2, low).
  - Tests construct `shared` through the entry's exported `createShared()`.
- **Test hooks.** The entry exports `__reloadNow()`, `__pollOnce()` and `__registry`. Tests use them so they do not wait on the 5 s timer.
- **Environment.**
  - `GC_MCP_TOOLS_PATH` and `GC_MCP_ENTRY_PATH` redirect the two polled paths.
  - `GC_MCP_RELOAD=0` disables polling.
  - `GC_DAEMON_URL` points delivery at a stub daemon.
- **Re-exports.** `dist/index.js` re-exports `turnKeyFor`, `finishTurnKey`, `turnKeyKept` and `isClientCutShort`, which are the entry-owned ones.
