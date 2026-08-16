# gc_mcp

`gc_mcp` exposes Grand Central daemon capabilities as MCP tools.

It is a client, not a server of record: every tool call is proxied to a running
[`gc_daemon`](https://github.com/fosferon/gc_daemon). Without one listening on
`GC_DAEMON_URL` (default `http://localhost:4242`) the tools will load and then
fail to reach anything.

## Install

Point your MCP client at it — no clone or build required:

```json
{
  "mcpServers": {
    "gc": {
      "command": "npx",
      "args": ["-y", "@fosferon/gc-mcp"]
    }
  }
}
```

Or install it and use the binary directly:

```sh
npm install -g @fosferon/gc-mcp
gc-mcp                     # stdio (default) — the binary is unscoped
GC_MCP_TRANSPORT=streamable-http gc-mcp
```

From a clone, `npm install && npm run build` then point the client at
`node /path/to/gc_mcp/dist/index.js`.

## Parameter validation

Every tool rejects unsupported **top-level** parameters before its callback can
contact `gc_daemon`. MCP returns its standard `isError: true` tool result; the
diagnostic names the rejected parameter and lists the parameters registered for
that tool. This makes a misspelled or obsolete option recoverable instead of
silently ignoring it.

This boundary does not alter nested payload contracts: a declared map or object
parameter continues to accept the nested values its existing schema allows.

## Bee work queries

`gc_work` exposes Bee's query and dependency-analysis engine directly. Prefer a
bounded server-side query over fetching a backlog and filtering it in the client:

```json
{
  "action": "query",
  "text": "FameLine",
  "projects": ["mobus_umbrella", "lt_umbrella"],
  "status": "all",
  "order": "updated_at:desc",
  "detail": "minimal",
  "limit": 10
}
```

Use `search` for relevance-ranked duplicate lookup, `ready` or the `what_next`
intent for actionable work, `traverse` for a bounded dependency neighborhood,
and `critical_path` for a blocker-to-goal or project-scoped path. The legacy
`plan` action is only a compatibility alias for `critical_path`; scheduling is
provided separately by `gc_plan`.

The tool also exposes discoverable registered intents and measures, project and
agent allocation, assignments, locks, measurements, rollups, and bottleneck
analysis. Call the relevant list action before guessing stored vocabulary.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `GC_DAEMON_URL` | `http://localhost:4242` | Base URL of the `gc_daemon` this wraps. |
| `GC_MCP_TRANSPORT` | `stdio` | `stdio`, `streamable-http`, or `all`. |
| `GC_MCP_HOST` | `127.0.0.1` | Bind host, `streamable-http` only. |
| `GC_MCP_PORT` | `8765` | Bind port, `streamable-http` only. |
| `GC_MCP_PATH` | `/mcp` | HTTP path, `streamable-http` only. |
| `GH_TOKEN` | — | GitHub token for the `gh_*` tools. Falls back to `~/.config/gh-token`. |
| `GH_DEFAULT_REPO` | *unset* | `owner/repo` used by the **read-only** `gh_*` tools when `repo` is omitted. |

### Why `GH_DEFAULT_REPO` does not apply to writes

`gh_issue_create`, `gh_issue_edit` and `gh_issue_comment` require an explicit
`repo`. A write that infers its target from ambient configuration will
eventually file into the wrong tracker, and the caller who omitted the argument
gets no signal that it happened — the operation succeeds, somewhere else.
Reads carry no such consequence, so they may fall back to the environment.

There is deliberately no compiled-in default. A shipped repository name aims
every installation's bare calls at whatever tracker the author last worked on.
