# Audit: gc_mcp S2 audit fold — round 1 findings folded into `4a6683d` (GC-6907)

**Scope:** commit `4a6683d` on branch `gc/6907-include-child-only` (fold of `audits/gc-6907-gcmcp-audit-round1.md` findings 1 and 2). gc_mcp worktree `.worktrees/6907-include-child-only`; daemon cross-check against `.worktrees/6651-s2-children-list`.
**Date:** 2026-11-05

## Checks walked

1. **Description text changes are exactly the two round-1 remediations** — `git show 4a6683d` touches 3 files with 6 insertions / 5 deletions. In `src/index.ts:3694-3701` (gc_workflow description): (a) the children sentence under the `show` bullet changed from "A parent run's response carries children" to "A parent run's show and detail responses carry children: [{ child_id, workflow, step, status }]" — round-1 finding 1's remediation, applied verbatim as suggested; (b) the `list_workflows` bullet gained "An explicit select by name always returns a child-only workflow." — round-1 finding 2's remediation, applied verbatim. No other description text, schema, or code changed.

2. **Test asserts both** — `test/include-child-only.mjs:27-28` replaces the single children regex with two assertions: `/show and detail responses carry children: \[\{ child_id, workflow, step, status \}\]/` and `/explicit select by name always returns a child-only workflow/`. Both match the exact new strings in the description, so the test pins both folded changes, not just one. Ran `node test/include-child-only.mjs` against the committed dist: **passes** ("gc_workflow include_child_only schema verified.").

3. **dist is exact tsc output** — Rebuilt with `npx tsc --outDir /tmp/gc6907-r2-build` (fresh scratch dir, deleted after; nothing written to `dist/`). `diff` results: `index.js` byte-identical, `index.d.ts` byte-identical. `index.js.map` differs only in the `sources` path (`../../Users/…/src/index.ts` vs `../src/index.ts`) — the known outDir artifact, confirms the checked-in map came from the normal `dist` build. Scratch dir removed.

4. **Claims match the daemon** — In `.worktrees/6651-s2-children-list`:
   - `hide_child_only/2` (`lib/gc_daemon/api/workflow_handler.ex:1197-1204`) returns rows unfiltered when `shape_mode(params)` matches `{:select, _}`, exactly the "explicit select by name always returns a child-only workflow" escape hatch now documented. The daemon's own comment at `workflow_handler.ex:1185-1186` states the same rule.
   - `children` is carried by both response paths: the `show` base map (`workflow_handler.ex:340`) and the `detail` response map (`workflow_handler.ex:516`) both call `Delegations.workflow_children/2`; the new "show and detail responses" wording is accurate (round 1 verified the key subset `{child_id, workflow, step, status}` against `delegations.ex:116-144`).
   - No drift between daemon worktree HEAD and what round 1 audited (same commit range `f6e890620..HEAD` still contains these lines unchanged).

## Findings

No findings. Both round-1 findings were folded exactly as recommended, the test was extended to pin both changes (not silently weakened — the old children regex was replaced, not deleted, so coverage did not shrink), dist is provably the compiler output of src, and both doc claims hold against daemon behaviour.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| None | — | The test covers schema accept/reject plus both new description substrings; the description claims are cross-verified here against daemon source, which a unit test cannot do. |

## Sign-off

**Blockers that should not have shipped:** None.
**Recommended next step:** Ship. Round-1 audit closed; no follow-up needed.

VERDICT: PASS

AUDIT COMPLETE. STOP.
