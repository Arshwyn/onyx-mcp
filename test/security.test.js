import test from "node:test";
import assert from "node:assert/strict";
import { secretsMatch, logValue } from "../security.js";

test("secretsMatch accepts equal secrets only", () => {
  assert.equal(secretsMatch("secret-1", "secret-1"), true);
  assert.equal(secretsMatch("secret-1", "secret-2"), false);
  assert.equal(secretsMatch("secret-1", "secret-1 "), false);
});

test("secretsMatch treats missing or non-string values as invalid without throwing", () => {
  for (const v of [undefined, null, 5, {}, ["secret-1"]]) {
    assert.equal(secretsMatch("secret-1", v), false);
    assert.equal(secretsMatch(v, "secret-1"), false);
  }
});

test("logValue escapes control characters", () => {
  const out = logValue("a\nb\r\nc");
  assert.equal(out.includes("\n"), false);
  assert.equal(out.includes("\r"), false);
  assert.equal(logValue(undefined), "undefined");
});
