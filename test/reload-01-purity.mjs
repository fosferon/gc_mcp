// GC-7182 test 1: the reloadable tool module carries no local imports, static
// or dynamic, so a cache-busted re-import is complete.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../dist/tools.js", import.meta.url), "utf8");

const staticLocal = [...source.matchAll(/\bfrom\s+["'](?:\.\.?\/)[^"']*["']/g)].map(
  (match) => match[0],
);
const dynamicLocal = [
  ...source.matchAll(/\bimport\s*\(\s*["'](?:\.\.?\/)[^"']*["']\s*\)/g),
].map((match) => match[0]);

assert.deepEqual(staticLocal, [], "dist/tools.js must have no static local imports");
assert.deepEqual(dynamicLocal, [], "dist/tools.js must have no dynamic local imports");

process.stdout.write("Verified dist/tools.js has no local imports.\n");
