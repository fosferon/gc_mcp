# Audit: gc_mcp round 3 — gc_workflow children field list gains created_at

**Scope:** commit `da0c2dd93a42cc235526184473eb2cb39d010559` (worktree `6907-include-child-only`)
**Date:** 2026-11-05

## Verification performed

1. **Diff shape** — `git show HEAD` is a three-file, one-line-each change:
   - `src/index.ts:3698` (gc_workflow tool description) — children field list gains `created_at`.
   - `test/include-child-only.mjs:27` — the corresponding regex assertion updated.
   - `dist/index.js:3079` — rebuilt bundle line.
   No other source, test, or config file was touched; nothing else in `src/` was modified.

2. **dist is exactly tsc output** — rebuilt with `npx tsc --outDir /tmp/gc6907-tsc-fresh` (fresh directory under /tmp; nothing written to `dist/`): `diff` reports `dist/index.js` identical to the fresh compiler output. The committed bundle is clean tsc output.

3. **Field list matches the daemon** — `/Users/leonidas/Sites/ex_libs/gc_daemon/.worktrees/6651-s2-children-list/lib/gc_daemon/workflow/delegations.ex:131-136`: `workflow_children/2` selects `d.child_id`, `COALESCE(e.workflow, ...)`, `d.caller_step`, `e.status`, `d.created_at` and returns the map `%{child_id: id, workflow: workflow, step: step, status: status, created_at: created_at}`. The tool description now reads `[{ child_id, workflow, step, status, created_at }]` — key set, order, and nil-safety note (`status`/`workflow` may be nil if the executions row is gone) all match the SQL and the @doc.

4. **No stale references** — `grep` for the old field list (`child_id, workflow, step, status` without `created_at`) across `src/` and `test/` returns zero hits; the only `children` mention in the gc_workflow description is the updated line at `src/index.ts:3701`.

5. **Test run** — `node test/include-child-only.mjs` passes: `gc_workflow include_child_only schema verified.` The test asserts against the registered `gc_workflow` tool description loaded from `dist/index.js`, so it validates the shipped bundle, not just the source.

## Findings

None. The commit is a pure documentation/schema-text fold: single line in the tool description, matching daemon contract, rebuilt dist verified byte-identical to tsc output, test updated and green.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| None new | — | The existing test covers the changed assertion; no behavioral code changed, so no new coverage is warranted. |

## Sign-off

**Blockers that should not have shipped:** None
**Recommended next step:** commit is ready as-is; proceed to fold/merge per the GC-6907 pipeline.

VERDICT: PASS

AUDIT COMPLETE. STOP.
