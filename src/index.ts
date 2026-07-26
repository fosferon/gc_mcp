#!/usr/bin/env node
/**
 * gc_mcp — Universal MCP server for Grand Central
 *
 * Thin translation layer: MCP tool calls → HTTP POST to gc_daemon (localhost:4242)
 * Plus 3 standalone tools: davinci_resolve, devonthink, gh_issues
 *
 * Usage:
 *   node dist/index.js                          # stdio (default)
 *   GC_MCP_TRANSPORT=streamable-http node dist/index.js
 *   GC_MCP_TRANSPORT=all node dist/index.js
 *
 * Config:
 *   { "mcpServers": { "gc": { "command": "node", "args": ["~/Sites/agents/gc_mcp/dist/index.js"] } } }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";

// ════════════════════════════════════════════════════════════════
// HTTP Client — gc_daemon at localhost:4242
// ════════════════════════════════════════════════════════════════

const GC_BASE = process.env.GC_DAEMON_URL || "http://localhost:4242";

/**
 * POST to gc_daemon.
 *
 * timeoutMs controls the client-side abort:
 *   - undefined (default) → 15s, suitable for fire-and-forget tools
 *   - positive number     → explicit client-side deadline in ms
 *   - null                → no client-side abort at all (fetch waits forever)
 *
 * Long-running tools (wait-mode dispatch, workflow wait) must override the
 * default — the 15s default exists only because most tools are interactive.
 */
async function gcPost(
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number | null | undefined = 15_000,
): Promise<any> {
  const url = `${GC_BASE}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
  if (timeoutMs !== null && timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`gc_daemon ${path} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

async function gcGet(path: string): Promise<any> {
  const url = `${GC_BASE}${path}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!resp.ok) throw new Error(`gc_daemon ${path} failed (${resp.status})`);
  return resp.json();
}

async function gcGetResponse(
  path: string,
  timeoutMs: number | null | undefined = 15_000,
): Promise<Response> {
  const url = `${GC_BASE}${path}`;
  const init: RequestInit = {};
  if (timeoutMs !== null && timeoutMs !== undefined) {
    init.signal = AbortSignal.timeout(timeoutMs);
  }

  const resp = await fetch(url, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`gc_daemon ${path} failed (${resp.status}): ${text}`);
  }
  return resp;
}

async function gcDelete(path: string): Promise<any> {
  const url = `${GC_BASE}${path}`;
  const resp = await fetch(url, {
    method: "DELETE",
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`gc_daemon ${path} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

/** Strip undefined values from params before sending to daemon */
function clean(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Standard MCP text result */
function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** Standard MCP error result */
function err(msg: string) {
  return {
    content: [{ type: "text" as const, text: msg }],
    isError: true as const,
  };
}

type WorkflowWatchEvent = {
  event: string;
  data: unknown;
  rawData: string;
};

function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function summarizeWatchEvent(event: WorkflowWatchEvent): string {
  if (event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    const bits = [event.event];
    if (typeof data.status === "string") bits.push(`status=${data.status}`);
    if (typeof data.step === "string") bits.push(`step=${data.step}`);
    if (typeof data.id === "string") bits.push(`id=${data.id}`);
    return bits.join(" ");
  }

  return `${event.event} ${event.rawData}`.trim();
}

function isTerminalWatchEvent(event: WorkflowWatchEvent): boolean {
  if (event.event === "final") return true;
  if (event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    return data.final === true || data.settled === true;
  }
  return false;
}

function isFailedWatchEvent(event: WorkflowWatchEvent): boolean {
  if (event.event === "error") return true;
  if (event.data && typeof event.data === "object") {
    const data = event.data as Record<string, unknown>;
    return data.status === "failed";
  }
  return false;
}

async function readSseStream(
  resp: Response,
  onEvent?: (event: WorkflowWatchEvent, index: number) => Promise<void> | void,
): Promise<{ events: WorkflowWatchEvent[]; terminal?: WorkflowWatchEvent }> {
  if (!resp.body) {
    throw new Error("gc_daemon SSE stream returned no response body");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  const events: WorkflowWatchEvent[] = [];
  let terminal: WorkflowWatchEvent | undefined;

  const flushEvent = async () => {
    if (dataLines.length === 0) return;

    const rawData = dataLines.join("\n");
    let data: unknown = rawData;
    try {
      data = JSON.parse(rawData);
    } catch {}

    const event: WorkflowWatchEvent = {
      event: eventName || "message",
      data,
      rawData,
    };

    events.push(event);
    await onEvent?.(event, events.length);

    if (isTerminalWatchEvent(event)) {
      terminal = event;
    }

    eventName = "message";
    dataLines = [];
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);

      if (line === "") {
        await flushEvent();
        if (terminal) {
          await reader.cancel().catch(() => undefined);
          return { events, terminal };
        }
        continue;
      }

      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    if (done) {
      if (buffer.trim() || dataLines.length > 0) {
        if (buffer.trim()) dataLines.push(buffer.trim());
        await flushEvent();
      }
      return { events, terminal };
    }
  }
}

async function readWorkflowWatchStream(
  executionId: string,
  timeoutMs: number | null | undefined,
  onEvent?: (event: WorkflowWatchEvent, index: number) => Promise<void> | void,
): Promise<{ events: WorkflowWatchEvent[]; terminal?: WorkflowWatchEvent }> {
  const resp = await gcGetResponse(
    `/gc/workflow/${encodeURIComponent(executionId)}/watch`,
    timeoutMs,
  );
  return readSseStream(resp, onEvent);
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;

  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce<unknown>((current, key) => {
      if (
        current &&
        typeof current === "object" &&
        key in (current as Record<string, unknown>)
      ) {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    }, root);
}

function inlineLocalRefs<T>(schema: T): T {
  const root = structuredClone(schema);

  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(visit);
    }

    if (!node || typeof node !== "object") {
      return node;
    }

    const record = node as Record<string, unknown>;

    if (typeof record.$ref === "string" && record.$ref.startsWith("#/")) {
      const target = resolveJsonPointer(root, record.$ref);
      if (target && typeof target === "object") {
        const { $ref: _ignored, ...rest } = record;
        return visit({
          ...structuredClone(target as Record<string, unknown>),
          ...rest,
        });
      }
    }

    return Object.fromEntries(
      Object.entries(record).map(([key, value]) => [key, visit(value)]),
    );
  };

  return visit(root) as T;
}

/** Call daemon and return formatted JSON */
async function daemonCall(
  endpoint: string,
  params: Record<string, unknown>,
  timeoutMs: number | null | undefined = 15_000,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  try {
    const result = await gcPost(endpoint, clean(params), timeoutMs);
    return text(JSON.stringify(result, null, 2));
  } catch (e: any) {
    return err(`ERROR: ${e.message}`);
  }
}

// ════════════════════════════════════════════════════════════════
// Schema helpers — value-shape parity with daemon's GcDaemon.Timeouts
// ════════════════════════════════════════════════════════════════
//
// The daemon parses every timeout via GcDaemon.Timeouts.parse/2 which
// accepts: integer | string-of-int | "none" | "infinity" | "infinite".
// Pre-GC-773 the MCP shim declared `timeout: z.number()` which rejected
// LLM-stringified values like "600" — the user couldn't wait on a workflow
// because the Zod layer rejected the call before it ever reached the
// daemon. zTimeout() / zPositiveNumber() close that value-shape hole and
// keep the MCP contract aligned with the daemon's parser.
//
// `z.coerce.number()` accepts numeric input AND parses string-of-int.
// Combined with the literal alternatives we cover the full Timeouts.parse
// value space.

const zTimeout = () =>
  z.union([
    z.coerce.number().positive(),
    z.literal("none"),
    z.literal("infinity"),
    z.literal("infinite"),
  ]);

const zPositiveNumber = () => z.coerce.number().positive();

// Generic numeric coercion — accepts int, float, and string-of-number.
// Same semantic as the old `z.number()` but string-tolerant. Apply to every
// numeric field by default; reach for zPositiveNumber() / zTimeout() only when
// the field carries additional constraints.
const zNumber = () => z.coerce.number();

// Boolean with string tolerance. NB: NOT `z.coerce.boolean()` — that coerces
// any truthy value and silently turns the string "false" into `true`, which
// is the opposite of what an LLM that stringified the literal means. This
// helper accepts only real booleans and the exact strings "true"/"false".
const zBoolean = () =>
  z.union([
    z.boolean(),
    z.literal("true").transform(() => true),
    z.literal("false").transform(() => false),
  ]);

// ════════════════════════════════════════════════════════════════
// MCP Server
// ════════════════════════════════════════════════════════════════

function buildMcpServer() {
  const server = new McpServer(
    { name: "gc", version: "1.0.0" },
    {
    instructions: [
      "Grand Central operations hub. All tools route to gc_daemon (localhost:4242).",
      "Use gc_recall for memory search (FTS5, instant). gc_retain to store facts.",
      "gc_docs queries the packaged gc_daemon user manual — use it for setup, configuration, workflows, templates, and troubleshooting.",
      "gc_onboarding drives the guided setup DAG and setup-degree checks.",
      "gc_control executes deterministic, approval-gated operations directly.",
      "gc_capability reports which features are currently lit up.",
      "gc_cost checks cost ceilings, spend, and breaker state.",
      "gc_posture tunes operator trust levels for autonomous actions.",
      "gc_hindsight queries the deep-memory Hindsight cache.",
      "gc_conversation / gc_agent_conversation / gc_aden manage interactive chat sessions.",
      "gc_run watches and controls observable workflow/execution runs.",
      "gc_checkpoint fetches and resolves approval checkpoints.",
      "gc_workflow_watch follows a workflow execution live via SSE.",
      "gc_work manages the Bee DAG — issues, dependencies, assignments.",
      "gc_plan answers 'what should I work on next?' with scored recommendations.",
      "gc_convergence tracks strategic vectors — use 'report' for the real 'where are we at?'",
      "gc_ticker provides situational awareness snapshots.",
      "gc_a2a is the Agent-to-Agent protocol client — send tasks to agents, check status, register as a worker.",
      "gc_peer_conversation is the chat-style lane for ongoing dialogue with external A2A peers; use it instead of gc_dispatch when you want a conversation rather than a job.",
    ].join(" "),
    },
  );

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Memory
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_recall",
  {
    description: `Search the memory bank for facts matching a query. Uses FTS5/BM25 — instant, zero cost.
Falls back to hindsight (expensive, deep) only if no local results and hindsight is available.
Returns ranked facts with bank attribution and match scores.

Superseded facts (those replaced via gc_retain supersedes) are EXCLUDED by default — you get current truth only.
Each returned fact may include a "superseded_by" field pointing to the fact that replaced it (only visible when include_superseded: true).
Use include_superseded: true for historical audits.`,
    inputSchema: z.object({
      query: z.string().describe("Natural language search query"),
      bank: z
        .string()
        .optional()
        .describe("Filter to specific bank (omit for global search)"),
      limit: zNumber().optional().describe("Max results (default 15)"),
      mode: z
        .enum(["linear", "deep", "full"])
        .optional()
        .describe(
          '"linear" (default) = local facts only, recency-weighted. "deep" = includes HS-imports. "full" = everything, pure BM25 (debug).',
        ),
      hindsight: z
        .enum(["never", "fallback", "always"])
        .optional()
        .describe(
          '"never" = local only, "fallback" = use if no local results, "always" = always call hindsight too',
        ),
      include_superseded: zBoolean()
        .optional()
        .describe(
          "If true, include facts that have been superseded. Each such fact is returned with a superseded_by: <id> field. Default: false (current truth only).",
        ),
    }),
  },
  async (params) => daemonCall("/gc/recall", params),
);

server.registerTool(
  "gc_retain",
  {
    description: `Store a fact in the memory bank. Auto-routes to the best bank by keyword matching, or specify a bank.

Deduplication:
  - Fingerprint dedup only (exact normalized-content match). Fuzzy/BM25 dedup removed — it was silently rejecting corrections.
  - Supersedes bypasses even fingerprint dedup — an explicit replacement signal always stores.

Response contract (READ THIS):
  - { stored: true, duplicate: false, id, bank }  → fact was stored
  - { stored: false, duplicate: true, existing_id } → fact was NOT stored; same fingerprint already in DB
  ALWAYS check 'stored' to know whether your content was persisted. 'ok: true' only means the call succeeded, not that storage happened.

Supersedes + recall: when you pass supersedes: [<old-id>], the old fact is marked as replaced and won't show up in default recall results.
Use recall with include_superseded: true to see historical versions.`,
    inputSchema: z.object({
      content: z
        .string()
        .describe(
          "The fact to store — be specific and include relevant context",
        ),
      bank: z
        .string()
        .optional()
        .describe("Target bank (auto-routed if omitted)"),
      context: z
        .string()
        .optional()
        .describe(
          "Category: architecture, decision, pattern, convention, bug, etc.",
        ),
      tags: z.array(z.string()).optional().describe("Tags for this fact"),
      source: z.string().optional().describe("Where this fact comes from"),
      supersedes: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "Fact ID(s) this new fact supersedes. Marks the old fact(s) as replaced (hidden from default recall) AND bypasses fingerprint dedup so your correction is always stored.",
        ),
      origin: z
        .string()
        .optional()
        .describe("Origin: 'local' (default), 'hs-import', 'hs-echo'"),
      hindsight: zBoolean()
        .optional()
        .describe("Also push to Hindsight for deep memory"),
    }),
  },
  async (params) => daemonCall("/gc/retain", params),
);

server.registerTool(
  "gc_reflect",
  {
    description: `Analyze coverage for a topic across all memory banks.
Shows: which banks have relevant facts, tag distribution, coverage gaps, stale facts.`,
    inputSchema: z.object({
      topic: z.string().describe("Topic to analyze coverage for"),
      bank: z.string().optional().describe("Restrict analysis to one bank"),
    }),
  },
  async (params) => daemonCall("/gc/reflect", params),
);

server.registerTool(
  "gc_banks",
  {
    description: `Manage memory banks: list all banks with stats, or create new banks.
Actions: "list" = show all banks, "create" = new bank, "stats" = detailed statistics.`,
    inputSchema: z.object({
      action: z
        .enum(["list", "create", "delete", "stats"])
        .describe("Action to perform"),
      name: z.string().optional().describe("Bank name (for create/delete)"),
      description: z
        .string()
        .optional()
        .describe("Bank description (for create)"),
      keywords: z
        .array(z.string())
        .optional()
        .describe("Bank keywords (for create)"),
      force: zBoolean()
        .optional()
        .describe("Force delete a non-empty bank (for delete)"),
    }),
  },
  async (params) => daemonCall("/gc/banks", params),
);

server.registerTool(
  "gc_obsidian_vault",
  {
    description: `Obsidian vault knowledge-base indexing.
Indexes Obsidian vault .md files into the memory bank for fast retrieval via gc_recall.
Actions: "reindex" = enqueue a full reindex now, "status" = show vault config and indexed chunk count.`,
    inputSchema: z.object({
      action: z
        .enum(["reindex", "status"])
        .describe("Action to perform"),
    }),
  },
  async (params) => daemonCall("/gc/obsidian_vault", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Documentation
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_docs",
  {
    description: `Query the packaged gc_daemon user manual.
Use this whenever you need authoritative help with daemon setup, configuration, workflows, templates, or troubleshooting.
Actions:
- search: keyword search over doc titles, ids, and tags
- get: retrieve a doc body by id or path
- list: list docs, templates, workflows, or checklists
- guide: return a ranked guide (docs + checklists + templates) for a topic
- template: return the raw contents of a starter template by name
- validate: check that the manual package is intact`,
    inputSchema: z.object({
      action: z
        .enum(["search", "get", "list", "guide", "template", "validate"])
        .describe("Action to perform"),
      query: z
        .string()
        .optional()
        .describe("Keyword query (for search)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter by tags (for search/list)"),
      limit: zNumber()
        .optional()
        .describe("Max results (for search/guide, default 10, cap 100)"),
      id: z
        .string()
        .optional()
        .describe("Doc id (for get)"),
      path: z
        .string()
        .optional()
        .describe("Doc path (for get)"),
      kind: z
        .enum(["doc", "template", "workflow", "checklist"])
        .optional()
        .describe("Collection kind (for list, default doc)"),
      topic: z
        .string()
        .optional()
        .describe("Topic for guided results (for guide)"),
      name: z
        .string()
        .optional()
        .describe("Template name or id (for template)"),
    }),
  },
  async (params) => daemonCall("/gc/docs", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Memory Maintenance
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_rebuild_fts",
  {
    description: `Emergency rebuild of the memory-bank FTS5 index.
Use when recall/search is returning stale or incomplete results despite facts existing in the bank. This is a maintenance operation, not a daily tool.`,
    inputSchema: z.object({}),
  },
  async () => daemonCall("/gc/rebuild_fts", {}),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Uniform Tool Call Surface
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_tool_call",
  {
    description: `Execute any daemon tool by name through the uniform tool-call surface (GC-2632).
Useful when you know the exact tool name and want to dispatch it without a dedicated MCP tool. Handler tools (gc_*) are always available. Code tools (bash, read_file, etc.) require server-side code-tool execution to be enabled.`,
    inputSchema: z.object({
      name: z.string().describe("Tool name to execute"),
      arguments: z
        .record(z.any())
        .optional()
        .describe("Arguments object for the tool (default {}),"),
      session_id: z
        .string()
        .optional()
        .describe("Session ID for resolving cwd (code tools)"),
      cwd: z
        .string()
        .optional()
        .describe("Explicit working directory (code tools)"),
    }),
  },
  async (params) => daemonCall("/gc/tool_call", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Templating
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_template",
  {
    description: `Merge-field templating (GC-2774).
- placeholders: list available {{ }} placeholders for a context
- fill: render a template block with explicit values`,
    inputSchema: z.object({
      action: z
        .enum(["placeholders", "fill"])
        .describe("Action to perform"),
      context: z
        .enum(["reply", "template"])
        .optional()
        .describe("Template context (for placeholders)"),
      message_id: z.string().optional().describe("Message ID (for placeholders)"),
      record_type: z.string().optional().describe("Record type (for placeholders)"),
      block_json: z
        .record(z.any())
        .optional()
        .describe("Template block JSON object (for fill)"),
      values: z
        .record(z.any())
        .optional()
        .describe("Merge-field values (for fill)"),
      email: zBoolean()
        .optional()
        .describe("Render email-compatible output (for fill)"),
    }),
  },
  async (params) => daemonCall("/gc/template", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Deterministic Controls
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_control",
  {
    description: `Deterministic dual-path controls (Story 3.1). Direct, LLM-free execution of approved operations.
- manifest: list control-reachable operations and their risk metadata
- execute: run one control; may return held: true if the gate requires approval`,
    inputSchema: z.object({
      action: z
        .enum(["manifest", "execute"])
        .describe("Action to perform"),
      tool: z.string().optional().describe("Tool name (for execute)"),
      op: z.string().optional().describe("Operation name (for execute)"),
      args: z
        .record(z.any())
        .optional()
        .describe("Operation arguments object (for execute)"),
      idempotency_key: z
        .string()
        .optional()
        .describe("Idempotency key (for execute)"),
    }),
  },
  async (params) => daemonCall("/gc/control", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Onboarding DAG
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_onboarding",
  {
    description: `Onboarding DAG orchestration and setup generation.
Key actions:
- setup_degree: current readiness state (ready | setup-required | degraded)
- bootstrap_apex: minimal pre-apex bootstrap (credential one provider)
- recommended_action: server-authoritative next step
- begin/expand/advance: companion-driven guided flow
- state/summary/show/list/ready/next/node: inspect DAG state
- launch_node/update_node/submit_answers: drive the DAG
- create/create_template/template: build onboarding DAGs
- catalog/admin_overview/readiness: administration views`,
    inputSchema: z.object({
      action: z
        .enum([
          "create",
          "create_template",
          "template",
          "list_templates",
          "catalog",
          "admin_overview",
          "readiness",
          "setup_degree",
          "bootstrap_apex",
          "recommended_action",
          "list",
          "show",
          "summary",
          "state",
          "focus",
          "node",
          "ready",
          "blocked",
          "next",
          "update_node",
          "bind_execution",
          "reset_node",
          "launch_node",
          "submit_answers",
          "advance",
          "reset",
          "resume_node",
          "begin",
          "expand",
          "provider_setup",
          "assistant_agent_setup",
          "optional_schedule_setup",
          "writer_agent_setup",
          "optional_content_schedule_setup",
          "project_discovery_or_registration",
          "developer_agent_setup",
          "work_dag_alignment",
          "project_lane_binding",
          "project_directive_seed",
          "mail_endpoint_setup",
          "optional_mail_digest_setup",
          "memory_bank_setup",
          "optional_memory_capture_workflow_setup",
          "content_piece_setup",
          "distribution_post_setup",
          "optional_distribution_workflow_setup",
        ])
        .describe("Action to perform"),
      id: z.string().optional().describe("DAG instance ID"),
      node_key: z.string().optional().describe("Node key within a DAG"),
      template: z.string().optional().describe("Template ID (for create_template/template)"),
      templates: z
        .array(z.string())
        .optional()
        .describe("Multiple template IDs"),
      status: z.string().optional().describe("New node status (for update_node)"),
      execution_id: z.string().optional().describe("Workflow execution ID (for bind_execution)"),
      answers: z
        .record(z.any())
        .optional()
        .describe("Answers object (for submit_answers)"),
      params: z
        .record(z.any())
        .optional()
        .describe("Override params (for launch_node)"),
      scope: z
        .string()
        .optional()
        .describe("Reset scope: branch | downstream | all (default branch)"),
      context: z
        .record(z.any())
        .optional()
        .describe("Resume context object (for resume_node)"),
      input_payload: z.any().optional().describe("Node input payload"),
      output_summary: z.string().optional().describe("Node output summary"),
      resume_execution_id: z.string().optional().describe("Resume execution ID"),
      metadata: z.record(z.any()).optional().describe("Node metadata"),
      capability: z.string().optional().describe("Capability scope (for recommended_action)"),
    }),
  },
  async (params) => daemonCall("/gc/onboarding", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Capability State
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_capability",
  {
    description: `Reflected capability-state snapshot (features-light-up). Returns the current capability snapshot the front-end uses to decide which features are available.`,
    inputSchema: z.object({
      action: z.literal("state").describe("Action to perform"),
    }),
  },
  async (params) => daemonCall("/gc/capability", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Beat Accumulation
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_beat",
  {
    description: `Beat accumulation: ingest turns, check status, flush buffers, report durability.
Actions: ingest, status, flush, report.`,
    inputSchema: z.object({
      action: z
        .enum(["ingest", "status", "flush", "report"])
        .describe("Action to perform"),
      session_id: z.string().optional().describe("Session ID"),
      role: z.string().optional().describe("Turn role (for ingest)"),
      text: z.string().optional().describe("Turn text (for ingest)"),
      tool_calls: z
        .array(z.any())
        .optional()
        .describe("Tool calls in this turn (for ingest)"),
      files_read: z
        .array(z.string())
        .optional()
        .describe("Files read (for ingest)"),
      files_modified: z
        .array(z.string())
        .optional()
        .describe("Files modified (for ingest)"),
      agent: z.string().optional().describe("Agent name (for ingest)"),
      hostname: z.string().optional().describe("Hostname (for ingest)"),
      cwd: z.string().optional().describe("Working directory (for ingest)"),
      bank: z.string().optional().describe("Bank filter (for report)"),
    }),
  },
  async (params) => daemonCall("/gc/beat", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Cost Guard
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_cost",
  {
    description: `Provider cost ceilings and circuit-breaker (Story 3.3, AD-26).
Actions: set_ceiling, get_ceilings, status, spend, check, reset, estimate.`,
    inputSchema: z.object({
      action: z
        .enum([
          "set_ceiling",
          "get_ceilings",
          "status",
          "spend",
          "check",
          "reset",
          "estimate",
        ])
        .describe("Action to perform"),
      scope: z
        .enum(["run", "tree"])
        .optional()
        .describe("Cost scope (run or tree)"),
      scope_id: z.string().optional().describe("Scope ID"),
      ceiling_cents: zNumber().optional().describe("Ceiling in cents (for set_ceiling)"),
      cents: zNumber().optional().describe("Spend amount in cents (for spend)"),
      provider: z.string().optional().describe("Provider name (for spend)"),
      action_name: z.string().optional().describe("Action name (for spend)"),
      estimated_cents: zNumber().optional().describe("Estimated cents (for check)"),
      provider_id: z.string().optional().describe("Provider ID (for estimate)"),
      input_tokens: zNumber().optional().describe("Input tokens (for estimate)"),
      output_tokens: zNumber().optional().describe("Output tokens (for estimate)"),
    }),
  },
  async (params) => daemonCall("/gc/cost", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Trust Posture
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_posture",
  {
    description: `Operator-tunable trust posture (Story 3.6, FR-6).
Actions: get, set_global, set_tool_trust, clear_tool_trust.`,
    inputSchema: z.object({
      action: z
        .enum(["get", "set_global", "set_tool_trust", "clear_tool_trust"])
        .describe("Action to perform"),
      level: z
        .enum(["cautious", "normal", "trusting"])
        .optional()
        .describe("Global posture level (for set_global)"),
      tool: z.string().optional().describe("Tool name (for set_tool_trust/clear_tool_trust)"),
      loosen_reasons: z
        .array(z.string())
        .optional()
        .describe("Reasons to loosen for this tool (for set_tool_trust)"),
    }),
  },
  async (params) => daemonCall("/gc/posture", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Orchestration Trees
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_orchestration",
  {
    description: `Orchestration trees: create + seat-switch for agent hierarchies (Story 2.11, FR-21).
Actions: plant, launch, seat, tree, node, list.`,
    inputSchema: z.object({
      action: z
        .enum(["plant", "launch", "seat", "tree", "node", "list"])
        .describe("Action to perform"),
      agent: z.string().optional().describe("Agent name (for plant)"),
      tree_id: z.string().optional().describe("Tree ID (for plant/tree)"),
      session_id: z.string().optional().describe("Session ID (for plant)"),
      label: z.string().optional().describe("Label (for plant/launch)"),
      parent_node_id: z.string().optional().describe("Parent node ID (for launch)"),
      child_agent: z.string().optional().describe("Child agent name (for launch)"),
      message: z.string().optional().describe("Dispatch message (for launch)"),
      node_id: z.string().optional().describe("Node ID (for seat/node)"),
    }),
  },
  async (params) => daemonCall("/gc/orchestration", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Local Model / Offline Operation
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_local_model",
  {
    description: `Local MLX model provisioning and offline operation status (Story 2.10, AD-34).
Actions: provision, status, offline, connectivity.`,
    inputSchema: z.object({
      action: z
        .enum(["provision", "status", "offline", "connectivity"])
        .describe("Action to perform"),
      endpoint: z.string().optional().describe("Local model endpoint (for provision)"),
      model: z.string().optional().describe("Model name (for provision)"),
    }),
  },
  async (params) => daemonCall("/gc/local_model", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Hindsight Deep Memory
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_hindsight",
  {
    description: `Direct Hindsight deep-memory proxy.
Actions: health, recall, reflect, retain.`,
    inputSchema: z.object({
      action: z
        .enum(["health", "recall", "reflect", "retain"])
        .describe("Action to perform"),
      query: z.string().optional().describe("Query string (for recall/reflect)"),
      bank_id: z.string().optional().describe("Hindsight bank ID (default: default)"),
      bank: z.string().optional().describe("Alias for bank_id"),
      limit: zNumber().optional().describe("Max results (for recall, default 10)"),
      content: z.string().optional().describe("Content to retain (for retain)"),
      metadata: z
        .record(z.any())
        .optional()
        .describe("Metadata for retained content (for retain)"),
    }),
  },
  async (params) => daemonCall("/gc/hindsight", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Telegram
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_telegram",
  {
    description: `Telegram bot poller status. Returns whether the poller is running and connected.`,
    inputSchema: z.object({
      action: z.literal("status").describe("Action to perform"),
    }),
  },
  async (params) => {
    // GET endpoint; use gcGet for the simple status query.
    try {
      const result = await gcGet("/gc/telegram/status");
      return text(JSON.stringify(result, null, 2));
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — AI Conversation
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_conversation",
  {
    description: `Interactive AI conversation sessions (backend-neutral).
Actions:
- spawn: create a new session (persona/agent_name, optional config, make_apex)
- turn: send a message and get the assistant response
- submit_tool_results: provide results for pending tool calls
- cut_in: inject an operator message into a running session
- get/list/delete: inspect or close sessions
- diagnostics: persona/path resolution diagnostics
- apex_status: show the active apex session
- activate_apex: bind a session as the apex`,
    inputSchema: z.object({
      action: z
        .enum([
          "spawn",
          "turn",
          "submit_tool_results",
          "cut_in",
          "get",
          "list",
          "delete",
          "diagnostics",
          "apex_status",
          "activate_apex",
        ])
        .describe("Action to perform"),
      persona: z.string().optional().describe("Persona/agent name (for spawn)"),
      agent_name: z.string().optional().describe("Alias for persona (for spawn)"),
      agent: z.string().optional().describe("Alias for persona (for spawn)"),
      config: z.record(z.any()).optional().describe("Session config object (for spawn)"),
      make_apex: zBoolean()
        .optional()
        .describe("Activate as apex after spawn (default true)"),
      session_id: z.string().optional().describe("Session ID (for turn/get/delete/etc.)"),
      id: z.string().optional().describe("Alias for session_id"),
      message: z.string().optional().describe("User message (for turn/cut_in)"),
      from: z.string().optional().describe("Cut-in sender label (for cut_in)"),
      tool_results: z
        .array(z.any())
        .optional()
        .describe("Tool results array (for submit_tool_results)"),
      results: z
        .array(z.any())
        .optional()
        .describe("Alias for tool_results"),
    }),
  },
  async (params) => {
    const action = params.action;
    const sessionId = params.session_id || params.id;

    try {
      if (action === "spawn") {
        const result = await gcPost("/gc/conversation", params);
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "list" || action === "diagnostics" || action === "apex_status") {
        const path =
          action === "list"
            ? "/gc/conversation"
            : action === "diagnostics"
              ? "/gc/conversation/diagnostics"
              : "/gc/conversation/apex";
        const result = await gcGet(path);
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "activate_apex") {
        const result = await gcPost("/gc/conversation/apex", {
          session_id: sessionId,
          id: sessionId,
        });
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "turn" || action === "submit_tool_results" || action === "cut_in") {
        if (!sessionId) return err("session_id (or id) is required");
        const path =
          action === "turn"
            ? `/gc/conversation/${encodeURIComponent(sessionId)}/turn`
            : action === "cut_in"
              ? `/gc/conversation/${encodeURIComponent(sessionId)}/cut_in`
              : `/gc/conversation/${encodeURIComponent(sessionId)}/tool_results`;
        const result = await gcPost(path, params);
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "get" || action === "delete") {
        if (!sessionId) return err("session_id (or id) is required");
        const path = `/gc/conversation/${encodeURIComponent(sessionId)}`;
        const result =
          action === "get" ? await gcGet(path) : await gcDelete(path);
        return text(JSON.stringify(result, null, 2));
      }
      return err(`unsupported gc_conversation action: ${action}`);
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Local Agent Conversation
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_agent_conversation",
  {
    description: `Chat-style sessions with local GC agents.
Actions: spawn, turn, get, list, delete.`,
    inputSchema: z.object({
      action: z
        .enum(["spawn", "turn", "get", "list", "delete"])
        .describe("Action to perform"),
      agent_name: z.string().optional().describe("Agent name (for spawn)"),
      agent: z.string().optional().describe("Alias for agent_name (for spawn)"),
      config: z.record(z.any()).optional().describe("Session config (for spawn)"),
      session_id: z.string().optional().describe("Session ID"),
      id: z.string().optional().describe("Alias for session_id"),
      message: z.string().optional().describe("Message (for turn)"),
    }),
  },
  async (params) => {
    const action = params.action;
    const sessionId = params.session_id || params.id;

    try {
      if (action === "spawn") {
        const result = await gcPost("/gc/agent_conversation", params);
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "list") {
        const result = await gcGet("/gc/agent_conversation");
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "turn") {
        if (!sessionId) return err("session_id (or id) is required");
        const result = await gcPost(
          `/gc/agent_conversation/${encodeURIComponent(sessionId)}/turn`,
          params,
        );
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "get" || action === "delete") {
        if (!sessionId) return err("session_id (or id) is required");
        const path = `/gc/agent_conversation/${encodeURIComponent(sessionId)}`;
        const result =
          action === "get" ? await gcGet(path) : await gcDelete(path);
        return text(JSON.stringify(result, null, 2));
      }
      return err(`unsupported gc_agent_conversation action: ${action}`);
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Aden Conversation
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_aden",
  {
    description: `Aden conversation instances.
Actions: spawn, turn, get, list, delete.`,
    inputSchema: z.object({
      action: z
        .enum(["spawn", "turn", "get", "list", "delete"])
        .describe("Action to perform"),
      business_name: z.string().optional().describe("Business name (for spawn)"),
      pre_research: z.string().optional().describe("Pre-research context (for spawn)"),
      persona: z.string().optional().describe("Persona (for spawn, default noah)"),
      instance_id: z.string().optional().describe("Instance ID"),
      id: z.string().optional().describe("Alias for instance_id"),
      message: z.string().optional().describe("Message (for turn)"),
    }),
  },
  async (params) => {
    const action = params.action;
    const instanceId = params.instance_id || params.id;

    try {
      if (action === "spawn") {
        const result = await gcPost("/gc/aden", params);
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "list") {
        const result = await gcGet("/gc/aden");
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "turn") {
        if (!instanceId) return err("instance_id (or id) is required");
        const result = await gcPost(
          `/gc/aden/${encodeURIComponent(instanceId)}/turn`,
          params,
        );
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "get" || action === "delete") {
        if (!instanceId) return err("instance_id (or id) is required");
        const path = `/gc/aden/${encodeURIComponent(instanceId)}`;
        const result =
          action === "get" ? await gcGet(path) : await gcDelete(path);
        return text(JSON.stringify(result, null, 2));
      }
      return err(`unsupported gc_aden action: ${action}`);
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Observable Runs
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_run",
  {
    description: `Observable run control and event history.
Actions:
- events: durable event log since a seq (non-SSE history read)
- control: operator control (abort)
- watch: SSE live tail (collects events until terminal or timeout)`,
    inputSchema: z.object({
      action: z.enum(["events", "control", "watch"]).describe("Action to perform"),
      execution_id: z.string().describe("Run execution ID"),
      id: z.string().optional().describe("Alias for execution_id"),
      since: zNumber().optional().describe("Start seq (for events/watch, default 0)"),
      control_action: z
        .enum(["abort"])
        .optional()
        .describe("Control action (for control)"),
      reason: z.string().optional().describe("Abort reason (for control)"),
      timeout: zTimeout().optional().describe("Watch timeout (for watch)"),
      heartbeat: zNumber().optional().describe("Watch heartbeat ms (for watch)"),
    }),
  },
  async (params) => {
    const action = params.action;
    const executionId = params.execution_id || params.id;
    if (!executionId) return err("execution_id (or id) is required");

    try {
      if (action === "events") {
        const since = params.since ?? 0;
        const result = await gcGet(
          `/gc/run/${encodeURIComponent(executionId)}/events?since=${encodeURIComponent(since)}`,
        );
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "control") {
        const result = await gcPost(
          `/gc/run/${encodeURIComponent(executionId)}/control`,
          {
            action: params.control_action || "abort",
            reason: params.reason,
          },
        );
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "watch") {
        const timeoutMs =
          params.timeout === "infinite" || params.timeout === "infinity"
            ? null
            : typeof params.timeout === "number"
              ? params.timeout * 1000
              : 30_000;
        const url = `${GC_BASE}/gc/run/${encodeURIComponent(executionId)}/watch?since=${encodeURIComponent(params.since ?? 0)}`;
        const resp = await fetch(url, {
          signal:
            timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs + 5_000),
        });
        if (!resp.ok) {
          const textBody = await resp.text().catch(() => "");
          throw new Error(`gc_daemon run watch failed (${resp.status}): ${textBody}`);
        }
        const { events, terminal } = await readSseStream(resp);
        const summary = terminal
          ? `\nTerminal event: ${summarizeWatchEvent(terminal)}`
          : `\nStream ended without terminal event (${events.length} events)`;
        return text(
          JSON.stringify(
            {
              execution_id: executionId,
              event_count: events.length,
              terminal_event: terminal
                ? {
                    event: terminal.event,
                    data: terminal.data,
                  }
                : null,
              events: events.map((e) => ({
                event: e.event,
                data: e.data,
              })),
            },
            null,
            2,
          ) + summary,
        );
      }
      return err(`unsupported gc_run action: ${action}`);
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Approval Checkpoints
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_checkpoint",
  {
    description: `Approval checkpoints (Story 3.5a).
- get: fetch a held action's render payload + risk dot
- resolve: approve or reject a checkpoint; edited_args supports edit-then-approve`,
    inputSchema: z.object({
      action: z.enum(["get", "resolve"]).describe("Action to perform"),
      id: z.string().describe("Checkpoint ID"),
      decision: z
        .enum(["approve", "reject"])
        .optional()
        .describe("Decision (for resolve)"),
      edited_args: z
        .record(z.any())
        .optional()
        .describe("Edited args for edit-then-approve (for resolve)"),
    }),
  },
  async (params) => {
    const action = params.action;
    const id = params.id;
    if (!id) return err("id is required");

    try {
      if (action === "get") {
        const result = await gcGet(`/gc/checkpoint/${encodeURIComponent(id)}`);
        return text(JSON.stringify(result, null, 2));
      }
      if (action === "resolve") {
        if (!params.decision) return err("decision is required for resolve");
        const result = await gcPost(
          `/gc/checkpoint/${encodeURIComponent(id)}/resolve`,
          {
            decision: params.decision,
            edited_args: params.edited_args,
          },
        );
        return text(JSON.stringify(result, null, 2));
      }
      return err(`unsupported gc_checkpoint action: ${action}`);
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Relay Ingress
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_relay",
  {
    description: `Relay ingress for external peers (e.g. Pluto). Sends a message to an existing agent session or creates a new one. Defaults to the daemon-owned ingress agent (charon).`,
    inputSchema: z.object({
      message: z.string().describe("Message to relay"),
      session_id: z
        .string()
        .optional()
        .describe("Existing session ID (if omitted, a new session is spawned)"),
      agent: z.string().optional().describe("Target agent name (default charon)"),
      config: z.record(z.any()).optional().describe("Session config (for new sessions)"),
    }),
  },
  async (params) => daemonCall("/gc/relay", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Workflow Watch (SSE)
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_workflow_watch",
  {
    description: `Live SSE watch of a workflow execution. Collects status events until the execution settles, times out, or the client aborts. Use gc_workflow action=wait for a simpler polling alternative.`,
    inputSchema: z.object({
      execution_id: z.string().describe("Workflow execution ID"),
      id: z.string().optional().describe("Alias for execution_id"),
      since: zNumber().optional().describe("Start seq (default 0)"),
      timeout: zTimeout().optional().describe("Max watch time in seconds"),
      heartbeat: zNumber().optional().describe("Heartbeat interval ms"),
    }),
  },
  async (params) => {
    const executionId = params.execution_id || params.id;
    if (!executionId) return err("execution_id (or id) is required");

    try {
      const timeoutMs =
        params.timeout === "infinite" || params.timeout === "infinity"
          ? null
          : typeof params.timeout === "number"
            ? params.timeout * 1000
            : 30_000;
      const { events, terminal } = await readWorkflowWatchStream(
        executionId,
        timeoutMs,
      );
      const summary = terminal
        ? `\nTerminal event: ${summarizeWatchEvent(terminal)}`
        : `\nStream ended without terminal event (${events.length} events)`;
      return text(
        JSON.stringify(
          {
            execution_id: executionId,
            event_count: events.length,
            terminal_event: terminal
              ? {
                  event: terminal.event,
                  data: terminal.data,
                }
              : null,
            events: events.map((e) => ({
              event: e.event,
              data: e.data,
            })),
          },
          null,
          2,
        ) + summary,
      );
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Capability Watch (SSE)
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_capability_watch",
  {
    description: `Live SSE watch of capability-state changes. Returns the initial snapshot plus any capability state changes until timeout.`,
    inputSchema: z.object({
      timeout: zTimeout().optional().describe("Max watch time in seconds"),
      heartbeat: zNumber().optional().describe("Heartbeat interval ms"),
    }),
  },
  async (params) => {
    try {
      const timeoutMs =
        params.timeout === "infinite" || params.timeout === "infinity"
          ? null
          : typeof params.timeout === "number"
            ? params.timeout * 1000
            : 30_000;
      const url = `${GC_BASE}/gc/capability/watch`;
      const resp = await fetch(url, {
        signal:
          timeoutMs === null ? undefined : AbortSignal.timeout(timeoutMs + 5_000),
      });
      if (!resp.ok) {
        const textBody = await resp.text().catch(() => "");
        throw new Error(`gc_daemon capability watch failed (${resp.status}): ${textBody}`);
      }
      const { events, terminal } = await readSseStream(resp);
      const summary = terminal
        ? `\nTerminal event: ${summarizeWatchEvent(terminal)}`
        : `\nStream ended without terminal event (${events.length} events)`;
      return text(
        JSON.stringify(
          {
            event_count: events.length,
            terminal_event: terminal
              ? {
                  event: terminal.event,
                  data: terminal.data,
                }
              : null,
            events: events.map((e) => ({
              event: e.event,
              data: e.data,
            })),
          },
          null,
          2,
        ) + summary,
      );
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Directives
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_directive",
  {
    description: `Manage behavioral directives using the @always/@never/@stop/@pin/@until vocabulary.
Directives are injected into agent context automatically. Scoped to specific agents or global (*).
Actions: "add" — create, "remove" — hard delete by ID (confirm: true required for pinned), "deactivate" — soft disable (can reactivate later), "reactivate" — re-enable a deactivated directive, "list" — show active, "inject" — formatted for context injection.`,
    inputSchema: z.object({
      action: z
        .enum(["add", "remove", "deactivate", "reactivate", "list", "inject"])
        .describe("Action to perform"),
      content: z.string().optional().describe("Directive text (for add)"),
      persistence: z
        .string()
        .optional()
        .describe(
          "Persistence level: always, pin, never, stop, remember, until",
        ),
      scope: z
        .string()
        .optional()
        .describe("Agent scope: * for all, or agent name(s) comma-separated"),
      id: z
        .string()
        .optional()
        .describe("Directive ID (for remove/deactivate/reactivate)"),
      confirm: zBoolean()
        .optional()
        .describe("Required for remove/deactivate of pinned directives"),
      source: z.string().optional().describe("Where this directive came from"),
      expires_at: z
        .string()
        .optional()
        .describe("ISO date for @until directives"),
      query: z
        .string()
        .optional()
        .describe("Similarity query for inject (optional)"),
    }),
  },
  async (params) => daemonCall("/gc/directive", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Skills
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_skill",
  {
    description: `GC-native procedural skill registry.
Use this when you want to know whether GC already has a reusable procedure for a task before inventing a new workflow or doing ad-hoc work.

Key actions:
- suggest: rank candidate skills for a task. Returns suggestions plus a recommended top match.
- resolve: like suggest, but only sets resolved when one skill clearly dominates; use this when you need a safe yes/no pick.
- list/show: inspect existing skills and their metadata.
- create/update/deprecate: maintain the skill registry itself.

Matching behavior:
- task text is scored against aliases, skill name, slug, and intent tags
- project-scoped skills are strongly preferred when project matches
- mode can bias toward skills that explicitly support baseline or deep execution`,
    inputSchema: z.object({
      action: z
        .enum([
          "list",
          "show",
          "create",
          "update",
          "suggest",
          "resolve",
          "deprecate",
        ])
        .describe("Skill action to perform"),
      task: z
        .string()
        .optional()
        .describe(
          "Task text to match against skills. Required for suggest and resolve.",
        ),
      project: z
        .string()
        .optional()
        .describe(
          "Optional active project. Helps project-scoped skills outrank general fallbacks.",
        ),
      mode: z
        .enum(["baseline", "deep"])
        .optional()
        .describe("Optional execution depth hint used during ranking."),
      slug: z
        .string()
        .optional()
        .describe(
          "Skill slug for show, update, and deprecate. If omitted on create, daemon derives it from name.",
        ),
      name: z
        .string()
        .optional()
        .describe("Human-readable skill name. Required for create."),
      description: z
        .string()
        .optional()
        .describe("What the skill does and when to use it."),
      scope: z
        .enum(["general", "project"])
        .optional()
        .describe(
          "Explicit skill scope. If omitted, daemon infers project scope when project is present.",
        ),
      status: z
        .enum(["draft", "active", "deprecated"])
        .optional()
        .describe("Lifecycle status. Draft is the default on create."),
      entry_workflow: z
        .string()
        .optional()
        .describe(
          "Canonical workflow entrypoint this skill should invoke when selected.",
        ),
      workflow_entrypoint: z
        .string()
        .optional()
        .describe("Backward-compatible alias for entry_workflow."),
      aliases: z
        .array(z.string())
        .optional()
        .describe(
          "Exact phrases or shorthand that operators use for this skill.",
        ),
      intent_tags: z
        .array(z.string())
        .optional()
        .describe(
          "Intent keywords used for softer matching during suggest/resolve.",
        ),
      intents: z
        .array(z.string())
        .optional()
        .describe("Backward-compatible alias for intent_tags."),
      supports_baseline: zBoolean()
        .optional()
        .describe(
          "Whether the skill supports baseline execution mode. Defaults to true.",
        ),
      supports_deep: zBoolean()
        .optional()
        .describe(
          "Whether the skill supports deep execution mode. Defaults to false.",
        ),
      include_deprecated: zBoolean()
        .optional()
        .describe(
          "For list: include deprecated skills instead of hiding them by default.",
        ),
      limit: zNumber()
        .optional()
        .describe(
          "For list/suggest: max rows to return. Suggest defaults to 5, list defaults to 20.",
        ),
    }),
  },
  async (params) => daemonCall("/gc/skill", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Work (Bee DAG)
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_work",
  {
    description: `Work coordination with dependency DAG.
Actions: create, list, search, ready, show, update, done, cancel, block, unblock, claim, release, comment, plan, tree, stale, focus, backfill_projects, rebuild_search_index.
Use action=search to check if an issue about a topic already exists (FTS, ranked, matches title+description regardless of project_id tagging) instead of listing the whole DAG. Issues have dependencies (DAG), assignments, locks, labels. Use 'ready' to see what's unblocked. 'plan' for critical path.`,
    inputSchema: z.object({
      action: z
        .enum([
          "create",
          "list",
          "search",
          "ready",
          "show",
          "update",
          "done",
          "cancel",
          "block",
          "unblock",
          "claim",
          "release",
          "comment",
          "plan",
          "tree",
          "stale",
          "focus",
          "backfill_projects",
          "rebuild_search_index",
        ])
        .describe("Action to perform"),
      title: z.string().optional().describe("Issue title"),
      description: z.string().optional().describe("Issue description"),
      priority: zNumber()
        .optional()
        .describe("Priority (higher = more important)"),
      type: z
        .string()
        .optional()
        .describe("Issue type: task, bug, epic, objective"),
      project: z.string().optional().describe("Project name"),
      parent: z.string().optional().describe("Parent issue ID (for sub-tasks)"),
      labels: z.array(z.string()).optional().describe("Labels"),
      id: z.string().optional().describe("Issue ID (number or full ID)"),
      depends_on: z.string().optional().describe("Issue ID this depends on"),
      agent: z.string().optional().describe("Agent name for claim/assign"),
      note: z.string().optional().describe("Comment text or close reason"),
      q: z
        .string()
        .optional()
        .describe(
          "Full-text query for action=search — matches issue title + description, ranked by relevance. Bypasses project_id tagging. Punctuation-only queries return an annotated empty result.",
        ),
      status: z
        .string()
        .optional()
        .describe(
          "Filter by status: open, in_progress, closed, all. list defaults to open; search defaults to all statuses.",
        ),
      assigned: z.string().optional().describe("Filter by assigned agent"),
      days: zNumber()
        .optional()
        .describe(
          "For action=stale/focus: stale threshold in days (default 7)",
        ),
      dry_run: zBoolean()
        .optional()
        .describe(
          "For action=backfill_projects: when true, preview only (default true)",
        ),
      fallback_project: z
        .string()
        .optional()
        .describe(
          "For action=backfill_projects: fallback project id for GC-* issues (default gc_daemon)",
        ),
      limit: zNumber()
        .optional()
        .describe(
          "Max results. list: default 50, cap 500 (newest-first; also returns `total` = full pre-limit count). search: default 10, cap 50. ready: opt-in, no default. stale/focus/backfill_projects: max rows or sample size.",
        ),
      include: z
        .array(z.enum(["comments"]))
        .optional()
        .describe(
          "For action=show: request optional relations. Pass [\"comments\"] to load issue comments in ascending created_at order; omitted relations return as :not_loaded.",
        ),
    }),
  },
  async (params) => daemonCall("/gc/work", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Timeline
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_timeline",
  {
    description: `Manage timeline events — deadlines, appointments, blocks, milestones. Links events to Bee issues and other entities.
Actions: create_event, update_event, delete_event, get, link, unlink, query, today, upcoming_deadlines, slipped.`,
    inputSchema: z.object({
      action: z
        .enum([
          "create_event",
          "update_event",
          "delete_event",
          "get",
          "link",
          "unlink",
          "query",
          "today",
          "upcoming_deadlines",
          "slipped",
        ])
        .describe("Action to perform"),
      id: z
        .union([zNumber(), z.string()])
        .optional()
        .describe("Event or link ID"),
      title: z.string().optional().describe("Event title"),
      type: z
        .string()
        .optional()
        .describe("Event type: deadline, appointment, block, milestone"),
      starts_at: z.string().optional().describe("Start time (ISO 8601)"),
      ends_at: z.string().optional().describe("End time (ISO 8601)"),
      all_day: zBoolean().optional().describe("All-day event"),
      recurrence: z
        .string()
        .optional()
        .describe("Recurrence: daily, weekly, monthly, yearly"),
      labels: z.array(z.string()).optional().describe("Labels"),
      notes: z.string().optional().describe("Notes"),
      event_id: zNumber().optional().describe("Event ID (for linking)"),
      linkable_type: z
        .string()
        .optional()
        .describe("Link target type: bee_issue, reminder, external"),
      linkable_id: z.string().optional().describe("Link target ID"),
      role: z
        .string()
        .optional()
        .describe("Link role: deadline_for, blocks, related"),
      from: z.string().optional().describe("Query range start (ISO)"),
      to: z.string().optional().describe("Query range end (ISO)"),
      hours: zNumber()
        .optional()
        .describe("Deadline lookahead hours (default 48)"),
      limit: zNumber().optional().describe("Max results"),
    }),
  },
  async (params) => daemonCall("/gc/timeline", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Time Registry
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_time",
  {
    description: `Track actual time spent on work. Timers, manual logging, agent job capture, duration models.
Actions: start_timer, stop_timer, log, log_agent_job, delete, running, query, aggregate, capacity, duration_estimate.`,
    inputSchema: z.object({
      action: z
        .enum([
          "start_timer",
          "stop_timer",
          "log",
          "log_agent_job",
          "delete",
          "running",
          "query",
          "aggregate",
          "capacity",
          "duration_estimate",
        ])
        .describe("Action to perform"),
      resource: z
        .string()
        .optional()
        .describe("Resource name: leonidas, mobus, ops, etc."),
      id: zNumber().optional().describe("Time entry ID"),
      bee_issue_id: z.string().optional().describe("Bee issue ID to link to"),
      event_id: zNumber().optional().describe("Timeline event ID to link to"),
      started_at: z.string().optional().describe("Start time (ISO 8601)"),
      ended_at: z.string().optional().describe("End time (ISO 8601)"),
      duration_minutes: zNumber()
        .optional()
        .describe("Explicit duration in minutes"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Labels for categorization"),
      notes: z.string().optional().describe("Notes about the work"),
      source: z.string().optional().describe("Source: manual, agent, auto"),
      from: z.string().optional().describe("Query range start (ISO)"),
      to: z.string().optional().describe("Query range end (ISO)"),
      dimension: z
        .string()
        .optional()
        .describe("Aggregation dimension: resource, bee_issue_id, source"),
      limit: zNumber().optional().describe("Max results"),
      agent: z.string().optional().describe("Agent name (for log_agent_job)"),
      issue: z.string().optional().describe("Issue ID (for log_agent_job)"),
      task: z
        .string()
        .optional()
        .describe("Task description (for log_agent_job)"),
    }),
  },
  async (params) => daemonCall("/gc/time", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Engagement / Timesheets
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_engagement",
  {
    description: `Reconstruct engaged-attention hours from Timing presence plus project-touch events across Claude Code, pi, Codex, and Bee.
Screen-first by default. File output only when target=file|both.
Actions: compute, per_day, audit, sensitivity, projects, timesheet_export.`,
    inputSchema: z.object({
      action: z
        .enum([
          "compute",
          "per_day",
          "audit",
          "sensitivity",
          "projects",
          "timesheet_export",
        ])
        .describe("Action to perform"),
      from: z
        .string()
        .optional()
        .describe("Period start (ISO date or datetime)"),
      to: z.string().optional().describe("Period end (ISO date or datetime)"),
      project: z
        .string()
        .optional()
        .describe("Single project id or display name"),
      projects: z
        .array(z.string())
        .optional()
        .describe("Project ids or display names"),
      bin_minutes: zNumber()
        .optional()
        .describe("Bin width in minutes (default 5)"),
      tolerance_minutes: zNumber()
        .optional()
        .describe("Burst tolerance in minutes (default 10)"),
      target: z
        .enum(["screen", "file", "both"])
        .optional()
        .describe("screen (default), file, both"),
      out_path: z
        .string()
        .optional()
        .describe("Exact file destination for single-project exports"),
      out_dir: z
        .string()
        .optional()
        .describe("Directory destination for generated files"),
      filename: z
        .string()
        .optional()
        .describe("Explicit filename for single-project exports"),
      filename_prefix: z
        .string()
        .optional()
        .describe("Filename prefix for generated files"),
      audit_filename: z
        .string()
        .optional()
        .describe("Explicit audit filename when include_audit=true"),
      include_audit: zBoolean()
        .optional()
        .describe("Also export audit CSVs in timesheet_export"),
      k_values: z
        .array(zNumber())
        .optional()
        .describe("Tolerance values for sensitivity"),
    }),
  },
  async (params) => daemonCall("/gc/engagement", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Sessions
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_sessions",
  {
    description: `Session ingestion ops — scanner status, attribution repair, manual scans, and knowledge backlog control.
Actions: status, scan, pending_knowledge, enqueue_pending_knowledge, backfill_project_ids, backfill_attributions, enqueue_attribution_backfill, review_attributions, next_review_item, apply_review_decision, work_item_summary, process_session_file.`,
    inputSchema: z.object({
      action: z
        .enum([
          "status",
          "scan",
          "pending_knowledge",
          "enqueue_pending_knowledge",
          "backfill_project_ids",
          "backfill_attributions",
          "enqueue_attribution_backfill",
          "review_attributions",
          "next_review_item",
          "apply_review_decision",
          "work_item_summary",
          "process_session_file",
        ])
        .describe("Action to perform"),
      session_file_id: zNumber()
        .optional()
        .describe("Session file id for process_session_file"),
      limit: zNumber().optional().describe("Max results / enqueue batch size"),
      agent: z
        .string()
        .optional()
        .describe("Optional agent filter for attribution backfill"),
      from: z
        .string()
        .optional()
        .describe("Optional ISO date/datetime lower bound"),
      to: z
        .string()
        .optional()
        .describe("Optional ISO date/datetime upper bound"),
      provider: z
        .string()
        .optional()
        .describe("Optional provider filter for attribution review"),
      review_id: zNumber()
        .optional()
        .describe("Review row id for apply_review_decision"),
      decision: z
        .enum(["accept", "reject", "skip"])
        .optional()
        .describe("Review decision for apply_review_decision"),
      project_id: z
        .string()
        .optional()
        .describe("Project id for apply_review_decision"),
      note: z
        .string()
        .optional()
        .describe("Optional note for apply_review_decision"),
      worker_limit: zNumber()
        .optional()
        .describe("Optional worker limit for batch attribution enqueue"),
    }),
  },
  async (params) => daemonCall("/gc/sessions", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Cash Flow
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_cash",
  {
    description: `Track money in/out. Runway, forecasts, drift detection.
Actions: add, update, delete, get, query, runway, monthly, forecast, drift.`,
    inputSchema: z.object({
      action: z
        .enum([
          "add",
          "update",
          "delete",
          "get",
          "query",
          "runway",
          "monthly",
          "forecast",
          "drift",
        ])
        .describe("Action to perform"),
      id: zNumber().optional().describe("Entry ID"),
      title: z.string().optional().describe("Entry title"),
      type: z.string().optional().describe("income or expense"),
      category: z
        .string()
        .optional()
        .describe(
          "Category: client_work, retainer, infrastructure, subscriptions, etc.",
        ),
      amount: zNumber()
        .optional()
        .describe("Amount in cents (1250 = €12.50) or euros as float (12.50)"),
      date: z.string().optional().describe("Date (ISO: 2026-03-07)"),
      currency: z.string().optional().describe("Currency code (default EUR)"),
      status: z
        .string()
        .optional()
        .describe("expected, confirmed, received, or paid"),
      recurrence: z.string().optional().describe("monthly, quarterly, yearly"),
      confidence: zNumber()
        .optional()
        .describe("0.0-1.0 confidence for expected entries"),
      source_type: z.string().optional().describe("project, client, bee_issue"),
      source_id: z.string().optional().describe("Source entity ID"),
      notes: z.string().optional().describe("Notes"),
      labels: z.array(z.string()).optional().describe("Labels"),
      from: z.string().optional().describe("Query range start (ISO date)"),
      to: z.string().optional().describe("Query range end (ISO date)"),
      cash_on_hand: zNumber()
        .optional()
        .describe("Current cash in euros (for runway)"),
      months: zNumber().optional().describe("Lookback or lookahead months"),
      limit: zNumber().optional().describe("Max results"),
    }),
  },
  async (params) => daemonCall("/gc/cash", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Publishing
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_publishing",
  {
    description: `Content dissemination metrics. Track pieces, platform posts, and performance over time.
Actions: create (piece), post (distribution), snapshot (manual metrics), ingest (parse platform export), list, report, compare, trend, funnel.`,
    inputSchema: z.object({
      action: z
        .enum([
          "create",
          "post",
          "snapshot",
          "ingest",
          "list",
          "report",
          "compare",
          "trend",
          "funnel",
        ])
        .describe("Action to perform"),
      // create piece
      id: z.string().optional().describe("Piece slug ID (for create)"),
      title: z.string().optional().describe("Piece title"),
      url: z.string().optional().describe("Canonical URL"),
      brand: z.string().optional().describe("Brand: leonidas, fosferon, sil"),
      category: z
        .string()
        .optional()
        .describe("Category: essay, video, thread, post"),
      published_at: z.string().optional().describe("Publish date (ISO)"),
      tags: z.array(z.string()).optional().describe("Tags"),
      // post (distribution)
      piece_id: z.string().optional().describe("Piece ID to link to"),
      platform: z
        .string()
        .optional()
        .describe(
          "Platform: linkedin, medium, x, youtube, hackernews, tiktok, instagram, substack",
        ),
      platform_id: z
        .string()
        .optional()
        .describe("Platform-specific post ID/URN"),
      round: zNumber().optional().describe("Distribution round (1, 2, 3)"),
      angle: z
        .string()
        .optional()
        .describe(
          "Content angle: behaviour_hook, research_evidence, philosophical, general",
        ),
      posted_at: z.string().optional().describe("Post date (ISO datetime)"),
      // metrics
      post_id: zNumber()
        .optional()
        .describe("Post ID (for snapshot, ingest, trend)"),
      snapshot_at: z.string().optional().describe("Snapshot date (ISO)"),
      impressions: zNumber().optional().describe("Impressions count"),
      reach: zNumber().optional().describe("Members reached"),
      link_clicks: zNumber().optional().describe("Link clicks"),
      reactions: zNumber().optional().describe("Reactions count"),
      comments: zNumber().optional().describe("Comments count"),
      reposts: zNumber().optional().describe("Reposts count"),
      saves: zNumber().optional().describe("Saves count"),
      profile_views: zNumber().optional().describe("Profile views from post"),
      followers_gained: zNumber().optional().describe("Followers gained"),
      demographics: z.string().optional().describe("Demographics JSON"),
      // ingest
      file: z.string().optional().describe("File path for ingest"),
      snapshot_date: z
        .string()
        .optional()
        .describe("Override snapshot date for ingest (ISO)"),
      force: zBoolean()
        .optional()
        .describe("Force ingest even if duplicate snapshot exists"),
      // list/compare
      type: z.string().optional().describe("List type: pieces or posts"),
      dimension: z
        .string()
        .optional()
        .describe("Compare dimension: round, angle, platform, piece"),
      limit: zNumber().optional().describe("Max results"),
    }),
  },
  async (params) => daemonCall("/gc/publishing", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Runtime Records
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_records",
  {
    description: `Runtime record definitions and instances.
Actions: types, get_type, define_type, create, get, list, update, delete, transition.
Use definition for define_type and data for create/update.
Use params for Records query filters, sort, temporal constraints, and pagination.`,
    inputSchema: z.object({
      action: z
        .enum([
          "types",
          "get_type",
          "define_type",
          "create",
          "get",
          "list",
          "update",
          "delete",
          "transition",
        ])
        .describe("Action to perform"),
      handle: z.string().optional().describe("Record type handle for get_type"),
      type: z.string().optional().describe("Record type handle for create or list"),
      definition: z.record(z.any()).optional().describe("Record type definition for define_type"),
      data: z.record(z.any()).optional().describe("Record data for create or update"),
      pub_id: z.string().optional().describe("Public record ID for get, update, delete, or transition"),
      event: z.string().optional().describe("Lifecycle event for transition"),
      params: z.record(z.any()).optional().describe("List filters, sort, temporal constraints, and pagination"),
    }),
  },
  async (params) => daemonCall("/gc/records", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Planner
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_plan",
  {
    description: `Resource-constrained scheduler. "What should I work on next?"
Actions: next, replan, profile, switch_profile, list_profiles, upsert_profile, resources, upsert_resource, capacity, conflicts, simulate, simulate_single, scenarios, solve, solve_and_validate.`,
    inputSchema: z.object({
      action: z
        .enum([
          "next",
          "replan",
          "profile",
          "switch_profile",
          "list_profiles",
          "upsert_profile",
          "resources",
          "upsert_resource",
          "capacity",
          "conflicts",
          "simulate",
          "simulate_single",
          "scenarios",
          "solve",
          "solve_and_validate",
        ])
        .describe("Action to perform"),
      resource: z
        .string()
        .optional()
        .describe("Resource name (default: leonidas)"),
      name: z.string().optional().describe("Profile or resource name"),
      description: z.string().optional().describe("Profile description"),
      weights: z
        .any()
        .optional()
        .describe("Weight vector: {label: weight, ...}"),
      active: zBoolean().optional().describe("Set as active profile"),
      type: z.string().optional().describe("Resource type: human or agent"),
      capacity_hours_day: zNumber().optional().describe("Hours per day"),
      capacity_hours_week: zNumber().optional().describe("Hours per week"),
      availability: z
        .string()
        .optional()
        .describe("weekdays, always, or custom"),
      labels: z.array(z.string()).optional().describe("Labels"),
      scenario: z
        .string()
        .optional()
        .describe(
          "Named scenario: current, stress, optimistic, revenue_mode, six_month",
        ),
      n: zNumber()
        .optional()
        .describe("Number of Monte Carlo runs (default: 100)"),
      horizon_days: zNumber().optional().describe("Simulation horizon in days"),
      cash_balance: zNumber()
        .optional()
        .describe("Override starting cash balance (euros)"),
      inject_disruptions: zBoolean()
        .optional()
        .describe("Inject random disruptions"),
      base_seed: zNumber()
        .optional()
        .describe("Base seed for reproducible Monte Carlo"),
      seed: zNumber().optional().describe("Random seed for single simulation"),
      time_limit_ms: zNumber()
        .optional()
        .describe("Solver time limit in ms (default: 10000)"),
    }),
  },
  async (params) => daemonCall("/gc/plan", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Convergence
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_convergence",
  {
    description: `Strategic vector tracking — the Fosferon evaluation model.
Actions: report, vectors, get_vector, create_vector, update_vector, link, unlink, vectors_for, score, leverage, set_leverage, backfill,
vitality, snapshot, snapshots, events, log_event, record_outcome, outcomes, correlation,
invest, update_investment, investments, causal_chain, project, projections, expected_value, resolve_projection, accuracy_trend, retrofit, roi, horizon_score.`,
    inputSchema: z.object({
      action: z
        .enum([
          "report",
          "vectors",
          "get_vector",
          "create_vector",
          "update_vector",
          "link",
          "unlink",
          "vectors_for",
          "score",
          "leverage",
          "set_leverage",
          "backfill",
          "vitality",
          "snapshot",
          "snapshots",
          "events",
          "log_event",
          "record_outcome",
          "outcomes",
          "correlation",
          "invest",
          "update_investment",
          "investments",
          "causal_chain",
          "project",
          "projections",
          "expected_value",
          "resolve_projection",
          "accuracy_trend",
          "retrofit",
          "roi",
          "horizon_score",
        ])
        .describe("Action to perform"),
      handle: z
        .string()
        .optional()
        .describe("Vector handle (e.g. revenue:atrapos)"),
      vector: z.string().optional().describe("Vector handle for linking"),
      name: z.string().optional().describe("Vector name"),
      category: z
        .string()
        .optional()
        .describe("revenue|authority|academic|infrastructure|product|network"),
      domain: z
        .string()
        .optional()
        .describe("Domain: mobus, atrapos, fosferon, gc, etc."),
      status: z.string().optional().describe("active|dormant|emerged"),
      notes: z.string().optional().describe("Notes"),
      type: z
        .string()
        .optional()
        .describe(
          "Linkable type: bee_issue, cash_entry, time_entry, event, commit, content",
        ),
      id: z.string().optional().describe("Linkable ID or link ID (for unlink)"),
      linkable_type: z.string().optional().describe("For set_leverage"),
      linkable_id: z.string().optional().describe("For set_leverage"),
      coefficient: zNumber()
        .optional()
        .describe("Leverage coefficient (>1 = amplifier)"),
      evidence: z.string().optional().describe("Why this leverage coefficient"),
      window: zNumber()
        .optional()
        .describe("Window in days for report (default 30)"),
      days: zNumber()
        .optional()
        .describe("Backfill period in days (default 90)"),
      // Investment tracking
      investment_id: z
        .string()
        .optional()
        .describe("Investment ID (for causal_chain)"),
      amount: zNumber().optional().describe("Investment amount"),
      // Projection
      projection_id: z
        .string()
        .optional()
        .describe("Projection ID (for expected_value, resolve_projection)"),
      actual: zNumber()
        .optional()
        .describe("Actual outcome value (for resolve_projection)"),
      // Snapshot
      label: z.string().optional().describe("Snapshot label"),
      // Events
      event_type: z.string().optional().describe("Convergence event type"),
      limit: zNumber().optional().describe("Max results"),
    }),
  },
  async (params) => daemonCall("/gc/convergence", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Dispatch (on-demand agent execution)
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_project_registry",
  {
    description: `Canonical project registry for Grand Central.
Actions:
  - list: list all registered projects
  - get: fetch one project by id
  - upsert: create or update one project (supports partial payloads; metadata is merged)
  - sync: sync projects from ~/.config/gc/registry.toml into the registry DB
  - repos: list registered git repos

Use this as the source of truth for project metadata such as repo paths, canonical docs,
related projects, and strategy-sync metadata. Prefer this over maintaining sidecar maps.`,
    inputSchema: z.object({
      action: z
        .enum(["list", "get", "upsert", "sync", "repos"])
        .describe("Project registry action"),
      id: z
        .string()
        .optional()
        .describe("Project id for action=get or action=upsert"),
      name: z
        .string()
        .optional()
        .describe("Human-readable project name for action=upsert"),
      path: z
        .string()
        .optional()
        .describe("Primary repo/worktree path for action=upsert"),
      canonical_path: z
        .string()
        .optional()
        .describe("Canonical path when path is a worktree or alias"),
      description: z.string().optional().describe("Project description"),
      stack: z.string().optional().describe("Tech stack summary"),
      domain: z.string().optional().describe("Primary domain"),
      repo_url: z.string().optional().describe("Repo remote URL"),
      branch: z.string().optional().describe("Default or canonical branch"),
      binary_path: z.string().optional().describe("Binary path, if applicable"),
      launchd_service: z
        .string()
        .optional()
        .describe("launchd service name, if applicable"),
      data_dir: z
        .string()
        .optional()
        .describe("Primary data directory, if applicable"),
      notes: z.string().optional().describe("Operator notes"),
      status: z.string().optional().describe("Project status"),
      ports: z.record(z.unknown()).optional().describe("Named ports map"),
      domains: z.array(z.string()).optional().describe("Associated domains"),
      tags: z.array(z.string()).optional().describe("Project tags"),
      commands: z.array(z.string()).optional().describe("Useful commands"),
      key_files: z.array(z.string()).optional().describe("Key file paths"),
      related_projects: z
        .array(z.string())
        .optional()
        .describe("Related project ids"),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe("Additional metadata; merged into existing metadata_json"),
      source: z.string().optional().describe("Source tag for upsert"),
      last_synced_at: z.string().optional().describe("ISO timestamp override"),
    }),
  },
  async (params) => daemonCall("/gc/project_registry", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Dispatch (on-demand agent execution)
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_peer_conversation",
  {
    description: `Persistent chat-style sessions with external A2A peers such as Pluto. Use this for dialogue, clarification, synthesis, and back-and-forth coordination. Do NOT use gc_dispatch for conversational turns; gc_dispatch is for job assignments.

Actions:
  - create: open a new peer conversation session and bind it to a registered A2A peer
  - turn: send one user message into an existing session and get the peer's reply
  - get: fetch the full current state of one session, including transcript and remote threading metadata
  - list: list all peer conversation sessions
  - delete: destroy one peer conversation session

Important semantics:
  - Sessions are persistent and conversation-oriented, not job-oriented.
  - Turns create no dispatch jobs and no dispatch audit rows.
  - The daemon preserves transcript locally and reuses remote A2A context/threading under the hood.
  - peer_agent must be the name of a registered A2A peer (for example: "pluto").

Typical flow:
  1. action="create", peer_agent="pluto"
  2. action="turn", session_id="<returned id>", message="..."
  3. action="get" or action="list" to inspect session state later`,
    inputSchema: z.object({
      action: z
        .enum(["create", "turn", "get", "list", "delete"])
        .describe(
          "Conversation action: create a session, send a turn, fetch one session, list sessions, or delete a session",
        ),
      peer_agent: z
        .string()
        .optional()
        .describe(
          'Registered A2A peer name for action="create" (for example: "pluto")',
        ),
      agent: z
        .string()
        .optional()
        .describe(
          'Alias for peer_agent on action="create". Prefer peer_agent for clarity.',
        ),
      config: z
        .record(z.unknown())
        .optional()
        .describe(
          "Optional session config stored with the conversation at creation time (e.g. purpose, project, strategy context)",
        ),
      session_id: z
        .string()
        .optional()
        .describe(
          "Existing peer conversation session ID, required for turn/get/delete",
        ),
      message: z
        .string()
        .optional()
        .describe(
          'User message to send into the peer session, required for action="turn"',
        ),
    }),
  },
  async (params) => {
    try {
      if (params.action === "create") {
        const result = await gcPost(
          "/gc/peer_conversation",
          clean({
            peer_agent: params.peer_agent ?? params.agent,
            config: params.config,
          }),
        );
        return text(JSON.stringify(result, null, 2));
      }

      if (params.action === "turn") {
        const sessionId = params.session_id;
        if (!sessionId)
          return err('ERROR: session_id is required for action="turn"');
        const result = await gcPost(
          `/gc/peer_conversation/${sessionId}/turn`,
          clean({
            message: params.message,
          }),
          120_000,
        );
        return text(JSON.stringify(result, null, 2));
      }

      if (params.action === "get") {
        const sessionId = params.session_id;
        if (!sessionId)
          return err('ERROR: session_id is required for action="get"');
        const result = await gcGet(`/gc/peer_conversation/${sessionId}`);
        return text(JSON.stringify(result, null, 2));
      }

      if (params.action === "delete") {
        const sessionId = params.session_id;
        if (!sessionId)
          return err('ERROR: session_id is required for action="delete"');
        const result = await gcDelete(`/gc/peer_conversation/${sessionId}`);
        return text(JSON.stringify(result, null, 2));
      }

      const result = await gcGet("/gc/peer_conversation");
      return text(JSON.stringify(result, null, 2));
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

server.registerTool(
  "gc_peer",
  {
    description: `Legacy alias for gc_peer_conversation.
Actions: spawn, turn, get, list, destroy.`,
    inputSchema: z.object({
      action: z
        .enum(["spawn", "turn", "get", "list", "destroy"])
        .describe("Legacy peer action"),
      peer_agent: z
        .string()
        .optional()
        .describe('Registered A2A peer name for action="spawn"'),
      session_id: z
        .string()
        .optional()
        .describe("Session ID for turn/get/destroy"),
      message: z.string().optional().describe('User message for action="turn"'),
      config: z
        .record(z.unknown())
        .optional()
        .describe("Optional conversation config for spawn"),
    }),
  },
  async (params) => {
    try {
      if (params.action === "spawn") {
        const result = await gcPost(
          "/gc/peer_conversation",
          clean({
            peer_agent: params.peer_agent,
            config: params.config,
          }),
        );
        return text(JSON.stringify(result, null, 2));
      }

      if (params.action === "turn") {
        const sessionId = params.session_id;
        if (!sessionId)
          return err('ERROR: session_id is required for action="turn"');
        const result = await gcPost(
          `/gc/peer_conversation/${sessionId}/turn`,
          clean({
            message: params.message,
          }),
          120_000,
        );
        return text(JSON.stringify(result, null, 2));
      }

      if (params.action === "get") {
        const sessionId = params.session_id;
        if (!sessionId)
          return err('ERROR: session_id is required for action="get"');
        const result = await gcGet(`/gc/peer_conversation/${sessionId}`);
        return text(JSON.stringify(result, null, 2));
      }

      if (params.action === "destroy") {
        const sessionId = params.session_id;
        if (!sessionId)
          return err('ERROR: session_id is required for action="destroy"');
        const result = await gcDelete(`/gc/peer_conversation/${sessionId}`);
        return text(JSON.stringify(result, null, 2));
      }

      const result = await gcGet("/gc/peer_conversation");
      return text(JSON.stringify(result, null, 2));
    } catch (e: any) {
      return err(`ERROR: ${e.message}`);
    }
  },
);

server.registerTool(
  "gc_project_status",
  {
    description: `Legacy alias for gc_ticker/get. Returns the latest ecosystem status snapshot.`,
    inputSchema: z.object({
      name: z
        .string()
        .optional()
        .describe("Optional project name or 'all' for overview"),
    }),
  },
  async (params) => daemonCall("/gc/ticker", { action: "get", ...params }),
);

server.registerTool(
  "gc_find",
  {
    description: `Find documents by metadata — domain, type, project, or title.`,
    inputSchema: z.object({
      domain: z.string().optional().describe("Domain filter"),
      type: z.string().optional().describe("Type filter"),
      project: z.string().optional().describe("Project name filter"),
      title: z.string().optional().describe("Title substring (LIKE search)"),
      limit: z
        .number()
        .optional()
        .describe("Max results (default 25)"),
    }),
  },
  async (params) => daemonCall("/gc/tool_call", { name: "gc_find", arguments: params }),
);

server.registerTool(
  "gc_dispatch",
  {
    description: `On-demand agent dispatch. Spawn an agent with a task, inspect dispatchable targets, inspect provider/model availability, preview dispatch resolution, check job status, retrieve output.
Actions: dispatch (spawn agent), list_agents (local markdown agents only), list_providers (show valid provider overrides and availability), list_models (show provider model inventories with authoritative vs hint provenance), resolve_dispatch (preview what provider/model/mode GC would use for one target), list_targets (all dispatchable targets, optionally filtered by kind), status (check job), output (get result), list (query jobs), dismiss (hide noisy job), delete (remove one), prune (bulk cleanup), repair_stale (reconcile ghost running jobs after crashes/redeploys).
Default is fire-and-forget (returns job_id immediately). Set wait=true to block until done.

Use gc_dispatch for assignments and runnable work. If you want an ongoing dialogue with an external A2A peer (for example Pluto), use gc_peer_conversation instead — that path preserves session/thread semantics and avoids creating one job per turn.
Do not inspect past sessions to guess provider/model defaults. Use list_agents, list_providers, list_models, and especially resolve_dispatch instead.

Semantics:
  - provider = GC dispatch route, not upstream vendor and not CLI binary name
  - model = real provider-native model id only
  - resolve_dispatch shows provider_type, binary, model_source, and model_resolution so you can see exactly what GC will do

Provider selection (dispatch backend / route):
  - Default: omit provider and let the daemon resolve from the agent's declared provider/model fields plus configured fallback order
  - provider: "native" — explicit in-process/native dispatch route
  - provider: "native:<backend>" — explicit native backend pin, for example provider: "native:zai"
  - provider: "claude" | "droid" | "pi" — explicit built-in CLI route override
  - provider: "kimi" — explicit dynamic CLI route override when kimi is installed
  - provider: "<other-cli-label>" — any other installed CLI route label or alias accepted by the daemon
  - action=list_providers — inspect the currently valid native + CLI route strings before choosing one

Model selection:
  - For CLI providers with model_resolution=provider_runtime, omit model unless you know a valid provider-native model id
  - Never pass transport labels such as "kimi-cli" or "claude-code-cli" as model values
  - action=list_models shows exact live inventories where GC can verify them, and clearly labeled hints otherwise

Claude-specific permission controls:
  - permission_mode: default|auto|dontAsk|acceptEdits|plan|bypassPermissions
  - dangerously_skip_permissions: true adds --dangerously-skip-permissions
  - allow_dangerously_skip_permissions: true adds --allow-dangerously-skip-permissions`,
    inputSchema: z.object({
      action: z
        .enum([
          "dispatch",
          "list_agents",
          "list_providers",
          "list_models",
          "resolve_dispatch",
          "list_targets",
          "status",
          "output",
          "list",
          "dismiss",
          "delete",
          "prune",
          "repair_stale",
        ])
        .describe("Action to perform"),
      kind: z
        .enum(["all", "agent", "persona", "a2a"])
        .optional()
        .describe("Target filter for list_targets (default: all)"),
      agent: z
        .string()
        .optional()
        .describe("Agent name to dispatch (required for dispatch)"),
      task: z.string().optional().describe("Task text (required for dispatch)"),
      cwd: z
        .string()
        .optional()
        .describe("Working directory (optional, defaults to project default)"),
      issue: z.string().optional().describe("Bee issue ID to link (optional)"),
      on_complete: z
        .string()
        .optional()
        .describe(
          'Terminal hook for dispatch. Currently supports "notify" to emit a mailbox event when the job finishes.',
        ),
      wait: zBoolean()
        .optional()
        .describe("If true, block until agent completes (default: false)"),
      provider: z
        .string()
        .optional()
        .describe(
          'Explicit GC dispatch route override, or route hint/filter for list_providers, list_models, or resolve_dispatch. This is not the upstream vendor and not the CLI binary name. Accepts dynamic CLI route labels such as "claude", "droid", "pi", "kimi", plus "native" or "native:<backend>" such as "native:zai".',
        ),
      model: z
        .string()
        .optional()
        .describe(
          'Explicit real model id override, or a model hint for list_providers/resolve_dispatch (e.g. "claude-sonnet-4-6", "claude-opus-4-6", "gpt-5.2-codex"). Do not pass CLI labels such as "kimi-cli" or "claude-code-cli". Default: agent-defined, GC default, or provider runtime default depending on resolve_dispatch.',
        ),
      permission_mode: z
        .enum([
          "default",
          "auto",
          "dontAsk",
          "acceptEdits",
          "plan",
          "bypassPermissions",
        ])
        .optional()
        .describe(
          "Claude permission mode override (passed as --permission-mode)",
        ),
      dangerously_skip_permissions: zBoolean()
        .optional()
        .describe("Claude only: pass --dangerously-skip-permissions"),
      allow_dangerously_skip_permissions: zBoolean()
        .optional()
        .describe("Claude only: pass --allow-dangerously-skip-permissions"),
      allowed_tools: z
        .string()
        .optional()
        .describe("Claude only: comma-separated allowed tools"),
      disallowed_tools: z
        .string()
        .optional()
        .describe("Claude only: comma-separated disallowed tools"),
      add_dir: z
        .string()
        .optional()
        .describe("Claude only: additional directory to allow tool access to"),
      timeout: zTimeout()
        .optional()
        .describe(
          'Max lifetime of the dispatched CLI subprocess. Integer seconds (default: 1800 / 30 min), or "infinite"/"infinity"/"none" to disable the wrapper kill entirely. Accepts string-of-int ("600") so LLM stringification is safe.',
        ),
      job_id: z
        .string()
        .optional()
        .describe("Job ID (for status/output actions)"),
      status: z
        .string()
        .optional()
        .describe("Filter by status (for list/prune)"),
      scheduled: zBoolean()
        .optional()
        .describe("Filter scheduled jobs only (for list)"),
      since_hours: zNumber()
        .optional()
        .describe("Only jobs newer than N hours (for list)"),
      include_hidden: zBoolean()
        .optional()
        .describe("Include hidden jobs (list/prune; default false)"),
      reason: z.string().optional().describe("Dismiss reason (for dismiss)"),
      force: zBoolean()
        .optional()
        .describe("Force deletion of running job (for delete)"),
      older_than_hours: zNumber()
        .optional()
        .describe("Minimum age in hours for prune (default 24)"),
      older_than_minutes: zNumber()
        .optional()
        .describe("Minimum age in minutes for repair_stale (default 30)"),
      dry_run: zBoolean()
        .optional()
        .describe("Preview repair_stale without mutating"),
      limit: zNumber()
        .optional()
        .describe("Max rows to return/delete (list/prune)"),
    }),
  },
  async (params) => {
    // Compute the client-side HTTP abort deadline from the user's timeout.
    // - Non-dispatch actions (status/output) → short default, they return fast.
    // - wait: false → short default, daemon returns job_id immediately.
    // - wait: true + "infinite" → no client abort at all.
    // - wait: true + integer → (seconds * 1000) + 10s buffer past daemon deadline.
    // - wait: true + undefined → 30 min default + 10s buffer.
    let clientTimeoutMs: number | null | undefined = 15_000;
    if (params.action === "dispatch" && params.wait === true) {
      const t = params.timeout;
      if (t === "infinite" || t === "infinity") {
        clientTimeoutMs = null; // wait forever
      } else if (typeof t === "number" && t > 0) {
        clientTimeoutMs = t * 1000 + 10_000;
      } else {
        clientTimeoutMs = 1_800_000 + 10_000; // daemon default + buffer
      }
    }
    return daemonCall("/gc/dispatch", params, clientTimeoutMs);
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Schedule
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_schedule",
  {
    description: `Manage scheduled agent dispatches.
Actions: list, create, enable, disable, delete, history, fire (manual trigger), tick (force check).
Trigger types: cron, interval, session_start, once.

CRON: pass a standard 5-field expression via 'cron' (preferred):
  "min hour day-of-month month day-of-week"
  Examples:
    "0 9 * * mon-fri"       — weekdays at 09:00
    "0 10 1 * *"            — 1st of every month at 10:00
    "0 10 1 1,4,7,10 *"     — 1st of Jan/Apr/Jul/Oct at 10:00
    "*/15 9-17 * * 1-5"     — every 15 min, 9am-5pm, weekdays

The legacy 'hour'/'minute'/'days' params are deprecated but still accepted
(the server converts them to a cron expression). They cannot express
day-of-month, month-of-year, or ranges — use 'cron' for those.`,
    inputSchema: z.object({
      action: z
        .enum([
          "list",
          "create",
          "enable",
          "disable",
          "delete",
          "history",
          "fire",
          "tick",
        ])
        .describe("Action to perform"),
      name: z.string().optional().describe("Schedule name"),
      description: z.string().optional().describe("Schedule description"),
      trigger: z
        .string()
        .optional()
        .describe("Trigger type: cron, interval, session_start, once"),
      cron: z
        .string()
        .optional()
        .describe(
          'Standard 5-field cron: "min hour dom month dow". Preferred over hour/minute/days.',
        ),
      hour: zNumber()
        .optional()
        .describe("DEPRECATED — use 'cron'. Legacy cron hour (0-23)"),
      minute: zNumber()
        .optional()
        .describe(
          "DEPRECATED — use 'cron'. Legacy cron minute (0-59), default 0",
        ),
      days: z
        .array(z.string())
        .optional()
        .describe(
          'DEPRECATED — use \'cron\'. Legacy days of week: ["mon","tue",...]',
        ),
      interval: zPositiveNumber()
        .optional()
        .describe("Interval in minutes (accepts string-of-int)"),
      fire_at: z.string().optional().describe("ISO timestamp for one-shot"),
      action_type: z
        .string()
        .optional()
        .describe("What to do: dispatch (default) or notify"),
      agent: z.string().optional().describe("Agent to dispatch"),
      task: z.string().optional().describe("Task text"),
      cwd: z.string().optional().describe("Working directory"),
      issue: z.string().optional().describe("Linked bee issue"),
      id: z.string().optional().describe("Schedule ID"),
      limit: zNumber().optional().describe("History limit (default 20)"),
    }),
  },
  async (params) => daemonCall("/gc/schedule", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Reminders
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_remind",
  {
    description: `Human reminders. Simple, managed by Eve or directly.
Actions: add (create reminder), list (show pending/fired), dismiss (mark as handled), snooze (delay), delete.
Due accepts: ISO timestamps, relative times.`,
    inputSchema: z.object({
      action: z
        .enum(["add", "list", "dismiss", "snooze", "delete"])
        .describe("Action to perform"),
      text: z.string().optional().describe("Reminder text"),
      due: z
        .string()
        .optional()
        .describe("When: ISO timestamp or relative time"),
      recurrence: z
        .string()
        .optional()
        .describe("Repeat: daily, weekdays, weekly, monthly"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Labels for categorization"),
      id: z
        .string()
        .optional()
        .describe("Reminder ID (for dismiss/snooze/delete)"),
      snooze_for: z.string().optional().describe("Snooze duration"),
      status: z.string().optional().describe("Filter: pending, fired, all"),
      created_by: z
        .string()
        .optional()
        .describe("Who created: human (default), eve, or agent name"),
    }),
  },
  async (params) => daemonCall("/gc/remind", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Workflow
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_workflow",
  {
    description: `Run deterministic workflows from ~/.config/gc/workflows/.
Workflows are YAML pipelines with step types: tool, prompt, dispatch, shell, each, branch, halt.

Actions:
  - run (sync by default, or async: true)
  - list_workflows — list YAML definitions (defaults to summary: name/file/description/size)
  - list_executions — list past runs (defaults to summary: no runtime blob)
  - list — alias for list_executions (backward compat)
  - show (alias: get_execution) — one execution with full runtime
  - report — reliability summary, stale-running detection, recent failures
  - detail — per-step breakdown for an execution
  - context — inspect runtime context/keys for an execution
  - resume — re-run from a checkpoint
  - wait — bounded poll until terminal state or timeout
  - watch — stream daemon SSE continuity through MCP progress notifications, then return the terminal event
  - cancel — stop one execution and cancel any backing Oban workflow job
  - dismiss — hide an execution from default listings
  - delete — remove one execution (and checkpoint)
  - prune — bulk-delete old terminal executions
  - repair_stale — mark stale running executions failed and clear checkpoints

Response shaping:

  run (sync):
    - Default shape: { execution_id, status: "complete", last_step, result }.
      \`result\` carries the last MEANINGFUL step's output — the shaper walks
      the trace backwards and skips nil-returning tail steps (gc.retain /
      gc.notify side-effects). \`last_step\` names whichever step produced
      \`result\`. If every step returns nil, \`result\` is null but
      \`last_step\` still names the actual final step.
    - select: "step_id" — return one specific step's result (bypasses the
      walk-past-nil default; use when you want an intermediate step or a
      specific side-effect's receipt).
    - select: "step_a,step_b" — return multiple specific steps (selected
      map + \`result\` unset).
    - return: "full" — everything (all step results + trace).
    - return: "steps" — all step results keyed by step_id, no trace.
    - return: "trace" — trace only, no results.

  run (async: true):
    - Returns { ok: true, status: "started", execution_id } immediately.
    - Goes through Oban; survives daemon restart (idempotent resume —
      crash mid-run → row marked failed with reason "crashed-resume").

  list_workflows:
    - Default: summary — name, file, description, size_bytes (no YAML body)
    - return: "full" — includes the YAML 'body' field for every workflow
    - select: "name1,name2" — return full bodies for the named workflows only

  list_executions:
    - Default: summary — id, workflow, status, started_at, updated_at (no runtime blob)
    - return: "full" — includes 'runtime' JSON for every row (can be large)
    - select: "id,status" — return only the named fields per row

Use timeout to control client-side HTTP deadline, or "none" for no timeout.`,
    inputSchema: z.object({
      action: z
        .enum([
          "run",
          "list",
          "list_workflows",
          "list_executions",
          "show",
          "get_execution",
          "report",
          "detail",
          "context",
          "wait",
          "watch",
          "resume",
          "cancel",
          "dismiss",
          "delete",
          "prune",
          "repair_stale",
        ])
        .describe("Action to perform"),
      workflow: z
        .string()
        .optional()
        .describe("Workflow name (for run/resume)"),
      params: z
        .string()
        .optional()
        .describe(
          'JSON parameters for the workflow. Pass an object encoded as JSON, for example {"since":"2026-05-02T00:00:00+03:00","projects":["gc_daemon"],"mode":"draft"}. Use JSON arrays for list<string> params such as projects.',
        ),
      async: zBoolean()
        .optional()
        .describe(
          "If true, run returns immediately with execution_id (run action only)",
        ),
      status: z
        .string()
        .optional()
        .describe(
          "Filter list_executions by status (running/completed/failed/halted)",
        ),
      limit: zNumber()
        .optional()
        .describe("Max rows for list_executions (default 20)"),
      select: z
        .string()
        .optional()
        .describe(
          'Cherry-pick fields/steps. run: step IDs ("step_a,step_b"). list_workflows: workflow names (returns full body). list_executions: execution field names. Takes priority over return.',
        ),
      return: z
        .enum(["result", "full", "steps", "trace", "summary"])
        .optional()
        .describe(
          'Response shape. run: "result" (default)/"full"/"steps"/"trace". list_workflows + list_executions: "summary" (default)/"full".',
        ),
      id: z
        .string()
        .optional()
        .describe(
          "Execution ID (for show/resume/detail/context/wait/watch).",
        ),
      execution_id: z
        .string()
        .optional()
        .describe("Execution ID (alias for id)"),
      key: z
        .string()
        .optional()
        .describe("Context key to inspect (for context action)"),
      interval: zPositiveNumber()
        .optional()
        .describe(
          "Poll interval in seconds for wait (default: 5). Accepts string-of-int.",
        ),
      timeout: zTimeout()
        .optional()
        .describe(
          'Client-side HTTP timeout in seconds. Default: 300 (5 min) for run/resume, 15 for others. "none" / "infinity" / "infinite" disable timeout entirely. Accepts string-of-int ("600") so LLM stringification is safe.',
        ),
      run_timeout: zTimeout()
        .optional()
        .describe(
          'Server-side workflow execution timeout in seconds for action=run only. Distinct from client timeout. "none" / "infinity" / "infinite" disable the server-side run deadline.',
        ),
      execution_timeout: zTimeout()
        .optional()
        .describe("Alias for run_timeout"),
      include_hidden: zBoolean()
        .optional()
        .describe(
          "Include hidden rows in list/prune (default false for list, true for prune)",
        ),
      reason: z
        .string()
        .optional()
        .describe("Dismiss reason (for action=dismiss)"),
      force: zBoolean()
        .optional()
        .describe("Force deletion of running execution (for action=delete)"),
      older_than_hours: zNumber()
        .optional()
        .describe("Minimum age in hours for action=prune (default 24)"),
      dry_run: zBoolean()
        .optional()
        .describe("Preview repair_stale without mutating"),
    }),
  },
  async (params, extra) => {
    // Normalize execution_id -> id for the handler
    const normalized = { ...params };
    if (normalized.execution_id && !normalized.id) {
      normalized.id = normalized.execution_id;
    }

    // Compute client-side HTTP timeout:
    // - async: true → 15s (daemon returns immediately)
    // - timeout: none/infinity/infinite → null (no abort)
    // - timeout: N → N * 1000
    // - run/resume/wait (no explicit timeout) → 300s default (workflows can take minutes)
    // - everything else → 15s default
    let clientTimeoutMs: number | null | undefined = 15_000;
    const isLongAction =
      params.action === "run" ||
      params.action === "resume" ||
      params.action === "wait" ||
      params.action === "watch";

    if (params.async) {
      clientTimeoutMs = 15_000; // async returns immediately
    } else if (
      params.timeout === "none" ||
      params.timeout === "infinity" ||
      params.timeout === "infinite"
    ) {
      clientTimeoutMs = null;
    } else if (typeof params.timeout === "number" && params.timeout > 0) {
      clientTimeoutMs = params.timeout * 1000;
    } else if (isLongAction) {
      clientTimeoutMs = 300_000; // 5 min default for sync run/resume
    }

    if (params.action === "watch") {
      const executionId =
        typeof normalized.id === "string" ? normalized.id : undefined;
      if (!executionId) {
        return err("ERROR: execution id is required for action=watch");
      }

      try {
        const { events, terminal } = await readWorkflowWatchStream(
          executionId,
          clientTimeoutMs,
          async (event, index) => {
            if (extra._meta?.progressToken === undefined) return;

            await extra.sendNotification({
              method: "notifications/progress",
              params: {
                progressToken: extra._meta.progressToken,
                progress: index,
                message: summarizeWatchEvent(event),
              },
            });
          },
        );

        const finalEvent = terminal || events.at(-1);
        const payload = {
          ok: true,
          id: executionId,
          event_count: events.length,
          final_event: finalEvent?.event ?? null,
          terminal: finalEvent?.data ?? null,
          events,
        };

        return isFailedWatchEvent(finalEvent as WorkflowWatchEvent)
          ? err(toJsonText(payload))
          : text(toJsonText(payload));
      } catch (e: any) {
        return err(`ERROR: ${e.message}`);
      }
    }

    return daemonCall("/gc/workflow", normalized, clientTimeoutMs);
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Mail
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_mail",
  {
    description: `Query email state, financial data, and inbox summary from the mail transceiver.
Actions: summary, burn_rate, financial, messages, endpoints, scan, extract_financials, ocr,
add_endpoint, remove_endpoint, enable_endpoint, disable_endpoint, update_endpoint,
seed_rules, sender_queue, classify_sender, dismiss_sender, ignore_sender, backfill_senders.`,
    inputSchema: z.object({
      action: z
        .enum([
          "summary",
          "burn_rate",
          "financial",
          "messages",
          "endpoints",
          "scan",
          "extract_financials",
          "ocr",
          "add_endpoint",
          "remove_endpoint",
          "enable_endpoint",
          "disable_endpoint",
          "update_endpoint",
          "seed_rules",
          "sender_queue",
          "classify_sender",
          "dismiss_sender",
          "ignore_sender",
          "backfill_senders",
        ])
        .describe("Action to perform"),
      months: zNumber()
        .optional()
        .describe("Burn rate lookback months (default 3)"),
      category: z.string().optional().describe("Filter messages by category"),
      from: z
        .string()
        .optional()
        .describe("Filter messages by sender (substring)"),
      since: z.string().optional().describe("Filter messages since date (ISO)"),
      direction: z
        .string()
        .optional()
        .describe("Financial direction: expense or income"),
      vat_period: z.string().optional().describe("VAT period filter"),
      limit: zNumber().optional().describe("Max results"),
      // Endpoint management
      id: z.string().optional().describe("Endpoint or sender ID"),
      email: z.string().optional().describe("Email address (for add_endpoint)"),
      name: z.string().optional().describe("Endpoint name"),
      imap_host: z
        .string()
        .optional()
        .describe("IMAP host (default: imap.zoho.com)"),
      imap_port: zNumber().optional().describe("IMAP port (default: 993)"),
      username: z.string().optional().describe("IMAP username"),
      app_key: z.string().optional().describe("IMAP app-specific password"),
      scan_folders: z
        .array(z.string())
        .optional()
        .describe("Folders to scan (default: [INBOX])"),
      autonomy: z
        .string()
        .optional()
        .describe("Autonomy level: observe, classify, act"),
      endpoint_id: z.string().optional().describe("Endpoint ID (for scan)"),
      // Sender classification
      view: z
        .string()
        .optional()
        .describe("Sender queue view: summary or list"),
      reason: z.string().optional().describe("Reason for dismiss/ignore"),
    }),
  },
  async (params) => daemonCall("/gc/mail", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — HTTP Client
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_http",
  {
    description: `Generic HTTP client for external API calls.
Actions: get, post, put, delete. Supports bearer, basic, and header auth.`,
    inputSchema: z.object({
      action: z.enum(["get", "post", "put", "delete"]).describe("HTTP method"),
      url: z.string().describe("Target URL"),
      body: z.any().optional().describe("JSON body (for post/put)"),
      params: z.record(z.string()).optional().describe("Query parameters"),
      headers: z.record(z.string()).optional().describe("Custom headers"),
      auth: z
        .object({
          type: z.enum(["bearer", "basic", "header"]).describe("Auth type"),
          token: z.string().optional().describe("Bearer token"),
          username: z.string().optional().describe("Basic auth username"),
          password: z.string().optional().describe("Basic auth password"),
          name: z.string().optional().describe("Custom header name"),
          value: z.string().optional().describe("Custom header value"),
        })
        .optional()
        .describe("Authentication config"),
      timeout: zTimeout()
        .optional()
        .describe(
          "Timeout in ms (default 30000). Accepts string-of-int / 'none' / 'infinity'.",
        ),
    }),
  },
  async (params) => daemonCall("/gc/http", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Timing (macOS Timing.app)
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_timing",
  {
    description: `Read-only queries against macOS Timing.app SQLite database.
Actions: summary (project totals), capacity (daily hours), duration (estimate from labels), hours_by_label.`,
    inputSchema: z.object({
      action: z
        .enum(["summary", "capacity", "duration", "hours_by_label"])
        .describe("Action to perform"),
      since: z.string().optional().describe("Start date filter (ISO)"),
      until: z.string().optional().describe("End date filter (ISO)"),
      labels: z
        .array(z.string())
        .optional()
        .describe("Labels for duration estimate"),
    }),
  },
  async (params) => daemonCall("/gc/timing", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Sync (Reconciliation Engine)
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_sync",
  {
    description: `Reconciliation engine for data hygiene.
Actions: status (last runs, pending reviews), run (trigger sync), rules (list rule files), reviews (pending items), classify (resolve item), dismiss (dismiss item).`,
    inputSchema: z.object({
      action: z
        .enum(["status", "run", "rules", "reviews", "classify", "dismiss"])
        .describe("Action to perform"),
      rule_file: z
        .string()
        .optional()
        .describe("Specific rule file to run or filter by"),
      id: z
        .string()
        .optional()
        .describe("Review item ID (for classify/dismiss)"),
      resolution: z
        .record(z.unknown())
        .optional()
        .describe("Resolution data (for classify)"),
      reason: z.string().optional().describe("Reason for dismiss"),
      limit: zNumber().optional().describe("Max results"),
    }),
  },
  async (params) => daemonCall("/gc/sync", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — MCP Client Proxy
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_mcpclient",
  {
    description: `General-purpose MCP client proxy. Connect to any MCP server once, use from any agent.
Supports all transports: streamable_http (default), sse (e.g. Tidewave), stdio, websocket.
Actions: connect (register + connect), disconnect, remove, servers (list registered), tools (list tools), call (invoke a tool), scan (health-check all).`,
    inputSchema: z.object({
      action: z
        .enum([
          "connect",
          "disconnect",
          "remove",
          "servers",
          "tools",
          "call",
          "scan",
        ])
        .describe("Action to perform"),
      name: z
        .string()
        .optional()
        .describe("Server name (for connect/disconnect/remove)"),
      url: z.string().optional().describe("Server URL (for connect)"),
      transport: z
        .string()
        .optional()
        .describe(
          "Transport type: streamable_http (default), sse, stdio, websocket",
        ),
      description: z
        .string()
        .optional()
        .describe("Server description (for connect)"),
      metadata: z
        .record(z.unknown())
        .optional()
        .describe("Extra config (e.g. {command, args} for stdio)"),
      server: z.string().optional().describe("Server name (for tools/call)"),
      tool: z
        .string()
        .optional()
        .describe("Tool name to call (for call action)"),
      arguments: z
        .record(z.unknown())
        .optional()
        .describe("Tool arguments (for call)"),
      timeout: zTimeout()
        .optional()
        .describe(
          "Call timeout in seconds. Accepts string-of-int / 'none' / 'infinity'.",
        ),
    }),
  },
  async (params) => daemonCall("/gc/mcpclient", params),
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Ticker (Situational Awareness)
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_ticker",
  {
    description: `Situational awareness snapshot. Returns the latest ticker state from gc_daemon.
Actions: "get" (default) = latest snapshot, "tick" = force a fresh tick.`,
    inputSchema: z.object({
      action: z
        .enum(["get", "tick"])
        .optional()
        .describe("Action: get (default) or tick (force refresh)"),
    }),
  },
  async (params) => {
    try {
      if (params.action === "tick") {
        const result = await gcPost("/gc/ticker", { action: "tick" });
        return text(JSON.stringify(result, null, 2));
      }
      // Default: GET request
      const result = await gcGet("/gc/ticker");
      return text(JSON.stringify(result, null, 2));
    } catch (e: any) {
      return err(`Ticker error: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Notifications
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_notify",
  {
    description: `Notification mailbox for durable consumer polling.
Actions: "push" = append a mailbox event, "drain" = fetch unread items and mark them read, "list" = inspect mailbox contents by status/checkpoint.

Recommended integration pattern:
  - Persist a per-consumer checkpoint
  - Poll gc_notify with action: "drain", since: <checkpoint>
  - Handle returned events
  - Advance the checkpoint to the newest handled created_at

Daemon guarantees durable mailbox creation plus unread/read semantics. Harnesses decide how to surface drained events.`,
    inputSchema: z.object({
      action: z.enum(["push", "drain", "list"]).describe("Action to perform"),
      source: z.string().optional().describe("Notification source (for push)"),
      content: z
        .string()
        .optional()
        .describe("Notification content (for push)"),
      priority: zNumber()
        .optional()
        .describe("Notification priority (for push, default 0)"),
      limit: zNumber()
        .optional()
        .describe("Max rows to drain/list (default 10 for drain, 50 for list)"),
      status: z.string().optional().describe("For list: unread, read, all"),
      since: z
        .string()
        .optional()
        .describe(
          "Optional ISO timestamp checkpoint. For drain/list, only return notifications newer than this.",
        ),
    }),
  },
  async (params) => daemonCall("/gc/notify", params),
);

// ════════════════════════════════════════════════════════════════
// STANDALONE TOOL — DaVinci Resolve
// ════════════════════════════════════════════════════════════════

function getResolveBridgePath(): string {
  // Bridge script lives next to the pi extension
  const piExtPath = join(
    homedir(),
    "Sites",
    "agents",
    ".pi",
    "extensions",
    "davinci-resolve",
    "resolve-bridge.py",
  );
  if (existsSync(piExtPath)) return piExtPath;
  // Fallback: check relative to this file
  const localPath = resolve(
    dirname(import.meta.url.replace("file://", "")),
    "..",
    "..",
    ".pi",
    "extensions",
    "davinci-resolve",
    "resolve-bridge.py",
  );
  // ════════════════════════════════════════════════════════════════
  // DAEMON TOOL — A2A (Agent-to-Agent Protocol)
  // ════════════════════════════════════════════════════════════════

  const A2A_RPC_METHODS = new Set([
    "message/send",
    "tasks/get",
    "tasks/cancel",
  ]);

  async function a2aRpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    const url = `${GC_BASE}/a2a`;
    const id = Date.now();
    const body = { jsonrpc: "2.0", id, method, params };

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await resp.json();

    if (data.error) {
      throw new Error(
        `A2A ${method} error: ${data.error.message || JSON.stringify(data.error)}`,
      );
    }

    return data.result;
  }

  server.registerTool(
    "gc_a2a",
    {
      description: `Agent-to-Agent (A2A) protocol client. Interact with the A2A broker to create tasks, check status, cancel tasks, and discover agent capabilities.

Actions:
- **send**: Create a new A2A task (message/send). Params: message (with role + parts), worker (optional target agent), idempotencyKey (optional dedup).
- **get**: Get task status by ID (tasks/get). Params: id (task ID).
- **cancel**: Cancel a running task (tasks/cancel). Params: id (task ID).
- **card**: Fetch an agent's public card. Params: name (agent name).
- **list**: List tasks with optional filters. Params: state, worker_agent.
- **register**: Register as an A2A worker agent. Params: agent_name, card_url?, cascade_priority?.
- **inbox**: Get submitted tasks for a worker. Params: worker_agent.
- **respond**: Transition a task state + optionally append a message. Params: task_id, state (working|completed|failed|canceled|rejected), message?.

The A2A protocol follows the Google A2A specification (JSON-RPC 2.0 over HTTP).
Task states: submitted → working → completed | failed | canceled | rejected.`,
      inputSchema: z.object({
        action: z
          .enum([
            "send",
            "get",
            "cancel",
            "card",
            "list",
            "register",
            "inbox",
            "respond",
          ])
          .describe("A2A action to perform"),
        // send / get / cancel
        id: z.string().optional().describe("Task ID (for get/cancel)"),
        message: z
          .object({
            role: z
              .string()
              .optional()
              .describe("Message role (default: user)"),
            parts: z
              .array(
                z.object({
                  type: z.string().describe("Part type (e.g. 'text')"),
                  text: z.string().optional().describe("Text content"),
                }),
              )
              .optional()
              .describe("Message parts"),
            taskId: z
              .string()
              .optional()
              .describe("Explicit task ID (auto-generated if omitted)"),
            contextId: z
              .string()
              .optional()
              .describe("Context ID for conversation threading"),
            metadata: z
              .record(z.unknown())
              .optional()
              .describe("Message metadata"),
          })
          .optional()
          .describe("Message payload (for send action)"),
        worker: z
          .string()
          .optional()
          .describe("Target worker agent name (for send action)"),
        idempotencyKey: z
          .string()
          .optional()
          .describe("Deduplication key (for send action)"),
        // card
        name: z.string().optional().describe("Agent name (for card action)"),
        // list / inbox
        state: z
          .string()
          .optional()
          .describe("Filter by task state (for list)"),
        worker_agent: z
          .string()
          .optional()
          .describe("Filter by worker agent (for list/inbox)"),
        // register
        agent_name: z
          .string()
          .optional()
          .describe("Agent name to register (for register action)"),
        card_url: z
          .string()
          .optional()
          .describe("Agent card URL (for register action)"),
        cascade_priority: z
          .array(z.string())
          .optional()
          .describe("Cascade priority list (for register action)"),
        // respond
        task_id: z
          .string()
          .optional()
          .describe("Task ID to respond to (for respond action)"),
      }),
    },
    async (params) => {
      try {
        switch (params.action) {
          case "send": {
            const rpcParams = clean({
              message: params.message,
              worker: params.worker,
              idempotencyKey: params.idempotencyKey,
            });
            const result = await a2aRpc("message/send", rpcParams);
            return text(JSON.stringify(result, null, 2));
          }
          case "get": {
            const result = await a2aRpc("tasks/get", { id: params.id });
            return text(JSON.stringify(result, null, 2));
          }
          case "cancel": {
            const result = await a2aRpc("tasks/cancel", { id: params.id });
            return text(JSON.stringify(result, null, 2));
          }
          case "card": {
            const result = await gcGet(
              `/.well-known/agents/${params.name}.json`,
            );
            return text(JSON.stringify(result, null, 2));
          }
          // Admin actions — route through /gc/a2a_admin
          case "register":
            return daemonCall("/gc/a2a_admin", {
              action: "register",
              agent_name: params.agent_name,
              card_url: params.card_url,
              cascade_priority: params.cascade_priority,
            });
          case "inbox":
            return daemonCall("/gc/a2a_admin", {
              action: "inbox",
              worker_agent: params.worker_agent,
            });
          case "respond":
            return daemonCall("/gc/a2a_admin", {
              action: "respond",
              task_id: params.task_id,
              state: params.state,
              message: params.message,
            });
          case "list":
            return daemonCall("/gc/a2a_admin", {
              action: "list",
              state: params.state,
              worker_agent: params.worker_agent,
            });
          default:
            return err(`Unknown A2A action: ${params.action}`);
        }
      } catch (e: any) {
        return err(`gc_a2a error: ${e.message}`);
      }
    },
  );

  if (existsSync(localPath)) return localPath;
  throw new Error("resolve-bridge.py not found");
}

// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Hot Config Reload
// ════════════════════════════════════════════════════════════════

server.registerTool(
  "gc_reload",
  {
    description: `Runtime config reload control plane for YAML/TOML-backed operator config.
Supports status, preview, apply, selective targets, safe bulk reload, and legacy section-based requests.

Actions:
  - status:  Show current reload targets and their live-safe status.
  - preview: Dry-run — show what would change without applying.
  - apply:   Apply the reload for the specified target(s).

Targets (examples):
  providers, api_keys, env, paths, telegram_routing, telegram_bot_token,
  vault, a2a_auth, mcp_client, llm_core_providers, llm_core_routing,
  workflows, personas, session_registry, sync_rules, project_registry

Use after: editing secrets.toml or YAML config, swapping models in LM Studio,
rotating API keys, updating workflow definitions, or reloading llm_core.toml
provider definitions such as custom CLI providers.

Legacy section names (providers, api, env, paths, telegram, vault, a2a, mcp, llm_core)
are still accepted via the section parameter for backward compatibility.`,
    inputSchema: z.object({
      action: z
        .enum(["status", "preview", "apply"])
        .optional()
        .describe("Reload action: status (inspect), preview (dry-run), or apply (execute). Defaults to status."),
      target: z
        .string()
        .optional()
        .describe("Single reload target (e.g. providers, api_keys, env, paths, telegram_routing, vault, a2a_auth, mcp_client, llm_core_providers, llm_core_routing, workflows, personas, session_registry, sync_rules, project_registry)."),
      targets: z
        .array(z.string())
        .optional()
        .describe("Multiple reload targets. Use all_safe=true or omit targets to apply all safe targets."),
      all_safe: z
        .boolean()
        .optional()
        .describe("Expand to all live-safe targets (excludes dangerous-sync and restart-required targets)."),
      section: z
        .string()
        .optional()
        .describe("Legacy compatibility: section name (providers, api, env, paths, telegram, vault, a2a, mcp, llm_core)."),
    }),
  },
  async (params) => daemonCall("/gc/reload", params),
);

server.registerTool(
  "davinci_resolve",
  {
    description: `Control DaVinci Resolve Studio via scripting API. Requires Resolve to be running.
Actions: status, list_projects, open_project, save_project, list_timelines, get_timeline, set_timeline,
get_clips, get_markers, add_marker, delete_markers, set_playhead, open_page, media_pool, clip_metadata,
render_setup, add_render_job, render_queue, start_render, stop_render, render_status, render_formats,
delete_render_jobs, export_timeline, grab_still, export_frame, project_settings, timeline_settings,
create_timeline, import_media, create_subtitles, detect_scene_cuts, transcribe_audio, node_graph,
set_lut, copy_grades, quick_export, media_storage.`,
    inputSchema: z.object({
      action: z
        .enum([
          "status",
          "list_projects",
          "open_project",
          "save_project",
          "list_timelines",
          "get_timeline",
          "set_timeline",
          "get_clips",
          "get_markers",
          "add_marker",
          "delete_markers",
          "set_playhead",
          "open_page",
          "media_pool",
          "clip_metadata",
          "render_setup",
          "add_render_job",
          "render_queue",
          "start_render",
          "stop_render",
          "render_status",
          "render_formats",
          "delete_render_jobs",
          "export_timeline",
          "grab_still",
          "export_frame",
          "project_settings",
          "timeline_settings",
          "create_timeline",
          "import_media",
          "create_subtitles",
          "detect_scene_cuts",
          "transcribe_audio",
          "node_graph",
          "set_lut",
          "copy_grades",
          "quick_export",
          "media_storage",
        ])
        .describe("Action to perform"),
      name: z.string().optional().describe("Project/timeline name"),
      index: zNumber().optional().describe("Timeline index (1-based)"),
      timeline: z.string().optional().describe("Timeline name"),
      track_type: z
        .string()
        .optional()
        .describe("Track type: video, audio, subtitle"),
      track_index: zNumber().optional().describe("Track index (1-based)"),
      frame_id: zNumber().optional().describe("Frame position for marker"),
      color: z.string().optional().describe("Marker color"),
      note: z.string().optional().describe("Marker note"),
      duration: zNumber().optional().describe("Marker duration in frames"),
      custom_data: z.string().optional().describe("Marker custom data"),
      source: z.string().optional().describe("Marker source: timeline or clip"),
      target: z
        .string()
        .optional()
        .describe("Target for marker: timeline or clip"),
      clip_name: z.string().optional().describe("Clip name"),
      timecode: z.string().optional().describe("Timecode (HH:MM:SS:FF)"),
      page: z
        .string()
        .optional()
        .describe("Page: media, cut, edit, fusion, color, fairlight, deliver"),
      folder: z.string().optional().describe("Media pool folder path"),
      set_metadata: z.any().optional().describe("Metadata dict to set on clip"),
      paths: z.array(z.string()).optional().describe("File paths for import"),
      target_dir: z.string().optional().describe("Render output directory"),
      filename: z.string().optional().describe("Output filename"),
      format: z.string().optional().describe("Render format"),
      codec: z.string().optional().describe("Render codec"),
      width: zNumber().optional().describe("Output width"),
      height: zNumber().optional().describe("Output height"),
      quality: z.any().optional().describe("Video quality"),
      export_video: zBoolean().optional().describe("Export video track"),
      export_audio: zBoolean().optional().describe("Export audio track"),
      job_id: z.string().optional().describe("Render job ID"),
      job_ids: z
        .array(z.string())
        .optional()
        .describe("Render job IDs to start"),
      all: zBoolean().optional().describe("Apply to all"),
      file_path: z.string().optional().describe("File path for export"),
      export_type: z
        .string()
        .optional()
        .describe("Export type: AAF, EDL, FCPXML_1_10, CSV, OTIO, etc."),
      key: z.string().optional().describe("Settings key"),
      value: z.any().optional().describe("Settings value"),
      language: z
        .string()
        .optional()
        .describe("Language for subtitles/transcription"),
      node_index: zNumber().optional().describe("Node index (1-based)"),
      lut_path: z.string().optional().describe("LUT file path"),
      target_clips: z
        .array(z.string())
        .optional()
        .describe("Target clip names for grade copy"),
      preset: z.string().optional().describe("Quick export preset name"),
      path: z.string().optional().describe("Media storage path"),
    }),
  },
  async (params) => {
    const { action, ...rest } = params;
    const cleanParams: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v !== undefined && v !== null) cleanParams[k] = v;
    }

    try {
      const bridgePath = getResolveBridgePath();
      const input = JSON.stringify({ action, params: cleanParams });
      const raw = execSync(`/opt/homebrew/bin/python3 "${bridgePath}"`, {
        input,
        encoding: "utf-8",
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          RESOLVE_SCRIPT_API:
            "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
          RESOLVE_SCRIPT_LIB:
            "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
          PYTHONPATH:
            "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/",
        },
      }).trim();

      const result = JSON.parse(raw);
      if (!result.ok) throw new Error(result.error || "Unknown bridge error");
      return text(JSON.stringify(result.data, null, 2));
    } catch (e: any) {
      return err(`DaVinci Resolve ${action}: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// STANDALONE TOOL — DEVONthink
// ════════════════════════════════════════════════════════════════

function runAppleScript(script: string): string {
  return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

function escapeForAS(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

server.registerTool(
  "devonthink",
  {
    description: `Search and retrieve documents from DEVONthink.
Actions: search (full-text search), similar (find similar documents), read (get plain text by UUID), databases (list all).`,
    inputSchema: z.object({
      action: z
        .enum(["search", "similar", "read", "databases"])
        .describe("Action to perform"),
      query: z
        .string()
        .optional()
        .describe(
          "Search query (supports AND, OR, NOT, NEAR, wildcards, phrase quotes)",
        ),
      uuid: z
        .string()
        .optional()
        .describe("Document UUID (for read and similar)"),
      limit: zNumber().optional().describe("Max results (default 20, max 50)"),
      database: z
        .string()
        .optional()
        .describe("Database name to search in (omit for all)"),
      content_length: zNumber()
        .optional()
        .describe(
          "Max chars of content per search result (default 200, 0 for metadata only)",
        ),
    }),
  },
  async (params) => {
    const { action, query, uuid, database, content_length } = params;
    const limit = Math.min(params.limit || 20, 50);
    const snippetLen = content_length ?? 200;

    try {
      switch (action) {
        case "databases": {
          const script = `
tell application id "DNtp"
  set output to ""
  repeat with db in databases
    set dbName to name of db
    set dbCount to count of contents of db
    set output to output & dbName & " ||| " & dbCount & linefeed
  end repeat
  return output
end tell`;
          const result = runAppleScript(script);
          const lines = result
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => {
              const [name, count] = l.split(" ||| ");
              return `- **${name}**: ${count} records`;
            });
          return text(lines.join("\n"));
        }

        case "search": {
          if (!query) return err("Error: query is required for search action");
          const dbClause = database
            ? `in database "${escapeForAS(database)}"`
            : "";
          const script = `
tell application id "DNtp"
  set results to search "${escapeForAS(query)}" ${dbClause}
  set output to ""
  set maxItems to ${limit}
  if (count of results) < maxItems then set maxItems to (count of results)
  set totalCount to count of results
  repeat with i from 1 to maxItems
    set rec to item i of results
    set recName to name of rec
    set recType to type of rec as string
    set recLoc to location of rec
    set recUUID to uuid of rec
    set recDate to modification date of rec
    set recSize to size of rec
    set recTags to ""
    try
      set recTags to (tags of rec) as string
    end try
    set snippet to ""
    ${
      snippetLen > 0
        ? `try
      set theText to plain text of rec
      if length of theText > ${snippetLen} then
        set snippet to text 1 thru ${snippetLen} of theText
      else
        set snippet to theText
      end if
    end try`
        : ""
    }
    set output to output & "<<RECORD>>" & recName & "<<F>>" & recType & "<<F>>" & recLoc & "<<F>>" & recUUID & "<<F>>" & (recDate as string) & "<<F>>" & recSize & "<<F>>" & recTags & "<<F>>" & snippet & linefeed
  end repeat
  return (totalCount as string) & "<<TOTAL>>" & output
end tell`;
          const raw = runAppleScript(script);
          const [totalPart, ...rest] = raw.split("<<TOTAL>>");
          const totalCount = parseInt(totalPart) || 0;
          const records = rest
            .join("<<TOTAL>>")
            .split("<<RECORD>>")
            .filter((r) => r.trim());

          let output = `## DEVONthink Search: "${query}"\n`;
          output += `**${totalCount} total results** (showing ${Math.min(limit, totalCount)})\n\n`;
          for (const rec of records) {
            const [name, type, location, recUuid, date, size, tags, snippet] =
              rec.split("<<F>>");
            output += `### ${name?.trim()}\n`;
            output += `- **Type:** ${type?.trim()} | **Location:** ${location?.trim()}\n`;
            output += `- **UUID:** \`${recUuid?.trim()}\` | **Modified:** ${date?.trim()} | **Size:** ${size?.trim()} bytes\n`;
            if (tags?.trim()) output += `- **Tags:** ${tags.trim()}\n`;
            if (snippet?.trim())
              output += `- **Preview:** ${snippet.trim().replace(/\n/g, " ").substring(0, snippetLen)}…\n`;
            output += "\n";
          }
          return text(output);
        }

        case "similar": {
          if (!uuid) return err("Error: uuid is required for similar action");
          const script = `
tell application id "DNtp"
  set rec to get record with uuid "${escapeForAS(uuid)}"
  set sourceName to name of rec
  set similar to compare record rec
  set output to ""
  set maxItems to ${limit}
  if (count of similar) < maxItems then set maxItems to (count of similar)
  set totalCount to count of similar
  repeat with i from 1 to maxItems
    set simRec to item i of similar
    set recName to name of simRec
    set recType to type of simRec as string
    set recLoc to location of simRec
    set recUUID to uuid of simRec
    set recSize to size of simRec
    set output to output & "<<RECORD>>" & recName & "<<F>>" & recType & "<<F>>" & recLoc & "<<F>>" & recUUID & "<<F>>" & recSize & linefeed
  end repeat
  return sourceName & "<<SOURCE>>" & (totalCount as string) & "<<TOTAL>>" & output
end tell`;
          const raw = runAppleScript(script);
          const [sourceName, rest1] = raw.split("<<SOURCE>>");
          const [totalPart2, ...rest2] = rest1.split("<<TOTAL>>");
          const totalCount2 = parseInt(totalPart2) || 0;
          const records2 = rest2
            .join("<<TOTAL>>")
            .split("<<RECORD>>")
            .filter((r) => r.trim());

          let output = `## Documents Similar to: "${sourceName?.trim()}"\n`;
          output += `**${totalCount2} similar documents** (showing ${Math.min(limit, totalCount2)})\n\n`;
          for (let i = 0; i < records2.length; i++) {
            const [name, type, location, recUuid, size] =
              records2[i].split("<<F>>");
            output += `${i + 1}. **${name?.trim()}** (${type?.trim()})\n`;
            output += `   Location: ${location?.trim()} | UUID: \`${recUuid?.trim()}\` | Size: ${size?.trim()} bytes\n`;
          }
          return text(output);
        }

        case "read": {
          if (!uuid) return err("Error: uuid is required for read action");
          const script = `
tell application id "DNtp"
  set rec to get record with uuid "${escapeForAS(uuid)}"
  set recName to name of rec
  set recType to type of rec as string
  set recLoc to location of rec
  set recPath to path of rec
  set recDate to modification date of rec
  set recTags to ""
  try
    set recTags to (tags of rec) as string
  end try
  set theText to plain text of rec
  return recName & "<<F>>" & recType & "<<F>>" & recLoc & "<<F>>" & recPath & "<<F>>" & (recDate as string) & "<<F>>" & recTags & "<<F>>" & theText
end tell`;
          const raw = runAppleScript(script);
          const parts = raw.split("<<F>>");
          const [name, type, location, path, date, tags, ...textParts] = parts;
          const docText = textParts.join("<<F>>");
          let output = `## ${name?.trim()}\n`;
          output += `- **Type:** ${type?.trim()} | **Location:** ${location?.trim()}\n`;
          output += `- **Path:** ${path?.trim()}\n`;
          output += `- **Modified:** ${date?.trim()}\n`;
          if (tags?.trim()) output += `- **Tags:** ${tags.trim()}\n`;
          output += `\n---\n\n${docText}`;
          return text(output);
        }

        default:
          return err(`Unknown action: ${action}`);
      }
    } catch (e: any) {
      return err(`DEVONthink error: ${e.message}`);
    }
  },
);

// ════════════════════════════════════════════════════════════════
// STANDALONE TOOL — GitHub Issues (gh CLI)
// ════════════════════════════════════════════════════════════════

const GH_DEFAULT_REPO = "owner/repo";
const GH_TOKEN_PATH = resolve(homedir(), ".config", "gh-token");

function getGhToken(): string {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (existsSync(GH_TOKEN_PATH))
    return readFileSync(GH_TOKEN_PATH, "utf-8").trim();
  throw new Error(
    `No GitHub token. Set GH_TOKEN env var or put token in ${GH_TOKEN_PATH}`,
  );
}

function gh(args: string, repo?: string): string {
  const r = repo || GH_DEFAULT_REPO;
  const token = getGhToken();
  return execSync(`gh ${args} -R ${r}`, {
    encoding: "utf-8",
    timeout: 15000,
    env: { ...process.env, GH_TOKEN: token },
  }).trim();
}

server.registerTool(
  "gh_issues",
  {
    description: `List GitHub issues. Defaults to owner/repo. Filter by state, assignee, labels.`,
    inputSchema: z.object({
      repo: z
        .string()
        .optional()
        .describe("owner/repo (default: owner/repo)"),
      state: z.string().optional().describe("open|closed|all (default: open)"),
      assignee: z.string().optional().describe("GitHub username filter"),
      labels: z.string().optional().describe("Comma-separated labels"),
      limit: zNumber().optional().describe("Max results (default: 30)"),
    }),
  },
  async (params) => {
    const parts = ["issue list"];
    parts.push(`--state ${params.state || "open"}`);
    parts.push(`--limit ${params.limit || 30}`);
    if (params.assignee) parts.push(`--assignee ${params.assignee}`);
    if (params.labels) parts.push(`--label "${params.labels}"`);
    parts.push("--json number,title,state,assignees,labels,createdAt");
    parts.push(
      `--jq '.[] | "#\\(.number) [\\(.assignees | map(.login) | join(","))] \\(.title) (\\(.labels | map(.name) | join(",")))"'`,
    );
    try {
      const result = gh(parts.join(" "), params.repo);
      return text(result || "No issues found.");
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  "gh_issue_create",
  {
    description: `Create a GitHub issue. Returns the issue URL.`,
    inputSchema: z.object({
      title: z.string().describe("Issue title"),
      body: z.string().describe("Issue body (markdown)"),
      repo: z
        .string()
        .optional()
        .describe("owner/repo (default: owner/repo)"),
      assignee: z.string().optional().describe("GitHub username to assign"),
      labels: z.string().optional().describe("Comma-separated labels"),
    }),
  },
  async (params) => {
    const parts = ["issue create"];
    parts.push(`--title "${params.title.replace(/"/g, '\\"')}"`);
    parts.push(
      `--body "${params.body.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`,
    );
    if (params.assignee) parts.push(`--assignee ${params.assignee}`);
    if (params.labels) parts.push(`--label "${params.labels}"`);
    try {
      const result = gh(parts.join(" "), params.repo);
      return text(result);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  "gh_issue_view",
  {
    description: `View a single GitHub issue with full body and comments.`,
    inputSchema: z.object({
      number: zNumber().describe("Issue number"),
      repo: z
        .string()
        .optional()
        .describe("owner/repo (default: owner/repo)"),
    }),
  },
  async (params) => {
    try {
      const result = gh(
        `issue view ${params.number} --json number,title,state,body,assignees,labels,comments --jq '"#\\(.number) [\\(.state)] \\(.title)\\nAssigned: \\(.assignees | map(.login) | join(", "))\\nLabels: \\(.labels | map(.name) | join(", "))\\n\\n\\(.body)\\n\\n--- Comments (\\(.comments | length)) ---\\n\\(.comments | map("\\(.author.login): \\(.body)") | join("\\n\\n"))"'`,
        params.repo,
      );
      return text(result);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    }
  },
);

server.registerTool(
  "gh_issue_edit",
  {
    description: `Edit a GitHub issue — change assignee, labels, title, or state.`,
    inputSchema: z.object({
      number: zNumber().describe("Issue number"),
      repo: z
        .string()
        .optional()
        .describe("owner/repo (default: owner/repo)"),
      title: z.string().optional().describe("New title"),
      assignee: z.string().optional().describe("Set assignee"),
      add_labels: z
        .string()
        .optional()
        .describe("Comma-separated labels to add"),
      remove_labels: z
        .string()
        .optional()
        .describe("Comma-separated labels to remove"),
      state: z.string().optional().describe("open or closed"),
    }),
  },
  async (params) => {
    const results: string[] = [];
    if (params.state) {
      try {
        const cmd = params.state === "closed" ? "close" : "reopen";
        results.push(gh(`issue ${cmd} ${params.number}`, params.repo));
      } catch (e: any) {
        results.push(`State change error: ${e.message}`);
      }
    }
    const editParts = [`issue edit ${params.number}`];
    let hasEdit = false;
    if (params.title) {
      editParts.push(`--title "${params.title.replace(/"/g, '\\"')}"`);
      hasEdit = true;
    }
    if (params.assignee !== undefined) {
      editParts.push(`--add-assignee ${params.assignee}`);
      hasEdit = true;
    }
    if (params.add_labels) {
      editParts.push(`--add-label "${params.add_labels}"`);
      hasEdit = true;
    }
    if (params.remove_labels) {
      editParts.push(`--remove-label "${params.remove_labels}"`);
      hasEdit = true;
    }
    if (hasEdit) {
      try {
        results.push(gh(editParts.join(" "), params.repo));
      } catch (e: any) {
        results.push(`Edit error: ${e.message}`);
      }
    }
    return text(
      results.filter(Boolean).join("\n") || `Issue #${params.number} updated.`,
    );
  },
);

server.registerTool(
  "gh_issue_comment",
  {
    description: `Add a comment to a GitHub issue.`,
    inputSchema: z.object({
      number: zNumber().describe("Issue number"),
      body: z.string().describe("Comment body (markdown)"),
      repo: z
        .string()
        .optional()
        .describe("owner/repo (default: owner/repo)"),
    }),
  },
  async (params) => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpFile = `/tmp/gh-comment-${Date.now()}.md`;
    try {
      writeFileSync(tmpFile, params.body);
      const result = gh(
        `issue comment ${params.number} -F ${tmpFile}`,
        params.repo,
      );
      return text(result || `Commented on #${params.number}.`);
    } catch (e: any) {
      return err(`Error: ${e.message}`);
    } finally {
      try {
        unlinkSync(tmpFile);
      } catch {}
    }
  },
);

  const rawListToolsHandler = (server.server as any)._requestHandlers.get(
    "tools/list",
  );

  if (rawListToolsHandler) {
    server.server.setRequestHandler(
      ListToolsRequestSchema,
      async (request, extra) => {
        const result = await rawListToolsHandler(request, extra);

        return {
          ...result,
          tools: result.tools.map((tool: Record<string, unknown>) => ({
            ...tool,
            inputSchema: inlineLocalRefs(tool.inputSchema),
            ...(tool.outputSchema
              ? { outputSchema: inlineLocalRefs(tool.outputSchema) }
              : {}),
          })),
        };
      },
    );
  }

  return server;
}

// ════════════════════════════════════════════════════════════════
// Connect and start
// ════════════════════════════════════════════════════════════════

type BootstrapTransport = "stdio" | "streamable-http" | "all";

type HttpSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

const HTTP_HOST = process.env.GC_MCP_HOST || "127.0.0.1";
const HTTP_PORT = Number(process.env.GC_MCP_PORT || "8765");
const HTTP_PATH = process.env.GC_MCP_PATH || "/mcp";

function getBootstrapTransport(): BootstrapTransport {
  const raw = (process.env.GC_MCP_TRANSPORT || "stdio").toLowerCase();
  if (raw === "stdio" || raw === "streamable-http" || raw === "all") {
    return raw;
  }

  throw new Error(
    `Invalid GC_MCP_TRANSPORT=${raw}. Expected stdio, streamable-http, or all.`,
  );
}

function isInitializePayload(payload: unknown): boolean {
  return (
    !!payload &&
    typeof payload === "object" &&
    "method" in payload &&
    (payload as { method?: unknown }).method === "initialize"
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return undefined;

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;

  return JSON.parse(raw);
}

function writeJsonError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  if (res.headersSent) return;

  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

async function startStreamableHttpServer(): Promise<void> {
  const sessions = new Map<string, HttpSession>();

  const listener = createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || HTTP_HOST}`,
      );
      if (url.pathname !== HTTP_PATH) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId =
        typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const session = sessionId ? sessions.get(sessionId) : undefined;

        if (!session) {
          if (sessionId || !isInitializePayload(body)) {
            writeJsonError(
              res,
              400,
              "Bad Request: No valid session ID provided",
            );
            return;
          }

          const server = buildMcpServer();
          let transport!: StreamableHTTPServerTransport;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              sessions.set(newSessionId, { server, transport });
            },
          });

          transport.onclose = async () => {
            const sid = transport.sessionId;
            if (sid) sessions.delete(sid);
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
    } catch (e: any) {
      writeJsonError(res, 500, e.message || "Internal server error");
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    listener.once("error", rejectListen);
    listener.listen(HTTP_PORT, HTTP_HOST, () => {
      listener.off("error", rejectListen);
      process.stderr.write(
        `gc_mcp streamable_http listening on http://${HTTP_HOST}:${HTTP_PORT}${HTTP_PATH}\n`,
      );
      resolveListen();
    });
  });
}

async function main() {
  const mode = getBootstrapTransport();

  if (mode === "stdio" || mode === "all") {
    const server = buildMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  }

  if (mode === "streamable-http" || mode === "all") {
    await startStreamableHttpServer();
  }
}

main().catch((e) => {
  process.stderr.write(`gc_mcp fatal: ${e.message}\n`);
  process.exit(1);
});
