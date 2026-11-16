// Run with: npx tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { embedOrigins, frameAncestors } from "../lib/embed";

test("unset, empty or blank means no framing at all", () => {
  for (const v of [undefined, null, "", "   "]) {
    assert.deepEqual(embedOrigins(v), []);
    assert.equal(frameAncestors(v), "frame-ancestors 'none'");
  }
});

test("plain https origins are accepted, lower-cased and de-duplicated", () => {
  assert.equal(
    frameAncestors("https://grabbit.example.com  https://GRABBIT.example.com https://hub.example.com:8443"),
    "frame-ancestors https://grabbit.example.com https://hub.example.com:8443",
  );
  assert.deepEqual(embedOrigins("http://127.0.0.1:3399"), ["http://127.0.0.1:3399"]);
});

test("one malformed entry turns the whole list off", () => {
  for (const bad of [
    "*",
    "https://*.example.com",
    "https://grabbit.example.com/hub",
    "http://grabbit.example.com",
    "data:",
    "'self'",
    "https://ok.example.com javascript:alert(1)",
    "https://ok.example.com;script-src *",
  ]) {
    assert.equal(frameAncestors(bad), "frame-ancestors 'none'", bad);
  }
});

test("the full policy always travels with frame-ancestors", async () => {
  const { contentSecurityPolicy, BASE_DIRECTIVES } = await import("../lib/csp.mjs");
  for (const env of [undefined, "http://127.0.0.1:3399", "*"]) {
    const csp = contentSecurityPolicy(frameAncestors(env));
    for (const d of BASE_DIRECTIVES) assert.ok(csp.includes(d), `${d} missing for ${env}`);
    assert.equal(csp.match(/frame-ancestors/g)?.length, 1);
  }
  assert.ok(
    contentSecurityPolicy(frameAncestors(undefined)).endsWith("frame-ancestors 'none'"),
  );
});
