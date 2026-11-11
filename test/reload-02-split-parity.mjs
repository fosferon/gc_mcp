// GC-7182 test 2: the split registers the same 65 tools with exactly the same
// tools/list output as the snapshot generated from master 4496e1d.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadEntry, wire } from "./reload-harness.mjs";

const snapshot = JSON.parse(
  readFileSync(new URL("./fixtures/tools-list-4496e1d.json", import.meta.url), "utf8"),
);

const { listTools } = await loadEntry({ GC_MCP_RELOAD: "0" });
const result = await listTools();

assert.equal(result.tools.length, 65);
assert.deepEqual(wire(result), snapshot, "tools/list output drifted from 4496e1d");

process.stdout.write(`Verified split parity for ${result.tools.length} tools.\n`);
