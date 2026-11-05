# Audit: gc_mcp GC-6926 — fold commit `a298446` (round 2)

**Scope:** branch `gc/6926-mcp-dispatch-actions`, commit `a298446` ("fold GC-6926 mcp audit
round 1 findings"). Delta supplied as `audits/gc-6926-mcp-fold-delta.patch` (101 lines):
`src/index.ts` + `test/dispatch-explain-availability-schema.mjs`. Round-1 findings read from
`audits/gc-6926-mcp-round1.md`.
**Cross-read:** daemon worktree `~/Sites/ex_libs/gc_daemon/.worktrees/6926-availability-ledger`
(`lib/gc_daemon/api/dispatch_handler.ex`, `lib/gc_daemon/dispatch/availability_ledger.ex`,
`lib/gc_daemon/dispatch/route_explain.ex`, `lib/gc_daemon/api/control_handler.ex`), and this
repo's `src/index.ts` (`strictRootInputSchema`, `clean`, `daemonCall`), `test/strict-params.mjs`.
**Date:** 2026-11-05

**Method / limitation.** Shell execution is unavailable in this sandbox: every `Execute` call
was killed with SIGKILL (a bare `git show --stat a298446` died the same way round 1 did).
Everything below is a static reading of the files and the patch with the file tools. No test
was executed; the analysis of `test/strict-params.mjs` and the pass-through assertions is a
static trace, not a run. `package.json` is **not** in the fold delta (the patch has exactly two
files: `src/index.ts`, `test/dispatch-explain-availability-schema.mjs`); the test was added to
the chain in round 1, not here.

**Verdict in one line:** every round-1 finding and nit is fixed for real, the `metadata` schema
matches what the daemon accepts (any JSON object) and survives the strict-root wrapper intact,
`.min(1)` touched only `gc_dispatch`, and the new test assertions are meaningful — the only
residuals are one boundary the schema cannot express and one coverage gap, both LOW.

## Round-1 fix verification (all confirmed)

| Round-1 item | Fix in `a298446` | Verified against | Real? |
|---|---|---|---|
| F1 `metadata` dispatch param not exposed | `src/index.ts:3458-3463` adds `metadata: z.record(z.string(), z.any()).optional()` | daemon `dispatch_handler.ex:617-618,673,684-690` | ✅ |
| F2 `clear` describe under-states model-scoped clear | `src/index.ts:3440` "…a model also drops the provider-wide entry" | `availability_ledger.ex:119-122` (doc), `:311-319` (`:ets.delete` of `{p,m}` **and** `{p,nil}`) | ✅ |
| F3 `idempotency_key` accepts `""` | `src/index.ts:3429-3431` adds `.min(1)` | daemon `dispatch_handler.ex:679-682` (`invalid_idempotency_key`, non-empty) | ✅ |
| F4 `agent`/`provider`/`model` describes omit `explain_route` | `src/index.ts:3472`, `:3493`, `:3499` | daemon `dispatch_handler.ex:254` (`explain_route` + binary agent), `:220` (`resolve_dispatch`) | ✅ |
| F5 "the same function a dispatch uses" loose | `src/index.ts:3367` now "the decision is the one a dispatch makes, and the candidate list probes every configured route" | `route_explain.ex:38-39` (`evaluate_all` probes every route) | ✅ |
| F6 test does not exercise `explain_route`/`clear` pass-through | `test/...mjs:45-51` sends both through the handler | see "Test meaning" below | ✅ |
| F7 merge overlap with 6928, no `src` change | no change in `a298446` (as intended) | patch has no shared-line edits | ✅ |
| nit `reason` default text | `src/index.ts:3558` "(default \"set by the operator\")" | daemon `dispatch_handler.ex:294` (`params["reason"] \|\| "set by the operator"`) | ✅ |
| nit clear-wins-over-set | `src/index.ts:3440` "If clear and set are both given, clear wins." | daemon `dispatch_handler.ex:278-305` (`cond` tests `clear` first) | ✅ |

## Explicit angles the brief asked for

### `metadata` schema vs the daemon, and the strict-root wrapper — OK

- **What the daemon accepts** (`dispatch_handler.ex:684-690`): a present, non-nil value must be
  a map (`is_map/1`), else `invalid_metadata`; an encoded size over `@metadata_limit_bytes`
  (`16_384`, `:673`) is `invalid_metadata`; a valid map is forwarded to `put_profile_opts`
  (`:615-618`) and recorded on the dispatch.
- **What `z.record(z.string(), z.any())` accepts**: any JSON object, arbitrary string keys,
  arbitrary values, empty object allowed; arrays are rejected (zod v3 `ZodRecord` fails on
  parsed type `array`). The daemon also rejects arrays (`is_map` is false for an Elixir list).
  **Parity holds** for the value space the brief cares about.
- **Strict-root wrapper** (`src/index.ts:612-679`, applied at `:730`): `gc_dispatch` passes a
  `z.object`, so `isRawShape` is false and the v3-object branch rebuilds
  `new z.ZodObject({...objectSchema._def, unknownKeys: "strict", errorMap})`. The new
  `z.record` field is carried through unchanged (nested record keys are deliberately *not*
  made strict — see the comment at `:551-559`), root `additionalProperties` stays `false`, and
  because `metadata` is `.optional()` the required set stays `["action"]`. No mixing hazard:
  every other `gc_dispatch` field (`zBoolean`/`zNumber`/`zTimeout`, `:524-549`) is v3, so
  `usesZodV4` is false and the v3/v4 mix guard never fires. `strict-params.mjs` iterates every
  tool and asserts `tools/list` properties equal the registered shape, so `metadata` must and
  will appear.
- **`clean()`** (`src/index.ts:171-177`) strips only top-level `undefined`, so a nested
  `metadata` object is forwarded verbatim — the pass-through assertion is honest.

### `.min(1)` locality — OK

The patch adds `.min(1)` in exactly one hunk (`src/index.ts` `@@ -3428,6 +3428,7 @@`). The
only other `idempotency_key` in the file is `gc_control` at `src/index.ts:1036-1039`
(`z.string().optional()`, no `min`) — **untouched**. Confirmed by direct read of both regions.
That is the correct scope: the control daemon silently ignores an empty key
(`control_handler.ex:80-85`, `key when is_binary(key) and key != "" -> [idempotency_key: key]`),
a different contract from dispatch's 400.

### Test assertions — meaningful, with one gap

- `assert.deepEqual(sent, more)` at `test/...mjs:51` genuinely proves pass-through: the handler
  is `async (params) => daemonCall("/gc/dispatch", params)`, the mocked `fetch` records
  `JSON.parse(init.body)`, and `clean` does not add or drop keys for these inputs. Three cases
  (explain_route, availability clear, dispatch metadata) each assert the exact body.
- `assert.ok(!parse({… idempotency_key: "" }).success, …)` at `:53` exercises the new
  `.min(1)` through the registered schema — a real negative assertion.
- Lines `:42-44` (availability `set`) and `:54-56` (call_profile/idempotency_key) remain
  meaningful. The pre-existing parse loop at `:17-23` covers explain_route / availability /
  call_profile / idempotency_key.
- **Gap:** `metadata` is never run through `safeParse` (it is absent from the `:17-23` loop,
  and the `:48-51` case calls `dispatch.handler` directly, bypassing zod). See R2.

## Findings

### Finding R1 — 🟢 LOW: the `metadata` schema does not enforce the 16 KiB cap it documents

**Severity:** 🟢 Low
**File:** `src/index.ts:3458-3463`

**Analysis:** The describe promises "a JSON object (at most 16 KiB)", but the schema is a bare
`z.record(z.string(), z.any())` with no size check. The daemon enforces the cap
(`byte_size(Jason.encode!(metadata)) > 16_384`, `dispatch_handler.ex:673,688-690`), so an
oversized object passes MCP validation and then fails with a 400 `invalid_metadata`. This is the
same shape as round-1 Finding 3 (which the fold fixed with `.min(1)`): a boundary the MCP layer
advertises but does not hold. The failure is loud, not silent corruption, so it is LOW, not a
blocker. Unlike root refinements, a field-level `.refine` is allowed here — the wrapper only
rejects refined *root* schemas (`src/index.ts:598-605`).

**Specific references:**
- `src/index.ts:3458-3463` (schema + describe)
- `lib/gc_daemon/api/dispatch_handler.ex:673` (`@metadata_limit_bytes 16_384`), `:688-690` (the cap check)

**Remediation:** optionally add a field-level guard, e.g.
`z.record(z.string(), z.any()).refine((v) => Buffer.byteLength(JSON.stringify(v)) <= 16_384, "metadata exceeds 16 KiB").optional()`.
Not required for correctness; the daemon is authoritative.

---

### Finding R2 — 🟢 LOW: `metadata`'s schema is never parsed by a test

**Severity:** 🟢 Low
**File:** `test/dispatch-explain-availability-schema.mjs:17-23, 45-53`

**Analysis:** The fold added a `metadata` case to the *pass-through* loop (`:48-51`), which calls
`dispatch.handler(more, {})` directly and therefore never touches zod. The success-parse loop at
`:17-23` was not extended with a `metadata` case, and `strict-params.mjs` never calls
`gc_dispatch` with `metadata`. So the one new schema field is asserted only at the transport
layer; a regression that made `metadata` unparseable (wrong zod version, a bad refactor of the
wrapper) would not be caught by this suite. The pass-through half is real and correct — it just
does not cover the schema half.

**Specific references:**
- `test/dispatch-explain-availability-schema.mjs:17-23` (parse loop — no metadata)
- `test/dispatch-explain-availability-schema.mjs:45-51` (handler call — bypasses zod)
- `test/strict-params.mjs` (no `gc_dispatch` + `metadata` call)

**Remediation:** add `{ action: "dispatch", agent: "a", task: "t", metadata: { run: "r-1" } }`
to the `ok` array at `:17-23`, and optionally a negative case (e.g. `metadata: "nope"`).

---

### Finding R3 — 🟢 LOW: MCP rejects `metadata: null`, which the daemon treats as absent

**Severity:** 🟢 Low
**File:** `src/index.ts:3458-3463`

**Analysis:** `z.record(...).optional()` accepts `undefined` but not `null`, so `metadata: null`
is refused at the MCP boundary. The daemon's guard skips a nil value
(`Map.has_key?(params, "metadata") and not is_nil(params["metadata"]) and not is_map(...)`,
`dispatch_handler.ex:684-686`) and then drops it via `maybe_add` (`:618`, `:3074`), i.e. it
treats `null` as "no metadata". This is a divergence in the "matches what the daemon accepts"
sense, but the MCP side is *stricter*, so it can only reject a call the daemon would have
silently no-op'd — harmless, and arguably the better boundary. Recorded for completeness.

**Specific references:**
- `src/index.ts:3458-3463`
- `lib/gc_daemon/api/dispatch_handler.ex:684-686`, `:3074-3075`

**Remediation:** none needed; leave as-is or accept null via `.nullish()` if strict parity is wanted.

---

### Finding R4 — 🟢 LOW: `agent` describe still omits `resolve_dispatch`

**Severity:** 🟢 Low
**File:** `src/index.ts:3470-3473`

**Analysis:** The fold changed the `agent` describe to "required for dispatch and explain_route"
(round-1 F4). The daemon also requires `agent` for `resolve_dispatch`
(`dispatch_handler.ex:220` matches `resolve_dispatch` + agent; `:242` returns
"missing required field: agent"). The statement is not false, just incomplete in the same way F4
was. Pre-existing and out of the round-1 scope, so not a regression — noted only because the
brief asks for nits.

**Specific references:**
- `src/index.ts:3472`
- `lib/gc_daemon/api/dispatch_handler.ex:220,242`

**Remediation:** optionally "required for dispatch, resolve_dispatch and explain_route".

---

### Finding R5 — 🟢 LOW: the test's success line and header do not mention `metadata`

**Severity:** 🟢 Low
**File:** `test/dispatch-explain-availability-schema.mjs:1-2, 57`

**Analysis:** The fold added a `metadata` pass-through case, but the file header ("…dispatch's
call_profile / idempotency_key, and passes them through to the daemon unchanged", `:1-2`) and the
final `process.stdout.write` (`:57`) still name only explain_route / availability /
call_profile / idempotency_key. Pure doc drift in a test; no behavioural effect.

**Specific references:**
- `test/dispatch-explain-availability-schema.mjs:1-2`, `:57`

**Remediation:** add "metadata" to both strings when the file is next touched.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| `metadata` schema parse untested | Low | R2 — add a metadata case to the `:17-23` parse loop |
| `metadata` >16 KiB boundary untested | Low | R1 — daemon-only today; a field-level refine would make it testable at the MCP layer |
| No daemon-side test in this repo | n/a | availability/explain_route behaviour lives in the daemon worktree's tests, out of scope here |

## Sign-off

**Blockers that should not have shipped:** None.
**Recommended next step:** commit as-is. Every round-1 finding and nit is fixed and accurate
against the daemon; the residuals are two LOW boundary/coverage items (R1, R2) that need no
change before shipping. Note the environment limitation: tests were not executed (shell SIGKILL),
so run `npm test` once on a machine with a working shell to confirm the new test and
`strict-params.mjs` still pass.

VERDICT: PASS

AUDIT COMPLETE. STOP.
