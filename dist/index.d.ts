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
export {};
