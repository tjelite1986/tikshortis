// Run with: npx tsx --test test/*.test.ts
// Every POST operation the dedupe route handles must also be let through by
// the middleware's origin guard, or Grabbit's server-to-server call gets
// "Bad origin" before the route can check its token (hold was missed once).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const route = readFileSync(join(root, "app/api/dedupe/v1/[op]/route.ts"), "utf8");
const middleware = readFileSync(join(root, "middleware.ts"), "utf8");

test("the middleware lets every dedupe operation through", () => {
  const m = middleware.match(/const DEDUPE_OPS = (\/.*\/);/);
  assert.ok(m, "DEDUPE_OPS not found in middleware.ts");
  const re = new RegExp(m[1].slice(1, -1));
  const ops = [...route.matchAll(/case "([a-z]+)":/g)].map((x) => x[1]);
  assert.ok(ops.includes("hold"), "route ops not found");
  for (const op of ops) assert.ok(re.test(`/api/dedupe/v1/${op}`), `middleware blocks ${op}`);
  assert.ok(!re.test("/api/dedupe/v1/holdx"), "allowlist must stay anchored");
});
