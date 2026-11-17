import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { createTokenStore, hashToken } from "../token-store.js";

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tokstore-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("issued access token is accepted, unknown and non-string tokens are not", () => {
  const s = createTokenStore();
  const { accessToken, refreshToken, expiresIn } = s.issue("c1");
  assert.equal(expiresIn, 3600);
  assert.notEqual(accessToken, refreshToken);
  assert.deepEqual(s.lookupAccess(accessToken), { clientId: "c1" });
  assert.equal(s.lookupAccess("nope"), null);
  for (const v of [undefined, null, 5, {}, ""]) assert.equal(s.lookupAccess(v), null);
});

test("access tokens expire", () => {
  let t = 1000;
  const s = createTokenStore({ now: () => t, accessTtlMs: 100 });
  const { accessToken } = s.issue("c1");
  t += 99;
  assert.ok(s.lookupAccess(accessToken));
  t += 1;
  assert.equal(s.lookupAccess(accessToken), null);
});

test("refresh rotates tokens and invalidates the old refresh token", () => {
  const s = createTokenStore();
  const first = s.issue("c1");
  const second = s.refresh(first.refreshToken, "c1");
  assert.ok(second.accessToken && second.refreshToken);
  assert.notEqual(second.refreshToken, first.refreshToken);
  assert.ok(s.lookupAccess(second.accessToken));
  assert.deepEqual(s.refresh(first.refreshToken, "c1"), { error: "invalid_grant" });
});

test("reusing a rotated refresh token revokes the whole family", () => {
  const s = createTokenStore();
  const first = s.issue("c1");
  const second = s.refresh(first.refreshToken, "c1");
  assert.equal(s.refresh(first.refreshToken, "c1").error, "invalid_grant");
  assert.equal(s.lookupAccess(second.accessToken), null);
  assert.equal(s.refresh(second.refreshToken, "c1").error, "invalid_grant");
});

test("refresh token is bound to its client and unknown tokens fail", () => {
  const s = createTokenStore();
  const a = s.issue("c1");
  assert.equal(s.refresh(a.refreshToken, "c2").error, "invalid_grant");
  assert.equal(s.refresh("nope", "c1").error, "invalid_grant");
  assert.equal(s.refresh(undefined, "c1").error, "invalid_grant");
  // wrong-client attempt must not burn the token
  assert.ok(s.refresh(a.refreshToken, "c1").refreshToken);
});

test("refresh expiry slides on each refresh", () => {
  let t = 0;
  const s = createTokenStore({ now: () => t, refreshTtlMs: 1000, accessTtlMs: 10 });
  let cur = s.issue("c1");
  for (let i = 0; i < 3; i++) {
    t += 900;
    cur = s.refresh(cur.refreshToken, "c1");
    assert.ok(cur.refreshToken, `refresh ${i} should succeed`);
  }
  t += 1000;
  assert.equal(s.refresh(cur.refreshToken, "c1").error, "invalid_grant");
});

test("revokeClient removes that client's tokens only", () => {
  const s = createTokenStore();
  const a = s.issue("c1");
  const b = s.issue("c2");
  s.revokeClient("c1");
  assert.equal(s.lookupAccess(a.accessToken), null);
  assert.ok(s.lookupAccess(b.accessToken));
});

test("tokens persist across store instances and the file holds no raw tokens", (t) => {
  const file = path.join(tmpDir(t), "tokens.json");
  const s1 = createTokenStore({ filePath: file });
  const { accessToken, refreshToken } = s1.issue("c1");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(!text.includes(accessToken));
  assert.ok(!text.includes(refreshToken));
  assert.ok(text.includes(hashToken(accessToken)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const s2 = createTokenStore({ filePath: file });
  assert.deepEqual(s2.lookupAccess(accessToken), { clientId: "c1" });
  assert.ok(s2.refresh(refreshToken, "c1").accessToken);
});

test("expired entries are pruned on load", (t) => {
  const file = path.join(tmpDir(t), "tokens.json");
  let now = 0;
  const s1 = createTokenStore({ filePath: file, now: () => now, accessTtlMs: 10, refreshTtlMs: 20 });
  s1.issue("c1");
  now = 100;
  createTokenStore({ filePath: file, now: () => now });
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(parsed.access).length, 1); // file unchanged until next save
  const s3 = createTokenStore({ filePath: file, now: () => now });
  s3.issue("c2");
  const after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(Object.keys(after.access).length, 1);
  assert.equal(Object.keys(after.refresh).length, 1);
});

test("corrupt file: warns, works in memory, file left untouched", (t) => {
  const file = path.join(tmpDir(t), "tokens.json");
  fs.writeFileSync(file, "{not json");
  const warnings = [];
  const s = createTokenStore({ filePath: file, warn: (m) => warnings.push(m) });
  const { accessToken } = s.issue("c1");
  assert.ok(s.lookupAccess(accessToken));
  assert.equal(fs.readFileSync(file, "utf8"), "{not json");
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(accessToken));
});

test("unwritable directory: warns and keeps working in memory", (t) => {
  const dir = tmpDir(t);
  const blocker = path.join(dir, "file");
  fs.writeFileSync(blocker, "x");
  const warnings = [];
  const s = createTokenStore({ filePath: path.join(blocker, "sub", "tokens.json"), warn: (m) => warnings.push(m) });
  const { accessToken } = s.issue("c1");
  assert.ok(s.lookupAccess(accessToken));
  assert.ok(warnings.length >= 1);
});
