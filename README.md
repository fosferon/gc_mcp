# gc_mcp

`gc_mcp` exposes Grand Central daemon capabilities as MCP tools.

## Parameter validation

Every tool rejects unsupported **top-level** parameters before its callback can
contact `gc_daemon`. MCP returns its standard `isError: true` tool result; the
diagnostic names the rejected parameter and lists the parameters registered for
that tool. This makes a misspelled or obsolete option recoverable instead of
silently ignoring it.

This boundary does not alter nested payload contracts: a declared map or object
parameter continues to accept the nested values its existing schema allows.
