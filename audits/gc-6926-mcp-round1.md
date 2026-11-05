# Audit: gc_mcp GC-6926 — gc_dispatch explain_route / availability / call_profile / idempotency_key (round 1)

**Scope:** branch `gc/6926-mcp-dispatch-actions`, commit `568a7b7` on master `59bbd91`.
Files: `src/index.ts`, `test/dispatch-explain-availability-schema.mjs` (new), `package.json`.
Cross-read: daemon worktree `~/Sites/ex_libs/gc_daemon/.worktrees/6926-availability-ledger`
(`lib/gc_daemon/api/dispatch_handler.ex`, `lib/gc_daemon/dispatch/availability_ledger.ex`,
`lib/gc_daemon/dispatch/route_explain.ex`, `lib/gc_daemon/api/router.ex`), and sibling branch
`gc/6928-no-default-timeouts` @ `7eb6676` (worktree `6928-no-default-timeouts`).
**Date:** 2026-11-05

**Method / limitation.** Shell execution is unavailable in this sandbox: every `Execute`
call was killed with SIGKILL (including a bare `echo hi`). I therefore could not run
`git diff`, `git log`, `npm test`, or `tsc`. Everything below comes from reading files
directly in both worktrees with the file tools, plus the supplied
`audits/gc-6926-mcp-diff.patch`. I verified by reading that this worktree's committed
`dist/index.js` already contains the new schema (so the new test's `../dist/index.js`
import will see it). No test was executed; the test-chain analysis is a static reading.

**Verdict in one line:** the MCP schema matches the daemon contract — every new param name,
enum value, required field and error shape lines up, the description claims nothing the
daemon does not do, and the diff is confined to the enum, schema and description text.
Findings are all LOW/nits.

## Parity check (no findings — stated for the record)

| Daemon reads (dispatch_handler.ex) | MCP declares (src/index.ts) | Match |
|---|---|---|
| `explain_route` + `agent` (required, binary) | `action` enum + `agent` | ✅ |
| `explain_route` opts `provider`, `model`, `call_profile`, `task` (accepted, unused) | all declared | ✅ |
| `availability` `clear`, `set`, `retry_at`, `state`, `reason` | all declared, same names | ✅ |
| `parse_call_profile`: `worker` \| `completion` | `z.enum(["worker","completion"])` | ✅ |
| `availability_state`: `quota` \| `auth_failed` \| `containment_denied` \| `unhealthy` | `z.enum([...])` identical | ✅ |
| `retry_at` future rule (`handle_call({:set,...})`, `retry_at <= now -> :error`) | describe "Must be in the future." | ✅ |
| `idempotency_key` dedup on agent/task_sha/call_profile; different request → 409 `idempotency_key_reused` (router.ex:814-816) | describe says same, names 409 `idempotency_key_reused` | ✅ |
| completion refusal → `call_profile_unsupported` before any job | describe "refused for a route with no completion recipe" | ✅ |
| `availability` no-arg → `Ledger.snapshot()` entries carry `state, reason, source, retry_at` (availability_ledger.ex:429-445) | describe "lists the entries (state, reason, source, retry_at)" | ✅ |

`state` default `quota` (`availability_state(nil)`, dispatch_handler.ex:3373) matches the
describe "(default quota)". `clear`/`set`/`state`/`retry_at` are not read by any other
gc_dispatch action, so the new root params cannot collide with existing behaviour.

## Findings

### Finding 1 — 🟢 LOW: daemon's `metadata` dispatch param is not exposed

**Severity:** 🟢 Low
**File:** `src/index.ts:3402-3573` (schema), daemon `lib/gc_daemon/api/dispatch_handler.ex:617,672-690`

**Analysis:** GC-6899 added three dispatch extras. The MCP tool exposes two of them
(`call_profile`, `idempotency_key`) and omits the third. The daemon reads `metadata`,
records it on the job (`maybe_add(:metadata, ...)` at dispatch_handler.ex:617) and validates
it (`invalid_metadata`, non-map or >16 KiB, dispatch_handler.ex:683-690). Because the MCP
root schema is strict (see "Verified checks"), an agent passing `metadata` is refused with
"Unsupported top-level MCP parameter(s)…" rather than silently ignored, so there is no data
loss — but the capability is unreachable through the MCP tool, which is the only dispatch
path agents have.

**Specific references:**
- `src/index.ts:3423-3456` (the three GC-6899 fields that *are* exposed)
- `lib/gc_daemon/api/dispatch_handler.ex:38,45-46` (moduledoc), `:617` (recorded), `:683-690` (validated)

**Remediation:** add `metadata: z.record(z.any()).optional().describe("dispatch: a JSON object (≤16 KiB) recorded on the job")`
to the gc_dispatch schema, or state explicitly that metadata is intentionally not exposed.
Not a blocker: nothing in this change depends on it.

---

### Finding 2 — 🟢 LOW: `clear` describe under-states what a model-scoped clear removes

**Severity:** 🟢 Low
**File:** `src/index.ts:3435-3440`

**Analysis:** The MCP describe says a bare provider also drops its model entries, and stops
there. The daemon's `clear` (`handle_call({:success, provider, model, :force})`,
availability_ledger.ex:311-319) deletes both `{provider, model}` and `{provider, nil}`, so
clearing `"kimi/kimi-code"` *also* forgets the provider-wide `"kimi"` entry — the opposite
direction from the one documented. An agent clearing one model could silently drop a
provider-wide entry it did not mean to touch. The documented claim is not false, just
incomplete in the direction that surprises.

**Specific references:**
- `src/index.ts:3439` (the describe)
- `lib/gc_daemon/dispatch/availability_ledger.ex:116-121` (doc), `:311-319` (implementation)

**Remediation:** extend the describe, e.g. '…; a bare provider drops its model entries, and a
model also drops the provider-wide entry.'

---

### Finding 3 — 🟢 LOW: `idempotency_key` schema accepts `""`, which the daemon 400s

**Severity:** 🟢 Low
**File:** `src/index.ts:3429-3434`

**Analysis:** `z.string()` accepts the empty string, but the daemon requires a non-empty
string (`validate_request_extras`, dispatch_handler.ex:676-681 → 400 `invalid_idempotency_key`).
So `idempotency_key: ""` passes MCP validation and then fails at the daemon with a 400. Loud
failure, not silent corruption, but the schema could reject it at the boundary the way
`zTimeout`/`zBoolean` do elsewhere in this file.

**Specific references:**
- `src/index.ts:3429-3434`
- `lib/gc_daemon/api/dispatch_handler.ex:678-681`

**Remediation:** `z.string().min(1).optional()`.

---

### Finding 4 — 🟢 LOW: `agent` / `provider` / `model` describes do not mention `explain_route`

**Severity:** 🟢 Low
**File:** `src/index.ts:3461-3464, 3480-3485, 3486-3491`

**Analysis:** `explain_route` requires `agent` and honours `provider`/`model` overrides, but
the reused describes still only name dispatch/list/resolve_dispatch. `agent` says
"(required for dispatch)" — an agent may read that as "optional for explain_route" and omit
it, then get the daemon's `missing required field: agent`. Pure doc drift, no behaviour.

**Specific references:**
- `src/index.ts:3464` (agent), `:3484` (provider), `:3490` (model)
- `lib/gc_daemon/api/dispatch_handler.ex:253-269` (explain_route handlers)

**Remediation:** add "or explain_route" to the `agent`/`provider`/`model` describes.

---

### Finding 5 — 🟢 LOW: "the same function a dispatch uses" is loose for `explain_route`'s `candidates`

**Severity:** 🟢 Low
**File:** `src/index.ts:3367`

**Analysis:** The action-list line says explain_route is "the same function a dispatch uses".
The *decision* is (`Core.legacy_route/4`), and the daemon's own comment says so
(dispatch_handler.ex:250-252). But RouteExplain's moduledoc is explicit that `candidates`
probes **every** configured route (`evaluate_all`), including routes a dispatch would never
reach, "so an explain does more availability checks" (route_explain.ex:38-39). An agent
using explain_route to predict a dispatch's routing will usually be right, but the two are
not identical. The daemon's own comment already scopes the claim to the decision, so this is
a precision nit, not an inaccuracy.

**Specific references:**
- `src/index.ts:3367`
- `lib/gc_daemon/dispatch/route_explain.ex:38-39`, `lib/gc_daemon/api/dispatch_handler.ex:245-252`

**Remediation:** optionally qualify with "…the routing decision a dispatch uses (its
candidate list probes every configured route)".

---

### Finding 6 — 🟢 LOW: new test does not exercise `explain_route` (or `clear`) pass-through

**Severity:** 🟢 Low
**File:** `test/dispatch-explain-availability-schema.mjs:37-47`

**Analysis:** The file's header claims the new fields are "passed through to the daemon
unchanged". The pass-through assertions cover only `availability` with `set`
(deepEqual at line 44) and `dispatch` with `call_profile`/`idempotency_key` (lines 45-47).
`explain_route` is only schema-parsed (line 19), never sent through the handler, and the
`clear` path is never sent either. Since the handler is a generic pass-through this is
unlikely to hide a bug, but the test asserts less than its comment claims.

**Specific references:**
- `test/dispatch-explain-availability-schema.mjs:19` (explain_route parsed only), `:37-47` (pass-through)

**Remediation:** add one `dispatch.handler({action:"explain_route", agent:"a", provider:"kimi", call_profile:"completion"}, {})`
and one `clear` case with `assert.deepEqual(sent, args)`.

---

### Finding 7 — 🟢 LOW: merge overlap with `gc/6928-no-default-timeouts` is clean in `src` but not in tracked `dist/index.js`

**Severity:** 🟢 Low
**File:** `src/index.ts:3367-3372, 3410-3456, 3545-3548`; `dist/index.js` (tracked)

**Analysis:** Both branches edit the same `registerTool("gc_dispatch", …)` block. In `src`
the changed lines are disjoint: this branch edits the description head (3367-3372), the enum
(3410-3411), six new fields (3423-3456) and the `reason` describe (3545-3548); 6928 edits
the `timeout` describe (its tree line 3486) and the handler body (its tree lines 3540/3549).
No shared changed line, so a rebase/3-way merge of `src/index.ts` should be clean. The real
risk is `dist/`: it is tracked (`.gitignore` says so deliberately) and **both** branches
rebuilt and committed it — 6928's `dist/index.js` carries its timeout change and this
branch's carries the new schema. A merge will conflict (or silently take one side) in
`dist/index.js`; the only correct resolution is to rebuild `dist` from the merged `src`.
A careless resolution that keeps this branch's `dist` would revert 6928's timeout change
(and vice versa), which is exactly the src/dist drift the `.gitignore` note warns about.

**Specific references:**
- `src/index.ts:3367-3372, 3410-3456, 3545-3548`
- `6928-no-default-timeouts/src/index.ts:3486` (timeout describe), `:3540,3549` (handler)
- `6928-no-default-timeouts/dist/index.js:2948,2959` (its rebuild), `.gitignore` (dist tracked)

**Remediation:** land 6926 and 6928 sequentially, and rebuild `dist` (`npm run build`) after
the merge rather than hand-resolving the generated file. No change to this branch required.

## Nits (not counted as findings)

- `reason` describe (`src/index.ts:3545-3548`) does not mention the daemon's default note
  when it is omitted ("set by the operator", dispatch_handler.ex:294). Optional.
- `retry_at` is `z.string()` (`src/index.ts:3447-3452`); the daemon also accepts a unix-ms
  integer (`parse_when/1`, availability_ledger.ex:146). Unreachable via MCP, and the describe
  only advertises strings, so this is consistent — noted only for completeness.
- `availability` with both `clear` and `set` set: the daemon's `cond` gives `clear`
  precedence (dispatch_handler.ex:278-305); the describe does not say so. Harmless.
- The schema cannot express the `set` → `retry_at` dependency, because the strict-root
  wrapper deliberately rejects refined root schemas (`unsupportedRootSchema`,
  `src/index.ts:596-605`). The daemon's 400 ("set needs a retry_at in the future…") is the
  only guard. This is a design constraint of this repo, not a defect.

## Verified checks (no finding)

- **Diff locality:** the patch touches only the gc_dispatch description (action list + two
  new paragraphs), the `action` enum, six new schema fields, and the `reason` describe. The
  handler body (`src/index.ts:3575-3602`) is unchanged; no other tool is touched.
- **`strict-params.mjs` interplay:** the new fields are added to the same `z.object`, and
  `strictRootInputSchema` (`src/index.ts:657-668`) rebuilds a strict object from the shape,
  so `tools/list` will advertise the new properties with `additionalProperties:false`, and
  all six are `.optional()` so `required` stays `["action"]`. The generic undeclared-root-key
  rejection for every tool still holds. No change needed to that test.
- **`package.json` test chain:** `node test/dispatch-explain-availability-schema.mjs` is
  appended after `npm run build` and after the existing tests; every link is a `node`
  invocation whose non-zero exit fails the chain. Ordering is correct (build precedes the
  `dist`-importing test).
- **Test assertions test what they claim (schema half):** the parse loop (lines 18-27) uses
  the new params, and the three negative cases (lines 28-30) reject an unknown `call_profile`,
  an unknown `state`, and a misspelled `action`; the four description regexes (lines 32-35)
  match the actual strings. The pass-through half is Finding 6.
- **`dist` on disk:** `dist/index.js` already contains `explain_route`, `idempotency_key` and
  `call_profile` (read at dist/index.js:2792, 2835, 2848, 2852), so the new test's import will
  see the new schema.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| explain_route pass-through untested | Low | `test/dispatch-explain-availability-schema.mjs:19,37-47` |
| `clear` path untested | Low | same file; only `set` is sent through the handler |
| `metadata` (Finding 1) unreachable | Low | no test asserts it is intentionally absent |
| No daemon-side test in this repo | n/a | the availability ledger / explain_route behaviour is the daemon worktree's tests, out of scope here |

## Sign-off

**Blockers that should not have shipped:** None.
**Recommended next step:** commit as-is. Address Findings 1-4 opportunistically (doc/schema
tightening, no behavioural risk); resolve the `dist/index.js` overlap with 6928 by rebuilding
from merged `src`, not by hand-merging the generated file. Tests were not executed in this
environment (shell unavailable) — run `npm test` once on a machine with a working shell to
confirm the new test and `strict-params.mjs` pass.

VERDICT: PASS

AUDIT COMPLETE. STOP.
