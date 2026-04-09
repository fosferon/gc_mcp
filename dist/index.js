#!/usr/bin/env node
/**
 * gc_mcp — Universal MCP server for Grand Central
 *
 * Thin translation layer: MCP tool calls → HTTP POST to gc_daemon (localhost:4242)
 * Plus 3 standalone tools: davinci_resolve, devonthink, gh_issues
 *
 * Usage:
 *   node dist/index.js
 *
 * Config:
 *   { "mcpServers": { "gc": { "command": "node", "args": ["~/Sites/agents/gc_mcp/dist/index.js"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
// ════════════════════════════════════════════════════════════════
// HTTP Client — gc_daemon at localhost:4242
// ════════════════════════════════════════════════════════════════
const GC_BASE = process.env.GC_DAEMON_URL || "http://localhost:4242";
async function gcPost(path, body) {
    const url = `${GC_BASE}${path}`;
    const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`gc_daemon ${path} failed (${resp.status}): ${text}`);
    }
    return resp.json();
}
async function gcGet(path) {
    const url = `${GC_BASE}${path}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok)
        throw new Error(`gc_daemon ${path} failed (${resp.status})`);
    return resp.json();
}
/** Strip undefined values from params before sending to daemon */
function clean(params) {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
/** Standard MCP text result */
function text(t) {
    return { content: [{ type: "text", text: t }] };
}
/** Standard MCP error result */
function err(msg) {
    return { content: [{ type: "text", text: msg }], isError: true };
}
/** Call daemon and return formatted JSON */
async function daemonCall(endpoint, params) {
    try {
        const result = await gcPost(endpoint, clean(params));
        return text(JSON.stringify(result, null, 2));
    }
    catch (e) {
        return err(`ERROR: ${e.message}`);
    }
}
// ════════════════════════════════════════════════════════════════
// MCP Server
// ════════════════════════════════════════════════════════════════
const server = new McpServer({ name: "gc", version: "1.0.0" }, {
    instructions: [
        "Grand Central operations hub. All tools route to gc_daemon (localhost:4242).",
        "Use gc_recall for memory search (FTS5, instant). gc_retain to store facts.",
        "gc_work manages the Bee DAG — issues, dependencies, assignments.",
        "gc_plan answers 'what should I work on next?' with scored recommendations.",
        "gc_convergence tracks strategic vectors — use 'report' for the real 'where are we at?'",
        "gc_ticker provides situational awareness snapshots.",
    ].join(" "),
});
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Memory
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_recall", {
    description: `Search the memory bank for facts matching a query. Uses FTS5/BM25 — instant, zero cost.
Falls back to hindsight (expensive, deep) only if no local results and hindsight is available.
Returns ranked facts with bank attribution and match scores.`,
    inputSchema: z.object({
        query: z.string().describe("Natural language search query"),
        bank: z.string().optional().describe("Filter to specific bank (omit for global search)"),
        limit: z.number().optional().describe("Max results (default 15)"),
        mode: z.enum(["linear", "deep", "full"]).optional().describe('"linear" (default) = local facts only, recency-weighted. "deep" = includes HS-imports. "full" = everything, pure BM25 (debug).'),
        hindsight: z.enum(["never", "fallback", "always"]).optional().describe('"never" = local only, "fallback" = use if no local results, "always" = always call hindsight too'),
    }),
}, async (params) => daemonCall("/gc/recall", params));
server.registerTool("gc_retain", {
    description: `Store a fact in the memory bank. Auto-routes to the best bank by keyword matching, or specify a bank.
Deduplicates by content fingerprint + BM25 similarity — won't store near-duplicates.`,
    inputSchema: z.object({
        content: z.string().describe("The fact to store — be specific and include relevant context"),
        bank: z.string().optional().describe("Target bank (auto-routed if omitted)"),
        context: z.string().optional().describe("Category: architecture, decision, pattern, convention, bug, etc."),
        tags: z.array(z.string()).optional().describe("Tags for this fact"),
        source: z.string().optional().describe("Where this fact comes from"),
        supersedes: z.union([z.string(), z.array(z.string())]).optional().describe("Fact ID(s) this new fact supersedes"),
        origin: z.string().optional().describe("Origin: 'local' (default), 'hs-import', 'hs-echo'"),
        hindsight: z.boolean().optional().describe("Also push to Hindsight for deep memory"),
    }),
}, async (params) => daemonCall("/gc/retain", params));
server.registerTool("gc_reflect", {
    description: `Analyze coverage for a topic across all memory banks.
Shows: which banks have relevant facts, tag distribution, coverage gaps, stale facts.`,
    inputSchema: z.object({
        topic: z.string().describe("Topic to analyze coverage for"),
        bank: z.string().optional().describe("Restrict analysis to one bank"),
    }),
}, async (params) => daemonCall("/gc/reflect", params));
server.registerTool("gc_banks", {
    description: `Manage memory banks: list all banks with stats, or create new banks.
Actions: "list" = show all banks, "create" = new bank, "stats" = detailed statistics.`,
    inputSchema: z.object({
        action: z.enum(["list", "create", "stats"]).describe("Action to perform"),
        name: z.string().optional().describe("Bank name (for create)"),
        description: z.string().optional().describe("Bank description (for create)"),
        keywords: z.array(z.string()).optional().describe("Bank keywords (for create)"),
    }),
}, async (params) => daemonCall("/gc/banks", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Directives
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_directive", {
    description: `Manage behavioral directives using the @always/@never/@stop/@pin/@until vocabulary.
Directives are injected into agent context automatically. Scoped to specific agents or global (*).
Actions: "add" — create, "remove" — deactivate by ID, "list" — show active, "inject" — formatted for context injection.`,
    inputSchema: z.object({
        action: z.enum(["add", "remove", "list", "inject"]).describe("Action to perform"),
        content: z.string().optional().describe("Directive text (for add)"),
        persistence: z.string().optional().describe("Persistence level: always, pin, never, stop, remember, until"),
        scope: z.string().optional().describe("Agent scope: * for all, or agent name(s) comma-separated"),
        id: z.string().optional().describe("Directive ID (for remove)"),
        source: z.string().optional().describe("Where this directive came from"),
        expires_at: z.string().optional().describe("ISO date for @until directives"),
        query: z.string().optional().describe("Similarity query for inject (optional)"),
    }),
}, async (params) => daemonCall("/gc/directive", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Work (Bee DAG)
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_work", {
    description: `Work coordination with dependency DAG.
Actions: create, list, ready, show, update, done, cancel, block, unblock, claim, release, comment, plan, tree, stale.
Issues have dependencies (DAG), assignments, locks, labels. Use 'ready' to see what's unblocked. 'plan' for critical path.`,
    inputSchema: z.object({
        action: z.enum(["create", "list", "ready", "show", "update", "done", "cancel", "block", "unblock", "claim", "release", "comment", "plan", "tree", "stale"]).describe("Action to perform"),
        title: z.string().optional().describe("Issue title"),
        description: z.string().optional().describe("Issue description"),
        priority: z.number().optional().describe("Priority (higher = more important)"),
        type: z.string().optional().describe("Issue type: task, bug, epic, objective"),
        project: z.string().optional().describe("Project name"),
        parent: z.string().optional().describe("Parent issue ID (for sub-tasks)"),
        labels: z.array(z.string()).optional().describe("Labels"),
        id: z.string().optional().describe("Issue ID (number or full ID)"),
        depends_on: z.string().optional().describe("Issue ID this depends on"),
        agent: z.string().optional().describe("Agent name for claim/assign"),
        note: z.string().optional().describe("Comment text or close reason"),
        status: z.string().optional().describe("Filter by status: open, in_progress, closed, all"),
        assigned: z.string().optional().describe("Filter by assigned agent"),
    }),
}, async (params) => daemonCall("/gc/work", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Timeline
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_timeline", {
    description: `Manage timeline events — deadlines, appointments, blocks, milestones. Links events to Bee issues and other entities.
Actions: create_event, update_event, delete_event, get, link, unlink, query, today, upcoming_deadlines, slipped.`,
    inputSchema: z.object({
        action: z.enum(["create_event", "update_event", "delete_event", "get", "link", "unlink", "query", "today", "upcoming_deadlines", "slipped"]).describe("Action to perform"),
        id: z.union([z.number(), z.string()]).optional().describe("Event or link ID"),
        title: z.string().optional().describe("Event title"),
        type: z.string().optional().describe("Event type: deadline, appointment, block, milestone"),
        starts_at: z.string().optional().describe("Start time (ISO 8601)"),
        ends_at: z.string().optional().describe("End time (ISO 8601)"),
        all_day: z.boolean().optional().describe("All-day event"),
        recurrence: z.string().optional().describe("Recurrence: daily, weekly, monthly, yearly"),
        labels: z.array(z.string()).optional().describe("Labels"),
        notes: z.string().optional().describe("Notes"),
        event_id: z.number().optional().describe("Event ID (for linking)"),
        linkable_type: z.string().optional().describe("Link target type: bee_issue, reminder, external"),
        linkable_id: z.string().optional().describe("Link target ID"),
        role: z.string().optional().describe("Link role: deadline_for, blocks, related"),
        from: z.string().optional().describe("Query range start (ISO)"),
        to: z.string().optional().describe("Query range end (ISO)"),
        hours: z.number().optional().describe("Deadline lookahead hours (default 48)"),
        limit: z.number().optional().describe("Max results"),
    }),
}, async (params) => daemonCall("/gc/timeline", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Time Registry
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_time", {
    description: `Track actual time spent on work. Timers, manual logging, agent job capture, duration models.
Actions: start_timer, stop_timer, log, log_agent_job, delete, running, query, aggregate, capacity, duration_estimate.`,
    inputSchema: z.object({
        action: z.enum(["start_timer", "stop_timer", "log", "log_agent_job", "delete", "running", "query", "aggregate", "capacity", "duration_estimate"]).describe("Action to perform"),
        resource: z.string().optional().describe("Resource name: leonidas, mobus, ops, etc."),
        id: z.number().optional().describe("Time entry ID"),
        bee_issue_id: z.string().optional().describe("Bee issue ID to link to"),
        event_id: z.number().optional().describe("Timeline event ID to link to"),
        started_at: z.string().optional().describe("Start time (ISO 8601)"),
        ended_at: z.string().optional().describe("End time (ISO 8601)"),
        duration_minutes: z.number().optional().describe("Explicit duration in minutes"),
        labels: z.array(z.string()).optional().describe("Labels for categorization"),
        notes: z.string().optional().describe("Notes about the work"),
        source: z.string().optional().describe("Source: manual, agent, auto"),
        from: z.string().optional().describe("Query range start (ISO)"),
        to: z.string().optional().describe("Query range end (ISO)"),
        dimension: z.string().optional().describe("Aggregation dimension: resource, bee_issue_id, source"),
        limit: z.number().optional().describe("Max results"),
        agent: z.string().optional().describe("Agent name (for log_agent_job)"),
        issue: z.string().optional().describe("Issue ID (for log_agent_job)"),
        task: z.string().optional().describe("Task description (for log_agent_job)"),
    }),
}, async (params) => daemonCall("/gc/time", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Cash Flow
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_cash", {
    description: `Track money in/out. Runway, forecasts, drift detection.
Actions: add, update, delete, get, query, runway, monthly, forecast, drift.`,
    inputSchema: z.object({
        action: z.enum(["add", "update", "delete", "get", "query", "runway", "monthly", "forecast", "drift"]).describe("Action to perform"),
        id: z.number().optional().describe("Entry ID"),
        title: z.string().optional().describe("Entry title"),
        type: z.string().optional().describe("income or expense"),
        category: z.string().optional().describe("Category: client_work, retainer, infrastructure, subscriptions, etc."),
        amount: z.number().optional().describe("Amount in cents (1250 = €12.50) or euros as float (12.50)"),
        date: z.string().optional().describe("Date (ISO: 2026-03-07)"),
        currency: z.string().optional().describe("Currency code (default EUR)"),
        status: z.string().optional().describe("expected, confirmed, received, or paid"),
        recurrence: z.string().optional().describe("monthly, quarterly, yearly"),
        confidence: z.number().optional().describe("0.0-1.0 confidence for expected entries"),
        source_type: z.string().optional().describe("project, client, bee_issue"),
        source_id: z.string().optional().describe("Source entity ID"),
        notes: z.string().optional().describe("Notes"),
        labels: z.array(z.string()).optional().describe("Labels"),
        from: z.string().optional().describe("Query range start (ISO date)"),
        to: z.string().optional().describe("Query range end (ISO date)"),
        cash_on_hand: z.number().optional().describe("Current cash in euros (for runway)"),
        months: z.number().optional().describe("Lookback or lookahead months"),
        limit: z.number().optional().describe("Max results"),
    }),
}, async (params) => daemonCall("/gc/cash", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Publishing
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_publishing", {
    description: `Content dissemination metrics. Track pieces, platform posts, and performance over time.
Actions: create (piece), post (distribution), snapshot (manual metrics), ingest (parse platform export), list, report, compare, trend, funnel.`,
    inputSchema: z.object({
        action: z.enum(["create", "post", "snapshot", "ingest", "list", "report", "compare", "trend", "funnel"]).describe("Action to perform"),
        // create piece
        id: z.string().optional().describe("Piece slug ID (for create)"),
        title: z.string().optional().describe("Piece title"),
        url: z.string().optional().describe("Canonical URL"),
        brand: z.string().optional().describe("Brand: leonidas, fosferon, sil"),
        category: z.string().optional().describe("Category: essay, video, thread, post"),
        published_at: z.string().optional().describe("Publish date (ISO)"),
        tags: z.array(z.string()).optional().describe("Tags"),
        // post (distribution)
        piece_id: z.string().optional().describe("Piece ID to link to"),
        platform: z.string().optional().describe("Platform: linkedin, medium, x, youtube, hackernews, tiktok, instagram, substack"),
        platform_id: z.string().optional().describe("Platform-specific post ID/URN"),
        round: z.number().optional().describe("Distribution round (1, 2, 3)"),
        angle: z.string().optional().describe("Content angle: behaviour_hook, research_evidence, philosophical, general"),
        posted_at: z.string().optional().describe("Post date (ISO datetime)"),
        // metrics
        post_id: z.number().optional().describe("Post ID (for snapshot, ingest, trend)"),
        snapshot_at: z.string().optional().describe("Snapshot date (ISO)"),
        impressions: z.number().optional().describe("Impressions count"),
        reach: z.number().optional().describe("Members reached"),
        link_clicks: z.number().optional().describe("Link clicks"),
        reactions: z.number().optional().describe("Reactions count"),
        comments: z.number().optional().describe("Comments count"),
        reposts: z.number().optional().describe("Reposts count"),
        saves: z.number().optional().describe("Saves count"),
        profile_views: z.number().optional().describe("Profile views from post"),
        followers_gained: z.number().optional().describe("Followers gained"),
        demographics: z.string().optional().describe("Demographics JSON"),
        // ingest
        file: z.string().optional().describe("File path for ingest"),
        snapshot_date: z.string().optional().describe("Override snapshot date for ingest (ISO)"),
        force: z.boolean().optional().describe("Force ingest even if duplicate snapshot exists"),
        // list/compare
        type: z.string().optional().describe("List type: pieces or posts"),
        dimension: z.string().optional().describe("Compare dimension: round, angle, platform, piece"),
        limit: z.number().optional().describe("Max results"),
    }),
}, async (params) => daemonCall("/gc/publishing", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Planner
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_plan", {
    description: `Resource-constrained scheduler. "What should I work on next?"
Actions: next, replan, profile, switch_profile, list_profiles, upsert_profile, resources, upsert_resource, capacity, conflicts, simulate, simulate_single, scenarios, solve, solve_and_validate.`,
    inputSchema: z.object({
        action: z.enum(["next", "replan", "profile", "switch_profile", "list_profiles", "upsert_profile", "resources", "upsert_resource", "capacity", "conflicts", "simulate", "simulate_single", "scenarios", "solve", "solve_and_validate"]).describe("Action to perform"),
        resource: z.string().optional().describe("Resource name (default: leonidas)"),
        name: z.string().optional().describe("Profile or resource name"),
        description: z.string().optional().describe("Profile description"),
        weights: z.any().optional().describe("Weight vector: {label: weight, ...}"),
        active: z.boolean().optional().describe("Set as active profile"),
        type: z.string().optional().describe("Resource type: human or agent"),
        capacity_hours_day: z.number().optional().describe("Hours per day"),
        capacity_hours_week: z.number().optional().describe("Hours per week"),
        availability: z.string().optional().describe("weekdays, always, or custom"),
        labels: z.array(z.string()).optional().describe("Labels"),
        scenario: z.string().optional().describe("Named scenario: current, stress, optimistic, revenue_mode, six_month"),
        n: z.number().optional().describe("Number of Monte Carlo runs (default: 100)"),
        horizon_days: z.number().optional().describe("Simulation horizon in days"),
        cash_balance: z.number().optional().describe("Override starting cash balance (euros)"),
        inject_disruptions: z.boolean().optional().describe("Inject random disruptions"),
        base_seed: z.number().optional().describe("Base seed for reproducible Monte Carlo"),
        seed: z.number().optional().describe("Random seed for single simulation"),
        time_limit_ms: z.number().optional().describe("Solver time limit in ms (default: 10000)"),
    }),
}, async (params) => daemonCall("/gc/plan", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Convergence
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_convergence", {
    description: `Strategic vector tracking — the Fosferon evaluation model.
Actions: report, vectors, get_vector, create_vector, update_vector, link, unlink, vectors_for, score, leverage, set_leverage, backfill,
vitality, snapshot, snapshots, events, log_event, record_outcome, outcomes, correlation,
invest, update_investment, investments, causal_chain, project, projections, expected_value, resolve_projection, accuracy_trend, retrofit, roi, horizon_score.`,
    inputSchema: z.object({
        action: z.enum([
            "report", "vectors", "get_vector", "create_vector", "update_vector",
            "link", "unlink", "vectors_for", "score", "leverage", "set_leverage", "backfill",
            "vitality", "snapshot", "snapshots", "events", "log_event",
            "record_outcome", "outcomes", "correlation",
            "invest", "update_investment", "investments", "causal_chain",
            "project", "projections", "expected_value", "resolve_projection",
            "accuracy_trend", "retrofit", "roi", "horizon_score",
        ]).describe("Action to perform"),
        handle: z.string().optional().describe("Vector handle (e.g. revenue:atrapos)"),
        vector: z.string().optional().describe("Vector handle for linking"),
        name: z.string().optional().describe("Vector name"),
        category: z.string().optional().describe("revenue|authority|academic|infrastructure|product|network"),
        domain: z.string().optional().describe("Domain: mobus, atrapos, fosferon, gc, etc."),
        status: z.string().optional().describe("active|dormant|emerged"),
        notes: z.string().optional().describe("Notes"),
        type: z.string().optional().describe("Linkable type: bee_issue, cash_entry, time_entry, event, commit, content"),
        id: z.string().optional().describe("Linkable ID or link ID (for unlink)"),
        linkable_type: z.string().optional().describe("For set_leverage"),
        linkable_id: z.string().optional().describe("For set_leverage"),
        coefficient: z.number().optional().describe("Leverage coefficient (>1 = amplifier)"),
        evidence: z.string().optional().describe("Why this leverage coefficient"),
        window: z.number().optional().describe("Window in days for report (default 30)"),
        days: z.number().optional().describe("Backfill period in days (default 90)"),
        // Investment tracking
        investment_id: z.string().optional().describe("Investment ID (for causal_chain)"),
        amount: z.number().optional().describe("Investment amount"),
        // Projection
        projection_id: z.string().optional().describe("Projection ID (for expected_value, resolve_projection)"),
        actual: z.number().optional().describe("Actual outcome value (for resolve_projection)"),
        // Snapshot
        label: z.string().optional().describe("Snapshot label"),
        // Events
        event_type: z.string().optional().describe("Convergence event type"),
        limit: z.number().optional().describe("Max results"),
    }),
}, async (params) => daemonCall("/gc/convergence", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Dispatch (on-demand agent execution)
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_dispatch", {
    description: `On-demand agent dispatch. Spawn an agent with a task, check job status, retrieve output.
Actions: dispatch (spawn agent), status (check job), output (get result).
Default is fire-and-forget (returns job_id immediately). Set wait=true to block until done.`,
    inputSchema: z.object({
        action: z.enum(["dispatch", "status", "output"]).describe("Action to perform"),
        agent: z.string().optional().describe("Agent name to dispatch (required for dispatch)"),
        task: z.string().optional().describe("Task text (required for dispatch)"),
        cwd: z.string().optional().describe("Working directory (optional, defaults to project default)"),
        issue: z.string().optional().describe("Bee issue ID to link (optional)"),
        wait: z.boolean().optional().describe("If true, block until agent completes (default: false)"),
        timeout: z.number().optional().describe("Max seconds to wait when wait=true (default: 300)"),
        job_id: z.string().optional().describe("Job ID (for status/output actions)"),
    }),
}, async (params) => daemonCall("/gc/dispatch", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Schedule
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_schedule", {
    description: `Manage scheduled agent dispatches.
Actions: list, create, enable, disable, delete, history, fire (manual trigger), tick (force check).
Trigger types: cron, interval, session_start, once.`,
    inputSchema: z.object({
        action: z.enum(["list", "create", "enable", "disable", "delete", "history", "fire", "tick"]).describe("Action to perform"),
        name: z.string().optional().describe("Schedule name"),
        description: z.string().optional().describe("Schedule description"),
        trigger: z.string().optional().describe("Trigger type: cron, interval, session_start, once"),
        hour: z.number().optional().describe("Cron hour (0-23)"),
        minute: z.number().optional().describe("Cron minute (0-59), default 0"),
        days: z.array(z.string()).optional().describe('Days of week: ["mon","tue",...]'),
        interval: z.number().optional().describe("Interval in minutes"),
        fire_at: z.string().optional().describe("ISO timestamp for one-shot"),
        action_type: z.string().optional().describe("What to do: dispatch (default) or notify"),
        agent: z.string().optional().describe("Agent to dispatch"),
        task: z.string().optional().describe("Task text"),
        cwd: z.string().optional().describe("Working directory"),
        issue: z.string().optional().describe("Linked bee issue"),
        id: z.string().optional().describe("Schedule ID"),
        limit: z.number().optional().describe("History limit (default 20)"),
    }),
}, async (params) => daemonCall("/gc/schedule", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Reminders
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_remind", {
    description: `Human reminders. Simple, managed by Eve or directly.
Actions: add (create reminder), list (show pending/fired), dismiss (mark as handled), snooze (delay), delete.
Due accepts: ISO timestamps, relative times.`,
    inputSchema: z.object({
        action: z.enum(["add", "list", "dismiss", "snooze", "delete"]).describe("Action to perform"),
        text: z.string().optional().describe("Reminder text"),
        due: z.string().optional().describe("When: ISO timestamp or relative time"),
        recurrence: z.string().optional().describe("Repeat: daily, weekdays, weekly, monthly"),
        labels: z.array(z.string()).optional().describe("Labels for categorization"),
        id: z.string().optional().describe("Reminder ID (for dismiss/snooze/delete)"),
        snooze_for: z.string().optional().describe("Snooze duration"),
        status: z.string().optional().describe("Filter: pending, fired, all"),
        created_by: z.string().optional().describe("Who created: human (default), eve, or agent name"),
    }),
}, async (params) => daemonCall("/gc/remind", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Workflow
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_workflow", {
    description: `Run deterministic workflows from .pi/workflows/.
Workflows are YAML pipelines with step types: tool, prompt, dispatch, each, branch.
Actions: run, list, show, detail, context, watch, resume.`,
    inputSchema: z.object({
        action: z.enum(["run", "list", "show", "detail", "context", "watch", "resume"]).describe("Action to perform"),
        workflow: z.string().optional().describe("Workflow name (from .pi/workflows/)"),
        params: z.string().optional().describe("JSON parameters for the workflow"),
        id: z.string().optional().describe("Execution ID (for show/resume/detail/context/watch)"),
        execution_id: z.string().optional().describe("Execution ID (alias for id)"),
        key: z.string().optional().describe("Context key to inspect (for context action)"),
        interval: z.number().optional().describe("Poll interval in seconds for watch (default: 5)"),
        timeout: z.number().optional().describe("Max seconds to wait for watch (default: 120)"),
    }),
}, async (params) => {
    // Normalize execution_id -> id for the handler
    const normalized = { ...params };
    if (normalized.execution_id && !normalized.id) {
        normalized.id = normalized.execution_id;
    }
    return daemonCall("/gc/workflow", normalized);
});
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Mail
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_mail", {
    description: `Query email state, financial data, and inbox summary from the mail transceiver.
Actions: summary, burn_rate, financial, messages, endpoints, scan, extract_financials, ocr,
add_endpoint, remove_endpoint, enable_endpoint, disable_endpoint, update_endpoint,
seed_rules, sender_queue, classify_sender, dismiss_sender, ignore_sender, backfill_senders.`,
    inputSchema: z.object({
        action: z.enum([
            "summary", "burn_rate", "financial", "messages", "endpoints", "scan", "extract_financials", "ocr",
            "add_endpoint", "remove_endpoint", "enable_endpoint", "disable_endpoint", "update_endpoint",
            "seed_rules", "sender_queue", "classify_sender", "dismiss_sender", "ignore_sender", "backfill_senders",
        ]).describe("Action to perform"),
        months: z.number().optional().describe("Burn rate lookback months (default 3)"),
        category: z.string().optional().describe("Filter messages by category"),
        from: z.string().optional().describe("Filter messages by sender (substring)"),
        since: z.string().optional().describe("Filter messages since date (ISO)"),
        direction: z.string().optional().describe("Financial direction: expense or income"),
        vat_period: z.string().optional().describe("VAT period filter"),
        limit: z.number().optional().describe("Max results"),
        // Endpoint management
        id: z.string().optional().describe("Endpoint or sender ID"),
        email: z.string().optional().describe("Email address (for add_endpoint)"),
        name: z.string().optional().describe("Endpoint name"),
        imap_host: z.string().optional().describe("IMAP host (default: imap.zoho.com)"),
        imap_port: z.number().optional().describe("IMAP port (default: 993)"),
        username: z.string().optional().describe("IMAP username"),
        app_key: z.string().optional().describe("IMAP app-specific password"),
        scan_folders: z.array(z.string()).optional().describe("Folders to scan (default: [INBOX])"),
        autonomy: z.string().optional().describe("Autonomy level: observe, classify, act"),
        endpoint_id: z.string().optional().describe("Endpoint ID (for scan)"),
        // Sender classification
        view: z.string().optional().describe("Sender queue view: summary or list"),
        reason: z.string().optional().describe("Reason for dismiss/ignore"),
    }),
}, async (params) => daemonCall("/gc/mail", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — HTTP Client
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_http", {
    description: `Generic HTTP client for external API calls.
Actions: get, post, put, delete. Supports bearer, basic, and header auth.`,
    inputSchema: z.object({
        action: z.enum(["get", "post", "put", "delete"]).describe("HTTP method"),
        url: z.string().describe("Target URL"),
        body: z.any().optional().describe("JSON body (for post/put)"),
        params: z.record(z.string()).optional().describe("Query parameters"),
        headers: z.record(z.string()).optional().describe("Custom headers"),
        auth: z.object({
            type: z.enum(["bearer", "basic", "header"]).describe("Auth type"),
            token: z.string().optional().describe("Bearer token"),
            username: z.string().optional().describe("Basic auth username"),
            password: z.string().optional().describe("Basic auth password"),
            name: z.string().optional().describe("Custom header name"),
            value: z.string().optional().describe("Custom header value"),
        }).optional().describe("Authentication config"),
        timeout: z.number().optional().describe("Timeout in ms (default 30000)"),
    }),
}, async (params) => daemonCall("/gc/http", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Timing (macOS Timing.app)
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_timing", {
    description: `Read-only queries against macOS Timing.app SQLite database.
Actions: summary (project totals), capacity (daily hours), duration (estimate from labels), hours_by_label.`,
    inputSchema: z.object({
        action: z.enum(["summary", "capacity", "duration", "hours_by_label"]).describe("Action to perform"),
        since: z.string().optional().describe("Start date filter (ISO)"),
        until: z.string().optional().describe("End date filter (ISO)"),
        labels: z.array(z.string()).optional().describe("Labels for duration estimate"),
    }),
}, async (params) => daemonCall("/gc/timing", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Sync (Reconciliation Engine)
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_sync", {
    description: `Reconciliation engine for data hygiene.
Actions: status (last runs, pending reviews), run (trigger sync), rules (list rule files), reviews (pending items), classify (resolve item), dismiss (dismiss item).`,
    inputSchema: z.object({
        action: z.enum(["status", "run", "rules", "reviews", "classify", "dismiss"]).describe("Action to perform"),
        rule_file: z.string().optional().describe("Specific rule file to run or filter by"),
        id: z.string().optional().describe("Review item ID (for classify/dismiss)"),
        resolution: z.record(z.unknown()).optional().describe("Resolution data (for classify)"),
        reason: z.string().optional().describe("Reason for dismiss"),
        limit: z.number().optional().describe("Max results"),
    }),
}, async (params) => daemonCall("/gc/sync", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — MCP Client Proxy
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_mcpclient", {
    description: `General-purpose MCP client proxy. Connect to any MCP server once, use from any agent.
Supports all transports: streamable_http (default), sse (e.g. Tidewave), stdio, websocket.
Actions: connect (register + connect), disconnect, remove, servers (list registered), tools (list tools), call (invoke a tool), scan (health-check all).`,
    inputSchema: z.object({
        action: z.enum(["connect", "disconnect", "remove", "servers", "tools", "call", "scan"]).describe("Action to perform"),
        name: z.string().optional().describe("Server name (for connect/disconnect/remove)"),
        url: z.string().optional().describe("Server URL (for connect)"),
        transport: z.string().optional().describe("Transport type: streamable_http (default), sse, stdio, websocket"),
        description: z.string().optional().describe("Server description (for connect)"),
        metadata: z.record(z.unknown()).optional().describe("Extra config (e.g. {command, args} for stdio)"),
        server: z.string().optional().describe("Server name (for tools/call)"),
        tool: z.string().optional().describe("Tool name to call (for call action)"),
        arguments: z.record(z.unknown()).optional().describe("Tool arguments (for call)"),
        timeout: z.number().optional().describe("Call timeout in seconds"),
    }),
}, async (params) => daemonCall("/gc/mcpclient", params));
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Ticker (Situational Awareness)
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_ticker", {
    description: `Situational awareness snapshot. Returns the latest ticker state from gc_daemon.
Actions: "get" (default) = latest snapshot, "tick" = force a fresh tick.`,
    inputSchema: z.object({
        action: z.enum(["get", "tick"]).optional().describe("Action: get (default) or tick (force refresh)"),
    }),
}, async (params) => {
    try {
        if (params.action === "tick") {
            const result = await gcPost("/gc/ticker", { action: "tick" });
            return text(JSON.stringify(result, null, 2));
        }
        // Default: GET request
        const result = await gcGet("/gc/ticker");
        return text(JSON.stringify(result, null, 2));
    }
    catch (e) {
        return err(`Ticker error: ${e.message}`);
    }
});
// ════════════════════════════════════════════════════════════════
// DAEMON TOOLS — Notifications
// ════════════════════════════════════════════════════════════════
server.registerTool("gc_notify", {
    description: `Push and drain notifications.
Actions: "push" = send a notification, "drain" = get unread notifications, "list" = list by status.`,
    inputSchema: z.object({
        action: z.enum(["push", "drain", "list"]).describe("Action to perform"),
        source: z.string().optional().describe("Notification source (for push)"),
        content: z.string().optional().describe("Notification content (for push)"),
        priority: z.number().optional().describe("Notification priority (for push, default 0)"),
        limit: z.number().optional().describe("Max notifications to drain (default 10)"),
        status: z.string().optional().describe("Filter by status: unread (default)"),
    }),
}, async (params) => daemonCall("/gc/notify", params));
// ════════════════════════════════════════════════════════════════
// STANDALONE TOOL — DaVinci Resolve
// ════════════════════════════════════════════════════════════════
function getResolveBridgePath() {
    // Bridge script lives next to the pi extension
    const piExtPath = join(homedir(), "Sites", "agents", ".pi", "extensions", "davinci-resolve", "resolve-bridge.py");
    if (existsSync(piExtPath))
        return piExtPath;
    // Fallback: check relative to this file
    const localPath = resolve(dirname(import.meta.url.replace("file://", "")), "..", "..", ".pi", "extensions", "davinci-resolve", "resolve-bridge.py");
    if (existsSync(localPath))
        return localPath;
    throw new Error("resolve-bridge.py not found");
}
server.registerTool("davinci_resolve", {
    description: `Control DaVinci Resolve Studio via scripting API. Requires Resolve to be running.
Actions: status, list_projects, open_project, save_project, list_timelines, get_timeline, set_timeline,
get_clips, get_markers, add_marker, delete_markers, set_playhead, open_page, media_pool, clip_metadata,
render_setup, add_render_job, render_queue, start_render, stop_render, render_status, render_formats,
delete_render_jobs, export_timeline, grab_still, export_frame, project_settings, timeline_settings,
create_timeline, import_media, create_subtitles, detect_scene_cuts, transcribe_audio, node_graph,
set_lut, copy_grades, quick_export, media_storage.`,
    inputSchema: z.object({
        action: z.enum([
            "status", "list_projects", "open_project", "save_project",
            "list_timelines", "get_timeline", "set_timeline",
            "get_clips", "get_markers", "add_marker", "delete_markers",
            "set_playhead", "open_page",
            "media_pool", "clip_metadata",
            "render_setup", "add_render_job", "render_queue",
            "start_render", "stop_render", "render_status",
            "render_formats", "delete_render_jobs",
            "export_timeline", "grab_still", "export_frame",
            "project_settings", "timeline_settings",
            "create_timeline", "import_media",
            "create_subtitles", "detect_scene_cuts", "transcribe_audio",
            "node_graph", "set_lut", "copy_grades",
            "quick_export", "media_storage",
        ]).describe("Action to perform"),
        name: z.string().optional().describe("Project/timeline name"),
        index: z.number().optional().describe("Timeline index (1-based)"),
        timeline: z.string().optional().describe("Timeline name"),
        track_type: z.string().optional().describe("Track type: video, audio, subtitle"),
        track_index: z.number().optional().describe("Track index (1-based)"),
        frame_id: z.number().optional().describe("Frame position for marker"),
        color: z.string().optional().describe("Marker color"),
        note: z.string().optional().describe("Marker note"),
        duration: z.number().optional().describe("Marker duration in frames"),
        custom_data: z.string().optional().describe("Marker custom data"),
        source: z.string().optional().describe("Marker source: timeline or clip"),
        target: z.string().optional().describe("Target for marker: timeline or clip"),
        clip_name: z.string().optional().describe("Clip name"),
        timecode: z.string().optional().describe("Timecode (HH:MM:SS:FF)"),
        page: z.string().optional().describe("Page: media, cut, edit, fusion, color, fairlight, deliver"),
        folder: z.string().optional().describe("Media pool folder path"),
        set_metadata: z.any().optional().describe("Metadata dict to set on clip"),
        paths: z.array(z.string()).optional().describe("File paths for import"),
        target_dir: z.string().optional().describe("Render output directory"),
        filename: z.string().optional().describe("Output filename"),
        format: z.string().optional().describe("Render format"),
        codec: z.string().optional().describe("Render codec"),
        width: z.number().optional().describe("Output width"),
        height: z.number().optional().describe("Output height"),
        quality: z.any().optional().describe("Video quality"),
        export_video: z.boolean().optional().describe("Export video track"),
        export_audio: z.boolean().optional().describe("Export audio track"),
        job_id: z.string().optional().describe("Render job ID"),
        job_ids: z.array(z.string()).optional().describe("Render job IDs to start"),
        all: z.boolean().optional().describe("Apply to all"),
        file_path: z.string().optional().describe("File path for export"),
        export_type: z.string().optional().describe("Export type: AAF, EDL, FCPXML_1_10, CSV, OTIO, etc."),
        key: z.string().optional().describe("Settings key"),
        value: z.any().optional().describe("Settings value"),
        language: z.string().optional().describe("Language for subtitles/transcription"),
        node_index: z.number().optional().describe("Node index (1-based)"),
        lut_path: z.string().optional().describe("LUT file path"),
        target_clips: z.array(z.string()).optional().describe("Target clip names for grade copy"),
        preset: z.string().optional().describe("Quick export preset name"),
        path: z.string().optional().describe("Media storage path"),
    }),
}, async (params) => {
    const { action, ...rest } = params;
    const cleanParams = {};
    for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined && v !== null)
            cleanParams[k] = v;
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
                RESOLVE_SCRIPT_API: "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting",
                RESOLVE_SCRIPT_LIB: "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so",
                PYTHONPATH: "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/",
            },
        }).trim();
        const result = JSON.parse(raw);
        if (!result.ok)
            throw new Error(result.error || "Unknown bridge error");
        return text(JSON.stringify(result.data, null, 2));
    }
    catch (e) {
        return err(`DaVinci Resolve ${action}: ${e.message}`);
    }
});
// ════════════════════════════════════════════════════════════════
// STANDALONE TOOL — DEVONthink
// ════════════════════════════════════════════════════════════════
function runAppleScript(script) {
    return execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
    }).trim();
}
function escapeForAS(s) {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
server.registerTool("devonthink", {
    description: `Search and retrieve documents from DEVONthink.
Actions: search (full-text search), similar (find similar documents), read (get plain text by UUID), databases (list all).`,
    inputSchema: z.object({
        action: z.enum(["search", "similar", "read", "databases"]).describe("Action to perform"),
        query: z.string().optional().describe("Search query (supports AND, OR, NOT, NEAR, wildcards, phrase quotes)"),
        uuid: z.string().optional().describe("Document UUID (for read and similar)"),
        limit: z.number().optional().describe("Max results (default 20, max 50)"),
        database: z.string().optional().describe("Database name to search in (omit for all)"),
        content_length: z.number().optional().describe("Max chars of content per search result (default 200, 0 for metadata only)"),
    }),
}, async (params) => {
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
                const lines = result.split("\n").filter(l => l.trim()).map(l => {
                    const [name, count] = l.split(" ||| ");
                    return `- **${name}**: ${count} records`;
                });
                return text(lines.join("\n"));
            }
            case "search": {
                if (!query)
                    return err("Error: query is required for search action");
                const dbClause = database ? `in database "${escapeForAS(database)}"` : "";
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
    ${snippetLen > 0 ? `try
      set theText to plain text of rec
      if length of theText > ${snippetLen} then
        set snippet to text 1 thru ${snippetLen} of theText
      else
        set snippet to theText
      end if
    end try` : ""}
    set output to output & "<<RECORD>>" & recName & "<<F>>" & recType & "<<F>>" & recLoc & "<<F>>" & recUUID & "<<F>>" & (recDate as string) & "<<F>>" & recSize & "<<F>>" & recTags & "<<F>>" & snippet & linefeed
  end repeat
  return (totalCount as string) & "<<TOTAL>>" & output
end tell`;
                const raw = runAppleScript(script);
                const [totalPart, ...rest] = raw.split("<<TOTAL>>");
                const totalCount = parseInt(totalPart) || 0;
                const records = rest.join("<<TOTAL>>").split("<<RECORD>>").filter(r => r.trim());
                let output = `## DEVONthink Search: "${query}"\n`;
                output += `**${totalCount} total results** (showing ${Math.min(limit, totalCount)})\n\n`;
                for (const rec of records) {
                    const [name, type, location, recUuid, date, size, tags, snippet] = rec.split("<<F>>");
                    output += `### ${name?.trim()}\n`;
                    output += `- **Type:** ${type?.trim()} | **Location:** ${location?.trim()}\n`;
                    output += `- **UUID:** \`${recUuid?.trim()}\` | **Modified:** ${date?.trim()} | **Size:** ${size?.trim()} bytes\n`;
                    if (tags?.trim())
                        output += `- **Tags:** ${tags.trim()}\n`;
                    if (snippet?.trim())
                        output += `- **Preview:** ${snippet.trim().replace(/\n/g, " ").substring(0, snippetLen)}…\n`;
                    output += "\n";
                }
                return text(output);
            }
            case "similar": {
                if (!uuid)
                    return err("Error: uuid is required for similar action");
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
                const records2 = rest2.join("<<TOTAL>>").split("<<RECORD>>").filter(r => r.trim());
                let output = `## Documents Similar to: "${sourceName?.trim()}"\n`;
                output += `**${totalCount2} similar documents** (showing ${Math.min(limit, totalCount2)})\n\n`;
                for (let i = 0; i < records2.length; i++) {
                    const [name, type, location, recUuid, size] = records2[i].split("<<F>>");
                    output += `${i + 1}. **${name?.trim()}** (${type?.trim()})\n`;
                    output += `   Location: ${location?.trim()} | UUID: \`${recUuid?.trim()}\` | Size: ${size?.trim()} bytes\n`;
                }
                return text(output);
            }
            case "read": {
                if (!uuid)
                    return err("Error: uuid is required for read action");
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
                if (tags?.trim())
                    output += `- **Tags:** ${tags.trim()}\n`;
                output += `\n---\n\n${docText}`;
                return text(output);
            }
            default:
                return err(`Unknown action: ${action}`);
        }
    }
    catch (e) {
        return err(`DEVONthink error: ${e.message}`);
    }
});
// ════════════════════════════════════════════════════════════════
// STANDALONE TOOL — GitHub Issues (gh CLI)
// ════════════════════════════════════════════════════════════════
const GH_DEFAULT_REPO = "owner/repo";
const GH_TOKEN_PATH = resolve(homedir(), ".config", "gh-token");
function getGhToken() {
    if (process.env.GH_TOKEN)
        return process.env.GH_TOKEN;
    if (existsSync(GH_TOKEN_PATH))
        return readFileSync(GH_TOKEN_PATH, "utf-8").trim();
    throw new Error(`No GitHub token. Set GH_TOKEN env var or put token in ${GH_TOKEN_PATH}`);
}
function gh(args, repo) {
    const r = repo || GH_DEFAULT_REPO;
    const token = getGhToken();
    return execSync(`gh ${args} -R ${r}`, {
        encoding: "utf-8",
        timeout: 15000,
        env: { ...process.env, GH_TOKEN: token },
    }).trim();
}
server.registerTool("gh_issues", {
    description: `List GitHub issues. Defaults to owner/repo. Filter by state, assignee, labels.`,
    inputSchema: z.object({
        repo: z.string().optional().describe("owner/repo (default: owner/repo)"),
        state: z.string().optional().describe("open|closed|all (default: open)"),
        assignee: z.string().optional().describe("GitHub username filter"),
        labels: z.string().optional().describe("Comma-separated labels"),
        limit: z.number().optional().describe("Max results (default: 30)"),
    }),
}, async (params) => {
    const parts = ["issue list"];
    parts.push(`--state ${params.state || "open"}`);
    parts.push(`--limit ${params.limit || 30}`);
    if (params.assignee)
        parts.push(`--assignee ${params.assignee}`);
    if (params.labels)
        parts.push(`--label "${params.labels}"`);
    parts.push("--json number,title,state,assignees,labels,createdAt");
    parts.push(`--jq '.[] | "#\\(.number) [\\(.assignees | map(.login) | join(","))] \\(.title) (\\(.labels | map(.name) | join(",")))"'`);
    try {
        const result = gh(parts.join(" "), params.repo);
        return text(result || "No issues found.");
    }
    catch (e) {
        return err(`Error: ${e.message}`);
    }
});
server.registerTool("gh_issue_create", {
    description: `Create a GitHub issue. Returns the issue URL.`,
    inputSchema: z.object({
        title: z.string().describe("Issue title"),
        body: z.string().describe("Issue body (markdown)"),
        repo: z.string().optional().describe("owner/repo (default: owner/repo)"),
        assignee: z.string().optional().describe("GitHub username to assign"),
        labels: z.string().optional().describe("Comma-separated labels"),
    }),
}, async (params) => {
    const parts = ["issue create"];
    parts.push(`--title "${params.title.replace(/"/g, '\\"')}"`);
    parts.push(`--body "${params.body.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`);
    if (params.assignee)
        parts.push(`--assignee ${params.assignee}`);
    if (params.labels)
        parts.push(`--label "${params.labels}"`);
    try {
        const result = gh(parts.join(" "), params.repo);
        return text(result);
    }
    catch (e) {
        return err(`Error: ${e.message}`);
    }
});
server.registerTool("gh_issue_view", {
    description: `View a single GitHub issue with full body and comments.`,
    inputSchema: z.object({
        number: z.number().describe("Issue number"),
        repo: z.string().optional().describe("owner/repo (default: owner/repo)"),
    }),
}, async (params) => {
    try {
        const result = gh(`issue view ${params.number} --json number,title,state,body,assignees,labels,comments --jq '"#\\(.number) [\\(.state)] \\(.title)\\nAssigned: \\(.assignees | map(.login) | join(", "))\\nLabels: \\(.labels | map(.name) | join(", "))\\n\\n\\(.body)\\n\\n--- Comments (\\(.comments | length)) ---\\n\\(.comments | map("\\(.author.login): \\(.body)") | join("\\n\\n"))"'`, params.repo);
        return text(result);
    }
    catch (e) {
        return err(`Error: ${e.message}`);
    }
});
server.registerTool("gh_issue_edit", {
    description: `Edit a GitHub issue — change assignee, labels, title, or state.`,
    inputSchema: z.object({
        number: z.number().describe("Issue number"),
        repo: z.string().optional().describe("owner/repo (default: owner/repo)"),
        title: z.string().optional().describe("New title"),
        assignee: z.string().optional().describe("Set assignee"),
        add_labels: z.string().optional().describe("Comma-separated labels to add"),
        remove_labels: z.string().optional().describe("Comma-separated labels to remove"),
        state: z.string().optional().describe("open or closed"),
    }),
}, async (params) => {
    const results = [];
    if (params.state) {
        try {
            const cmd = params.state === "closed" ? "close" : "reopen";
            results.push(gh(`issue ${cmd} ${params.number}`, params.repo));
        }
        catch (e) {
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
        }
        catch (e) {
            results.push(`Edit error: ${e.message}`);
        }
    }
    return text(results.filter(Boolean).join("\n") || `Issue #${params.number} updated.`);
});
server.registerTool("gh_issue_comment", {
    description: `Add a comment to a GitHub issue.`,
    inputSchema: z.object({
        number: z.number().describe("Issue number"),
        body: z.string().describe("Comment body (markdown)"),
        repo: z.string().optional().describe("owner/repo (default: owner/repo)"),
    }),
}, async (params) => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpFile = `/tmp/gh-comment-${Date.now()}.md`;
    try {
        writeFileSync(tmpFile, params.body);
        const result = gh(`issue comment ${params.number} -F ${tmpFile}`, params.repo);
        return text(result || `Commented on #${params.number}.`);
    }
    catch (e) {
        return err(`Error: ${e.message}`);
    }
    finally {
        try {
            unlinkSync(tmpFile);
        }
        catch { }
    }
});
// ════════════════════════════════════════════════════════════════
// Connect and start
// ════════════════════════════════════════════════════════════════
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((e) => {
    process.stderr.write(`gc_mcp fatal: ${e.message}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map