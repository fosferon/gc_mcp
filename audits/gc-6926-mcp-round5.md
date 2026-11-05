# Audit: gc_mcp GC-6926 — fold commit `066c2cf` (round 5, delta-scoped)

**Scope:** the delta in `audits/gc-6926-mcp-fold4.patch` and nothing else —
`src/index.ts` (the `metadata` field) and `test/dispatch-explain-availability-schema.mjs`.
**Date:** 2026-11-05

**Scope discipline.** Per the brief, findings are raised only on lines the patch changes.
Anything outside those lines (including the daemon, the rest of `src/index.ts`, and other
tests) is context for verifying the changed lines, not an audit target.

## Method

Read-only. I read the patch, the working-tree `src/index.ts` and test, the committed
`dist/index.js`, the daemon's `lib/gc_daemon/api/dispatch_handler.ex` in the
`6926-availability-ledger` worktree, and the installed libraries the change depends on:
`zod@3.25.76` (`v3/types.js`), `zod-to-json-schema@3.25.2` (`dist/esm/parsers/*`),
`@modelcontextprotocol/sdk@1.32.1` (`server/mcp.js`, `server/zod-json-schema-compat.js`),
and Jason (`deps/jason/lib/encode.ex`) for the daemon's re-encoding.

I also **ran** the three affected test files against the committed `dist`:

```
node v24.21.0
test/dispatch-explain-availability-schema.mjs  exit=0
  "gc_dispatch explain_route + availability + call_profile/idempotency_key/metadata verified."
test/tools-list-no-refs.mjs                    exit=0
  "Verified 65 tools with no advertised $ref schemas."
test/strict-params.mjs                         exit=0
  "Verified strict root MCP parameter rejection across 72 tools."
  "Verified response truncation for oversized daemon payloads."
  "Verified gc_dispatch output paging parameters and hint."
```

Shell in this sandbox only runs with `fireAndForget` (foreground `Execute` is SIGKILLed);
`Grep`/`Glob` are unavailable (ripgrep binary missing), so searching was done via `Execute`
+ `grep`/`od`. I did **not** run `npm run build`: `tsc` would rewrite the tracked `dist/`,
which an auditor must not do. The committed `dist` already carries the folded code (verified
by direct read and by the passing tests, which import `../dist/index.js`).

## Patch fidelity

The supplied patch is a faithful, if partial, record of the commit. The commit
`066c2cf` touches four files (`src/index.ts`, `test/…mjs`, `dist/index.js`,
`dist/index.js.map`); the patch carries only the first two. Extracted and diffed
against `git diff 066c2cf^ 066c2cf`:

```
=== src diff vs patch src ===   IDENTICAL
=== test diff vs patch test === IDENTICAL
```

The commit rebuilt `dist` in the same step (`dist/index.js` gains the same comment,
`.nullish()`, and describe), so there is **no src/dist drift**. Working tree is clean
apart from the untracked patch. Scope note: `dist` is outside the patch, so it is not
audited here; it is confirmed only as evidence that the tests exercised the folded code.

## Item-by-item verification of the changed lines

| Brief item | Where | Verdict |
|---|---|---|
| Guard comment reworded | `src/index.ts:3464-3465` | Accurate |
| Describe: JSON-encodable, null == omitted, size-measurement divergence | `src/index.ts:3471` | Accurate |
| `.optional()` → `.nullish()`; refine does not run on null | `src/index.ts:3469` | Correct, verified in zod source |
| `metadata: null` accepted | `test/…mjs:45` | Real (passes) |
| `metadata: null` passed through unchanged | `test/…mjs:65-68` | Real |
| Multi-byte boundary arithmetic | `test/…mjs:37-39` | Exact |
| Array refused | `test/…mjs:40` | Real |
| Cyclic refused (drives the `catch`) | `test/…mjs:41-43` | Real |

### Guard comment (`src/index.ts:3464-3465`)

Now reads: *"not JSON-encodable (BigInt, cycle): fail validation here rather than letting
the transport's JSON.stringify throw later"*. This is the wording round-4 F1 proposed. It
is accurate: the MCP server's own `gcPost` serialises the body with `JSON.stringify(body)`
(`src/index.ts:119`), which throws for a `BigInt`/cyclic value, and that throw lands inside
`daemonCall`'s `try` (`src/index.ts:495-505`) as an `ERROR: …` tool result. The comment no
longer blames the daemon, which was round-4 F1's point.

### Describe wording (`src/index.ts:3471`) against the daemon

- *"a JSON object (at most 16 KiB, JSON-encodable) recorded on the job"* — matches the
  daemon: `validate_request_extras` requires a map and `byte_size(Jason.encode!(…)) <= 16_384`
  (`dispatch_handler.ex:689-696`, `@metadata_limit_bytes 16_384` at `:678`).
- *"null is the same as omitting it"* — matches the daemon. Nil metadata skips both the
  type and size checks (`dispatch_handler.ex:689-694`: `not is_nil(...)`), and is dropped
  before the job record is written (`put_profile_opts` keeps metadata only when
  `is_map(...)`, `:620-624`; `put_if("metadata", cli_opts[:metadata])` is a no-op for nil,
  `:1279`). The claim is about the recorded job, and it is true there. (The MCP layer does
  transmit `"metadata":null` on the wire — the pass-through test asserts exactly that — but
  the daemon's observable effect is the same as absent.)
- *"The size is measured here as the JSON.stringify byte length and by the daemon on its own
  re-encoding"* — matches. Here: `Buffer.byteLength(JSON.stringify(value))` (`:3462`); the
  daemon: `byte_size(Jason.encode!(params["metadata"]))` over the decoded map (`:693-694`).
- *"…so a payload within a byte or two of the limit that holds exponent-form numbers (1e+21,
  1e-7) can be accepted here and still refused by the daemon (invalid_metadata, 400)."* —
  matches. `JSON.stringify(1e21)` → `1e+21` (5 bytes) while the daemon decodes the float and
  re-encodes via `:erlang.float_to_binary(float, [:short])` (`deps/jason/lib/encode.ex:139-141`)
  as `1.0e21` (6 bytes, +1); `JSON.stringify(1e-7)` → `1e-7` (4) vs `1.0e-7` (6, +2). A payload
  1–2 bytes under the MCP cap can therefore clear the refine and trip the daemon's check,
  which returns `{:error, :refused, %{error: "invalid_metadata", …}}` → HTTP 400 via
  `finalize(conn, {:error, :refused, payload})` (`api/router.ex:835-837`). The claimed
  direction and the `invalid_metadata, 400` pair are both correct.

### `.nullish()` composition (`src/index.ts:3469`)

`.nullish()` is `this.nullable().optional()` (`node_modules/zod/v3/types.js:295-296`), so the
chain `z.record(...).refine(...).nullish()` is `ZodOptional(ZodNullable(ZodEffects(ZodRecord)))`.
For `null`, `ZodOptional._parse` sees a non-undefined value and delegates to `ZodNullable._parse`,
which returns `OK(null)` at `types.js:3329-3335` **without touching the inner `ZodEffects`** — the
refine never runs on `null`. For `undefined`, `ZodOptional._parse` returns `OK(undefined)`
(`:3310-3317`). Only a non-null value reaches the record and the refine. So accepting `null`
adds no new path through the size/encodability guard.

The `strictRootInputSchema` wrapper is unaffected: `isSchema` only checks for a `safeParse`
function (`src/index.ts:563-569`), which `ZodOptional` has, so the field passes the shape
check. The `tools/list` export stays `$ref`-free — `parseNullableDef` unwraps the non-primitive
inner to `{type:"object", additionalProperties:{}}` and returns `{anyOf:[…, {type:"null"}]}`
(`node_modules/zod-to-json-schema/dist/esm/parsers/nullable.js`), and the test run above
reported 65 tools with zero `$ref`s. `metadata` is not made required (`safeIsOptional` on the
outer `ZodOptional`), so `strict-params.mjs` stays green.

### `metadata: null` accepted and passed through (`test/…mjs:45`, `:65-68`)

- Acceptance: line 45 parses `{action:"dispatch", agent:"a", task:"t", metadata: null}` and
  asserts `.success`. It passes, so `.nullish()` genuinely admits `null` (this assertion would
  fail if the field were still `.optional()`).
- Pass-through: the `more` loop (`:61-69`) calls `dispatch.handler({…, metadata: null}, {})`,
  captures the body the handler handed to `fetch`, and asserts `deepEqual(sent, more)`. The
  test imports `node:assert/strict`, so `deepEqual` is the strict comparison — a `null` value
  and a missing key are distinct, so this is a real check that the handler forwards `null`
  unchanged (a `clean()`/handler that dropped or re-typed null would fail it). It is a
  handler-level check, not a schema check; the schema path is covered separately by line 45.
  Both claims in the brief hold.

### Multi-byte boundary arithmetic (`test/…mjs:37-39`)

The character is U+00E9 (`od` of the file line shows `303 251` = `0xC3 0xA9`, 2 UTF-8 bytes),
and `JSON.stringify` leaves non-ASCII unescaped, so `JSON.stringify({k:"é"×N})` is
`8 + 2N` bytes (the same 8-byte overhead `{`, `"k"`, `:`, two value quotes, `}` used by the
ASCII cases at `:34-35`).

- `N = 8188`: `8 + 16376 = 16384 ≤ 16384` → accepted (line 39, passes).
- `N = 8190`: `8 + 16380 = 16388 > 16384` → refused (line 38, passes).

The comment at line 37 states exactly this (`8190 … = 16388 > 16384`) and is correct. The pair
is meaningful, not redundant: a character-counting guard would accept the 8190 case (8198 chars),
so the refused assertion is what pins `Buffer.byteLength` byte semantics.

### Array refused (`test/…mjs:40`)

`z.record(z.string(), z.any())` rejects a non-object: `ZodRecord._parse` fails when
`ctx.parsedType !== ZodParsedType.object` (`zod/v3/types.js:2668-2677`), and an array's parsed
type is `array`. The assertion (`!success`) passes. The daemon agrees (`is_map/1` rejects
arrays, `dispatch_handler.ex:689-691`), so MCP and daemon are consistent here.

### Cyclic refused (`test/…mjs:41-43`)

The cyclic object passes the record gate (`z.any()` values are returned as-is, no recursion),
then reaches the refine, where `JSON.stringify(cyclic)` throws `TypeError`; the `catch` converts
that to `false` and the parse fails. This is a genuine exercise of the `catch` — without it,
`safeParse` would throw and the test would die with an uncaught `TypeError` rather than reaching
its assertion. The test passes, so the `catch` is live. The comment's "cycle" case is now covered.

## Findings

**None on the changed lines.** Every line the patch changes was checked against the daemon, the
zod runtime, and a live run of the tests; all four folded items (comment, describe, `.nullish()`,
new tests) are implemented as described and behave as the tests assert.

Two notes that are *not* findings, recorded so they are not mistaken for gaps:

- The describe documents only the direction that matters at the boundary (MCP accepts, daemon
  refuses). The reverse can also occur for some exponent forms (e.g. `JSON.stringify(1.5e21)` is
  `1.5e+21`, one byte longer than the daemon's `1.5e21`, so MCP would refuse what the daemon
  accepts). The describe says "can be accepted here and still refused", a possibility claim that
  is true for its examples and does not assert the converse never happens; the omitted direction
  is the benign one (MCP being the stricter layer). No change needed.
- `metadata: null` is still put on the wire (`"metadata":null`); "the same as omitting it" is
  true of the daemon's treatment and the recorded job, which is the sentence's subject.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| No daemon-side test of the null path | Low | The MCP side is tested; the "null == absent" claim rests on `dispatch_handler.ex:689-694,620-624`, read here, not exercised in this repo (it is the daemon's repo anyway). |
| Exponent divergence not exercised end to end | Low | The describe's claim is derived from `JSON.stringify` vs `:erlang.float_to_binary/2`; no test sends an exponent payload to a real daemon. Loud, daemon-authoritative failure, so acceptable. |
| `dist` build not re-run here | n/a | Read-only audit; `tsc` would rewrite a tracked file. The committed `dist` is in step and the tests import it. |

## Sign-off

**Blockers that should not have shipped:** None.

**Recommended next step:** commit as-is. The fold implements round-3 F1/F3 and round-4 F1–F4
exactly as described: the comment no longer blames the daemon, the describe is accurate against
`dispatch_handler.ex` (including `invalid_metadata`/400), `.nullish()` composes so the refine
never sees `null`, and the new multi-byte/array/cyclic/null tests are real and pass against the
committed `dist`.

VERDICT: PASS

AUDIT COMPLETE. STOP.
