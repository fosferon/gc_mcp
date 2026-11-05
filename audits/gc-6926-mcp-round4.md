# Audit: gc_mcp GC-6926 — fold commit `e3c8f74` (round 4)

**Scope:** branch `gc/6926-mcp-dispatch-actions`, HEAD `e3c8f74` ("fix(gc_dispatch): total
metadata refine, boundary tests (GC-6926 mcp round 3)"). Delta read: `audits/gc-6926-mcp-fold3.patch`
(`src/index.ts`, `test/dispatch-explain-availability-schema.mjs`). Prior findings read from
`audits/gc-6926-mcp-round3.md`.
**Cross-read:** working-tree `src/index.ts`, `test/dispatch-explain-availability-schema.mjs`, and
the committed `dist/index.js`.
**Date:** 2026-11-05

**Method / limitation.** Shell is unavailable in this sandbox: every `Execute` call was killed
with SIGKILL (same as rounds 2–3), and `Grep` failed ("Ripgrep binary not found"), so no test was
run and no `git` command was issued. Verification is a static reading of the patch, the
working-tree files, and the committed `dist`. `git status` at session start showed only the
untracked patch, so the working-tree `src`/`test`/`dist` equal HEAD. I therefore cannot *prove*
from git that the commit touched no other files; I verified that (a) the patch's post-image
matches the working tree byte-for-byte at every touched hunk and (b) `dist` is in step with
`src` (see below). Treat "nothing else changed" as high-confidence, not git-proven.

## Verdict in one line

The fold is correct and complete. F2 (total refine) and F4 (boundary tests) are implemented as
described; the boundary arithmetic is exact (16 384 accepted, 16 385 refused); the BigInt case
genuinely reaches and exercises the new `catch`; the refine message and test wording are accurate;
and `dist` was rebuilt in step. F1 (exponent-notation byte-count divergence) and F3
(`metadata: null`) are deliberately unchanged. Only four LOW nits remain, none blocking.

## Fold verification

| Round-3 item | Fix in `e3c8f74` | Verified against | Real? |
|---|---|---|---|
| F2 refine not total (`JSON.stringify` can throw on BigInt/cycle) | `src/index.ts:3460-3466` wraps the predicate in `try { … } catch { return false; }` | zod v3 runs predicates without try/catch (round-3 reading); `dist/index.js:2875-2882` carries the same code | ✅ |
| F4 no exact-boundary test | `test/...mjs:34-36` adds exact-limit, one-over, and BigInt cases | arithmetic below | ✅ |
| F1 exponent-notation byte-count divergence — deliberately unchanged | no change | patch contains only the refine hunk | ✅ (accepted) |
| F3 `metadata: null` divergence — deliberately unchanged | no change | patch contains only the refine hunk | ✅ (accepted) |
| dist rebuilt from folded src | `dist/index.js:2873-2884` (try/catch refine, message, describe) matches `src/index.ts:3458-3470` | direct read | ✅ |

**Boundary arithmetic (verified by hand).** The test builds `metadata: { k: "x".repeat(16384 - 8) }`.
`JSON.stringify` emits `{"k":"…"}`, whose non-value overhead is 8 bytes: `{` (1) + `"k"` (3) +
`:` (1) + the two value quotes (2) + `}` (1) = 8. So 16 376 `x` bytes + 8 = **16 384**, and
`Buffer.byteLength(...) <= 16_384` is true → the accept assertion is correct. The over case uses
`16384 - 7` = 16 377 `x` bytes → **16 385** → refine false → the refuse assertion is correct. The
inline comment "`{"k":"…"}` is 8 bytes of JSON around the value" is accurate. The predicate
receives the *parsed* record, whose only value is passed through unchanged by `z.any()`, so
`JSON.stringify` reproduces the input length exactly.

**BigInt case exercises the catch (verified).** `metadata: { n: 10n }` passes the `ZodRecord` gate
(`z.any()` value, no checks) and reaches the refinement, where `JSON.stringify({n: 10n})` throws
`TypeError: Do not know how to serialize a BigInt`. The new `catch` converts that into `false`, so
`parse(...).success` is `false`. Without the catch, `safeParse` would throw and the test would die
with an uncaught `TypeError`; the assertion `assert.ok(!parse(...).success, …)` is therefore a real
regression test for the catch, not a tautology. The case is reachable in-process even though the
JSON transport itself cannot carry a BigInt (round-3 F2 analysis).

**Wording (verified).** Refine message `"metadata exceeds 16 KiB or is not JSON-encodable"`
(`src/index.ts:3466`) is accurate for both failure paths. Test messages
(`test/...mjs:34-36`) state exactly what each assertion checks. `dist` mirrors both.

## Findings

### Finding 1 — 🟢 LOW: the new comment overstates the daemon's role for non-encodable values

**Severity:** 🟢 Low
**File:** `src/index.ts:3464`

**Analysis:** The comment reads "not JSON-encodable (BigInt, cycle): the daemon could not take it
either". The daemon is never contacted for such a value: the MCP server's own transport
serialises the body with `JSON.stringify` in `gcPost` (`src/index.ts:119`), which would throw for
a BigInt/cyclic value before any HTTP request is made. And even if the refine were absent, that
throw occurs inside `daemonCall`'s `try` (`src/index.ts:495-505`) and is returned as an
`ERROR: …` tool result, not a crash. So the guard's real value is a clean field-level validation
error instead of a transport throw, not preventing a daemon-side failure. The comment's intent is
defensible (the daemon could not accept a BigInt in any case), but the phrasing implies the daemon
is the reason, which is not how the failure would actually surface.

**Specific references:**
- `src/index.ts:3464` (the comment)
- `src/index.ts:119` (`gcPost`'s `JSON.stringify(body)`)
- `src/index.ts:495-505` (`daemonCall`'s try/catch)

**Remediation:** reword, e.g. "not JSON-encodable (BigInt, cycle): fail validation here rather than
letting the transport `JSON.stringify` throw later". No behaviour change.

---

### Finding 2 — 🟢 LOW: the `.describe` text omits the JSON-encodable requirement

**Severity:** 🟢 Low
**File:** `src/index.ts:3468-3470`

**Analysis:** The description the model sees is "dispatch: a JSON object (at most 16 KiB) recorded
on the job." It documents the size cap but not the second rejection reason now enforced by the
refine (non-JSON-encodable values). The refine message mentions both; the describe does not. Minor
inconsistency, and a model that only reads the tool description would not learn the constraint.

**Specific references:**
- `src/index.ts:3468-3470` (describe)
- `src/index.ts:3466` (refine message naming both causes)

**Remediation:** optionally extend the describe to "…a JSON object (at most 16 KiB, JSON-encodable)
recorded on the job." Cosmetic.

---

### Finding 3 — 🟢 LOW: boundary tests exercise only one JSON shape

**Severity:** 🟢 Low
**File:** `test/dispatch-explain-availability-schema.mjs:34-35`

**Analysis:** Both boundary cases use a single 1-character key with an ASCII string value, so the
"8 bytes of overhead" figure holds only for that shape. The threshold itself is proven exactly, but
the tests do not cover other value types at the boundary (numbers, booleans, nested objects, or
multi-byte Unicode, where `Buffer.byteLength` counts bytes not characters), nor the
`metadata: []` array case that round-3 flagged and that both the zod record and the daemon's
`is_map/1` reject. Coverage, not correctness.

**Specific references:**
- `test/dispatch-explain-availability-schema.mjs:34-35` (boundary cases)
- `test/dispatch-explain-availability-schema.mjs:31` (the only non-object case)

**Remediation:** optional — add a Unicode boundary case and a `metadata: []` case. No code change.

---

### Finding 4 — 🟢 LOW: the cyclic-object half of the catch rationale is untested

**Severity:** 🟢 Low
**File:** `test/dispatch-explain-availability-schema.mjs:36`

**Analysis:** The comment at `src/index.ts:3464` names two non-encodable cases, BigInt and cycle,
but only the BigInt case is exercised. The cycle path is the one a caller could construct
in-process with an object reference (`const o = {}; o.self = o`), and it is the case the `catch`
most clearly exists for. Nit-level coverage gap.

**Specific references:**
- `test/dispatch-explain-availability-schema.mjs:36` (BigInt case)
- `src/index.ts:3464` (comment naming "cycle")

**Remediation:** optional — add `const c = {}; c.self = c;` and assert
`!parse({ …, metadata: c }).success`.

## Test gaps

| Gap | Priority | Details |
|-----|----------|---------|
| Boundary only for one JSON shape | Low | Finding 3 — 1-char key + ASCII string only |
| Cyclic-object catch path untested | Low | Finding 4 — only BigInt exercises the `catch` |
| `metadata: []` still untested | Low | Carried from round 3; rejected by both layers |
| Tests not executed here | n/a | Shell/ripgrep unavailable (SIGKILL / binary missing); run `npm test` where a shell works |

## Sign-off

**Blockers that should not have shipped:** None.
**Recommended next step:** commit as-is. The fold implements F2 and F4 exactly as described, the
boundary arithmetic is exact, the BigInt case genuinely drives the new `catch`, the wording is
accurate, and `dist` is in step. Findings 1–4 are LOW nits that need no change before shipping.

VERDICT: PASS

AUDIT COMPLETE. STOP.
