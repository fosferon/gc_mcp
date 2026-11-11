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
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as toolsModule from "./tools.js";
import type { Shared } from "./tools.js";
interface Connection {
    id: string;
    /** seqs handed on in returned responses, acknowledged by the next take */
    pendingAck: number[];
    /** serializes take + acknowledgement across this connection's parallel calls */
    queue: Promise<unknown>;
}
export declare function isClientCutShort(e: unknown): boolean;
/** Start a call on a slot: the kept key, or a new one. Exported for its test. */
export declare function turnKeyFor(slot: string, now?: number): string;
/**
 * End a call on a slot. `settled`: its caller learned the outcome. The slot is
 * freed only when settled and no other call on it is in flight; otherwise the
 * key is kept for the TTL from now. Exported for its test.
 */
export declare function finishTurnKey(slot: string, key: string, settled: boolean, now?: number): void;
/** Whether a slot still holds a key. Exported for its test. */
export declare function turnKeyKept(slot: string): string | undefined;
export declare function createShared(): Shared;
type NoticeState = {
    state: "fresh" | "reloaded" | "failed" | "entry_changed";
    from?: string;
    to?: string;
    error?: string;
};
type ServerEntry = {
    server: McpServer;
    connection: Connection;
    notice: NoticeState;
    handles: RegisteredTool[];
    swapping: boolean;
};
/** Test hook: the live registry and the module currently serving it. */
export declare const __registry: {
    current: typeof toolsModule;
    currentLabel: string;
    servers: Set<ServerEntry>;
};
/** Test hook: one watcher pass, including the two-poll debounce. */
export declare function __pollOnce(): Promise<void>;
/** Test hook: import and swap immediately, bypassing the poll debounce. */
export declare function __reloadNow(): Promise<void>;
export {};
