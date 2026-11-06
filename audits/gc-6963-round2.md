# Audit: GC-6963 (gc_mcp) — round 2, fold delta

**Scope:** `gc/6963-schedule-workflow` @ `19e55b2` (`git show 19e55b2` — `src/index.ts`, `dist/index.js`, `dist/index.js.map`, `test/schedule-workflow-schema.mjs`). The commit after it (`caf6ea0`) is the round-1 report, report-only and not reviewed. Daemon reference: `gc_daemon` worktree `.worktrees/6963-scheduled-workflow` @ `c27dd7fb4` (fold `af8dba096` on top of `9860f50a5`).
**Date:** 2026-11-06
**Method:** read-only. Foreground shell and the Grep/Glob tools were unavailable this session (shell SIGKILL, ripgrep binary missing); survey via Read plus backgrounded `git`/`grep` writing to temp files. No source, test, config, or dist file modified. Only this report was written.

## Delta verified

- **`dist` equals a clean build of `src`.** Copied `src` + `tsconfig.json` + `package.json` to a temp dir, symlinked `node_modules`, ran `tsc` (exit 0), then `diff -r` against the committed `dist`: empty. SHA-256 identical for `dist/index.js` (`aa0f2c2d…`), `dist/index.d.ts` (`043fe77a…`) and `dist/index.js.map` (`9e6961e9…`). The committed `dist` is reproducible from the committed `src`.
- **The new test passes.** `node test/schedule-workflow-schema.mjs` → exit 0, `gc_schedule workflow action type verified.` The added assertions (bundled/child-only text, prompt-step model text, due-moment text, `/notify/` absence, `params`/`workflow` declared) all hold against the shipped `dist`.
- **Working tree clean** apart from this untracked report.

## Claim-by-claim against the daemon

| Description claim (`src/index.ts:3636-3647`, `:3707`) | Daemon evidence | Holds |
|---|---|---|
| `action_type "workflow"` runs the workflow directly, no agent/model added by the schedule; the workflow's own prompt/dispatch steps still call a model | `fire_workflow` → `start_workflow` → `Engine.run_async/3` (`scheduled_dispatch.ex:226-287`); prompt/dispatch/conversation steps call a provider (`stepwise_adapter.ex:10-11,154-196,215-260,351-437`) | yes |
| name from `~/.config/gc/workflows/` **or a bundled workflow**; user dir wins | `workflow_search_paths/0 = [workflow_dir(), bundled_workflow_dir()]` (`parser.ex:386-387`), `source/2` checks the user path first (`parser.ex:313-326`) | yes |
| must load at create time; **a child-only workflow is refused** | `check_workflow_loads/1` rejects `child_only: true` at create (`schedule_handler.ex:362-381`), `Parser.parse/1` at `:362-379` | yes |
| optional `params` (JSON object) | `encode_workflow_params/1` accepts map or JSON string (`schedule_handler.ex:348-360`) | yes |
| each fire starts one async execution | `run_async/3` persists one `running` row then enqueues one `WorkflowRun` (`engine.ex:152-170,266-310`) | yes |
| history records the execution id in place of a job id (`execution_id`) | `Map.put(entry, :execution_id, job_id)` when `action_type == "workflow"` (`schedule_handler.ex:143-145`); `log_fire` writes the id into `job_id` (`scheduled_dispatch.ex:1245-1264`) | yes |
| load failure at fire = one error row, schedule moves on, not retried every tick | `fire_workflow` `{:error, reason}` → `update_fired` + `log_fire` (`scheduled_dispatch.ex:241-248`) | yes |
| **transient start failure advances nothing, next tick retries** | `{:error, {:transient, reason}}` → `log_fire` only, no `update_fired` (`scheduled_dispatch.ex:234-239`); transient sources are `{:persist_failed, _}` (`:271-272`) and drain (`:290-295`) | yes |
| every run gives shell steps `GC_WORKFLOW_STATE_DIR` = the workflow's own state dir | `workflow_state_env/1` appended to the shell step's env (`stepwise_adapter.ex:966-969,1102-1118`), from `Paths.workflow_state_dir/1` (`paths.ex:129-134`) | yes |
| `fire` runs now through the same path, **a disabled schedule too**, writes a row (note `"manual"`) | `find_schedule/1` has no `enabled` filter (`scheduled_dispatch.ex:364-370`); `fire_manual` logs `"manual"` (`:346`) | yes |
| leaves `next_fire_at`/`last_fired_at`/`fire_count` alone, **except a schedule due at that moment counts as fired** | `fire_manual` calls `update_fired` only when `is_due?` (`scheduled_dispatch.ex:340-347`) | yes |
| `notify` gone from the action-type text | `@action_types = ["dispatch", "workflow"]` (`schedule_handler.ex:321`); no `notify` in the tool description | yes |

## Findings

### Finding 1 — NIT: the manual-fire rationale "so the next tick does not run it again" is inapplicable to the disabled schedules the same sentence advertises

**Severity:** NIT
**File:** `src/index.ts:3644-3647`

The description says `fire` also runs "a disabled schedule too" and that a schedule "that is due at that moment counts as fired so the next tick does not run it again". For a *disabled* schedule the tick never runs it (`find_due_schedules` filters `enabled = 1`, `scheduled_dispatch.ex:380`), so the stated purpose does not apply — yet the due-moment branch still fires: `is_due?/3` does not read `enabled` (`scheduled_dispatch.ex:468-475`) and `fire_manual` calls `update_fired` on any due schedule (`:344-345`). The observable result is that a disabled, overdue schedule's manual fire still increments `fire_count` and moves `last_fired_at`/`next_fire_at`, which reads against the same sentence's "it leaves next_fire_at, last_fired_at and fire_count alone". The behaviour matches the code (the "except" clause covers it), so this is a wording nit, not a mismatch.

**Remediation:** Optional. Either drop the trailing rationale ("so the next tick does not run it again") or scope it: "…counts as fired (which for an enabled schedule also stops the next tick re-running it)".

### Finding 2 — NIT: the transient parenthetical names only curable causes; the engine's `persist_failed` class is broader

**Severity:** NIT
**File:** `src/index.ts:3642-3643`

The description says "a transient start failure (busy workflow database, draining daemon) advances nothing and the next tick retries". That is exactly the daemon's classification, but the parenthetical is narrower than the class it annotates: `Engine.run_async/3` returns `{:error, {:persist_failed, reason}}` for *any* failure of the initial `running` INSERT — its own docstring names "write-locked DB, unwritable path, schema error" (`engine.ex:152-166,241-255`) — and `start_workflow/1` maps every `persist_failed` to `{:transient, …}` (`scheduled_dispatch.ex:271-272`). A permanently unwritable state path therefore retries every tick forever. The description does not claim the list is exhaustive, so it inherits rather than contradicts the daemon; the two examples are the curable ones.

**Remediation:** Optional. If the description is meant to be exhaustive, say "e.g." before the parenthetical. The durable fix is daemon-side (distinguish a curable `SQLITE_BUSY` from a permanent persist error), out of scope for this delta.

### Finding 3 — NIT: the tool-level text says `params` is "a JSON object" while the field text (and schema, and daemon) also accept a JSON string

**Severity:** NIT
**File:** `src/index.ts:3639` vs `src/index.ts:3716-3721`

The top-level copy reads "optional 'params' (a JSON object)"; the `params` property says "a JSON object (or its JSON string)", the zod union accepts `z.string()` (`:3717`), and the daemon decodes a JSON string (`schedule_handler.ex:352-357`). The added test asserts the string form is accepted (`test/schedule-workflow-schema.mjs:20-24`), so the copy under-describes what the boundary allows. Pre-existing phrasing; the delta touched this line but did not introduce the gap.

**Remediation:** Optional. Align the top-level line with the field: "(a JSON object or its JSON string)".

## Angles that check out

- **The two round-1 NITs are folded accurately.** "a bundled workflow" matches `workflow_search_paths/0`; the model wording now says the schedule adds no dispatch and that the workflow's own prompt/dispatch steps still call a model, matching `stepwise_adapter.ex:154-196` and `:215-260`.
- **`notify` removal is correct, not an over-correction.** `@action_types` is `["dispatch", "workflow"]`; a `notify` schedule would have run the ordinary dispatch path. The `assert.doesNotMatch(description, /notify/)` guard cannot false-positive on a legitimate future mention (`notifications` does not match `/notify/`).
- **`action_type` remains `z.string()`, not an enum.** Unknown values are rejected by the daemon at create (`schedule_handler.ex:327-329`), so the boundary is safe; the delta changed only the `.describe` text. Pre-existing and unchanged.
- **The `agent` fallback is undocumented but harmless.** The daemon accepts `params["workflow"] || params["agent"]` (`schedule_handler.ex:340`); the description names only `workflow`, the canonical field the schema also declares.
- **`assert.doesNotMatch` / regex assertions are wired into `npm test`** (`package.json:41`) and pass.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| Description assertions remain substring-only | Low | `test/schedule-workflow-schema.mjs:29-40` pins the prose but cannot detect later drift between the copy and the daemon; the behaviour itself is covered daemon-side by `test/gc_daemon/scheduled_workflow_test.exs`. Unchanged from round 1. |
| `params` tools/list shape not asserted here | Low | Still covered indirectly by `test/strict-params.mjs` and `test/tools-list-no-refs.mjs`. Unchanged from round 1. |

## Sign-off

**Blockers that should not have shipped:** None. Every specific claim in the folded description matches the daemon source, `dist` is a byte-identical clean build of `src`, and the new test passes.

**Recommended next step:** commit (land as-is). The three NITs are optional wording refinements; none affects the contract or the shipped behaviour.

VERDICT: PASS

AUDIT COMPLETE
