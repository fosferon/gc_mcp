# Audit: gc_mcp GC-6926 — fold commit `8a10c6d` (round 3)

**Scope:** branch `gc/6926-mcp-dispatch-actions`, HEAD `8a10c6d` ("fold GC-6926 mcp round 2
(metadata size guard, tests, describes)"). Delta read: `audits/gc-6926-mcp-fold2.patch`
(`src/index.ts`, `test/dispatch-explain-availability-schema.mjs`). Round-2 findings read from
`audits/gc-6926-mcp-round2.md`.
**Cross-read:** daemon worktree `~/Sites/ex_libs/gc_daemon/.worktrees/6926-availability-ledger`
(`lib/gc_daemon/api/dispatch_handler.ex`), this repo's `src/index.ts` (`strictRootInputSchema`,
`clean`, `gcPost`, `daemonCall`), committed `dist/index.js`, `test/strict-params.mjs`,
`test/tools-list-no-refs.mjs`, and the installed `zod@3.25.76`, `zod-to-json-schema@3.25.2`,
`@modelcontextprotocol/sdk@1.32.1`, `@types/node@22`.
**Date:** 2026-11-05

**Method / limitation.** Shell is unavailable in this sandbox: every `Execute` call was killed
with SIGKILL (same as round 2), so no test was run and no `git` command was issued. All
verification below is a static reading of the files, the patch, and the installed libraries. I
did verify the *committed* `dist` by reading it directly (see "dist rebuild" below). `git status`
at session start showed only the untracked patch, so `dist` in the tree equals HEAD.

**Verdict in one line:** the fold is correct. R1–R5 are all real fixes; the refine's threshold
matches the daemon exactly (`<= 16_384` vs daemon `> 16_384`), the field-level refine survives
the strict-root wrapper and the tools/list JSON-schema export intact (no `$ref`), `Buffer`
compiles, and the tests assert what they claim. The only residuals are three LOW
boundary/robustness nits and one LOW test-coverage gap.

## Fold verification (R1–R5)

| Round-2 item | Fix in `8a10c6d` | Verified against | Real? |
|---|---|---|---|
| R1 `metadata` 16 KiB cap not enforced at MCP | `src/index.ts:3460-3463` adds the field-level `.refine(...)` | daemon `dispatch_handler.ex:673,688-691` | ✅ |
| R2 `metadata` schema never parsed by a test | `test/...mjs:24` (ok case), `:31-32` (two negatives) | daemon type + cap rules | ✅ |
| R3 `metadata: null` divergence — deliberately unchanged | no change | daemon `:684-686` | ✅ (accepted) |
| R4 `agent` describe omits `resolve_dispatch` | `src/index.ts:3476` now "dispatch, resolve_dispatch and explain_route" | daemon `:220,242,254` | ✅ |
| R5 test header/success line omit `metadata` | `test/...mjs:2,60` | — | ✅ |
| dist rebuilt from folded src | `dist/index.js:2873-2877` (refine), `:2885` (describe) | `src/index.ts:3458-3477` | ✅ |

The threshold is exact parity, not approximate: the refine passes when
`Buffer.byteLength(JSON.stringify(value)) <= 16_384` (`src/index.ts:3461`) and the daemon errors
when `byte_size(Jason.encode!(metadata)) > @metadata_limit_bytes` with `@metadata_limit_bytes
16_384` (`dispatch_handler.ex:673,688-691`). Both accept 16 384 bytes and reject 16 385.

## Findings

### Finding 1 — 🟢 LOW: the two byte counts agree for text but can differ for exponent-notation numbers

**Severity:** 🟢 Low
**File:** `src/index.ts:3460-3463`; daemon `lib/gc_daemon/api/dispatch_handler.ex:673,688-691`

**Analysis:** The MCP guard measures `Buffer.byteLength(JSON.stringify(value))` over the parsed
object, while the daemon measures `byte_size(Jason.encode!(params["metadata"]))` over the value
it re-decodes from the JSON the MCP server sent (`daemonCall` → `gcPost` →
`JSON.stringify(body)`, `src/index.ts:496,119`). For ASCII/UTF-8 text and ordinary integers the
two encodings are byte-identical, so the counts match. They can diverge for numbers that
`JSON.stringify` emits in exponent notation: Jason decodes `1e+21` to the float `1.0e21` and
re-encodes it as `1.0e21` (one byte longer, and without the `+`), and likewise `1e-7` →
`1.0e-7` (two bytes longer). The reverse can also happen for very large magnitudes, where
`JSON.stringify` keeps the `+` (`1.7976931348623157e+308` is one byte longer than Jason's
`1.7976931348623157e308`).

**Impact:** within a byte or two of the 16 KiB boundary the two layers can disagree — the MCP
guard accepts while the daemon answers 400 `invalid_metadata`, or (rarely) the MCP guard rejects
a payload the daemon would have accepted. Both are loud, and the daemon remains authoritative,
so this is LOW. It is the one place where the "matches the daemon" claim is not byte-exact.

**Specific references:**
- `src/index.ts:3461` (the refine's `Buffer.byteLength(JSON.stringify(value))`)
- `src/index.ts:496` (`daemonCall` → `gcPost(endpoint, clean(params), …)`), `src/index.ts:119` (`gcPost`'s `JSON.stringify(body)`)
- `lib/gc_daemon/api/dispatch_handler.ex:688-691` (the daemon's `byte_size(Jason.encode!(…))` check)

**Remediation:** none required for correctness (the daemon is authoritative and the failure is
loud). If exact parity is wanted, do not add a second approximation — either drop the MCP guard
and rely on the daemon, or make it a generous early guard (e.g. reject only well over the limit)
and document that the daemon is the source of truth.

---

### Finding 2 — 🟢 LOW: the refine predicate is not total (`JSON.stringify` can throw), and zod does not catch it

**Severity:** 🟢 Low
**File:** `src/index.ts:3461`

**Analysis:** `JSON.stringify(value)` throws `TypeError` for a `BigInt` value (and for a circular
object or a throwing `toJSON`). zod v3 calls a refinement predicate directly, with no
`try`/`catch` (`node_modules/zod/v3/types.js:3227-3251`, `effect.refinement(acc, checkCtx)`), so
a throw propagates out of `safeParse`/`safeParseAsync` as an exception rather than becoming a
validation issue. Two things make this harmless in practice: (a) it is unreachable through the
JSON transport — JSON has no `BigInt` literal and no cycles, so `metadata` can only contain JSON
values; and (b) the SDK's `CallTool` handler wraps any thrown error into an `isError` result
(`node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:175-182`), so even an in-process
caller would get a tool error, not a crash. Recorded only because the brief asked about the
`BigInt`/`undefined` edge.

Note also that `undefined` is safe by construction: `metadata` is
`.refine(...).optional()`, and `ZodOptional._parse` returns `OK(undefined)` before the inner
record/refine runs (`node_modules/zod/v3/types.js:3310-3317`); the record rejects non-objects
(`types.js:2668-2677`) before the refinement is reached.

**Specific references:**
- `src/index.ts:3461` (the predicate)
- `node_modules/zod/v3/types.js:3227-3251` (refinement runs without try/catch), `:3310-3317` (`ZodOptional` short-circuit), `:2668-2677` (`ZodRecord` type gate)
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:206-224` (`validateToolInput`), `:175-182` (error → `isError`)

**Remediation:** none needed. If you want the predicate total anyway, guard it, e.g.
`(value) => { try { return Buffer.byteLength(JSON.stringify(value)) <= 16_384; } catch { return false; } }`.

---

### Finding 3 — 🟢 LOW: `metadata: null` is refused at MCP but treated as absent by the daemon (R3, unchanged)

**Severity:** 🟢 Low
**File:** `src/index.ts:3458-3464`

**Analysis:** `z.record(...).optional()` accepts `undefined` but not `null`, so `metadata: null`
is rejected at the MCP boundary, while the daemon's guard skips a nil value
(`Map.has_key?(params, "metadata") and not is_nil(params["metadata"]) and not is_map(...)`,
`dispatch_handler.ex:684-686`) and then drops it. This is the divergence round 2 recorded as R3
and the brief says is deliberately unchanged; it is restated here only for completeness. The MCP
side is the *stricter* one, so it can only refuse a call the daemon would have no-op'd — harmless.

**Specific references:**
- `src/index.ts:3458-3464`
- `lib/gc_daemon/api/dispatch_handler.ex:684-686`

**Remediation:** none; leave as-is (or `.nullish()` if exact parity is ever wanted).

---

### Finding 4 — 🟢 LOW: the 16 KiB threshold is not tested at its exact boundary

**Severity:** 🟢 Low
**File:** `test/dispatch-explain-availability-schema.mjs:24,31,32`

**Analysis:** The ok case (`:24`) is a tiny object and the over-limit case (`:32`) is 17 000
characters (`{"big":"…"}` = 17 010 bytes), comfortably past the cap. So the test proves the cap
is somewhere below ~17 KB, but not that it is exactly 16 384: a guard that rejected anything
over, say, 16 500 would still pass `:32`. There is also no case for a JSON array (`metadata: []`),
which both the zod record and the daemon's `is_map/1` reject, nor for the exact boundary
(accept 16 384, reject 16 385).

**Specific references:**
- `test/dispatch-explain-availability-schema.mjs:24` (small ok), `:31` (non-object), `:32` (17 010 bytes)

**Remediation:** add two boundary assertions, e.g. an object whose JSON is exactly 16 384 bytes
(expected `success`) and one at 16 385 bytes (expected `!success`); optionally an array case.

## Explicit angles the brief asked for

- **`JSON.stringify` of `undefined`** — safe. `.optional()` short-circuits before the record and
  refine (`src/index.ts:3464`, `zod/v3/types.js:3310-3317`).
- **`JSON.stringify` of `BigInt`** — throws, but unreachable via JSON and wrapped by the SDK.
  See Finding 2.
- **Byte length vs the daemon's `Jason.encode` byte size** — equal for text and ordinary numbers;
  can differ by 1–2 bytes for exponent-notation numbers. See Finding 1.
- **Unicode** — both sides emit raw UTF-8 (`JSON.stringify` and `Jason.encode!` leave non-ASCII
  unescaped), so multi-byte characters count the same; surrogate pairs and `U+2028/U+2029` are
  likewise emitted raw by both. No divergence found.
- **Boundary** — exact: refine `<= 16_384` (`src/index.ts:3461`) vs daemon `> 16_384`
  (`dispatch_handler.ex:673,688-691`).
- **Strict-root wrapper** — safe. `gc_dispatch` passes a `z.object`, so `hasRootRefinement`
  (`src/index.ts:596-599`, reads `def.checks` on the *root*) is false and the wrapper rebuilds
  `new z.ZodObject({..._def, unknownKeys:"strict"})` (`src/index.ts:657-663`); the field-level
  `ZodOptional<ZodEffects<ZodRecord>>` is carried through the shape unchanged. The wrapper only
  rejects refined *root* schemas (`src/index.ts:630,601-605`), not refined fields.
- **tools/list JSON-schema export** — safe. The SDK converts v3 schemas with `zodToJsonSchema`
  (`zod-json-schema-compat.js`), whose `effectStrategy` default is `"input"`
  (`zod-to-json-schema/dist/esm/Options.js`), so `parseEffectsDef` unwraps the `ZodEffects` to the
  inner record (`.../parsers/effects.js`) and `metadata` exports as
  `{type:"object", additionalProperties:{}}`. No `$ref` is introduced (the refined def is unique,
  so `$refStrategy:"root"` never fires), so `test/tools-list-no-refs.mjs` stays green. In
  `test/strict-params.mjs` the required set is derived from `!schema.safeParse(undefined).success`
  — `metadata` is optional, so it is not required and `tools/list`'s `required` is unaffected.
- **`Buffer` under tsconfig** — compiles. `tsconfig.json` sets no `types`/`lib` restriction, so
  the installed `@types/node@22` global `Buffer` is in scope; `JSON.stringify(value)` types as
  `string`, matching `Buffer.byteLength(string)`. Strong confirmation: the committed
  `dist/index.js:2875` contains the compiled `.refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 16_384, …)`,
  so `tsc` accepted it.
- **Tests assert what they claim** — yes, for `:24` (small metadata parses), `:31`
  (`ZodRecord` rejects a string), `:32` (refine rejects 17 010 bytes), and `:51,54` (metadata is
  forwarded verbatim: the handler passes `params` unchanged and `daemonCall`→`gcPost` serialises
  `clean(params)`). The one gap is the exact boundary — Finding 4.

## Anything else

- **dist rebuild verified.** `dist/` is committed, not ignored (`.gitignore`), and the fold
  commit kept it in step: `dist/index.js:2873-2877` carries the refine and `:2885` the new
  `agent` describe, matching `src/index.ts:3458-3477`. No src/dist drift. Note the supplied patch
  contains only `src/` and `test/`, so it is not the complete commit delta — anyone treating the
  patch as the whole change set would miss the dist rebuild.
- **No other changed files.** I could not run `git`, so I relied on the supplied patch plus direct
  reads of `src`, `test`, and `dist`; I found no fold-related change beyond those three files.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| Exact 16 KiB boundary untested | Low | Finding 4 — the 17 010-byte case only bounds the cap from above |
| JSON array `metadata` untested | Low | `metadata: []` is rejected by both layers; no case covers it |
| Tests not executed here | n/a | Shell unavailable (SIGKILL); run `npm test` where a shell works to confirm the new cases and `strict-params.mjs`/`tools-list-no-refs.mjs` |

## Sign-off

**Blockers that should not have shipped:** None.
**Recommended next step:** commit as-is. Every round-2 finding and nit is fixed for real, the
threshold matches the daemon exactly, and the field-level refine is compatible with both the
strict-root wrapper and the tools/list export. The residuals (Findings 1–4) are LOW and need no
change before shipping. Run `npm test` once on a machine with a working shell to confirm the
suite passes.

VERDICT: PASS

AUDIT COMPLETE. STOP.
