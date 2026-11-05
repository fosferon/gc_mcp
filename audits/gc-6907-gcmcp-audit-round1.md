# Audit: gc_mcp S2 — advertise `include_child_only` / `children` (GC-6907)

**Scope:** commit `1e6ecd6` on branch `gc/6907-include-child-only` (base `fa68b1b`), gc_mcp worktree `.worktrees/6907-include-child-only`. Cross-checked against daemon worktree `.worktrees/6651-s2-children-list` (`git diff f6e890620..HEAD`).
**Date:** 2026-11-05

## Checks walked

1. **Schema placement and shape** — The new entry is at `src/index.ts:3943-3947`, inside the `registerTool("gc_workflow", …)` call that opens at `src/index.ts:3688` (schema object starts at `src/index.ts:3806`, closes at `src/index.ts:3965`). Not leaked into any other tool. It uses the shared `zBoolean()` helper (`src/index.ts:544-549`), which accepts `true/false` booleans and `"true"/"false"` string literals (transformed to real booleans before forwarding, so the daemon's `truthy?/2` receives proper booleans). The daemon-side `list_workflows` allow-list includes `include_child_only` (`lib/gc_daemon/api/workflow_handler.ex:1936`), so the flag is not stripped by the daemon either.
2. **Description accuracy vs daemon behaviour** — `src/index.ts:3695-3698` says child-only workflows are hidden by default, `include_child_only: true` lists them flagged `child_only`. The daemon does exactly that in `hide_child_only/2` (`workflow_handler.ex:1197-1204`) with the flag set by `put_child_only/2` (`workflow_handler.ex:1183-1194`). The param description at `src/index.ts:3945-3947` ("started by a protected parent, not run directly; default false") matches the daemon's own advertised text (`handler_tools.ex:1084-1088`). The `children` note at `src/index.ts:3702` documents `{ child_id, workflow, step, status }`; `Delegations.workflow_children/2` (`delegations.ex:116-144`) returns exactly those keys plus `created_at`, and joins `workflow` from the executions row with a JSON-extract fallback — the documented subset is accurate.
3. **dist/ is exact tsc output** — Rebuilt with `npx tsc --outDir /tmp/gc6907-audit-build` (scratch dir, since deleted). `diff` of `index.js` against `dist/index.js`: byte-identical. `index.d.ts`: identical. `index.js.map`: `mappings`, `names`, and all other keys identical; the only difference is the `sources` path (`../../Users/…/src/index.ts` vs `../src/index.ts`), which is an artifact of the different outDir and confirms the checked-in map was produced by the normal `dist` build.
4. **Test discrimination** — `test/include-child-only.mjs` would fail on master's src: the strict root wrapper (`strictRootInputSchema`, `src/index.ts:612`, applied at `src/index.ts:724-733`) rejects unrecognized keys, so on master `safeParse({action:"list_workflows", include_child_only:true})` fails the first assertion (line 17-18). The negative assertions (line 20-24) additionally pin the strict boundary, so the test cannot pass by merely loosening the schema. Ran it against the committed dist: passes. Also ran `test/strict-params.mjs`: passes (72 tools verified). `package.json:41` chains the new test last in the `test` script, after `npm run build`, consistent with the existing convention.
5. **Other files that could list gc_workflow params** — `README.md` documents no tool params (no match for `gc_workflow`/`list_workflows`); `test/tools-list-no-refs.mjs` only asserts absence of `$ref` in schemas and does not snapshot param lists; no fixtures or tools-list snapshots in the repo. Nothing missed.

## Findings

### Finding 1 — MINOR: `children` documented only under the `show` bullet, but daemon adds it to `detail` too

**Severity:** 🟡 MINOR
**File:** `src/index.ts:3701-3703`

**Analysis:** The daemon's S2 slice puts `children` on both the `show` response base map (`workflow_handler.ex:340`) and the `detail` response map (`workflow_handler.ex:516`). The gc_mcp tool description inserts the `children: [{ child_id, workflow, step, status }]` sentence inside the `show` bullet only. An agent reading the `detail` bullet will not know the field is present there. This is under-documentation, not a contract break — the field simply appears unadvertised.

**Specific references:**
- `src/index.ts:3701-3703` (children note under show)
- `lib/gc_daemon/api/workflow_handler.ex:340` (show base carries children)
- `lib/gc_daemon/api/workflow_handler.ex:516` (detail response carries children)

**Remediation:** Move the `children` sentence out of the `show` bullet to a standalone line covering "show and detail responses", e.g. "A parent run's response (show, detail) carries children: […]".

---

### Finding 2 — NIT: description omits the explicit-`select` escape hatch

**Severity:** 🟢 NIT
**File:** `src/index.ts:3943-3947`

**Analysis:** `hide_child_only/2` (`workflow_handler.ex:1197-1204`) returns all rows unfiltered when `shape_mode(params)` is `{:select, _}` — an explicit `select: "name"` by name always returns a child-only workflow even without `include_child_only: true`. The MCP description doesn't mention this, so a model that knows a child workflow's name may pass `include_child_only: true` unnecessarily (harmless) or, worse, may conclude a named child workflow is unreachable. Low impact; optional to document.

**Remediation:** Append to the description: "An explicit select by name always returns a child-only workflow."

---

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| None blocking | — | The new test covers accept (4 forms), reject (non-boolean), strict rejection (misspelling), and description substrings. No behavioural gap for a schema-only change. |

## Sign-off

**Blockers that should not have shipped:** None.
**Recommended next step:** Commit is clean as-is; optionally fold the two doc nits into a follow-up rather than re-spinning this commit.

VERDICT: PASS

AUDIT COMPLETE. STOP.
