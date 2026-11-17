import test from "node:test";
import assert from "node:assert/strict";
import { createTokenStore } from "../token-store.js";
import { handleRefreshGrant, tokenResponse } from "../oauth-token.js";

const clients = new Map([
  ["c1", { clientSecret: "s1", userId: "u1" }],
  ["c2", { clientSecret: "s2", userId: "u2" }],
]);

function setup() {
  const store = createTokenStore();
  const first = store.issue("c1");
  return { store, first };
}

test("refresh grant returns a rotated token pair", () => {
  const { store, first } = setup();
  const r = handleRefreshGrant({ store, clients, clientId: "c1", clientSecret: "s1", refreshToken: first.refreshToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.token_type, "Bearer");
  assert.equal(r.body.expires_in, 3600);
  assert.ok(r.body.access_token && r.body.refresh_token);
  assert.notEqual(r.body.refresh_token, first.refreshToken);
});

test("bad client credentials are invalid_client (401)", () => {
  const { store, first } = setup();
  for (const [id, secret] of [["c1", "wrong"], ["nope", "s1"], ["c1", undefined]]) {
    const r = handleRefreshGrant({ store, clients, clientId: id, clientSecret: secret, refreshToken: first.refreshToken });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "invalid_client");
  }
});

test("missing refresh_token is invalid_request", () => {
  const { store } = setup();
  const r = handleRefreshGrant({ store, clients, clientId: "c1", clientSecret: "s1", refreshToken: undefined });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "invalid_request");
});

test("unknown, reused or other-client refresh tokens are invalid_grant", () => {
  const { store, first } = setup();
  const bad = (rt, id = "c1", sec = "s1") => handleRefreshGrant({ store, clients, clientId: id, clientSecret: sec, refreshToken: rt });
  assert.equal(bad("nope").body.error, "invalid_grant");
  assert.equal(bad(first.refreshToken, "c2", "s2").body.error, "invalid_grant");
  assert.equal(bad(first.refreshToken).status, 200);
  const reuse = bad(first.refreshToken);
  assert.equal(reuse.status, 400);
  assert.equal(reuse.body.error, "invalid_grant");
});

test("tokenResponse includes refresh_token for the code grant", () => {
  const body = tokenResponse(createTokenStore().issue("c1"));
  assert.deepEqual(Object.keys(body).sort(), ["access_token", "expires_in", "refresh_token", "token_type"]);
});
