# Audit: GC-6963 (gc_mcp) — round 3, fold delta

**Scope:** `gc/6963-schedule-workflow` @ `e707ac2` (`git show e707ac2`). The commit touches `src/index.ts` (3 lines of `gc_schedule` description), `dist/index.js` (matching 3 lines), `test/schedule-workflow-schema.mjs` (one assertion tightened, two added), and adds the round-2 report `audits/gc-6963-round2.md` (report-only). The three folds under audit are exactly the three NITs from `audits/gc-6963-round2.md`.
**Daemon reference:** `gc_daemon` worktree `.worktrees/6963-scheduled-workflow` @ `c7324501b` (round-2 fold) on top of `c27dd7fb4`. Round 2 cited `c27dd7fb4`; the daemon has since advanced by one commit (`c7324501b` — a `handler_tools.ex` drain-refusal mapping plus daemon tests, no change to the `gc_schedule` contract).
**Date:** 2026-11-06
**Method:** read-only. Foreground shell and the Grep/Glob tools were unavailable this session (shell SIGKILL, ripgrep binary missing), as in round 2; survey via Read plus backgrounded `git`/`grep`/`tsc` writing to temp files. No source, test, config, or dist file was modified. Only this report was written.

## Findings

### Finding 1 — None (verified): the due-moment fold is accurate against the daemon

**Severity:** None (verified)
**File:** `src/index.ts:3646-3647`

The old text ended "…counts as fired so the next tick does not run it again."; the folded text is "…counts as fired (for an enabled schedule that also stops the next tick re-running it)." The daemon scopes the tick to enabled schedules only — `find_due_schedules/0` queries `WHERE enabled = 1 AND trigger_type IN ('cron','interval','once')` (`scheduled_dispatch.ex:380`) — while `fire_manual` still advances a due schedule regardless of enabled: `is_due?/3` reads no `enabled` flag (`scheduled_dispatch.ex:468-475`) and `fire_manual` calls `update_fired(schedule)` whenever `is_due?` holds (`scheduled_dispatch.ex:344-345`). The parenthetical therefore attributes the "next tick" effect to the enabled case, where it actually materializes, and leaves the plain "counts as fired" statement true for the disabled case the same sentence advertises. Accurate.

**Remediation:** None.

---

### Finding 2 — None (verified): the transient-causes fold is accurate against the daemon

**Severity:** None (verified)
**File:** `src/index.ts:3642-3643`

The old text read "(busy workflow database, draining daemon)"; the folded text reads "(e.g. a busy workflow database, a draining daemon)". The daemon's transient class is broader than those two examples: `start_workflow/1` maps every `{:error, {:persist_failed, reason}}` to `{:error, {:transient, …}}` (`scheduled_dispatch.ex:271-272`), and `Engine.run_async/3` returns `persist_failed` for any failure of the initial `running` INSERT — its docstring names "write-locked DB, unwritable path, schema error" (`engine.ex:152-166,241-255`) — plus drain returns `{:error, {:transient, "daemon is draining"}}` (`scheduled_dispatch.ex:290-295`). The `e.g.` marks the two examples non-exhaustive, so the copy no longer implies the list is complete. Accurate.

**Residual (out of delta scope, no daemon change in this delta):** a *permanent* persist error (unwritable path, schema error) is still classified transient and so retries every tick. That is a daemon-side classification, unchanged by `e707ac2`; the `e.g.` fold removes the copy's over-claim without touching the behaviour. Same residual as round-2 Finding 2.

**Remediation:** None for this delta.

---

### Finding 3 — None (verified): the `params` string-form fold is accurate against the daemon

**Severity:** None (verified)
**File:** `src/index.ts:3639` (vs `:3716-3721`)

The top-level copy now reads "optional 'params' (a JSON object or its JSON string)", matching the `params` property's own text "a JSON object (or its JSON string)" (`src/index.ts:3719-3721`), the zod union `z.union([z.record(z.string(), z.unknown()), z.string()])` (`src/index.ts:3717`), and the daemon, whose `encode_workflow_params/1` accepts a map or a JSON string that decodes to a map (`schedule_handler.ex:348-357`). Accurate.

**Remediation:** None.

---

### Finding 4 — None (verified): the three new/tightened test regexes match the shipped description

**Severity:** None (verified)
**File:** `test/schedule-workflow-schema.mjs:31-33`

Each added pattern matches the folded `src/index.ts` text (and therefore `dist`):
- `/a schedule that is due at that\s+moment counts as fired \(for an enabled schedule that also stops the next tick/` ↔ `src/index.ts:3646-3647` ("…counts as fired (for an enabled schedule that also stops the next tick re-running it).").
- `/e\.g\. a busy\s+workflow database, a draining daemon/` ↔ `src/index.ts:3642-3643` ("…(e.g. a busy\nworkflow database, a draining daemon)…").
- `/'params' \(a JSON object or its JSON string\)/` ↔ `src/index.ts:3639`.

The `\s+` spans are the line-wrap newlines in the template literal; the patterns are single-line safe. The assertion was tightened in place (the old `/…counts as fired/` became the longer form), so no stale duplicate remains.

**Remediation:** None.

---

### Finding 5 — None (verified): `dist` equals a clean out-of-tree build of `src`

**Severity:** None (verified)
**File:** `dist/index.js`, `dist/index.d.ts`, `dist/index.js.map`

Copied `src` + `tsconfig.json` + `package.json` to a fresh temp dir, symlinked the repo `node_modules`, ran `tsc` (exit 0), then `diff -r` against the committed `dist`: empty (`DIFF_EXIT=0`). SHA-256 of the committed files: `dist/index.js` `a5ae1d9f…`, `dist/index.d.ts` `043fe77a…`, `dist/index.js.map` `9e6961e9…`. `index.d.ts` and `index.js.map` are unchanged from round 2 (`043fe77a…`, `9e6961e9…`); `index.js` changed (`aa0f2c2d…` → `a5ae1d9f…`), as expected from the three description-line edits. The committed `dist` is reproducible from the committed `src`.

`node test/schedule-workflow-schema.mjs` → exit 0, `gc_schedule workflow action type verified.`

**Remediation:** None.

---

## Angles that check out

- **All three round-2 NITs are folded, and only those.** The delta's source change is the three wording edits; no behavioural change to the schema, the description's other clauses, or `action_type` handling.
- **The daemon advance does not disturb the copy.** `c7324501b` adds a `{:error, :draining, payload}` clause to the MCP `call_handler` (`agent_tools/handler_tools.ex:1690-1697` area) and daemon-side tests; the `gc_schedule` contract and the `"manual"` note are untouched (`schedule_handler.ex:159-176`, `scheduled_dispatch.ex:346`).
- **The manual-fire claim still holds.** `find_schedule/1` has no `enabled` filter (`scheduled_dispatch.ex:364-370`), `fire_manual` logs note `"manual"` (`:346`), and the fire action is drain-gated at the handler (`schedule_handler.ex:160`), consistent with "a draining daemon" being a transient refusal.
- **No `notify` reintroduced.** `@action_types` remains `["dispatch", "workflow"]` (`schedule_handler.ex:321`); the description still contains no `notify`, and the `assert.doesNotMatch(description, /notify/)` guard passes.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| Description assertions remain substring-only | Low | `test/schedule-workflow-schema.mjs` pins prose but cannot detect later drift between the copy and the daemon; behaviour is covered daemon-side by `test/gc_daemon/scheduled_workflow_test.exs` (extended in `c7324501b`). Unchanged from rounds 1–2. |
| `params` tools/list shape not asserted here | Low | Covered indirectly by `test/strict-params.mjs` and `test/tools-list-no-refs.mjs`. Unchanged from rounds 1–2. |

## Sign-off

**Blockers that should not have shipped:** None. The three wording folds match the daemon source at `c7324501b`, the new test regexes match the shipped description, and `dist` is a byte-identical clean build of `src` with the new test passing.

**Recommended next step:** commit (land as-is).

VERDICT: PASS

AUDIT COMPLETE
