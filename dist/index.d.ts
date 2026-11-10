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
