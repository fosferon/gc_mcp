# Audit: GC-6963 (gc_mcp) — gc_schedule workflow action type

**Scope:** `gc/6963-schedule-workflow` @ `3b66b79`, `git diff master...HEAD` (src/index.ts, package.json, dist/index.js, dist/index.js.map, test/schedule-workflow-schema.mjs). Daemon reference: `gc_daemon` worktree `.worktrees/6963-scheduled-workflow` @ `9860f50a5` (branch `gc/6963-scheduled-workflow`).
**Date:** 2026-11-05

## What I verified

- **Schema correctness.** `params: z.union([z.record(z.string(), z.unknown()), z.string()])` (src/index.ts:3712-3717) behaves as intended on the installed stack (zod 3.25.76, SDK 1.32.1). A direct probe of the union accepts object, `{}`, nested object, JSON string, and empty string; it rejects number, array, null, and boolean. So a malformed `params: 5` is stopped at the MCP boundary (asserted by the new test), and an array cannot slip through the record branch.
- **Strict root for gc_schedule.** `strictRootInputSchema` rebuilds the root `z.object` with `unknownKeys: "strict"` (src/index.ts:612-683) and is applied to every tool at registration (src/index.ts:725-733). `test/strict-params.mjs` walks every registered tool (gc_schedule included) and asserts an undeclared root key is rejected with a diagnostic naming it — passes.
- **tools/list without `$ref`.** `test/tools-list-no-refs.mjs` visits the whole tools/list result recursively and found no `$ref`; it reported 65 tools. The union compiles to `anyOf`, not a `$ref`.
- **Description vs daemon behaviour.** Every specific claim checks out against the daemon source:
  - execution id in history — `schedule_handler.ex:144` adds `execution_id: job_id` when `action_type == "workflow"`, and `scheduled_dispatch.ex:222` writes the execution id into the `job_id` column (`log_fire(schedule, execution_id, "ok")`).
  - a failed workflow fire advances the schedule — `scheduled_dispatch.ex:224-230` calls `update_fired(schedule)` on both the success and the error branch, so the schedule re-arms by its own cron/interval.
  - manual fire writes a row and leaves the clock alone — `scheduled_dispatch.ex:289-304` logs with note `"manual"` and never calls `update_fired`; `next_fire_at`, `last_fired_at`, `fire_count` are untouched. `schedule_handler.ex:159-177` returns `execution_id` for a workflow fire.
  - `GC_WORKFLOW_STATE_DIR` — set for shell steps at `stepwise_adapter.ex:1098-1105` from `paths.ex:129-134` (`<data_dir>/workflow_state/<workflow>/`).
  - "must load at create time" — `schedule_handler.ex:339-346,362-376` calls `Parser.parse/1` during create and refuses a name that does not load.
- **dist matches a clean build.** I copied the tree (excluding node_modules/.git/dist) to a temp dir, symlinked node_modules, ran `tsc` (exit 0), and diffed: `dist/index.js`, `dist/index.d.ts`, and `dist/index.js.map` are all byte-identical to the committed artifacts. The source map's `sources`/`mappings` match, so the committed dist is reproducible from the committed src.
- **Test is meaningful.** `test/schedule-workflow-schema.mjs` asserts the schema accepts an object `params` and a JSON-string `params`, rejects a numeric `params`, and that the description advertises the workflow action type, the execution id, `GC_WORKFLOW_STATE_DIR`, and the manual-fire behaviour. It is wired into `npm test` (package.json:41).

Checks run: `node test/schedule-workflow-schema.mjs`, `node test/tools-list-no-refs.mjs`, `node test/strict-params.mjs` — all exit 0. I did not run the full `npm test` (it starts with `npm run build`, which would rewrite `dist`; I verified dist by an out-of-tree clean build instead). No source, test, config, or dist file was modified.

## Findings

### Finding 1 — NIT: the workflow-name source omits the bundled workflows directory

**Severity:** NIT
**File:** `src/index.ts:3636-3638`

The description tells the operator the name is "a name from `~/.config/gc/workflows/`". The daemon resolves names from two directories: the live workflows dir (`~/.config/gc/workflows`) and the bundled `priv/workflows` (`parser.ex:387` — `workflow_search_paths/0` returns `[workflow_dir(), bundled_workflow_dir()]`, user-configured taking precedence). A bundled workflow name is therefore also valid and loadable.

This is not a divergence from the daemon contract in the sense of breaking a caller — it is an incomplete description, and it matches the phrasing already used by the pre-existing `gc_workflow` tool (src/index.ts:3777) and the daemon's own onboarding doc. The change neither introduces nor worsens the inaccuracy; it simply repeats the existing convention.

**Remediation:** Optional. If you want the description to be exact, say "a name from `~/.config/gc/workflows/` (or a bundled workflow)". Otherwise leave as-is for consistency with `gc_workflow`.

### Finding 2 — NIT: "no model in the path" is true of the schedule path but can mislead about the workflow body

**Severity:** NIT
**File:** `src/index.ts:3636-3638`

The description says `action_type "workflow"` "runs a workflow with no model in the path". This is accurate about what the *schedule* does: it starts a workflow execution directly and does not spawn a model-bearing agent. But a workflow body can contain `prompt`, `dispatch`, or `conversation` steps, and those do call a model (`stepwise_adapter.ex:10-11,156-196` drives prompt steps through a CLI/LLM provider). An operator scheduling a workflow with a `prompt` step should not read "no model" as "costs nothing".

The daemon uses the same phrasing in its own code comment (`scheduled_dispatch.ex:171`, "no model anywhere in the path") and onboarding doc, so the MCP description mirrors the daemon framing rather than inventing a claim. Low confidence this needs changing.

**Remediation:** Optional. If tightening, phrase it as "runs a workflow directly, with no agent/model dispatch added by the schedule; a workflow's own prompt/dispatch steps still call a model."

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| Description assertions are substring-only | Low | `test/schedule-workflow-schema.mjs:29-32` regex-matches description prose. It cannot catch a description that becomes inaccurate later (e.g. the manual-fire or state-dir claims drifting from the daemon). The daemon-side behaviour is covered by the daemon branch's `test/gc_daemon/scheduled_workflow_test.exs`; this MCP test only pins the text. |
| No tools/list shape assertion for `params` | Low | The new test never inspects the advertised `params` schema. It is covered indirectly — `test/strict-params.mjs:138-158` asserts every tool's tools/list properties match its registered shape, and `test/tools-list-no-refs.mjs` asserts no `$ref` — so the marginal value of adding it here is small. |

## Sign-off

**Blockers that should not have shipped:** None.

**Recommended next step:** commit (land as-is). The two NITs are optional wording refinements; neither affects the contract or the shipped behaviour.

VERDICT: PASS

AUDIT COMPLETE
